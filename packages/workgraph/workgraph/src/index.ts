/**
 * Service Definition for the work-graph capability seam: a deterministic DAG
 * scheduler over agent work. Service Providers own the tracker and episodic
 * execution; observe-only `workgraph/*` events never expose graph control.
 * @module @deepseek-ai/dsh-workgraph
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  ResumeWorkGraphRequest,
  SetWorkGraphRequest,
  WorkGraphSnapshot,
  WorkNodeId,
} from './types.ts'

export type * from './types.ts'
export type * from './domain.ts'
export { WORKGRAPH_CHANGE_VERSION, WorkGraphError, WorkGraphId, WorkNodeId } from './runtime.ts'
export { decodeWorkGraphChange, foldWorkGraph } from './fold.ts'
export { commitWorkGraphChange } from './commit.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workGraph: WorkGraphEngine
  }
}

/**
 * Work-graph Service Definition contract. One engine per context owns the
 * durable work graph of each session: mutations validate before any session
 * event commits, every transition checkpoints the whole snapshot, and a
 * restored graph never resumes as self-driving.
 */
export abstract class WorkGraphEngine extends Service {
  constructor(ctx: Context) {
    super(ctx, 'workGraph')
  }

  /**
   * Plan and start a work graph for the agent's session.
   * @param agent - the agent whose session owns the graph.
   * @param request - the objective and an optional token budget.
   * @returns the initial planned snapshot.
   */
  abstract set(agent: Agent, request: SetWorkGraphRequest): Promise<WorkGraphSnapshot>

  /**
   * Read the session's current work graph. A session with no durable events
   * revives the repository projection (`.dsh/graph.jsonl`) sanitized and
   * demoted to paused; a malformed projection is a loud error.
   * @param agent - the agent whose session owns the graph.
   * @returns the current snapshot, or `null` when none exists.
   */
  abstract status(agent: Agent): Promise<WorkGraphSnapshot | null>

  /**
   * Pause the graph, cancelling any live episode with bounded child settlement.
   * @param agent - the agent whose session owns the graph.
   * @param reason - human-readable pause cause.
   * @returns the paused snapshot.
   */
  abstract pause(agent: Agent, reason?: string): Promise<WorkGraphSnapshot>

  /**
   * Resume a paused graph, optionally topping up an exhausted token budget.
   * @param agent - the agent whose session owns the graph.
   * @param request - a positive budget top-up from spent-so-far.
   * @returns the resumed snapshot.
   */
  abstract resume(agent: Agent, request?: ResumeWorkGraphRequest): Promise<WorkGraphSnapshot>

  /**
   * Reset one terminal node and its transitively blocked chain to re-runnable
   * work; refuses while an upstream dependency is neither achieved nor in the
   * same reset batch.
   * @param agent - the agent whose session owns the graph.
   * @param node - the terminal node to retry.
   * @returns the snapshot after the reset batch.
   */
  abstract retry(agent: Agent, node: WorkNodeId): Promise<WorkGraphSnapshot>

  /**
   * Reset every failed node plus its transitively blocked chain as ONE batch
   * (bare `/graph retry`): a shared final blocked by sibling failures refuses
   * any single-root reset whose other dependency is still failed.
   * @param agent - the agent whose session owns the graph.
   * @returns the snapshot after the union reset batch; unchanged when no
   * node is failed.
   */
  abstract retryAll(agent: Agent): Promise<WorkGraphSnapshot>

  /**
   * Clear the graph and its projection; a cleared graph cannot resurrect.
   * @param agent - the agent whose session owns the graph.
   */
  abstract clear(agent: Agent): Promise<void>
}
