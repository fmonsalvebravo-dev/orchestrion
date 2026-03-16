# Orchestrion — Agent Integration Guide

Orchestrion is an agent-native task orchestration API. It provides task lifecycle management with lease-based ownership, automatic retry logic, and machine-readable recovery guidance (`agent_contract`) on every response.

This guide explains how an autonomous agent integrates with Orchestrion.

---

## Discovery

Before calling any authenticated endpoint, read the discovery surface:

| Endpoint | Purpose |
|---|---|
| `GET /.well-known/agent.json` | Entry point — links to all discovery resources |
| `GET /v1/capabilities` | Full API limits, error codes, action codes, rate limits |
| `GET /v1/tool` | MCP-compatible tool manifest with input schemas |
| `GET /v1/schema` | OpenAPI 3.1 JSON schema |
| `GET /health` | Health check |

All discovery endpoints are public (no authentication required) and rate-limited at 60 requests per minute per IP.

---

## Authentication

1. Register an API key:

```
POST /v1/keys/register
Content-Type: application/json

{}
```

Response:

```json
{
  "apiKey": "orch_live_...",
  "accountId": "acct_01JXZK..."
}
```

2. Store the `apiKey`. It is returned exactly once — the server stores only a SHA-256 hash.

3. Use the key on all authenticated requests:

```
Authorization: Bearer orch_live_...
```

Keys placed in query strings are rejected with `400 invalid_request`.

---

## Core Workflow

The typical agent workflow is: **create → claim → work → complete**.

### 1. Create a task

```
POST /v1/tasks
Authorization: Bearer orch_live_...
Content-Type: application/json

{
  "type": "generate_report",
  "payload": { "reportId": "rpt-123", "format": "pdf" },
  "priority": 0,
  "maxAttempts": 3,
  "leaseDurationSeconds": 300,
  "idempotencyKey": "job-456:1"
}
```

Required fields: `type`, `payload`. All others are optional.

### 2. Claim work

```
POST /v1/tasks/claim
Authorization: Bearer orch_live_...
Content-Type: application/json

{
  "type": "generate_report",
  "worker_id": "agent-v1-instance-3"
}
```

The server selects the highest-priority available task of the requested type and assigns it atomically. If no work is available, the response contains `"task": null` with `agent_contract.task_claimable: false`.

To claim a specific task by ID:

```
POST /v1/tasks/{id}/claim
```

### 3. Send heartbeats

While working, renew the lease periodically (recommended: every `leaseDurationSeconds / 3`):

```
POST /v1/tasks/{id}/heartbeat
Authorization: Bearer orch_live_...
```

If the lease expires before completion, the task is automatically returned to the queue.

### 4. Complete the task

```
POST /v1/tasks/{id}/complete
Authorization: Bearer orch_live_...
Content-Type: application/json

{
  "result": { "summary": "Generated 42-page report" },
  "output_id": "out_01JXZK..."
}
```

Both `result` (inline structured data) and `output_id` (OutputLayer artifact reference) are optional, but at least one is recommended.

### 5. Report failure

If the task cannot be completed:

```
POST /v1/tasks/{id}/fail
Authorization: Bearer orch_live_...
Content-Type: application/json

{
  "reason": "External API returned 503",
  "retry_after_seconds": 60
}
```

The system decides whether to requeue (if retries remain) or move to `dead_letter` (if exhausted).

---

## The `agent_contract`

Every response — success and error — includes an `agent_contract` field with machine-readable guidance. Agents should read `next_actions` to determine what to do next, rather than parsing HTTP status codes.

```json
{
  "agent_contract": {
    "version": "1",
    "retryable": false,
    "next_actions": [
      {
        "action": "complete_task",
        "available": true,
        "recommended": true,
        "description": "Complete this task and submit the result.",
        "method": "POST",
        "endpoint": "/v1/tasks/tsk_.../complete"
      }
    ],
    "lease_valid": true,
    "lease_expires_in_seconds": 287,
    "recommended_heartbeat_interval_seconds": 100
  }
}
```

See [AGENT_CONTRACT.md](AGENT_CONTRACT.md) for the full protocol specification.

---

## Task Lifecycle

| State | Description |
|---|---|
| `pending` | Queued, awaiting claim |
| `claimed` | A worker holds an active lease |
| `completed` | Finished successfully (terminal) |
| `dead_letter` | All retries exhausted (terminal) |
| `cancelled` | Intentionally abandoned (terminal) |

