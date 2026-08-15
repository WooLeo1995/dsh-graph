/**
 * Topology optimizer tests (issue 09): the restricted op matrix, the final
 * invariants (gate rebuild, bidirectional status re-derivation, non-pending
 * identity, acyclicity, size), the shared-cap slot consumption, the episode
 * decode, and the scheduler wiring (pass after planning and after an applied
 * replan; disabled or cap-exhausted states never spawn).
 * @module
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { WorkGraphId, WorkNodeId } from '@deepseek-ai/dsh-workgraph'
import type { WorkGraphLimits, WorkGraphSnapshot } from '@deepseek-ai/dsh-workgraph'
import {
  OPTIMIZER_OUTPUT_SCHEMA,
  applyOptimization,
  canonicalNodeId,
  parseOptimizerOps,
  runOptimizerEpisode,
  WorkGraphScheduler,
} from '@deepseek-ai/dsh-workgraph-scheduler'
import type { PlannerSpawn } from '@deepseek-ai/dsh-workgraph-scheduler'
import { installPlan, initializeGraph } from '@deepseek-ai/dsh-workgraph-scheduler'
import { ROUND_DONE, VERDICT_ACHIEVED, RECORDED_USAGE, VALID_ARTIFACT } from './fixtures.ts'

const LIMITS: WorkGraphLimits = { maxNodes: 24, historyMax: 64 }
const A = canonicalNodeId('a')
const B = canonicalNodeId('b')
const C = canonicalNodeId('c')
const D = canonicalNodeId('d')
const FINAL = WorkNodeId('gn-final')

/** Install a diamond a → c, b → c plus the gated final, all pending. */
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

