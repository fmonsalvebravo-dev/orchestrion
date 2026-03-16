# Concurrency Model

Orchestrion guarantees correctness when many workers operate on the same task queue simultaneously. This document explains how concurrency is handled at every layer.

---

## Overview

The system is designed to be safe under high worker concurrency. The guarantees:

- **No duplicate processing.** Each task is claimed by exactly one worker.
- **No lost tasks.** A crashed worker's task is automatically recovered.
- **Deterministic ordering.** Claim order is consistent and repeatable.
- **No deadlocks.** Lock contention is avoided by design.
- **Scalable competition.** Thousands of workers can safely race for tasks.

Concurrency control is enforced primarily at the database layer using PostgreSQL row-level locking. The application layer validates state transitions; the database layer serializes them.

---

## Task Claim Concurrency

Workers claim tasks via:

```
POST /v1/tasks/claim
{ "type": "process_document" }
```

The underlying query:

```sql
SELECT id, ... FROM tasks
WHERE account_id = $1
  AND type = $2
  AND status = 'pending'
  AND (scheduled_at IS NULL OR scheduled_at <= now())
ORDER BY priority DESC,
         scheduled_at ASC NULLS FIRST,
         created_at ASC
LIMIT 1
FOR UPDATE SKIP LOCKED
```

### Why `FOR UPDATE SKIP LOCKED`

The `FOR UPDATE` clause locks the selected row for the duration of the transaction. `SKIP LOCKED` tells PostgreSQL to silently skip any rows already locked by another transaction.

This produces three behaviors:

1. **Exactly-once assignment.** Only one transaction can lock a given row. The first worker wins; others skip it.
2. **No blocking.** Workers never wait for each other. If all eligible tasks are locked, the query returns zero rows — the worker gets `no_tasks` and retries with backoff.
3. **No deadlocks.** Because workers never wait for locks, circular dependencies cannot form.

### What the Losing Worker Sees

```json
{
  "message": "no_tasks",
  "agent_contract": {
    "next_actions": [
      { "action": "retry_after_wait", "retry_after_seconds": 5 }
    ]
  }
}
```

The `agent_contract` tells the worker exactly how long to wait before retrying. No guesswork, no exponential backoff logic required on the client side.

---

## Row-Level Locking

Every task mutation operates within a database transaction using row-level locks:

| Operation | Lock Mode | Reason |
|---|---|---|
| Claim (server-assigned) | `FOR UPDATE SKIP LOCKED` | Non-blocking competition |
| Claim (by ID) | `FOR UPDATE` | Caller wants a definitive answer |
| Complete | `FOR UPDATE` | Serialize with concurrent operations |
| Fail | `FOR UPDATE` | Serialize with concurrent operations |
| Heartbeat | `FOR UPDATE` | Serialize with lease expiry job |
| Cancel | `FOR UPDATE` | Serialize with concurrent operations |
| Requeue | `FOR UPDATE` | Serialize with concurrent operations |

The pattern is consistent:

1. `SELECT ... FOR UPDATE` — lock the row and read current state
2. Validate the transition (e.g., status must be `claimed` to complete)
3. `UPDATE` — apply the transition
4. `COMMIT` — release the lock

If two operations target the same task, one blocks until the other commits. The second operation then reads the updated state and either proceeds or rejects (e.g., `invalid_transition` if the task was already completed).

---

## Lease Expiry vs Worker Operations

Two actors can operate on claimed tasks:

- **Workers** — completing, failing, or heartbeating
- **Lease expiry job** — recovering tasks with expired leases

These must never process the same task simultaneously. The solution:

```
Worker:     SELECT ... FOR UPDATE       (blocking)
Expiry job: SELECT ... FOR UPDATE SKIP LOCKED  (non-blocking)
```

### Scenario: Worker Completes While Lease Expires

```
Time T:
  Worker starts:   SELECT task FOR UPDATE        → gets lock
  Expiry job:      SELECT task FOR UPDATE SKIP LOCKED → skips (locked)

  Worker:          UPDATE status = 'completed'
  Worker:          COMMIT → lock released

  Expiry job:      next cycle → task is 'completed' → ignored
```

The worker wins. No work is lost.

### Scenario: Lease Expiry Runs First

```
Time T:
  Expiry job:      SELECT task FOR UPDATE SKIP LOCKED → gets lock
  Worker starts:   SELECT task FOR UPDATE             → blocks

  Expiry job:      UPDATE status = 'pending' (retry)
  Expiry job:      COMMIT → lock released

  Worker:          lock acquired → reads status = 'pending'
  Worker:          returns 'invalid_transition' (expected 'claimed')
```

The expiry job wins. The worker receives a clear error. The task is safely back in the queue.

### Why This Is Safe

