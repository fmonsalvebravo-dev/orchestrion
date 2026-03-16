# API Philosophy

This document explains the design philosophy behind the Orchestrion API. Every decision was shaped by one constraint: the primary consumers are autonomous agents, not humans reading documentation.

---

## Overview

Traditional APIs assume human-written code: a developer reads the docs, writes error handling, builds retry logic, and deploys. The API communicates through HTTP status codes and error messages designed for humans.

Orchestrion assumes something different:

- **Autonomous clients.** The consumer may be an AI agent that has never seen the API before.
- **Unreliable networks.** Requests may be retried, duplicated, or lost.
- **Large worker fleets.** Many workers compete for the same tasks simultaneously.

The API design reflects these assumptions at every layer.

---

## Machine-Readable Recovery

Every Orchestrion response — success or error — includes an `agent_contract` field:

```json
{
  "agent_contract": {
    "version": "1",
    "next_actions": [
      { "action": "retry_after_wait", "retry_after_seconds": 30, "recommended": true }
    ]
  }
}
```

The agent reads `next_actions` and follows the recommended action. It does not need to:

- Parse HTTP status codes
- Interpret error messages
- Implement endpoint-specific retry logic
- Handle unfamiliar error conditions

If Orchestrion introduces a new error type tomorrow, existing agents still work — the recovery path is always in the contract.

### Why This Matters

A traditional agent must hardcode behavior:

```
if status == 429: extract Retry-After, wait, retry
if status == 401: re-authenticate
if status == 409: fetch task state, decide next step
if status == 503: exponential backoff
```

An Orchestrion agent has one rule:

```
follow response.agent_contract.next_actions[0]
```

This collapses an entire error-handling state machine into a single field read.

---

## Deterministic Task Lifecycle

Tasks follow a strict lifecycle with validated transitions:

```
pending → claimed → completed
pending → cancelled
claimed → pending    (retry)
claimed → dead_letter (exhausted)
dead_letter → pending (requeue)
```

Every transition is explicit. There are no implicit state changes, no background state mutations that the client doesn't know about, and no ambiguous intermediate states.

This matters for automation because:

- An agent can reason about task state without polling for updates
- A task is always in exactly one of five states
- Invalid transitions are rejected with a clear error and recovery guidance
- Terminal states (`completed`, `dead_letter`, `cancelled`) are immutable

Agents must never encounter ambiguous state. If a task is `claimed`, it has a lease. If it is `pending`, it is claimable (subject to scheduling). If it is `completed`, it is done forever.

---

## Lease-Based Ownership

Orchestrion uses leases instead of permanent claims because permanent claims fail silently when workers crash.

With permanent claims:

1. Worker claims task
2. Worker crashes
3. Task is locked forever
4. Operator must manually detect and release it

With leases:

1. Worker claims task with a time-limited lease
2. Worker crashes
3. Lease expires automatically
4. Background job returns task to the queue

Leases make the system self-healing. No operator intervention is required. The heartbeat mechanism gives workers control over lease duration — as long as a worker is actively sending heartbeats, its lease remains valid.

The recommended heartbeat interval is `lease_duration / 3`, giving two chances to renew before expiry. This tolerates brief network interruptions without losing work.

---

## Poll-Based Coordination

Orchestrion uses polling (`POST /v1/tasks/claim`) instead of push-based task delivery (webhooks, WebSockets, server-sent events).

### Why Polling

| Concern | Push | Poll |
|---|---|---|
| Infrastructure | Requires callback URLs, retry queues, delivery confirmation | Single HTTP endpoint |
| Failure handling | Failed delivery must be retried with backoff | Worker simply polls again |
| Scaling | Server must track connections per worker | Workers are stateless |
| Agent compatibility | Requires persistent connections or public endpoints | Works with any HTTP client |
| NAT/firewall | Callbacks may be blocked | Outbound requests work everywhere |

Push-based delivery solves latency — tasks are delivered the instant they are available. But it introduces significant infrastructure complexity: delivery guarantees, connection management, retry logic for failed callbacks, and authentication of incoming webhooks.

For autonomous agents, the latency difference between instant push and 5-second polling is negligible. The simplicity and reliability of polling outweigh the latency cost.

### How Workers Poll

```
POST /v1/tasks/claim → task available → process it
POST /v1/tasks/claim → no_tasks → wait per agent_contract, retry
```

The `agent_contract` tells the worker exactly how long to wait before retrying. Workers don't need to implement exponential backoff or jitter — the server provides the timing.

---

## Minimal Primitive Model

Orchestrion provides five core operations:

| Operation | Endpoint |
|---|---|
| Create a task | `POST /v1/tasks` |
| Claim a task | `POST /v1/tasks/claim` |
| Complete a task | `POST /v1/tasks/{id}/complete` |
| Fail a task | `POST /v1/tasks/{id}/fail` |
| Renew a lease | `POST /v1/tasks/{id}/heartbeat` |

Plus three lifecycle operations: cancel, requeue, and list/get for visibility.

Everything else — workflows, DAGs, orchestration logic, multi-step pipelines, fan-out/fan-in — is composed by agents or applications at a higher layer.

This is an intentional design constraint. A workflow engine embedded in the task queue would impose opinions about how tasks relate to each other. Orchestrion does not have those opinions. It provides one task, one worker, one lifecycle, one contract. Composition happens above.

---

## Stability Over Features

The system intentionally avoids features that increase operational complexity:

| Excluded Feature | Reason |
|---|---|
| DAG workflows | Imposes inter-task dependency model; agents compose this at the application layer |
| Distributed consensus | PostgreSQL row locking provides equivalent safety without external coordination |
| Multi-queue routing | All tasks share one queue filtered by `type`; simpler to reason about |
| Callback/webhook systems | Adds delivery infrastructure; polling is sufficient for agent workloads |
| Priority aging | Adds queue complexity; predictable priority ordering is clearer for V1 |

Each of these features has valid use cases. They are excluded because they increase the failure surface and operational burden disproportionately to their benefit for the primary use case: autonomous agent task execution.

---

## Predictable Failure Behavior

The API guarantees specific failure behavior:

| Guarantee | Mechanism |
|---|---|
| Tasks are never lost | Every task is in one of five defined states; no transition drops a task |
| Retries are explicit | Failed tasks return to `pending` with a future `scheduled_at`; no implicit retry |
| Dead-letter is terminal | `dead_letter` tasks stop cycling; only explicit `requeue` restarts them |
| Recovery is deterministic | Every error response includes the exact recovery action in `agent_contract` |

An agent can safely operate without human supervision because every failure mode has a defined, machine-readable recovery path. The agent never encounters a state where it must "figure out" what went wrong.

---

## Summary

Orchestrion's API is designed around one idea: **agents should be able to operate reliably without understanding the implementation**. The `agent_contract` is the interface. The lifecycle is the state machine. The lease is the safety net. Everything else is kept simple so these three mechanisms can be trusted absolutely.
