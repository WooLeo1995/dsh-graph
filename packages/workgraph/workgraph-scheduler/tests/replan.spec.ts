import { describe, expect, it } from 'vitest'
import type { WorkGraphLimits, WorkGraphSnapshot, WorkNode } from '@deepseek-ai/dsh-workgraph'
import { WorkGraphId, WorkNodeId } from '@deepseek-ai/dsh-workgraph'
import { canonicalNodeId, drainDiscoveries, installReplan, replanDependencyGuard, runReplannerEpisode, FINAL_NODE_ID } from '@deepseek-ai/dsh-workgraph-scheduler'
import type { PlannerSpawn } from '@deepseek-ai/dsh-workgraph-scheduler'

const LIMITS: WorkGraphLimits = { maxNodes: 24, historyMax: 64 }

function snapshot(nodes: readonly WorkNode[] = []): WorkGraphSnapshot {
  const final: WorkNode = {
    id: WorkNodeId('gn-final'),
    title: 'Final verification of the overall objective',
    spec: 'verify',
    blocks: nodes.filter(node => node.id !== FINAL_NODE_ID).map(node => node.id),
    state: 'waiting',
    rounds: 0,
  }
  return {
    id: WorkGraphId('wg-r'),
    objective: 'ship it',
    status: 'active',
    planVersion: 1,
    nodes: [...nodes, final],
    pendingDiscoveries: [{ description: 'more work', from: canonicalNodeId('a') }],
    history: [],
    tokensSpent: 0,
    replanRuns: 0,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('runReplannerEpisode', () => {
  it('plans an appendix and fails closed on child errors or missing artifacts', async () => {
    const spawn: PlannerSpawn = async () => ({
      structured: { nodes: [{ id: 'c', title: 'C', spec: 'do c', deps: ['a'] }] },
      stopReason: 'completed',
    })
    const planned = await runReplannerEpisode({
      objective: 'ship it',
      currentGraph: '[]',
      discoveries: '- (from gn-1) more work',
      feedback: '',
      limits: LIMITS,
      signal: new AbortController().signal,
      spawn,
    })
    expect(planned).toEqual({ kind: 'planned', nodes: [expect.objectContaining({ id: canonicalNodeId('c') })] })
    expect(await runReplannerEpisode({
      objective: 'ship it',
      currentGraph: '[]',
      discoveries: '',
      feedback: '',
      limits: LIMITS,
      signal: new AbortController().signal,
      spawn: async () => ({ structured: undefined, stopReason: 'error' }),
    })).toEqual({ kind: 'fail-closed', reason: 'replanner child ended with stop reason "error"' })
    expect(await runReplannerEpisode({
      objective: 'ship it',
      currentGraph: '[]',
      discoveries: '',
      feedback: '',
      limits: LIMITS,
      signal: new AbortController().signal,
      spawn: async () => ({ structured: undefined, stopReason: 'completed' }),
    })).toEqual({ kind: 'fail-closed', reason: 'replanner produced no structured appendix' })
  })

  it('accepts an empty appendix as a respected answer', async () => {
    const outcome = await runReplannerEpisode({
      objective: 'ship it',
      currentGraph: '[]',
      discoveries: 'x',
      feedback: '',
      limits: LIMITS,
      signal: new AbortController().signal,
      spawn: async () => ({ structured: { nodes: [] }, stopReason: 'completed' }),
    })
    expect(outcome).toEqual({ kind: 'planned', nodes: [] })
  })

  it('rethrows a non-domain gate error', async () => {
    const artifact = new Proxy({}, {
      get() {
        throw new Error('boom')
      },
    })
    await expect(runReplannerEpisode({
      objective: 'ship it',
      currentGraph: '[]',
      discoveries: '',
      feedback: '',
      limits: LIMITS,
      signal: new AbortController().signal,
      spawn: async () => ({ structured: artifact, stopReason: 'completed' }),
    })).rejects.toThrow('boom')
  })

  it('rejects malformed appendix rows as invalid outcomes', async () => {
    const episode = (structured: unknown) => runReplannerEpisode({
      objective: 'ship it',
      currentGraph: '[]',
      discoveries: 'x',
      feedback: '',
      limits: LIMITS,
      signal: new AbortController().signal,
      spawn: async () => ({ structured: structured as never, stopReason: 'completed' }),
    })
    const invalidReason = async (structured: unknown): Promise<string> => {
      const outcome = await episode(structured)
      expect(outcome.kind).toBe('invalid')
      return outcome.kind === 'invalid' ? outcome.reason : ''
    }
    const row = { id: 'c', title: 'C', spec: 'do c', deps: [] }
    await expect(invalidReason({})).resolves.toContain('nodes array')
    await expect(invalidReason({ nodes: [{ id: 'c', spec: 'do c', deps: [] }] }))
      .resolves.toContain('id, title, spec, and deps')
    await expect(invalidReason({ nodes: [{ ...row, id: 'bad id!' }] }))
      .resolves.toContain('1-64 characters')
    await expect(invalidReason({ nodes: [row, row] })).resolves.toContain('duplicate node id')
    await expect(invalidReason({ nodes: [{ ...row, title: '   ' }] }))
      .resolves.toContain('empty title or spec')
    await expect(invalidReason({ nodes: [{ ...row, deps: [42] }] }))
      .resolves.toContain('deps must be strings')
    await expect(invalidReason({ nodes: [{ ...row, deps: ['c'] }] }))
      .resolves.toContain('depends on itself')
  })
})

describe('installReplan', () => {
  it('appends nodes, re-gates gn-final, bumps the version, and clears discoveries', () => {
    const base = snapshot([{ id: canonicalNodeId('a'), title: 'A', spec: 'do a', blocks: [], state: 'ready', rounds: 0 }])
    const installed = installReplan(
      base,
      [{ id: canonicalNodeId('c'), title: 'C', spec: 'do c', blocks: [], state: 'waiting', rounds: 0 }],
      LIMITS,
      10,
    )
    expect(installed.planVersion).toBe(2)
    expect(installed.pendingDiscoveries).toEqual([])
    expect(installed.nodes.map(node => node.id)).toEqual([
      canonicalNodeId('a'),
      FINAL_NODE_ID,
      canonicalNodeId('c'),
    ])
    const final = installed.nodes.find(node => node.id === FINAL_NODE_ID)!
    expect(final.blocks).toContain(canonicalNodeId('c'))
  })

  it('requires the final node', () => {
    const base = snapshot()
    expect(() => installReplan(
      { ...base, nodes: [{ id: canonicalNodeId('a'), title: 'A', spec: 'do a', blocks: [], state: 'ready', rounds: 0 }] },
      [{ id: canonicalNodeId('c'), title: 'C', spec: 'do c', blocks: [], state: 'waiting', rounds: 0 }],
      LIMITS,
      10,
    )).toThrow('replan requires the final node')
  })

  it('rejects duplicates and the reserved final id', () => {
    const base = snapshot([{ id: canonicalNodeId('a'), title: 'A', spec: 'do a', blocks: [], state: 'ready', rounds: 0 }])
    expect(() => installReplan(
      base,
      [{ id: canonicalNodeId('a'), title: 'A2', spec: 'do a', blocks: [], state: 'waiting', rounds: 0 }],
      LIMITS,
      10,
    )).toThrow('duplicates an existing node')
    expect(() => installReplan(
      base,
      [{ id: FINAL_NODE_ID, title: 'F', spec: 'x', blocks: [], state: 'waiting', rounds: 0 }],
      LIMITS,
      10,
    )).toThrow('reserved final node')
  })

  it('demotes a ready final node to waiting when re-gating over the appendix', () => {
    const base = snapshot([{ id: canonicalNodeId('a'), title: 'A', spec: 'do a', blocks: [], state: 'ready', rounds: 0 }])
    const readyFinal = {
      ...base,
      nodes: base.nodes.map(node => node.id === FINAL_NODE_ID ? { ...node, state: 'ready' as const } : node),
    }
    const installed = installReplan(
      readyFinal,
      [{ id: canonicalNodeId('c'), title: 'C', spec: 'do c', blocks: [], state: 'waiting', rounds: 0 }],
      LIMITS,
      10,
    )
    const final = installed.nodes.find(node => node.id === FINAL_NODE_ID)!
    expect(final.state).toBe('waiting')
    expect(final.blocks).toContain(canonicalNodeId('c'))
  })
})

describe('replanDependencyGuard', () => {
  const existing: WorkNode[] = [
    { id: canonicalNodeId('a'), title: 'A', spec: 'do a', blocks: [], state: 'ready', rounds: 0 },
  ]

  it('rejects deps on unknown nodes and on the reserved final node', () => {
    expect(() =>{  replanDependencyGuard(
      [{ id: canonicalNodeId('c'), title: 'C', spec: 'do c', blocks: [WorkNodeId('gn-missing')], state: 'waiting', rounds: 0 }],
      existing,
    ) }).toThrow('not a live existing node')
    expect(() =>{  replanDependencyGuard(
      [{ id: canonicalNodeId('c'), title: 'C', spec: 'do c', blocks: [FINAL_NODE_ID], state: 'waiting', rounds: 0 }],
      existing,
    ) }).toThrow('not a live existing node')
  })

  it('accepts deps on live existing nodes', () => {
    expect(() =>{  replanDependencyGuard(
      [{ id: canonicalNodeId('c'), title: 'C', spec: 'do c', blocks: [canonicalNodeId('a')], state: 'waiting', rounds: 0 }],
      existing,
    ) }).not.toThrow()
  })
})

describe('drainDiscoveries', () => {
  it('clears the entries to history and no-ops when empty', () => {
    const base = snapshot()
    const drained = drainDiscoveries(base, LIMITS, 10)
    expect(drained.pendingDiscoveries).toEqual([])
    expect(drained.history.at(-1)!.kind).toBe('replanned')
    expect(drainDiscoveries(drained, LIMITS, 11)).toBe(drained)
  })
})
