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
   * Plan and start a work graph for the agent's session, then drive it to
   * settlement (completion, pause, wedge, or budget trip). The returned
   * promise resolves with the settled snapshot, not the pending one — the
   * blocking form of {@link dispatchSet}.
   * @param agent - the agent whose session owns the graph.
   * @param request - the objective and an optional token budget.
   * @returns the settled snapshot.
   */
  abstract set(agent: Agent, request: SetWorkGraphRequest): Promise<WorkGraphSnapshot>

  /**
   * Validate, create, and commit a pending work graph, then run planning and
   * the drive DETACHED in the background. Returns as soon as the pending
   * graph is durable — the human command surface uses this so `/graph set`
   * never blocks the command channel for the graph's whole lifetime.
   * Progress is observed through {@link status}, the `workgraph/*` events,
   * and the GUI DAG; {@link pause} still awaits the episode's bounded
   * settlement.
   * @param agent - the agent whose session owns the graph.
   * @param request - the objective and an optional token budget.
   * @returns the durable pending snapshot (planning starts in the background).
   */
  abstract dispatchSet(agent: Agent, request: SetWorkGraphRequest): Promise<WorkGraphSnapshot>

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
   * Resume a paused graph, optionally topping up an exhausted token budget,
   * then drive it to settlement. The blocking form of {@link dispatchResume}.
   * @param agent - the agent whose session owns the graph.
   * @param request - a positive budget top-up from spent-so-far.
   * @returns the settled snapshot.
   */
  abstract resume(agent: Agent, request?: ResumeWorkGraphRequest): Promise<WorkGraphSnapshot>

  /**
   * Resume a paused, blocked, or budget-limited graph to active and re-drive
   * it DETACHED in the background (a pending graph re-plans there). Returns
   * the durable resumed snapshot immediately; validation refusals (locked
   * projection, plain resume on a budget-limited graph) still throw.
   * @param agent - the agent whose session owns the graph.
   * @param request - an optional positive budget top-up from spent-so-far.
   * @returns the durable resumed snapshot.
   */
  abstract dispatchResume(agent: Agent, request?: ResumeWorkGraphRequest): Promise<WorkGraphSnapshot>

  /**
   * Reset one terminal node and its transitively blocked chain to re-runnable
   * work; refuses while an upstream dependency is neither achieved nor in the
   * same reset batch. The blocking form of {@link dispatchRetry}.
   * @param agent - the agent whose session owns the graph.
   * @param node - the terminal node to retry.
   * @returns the snapshot after the reset batch.
   */
  abstract retry(agent: Agent, node: WorkNodeId): Promise<WorkGraphSnapshot>

  /**
   * Reset one terminal node and its transitively blocked chain, then re-drive
   * the graph DETACHED in the background. Returns the durable reset snapshot
   * immediately.
   * @param agent - the agent whose session owns the graph.
   * @param node - the terminal node to retry.
   * @returns the durable snapshot after the reset batch.
   */
  abstract dispatchRetry(agent: Agent, node: WorkNodeId): Promise<WorkGraphSnapshot>

  /**
   * Reset every failed node plus its transitively blocked chain as ONE batch
   * (bare `/graph retry`): a shared final blocked by sibling failures refuses
   * any single-root reset whose other dependency is still failed. The
   * blocking form of {@link dispatchRetryAll}.
   * @param agent - the agent whose session owns the graph.
   * @returns the snapshot after the union reset batch; unchanged when no
   * node is failed.
   */
  abstract retryAll(agent: Agent): Promise<WorkGraphSnapshot>

  /**
   * Reset every failed node plus its transitively blocked chain as ONE batch
   * and re-drive the graph DETACHED in the background. Returns the durable
   * reset snapshot immediately.
   * @param agent - the agent whose session owns the graph.
   * @returns the durable snapshot after the union reset batch; unchanged when
   * no node is failed.
   */
  abstract dispatchRetryAll(agent: Agent): Promise<WorkGraphSnapshot>

  /**
   * Await the current episode's settlement (the detached planning+drive chain
   * started by the last dispatch) and return the latest committed snapshot.
   * Throws `WORKGRAPH_NOT_FOUND` when the graph was cleared mid-episode.
   * @param agent - the agent whose session owns the graph.
   * @returns the settled snapshot.
   */
  abstract settled(agent: Agent): Promise<WorkGraphSnapshot>

  /**
   * Clear the graph and its projection; a cleared graph cannot resurrect.
   * @param agent - the agent whose session owns the graph.
   */
  abstract clear(agent: Agent): Promise<void>
}
