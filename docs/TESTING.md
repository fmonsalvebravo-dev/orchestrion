# Testing Methodology

Orchestrion uses a layered testing strategy designed for the specific reliability requirements of a task orchestration API. Every lifecycle transition, concurrency path, and error recovery mechanism is validated before deployment.

---

## Philosophy

A task queue must be correct under concurrency. Dropped tasks, duplicate claims, or violated lifecycle invariants are unacceptable. The test suite is structured to verify not just happy-path behavior, but every edge case where concurrent workers, expired leases, and retry scheduling intersect.

---

## Test Categories

### Unit Tests

Isolated tests for individual services and utilities.

| Area | What is verified |
|---|---|
| API key generation | SHA-256 hashing, prefix extraction, key format |
| Plan catalog | Plan definitions, effective plan resolution, expiry logic |
| Agent contract builder | Correct `agent_contract` structure for every response type |
| Error contract | Recovery action mapping for all error codes |
| ULID generation | Time-ordered, prefixed, globally unique IDs |
| Account plan service | Lazy cycle reset, quota tracking, plan caching |

### Lifecycle Tests

End-to-end tests covering every valid state transition.

| Transition | Test coverage |
|---|---|
| `(new) → pending` | Task creation with all field combinations |
| `pending → claimed` | Server-assigned and explicit claim paths |
| `claimed → completed` | With result, with `outputId`, idempotent re-complete |
| `claimed → pending` | Fail with retries remaining, retry delay scheduling |
| `claimed → dead_letter` | Fail with retries exhausted |
| `pending → cancelled` | Cancel, idempotent re-cancel |
| `dead_letter → pending` | Requeue with attempt count reset |

Invalid transitions are also verified:

- Completing a pending task → rejected
- Claiming a completed task → rejected
- Cancelling a claimed task → rejected
- Failing a pending task → rejected

### Contract Validation

Every API response — success or error — includes an `agent_contract` field. Tests verify:

- Correct `next_actions` for each task state
- Valid action codes (`claim_task`, `complete_task`, `fail_task`, `heartbeat`, `retry_after_wait`, etc.)
- Recovery guidance on every error response (authentication, validation, rate limiting, quota)
- Consistent contract structure across all endpoints

### Concurrency Tests

Race condition tests using parallel HTTP requests against a live server instance.

| Scenario | What is verified |
|---|---|
| Simultaneous claim | Only one worker wins; others receive `no_tasks` or block |
| Claim vs lease expiry | Heartbeat/complete and expiry job cannot both process the same task |
| Fail vs lease expiry | Worker fail and background expiry are mutually exclusive |
| Complete vs lease expiry | Worker complete wins if it holds the row lock |
| Concurrent task creation | Idempotency keys prevent duplicates under parallel requests |

### Retry Logic Tests

| Scenario | What is verified |
|---|---|
| Fail with retries remaining | Task returns to `pending`, `attempt_count` preserved |
| Fail with `retry_after_seconds` | `scheduled_at` is set correctly for delayed retry |
| Retry exhaustion | Task transitions to `dead_letter` when `attempt_count >= max_attempts` |
| Requeue from dead letter | `attempt_count` resets to 0, task is claimable again |
| Repeated failures across workers | Each claim increments `attempt_count`; dead-letter occurs at the correct threshold |

### Idempotency Tests

| Scenario | What is verified |
|---|---|
| Duplicate creation with same key | Second request returns the original task, no duplicate created |
| Concurrent requests with same key | Only one task is created; others receive the cached response |
| Different keys, same payload | Two distinct tasks are created (keys are per-request, not per-payload) |
| Cross-account key isolation | Same idempotency key string used by different accounts creates separate tasks |
| In-flight slot recovery | Stale slots (>90s) are reclaimed safely |

### Billing Flow Tests

| Scenario | What is verified |
|---|---|
| Plan catalog | Correct pricing, limits, and feature sets for all tiers |
| Quota enforcement | Task creation blocked when monthly quota is exhausted |
| Worker limit enforcement | Claim rejected when concurrent worker limit is reached |
| Plan-aware rate limits | Higher-tier plans receive proportionally higher rate limits |
| Checkout flow | PayPal order creation returns valid approval URL |
| Payment verification | Capture activates plan atomically; duplicate capture is idempotent |
| Plan expiry | Expired plans revert to Free tier limits |

### Discovery and Schema Tests

| Scenario | What is verified |
|---|---|
| `/.well-known/agent.json` | Returns valid discovery document with correct links |
| `/v1/capabilities` | Complete API surface description |
| `/v1/tool` | MCP-compatible tool manifest with valid JSON Schema inputs |
| `/v1/schema` | Valid OpenAPI 3.1 document |

---

## Running Tests

```bash
# All tests
npm test

# Specific category
npx jest src/__tests__/lifecycle.phase5.test.ts
npx jest src/__tests__/concurrency.races.test.ts
npx jest src/__tests__/tasks.claim.concurrency.test.ts

# Load tests (requires database)
npx jest src/__tests__/load/
```

---

## Test Infrastructure

- **Framework**: Jest with TypeScript
- **HTTP testing**: Supertest (in-process Express server)
- **Database**: PostgreSQL (schema applied automatically before each suite)
- **Isolation**: Each test suite uses a dedicated account to prevent cross-test interference
- **Cleanup**: Test data is removed in `afterAll` hooks
