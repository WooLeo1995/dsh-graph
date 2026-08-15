/**
 * The topology optimizer (issue 09): a plan-boundary review pass that may
 * issue a RESTRICTED set of graph edits — remove false deps (restoring
 * parallelism), reorder pending priority, merge tiny nodes, split oversized
 * ones — over Waiting/Ready nodes only. `gn-final` cannot merge, split, or
 * be a merge party. Post-op invariants: the final gate rebuilds over all
 * surviving non-final nodes, pending status re-derives in BOTH directions
 * (a grafted dep demotes a Ready node; a removed blocker keeps one Ready),
 * non-pending nodes stay byte-identical, and acyclicity plus the node cap
 * re-verify. An applied pass bumps the plan version, consumes a slot of the
 * SHARED replan cap, and freezes a new baseline; an empty op list is a
 * respected no-op; any failure degrades — the current graph keeps running.
 * @module @deepseek-ai/dsh-workgraph-scheduler/optimizer
 */

import type { WorkGraphLimits, WorkGraphSnapshot, WorkNode } from '@deepseek-ai/dsh-workgraph'
import type { WorkNodeId } from '@deepseek-ai/dsh-workgraph/types'
import { WorkGraphError } from '@deepseek-ai/dsh-workgraph'
import { canonicalNodeId } from './ids.ts'
import { appendHistory, promoteReady } from './tracker.ts'
import { renderOptimizerPrompt } from './prompts.ts'
import type { PlannerSpawn } from './planner.ts'
import { FINAL_NODE_ID } from './ids.ts'

/** The structured capture schema for one optimizer pass. */
export const OPTIMIZER_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ops: {
      type: 'array',
      items: { type: 'object' },
    },
  },
  required: ['ops'],
  additionalProperties: false,
} as const

/** One restricted edit op over pending nodes. */
export type OptimizerOp =
  | { readonly op: 'remove_dep'; readonly node: string; readonly dep: string }
  | { readonly op: 'reorder'; readonly order: readonly string[] }
  | { readonly op: 'merge'; readonly into: string; readonly from: string }
  | {
    readonly op: 'split'
    readonly node: string
    readonly replacements: readonly {
      readonly id: string
      readonly title: string
      readonly spec: string
      readonly deps: readonly string[]
    }[]
  }

/** One optimizer attempt outcome. */
export type OptimizerOutcome =
  | { readonly kind: 'planned'; readonly ops: readonly OptimizerOp[] }
  | { readonly kind: 'invalid'; readonly reason: string }
  | { readonly kind: 'fail-closed'; readonly reason: string }

/** The slug hygiene rule shared with the plan gate. */
const SLUG_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u

/** Decode the raw ops array defensively. */
export function parseOptimizerOps(value: unknown): OptimizerOp[] | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (!Array.isArray(record['ops'])) return null
  const ops: OptimizerOp[] = []
  for (const raw of record['ops']) {
    if (raw === null || typeof raw !== 'object') return null
    const row = raw as Record<string, unknown>
    switch (row['op']) {
      case 'remove_dep': {
        const node = row['node']
        const dep = row['dep']
        if (typeof node !== 'string' || typeof dep !== 'string') return null
        ops.push({ op: 'remove_dep', node, dep })
        break
      }
      case 'reorder': {
        const order = row['order']
        if (!Array.isArray(order) || !order.every(id => typeof id === 'string')) return null
        ops.push({ op: 'reorder', order: order as string[] })
        break
      }
      case 'merge': {
        const into = row['into']
        const from = row['from']
        if (typeof into !== 'string' || typeof from !== 'string') return null
        ops.push({ op: 'merge', into, from })
        break
      }
      case 'split': {
        const node = row['node']
        const replacements = row['replacements']
        if (typeof node !== 'string' || !Array.isArray(replacements)) return null
        const rows: Array<{ id: string; title: string; spec: string; deps: string[] }> = []
        for (const rep of replacements) {
          if (rep === null || typeof rep !== 'object') return null
          const repRow = rep as Record<string, unknown>
          const id = repRow['id']
          const title = repRow['title']
          const spec = repRow['spec']
          const deps = repRow['deps']
          if (typeof id !== 'string' || typeof title !== 'string' || typeof spec !== 'string'
            || !Array.isArray(deps) || !deps.every(dep => typeof dep === 'string')) {
            return null
          }
          rows.push({ id, title, spec, deps: deps as string[] })
        }
        ops.push({ op: 'split', node, replacements: rows })
        break
      }
      default:
        return null
    }
  }
  return ops
}

