# Load Testing

Orchestrion was load-tested to verify correctness and stability under concurrent worker pressure. The goal was not to find maximum throughput, but to confirm that no race conditions, ordering violations, or data corruption occur under realistic multi-worker scenarios.

---

## Tools

| Tool | Purpose |
|---|---|
| **Jest + Supertest** | Concurrent HTTP request simulation with assertion-level control |
| **Direct SQL seeding** | Bulk task generation via `INSERT ... SELECT generate_series()` for large-scale benchmarks |
| **EXPLAIN ANALYZE** | Query plan verification at scale to confirm index usage |

---

## Scenarios Tested

### Concurrent Task Claiming

Multiple workers issue `POST /v1/tasks/claim` simultaneously for the same task type.

**Verified:**
- Only one worker receives each task (no double-claiming)
- `FOR UPDATE SKIP LOCKED` prevents contention-related failures
- Workers that lose the race receive `no_tasks` with retry guidance
- Claim ordering respects `priority DESC, scheduled_at ASC NULLS FIRST, created_at ASC`

### Thundering Herd

10+ concurrent claim requests arrive within milliseconds when only a small number of tasks are available.

**Verified:**
- Each task is assigned to exactly one worker
- No deadlocks or lock contention errors
- Response times remain stable under contention

### Task Creation Bursts

Rapid sequential and parallel task creation to stress the insertion path.

**Verified:**
- Idempotency keys prevent duplicates under parallel creation
- Index maintenance does not degrade insertion latency
- Quota enforcement remains correct under burst traffic

### Heartbeat Frequency

Workers sending heartbeats at recommended intervals while other workers claim and complete tasks concurrently.

**Verified:**
- Lease renewal is atomic and conflict-free
- Heartbeat does not interfere with concurrent claim operations on other tasks
- Expired leases are recovered correctly even under heavy heartbeat traffic

### Retry Scheduling Under Load

Tasks failing and re-entering the pending queue while new tasks are continuously created and claimed.

**Verified:**
- Retry scheduling respects `scheduled_at` — tasks are not claimable before their retry window
- `attempt_count` increments correctly across multiple workers
- Dead-letter transition occurs at the exact `max_attempts` threshold

### Worker Limit Enforcement

Concurrent claims exceeding the account's worker limit.

**Verified:**
- Worker count is checked atomically during claim
- Concurrent claims cannot exceed the plan's `maxWorkers` limit
- Rejected claims receive `max_workers_reached` with retry guidance

### Lease Expiry Under Load

Background lease expiry job running while workers actively heartbeat, complete, and fail tasks.

**Verified:**
- The expiry job and active workers never process the same task simultaneously
- `FOR UPDATE SKIP LOCKED` ensures mutual exclusion
- Completed tasks are never touched by the expiry job

---

## Retention Capacity Benchmarks

Large-scale benchmarks validated system behavior under significant task history accumulation.

### Scales Tested

| Scale | Tasks seeded | Purpose |
|---|---|---|
| 10,000 | Baseline | Validate seeding infrastructure and index sizes |
| 100,000 | Medium | Confirm stable operation under moderate history |
| 500,000 | Large | Stress-test query plans and index efficiency |

### Operations Benchmarked

| Operation | Result at 500K history |
|---|---|
| **Task claiming** | Constant latency — partial index on pending tasks stays small |
| **Task listing** | Flat performance — backward PK scan with LIMIT is O(1) effective |
| **Task get by ID** | Constant — primary key lookup |
| **Task creation** | Stable — INSERT is independent of history volume |
| **Lease expiry** | Constant — partial index on claimed tasks stays small |
| **Retention cleanup** | Bounded by batch size (1000 rows per cycle) |

### Key Finding

`EXPLAIN ANALYZE` confirmed that the critical claim query uses the partial index (`tasks_claim_idx`) at all scales. Execution time was flat at 0.034–0.040ms from 10K to 500K rows. The partial index only contains pending tasks, so it stays small regardless of total history volume.

---

## Metrics Measured

| Metric | How measured |
|---|---|
| Request latency (p50, p95, p99) | Timestamps around HTTP calls in test harness |
| Success rate | Assertion on HTTP status codes |
| Error rate | Count of unexpected failures vs expected rejections |
| Claim throughput | Tasks claimed per second under concurrent load |
| Seeding throughput | Rows inserted per second via bulk SQL |
| Query execution time | PostgreSQL `EXPLAIN ANALYZE` actual time |
| Index sizes | `pg_relation_size()` before and after seeding |

---

## Running Load Tests

```bash
# All load tests
npx jest src/__tests__/load/ --no-coverage

# Specific scenario
npx jest src/__tests__/load/claim.thundering-herd.test.ts
npx jest src/__tests__/load/retention.list-under-history.test.ts
```

Load tests require a running PostgreSQL instance. They create and clean up their own test data.
