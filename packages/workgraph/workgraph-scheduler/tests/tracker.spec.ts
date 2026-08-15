import { describe, expect, it } from 'vitest'
import {
  appendHistory,
  BUDGET_PAUSE_REASON,
  budgetLimit,
  canonicalNodeId,
  createPendingGraph,
  demoteRunningToReady,
  FINAL_NODE_ID,
  initializeGraph,
  installPlanIntoGraph,
  markRunning,
  pauseGraph,
  pausePlanningFailed,
  queueDiscoveries,
  settleMergeFailed,
  RESTORE_PAUSE_REASON,
  restoreSnapshot,
  resumeGraph,
  retryAllNodes,
  retryNodes,
  settleAchieved,
  settleFailed,
  WEDGE_PAUSE_REASON,
} from '@deepseek-ai/dsh-workgraph-scheduler'
import { installPlan } from '@deepseek-ai/dsh-workgraph-scheduler'
import type {
  WorkGraphHistoryEntry,
  WorkGraphLimits,
  WorkGraphSnapshot,
  WorkNode,
} from '@deepseek-ai/dsh-workgraph'
import { WorkGraphError, WorkGraphId, WorkNodeId } from '@deepseek-ai/dsh-workgraph'

const LIMITS: WorkGraphLimits = { maxNodes: 24, historyMax: 64 }
const ID_A = canonicalNodeId('a')
const ID_B = canonicalNodeId('b')
const ID_C = canonicalNodeId('c')

/** Install the diamond a → c, b → c, plus the gated final node. */
function diamond(): WorkGraphSnapshot {
  const nodes = installPlan(
    {
      nodes: [
        { id: 'a', title: 'A', spec: 'do a', deps: [] },
        { id: 'b', title: 'B', spec: 'do b', deps: [] },
        { id: 'c', title: 'C', spec: 'do c', deps: ['a', 'b'] },
      ],
    },
    'ship the diamond',
    LIMITS,
  )
  return initializeGraph(WorkGraphId('wg-1'), 'ship the diamond', nodes, LIMITS, 100)
}

/** Install the single chain a → c, plus the gated final node. */
function chain(): WorkGraphSnapshot {
  const nodes = installPlan(
    {
      nodes: [
        { id: 'a', title: 'A', spec: 'do a', deps: [] },
        { id: 'c', title: 'C', spec: 'do c', deps: ['a'] },
      ],
    },
    'ship the chain',
    LIMITS,
  )
  return initializeGraph(WorkGraphId('wg-1'), 'ship the chain', nodes, LIMITS, 100)
}

function stateOf(snapshot: WorkGraphSnapshot, id: WorkNode['id']): WorkNode['state'] {
  return snapshot.nodes.find(node => node.id === id)!.state
}

function expectTransitionInvalid(call: () => unknown, message: string): void {
  expect(call).toThrow(new WorkGraphError(message, 'WORKGRAPH_INVALID_TRANSITION'))
}

describe('initializeGraph', () => {
  it('creates an active snapshot with promoted roots and a created history entry', () => {
    const snapshot = diamond()
    expect(snapshot.status).toBe('active')
    expect(snapshot.planVersion).toBe(1)
    expect(stateOf(snapshot, ID_A)).toBe('ready')
    expect(stateOf(snapshot, ID_B)).toBe('ready')
    expect(stateOf(snapshot, ID_C)).toBe('waiting')
    expect(snapshot.history).toEqual([{ at: 100, kind: 'created' }])
  })
})

describe('markRunning', () => {
  it('starts a ready node and records the worker child session', () => {
    const next = markRunning(diamond(), ID_A, LIMITS, 101, 'child-1')
    expect(stateOf(next, ID_A)).toBe('running')
    expect(next.nodes.find(node => node.id === ID_A)!.childSessionId).toBe('child-1')
    expect(next.history.at(-1)).toEqual({ at: 101, kind: 'node-started', node: ID_A })
  })

  it('starts without a child session when none is given', () => {
    const next = markRunning(diamond(), ID_A, LIMITS, 101)
    expect(next.nodes.find(node => node.id === ID_A)!.childSessionId).toBeUndefined()
  })

  it('refuses every non-ready state and unknown nodes', () => {
    expectTransitionInvalid(() => markRunning(diamond(), ID_C, LIMITS, 101), `node ${ID_C} cannot start from state waiting`)
    const running = markRunning(diamond(), ID_A, LIMITS, 101)
    expectTransitionInvalid(() => markRunning(running, ID_A, LIMITS, 102), `node ${ID_A} cannot start from state running`)
    expectTransitionInvalid(() => markRunning(diamond(), WorkNodeId('gn-deadbeef'), LIMITS, 101), 'unknown node gn-deadbeef')
  })
})

