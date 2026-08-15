/**
 * The worker continuation transport: round 1 establishes a durable
 * continuable child (`startContinuable`), and later rounds deliver the gaps
 * prompt through `followup` on the SAME child — context and workspace
 * preserved, exactly as the verifier-rounds issue requires. Each round is
 * awaited through the child's `subagent/end` epoch edge: a leaf worker child
 * (delegation tools denied) settles its epoch when its turn completes, so
 * the epoch end is the turn end. The child's report travels as the strict
 * `REPORT:` JSON envelope line in its final output (the continuation
 * manager's composition does not carry the structured capture for later
 * rounds); the envelope is parsed strictly and an unparseable report fails
 * the node fail-closed.
 * @module @deepseek-ai/dsh-workgraph-scheduler/continuation
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'
import { parseWorkerReport, type WorkerEpisodeOutcome } from './worker.ts'

/**
 * The worker's delegation posture: no children, no self-modifying runtime.
 * The deny list must name tools exactly as registered in the host harness —
 * `tools.restrict()` fails loudly on unregistered names (the jxca names
 * `jobs`/`todo`/`code-runtime` have no registry counterpart here). The job
 * family is `job_list`/`job_output`/`job_kill`, the todo tool is
 * `todo_write`, and delegation splits into `subagent`/`subagent_fork`.
 */
export const WORKER_DENY_LIST: string[] = [
  'subagent',
  'subagent_fork',
  'workflow',
  'job_list',
  'job_output',
  'job_kill',
  'skill',
  'todo_write',
]

/** The tool restriction applied to worker children. */
export const WORKER_TOOL_FILTER: ToolRestriction = { deny: WORKER_DENY_LIST }

/** One worker round of a node: round 1 spawns, rounds 2+ continue the same child. */
export interface WorkerRoundRequest {
  /** The fully rendered worker prompt (with the prior gaps on rounds 2+). */
  readonly prompt: string
  /** Cancellation owned by the graph episode. */
  readonly signal: AbortSignal
  /** 1 spawns the child; 2+ continue the SAME child. */
  readonly round: number
  /** The durable child session id from round 1; present on rounds 2+. */
  readonly childSessionId?: string
  /** Absolute workspace (session `cwd`) for the child, e.g. a worktree. */
  readonly workspace?: string
}

/** The settled round: the parsed outcome and the durable child identity. */
export interface WorkerRoundResult {
  readonly outcome: WorkerEpisodeOutcome
  /** Stable across all rounds of one node. */
  readonly childSessionId: string
}

/** The injected round seam; tests script per-round outcomes. */
export type WorkerRound = (request: WorkerRoundRequest) => Promise<WorkerRoundResult>

/** The report envelope prefix the worker's final line must start with. */
export const REPORT_PREFIX = 'REPORT:'

/**
 * Parse the strict `REPORT:` JSON envelope from a child's final output text.
 * The envelope is the LAST line starting with the prefix; anything else
 * around it is ignored, but a missing or malformed envelope is unparseable
 * (fails the node fail-closed).
 * @param text - the child's final output text.
 * @returns the parsed outcome.
 */
export function parseReportEnvelope(text: string): WorkerEpisodeOutcome {
  let last = -1
  let index = 0
  for (const line of text.split('\n')) {
    if (line.startsWith(REPORT_PREFIX)) last = index
    index += 1
  }
  if (last < 0) {
    return { kind: 'unparseable', reason: 'worker final output carries no REPORT: envelope' }
  }
  const lines = text.split('\n')
  /* v8 ignore next -- `last` is a matched index, so lines[last] is always defined */
  const payload = (lines[last] ?? '').slice(REPORT_PREFIX.length).trim()
  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch {
    return { kind: 'unparseable', reason: 'worker REPORT: envelope is not valid JSON' }
  }
  return parseWorkerReport({ structured: value, stopReason: 'completed' })
}

/** The child's final message text blocks, joined. */
function outputText(output: readonly { type: string; text?: string }[] | undefined): string {
  if (output === undefined) return ''
  return output.filter(block => block.type === 'text' && block.text !== undefined)
    .map(block => block.text as string)
    .join('\n')
}

/**
 * Await one child epoch's `subagent/end` edge. The listener is attached
 * before the round starts so the race is won by construction; a non-
 * `completed` stop reason fails closed.
 * @param ctx - the dispatching context.
 * @param childId - the durable child session id.
 * @param signal - caller cancellation (rejects with the abort reason).
 * @returns the epoch's final output text and stop reason.
 */
export function awaitChildEpoch(
  ctx: Context,
  childId: string,
  signal: AbortSignal,
): Promise<{ text: string; stopReason: string }> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      remove()
      reject(new Error('workgraph: child epoch aborted'))
    }
    const listener = (info: SubagentRunEndInfo): void => {
      if (String(info.id) !== childId) return
      remove()
      signal.removeEventListener('abort', onAbort)
      resolve({
        text: outputText(info.lastAssistantMessage),
        stopReason: info.stopReason,
      })
    }
    // The listener is registered before the abort handler so the remove
    // closure is always assigned when either path first runs.
    const disposeListener = ctx.on('subagent/end', listener)
    const remove = (): void => {
      disposeListener()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * The default worker round transport over `ctx.subagents`: round 1
 * `startContinuable`, rounds 2+ `followup` on the same child, each round
 * awaited through the child epoch end and its report parsed from the
 * `REPORT:` envelope.
 * @param ctx - the dispatching context.
 * @param agent - the agent whose session owns the graph (the children's parent).
 * @returns the round seam.
 */
export function continuationWorkerRound(ctx: Context, agent: Agent): WorkerRound {
  return async ({ prompt, signal, round, childSessionId, workspace }) => {
    if (round === 1) {
      const { childId } = await ctx.subagents.startContinuable({
        provider: 'spawn',
        label: 'graph node worker',
        request: {
          prompt: [{ type: 'text', text: prompt }],
          parent: agent,
          toolFilter: WORKER_TOOL_FILTER,
          ...(workspace === undefined ? {} : { workspace }),
        },
        signal,
      })
      const { text, stopReason } = await awaitChildEpoch(ctx, childId, signal)
      const outcome = stopReason === 'completed'
        ? parseReportEnvelope(text)
        : { kind: 'fail-closed' as const, reason: `worker child ended with stop reason "${stopReason}"` }
      return { outcome, childSessionId: childId }
    }
    if (childSessionId === undefined) {
      throw new Error('workgraph: continuation round without a child session id')
    }
    await ctx.subagents.followup(agent, childSessionId as never, [{ type: 'text', text: prompt }], {
      source: { kind: 'coordinator', form: 'relay', senderSessionId: agent.id },
      signal,
    })
    const { text, stopReason } = await awaitChildEpoch(ctx, childSessionId, signal)
    const outcome = stopReason === 'completed'
      ? parseReportEnvelope(text)
      : { kind: 'fail-closed' as const, reason: `worker child ended with stop reason "${stopReason}"` }
    return { outcome, childSessionId }
  }
}
