/**
 * workgraph-definition fold tests: the chat node reconstructs the identical
 * layered view from the session log's workgraph/change events, across replay
 * and live append, through clear tombstones, and with deterministic layering.
 * @module
 */

import { describe, expect, it } from 'vitest'
import {
  ConversationNodeAssembler, type ConversationEventInput,
  type ConversationNodeDefinition, type ConversationViewDefinition,
  type ChatConversationViewNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  WorkGraphChatData, WorkGraphNodeData, WorkGraphNodeState,
} from '../src/client/workgraph-definition.ts'
import { decodeGraphChange, isGraphStartChange, layerNodes, workgraphDefinition } from '../src/client/workgraph-definition.ts'
import type {} from '../src/client/index.ts'

interface ChatSnapshot {
  readonly nodes: ReadonlyMap<string, ChatConversationViewNode>
}

class TestEventDefinitions {
  entries(): readonly ConversationNodeDefinition[] { return [workgraphDefinition] }
  fallbackEntry(): undefined { return undefined }
}

class TestViewDefinitions {
  entries(): readonly ConversationViewDefinition[] { return [chatViewDefinition] }
}

const chatViewDefinition: ConversationViewDefinition<ChatConversationViewNode, ChatSnapshot> = {
  target: 'chat',
  create: () => {
    let nodes = new Map<string, ChatConversationViewNode>()
    const snapshot = (): ChatSnapshot => ({ nodes })
    return {
      empty: snapshot(),
      replace: ({ nodes: values }) => {
        nodes = new Map(values.map(node => [node.key, node]))
        return snapshot()
      },
      apply: ({ upserts }) => {
        nodes = new Map(nodes)
        for (const node of upserts) nodes.set(node.key, node)
        return snapshot()
      },
    }
  },
}

function at(seq: number, data: unknown): ConversationEventInput {
  return { event: { seq, time: seq * 100, type: 'workgraph/change', data } as ConversationEventInput['event'], view: undefined }
}

function assembler(entries: readonly ConversationEventInput[], hasMore = false): ConversationNodeAssembler {
  const value = new ConversationNodeAssembler(new TestEventDefinitions(), new TestViewDefinitions())
  value.replaceWindow(entries, hasMore)
  value.flush()
  return value
}

function graphData(value: ConversationNodeAssembler): WorkGraphChatData | undefined {
  const snapshot = value.snapshot('chat') as ChatSnapshot
  return [...snapshot.nodes.values()][0]?.data as WorkGraphChatData | undefined
}

function node(
  id: string,
  title: string,
  state: WorkGraphNodeState,
  blocks: string[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id, title, spec: `spec of ${title}`, state, rounds: 0, blocks,
    ...extra,
  }
}

const A = 'gn-aaaaaaaa'
const B = 'gn-bbbbbbbb'
const C = 'gn-cccccccc'
const FINAL = 'gn-final'