describe('settleAchieved', () => {
  it('settles a running node, promotes dependents, and completes on the final node', () => {
    let snapshot = diamond()
    snapshot = markRunning(snapshot, ID_A, LIMITS, 101)
    snapshot = settleAchieved(snapshot, ID_A, 1, undefined, LIMITS, 102)
    expect(stateOf(snapshot, ID_A)).toBe('achieved')
    expect(stateOf(snapshot, ID_C)).toBe('waiting')
    snapshot = markRunning(snapshot, ID_B, LIMITS, 103)
    snapshot = settleAchieved(snapshot, ID_B, 2, undefined, LIMITS, 104)
    expect(stateOf(snapshot, ID_C)).toBe('ready')
    snapshot = markRunning(snapshot, ID_C, LIMITS, 105)
    snapshot = settleAchieved(snapshot, ID_C, 1, undefined, LIMITS, 106)
    const finalId = snapshot.nodes.find(node => node.blocks.length === 3)!.id
    expect(stateOf(snapshot, finalId)).toBe('ready')
    snapshot = markRunning(snapshot, finalId, LIMITS, 107)
    snapshot = settleAchieved(snapshot, finalId, 1, undefined, LIMITS, 108)
    expect(snapshot.status).toBe('complete')
    expect(snapshot.history.at(-2)).toEqual({ at: 108, kind: 'node-achieved', node: finalId })
    expect(snapshot.history.at(-1)).toEqual({ at: 108, kind: 'completed' })
  })

  it('refuses every non-running state', () => {
    expectTransitionInvalid(() => settleAchieved(diamond(), ID_A, 1, undefined, LIMITS, 102), `node ${ID_A} cannot achieve from state ready`)
    const achieved = settleAchieved(markRunning(diamond(), ID_A, LIMITS, 101), ID_A, 1, undefined, LIMITS, 102)
    expectTransitionInvalid(() => settleAchieved(achieved, ID_A, 1, undefined, LIMITS, 103), `node ${ID_A} cannot achieve from state achieved`)
  })
})

describe('settleFailed', () => {
  it('fails the node, blocks the transitive chain, and leaves siblings alone', () => {
    let snapshot = chain()
    snapshot = markRunning(snapshot, ID_A, LIMITS, 101, 'child-1')
    snapshot = settleFailed(snapshot, ID_A, 'worker reported blocked: no time', undefined, 1, LIMITS, 102)
    expect(stateOf(snapshot, ID_A)).toBe('failed')
    expect(snapshot.nodes.find(node => node.id === ID_A)!.failure).toBe('worker reported blocked: no time')
    expect(stateOf(snapshot, ID_C)).toBe('blocked')
    const finalId = snapshot.nodes.find(node => node.id !== ID_A && node.id !== ID_C)!.id
    expect(stateOf(snapshot, finalId)).toBe('blocked')
    expect(snapshot.nodes.find(node => node.id === ID_C)!.failure).toBe(
      `blocked: dependency chain failed at ${ID_A}`,
    )
  })

  it('wedges the graph when nothing is runnable, with the retry hint', () => {
    let snapshot = chain()
    snapshot = markRunning(snapshot, ID_A, LIMITS, 101)
    snapshot = settleFailed(snapshot, ID_A, 'boom', undefined, 1, LIMITS, 102)
    expect(snapshot.status).toBe('blocked')
    expect(snapshot.pauseReason).toBe(WEDGE_PAUSE_REASON)
    expect(snapshot.history.at(-1)).toEqual({ at: 102, kind: 'paused', detail: WEDGE_PAUSE_REASON })
  })

  it('keeps the graph active while a sibling is still runnable', () => {
    let snapshot = diamond()
    snapshot = markRunning(snapshot, ID_A, LIMITS, 101)
    snapshot = settleFailed(snapshot, ID_A, 'boom', undefined, 1, LIMITS, 102)
    expect(snapshot.status).toBe('active')
    expect(snapshot.pauseReason).toBeUndefined()
    expect(stateOf(snapshot, ID_B)).toBe('ready')
  })

  it('never demotes an achieved dependent', () => {
    let snapshot = chain()
    snapshot = markRunning(snapshot, ID_A, LIMITS, 101)
    snapshot = settleAchieved(snapshot, ID_A, 1, undefined, LIMITS, 102)
    snapshot = markRunning(snapshot, ID_C, LIMITS, 103)
    snapshot = settleAchieved(snapshot, ID_C, 1, undefined, LIMITS, 104)
    // The final node already achieved cannot be demoted by a later failure
    // elsewhere; recompute is promote-only and blocks never touch achieved.
    const handCrafted: WorkGraphSnapshot = {
      ...snapshot,
      nodes: snapshot.nodes.map(node =>
        node.id === ID_A ? { ...node, state: 'running' } : node,
      ),
    }
    const next = settleFailed(handCrafted, ID_A, 'late failure', undefined, 1, LIMITS, 105)
    expect(stateOf(next, ID_C)).toBe('achieved')
  })

  it('refuses every non-running state', () => {
    expectTransitionInvalid(() => settleFailed(diamond(), ID_B, 'boom', undefined, 1, LIMITS, 102), `node ${ID_B} cannot fail from state ready`)
  })
})

