// ─── Agent contract builders ──────────────────────────────────────────────────
//
// This module is the single source of truth for all agent contract generation.
//
// Builders:
//   - buildTaskContract   — success responses (GET, POST create, claim, heartbeat, etc.)
//   - buildClaimContract  — claim success (adds task_claimable: true)
//   - buildNoWorkContract — claim empty-queue response
//   - buildErrorContract  — error responses (Phase 6A: maps error codes to next actions)
//
// ─── V1 stability guarantee ───────────────────────────────────────────────────
// Breaking changes (require /v2/ + 6-month deprecation):
//   removing or renaming action codes, contract fields, or task_claimable semantics.
// Non-breaking (stay in /v1/): adding new optional fields or action codes.

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Action {
  action: string
  available: boolean
  recommended: boolean
  description?: string
  method?: string
  endpoint?: string
  retry_after_seconds?: number
}

export interface BillingContext {
  plan: string
  workers_in_use: number
  workers_limit: number
}

export interface AgentContract {
  version: '1'
  retryable: boolean
  next_actions: Action[]
  /** Present on claim responses only: true = task returned, false = queue empty */
  task_claimable?: boolean
  /** Present when status = 'claimed'; indicates whether the lease is still active */
  lease_valid?: boolean
  /** Present when status = 'claimed'; seconds until lease expires (0 if already expired) */
  lease_expires_in_seconds?: number | null
  /** Present when status = 'claimed' and lease is valid; recommended heartbeat interval in seconds (lease_duration / 3) */
  recommended_heartbeat_interval_seconds?: number
  /** Present on billing-related errors; provides plan and usage context */
  billing_context?: BillingContext
}

type TaskStatus = 'pending' | 'claimed' | 'completed' | 'dead_letter' | 'cancelled'

// ─── Task contract ────────────────────────────────────────────────────────────

/**
 * Builds the agent_contract for a task response.
 * Used by GET /v1/tasks/:id, GET /v1/tasks (list items), and POST /v1/tasks (create).
 *
 * Does NOT include task_claimable — that field is claim-context only.
 * Use buildClaimContract() for claim endpoint responses.
 */
