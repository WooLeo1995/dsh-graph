/**
 * The worker episode mechanics: one Ready node runs as a fresh spawn subagent
 * whose structured report settles the node. The report schema replaces jxca's
 * line-anchored `NODE_RESULT:` marker — the summary is schema-field data, so
 * it cannot spoof the status field. Verifier rounds (issue 04) continue the
 * same child; the prompt carries the gap contract from day one.
 * @module @deepseek-ai/dsh-workgraph-scheduler/worker
 */

import { WorkGraphError } from '@deepseek-ai/dsh-workgraph'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { renderWorkerPrompt } from './prompts.ts'

/** The structured report a worker child must satisfy to finish. */
export const WORKER_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'blocked'] },
    summary: { type: 'string' },
    discovered: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'summary', 'discovered'],
  additionalProperties: false,
} as const satisfies ObjectJsonSchema

/** What the episode asks of the spawn seam. */
export interface WorkerSpawnRequest {
  /** The fully rendered worker prompt. */
  readonly prompt: string
  /** Cancellation owned by the graph episode. */
  readonly signal: AbortSignal
  /** Absolute workspace (session `cwd`) for the child, e.g. a worktree. */
  readonly workspace?: string
}

/** What the spawn seam returns; a non-`completed` reason is an infra failure. */
export interface WorkerSpawnResult {
  /** The child's captured structured report, when it committed one. */
  readonly structured?: unknown
  /** The child's terminal stop reason. */
  readonly stopReason: string
  /** The child session id, when the provider exposes it (usage charging). */
  readonly childSessionId?: string
}

/** The injected spawn seam; tests script reports through it. */
export type WorkerSpawn = (request: WorkerSpawnRequest) => Promise<WorkerSpawnResult>

/**
 * Episode outcome split — every path is loud, nothing is papered over:
 * - `done`: the worker finished its scope; the node may advance.
 * - `blocked`: the worker declares the node impossible here; the node fails
 *   and its dependency chain blocks.
 * - `unparseable`: a completed child committed no report or a malformed one;
 *   the node fails fail-closed (an invalid report never passes).
 * - `fail-closed`: the child errored; the node fails.
 */
export type WorkerEpisodeOutcome =
  | { readonly kind: 'done'; readonly summary: string; readonly discovered: readonly string[] }
  | { readonly kind: 'blocked'; readonly reason: string; readonly discovered: readonly string[] }
  | { readonly kind: 'unparseable'; readonly reason: string }
  | { readonly kind: 'fail-closed'; readonly reason: string }

/** One worker attempt: node contract, graph context, gaps, spawn seam. */
export interface WorkerEpisodeRequest {
  /** `[Graph node {position}/{total}: {title}]` position line. */
  readonly position: number
  readonly total: number
  readonly title: string
  /** The node's outcome contract. */
  readonly spec: string
  /** The whole graph objective, verbatim. */
  readonly objective: string
  /** Prior verifier gaps (empty on the first round). */
  readonly gaps: readonly string[]
  readonly signal: AbortSignal
  readonly spawn: WorkerSpawn
}

/** Normalize reported discovery lines: trimmed, non-empty, one line each. */
function cleanDiscoveries(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)
}

/**
 * Parse one spawn result into the episode outcome. A missing or malformed
 * report is unparseable (fails the node fail-closed); a non-`completed` stop
 * reason fails closed.
 * @param result - the spawn result.
 * @returns the episode outcome.
 */
export function parseWorkerReport(result: WorkerSpawnResult): WorkerEpisodeOutcome {
  if (result.stopReason !== 'completed') {
    return {
      kind: 'fail-closed',
      reason: `worker child ended with stop reason "${result.stopReason}"`,
    }
  }
  if (result.structured === undefined) {
    return { kind: 'unparseable', reason: 'worker produced no structured report' }
  }
  const report = result.structured as Record<string, unknown>
  if (typeof report['status'] !== 'string' || typeof report['summary'] !== 'string') {
    return { kind: 'unparseable', reason: 'worker report is missing status or summary' }
  }
  const discovered = cleanDiscoveries(report['discovered'])
  if (report['status'] === 'done') {
    return { kind: 'done', summary: report['summary'], discovered }
  }
  if (report['status'] === 'blocked') {
    const reason = report['summary'].trim()
    if (reason.length === 0) {
      return { kind: 'unparseable', reason: 'a blocked report must carry a precise reason' }
    }
    return { kind: 'blocked', reason, discovered }
  }
  throw new WorkGraphError(
    `worker reported unknown status "${report['status']}"`,
    'WORKGRAPH_INVALID_TRANSITION',
  )
}

/**
 * Run one worker attempt end to end: render, spawn, parse.
 * @param request - the worker attempt inputs.
 * @returns the episode outcome and the child session id when exposed.
 */
export async function runWorkerEpisode(
  request: WorkerEpisodeRequest,
): Promise<{ outcome: WorkerEpisodeOutcome; childSessionId: string | undefined }> {
  const prompt = renderWorkerPrompt(request)
  const result = await request.spawn({ prompt, signal: request.signal })
  return { outcome: parseWorkerReport(result), childSessionId: result.childSessionId }
}