describe('retryNodes', () => {
  function wedgedChain(): WorkGraphSnapshot {
    let snapshot = chain()
    snapshot = markRunning(snapshot, ID_A, LIMITS, 101, 'child-1')
    return settleFailed(snapshot, ID_A, 'boom', undefined, 1, LIMITS, 102)
  }

  it('resets the failed node and its blocked chain, and unblocks the graph', () => {
    const snapshot = wedgedChain()
    const retried = retryNodes(snapshot, ID_A, LIMITS, 103)
    expect(stateOf(retried, ID_A)).toBe('ready')
    expect(stateOf(retried, ID_C)).toBe('waiting')
    expect(retried.status).toBe('active')
    expect(retried.pauseReason).toBeUndefined()
    expect(retried.history.at(-1)).toEqual({
      at: 103,
      kind: 'node-retried',
      node: ID_A,
      detail: '3 node(s) reset',
    })
    const resetA = retried.nodes.find(node => node.id === ID_A)!
    // Rounds are retained across retries for audit; failure and the worker
    // session are cleared.
    expect(resetA.rounds).toBe(1)
    expect(resetA.failure).toBeUndefined()
    expect(resetA.childSessionId).toBeUndefined()
  })

  it('keeps rounds for audit and refuses non-terminal and unknown targets', () => {
    const snapshot = wedgedChain()
    expectTransitionInvalid(() => retryNodes(diamond(), ID_A, LIMITS, 103), `node ${ID_A} is not retryable from state ready`)
    expectTransitionInvalid(() => retryNodes(snapshot, WorkNodeId('gn-deadbeef'), LIMITS, 103), 'unknown node gn-deadbeef')
    const spent: WorkGraphSnapshot = {
      ...snapshot,
      nodes: snapshot.nodes.map(node =>
        node.id === ID_A ? { ...node, rounds: 4 } : node,
      ),
    }
    const retried = retryNodes(spent, ID_A, LIMITS, 103)
    expect(retried.nodes.find(node => node.id === ID_A)!.rounds).toBe(4)
  })

  it('refuses when an upstream dependency is neither achieved nor in the batch', () => {
    const snapshot = chain()
    const nodes = snapshot.nodes.map(node =>
      node.id === ID_C ? { ...node, state: 'failed' as const, failure: 'own fault' } : node,
    )
    const isolated: WorkGraphSnapshot = { ...snapshot, nodes }
    expect(() => retryNodes(isolated, ID_C, LIMITS, 103)).toThrow(
      new WorkGraphError(`node ${ID_C} cannot retry before ${ID_A}`, 'WORKGRAPH_RETRY_UPSTREAM_NOT_ACHIEVED'),
    )
  })

  it('refuses to retry a blocked node whose failed upstream is outside the batch', () => {
    const snapshot = wedgedChain()
    expect(() => retryNodes(snapshot, ID_C, LIMITS, 103)).toThrow(
      new WorkGraphError(`node ${ID_C} cannot retry before ${ID_A}`, 'WORKGRAPH_RETRY_UPSTREAM_NOT_ACHIEVED'),
    )
  })
})

