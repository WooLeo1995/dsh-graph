/**
 * The planning episode: one structured-output planner spawn gated by the plan
 * static gate. The spawn seam is injected so unit tests script artifacts
 * without a model; the scheduler provider wires it to `ctx.subagents`.
 * @module @deepseek-ai/dsh-workgraph-scheduler/planner
 */

import { WorkGraphError } from '@deepseek-ai/dsh-workgraph'
import type { WorkGraphLimits, WorkNode } from '@deepseek-ai/dsh-workgraph'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { installPlan } from './gate.ts'
import { renderPlannerPrompt } from './prompts.ts'

/** The structured-output schema the planner child must satisfy to finish. */
export const PLAN_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          spec: { type: 'string' },
          deps: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'title', 'spec', 'deps'],
        additionalProperties: false,
      },
    },
  },
  required: ['nodes'],
  additionalProperties: false,
} as const satisfies ObjectJsonSchema

/** What the episode asks of the spawn seam. */
export interface PlannerSpawnRequest {
  /** The fully rendered planner prompt. */
  readonly prompt: string
  /** Cancellation owned by the graph episode. */
  readonly signal: AbortSignal
}

/** What the spawn seam returns; a non-`completed` reason is an infra failure. */
export interface PlannerSpawnResult {
  /** The child's captured structured artifact, when it committed one. */
  readonly structured?: unknown
  /** The child's terminal stop reason. */
  readonly stopReason: string
}

/** The injected spawn seam; tests script artifacts through it. */
export type PlannerSpawn = (request: PlannerSpawnRequest) => Promise<PlannerSpawnResult>

/**
 * Episode outcome split — both are loud, nothing is papered over:
 * - `planned`: the artifact passed the gate; the caller installs and freezes it.
 * - `invalid`: the artifact failed the static gate; retryable ONCE by the
 *   caller, feeding the precise reason back as CONTEXT.
 * - `fail-closed`: the child errored or produced no artifact; the caller
 *   pauses the graph as infra and `resume` retries.
 */
export type PlannerEpisodeOutcome =
  | { readonly kind: 'planned'; readonly nodes: readonly WorkNode[] }
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'fail-closed'; readonly reason: string }

/** One planning attempt: objective, retry feedback, bounds, spawn seam. */
export interface PlannerEpisodeRequest {
  readonly objective: string
  /** Empty on the first attempt; the prior gate rejection on the retry. */
  readonly feedback: string
  readonly limits: WorkGraphLimits
  readonly signal: AbortSignal
  readonly spawn: PlannerSpawn
}

/**
 * Run one planning attempt end to end: render, spawn, gate. A missing or
 * schema-invalid structured artifact fails closed (infra path), never a
 * partial install; a gate rejection names its precise reason for the retry.
 * @param request - the planning attempt inputs.
 * @returns the episode outcome.
 */
export async function runPlannerEpisode(
  request: PlannerEpisodeRequest,
): Promise<PlannerEpisodeOutcome> {
  const prompt = renderPlannerPrompt(request.objective, request.feedback)
  const result = await request.spawn({ prompt, signal: request.signal })
  if (result.stopReason !== 'completed') {
    return {
      kind: 'fail-closed',
      reason: `planner child ended with stop reason "${result.stopReason}"`,
    }
  }
  if (result.structured === undefined) {
    return { kind: 'fail-closed', reason: 'planner produced no structured plan artifact' }
  }
  try {
    return { kind: 'planned', nodes: installPlan(result.structured, request.objective, request.limits) }
  } catch (error) {
    if (error instanceof WorkGraphError) {
      return { kind: 'invalid', reason: error.message }
    }
    throw error
  }
}
