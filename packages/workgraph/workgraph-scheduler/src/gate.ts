/**
 * The plan static gate: ordered, fail-closed validation of planner artifact
 * rows, canonical-id minting, and the harness-appended final node.
 * @module @deepseek-ai/dsh-workgraph-scheduler/gate
 */

import { WorkGraphError } from '@deepseek-ai/dsh-workgraph'
import type { WorkGraphLimits, WorkNode } from '@deepseek-ai/dsh-workgraph'
import type { WorkNodeId } from '@deepseek-ai/dsh-workgraph/types'
import { canonicalNodeId, FINAL_NODE_ID } from './ids.ts'

/** One validated, trimmed planner row with deduplicated dependencies. */
export interface ParsedPlanNode {
  /** The planner slug, validated for hygiene and uniqueness. */
  readonly slug: string
  readonly title: string
  readonly spec: string
  /** Slug identities of prerequisite nodes, duplicates collapsed. */
  readonly deps: readonly string[]
}

/** Slug hygiene: 1–64 characters of letters, digits, underscore, hyphen. */
const SLUG_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** Reject the plan with its precise, ordered reason. */
function invalid(reason: string): never {
  throw new WorkGraphError(reason, 'WORKGRAPH_INVALID_PLAN')
}

/** Whether a value is a JSON record rather than an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Decode and trim one planner row; shape errors are parse failures. */
function parseRow(value: unknown, index: number): Omit<ParsedPlanNode, 'deps'> & { deps: string[] } {
  if (!isRecord(value)) invalid(`plan node ${index} must be a record`)
  const { id, title, spec, deps } = value
  if (typeof id !== 'string') invalid(`plan node ${index} id must be a string`)
  if (typeof title !== 'string') invalid(`plan node ${index} (${id}) title must be a string`)
  if (typeof spec !== 'string') invalid(`plan node ${index} (${id}) spec must be a string`)
  if (!Array.isArray(deps)) invalid(`plan node ${index} (${id}) deps must be an array`)
  const validatedDeps: string[] = []
  for (const dep of deps) {
    if (typeof dep !== 'string') invalid(`plan node ${index} (${id}) deps must be strings`)
    validatedDeps.push(dep)
  }
  return { slug: id, title: title.trim(), spec: spec.trim(), deps: validatedDeps }
}

/**
 * The planner-order-stable topological order: each Kahn round takes the FIRST
 * zero-indegree node in planner order, so `first Ready in storage order`
 * inherits planner intent, and a cycle strands its members.
 * @param rows - validated plan rows.
 * @returns the rows in stable topological order.
 */
function stableTopologicalOrder(rows: readonly ParsedPlanNode[]): readonly ParsedPlanNode[] {
  const remaining = new Map(rows.map(row => [row.slug, new Set(row.deps)]))
  const ordered: ParsedPlanNode[] = []
  while (remaining.size > 0) {
    let picked: ParsedPlanNode | undefined
    for (const row of rows) {
      const pending = remaining.get(row.slug)
      if (pending !== undefined && pending.size === 0) {
        picked = row
        break
      }
    }
    if (picked === undefined) {
      invalid(`plan contains a dependency cycle involving: ${[...remaining.keys()].sort().join(', ')}`)
    }
    remaining.delete(picked.slug)
    ordered.push(picked)
    for (const pending of remaining.values()) pending.delete(picked.slug)
  }
  return ordered
}

/**
 * Validate a planner artifact and normalize it into trimmed, dependency-
 * deduplicated rows in planner-order-stable topological order. Checks run in
 * the spec's fixed order, each rejection naming its precise reason.
 * @param value - the raw planner artifact (model JSON boundary).
 * @param limits - validation bounds.
 * @param hash - canonical id mint; overridable for collision tests.
 * @returns the validated rows in topological order.
 */
