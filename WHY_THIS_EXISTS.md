# Why Orchestrion Exists

This document explains the problem Orchestrion solves and why it was designed the way it was.

---

## The Problem

Coordinating distributed workers is a solved problem — for human-written applications. A developer writes a service, adds retry logic with exponential backoff, wraps calls in try/catch, maps HTTP status codes to recovery actions, and deploys. When something breaks, the developer reads logs, debugs, and fixes the code.

Autonomous agents don't work this way.

An AI agent claiming tasks from a queue may not understand what `409 Conflict` means. It may not know that `429` requires a `Retry-After` header. It may not have pre-programmed logic for every possible error condition. It operates across unreliable networks, may run as one of thousands of independent workers, and has no human watching its logs.

This creates a gap. Traditional job queues assume a developer will handle the edge cases. Agent-based systems need the infrastructure to handle them instead.

---

## The Failure Modes of Traditional Queues

Developers building worker systems encounter the same problems repeatedly:

**Duplicate processing.** Two workers claim the same job simultaneously. Both process it. The customer gets charged twice, the email is sent twice, the report is generated twice. The fix is usually a distributed lock or a database constraint, but the queue itself doesn't prevent it.

**Lost tasks.** A worker pulls a job, begins processing, and crashes. The job is marked as "in progress" and stays there. No one notices until a customer complains. The fix is usually a visibility timeout or a dead-letter mechanism, but many systems leave this to the developer.

**Retry storms.** A task fails because an external API is down. The queue immediately retries it. It fails again. And again. All retry attempts are consumed in seconds, before the external API has time to recover. The task lands in the dead-letter queue. The fix is a retry delay, but many systems don't enforce one.

**Manual recovery.** A job gets stuck in an intermediate state. The queue has no mechanism to detect this. An operator must query the database, identify the stuck job, and manually reset it. At 3 AM.

**Complex client libraries.** Each queue system requires its own client SDK with specific error handling patterns. A new worker means learning a new library, understanding its failure semantics, and implementing custom retry logic.

These problems are manageable when the worker is a service written by a developer who understands the queue's semantics. They become serious when the worker is an autonomous agent that has never seen the queue before and has no developer watching it.

---

## The Key Insight

The central idea behind Orchestrion is simple:

**The server should guide the agent.**

Instead of expecting the client to interpret HTTP status codes, extract retry timing from headers, and implement endpoint-specific error handling, the API returns machine-readable instructions describing exactly what the agent should do next.

Every response — success or error — includes:

```json
{
  "agent_contract": {
    "next_actions": [
      { "action": "retry_after_wait", "retry_after_seconds": 30, "recommended": true }
    ]
  }
}
```

The agent reads one field and follows the recommended action. It doesn't need to know what a `429` means. It doesn't need a pre-programmed mapping of status codes to behaviors. It doesn't need to implement exponential backoff. The server tells it what to do.

This makes the system self-describing. An agent that has never seen the API before can operate safely from the first request, because every response includes the instructions for the next step.

It also makes the system robust to change. If a new error condition is introduced, existing agents still work — the recovery path is always in the contract.

---

## Design Principles

Five principles guided every architectural decision:

**Correctness over complexity.** Every task state transition is validated. Every concurrent operation is serialized through row-level locks. The system uses PostgreSQL's built-in locking rather than external coordination services. Fewer moving parts mean fewer failure modes.

**Deterministic task lifecycle.** A task is always in exactly one of five states: `pending`, `claimed`, `completed`, `dead_letter`, or `cancelled`. Transitions are explicit and validated. There are no implicit state changes, no background mutations the client doesn't know about, and no ambiguous intermediate states.

**Machine-readable recovery.** Every response includes `agent_contract` with `next_actions`. Error responses include the specific recovery action required: authenticate, fix the request, wait and retry, upgrade the plan. No error requires the agent to "figure out" what went wrong.

**Minimal infrastructure dependencies.** The entire system is one Node.js process and one PostgreSQL database. No Redis, no message broker, no external queue, no distributed lock service. This keeps the operational surface small and the failure modes well-understood.

**Composable primitives.** Orchestrion provides one task, one worker, one lifecycle, one contract. Workflows, DAGs, multi-step pipelines, and fan-out/fan-in are composed by agents or applications at a higher layer. The infrastructure doesn't need to understand the workflow — it just needs to manage individual tasks reliably.

---

## Why Not a Workflow Engine

Systems like Temporal, Airflow, and Step Functions are powerful. They manage complex workflows with inter-task dependencies, conditional branching, fan-out/fan-in, and long-running orchestration. They are excellent tools for the problems they solve.

Orchestrion solves a different problem.

Most agent workloads don't need DAG orchestration. An agent needs to claim a task, process it, and report the result. If it fails, the task should be retried with a delay. If all retries are exhausted, the task should be dead-lettered for human review. The agent doesn't need to know about other tasks, other agents, or the overall workflow.

A workflow engine embedded in the task queue imposes opinions about how tasks relate to each other. Orchestrion does not have those opinions. It provides one reliable primitive — claim, work, complete — and lets the agent or developer compose primitives into workflows at the application layer.

This is a deliberate trade-off: less built-in capability in exchange for a smaller failure surface, simpler operations, and fewer assumptions about how the system will be used.

---

## What This Enables

With Orchestrion, developers and agents can:

**Run large fleets of autonomous workers safely.** Thousands of workers can compete for tasks without double-processing, deadlocks, or coordination protocols. `FOR UPDATE SKIP LOCKED` handles the concurrency. The `agent_contract` handles the guidance.

**Build distributed processing without coordination logic.** Workers are stateless. They claim, process, and complete. They don't need to know about each other, don't share state, and don't require leader election.

**Recover automatically from worker crashes.** Leases expire. Tasks return to the queue. Another worker picks them up. No operator intervention required.

**Operate reliably under high concurrency.** Row-level locks serialize state transitions. Partial indexes keep claim queries fast regardless of history volume. Rate limits prevent runaway agents from overwhelming the system.

**Integrate from zero knowledge.** An agent can discover the full API from a single URL (`/.well-known/agent.json`), learn every rule from the capabilities document, register a key, and start working — all without reading documentation written for humans.

---

## The Long-Term Vision

Orchestrion is part of a broader shift in infrastructure design.

For decades, infrastructure APIs were designed for human developers. Error messages are written in English. Recovery procedures are documented in READMEs. Debugging requires reading logs and understanding internal state machines.

As AI agents become more capable, they need infrastructure that communicates with machines rather than humans. APIs that return structured recovery instructions instead of error strings. Systems that guide autonomous clients through failure states instead of expecting them to implement custom handling.

Orchestrion explores what that infrastructure looks like for task orchestration: a system where the `agent_contract` is the primary interface, where every failure has a machine-readable recovery path, and where an agent can operate safely without understanding the implementation underneath.

The question is not whether agents will need this kind of infrastructure. The question is what it should look like. Orchestrion is one answer.
