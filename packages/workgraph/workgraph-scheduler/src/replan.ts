/**
 * The capped replan pass: at episode boundaries, pending discoveries fold
 * into the graph through a replanner child that appends the fewest new
 * nodes, each carrying `discovered_from` provenance. Append-only by design —
 * the running plan is immutable inside a version; a replan appends, bumps
 * the plan version, re-gates `gn-final`, and clears the entries. Any degrade
 * drains the entries to history so the graph always converges.
 * @module @deepseek-ai/dsh-workgraph-scheduler/replan
 */

import { WorkGraphError } from '@deepseek-ai/dsh-workgraph'
import type { WorkGraphLimits, WorkGraphSnapshot, WorkNode } from '@deepseek-ai/dsh-workgraph'
import type { WorkNodeId } from '@deepseek-ai/dsh-workgraph/types'
import { canonicalNodeId, FINAL_NODE_ID } from './ids.ts'
import { appendHistory, promoteReady } from './tracker.ts'
import { renderReplannerPrompt } from './prompts.ts'
import type { PlannerSpawn } from './planner.ts'

/** Slug hygiene: 1–64 characters of letters, digits, underscore, hyphen. */
const SLUG_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Validate the raw appendix rows: shape, slug hygiene, uniqueness, non-empty
 * prose, and no self-dependencies. Deps may reference EXISTING live nodes
 * (the caller's guard resolves them against the current graph), so the plan
 * gate's internal dep-resolution is deliberately not applied here.
 */
function validateAppendix(value: unknown): Array<{ id: string; title: string; spec: string; deps: string[] }> {
  const artifact = value as { nodes?: unknown }
  if (!Array.isArray(artifact.nodes)) {
    throw new WorkGraphError('replan artifact must be an object with a nodes array', 'WORKGRAPH_INVALID_PLAN')
  }
  const seen = new Set<string>()
  const rows: Array<{ id: string; title: string; spec: string; deps: string[] }> = []
  artifact.nodes.forEach((row, index) => {
    const record = row as { id?: unknown; title?: unknown; spec?: unknown; deps?: unknown }
    if (typeof record.id !== 'string' || typeof record.title !== 'string'
      || typeof record.spec !== 'string' || !Array.isArray(record.deps)) {
      throw new WorkGraphError(`replan node ${index} must have id, title, spec, and deps`, 'WORKGRAPH_INVALID_PLAN')
    }
    const slug = record.id
    if (!SLUG_PATTERN.test(slug)) {
      throw new WorkGraphError(`node id "${slug}" must be 1-64 characters of [A-Za-z0-9_-]`, 'WORKGRAPH_INVALID_PLAN')
    }
    if (seen.has(slug)) throw new WorkGraphError(`duplicate node id "${slug}"`, 'WORKGRAPH_INVALID_PLAN')
    seen.add(slug)
    if (record.title.trim().length === 0 || record.spec.trim().length === 0) {
      throw new WorkGraphError(`node "${slug}" has an empty title or spec`, 'WORKGRAPH_INVALID_PLAN')
    }
    const deps: string[] = []
    for (const dep of record.deps) {
      if (typeof dep !== 'string') {
        throw new WorkGraphError(`node "${slug}" deps must be strings`, 'WORKGRAPH_INVALID_PLAN')
      }
      if (dep === slug) throw new WorkGraphError(`node "${slug}" depends on itself`, 'WORKGRAPH_INVALID_PLAN')
      deps.push(dep)
    }
    rows.push({ id: slug, title: record.title.trim(), spec: record.spec.trim(), deps: [...new Set(deps)] })
  })
  return rows
}

/** One replan attempt outcome. */
export type ReplannerOutcome =
  | { readonly kind: 'planned'; readonly nodes: readonly WorkNode[] }
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'fail-closed'; readonly reason: string }

/** Run one replanner attempt: render, spawn, validate the appendix rows. */
export async function runReplannerEpisode(
  request: {
    readonly objective: string
    readonly currentGraph: string
    readonly discoveries: string
    readonly feedback: string
    readonly limits: WorkGraphLimits
    readonly signal: AbortSignal
    readonly spawn: PlannerSpawn
  },
): Promise<ReplannerOutcome> {
  const prompt = renderReplannerPrompt({
    objective: request.objective,
    currentGraph: request.currentGraph,
    discoveries: request.discoveries,
    feedback: request.feedback,
  })
  const result = await request.spawn({ prompt, signal: request.signal })
  if (result.stopReason !== 'completed') {
    return { kind: 'fail-closed', reason: `replanner child ended with stop reason "${result.stopReason}"` }
  }
  if (result.structured === undefined) {
    return { kind: 'fail-closed', reason: 'replanner produced no structured appendix' }
  }
  try {
    const rows = validateAppendix(result.structured)
    const nodes: WorkNode[] = rows.map(row => ({
      id: canonicalNodeId(row.id),
      title: row.title,
      spec: row.spec,
      blocks: row.deps.map(dep => canonicalNodeId(dep)),
      state: 'waiting',
      rounds: 0,
    }))
    return { kind: 'planned', nodes }
  } catch (error) {
    if (error instanceof WorkGraphError) return { kind: 'invalid', reason: error.message }
    throw error
  }
}

