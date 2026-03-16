# Design Decisions

This document explains the key architectural decisions behind Orchestrion. It is intended for engineers evaluating the system or continuing its development.

---

## Overview

Orchestrion is an agent-native task orchestration API. It manages individual tasks — create, claim, work, complete — with strong lifecycle guarantees.

The system prioritizes:

- **Correctness under concurrency** — no task is ever claimed twice, lost, or silently corrupted
- **Deterministic task lifecycle** — every state transition is validated and constrained
- **Agent-readable recovery guidance** — every response includes machine-readable next actions
- **Predictable retry behavior** — retries follow explicit scheduling, not implicit requeue

Orchestrion is intentionally not a workflow engine. There are no DAGs, no inter-task dependencies, no fan-out/fan-in. It provides reliable single-task orchestration primitives that agents and developers compose into higher-level workflows.

---

## Task Claim Model

### Why `FOR UPDATE SKIP LOCKED`

The claim query uses `SELECT ... FOR UPDATE SKIP LOCKED` inside a transaction. This was chosen over alternatives for three reasons:

1. **No double-claiming.** The `FOR UPDATE` lock ensures only one transaction can claim a given task. The second concurrent claim either skips (SKIP LOCKED) or blocks and sees the task is already claimed.

2. **No lock contention.** `SKIP LOCKED` means workers never wait for each other. If a task is locked by another transaction, the query skips it and selects the next eligible task. Under heavy load, this degrades gracefully — some workers get `no_tasks` and retry with backoff.

3. **High worker concurrency.** Unlike advisory locks or external coordination (Redis, ZooKeeper), this approach uses PostgreSQL's built-in row locking. No external dependencies, no distributed lock management, no lock expiry complexity.

### Claim Ordering

Tasks are claimed in this order:

```
priority DESC, scheduled_at ASC NULLS FIRST, created_at ASC
```

- Higher priority first
- Among equal priority, earliest scheduled time first (NULL means immediately available)
- Among equal schedule, FIFO by creation time

This ordering is backed by a partial index (`tasks_claim_idx`) that only includes pending tasks. The index stays small regardless of total task history.

---

## Lease-Based Ownership

### Why Leases Instead of Permanent Claims

A permanent claim model requires the worker to explicitly release the task when done. If the worker crashes, the task is locked forever unless an operator intervenes.

Leases solve this automatically:

- A worker receives a time-limited lease when it claims a task
- The worker must complete the task or send heartbeats before the lease expires
- If the worker crashes, the lease expires and the task is recovered automatically

### Lease Parameters

| Parameter | Range | Default |
|---|---|---|
| Duration | 30–3600 seconds | 300 seconds |
| Heartbeat interval | Recommended at `duration / 3` | 100 seconds |

### Expiry Recovery

A background job runs every 30 seconds to detect expired leases. It uses `FOR UPDATE SKIP LOCKED` to avoid interfering with active workers. For each expired task:

- If retries remain → return to `pending`
- If retries exhausted → move to `dead_letter`

### Worker-Wins Semantics

If a worker completes a task at the same moment the lease expires, the worker wins. The completion holds the row lock, so the recovery job skips the task. No work is lost.

---

## Retry Scheduling

### Why `scheduled_at` Instead of Immediate Requeue

When a task fails with retries remaining, it could be immediately returned to the pending queue. This creates two problems:

1. **Retry storms.** If the failure is caused by a transient external dependency (API rate limit, temporary outage), immediate retry will fail again instantly, consuming all attempts in seconds.

2. **Unfair queue behavior.** An immediately-requeued task competes with fresh tasks, potentially starving new work or being starved itself depending on priority.

Instead, the fail endpoint accepts `retry_after_seconds`. The task returns to `pending` with a future `scheduled_at`. The claim query filters `WHERE scheduled_at IS NULL OR scheduled_at <= now()`, making the task invisible until its retry window elapses.

This gives the external dependency time to recover and keeps queue behavior predictable.

---

## Dead-Letter Queue

### Why Tasks Transition to `dead_letter`

Without a dead-letter mechanism, a consistently-failing task would retry forever, consuming worker capacity and never resolving.

The `dead_letter` state provides:

- **Bounded retries.** `max_attempts` (1–10) caps the number of processing attempts. When exhausted, the task stops cycling.
- **Failure preservation.** The `failure_reason` from the last attempt is preserved on the task record for debugging.
- **Explicit recovery.** Dead-lettered tasks can be requeued by an operator or automation, which resets `attempt_count` to 0. This is an intentional action, not an automatic loop.

Dead-lettered tasks are eventually purged by the retention cleanup job based on the account's retention window, preventing unbounded accumulation.

---

## Idempotency Design

### Why `Idempotency-Key` on Task Creation

Agents operate in unreliable network environments. A task creation request might succeed on the server but the response might be lost (timeout, connection reset). Without idempotency, the agent retries and creates a duplicate task.

The `Idempotency-Key` header prevents this:

1. First request claims an idempotency slot and creates the task
2. Subsequent requests with the same key return the stored response
3. Keys are scoped per account — different accounts can safely use the same key string

The implementation uses `INSERT ... ON CONFLICT DO NOTHING` on a composite key `(key, api_key_hash)`. Only one concurrent request wins the insert. All others receive the stored response once finalized.

### In-Flight Protection

If the original request is still processing when a retry arrives, the retry receives `503` with `retry_after_seconds: 2`. This prevents partial or inconsistent responses.

### Key Expiry

Idempotency keys expire after 24 hours and are purged by a background job. This bounds storage growth while providing a generous replay window.

---

## Agent Contract Design

### The Problem

Traditional APIs communicate outcomes through HTTP status codes and error messages written for humans. An agent receiving `429 Too Many Requests` must have pre-programmed logic to interpret the code, extract retry timing from headers, and decide what to do next.

This breaks when:

- The agent encounters an unfamiliar error code
- The retry strategy differs between endpoints
- The error requires a specific recovery action (authenticate, upgrade plan, fix the request)

### The Solution

Every Orchestrion response — success or error — includes an `agent_contract` field:

```json
{
  "agent_contract": {
    "version": "1",
    "next_actions": [
      {
        "action": "retry_after_wait",
        "retry_after_seconds": 30,
        "recommended": true
      }
    ]
  }
}
```

The agent reads `next_actions` and follows the recommended action. It never needs to parse status codes, interpret error messages, or implement endpoint-specific retry logic.

### Action Codes

Each action code maps to a specific recovery behavior:

| Code | Meaning |
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

### What Orchestrion Deliberately Avoids

| Capability | Why excluded |
|---|---|
| Workflow DAGs | Adds complexity that most agent use cases don't need. Agents compose simple task primitives into workflows at the application layer. |
| Push notifications / webhooks | Requires callback infrastructure, retry logic for delivery, and authentication of incoming webhooks. Polling with `claim` is simpler and more reliable for agents. |
| Complex distributed coordination | Redis, ZooKeeper, or consensus protocols add operational dependencies. PostgreSQL row locking provides equivalent safety for single-database deployments. |
| Priority aging | Low-priority task starvation is a real concern at scale, but the current priority model is predictable and sufficient for V1. |
| Multi-queue isolation | All tasks share one logical queue filtered by `type`. Named queues with separate configuration add complexity without clear V1 demand. |

### What It Focuses On

Orchestrion provides the smallest reliable building block: **one task, one worker, one lifecycle, one contract.** Everything else is composed by the agent or the developer at the application layer.

This keeps the operational surface small, the failure modes well-understood, and the system easy to reason about under concurrent load.
