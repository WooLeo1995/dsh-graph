/**
 * The work-graph scheduler provider: a Cordis `WorkGraphEngine` implementation
 * whose episodes drive the subagent seam. Issue 02 ships the planning episode
 * end to end — pending-graph creation, structured planner spawn with one
 * feedback retry, plan installation, and the frozen v1 baseline — plus
 * tracker-level pause/resume/retry/clear. Serial and parallel node episodes
 * land with the execution issues.
 * @module @deepseek-ai/dsh-workgraph-scheduler
 */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import {
  WorkGraphEngine,
  WorkGraphError,
  WorkGraphId,
  commitWorkGraphChange,
  foldWorkGraph,
} from '@deepseek-ai/dsh-workgraph'
import type {
  ResumeWorkGraphRequest,
  SetWorkGraphRequest,
  WorkGraphLimits,
  WorkGraphPanelSnapshot,
  WorkGraphSnapshot,
} from '@deepseek-ai/dsh-workgraph'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { WorkNodeId } from '@deepseek-ai/dsh-workgraph/types'
import { createBaselineStore, type BaselineStore } from './baselines.ts'
import { assemblePanelSnapshot } from './snapshot.ts'
import { PLAN_OUTPUT_SCHEMA, runPlannerEpisode, type PlannerSpawn } from './planner.ts'
import type { WorkerSpawn } from './worker.ts'
import { continuationWorkerRound, type WorkerRound } from './continuation.ts'
import { VERIFIER_OUTPUT_SCHEMA, VERIFIER_TOOL_FILTER } from './verifier.ts'
import { sessionChildUsageReader, type ChildUsageReader } from './usage.ts'
import { driveSerial, type SerialDriverHooks } from './serial.ts'
import { driveParallel, type ParallelDriverHooks } from './parallel.ts'
import { createGitSeam, type GitSeam } from './worktrees.ts'
import { drainDiscoveries, installReplan, replanDependencyGuard, runReplannerEpisode } from './replan.ts'
import type { ReplannerOutcome } from './replan.ts'
import {
  createPendingGraph,
  installPlanIntoGraph,
  pauseGraph,
  pausePlanningFailed,
  resumeGraph,
  retryAllNodes,
  retryNodes,
} from './tracker.ts'

/**
 * Structural slice of the Web server service, compatible with both the
 * published `dsh-host-webserver@0.0.1-rc.1` (`ctx.httpServer`) and the
 * renamed `webServer` in current builds: the beta transition renamed the
 * service without changing the route registration shape.
 */
interface WebRouteHost {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Web-server service key candidates, newest first. */
const WEB_SERVER_KEYS = ['webServer', 'httpServer'] as const

/** Scheduler configuration, validated by the loading composition (issue 07). */
export interface WorkGraphSchedulerConfig {
  /** Plan gate and history bounds; spec defaults apply when omitted. */
  readonly limits?: WorkGraphLimits
  /** Harness home workgraph dir for baselines (and later worktrees). */
  readonly workgraphDir: string
  /** Test seam: override the planner spawn; defaults to `ctx.subagents`. */
  readonly plannerSpawn?: PlannerSpawn
  /** Test seam: override the worker round transport; defaults to continuation. */
  readonly workerRound?: WorkerRound
  /** Test seam: override the verifier spawn; defaults to `ctx.subagents`. */
  readonly verifierSpawn?: WorkerSpawn
  /** Test seam: override the child-usage reader; defaults to `ctx.sessions`. */
  readonly readChildUsage?: ChildUsageReader
  /** Worker-verifier round cap per node; defaults to 3. */
  readonly nodeRounds?: number
  /** Parallel batch cap; defaults to 3. */
  readonly concurrency?: number
  /** Override the workspace-capability probe (defaults to the spawn provider). */
  readonly workspaceCapable?: boolean
  /** Test seam: the git runner; defaults to the production git seam. */
  readonly git?: GitSeam
  /** Test seam: override the replanner spawn; defaults to `ctx.subagents`. */
  readonly replannerSpawn?: PlannerSpawn
  /** Test seam: override the optimizer spawn; defaults to `ctx.subagents`. */
  readonly optimizerSpawn?: PlannerSpawn
  /** Replan passes cap; defaults to 3 (0 disables replanning). */
  readonly replanCap?: number
  /** Whether the topology optimizer may run at plan boundaries; default on. */
  readonly optimizer?: boolean
  /** Maximum planner nodes in one plan; default 24. */
  readonly maxNodes?: number
  /** Maximum retained history entries; default 64. */
  readonly historyMax?: number
  /** Maximum serialized plan artifact bytes; default 256 KiB. */
  readonly planBytesMax?: number
  /** Per-child settlement await budget in seconds; default 600. */
  readonly childAwaitBudget?: number
}

/**
 * The planner spawn over `ctx.subagents`: one structured-output spawn child
 * whose artifact is captured through the provider's own schema.
 * @param ctx - the dispatching context.
 * @param agent - the agent whose session owns the graph.
 * @returns the spawn seam.
 */
export function subagentPlannerSpawn(ctx: Context, agent: Agent): PlannerSpawn {
  return async ({ prompt, signal }) => {
    const request: SubagentStartRequest = {
      label: 'graph plan writer',
      prompt: [{ type: 'text', text: prompt }],
      parent: agent,
      signal,
      outputSchema: PLAN_OUTPUT_SCHEMA,
    }
    const run = await ctx.subagents.start('spawn', request)
    try {
      const result = await run.result
      return { structured: result.structured, stopReason: result.stopReason }
    } finally {
      await run.dispose()
    }
  }
}

import { resolveWorkGraphConfig, workGraphConfigSchema } from './config.ts'
import { applyOptimization, runOptimizerEpisode, type OptimizerOutcome } from './optimizer.ts'
import { acquireProjectLock, projectLockExists, readProject, removeProject, writeProject } from './project.ts'

/**
 * The verifier spawn over `ctx.subagents`: one structured-output spawn child
 * on the worker's workspace with the read-only deny-list tool filter, whose
 * verdict is captured through the verifier schema.
 * @param ctx - the dispatching context.
 * @param agent - the agent whose session owns the graph.
 * @returns the spawn seam.
 */
function subagentVerifierSpawn(ctx: Context, agent: Agent): WorkerSpawn {
  return async ({ prompt, signal, workspace }) => {
    const request: SubagentStartRequest = {
      label: 'graph node verifier',
      prompt: [{ type: 'text', text: prompt }],
      parent: agent,
      signal,
      outputSchema: VERIFIER_OUTPUT_SCHEMA,
      toolFilter: VERIFIER_TOOL_FILTER,
      ...(workspace === undefined ? {} : { workspace }),
    }
    const run = await ctx.subagents.start('spawn', request)
    try {
      const result = await run.result
      return { structured: result.structured, stopReason: result.stopReason, childSessionId: run.id }
    } finally {
      await run.dispose()
    }
  }
}

/**
 * The scheduler provider. Owns the session's durable graph: every transition
 * funnels through `commitWorkGraphChange`, the in-process latest snapshot
 * serves reads, and the session log fold covers a reloaded provider.
 */
export class WorkGraphScheduler extends WorkGraphEngine {
  static inject = ['subagents']

