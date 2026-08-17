/**
 * `/graph` command tests over the real command registry and the real
 * scheduler provider (scripted child seams): the jxca grammar (resume/retry
 * prefixes never fall through to set), the status and DAG renderers (with
 * width-pressure degradation), bounded child settlement on pause, the
 * budget top-up hint, per-node and bare retry, and clear.
 * @module
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import { canonicalNodeId, WorkGraphScheduler } from '@deepseek-ai/dsh-workgraph-scheduler'
import type { WorkerRound, WorkerSpawn, ChildUsage, PlannerSpawnResult } from '@deepseek-ai/dsh-workgraph-scheduler'
import { WorkGraphError, WorkGraphId, WorkNodeId } from '@deepseek-ai/dsh-workgraph'
import type { WorkGraphSnapshot } from '@deepseek-ai/dsh-workgraph'
import * as commandWorkgraph from '@deepseek-ai/dsh-command-workgraph'
import { ROUND_DONE, VERDICT_ACHIEVED, RECORDED_USAGE, VALID_ARTIFACT } from '../../workgraph-scheduler/tests/fixtures.ts'

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly session: Session
  readonly dir: string
  readonly scheduler: WorkGraphScheduler
}

/** Build a live idle agent accepted by the engine's exact-identity checks. */
function stubAgent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id))
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

/** Mount the real command registry, engine, and producer. */
async function harness(options?: {
  round?: WorkerRound
  verifier?: WorkerSpawn
  usage?: (id: string) => Promise<ChildUsage>
  planner?: PlannerSpawnResult
  childAwaitBudget?: number
}): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  const dir = await mkdtemp(join(tmpdir(), 'command-workgraph-'))
  const scheduler = new WorkGraphScheduler(ctx, {
    workgraphDir: dir,
    plannerSpawn: async () => options?.planner ?? VALID_ARTIFACT,
    workerRound: options?.round ?? (async () => ROUND_DONE),
    verifierSpawn: options?.verifier ?? (async () => VERDICT_ACHIEVED),
    readChildUsage: options?.usage ?? (async () => RECORDED_USAGE),
    // The composition owns no subagents service: the replanner seam answers
    // with an empty appendix instead of the default spawn.
    replannerSpawn: async () => ({ structured: { nodes: [] }, stopReason: 'completed' }),
    ...(options?.childAwaitBudget === undefined ? {} : { childAwaitBudget: options.childAwaitBudget }),
  })
  await ctx.plugin(commandWorkgraph)
  const agent = stubAgent(ctx, `command-workgraph-${Math.random()}`)
  ctx.agents.register(agent)
  return { ctx, agent, session: agent.session, dir, scheduler }
}

/** Execute `/graph` through the same registry boundary as a UI adapter. */
async function run(test: Harness, suffix = ''): Promise<NonNullable<Awaited<ReturnType<CommandRuntime['execute']>>>['result']> {
  const execution = await test.ctx.commands.execute(
    test.agent,
    `/graph${suffix}`,
    new AbortController().signal,
  )
  if (execution === undefined) throw new Error('graph command was not registered')
  return execution.result
}

/** Seed a restored paused snapshot through the durable log fold. */
function seed(test: Harness, graph: WorkGraphSnapshot): void {
  test.session.append('workgraph/change', {
    kind: 'workgraph/change',
    version: 1,
    graph,
  })
}