describe('retryNodes edge coverage', () => {
  it('drops a pause reason when retrying inside a user-paused graph and stays paused', () => {
    let snapshot = chain()
    snapshot = markRunning(snapshot, ID_A, LIMITS, 101)
    snapshot = settleFailed(snapshot, ID_A, 'boom', undefined, 1, LIMITS, 102)
    const paused: WorkGraphSnapshot = { ...snapshot, status: 'user_paused', pauseReason: 'user asked' }
    const retried = retryNodes(paused, ID_A, LIMITS, 103)
    expect(retried.status).toBe('user_paused')
    expect(retried.pauseReason).toBeUndefined()
  })

  it('fails a node with no blockable dependents without wedging', () => {
    let snapshot = chain()
    snapshot = markRunning(snapshot, ID_A, LIMITS, 101)
    snapshot = settleAchieved(snapshot, ID_A, 1, undefined, LIMITS, 102)
    snapshot = markRunning(snapshot, ID_C, LIMITS, 103)
    snapshot = settleAchieved(snapshot, ID_C, 1, undefined, LIMITS, 104)
    const finalId = snapshot.nodes.find(node => node.id !== ID_A && node.id !== ID_C)!.id
    snapshot = markRunning(snapshot, finalId, LIMITS, 105)
    snapshot = settleAchieved(snapshot, finalId, 1, undefined, LIMITS, 106)
    const handCrafted: WorkGraphSnapshot = {
      ...snapshot,
      nodes: snapshot.nodes.map(node =>
        node.id === ID_A ? { ...node, state: 'running' } : node,
      ),
    }
    const failed = settleFailed(handCrafted, ID_A, 'late failure', undefined, 1, LIMITS, 107)
    expect(failed.status).toBe('blocked')
    expect(failed.pauseReason).toBe(WEDGE_PAUSE_REASON)
    expect(failed.history.at(-1)!.kind).toBe('paused')
  })

  it('retries a node whose upstream dependency is achieved', () => {
    let snapshot = chain()
    snapshot = markRunning(snapshot, ID_A, LIMITS, 101)
    snapshot = settleAchieved(snapshot, ID_A, 1, undefined, LIMITS, 102)
    snapshot = markRunning(snapshot, ID_C, LIMITS, 103)
    const failed = settleFailed(snapshot, ID_C, 'own fault', undefined, 1, LIMITS, 104)
    const retried = retryNodes(failed, ID_C, LIMITS, 105)
    expect(stateOf(retried, ID_C)).toBe('ready')
    expect(retried.status).toBe('active')
  })
})


describe('retryAllNodes', () => {
  it('returns the snapshot unchanged when no node is failed', () => {
    const snapshot = chain()
    expect(retryAllNodes(snapshot, LIMITS, 100)).toBe(snapshot)
  })

  it('resets sibling failure chains as ONE union batch', () => {
    let snapshot = diamond()
    // a and b both fail: c and the final block on BOTH roots, so no
    // single-root reset may proceed — the union batch must carry both
    // chains (a bare /graph retry on this graph otherwise refuses).
    snapshot = markRunning(snapshot, ID_A, LIMITS, 101)
    snapshot = settleFailed(snapshot, ID_A, 'boom a', undefined, 1, LIMITS, 102)
    snapshot = markRunning(snapshot, ID_B, LIMITS, 103)
    snapshot = settleFailed(snapshot, ID_B, 'boom b', undefined, 1, LIMITS, 104)
    expect(snapshot.status).toBe('blocked')
    expect(() => retryNodes(snapshot, ID_A, LIMITS, 105))
      .toThrow('cannot retry before')
    const retried = retryAllNodes(snapshot, LIMITS, 105)
    expect(retried.status).toBe('active')
    expect(retried.pauseReason).toBeUndefined()
    // The failed roots reset runnable; their blocked chains wait on them.
    expect(stateOf(retried, ID_A)).toBe('ready')
    expect(stateOf(retried, ID_B)).toBe('ready')
    expect(stateOf(retried, ID_C)).toBe('waiting')
    for (const node of retried.nodes) {
      expect(node.failure).toBeUndefined()
      expect(node.childSessionId).toBeUndefined()
    }
    expect(retried.history.at(-1)!.kind).toBe('node-retried')
  })

  it('keeps achieved members untouched while resetting their blocked chains', () => {
    let snapshot = chain()
    snapshot = markRunning(snapshot, ID_A, LIMITS, 101)
    snapshot = settleAchieved(snapshot, ID_A, 1, undefined, LIMITS, 102)
    snapshot = markRunning(snapshot, ID_C, LIMITS, 103)
    snapshot = settleFailed(snapshot, ID_C, 'own fault', undefined, 1, LIMITS, 104)
    // a stays achieved; c and the blocked final reset.
    const retried = retryAllNodes(snapshot, LIMITS, 105)
    expect(stateOf(retried, ID_A)).toBe('achieved')
    expect(stateOf(retried, ID_C)).toBe('ready')
    const finalId = retried.nodes.find(node => node.id !== ID_A && node.id !== ID_C)!.id
    expect(stateOf(retried, finalId)).toBe('waiting')
    expect(retried.status).toBe('active')
  })
})

