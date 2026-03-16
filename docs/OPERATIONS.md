# Operations Guide

This document explains how Orchestrion behaves in production and what operators need to know to run it safely.

---

## Overview

Orchestrion runs as a stateless API server backed by PostgreSQL. All task state, account data, and billing records live in the database. The server process can be restarted, scaled, or replaced without losing state.

Three background jobs run within the API process:

| Job | Interval | Purpose |
|---|---|---|
| Lease expiry | 30 seconds | Recover tasks from crashed workers |
| Retention cleanup | 60 seconds | Purge expired terminal tasks |
| Idempotency purge | 1 hour | Remove stale idempotency keys |

These jobs use guard flags to prevent overlapping runs and `try/catch` to prevent server crashes on failure.

---

## Worker Operations

Workers interact with the system through a simple loop:

1. **Claim** — `POST /v1/tasks/claim` with a task type. The server assigns the next eligible task and grants a lease.
2. **Process** — The worker reads the task payload and performs the work.
3. **Heartbeat** — `POST /v1/tasks/{id}/heartbeat` at regular intervals to keep the lease alive.
4. **Complete or fail** — `POST /v1/tasks/{id}/complete` on success, or `POST /v1/tasks/{id}/fail` on failure.

Workers operate independently. They do not coordinate with each other, do not share state, and do not require a client SDK. The `agent_contract` in every response tells the worker what to do next.

---

## Lease Management

### Lease Duration

Each task has a configurable lease duration (30–3600 seconds, default 300). When claimed, the task's `lease_expires_at` is set to `now() + lease_duration_seconds`.

### Heartbeat Interval

Workers should send heartbeats at `lease_duration / 3`. This gives two chances to renew before expiry. Each heartbeat resets the lease to the full duration.

### Expiry Recovery

The lease expiry job runs every 30 seconds and processes tasks where:

- `status = 'claimed'`
- `lease_expires_at <= now()`

For each expired task:

- If `attempt_count < max_attempts` → return to `pending`
- If `attempt_count >= max_attempts` → move to `dead_letter`

The job uses `FOR UPDATE SKIP LOCKED` to avoid interfering with active workers.

### Recovery Time

Maximum time for a crashed worker's task to be recovered:

```
lease_duration_seconds + 30 seconds (one expiry job cycle)
```

With the default 300-second lease, worst-case recovery is ~330 seconds.

---

## Retry and Dead-Letter Handling

### Retry Scheduling

When a worker reports failure with `retry_after_seconds`, the task returns to `pending` with a future `scheduled_at`. The task is invisible to claim queries until that time passes.

This prevents retry storms where a consistently-failing task burns through all attempts immediately.

### Attempt Counting

`attempt_count` increments on each claim, not on fail. This accurately reflects the number of processing attempts consumed.

### Dead-Letter Transition

When `attempt_count >= max_attempts` at the time of failure or lease expiry, the task transitions to `dead_letter`. The `failure_reason` from the last attempt is preserved.

### Manual Requeue

Dead-lettered tasks can be requeued via `POST /v1/tasks/{id}/requeue`. This resets `attempt_count` to 0 and returns the task to `pending`. Requeue is an explicit action — there is no automatic retry from `dead_letter`.

---

## Monitoring

### What to Watch

| Metric | Why It Matters | How to Check |
|---|---|---|
| **Pending task count** | Growing backlog indicates workers can't keep up | `SELECT count(*) FROM tasks WHERE status = 'pending'` |
| **Dead-letter count** | Growing dead-letter indicates systematic failures | `SELECT count(*) FROM tasks WHERE status = 'dead_letter'` |
| **Claim throughput** | Drop indicates worker fleet issues | Monitor claim request rate in access logs |
| **Lease expiry recoveries** | High count indicates worker instability | Structured logs: `event: "lease_expiry_cycle"` |
| **Retention cleanup deletions** | Confirms cleanup is running | Structured logs: `event: "retention_cleanup_cycle"` |

### Health Endpoint

```
GET /health
```

Returns the status of background jobs:

```json
{
  "status": "ok",
  "leaseExpiryJob": {
    "lastRunAt": "2026-03-14T18:26:39Z",
    "staleSec": 2,
    "healthy": true
  },
  "retentionCleanupJob": {
    "lastRunAt": "2026-03-14T18:27:09Z",
    "staleSec": 2,
    "healthy": true
  }
}
```

- `leaseExpiryJob` is healthy if last run was < 90 seconds ago
- `retentionCleanupJob` is healthy if last run was < 120 seconds ago

If either job shows `healthy: false`, the process may need to be restarted.

### Useful Diagnostic Queries

```sql
-- Task distribution by status
SELECT status, count(*) FROM tasks GROUP BY status;

-- Dead-letter tasks by type (identify problem areas)
SELECT type, count(*) FROM tasks
WHERE status = 'dead_letter'
GROUP BY type ORDER BY count DESC;

-- Active workers per account
SELECT account_id, count(*) FROM tasks
WHERE status = 'claimed' AND lease_expires_at > now()
GROUP BY account_id;

-- Pending tasks per type (queue depth)
SELECT type, count(*) FROM tasks
WHERE status = 'pending'
GROUP BY type ORDER BY count DESC;

-- Oldest pending task (detect stuck queues)
SELECT type, min(created_at) FROM tasks
WHERE status = 'pending'
GROUP BY type;
```

---

## Retention Cleanup

Terminal tasks (`completed`, `dead_letter`, `cancelled`) are automatically purged based on each account's `retention_days`:

| Plan | Retention |
|---|---|
| Free | 7 days |
| Basic | 30 days |
| Pro | 60 days |
| Agency | 90 days |

The retention cleanup job runs every 60 seconds. Each cycle:

1. Selects up to 1000 terminal tasks where `updated_at < now() - retention_days`
2. Locks them with `FOR UPDATE SKIP LOCKED`
3. Deletes them in a single batch

The `LIMIT 1000` prevents any single cycle from running too long. Large backlogs are cleared across multiple cycles.

**Only terminal tasks are deleted.** Pending and claimed tasks are never touched by the retention job, regardless of age.

---

## Failure Recovery

### Worker Crashes

The lease expires, and the expiry job returns the task to `pending` (or `dead_letter` if attempts are exhausted). Another worker claims it on the next cycle.

### Network Failures

Same as a crash — the worker cannot send heartbeats, so the lease expires. The task is recovered automatically.

### Database Connection Loss

The API server cannot process requests while disconnected from PostgreSQL. The connection pool will attempt to reconnect automatically. In-flight requests will fail with a database error. No task state is corrupted because all mutations run inside transactions — a failed transaction is rolled back.

### Process Restart

Background jobs restart with the process. `setInterval` timers begin fresh. In-memory rate limiters reset to zero. Task state in the database is unaffected.

Rate limiter reset on restart allows a brief burst of requests that would otherwise be limited. For production deployments, use a reverse proxy with its own rate limiting as defense-in-depth.

### Repeated Task Failures

Tasks that fail consistently will reach `dead_letter` after `max_attempts` (1–10, default 3). Dead-lettered tasks stop cycling and require explicit requeue. This prevents a single broken task from consuming worker capacity indefinitely.