/** The scheduler used for the wiring tests (cwd-capable agent). */
function stubAgent(cwd?: string): Agent {
  const session = Session.create(
    SessionId('wg-project-test'),
    undefined,
    cwd === undefined ? undefined : { version: 0, id: SessionId('wg-project-test'), createdAt: 1, cwd },
  )
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

describe('applyOptimization', () => {
  it('removes a false dependency and unlocks a real parallel batch', async () => {
    const snapshot = diamond()
    // c's false dep on b: removing it keeps c waiting only on a.
    const optimized = applyOptimization(snapshot, [
      { op: 'remove_dep', node: C, dep: B },
    ], LIMITS, 200)
    expect(optimized).not.toBeNull()
    const cNode = optimized!.nodes.find(node => node.id === C)!
    expect(cNode.blocks).toEqual([A])
    expect(optimized!.planVersion).toBe(2)
    expect(optimized!.replanRuns).toBe(1)
    expect(optimized!.history.at(-1)!.kind).toBe('optimized')
    // The final gate rebuilds over ALL surviving non-final nodes.
    const final = optimized!.nodes.find(node => node.id === FINAL)!
    expect(final.blocks).toContain(C)
    // Non-pending nodes are byte-identical (none exist here, but the gate
    // rebuild keeps the invariant honest).
    expect(optimized!.nodes.every(node => node.state === 'waiting' || node.state === 'ready')).toBe(true)
  })

  it('reorders pending nodes stably and rejects unknown or duplicated ids', () => {
    const snapshot = diamond()
    const reordered = applyOptimization(snapshot, [{ op: 'reorder', order: [B, A] }], LIMITS, 200)
    expect(reordered!.nodes.slice(0, 2).map(node => node.id)).toEqual([B, A])
    expect(() => applyOptimization(snapshot, [{ op: 'reorder', order: ['gn-missing'] }], LIMITS, 200))
      .toThrow('unknown node')
    expect(() => applyOptimization(snapshot, [{ op: 'reorder', order: [A, A] }], LIMITS, 200))
      .toThrow('twice')
  })

  it('merges one pending node into another with spec combine and rewiring', () => {
    const snapshot = diamond()
    // B merges into C: the spec combines, C's dep on B absorbs, and the
    // final gate rewires B → C (dedupe included).
    const merged = applyOptimization(snapshot, [{ op: 'merge', into: C, from: B }], LIMITS, 200)
    expect(merged).not.toBeNull()
    const cNode = merged!.nodes.find(node => node.id === C)!
    expect(cNode.spec).toContain('AND:')
    expect(cNode.blocks).toEqual([A])
    const final = merged!.nodes.find(node => node.id === FINAL)!
    expect(final.blocks).not.toContain(B)
    expect(final.blocks).toContain(C)
    expect(() => applyOptimization(snapshot, [{ op: 'merge', into: C, from: C }], LIMITS, 200))
      .toThrow('into == from')
    expect(() => applyOptimization(snapshot, [{ op: 'merge', into: FINAL, from: C }], LIMITS, 200))
      .toThrow('terminal node cannot participate')
    expect(() => applyOptimization(snapshot, [{ op: 'merge', into: C, from: 'gn-missing' }], LIMITS, 200))
      .toThrow('unknown node')
  })

  it('splits an oversized pending node into 2-3 replacements with rewired dependents', () => {
    const snapshot = diamond()
    const split = applyOptimization(snapshot, [{
      op: 'split',
      node: C,
      replacements: [
        { id: 'c1', title: 'C1', spec: 'first half', deps: [A] },
        { id: 'c2', title: 'C2', spec: 'second half', deps: [B] },
      ],
    }], LIMITS, 200)
    expect(split).not.toBeNull()
    const c1 = canonicalNodeId('c1')
    const c2 = canonicalNodeId('c2')
    const final = split!.nodes.find(node => node.id === FINAL)!
    expect(final.blocks).toContain(c1)
    expect(final.blocks).toContain(c2)
    expect(final.blocks).not.toContain(C)
    expect(() => applyOptimization(snapshot, [{
      op: 'split', node: FINAL, replacements: [
        { id: 'x', title: 'X', spec: 's', deps: [] },
        { id: 'y', title: 'Y', spec: 's', deps: [] },
      ],
    }], LIMITS, 200)).toThrow('terminal node cannot be split')
    expect(() => applyOptimization(snapshot, [{
      op: 'split', node: C, replacements: [{ id: 'x', title: 'X', spec: 's', deps: [] }],
    }], LIMITS, 200)).toThrow('needs 2-3 replacements')
    expect(() => applyOptimization(snapshot, [{
      op: 'split', node: C, replacements: [
        { id: 'bad id!', title: 'X', spec: 's', deps: [] },
        { id: 'y', title: 'Y', spec: 's', deps: [] },
      ],
    }], LIMITS, 200)).toThrow('hygienic slug')
    expect(() => applyOptimization(snapshot, [{
      op: 'split', node: C, replacements: [
        { id: 'x', title: 'X', spec: 's', deps: ['gn-missing'] },
        { id: 'y', title: 'Y', spec: 's', deps: [] },
      ],
    }], LIMITS, 200)).toThrow('unknown')
    expect(() => applyOptimization(snapshot, [{
      op: 'split', node: C, replacements: [
        { id: 'x', title: 'X', spec: 's', deps: [A] },
        { id: 'y', title: 'Y', spec: 's', deps: [] },
      ],
    }, {
      op: 'split', node: B, replacements: [
        { id: 'x', title: 'X2', spec: 's', deps: [] },
        { id: 'y2', title: 'Y2', spec: 's', deps: [] },
      ],
    }], LIMITS, 200)).toThrow('collides')
  })

  it('rejects a remove_dep that does not exist and merges from-dep and into-dep edges', () => {
    const snapshot = diamond()
    expect(() => applyOptimization(snapshot, [{ op: 'remove_dep', node: C, dep: D }], LIMITS, 200))
      .toThrow('has no dependency on')
    // from carries deps (incl. into): the into-dep absorbs, the rest merge.
    const merged = applyOptimization(snapshot, [{ op: 'merge', into: B, from: C }], LIMITS, 200)!
    const bNode = merged.nodes.find(node => node.id === B)!
    expect(bNode.spec).toContain('AND:')
    expect(bNode.blocks).toEqual([A])
    // The split's non-pending dependent guard fires too.
    let running = diamond()
    running = { ...running, nodes: running.nodes.map(node => node.id === C ? { ...node, state: 'running' } : node) }
    expect(() => applyOptimization(running, [{
      op: 'split', node: B, replacements: [
        { id: 'b1', title: 'B1', spec: 's', deps: [] },
        { id: 'b2', title: 'B2', spec: 's', deps: [] },
      ],
    }], LIMITS, 200)).toThrow('non-pending dependent')
  })

  it('re-derives pending status in both directions', () => {
    // A merge grafts an unachieved dep onto a Ready node → it demotes.
    let snapshot = diamond()
    snapshot = { ...snapshot, nodes: snapshot.nodes.map(node => node.id === C ? { ...node, state: 'ready' } : node) }
    const demoted = applyOptimization(snapshot, [{ op: 'merge', into: C, from: B }], LIMITS, 200)!
    expect(demoted.nodes.find(node => node.id === C)!.state).toBe('waiting')
    // A remove_dep that clears the last blocker keeps a Ready node ready.
    snapshot = { ...snapshot, nodes: snapshot.nodes.map(node => node.id === A ? { ...node, state: 'achieved' } : node) }
    const kept = applyOptimization(snapshot, [{ op: 'remove_dep', node: C, dep: B }], LIMITS, 200)!
    expect(kept.nodes.find(node => node.id === C)!.state).toBe('ready')
  })

  it('refuses edits to non-pending nodes and to non-pending dependents', () => {
    let snapshot = diamond()
    snapshot = { ...snapshot, nodes: snapshot.nodes.map(node => node.id === A ? { ...node, state: 'achieved' } : node) }
    expect(() => applyOptimization(snapshot, [{ op: 'remove_dep', node: A, dep: B }], LIMITS, 200))
      .toThrow('only Waiting/Ready nodes may be edited')
    // A merge whose target has a non-pending dependent is refused up front.
    snapshot = { ...snapshot, nodes: snapshot.nodes.map(node => node.id === C ? { ...node, state: 'running' } : node) }
    expect(() => applyOptimization(snapshot, [{ op: 'merge', into: D, from: A }], LIMITS, 200))
      .toThrow('non-pending dependent')
  })

  it('re-verifies acyclicity and the node cap, and respects an empty list', () => {
    const snapshot = diamond()
    // A split whose replacements depend on each other cyclically is refused.
    expect(() => applyOptimization(snapshot, [{
      op: 'split', node: C, replacements: [
        { id: 'c1', title: 'C1', spec: 's', deps: ['c2'] },
        { id: 'c2', title: 'C2', spec: 's', deps: ['c1'] },
      ],
    }], LIMITS, 200)).toThrow('cyclic')
    // The node cap re-verifies.
    const tiny: WorkGraphLimits = { maxNodes: 3, historyMax: 64 }
    expect(() => applyOptimization(snapshot, [{
      op: 'split', node: C, replacements: [
        { id: 'c1', title: 'C1', spec: 's', deps: [] },
        { id: 'c2', title: 'C2', spec: 's', deps: [] },
        { id: 'c3', title: 'C3', spec: 's', deps: [] },
      ],
    }], tiny, 200)).toThrow('node cap')
    expect(applyOptimization(snapshot, [], LIMITS, 200)).toBeNull()
  })
})

describe('runOptimizerEpisode and parseOptimizerOps', () => {
  const episode = (spawn: PlannerSpawn) => runOptimizerEpisode({
    objective: 'ship it',
    currentGraph: '[]',
    history: '',
    limits: LIMITS,
    signal: new AbortController().signal,
    spawn,
  })

  it('decodes a planned op list and fails closed on child errors', async () => {
    const planned = await episode(async () => ({
      structured: { ops: [{ op: 'remove_dep', node: C, dep: B }] },
      stopReason: 'completed',
    }))
    expect(planned).toEqual({ kind: 'planned', ops: [{ op: 'remove_dep', node: C, dep: B }] })
    expect(await episode(async () => ({ structured: undefined, stopReason: 'error' })))
      .toEqual({ kind: 'fail-closed', reason: expect.stringContaining('stop reason "error"') })
    expect(await episode(async () => ({ structured: undefined, stopReason: 'completed' })))
      .toEqual({ kind: 'fail-closed', reason: 'optimizer produced no structured ops' })
  })

  it('rejects malformed op payloads as invalid', async () => {
    expect(await episode(async () => ({ structured: { ops: [{ op: 'nope' }] }, stopReason: 'completed' })))
      .toEqual({ kind: 'invalid', reason: expect.stringContaining('ops array') })
    expect(await episode(async () => ({ structured: { ops: [{ op: 'remove_dep', node: 7, dep: B }] }, stopReason: 'completed' })))
      .toEqual({ kind: 'invalid', reason: expect.stringContaining('ops array') })
    expect(await episode(async () => ({ structured: 'nope', stopReason: 'completed' })))
      .toEqual({ kind: 'invalid', reason: expect.stringContaining('ops array') })
  })

  it('parses each op shape defensively', () => {
    const ops = parseOptimizerOps({
      ops: [
        { op: 'remove_dep', node: A, dep: B },
        { op: 'reorder', order: [A, B] },
        { op: 'merge', into: A, from: B },
        { op: 'split', node: C, replacements: [{ id: 'c1', title: 'T', spec: 'S', deps: [A] }] },
      ],
    })
    expect(ops).toHaveLength(4)
    expect(parseOptimizerOps({ ops: [{ op: 'split', node: C, replacements: [{ id: 'c1' }] }] })).toBeNull()
    expect(parseOptimizerOps(null)).toBeNull()
    expect(parseOptimizerOps({})).toBeNull()
    expect(parseOptimizerOps({ ops: [{ op: 'reorder', order: [1] }] })).toBeNull()
    expect(parseOptimizerOps({ ops: [7] })).toBeNull()
    expect(parseOptimizerOps({ ops: [{ op: 'merge', into: 7, from: 'x' }] })).toBeNull()
    expect(parseOptimizerOps({ ops: [{ op: 'split', node: 7, replacements: [] }] })).toBeNull()
    expect(parseOptimizerOps({ ops: [{ op: 'split', node: 'x', replacements: [7] }] })).toBeNull()
    expect(parseOptimizerOps({ ops: [{ op: 'split', node: 'x', replacements: [{ id: 'y', title: 'T', spec: 'S', deps: [1] }] }] })).toBeNull()
    expect(OPTIMIZER_OUTPUT_SCHEMA.required).toEqual(['ops'])
  })

  it('rejects empty titles and dead split dependencies', () => {
    let snapshot = diamond()
    snapshot = { ...snapshot, nodes: [...snapshot.nodes.map(node => node.id === B ? { ...node, state: 'failed' as const, failure: 'boom' } : node)] }
    expect(() => applyOptimization(snapshot, [{
      op: 'split', node: C, replacements: [
        { id: 'c1', title: '   ', spec: 's', deps: [] },
        { id: 'c2', title: 'C2', spec: 's', deps: [] },
      ],
    }], LIMITS, 200)).toThrow('empty title/spec')
    expect(() => applyOptimization(snapshot, [{
      op: 'split', node: C, replacements: [
        { id: 'c1', title: 'C1', spec: 's', deps: [B] },
        { id: 'c2', title: 'C2', spec: 's', deps: [] },
      ],
    }], LIMITS, 200)).toThrow('dead node')
  })

  it('rewires a dependent that does not already block the merge target', () => {
    // d depends only on b; merging b into c must rewire d → c (the push arm).
    let snapshot = diamond()
    snapshot = { ...snapshot, nodes: [...snapshot.nodes, {
      id: D, title: 'D', spec: 'do d', blocks: [B], state: 'waiting', rounds: 0,
    }] }
    const merged = applyOptimization(snapshot, [{ op: 'merge', into: C, from: B }], LIMITS, 200)!
    const dNode = merged.nodes.find(node => node.id === D)!
    expect(dNode.blocks).toEqual([C])
  })
})

describe('optimizer scheduler wiring', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'workgraph-opt-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function scheduler(optimizerSpawn?: PlannerSpawn, options: { optimizer?: boolean; replanCap?: number } = {}): WorkGraphScheduler {
    return new WorkGraphScheduler(new Context(), {
      workgraphDir: dir,
      plannerSpawn: async () => VALID_ARTIFACT,
      workerRound: async () => ROUND_DONE,
      verifierSpawn: async () => VERDICT_ACHIEVED,
      readChildUsage: async () => RECORDED_USAGE,
      replannerSpawn: async () => ({ structured: { nodes: [] }, stopReason: 'completed' }),
      ...(optimizerSpawn === undefined ? {} : { optimizerSpawn }),
      ...(options.optimizer === undefined ? {} : { optimizer: options.optimizer }),
      ...(options.replanCap === undefined ? {} : { replanCap: options.replanCap }),
      childAwaitBudget: 0.02,
    })
  }

  it('applies a pass after planning: version bump, shared slot consumed, baseline frozen', async () => {
    const agent = stubAgent()
    let calls = 0
    const optimizerSpawn: PlannerSpawn = async () => {
      calls += 1
      return { structured: { ops: [{ op: 'remove_dep', node: canonicalNodeId('b'), dep: canonicalNodeId('a') }] }, stopReason: 'completed' }
    }
    const s = scheduler(optimizerSpawn)
    const snapshot = await s.set(agent, { objective: 'ship it' })
    // One pass after planning + one per boundary; the later passes are
    // rejected (the dep is already gone) and degrade without a second bump.
    expect(calls).toBe(4)
    expect(snapshot.status).toBe('complete')
    expect(snapshot.planVersion).toBe(2)
    expect(snapshot.replanRuns).toBe(1)
    expect(snapshot.history.map(entry => entry.kind)).toContain('optimized')
  })

  it('degrades when the optimized baseline cannot freeze (audit gap only)', async () => {
    // A restored graph whose v2 baseline is already frozen: the optimizer
    // applies, the freeze collides, and the graph keeps running.
    const seeded = initializeGraph(WorkGraphId('wg-optfreeze'), 'ship it', installPlan(VALID_ARTIFACT.structured, 'ship it', LIMITS), LIMITS, 100)
    const restored = { ...seeded, status: 'user_paused' as const, pauseReason: 'restored' }
    const agent = stubAgent()
    agent.session.append('workgraph/change', { kind: 'workgraph/change', version: 1, graph: restored })
    const baselineDir = join(dir, 'workgraph', 'baselines', 'wg-optfreeze')
    await mkdir(baselineDir, { recursive: true })
    await writeFile(join(baselineDir, 'v2.json'), '[]\n')
    const s = scheduler(async () => ({
      structured: { ops: [{ op: 'remove_dep', node: canonicalNodeId('b'), dep: canonicalNodeId('a') }] },
      stopReason: 'completed',
    }))
    const snapshot = await s.resume(agent)
    expect(snapshot.status).toBe('complete')
    expect(snapshot.planVersion).toBe(2)
  })

  it('never spawns when disabled or when the shared cap is exhausted', async () => {
    const agent = stubAgent()
    let calls = 0
    const optimizerSpawn: PlannerSpawn = async () => {
      calls += 1
      return { structured: { ops: [] }, stopReason: 'completed' }
    }
    const off = scheduler(optimizerSpawn, { optimizer: false })
    await off.set(agent, { objective: 'ship it' })
    expect(calls).toBe(0)
    const capped = scheduler(optimizerSpawn, { replanCap: 0 })
    await capped.set(stubAgent(), { objective: 'ship it' })
    expect(calls).toBe(0)
  })

  it('degrades on rejected ops and on a failed child, keeping the current plan', async () => {
    const agent = stubAgent()
    const rejected = scheduler(async () => ({
      structured: { ops: [{ op: 'remove_dep', node: 'gn-missing', dep: A }] },
      stopReason: 'completed',
    }))
    const snapshot = await rejected.set(agent, { objective: 'ship it' })
    expect(snapshot.planVersion).toBe(1)
    const failed = scheduler(async () => {
      throw new Error('child boom')
    })
    const after = await failed.set(stubAgent(), { objective: 'ship it' })
    expect(after.status).toBe('complete')
  })
})
