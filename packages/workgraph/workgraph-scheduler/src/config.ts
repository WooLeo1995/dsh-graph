/**
 * Validated scheduler tunables (issue 07): spec defaults, load-time clamps,
 * and the cordis `Config` schema so deployments tune the graph from
 * cordis.yml instead of code. The schema is the load boundary — an
 * out-of-range value fails plugin load loudly; direct construction goes
 * through the same resolver with the same defaults and sanity checks.
 * @module @deepseek-ai/dsh-workgraph-scheduler/config
 */

import z from '@deepseek-ai/schemastery'
import type { WorkGraphLimits } from '@deepseek-ai/dsh-workgraph'

/** Default parallel batch cap. */
export const DEFAULT_CONCURRENCY = 3
/** Default worker-verifier round cap per node. */
export const DEFAULT_NODE_ROUNDS = 3
/** Default replan passes cap. */
export const DEFAULT_REPLAN_CAP = 3
/** Default optimizer toggle (consumed by issue 09 at plan boundaries). */
export const DEFAULT_OPTIMIZER = true
/** Default maximum planner nodes in one plan. */
export const DEFAULT_MAX_NODES = 24
/** Default maximum retained history entries. */
export const DEFAULT_HISTORY_MAX = 64
/** Default maximum serialized plan artifact bytes (256 KiB). */
export const DEFAULT_PLAN_BYTES_MAX = 256 * 1024
/** Default per-child settlement await budget in seconds. */
export const DEFAULT_CHILD_AWAIT_BUDGET = 600

/** Clamps documented by the work-graph spec (issue 07). */
export const CONCURRENCY_CLAMP = { min: 1, max: 8 } as const
export const NODE_ROUNDS_CLAMP = { min: 1, max: 8 } as const
export const REPLAN_CAP_CLAMP = { min: 0, max: 10 } as const
export const CHILD_AWAIT_BUDGET_CLAMP = { min: 1, max: 3600 } as const

/** Validated scheduler tunables; every field resolved with its default. */
export interface WorkGraphConfig {
  /** Parallel batch cap; clamp 1–8, default 3. */
  readonly concurrency: number
  /** Worker-verifier round cap per node; clamp 1–8, default 3. */
  readonly nodeRounds: number
  /** Replan passes cap; clamp 0–10, default 3 (0 disables replanning). */
  readonly replanCap: number
  /** Whether the topology optimizer may run at plan boundaries; default on. */
  readonly optimizer: boolean
  /** Maximum planner nodes in one plan; default 24. */
  readonly maxNodes: number
  /** Maximum retained history entries; default 64. */
  readonly historyMax: number
  /** Maximum serialized plan artifact bytes; default 256 KiB. */
  readonly planBytesMax: number
  /** Per-child settlement await budget in seconds; clamp 1–3600, default 600. */
  readonly childAwaitBudget: number
}

/** The cordis `Config` schema: defaults applied, clamps enforced at load. */
export const workGraphConfigSchema: z<WorkGraphConfig> = z.object({
  concurrency: z.number().step(1).min(CONCURRENCY_CLAMP.min).max(CONCURRENCY_CLAMP.max)
    .default(DEFAULT_CONCURRENCY),
  nodeRounds: z.number().step(1).min(NODE_ROUNDS_CLAMP.min).max(NODE_ROUNDS_CLAMP.max)
    .default(DEFAULT_NODE_ROUNDS),
  replanCap: z.number().step(1).min(REPLAN_CAP_CLAMP.min).max(REPLAN_CAP_CLAMP.max)
    .default(DEFAULT_REPLAN_CAP),
  optimizer: z.boolean().default(DEFAULT_OPTIMIZER),
  maxNodes: z.number().step(1).min(1).default(DEFAULT_MAX_NODES),
  historyMax: z.number().step(1).min(1).default(DEFAULT_HISTORY_MAX),
  planBytesMax: z.number().step(1).min(1).default(DEFAULT_PLAN_BYTES_MAX),
  childAwaitBudget: z.number().step(1).min(CHILD_AWAIT_BUDGET_CLAMP.min)
    .max(CHILD_AWAIT_BUDGET_CLAMP.max).default(DEFAULT_CHILD_AWAIT_BUDGET),
})

/** The resolved tunables plus the tracker limits they feed. */
export interface ResolvedWorkGraphConfig extends WorkGraphConfig {
  readonly limits: WorkGraphLimits
}

/** Fail loudly on a tunable outside its documented clamp. */
function clampCheck(name: string, value: number, clamp: { min: number; max: number }): void {
  if (!Number.isFinite(value) || value < clamp.min || value > clamp.max) {
    throw new TypeError(
      `workgraph.${name} must be within ${clamp.min}–${clamp.max}, got ${value}`,
    )
  }
}

/**
 * Resolve partial tunables to the full validated config. The cordis schema
 * enforces the clamps at plugin load; direct construction goes through here,
 * which fails loudly on out-of-range values instead of clamping silently.
 * @param tunables - the partial configuration.
 * @returns the resolved config and the tracker limits it feeds.
 */
export function resolveWorkGraphConfig(tunables: Partial<WorkGraphConfig>): ResolvedWorkGraphConfig {
  const concurrency = tunables.concurrency ?? DEFAULT_CONCURRENCY
  const nodeRounds = tunables.nodeRounds ?? DEFAULT_NODE_ROUNDS
  const replanCap = tunables.replanCap ?? DEFAULT_REPLAN_CAP
  const optimizer = tunables.optimizer ?? DEFAULT_OPTIMIZER
  const maxNodes = tunables.maxNodes ?? DEFAULT_MAX_NODES
  const historyMax = tunables.historyMax ?? DEFAULT_HISTORY_MAX
  const planBytesMax = tunables.planBytesMax ?? DEFAULT_PLAN_BYTES_MAX
  const childAwaitBudget = tunables.childAwaitBudget ?? DEFAULT_CHILD_AWAIT_BUDGET
  clampCheck('concurrency', concurrency, CONCURRENCY_CLAMP)
  clampCheck('nodeRounds', nodeRounds, NODE_ROUNDS_CLAMP)
  clampCheck('replanCap', replanCap, REPLAN_CAP_CLAMP)
  if (!Number.isInteger(maxNodes) || maxNodes < 1) {
    throw new TypeError(`workgraph.maxNodes must be a positive integer, got ${maxNodes}`)
  }
  if (!Number.isInteger(historyMax) || historyMax < 1) {
    throw new TypeError(`workgraph.historyMax must be a positive integer, got ${historyMax}`)
  }
  if (!Number.isInteger(planBytesMax) || planBytesMax < 1) {
    throw new TypeError(`workgraph.planBytesMax must be a positive integer, got ${planBytesMax}`)
  }
  if (!Number.isFinite(childAwaitBudget) || childAwaitBudget <= 0) {
    throw new TypeError(`workgraph.childAwaitBudget must be positive seconds, got ${childAwaitBudget}`)
  }
  return {
    concurrency,
    nodeRounds,
    replanCap,
    optimizer,
    maxNodes,
    historyMax,
    planBytesMax,
    childAwaitBudget,
    limits: {
      maxNodes,
      historyMax,
      planBytesMax,
    },
  }
}
