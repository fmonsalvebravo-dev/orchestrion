# Security Model

Orchestrion uses a simple but strict security model. This document explains how the system protects task data, API access, and system integrity.

---

## Overview

The security model is built around four principles:

- **API key authentication** — every request is authenticated with a hashed credential
- **Account-level isolation** — every query is scoped to a single account
- **Database-enforced constraints** — invalid states are prevented at the schema level
- **Safe failure behavior** — failures always resolve to a known, recoverable state

The system prioritizes predictable behavior under failure and misuse over feature complexity.

---

## API Key Authentication

### How It Works

1. A client calls `POST /v1/keys/register` to create an API key
2. The server generates a cryptographically random key: `orch_live_` + 64 hex characters
3. The plaintext key is returned **once** in the registration response
4. Only a SHA-256 hash of the key is stored in the database

All subsequent requests authenticate via:

```
Authorization: Bearer orch_live_...
```

### Key Properties

| Property | Detail |
|---|---|
| Generation | 32 cryptographically random bytes (256 bits of entropy) |
| Storage | SHA-256 hash only — plaintext is never persisted |
| Retrieval | Impossible — lost keys must be replaced |
| Comparison | Constant-time via `crypto.timingSafeEqual()` |
| Query string | Explicitly rejected to prevent log exposure |

If the database is compromised, an attacker obtains only hashes. SHA-256 is preimage-resistant — the original keys cannot be recovered from the hashes.

---

## Account Isolation

Every database query includes an `account_id` filter:

```sql
SELECT ... FROM tasks WHERE account_id = $1 AND ...
```

This guarantees:

- Tasks belonging to one account are invisible to other accounts
- Cross-account access returns `404`, not `403` — no information leakage about whether a resource exists in another account
- There is no API endpoint that returns data across accounts
- There is no way to enumerate other accounts' resources

Account isolation is enforced at the query level, not at an application middleware layer. Every service function receives `accountId` as a required parameter and includes it in every query.

---

## Authorization Model

Orchestrion uses a single-account API key model. One API key maps to one account. A key grants access only to that account's resources:

- Tasks (create, claim, list, get, complete, fail, cancel, requeue)
- Usage and billing status
- Purchase records

There are no cross-account operations, no admin keys, and no shared resources. This keeps the authorization surface minimal and eliminates an entire class of privilege escalation vulnerabilities.

---

## Rate Limiting

Rate limits protect the API from abuse, runaway agents, and accidental request storms.

Limits are applied per API key and vary by plan tier:

| Scope | Example Limit |
|---|---|
| Task creation | 120–7,500/hour (by plan) |
| Task claiming | 600–15,000/hour (by plan) |
| Task reads | 3,000/hour |
| Key registration | 10/hour (by IP) |
| Discovery endpoints | 60/minute (by IP) |

Rate-limited responses include:

- HTTP `429` status code
- `Retry-After` header with seconds to wait
- `agent_contract.next_actions` with `retry_after_wait` guidance

Agents follow the contract guidance rather than implementing custom backoff logic. This prevents rate-limited agents from degrading into uncontrolled retry loops.

---

## Input Validation

Every endpoint validates input before processing:

| Parameter | Validation |
|---|---|
| Task type | 1–100 characters, alphanumeric + hyphens + underscores |
| Payload / result | JSON object, max 64 KB, max 5 levels of nesting |
| Priority | Integer 0–100 |
| Max attempts | Integer 1–10 |
| Lease duration | Integer 30–3600 seconds |
| Scheduled at | ISO 8601, must be future, max 30 days ahead |
| Idempotency key | Max 255 characters, printable ASCII |
| Failure reason | Max 500 characters |

Invalid requests return structured error responses with `agent_contract` guidance explaining how to fix the request. Malformed input cannot corrupt system state because validation occurs before any database operation.

---

## Idempotency Protection

The `Idempotency-Key` header protects against duplicate task creation in unreliable network environments.

| Property | Detail |
|---|---|
| Scope | Per account (composite key: idempotency key + API key hash) |
| Duplicate behavior | Returns the stored response from the original request |
| Concurrent safety | `INSERT ... ON CONFLICT DO NOTHING` — only one request wins |
| In-flight handling | Concurrent requests receive `503` with retry guidance |
| Expiry | Keys are purged after 24 hours |

This protects agents that retry after network timeouts, connection resets, or ambiguous failures. The agent can safely retry without creating duplicate tasks.

---

## Database Safety

PostgreSQL constraints and transactions enforce correctness at the schema level:

| Mechanism | What It Prevents |
|---|---|
| `CHECK (status IN (...))` | Invalid task states |
| `CHECK (priority >= 0 AND priority <= 100)` | Out-of-range priority |
| `CHECK (max_attempts >= 1 AND max_attempts <= 10)` | Invalid attempt limits |
| `CHECK (lease_duration_seconds >= 30 AND ...)` | Unreasonable lease durations |
| `FOR UPDATE` / `FOR UPDATE SKIP LOCKED` | Race conditions on state transitions |
| `UNIQUE (paypal_capture_id)` | Duplicate payment activation |
| Transactions | Partial state updates |

Every mutation runs inside a database transaction. If any step fails, the entire operation rolls back. There is no possibility of a task being partially updated — it either transitions completely or not at all.

---

## Failure Safety

The system is designed so that every failure mode resolves to a known, recoverable state:

| Failure | Recovery |
|---|---|
| Worker crash | Lease expires → task returns to `pending` or `dead_letter` |
| Network failure | Same as crash — heartbeats stop, lease expires |
| Process restart | Task state is in the database, unaffected by restart |
| Database transaction failure | Transaction rolls back — no partial state |
| Background job failure | `try/catch` prevents server crash; next cycle runs normally |

The database is the single source of truth. The API server is stateless. Any server instance can be replaced without losing task state.

---

## Responsible Disclosure

Security vulnerabilities should be reported privately to the maintainers. See [SECURITY.md](SECURITY.md) for contact information and disclosure policy.