/** An installed snapshot: a → b plus the gated final, roots ready. */
function installedSnapshot(id: string): WorkGraphSnapshot {
  const a = canonicalNodeId('a')
  const b = canonicalNodeId('b')
  return {
    id: WorkGraphId(id),
    objective: 'ship it',
    status: 'user_paused' as const,
    pauseReason: 'restored',
    planVersion: 1,
    nodes: [
      { id: a, title: 'A', spec: 'do a', blocks: [], state: 'ready', rounds: 0 },
      { id: b, title: 'B', spec: 'do b', blocks: [a], state: 'waiting', rounds: 0 },
      { id: WorkNodeId('gn-final'), title: 'Final verification of the overall objective', spec: 'verify', blocks: [a, b], state: 'waiting', rounds: 0 },
    ],
    pendingDiscoveries: [{ description: 'more work', from: a }],
    history: [{ at: 1, kind: 'created' }],
    tokensSpent: 3,
    tokenBudget: 10,
    replanRuns: 0,
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('@deepseek-ai/dsh-command-workgraph', () => {
  let test: Harness

  beforeEach(async () => {
    test = await harness()
  })

  afterEach(async () => {
    await rm(test.dir, { recursive: true, force: true })
  })

  it('registers one global command with Loader-safe exports', async () => {
    expect(commandWorkgraph.name).toBe('command-workgraph')
    expect(commandWorkgraph.inject).toEqual(['commands', 'workGraph'])
    expect(test.ctx.commands.list(test.agent)).toContainEqual({
      name: 'graph',
      description: expect.stringContaining('dependency graph'),
      input: { hint: expect.stringContaining('--budget') },
    })
  })

  it('renders the empty state for status/show and refuses control verbs without a graph', async () => {
    const status = await run(test)
    expect(status).toEqual({ kind: 'success', text: expect.stringContaining('No graph is set') })
    expect(await run(test, ' status')).toEqual(status)
    expect(await run(test, ' show')).toEqual(status)
    expect(await run(test, ' pause')).toEqual({ kind: 'error', text: expect.stringContaining('No graph is set') })
    expect(await run(test, ' resume')).toEqual({ kind: 'error', text: expect.stringContaining('No graph is set') })
    expect(await run(test, ' retry')).toEqual({ kind: 'error', text: expect.stringContaining('No graph is set') })
    expect(await run(test, ' clear')).toEqual({ kind: 'success', text: 'No graph to clear.' })
  })

  it('never lets resume/retry prefixes fall through to set', async () => {
    const resume = await run(test, ' resumefoo')
    expect(resume).toEqual({ kind: 'error', text: expect.stringContaining('/graph resume requires one') })
    const retry = await run(test, ' retrywhatever')
    expect(retry).toEqual({ kind: 'error', text: expect.stringContaining('/graph retry requires one') })
    expect(await test.scheduler.status(test.agent)).toBeNull()
  })

  it('dispatches a set immediately and completes in the background', async () => {
    const result = await run(test, ' build the thing')
    expect(result.kind).toBe('success')
    const text = result.text
    // The command returns the durable pending render at once — it never
    // blocks the command channel for the graph's whole lifetime.
    expect(text).toContain('Graph: build the thing')
    expect(text).toContain('Status: active | Plan v1')
    expect(text).toContain('Nodes: 0/0 achieved')
    expect(text).toContain('Planning and execution run in the background')
    // The drive settles detached; status then shows the completed tree.
    const settled = await test.scheduler.settled(test.agent)
    expect(settled.status).toBe('complete')
    const status = await run(test, ' status')
    expect(status.kind).toBe('success')
    expect(status.text).toContain('Status: complete | Plan v1')
    expect(status.text).toContain('Nodes: 3/3 achieved')
    expect(status.text).toContain('[x]')
    expect(status.text).toContain('Tokens: 15')
  })

  it('consumes a trailing own-token --budget and leaves mid-objective mentions alone', async () => {
    const budgeted = await run(test, ' build it --budget 100')
    expect(budgeted.kind).toBe('success')
    expect(budgeted.text).toContain('Budget: 100')
    // Each set dispatches detached; a set replaces only a completed graph,
    // so settle before the next objective.
    await test.scheduler.settled(test.agent)
    const mention = await run(test, ' add --budget support to the docs')
    expect(mention.kind).toBe('success')
    expect(mention.text).toContain('Graph: add --budget support to the docs')
    expect(mention.text).not.toContain('Budget:')
    await test.scheduler.settled(test.agent)
    const zero = await run(test, ' build it --budget 0')
    expect(zero.kind).toBe('success')
    expect(zero.text).toContain('Graph: build it --budget 0')
    expect(zero.text).not.toContain('Budget:')
  })

  it('refuses a second set while a graph is paused; a completed one is replaceable', async () => {
    seed(test, installedSnapshot('wg-existing'))
    const second = await run(test, ' second objective')
    expect(second).toEqual({ kind: 'error', text: expect.stringContaining('already set') })
    await run(test, ' clear')
    const fresh = await run(test, ' fresh objective')
    expect(fresh.kind).toBe('success')
    expect(fresh.text).toContain('Graph: fresh objective')
    await test.scheduler.settled(test.agent)
    const status = await run(test, ' status')
    expect(status.kind).toBe('success')
    expect(status.text).toContain('Status: complete')
  })

  it('renders the status tree with glyphs, waits, rounds, failures, budget, and pause reason', async () => {
    const a = canonicalNodeId('a')
    seed(test, {
      ...installedSnapshot('wg-status'),
      nodes: [
        { id: a, title: 'A', spec: 'do a', blocks: [], state: 'achieved', rounds: 2 },
        {
          id: canonicalNodeId('b'),
          title: 'B',
          spec: 'do b',
          blocks: [a],
          state: 'running',
          rounds: 1,
        },
        {
          id: canonicalNodeId('c'),
          title: 'C',
          spec: 'do c',
          blocks: [],
          state: 'failed',
          rounds: 1,
          failure: 'worker episode failed: boom',
        },
        {
          id: canonicalNodeId('d'),
          title: 'D',
          spec: 'do d',
          blocks: [],
          state: 'waiting',
          rounds: 0,
        },
        { id: WorkNodeId('gn-final'), title: 'Final verification of the overall objective', spec: 'verify', blocks: [a], state: 'blocked', rounds: 0, failure: `blocked: dependency chain failed at ${a}` },
      ],
    })
    const result = await run(test, ' status')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('Status: user paused | Plan v1')
    expect(result.text).toContain('[x] gn-')
    expect(result.text).toContain('[>] gn-')
    expect(result.text).toContain('[!] gn-')
    expect(result.text).toContain('[-] gn-')
    expect(result.text).toContain('(2 rounds)')
    expect(result.text).toContain('— worker episode failed: boom')
    expect(result.text).toContain('Tokens: 3 | Budget: 10')
    expect(result.text).toContain('Discoveries: 1 pending replan')
    expect(result.text).toContain('Paused: restored')
  })

  it('renders the layered DAG with the legend and degrades to the tree under width pressure', async () => {
    const a = canonicalNodeId('a')
    const b = canonicalNodeId('b')
    const c = canonicalNodeId('c')
    const d = canonicalNodeId('d')
    const final = WorkNodeId('gn-final')
    const dagSnapshot: WorkGraphSnapshot = {
      ...installedSnapshot('wg-show'),
      nodes: [
        { id: a, title: 'A', spec: 'do a', blocks: [], state: 'achieved', rounds: 1 },
        { id: b, title: 'B', spec: 'do b', blocks: [], state: 'running', rounds: 1 },
        { id: c, title: 'C', spec: 'do c', blocks: [a, b], state: 'failed', rounds: 2, failure: 'boom' },
        { id: d, title: 'D', spec: 'do d', blocks: [], state: 'blocked', rounds: 0, failure: 'blocked: chain' },
        // The final gates over everything; the d -> final edge spans two
        // layers, forcing a dummy pass-through in the painting.
        { id: final, title: 'Final verification of the overall objective', spec: 'verify', blocks: [a, b, c, d], state: 'waiting', rounds: 0 },
      ],
    }
    seed(test, dagSnapshot)
    const show = await run(test, ' show')
    expect(show.kind).toBe('success')
    expect(show.text).toContain('Graph: ship it (plan v1)')
    expect(show.text).toContain('┌')
    expect(show.text).toContain('✓ achieved')
    expect(show.text).toContain('✓ A')
    // The full glyph set paints: running, failed, blocked.
    expect(show.text).toContain('▶ B')
    expect(show.text).toContain('✗ C')
    expect(show.text).toContain('⊘ D')
    // A wide graph (many long-titled roots) cannot fit the budget: the
    // command degrades to the indented status tree — wrapped box art is
    // worse than no art.
    const wide = {
      ...installedSnapshot('wg-show'),
      nodes: [
        ...Array.from({ length: 9 }, (_, index) => ({
          id: canonicalNodeId(`root-${index}`),
          title: `Root node number ${index} with a deliberately long title`,
          spec: 'do it',
          blocks: [],
          state: 'ready' as const,
          rounds: 0,
        })),
        { id: WorkNodeId('gn-final'), title: 'Final verification of the overall objective', spec: 'verify', blocks: Array.from({ length: 9 }, (_, index) => canonicalNodeId(`root-${index}`)), state: 'waiting' as const, rounds: 0 },
      ],
    }
    test.session.append('workgraph/change', {
      kind: 'workgraph/change',
      version: 1,
      graph: wide,
    })
    const degraded = await run(test, ' show')
    expect(degraded.kind).toBe('success')
    expect(degraded.text).toContain('Status: user paused')
    expect(degraded.text).not.toContain('┌')
  })

  it('paints vertical 0-width hops for a straight chain', async () => {
    seed(test, installedSnapshot('wg-chain'))
    const chain = await run(test, ' show')
    expect(chain.kind).toBe('success')
    expect(chain.text).toContain('○ A')
    expect(chain.text).toContain('▼')
  })

  it('degrades the DAG to the status tree for pending and cyclic graphs', async () => {
    // A pending graph has zero nodes: nothing to layer. Both seeds share
    // one graph identity so the fold continuity check passes.
    seed(test, {
      ...installedSnapshot('wg-cycle'),
      nodes: [],
      history: [{ at: 1, kind: 'created' }],
    })
    const pending = await run(test, ' show')
    expect(pending.kind).toBe('success')
    expect(pending.text).toContain('Status: user paused')
    expect(pending.text).not.toContain('┌')
    // A cyclic foreign snapshot cannot be layered (the layering guard
    // refuses to render garbage) and degrades too.
    const a = canonicalNodeId('a')
    const b = canonicalNodeId('b')
    seed(test, {
      ...installedSnapshot('wg-cycle'),
      nodes: [
        { id: a, title: 'A', spec: 'do a', blocks: [b], state: 'waiting', rounds: 0 },
        { id: b, title: 'B', spec: 'do b', blocks: [a], state: 'waiting', rounds: 0 },
      ],
    })
    const cyclic = await run(test, ' show')
    expect(cyclic.kind).toBe('success')
    expect(cyclic.text).toContain('Status: user paused')
    expect(cyclic.text).not.toContain('┌')
  })

  it('pauses mid-episode and waits for bounded child settlement before returning', async () => {
    let release!: (result: typeof ROUND_DONE) => void
    const gate = new Promise<typeof ROUND_DONE>((resolve) => { release = resolve })
    const round: WorkerRound = async () => gate
    test = await harness({ round, childAwaitBudget: 5 })
    const pendingSet = test.scheduler.set(test.agent, { objective: 'ship it' })
    await new Promise<void>(resolve => setTimeout(resolve, 10))
    const pendingPause = test.ctx.commands.execute(test.agent, '/graph pause', new AbortController().signal)
    // The child settles within the await budget: the drive demotes the
    // in-flight node and pause returns the settled view.
    setTimeout(() => { release(ROUND_DONE) }, 5)
    const execution = await pendingPause
    if (execution === undefined) throw new Error('graph command was not registered')
    expect(execution.result.kind).toBe('success')
    expect(execution.result.text).toContain('Status: user paused')
    // Quiescence: the in-flight worker demoted to ready before the command
    // returned (a resource stop, never a verdict).
    expect(execution.result.text).toContain(`[ ] ${canonicalNodeId('a')}`)
    await pendingSet
  })

  it('renders the pre-clear view when a clear lands during the pause settle', async () => {
    let release!: (result: typeof ROUND_DONE) => void
    const gate = new Promise<typeof ROUND_DONE>((resolve) => { release = resolve })
    test = await harness({ round: async () => gate, childAwaitBudget: 5 })
    const pendingSet = test.scheduler.set(test.agent, { objective: 'ship it' })
    // Attach early so the mid-test rejection is never unhandled.
    const setSettled = pendingSet.then(() => undefined, (error: unknown) => error)
    await new Promise<void>(resolve => setTimeout(resolve, 10))
    const pendingPause = test.ctx.commands.execute(test.agent, '/graph pause', new AbortController().signal)
    // Wait until the handler's pause committed (the bounded settle wait is
    // then in flight), then clear: the live view is gone, so the handler
    // falls back to the view it captured. Polling beats a fixed delay under
    // load.
    const pausedAt = Date.now()
    for (;;) {
      const state = await test.scheduler.status(test.agent)
      if (state !== null && state.status === 'user_paused') break
      if (Date.now() - pausedAt > 5000) throw new Error('pause never committed')
      await new Promise<void>(resolve => setTimeout(resolve, 5))
    }
    await test.scheduler.clear(test.agent)
    release(ROUND_DONE)
    const execution = await pendingPause
    if (execution === undefined) throw new Error('graph command was not registered')
    expect(execution.result.kind).toBe('success')
    expect(execution.result.text).toContain('Status: active')
    expect(await setSettled).toEqual(
      new WorkGraphError('graph cleared mid-episode', 'WORKGRAPH_NOT_FOUND'),
    )
  })

  it('refuses a plain resume on a budget-limited graph with the top-up hint', async () => {
    const seeded = { ...installedSnapshot('wg-budget'), status: 'budget_limited' as const, pauseReason: 'budget exhausted' }
    seed(test, seeded)
    const refused = await run(test, ' resume')
    expect(refused).toEqual({ kind: 'error', text: expect.stringContaining('top up with resume --budget') })
    const status = await run(test, ' status')
    expect(status.kind).toBe('success')
    expect(status.text).toContain('Status: budget limited | Plan v1')
    // Malformed top-ups resolve to a plain resume (never a set).
    expect(await run(test, ' resume --budget abc')).toEqual(refused)
    expect(await run(test, ' resume --budget 0')).toEqual(refused)
  })

  it('tops up a budget-limited graph with resume --budget', async () => {
    const seeded = { ...installedSnapshot('wg-budget'), status: 'budget_limited' as const, pauseReason: 'budget exhausted' }
    seed(test, seeded)
    const result = await run(test, ' resume --budget 20')
    expect(result.kind).toBe('success')
    // The durable resume render carries the top-up from spent-so-far...
    expect(result.text).toContain('Budget: 23')
    // ...and the detached drive settles the graph.
    await test.scheduler.settled(test.agent)
    const status = await run(test, ' status')
    expect(status.kind).toBe('success')
    expect(status.text).toContain('Status: complete')
  })

  it('retries one failed chain by node id and reports unknown targets honestly', async () => {
    const a = canonicalNodeId('a')
    const { tokenBudget: _unbudgeted, ...unbudgetedBase } = installedSnapshot('wg-retry')
    void _unbudgeted
    seed(test, {
      ...unbudgetedBase,
      status: 'blocked' as const,
      pauseReason: 'wedge',
      nodes: [
        { id: a, title: 'A', spec: 'do a', blocks: [], state: 'failed', rounds: 1, failure: 'boom' },
        { id: canonicalNodeId('b'), title: 'B', spec: 'do b', blocks: [a], state: 'blocked', rounds: 0, failure: `blocked: dependency chain failed at ${a}` },
        { id: WorkNodeId('gn-final'), title: 'Final verification of the overall objective', spec: 'verify', blocks: [a], state: 'blocked', rounds: 0, failure: `blocked: dependency chain failed at ${a}` },
      ],
    })
    const before = await run(test, ' status')
    expect(before.kind).toBe('success')
    expect(before.text).toContain('Status: blocked | Plan v1')
    const result = await run(test, ` retry ${a}`)
    expect(result.kind).toBe('success')
    expect(result.text).toContain('Status: active | Plan v1')
    await test.scheduler.settled(test.agent)
    expect((await run(test, ' status')).text).toContain('Status: complete')
    const unknown = await run(test, ' retry gn-00000000')
    expect(unknown).toEqual({ kind: 'error', text: expect.stringContaining('unknown node gn-00000000') })
  })

  it('bare retry resets every terminal chain once', async () => {
    const a = canonicalNodeId('a')
    const c = canonicalNodeId('c')
    const { tokenBudget: _unbudgetedAll, ...unbudgetedAllBase } = installedSnapshot('wg-retry-all')
    void _unbudgetedAll
    seed(test, {
      ...unbudgetedAllBase,
      status: 'blocked' as const,
      pauseReason: 'wedge',
      nodes: [
        { id: a, title: 'A', spec: 'do a', blocks: [], state: 'failed', rounds: 1, failure: 'boom' },
        { id: c, title: 'C', spec: 'do c', blocks: [], state: 'failed', rounds: 1, failure: 'boom' },
        { id: canonicalNodeId('b'), title: 'B', spec: 'do b', blocks: [a], state: 'blocked', rounds: 0, failure: `blocked: dependency chain failed at ${a}` },
        { id: WorkNodeId('gn-final'), title: 'Final verification of the overall objective', spec: 'verify', blocks: [a, c], state: 'blocked', rounds: 0, failure: 'blocked: dependency chain failed' },
      ],
    })
    const result = await run(test, ' retry')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('Retried 2 failure chain(s)')
    await test.scheduler.settled(test.agent)
    expect((await run(test, ' status')).text).toContain('Status: complete')
    const none = await run(test, ' retry')
    expect(none).toEqual({ kind: 'success', text: 'No failed nodes to retry.' })
  })

  it('clears the graph and its durable tombstone', async () => {
    await run(test, ' build it')
    const cleared = await run(test, ' clear')
    expect(cleared).toEqual({ kind: 'success', text: 'Graph cleared.' })
    expect(await test.scheduler.status(test.agent)).toBeNull()
    // A cleared graph cannot resurrect: set works again.
    const again = await run(test, ' build it again')
    expect(again.kind).toBe('success')
  })

  it('surfaces engine errors as command errors', async () => {
    test = await harness({
      planner: {
        structured: undefined,
        stopReason: 'error',
      } as unknown as PlannerSpawnResult,
    })
    // The scripted planner fails closed; the command dispatches, and the
    // detached episode pauses the graph infra with the honest reason.
    const result = await run(test, ' build it')
    expect(result.kind).toBe('success')
    const settled = await test.scheduler.settled(test.agent)
    expect(settled.status).toBe('infra_paused')
    expect(settled.pauseReason).toContain('graph planning failed')
    const status = await run(test, ' status')
    expect(status.kind).toBe('success')
    expect(status.text).toContain('Status: infra paused')
    // A non-domain engine failure (a malformed persisted change) propagates
    // through the handler — never mistaken for a domain error. A fresh
    // harness has no live view, so the fold must replay the malformed event.
    test = await harness()
    test.session.append('workgraph/change', {
      kind: 'workgraph/change',
      version: 99,
      graph: { nodes: [] },
    } as never)
    await expect(run(test, ' status')).rejects.toThrow('unsupported workgraph change version 99')
  })
})
