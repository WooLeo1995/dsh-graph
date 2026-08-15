import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  decodeWorkGraphChange,
  foldWorkGraph,
  WorkGraphId,
  WorkNodeId,
  WORKGRAPH_CHANGE_VERSION,
} from '@deepseek-ai/dsh-workgraph'
import type { WorkGraphChangeMeta, WorkGraphSnapshot } from '@deepseek-ai/dsh-workgraph'

const NODE_A = WorkNodeId('gn-aaaaaaaa')
const NODE_B = WorkNodeId('gn-bbbbbbbb')

function snapshot(overrides: Partial<WorkGraphSnapshot> = {}): WorkGraphSnapshot {
  return {
    id: WorkGraphId('wg-1'),
    objective: 'ship it',
    status: 'active',
    planVersion: 1,
    nodes: [
      { id: NODE_A, title: 'A', spec: 'do a', blocks: [], state: 'ready', rounds: 0 },
      {
        id: NODE_B,
        title: 'B',
        spec: 'do b',
        blocks: [NODE_A],
        state: 'waiting',
        rounds: 1,
        childSessionId: 'session-1',
      },
    ],
    pendingDiscoveries: [{ description: 'write docs', from: NODE_A }],
    history: [{ at: 5, kind: 'created' }, { at: 6, kind: 'node-started', node: NODE_A }],
    tokensSpent: 100,
    replanRuns: 1,
    createdAt: 5,
    updatedAt: 6,
    ...overrides,
  }
}

function changeEvent(data: WorkGraphChangeMeta, seq: number, time = 10): SessionEvent {
  return { type: 'workgraph/change', seq, time, data }
}

