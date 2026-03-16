# Test Environment

This document describes the general testing environment used during Orchestrion development and validation.

---

## Runtime

| Component | Version |
|---|---|
| Node.js | LTS (v18+) |
| TypeScript | 5.x |
| Package manager | npm |

---

## Database

| Component | Details |
|---|---|
| Engine | PostgreSQL 16 |
| Schema management | Idempotent SQL (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ADD COLUMN IF NOT EXISTS`) |
| Schema application | Automatic on server startup |

---

## Testing Tools

| Tool | Purpose |
|---|---|
| **Jest** | Test runner and assertion framework |
| **Supertest** | In-process HTTP testing against Express |
| **pg (node-postgres)** | Direct database queries for setup, verification, and cleanup |
| **EXPLAIN ANALYZE** | Query plan verification at scale |

---

## Infrastructure Characteristics

Testing was performed in two environments:

### Local Development

| Spec | Details |
|---|---|
| OS | Windows 10 Home |
| CPU | Intel Core i5-9600K @ 3.70 GHz (6 cores) |
| RAM | 16 GB |
| Database | PostgreSQL 16 (local) |

- Local PostgreSQL instance
- No disk or memory constraints
- Used for large-scale retention benchmarks (10K–500K tasks)
- Full `EXPLAIN ANALYZE` profiling at each scale

### Cloud-Hosted

- Container-based Linux environment
- Managed PostgreSQL
- Single-instance deployment during development
- Used for integration testing and API validation

---

## Test Isolation

- Each test suite registers a dedicated API key and account
- Test data uses identifiable prefixes for safe cleanup
- `afterAll` hooks remove all test-created data
- Tests do not depend on pre-existing database state

---

## Test Coverage

| Category | Test files | Approximate test count |
|---|---|---|
| Unit and integration | 34 | 450+ |
| Load and concurrency | 29 | 100+ |
| **Total** | **63** | **560+** |

---

## Continuous Integration

Tests are designed to run in any environment with Node.js and PostgreSQL available. No external services, mock servers, or proprietary tooling are required.

```bash
# Install dependencies
npm install

# Run all tests
npm test

# Run load tests separately (database required)
npx jest src/__tests__/load/ --no-coverage
```
