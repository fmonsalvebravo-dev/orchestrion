# Agent Walkthrough

This document walks through a complete interaction between an autonomous agent and the Orchestrion API. It covers discovery, registration, task execution, failure handling, and recovery — the full cycle an agent performs in production.

---

## Overview

Orchestrion is designed for autonomous workers and AI agents that need reliable task execution. An agent with zero prior knowledge can discover the API, register credentials, claim tasks, and operate safely — guided entirely by machine-readable responses.

---

## Step 1: Discover the API

An agent begins by fetching the discovery document:

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

This tells the agent where to find everything: capabilities, tool schemas, the OpenAPI spec, and how to register.

---

## Step 2: Learn Capabilities

```
GET /v1/capabilities
```

The capabilities document describes the full API surface:

- Authentication scheme (Bearer token)
- Task lifecycle states and valid transitions
- Constraint ranges (priority, max_attempts, lease_duration, etc.)
- Error codes and recovery actions
- Rate limits per endpoint
- Available billing plans

An agent reads this once and understands every rule of the system.

---

## Step 3: Get Tool Manifest (Optional)

```
GET /v1/tool
```

Returns an MCP-compatible tool manifest with JSON Schema input definitions for every operation. Agents that support the Model Context Protocol can import these directly as callable tools.

---

## Step 4: Register

```
POST /v1/keys/register
```

Response:

```json
{
  "apiKey": "orch_live_...",
  "accountId": "key_01JXZK..."
}
```

The agent stores the API key securely. This is the only time the plaintext key is returned — it is never stored on the server.

All subsequent requests use the key as a Bearer token:

```
Authorization: Bearer orch_live_...
```

---

## Step 5: Claim a Task

```
POST /v1/tasks/claim
Authorization: Bearer orch_live_...
Content-Type: application/json

{ "type": "process_document" }
```

Response:

```json
{
  "id": "tsk_01JXZK4M...",
  "type": "process_document",
  "status": "claimed",
  "payload": {
    "document_url": "https://example.com/doc.pdf"
  },
  "attemptCount": 1,
  "maxAttempts": 3,
  "leaseExpiresAt": "2026-03-14T19:05:00Z",
  "agent_contract": {
    "version": "1",
    "lease_valid": true,
    "lease_expires_in_seconds": 298,
    "recommended_heartbeat_interval_seconds": 99,
    "next_actions": [
      { "action": "heartbeat", "recommended": true },
      { "action": "complete_task" },
      { "action": "fail_task" }
    ]
  }
}
```

The agent now owns the task. The `agent_contract` tells it exactly what to do:

1. Send heartbeats at the recommended interval
2. Complete the task when done
3. Report failure if processing fails

### When No Tasks Are Available

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

The agent waits 5 seconds and tries again. No guesswork required.

---

## Step 6: Maintain the Lease

While processing, the agent sends heartbeats to prevent lease expiry:

```
POST /v1/tasks/tsk_01JXZK4M.../heartbeat
Authorization: Bearer orch_live_...
```

Response:

```json
{
  "status": "claimed",
  "leaseExpiresAt": "2026-03-14T19:10:00Z",
  "agent_contract": {
    "lease_valid": true,
    "lease_expires_in_seconds": 298,
    "recommended_heartbeat_interval_seconds": 99
  }
}
```

Each heartbeat resets the lease to the full duration. The recommended interval is `lease_duration / 3`, giving the agent two chances to renew before expiry.

**If the agent crashes**, it stops sending heartbeats. After the lease expires, a background job automatically recovers the task — returning it to `pending` for another worker.

---

## Step 7: Complete the Task

```
POST /v1/tasks/tsk_01JXZK4M.../complete
Authorization: Bearer orch_live_...
Content-Type: application/json

{
  "result": { "pages_processed": 42 },
  "outputId": "out_01J..."
}
```

Response:

```json
{
  "id": "tsk_01JXZK4M...",
  "status": "completed",
  "result": { "pages_processed": 42 },
  "agent_contract": {
    "version": "1",
    "next_actions": [
      { "action": "claim_task", "recommended": true }
    ]
  }
}
```

