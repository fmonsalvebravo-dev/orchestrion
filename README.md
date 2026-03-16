# Orchestrion

Orchestrion is an agent-native task orchestration API designed for autonomous workers and AI agents.

It manages task lifecycle, worker leases, retry scheduling, dead-letter queues, and provides machine-readable recovery guidance on every response.

---

## Why Orchestrion

Agents and distributed workers need a reliable way to coordinate task execution. Existing job queues are designed for human-written code with try/catch blocks and retry libraries. Agents need something different:

- **Safe concurrent claiming.** Multiple workers can race for tasks without double-processing. `FOR UPDATE SKIP LOCKED` guarantees each task is assigned to exactly one worker.
- **Automatic recovery.** If a worker crashes, its lease expires and the task is recovered automatically. No operator intervention required.
- **Predictable retries.** Failed tasks return to the queue with a scheduled retry window, preventing retry storms and giving transient failures time to resolve.
- **Machine-readable recovery.** Every response includes an `agent_contract` with `next_actions` that tells the agent exactly what to do next. No status code parsing required.

---

## Key Features

- Deterministic task lifecycle (`pending → claimed → completed / dead_letter / cancelled`)
- Lease-based worker ownership with heartbeat renewal
- Retry scheduling with `scheduled_at` delays
- Dead-letter handling with explicit requeue
- Idempotent task creation via `Idempotency-Key`
- `agent_contract` on every response — machine-readable next actions and recovery guidance
- MCP-compatible tool manifest (`GET /v1/tool`)
- OpenAPI 3.1 schema (`GET /v1/schema`)
- Agent discovery document (`GET /.well-known/agent.json`)
- Plan-based billing with quota and rate limit enforcement

---

## Example Workflow

```bash
# 1. Register an API key
curl -X POST https://api.orchestrion.dev/v1/keys/register

# 2. Create a task
curl -X POST https://api.orchestrion.dev/v1/tasks \
  -H "Authorization: Bearer orch_live_..." \
  -H "Content-Type: application/json" \
  -d '{ "type": "process_document", "payload": { "url": "https://..." } }'

# 3. Claim a task
curl -X POST https://api.orchestrion.dev/v1/tasks/claim \
  -H "Authorization: Bearer orch_live_..." \
  -H "Content-Type: application/json" \
  -d '{ "type": "process_document" }'

# 4. Send heartbeats while working
curl -X POST https://api.orchestrion.dev/v1/tasks/{id}/heartbeat \
  -H "Authorization: Bearer orch_live_..."

# 5. Complete the task
curl -X POST https://api.orchestrion.dev/v1/tasks/{id}/complete \
  -H "Authorization: Bearer orch_live_..." \
  -H "Content-Type: application/json" \
  -d '{ "result": { "pages": 42 } }'
```

Every response includes `agent_contract.next_actions` telling the worker what to do next.

---

## Agent Discovery

An agent with zero prior knowledge can discover the full API from a single URL:

```
GET /.well-known/agent.json
```

This returns links to the capabilities document, tool manifest, OpenAPI schema, and registration endpoint. The agent reads these once and understands every rule of the system.

---

## Documentation

| Document | Description |
|---|---|
| [AGENTS.md](AGENTS.md) | Agent integration guide |
| [AGENT_CONTRACT.md](AGENT_CONTRACT.md) | `agent_contract` protocol specification |
| [AGENT_WALKTHROUGH.md](AGENT_WALKTHROUGH.md) | Step-by-step agent interaction walkthrough |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Internal system architecture |
| [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md) | Key architectural decisions and rationale |
| [CONCURRENCY_MODEL.md](CONCURRENCY_MODEL.md) | Concurrency safety model |
| [RELIABILITY.md](RELIABILITY.md) | Reliability guarantees |
| [OPERATIONS.md](OPERATIONS.md) | Production operations guide |
| [SECURITY.md](SECURITY.md) | Security policy |
| [SECURITY_MODEL.md](SECURITY_MODEL.md) | Security model deep-dive |
| [API_PHILOSOPHY.md](API_PHILOSOPHY.md) | API design philosophy |
| [WHY_THIS_EXISTS.md](WHY_THIS_EXISTS.md) | Design motivation and problem statement |
| [PROTOCOL.md](PROTOCOL.md) | Formal protocol specification |
| [TESTING.md](TESTING.md) | Testing methodology |
| [LOAD_TESTING.md](LOAD_TESTING.md) | Load and performance testing |
| [TEST_ENVIRONMENT.md](TEST_ENVIRONMENT.md) | Test environment description |

---

## Running Locally

### Requirements

- Node.js v18+
- PostgreSQL 16

### Setup

```bash
# Install dependencies
npm install

# Set environment
# Create .env with:
#   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/orchestrion_dev
#   PORT=3000

# Create the database
psql -U postgres -c "CREATE DATABASE orchestrion_dev;"

# Build and run (schema is applied automatically on startup)
npm run build
npm start

# Or use dev mode
npm run dev
```

The server starts on `http://localhost:3000`. The schema is applied automatically on startup — no manual migration step required.

### Tests

```bash
# Unit and integration tests
npm test

# Load tests (requires database)
npx jest src/__tests__/load/ --no-coverage
```

---

## License

All rights reserved.
