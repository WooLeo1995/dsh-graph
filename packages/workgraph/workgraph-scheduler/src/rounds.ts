/**
 * The shared node episode: worker/verifier rounds for one node, optionally
 * inside a caller-chosen workspace (a parallel worktree). A `done` report is
 * audited by the adversarial verifier; a rejection iterates the SAME worker
 * child with the named gaps, bounded by the nodeRounds cap. The caller
 * (serial or parallel driver) decides what follows an achieved settlement
 * (merge-back, next node).
 * @module @deepseek-ai/dsh-workgraph-scheduler/rounds
 */

import type { WorkGraphSnapshot, WorkNode } from '@deepseek-ai/dsh-workgraph'
import type { WorkNodeId } from '@deepseek-ai/dsh-workgraph/types'
import {
  demoteRunningToReady,
  markRunning,
  pauseGraph,
  queueDiscoveries,
  settleAchieved,
  settleFailed,
} from './tracker.ts'
import type { WorkerEpisodeOutcome } from './worker.ts'
import { runVerifierEpisode } from './verifier.ts'
import type { SerialDriverHooks } from './serial.ts'
import { renderWorkerPrompt } from './prompts.ts'

/** The accumulated discoveries and worker round of one node episode. */
interface NodeEpisodeState {
  readonly discoveries: Array<{ description: string; from: WorkNodeId }>
  round: number
  readonly childSessionId: string
}

/** The settled outcome of one node episode. */
export interface NodeEpisodeResult {
  readonly snapshot: WorkGraphSnapshot
  /** Whether the node achieved (and thus passed verification). */
  readonly achieved: boolean
}

/**
 * Run one node's worker/verifier rounds: worker round 1 (continuable child),
 * markRunning with the child session id, then the verifier gates achievement
 * — a rejection iterates the SAME child with the named gaps up to the
 * nodeRounds cap. Blocked/unparseable/fail-closed reports fail the node; a
 * rejected-without-gaps verdict is itself invalid; cap exhaustion fails the
 * node naming the last gaps. Interruptions demote the in-flight node on the
 * authoritative snapshot. The optional `workspace` isolates the child (and
 * its verifier) in a worktree.
 */
export async function runNodeRounds(
  snapshot: WorkGraphSnapshot,
  node: WorkNode,
  workspace: string | undefined,
  hooks: SerialDriverHooks,
): Promise<NodeEpisodeResult> {
  const position = snapshot.nodes.findIndex(entry => entry.id === node.id) + 1
  const roundPrompt = (gaps: readonly string[]): string => renderWorkerPrompt({
    position,
    total: snapshot.nodes.length,
    title: node.title,
    spec: node.spec,
    objective: snapshot.objective,
    gaps,
  })

  let first
  let running: WorkGraphSnapshot | undefined
  try {
    first = await hooks.workerRound({
      prompt: roundPrompt([]),
      signal: hooks.signal(),
      round: 1,
      ...(workspace === undefined ? {} : { workspace }),
      onSpawned: async (childSessionId) => {
        // The child is published: commit the running transition NOW so the
        // durable state and projection show `running` while the worker works,
        // not only after its (minutes-long) first round settles. An abort
        // that landed mid-spawn leaves the transition to the pause itself.
        if (hooks.aborted()) return
        running = markRunning(snapshot, node.id, hooks.limits, hooks.now(), childSessionId)
        await hooks.commit(running)
      },
    })
  } catch (error) {
    // A transport failure is an episode failure, unless it was the abort
    // signal firing mid-start — that is a resource stop, not a verdict.
    if (hooks.aborted()) return { snapshot: await demoteIfRunning(hooks.current(), node.id, hooks), achieved: false }
    throw error
  }
  if (hooks.aborted()) {
    // The pause landed while the spawn was in flight: the authoritative
    // (paused) snapshot stands as-is, except that a running transition
    // committed at spawn must demote (a resource stop, never a verdict).
    return { snapshot: await demoteIfRunning(hooks.current(), node.id, hooks), achieved: false }
  }
  const state: NodeEpisodeState = {
    discoveries: [],
    round: 1,
    childSessionId: first.childSessionId,
  }
  // The running transition commits at spawn on transports that report the
  // publication; scripted seams fall back to the post-round transition.
  let current = running ?? markRunning(snapshot, node.id, hooks.limits, hooks.now(), first.childSessionId)
  if (running === undefined) await hooks.commit(current)
  let outcome = first.outcome
  for (;;) {
    if (outcome.kind !== 'done') {
      return { snapshot: await settleNodeFailure(current, node.id, outcome, state, hooks), achieved: false }
    }
    state.discoveries.push(...outcome.discovered.map(description => ({ description, from: node.id })))
    const verdict = await runVerifierEpisode({
      position,
      total: snapshot.nodes.length,
      title: node.title,
      spec: node.spec,
      objective: snapshot.objective,
      summary: outcome.summary,
      ...(workspace === undefined ? {} : { workspace }),
      signal: hooks.signal(),
      spawn: hooks.verifierSpawn,
    })
    if (hooks.aborted()) {
      current = demoteRunningToReady(hooks.current(), node.id, hooks.limits, hooks.now())
      await hooks.commit(current)
      return { snapshot: current, achieved: false }
    }
    if (verdict.kind === 'achieved') {
      state.discoveries.push(...verdict.discovered.map(description => ({ description, from: node.id })))
      return { snapshot: await settleNodeAchieved(current, node.id, state, hooks), achieved: true }
    }
    if (verdict.kind === 'invalid' || verdict.kind === 'fail-closed') {
      return {
        snapshot: await settleNodeFailure(current, node.id, { kind: 'fail-closed', reason: verdict.reason }, state, hooks),
        achieved: false,
      }
    }
    state.discoveries.push(...verdict.discovered.map(description => ({ description, from: node.id })))
    if (state.round >= hooks.nodeRounds) {
      return {
        snapshot: await settleNodeFailure(
          current,
          node.id,
          {
            kind: 'fail-closed',
            reason: `verifier rounds exhausted (${hooks.nodeRounds}); last gaps: ${verdict.gaps.join(' | ')}`,
          },
          state,
          hooks,
        ),
        achieved: false,
      }
    }
    // Rejections iterate the SAME worker child with exactly the named gaps.
    state.round += 1
    const next = await hooks.workerRound({
      prompt: roundPrompt(verdict.gaps),
      signal: hooks.signal(),
      round: state.round,
      childSessionId: state.childSessionId,
      ...(workspace === undefined ? {} : { workspace }),
    })
    if (hooks.aborted()) {
      current = demoteRunningToReady(hooks.current(), node.id, hooks.limits, hooks.now())
      await hooks.commit(current)
      return { snapshot: current, achieved: false }
    }
    outcome = next.outcome
  }
}

