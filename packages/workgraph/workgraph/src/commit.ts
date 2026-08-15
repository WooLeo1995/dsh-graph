/** The checkpoint chokepoint: commit one durable work-graph change and notify. */

import type { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { WorkGraphChangeMeta, WorkGraphChanged, WorkGraphOperation } from './domain.ts'

/**
 * Append one whole-value `workgraph/change` session event and, after it
 * commits, emit the agent-scoped `workgraph/changed` notification carrying the
 * fresh snapshot or clear tombstone. Every provider transition funnels through
 * here so the durable log and the live stream cannot diverge.
 * @param ctx - the dispatching context.
 * @param agent - the agent whose session owns the work graph.
 * @param change - the decoded change to commit.
 * @param operation - the live-notification verb for snapshot changes.
 */
export function commitWorkGraphChange(
  ctx: Context,
  agent: Agent,
  change: WorkGraphChangeMeta,
  operation: WorkGraphOperation,
): void {
  agent.session.append('workgraph/change', change)
  const notification: WorkGraphChanged = 'operation' in change
    ? { operation: 'clear' }
    : { operation, graph: change.graph }
  agentEvents(ctx, agent).emit('workgraph/changed', { change: notification })
}
