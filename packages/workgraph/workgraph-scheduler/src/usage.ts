/**
 * Per-child token usage: folds the child session's durable usage records
 * (`assistant/message` events carrying adapter-reported `usage`) keyed by the
 * child session id the scheduler started. The reader is a seam so unit tests
 * script charges without a session store; the production default reads
 * through `ctx.sessions`.
 * @module @deepseek-ai/dsh-workgraph-scheduler/usage
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'

/** The charge and recording evidence of one child session. */
export interface ChildUsage {
  /** Total charged tokens (input + output + cache reads/writes). */
  readonly tokens: number
  /**
   * True when at least one `assistant/message` event carried adapter-reported
   * usage. A budget configured in a composition whose children record no
   * usage fails loud instead of silently mis-budgeting.
   */
  readonly recorded: boolean
}

/** Charge one adapter-reported usage record. */
export function chargeTokenUsage(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens
    + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

/**
 * Fold one session's durable log into its usage charge.
 * @param session - the child session.
 * @returns the charge and whether any usage was recorded.
 */
export function readSessionUsage(session: Session): ChildUsage {
  let tokens = 0
  let recorded = false
  for (const event of session.events) {
    if (event.type !== 'assistant/message' || event.data.usage === undefined) continue
    recorded = true
    tokens += chargeTokenUsage(event.data.usage)
  }
  return { tokens, recorded }
}

/** The injected child-usage reader. */
export type ChildUsageReader = (childSessionId: string) => Promise<ChildUsage>

/**
 * The default child-usage reader over `ctx.sessions`: live in-process child
 * sessions are read directly; an absent session reads as unrecorded.
 * @param ctx - the dispatching context.
 * @returns the reader.
 */
export function sessionChildUsageReader(ctx: Context): ChildUsageReader {
  // oxlint-disable-next-line typescript/require-await -- the reader is async by contract; the session lookup is synchronous today
  return async (childSessionId) => {
    const session = ctx.sessions.get(SessionId(childSessionId))
    if (session === undefined) return { tokens: 0, recorded: false }
    return readSessionUsage(session)
  }
}
