# Orchestrion Protocol

Version: 1

This document defines the formal contract between autonomous agents and the Orchestrion API. It is intended as a protocol specification — any developer or AI agent can implement a compatible client using only this document.

---

## Overview

The Orchestrion protocol defines how autonomous agents interact with a task orchestration system over HTTP.

The protocol is based on three core ideas:

1. **Deterministic task lifecycle.** Tasks exist in exactly one of five defined states. Transitions are explicit, validated, and predictable.
2. **Lease-based task ownership.** Workers hold time-limited leases on tasks. Crashed workers are recovered automatically when leases expire.
3. **Machine-readable recovery instructions.** Every response includes an `agent_contract` object with `next_actions` that tells the agent exactly what to do next.

The `agent_contract` is the primary interface. Agents follow its instructions rather than interpreting HTTP status codes or error messages.

---

## Core Concepts

### Tasks

A task is a unit of work stored in the system. Each task contains:

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique identifier (ULID, prefixed `tsk_`) |
| `type` | string | Task category (1–100 chars, alphanumeric + hyphens + underscores) |
| `status` | enum | Current lifecycle state |
| `payload` | object | Arbitrary JSON data provided by the creator (max 64 KB) |
| `result` | object | Arbitrary JSON data provided on completion (max 64 KB) |
| `priority` | integer | Claim ordering priority (0–100, default 0) |
| `maxAttempts` | integer | Maximum processing attempts (1–10, default 3) |
| `attemptCount` | integer | Number of claims consumed |
| `scheduledAt` | ISO 8601 | Earliest time the task can be claimed (null = immediately) |
| `leaseDurationSeconds` | integer | Lease length on claim (30–3600, default 300) |
| `leaseExpiresAt` | ISO 8601 | Current lease expiration (null when not claimed) |
| `createdAt` | ISO 8601 | Task creation timestamp |
| `updatedAt` | ISO 8601 | Last state change timestamp |
| `failureReason` | string | Reason from the last failed attempt |
| `outputId` | string | Optional reference to an external artifact |

Tasks are processed by workers that claim them from the queue.

### Workers

A worker is any process that:

1. Claims a task from the queue
2. Processes the task's payload
3. Reports the result (complete or fail)

Workers are stateless and independent. They do not coordinate with each other, share memory, or require a client SDK. Concurrency is managed entirely by the server through database-level locking.

A worker's identity is established by the `claimed_by` field set during claim. Multiple workers authenticate with the same API key but operate independently.

### Leases

When a worker claims a task, it receives a time-limited lease. The lease grants exclusive ownership of the task for a defined duration.

| Parameter | Range | Default |
|---|---|---|
| Lease duration | 30–3600 seconds | 300 seconds |
| Recommended heartbeat interval | `lease_duration / 3` | 100 seconds |

**Heartbeat renewal:** Workers extend their lease by calling the heartbeat endpoint. Each heartbeat resets `leaseExpiresAt` to `now() + leaseDurationSeconds`. The recommended interval of `duration / 3` provides two renewal opportunities before expiry.

**Expiry recovery:** If a worker stops sending heartbeats (crash, network failure, process exit), the lease expires. A background job detects expired leases and returns the task to `pending` for another worker, or moves it to `dead_letter` if all attempts are exhausted.

---

## Task Lifecycle

### Valid States

| State | Terminal | Description |
|---|---|---|
| `pending` | No | Queued and available for claim (subject to `scheduledAt`) |
| `claimed` | No | Held by a worker with an active lease |
| `completed` | Yes | Processing finished successfully |
| `dead_letter` | Yes | All retry attempts exhausted |
| `cancelled` | Yes | Intentionally abandoned before processing |

### Valid Transitions

| From | To | Trigger |
|---|---|---|
| _(new)_ | `pending` | Task creation |
| `pending` | `claimed` | Worker claim |
| `claimed` | `completed` | Worker completes successfully |
| `claimed` | `pending` | Worker fails with retries remaining |
| `claimed` | `pending` | Lease expires with retries remaining |
| `claimed` | `dead_letter` | Worker fails with retries exhausted |
| `claimed` | `dead_letter` | Lease expires with retries exhausted |
| `pending` | `cancelled` | Cancel request |
| `dead_letter` | `pending` | Requeue request |