- `SKIP LOCKED` on the expiry job means it never blocks workers
- `FOR UPDATE` on workers means they get a definitive answer
- Whichever acquires the lock first, the other sees the updated state after

---

## Retry Scheduling Concurrency

When a task fails with `retry_after_seconds`, it returns to `pending` with a future `scheduled_at`. The claim query filters:

```sql
WHERE scheduled_at IS NULL OR scheduled_at <= now()
```

This creates a concurrency-safe retry window:

1. Task fails at time T with `retry_after_seconds: 60`
2. `scheduled_at` is set to T+60
3. All claim queries between T and T+60 skip this task
4. At T+60, the task becomes visible and the next claim picks it up

This prevents two concurrency problems:

- **Retry storms.** Without the delay, a failed task would be immediately reclaimed and likely fail again, burning through all attempts in seconds.
- **Unfair reclaim.** Without scheduling, a retried task would compete with fresh tasks based on priority alone, creating unpredictable queue behavior.

---

## Idempotency Concurrency

Task creation supports idempotency keys to prevent duplicates under concurrent retries:

```sql
INSERT INTO idempotency_keys (key, api_key_hash, ...)
VALUES ($1, $2, ...)
ON CONFLICT (key, api_key_hash) DO NOTHING
```

Only one `INSERT` succeeds per composite key. All concurrent requests hit the conflict path and inspect the existing row:

| Existing Row State | Behavior |
|---|---|
| Finalized (has stored response) | Return the stored response |
| In-flight (response not yet stored) | Return `503` with `retry_after_seconds: 2` |
| Stale (>90 seconds old, still in-flight) | Reclaim the slot and create the task |

This guarantees exactly-once task creation even when an agent retries the same request concurrently across multiple connections.

---

## Background Jobs and Concurrency

Three background jobs run within the API process:

| Job | Interval | Lock Mode |
|---|---|---|
| Lease expiry | 30 seconds | `FOR UPDATE SKIP LOCKED` |
| Retention cleanup | 60 seconds | `FOR UPDATE SKIP LOCKED` |
| Idempotency purge | 1 hour | Direct `DELETE` on expired rows |

### Safety Properties

- **Non-blocking.** `SKIP LOCKED` ensures background jobs never interfere with active worker transactions.
- **No overlap.** Each job uses a guard flag that prevents a new cycle from starting while the previous one is still running.
- **Crash-safe.** Each job runs inside `try/catch`. A failed cycle logs the error and the next interval runs normally.
- **Disjoint row sets.** Retention cleanup targets terminal tasks (`completed`, `dead_letter`, `cancelled`). Claim queries target `pending` tasks. These sets never overlap, so they cannot contend for the same rows.

---

## Failure Scenarios

### Worker Crashes Mid-Processing

1. Worker claims task, begins processing
2. Worker process crashes — no heartbeat, no complete, no fail
3. Lease expires after `lease_duration_seconds`
4. Background job detects expiry and returns task to `pending` (or `dead_letter` if attempts exhausted)
5. Another worker claims and processes the task

**Time to recovery:** at most `lease_duration_seconds + 30` seconds (lease duration plus one expiry job cycle).

### Network Connection Drops

Same as crash — the worker cannot send heartbeats, so the lease expires. The task is recovered automatically.

### Task Fails Repeatedly

1. Attempt 1: claim → fail → `pending` (retry scheduled)
2. Attempt 2: claim → fail → `pending` (retry scheduled)
3. Attempt 3: claim → fail → `dead_letter` (exhausted)

Each attempt increments `attempt_count` on claim. The dead-letter transition is deterministic — it occurs at exactly `max_attempts`, checked identically in both the fail endpoint and the expiry job.

### Multiple Workers Retry Simultaneously

Workers retry claims independently based on `agent_contract` guidance. Because `SKIP LOCKED` prevents contention, simultaneous retries degrade gracefully:

- If tasks are available, each worker gets a different task
- If no tasks are available, all workers get `no_tasks` with retry guidance
- No worker blocks another

---

## Design Principles

| Principle | How It Is Enforced |
|---|---|
| **Correctness over throughput** | Row-level locks serialize every state transition. No optimistic concurrency, no eventual consistency. |
| **Deterministic transitions** | Every mutation validates the current state before proceeding. Invalid transitions are rejected, not silently ignored. |
| **Database-enforced invariants** | CHECK constraints on status, priority, attempt limits. `FOR UPDATE` on every mutation. Partial indexes on active states. |
| **Autonomous worker safety** | Workers operate independently with no shared state, no leader election, and no coordination protocol. The database is the single source of truth. |

The goal is a system where many independent workers can safely operate on the same task queue without central coordination, custom client libraries, or distributed consensus.