describe('restoreSnapshot', () => {
  it('demotes running nodes to ready and an active graph to user-paused', () => {
    let snapshot = chain()
    snapshot = markRunning(snapshot, ID_A, LIMITS, 101, 'child-1')
    const restored = restoreSnapshot(snapshot, 200)
    expect(stateOf(restored, ID_A)).toBe('ready')
    expect(restored.status).toBe('user_paused')
    expect(restored.pauseReason).toBe(RESTORE_PAUSE_REASON)
    expect(restored.updatedAt).toBe(200)
  })

  it('leaves an already-paused graph paused with its own reason', () => {
    let snapshot = chain()
    snapshot = markRunning(snapshot, ID_A, LIMITS, 101)
    snapshot = settleFailed(snapshot, ID_A, 'boom', undefined, 1, LIMITS, 102)
    const restored = restoreSnapshot(snapshot, 200)
    expect(restored.status).toBe('blocked')
    expect(restored.pauseReason).toBe(WEDGE_PAUSE_REASON)
  })
})

describe('appendHistory', () => {
  it('caps the history by dropping the oldest entries first', () => {
    const entries = (from: number, to: number): WorkGraphHistoryEntry[] =>
      Array.from({ length: to - from + 1 }, (_, index) => ({ at: from + index, kind: 'node-started' as const }))
    expect(appendHistory(entries(1, 2), entries(3, 5), { maxNodes: 24, historyMax: 4 })).toEqual(entries(2, 5))
    expect(appendHistory(entries(1, 2), entries(3, 4), { maxNodes: 24, historyMax: 64 })).toEqual(entries(1, 4))
  })
})

describe('snapshot immutability', () => {
  it('never mutates the input snapshot', () => {
    const snapshot = Object.freeze(diamond())
    const frozenNodes = Object.freeze([...snapshot.nodes])
    const next = settleAchieved(markRunning(snapshot, ID_A, LIMITS, 101), ID_A, 1, undefined, LIMITS, 102)
    expect(next).not.toBe(snapshot)
    expect(snapshot.nodes).toEqual(frozenNodes)
    expect(stateOf(snapshot, ID_A)).toBe('ready')
  })
})

describe('createPendingGraph', () => {
  it('creates an active empty snapshot with created and planning-started history', () => {
    const snapshot = createPendingGraph(WorkGraphId('wg-2'), 'plan me', LIMITS, 50)
    expect(snapshot.status).toBe('active')
    expect(snapshot.nodes).toEqual([])
    expect(snapshot.planVersion).toBe(1)
    expect(snapshot.history).toEqual([
      { at: 50, kind: 'created' },
      { at: 50, kind: 'planning-started' },
    ])
    expect(snapshot.tokensSpent).toBe(0)
    expect(snapshot.replanRuns).toBe(0)
  })
})

describe('installPlanIntoGraph', () => {
  it('installs the plan into a pending graph, promotes roots, and completes planning', () => {
    const pending = createPendingGraph(WorkGraphId('wg-2'), 'plan me', LIMITS, 50)
    const installed = installPlanIntoGraph(
      pending,
      installPlan(
        {
          nodes: [
            { id: 'a', title: 'A', spec: 'do a', deps: [] },
            { id: 'c', title: 'C', spec: 'do c', deps: ['a'] },
          ],
        },
        'plan me',
        LIMITS,
      ),
      LIMITS,
      60,
    )
    expect(installed.status).toBe('active')
    expect(installed.planVersion).toBe(1)
    expect(stateOf(installed, ID_A)).toBe('ready')
    expect(stateOf(installed, canonicalNodeId('c'))).toBe('waiting')
    expect(installed.nodes.at(-1)!.id).toBe('gn-final')
    expect(installed.history.map(entry => entry.kind)).toEqual([
      'created',
      'planning-started',
      'planning-completed',
    ])
  })

  it('rejects installation into a graph that already has nodes', () => {
    const pending = createPendingGraph(WorkGraphId('wg-2'), 'plan me', LIMITS, 50)
    const installed = installPlanIntoGraph(
      pending,
      installPlan({ nodes: [{ id: 'a', title: 'A', spec: 'do a', deps: [] }] }, 'plan me', LIMITS),
      LIMITS,
      60,
    )
    expectTransitionInvalid(
      () => installPlanIntoGraph(installed, installed.nodes, LIMITS, 70),
      'cannot install a plan into a graph that already has nodes',
    )
  })

  it('rejects installation into a non-active graph', () => {
    const pending = createPendingGraph(WorkGraphId('wg-2'), 'plan me', LIMITS, 50)
    const paused = pausePlanningFailed(pending, 'boom', LIMITS, 55)
    expectTransitionInvalid(
      () => installPlanIntoGraph(
        paused,
        installPlan({ nodes: [{ id: 'a', title: 'A', spec: 'do a', deps: [] }] }, 'plan me', LIMITS),
        LIMITS,
        60,
      ),
      'cannot install a plan into a infra_paused graph',
    )
  })
})