Key transitions:
- `pending → claimed` via claim
- `claimed → completed` via complete
- `claimed → pending` via fail (retries remaining) or lease expiry
- `claimed → dead_letter` via fail (retries exhausted) or lease expiry
- `pending → cancelled` via cancel
- `dead_letter → pending` via requeue

---

## Idempotency

Task creation supports an optional `idempotencyKey` (max 255 chars, printable ASCII).

| Scenario | Result |
|---|---|
| Same key + same payload | Cached 201 with original task |
| Same key + different payload | 409 `idempotency_conflict` |
| No key | Each call creates a new task |
| Concurrent duplicate | 503 `idempotency_in_flight` (retry after 2s) |

Keys are scoped per API key and expire after 7 days.

---

## Lease Management

- **Duration**: set by the producer at creation (30–3600 seconds, default 300)
- **Renewal**: `POST /v1/tasks/{id}/heartbeat` extends the lease
- **Expiry**: if the lease expires, the task returns to `pending` or moves to `dead_letter`
- **Authority**: same account + `claimed` status + non-expired lease

The `claimed_by` field is observational metadata for logging. It is never used for authorization.

---

## Dead-Letter Handling

Tasks that exhaust all retry attempts move to `dead_letter`. They are retained indefinitely and can be requeued:

```
POST /v1/tasks/{id}/requeue
```

This resets `attempt_count` to 0 and returns the task to `pending`.

---

## Error Handling

Every error response includes `agent_contract` with recommended recovery actions:

| Error Code | HTTP | Recovery |
|---|---|---|
| `missing_api_key` | 401 | `authenticate` — register or provide a key |
| `invalid_api_key` | 401 | `authenticate` — register a new key |
| `invalid_request` | 400 | `fix_request` — correct parameters |
| `task_not_found` | 404 | `list_tasks` — find valid task IDs |
| `invalid_transition` | 409 | `check_task_status` — re-read state |
| `lease_expired` | 409 | `check_task_status` — re-read state |
| `task_currently_claimed` | 409 | `check_task_status` (if task ID known) / `retry_after_wait` — wait for lease expiry |
| `not_yet_claimable` | 409 | `retry_after_wait` — task is scheduled |
| `idempotency_conflict` | 409 | `create_task` — use a different key |
| `idempotency_in_flight` | 503 | `retry_after_wait` — retry with same key |
| `quota_exceeded` | 402 | `upgrade_plan` — purchase a higher tier |
| `plan_expired` | 402 | `renew_plan` — purchase a new plan |
| `max_workers_reached` | 429 | `retry_after_wait` — wait for lease to free up |
| `payment_failed` | 402 | `retry_checkout` — start a new checkout |
| `rate_limited` | 429 | `retry_after_wait` |
| `server_error` | 500 | `retry_after_wait` |

---

## Polling Pattern

```
loop:
  response = POST /v1/tasks/claim { type: "generate_report" }
  if response.task != null:
    process(response.task)
  else if response.agent_contract.retryable:
    wait(response.agent_contract.next_actions[0].retry_after_seconds)
  else:
    break
```

---

## OutputLayer Integration

For large artifacts, upload to OutputLayer and attach the reference:

1. Upload: `POST https://api.outputlayer.dev/v1/outputs`
2. Complete with reference: `POST /v1/tasks/{id}/complete { "output_id": "out_..." }`
3. Downstream agents read `output_id` from the completed task and follow the `download_artifact` action in `agent_contract`.

---

## Rate Limits

| Operation | Limit | Key |
|---|---|---|
| Task creation | 120/hour | API key |
| Task claim | 600/hour | API key |
| Task reads | 3000/hour | API key |
| Task mutations | 600/hour | API key |
| Heartbeat | 1800/hour | API key |
| Discovery | 60/minute | IP |
| Key registration | 10/hour | IP |
| Global | 6000/hour | IP |

Rate-limited responses include `agent_contract` with `retry_after_wait` and `retry_after_seconds`.

Rate limits for task creation and claims are plan-aware — paid plans receive higher limits. See the Billing section below.

---

## Billing

Orchestrion uses a plan-based billing model. Every account starts on the **Free** tier. Paid plans are purchased via a one-time PayPal payment and are active for 30 days.

### Plans

