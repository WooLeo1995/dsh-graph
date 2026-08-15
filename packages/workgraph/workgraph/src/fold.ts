/** Pure replay fold and strict decoder for durable work-graph changes. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { WORKGRAPH_CHANGE_VERSION, WorkGraphId, WorkNodeId } from './runtime.ts'
import type {
  WorkGraphDiscovery,
  WorkGraphHistoryEntry,
  WorkGraphHistoryKind,
  WorkGraphSnapshot,
  WorkGraphStatus,
  WorkNode,
  WorkNodeState,
} from './types.ts'
import type {
  FoldedWorkGraph,
  WorkGraphChangeMeta,
  WorkGraphClearChangeMeta,
  WorkGraphSnapshotChangeMeta,
} from './domain.ts'

const NODE_STATES: ReadonlySet<string> = new Set([
  'waiting',
  'ready',
  'running',
  'achieved',
  'failed',
  'blocked',
])
const GRAPH_STATUSES: ReadonlySet<string> = new Set([
  'active',
  'user_paused',
  'infra_paused',
  'blocked',
  'budget_limited',
  'complete',
])
const HISTORY_KINDS: ReadonlySet<string> = new Set([
  'created',
  'planning-started',
  'planning-completed',
  'planning-failed',
  'node-started',
  'node-achieved',
  'node-failed',
  'node-retried',
  'paused',
  'resumed',
  'completed',
  'cleared',
  'budget-exceeded',
  'replanned',
  'optimized',
])

/** Mutable accumulator kept private to the pure fold. */
interface WorkGraphFoldState {
  graph: WorkGraphSnapshot | undefined
  clearedAt: number | undefined
}

/** Whether a value is a JSON record rather than an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Require the record to carry every required field and nothing beyond the
 * required and optional vocabulary.
 */
function requireFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  what: string,
): void {
  const allowed = [...required, ...optional].sort()
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`${what} must have only ${allowed.join(',')} fields`)
    }
  }
  const missing = required.filter(key => !(key in value)).sort()
  if (missing.length > 0) {
    throw new Error(`${what} must have exactly ${required.slice().sort().join(',')} fields`)
  }
}

/** Require one non-negative safe integer. */
function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`workgraph change ${field} must be a non-negative safe integer`)
  }
  return value
}

/** Require one positive safe integer. */
function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`workgraph change ${field} must be a positive safe integer`)
  }
  return value
}

/** Require one non-empty trimmed string. */
function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`workgraph change ${field} must be a non-empty string`)
  }
  return value
}

/** Require one canonical `gn-` node id. */
function nodeId(value: unknown, field: string): ReturnType<typeof WorkNodeId> {
  const raw = nonEmptyString(value, field)
  if (!/^gn-(?:[0-9a-f]{8}|final)$/.test(raw)) {
    throw new Error(`workgraph change ${field} must be a canonical gn- node id`)
  }
  return WorkNodeId(raw)
}

/** Require an array of canonical node ids. */
function nodeIdArray(value: unknown, field: string): readonly ReturnType<typeof WorkNodeId>[] {
  if (!Array.isArray(value)) {
    throw new Error(`workgraph change ${field} must be an array of node ids`)
  }
  return value.map((entry, index) => nodeId(entry, `${field}[${index}]`))
}

/**
 * Decode one node state with the restore fail-safe: an unrecognized persisted
 * state becomes `ready`, so restored work is re-runnable rather than
 * silently done or permanently stuck.
 */
function decodeNodeState(value: unknown): WorkNodeState {
  if (typeof value === 'string' && NODE_STATES.has(value)) return value as WorkNodeState
  return 'ready'
}

/** Decode one history kind with the forward-compat sink. */
function decodeHistoryKind(value: unknown): WorkGraphHistoryKind {
  if (typeof value === 'string' && HISTORY_KINDS.has(value)) return value as WorkGraphHistoryKind
  return 'unknown'
}

/** Decode one capped history record. */
function decodeHistoryEntry(value: unknown, index: number): WorkGraphHistoryEntry {
  if (!isRecord(value)) {
    throw new Error(`workgraph change history[${index}] must be a record`)
  }
  requireFields(value, ['at', 'kind'], ['detail', 'node'], `workgraph change history[${index}]`)
  const entry: { at: number; kind: WorkGraphHistoryKind; node?: ReturnType<typeof nodeId>; detail?: string } = {
    at: nonNegativeInteger(value['at'], `history[${index}].at`),
    kind: decodeHistoryKind(value['kind']),
  }
  if (value['node'] !== undefined) entry.node = nodeId(value['node'], `history[${index}].node`)
  if (value['detail'] !== undefined) {
    entry.detail = nonEmptyString(value['detail'], `history[${index}].detail`)
  }
  if (entry.kind === 'unknown' && typeof value['kind'] === 'string') {
    entry.detail = `unrecognized history kind ${value['kind']}`
  }
  return entry
}

