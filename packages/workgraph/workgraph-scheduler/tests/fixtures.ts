/**
 * Shared scripted fixtures for the workgraph scheduler tests: plan artifacts,
 * round results, verdicts, and usage charges.
 * @module
 */

import { canonicalNodeId } from '@deepseek-ai/dsh-workgraph-scheduler'
import type { PlannerSpawnResult, WorkerRoundResult, WorkerSpawnResult, ChildUsage } from '@deepseek-ai/dsh-workgraph-scheduler'

/** A two-node plan (a → b) plus the harness final node. */
export const VALID_PLAN = {
  nodes: [
    { id: 'a', title: 'A', spec: 'do a', deps: [] },
    { id: 'b', title: 'B', spec: 'do b', deps: ['a'] },
  ],
}

/** The planner spawn result for the valid plan. */
export const VALID_ARTIFACT: PlannerSpawnResult = {
  structured: VALID_PLAN,
  stopReason: 'completed',
}

/** A done worker round on the durable child. */
export const ROUND_DONE: WorkerRoundResult = {
  outcome: { kind: 'done', summary: 'done as specified', discovered: [] },
  childSessionId: 'child-1',
}

/** An achieved verifier verdict. */
export const VERDICT_ACHIEVED: WorkerSpawnResult = {
  structured: { verdict: 'achieved', gaps: [], discovered: [] },
  stopReason: 'completed',
}

/** Recorded usage of 5 tokens. */
export const RECORDED_USAGE: ChildUsage = { tokens: 5, recorded: true }

/** The canonical node ids of the shared plan. */
export const ID_A = canonicalNodeId('a')
export const ID_B = canonicalNodeId('b')
