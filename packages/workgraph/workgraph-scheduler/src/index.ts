/**
 * Deterministic scheduler for the work graph: canonical node identity, the
 * plan static gate, the pure snapshot state machine, planning baselines, the
 * planning episode, and the Cordis provider that owns the session's graph.
 * @module @deepseek-ai/dsh-workgraph-scheduler
 */

export { canonicalNodeId, FINAL_NODE_ID, fnv1a32 } from './ids.ts'
export type { ParsedPlanNode } from './gate.ts'
export {
  buildFinalNode,
  finalNodeSpec,
  FINAL_NODE_TITLE,
  installPlan,
  parsePlanArtifact,
} from './gate.ts'
export {
  appendHistory,
  BUDGET_PAUSE_REASON,
  budgetLimit,
  createPendingGraph,
  demoteRunningToReady,
  initializeGraph,
  installPlanIntoGraph,
  markRunning,
  pauseGraph,
  pausePlanningFailed,
  queueDiscoveries,
  RESTORE_PAUSE_REASON,
  restoreSnapshot,
  resumeGraph,
  retryAllNodes,
  retryNodes,
  settleAchieved,
  settleFailed,
  settleMergeFailed,
  WEDGE_PAUSE_REASON,
} from './tracker.ts'
export { renderPlannerPrompt, renderVerifierPrompt, renderWorkerPrompt } from './prompts.ts'
export {
  PLAN_OUTPUT_SCHEMA,
  runPlannerEpisode,
} from './planner.ts'
export type {
  PlannerEpisodeOutcome,
  PlannerEpisodeRequest,
  PlannerSpawn,
  PlannerSpawnRequest,
  PlannerSpawnResult,
} from './planner.ts'
export { createBaselineStore } from './baselines.ts'
export { OPTIMIZER_OUTPUT_SCHEMA, applyOptimization, parseOptimizerOps, runOptimizerEpisode } from './optimizer.ts'
export type { OptimizerOp, OptimizerOutcome } from './optimizer.ts'
export type { BaselineStore } from './baselines.ts'
export {
  WORKER_OUTPUT_SCHEMA,
  parseWorkerReport,
  runWorkerEpisode,
} from './worker.ts'
export type {
  WorkerEpisodeOutcome,
  WorkerEpisodeRequest,
  WorkerSpawn,
  WorkerSpawnRequest,
  WorkerSpawnResult,
} from './worker.ts'
export { chargeTokenUsage, readSessionUsage, sessionChildUsageReader } from './usage.ts'
export type { ChildUsage, ChildUsageReader } from './usage.ts'
export {
  awaitChildEpoch,
  continuationWorkerRound,
  parseReportEnvelope,
  REPORT_PREFIX,
  WORKER_DENY_LIST,
  WORKER_TOOL_FILTER,
} from './continuation.ts'
export type { WorkerRound, WorkerRoundRequest, WorkerRoundResult } from './continuation.ts'
export {
  runVerifierEpisode,
  parseVerifierReport,
  VERIFIER_DENY_LIST,
  VERIFIER_OUTPUT_SCHEMA,
  VERIFIER_TOOL_FILTER,
} from './verifier.ts'
export type { VerifierEpisodeRequest, VerifierOutcome } from './verifier.ts'
export { driveSerial, remainingBudget, runSerialNode } from './serial.ts'
export type { SerialDriverHooks } from './serial.ts'
export { driveParallel } from './parallel.ts'
export { drainDiscoveries, installReplan, replanDependencyGuard, runReplannerEpisode } from './replan.ts'
export type { ReplannerOutcome } from './replan.ts'
export type { ParallelDriverHooks } from './parallel.ts'
export {
  captureHead,
  changedFiles,
  createGitSeam,
  isGitRepo,
  mergeFileBytes,
  mergeWorktree,
  mintWorktree,
  removeWorktree,
  readBlob,
  worktreePath,
} from './worktrees.ts'
export type { FileMerge, GitSeam } from './worktrees.ts'
export { subagentPlannerSpawn, WorkGraphScheduler } from './scheduler.ts'
export type { WorkGraphSchedulerConfig } from './scheduler.ts'
// The cordis plugin entry: the loader unwraps the default export before
// applying the plugin (class plugins follow this convention).
export { WorkGraphScheduler as default } from './scheduler.ts'
