/**
 * The work-graph chat-node definition: folds the session log's
 * `workgraph/change` whole-value events into one keyed chat node per graph,
 * and projects the latest snapshot into deterministic layered presentation
 * data. The projection is a pure function of the logged state, so a reload
 * reconstructs the identical view.
 * @module @deepseek-ai/dsh-client-ui-workgraph/workgraph-definition
 */

import type {
  ChatConversationViewNode,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
// Importing the domain types also pulls the workgraph package's
// `workgraph/change` SessionEventMap augmentation into this program.
import type { WorkGraphChangeMeta } from '@deepseek-ai/dsh-workgraph'

/** One durable node state as presented. */
export type WorkGraphNodeState = 'waiting' | 'ready' | 'running' | 'achieved' | 'failed' | 'blocked'

/** One graph lifecycle status as presented. */
export type WorkGraphStatus =
  | 'active'
  | 'user_paused'
  | 'infra_paused'
  | 'blocked'
  | 'budget_limited'
  | 'complete'

/** Final keyed Chat payload for one work graph. */
export interface WorkGraphChatData {
  readonly objective: string
  readonly status: WorkGraphStatus
  readonly planVersion: number
  /** Longest-path layering; each layer holds its nodes in stable order. */
  readonly layers: readonly (readonly WorkGraphNodeData[])[]
  readonly tokensSpent: number
  readonly tokenBudget?: number
  readonly pauseReason?: string
  readonly pendingDiscoveries: number
}

/** One node's presentation data. */
export interface WorkGraphNodeData {
  readonly id: string
  readonly title: string
  /** The outcome contract the node's worker and verifier are held to. */
  readonly spec: string
  readonly state: WorkGraphNodeState
  readonly rounds: number
  /** Canonical ids of nodes that must be achieved first. */
  readonly blocks: readonly string[]
  readonly failure?: string
  readonly discoveredFrom?: readonly string[]
  /** Whether this is the harness-appended final verification node. */
  readonly final: boolean
}

/** The folded state data: the chat payload minus the computed layers. */
export interface WorkGraphStateData {
  readonly objective: string
  readonly status: WorkGraphStatus
  readonly planVersion: number
  readonly nodes: readonly WorkGraphNodeData[]
  readonly tokensSpent: number
  readonly tokenBudget?: number
  readonly pauseReason?: string
  readonly pendingDiscoveries: number
}

/** The definition's folded state; a null snapshot is a clear tombstone. */
export interface WorkGraphState {
  readonly snapshot: WorkGraphStateData | null
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** Durable work-graph run node. */
    'workgraph': WorkGraphChatData
  }
}

/** One decoded `workgraph/change` event, or `null` when unrelated/malformed. */
export interface DecodedGraphChange {
  readonly graphId: string
  readonly cleared: boolean
  /** Present exactly for graph-bearing changes. */
  readonly snapshot?: WorkGraphStateData
  /** The graph's history kinds at this change (start detection). */
  readonly historyKinds: readonly string[]
}

const FINAL_NODE_ID = 'gn-final'

/** Decode the raw change data defensively; foreign or malformed data is null. */
export function decodeGraphChange(data: WorkGraphChangeMeta | unknown): DecodedGraphChange | null {
  if (data === null || typeof data !== 'object') return null
  const record = data as Record<string, unknown>
  if (record['kind'] !== 'workgraph/change') return null
  if (record['operation'] === 'clear') {
    const cleared = record['cleared']
    return typeof cleared === 'string'
      ? { graphId: cleared, cleared: true, historyKinds: [] }
      : null
  }
  const graph = record['graph']
  if (graph === null || typeof graph !== 'object') return null
  const graphRecord = graph as Record<string, unknown>
  const id = graphRecord['id']
  const objective = graphRecord['objective']
  const status = graphRecord['status']
  const planVersion = graphRecord['planVersion']
  const nodes = graphRecord['nodes']
  const tokensSpent = graphRecord['tokensSpent']
  if (typeof id !== 'string' || typeof objective !== 'string'
    || typeof status !== 'string' || typeof planVersion !== 'number'
    || !Array.isArray(nodes) || typeof tokensSpent !== 'number') {
    return null
  }
  const nodeRows: WorkGraphNodeData[] = []
  for (const raw of nodes) {
    if (raw === null || typeof raw !== 'object') return null
    const row = raw as Record<string, unknown>
    const nodeId = row['id']
    const title = row['title']
    const spec = row['spec']
    const state = row['state']
    const rounds = row['rounds']
    const blocks = row['blocks']
    if (typeof nodeId !== 'string' || typeof title !== 'string' || typeof spec !== 'string'
      || typeof state !== 'string' || typeof rounds !== 'number' || !Array.isArray(blocks)) {
      return null
    }
    if (!blocks.every(block => typeof block === 'string')) return null
    const failure = row['failure']
    const discoveredFrom = row['discoveredFrom']
    nodeRows.push({
      id: nodeId,
      title,
      spec,
      state: state as WorkGraphNodeState,
      rounds,
      blocks: blocks as string[],
      ...(failure === undefined ? {} : { failure: String(failure) }),
      ...(Array.isArray(discoveredFrom) && discoveredFrom.every(origin => typeof origin === 'string')
        ? { discoveredFrom: discoveredFrom as string[] }
        : {}),
      final: nodeId === FINAL_NODE_ID,
    })
  }
  const historyKinds = Array.isArray(graphRecord['history'])
    ? graphRecord['history']
      .filter((entry): entry is Record<string, unknown> =>
        entry !== null && typeof entry === 'object')
      .map(entry => String(entry['kind']))
    : []
  const pendingDiscoveries = graphRecord['pendingDiscoveries']
  const tokenBudget = graphRecord['tokenBudget']
  const pauseReason = graphRecord['pauseReason']
  return {
    graphId: id,
    cleared: false,
    historyKinds,
    snapshot: {
      objective,
      status: status as WorkGraphStatus,
      planVersion,
      nodes: nodeRows,
      tokensSpent,
      ...(tokenBudget === undefined ? {} : { tokenBudget: Number(tokenBudget) }),
      ...(pauseReason === undefined ? {} : { pauseReason: String(pauseReason) }),
      pendingDiscoveries: Array.isArray(pendingDiscoveries) ? pendingDiscoveries.length : 0,
    },
  }
}

