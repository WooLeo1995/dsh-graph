/**
 * The serial execution episode: one Ready node at a time runs as a worker
 * child whose `done` report is audited by an adversarial verifier before the
 * node may achieve. A rejection iterates the SAME worker child (continuation,
 * context and workspace preserved) with the named gaps, bounded by the
 * nodeRounds cap; cap exhaustion fails the node naming the last gaps. The
 * drive loop is deterministic and checkpoint-everything, the budget gates
 * dispatch, and an interrupted episode (pause/clear) demotes the in-flight
 * node on the authoritative snapshot — a resource stop, never a verdict.
 * Parallel batches (issue 05) replace this loop's per-node dispatch while
 * reusing the same worker mechanics.
 * @module @deepseek-ai/dsh-workgraph-scheduler/serial
 */

import type { WorkGraphLimits, WorkGraphSnapshot, WorkNode } from '@deepseek-ai/dsh-workgraph'
import { budgetLimit } from './tracker.ts'
import type { WorkerRound } from './continuation.ts'
import type { WorkerSpawn } from './worker.ts'
import type { ChildUsageReader } from './usage.ts'
import { runNodeRounds } from './rounds.ts'

/** The remaining budget before a dispatch, or `undefined` for unlimited. */
export function remainingBudget(snapshot: WorkGraphSnapshot): number | undefined {
  if (snapshot.tokenBudget === undefined) return undefined
  return Math.max(0, snapshot.tokenBudget - snapshot.tokensSpent)
}

/** The engine surface the drive loop commits through. */
export interface SerialDriverHooks {
  /** Commit one transition and refresh the provider's live view. */
  commit(snapshot: WorkGraphSnapshot): void | Promise<void>
  /** The provider's authoritative current snapshot (latest committed view). */
  current(): WorkGraphSnapshot
  /** Whether the episode was interrupted (pause/clear). */
  readonly aborted: () => boolean
  /** The episode's cancellation signal for the child spawns. */
  readonly signal: () => AbortSignal
  readonly limits: WorkGraphLimits
  /** The worker round seam: round 1 spawns, rounds 2+ continue the same child. */
  readonly workerRound: WorkerRound
  /** The one-shot verifier spawn seam. */
  readonly verifierSpawn: WorkerSpawn
  /** The per-node worker-verifier round cap. */
  readonly nodeRounds: number
  readonly readUsage: ChildUsageReader
  readonly now: () => number
  /** The replan pass hook, called at episode boundaries. */
  readonly replan?: () => Promise<void>
}

/**
 * Drive the graph serially until it settles: every Ready node in storage
 * order runs its worker/verifier rounds, discoveries queue for the next
 * replan boundary, and the budget gates dispatch. Stops on completion, a
 * wedge (handled by the tracker), a budget trip, a pause abort (the in-flight
 * node demotes to ready), or a graph that is no longer active.
 * @param snapshot - the active snapshot to drive.
 * @param hooks - the commit/abort/seam surface.
 * @returns the final snapshot.
 */
export async function driveSerial(
  snapshot: WorkGraphSnapshot,
  hooks: SerialDriverHooks,
): Promise<WorkGraphSnapshot> {
  let current = snapshot
  while (current.status === 'active' && !hooks.aborted()) {
    if (remainingBudget(current) === 0) {
      current = budgetLimit(current, hooks.limits, hooks.now())
      await hooks.commit(current)
      break
    }
    if (hooks.replan !== undefined) {
      await hooks.replan()
      // The replan pass commits through the provider; re-read the
      // authoritative snapshot so the local chain cannot stomp it.
      current = hooks.current()
    }
    const node = current.nodes.find(entry => entry.state === 'ready')
    if (node === undefined) break
    current = await runSerialNode(current, node, hooks)
  }
  return current
}

/** Run one serial node's worker/verifier rounds (no workspace isolation). */
export async function runSerialNode(
  snapshot: WorkGraphSnapshot,
  node: WorkNode,
  hooks: SerialDriverHooks,
): Promise<WorkGraphSnapshot> {
  const result = await runNodeRounds(snapshot, node, undefined, hooks)
  return result.snapshot
}
