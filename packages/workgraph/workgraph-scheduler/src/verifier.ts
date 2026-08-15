/**
 * The adversarial verifier: a read-only skeptic that re-runs the decisive
 * checks for one node before it may achieve. The verifier is a one-shot
 * spawn on the worker's workspace with a deny-list tool filter where the
 * provider supports it (and the prompt contract otherwise); its verdict
 * gates the worker's `done` report. An errored or unparseable verifier never
 * passes — an unverified claim is a gap by construction.
 * @module @deepseek-ai/dsh-workgraph-scheduler/verifier
 */

import type { ObjectJsonSchema, ToolRestriction } from '@deepseek-ai/dsh-tools'
import { renderVerifierPrompt } from './prompts.ts'
import type { WorkerSpawn, WorkerSpawnResult } from './worker.ts'

/** The structured verdict a verifier child must satisfy to finish. */
export const VERIFIER_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['achieved', 'not_achieved'] },
    gaps: { type: 'array', items: { type: 'string' } },
    discovered: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'gaps', 'discovered'],
  additionalProperties: false,
} as const satisfies ObjectJsonSchema

/**
 * The verifier's read-only tool posture: mutating and delegation tools are
 * denied outright; `bash` stays available because re-running the decisive
 * checks (tests, builds) may write artifacts — the rest of the read-only
 * contract is prompt-enforced.
 */
export const VERIFIER_DENY_LIST: string[] = [
  'write',
  'edit',
  'subagent',
  'workflow',
  'jobs',
  'skill',
  'todo',
  'code-runtime',
  'ask_user_question',
]

/** The tool restriction applied to verifier children. */
export const VERIFIER_TOOL_FILTER: ToolRestriction = { deny: VERIFIER_DENY_LIST }

/** The terminal verdict of one verification pass. */
export type VerifierOutcome =
  | { readonly kind: 'achieved'; readonly discovered: readonly string[] }
  | { readonly kind: 'rejected'; readonly gaps: readonly string[]; readonly discovered: readonly string[] }
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'fail-closed'; readonly reason: string }

/**
 * Parse one verifier spawn result. A missing or malformed verdict, or an
 * errored child, fails closed — an unverified claim never passes. A
 * rejection without gaps is itself rejected as invalid.
 * @param result - the spawn result.
 * @returns the verifier outcome.
 */
export function parseVerifierReport(result: WorkerSpawnResult): VerifierOutcome {
  if (result.stopReason !== 'completed') {
    return {
      kind: 'fail-closed',
      reason: `verifier child ended with stop reason "${result.stopReason}"`,
    }
  }
  if (result.structured === undefined) {
    return { kind: 'fail-closed', reason: 'verifier produced no structured verdict' }
  }
  const report = result.structured as Record<string, unknown>
  if (typeof report['verdict'] !== 'string' || !Array.isArray(report['gaps'])) {
    return { kind: 'fail-closed', reason: 'verifier verdict is missing verdict or gaps' }
  }
  const clean = (value: unknown): readonly string[] => {
    if (!Array.isArray(value)) return []
    return value.filter((entry): entry is string => typeof entry === 'string')
      .map(entry => entry.trim())
      .filter(entry => entry.length > 0)
  }
  const discovered = clean(report['discovered'])
  if (report['verdict'] === 'achieved') {
    return { kind: 'achieved', discovered }
  }
  if (report['verdict'] === 'not_achieved') {
    const gaps = clean(report['gaps'])
    if (gaps.length === 0) {
      return { kind: 'invalid', reason: 'verifier rejected without naming any gaps' }
    }
    return { kind: 'rejected', gaps, discovered }
  }
  return { kind: 'fail-closed', reason: `verifier reported unknown verdict "${report['verdict']}"` }
}

/** One verification pass: node contract, worker summary, spawn seam. */
export interface VerifierEpisodeRequest {
  readonly position: number
  readonly total: number
  readonly title: string
  readonly spec: string
  readonly objective: string
  /** The worker's summary — data to audit, not trust. */
  readonly summary: string
  /** Absolute workspace (session `cwd`) — the worker's worktree, if any. */
  readonly workspace?: string
  readonly signal: AbortSignal
  readonly spawn: WorkerSpawn
}

/**
 * Run one verification pass end to end: render, spawn, parse.
 * @param request - the verification inputs.
 * @returns the verifier outcome.
 */
export async function runVerifierEpisode(
  request: VerifierEpisodeRequest,
): Promise<VerifierOutcome> {
  const prompt = renderVerifierPrompt(request)
  const result = await request.spawn({
    prompt,
    signal: request.signal,
    ...(request.workspace === undefined ? {} : { workspace: request.workspace }),
  })
  return parseVerifierReport(result)
}
