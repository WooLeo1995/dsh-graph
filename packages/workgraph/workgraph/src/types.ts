/**
 * Pure types of the work-graph domain: durable snapshot vocabulary, planner
 * artifact rows, and validation bounds, free of host-side imports (cordis
 * events, dsh-agent, the service). Host-coupled vocabulary (change metas,
 * live events, error codes) lives in ./domain.ts.
 * @module @deepseek-ai/dsh-workgraph/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identifies one work graph across its durable revisions. */
export type WorkGraphId = Branded<'WorkGraphId'>

/** Canonical node identity: `gn-` plus eight lowercase hex characters. */
export type WorkNodeId = Branded<'WorkNodeId'>

/**
 * Durable per-node lifecycle state. `Verifying` is display-only: the tracker
 * never persists it and a fold demotes any unknown persisted state to
 * `ready`, so a restored snapshot is always re-runnable work.
 */
export type WorkNodeState = 'waiting' | 'ready' | 'running' | 'achieved' | 'failed' | 'blocked'

/** Graph-level lifecycle status. */
export type WorkGraphStatus =
  | 'active'
  | 'user_paused'
  | 'infra_paused'
  | 'blocked'
  | 'budget_limited'
  | 'complete'

/** One planner artifact row before canonicalization: slug identity plus prose. */
export interface PlanNode {
  /** Planner slug; canonicalized to a {@link WorkNodeId} at installation. */
  readonly id: string
  /** One-line human title. */
  readonly title: string
  /** Outcome contract the node's worker and verifier are held to. */
  readonly spec: string
  /** Slug identities of nodes that must be achieved first. */
  readonly deps: readonly string[]
}

/** Durable work node: canonical identity, blocks edges, lifecycle state. */
export interface WorkNode {
  readonly id: WorkNodeId
  readonly title: string
  readonly spec: string
  /** Canonical ids of nodes that must be achieved before this one runs. */
  readonly blocks: readonly WorkNodeId[]
  readonly state: WorkNodeState
  /** Settled worker-verifier rounds; retained across retries for audit. */
  readonly rounds: number
  /** Present exactly while `state` is `failed`. */
  readonly failure?: string
  /** The worker child session that executed this node, when one is recorded. */
  readonly childSessionId?: string
  /** Canonical ids of nodes whose reported discovery created this node. */
  readonly discoveredFrom?: readonly WorkNodeId[]
}

/** One queued out-of-scope discovery awaiting a replan pass. */
export interface WorkGraphDiscovery {
  /** One-line description of the necessary work, as reported. */
  readonly description: string
  /** Canonical id of the node whose report carried the discovery. */
  readonly from: WorkNodeId
}

/**
 * History entry kinds. An unrecognized persisted kind decodes as `unknown`
 * with the raw kind retained in the entry detail, so a newer history record
 * degrades to evidence instead of failing replay.
 */
export type WorkGraphHistoryKind =
  | 'created'
  | 'planning-started'
  | 'planning-completed'
  | 'planning-failed'
  | 'node-started'
  | 'node-achieved'
  | 'node-failed'
  | 'node-retried'
  | 'paused'
  | 'resumed'
  | 'completed'
  | 'cleared'
  | 'budget-exceeded'
  | 'replanned'
  | 'optimized'
  | 'unknown'

/** One capped history record inside the snapshot. */
export interface WorkGraphHistoryEntry {
  /** Epoch milliseconds of the recorded transition. */
  readonly at: number
  readonly kind: WorkGraphHistoryKind
  /** Canonical id of the node the entry is about, when one is. */
  readonly node?: WorkNodeId
  /** Kind-specific detail or the raw kind behind an `unknown` entry. */
  readonly detail?: string
}

/** Complete durable orchestration state; every change carries it whole. */
export interface WorkGraphSnapshot {
  readonly id: WorkGraphId
  readonly objective: string
  readonly status: WorkGraphStatus
  /** Present exactly while `status` is not `active` or `complete`. */
  readonly pauseReason?: string
  /** Monotonic plan version; 1 is the first installed plan. */
  readonly planVersion: number
  readonly nodes: readonly WorkNode[]
  readonly pendingDiscoveries: readonly WorkGraphDiscovery[]
  readonly history: readonly WorkGraphHistoryEntry[]
  /** Optional token budget; absent means unlimited. */
  readonly tokenBudget?: number
  readonly tokensSpent: number
  readonly replanRuns: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** Validation bounds applied by the plan gate and the history cap. */
export interface WorkGraphLimits {
  /** Maximum planner nodes in one plan; the harness final node is additional. */
  readonly maxNodes: number
  /** Maximum retained history entries; the oldest are dropped first. */
  readonly historyMax: number
  /** Maximum serialized planner artifact bytes; the gate rejects larger plans. */
  readonly planBytesMax?: number
}

/** Input to starting a work graph; an omitted budget means unlimited. */
export interface SetWorkGraphRequest {
  readonly objective: string
  readonly tokenBudget?: number
}

/** Optional resume directives; a positive `budget` tops up from spent-so-far. */
export interface ResumeWorkGraphRequest {
  readonly budget?: number
}

/**
 * One node row of the activity-panel snapshot (host-assembled, client
 * rendered). A projection of {@link WorkNode} plus the longest dependency
 * chain depth, free of live objects so it can cross the JSON route.
 */
export interface WorkGraphPanelNode {
  readonly id: WorkNodeId
  readonly title: string
  readonly state: WorkNodeState
  readonly rounds: number
  readonly blocks: readonly WorkNodeId[]
  /** Longest dependency chain depth (column index for the panel DAG). */
  readonly depth: number
  /** Whether this is the harness-appended final verification node. */
  readonly final: boolean
  /** Present exactly while `state` is `failed`. */
  readonly failure?: string
}

/**
 * The activity-panel snapshot for one graph, assembled on request from the
 * scheduler's live view. Carries the owning session id so the panel can
 * filter to the current session's graph.
 */
export interface WorkGraphPanelSnapshot {
  readonly sessionId: string
  readonly graphId: WorkGraphId
  readonly objective: string
  readonly status: WorkGraphStatus
  readonly planVersion: number
  readonly tokensSpent: number
  readonly tokenBudget?: number
  readonly pauseReason?: string
  readonly pendingDiscoveries: number
  readonly nodes: readonly WorkGraphPanelNode[]
}