/** Settle the node achieved with the child's usage charge and queued discoveries. */
async function settleNodeAchieved(
  snapshot: WorkGraphSnapshot,
  nodeId: WorkNodeId,
  state: NodeEpisodeState,
  hooks: SerialDriverHooks,
): Promise<WorkGraphSnapshot> {
  const usage = await hooks.readUsage(state.childSessionId)
  if (hooks.aborted()) {
    const demoted = demoteRunningToReady(hooks.current(), nodeId, hooks.limits, hooks.now())
    await hooks.commit(demoted)
    return demoted
  }
  // A budget configured in a composition whose children record no provider
  // usage fails loud at the first child instead of silently mis-budgeting:
  // the node demotes to ready (a resource stop, never a verdict) and the
  // graph pauses infra, so a resume with a recording composition re-runs it.
  if (snapshot.tokenBudget !== undefined && !usage.recorded) {
    const demoted = demoteRunningToReady(snapshot, nodeId, hooks.limits, hooks.now())
    const paused = pauseGraph(
      demoted,
      'infra',
      'token budget configured but the composition records no provider usage',
      hooks.limits,
      hooks.now(),
    )
    await hooks.commit(paused)
    return paused
  }
  let current = settleAchieved(snapshot, nodeId, state.round, usage.tokens, hooks.limits, hooks.now())
  if (state.discoveries.length > 0) {
    current = queueDiscoveries(current, state.discoveries, hooks.limits, hooks.now())
  }
  await hooks.commit(current)
  return current
}

/** Settle the node failed (blocked/unparseable/fail-closed) with its charge. */
async function settleNodeFailure(
  snapshot: WorkGraphSnapshot,
  nodeId: WorkNodeId,
  outcome: Exclude<WorkerEpisodeOutcome, { readonly kind: 'done' }>,
  state: NodeEpisodeState,
  hooks: SerialDriverHooks,
): Promise<WorkGraphSnapshot> {
  const usage = await hooks.readUsage(state.childSessionId)
  if (hooks.aborted()) {
    const demoted = demoteRunningToReady(hooks.current(), nodeId, hooks.limits, hooks.now())
    await hooks.commit(demoted)
    return demoted
  }
  // A budget configured in a composition whose children record no provider
  // usage fails loud at the first child instead of silently mis-budgeting:
  // the node demotes to ready (a resource stop, never a verdict) and the
  // graph pauses infra, so a resume with a recording composition re-runs it.
  if (snapshot.tokenBudget !== undefined && !usage.recorded) {
    const demoted = demoteRunningToReady(snapshot, nodeId, hooks.limits, hooks.now())
    const paused = pauseGraph(
      demoted,
      'infra',
      'token budget configured but the composition records no provider usage',
      hooks.limits,
      hooks.now(),
    )
    await hooks.commit(paused)
    return paused
  }
  const reason = outcome.kind === 'blocked'
    ? outcome.reason
    : (outcome.kind === 'unparseable'
      ? `worker report unparseable: ${outcome.reason}`
      : `worker episode failed: ${outcome.reason}`)
  const settled = settleFailed(snapshot, nodeId, reason, usage.tokens, state.round, hooks.limits, hooks.now())
  await hooks.commit(settled)
  return settled
}

/**
 * Demote a node whose running transition committed at spawn when an abort
 * lands mid-round, and commit the demote (a resource stop, never a verdict).
 * Transports that never reported the publication — and graphs whose plan was
 * abandoned mid-planning — leave no running state, so the authoritative
 * snapshot stands as-is without an extra commit.
 */
async function demoteIfRunning(
  snapshot: WorkGraphSnapshot,
  nodeId: WorkNodeId,
  hooks: SerialDriverHooks,
): Promise<WorkGraphSnapshot> {
  const node = snapshot.nodes.find(entry => entry.id === nodeId)
  /* v8 ignore next 3 -- a round in flight implies the installed plan; a cleared graph makes hooks.current() throw before this helper runs */
  if (node === undefined || node.state !== 'running') return snapshot
  const demoted = demoteRunningToReady(snapshot, nodeId, hooks.limits, hooks.now())
  await hooks.commit(demoted)
  return demoted
}
