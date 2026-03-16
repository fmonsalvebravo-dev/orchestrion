# `agent_contract` Protocol Specification

This document defines the `agent_contract` protocol used by Orchestrion V1. Every API response — success and error — includes a top-level `agent_contract` field that provides machine-readable recovery guidance. Agents should read this field to determine their next action rather than parsing HTTP status codes or error message strings.

---

## Structure

```typescript
interface AgentContract {
  version: '1'
  retryable: boolean
  next_actions: Action[]
  task_claimable?: boolean
  lease_valid?: boolean
  lease_expires_in_seconds?: number | null
  recommended_heartbeat_interval_seconds?: number
}

interface Action {
  action: string
  available: boolean
  recommended: boolean
  description?: string
  method?: string
  endpoint?: string
  retry_after_seconds?: number
}
```

---

## Fields

### `version`

Always `"1"` for V1. This field enables forward-compatible parsing. Agents should verify `version === "1"` and fall back to safe behavior if it does not match.

### `retryable`

`true` if the exact same request can be retried and may succeed. `false` if the agent must change something (fix the request, check state, use a different key) before retrying.

### `next_actions`

Array of `Action` objects, ordered by recommendation priority. The first action with `recommended: true` is the primary guidance. Agents may inspect additional actions for alternative paths.

### `task_claimable` (contextual)

Present only on claim responses.
- `true`: a task was found and returned.
- `false`: the queue was empty for the requested type.

### `lease_valid` (contextual)

Present only when the task is in `claimed` status.
- `true`: the lease is active (`lease_expires_at > now()`).
- `false`: the lease has expired but the background job has not yet reclaimed the task.

### `lease_expires_in_seconds` (contextual)

Present only when the task is in `claimed` status. Integer seconds until the lease expires. `0` if already expired. `null` if the task has no lease data.

### `recommended_heartbeat_interval_seconds` (contextual)

Present only when the task is in `claimed` status with an active lease. Computed as `Math.floor(lease_duration_seconds / 3)`. Agents should use this value as the interval between heartbeat calls to keep the lease alive.

---

## Action Fields

### `action`

A stable action code from the V1 action code set. See the full list below.

### `available`

`true` if the agent can perform this action now. `false` if it is listed for informational purposes (e.g., an action that will become available after a wait).

### `recommended`

`true` if this is the suggested next step. Exactly one action in the array should have `recommended: true` in most cases.

### `description`

Human-readable explanation. Agents should not parse this field programmatically — use `action` instead.

### `method`

HTTP method for the action endpoint (e.g., `"GET"`, `"POST"`). Present when the action maps to an API call.

### `endpoint`

URL path or full URL for the action. Present when the action maps to an API call. May contain task-specific IDs (e.g., `/v1/tasks/tsk_01.../complete`).

### `retry_after_seconds`

Advisory wait time before retrying. Present on `retry_after_wait` actions. Agents may apply jitter or exponential backoff using this as the minimum floor.

---

## Action Codes (V1)

| Code | Meaning |
|---|---|
| `create_task` | Create a new task |
| `claim_task` | Claim an available task |
| `complete_task` | Complete the claimed task with a result |
| `fail_task` | Report task failure |
| `heartbeat` | Renew the lease to keep the task claimed |
| `check_task_status` | Re-read the task state before acting |
| `requeue_task` | Re-queue a dead-letter task |
| `retry_after_wait` | Wait and retry (rate limit, empty queue, transient error) |
| `authenticate` | Register or provide an API key |
| `fix_request` | Correct request parameters |
| `download_artifact` | Retrieve the artifact from OutputLayer |
| `list_tasks` | List tasks to find valid IDs |

---

## Contract by Task Status

| Task Status | `task_claimable` | `lease_valid` | Recommended Action |
|---|---|---|---|
| `pending` | — | — | `claim_task` |
| `claimed` (lease active) | — | `true` | `complete_task` |
| `claimed` (lease expired) | — | `false` | `check_task_status` |
| `completed` (with `output_id`) | — | — | `download_artifact`, `claim_task` |
| `completed` (no `output_id`) | — | — | `create_task`, `claim_task` |
| `dead_letter` | — | — | `requeue_task` |
| `cancelled` | — | — | `create_task` |
| Claim (task found) | `true` | — | `complete_task` |
| Claim (queue empty) | `false` | — | `retry_after_wait` |

---

## Contract on Error Responses

Every error response includes `agent_contract` with the recommended recovery action:

| Error Code | `retryable` | Recommended Action |
|---|---|---|
| `missing_api_key` | `true` | `authenticate` |
| `invalid_api_key` | `false` | `authenticate` |
| `invalid_request` | `false` | `fix_request` |
| `task_not_found` | `false` | `list_tasks` |
| `invalid_transition` | `false` | `check_task_status` |
| `lease_expired` | `false` | `check_task_status` |
| `task_currently_claimed` | `true` | `check_task_status` / `retry_after_wait` |
| `not_yet_claimable` | `true` | `retry_after_wait` |
| `idempotency_conflict` | `false` | `create_task` |
| `idempotency_in_flight` | `true` | `retry_after_wait` |
| `rate_limited` | `true` | `retry_after_wait` |
| `server_error` | `true` | `retry_after_wait` |

---

## Stability Guarantee

**Breaking changes** (require `/v2/` and 6-month deprecation):
- Removing or renaming an action code
- Removing or renaming an error code
- Removing or renaming an `agent_contract` field
- Changing the semantics of `task_claimable`

**Non-breaking changes** (stay in `/v1/`):
- Adding new optional fields to `AgentContract`
- Adding new optional fields to `Action`
- Adding new action codes
- Adding new error codes

Agents should ignore unknown fields and unknown action codes rather than failing. This ensures forward compatibility as the protocol evolves.

---

## Implementation Notes

- The `agent_contract` is always present at the top level of the response body — never nested inside another object.
- On success responses, it appears alongside the task data. On error responses, it appears alongside `error`, `message`, and `request_id`.
- Discovery endpoints (`/v1/capabilities`, `/v1/tool`, `/v1/schema`, `/.well-known/agent.json`) do not include `agent_contract` — they are static documents, not API responses.
- The `version` field is a string (`"1"`), not an integer.
