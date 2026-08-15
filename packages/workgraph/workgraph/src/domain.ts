/**
 * Host-side vocabulary of the work-graph domain: durable change payloads, the
 * session event and live notification declarations, and stable error codes.
 * Kept separate from ./types.ts (the pure client-safe outlet) because these
 * declarations pull dsh-agent and cordis into the program.
 * @module @deepseek-ai/dsh-workgraph
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { WorkGraphId, WorkGraphSnapshot } from './types.ts'

/**
 * Whole-snapshot change committed by every work-graph transition. The
 * whole-value rule holds: each change carries the complete post-change
 * orchestration, so the replay fold is last-wins after structural decode.
 */
export interface WorkGraphSnapshotChangeMeta {
  readonly kind: 'workgraph/change'
  readonly version: 1
  /** Complete post-change orchestration state. */
  readonly graph: WorkGraphSnapshot
}

/** Tombstone retained when the current work graph is cleared. */
export interface WorkGraphClearChangeMeta {
  readonly kind: 'workgraph/change'
  readonly version: 1
  readonly operation: 'clear'
  readonly cleared: WorkGraphId
  readonly clearedAt: number
}

/** Durable change union carried by the work-graph domain's own session event. */
export type WorkGraphChangeMeta = WorkGraphSnapshotChangeMeta | WorkGraphClearChangeMeta

/** Work-graph state-changing verbs recorded in the live notification. */
export type WorkGraphOperation = 'set' | 'checkpoint' | 'pause' | 'resume' | 'retry' | 'clear'

/** Pure replay fold of durable work-graph facts. */
export interface FoldedWorkGraph {
  /** Current graph, absent after a clear or before the first set. */
  readonly graph?: WorkGraphSnapshot
  /** Epoch milliseconds of the latest clear tombstone, when one committed. */
  readonly clearedAt?: number
}

/** Live notification after one durable work-graph mutation commits. */
export interface WorkGraphChanged {
  readonly operation: WorkGraphOperation
  /** Absent for a clear tombstone. */
  readonly graph?: WorkGraphSnapshot
}

/** Stable error codes for rejected work-graph reads and mutations. */
export type WorkGraphErrorCode =
  | 'WORKGRAPH_NOT_FOUND'
  | 'WORKGRAPH_ALREADY_EXISTS'
  | 'WORKGRAPH_INVALID_OBJECTIVE'
  | 'WORKGRAPH_INVALID_BUDGET'
  | 'WORKGRAPH_INVALID_PLAN'
  | 'WORKGRAPH_INVALID_TRANSITION'
  | 'WORKGRAPH_RETRY_UPSTREAM_NOT_ACHIEVED'
  | 'WORKGRAPH_BASELINE_EXISTS'
  | 'WORKGRAPH_INVALID_OPTIMIZATION'
  | 'WORKGRAPH_MALFORMED_PROJECTION'
  | 'WORKGRAPH_LOCKED'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Complete post-transition work-graph state or clear tombstone.
     */
    'workgraph/change': WorkGraphChangeMeta
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Work-graph mutation accepted by one live agent. The matching
     * `workgraph/change` session event has already committed. Listener
     * failures are contained. Scope-filtered dispatch
     * (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @param payload.agent - agent whose session owns the work graph.
     * @param payload.change - fresh current snapshot or clear tombstone.
     * @mode emit
     */
    'workgraph/changed'(this: import('@deepseek-ai/dsh-scope').Scoped<Agent>, payload: { agent: Agent; change: WorkGraphChanged }): void
  }
}