### Terminal State Immutability

Once a task reaches `completed`, `dead_letter`, or `cancelled`, no operation can modify it. The only exception is `requeue`, which transitions `dead_letter → pending` and resets `attemptCount` to 0.

Any attempt to mutate a terminal task returns an error with `agent_contract` guidance.

### Attempt Counting

`attemptCount` is incremented when a task is **claimed**, not when it fails. This reflects the number of processing attempts consumed. The dead-letter threshold is: `attemptCount >= maxAttempts` at the time of failure or lease expiry.

### Claim Ordering

When multiple pending tasks are available, they are assigned in this order:

```
priority DESC,
scheduled_at ASC NULLS FIRST,
created_at ASC
```

1. Higher priority first
2. Among equal priority, earliest scheduled time first (null = immediately available)
3. Among equal schedule, FIFO by creation time

---

## Agent Contract

Every response from the API includes an `agent_contract` object. This is the primary interface between the server and the agent.

### Structure

```json
{
  "agent_contract": {
    "version": "1",
    "next_actions": [
      {
        "action": "heartbeat",
        "recommended": true
      },
      {
        "action": "complete_task"
      }
    ]
  }
}
```

### Fields

| Field | Type | Description |
|---|---|---|
| `version` | string | Protocol version (currently `"1"`) |
| `next_actions` | array | Ordered list of actions the agent can take |
| `next_actions[].action` | string | Action code (see Standard Actions) |
| `next_actions[].recommended` | boolean | Whether this is the suggested next step |
| `next_actions[].retry_after_seconds` | integer | Seconds to wait before retrying (when applicable) |
| `next_actions[].method` | string | HTTP method for the action (when applicable) |
| `next_actions[].endpoint` | string | API path for the action (when applicable) |

Additional fields may appear on claimed task responses:

| Field | Type | Description |
|---|---|---|
| `lease_valid` | boolean | Whether the current lease is active |
| `lease_expires_in_seconds` | integer | Seconds remaining on the lease |
| `recommended_heartbeat_interval_seconds` | integer | Suggested heartbeat frequency |

### Agent Behavior

An agent SHOULD:

1. Read `agent_contract.next_actions` from every response
2. Follow the action marked `recommended: true`
3. Use `retry_after_seconds` when the action is `retry_after_wait`
4. Not hardcode HTTP status code handling — rely on the contract instead

An agent MAY choose a non-recommended action from the list if it has domain-specific reasons to do so.

---

## Standard Actions

| Action | Description | Typical Context |
|---|---|---|
| `claim_task` | Claim the next available task | After completing or failing a task |
| `complete_task` | Report successful completion | While holding a claimed task |
| `fail_task` | Report processing failure | While holding a claimed task |
| `heartbeat` | Renew the lease | While processing a claimed task |
| `retry_after_wait` | Wait N seconds, then retry the same request | Rate limited, no tasks available, or in-flight idempotency |
| `authenticate` | Provide valid credentials | Missing or invalid API key |
| `fix_request` | Correct the request payload | Validation error |
| `upgrade_plan` | Upgrade to a higher plan | Quota or worker limit exceeded |
| `requeue_task` | Requeue a dead-lettered task | Task is in dead_letter state |
| `check_task_status` | Fetch current task state | After ambiguous failure |
| `verify_payment` | Complete a pending payment | After PayPal checkout approval |

---

## Error Semantics

Errors do not require interpretation of HTTP status codes. The `agent_contract` in every error response provides the recovery path.

| HTTP Status | Error Condition | Contract Action |
|---|---|---|
| `400` | Invalid request parameters | `fix_request` |
| `401` | Missing or invalid credentials | `authenticate` |
| `402` | Quota exhausted or plan expired | `upgrade_plan` |
| `404` | Resource not found | `claim_task` or `fix_request` |
| `409` | Invalid state transition or lease expired | `claim_task` or `check_task_status` |
| `429` | Rate limit or worker limit exceeded | `retry_after_wait` or `upgrade_plan` |
| `503` | Idempotency slot in-flight | `retry_after_wait` |

