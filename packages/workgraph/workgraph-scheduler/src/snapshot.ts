/**
 * Panel snapshot assembly for the live activity panel.
 *
 * Pure projection of the scheduler's live {@link WorkGraphSnapshot} into the
 * JSON-serializable {@link WorkGraphPanelSnapshot}: node rows carry the same
 * longest-dependency-chain `depth` the client DAG layering uses, so the
 * floating panel and the in-chat card render identical columns. No IO, no
 * ctx, no live objects — a pure function, easy to cover exhaustively.
 *
 * Pattern ported from dsh-agent-teams' server-side activity snapshot
 * (`src/snapshot.ts` assembling `taskDepthsById` depths from `state.ts`,
 * MIT); the dependency direction follows workgraph's `blocks` edges.
 * @module @deepseek-ai/dsh-workgraph-scheduler/snapshot
 */

import type {
  WorkGraphPanelSnapshot,
  WorkGraphSnapshot,
} from '@deepseek-ai/dsh-workgraph'
import { FINAL_NODE_ID } from './ids.ts'

/**
 * Longest dependency chain depth per node id, mirroring the client's
 * `layerNodes` semantics: a node sits one layer past its longest dependency
 * chain, unknown dependency ids are skipped, and cyclic foreign data degrades
 * every member to depth 0 (the fixpoint guard refuses to loop).
 * @param nodes - the graph's node rows.
 * @returns the depth map, one entry per node.
 */
function nodeDepthById(nodes: WorkGraphSnapshot['nodes']): Map<string, number> {
  const depth = new Map<string, number>(nodes.map(node => [node.id, 0]))
  let changed = true
  let guard = 0
  let cyclic = false
  while (changed) {
    changed = false
    guard += 1
    if (guard > nodes.length + 1) {
      // Cyclic foreign data: the longest-path fixpoint would never converge;
      // degrade every member to depth 0 rather than looping or misplacing.
      cyclic = true
      break
    }
    for (const node of nodes) {
      for (const dep of node.blocks) {
        const depDepth = depth.get(dep)
        if (depDepth === undefined) continue
        const next = depDepth + 1
        /* v8 ignore next -- the node is seeded before the loop, so the fallback never fires */
        if ((depth.get(node.id) ?? 0) < next) {
          depth.set(node.id, next)
          changed = true
        }
      }
    }
  }
  if (cyclic) {
    for (const node of nodes) depth.set(node.id, 0)
  }
  return depth
}

/**
 * Assemble one panel snapshot from the scheduler's live graph view.
 * @param sessionId - the session id that owns the graph (panel filter key).
 * @param snapshot - the live durable snapshot.
 * @returns the JSON-serializable panel snapshot.
 */
export function assemblePanelSnapshot(sessionId: string, snapshot: WorkGraphSnapshot): WorkGraphPanelSnapshot {
  const depthById = nodeDepthById(snapshot.nodes)
  return {
    sessionId,
    graphId: snapshot.id,
    objective: snapshot.objective,
    status: snapshot.status,
    planVersion: snapshot.planVersion,
    tokensSpent: snapshot.tokensSpent,
    ...(snapshot.tokenBudget === undefined ? {} : { tokenBudget: snapshot.tokenBudget }),
    ...(snapshot.pauseReason === undefined ? {} : { pauseReason: snapshot.pauseReason }),
    pendingDiscoveries: snapshot.pendingDiscoveries.length,
    nodes: snapshot.nodes.map(node => ({
      id: node.id,
      title: node.title,
      state: node.state,
      rounds: node.rounds,
      blocks: node.blocks,
      /* v8 ignore next -- every node is seeded into a valid depth, so the fallback never fires */
      depth: depthById.get(node.id) ?? 0,
      final: node.id === FINAL_NODE_ID,
      ...(node.failure === undefined ? {} : { failure: node.failure }),
    })),
  }
}