export function buildTaskContract(task: {
  id: string
  status: TaskStatus
  leaseExpiresAt: Date | null
  outputId: string | null
  leaseDurationSeconds?: number
}): AgentContract {
  const { id, status, leaseExpiresAt, outputId, leaseDurationSeconds } = task
  const now = Date.now()

  switch (status) {
    case 'pending':
      return {
        version: '1',
        retryable: false,
        next_actions: [
          {
            action: 'claim_task',
            available: true,
            recommended: true,
            description: 'Claim this task to begin work.',
            method: 'POST',
            endpoint: '/v1/tasks/claim',
          },
        ],
      }

    case 'claimed': {
      const leaseValid = leaseExpiresAt != null && leaseExpiresAt.getTime() > now
      const leaseExpiresInSeconds = leaseExpiresAt != null
        ? Math.max(0, Math.floor((leaseExpiresAt.getTime() - now) / 1000))
        : null

      return {
        version: '1',
        retryable: false,
        lease_valid: leaseValid,
        lease_expires_in_seconds: leaseExpiresInSeconds,
        ...(leaseValid && leaseDurationSeconds != null
          ? { recommended_heartbeat_interval_seconds: Math.floor(leaseDurationSeconds / 3) }
          : {}),
        next_actions: leaseValid
          ? [
              {
                action: 'complete_task',
                available: true,
                recommended: true,
                description: 'Complete this task and submit the result.',
                method: 'POST',
                endpoint: `/v1/tasks/${id}/complete`,
              },
              {
                action: 'fail_task',
                available: true,
                recommended: false,
                description: 'Fail this task attempt.',
                method: 'POST',
                endpoint: `/v1/tasks/${id}/fail`,
              },
              {
                action: 'heartbeat',
                available: true,
                recommended: false,
                description: 'Renew the lease to keep this task claimed.',
                method: 'POST',
                endpoint: `/v1/tasks/${id}/heartbeat`,
              },
            ]
          : [
              {
                action: 'check_task_status',
                available: true,
                recommended: true,
                description: 'Lease has expired. Check current task status before acting.',
                method: 'GET',
                endpoint: `/v1/tasks/${id}`,
              },
            ],
      }
    }

    case 'completed':
      return {
        version: '1',
        retryable: false,
        next_actions: outputId
          ? [
              {
                action: 'download_artifact',
                available: true,
                recommended: true,
                description: 'Download the artifact from OutputLayer.',
                method: 'GET',
                endpoint: `https://api.outputlayer.dev/v1/outputs/${outputId}/content`,
              },
              {
                action: 'claim_task',
                available: true,
                recommended: false,
                description: 'Claim another task to continue processing.',
                method: 'POST',
                endpoint: '/v1/tasks/claim',
              },
            ]
          : [
              {
                action: 'create_task',
                available: true,
                recommended: true,
                description: 'Task is complete. Create a new task if follow-up work is needed.',
                method: 'POST',
                endpoint: '/v1/tasks',
              },
              {
                action: 'claim_task',
                available: true,
                recommended: false,
                description: 'Claim another task to continue processing.',
                method: 'POST',
                endpoint: '/v1/tasks/claim',
              },
            ],
      }

    case 'dead_letter':
      return {
        version: '1',
        retryable: false,
        next_actions: [
          {
            action: 'requeue_task',
            available: true,
            recommended: true,
            description: 'Re-queue this dead-letter task to retry.',
            method: 'POST',
            endpoint: `/v1/tasks/${id}/requeue`,
          },
        ],
      }

    case 'cancelled':
      return {
        version: '1',
        retryable: false,
        next_actions: [
          {
            action: 'create_task',
            available: true,
            recommended: true,
            description: 'Task was cancelled. Create a new task if needed.',
            method: 'POST',
            endpoint: '/v1/tasks',
          },
        ],
      }
  }
}

// ─── Claim success contract ───────────────────────────────────────────────────

/**
 * Builds the agent_contract for a successful claim response.
 * Identical to buildTaskContract but adds task_claimable: true to signal
 * that a task was found and returned (as opposed to the empty-queue case).
 */
export function buildClaimContract(task: {
  id: string
  status: TaskStatus
  leaseExpiresAt: Date | null
  outputId: string | null
  leaseDurationSeconds?: number
}): AgentContract {
  return {
    ...buildTaskContract(task),
    task_claimable: true,
  }
}

// ─── No-work contract ─────────────────────────────────────────────────────────

/**
 * Builds the agent_contract for a claim response when no tasks are available.
 *
 * This contract is stable for V1. Agents may unconditionally rely on:
 *   - task_claimable: false
 *   - next_actions[0].action: 'retry_after_wait'
 *   - next_actions[0].retry_after_seconds: 5
 */
export function buildNoWorkContract(): AgentContract {
  return {
    version: '1',
    retryable: true,
    task_claimable: false,
    next_actions: [
      {
        action: 'retry_after_wait',
        available: true,
        recommended: true,
        retry_after_seconds: 5,
        description: 'No tasks of the requested type are currently available. Retry after waiting.',
        method: 'POST',
        endpoint: '/v1/tasks/claim',
      },
    ],
  }
}

// ─── Error contract ──────────────────────────────────────────────────────────

/**
 * Optional context passed to buildErrorContract for error-code-specific
 * contract generation. Only two fields — kept minimal to avoid leaking
 * route-level knowledge into the contract layer.
 */
export interface ErrorContext {
  /** Task ID for task-specific errors (populates check_task_status endpoint) */
  taskId?: string
  /** Retry delay in seconds (populates retry_after_wait action) */
  retryAfterSeconds?: number
  /** Billing context for worker-limit and quota errors */
  billingContext?: BillingContext
}