| Tier | Price | Workers | Tasks/Month | Claims/Hour | Creates/Hour | Retention |
|---|---|---|---|---|---|---|
| Free | $0 | 2 | 200 | 120 | 120 | 7 days |
| Basic | $9.99 | 10 | 5,000 | 1,200 | 500 | 30 days |
| Pro | $24.99 | 25 | 25,000 | 4,000 | 2,000 | 60 days |
| Agency | $59.99 | 50 | 150,000 | 15,000 | 7,500 | 90 days |

Discover plans programmatically via `GET /v1/billing/plans` (public, no auth required).

### Quota Enforcement

- **Task creation quota**: `POST /v1/tasks` is gated by the monthly `maxTasksPerMonth` limit. Exceeding this returns `402 quota_exceeded`. Idempotent replays do not count against the quota.
- **Worker limit**: `POST /v1/tasks/claim` checks the number of concurrent active leases for the account. Exceeding `maxWorkers` returns `429 max_workers_reached`.
- **Plan expiry**: When a paid plan expires, the account silently reverts to Free tier limits. If an action would have been allowed on the expired plan but exceeds Free limits, the error is `402 plan_expired`.

### Purchase Flow

**Important:** Billing checkout requires human approval on PayPal. Agents cannot complete payment themselves. The agent must present the checkout URL to the user (or a human operator) for approval.

1. Check current plan: `GET /v1/billing/status`
2. Start checkout: `POST /v1/billing/checkout { "planId": "pro" }` → returns `checkoutUrl`
3. **Human action:** User opens `checkoutUrl` and approves payment on PayPal
4. Verify and activate: `POST /v1/billing/verify { "purchaseId": "pur_..." }`
5. Confirm activation: `GET /v1/billing/status`

```
POST /v1/billing/checkout
Authorization: Bearer orch_live_...
Content-Type: application/json

{ "planId": "pro" }
```

Response:

```json
{
  "purchaseId": "pur_01JXZK...",
  "orderId": "PAYPAL-ORDER-ID",
  "checkoutUrl": "https://www.paypal.com/checkoutnow?token=...",
  "planId": "pro",
  "planName": "Pro",
  "priceUsd": 24.99,
  "checkoutExpiresAt": "2026-03-13T02:00:00.000Z",
  "agent_contract": {
    "version": "1",
    "next_actions": [
      {
        "action": "verify_payment",
        "recommended": true,
        "method": "POST",
        "endpoint": "/v1/billing/verify"
      }
    ]
  }
}
```

After the user approves on PayPal, verify:

```
POST /v1/billing/verify
Authorization: Bearer orch_live_...
Content-Type: application/json

{ "purchaseId": "pur_01JXZK..." }
```

### Plan Renewal

Plans are active for 30 days from activation. When nearing expiry, repeat the purchase flow. Purchasing while an existing plan is active extends from `max(now, current_expiry) + 30 days` — remaining days are preserved.

### Billing Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/v1/billing/plans` | No | List available plans |
| `GET` | `/v1/billing/status` | Yes | Current plan, usage, limits |
| `POST` | `/v1/billing/checkout` | Yes | Start PayPal checkout |
| `POST` | `/v1/billing/verify` | Yes | Capture payment and activate plan |

### Billing Error Codes

| Error Code | HTTP | Recovery |
|---|---|---|
| `quota_exceeded` | 402 | `upgrade_plan` — purchase a higher tier |
| `plan_expired` | 402 | `renew_plan` — purchase a new plan |
| `max_workers_reached` | 429 | `retry_after_wait` — wait for a lease to free up |
| `payment_failed` | 402 | `retry_checkout` — start a new checkout |

---

## Known Edge Cases

### Transient quota rejection on idempotent replays

When creating a task with an `idempotencyKey`, the system reserves a quota slot atomically before checking idempotency state. If the request resolves to an idempotent replay (the task was already created by a prior request with the same key), the reserved slot is released immediately.

In extremely rare timing conditions, a concurrent request may observe the briefly reserved slot and receive a `402 quota_exceeded` rejection even though the account has not truly exhausted its quota. This can only occur when the account is within one slot of its monthly limit and two requests with the same idempotency key arrive within microseconds of each other.

This condition:

- Does not create duplicate tasks
- Does not allow quota bypass
- Does not produce incorrect state
- Resolves automatically — the slot is released and subsequent requests succeed

Agents that encounter an unexpected `quota_exceeded` when using idempotency keys near the quota boundary should follow the standard `agent_contract` guidance: wait briefly and retry. The condition is self-correcting.
