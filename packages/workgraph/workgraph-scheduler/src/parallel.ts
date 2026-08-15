/**
 * The parallel batch episode: when more than one node is Ready and the
 * concurrency cap exceeds 1 (and the composition can isolate workspaces in a
 * git repo), a batch of Ready nodes runs as independent worker/verifier
 * pairs, each in its own git worktree minted under the harness home. Merge-
 * back runs sequentially in batch order: a HEAD guard fails a node loudly if
 * the main HEAD moved since fan-out, each changed file merges 3-way over raw
 * bytes, and a conflict fails only that node — siblings continue, dependents
 * block. A successful merge removes the worktree best-effort; a failed node
 * keeps it for postmortem. Outside a git repo or with an incapable provider,
 * the driver degrades to serial exactly like jxca's non-git clamp.
 * @module @deepseek-ai/dsh-workgraph-scheduler/parallel
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { WorkGraphSnapshot, WorkNode } from '@deepseek-ai/dsh-workgraph'
import { settleMergeFailed } from './tracker.ts'
import { runNodeRounds } from './rounds.ts'
import { runSerialNode, type SerialDriverHooks } from './serial.ts'
import {
  captureHead,
  isGitRepo,
  mergeWorktree,
  mintWorktree,
  worktreePath,
  type GitSeam,
} from './worktrees.ts'

/** The engine surface the parallel drive commits through. */
export interface ParallelDriverHooks extends SerialDriverHooks {
  /** The agent whose session owns the graph (worktree paths derive from it). */
  readonly agent: Agent
  /** Whether the composition can isolate a child in a caller-chosen workspace. */
  readonly workspaceCapable: boolean
  /** The parallel batch cap; 1 disables batches (serial only). */
  readonly concurrency: number
  /** The harness home workgraph dir (worktrees live under it). */
  readonly workgraphDir: string
  /** The main working directory the worktrees fan out from. */
  readonly mainDir: string
  /** The git seam. */
  readonly git: GitSeam
}

/**
 * Drive the graph with parallel batches where eligible (≥2 Ready nodes, the
 * cap above 1, a workspace-capable composition, a git repo), falling back to
 * the serial node episode otherwise. Each batch runs its nodes in isolated
 * worktrees (the workspace override reaches the worker and verifier
 * children), then merges them back sequentially in batch order.
 */
export async function driveParallel(
  snapshot: WorkGraphSnapshot,
  hooks: ParallelDriverHooks,
): Promise<WorkGraphSnapshot> {
  let current = snapshot
  while (current.status === 'active' && !hooks.aborted()) {
    let ready = current.nodes.filter(node => node.state === 'ready')
    if (ready.length >= 2 && hooks.concurrency > 1 && hooks.workspaceCapable
      && await isGitRepo(hooks.git, hooks.mainDir)) {
      current = await runBatch(current, ready.slice(0, hooks.concurrency), hooks)
      continue
    }
    if (hooks.replan !== undefined) {
      await hooks.replan()
      current = hooks.current()
      // The replan pass re-gates nodes (a ready final demotes to waiting);
      // re-read the runnable set against the authoritative snapshot.
      ready = current.nodes.filter(node => node.state === 'ready')
    }
    const node = ready[0]
    if (node === undefined) break
    current = await runSerialNode(current, node, hooks)
  }
  return current
}

/** One batch: mint worktrees, run the nodes concurrently, merge back sequentially. */
async function runBatch(
  snapshot: WorkGraphSnapshot,
  batch: readonly WorkNode[],
  hooks: ParallelDriverHooks,
): Promise<WorkGraphSnapshot> {
  const sessionId = hooks.agent.id
  const fanOutHead = await captureHead(hooks.git, hooks.mainDir)
  // Mint every worktree at the fan-out HEAD first: the batch shares one
  // isolation baseline.
  for (const node of batch) {
    if (hooks.aborted()) break
    await mintWorktree(hooks.git, hooks.mainDir, worktreePath(hooks.workgraphDir, sessionId, node.id), fanOutHead)
  }
  let current = snapshot
  for (const node of batch) {
    if (hooks.aborted()) break
    const path = worktreePath(hooks.workgraphDir, sessionId, node.id)
    const result = await runNodeRounds(current, node, path, hooks)
    current = result.snapshot
    if (!result.achieved || hooks.aborted()) continue
    // Merge back sequentially in batch order, gated on the CURRENT main
    // HEAD: a moved HEAD fails only this node; the node keeps its worktree.
    const currentHead = await captureHead(hooks.git, hooks.mainDir)
    const merged = await mergeWorktree(hooks.git, hooks.mainDir, path, fanOutHead, currentHead)
    if (!merged.ok) {
      current = settleMergeFailed(current, node.id, merged.reason, hooks.limits, hooks.now())
      await hooks.commit(current)
    }
  }
  return current
}