/**
 * Builds the agent_contract for an error response.
 *
 * Maps each error code to:
 *   - retryable: whether the same request can succeed if retried
 *   - next_actions: machine-readable guidance for the agent
 *
 * Unknown error codes fall back to a server_error-style contract
 * (retryable with retry_after_wait). This ensures the function never
 * throws and always returns a valid contract.
 *
 * Phase 6A: defines the catalog. Phase 6B will wire it into sendError.
 */
export function buildErrorContract(
  errorCode: string,
  context?: ErrorContext,
): AgentContract {
  const taskId = context?.taskId
  const retryAfterSeconds = context?.retryAfterSeconds

  switch (errorCode) {
    // 405 wrong method — tell the agent the correct method
    case 'wrong_method':
      return {
        version: '1',
        retryable: true,
        next_actions: [
          {
            action: 'authenticate',
            available: true,
            recommended: true,
            description: 'Register a new API key via POST /v1/keys/register.',
            method: 'POST',
            endpoint: '/v1/keys/register',
          },
        ],
      }

    case 'missing_api_key':
      return {
        version: '1',
        retryable: true,
        next_actions: [
          {
            action: 'authenticate',
            available: true,
            recommended: true,
            description: 'Provide a valid API key in the Authorization header.',
            method: 'POST',
            endpoint: '/v1/keys/register',
          },
        ],
      }

    case 'invalid_api_key':
      return {
        version: '1',
        retryable: false,
        next_actions: [
          {
            action: 'authenticate',
            available: true,
            recommended: true,
            description: 'The API key is invalid or deactivated. Register a new key.',
            method: 'POST',
            endpoint: '/v1/keys/register',
          },
        ],
      }

    case 'invalid_request':
      return {
        version: '1',
        retryable: false,
        next_actions: [
          {
            action: 'fix_request',
            available: true,
            recommended: false,
            description: 'Fix the request parameters based on the error message and retry.',
          },
        ],
      }

    case 'task_not_found':
      return {
        version: '1',
        retryable: false,
        next_actions: [
          {
            action: 'list_tasks',
            available: true,
            recommended: true,
            description: 'List available tasks to find a valid task ID.',
            method: 'GET',
            endpoint: '/v1/tasks',
          },
        ],
      }

    case 'invalid_transition':
      return {
        version: '1',
        retryable: false,
        next_actions: taskId
          ? [
              {
                action: 'check_task_status',
                available: true,
                recommended: true,
                description: 'Check the current task status.',
                method: 'GET',
                endpoint: `/v1/tasks/${taskId}`,
              },
            ]
          : [
              {
                action: 'list_tasks',
                available: true,
                recommended: true,
                description: 'List tasks to check current state.',
                method: 'GET',
                endpoint: '/v1/tasks',
              },
            ],
      }

    case 'lease_expired':
      return {
        version: '1',
        retryable: false,
        next_actions: taskId
          ? [
              {
                action: 'check_task_status',
                available: true,
                recommended: true,
                description: 'Lease has expired. Check whether the task was reclaimed.',
                method: 'GET',
                endpoint: `/v1/tasks/${taskId}`,
              },
            ]
          : [
              {
                action: 'claim_task',
                available: true,
                recommended: true,
                description: 'Lease has expired. Claim a new task.',
                method: 'POST',
                endpoint: '/v1/tasks/claim',
              },
            ],
      }

    case 'task_currently_claimed': {
      const actions: Action[] = []
      if (taskId) {
        actions.push({
          action: 'check_task_status',
          available: true,
          recommended: true,
          description: 'Task is currently claimed. Wait for the lease to expire, then retry.',
          method: 'GET',
          endpoint: `/v1/tasks/${taskId}`,
        })
      }
      actions.push({
        action: 'retry_after_wait',
        available: true,
        recommended: !taskId,
        retry_after_seconds: 30,
        description: 'Wait for the lease to expire and check again.',
      })
      return {
        version: '1',
        retryable: true,
        next_actions: actions,
      }
    }

    case 'not_yet_claimable': {
      const actions: Action[] = [
        {
          action: 'retry_after_wait',
          available: true,
          recommended: true,
          retry_after_seconds: retryAfterSeconds ?? 30,
          description: 'Task is scheduled for future execution.',
        },
      ]
      if (taskId) {
        actions.push({
          action: 'check_task_status',
          available: true,
          recommended: false,
          description: 'Check the task status.',
          method: 'GET',
          endpoint: `/v1/tasks/${taskId}`,
        })
      }
      return {
        version: '1',
        retryable: true,
        next_actions: actions,
      }
    }

    case 'idempotency_conflict':
      return {
        version: '1',
        retryable: false,
        next_actions: [
          {
            action: 'create_task',
            available: true,
            recommended: true,
            description: 'Use a different idempotency key for a different request.',
            method: 'POST',
            endpoint: '/v1/tasks',
          },
        ],
      }

    case 'idempotency_in_flight':
      return {
        version: '1',
        retryable: true,
        next_actions: [
          {
            action: 'retry_after_wait',
            available: true,
            recommended: true,
            retry_after_seconds: 2,
            description: 'A request with this key is in progress. Retry shortly with the same key.',
          },
        ],
      }

    case 'quota_exceeded':
      return {
        version: '1',
        retryable: false,
        next_actions: [
          {
            action: 'upgrade_plan',
            available: true,
            recommended: true,
            description: 'Task creation quota exhausted for this billing cycle. Upgrade your plan for higher limits.',
            method: 'POST',
            endpoint: '/v1/billing/checkout',
          },
          {
            action: 'check_billing_status',
            available: true,
            recommended: false,
            description: 'Check current plan usage and limits.',
            method: 'GET',
            endpoint: '/v1/billing/status',
          },
        ],
      }

    case 'plan_expired':
      return {
        version: '1',
        retryable: false,
        next_actions: [
          {
            action: 'renew_plan',
            available: true,
            recommended: true,
            description: 'Your plan has expired. Purchase a new plan to restore higher limits.',
            method: 'POST',
            endpoint: '/v1/billing/checkout',
          },
          {
            action: 'check_billing_status',
            available: true,
            recommended: false,
            description: 'Check current plan status.',
            method: 'GET',
            endpoint: '/v1/billing/status',
          },
        ],
      }

    case 'max_workers_reached':
      return {
        version: '1',
        retryable: true,
        next_actions: [
          {
            action: 'retry_after_wait',
            available: true,
            recommended: true,
            retry_after_seconds: 30,
            description: 'Concurrent worker limit reached. Wait for a lease to free up.',
          },
          {
            action: 'upgrade_plan',
            available: true,
            recommended: false,
            description: 'Upgrade your plan for higher worker limits.',
            method: 'POST',
            endpoint: '/v1/billing/checkout',
          },
        ],
        ...(context?.billingContext ? { billing_context: context.billingContext } : {}),
      }

    case 'payment_failed':
      return {
        version: '1',
        retryable: false,
        next_actions: [
          {
            action: 'retry_checkout',
            available: true,
            recommended: true,
            description: 'Payment was not completed. Start a new checkout to try again.',
            method: 'POST',
            endpoint: '/v1/billing/checkout',
          },
          {
            action: 'check_billing_status',
            available: true,
            recommended: false,
            description: 'Check current plan status.',
            method: 'GET',
            endpoint: '/v1/billing/status',
          },
        ],
      }

    case 'rate_limited':
      return {
        version: '1',
        retryable: true,
        next_actions: [
          {
            action: 'retry_after_wait',
            available: true,
            recommended: true,
            retry_after_seconds: retryAfterSeconds ?? 60,
            description: 'Rate limit exceeded. Wait before retrying.',
          },
        ],
      }

    case 'server_error':
    default:
      return {
        version: '1',
        retryable: true,
        next_actions: [
          {
            action: 'retry_after_wait',
            available: true,
            recommended: true,
            retry_after_seconds: 5,
            description: 'An unexpected error occurred. Retry after a brief wait.',
          },
        ],
      }
  }
}
