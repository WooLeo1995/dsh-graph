/**
 * Panel snapshot assembly tests: the pure projection (longest-chain depths,
 * final marker, failure passthrough, optional fields) and the lazy
 * `/plugins/dsh-workgraph/state` route registration (response shape,
 * no-store header, webless degradation, late web-server binding).
 * @module
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { commitWorkGraphChange, WorkGraphId, WorkNodeId } from '@deepseek-ai/dsh-workgraph'
import type { WorkGraphLimits, WorkGraphSnapshot } from '@deepseek-ai/dsh-workgraph'
import {
  assemblePanelSnapshot,
  canonicalNodeId,
  initializeGraph,
  installPlan,
  WorkGraphScheduler,
} from '@deepseek-ai/dsh-workgraph-scheduler'

const LIMITS: WorkGraphLimits = { maxNodes: 24, historyMax: 64 }

function stubAgent(id = 'workgraph-snapshot-test'): Agent {
  const session = Session.create(SessionId(id))
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  return {
    id: session.id,
    options: {},
    session,
    inbox,
    ctx: new Context(),
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/** Install a plan plus the gated final node, as an initialized graph. */
function graphOf(
  plan: { nodes: Array<{ id: string; title: string; spec: string; deps: string[] }> },
  objective: string,
): WorkGraphSnapshot {
  return initializeGraph(WorkGraphId('wg-snapshot'), objective, installPlan(plan, objective, LIMITS), LIMITS, 100)
}