describe('decodeWorkGraphChange', () => {
  it('returns undefined for another value kind', () => {
    expect(decodeWorkGraphChange(undefined)).toBeUndefined()
    expect(decodeWorkGraphChange('workgraph/change')).toBeUndefined()
    expect(decodeWorkGraphChange({ kind: 'goal/change' })).toBeUndefined()
  })

  it('rejects an unsupported version loudly', () => {
    expect(() => decodeWorkGraphChange({ kind: 'workgraph/change', version: 2 })).toThrow(
      'unsupported workgraph change version 2',
    )
  })

  it('decodes a whole-snapshot change with every vocabulary field', () => {
    const graph = snapshot()
    const meta = decodeWorkGraphChange({
      kind: 'workgraph/change',
      version: WORKGRAPH_CHANGE_VERSION,
      graph,
    })
    expect(meta).toEqual({
      kind: 'workgraph/change',
      version: 1,
      graph,
    })
  })

  it('decodes a clear tombstone and rejects an unshaped one', () => {
    expect(
      decodeWorkGraphChange({
        kind: 'workgraph/change',
        version: 1,
        operation: 'clear',
        cleared: 'wg-1',
        clearedAt: 9,
      }),
    ).toEqual({
      kind: 'workgraph/change',
      version: 1,
      operation: 'clear',
      cleared: WorkGraphId('wg-1'),
      clearedAt: 9,
    })
    expect(() =>
      decodeWorkGraphChange({
        kind: 'workgraph/change',
        version: 1,
        operation: 'clear',
        cleared: 'wg-1',
        clearedAt: 9,
        extra: true,
      }),
    ).toThrow('workgraph clear change must have only')
  })

  it('requires the exact snapshot-change field set', () => {
    const base = { kind: 'workgraph/change', version: 1, graph: snapshot() }
    expect(() => decodeWorkGraphChange({ ...base, extra: 1 })).toThrow(
      'workgraph snapshot change must have only',
    )
    const withoutGraph = { ...base } as Record<string, unknown>
    delete withoutGraph['graph']
    expect(() => decodeWorkGraphChange(withoutGraph)).toThrow(
      'workgraph snapshot change must have exactly',
    )
  })

  it('restores an unknown persisted node state as ready', () => {
    const raw = JSON.parse(JSON.stringify(snapshot())) as Record<string, unknown[]>
    ;(raw['nodes'] as Record<string, unknown>[])[0]!['state'] = 'verifying'
    const meta = decodeWorkGraphChange({ kind: 'workgraph/change', version: 1, graph: raw })
    expect(meta && 'graph' in meta && meta.graph.nodes[0]!.state).toBe('ready')
  })

  it('absorbs an unknown history kind as unknown with the raw kind retained', () => {
    const raw = JSON.parse(JSON.stringify(snapshot())) as Record<string, unknown[]>
    raw['history'] = [{ at: 7, kind: 'teleported' }]
    const meta = decodeWorkGraphChange({ kind: 'workgraph/change', version: 1, graph: raw })
    expect(meta && 'graph' in meta && meta.graph.history[0]).toEqual({
      at: 7,
      kind: 'unknown',
      detail: 'unrecognized history kind teleported',
    })
  })

  it('rejects each malformed snapshot field precisely', () => {
    const bad = (graph: Record<string, unknown>) =>
      decodeWorkGraphChange({ kind: 'workgraph/change', version: 1, graph })
    expect(() => bad({ ...snapshot(), status: 'dreaming' })).toThrow('graph.status is invalid')
    expect(() => bad({ ...snapshot(), nodes: 'nope' })).toThrow('graph.nodes must be an array')
    expect(() => bad({ ...snapshot(), pendingDiscoveries: 3 })).toThrow(
      'graph.pendingDiscoveries must be an array',
    )
    expect(() => bad({ ...snapshot(), history: null })).toThrow('graph.history must be an array')
    expect(() => bad({ ...snapshot(), objective: '  ' })).toThrow('graph.objective')
    expect(() => bad({ ...snapshot(), planVersion: 0 })).toThrow('graph.planVersion')
    expect(() => bad({ ...snapshot(), updatedAt: 4 })).toThrow(
      'graph.updatedAt cannot precede createdAt',
    )
    expect(() => bad({ ...snapshot(), tokenBudget: 0 })).toThrow('graph.tokenBudget')
    expect(() => bad({ ...snapshot(), pauseReason: '' })).toThrow('graph.pauseReason')
  })

  it('rejects duplicate node ids and unresolvable edges', () => {
    const duplicated = snapshot({
      nodes: [...snapshot().nodes, { ...snapshot().nodes[0]!, title: 'A again' }],
    })
    expect(() =>
      decodeWorkGraphChange({ kind: 'workgraph/change', version: 1, graph: duplicated }),
    ).toThrow('duplicate ids')
    const dangling = snapshot({
      nodes: [
        { id: WorkNodeId('gn-cccccccc'), title: 'C', spec: 'do c', blocks: [WorkNodeId('gn-deadbeef')], state: 'waiting', rounds: 0 },
      ],
    })
    expect(() =>
      decodeWorkGraphChange({ kind: 'workgraph/change', version: 1, graph: dangling }),
    ).toThrow('blocks unlisted node gn-deadbeef')
    const orphanProvenance = snapshot({
      nodes: snapshot().nodes.map(node =>
        node.id === NODE_B ? { ...node, discoveredFrom: [WorkNodeId('gn-deadbeef')] } : node,
      ),
    })
    expect(() =>
      decodeWorkGraphChange({ kind: 'workgraph/change', version: 1, graph: orphanProvenance }),
    ).toThrow('discovers from unlisted node gn-deadbeef')
  })

  it('absorbs a non-string history kind without inventing detail', () => {
    const raw = JSON.parse(JSON.stringify(snapshot())) as Record<string, unknown[]>
    raw['history'] = [{ at: 7, kind: 7 }]
    const meta = decodeWorkGraphChange({ kind: 'workgraph/change', version: 1, graph: raw })
    expect(meta && 'graph' in meta && meta.graph.history[0]).toEqual({ at: 7, kind: 'unknown' })
  })

  it('rejects malformed node, history, and discovery records precisely', () => {
    const bad = (graph: unknown) =>
      decodeWorkGraphChange({ kind: 'workgraph/change', version: 1, graph })
    expect(() => bad('not-a-record')).toThrow('workgraph change graph must be a record')
    expect(() => bad({ ...snapshot(), nodes: [7] })).toThrow('nodes[0] must be a record')
    expect(() =>
      bad({
        ...snapshot(),
        nodes: [{ id: 'not-gn', title: 'A', spec: 'do a', blocks: [], state: 'ready', rounds: 0 }],
      }),
    ).toThrow('must be a canonical gn- node id')
    expect(() =>
      bad({
        ...snapshot(),
        nodes: [{ id: 'gn-aaaaaaaa', title: 'A', spec: 'do a', blocks: 'x', state: 'ready', rounds: 0 }],
      }),
    ).toThrow('blocks must be an array of node ids')
    expect(() =>
      bad({
        ...snapshot(),
        nodes: [{ id: 'gn-aaaaaaaa', title: 'A', spec: 'do a', blocks: [], state: 'ready', rounds: -1 }],
      }),
    ).toThrow('rounds must be a non-negative safe integer')
    expect(() =>
      bad({
        ...snapshot(),
        nodes: [{ id: 'gn-aaaaaaaa', title: 'A', spec: 'do a', blocks: [], state: 'ready', rounds: 0, failure: 5 }],
      }),
    ).toThrow('nodes[0].failure')
    expect(() =>
      bad({
        ...snapshot(),
        nodes: [{
          id: 'gn-aaaaaaaa',
          title: 'A',
          spec: 'do a',
          blocks: [],
          state: 'ready',
          rounds: 0,
          discoveredFrom: ['gn-ffffffff'],
        }],
      }),
    ).toThrow('discovers from unlisted node')
    expect(() => bad({ ...snapshot(), history: ['x'] })).toThrow('history[0] must be a record')
    expect(() =>
      bad({ ...snapshot(), history: [{ at: 1, kind: 'node-started', detail: 5 }] }),
    ).toThrow('history[0].detail')
    expect(() => bad({ ...snapshot(), history: [{ at: 1 }] })).toThrow('history[0] must have exactly')
    expect(() => bad({ ...snapshot(), pendingDiscoveries: ['x'] })).toThrow(
      'pendingDiscoveries[0] must be a record',
    )
    expect(() =>
      bad({ ...snapshot(), pendingDiscoveries: [{ description: '', from: 'gn-aaaaaaaa' }] }),
    ).toThrow('pendingDiscoveries[0].description')
  })
})

