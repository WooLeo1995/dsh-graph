/**
 * Pure relationship projections used by the workgraph activity panel.
 *
 * Pattern-ported from the AgentTeams activity panel model
 * (dsh-agent-teams/src/client/activity-model.ts, MIT — author 程序员阿江 /
 * Relakkes) and adapted to the work-graph domain: "tasks" become graph nodes
 * and "dependencies" become `blocks` edges. The compact-DAG geometry
 * (narrow-node constants, depth-column/stable-row projection, cubic edge
 * routing, focus precedence, parallel-grid fallback, label compaction)
 * follows the AgentTeams activity-panel rebuild of 8/17 (commits c5eb6ed and
 * 00857a1). The work-graph DAG is acyclic by construction, but the projections
 * stay cycle-safe so foreign or malformed snapshot data can never hang the UI.
 * @module @deepseek-ai/dsh-client-ui-workgraph/activity-model
 */

/** Minimum node shape needed to derive dependency relationships. */
export interface RelationshipNode {
  readonly id: string
  /** Canonical ids of nodes that must be achieved first. */
  readonly blocks: readonly string[]
  /** Longest dependency-chain depth (lane column); non-finite degrades to 0. */
  readonly depth: number
}

/** One dependency-depth stage in stable display order. */
export interface RelationshipStage<N extends RelationshipNode> {
  readonly depth: number
  readonly nodes: readonly N[]
}

/** Geometry used by the compact node DAG in the activity panel. */
export interface CompactDagNode<N extends RelationshipNode> {
  readonly node: N
  readonly x: number
  readonly y: number
}

/** One dependency edge routed between two compact DAG nodes. */
export interface CompactDagEdge {
  readonly from: string
  readonly to: string
  readonly path: string
}

/** Complete, scrollable compact DAG projection. */
export interface CompactDagLayout<N extends RelationshipNode> {
  readonly width: number
  readonly height: number
  readonly nodes: readonly CompactDagNode<N>[]
  readonly edges: readonly CompactDagEdge[]
}

/** Reference-panel geometry: narrow nodes with enough room for curved edges. */
export const COMPACT_DAG_NODE_WIDTH = 92
export const COMPACT_DAG_NODE_HEIGHT = 30
export const COMPACT_DAG_COLUMN_GAP = 26
export const COMPACT_DAG_ROW_GAP = 8

/**
 * Whether an expanded activity panel still belongs to the current session.
 *
 * The panel is mounted through a body portal, so React does not remount it
 * when the conversation route changes. Ownership keeps an expanded panel
 * from leaking onto the new-session screen (or another conversation) while
 * its local open state is being reset.
 */
export function activityPanelExpandedForSession(
  open: boolean,
  owner: string | undefined,
  current: string | undefined,
): boolean {
  return open && owner !== undefined && owner === current
}

/**
 * Resolve the node whose dependency chain should be highlighted.
 *
 * A pinned node is an explicit user choice. Keyboard focus takes precedence
 * over delayed pointer intent so an older hover timer cannot steal the active
 * chain from someone navigating the node map with the keyboard.
 */
export function dependencyFocusNodeId(
  pinnedNodeId: string | null,
  keyboardNodeId: string | null,
  hoverNodeId: string | null,
): string | null {
  return pinnedNodeId ?? keyboardNodeId ?? hoverNodeId
}

/** Group nodes by their precomputed dependency depth (missing → layer 0). */
export function nodeStages<N extends RelationshipNode>(nodes: readonly N[]): readonly RelationshipStage<N>[] {
  const byDepth = new Map<number, N[]>()
  for (const node of nodes) {
    const depth = Number.isFinite(node.depth) ? Math.max(0, Math.floor(node.depth)) : 0
    const stage = byDepth.get(depth) ?? []
    stage.push(node)
    byDepth.set(depth, stage)
  }
  return [...byDepth.entries()]
    .sort(([left], [right]) => left - right)
    .map(([depth, stageNodes]) => ({
      depth,
      nodes: stageNodes.slice().sort((left, right) => left.id.localeCompare(right.id, 'en', { numeric: true })),
    }))
}

/**
 * Lay nodes out as the reference panel's compact left-to-right DAG.
 *
 * Columns are dependency-depth stages; rows are stable node-id order within
 * each stage. Edges use cubic curves so fan-in stays readable without turning
 * every node into a large card. Every input node is positioned, so the target
 * side of an edge comes from the positioned entry; only the source lookup
 * guards dangling `blocks` ids that are absent from the node set.
 */