/** The first durable change of a graph: the set commit with `created` history. */
export function isGraphStartChange(decoded: DecodedGraphChange): boolean {
  if (decoded.cleared || decoded.snapshot === undefined) return false
  return decoded.historyKinds.length === 1 && decoded.historyKinds[0] === 'created'
}

/**
 * Longest-path layering (stable by construction order): each node sits in
 * the layer one past its longest dependency chain; the final node lands in
 * the deepest layer. Deterministic across replays. Cyclic foreign data
 * degrades every member to layer 0 (the layering guard refuses to loop).
 */
export function layerNodes(nodes: readonly WorkGraphNodeData[]): readonly (readonly WorkGraphNodeData[])[] {
  const layer = new Map<string, number>(nodes.map(node => [node.id, 0]))
  let changed = true
  let guard = 0
  let cyclic = false
  while (changed) {
    changed = false
    guard += 1
    if (guard > nodes.length + 1) {
      // Cyclic foreign data: the layering would never converge; degrade
      // every member to layer 0 rather than looping or misplacing nodes.
      cyclic = true
      break
    }
    for (const node of nodes) {
      for (const dep of node.blocks) {
        const depLayer = layer.get(dep)
        if (depLayer === undefined) continue
        const next = depLayer + 1
        /* v8 ignore next -- the node is seeded before the loop, so the fallback never fires */
        if ((layer.get(node.id) ?? 0) < next) {
          layer.set(node.id, next)
          changed = true
        }
      }
    }
  }
  if (cyclic) {
    for (const node of nodes) layer.set(node.id, 0)
  }
  const depth = nodes.length === 0 ? 0 : Math.max(...layer.values()) + 1
  const rows: WorkGraphNodeData[][] = Array.from({ length: depth }, () => [])
  for (const node of nodes) {
    /* v8 ignore start -- every node is seeded into a valid layer, so the fallbacks never fire */
    const row = rows[layer.get(node.id) ?? 0]
    if (row !== undefined) row.push(node)
    /* v8 ignore stop */
  }
  return rows
}

/** The chat-node definition folding the session log's `workgraph/change` events. */
export const workgraphDefinition: ConversationNodeDefinition<WorkGraphState> = {
  kind: 'workgraph',
  target: 'chat',
  match: (event) => {
    if (event.type !== 'workgraph/change') return null
    const decoded = decodeGraphChange(event.data)
    if (decoded === null) return null
    return {
      id: decoded.graphId,
      // Exactly one start per graph: the first durable change is the set
      // commit, recognizable by its single `created` history entry.
      role: isGraphStartChange(decoded) ? 'start' : 'update',
    }
  },
  start: (_context, match) => {
    if (match.event.type !== 'workgraph/change') {
      throw new Error('workgraph start requires workgraph/change')
    }
    const decoded = decodeGraphChange(match.event.data)
    if (decoded === null || decoded.snapshot === undefined) {
      throw new Error('workgraph start requires a graph-bearing change')
    }
    return { snapshot: decoded.snapshot }
  },
  update: (context, match) => {
    if (match.event.type !== 'workgraph/change') return context.state ?? { snapshot: null }
    const decoded = decodeGraphChange(match.event.data)
    if (decoded === null) return context.state ?? { snapshot: null }
    if (decoded.cleared) return { snapshot: null }
    /* v8 ignore next 2 -- graph-bearing decodes always carry a snapshot; the arm guards the union shape */
    return decoded.snapshot === undefined
      ? context.state ?? { snapshot: null }
      : { snapshot: decoded.snapshot }
  },
  buildViewNode: (context): ChatConversationViewNode | null => {
    const snapshot = context.state?.snapshot
    if (snapshot === null || snapshot === undefined || context.start === undefined) return null
    const { nodes, ...rest } = snapshot
    return {
      key: context.key,
      kind: 'workgraph',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data: {
        ...rest,
        layers: layerNodes(nodes),
      },
    }
  },
}