/** Decode one queued discovery record. */
function decodeDiscovery(value: unknown, index: number): WorkGraphDiscovery {
  if (!isRecord(value)) {
    throw new Error(`workgraph change pendingDiscoveries[${index}] must be a record`)
  }
  requireFields(
    value,
    ['description', 'from'],
    [],
    `workgraph change pendingDiscoveries[${index}]`,
  )
  return {
    description: nonEmptyString(value['description'], `pendingDiscoveries[${index}].description`),
    from: nodeId(value['from'], `pendingDiscoveries[${index}].from`),
  }
}

/** Decode one durable work node. */
function decodeNode(value: unknown, index: number): WorkNode {
  if (!isRecord(value)) {
    throw new Error(`workgraph change nodes[${index}] must be a record`)
  }
  requireFields(
    value,
    ['blocks', 'id', 'rounds', 'spec', 'state', 'title'],
    ['childSessionId', 'discoveredFrom', 'failure'],
    `workgraph change nodes[${index}]`,
  )
  const node: {
    id: ReturnType<typeof nodeId>
    title: string
    spec: string
    blocks: readonly ReturnType<typeof nodeId>[]
    state: WorkNodeState
    rounds: number
    failure?: string
    childSessionId?: string
    discoveredFrom?: readonly ReturnType<typeof nodeId>[]
  } = {
    id: nodeId(value['id'], `nodes[${index}].id`),
    title: nonEmptyString(value['title'], `nodes[${index}].title`),
    spec: nonEmptyString(value['spec'], `nodes[${index}].spec`),
    blocks: nodeIdArray(value['blocks'], `nodes[${index}].blocks`),
    state: decodeNodeState(value['state']),
    rounds: nonNegativeInteger(value['rounds'], `nodes[${index}].rounds`),
  }
  if (value['failure'] !== undefined) {
    node.failure = nonEmptyString(value['failure'], `nodes[${index}].failure`)
  }
  if (value['childSessionId'] !== undefined) {
    node.childSessionId = nonEmptyString(value['childSessionId'], `nodes[${index}].childSessionId`)
  }
  if (value['discoveredFrom'] !== undefined) {
    node.discoveredFrom = nodeIdArray(value['discoveredFrom'], `nodes[${index}].discoveredFrom`)
  }
  return node
}

/** Require blocks and provenance edges to resolve within the node set. */
function requireResolvableEdges(nodes: readonly WorkNode[]): void {
  const ids = new Set(nodes.map(node => node.id))
  for (const node of nodes) {
    for (const dep of node.blocks) {
      if (!ids.has(dep)) {
        throw new Error(`workgraph change node ${node.id} blocks unlisted node ${dep}`)
      }
    }
    for (const origin of node.discoveredFrom ?? []) {
      if (!ids.has(origin)) {
        throw new Error(`workgraph change node ${node.id} discovers from unlisted node ${origin}`)
      }
    }
  }
}

/** Decode the whole orchestration snapshot. */
function decodeSnapshot(value: unknown): WorkGraphSnapshot {
  if (!isRecord(value)) {
    throw new Error('workgraph change graph must be a record')
  }
  requireFields(
    value,
    [
      'createdAt', 'history', 'id', 'nodes', 'objective',
      'pendingDiscoveries', 'planVersion', 'replanRuns', 'status',
      'tokensSpent', 'updatedAt',
    ],
    ['pauseReason', 'tokenBudget'],
    'workgraph change graph',
  )
  const status = value['status']
  if (typeof status !== 'string' || !GRAPH_STATUSES.has(status)) {
    throw new Error('workgraph change graph.status is invalid')
  }
  if (!Array.isArray(value['nodes'])) {
    throw new Error('workgraph change graph.nodes must be an array')
  }
  if (!Array.isArray(value['pendingDiscoveries'])) {
    throw new Error('workgraph change graph.pendingDiscoveries must be an array')
  }
  if (!Array.isArray(value['history'])) {
    throw new Error('workgraph change graph.history must be an array')
  }
  const nodes = value['nodes'].map((node, index) => decodeNode(node, index))
  const seen = new Set(nodes.map(node => node.id))
  if (seen.size !== nodes.length) {
    throw new Error('workgraph change graph.nodes contains duplicate ids')
  }
  requireResolvableEdges(nodes)
  const snapshot: Omit<WorkGraphSnapshot, 'pauseReason' | 'tokenBudget'> & {
    pauseReason?: string
    tokenBudget?: number
  } = {
    id: WorkGraphId(nonEmptyString(value['id'], 'graph.id')),
    objective: nonEmptyString(value['objective'], 'graph.objective'),
    status: status as WorkGraphStatus,
    planVersion: positiveInteger(value['planVersion'], 'graph.planVersion'),
    nodes,
    pendingDiscoveries: value['pendingDiscoveries'].map((entry, index) => decodeDiscovery(entry, index)),
    history: value['history'].map((entry, index) => decodeHistoryEntry(entry, index)),
    tokensSpent: nonNegativeInteger(value['tokensSpent'], 'graph.tokensSpent'),
    replanRuns: nonNegativeInteger(value['replanRuns'], 'graph.replanRuns'),
    createdAt: nonNegativeInteger(value['createdAt'], 'graph.createdAt'),
    updatedAt: nonNegativeInteger(value['updatedAt'], 'graph.updatedAt'),
  }
  if (snapshot.updatedAt < snapshot.createdAt) {
    throw new Error('workgraph change graph.updatedAt cannot precede createdAt')
  }
  if (value['pauseReason'] !== undefined) {
    snapshot.pauseReason = nonEmptyString(value['pauseReason'], 'graph.pauseReason')
  }
  if (value['tokenBudget'] !== undefined) {
    snapshot.tokenBudget = positiveInteger(value['tokenBudget'], 'graph.tokenBudget')
  }
  return snapshot
}