export function compactDagLayout<N extends RelationshipNode>(nodes: readonly N[]): CompactDagLayout<N> {
  const stages = nodeStages(nodes)
  const positions = new Map<string, { x: number; y: number }>()
  const layoutNodes: CompactDagNode<N>[] = []
  for (const [column, stage] of stages.entries()) {
    for (const [row, node] of stage.nodes.entries()) {
      const x = column * (COMPACT_DAG_NODE_WIDTH + COMPACT_DAG_COLUMN_GAP)
      const y = row * (COMPACT_DAG_NODE_HEIGHT + COMPACT_DAG_ROW_GAP)
      positions.set(node.id, { x, y })
      layoutNodes.push({ node, x, y })
    }
  }
  const edges: CompactDagEdge[] = []
  for (const entry of layoutNodes) {
    for (const block of entry.node.blocks) {
      const source = positions.get(block)
      if (source === undefined) continue
      const y1 = source.y + COMPACT_DAG_NODE_HEIGHT / 2
      const y2 = entry.y + COMPACT_DAG_NODE_HEIGHT / 2
      edges.push({
        from: block,
        to: entry.node.id,
        path: `M${source.x + COMPACT_DAG_NODE_WIDTH} ${y1}C${source.x + COMPACT_DAG_NODE_WIDTH + 14} ${y1},${entry.x - 14} ${y2},${entry.x} ${y2}`,
      })
    }
  }
  const rows = Math.max(1, ...stages.map(stage => stage.nodes.length))
  return {
    width: stages.length === 0
      ? 0
      : stages.length * COMPACT_DAG_NODE_WIDTH + (stages.length - 1) * COMPACT_DAG_COLUMN_GAP,
    height: stages.length === 0
      ? 0
      : rows * COMPACT_DAG_NODE_HEIGHT + (rows - 1) * COMPACT_DAG_ROW_GAP,
    nodes: layoutNodes,
    edges,
  }
}

/**
 * Compact a node title for the narrow DAG card.
 *
 * Takes the first segment before common inline separators and truncates past
 * 18 characters. Deliberately does not strip leading goal verbs
 * ("完成/产出/检查…"): workgraph titles are Chinese goal sentences and a
 * prefix heuristic risks cutting meaning, unlike the upstream task labels.
 */
export function compactNodeLabel(title: string): string {
  const separator = /[（(·：:]/u.exec(title)
  const head = separator === null ? title : title.slice(0, separator.index)
  const trimmed = head.trim()
  return trimmed.length > 18 ? `${trimmed.slice(0, 17)}…` : trimmed
}

/**
 * Use a fill-width grid when the graph has no real dependency edges.
 *
 * Work graphs almost always carry a harness-appended final-verification
 * dependency, so this is mainly defensive for empty or single-node graphs.
 * A dangling `blocks` id (absent from the node set) is not a real edge.
 */
export function usesParallelGrid(nodes: readonly RelationshipNode[]): boolean {
  if (nodes.length === 0) return false
  const nodeIds = new Set(nodes.map(node => node.id))
  return nodes.every(node => node.blocks.every(block => !nodeIds.has(block)))
}

/**
 * Return the complete upstream/downstream chain around one node.
 *
 * Traversal uses both `blocks` directions (upstream dependencies and
 * downstream dependents) and remains cycle-safe, so the UI can highlight
 * every handoff related to the focused node even if malformed snapshot data
 * contains a cycle.
 */
export function relatedNodeIds(nodeId: string, nodes: readonly RelationshipNode[]): ReadonlySet<string> {
  const byId = new Map(nodes.map(node => [node.id, node]))
  if (!byId.has(nodeId)) return new Set()
  const dependents = new Map<string, string[]>()
  for (const node of nodes) {
    for (const block of node.blocks) {
      const targets = dependents.get(block) ?? []
      targets.push(node.id)
      dependents.set(block, targets)
    }
  }
  const related = new Set<string>()
  const upstreamSeen = new Set<string>()
  const downstreamSeen = new Set<string>()
  const visitUpstream = (id: string): void => {
    if (upstreamSeen.has(id)) return
    upstreamSeen.add(id)
    related.add(id)
    for (const block of byId.get(id)?.blocks ?? []) visitUpstream(block)
  }
  const visitDownstream = (id: string): void => {
    if (downstreamSeen.has(id)) return
    downstreamSeen.add(id)
    related.add(id)
    for (const dependent of dependents.get(id) ?? []) visitDownstream(dependent)
  }
  visitUpstream(nodeId)
  visitDownstream(nodeId)
  return related
}