/**
 * Run one optimizer attempt: render, spawn, decode the ops array.
 * @param request - the pass inputs.
 * @returns `planned` (decoded ops), `invalid` (malformed payload), or
 * `fail-closed` (child error or missing artifact).
 */
export async function runOptimizerEpisode(
  request: {
    readonly objective: string
    readonly currentGraph: string
    readonly history: string
    readonly limits: WorkGraphLimits
    readonly signal: AbortSignal
    readonly spawn: PlannerSpawn
  },
): Promise<OptimizerOutcome> {
  const prompt = renderOptimizerPrompt({
    objective: request.objective,
    currentGraph: request.currentGraph,
    history: request.history,
  })
  const result = await request.spawn({ prompt, signal: request.signal })
  if (result.stopReason !== 'completed') {
    return { kind: 'fail-closed', reason: `optimizer child ended with stop reason "${result.stopReason}"` }
  }
  if (result.structured === undefined) {
    return { kind: 'fail-closed', reason: 'optimizer produced no structured ops' }
  }
  try {
    const ops = parseOptimizerOps(result.structured)
    if (ops === null) return { kind: 'invalid', reason: 'optimizer artifact must be an object with an ops array' }
    return { kind: 'planned', ops }
  } catch (error) {
    /* v8 ignore start -- parseOptimizerOps never throws; the catch guards the union shape */
    if (error instanceof WorkGraphError) return { kind: 'invalid', reason: error.message }
    throw error
    /* v8 ignore stop */
  }
}

/** Whether a node may be edited by the optimizer (Waiting/Ready only). */
function isPending(node: WorkNode): boolean {
  return node.state === 'waiting' || node.state === 'ready'
}

/** Reject an op with its precise reason. */
function invalidOp(reason: string): never {
  throw new WorkGraphError(`optimizer op rejected: ${reason}`, 'WORKGRAPH_INVALID_OPTIMIZATION')
}

/** Kahn acyclicity over canonical ids; the first cycle member is named. */
function assertAcyclic(nodes: readonly WorkNode[]): void {
  const remaining = new Map(nodes.map(node => [node.id, new Set(node.blocks)]))
  /* v8 ignore next -- every node is seeded, so the size fallback never fires */
  const frontier = nodes.filter(node => (remaining.get(node.id)?.size ?? 0) === 0)
  let seen = 0
  while (frontier.length > 0) {
    const current = frontier.shift()
    /* v8 ignore next -- shift() on a non-empty frontier never returns undefined */
    if (current === undefined) break
    seen += 1
    for (const node of nodes) {
      const deps = remaining.get(node.id)
      /* v8 ignore next -- every node is seeded, so the miss never fires */
      if (deps === undefined) continue
      if (deps.delete(current.id) && deps.size === 0) frontier.push(node)
    }
  }
  if (seen !== nodes.length) {
    const cyclic = [...remaining.entries()].find(([, deps]) => deps.size > 0)
    /* v8 ignore next -- a mismatched count guarantees a cyclic member */
    invalidOp(`resulting graph is cyclic (${cyclic?.[0] ?? 'unknown'} member)`)
  }
}

/**
 * Apply the ops to the snapshot. Returns `null` for a respected empty op
 * list; otherwise the optimized snapshot with the plan version bumped, the
 * shared replan slot consumed, the final gate rebuilt, pending status
 * re-derived in both directions, non-pending nodes byte-identical, and
 * acyclicity plus the node cap re-verified.
 * @param snapshot - the current snapshot.
 * @param ops - the validated ops.
 * @param limits - carries the history cap and the node cap.
 * @param now - epoch milliseconds of the pass.
 * @returns the optimized snapshot, or `null` when no op was issued.
 */