describe('assemblePanelSnapshot', () => {
  it('projects longest-chain depths for a chain with the final node deepest', () => {
    const snapshot = graphOf(
      { nodes: [{ id: 'a', title: 'A', spec: 'do a', deps: [] }, { id: 'c', title: 'C', spec: 'do c', deps: ['a'] }] },
      'ship the chain',
    )
    const panel = assemblePanelSnapshot('session-1', snapshot)
    const depth = new Map(panel.nodes.map(node => [node.id, node.depth]))
    expect(depth.get(canonicalNodeId('a'))).toBe(0)
    expect(depth.get(canonicalNodeId('c'))).toBe(1)
    expect(depth.get(WorkNodeId('gn-final'))).toBe(2)
  })

  it('projects longest-chain depths for a diamond (shared deepest dependency wins)', () => {
    const snapshot = graphOf(
      {
        nodes: [
          { id: 'a', title: 'A', spec: 'do a', deps: [] },
          { id: 'b', title: 'B', spec: 'do b', deps: [] },
          { id: 'c', title: 'C', spec: 'do c', deps: ['a', 'b'] },
        ],
      },
      'ship the diamond',
    )
    const panel = assemblePanelSnapshot('session-1', snapshot)
    const depth = new Map(panel.nodes.map(node => [node.id, node.depth]))
    expect(depth.get(canonicalNodeId('a'))).toBe(0)
    expect(depth.get(canonicalNodeId('b'))).toBe(0)
    expect(depth.get(canonicalNodeId('c'))).toBe(1)
    expect(depth.get(WorkNodeId('gn-final'))).toBe(2)
  })

  it('degrades cyclic foreign data to depth 0 and skips unknown blocks', () => {
    const cyclic: WorkGraphSnapshot = {
      id: WorkGraphId('wg-cycle'),
      objective: 'cycle',
      status: 'active',
      planVersion: 1,
      nodes: [
        { id: canonicalNodeId('x'), title: 'X', spec: 'x', state: 'ready', rounds: 0, blocks: [canonicalNodeId('y')] },
        { id: canonicalNodeId('y'), title: 'Y', spec: 'y', state: 'ready', rounds: 0, blocks: [canonicalNodeId('x')] },
        { id: canonicalNodeId('z'), title: 'Z', spec: 'z', state: 'ready', rounds: 0, blocks: [WorkNodeId('gn-unknown')] },
      ],
      pendingDiscoveries: [],
      history: [],
      tokensSpent: 0,
      replanRuns: 0,
      createdAt: 1,
      updatedAt: 1,
    }
    const panel = assemblePanelSnapshot('session-1', cyclic)
    const depth = new Map(panel.nodes.map(node => [node.id, node.depth]))
    expect(depth.get(canonicalNodeId('x'))).toBe(0)
    expect(depth.get(canonicalNodeId('y'))).toBe(0)
    // Unknown dependency ids are skipped, never an error: z stays at 0.
    expect(depth.get(canonicalNodeId('z'))).toBe(0)
  })

  it('marks the harness final node and passes failure through', () => {
    const base = graphOf(
      { nodes: [{ id: 'a', title: 'A', spec: 'do a', deps: [] }, { id: 'b', title: 'B', spec: 'do b', deps: ['a'] }] },
      'ship it',
    )
    const failed: WorkGraphSnapshot = {
      ...base,
      nodes: base.nodes.map(node => node.id === canonicalNodeId('a')
        ? { ...node, state: 'failed', rounds: 2, failure: 'boom' }
        : node),
    }
    const panel = assemblePanelSnapshot('session-1', failed)
    const byId = new Map(panel.nodes.map(node => [node.id, node]))
    expect(byId.get(WorkNodeId('gn-final'))!.final).toBe(true)
    expect(byId.get(canonicalNodeId('a'))!.final).toBe(false)
    expect(byId.get(canonicalNodeId('a'))!.state).toBe('failed')
    expect(byId.get(canonicalNodeId('a'))!.rounds).toBe(2)
    expect(byId.get(canonicalNodeId('a'))!.failure).toBe('boom')
    expect(byId.get(canonicalNodeId('b'))!.failure).toBeUndefined()
  })

  it('passes graph fields through and counts pending discoveries', () => {
    const base = graphOf(
      { nodes: [{ id: 'a', title: 'A', spec: 'do a', deps: [] }] },
      'ship it',
    )
    const rich: WorkGraphSnapshot = {
      ...base,
      status: 'user_paused',
      pauseReason: 'user asked',
      tokenBudget: 500,
      tokensSpent: 42,
      pendingDiscoveries: [
        { description: 'more work', from: canonicalNodeId('a') },
        { description: 'even more', from: canonicalNodeId('a') },
      ],
    }
    const panel = assemblePanelSnapshot('session-9', rich)
    expect(panel.sessionId).toBe('session-9')
    expect(panel.graphId).toBe(rich.id)
    expect(panel.objective).toBe('ship it')
    expect(panel.status).toBe('user_paused')
    expect(panel.pauseReason).toBe('user asked')
    expect(panel.planVersion).toBe(1)
    expect(panel.tokensSpent).toBe(42)
    expect(panel.tokenBudget).toBe(500)
    expect(panel.pendingDiscoveries).toBe(2)
  })

  it('omits optional fields when absent and handles an empty graph', () => {
    const empty: WorkGraphSnapshot = {
      id: WorkGraphId('wg-empty'),
      objective: 'nothing yet',
      status: 'active',
      planVersion: 1,
      nodes: [],
      pendingDiscoveries: [],
      history: [],
      tokensSpent: 0,
      replanRuns: 0,
      createdAt: 1,
      updatedAt: 1,
    }
    const panel = assemblePanelSnapshot('session-1', empty)
    expect(panel.nodes).toEqual([])
    expect(panel.pendingDiscoveries).toBe(0)
    expect(panel.tokenBudget).toBeUndefined()
    expect(panel.pauseReason).toBeUndefined()
  })
})