The task is done. The contract tells the agent to claim another task — the work loop continues.

---

## Failure and Retry

If processing fails, the agent reports it:

```
POST /v1/tasks/tsk_01JXZK4M.../fail
Authorization: Bearer orch_live_...
Content-Type: application/json

{
  "reason": "External API returned 503",
  "retry_after_seconds": 60
}
```

Response:

```json
{
  "id": "tsk_01JXZK4M...",
  "status": "pending",
  "attemptCount": 1,
  "maxAttempts": 3,
  "scheduledAt": "2026-03-14T19:06:00Z",
  "agent_contract": {
    "version": "1",
    "next_actions": [
      { "action": "claim_task", "recommended": true }
    ]
  }
}
```

The task returns to `pending` with a future `scheduledAt`. It will not be claimable until that time passes. This prevents retry storms when the failure is caused by a transient external issue.

### Retry Progression

```
Attempt 1 → claim → fail → pending (retry scheduled)
Attempt 2 → claim → fail → pending (retry scheduled)
Attempt 3 → claim → fail → dead_letter (retries exhausted)
```

`attempt_count` increments on each claim. When it reaches `max_attempts`, the next failure transitions the task to `dead_letter`.

### Dead-Letter Recovery

Dead-lettered tasks can be explicitly requeued:

```
POST /v1/tasks/tsk_01JXZK4M.../requeue
```

This resets `attempt_count` to 0 and returns the task to `pending`. Requeue is an intentional operator action, not automatic.

---

## Agent Recovery Logic

The key principle: **always follow `agent_contract.next_actions`**.

An agent's main loop should look like this:

```
1. Claim a task
2. If no task available → follow retry_after_wait guidance
3. If task claimed → process it
   a. Send heartbeats at recommended_heartbeat_interval_seconds
   b. On success → complete the task
   c. On failure → fail the task with retry_after_seconds
4. Read agent_contract.next_actions from the response
5. Follow the recommended action
6. Go to 1
```

### Common Action Codes

| Action | When returned | What the agent should do |
|---|---|---|
| `claim_task` | After completing or failing a task | Claim the next available task |
| `complete_task` | After claiming a task | Complete it when processing is done |
| `fail_task` | After claiming a task | Report failure if processing fails |
| `heartbeat` | After claiming a task | Send periodic lease renewals |
| `retry_after_wait` | Rate limited or no tasks available | Wait the specified seconds, then retry |
| `authenticate` | Missing or invalid credentials | Provide a valid API key |
| `fix_request` | Validation error | Correct the request payload |
| `upgrade_plan` | Plan limits exceeded | Upgrade to a higher plan |
| `requeue_task` | Task is dead-lettered | Requeue for another attempt |

### Why This Matters

Traditional APIs require agents to hardcode status code handling:

```
if status == 429: wait and retry
if status == 401: re-authenticate
if status == 409: check task state
```

With Orchestrion, the agent reads one field:

```
response.agent_contract.next_actions[0].action
```

This works for every response — success or error. New error types can be introduced without breaking existing agents, because the recovery path is always in the contract.

---

## Full Agent Lifecycle Summary

```
┌─────────────────────────────────────────────┐
│  1. GET /.well-known/agent.json             │
│     → discover API surface                  │
│                                             │
│  2. GET /v1/capabilities                    │
│     → learn lifecycle, constraints, limits  │
│                                             │
│  3. POST /v1/keys/register                  │
│     → obtain API key                        │
│                                             │
│  4. POST /v1/tasks/claim                    │
│     → receive task + lease + contract       │
│                                             │
│  5. POST /v1/tasks/{id}/heartbeat           │  ← repeat
│     → maintain lease while working          │     during
│                                             │     work
│  6. POST /v1/tasks/{id}/complete            │
│     or POST /v1/tasks/{id}/fail             │
│     → report outcome                        │
│                                             │
│  7. Read agent_contract.next_actions        │
│     → follow recommended action             │
│                                             │
│  8. Go to step 4                            │
└─────────────────────────────────────────────┘
```