function snapshotChange(seq: number, over: Record<string, unknown> = {}): ConversationEventInput {
  const graph: Record<string, unknown> = {
    id: 'wg-1',
    objective: 'ship it',
    status: 'active',
    planVersion: 1,
    nodes: [
      node(A, 'A', 'ready', []),
      node(B, 'B', 'waiting', [A]),
      node(FINAL, 'Final verification', 'waiting', [A, B], { final: true }),
    ],
    pendingDiscoveries: [{ description: 'more work', from: A }],
    history: [{ at: 1, kind: 'created' }],
    tokensSpent: 3,
    tokenBudget: 10,
    replanRuns: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
  return at(seq, { kind: 'workgraph/change', version: 1, graph })
}

function completeEvents(): ConversationEventInput[] {
  // Real dispatchSet shape: the first commit already carries BOTH `created`
  // and `planning-started` (planning begins before the first checkpoint),
  // so the fixture starts at that two-kind history and appends exactly one
  // kind per later change — the first event is the unique start, the rest
  // are updates.
  const set = snapshotChange(1, {
    history: [{ at: 1, kind: 'created' }, { at: 1, kind: 'planning-started' }],
  })
  const planned = snapshotChange(3, {
    history: [
      { at: 1, kind: 'created' }, { at: 1, kind: 'planning-started' },
      { at: 2, kind: 'planning-completed' },
    ],
    // Every post-creation transition bumps updatedAt (createdAt stays 1);
    // the history entries a checkpoint adds carry that checkpoint's
    // updatedAt as their `at` (real payloads share one `now` per checkpoint).
    updatedAt: 2,
  })
  const achieved = snapshotChange(4, {
    status: 'complete',
    nodes: [
      node(A, 'A', 'achieved', [], { rounds: 1 }),
      node(B, 'B', 'achieved', [A], { rounds: 1 }),
      node(FINAL, 'Final verification', 'achieved', [A, B], { rounds: 1, final: true }),
    ],
    pendingDiscoveries: [],
    tokensSpent: 18,
    updatedAt: 3,
    history: [
      { at: 1, kind: 'created' }, { at: 1, kind: 'planning-started' },
      { at: 2, kind: 'planning-completed' }, { at: 3, kind: 'completed' },
    ],
  })
  return [set, planned, achieved]
}

describe('workgraph-definition', () => {
  it('decodes graph-bearing and clear changes defensively', () => {
    const decoded = decodeGraphChange({ kind: 'workgraph/change', version: 1, graph: { id: 'wg-1' } })
    expect(decoded).toBeNull()
    const full = decodeGraphChange(snapshotChange(1).event.data)
    expect(full).not.toBeNull()
    expect(full!.graphId).toBe('wg-1')
    expect(full!.snapshot!.objective).toBe('ship it')
    expect(full!.historyKinds).toEqual(['created'])
    expect(full!.createdAt).toBe(1)
    expect(full!.updatedAt).toBe(1)
    // Non-number timestamps are omitted from the decode (never coerced).
    const noStamps = decodeGraphChange({ kind: 'workgraph/change', version: 1, graph: {
      id: 'wg-1', objective: 'o', status: 'active', planVersion: 1, nodes: [], tokensSpent: 0,
      createdAt: 'nope', updatedAt: null,
    } })
    expect(noStamps).not.toBeNull()
    expect(noStamps!.createdAt).toBeUndefined()
    expect(noStamps!.updatedAt).toBeUndefined()
    const clear = decodeGraphChange({ kind: 'workgraph/change', version: 1, operation: 'clear', cleared: 'wg-1', clearedAt: 9 })
    expect(clear).toEqual({ graphId: 'wg-1', cleared: true, historyKinds: [] })
    expect(decodeGraphChange(null)).toBeNull()
    expect(decodeGraphChange({ kind: 'other' })).toBeNull()
  })

  it('rejects malformed change payloads defensively', () => {
    expect(decodeGraphChange({ kind: 'workgraph/change', version: 1, operation: 'clear', cleared: 7 })).toBeNull()
    expect(decodeGraphChange({ kind: 'workgraph/change', version: 1, graph: 'nope' })).toBeNull()
    expect(decodeGraphChange({ kind: 'workgraph/change', version: 1, graph: { id: 'wg-1', objective: 7, status: 'active', planVersion: 1, nodes: [], tokensSpent: 0 } })).toBeNull()
    const badRow = decodeGraphChange({ kind: 'workgraph/change', version: 1, graph: { id: 'wg-1', objective: 'o', status: 'active', planVersion: 1, nodes: [7], tokensSpent: 0 } })
    expect(badRow).toBeNull()
    const badFields = decodeGraphChange({ kind: 'workgraph/change', version: 1, graph: { id: 'wg-1', objective: 'o', status: 'active', planVersion: 1, nodes: [{ id: 'a', title: 'A', spec: 's', state: 'ready', rounds: 'x', blocks: [] }], tokensSpent: 0 } })
    expect(badFields).toBeNull()
    const badBlocks = decodeGraphChange({ kind: 'workgraph/change', version: 1, graph: { id: 'wg-1', objective: 'o', status: 'active', planVersion: 1, nodes: [{ id: 'a', title: 'A', spec: 's', state: 'ready', rounds: 0, blocks: [7] }], tokensSpent: 0 } })
    expect(badBlocks).toBeNull()
    // A non-array discoveredFrom is omitted; a non-array history degrades to none.
    const decoded = decodeGraphChange({ kind: 'workgraph/change', version: 1, graph: { id: 'wg-1', objective: 'o', status: 'active', planVersion: 1, nodes: [{ id: 'a', title: 'A', spec: 's', state: 'ready', rounds: 0, blocks: [], discoveredFrom: 'nope' }], tokensSpent: 0, history: 'nope' } })
    expect(decoded).not.toBeNull()
    expect(decoded!.snapshot!.nodes[0]!.discoveredFrom).toBeUndefined()
    expect(decoded!.historyKinds).toEqual([])
  })

  it('recognizes the set commit as the unique start change', () => {
    // Creation-fact branch (createdAt === updatedAt): the default fixture is
    // the set commit, whatever its history shape is — including the real
    // dispatchSet two-kind history and the historyMax=1 truncated shape.
    expect(isGraphStartChange(decodeGraphChange(snapshotChange(1).event.data)!)).toBe(true)
    expect(isGraphStartChange(decodeGraphChange(snapshotChange(2, {
      history: [{ at: 1, kind: 'created' }, { at: 1, kind: 'planning-started' }],
    }).event.data)!)).toBe(true)
    expect(isGraphStartChange(decodeGraphChange(snapshotChange(3, {
      history: [{ at: 3, kind: 'planning-started' }],
    }).event.data)!)).toBe(true)
    // The same events with a bumped updatedAt are later transitions — never starts.
    expect(isGraphStartChange(decodeGraphChange(snapshotChange(2, {
      history: [{ at: 1, kind: 'created' }, { at: 1, kind: 'planning-started' }],
      updatedAt: 2,
    }).event.data)!)).toBe(false)
    expect(isGraphStartChange(decodeGraphChange(snapshotChange(3, {
      history: [{ at: 3, kind: 'planning-started' }],
      updatedAt: 2,
    }).event.data)!)).toBe(false)
    // Fallback for payloads without timestamps: the history shapes.
    // A lone `created` entry and the real created+planning-started both start;
    // every later shape (>= 3 kinds, a non-created head, created without
    // planning-started at length 2) is an update.
    const stampLess = (over: Record<string, unknown> = {}) =>
      decodeGraphChange({ kind: 'workgraph/change', version: 1, graph: {
        id: 'wg-1', objective: 'o', status: 'active', planVersion: 1,
        nodes: [{ id: 'a', title: 'A', spec: 's', state: 'ready', rounds: 0, blocks: [] }],
        tokensSpent: 0,
        ...over,
      } })!
    expect(isGraphStartChange(stampLess({ history: [{ at: 1, kind: 'created' }] }))).toBe(true)
    expect(isGraphStartChange(stampLess({
      history: [{ at: 1, kind: 'created' }, { at: 1, kind: 'planning-started' }],
    }))).toBe(true)
    expect(isGraphStartChange(stampLess({
      history: [
        { at: 1, kind: 'created' }, { at: 1, kind: 'planning-started' },
        { at: 3, kind: 'planning-completed' },
      ],
    }))).toBe(false)
    expect(isGraphStartChange(stampLess({ history: [{ at: 1, kind: 'node-started' }] }))).toBe(false)
    expect(isGraphStartChange(stampLess({
      history: [{ at: 1, kind: 'planning-started' }, { at: 1, kind: 'created' }],
    }))).toBe(false)
    expect(isGraphStartChange(stampLess({
      history: [{ at: 1, kind: 'created' }, { at: 1, kind: 'planning-completed' }],
    }))).toBe(false)
    // A single timestamp still falls back to the history shapes — in either
    // direction: createdAt without updatedAt, or updatedAt without createdAt.
    expect(isGraphStartChange(stampLess({ createdAt: 1, history: [{ at: 1, kind: 'created' }] }))).toBe(true)
    expect(isGraphStartChange(stampLess({ updatedAt: 2, history: [{ at: 1, kind: 'created' }] }))).toBe(true)
    // A snapshot-less record is not a start, and neither is a clear tombstone.
    expect(isGraphStartChange({ graphId: 'wg-x', cleared: false, historyKinds: [] })).toBe(false)
    expect(isGraphStartChange(decodeGraphChange({ kind: 'workgraph/change', version: 1, operation: 'clear', cleared: 'wg-1', clearedAt: 9 })!)).toBe(false)
  })

  it('folds the graph lifecycle into one chat node with deterministic layers', () => {
    const value = assembler(completeEvents())
    const data = graphData(value)
    expect(data).toEqual({
      objective: 'ship it',
      status: 'complete',
      planVersion: 1,
      layers: [
        [expect.objectContaining({ id: A, state: 'achieved' })],
        [expect.objectContaining({ id: B, state: 'achieved' })],
        [expect.objectContaining({ id: FINAL, state: 'achieved', final: true })],
      ],
      tokensSpent: 18,
      tokenBudget: 10,
      pendingDiscoveries: 0,
    })
    const node = [...(value.snapshot('chat') as ChatSnapshot).nodes.values()][0]!
    expect(node.kind).toBe('workgraph')
    expect(node.anchorSeq).toBe(1)
  })

  it('reconstructs the identical view on reload and live append', () => {
    const events = completeEvents()
    const replay = assembler(events)
    const live = assembler(events.slice(0, 1))
    for (const event of events.slice(1)) live.append(event)
    live.flush()
    expect(graphData(live)).toEqual(graphData(replay))
  })

  it('keeps separate nodes per graph identity', () => {
    const second = snapshotChange(5, {
      id: 'wg-2',
      objective: 'second graph',
      nodes: [node(A, 'A2', 'ready', []), node(FINAL, 'Final verification', 'waiting', [A], { final: true })],
      history: [{ at: 5, kind: 'created' }],
      createdAt: 5,
      updatedAt: 5,
    })
    const value = assembler([...completeEvents(), second])
    const nodes = [...(value.snapshot('chat') as ChatSnapshot).nodes.values()]
    expect(nodes).toHaveLength(2)
  })

  it('tombstones the node on clear', () => {
    const events = [...completeEvents(), at(9, {
      kind: 'workgraph/change', version: 1, operation: 'clear', cleared: 'wg-1', clearedAt: 9,
    })]
    const value = assembler(events)
    const nodes = [...(value.snapshot('chat') as ChatSnapshot).nodes.values()]
    expect(nodes.filter(node => node.kind === 'workgraph')).toHaveLength(0)
  })

  it('ignores malformed and foreign change events', () => {
    const malformed = at(2, { kind: 'workgraph/change', version: 1, graph: { id: 'wg-1' } })
    const foreign = at(3, { kind: 'other/event' })
    const value = assembler([snapshotChange(1), malformed, foreign, ...completeEvents().slice(1)])
    expect(graphData(value)?.status).toBe('complete')
  })

  it('covers the remaining decode and fold edges', () => {
    // A valid discoveredFrom array is included; a failure string is kept;
    // a pause reason lands on the payload.
    const decoded = decodeGraphChange({ kind: 'workgraph/change', version: 1, graph: {
      id: 'wg-1', objective: 'o', status: 'user_paused', planVersion: 1,
      nodes: [{ id: 'a', title: 'A', spec: 's', state: 'failed', rounds: 1, blocks: [], discoveredFrom: ['gn-other'], failure: 7 }],
      tokensSpent: 0, pauseReason: 'restored',
    } })
    expect(decoded!.snapshot!.nodes[0]!.discoveredFrom).toEqual(['gn-other'])
    expect(decoded!.snapshot!.nodes[0]!.failure).toBe('7')
    expect(decoded!.snapshot!.pauseReason).toBe('restored')
    // An empty node set layers to zero rows.
    expect(layerNodes([])).toEqual([])
    // The match and start guard against non-workgraph events directly.
    expect(workgraphDefinition.match({ type: 'other/event', seq: 1, time: 1, data: {} } as never)).toBeNull()
    expect(() => workgraphDefinition.start({} as never, { event: { type: 'other/event' } } as never, {} as never))
      .toThrow('workgraph start requires workgraph/change')
    // A graph-bearing but undecodable start change is refused too.
    expect(() => workgraphDefinition.start({} as never, {
      event: { type: 'workgraph/change', seq: 1, time: 1, data: { kind: 'workgraph/change', version: 1, graph: { id: 'wg-1' } } },
    } as never, {} as never)).toThrow('requires a graph-bearing change')
    // The update guards: foreign events and undecodable changes keep the
    // current state; a missing state degrades to a tombstone.
    const state = { snapshot: null }
    expect(workgraphDefinition.update({ state } as never, { event: { type: 'other/event' } } as never)).toBe(state)
    expect(workgraphDefinition.update({ state } as never, {
      event: { type: 'workgraph/change', seq: 1, time: 1, data: { kind: 'workgraph/change', version: 1, graph: { id: 'x' } } },
    } as never)).toBe(state)
    expect(workgraphDefinition.update({} as never, { event: { type: 'other/event' } } as never))
      .toEqual({ snapshot: null })
    expect(workgraphDefinition.update({} as never, {
      event: { type: 'workgraph/change', seq: 1, time: 1, data: { kind: 'workgraph/change', version: 1, graph: { id: 'x' } } },
    } as never)).toEqual({ snapshot: null })
  })

  it('layers chains, diamonds, and degrades cycles', () => {
    const chain: WorkGraphNodeData[] = [
      { id: A, title: 'A', spec: 'a', state: 'ready', rounds: 0, blocks: [], final: false },
      { id: B, title: 'B', spec: 'b', state: 'waiting', rounds: 0, blocks: [A], final: false },
      { id: FINAL, title: 'F', spec: 'f', state: 'waiting', rounds: 0, blocks: [A, B], final: true },
    ]
    const chainLayers = layerNodes(chain)
    expect(chainLayers.map(row => row.map(node => node.id))).toEqual([[A], [B], [FINAL]])
    const cyclic: WorkGraphNodeData[] = [
      { id: A, title: 'A', spec: 'a', state: 'waiting', rounds: 0, blocks: [B], final: false },
      { id: B, title: 'B', spec: 'b', state: 'waiting', rounds: 0, blocks: [A], final: false },
    ]
    // The layering guard refuses to loop; every member degrades to layer 0.
    expect(layerNodes(cyclic).map(row => row.map(node => node.id))).toEqual([[A, B]])
    // Unknown blocks are skipped, never an error.
    expect(layerNodes([...chain, { id: C, title: 'C', spec: 'c', state: 'waiting', rounds: 0, blocks: ['gn-unknown'], final: false }]))
      .toHaveLength(3)
  })

  it('issues exactly one start per graph (the engine would reject a second)', () => {
    // The fold tests above already exercise the full lifecycle; this
    // documents the invariant the set-commit start relies on: only the set
    // event has createdAt === updatedAt, so exactly one start per graph.
    const starts = completeEvents().filter(event => isGraphStartChange(decodeGraphChange(event.event.data)!))
    expect(starts).toHaveLength(1)
  })

  it('materializes the DAG from the real dispatch event stream (regression: the set commit carries created+planning-started)', () => {
    // Real scheduler payloads, captured from a live run: dispatchSet commits
    // the pending graph with BOTH `created` and `planning-started` in the
    // FIRST change's history (planning begins before the first checkpoint),
    // then planning-completed on install, then node-started. The first event
    // is the set commit (createdAt === updatedAt) and must materialize the
    // chat node; later events bump updatedAt and must update it live —
    // a folded DAG that silently stays absent is this regression.
    const set = snapshotChange(1, {
      nodes: [],
      history: [
        { at: 1, kind: 'created' },
        { at: 1, kind: 'planning-started' },
      ],
    })
    const planned = snapshotChange(2, {
      history: [
        { at: 1, kind: 'created' },
        { at: 1, kind: 'planning-started' },
        { at: 2, kind: 'planning-completed' },
      ],
      updatedAt: 2,
    })
    const running = snapshotChange(3, {
      nodes: [
        node(A, 'A', 'running', []),
        node(B, 'B', 'waiting', [A]),
        node(FINAL, 'Final verification', 'waiting', [A, B], { final: true }),
      ],
      history: [
        { at: 1, kind: 'created' },
        { at: 1, kind: 'planning-started' },
        { at: 2, kind: 'planning-completed' },
        { at: 3, kind: 'node-started' },
      ],
      updatedAt: 3,
    })
    const live = assembler([set])
    expect(graphData(live)?.status).toBe('active')
    live.append(planned)
    live.flush()
    expect(graphData(live)?.layers.flat().length).toBe(3)
    live.append(running)
    live.flush()
    expect(graphData(live)?.status).toBe('active')
    expect(graphData(live)?.layers.flat().find(entry => entry.id === A)?.state).toBe('running')
    // The same stream reconstructs identically on reload.
    const replay = assembler([set, planned, running])
    expect(graphData(replay)).toEqual(graphData(live))
  })
})