describe('panel state route', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'workgraph-snapshot-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  interface CapturedRoute {
    kind: string
    path: string
    handler: (req: unknown, res: unknown) => void | Promise<void>
  }

  function fakeWebServer(routes: CapturedRoute[]): { register(route: CapturedRoute): () => void } {
    return {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    }
  }

  function fakeRes(): {
    readonly status: number
    readonly headers: Record<string, string>
    readonly body: string
    writeHead(code: number, headers: Record<string, string>): void
    end(chunk: string): void
  } {
    const state = { status: 0, headers: {} as Record<string, string>, body: '' }
    return {
      get status() { return state.status },
      get headers() { return state.headers },
      get body() { return state.body },
      writeHead: (code, headers) => {
        state.status = code
        state.headers = headers
      },
      end: (chunk) => {
        state.body = chunk
      },
    }
  }

  it('registers the exact no-store state route when the web server is present', () => {
    const ctx = new Context()
    const routes: CapturedRoute[] = []
    ctx.provide('webServer', fakeWebServer(routes))
    const s = new WorkGraphScheduler(ctx, { workgraphDir: dir })
    expect(routes).toHaveLength(1)
    expect(routes[0]!.kind).toBe('exact')
    expect(routes[0]!.path).toBe('/plugins/dsh-workgraph/state')
    // The scheduler instance stays usable headlessly.
    expect(s).toBeInstanceOf(WorkGraphScheduler)
  })

  it('serves one panel snapshot per session that owns a graph, with no-store headers', async () => {
    const ctx = new Context()
    const routes: CapturedRoute[] = []
    ctx.provide('webServer', fakeWebServer(routes))
    const withGraph = stubAgent('workgraph-with-graph')
    const withoutGraph = stubAgent('workgraph-without-graph')
    const snapshot = graphOf(
      { nodes: [{ id: 'a', title: 'A', spec: 'do a', deps: [] }] },
      'ship it',
    )
    commitWorkGraphChange(ctx, withGraph, { kind: 'workgraph/change', version: 1, graph: snapshot }, 'set')
    ctx.provide('agents', { list: () => [withGraph, withoutGraph] })
    const s = new WorkGraphScheduler(ctx, { workgraphDir: dir })
    const res = fakeRes()
    await routes[0]!.handler({}, res)
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8')
    const payload = JSON.parse(res.body) as { graphs: Array<{ sessionId: string; objective: string }> }
    expect(payload.graphs).toHaveLength(1)
    expect(payload.graphs[0]!.sessionId).toBe(withGraph.id)
    expect(payload.graphs[0]!.objective).toBe('ship it')
    expect(s).toBeInstanceOf(WorkGraphScheduler)
  })

  it('returns an empty graphs list without the agents service', async () => {
    const ctx = new Context()
    const routes: CapturedRoute[] = []
    ctx.provide('webServer', fakeWebServer(routes))
    const s = new WorkGraphScheduler(ctx, { workgraphDir: dir })
    const res = fakeRes()
    await routes[0]!.handler({}, res)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ graphs: [] })
    expect(s).toBeInstanceOf(WorkGraphScheduler)
  })

  it('skips a throwing agent session without breaking the response', async () => {
    const ctx = new Context()
    const routes: CapturedRoute[] = []
    ctx.provide('webServer', fakeWebServer(routes))
    const healthy = stubAgent('workgraph-healthy')
    const snapshot = graphOf(
      { nodes: [{ id: 'a', title: 'A', spec: 'do a', deps: [] }] },
      'ship it',
    )
    commitWorkGraphChange(ctx, healthy, { kind: 'workgraph/change', version: 1, graph: snapshot }, 'set')
    // A torn-down session (no usable log) must be skipped, not fatal: it
    // comes first in the list, so the throw would abort the whole response
    // without the per-agent guard.
    const broken = { id: 'workgraph-broken', session: null } as unknown as Agent
    ctx.provide('agents', { list: () => [broken, healthy] })
    const s = new WorkGraphScheduler(ctx, { workgraphDir: dir })
    const res = fakeRes()
    await routes[0]!.handler({}, res)
    expect(res.status).toBe(200)
    const payload = JSON.parse(res.body) as { graphs: Array<{ sessionId: string }> }
    expect(payload.graphs).toHaveLength(1)
    expect(payload.graphs[0]!.sessionId).toBe(healthy.id)
    expect(s).toBeInstanceOf(WorkGraphScheduler)
  })

  it('skips registration silently without a web server (headless degrade)', () => {
    const s = new WorkGraphScheduler(new Context(), { workgraphDir: dir })
    expect(s).toBeInstanceOf(WorkGraphScheduler)
    // A second construction still does not throw nor register.
    const s2 = new WorkGraphScheduler(new Context(), { workgraphDir: dir })
    expect(s2).toBeInstanceOf(WorkGraphScheduler)
  })

  it('registers the route when the web server binds after construction', () => {
    const ctx = new Context()
    const routes: CapturedRoute[] = []
    const s = new WorkGraphScheduler(ctx, { workgraphDir: dir })
    expect(routes).toHaveLength(0)
    ctx.provide('webServer', fakeWebServer(routes))
    expect(routes).toHaveLength(1)
    expect(routes[0]!.path).toBe('/plugins/dsh-workgraph/state')
    // A later bind of a compat key must not double-register the route.
    ctx.provide('httpServer', fakeWebServer(routes))
    expect(routes).toHaveLength(1)
    // A non-web service binding leaves the registered route untouched.
    ctx.provide('agents', { list: () => [] })
    expect(routes).toHaveLength(1)
    expect(s).toBeInstanceOf(WorkGraphScheduler)
  })
})