export function applyOptimization(
  snapshot: WorkGraphSnapshot,
  ops: readonly OptimizerOp[],
  limits: WorkGraphLimits,
  now: number,
): WorkGraphSnapshot | null {
  if (ops.length === 0) return null
  const original = snapshot.nodes
  let nodes: WorkNode[] = original.map(node => ({ ...node }))
  const find = (id: string): WorkNode => {
    const node = nodes.find(entry => entry.id === id)
    if (node === undefined) invalidOp(`unknown node "${id}"`)
    return node
  }
  const pendingOrErr = (node: WorkNode): void => {
    if (!isPending(node)) {
      invalidOp(`node ${node.id} is ${node.state}; only Waiting/Ready nodes may be edited`)
    }
  }
  const nonPendingDependent = (id: string): WorkNode | undefined =>
    nodes.find(node =>
      node.id !== FINAL_NODE_ID && !isPending(node) && node.blocks.includes(id as WorkNodeId),
    )

  for (const op of ops) {
    if (op.op === 'remove_dep') {
      const node = find(op.node)
      pendingOrErr(node)
      if (!node.blocks.includes(op.dep as WorkNodeId)) {
        invalidOp(`node ${op.node} has no dependency on ${op.dep}`)
      }
      nodes = nodes.map(entry =>
        entry.id === op.node
          ? { ...entry, blocks: entry.blocks.filter(dep => dep !== (op.dep as WorkNodeId)) }
          : entry,
      )
      continue
    }
    if (op.op === 'reorder') {
      const seen = new Set<string>()
      for (const id of op.order) {
        const node = find(id)
        pendingOrErr(node)
        if (seen.has(id)) invalidOp(`reorder lists ${id} twice`)
        seen.add(id)
      }
      // Stable rearrangement: listed nodes adopt the listed relative order
      // across the positions they occupied.
      const positions = nodes
        .map((node, index) => ({ node, index }))
        .filter(({ node }) => op.order.includes(node.id as unknown as string))
        .map(({ index }) => index)
      const picked = op.order.map(id => find(id))
      positions.forEach((position, offset) => {
        const replacement = picked[offset]
        /* v8 ignore next -- positions and picked share the order length */
        if (replacement !== undefined) nodes[position] = { ...replacement }
      })
      continue
    }
    if (op.op === 'merge') {
      if (op.into === op.from) invalidOp('merge into == from')
      if (op.into === FINAL_NODE_ID || op.from === FINAL_NODE_ID) {
        invalidOp('the terminal node cannot participate in a merge')
      }
      const dependent = nonPendingDependent(op.from)
      if (dependent !== undefined) {
        invalidOp(`node ${op.from} has non-pending dependent ${dependent.id}; it cannot be merged`)
      }
      const intoNode = find(op.into)
      const fromNode = find(op.from)
      pendingOrErr(intoNode)
      pendingOrErr(fromNode)
      const absorbed = fromNode.blocks.filter(dep => dep !== op.into && !intoNode.blocks.includes(dep))
      nodes = nodes
        .filter(node => node.id !== op.from)
        .map((node) => {
          if (node.id === op.into) {
            return {
              ...node,
              spec: `${node.spec}\n\nAND: ${fromNode.spec}`,
              blocks: [...node.blocks.filter(dep => dep !== op.from), ...absorbed],
            }
          }
          if (node.blocks.includes(op.from as WorkNodeId)) {
            const rewired = node.blocks
              .filter(dep => dep !== (op.from as WorkNodeId))
              .map(dep => dep)
            if (!rewired.includes(op.into as WorkNodeId)) rewired.push(op.into as WorkNodeId)
            return { ...node, blocks: rewired }
          }
          return node
        })
      // Self-dependencies cannot survive a merge (into depended on from).
      nodes = nodes.map(node => ({ ...node, blocks: node.blocks.filter(dep => dep !== node.id) }))
      continue
    }
    // split
    if (op.node === FINAL_NODE_ID) invalidOp('the terminal node cannot be split')
    const originalNode = find(op.node)
    pendingOrErr(originalNode)
    const splitDependent = nonPendingDependent(op.node)
    if (splitDependent !== undefined) {
      invalidOp(`node ${op.node} has non-pending dependent ${splitDependent.id}; it cannot be split`)
    }
    if (op.replacements.length < 2 || op.replacements.length > 3) {
      invalidOp(`split of ${op.node} needs 2-3 replacements, got ${op.replacements.length}`)
    }
    const newIds: WorkNodeId[] = []
    for (const rep of op.replacements) {
      if (!SLUG_PATTERN.test(rep.id)) invalidOp(`replacement id "${rep.id}" is not a hygienic slug`)
      if (rep.title.trim().length === 0 || rep.spec.trim().length === 0) {
        invalidOp(`split replacement "${rep.id}" has an empty title/spec`)
      }
      const id = canonicalNodeId(rep.id)
      if (nodes.some(node => node.id === id) || newIds.includes(id)) {
        invalidOp(`split replacement "${rep.id}" collides with an existing node`)
      }
      newIds.push(id)
    }
    const deadIds = new Set(
      nodes.filter(node => node.state === 'failed' || node.state === 'blocked').map(node => node.id),
    )
    nodes = nodes.filter(node => node.id !== op.node)
    op.replacements.forEach((rep, index) => {
      const replacementId = newIds[index]
      /* v8 ignore next -- replacements and newIds share their order and length */
      if (replacementId === undefined) return
      const deps = [...originalNode.blocks]
      for (const dep of rep.deps) {
        const siblingIndex = op.replacements.findIndex(r => r.id === dep)
        const resolved = nodes.some(node => node.id === (dep as WorkNodeId))
          ? (dep as WorkNodeId)
          : siblingIndex >= 0
            ? newIds[siblingIndex]
            : undefined
        if (resolved === undefined) {
          invalidOp(`split replacement "${rep.id}" depends on unknown "${dep}"`)
        }
        if (deadIds.has(resolved as WorkNodeId)) {
          invalidOp(`split replacement "${rep.id}" depends on dead node "${resolved}"`)
        }
        if (!deps.includes(resolved as WorkNodeId)) deps.push(resolved as WorkNodeId)
      }
      nodes.push({
        id: replacementId,
        title: rep.title.trim(),
        spec: rep.spec.trim(),
        blocks: deps,
        state: 'waiting',
        rounds: 0,
      })
    })
    // Dependents of the original node now block every replacement.
    nodes = nodes.map((node) => {
      if (!node.blocks.includes(op.node as WorkNodeId)) return node
      const rewired = node.blocks.filter(dep => dep !== (op.node as WorkNodeId))
      for (const id of newIds) {
        /* v8 ignore next -- a rewire that already blocks a replacement is deduped */
        if (!rewired.includes(id as WorkNodeId)) rewired.push(id as WorkNodeId)
      }
      return { ...node, blocks: rewired }
    })
  }

  // Rebuild the terminal gate over all surviving non-final nodes.
  const nonFinal = nodes.filter(node => node.id !== FINAL_NODE_ID)
  const gate = nonFinal.map(node => node.id)
  nodes = nodes.map(node => (node.id === FINAL_NODE_ID ? { ...node, blocks: gate } : node))

  // Bidirectional status re-derivation over pending nodes: a removed
  // blocker keeps a Ready node ready; a grafted dep demotes it (a
  // promote-only pass would silently violate ordering at dispatch).
  const achieved = new Set(nodes.filter(node => node.state === 'achieved').map(node => node.id))
  const derived = nodes.map((node) => {
    if (node.state !== 'ready' && node.state !== 'waiting') return node
    const met = node.blocks.every(dep => achieved.has(dep))
    const target = met ? 'ready' as const : 'waiting' as const
    return node.state === target ? node : { ...node, state: target }
  })
  const rederived = promoteReady(derived)

  // Final invariants: non-pending nodes byte-identical (the per-op guards
  // already refuse edits touching them; this backstop keeps the promise),
  // acyclicity, size.
  for (const before of original) {
    if (isPending(before)) continue
    const after = rederived.find(node => node.id === before.id)
    /* v8 ignore next 2 -- the per-op guards keep non-pending nodes untouched */
    if (after === undefined || JSON.stringify(after) !== JSON.stringify(before)) {
      invalidOp(`non-pending node ${before.id} changed identity`)
    }
  }
  assertAcyclic(rederived)
  const plannerCount = rederived.filter(node => node.id !== FINAL_NODE_ID).length
  if (plannerCount > limits.maxNodes) {
    invalidOp(`optimized graph exceeds the node cap (${plannerCount} > ${limits.maxNodes})`)
  }

  return {
    ...snapshot,
    nodes: rederived,
    planVersion: snapshot.planVersion + 1,
    replanRuns: snapshot.replanRuns + 1,
    history: appendHistory(snapshot.history, [
      { at: now, kind: 'optimized', detail: `optimized to v${snapshot.planVersion + 1}` },
    ], limits),
    updatedAt: now,
  }
}