describe('foldWorkGraph', () => {
  it('folds an empty stream to no graph', () => {
    expect(foldWorkGraph([])).toEqual({})
  })

  it('ignores events of other types', () => {
    const other = { type: 'user/message', seq: 1, time: 1 } as unknown as SessionEvent
    expect(foldWorkGraph([other])).toEqual({})
    // Interleaved foreign events are skipped, the graph still folds.
    const folded = foldWorkGraph([
      other,
      changeEvent({ kind: 'workgraph/change', version: 1, graph: snapshot() }, 2),
      other,
    ])
    expect(folded.graph).toEqual(snapshot())
  })

  it('skips workgraph events that decode to nothing', () => {
    const folded = foldWorkGraph([
      { type: 'workgraph/change', seq: 1, data: { kind: 'other' } } as unknown as SessionEvent,
      changeEvent({ kind: 'workgraph/change', version: 1, graph: snapshot() }, 2),
    ])
    expect(folded.graph).toEqual(snapshot())
  })

  it('keeps the graph and the clearedAt after a clear followed by a new graph', () => {
    const folded = foldWorkGraph([
      changeEvent({ kind: 'workgraph/change', version: 1, graph: snapshot() }, 1),
      changeEvent(
        { kind: 'workgraph/change', version: 1, operation: 'clear', cleared: WorkGraphId('wg-1'), clearedAt: 30 },
        2,
      ),
      changeEvent({ kind: 'workgraph/change', version: 1, graph: snapshot() }, 3),
    ])
    expect(folded.graph).toEqual(snapshot())
    expect(folded.clearedAt).toBe(30)
  })

  it('decodes a node with a listed discovered-from origin', () => {
    const graph = snapshot({
      nodes: [
        {
          id: WorkNodeId('gn-aaaaaaaa'),
          title: 'A',
          spec: 'do a',
          blocks: [],
          state: 'ready',
          rounds: 0,
          discoveredFrom: [WorkNodeId('gn-bbbbbbbb')],
        },
        { id: WorkNodeId('gn-bbbbbbbb'), title: 'B', spec: 'do b', blocks: [], state: 'ready', rounds: 0 },
      ],
    })
    const decoded = decodeWorkGraphChange({ kind: 'workgraph/change', version: 1, graph })
    expect(decoded).not.toBeUndefined()
    if (decoded !== undefined && 'graph' in decoded) expect(decoded.graph).toEqual(graph)
  })

  it('reconstructs the latest snapshot byte-for-byte', () => {
    const first = snapshot()
    const second = snapshot({ status: 'complete', updatedAt: 20 })
    const folded = foldWorkGraph([
      changeEvent({ kind: 'workgraph/change', version: 1, graph: first }, 1),
      changeEvent({ kind: 'workgraph/change', version: 1, graph: second }, 2),
    ])
    expect(folded.graph).toEqual(second)
    expect(folded.clearedAt).toBeUndefined()
  })

  it('records the clear tombstone and drops the graph', () => {
    const cleared = foldWorkGraph([
      changeEvent({ kind: 'workgraph/change', version: 1, graph: snapshot() }, 1),
      changeEvent(
        { kind: 'workgraph/change', version: 1, operation: 'clear', cleared: WorkGraphId('wg-1'), clearedAt: 30 },
        2,
      ),
    ])
    expect(cleared.graph).toBeUndefined()
    expect(cleared.clearedAt).toBe(30)
  })

  it('rejects identity switches, creation-time rewrites, and rewinds', () => {
    const first = snapshot()
    expect(() =>
      foldWorkGraph([
        changeEvent({ kind: 'workgraph/change', version: 1, graph: first }, 1),
        changeEvent({ kind: 'workgraph/change', version: 1, graph: snapshot({ id: WorkGraphId('wg-2') }) }, 2),
      ]),
    ).toThrow('cannot switch graph identity')
    expect(() =>
      foldWorkGraph([
        changeEvent({ kind: 'workgraph/change', version: 1, graph: first }, 1),
        changeEvent({ kind: 'workgraph/change', version: 1, graph: snapshot({ createdAt: 1 }) }, 2),
      ]),
    ).toThrow('cannot rewrite the current graph creation time')
    expect(() =>
      foldWorkGraph([
        changeEvent({ kind: 'workgraph/change', version: 1, graph: first }, 1),
        changeEvent({ kind: 'workgraph/change', version: 1, graph: snapshot({ updatedAt: 5 }) }, 2),
      ]),
    ).toThrow('must not rewind the current graph')
    expect(() =>
      foldWorkGraph([
        changeEvent({ kind: 'workgraph/change', version: 1, graph: snapshot({ planVersion: 2 }) }, 1),
        changeEvent({ kind: 'workgraph/change', version: 1, graph: snapshot({ planVersion: 1, updatedAt: 20 }) }, 2),
      ]),
    ).toThrow('must not rewind the current graph')
  })
})
