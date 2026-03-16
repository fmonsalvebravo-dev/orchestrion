# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| V1 (current) | Yes |

## Reporting a Vulnerability

If you discover a security vulnerability in Orchestrion, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, send an email to the project maintainers with:

1. A description of the vulnerability
2. Steps to reproduce (if applicable)
3. The potential impact
4. Any suggested fix (optional)

We will acknowledge receipt within 48 hours and provide an initial assessment within 7 days.

## Security Model

### API Key Management

- API keys use the format `orch_live_{64 hex characters}` (32 random bytes).
- Keys are hashed with SHA-256 before storage. Plaintext keys are never persisted.
- Key comparison uses `crypto.timingSafeEqual()` to prevent timing attacks.
- Keys placed in URL query strings are rejected with `400 invalid_request` to prevent logging exposure.
- Each API key maps to exactly one account.

### Authentication

- All task operations require a `Bearer` token in the `Authorization` header.
- Discovery endpoints (`/.well-known/agent.json`, `/v1/capabilities`, `/v1/tool`, `/v1/schema`) and the health endpoint are public.
- Key registration (`POST /v1/keys/register`) is public but rate-limited to 10 requests per hour per IP.

### Authorization

- All queries are filtered by `account_id`. A task belonging to another account returns `404 task_not_found`, indistinguishable from a nonexistent task.
- Lease authority requires: same account as the task owner + `claimed` status + non-expired lease. The `claimed_by` field is not used for authorization.

### Rate Limiting

- Per-endpoint rate limits are enforced to prevent abuse (see `GET /v1/capabilities` for the full rate limit table).
- V1 uses in-memory rate limit stores. This is a known limitation for horizontally scaled deployments.

### Data Handling

- Task payloads are stored as JSONB with a 64 KB size limit.
- `last_failure_reason` is capped at 500 characters.
- Idempotency keys are scoped per API key and expire after 7 days.
- Request IDs are generated per request and included in all responses for correlation.

### Known V1 Limitations

- Rate limiting is per-process (in-memory), not distributed.
- No TLS termination — deploy behind a reverse proxy (e.g., nginx, Cloudflare) for HTTPS.
- No IP allowlisting or additional access controls beyond API keys.
- `output_id` references to OutputLayer are not validated — dangling references are possible if artifacts expire.