describe('pauseGraph', () => {
  it('pauses an active graph as user-paused with the reason', () => {
    const paused = pauseGraph(chain(), 'user', 'human stop', LIMITS, 90)
    expect(paused.status).toBe('user_paused')
    expect(paused.pauseReason).toBe('human stop')
    expect(paused.history.at(-1)).toEqual({ at: 90, kind: 'paused', detail: 'human stop' })
  })

  it('pauses an active graph as infra-paused', () => {
    const paused = pauseGraph(chain(), 'infra', 'environment stop', LIMITS, 90)
    expect(paused.status).toBe('infra_paused')
    expect(paused.pauseReason).toBe('environment stop')
  })

  it('rejects pausing a non-active graph', () => {
    const paused = pauseGraph(chain(), 'user', 'stop', LIMITS, 90)
    expectTransitionInvalid(
      () => pauseGraph(paused, 'user', 'again', LIMITS, 91),
      'cannot pause a user_paused graph',
    )
  })
})

describe('pausePlanningFailed', () => {
  it('pauses an active pending graph infra with a planning-failed record', () => {
    const pending = createPendingGraph(WorkGraphId('wg-2'), 'plan me', LIMITS, 50)
    const paused = pausePlanningFailed(pending, 'plan rejected twice: cycle', LIMITS, 55)
    expect(paused.status).toBe('infra_paused')
    expect(paused.pauseReason).toBe('plan rejected twice: cycle')
    expect(paused.history.map(entry => entry.kind)).toEqual([
      'created',
      'planning-started',
      'planning-failed',
    ])
    expect(paused.history.at(-1)!.detail).toBe('plan rejected twice: cycle')
  })

  it('rejects failing planning of a non-active graph', () => {
    const pending = createPendingGraph(WorkGraphId('wg-2'), 'plan me', LIMITS, 50)
    const paused = pausePlanningFailed(pending, 'nope', LIMITS, 55)
    expectTransitionInvalid(
      () => pausePlanningFailed(paused, 'nope again', LIMITS, 56),
      'cannot fail planning of a infra_paused graph',
    )
  })
})

describe('resumeGraph', () => {
  it('resumes a user-paused graph to active and drops the reason', () => {
    const paused = pauseGraph(chain(), 'user', 'stop', LIMITS, 90)
    const resumed = resumeGraph(paused, undefined, LIMITS, 95)
    expect(resumed.status).toBe('active')
    expect(resumed.pauseReason).toBeUndefined()
    expect(resumed.history.at(-1)).toEqual({ at: 95, kind: 'resumed' })
  })

  it('resumes an infra-paused graph', () => {
    const paused = pauseGraph(chain(), 'infra', 'env', LIMITS, 90)
    expect(resumeGraph(paused, undefined, LIMITS, 95).status).toBe('active')
  })

  it('resumes a blocked graph', () => {
    let snapshot = chain()
    snapshot = markRunning(snapshot, ID_A, LIMITS, 91)
    snapshot = settleFailed(snapshot, ID_A, 'boom', undefined, 1, LIMITS, 92)
    expect(snapshot.status).toBe('blocked')
    expect(resumeGraph(snapshot, undefined, LIMITS, 95).status).toBe('active')
  })

  it('rejects resuming an active or complete graph', () => {
    expectTransitionInvalid(
      () => resumeGraph(chain(), undefined, LIMITS, 95),
      'cannot resume a active graph',
    )
    let snapshot = chain()
    for (const id of [ID_A, canonicalNodeId('c')]) {
      snapshot = settleAchieved(markRunning(snapshot, id, LIMITS, 100), id, 1, undefined, LIMITS, 101)
    }
    snapshot = settleAchieved(markRunning(snapshot, FINAL_NODE_ID, LIMITS, 102), FINAL_NODE_ID, 1, undefined, LIMITS, 103)
    expect(snapshot.status).toBe('complete')
    expectTransitionInvalid(
      () => resumeGraph(snapshot, undefined, LIMITS, 104),
      'cannot resume a complete graph',
    )
  })
})