The protocol guarantees: **every error response includes at least one action in `agent_contract.next_actions`**. An agent never encounters an error without a machine-readable recovery path.

---

## Discovery

Agents discover the API using a standard well-known URL:

```
GET /.well-known/agent.json
```

Response:

```json
{
  "name": "Orchestrion",
  "description": "Agent-native task orchestration API",
  "capabilities_url": "/v1/capabilities",
  "tool_manifest_url": "/v1/tool",
  "openapi_schema_url": "/v1/schema",
  "registration_url": "/v1/keys/register",
  "documentation_url": "/AGENTS.md"
}
```

| Field | Purpose |
|---|---|
| `capabilities_url` | Full API surface: lifecycle, constraints, error codes, rate limits, billing |
| `tool_manifest_url` | MCP-compatible tool definitions with JSON Schema inputs |
| `openapi_schema_url` | OpenAPI 3.1 specification |
| `registration_url` | API key registration endpoint |
| `documentation_url` | Human-readable integration guide |

An agent can integrate from zero knowledge by reading the discovery document, fetching capabilities, registering a key, and following `agent_contract` instructions on every subsequent response.

---

## Concurrency Model

Task claiming uses database row-level locking:

```sql
SELECT ... FOR UPDATE SKIP LOCKED
```

This provides three guarantees:

1. **Mutual exclusion.** Only one transaction can lock a given task row. The first worker wins.
2. **Non-blocking.** `SKIP LOCKED` causes concurrent transactions to skip locked rows instead of waiting. Workers never block each other.
3. **Deadlock freedom.** Because workers never wait for locks held by other workers, circular dependencies cannot form.

All task mutations (complete, fail, heartbeat, cancel, requeue) use `FOR UPDATE` within transactions to serialize concurrent operations on the same task.

Concurrency safety is enforced by the database. Workers do not need distributed locks, leader election, or coordination protocols.

---

## Idempotency

Task creation supports an `Idempotency-Key` header to prevent duplicate tasks from network retries.

### Behavior

| Scenario | Result |
|---|---|
| First request with key | Task is created; response is stored |
| Duplicate request with same key | Stored response is returned; no new task created |
| Same key, different account | Treated as separate (keys are scoped per account) |
| Concurrent requests with same key | One wins; others receive the stored response or `503` with retry guidance |

### Key Properties

| Property | Value |
|---|---|
| Scope | Per account (composite: key + API key hash) |
| Expiry | 24 hours |
| Max length | 255 characters, printable ASCII |

Idempotency protects agents operating in unreliable network environments. An agent can safely retry any task creation request without risk of creating duplicates.

---

## Protocol Guarantees

The Orchestrion protocol provides the following guarantees:

| Guarantee | Mechanism |
|---|---|
| Tasks are never silently lost | Every task exists in one of five defined states; no transition drops a task |
| Workers cannot double-process the same task | `FOR UPDATE SKIP LOCKED` serializes claim operations |
| Failed tasks retry only after a scheduled delay | `scheduled_at` makes tasks invisible to claim queries until the retry window elapses |
| Dead-letter tasks stop retrying automatically | `dead_letter` is a terminal state; only explicit `requeue` restarts processing |
| Every failure response includes recovery instructions | `agent_contract.next_actions` is present on every error response |
| Leases prevent stuck tasks | Expired leases are recovered automatically by a background job |
| Terminal states are immutable | `completed`, `dead_letter`, and `cancelled` cannot be modified (except requeue from dead_letter) |

---

## Versioning

The protocol version is defined in the `agent_contract.version` field. The current version is `"1"`.

Future protocol versions:

- MUST remain backward compatible when possible
- MUST increment the version number for breaking changes
- SHOULD introduce new action codes without removing existing ones
- SHOULD preserve the `next_actions` structure

Agents SHOULD check `agent_contract.version` and log a warning if they encounter an unknown version, but SHOULD still attempt to follow `next_actions` — the action/recommended pattern is designed to be forward-compatible.