/**
 * Install a replan appendix append-only: the new nodes append in planner
 * order, `gn-final` re-gates over the additions (a ready final demotes to
 * waiting), the plan version bumps, and the discovery entries clear. An
 * empty appendix still bumps the version and consumes the slot.
 * @param snapshot - the current snapshot.
 * @param nodes - the validated appendix nodes (canonical ids, `waiting`).
 * @param limits - carries the history cap.
 * @param now - epoch milliseconds of the transition.
 * @returns the snapshot with the appended nodes and the bumped plan version.
 */
export function installReplan(
  snapshot: WorkGraphSnapshot,
  nodes: readonly WorkNode[],
  limits: WorkGraphLimits,
  now: number,
): WorkGraphSnapshot {
  const existing = new Set(snapshot.nodes.map(node => node.id))
  for (const node of nodes) {
    if (node.id === FINAL_NODE_ID) {
      throw new WorkGraphError('replan may not append the reserved final node', 'WORKGRAPH_INVALID_PLAN')
    }
    if (existing.has(node.id)) {
      throw new WorkGraphError(`replan node ${node.id} duplicates an existing node`, 'WORKGRAPH_INVALID_PLAN')
    }
  }
  const final = snapshot.nodes.find(node => node.id === FINAL_NODE_ID)
  if (final === undefined) {
    throw new WorkGraphError('replan requires the final node', 'WORKGRAPH_INVALID_PLAN')
  }
  const newFinal: WorkNode = {
    ...final,
    blocks: [...final.blocks, ...nodes.map(node => node.id)],
    state: final.state === 'ready' ? 'waiting' : final.state,
  }
  const all = [
    ...snapshot.nodes.map(node => (node.id === FINAL_NODE_ID ? newFinal : node)),
    ...nodes,
  ]
  // An empty appendix re-gates the final over nothing new: if its (unchanged)
  // deps are all achieved, the re-gate must not strand it waiting.
  const promoted = promoteReady(all)
  return {
    ...snapshot,
    nodes: promoted,
    planVersion: snapshot.planVersion + 1,
    pendingDiscoveries: [],
    history: appendHistory(snapshot.history, [
      { at: now, kind: 'replanned', detail: `${nodes.length} node(s) appended` },
    ], limits),
    updatedAt: now,
  }
}

/**
 * Drain the pending discoveries to history (the degrade path: cap exhausted,
 * cap zero, final achieved, or a failed replan). The graph keeps running and
 * converges on the current plan.
 * @param snapshot - the current snapshot.
 * @param limits - carries the history cap.
 * @param now - epoch milliseconds of the transition.
 * @returns the snapshot with the entries cleared.
 */
export function drainDiscoveries(
  snapshot: WorkGraphSnapshot,
  limits: WorkGraphLimits,
  now: number,
): WorkGraphSnapshot {
  const drained = snapshot.pendingDiscoveries.length
  if (drained === 0) return snapshot
  return {
    ...snapshot,
    pendingDiscoveries: [],
    history: appendHistory(snapshot.history, [
      { at: now, kind: 'replanned', detail: `${drained} discover(y/ies) drained to history` },
    ], limits),
    updatedAt: now,
  }
}

/** The node ids the appendix may depend on (live existing nodes, never the final). */
export function replanDependencyGuard(
  nodes: readonly WorkNode[],
  existing: readonly WorkNode[],
): void {
  const live = new Set(existing.map(node => node.id))
  for (const node of nodes) {
    for (const dep of node.blocks) {
      if (dep === FINAL_NODE_ID || !live.has(dep)) {
        throw new WorkGraphError(
          `replan node ${node.id} depends on ${dep}, which is not a live existing node`,
          'WORKGRAPH_INVALID_PLAN',
        )
      }
    }
  }
}

/** Re-exported for the caller's convenience. */
export type { WorkNodeId }