export function parsePlanArtifact(
  value: unknown,
  limits: WorkGraphLimits,
  hash: (slug: string) => WorkNodeId = canonicalNodeId,
): readonly ParsedPlanNode[] {
  if (!isRecord(value) || !Array.isArray(value['nodes'])) {
    invalid('plan artifact must be an object with a nodes array')
  }
  if (limits.planBytesMax !== undefined) {
    const bytes = new TextEncoder().encode(JSON.stringify(value)).length
    if (bytes > limits.planBytesMax) {
      invalid(`plan artifact exceeds the byte budget (${bytes} > ${limits.planBytesMax})`)
    }
  }
  const rawRows = value['nodes']
  if (rawRows.length === 0) invalid('plan must contain at least one node')
  const rows: ParsedPlanNode[] = rawRows.map((row, index) => {
    const parsed = parseRow(row, index)
    return { ...parsed, deps: [...new Set(parsed.deps)] }
  })
  if (rows.length > limits.maxNodes) {
    invalid(`plan exceeds the node cap (${rows.length} > ${limits.maxNodes})`)
  }
  const seenSlugs = new Set<string>()
  for (const row of rows) {
    if (!SLUG_PATTERN.test(row.slug)) {
      invalid(`node id "${row.slug}" must be 1-64 characters of [A-Za-z0-9_-]`)
    }
    if (seenSlugs.has(row.slug)) invalid(`duplicate node id "${row.slug}"`)
    seenSlugs.add(row.slug)
    if (row.title.length === 0) invalid(`node "${row.slug}" has an empty title`)
    if (row.spec.length === 0) invalid(`node "${row.slug}" has an empty spec`)
  }
  for (const row of rows) {
    for (const dep of row.deps) {
      if (dep === row.slug) invalid(`node "${row.slug}" depends on itself`)
      if (!seenSlugs.has(dep)) invalid(`node "${row.slug}" depends on unknown node "${dep}"`)
    }
  }
  const ordered = stableTopologicalOrder(rows)
  const seenIds = new Map<WorkNodeId, string>()
  for (const row of ordered) {
    const id = hash(row.slug)
    const owner = seenIds.get(id)
    if (owner !== undefined) {
      invalid(`distinct node ids "${owner}" and "${row.slug}" produce the same canonical id ${id}`)
    }
    seenIds.set(id, row.slug)
  }
  return ordered
}

/** The final node's fixed title. */
export const FINAL_NODE_TITLE = 'Final verification of the overall objective'

/**
 * The final node's fixed outcome contract embedding the whole objective.
 * @param objective - the graph objective the final node re-verifies.
 * @returns the fixed spec text.
 */
export function finalNodeSpec(objective: string): string {
  return `Independently verify that the OVERALL objective below is fully achieved, end to end, in the current state of the project. Re-run the relevant builds/tests/commands yourself; do not trust prior claims. If you find a gap, close it. Do not add features beyond the objective.\n\nOVERALL OBJECTIVE:\n${objective}`
}

/**
 * Build the harness-appended final node gated over every planner node.
 * @param objective - the graph objective.
 * @param blocks - canonical ids of every planner node.
 * @returns the final work node in `waiting` state.
 */
export function buildFinalNode(objective: string, blocks: readonly WorkNodeId[]): WorkNode {
  return {
    id: FINAL_NODE_ID,
    title: FINAL_NODE_TITLE,
    spec: finalNodeSpec(objective),
    blocks,
    state: 'waiting',
    rounds: 0,
  }
}

/**
 * Install a planner artifact as the initial durable node set: canonical ids,
 * rewritten blocks edges, every node `waiting` in topological order, and the
 * final node appended last, gated over all planner nodes.
 * @param value - the raw planner artifact.
 * @param objective - the graph objective embedded in the final node.
 * @param limits - validation bounds.
 * @param hash - canonical id mint; overridable for collision tests.
 * @returns the installed node set, final node last.
 */
export function installPlan(
  value: unknown,
  objective: string,
  limits: WorkGraphLimits,
  hash: (slug: string) => WorkNodeId = canonicalNodeId,
): readonly WorkNode[] {
  const rows = parsePlanArtifact(value, limits, hash)
  for (const row of rows) {
    if (hash(row.slug) === FINAL_NODE_ID) {
      invalid(`node "${row.slug}" canonicalizes onto the reserved final node id`)
    }
  }
  const nodes: WorkNode[] = rows.map(row => ({
    id: hash(row.slug),
    title: row.title,
    spec: row.spec,
    blocks: row.deps.map(dep => hash(dep)),
    state: 'waiting',
    rounds: 0,
  }))
  return [...nodes, buildFinalNode(objective, nodes.map(node => node.id))]
}
