# Reliability Guarantees

Orchestrion provides strong reliability guarantees for task lifecycle management. This document explains the design decisions behind each guarantee.

---

## Task Lifecycle Guarantees

### No task is ever lost

Every task exists in exactly one of five states: `pending`, `claimed`, `completed`, `dead_letter`, or `cancelled`. State transitions are validated at the application layer and constrained at the database layer. There is no transition path that silently drops a task.

### No task is claimed twice

Claim operations use `SELECT ... FOR UPDATE SKIP LOCKED` inside a database transaction. This ensures that when multiple workers attempt to claim simultaneously, each task is assigned to exactly one worker. Workers that lose the race receive a `no_tasks` response with retry guidance.

### Terminal states are immutable

Once a task reaches `completed`, `dead_letter`, or `cancelled`, no operation can modify it (except `requeue` from `dead_letter`). Every mutation endpoint validates the current status before proceeding. This prevents accidental re-processing or state corruption.

---

## Lease-Based Ownership

### How It Works

When a worker claims a task, Orchestrion assigns a time-limited lease. The worker must complete the task or send heartbeats before the lease expires. If the worker crashes or disconnects, the lease eventually expires and the task is automatically recovered.

### Lease Parameters

| Parameter | Range | Default |
|---|---|---|
| Lease duration | 30–3600 seconds | 300 seconds |
| Recommended heartbeat interval | `lease_duration / 3` | 100 seconds |

### Expiry Recovery

A background job runs every 30 seconds to detect expired leases. For each expired task:

- If retries remain → task returns to `pending` for another attempt
- If retries are exhausted → task moves to `dead_letter`

The recovery job uses `FOR UPDATE SKIP LOCKED` to prevent conflicts with active workers. If a worker is actively completing or heartbeating a task, the recovery job skips it.

### Worker-Wins Semantics

If a worker completes a task in the same moment the lease expires, the worker wins. The completion holds the row lock, so the recovery job either skips (SKIP LOCKED) or blocks and then sees the task is already completed. No work is lost.

---

## Retry Semantics

### Attempt Tracking

`attempt_count` is incremented each time a task is claimed, not when it fails. This accurately reflects the number of processing attempts consumed.

### Retry Scheduling

When a worker reports failure with `retry_after_seconds`, the task returns to `pending` with a future `scheduled_at`. The task is invisible to claim queries until that time passes. This prevents immediate retry storms.

### Dead-Letter Threshold

When `attempt_count >= max_attempts` at the time of failure or lease expiry, the task transitions to `dead_letter`. The threshold is checked identically in both the fail endpoint and the background recovery job.

### Requeue

Dead-lettered tasks can be requeued, which resets `attempt_count` to 0 and returns the task to `pending`. This is an explicit operator action, not an automatic behavior.

---

## Dead-Letter Behavior

Tasks reach `dead_letter` when all retry attempts are exhausted. Dead-lettered tasks:

- Cannot be claimed, completed, failed, or cancelled
- Can only be requeued (explicit action)
- Are eventually purged by the retention cleanup job based on the account's retention window
- Include the original `failure_reason` from the last failed attempt

Dead-letter accumulation is bounded by the retention cleanup system, which purges expired terminal tasks on a 60-second cycle.

---

## Idempotency Guarantees

### Request Deduplication

Task creation supports an `Idempotency-Key` header. When provided:

1. The first request creates the task and stores the response
2. Subsequent requests with the same key return the stored response without creating a duplicate
3. Keys are scoped per account — the same key string used by different accounts creates separate tasks

### Concurrent Safety

The idempotency system uses `INSERT ... ON CONFLICT DO NOTHING` with a composite primary key. Only one concurrent request wins the insert; all others receive the stored response once it is finalized.

### In-Flight Protection

If a response is still being generated (in-flight), concurrent requests with the same key receive a `503` with `retry_after_seconds: 2`. This prevents partial or inconsistent responses.

### Key Expiry

Idempotency keys are automatically purged after 24 hours. A background job runs hourly to remove expired keys.

---

## Rate Limiting

### Tiered Limits

Rate limits scale with the account's plan tier. Higher-tier plans receive proportionally higher limits for task creation, claiming, and read operations.

### Agent-Readable Responses

Rate-limited responses include `agent_contract` with a `retry_after_wait` action and a `Retry-After` header. Agents follow the contract guidance rather than implementing custom backoff logic.

### Quota Enforcement

Monthly task creation quotas are enforced atomically. The quota counter is incremented in the same database operation that validates the limit, preventing concurrent requests from exceeding the quota.

---

## Concurrency Model

### Row-Level Locking

All task mutations use `SELECT ... FOR UPDATE` within transactions. This serializes concurrent operations on the same task, preventing race conditions.

### SKIP LOCKED for Throughput

Batch operations (claim, lease recovery, retention cleanup) use `FOR UPDATE SKIP LOCKED` to avoid blocking on locked rows. This allows high-throughput claiming even when other operations hold locks on individual tasks.

### Account Isolation

Every query filters by `account_id`. A task belonging to one account is invisible to another — cross-account access returns `404`, indistinguishable from a nonexistent task.
