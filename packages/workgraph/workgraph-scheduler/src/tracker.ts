/**
 * The deterministic work-graph tracker: pure transitions over an immutable
 * snapshot. Every function returns a new snapshot and throws
 * `WORKGRAPH_INVALID_TRANSITION` on any illegal move; no function reads the
 * clock — callers pass transition timestamps explicitly.
 * @module @deepseek-ai/dsh-workgraph-scheduler/tracker
 */

import { WorkGraphError } from '@deepseek-ai/dsh-workgraph'
import type {
  WorkGraphDiscovery,
  WorkGraphHistoryEntry,
  WorkGraphLimits,
  WorkGraphSnapshot,
  WorkNode,
} from '@deepseek-ai/dsh-workgraph'
import type { WorkGraphId, WorkNodeId } from '@deepseek-ai/dsh-workgraph/types'

/** The restore message a revived graph carries while paused. */
export const RESTORE_PAUSE_REASON = 'Restored after a restart. Use resume to continue.'

/** The wedge message a blocked graph carries while no node is runnable. */
export const WEDGE_PAUSE_REASON =
  'No runnable node left: a dependency chain failed; retry the failed node to re-run its chain.'

/** Reject an illegal transition with its precise cause. */
function invalid(reason: string): never {
  throw new WorkGraphError(reason, 'WORKGRAPH_INVALID_TRANSITION')
}

/**
 * Append entries to the capped history, dropping the oldest first.
 * @param history - the current history.
 * @param entries - new entries in commit order.
 * @param limits - carries the history cap.
 * @returns the capped history.
 */
export function appendHistory(
  history: readonly WorkGraphHistoryEntry[],
  entries: readonly WorkGraphHistoryEntry[],
  limits: WorkGraphLimits,
): readonly WorkGraphHistoryEntry[] {
  const combined = [...history, ...entries]
  return combined.length > limits.historyMax
    ? combined.slice(combined.length - limits.historyMax)
    : combined
}

/** Promote every `waiting` node whose blocks are all achieved. */
export function promoteReady(nodes: readonly WorkNode[]): readonly WorkNode[] {
  const achieved = new Set(nodes.filter(node => node.state === 'achieved').map(node => node.id))
  const promoted = nodes.map(node =>
    node.state === 'waiting' && node.blocks.every(dep => achieved.has(dep))
      ? { ...node, state: 'ready' as const }
      : node,
  )
  return promoted.some((node, index) => node !== nodes[index]) ? promoted : nodes
}

/** Replace one node by id, preserving order. */
function withNode(
  nodes: readonly WorkNode[],
  id: WorkNodeId,
  patch: (node: WorkNode) => WorkNode,
): readonly WorkNode[] {
  return nodes.map(node => (node.id === id ? patch(node) : node))
}

/** Require a node to exist and return it. */
function nodeById(snapshot: WorkGraphSnapshot, id: WorkNodeId): WorkNode {
  const node = snapshot.nodes.find(entry => entry.id === id)
  if (node === undefined) invalid(`unknown node ${id}`)
  return node
}

/** Drop the optional pause reason, if set, from a copied snapshot. */
function withoutPauseReason(snapshot: WorkGraphSnapshot): WorkGraphSnapshot {
  if (snapshot.pauseReason === undefined) return snapshot
  const next: Omit<WorkGraphSnapshot, 'pauseReason'> & { pauseReason?: string } = { ...snapshot }
  delete next.pauseReason
  return next
}

/**
 * Initialize the durable snapshot of a freshly installed plan.
 * @param id - the graph identity.
 * @param objective - the whole-objective text.
 * @param nodes - the installed node set, final node last.
 * @param limits - carries the history cap.
 * @param now - epoch milliseconds of creation.
 * @returns the active initial snapshot with promoted roots.
 */
