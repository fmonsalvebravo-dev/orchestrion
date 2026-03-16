# Architecture

Orchestrion is an agent-native task orchestration API. It manages independent tasks with strong correctness guarantees under concurrency. This document explains how the system works internally.

---

## High-Level Architecture

```
┌──────────────────────────────────┐
│       Agents / Workers           │
│   (AI agents, scripts, services) │
└──────────────┬───────────────────┘
               │ HTTP (REST)
               ▼
┌──────────────────────────────────┐
│        Orchestrion API           │
│    Node.js / Express / TypeScript│
│                                  │
│  ┌────────────┐ ┌──────────────┐ │
│  │   Routes   │ │  Middleware   │ │
│  │ tasks,keys │ │ auth, rate   │ │
│  │ billing    │ │ limiting     │ │
│  └─────┬──────┘ └──────────────┘ │
│        │                         │
│  ┌─────▼──────┐                  │
│  │  Services  │                  │
│  │ lifecycle, │                  │
│  │ billing,   │                  │
│  │ idempotency│                  │
│  └─────┬──────┘                  │
└────────┼─────────────────────────┘
         │ SQL (parameterized queries)
         ▼
┌──────────────────────────────────┐
│     PostgreSQL Task Store        │
│                                  │
│  api_keys │ accounts │ tasks     │
│  purchases │ idempotency_keys    │
│                                  │
│  Background Jobs:                │
│  ├── Lease Expiry (30s cycle)    │
│  ├── Retention Cleanup (60s)     │
│  └── Idempotency Purge (1h)     │
└──────────────────────────────────┘
```

All state lives in PostgreSQL. There is no Redis, no external queue, and no message broker. The API server connects directly to the database using parameterized SQL queries through a connection pool.

Background jobs run as `setInterval` timers within the API process. Each job uses guard flags to prevent overlapping runs and `try/catch` to prevent server crashes on failure.

---

## Task Lifecycle

A task exists in exactly one of five states at any time:

```
                  ┌──────────────────────────────────────┐
                  │           create                      │
                  ▼                                       │
            ┌──────────┐                                  │
       ┌───▶│ pending  │◀──── fail (retries remain)       │
       │    └────┬─────┘◀──── lease expiry (retries)      │
       │         │                                        │
       │    claim│                                        │
       │         ▼                                        │
       │    ┌──────────┐                                  │
       │    │ claimed  │───── complete ──▶ completed       │
       │    └──────────┘                                  │
       │         │                                        │
       │    fail (exhausted)                               │
       │    lease expiry (exhausted)                       │
       │         │                                        │
       │         ▼                                        │
       │    ┌──────────────┐                               │
  requeue── │ dead_letter  │                               │
            └──────────────┘                               │
                                                          │
            ┌──────────────┐                               │
            │  cancelled   │◀──── cancel (from pending)    │
            └──────────────┘                               │
```

| State | Terminal | Description |
|---|---|---|
| `pending` | No | Queued and awaiting claim |
| `claimed` | No | A worker holds an active lease |
| `completed` | Yes | Finished successfully |
| `dead_letter` | Yes | All retry attempts exhausted |
| `cancelled` | Yes | Intentionally abandoned |

Terminal states are immutable. Once a task reaches `completed`, `dead_letter`, or `cancelled`, no operation can modify it — except `requeue` from `dead_letter`.

### Attempt Tracking

`attempt_count` is incremented each time a task is claimed, not when it fails. This reflects the number of processing attempts consumed. When `attempt_count >= max_attempts` at the time of failure or lease expiry, the task transitions to `dead_letter`.

---

## Task Claiming

Workers claim tasks by type:

```
POST /v1/tasks/claim
{ "type": "process_document" }
```

The claim query selects the next eligible task using:

```sql
SELECT ... FROM tasks
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

- **No double-claiming.** The `FOR UPDATE` lock ensures only one transaction can claim a given task.
- **No lock contention.** `SKIP LOCKED` means workers never wait for each other. If a task is locked by another transaction, the query skips it and selects the next eligible task.
- **Graceful degradation.** Under heavy load, some workers get `no_tasks` and retry with backoff guided by the `agent_contract`.

### Claim Ordering

1. Higher `priority` first (0–100)
2. Earliest `scheduled_at` first (NULL means immediately available)
3. FIFO by `created_at` among equal priority and schedule

This ordering is backed by a partial index that only includes pending tasks. The index stays small regardless of total task history.

---

## Lease Model

When a worker claims a task, it receives a time-limited lease.

### Parameters

| Parameter | Range | Default |
|---|---|---|
| Lease duration | 30–3600 seconds | 300 seconds |
| Recommended heartbeat interval | `lease_duration / 3` | 100 seconds |

### Heartbeat Renewal

Workers extend their lease by sending heartbeats:

```
POST /v1/tasks/{id}/heartbeat
```

Each heartbeat resets `lease_expires_at` to `now() + lease_duration_seconds`. The recommended interval is one-third of the lease duration, giving two chances to renew before expiry.

### Expiry Recovery

A background job runs every 30 seconds to detect tasks with expired leases:

- If `attempt_count < max_attempts` → task returns to `pending` for another attempt
- If `attempt_count >= max_attempts` → task moves to `dead_letter`

The job uses `FOR UPDATE SKIP LOCKED` to avoid interfering with workers that are actively completing or heartbeating. If a worker holds the row lock, the job skips that task.

### Worker-Wins Semantics

If a worker completes a task at the same moment the lease expires, the worker wins. The completion holds the row lock, so the recovery job either skips (SKIP LOCKED) or blocks and then sees the task is already completed. No work is lost.

---

## Retry Scheduling

When a worker reports failure with `retry_after_seconds`, the task returns to `pending` with a future `scheduled_at`. The claim query filters:

```sql
WHERE scheduled_at IS NULL OR scheduled_at <= now()
```

This makes the task invisible to claim queries until its retry window elapses. The delay gives transient external dependencies time to recover and prevents retry storms where a consistently-failing task consumes all attempts in seconds.

---

## Dead-Letter Queue

When a task exhausts all retry attempts (`attempt_count >= max_attempts`), it transitions to `dead_letter`. This prevents infinite retry loops.

Dead-lettered tasks:

- Cannot be claimed, completed, failed, or cancelled
- Preserve the `failure_reason` from the last attempt
- Can be explicitly requeued, which resets `attempt_count` to 0

Dead-letter accumulation is bounded by the retention cleanup job, which purges expired terminal tasks based on each account's retention window.

---

## Agent Contract

Every API response — success or error — includes an `agent_contract` field with machine-readable recovery instructions:

```json
{
  "agent_contract": {
    "version": "1",
    "next_actions": [
      { "action": "heartbeat", "recommended": true },
      { "action": "complete_task" }
    ]
  }
}
```

Agents read `next_actions` and follow the recommended action. They never need to parse HTTP status codes, interpret error messages, or implement endpoint-specific retry logic.

Error responses include the specific recovery action required:

| Action Code | Meaning |
|---|---|
| `claim_task` | Claim the next available task |
| `complete_task` | Complete the current task |
| `fail_task` | Report failure |
| `heartbeat` | Renew the lease |
| `retry_after_wait` | Wait and retry the same request |
| `authenticate` | Provide valid credentials |
| `fix_request` | Correct the request payload |
| `upgrade_plan` | Current plan limits exceeded |
| `requeue_task` | Requeue a dead-lettered task |

This design ensures that new error conditions can be introduced without breaking existing agents — the agent always has a machine-readable path forward.

---

## Minimal Infrastructure Philosophy

Orchestrion intentionally avoids:

| Excluded | Reason |
|---|---|
| Workflow DAGs | Most agent use cases don't need inter-task dependencies. Agents compose simple primitives into workflows at the application layer. |
| Push notifications | Callback infrastructure adds complexity. Polling with `claim` is simpler and more reliable for agents. |
| Distributed coordinators | PostgreSQL row locking provides equivalent safety for single-database deployments without external dependencies. |

The system focuses on **reliable single-task orchestration primitives**: one task, one worker, one lifecycle, one contract. Everything else is composed by the agent or developer.