  /** Validated cordis config: defaults and clamps per the work-graph spec. */
  static Config = workGraphConfigSchema

  private readonly limits: WorkGraphLimits
  private readonly baselines: BaselineStore
  private readonly baselinesDir: string
  private readonly configPlannerSpawn: PlannerSpawn | undefined
  private readonly configWorkerRound: WorkerRound | undefined
  private readonly configVerifierSpawn: WorkerSpawn | undefined
  private readonly configReadUsage: ChildUsageReader | undefined
  private readonly nodeRounds: number
  private readonly concurrency: number
  private readonly workspaceCapable: boolean | undefined
  private readonly git: GitSeam
  private readonly configReplannerSpawn: PlannerSpawn | undefined
  private readonly configOptimizerSpawn: PlannerSpawn | undefined
  private readonly replanCap: number
  private readonly optimizer: boolean
  private readonly childAwaitBudget: number
  private readonly latest = new Map<string, WorkGraphSnapshot>()
  private episodeAbort: AbortController
  /** The in-flight drive's settlement; pause awaits it bounded by the budget. */
  private episodeSettled: Promise<void> = Promise.resolve()
  /** The episode chain's rejection, rethrown by {@link settled}. */
  private episodeError: unknown = undefined
  /** Held project locks per agent (the graph's lifetime); writes project the state. */
  private readonly projectLocks = new Map<string, { mainDir: string }>()
  /** Whether the panel state route is registered (lazy web-surface guard). */
  private webRegistered = false

  constructor(ctx: Context, config: WorkGraphSchedulerConfig) {
    super(ctx)
    const resolved = resolveWorkGraphConfig(config)
    // An explicit limits seam (tests) overrides the tunable defaults.
    this.limits = config.limits ?? resolved.limits
    this.baselines = createBaselineStore(config.workgraphDir)
    this.baselinesDir = config.workgraphDir
    this.configPlannerSpawn = config.plannerSpawn
    this.configWorkerRound = config.workerRound
    this.configVerifierSpawn = config.verifierSpawn
    this.configReadUsage = config.readChildUsage
    this.nodeRounds = resolved.nodeRounds
    this.concurrency = resolved.concurrency
    this.workspaceCapable = config.workspaceCapable
    this.git = config.git ?? createGitSeam()
    this.configReplannerSpawn = config.replannerSpawn
    this.configOptimizerSpawn = config.optimizerSpawn
    this.replanCap = resolved.replanCap
    this.optimizer = resolved.optimizer
    this.childAwaitBudget = resolved.childAwaitBudget
    this.episodeAbort = new AbortController()
    // The panel state route needs the Web server, which headless profiles do
    // not mount and which may bind after this service under concurrent
    // activation. Register lazily: try now, then on each service binding
    // event. In a webless profile the scheduler stays headless and never
    // blocks boot.
    this.registerWebSurface()
    this.ctx.on('internal/service', (name) => {
      if (WEB_SERVER_KEYS.includes(name as (typeof WEB_SERVER_KEYS)[number])) {
        this.registerWebSurface()
      }
    })
  }