/**
 * Strictly decode one durable work-graph change. A value of another kind
 * returns `undefined`; a malformed or unsupported work-graph change fails
 * replay loudly.
 * @param value - candidate source change.
 * @returns validated change or `undefined` for another value kind.
 */
export function decodeWorkGraphChange(value: unknown): WorkGraphChangeMeta | undefined {
  if (!isRecord(value) || value['kind'] !== 'workgraph/change') return undefined
  if (value['version'] !== WORKGRAPH_CHANGE_VERSION) {
    throw new Error(`unsupported workgraph change version ${String(value['version'])}`)
  }
  if (value['operation'] === 'clear') {
    requireFields(value, ['cleared', 'clearedAt', 'kind', 'operation', 'version'], [], 'workgraph clear change')
    return {
      kind: 'workgraph/change',
      version: WORKGRAPH_CHANGE_VERSION,
      operation: 'clear',
      cleared: WorkGraphId(nonEmptyString(value['cleared'], 'cleared')),
      clearedAt: nonNegativeInteger(value['clearedAt'], 'clearedAt'),
    } satisfies WorkGraphClearChangeMeta
  }
  requireFields(value, ['graph', 'kind', 'version'], [], 'workgraph snapshot change')
  return {
    kind: 'workgraph/change',
    version: WORKGRAPH_CHANGE_VERSION,
    graph: decodeSnapshot(value['graph']),
  } satisfies WorkGraphSnapshotChangeMeta
}

/** Validate one snapshot change against the accumulated fold state. */
function validateSnapshotContinuity(state: WorkGraphFoldState, change: WorkGraphSnapshotChangeMeta): void {
  const current = state.graph
  if (current === undefined) return
  const next = change.graph
  if (next.id !== current.id) {
    throw new Error('workgraph change cannot switch graph identity while a graph is current')
  }
  if (next.createdAt !== current.createdAt) {
    throw new Error('workgraph change cannot rewrite the current graph creation time')
  }
  if (next.updatedAt < current.updatedAt || next.planVersion < current.planVersion) {
    throw new Error('workgraph change must not rewind the current graph')
  }
}

/**
 * Replay a committed event stream into the durable work-graph facts. Every
 * snapshot change carries the whole orchestration, so the fold is last-wins
 * after strict decode plus identity and monotonicity continuity.
 * @param events - the committed session events, in log order.
 * @returns the folded current graph and latest clear time.
 */
export function foldWorkGraph(events: readonly SessionEvent[]): FoldedWorkGraph {
  const state: WorkGraphFoldState = { graph: undefined, clearedAt: undefined }
  for (const event of events) {
    if (event.type !== 'workgraph/change') continue
    const change = decodeWorkGraphChange(event.data)
    if (change === undefined) continue
    if ('operation' in change) {
      state.graph = undefined
      state.clearedAt = change.clearedAt
      continue
    }
    validateSnapshotContinuity(state, change)
    state.graph = change.graph
  }
  if (state.graph !== undefined) {
    return state.clearedAt !== undefined
      ? { graph: state.graph, clearedAt: state.clearedAt }
      : { graph: state.graph }
  }
  return state.clearedAt !== undefined ? { clearedAt: state.clearedAt } : {}
}