describe('budget accounting', () => {
  /** A diamond with both roots running and a configured budget. */
  function runningDiamond(budget: number): WorkGraphSnapshot {
    let snapshot = diamond()
    snapshot = { ...snapshot, tokenBudget: budget }
    snapshot = markRunning(snapshot, ID_A, LIMITS, 101, 'child-a')
    snapshot = markRunning(snapshot, ID_B, LIMITS, 102, 'child-b')
    return snapshot
  }

  it('charges usage on achievement and trips the budget, demoting sibling running nodes', () => {
    const snapshot = runningDiamond(10)
    const settled = settleAchieved(snapshot, ID_A, 1, 6, LIMITS, 103)
    expect(settled.status).toBe('active')
    expect(settled.tokensSpent).toBe(6)
    const tripped = settleAchieved(settled, ID_B, 1, 6, LIMITS, 104)
    expect(tripped.status).toBe('budget_limited')
    expect(tripped.tokensSpent).toBe(12)
    expect(tripped.pauseReason).toBe(BUDGET_PAUSE_REASON)
    expect(tripped.history.map(entry => entry.kind)).toContain('budget-exceeded')
  })

  it('charges failed nodes too (spent-so-far is always charged)', () => {
    let snapshot = runningDiamond(20)
    snapshot = settleFailed(snapshot, ID_A, 'boom', 9, 1, LIMITS, 103)
    expect(snapshot.status).toBe('active')
    expect(snapshot.tokensSpent).toBe(9)
    expect(stateOf(snapshot, ID_B)).toBe('running')
  })

  it('prefers the budget stop over a wedge on a failing settlement', () => {
    const snapshot = runningDiamond(10)
    const tripped = settleFailed(snapshot, ID_A, 'boom', 10, 1, LIMITS, 103)
    expect(tripped.status).toBe('budget_limited')
    expect(tripped.pauseReason).toBe(BUDGET_PAUSE_REASON)
    expect(tripped.history.map(entry => entry.kind)).not.toContain('completed')
  })

  it('completes the graph without a budget trip when every node settles', () => {
    let snapshot = chain()
    snapshot = { ...snapshot, tokenBudget: 100 }
    snapshot = settleAchieved(markRunning(snapshot, ID_A, LIMITS, 101, 'c-a'), ID_A, 1, 60, LIMITS, 102)
    snapshot = settleAchieved(markRunning(snapshot, canonicalNodeId('c'), LIMITS, 103, 'c-c'), canonicalNodeId('c'), 1, 40, LIMITS, 104)
    snapshot = settleAchieved(markRunning(snapshot, FINAL_NODE_ID, LIMITS, 105, 'c-f'), FINAL_NODE_ID, 1, 10, LIMITS, 106)
    expect(snapshot.status).toBe('complete')
    expect(snapshot.tokensSpent).toBe(110)
  })

  it('trips the budget at a dispatch boundary via budgetLimit', () => {
    const snapshot = runningDiamond(10)
    const limited = budgetLimit(snapshot, LIMITS, 105)
    expect(limited.status).toBe('budget_limited')
    expect(stateOf(limited, ID_A)).toBe('ready')
    expect(stateOf(limited, ID_B)).toBe('ready')
    expect(limited.pauseReason).toBe(BUDGET_PAUSE_REASON)
  })

  it('refuses to trip the budget of an unlimited graph', () => {
    expectTransitionInvalid(
      () => budgetLimit(chain(), LIMITS, 105),
      'cannot trip the budget of an unlimited graph',
    )
  })

  it('resumes a budget-limited graph with a top-up from spent-so-far', () => {
    let snapshot = runningDiamond(10)
    snapshot = settleAchieved(snapshot, ID_A, 1, 10, LIMITS, 103)
    expect(snapshot.status).toBe('budget_limited')
    const resumed = resumeGraph(snapshot, 25, LIMITS, 104)
    expect(resumed.status).toBe('active')
    expect(resumed.tokenBudget).toBe(35)
    expect(resumed.pauseReason).toBeUndefined()
  })

  it('rejects a non-positive top-up', () => {
    let snapshot = runningDiamond(10)
    snapshot = settleAchieved(snapshot, ID_A, 1, 10, LIMITS, 103)
    expectTransitionInvalid(
      () => resumeGraph(snapshot, 0, LIMITS, 104),
      'budget top-up must be a positive integer',
    )
  })
})