export function initializeGraph(
  id: WorkGraphId,
  objective: string,
  nodes: readonly WorkNode[],
  limits: WorkGraphLimits,
  now: number,
): WorkGraphSnapshot {
  return {
    id,
    objective,
    status: 'active',
    planVersion: 1,
    nodes: promoteReady(nodes),
    pendingDiscoveries: [],
    history: appendHistory([], [{ at: now, kind: 'created' }], limits),
    tokensSpent: 0,
    replanRuns: 0,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Create the durable planning-window snapshot of a graph whose plan has not
 * been installed yet: zero nodes, active, history records creation and the
 * start of the planning episode. The planner runs against this snapshot; a
 * successful plan installs through {@link installPlanIntoGraph} and a failed
 * one pauses through {@link pausePlanningFailed}.
 * @param id - the graph identity.
 * @param objective - the whole-objective text.
 * @param limits - carries the history cap.
 * @param now - epoch milliseconds of creation.
 * @returns the active empty snapshot with planning started.
 */
export function createPendingGraph(
  id: WorkGraphId,
  objective: string,
  limits: WorkGraphLimits,
  now: number,
  tokenBudget?: number,
): WorkGraphSnapshot {
  const snapshot: Omit<WorkGraphSnapshot, 'tokenBudget'> & { tokenBudget?: number } = {
    id,
    objective,
    status: 'active',
    planVersion: 1,
    nodes: [],
    pendingDiscoveries: [],
    history: appendHistory([], [
      { at: now, kind: 'created' },
      { at: now, kind: 'planning-started' },
    ], limits),
    tokensSpent: 0,
    replanRuns: 0,
    createdAt: now,
    updatedAt: now,
  }
  if (tokenBudget !== undefined) snapshot.tokenBudget = tokenBudget
  return snapshot
}

/**
 * Install a validated plan into a pending graph: the full node set (final node
 * last, per {@link installPlan}) replaces the empty set, roots promote to
 * ready, and the planning episode records its completion. The plan version
 * stays 1 — replans bump it later.
 * @param snapshot - the pending graph snapshot.
 * @param nodes - the installed node set, final node last.
 * @param limits - carries the history cap.
 * @param now - epoch milliseconds of the transition.
 * @returns the active snapshot with the installed plan.
 */
export function installPlanIntoGraph(
  snapshot: WorkGraphSnapshot,
  nodes: readonly WorkNode[],
  limits: WorkGraphLimits,
  now: number,
): WorkGraphSnapshot {
  if (snapshot.nodes.length !== 0) {
    invalid('cannot install a plan into a graph that already has nodes')
  }
  if (snapshot.status !== 'active') {
    invalid(`cannot install a plan into a ${snapshot.status} graph`)
  }
  return {
    ...snapshot,
    nodes: promoteReady(nodes),
    history: appendHistory(snapshot.history, [
      { at: now, kind: 'planning-completed' },
    ], limits),
    updatedAt: now,
  }
}

/**
 * Pause an active graph as user- or infra-paused with a human-readable reason.
 * @param snapshot - the current snapshot.
 * @param kind - `user` for an explicit pause, `infra` for an environment stop.
 * @param reason - the pause cause shown to humans.
 * @param limits - carries the history cap.
 * @param now - epoch milliseconds of the transition.
 * @returns the paused snapshot.
 */
export function pauseGraph(
  snapshot: WorkGraphSnapshot,
  kind: 'user' | 'infra',
  reason: string,
  limits: WorkGraphLimits,
  now: number,
): WorkGraphSnapshot {
  if (snapshot.status !== 'active') {
    invalid(`cannot pause a ${snapshot.status} graph`)
  }
  return {
    ...snapshot,
    status: kind === 'user' ? 'user_paused' : 'infra_paused',
    pauseReason: reason,
    history: appendHistory(snapshot.history, [
      { at: now, kind: 'paused', detail: reason },
    ], limits),
    updatedAt: now,
  }
}

/**
 * Pause an active pending graph as infra-paused because its planning episode
 * failed (invalid plan rejected, or the planner child failed closed). The
 * history records the planning failure; resume re-plans.
 * @param snapshot - the active pending snapshot.
 * @param reason - the precise planning failure cause.
 * @param limits - carries the history cap.
 * @param now - epoch milliseconds of the transition.
 * @returns the infra-paused snapshot.
 */
export function pausePlanningFailed(
  snapshot: WorkGraphSnapshot,
  reason: string,
  limits: WorkGraphLimits,
  now: number,
): WorkGraphSnapshot {
  if (snapshot.status !== 'active') {
    invalid(`cannot fail planning of a ${snapshot.status} graph`)
  }
  return {
    ...snapshot,
    status: 'infra_paused',
    pauseReason: reason,
    history: appendHistory(snapshot.history, [
      { at: now, kind: 'planning-failed', detail: reason },
    ], limits),
    updatedAt: now,
  }
}

/**
 * Resume a paused, blocked, or budget-limited graph to active, dropping the
 * pause reason. An optional positive top-up replaces the token budget with
 * spent-so-far plus the top-up (the only way out of `budget_limited`). A
 * blocked graph that is still wedged re-pauses when the next episode runs; a
 * pending (zero-node) graph's caller re-plans after this transition.
 * @param snapshot - the paused or blocked snapshot.
 * @param topUp - optional budget top-up from spent-so-far.
 * @param limits - carries the history cap.
 * @param now - epoch milliseconds of the transition.
 * @returns the active snapshot.
 */
export function resumeGraph(
  snapshot: WorkGraphSnapshot,
  topUp: number | undefined,
  limits: WorkGraphLimits,
  now: number,
): WorkGraphSnapshot {
  if (snapshot.status !== 'user_paused' && snapshot.status !== 'infra_paused'
    && snapshot.status !== 'blocked' && snapshot.status !== 'budget_limited') {
    invalid(`cannot resume a ${snapshot.status} graph`)
  }
  if (topUp !== undefined && (!Number.isSafeInteger(topUp) || topUp <= 0)) {
    invalid('budget top-up must be a positive integer')
  }
  const base = withoutPauseReason(snapshot)
  const withBudget: Omit<WorkGraphSnapshot, 'tokenBudget'> & { tokenBudget?: number }
    = topUp === undefined ? base : { ...base, tokenBudget: snapshot.tokensSpent + topUp }
  return {
    ...withBudget,
    status: 'active',
    history: appendHistory(withBudget.history, [
      { at: now, kind: 'resumed' },
    ], limits),
    updatedAt: now,
  }
}

/** The pause message a budget-exhausted graph carries. */
export const BUDGET_PAUSE_REASON =
  'Graph token budget exhausted. Top up with resume --budget <tokens> or clear to abandon.'

/** Add one child token charge to spent-so-far; absent usage charges nothing. */
function chargeTokens(spent: number, usage: number | undefined): number {
  return usage === undefined ? spent : spent + usage
}

/** Whether a charge crosses the configured budget. */
function budgetTripped(snapshot: WorkGraphSnapshot, charged: number): boolean {
  return snapshot.tokenBudget !== undefined && charged >= snapshot.tokenBudget
}

/** Demote every running node to ready (a resource stop, never a verdict). */
function demoteRunningNodes(nodes: readonly WorkNode[]): readonly WorkNode[] {
  return nodes.map(node => (node.state === 'running' ? { ...node, state: 'ready' as const } : node))
}

/**
 * Trip the budget at a dispatch boundary: the graph becomes `budget_limited`
 * with the budget pause message, and every running node demotes to ready.
 * @param snapshot - the current snapshot.
 * @param limits - carries the history cap.
 * @param now - epoch milliseconds of the transition.
 * @returns the budget-limited snapshot.
 */
export function budgetLimit(
  snapshot: WorkGraphSnapshot,
  limits: WorkGraphLimits,
  now: number,
): WorkGraphSnapshot {
  if (snapshot.tokenBudget === undefined) {
    invalid('cannot trip the budget of an unlimited graph')
  }
  return {
    ...snapshot,
    nodes: demoteRunningNodes(snapshot.nodes),
    status: 'budget_limited',
    pauseReason: BUDGET_PAUSE_REASON,
    history: appendHistory(snapshot.history, [
      { at: now, kind: 'budget-exceeded', detail: BUDGET_PAUSE_REASON },
    ], limits),
    updatedAt: now,
  }
}

/**
 * Demote one running node to ready after an interrupted episode (a pause
 * abort, never a verdict). The node is re-runnable and verifier-gated again.
 * @param snapshot - the current snapshot.
 * @param id - the running node to demote.
 * @param limits - carries the history cap.
 * @param now - epoch milliseconds of the transition.
 * @returns the snapshot with the node ready.
 */
export function demoteRunningToReady(
  snapshot: WorkGraphSnapshot,
  id: WorkNodeId,
  limits: WorkGraphLimits,
  now: number,
): WorkGraphSnapshot {
  const node = nodeById(snapshot, id)
  if (node.state !== 'running') invalid(`node ${id} cannot demote from state ${node.state}`)
  const nodes = withNode(snapshot.nodes, id, (entry) => {
    const demoted: Omit<WorkNode, 'childSessionId'> & { childSessionId?: string } = {
      ...entry,
      state: 'ready',
    }
    delete demoted.childSessionId
    return demoted
  })
  return {
    ...snapshot,
    nodes,
    history: appendHistory(snapshot.history, [
      { at: now, kind: 'node-retried', node: id, detail: 'node demoted after an interrupted episode' },
    ], limits),
    updatedAt: now,
  }
}

/**
 * Queue reported out-of-scope work for the next replan boundary. Entries are
 * drained (or history-only past the cap) by the replanning episode.
 * @param snapshot - the current snapshot.
 * @param discoveries - one entry per reported item, attributed to its origin.
 * @param limits - carries the history cap.
 * @param now - epoch milliseconds of the transition.
 * @returns the snapshot with the appended pending discoveries.
 */
export function queueDiscoveries(
  snapshot: WorkGraphSnapshot,
  discoveries: readonly WorkGraphDiscovery[],
  limits: WorkGraphLimits,
  now: number,
): WorkGraphSnapshot {
  void limits
  void now
  const clean = discoveries.filter(entry => entry.description.trim().length > 0)
  if (clean.length === 0) return snapshot
  return {
    ...snapshot,
    pendingDiscoveries: [...snapshot.pendingDiscoveries, ...clean],
    updatedAt: now,
  }
}

/** Start one ready node.
 * @param snapshot - the current snapshot.
 * @param id - the node to start.
 * @param now - epoch milliseconds of the transition.
 * @param childSessionId - the worker child session executing the node.
 * @returns the snapshot with the node `running`.
 */
export function markRunning(
  snapshot: WorkGraphSnapshot,
  id: WorkNodeId,
  limits: WorkGraphLimits,
  now: number,
  childSessionId?: string,
): WorkGraphSnapshot {
  const node = nodeById(snapshot, id)
  if (node.state !== 'ready') invalid(`node ${id} cannot start from state ${node.state}`)
  const nodes = withNode(snapshot.nodes, id, (entry) => {
    const running: Omit<WorkNode, 'childSessionId'> & { childSessionId?: string } = {
      ...entry,
      state: 'running',
    }
    if (childSessionId !== undefined) running.childSessionId = childSessionId
    return running
  })
  return {
    ...snapshot,
    nodes,
    history: appendHistory(snapshot.history, [{ at: now, kind: 'node-started', node: id }], limits),
    updatedAt: now,
  }
}

/**
 * Settle one running node as achieved and promote its dependents. An optional
 * token charge accumulates into `tokensSpent`; when the charge crosses the
 * configured budget, every other running node demotes to ready (a resource
 * stop, never a verdict) and the graph trips `budget_limited` — unless the
 * settlement completed the graph, which wins.
 * @param snapshot - the current snapshot.
 * @param id - the node settling.
 * @param rounds - the settled worker-verifier round count.
 * @param usage - the child's token charge; absent means no budget accounting.
 * @param limits - carries the history cap.
 * @param now - epoch milliseconds of the transition.
 * @returns the snapshot with the node achieved; `complete` when every node
 *   including the final node is achieved.
 */
export function settleAchieved(
  snapshot: WorkGraphSnapshot,
  id: WorkNodeId,
  rounds: number,
  usage: number | undefined,
  limits: WorkGraphLimits,
  now: number,
): WorkGraphSnapshot {
  const node = nodeById(snapshot, id)
  if (node.state !== 'running') invalid(`node ${id} cannot achieve from state ${node.state}`)
  const settled = withNode(snapshot.nodes, id, entry => ({
    ...entry,
    state: 'achieved',
    rounds,
  }))
  const nodes = promoteReady(settled)
  const entries: WorkGraphHistoryEntry[] = [{ at: now, kind: 'node-achieved', node: id }]
  const complete = nodes.every(entry => entry.state === 'achieved')
  if (complete) entries.push({ at: now, kind: 'completed' })
  const charged = chargeTokens(snapshot.tokensSpent, usage)
  const tripped = budgetTripped(snapshot, charged)
  // A late achievement can wedge the graph even though the failure that
  // stranded it happened earlier (e.g. a merge-back failure while a sibling
  // was still runnable): nothing runnable and not all achieved is a wedge.
  const wedged = !complete && !tripped && isWedged(nodes)
  if (wedged) entries.push({ at: now, kind: 'paused', detail: WEDGE_PAUSE_REASON })
  if (complete) {
    return {
      ...snapshot,
      nodes,
      status: 'complete',
      tokensSpent: charged,
      history: appendHistory(snapshot.history, entries, limits),
      updatedAt: now,
    }
  }
  if (tripped) {
    entries.push({ at: now, kind: 'budget-exceeded', detail: BUDGET_PAUSE_REASON })
  }
  return {
    ...snapshot,
    nodes: tripped ? demoteRunningNodes(nodes) : nodes,
    status: tripped ? 'budget_limited' : (wedged ? 'blocked' : snapshot.status),
    ...(tripped
      ? { pauseReason: BUDGET_PAUSE_REASON }
      : (wedged ? { pauseReason: WEDGE_PAUSE_REASON } : {})),
    tokensSpent: charged,
    history: appendHistory(snapshot.history, entries, limits),
    updatedAt: now,
  }
}

/** The settled failure reason for a node whose merge-back failed. */
export const MERGE_FAILURE_PREFIX = 'merge-back failed'

/**
 * Fail a node that was already achieved when its merge-back failed (a HEAD
 * guard trip or a 3-way conflict): the achievement is revoked, the node
 * fails with the precise reason, its non-achieved dependents block, and a
 * wedge blocks the whole graph — one bad merge never kills the graph, only
 * this node and its dependents.
 * @param snapshot - the current snapshot with the node achieved.
 * @param id - the node whose merge-back failed.
 * @param reason - the precise merge failure cause.
 * @param limits - carries the history cap.
 * @param now - epoch milliseconds of the transition.
 * @returns the snapshot with the failed node, blocked chain, and any wedge.
 */
export function settleMergeFailed(
  snapshot: WorkGraphSnapshot,
  id: WorkNodeId,
  reason: string,
  limits: WorkGraphLimits,
  now: number,
): WorkGraphSnapshot {
  const node = nodeById(snapshot, id)
  if (node.state !== 'achieved') {
    invalid(`node ${id} cannot fail its merge from state ${node.state}`)
  }
  const fullReason = `${MERGE_FAILURE_PREFIX}: ${reason}`
  const failed = withNode(snapshot.nodes, id, entry => ({
    ...entry,
    state: 'failed',
    failure: fullReason,
  }))
  const nodes = blockDependents(failed, id)
  const entries: WorkGraphHistoryEntry[] = [
    { at: now, kind: 'node-failed', node: id, detail: fullReason },
  ]
  const wedged = isWedged(nodes)
  if (wedged) entries.push({ at: now, kind: 'paused', detail: WEDGE_PAUSE_REASON })
  return {
    ...snapshot,
    nodes,
    status: wedged ? 'blocked' : snapshot.status,
    ...(wedged ? { pauseReason: WEDGE_PAUSE_REASON } : {}),
    history: appendHistory(snapshot.history, entries, limits),
    updatedAt: now,
  }
}

/**
 * Mark every non-achieved, non-failed transitive dependent of the failed node
 * as blocked, attributing the chain to the original failure.
 */
function blockDependents(nodes: readonly WorkNode[], failedId: WorkNodeId): readonly WorkNode[] {
  const blocked = new Set<WorkNodeId>()
  const frontier = [failedId]
  while (frontier.length > 0) {
    const current = frontier.shift()
    /* v8 ignore next -- shift() on a non-empty frontier never returns undefined */
    if (current === undefined) break
    for (const node of nodes) {
      if (node.state === 'achieved' || node.state === 'failed' || blocked.has(node.id)) continue
      if (!node.blocks.includes(current)) continue
      blocked.add(node.id)
      frontier.push(node.id)
    }
  }
  if (blocked.size === 0) return nodes
  const reason = `blocked: dependency chain failed at ${failedId}`
  return nodes.map(node =>
    blocked.has(node.id) ? { ...node, state: 'blocked' as const, failure: reason } : node,
  )
}

/** Whether no node is runnable and not every node is achieved. */
function isWedged(nodes: readonly WorkNode[]): boolean {
  const runnable = nodes.some(node => node.state === 'ready' || node.state === 'running')
  const allAchieved = nodes.every(node => node.state === 'achieved')
  return !runnable && !allAchieved
}

/**
 * Settle one running node as failed: the node fails, its non-achieved
 * transitive dependents block with the chain attributed to this failure, and
 * a wedge (nothing runnable, not all achieved) blocks the whole graph. An
 * optional token charge accumulates into `tokensSpent` — spent-so-far is
 * always charged, including failed nodes — and a trip to the configured
 * budget demotes other running nodes to ready and marks the graph
 * `budget_limited` (the wedge pause loses to the budget stop). The settled
 * worker-verifier round count is recorded for audit, like achievements.
 * @param snapshot - the current snapshot.
 * @param id - the node settling.
 * @param reason - the precise failure cause.
 * @param usage - the child's token charge; absent means no budget accounting.
 * @param rounds - the settled worker-verifier round count.
 * @param limits - carries the history cap.
 * @param now - epoch milliseconds of the transition.
 * @returns the snapshot with the failure, blocked chain, and any pause.
 */
export function settleFailed(
  snapshot: WorkGraphSnapshot,
  id: WorkNodeId,
  reason: string,
  usage: number | undefined,
  rounds: number,
  limits: WorkGraphLimits,
  now: number,
): WorkGraphSnapshot {
  const node = nodeById(snapshot, id)
  if (node.state !== 'running') invalid(`node ${id} cannot fail from state ${node.state}`)
  const failed = withNode(snapshot.nodes, id, entry => ({
    ...entry,
    state: 'failed',
    failure: reason,
    rounds,
  }))
  const nodes = blockDependents(failed, id)
  const entries: WorkGraphHistoryEntry[] = [
    { at: now, kind: 'node-failed', node: id, detail: reason },
  ]
  const wedged = isWedged(nodes)
  const charged = chargeTokens(snapshot.tokensSpent, usage)
  const tripped = budgetTripped(snapshot, charged)
  if (wedged && !tripped) entries.push({ at: now, kind: 'paused', detail: WEDGE_PAUSE_REASON })
  if (tripped) entries.push({ at: now, kind: 'budget-exceeded', detail: BUDGET_PAUSE_REASON })
  return {
    ...snapshot,
    nodes: tripped ? demoteRunningNodes(nodes) : nodes,
    status: tripped ? 'budget_limited' : (wedged ? 'blocked' : snapshot.status),
    ...(tripped
      ? { pauseReason: BUDGET_PAUSE_REASON }
      : (wedged ? { pauseReason: WEDGE_PAUSE_REASON } : {})),
    tokensSpent: charged,
    history: appendHistory(snapshot.history, entries, limits),
    updatedAt: now,
  }
}

/**
 * Reset one terminal node plus its transitively blocked dependents to
 * re-runnable work. Refuses while any batch member's upstream dependency is
 * neither achieved nor in the same reset batch; a blocked graph becomes
 * active again.
 * @param snapshot - the current snapshot.
 * @param target - the failed node to retry.
 * @param limits - carries the history cap.
 * @param now - epoch milliseconds of the transition.
 * @returns the snapshot with the reset batch waiting or ready.
 */
export function retryNodes(
  snapshot: WorkGraphSnapshot,
  target: WorkNodeId,
  limits: WorkGraphLimits,
  now: number,
): WorkGraphSnapshot {
  const node = nodeById(snapshot, target)
  if (node.state !== 'failed' && node.state !== 'blocked') {
    invalid(`node ${target} is not retryable from state ${node.state}`)
  }
  const batch = new Set<WorkNodeId>([target])
  const frontier = [target]
  while (frontier.length > 0) {
    const current = frontier.shift()
    /* v8 ignore next -- shift() on a non-empty frontier never returns undefined */
    if (current === undefined) break
    for (const entry of snapshot.nodes) {
      if (entry.state === 'blocked' && !batch.has(entry.id) && entry.blocks.includes(current)) {
        batch.add(entry.id)
        frontier.push(entry.id)
      }
    }
  }
  return resetBatch(snapshot, batch, target, limits, now)
}

/**
 * Reset every failed node plus its transitively blocked chain as ONE batch
 * (bare `/graph retry`). A union batch is required because a shared final
 * blocked by sibling failures refuses any single-root reset whose other
 * dependency is still failed.
 * @param snapshot - the current snapshot.
 * @param limits - carries the history cap.
 * @param now - epoch milliseconds of the reset.
 * @returns the snapshot with every failure chain reset; unchanged when no
 * node is failed.
 */
export function retryAllNodes(
  snapshot: WorkGraphSnapshot,
  limits: WorkGraphLimits,
  now: number,
): WorkGraphSnapshot {
  const failed = snapshot.nodes.filter(node => node.state === 'failed')
  if (failed.length === 0) return snapshot
  const batch = new Set<WorkNodeId>()
  const frontier: WorkNodeId[] = []
  for (const node of failed) {
    /* v8 ignore next 3 -- snapshot node ids are unique, so the dedupe guard never fires */
    if (!batch.has(node.id)) {
      batch.add(node.id)
      frontier.push(node.id)
    }
  }
  while (frontier.length > 0) {
    const current = frontier.shift()
    /* v8 ignore next -- shift() on a non-empty frontier never returns undefined */
    if (current === undefined) break
    for (const entry of snapshot.nodes) {
      if (entry.state === 'blocked' && !batch.has(entry.id) && entry.blocks.includes(current)) {
        batch.add(entry.id)
        frontier.push(entry.id)
      }
    }
  }
  const root = [...batch][0]
  /* v8 ignore next -- the batch is non-empty whenever any node is failed */
  if (root === undefined) return snapshot
  return resetBatch(snapshot, batch, root, limits, now)
}

/** Reset one validated batch: upstream check, waiting reset, chain record. */
function resetBatch(
  snapshot: WorkGraphSnapshot,
  batch: Set<WorkNodeId>,
  root: WorkNodeId,
  limits: WorkGraphLimits,
  now: number,
): WorkGraphSnapshot {
  for (const member of snapshot.nodes) {
    if (!batch.has(member.id)) continue
    for (const dep of member.blocks) {
      if (batch.has(dep)) continue
      const upstream = snapshot.nodes.find(entry => entry.id === dep)
      if (upstream === undefined || upstream.state !== 'achieved') {
        throw new WorkGraphError(
          `node ${member.id} cannot retry before ${dep}`,
          'WORKGRAPH_RETRY_UPSTREAM_NOT_ACHIEVED',
        )
      }
    }
  }
  const nodes = promoteReady(
    snapshot.nodes.map((entry) => {
      if (!batch.has(entry.id)) return entry
      const reset: Omit<WorkNode, 'childSessionId' | 'failure'> & {
        childSessionId?: string
        failure?: string
      } = { ...entry, state: 'waiting' }
      delete reset.childSessionId
      delete reset.failure
      return reset
    }),
  )
  const base = withoutPauseReason(snapshot)
  return {
    ...base,
    nodes,
    status: snapshot.status === 'blocked' ? 'active' : snapshot.status,
    history: appendHistory(base.history, [
      { at: now, kind: 'node-retried', node: root, detail: `${batch.size} node(s) reset` },
    ], limits),
    updatedAt: now,
  }
}

/**
 * Sanitize a restored snapshot: running nodes demote to ready (an unknown
 * persisted state already decoded as ready), and an active graph demotes to
 * user-paused so a restored snapshot never resurrects as self-driving.
 * @param snapshot - the snapshot as persisted.
 * @param now - epoch milliseconds of the restore.
 * @returns the sanitized snapshot.
 */
export function restoreSnapshot(snapshot: WorkGraphSnapshot, now: number): WorkGraphSnapshot {
  const nodes = promoteReady(
    snapshot.nodes.map(node =>
      node.state === 'running' ? { ...node, state: 'ready' as const } : node,
    ),
  )
  if (snapshot.status !== 'active') {
    return { ...snapshot, nodes, updatedAt: now }
  }
  return {
    ...snapshot,
    nodes,
    status: 'user_paused',
    pauseReason: RESTORE_PAUSE_REASON,
    updatedAt: now,
  }
}