  /**
   * Lazily register the activity-panel state route
   * (`GET /plugins/dsh-workgraph/state`, `cache-control: no-store`). The
   * handler enumerates the live agents and assembles one panel snapshot per
   * session that owns a graph; the panel filters by `sessionId` client-side.
   * A webless profile (no `webServer` service) skips registration silently —
   * the scheduler's core never depends on the web surface. Pattern ported
   * from dsh-agent-teams' lazy route binding (`src/index.ts`, MIT).
   */
  private registerWebSurface(): void {
    if (this.webRegistered) return
    const webServer = (this.ctx.get(WEB_SERVER_KEYS[0]) ?? this.ctx.get(WEB_SERVER_KEYS[1])) as WebRouteHost | undefined
    if (webServer === undefined) return
    this.webRegistered = true
    this.ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/plugins/dsh-workgraph/state',
      handler: (_req, res) => {
        const graphs: WorkGraphPanelSnapshot[] = []
        const agents = this.ctx.get('agents')
        if (agents !== undefined) {
          for (const agent of agents.list()) {
            // One bad session (e.g. a torn-down log mid-close) must not take
            // down the whole panel response: skip it and keep the healthy
            // graphs.
            try {
              const current = this.current(agent)
              if (current !== null) graphs.push(assemblePanelSnapshot(agent.id, current))
            } catch (error: unknown) {
              this.ctx.logger.warn(`workgraph: panel snapshot skipped for session ${agent.id}: ${String(error)}`)
            }
          }
        }
        const body = JSON.stringify({ graphs })
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(body)
      },
    }), 'workgraph: panel state route')
  }

  /** Whether the topology optimizer is enabled (consumed at plan boundaries). */
  optimizerEnabled(): boolean {
    return this.optimizer
  }

  /**
   * The plan-boundary optimizer pass: fires after initial planning and
   * piggybacked on every replan boundary, never mid-execution. Gates: the
   * optimizer toggle, an active graph, and a free slot of the SHARED replan
   * cap. A planned op list applies (version bump, slot consumed, new
   * baseline frozen); an empty list is a respected no-op; ANY failure
   * degrades with a warning — an enhancement pass never pauses a working
   * graph.
   */
  private async maybeOptimize(agent: Agent): Promise<void> {
    if (!this.optimizer) return
    const current = this.current(agent)
    if (current === null || current.status !== 'active') return
    if (this.replanCap === 0 || current.replanRuns >= this.replanCap) {
      this.ctx.logger.info(`workgraph: optimizer skipped (shared cap ${current.replanRuns}/${this.replanCap})`)
      return
    }
    const compact = JSON.stringify(current.nodes.map(node => ({
      id: node.id,
      title: node.title,
      spec: node.spec,
      status: node.state,
      deps: node.blocks,
    })))
    const history = current.history
      .slice(-12)
      .map(entry => `- ${entry.kind} ${entry.node ?? '-'} ${entry.detail ?? ''}`)
      .join('\n')
    const spawn = this.configOptimizerSpawn ?? subagentPlannerSpawn(this.ctx, agent)
    let outcome: OptimizerOutcome
    try {
      outcome = await runOptimizerEpisode({
        objective: current.objective,
        currentGraph: compact,
        history,
        limits: this.limits,
        signal: this.episodeAbort.signal,
        spawn,
      })
    } catch (error) {
      this.ctx.logger.warn(`workgraph: optimizer pass failed; keeping current plan: ${String(error)}`)
      return
    }
    if (outcome.kind !== 'planned') {
      this.ctx.logger.warn(`workgraph: optimizer ${outcome.kind}; keeping current plan: ${outcome.reason}`)
      return
    }
    let applied
    try {
      applied = applyOptimization(current, outcome.ops, this.limits, Date.now())
    } catch (error) {
      this.ctx.logger.warn(`workgraph: optimizer ops rejected; keeping current plan: ${String(error)}`)
      return
    }
    if (applied === null) return // respected no-op
    await this.commit(agent, { kind: 'workgraph/change', version: 1, graph: applied }, 'checkpoint', applied)
    try {
      // A new baseline freezes the optimized version; a collision degrades
      // (audit gap only) — the graph keeps running on the session log.
      await this.baselines.freeze(applied.id, applied.planVersion, applied.nodes)
    } catch (error) {
      this.ctx.logger.warn(`workgraph: optimizer baseline write failed (audit gap only): ${String(error)}`)
    }
  }

  /** Track one drive's settlement so pause can await child quiescence. */
  private trackEpisode(pending: Promise<WorkGraphSnapshot | null>): Promise<WorkGraphSnapshot | null> {
    this.episodeSettled = pending.then(
      () => { this.episodeError = undefined },
      (error: unknown) => { this.episodeError = error },
    )
    return pending
  }

  /**
   * Dispatch the planning+drive chain DETACHED: the scheduler owns the graph's
   * progress from here on, and the parent conversation spends no model turn
   * and no blocking await. Failures are contained — the graph pauses infra
   * with the reason instead of being left active with no driver — and the
   * chain's settlement is tracked for pause's bounded wait and {@link settled}
   * (which rethrows the chain's rejection).
   * @param agent - the owning agent.
   */
  private dispatch(agent: Agent): void {
    // The chain is deliberately detached; trackEpisode attaches the
    // settlement/rejection handlers that keep the promise from floating.
    void this.trackEpisode(this.runEpisode(agent))
  }

  /**
   * Run one episode chain to settlement: re-plan a pending graph, run the
   * plan-boundary optimizer, then drive the graph until it settles. A thrown
   * failure first pauses the graph as infra with the reason (never leaves an
   * active graph undriven) and is then RETHROWN so blocking callers still
   * see the loud signal; a graph cleared mid-episode stays cleared and the
   * drive's NOT_FOUND is what propagates.
   * @param agent - the owning agent.
   * @returns the settled snapshot, or `null` when the graph is gone.
   */
  private async runEpisode(agent: Agent): Promise<WorkGraphSnapshot | null> {
    try {
      const current = this.current(agent)
      /* v8 ignore next 3 -- dispatch() follows its own durable commit with no await boundary, so the live view is never null here */
      if (current === null) return null
      const snapshot = current.nodes.length === 0
        ? await this.planAndInstall(agent, current)
        : current
      // drive() owns the active-status gate: a failed planning episode
      // returns a paused snapshot and stops there.
      await this.maybeOptimize(agent)
      return await this.drive(agent, snapshot)
    } catch (error) {
      this.ctx.logger.error(`workgraph: episode failed: ${String(error)}`)
      const current = this.current(agent)
      if (current !== null && current.status === 'active') {
        try {
          const paused = pauseGraph(
            current,
            'infra',
            `episode failed: ${String(error)}`,
            this.limits,
            Date.now(),
          )
          await this.commit(agent, { kind: 'workgraph/change', version: 1, graph: paused }, 'checkpoint', paused)
        } catch (pauseError) {
          /* v8 ignore next 3 -- the pause commit rethrows only when the session log itself fails; the primary failure is already logged */
          this.ctx.logger.error(`workgraph: failed to pause after an episode failure: ${String(pauseError)}`)
        }
      }
      throw error
    }
  }

  /**
   * Await the current episode chain's settlement and return the latest
   * committed snapshot; the chain's rejection is rethrown (an episode that
   * failed has paused the graph infra with the reason). Throws
   * `WORKGRAPH_NOT_FOUND` when the graph was cleared mid-episode.
   * @param agent - the agent whose session owns the graph.
   * @returns the settled snapshot.
   */
  async settled(agent: Agent): Promise<WorkGraphSnapshot> {
    await this.episodeSettled
    if (this.episodeError !== undefined) {
      throw this.episodeError instanceof Error ? this.episodeError : new Error(String(this.episodeError))
    }
    const current = this.current(agent)
    if (current === null) {
      throw new WorkGraphError('graph cleared mid-episode', 'WORKGRAPH_NOT_FOUND')
    }
    return current
  }

  /** The planner spawn seam for one owning agent. */
  private plannerSpawnFor(agent: Agent): PlannerSpawn {
    return this.configPlannerSpawn ?? subagentPlannerSpawn(this.ctx, agent)
  }

  /** The worker round seam for one owning agent. */
  private workerRoundFor(agent: Agent): WorkerRound {
    return this.configWorkerRound ?? continuationWorkerRound(this.ctx, agent)
  }

  /** The verifier spawn seam for one owning agent. */
  private verifierSpawnFor(agent: Agent): WorkerSpawn {
    return this.configVerifierSpawn ?? subagentVerifierSpawn(this.ctx, agent)
  }

  /** The child-usage reader for one owning agent. */
  private usageReaderFor(): ChildUsageReader {
    return this.configReadUsage ?? sessionChildUsageReader(this.ctx)
  }

  /** The serial drive hooks bound to this provider and agent. */
  private driveHooks(agent: Agent): SerialDriverHooks {
    return {
      commit: async (snapshot) => {
        await await this.commit(agent, { kind: 'workgraph/change', version: 1, graph: snapshot }, 'checkpoint', snapshot)
      },
      current: () => {
        const live = this.current(agent)
        if (live === null) throw new WorkGraphError('graph cleared mid-episode', 'WORKGRAPH_NOT_FOUND')
        return live
      },
      aborted: () => this.episodeAbort.signal.aborted,
      signal: () => this.episodeAbort.signal,
      limits: this.limits,
      workerRound: this.workerRoundFor(agent),
      verifierSpawn: this.verifierSpawnFor(agent),
      nodeRounds: this.nodeRounds,
      readUsage: this.usageReaderFor(),
      now: () => Date.now(),
    }
  }

  /**
   * Drive the graph serially while it is active: after planning (set/resume
   * re-plan) and after a retry reset, the serial episode runs ready nodes in
   * dependency order until the graph settles or the user pauses.
   */
  /**
   * The replan pass: at an episode boundary, fold pending discoveries into
   * the graph through a replanner child (one feedback retry), then install
   * append-only, re-gate gn-final, bump the plan version, and freeze the new
   * baseline. Pre-gates: no entries, zero remaining budget, final achieved,
   * cap zero, or cap exhausted drain to history instead — the graph always
   * converges and a working graph never pauses because an enhancement pass
   * failed.
   * @param agent - the owning agent.
   */
  private async maybeReplan(agent: Agent): Promise<void> {
    const current = this.current(agent)
    /* v8 ignore next -- reachable only when an external clear lands between the drive's commits; the hook runs on committed views */
    if (current === null) return
    if (current.pendingDiscoveries.length === 0) return
    const drain = async (): Promise<void> => {
      const drained = drainDiscoveries(current, this.limits, Date.now())
      await this.commit(agent, { kind: 'workgraph/change', version: 1, graph: drained }, 'checkpoint', drained)
    }
    const remaining = current.tokenBudget === undefined ? undefined : current.tokenBudget - current.tokensSpent
    if (remaining === 0) return // entries stay queued; resume --budget re-enters
    const finalNode = current.nodes.find(node => node.id === 'gn-final')
    if (finalNode !== undefined && finalNode.state === 'achieved') {
      await drain()
      return
    }
    if (this.replanCap === 0 || current.replanRuns >= this.replanCap) {
      await drain()
      return
    }
    const compact = JSON.stringify(current.nodes.map(node => ({
      id: node.id,
      title: node.title,
      status: node.state,
      deps: node.blocks,
    })))
    const discoveries = current.pendingDiscoveries
      .map(entry => `- (from ${entry.from}) ${entry.description}`)
      .join('\n')
    const spawn = this.configReplannerSpawn ?? subagentPlannerSpawn(this.ctx, agent)
    const attempt = async (feedback: string) => runReplannerEpisode({
      objective: current.objective,
      currentGraph: compact,
      discoveries,
      feedback,
      limits: this.limits,
      signal: this.episodeAbort.signal,
      spawn,
    })
    const guard = (outcome: ReplannerOutcome): ReplannerOutcome => {
      if (outcome.kind !== 'planned') return outcome
      try {
        replanDependencyGuard(outcome.nodes, current.nodes)
        return outcome
      } catch (error) {
        /* v8 ignore next 2 -- the guard only throws WorkGraphError today; a non-domain failure must not be mistaken for a plan rejection */
        if (error instanceof WorkGraphError) return { kind: 'invalid', reason: error.message }
        else throw error
      }
    }
    let outcome = guard(await attempt(''))
    if (outcome.kind === 'invalid') outcome = guard(await attempt(outcome.reason))
    if (outcome.kind === 'invalid' || outcome.kind === 'fail-closed') {
      // Degrade: entries drain to history, the slot is consumed, and the
      // graph keeps running.
      const drained = drainDiscoveries(current, this.limits, Date.now())
      const consumed = { ...drained, replanRuns: current.replanRuns + 1 }
      await this.commit(agent, { kind: 'workgraph/change', version: 1, graph: consumed }, 'checkpoint', consumed)
      return
    }
    const installed = installReplan(current, outcome.nodes, this.limits, Date.now())
    const withRuns = { ...installed, replanRuns: current.replanRuns + 1 }
    await this.commit(agent, { kind: 'workgraph/change', version: 1, graph: withRuns }, 'checkpoint', withRuns)
    try {
      await this.baselines.freeze(withRuns.id, withRuns.planVersion, withRuns.nodes)
    } catch (error) {
      if (error instanceof WorkGraphError) {
        // A baseline failure pauses infra; resume re-enters the pass.
        const { pauseGraph } = await import('./tracker.ts')
        const paused = pauseGraph(withRuns, 'infra', `failed to freeze the replan baseline: ${error.message}`, this.limits, Date.now())
        await this.commit(agent, { kind: 'workgraph/change', version: 1, graph: paused }, 'checkpoint', paused)
      } else {
        throw error
      }
    }
  }

  /** Whether the spawn provider can isolate a child in a chosen workspace. */
  private workspaceCapableFor(): boolean {
    if (this.workspaceCapable !== undefined) return this.workspaceCapable
    const provider = this.ctx.subagents.getProvider('spawn')
    return provider !== undefined && provider.capabilities.workspace === true
  }

  private async drive(agent: Agent, snapshot: WorkGraphSnapshot): Promise<WorkGraphSnapshot> {
    if (snapshot.status !== 'active') return snapshot
    const base = this.driveHooks(agent)
    const mainDir = agent.session.header.cwd
    const replanHook = async (): Promise<void> => {
      // The optimizer piggybacks on every replan boundary (jxca semantics):
      // it fires after each settled node, gated on the toggle, the shared
      // cap, and the active status — never mid-execution.
      await this.maybeReplan(agent)
      await this.maybeOptimize(agent)
    }
    if (mainDir !== undefined) {
      const parallel: ParallelDriverHooks = {
        ...base,
        agent,
        workspaceCapable: this.workspaceCapableFor(),
        concurrency: this.concurrency,
        workgraphDir: this.baselinesDir,
        mainDir,
        git: this.git,
        replan: replanHook,
      }
      await driveParallel(snapshot, parallel)
    } else {
      await driveSerial(snapshot, { ...base, replan: replanHook })
    }
    // Advisory discoveries landing with the final node drain after the loop:
    // appending them now would ship work the terminal gate never re-verified.
    await replanHook()
    // The drive's local chain can diverge from the committed state when a
    // pause/clear landed mid-episode; the provider's latest view is
    // authoritative.
    /* v8 ignore next -- every drive path commits before returning, so the live view is never null here */
    return this.current(agent) ?? snapshot
  }

  /** The agent's current graph: latest committed view, else the log fold. */
  current(agent: Agent): WorkGraphSnapshot | null {
    const latest = this.latest.get(agent.id)
    if (latest !== undefined) return latest
    return foldWorkGraph(agent.session.events).graph ?? null
  }

  /** Commit one durable change, refresh the live view, and project the file. */
  private async commit(
    agent: Agent,
    change: Parameters<typeof commitWorkGraphChange>[2],
    operation: Parameters<typeof commitWorkGraphChange>[3],
    snapshot?: WorkGraphSnapshot,
  ): Promise<void> {
    if (snapshot !== undefined) {
      this.latest.set(agent.id, snapshot)
    } else {
      // A change without a snapshot is a clear tombstone: drop the live view.
      this.latest.delete(agent.id)
    }
    commitWorkGraphChange(this.ctx, agent, change, operation)
    // The repository projection follows every checkpoint while the lock is
    // held; a write failure degrades with a warning (the session log is the
    // source of truth, never the file).
    const lock = this.projectLocks.get(agent.id)
    if (lock !== undefined && snapshot !== undefined) {
      try {
        await writeProject(lock.mainDir, snapshot)
      } catch (error) {
        this.ctx.logger.warn(`workgraph: projection write failed: ${String(error)}`)
      }
    }
  }

  /** Require a current graph and return it. */
  private requireGraph(agent: Agent): WorkGraphSnapshot {
    const current = this.current(agent)
    if (current === null) {
      throw new WorkGraphError('no work graph is set', 'WORKGRAPH_NOT_FOUND')
    }
    return current
  }

  /**
   * Run the planning episode with exactly one feedback retry and resolve the
   * outcome into the graph: `planned` installs nodes and freezes the version
   * baseline; `invalid` retries once; a second rejection or a fail-closed
   * child pauses the graph infra.
   * @param agent - the owning agent.
   * @param snapshot - the active pending snapshot.
   * @returns the resulting snapshot.
   */
  private async planAndInstall(agent: Agent, snapshot: WorkGraphSnapshot): Promise<WorkGraphSnapshot> {
    const objective = snapshot.objective
    const spawn = this.plannerSpawnFor(agent)
    const signal = this.episodeAbort.signal
    let outcome = await runPlannerEpisode({ objective, feedback: '', limits: this.limits, signal, spawn })
    if (outcome.kind === 'invalid') {
      outcome = await runPlannerEpisode({ objective, feedback: outcome.reason, limits: this.limits, signal, spawn })
    }
    // A pause/clear that landed during planning abandons the plan: the
    // paused (or cleared) state stands as-is and a cleared graph never
    // resurrects through a late install commit.
    if (this.episodeAbort.signal.aborted) return snapshot
    const now = Date.now()
    if (outcome.kind === 'invalid') {
      const paused = pausePlanningFailed(
        snapshot,
        `plan rejected twice: ${outcome.reason}`,
        this.limits,
        now,
      )
      await this.commit(agent, { kind: 'workgraph/change', version: 1, graph: paused }, 'checkpoint', paused)
      return paused
    }
    if (outcome.kind === 'fail-closed') {
      const paused = pausePlanningFailed(
        snapshot,
        `graph planning failed: ${outcome.reason}`,
        this.limits,
        now,
      )
      await this.commit(agent, { kind: 'workgraph/change', version: 1, graph: paused }, 'checkpoint', paused)
      return paused
    }
    const installed = installPlanIntoGraph(snapshot, outcome.nodes, this.limits, now)
    await this.commit(agent, { kind: 'workgraph/change', version: 1, graph: installed }, 'checkpoint', installed)
    // Freeze the immutable v1 baseline BEFORE any node executes; failing to
    // write the audit baseline is an infra failure, not ignorable.
    try {
      await this.baselines.freeze(installed.id, installed.planVersion, installed.nodes)
    } catch (error) {
      if (error instanceof WorkGraphError) {
        const paused = pauseGraph(
          installed,
          'infra',
          `failed to freeze the plan baseline: ${error.message}`,
          this.limits,
          Date.now(),
        )
        await this.commit(agent, { kind: 'workgraph/change', version: 1, graph: paused }, 'checkpoint', paused)
        return paused
      }
      throw error
    }
    return installed
  }

  /**
   * Plan and start a work graph, then drive it to settlement — the blocking
   * form of {@link dispatchSet}, kept for programmatic callers and tests.
   * @param agent - the agent whose session owns the graph.
   * @param request - the objective and an optional positive token budget.
   * @returns the settled snapshot.
   */
  async set(agent: Agent, request: SetWorkGraphRequest): Promise<WorkGraphSnapshot> {
    await this.dispatchSet(agent, request)
    return this.settled(agent)
  }

  /**
   * Validate, create, and commit a pending work graph, then run planning and
   * the drive DETACHED in the background. Returns as soon as the pending
   * graph is durable, so `/graph set` never blocks the command channel for
   * the graph's whole lifetime; planning failure pauses the graph infra in
   * the background (visible via status) and resume re-plans.
   * @param agent - the agent whose session owns the graph.
   * @param request - the objective and an optional positive token budget.
   * @returns the durable pending snapshot.
   */
  async dispatchSet(agent: Agent, request: SetWorkGraphRequest): Promise<WorkGraphSnapshot> {
    const objective = request.objective.trim()
    if (objective.length === 0) {
      throw new WorkGraphError('objective must be non-empty', 'WORKGRAPH_INVALID_OBJECTIVE')
    }
    if (request.tokenBudget !== undefined
      && (!Number.isSafeInteger(request.tokenBudget) || request.tokenBudget <= 0)) {
      throw new WorkGraphError('token budget must be a positive integer', 'WORKGRAPH_INVALID_BUDGET')
    }
    if (request.tokenBudget !== undefined && parentRecordsUsage(agent) === false) {
      // Positive evidence that this composition's children record no provider
      // usage: fail loud at set instead of silently mis-budgeting.
      throw new WorkGraphError(
        'token budget configured but the composition records no provider usage',
        'WORKGRAPH_INVALID_BUDGET',
      )
    }
    const existing = this.current(agent)
    if (existing !== null && existing.status !== 'complete') {
      throw new WorkGraphError(
        'a work graph is already set; clear it or resume it first',
        'WORKGRAPH_ALREADY_EXISTS',
      )
    }
    this.episodeAbort = new AbortController()
    const snapshot = createPendingGraph(
      WorkGraphId(randomUUID()),
      objective,
      this.limits,
      Date.now(),
      request.tokenBudget,
    )
    // Claim the repository lock BEFORE anything commits: a refused second
    // holder must leave no trace in the session log.
    const mainDir = agent.session.header.cwd
    if (mainDir !== undefined) {
      const lock = await acquireProjectLock(mainDir, snapshot.id)
      if (lock === null) {
        throw new WorkGraphError(
          'the repository graph projection is locked by another session',
          'WORKGRAPH_LOCKED',
        )
      }
      this.projectLocks.set(agent.id, { mainDir })
    }
    await this.commit(agent, { kind: 'workgraph/change', version: 1, graph: snapshot }, 'set', snapshot)
    if (mainDir !== undefined) {
      // The initial projection write degrades like every checkpoint write:
      // the session log is the source of truth, never the file.
      try {
        await writeProject(mainDir, snapshot)
      } catch (error) {
        this.ctx.logger.warn(`workgraph: projection write failed: ${String(error)}`)
      }
    }
    this.dispatch(agent)
    return snapshot
  }

  async status(agent: Agent): Promise<WorkGraphSnapshot | null> {
    const current = this.current(agent)
    if (current !== null) return current
    // A fresh session revives the repository projection, sanitized and
    // demoted to paused; a malformed projection is a loud error.
    const mainDir = agent.session.header.cwd
    if (mainDir === undefined) return null
    try {
      return await readProject(mainDir)
    } catch (error) {
      if (error instanceof WorkGraphError && error.code === 'WORKGRAPH_NOT_FOUND') return null
      throw error
    }
  }

  /**
   * Pause the graph as user-paused and cancel the live episode (bounded child
   * settlement lands with the execution issues).
   * @param agent - the agent whose session owns the graph.
   * @param reason - human-readable pause cause.
   * @returns the paused snapshot.
   */
  async pause(agent: Agent, reason?: string): Promise<WorkGraphSnapshot> {
    const current = this.requireGraph(agent)
    this.episodeAbort.abort('paused')
    const snapshot = pauseGraph(current, 'user', reason ?? 'Paused by the user.', this.limits, Date.now())
    await this.commit(agent, { kind: 'workgraph/change', version: 1, graph: snapshot }, 'pause', snapshot)
    // Bounded child settlement: await the in-flight episode's quiescence up
    // to the per-child await budget, then hand back the latest committed
    // view (the drive demotes the in-flight node once its child settles).
    await Promise.race([
      this.episodeSettled,
      new Promise<void>(resolve => setTimeout(resolve, this.childAwaitBudget * 1000)),
    ])
    return this.current(agent) ?? snapshot
  }

  /**
   * Resume a paused or blocked graph to active and drive it to settlement —
   * the blocking form of {@link dispatchResume}.
   * @param agent - the agent whose session owns the graph.
   * @param request - optional resume directives.
   * @returns the settled snapshot.
   */
  async resume(agent: Agent, request?: ResumeWorkGraphRequest): Promise<WorkGraphSnapshot> {
    await this.dispatchResume(agent, request)
    return this.settled(agent)
  }

  /**
   * Resume a paused, blocked, or budget-limited graph to active and re-drive
   * it DETACHED in the background; a pending graph (planning previously
   * failed) re-plans there. Returns the durable resumed snapshot immediately;
   * validation refusals still throw.
   * @param agent - the agent whose session owns the graph.
   * @param request - optional resume directives.
   * @returns the durable resumed snapshot.
   */
  async dispatchResume(agent: Agent, request?: ResumeWorkGraphRequest): Promise<WorkGraphSnapshot> {
    // A second session may read the projection but never resume it: the
    // exclusive lock belongs to the session that created or resumed it.
    // The refusal precedes requireGraph so a revived graph is refused by
    // the lock, not by NOT_FOUND.
    const mainDir = agent.session.header.cwd
    if (mainDir !== undefined && !this.projectLocks.has(agent.id)
      && await projectLockExists(mainDir)) {
      throw new WorkGraphError(
        'the repository graph projection is locked by another session',
        'WORKGRAPH_LOCKED',
      )
    }
    const current = this.requireGraph(agent)
    if (request?.budget !== undefined
      && (!Number.isSafeInteger(request.budget) || request.budget <= 0)) {
      throw new WorkGraphError('budget top-up must be a positive integer', 'WORKGRAPH_INVALID_BUDGET')
    }
    if (current.status === 'budget_limited' && request?.budget === undefined) {
      throw new WorkGraphError(
        'budget exhausted; top up with resume --budget <tokens>',
        'WORKGRAPH_INVALID_BUDGET',
      )
    }
    this.episodeAbort = new AbortController()
    const snapshot = resumeGraph(current, request?.budget, this.limits, Date.now())
    await this.commit(agent, { kind: 'workgraph/change', version: 1, graph: snapshot }, 'resume', snapshot)
    this.dispatch(agent)
    return snapshot
  }

  /**
   * Reset one terminal node plus its transitively blocked chain and drive the
   * graph to settlement — the blocking form of {@link dispatchRetry}.
   * @param agent - the agent whose session owns the graph.
   * @param node - the failed or blocked node to retry.
   * @returns the settled snapshot.
   */
  async retry(agent: Agent, node: WorkNodeId): Promise<WorkGraphSnapshot> {
    await this.dispatchRetry(agent, node)
    return this.settled(agent)
  }

  /**
   * Reset one terminal node plus its transitively blocked chain and re-drive
   * the graph DETACHED in the background. Returns the durable reset snapshot
   * immediately.
   * @param agent - the agent whose session owns the graph.
   * @param node - the failed or blocked node to retry.
   * @returns the durable snapshot after the reset batch.
   */
  async dispatchRetry(agent: Agent, node: WorkNodeId): Promise<WorkGraphSnapshot> {
    const current = this.requireGraph(agent)
    this.episodeAbort = new AbortController()
    const snapshot = retryNodes(current, node, this.limits, Date.now())
    await this.commit(agent, { kind: 'workgraph/change', version: 1, graph: snapshot }, 'retry', snapshot)
    this.dispatch(agent)
    return snapshot
  }

  /**
   * Reset every failed node plus its blocked chains as ONE batch and drive to
   * settlement — the blocking form of {@link dispatchRetryAll}.
   * @param agent - the agent whose session owns the graph.
   * @returns the settled snapshot.
   */
  async retryAll(agent: Agent): Promise<WorkGraphSnapshot> {
    await this.dispatchRetryAll(agent)
    return this.settled(agent)
  }

  /**
   * Reset every failed node plus its blocked chains as ONE batch and re-drive
   * the graph DETACHED in the background. Returns the durable reset snapshot
   * immediately.
   * @param agent - the agent whose session owns the graph.
   * @returns the durable snapshot after the union reset batch.
   */
  async dispatchRetryAll(agent: Agent): Promise<WorkGraphSnapshot> {
    const current = this.requireGraph(agent)
    this.episodeAbort = new AbortController()
    const snapshot = retryAllNodes(current, this.limits, Date.now())
    await this.commit(agent, { kind: 'workgraph/change', version: 1, graph: snapshot }, 'retry', snapshot)
    this.dispatch(agent)
    return snapshot
  }

  /**
   * Clear the graph and its durable tombstone; a cleared graph cannot
   * resurrect. The project projection removal lands with issue 09.
   * @param agent - the agent whose session owns the graph.
   */
  async clear(agent: Agent): Promise<void> {
    const current = this.requireGraph(agent)
    this.episodeAbort.abort('cleared')
    await await this.commit(
      agent,
      {
        kind: 'workgraph/change',
        version: 1,
        operation: 'clear',
        cleared: current.id,
        clearedAt: Date.now(),
      },
      'clear',
    )
    const lock = this.projectLocks.get(agent.id)
    if (lock !== undefined) {
      await removeProject(lock.mainDir)
      this.projectLocks.delete(agent.id)
    }
  }
}

/**
 * Whether the parent session's log has positive evidence of provider usage
 * recording: `true` when a recorded `assistant/message` carries usage,
 * `false` when messages exist but none carry usage, `undefined` when there
 * is no evidence either way (verified at the first child settlement instead).
 */
function parentRecordsUsage(agent: Agent): boolean | undefined {
  let sawMessage = false
  for (const event of agent.session.events) {
    if (event.type !== 'assistant/message') continue
    sawMessage = true
    if (event.data.usage !== undefined) return true
  }
  return sawMessage ? false : undefined
}