describe('demoteRunningToReady', () => {
  it('demotes a running node to ready and drops the child session', () => {
    let snapshot = chain()
    snapshot = markRunning(snapshot, ID_A, LIMITS, 101, 'child-a')
    const demoted = demoteRunningToReady(snapshot, ID_A, LIMITS, 102)
    expect(stateOf(demoted, ID_A)).toBe('ready')
    expect(demoted.nodes.find(node => node.id === ID_A)!.childSessionId).toBeUndefined()
    expect(demoted.history.at(-1)!.kind).toBe('node-retried')
  })

  it('rejects demoting a non-running node', () => {
    expectTransitionInvalid(
      () => demoteRunningToReady(chain(), ID_A, LIMITS, 102),
      'node gn-e40c292c cannot demote from state ready',
    )
  })
})

describe('queueDiscoveries', () => {
  it('appends cleaned discovery records and no-ops on empty input', () => {
    let snapshot = chain()
    snapshot = queueDiscoveries(snapshot, [
      { description: 'fix the build', from: ID_A },
      { description: '   ', from: ID_A },
      { description: 'port the linter', from: ID_A },
    ], LIMITS, 100)
    expect(snapshot.pendingDiscoveries).toEqual([
      { description: 'fix the build', from: ID_A },
      { description: 'port the linter', from: ID_A },
    ])
    const unchanged = queueDiscoveries(snapshot, [], LIMITS, 101)
    expect(unchanged).toBe(snapshot)
  })
})

describe('settleMergeFailed', () => {
  it('revokes an achievement on a failed merge and blocks dependents', () => {
    // a and b achieved, final waiting: failing a's merge blocks the final.
    let snapshot = diamond()
    snapshot = markRunning(snapshot, ID_A, LIMITS, 101, 'c-a')
    snapshot = settleAchieved(snapshot, ID_A, 1, undefined, LIMITS, 102)
    snapshot = markRunning(snapshot, ID_B, LIMITS, 103, 'c-b')
    snapshot = settleAchieved(snapshot, ID_B, 1, undefined, LIMITS, 104)
    const failed = settleMergeFailed(snapshot, ID_A, 'merge conflict on x.ts', LIMITS, 105)
    expect(stateOf(failed, ID_A)).toBe('failed')
    expect(failed.nodes.find(node => node.id === ID_A)!.failure).toContain('merge-back failed: merge conflict on x.ts')
    expect(stateOf(failed, ID_B)).toBe('achieved')
    expect(stateOf(failed, FINAL_NODE_ID)).toBe('blocked')
    expect(failed.status).toBe('blocked')
    expect(failed.history.map(entry => entry.kind)).toContain('node-failed')
  })

  it('keeps the graph active when a sibling is still runnable', () => {
    let snapshot = diamond()
    snapshot = markRunning(snapshot, ID_A, LIMITS, 101, 'c-a')
    snapshot = settleAchieved(snapshot, ID_A, 1, undefined, LIMITS, 102)
    // b is still ready: no wedge yet.
    const failed = settleMergeFailed(snapshot, ID_A, 'HEAD moved', LIMITS, 103)
    expect(stateOf(failed, ID_A)).toBe('failed')
    expect(stateOf(failed, ID_B)).toBe('ready')
    expect(failed.status).toBe('active')
  })

  it('rejects failing the merge of a non-achieved node', () => {
    expectTransitionInvalid(
      () => settleMergeFailed(chain(), ID_A, 'nope', LIMITS, 100),
      'node gn-e40c292c cannot fail its merge from state ready',
    )
  })
})

describe('settleAchieved wedge re-check', () => {
  it('wedges the graph when a late achievement leaves nothing runnable', () => {
    // a fails while b is still ready (no wedge), then b achieves: the graph
    // wedges on the final node.
    let snapshot = diamond()
    snapshot = markRunning(snapshot, ID_A, LIMITS, 101, 'c-a')
    snapshot = settleFailed(snapshot, ID_A, 'boom', undefined, 1, LIMITS, 102)
    expect(snapshot.status).toBe('active')
    snapshot = markRunning(snapshot, ID_B, LIMITS, 103, 'c-b')
    snapshot = settleAchieved(snapshot, ID_B, 1, undefined, LIMITS, 104)
    expect(snapshot.status).toBe('blocked')
    expect(snapshot.pauseReason).toBe(WEDGE_PAUSE_REASON)
    expect(stateOf(snapshot, FINAL_NODE_ID)).toBe('blocked')
  })
})
