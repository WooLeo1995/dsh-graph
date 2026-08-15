import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import { createLifecycleEmitter } from '@deepseek-ai/dsh-subagent/src/lifecycle.ts'
import { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { WorkGraphError, WorkGraphId, WorkNodeId } from '@deepseek-ai/dsh-workgraph'
import type { WorkGraphSnapshot } from '@deepseek-ai/dsh-workgraph'
import { canonicalNodeId, OPTIMIZER_OUTPUT_SCHEMA, WorkGraphScheduler, VERIFIER_OUTPUT_SCHEMA } from '@deepseek-ai/dsh-workgraph-scheduler'
import type { PlannerSpawn, PlannerSpawnResult } from '@deepseek-ai/dsh-workgraph-scheduler'
import type { WorkerRound, WorkerRoundRequest, WorkerRoundResult, WorkerSpawn, WorkerSpawnResult, ChildUsage } from '@deepseek-ai/dsh-workgraph-scheduler'
import { driveSerial } from '@deepseek-ai/dsh-workgraph-scheduler/src/serial.ts'
import type { SerialDriverHooks } from '@deepseek-ai/dsh-workgraph-scheduler/src/serial.ts'

function stubAgent(): Agent {
  const session = Session.create(SessionId('workgraph-scheduler-test'))
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

const VALID_ARTIFACT: PlannerSpawnResult = {
  structured: {
    nodes: [
      { id: 'a', title: 'A', spec: 'do a', deps: [] },
      { id: 'b', title: 'B', spec: 'do b', deps: ['a'] },
    ],
  },
  stopReason: 'completed',
}

/** A spawn scripting one result per call; the last result repeats forever. */
function scripted(...artifacts: PlannerSpawnResult[]): PlannerSpawn {
  let call = 0
  return async () => artifacts[Math.min(call++, artifacts.length - 1)]!
}

/** A worker round scripting one outcome per call; the last repeats. */
function scriptedRound(...results: WorkerRoundResult[]): WorkerRound {
  let call = 0
  return async () => results[Math.min(call++, results.length - 1)]!
}

const ROUND_DONE: WorkerRoundResult = {
  outcome: { kind: 'done', summary: 'done as specified', discovered: [] },
  childSessionId: 'child-1',
}

/** A verifier spawn scripting one verdict per call; the last repeats. */
function scriptedVerifier(...verdicts: WorkerSpawnResult[]): WorkerSpawn {
  let call = 0
  return async () => verdicts[Math.min(call++, verdicts.length - 1)]!
}

const VERDICT_ACHIEVED: WorkerSpawnResult = {
  structured: { verdict: 'achieved', gaps: [], discovered: [] },
  stopReason: 'completed',
}

/** A usage reader scripting charges per call; the last repeats. */
function scriptedUsage(...charges: ChildUsage[]): (id: string) => Promise<ChildUsage> {
  let call = 0
  const reader = async () => charges[Math.min(call++, charges.length - 1)]!
  return reader
}

const RECORDED_USAGE: ChildUsage = { tokens: 5, recorded: true }

function pendingSnapshot(id: string): WorkGraphSnapshot {
  return {
    id: WorkGraphId(id),
    objective: 'plan me',
    status: 'infra_paused',
    pauseReason: 'plan rejected twice: cycle',
    planVersion: 1,
    nodes: [],
    pendingDiscoveries: [],
    history: [
      { at: 1, kind: 'created' },
      { at: 2, kind: 'planning-failed', detail: 'plan rejected twice: cycle' },
    ],
    tokensSpent: 0,
    replanRuns: 0,
    createdAt: 1,
    updatedAt: 2,
  }
}

/** An installed active snapshot: a → b plus the gated final, roots ready. */
function installedSnapshot(id: string, objective: string): WorkGraphSnapshot {
  const a = canonicalNodeId('a')
  const b = canonicalNodeId('b')
  return {
    id: WorkGraphId(id),
    objective,
    status: 'active',
    planVersion: 1,
    nodes: [
      { id: a, title: 'A', spec: 'do a', blocks: [], state: 'ready', rounds: 0 },
      { id: b, title: 'B', spec: 'do b', blocks: [a], state: 'waiting', rounds: 0 },
      { id: WorkNodeId('gn-final'), title: 'Final verification of the overall objective', spec: 'verify', blocks: [a, b], state: 'waiting', rounds: 0 },
    ],
    pendingDiscoveries: [],
    history: [{ at: 1, kind: 'created' }],
    tokensSpent: 0,
    replanRuns: 0,
    createdAt: 1,
    updatedAt: 1,
  }
}

function failedChainSnapshot(): WorkGraphSnapshot {
  const a = canonicalNodeId('a')
  const b = canonicalNodeId('b')
  const final = WorkNodeId('gn-final')
  return {
    id: WorkGraphId('wg-seeded'),
    objective: 'ship it',
    status: 'blocked',
    pauseReason: 'wedge',
    planVersion: 1,
    nodes: [
      { id: a, title: 'A', spec: 'do a', blocks: [], state: 'failed', rounds: 1, failure: 'boom' },
      { id: b, title: 'B', spec: 'do b', blocks: [a], state: 'blocked', rounds: 0, failure: 'blocked: dependency chain failed at ' + a },
      { id: final, title: 'Final verification of the overall objective', spec: 'verify', blocks: [a, b], state: 'blocked', rounds: 0, failure: 'blocked: dependency chain failed at ' + a },
    ],
    pendingDiscoveries: [],
    history: [{ at: 1, kind: 'node-failed', node: a, detail: 'boom' }],
    tokensSpent: 0,
    replanRuns: 0,
    createdAt: 1,
    updatedAt: 2,
  }
}

describe('WorkGraphScheduler', () => {
  let dir: string
  let agent: Agent

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'workgraph-scheduler-'))
    agent = stubAgent()
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function scheduler(
    planner: PlannerSpawn = scripted(VALID_ARTIFACT),
    round: WorkerRound = scriptedRound(ROUND_DONE),
    verifier: WorkerSpawn = scriptedVerifier(VERDICT_ACHIEVED),
    usage: (id: string) => Promise<ChildUsage> = scriptedUsage(RECORDED_USAGE),
    nodeRounds?: number,
    options?: { replanner?: PlannerSpawn; replanCap?: number },
    emptyReplanner: PlannerSpawn = async () => ({ structured: { nodes: [] }, stopReason: 'completed' }),
  ): WorkGraphScheduler {
    return new WorkGraphScheduler(new Context(), {
      workgraphDir: dir,
      plannerSpawn: planner,
      workerRound: round,
      verifierSpawn: verifier,
      readChildUsage: usage,
      ...(nodeRounds === undefined ? {} : { nodeRounds }),
      replannerSpawn: options?.replanner ?? emptyReplanner,
      ...(options?.replanCap === undefined ? {} : { replanCap: options.replanCap }),
      // Bounded-settlement tests gate children after pause; keep the pause
      // wait short so the budget race resolves instead of hanging the suite.
      childAwaitBudget: 0.02,
    })
  }

  describe('set', () => {
    it('installs a valid plan, drives it serially to completion, and freezes baseline v1', async () => {
      const s = scheduler()
      const snapshot = await s.set(agent, { objective: 'ship it' })
      expect(snapshot.status).toBe('complete')
      expect(snapshot.nodes.map(node => node.id)).toEqual([
        canonicalNodeId('a'),
        canonicalNodeId('b'),
        WorkNodeId('gn-final'),
      ])
      expect(snapshot.nodes.every(node => node.state === 'achieved')).toBe(true)
      expect(snapshot.tokensSpent).toBe(15)
      expect(snapshot.history.map(entry => entry.kind)).toEqual([
        'created',
        'planning-started',
        'planning-completed',
        'node-started',
        'node-achieved',
        'node-started',
        'node-achieved',
        'node-started',
        'node-achieved',
        'completed',
      ])
      const events = agent.session.events.filter(event => event.type === 'workgraph/change')
      expect(events.length).toBeGreaterThanOrEqual(2)
      const first = events[0]!.data as { kind: 'workgraph/change'; version: 1; graph: WorkGraphSnapshot }
      const last = events.at(-1)!.data as { kind: 'workgraph/change'; version: 1; graph: WorkGraphSnapshot }
      expect(first.graph.nodes).toEqual([])
      expect(last.graph).toEqual(snapshot)
      // The v1 baseline is frozen BEFORE any node runs (create-new semantics):
      // it carries the installed node set, not the settled one.
      const baselineText = await readFile(join(dir, 'workgraph', 'baselines', snapshot.id, 'v1.json'), 'utf8')
      const baseline = JSON.parse(baselineText) as Array<{ id: string; state: string; rounds: number }>
      expect(baseline.map(node => node.id)).toEqual(snapshot.nodes.map(node => node.id))
      expect(baseline.every(node => node.state === 'waiting' || node.state === 'ready')).toBe(true)
      expect(baseline.every(node => node.rounds === 0)).toBe(true)
    })

    it('retries an invalid artifact exactly once, feeding the reason back', async () => {
      const prompts: string[] = []
      const spawn: PlannerSpawn = async ({ prompt }) => {
        prompts.push(prompt)
        return prompts.length === 1
          ? { structured: { nodes: [{ id: 'a', title: 'A', spec: 'do a', deps: ['a'] }] }, stopReason: 'completed' }
          : VALID_ARTIFACT
      }
      const s = scheduler(spawn)
      const snapshot = await s.set(agent, { objective: 'ship it' })
      expect(snapshot.status).toBe('complete')
      expect(prompts).toHaveLength(2)
      expect(prompts[1]).toContain('node "a" depends on itself')
    })

    it('pauses infra after a second invalid artifact', async () => {
      const spawn = scripted(
        { structured: { nodes: [{ id: 'a', title: 'A', spec: 'do a', deps: ['a'] }] }, stopReason: 'completed' },
        { structured: { nodes: [{ id: 'a', title: 'A', spec: 'do a', deps: ['a'] }] }, stopReason: 'completed' },
      )
      const s = scheduler(spawn)
      const snapshot = await s.set(agent, { objective: 'ship it' })
      expect(snapshot.status).toBe('infra_paused')
      expect(snapshot.pauseReason).toContain('plan rejected twice')
      expect(snapshot.nodes).toEqual([])
    })

    it('pauses infra when the planner child fails closed', async () => {
      const s = scheduler(scripted({ structured: undefined, stopReason: 'error' }))
      const snapshot = await s.set(agent, { objective: 'ship it' })
      expect(snapshot.status).toBe('infra_paused')
      expect(snapshot.pauseReason).toContain('graph planning failed')
      expect(snapshot.pauseReason).toContain('stop reason "error"')
    })

    it('rejects an empty objective and a non-positive budget', async () => {
      const s = scheduler()
      await expect(s.set(agent, { objective: '   ' })).rejects.toEqual(
        new WorkGraphError('objective must be non-empty', 'WORKGRAPH_INVALID_OBJECTIVE'),
      )
      await expect(s.set(agent, { objective: 'ship it', tokenBudget: 0 })).rejects.toEqual(
        new WorkGraphError('token budget must be a positive integer', 'WORKGRAPH_INVALID_BUDGET'),
      )
      await expect(s.set(agent, { objective: 'ship it', tokenBudget: 1.5 })).rejects.toEqual(
        new WorkGraphError('token budget must be a positive integer', 'WORKGRAPH_INVALID_BUDGET'),
      )
    })

    it('refuses a second graph while one is set (even paused)', async () => {
      const s = scheduler(scripted({ structured: undefined, stopReason: 'error' }))
      await s.set(agent, { objective: 'ship it' })
      await expect(s.set(agent, { objective: 'again' })).rejects.toEqual(
        new WorkGraphError('a work graph is already set; clear it or resume it first', 'WORKGRAPH_ALREADY_EXISTS'),
      )
    })
  })

  describe('serial execution', () => {
    it('executes a chain in dependency order with checkpoints at every transition', async () => {
      const prompts: string[] = []
      const round: WorkerRound = async (request) => {
        prompts.push(request.prompt)
        return ROUND_DONE
      }
      const s = scheduler(scripted(VALID_ARTIFACT), round)
      const snapshot = await s.set(agent, { objective: 'ship it' })
      expect(snapshot.status).toBe('complete')
      // The worker prompts carry the node contract, the graph objective, the
      // complete-only-this-scope discipline, and the (empty) gaps section.
      expect(prompts).toHaveLength(3)
      expect(prompts[0]).toContain('[Graph node 1/3: A]')
      expect(prompts[0]).toContain('do a')
      expect(prompts[0]).toContain('This node is one unit of a larger graph objective:\nship it')
      expect(prompts[0]).toContain("complete ONLY this node's scope")
      expect(prompts[0]).toContain('## GAPS')
      expect(prompts[1]).toContain('[Graph node 2/3: B]')
      // The child session id lands in the durable node state.
      const a = snapshot.nodes.find(node => node.id === canonicalNodeId('a'))!
      expect(a.childSessionId).toBe('child-1')
    })

    it('falls back to the committed snapshot when a clear lands during the bounded settle wait', async () => {
      let release!: (result: WorkerRoundResult) => void
      const gate = new Promise<WorkerRoundResult>((resolve) => { release = resolve })
      const round: WorkerRound = async () => gate
      const s = scheduler(scripted(VALID_ARTIFACT), round)
      const pending = s.set(agent, { objective: 'ship it' })
      await new Promise<void>(resolve => setTimeout(resolve, 10))
      const pausing = s.pause(agent, 'stop now')
      // The clear tombstones the graph while pause awaits the bounded
      // settle; the drive rejects, the wait resolves, and pause hands back
      // the committed snapshot (the live view is gone).
      await s.clear(agent)
      release(ROUND_DONE)
      const paused = await pausing
      expect(paused.status).toBe('user_paused')
      await expect(pending).rejects.toEqual(
        new WorkGraphError('graph cleared mid-episode', 'WORKGRAPH_NOT_FOUND'),
      )
    })

    it('demotes the in-flight node when a pause lands during the failure usage read', async () => {
      let releaseUsage!: () => void
      const usageGate = new Promise<void>((resolve) => { releaseUsage = resolve })
      const round = scriptedRound({
        outcome: { kind: 'blocked', reason: 'no toolchain here', discovered: [] },
        childSessionId: 'c1',
      })
      const s = scheduler(scripted(VALID_ARTIFACT), round, scriptedVerifier(VERDICT_ACHIEVED), async () => {
        await usageGate
        return RECORDED_USAGE
      })
      const pending = s.set(agent, { objective: 'ship it' })
      await new Promise<void>(resolve => setTimeout(resolve, 10))
      const paused = await s.pause(agent, 'stop now')
      expect(paused.status).toBe('user_paused')
      releaseUsage()
      const final = await pending
      expect(final.status).toBe('user_paused')
      const a = final.nodes.find(node => node.id === canonicalNodeId('a'))!
      expect(a.state).toBe('ready')
    })

    it('fails the node and blocks dependents on a blocked report', async () => {
      const round = scriptedRound({
        outcome: { kind: 'blocked', reason: 'no toolchain here', discovered: [] },
        childSessionId: 'c1',
      })
      const s = scheduler(scripted(VALID_ARTIFACT), round)
      const snapshot = await s.set(agent, { objective: 'ship it' })
      expect(snapshot.status).toBe('blocked')
      expect(snapshot.pauseReason).toContain('No runnable node left')
      const a = snapshot.nodes.find(node => node.id === canonicalNodeId('a'))!
      expect(a.state).toBe('failed')
      expect(a.failure).toBe('no toolchain here')
      const b = snapshot.nodes.find(node => node.id === canonicalNodeId('b'))!
      expect(b.state).toBe('blocked')
      expect(snapshot.history.map(entry => entry.kind)).toContain('node-failed')
    })

    it('fails the node fail-closed on a missing report', async () => {
      const round = scriptedRound({
        outcome: { kind: 'unparseable', reason: 'worker produced no structured report' },
        childSessionId: 'c1',
      })
      const s = scheduler(scripted(VALID_ARTIFACT), round)
      const snapshot = await s.set(agent, { objective: 'ship it' })
      expect(snapshot.status).toBe('blocked')
      const a = snapshot.nodes.find(node => node.id === canonicalNodeId('a'))!
      expect(a.state).toBe('failed')
      expect(a.failure).toBe('worker report unparseable: worker produced no structured report')
    })

    it('fails the node fail-closed when the worker child errors', async () => {
      const round = scriptedRound({
        outcome: { kind: 'fail-closed', reason: 'worker child ended with stop reason "error"' },
        childSessionId: 'c1',
      })
      const s = scheduler(scripted(VALID_ARTIFACT), round)
      const snapshot = await s.set(agent, { objective: 'ship it' })
      const a = snapshot.nodes.find(node => node.id === canonicalNodeId('a'))!
      expect(a.state).toBe('failed')
      expect(a.failure).toBe('worker episode failed: worker child ended with stop reason "error"')
    })

    it('queues reported discoveries for the replan boundary', async () => {
      const round = scriptedRound(
        {
          outcome: { kind: 'done', summary: 'ok', discovered: ['fix the build', '  ', 'port the linter'] },
          childSessionId: 'c1',
        },
        ROUND_DONE,
        ROUND_DONE,
      )
      const s = scheduler(scripted(VALID_ARTIFACT), round)
      const snapshot = await s.set(agent, { objective: 'ship it' })
      // The empty appendix was a respected answer: the entries folded at the
      // replan boundary (a consumed slot, plan v2) instead of staying queued.
      expect(snapshot.pendingDiscoveries).toEqual([])
      expect(snapshot.planVersion).toBe(2)
      expect(snapshot.replanRuns).toBe(1)
    })

    it('pauses mid-node: the in-flight worker demotes to ready and resume re-runs it', async () => {
      let release!: (result: WorkerRoundResult) => void
      const gate = new Promise<WorkerRoundResult>((resolve) => { release = resolve })
      let calls = 0
      const round: WorkerRound = async () => {
        calls += 1
        return calls === 1 ? gate : ROUND_DONE
      }
      const s = scheduler(scripted(VALID_ARTIFACT), round)
      const pending = s.set(agent, { objective: 'ship it' })
      // Let the first worker spawn start, then pause: the abort fires and the
      // in-flight node demotes to ready — a resource stop, never a verdict.
      await new Promise<void>(resolve => setTimeout(resolve, 10))
      const paused = await s.pause(agent, 'stop now')
      expect(paused.status).toBe('user_paused')
      release({ outcome: { kind: 'fail-closed', reason: 'aborted' }, childSessionId: 'c1' })
      const final = await pending
      expect(final.status).toBe('user_paused')
      const a = final.nodes.find(node => node.id === canonicalNodeId('a'))!
      expect(a.state).toBe('ready')
      expect(a.childSessionId).toBeUndefined()
      const resumed = await s.resume(agent)
      expect(resumed.status).toBe('complete')
    })

    it('propagates a spawn transport failure when no pause intervened', async () => {
      const round: WorkerRound = async () => {
        throw new Error('transport boom')
      }
      const s = scheduler(scripted(VALID_ARTIFACT), round)
      await expect(s.set(agent, { objective: 'ship it' })).rejects.toThrow('transport boom')
    })

    it('demotes the in-flight node when the spawn throws after a pause', async () => {
      let reject!: (error: Error) => void
      const gate = new Promise<WorkerRoundResult>((_resolve, rej) => { reject = rej })
      let calls = 0
      const round: WorkerRound = async () => {
        calls += 1
        return calls === 1 ? gate : ROUND_DONE
      }
      const s = scheduler(scripted(VALID_ARTIFACT), round)
      const pending = s.set(agent, { objective: 'ship it' })
      await new Promise<void>(resolve => setTimeout(resolve, 10))
      await s.pause(agent, 'stop now')
      reject(new Error('transport boom'))
      const final = await pending
      expect(final.status).toBe('user_paused')
      const a = final.nodes.find(node => node.id === canonicalNodeId('a'))!
      expect(a.state).toBe('ready')
    })

    it('demotes on the authoritative snapshot when a pause lands after the markRunning commit', async () => {
      let releaseUsage!: () => void
      const usageGate = new Promise<void>((resolve) => { releaseUsage = resolve })
      const round: WorkerRound = async () => ROUND_DONE
      const s = scheduler(scripted(VALID_ARTIFACT), round, scriptedVerifier(VERDICT_ACHIEVED), async () => {
        await usageGate
        return RECORDED_USAGE
      })
      const pending = s.set(agent, { objective: 'ship it' })
      // Wait until the first markRunning commit lands (the usage read gates
      // the flow after it), then pause: the abort hits after the commit.
      await new Promise<void>(resolve => setTimeout(resolve, 10))
      const paused = await s.pause(agent, 'stop now')
      expect(paused.status).toBe('user_paused')
      releaseUsage()
      const final = await pending
      expect(final.status).toBe('user_paused')
      const a = final.nodes.find(node => node.id === canonicalNodeId('a'))!
      expect(a.state).toBe('ready')
    })

    it('leaves a foreign stuck graph active when nothing is runnable', async () => {
      // Foreign data can fold into a user-paused graph whose only terminals
      // are failed/blocked: resume re-activates it, the drive finds no ready
      // node, and the graph stays active (honest, not wedged by the tracker).
      agent.session.append('workgraph/change', {
        kind: 'workgraph/change',
        version: 1,
        graph: {
          ...failedChainSnapshot(),
          status: 'user_paused',
          pauseReason: 'restored',
        },
      })
      const s = scheduler()
      const resumed = await s.resume(agent)
      expect(resumed.status).toBe('active')
      expect(resumed.nodes.some(node => node.state === 'ready')).toBe(false)
    })

    it('rejects with NOT_FOUND when the graph is cleared mid-episode', async () => {
      let release!: (result: WorkerRoundResult) => void
      const gate = new Promise<WorkerRoundResult>((resolve) => { release = resolve })
      const round: WorkerRound = async () => gate
      const s = scheduler(scripted(VALID_ARTIFACT), round)
      const pending = s.set(agent, { objective: 'ship it' })
      await new Promise<void>(resolve => setTimeout(resolve, 10))
      await s.clear(agent)
      release(ROUND_DONE)
      await expect(pending).rejects.toEqual(
        new WorkGraphError('graph cleared mid-episode', 'WORKGRAPH_NOT_FOUND'),
      )
    })

    it('returns the planned snapshot when a clear lands during planning', async () => {
      let releasePlan!: (result: PlannerSpawnResult) => void
      const planGate = new Promise<PlannerSpawnResult>((resolve) => { releasePlan = resolve })
      const planner: PlannerSpawn = async () => planGate
      const s = scheduler(planner)
      const pending = s.set(agent, { objective: 'ship it' })
      await new Promise<void>(resolve => setTimeout(resolve, 10))
      await s.clear(agent)
      releasePlan(VALID_ARTIFACT)
      const snapshot = await pending
      // The drive never dispatched (aborted before its first iteration), so
      // set() falls back to the planned snapshot it holds.
      expect(snapshot.status).toBe('active')
      expect(snapshot.nodes).toHaveLength(3)
    })
  })

  describe('verifier rounds', () => {
    const REJECTED = (gaps: string[]): WorkerSpawnResult => ({
      structured: { verdict: 'not_achieved', gaps, discovered: ['rejection follow-up'] },
      stopReason: 'completed',
    })

    it('iterates the SAME worker child with exactly the named gaps after a rejection', async () => {
      const requests: WorkerRoundRequest[] = []
      const round: WorkerRound = async (request) => {
        requests.push(request)
        return ROUND_DONE
      }
      const verifier = scriptedVerifier(REJECTED(['tests fail', 'lint broken']), VERDICT_ACHIEVED)
      const s = scheduler(scripted(VALID_ARTIFACT), round, verifier)
      const snapshot = await s.set(agent, { objective: 'ship it' })
      expect(snapshot.status).toBe('complete')
      // a iterates two rounds; b and the final node pass on their first.
      expect(requests).toHaveLength(4)
      expect(requests[0]!.round).toBe(1)
      expect(requests[1]!.round).toBe(2)
      // Round 2 continues the durable child from round 1's result.
      expect(requests[1]!.childSessionId).toBe('child-1')
      expect(requests[1]!.prompt).toContain('- tests fail')
      expect(requests[1]!.prompt).toContain('- lint broken')
      expect(requests[2]!.round).toBe(1)
      // The settled node records both worker rounds.
      const a = snapshot.nodes.find(node => node.id === canonicalNodeId('a'))!
      expect(a.rounds).toBe(2)
    })

    it('fails the node naming the last gaps when the rounds cap is exhausted', async () => {
      const s = scheduler(
        scripted(VALID_ARTIFACT),
        scriptedRound(ROUND_DONE, ROUND_DONE),
        scriptedVerifier(REJECTED(['gap one']), REJECTED(['gap one'])),
        scriptedUsage(RECORDED_USAGE),
        2,
      )
      const snapshot = await s.set(agent, { objective: 'ship it' })
      expect(snapshot.status).toBe('blocked')
      const a = snapshot.nodes.find(node => node.id === canonicalNodeId('a'))!
      expect(a.state).toBe('failed')
      expect(a.failure).toContain('verifier rounds exhausted (2)')
      expect(a.failure).toContain('gap one')
      expect(a.rounds).toBe(2)
    })

    it('never passes on an errored verifier run', async () => {
      const s = scheduler(
        scripted(VALID_ARTIFACT),
        scriptedRound(ROUND_DONE),
        scriptedVerifier({ structured: undefined, stopReason: 'error' }),
      )
      const snapshot = await s.set(agent, { objective: 'ship it' })
      const a = snapshot.nodes.find(node => node.id === canonicalNodeId('a'))!
      expect(a.state).toBe('failed')
      expect(a.failure).toContain('verifier child ended with stop reason "error"')
    })

    it('treats a gap-less rejection as invalid and fails the node', async () => {
      const s = scheduler(
        scripted(VALID_ARTIFACT),
        scriptedRound(ROUND_DONE),
        scriptedVerifier(REJECTED([])),
      )
      const snapshot = await s.set(agent, { objective: 'ship it' })
      const a = snapshot.nodes.find(node => node.id === canonicalNodeId('a'))!
      expect(a.state).toBe('failed')
      expect(a.failure).toContain('verifier rejected without naming any gaps')
    })

    it('queues discoveries from the verifier', async () => {
      let verifies = 0
      const verifier: WorkerSpawn = async () => {
        verifies += 1
        return {
          structured: {
            verdict: 'achieved',
            gaps: [],
            discovered: verifies === 1 ? ['verify the docs too'] : [],
          },
          stopReason: 'completed',
        }
      }
      const s = scheduler(scripted(VALID_ARTIFACT), scriptedRound(ROUND_DONE), verifier)
      const snapshot = await s.set(agent, { objective: 'ship it' })
      // The verifier discovery folded at the replan boundary.
      expect(snapshot.pendingDiscoveries).toEqual([])
      expect(snapshot.planVersion).toBe(2)
      expect(snapshot.replanRuns).toBe(1)
    })

    it('demotes the in-flight node when a pause lands during the second worker round', async () => {
      let releaseRound2!: (result: WorkerRoundResult) => void
      const round2Gate = new Promise<WorkerRoundResult>((resolve) => { releaseRound2 = resolve })
      let round = 1
      const roundSeam: WorkerRound = async () => {
        if (round++ === 2) return round2Gate
        return ROUND_DONE
      }
      const verifier = scriptedVerifier(REJECTED(['again']), REJECTED(['again']))
      const s = scheduler(scripted(VALID_ARTIFACT), roundSeam, verifier)
      const pending = s.set(agent, { objective: 'ship it' })
      await new Promise<void>(resolve => setTimeout(resolve, 10))
      const paused = await s.pause(agent, 'stop now')
      expect(paused.status).toBe('user_paused')
      releaseRound2(ROUND_DONE)
      const final = await pending
      expect(final.status).toBe('user_paused')
      const a = final.nodes.find(node => node.id === canonicalNodeId('a'))!
      expect(a.state).toBe('ready')
    })

    it('demotes the in-flight node when a pause lands during the verifier run', async () => {
      let releaseVerdict!: (result: WorkerSpawnResult) => void
      const verdictGate = new Promise<WorkerSpawnResult>((resolve) => { releaseVerdict = resolve })
      const verifier: WorkerSpawn = async () => verdictGate
      const s = scheduler(scripted(VALID_ARTIFACT), scriptedRound(ROUND_DONE), verifier)
      const pending = s.set(agent, { objective: 'ship it' })
      await new Promise<void>(resolve => setTimeout(resolve, 10))
      const paused = await s.pause(agent, 'stop now')
      expect(paused.status).toBe('user_paused')
      releaseVerdict(VERDICT_ACHIEVED)
      const final = await pending
      expect(final.status).toBe('user_paused')
      const a = final.nodes.find(node => node.id === canonicalNodeId('a'))!
      expect(a.state).toBe('ready')
    })

    it('renders the verifier prompt with the node contract and the worker summary', async () => {
      const prompts: string[] = []
      const verifier: WorkerSpawn = async (request) => {
        prompts.push(request.prompt)
        return VERDICT_ACHIEVED
      }
      const s = scheduler(scripted(VALID_ARTIFACT), scriptedRound(ROUND_DONE), verifier)
      await s.set(agent, { objective: 'ship it' })
      expect(prompts[0]).toContain('[Graph node 1/3: A]')
      expect(prompts[0]).toContain('done as specified')
      expect(prompts[0]).toContain('Do NOT modify any file')
    })
  })

  describe('replan', () => {
    const APPENDIX = (nodes: Array<{ id: string; title: string; spec: string; deps: string[] }>): PlannerSpawnResult => ({
      structured: { nodes },
      stopReason: 'completed',
    })

    it('appends a discovered node, bumps the plan version, re-gates gn-final, and freezes the new baseline', async () => {
      const round = scriptedRound(
        {
          outcome: { kind: 'done', summary: 'ok', discovered: ['port the linter'] },
          childSessionId: 'c1',
        },
        ROUND_DONE,
        ROUND_DONE,
        ROUND_DONE,
      )
      const replanner: PlannerSpawn = async () => APPENDIX([{ id: 'c', title: 'C', spec: 'do c', deps: [] }])
      const s = scheduler(
        scripted(VALID_ARTIFACT),
        round,
        scriptedVerifier(VERDICT_ACHIEVED),
        scriptedUsage(RECORDED_USAGE),
        3,
        { replanner },
      )
      const snapshot = await s.set(agent, { objective: 'ship it' })
      expect(snapshot.status).toBe('complete')
      expect(snapshot.planVersion).toBe(2)
      expect(snapshot.replanRuns).toBe(1)
      expect(snapshot.pendingDiscoveries).toEqual([])
      // The discovered node ran and achieved; gn-final re-gated over it.
      const c = snapshot.nodes.find(node => node.id === canonicalNodeId('c'))!
      expect(c.state).toBe('achieved')
      const final = snapshot.nodes.find(node => node.id === 'gn-final')!
      expect(final.blocks).toContain(canonicalNodeId('c'))
      // Both baselines are frozen; v1 untouched.
      const v2 = await readFile(join(dir, 'workgraph', 'baselines', snapshot.id, 'v2.json'), 'utf8')
      expect(JSON.parse(v2)).toHaveLength(4)
      const v1 = await readFile(join(dir, 'workgraph', 'baselines', snapshot.id, 'v1.json'), 'utf8')
      expect(JSON.parse(v1)).toHaveLength(3)
    })

    it('treats an empty appendix as a respected answer that still consumes a slot', async () => {
      const round = scriptedRound(
        { outcome: { kind: 'done', summary: 'ok', discovered: ['covered already'] }, childSessionId: 'c1' },
        ROUND_DONE,
        ROUND_DONE,
      )
      const s = scheduler(scripted(VALID_ARTIFACT), round)
      const snapshot = await s.set(agent, { objective: 'ship it' })
      expect(snapshot.status).toBe('complete')
      expect(snapshot.planVersion).toBe(2)
      expect(snapshot.replanRuns).toBe(1)
      expect(snapshot.pendingDiscoveries).toEqual([])
    })

    it('drains discoveries to history when the replan cap is exhausted', async () => {
      const round = scriptedRound(
        { outcome: { kind: 'done', summary: 'ok', discovered: ['more work'] }, childSessionId: 'c1' },
        ROUND_DONE,
        ROUND_DONE,
      )
      let replans = 0
      const replanner: PlannerSpawn = async () => {
        replans += 1
        return APPENDIX([{ id: 'c', title: 'C', spec: 'do c', deps: [] }])
      }
      // replanCap 1: the first discovery consumes the slot; a second wave drains.
      const s = scheduler(
        scripted(VALID_ARTIFACT),
        round,
        scriptedVerifier(VERDICT_ACHIEVED),
        scriptedUsage(RECORDED_USAGE),
        3,
        { replanner, replanCap: 1 },
      )
      const snapshot = await s.set(agent, { objective: 'ship it' })
      expect(snapshot.status).toBe('complete')
      expect(replans).toBe(1)
      // The second wave drained to history at the exhausted cap.
      expect(snapshot.replanRuns).toBe(1)
      expect(snapshot.pendingDiscoveries).toEqual([])
      expect(snapshot.history.map(entry => entry.kind)).toContain('replanned')
    })

    it('retries an invalid appendix once with feedback, then degrades to history', async () => {
      const round = scriptedRound(
        { outcome: { kind: 'done', summary: 'ok', discovered: ['more work'] }, childSessionId: 'c1' },
        ROUND_DONE,
        ROUND_DONE,
      )
      const prompts: string[] = []
      const replanner: PlannerSpawn = async (request) => {
        prompts.push(request.prompt)
        // A self-dependency appendix is invalid.
        return APPENDIX([{ id: 'c', title: 'C', spec: 'do c', deps: ['c'] }])
      }
      const s = scheduler(
        scripted(VALID_ARTIFACT),
        round,
        scriptedVerifier(VERDICT_ACHIEVED),
        scriptedUsage(RECORDED_USAGE),
        3,
        { replanner },
      )
      const snapshot = await s.set(agent, { objective: 'ship it' })
      expect(snapshot.status).toBe('complete')
      expect(prompts).toHaveLength(2)
      expect(prompts[1]).toContain('depends on itself')
      expect(snapshot.replanRuns).toBe(1)
      expect(snapshot.pendingDiscoveries).toEqual([])
    })

    it('drains to history when the final node already achieved (advisory discoveries)', async () => {
      // The final node reports a discovery as it achieves; the replan gate
      // drains it to history instead of appending unverified work.
      const round = scriptedRound(ROUND_DONE, ROUND_DONE, {
        outcome: { kind: 'done', summary: 'done', discovered: ['advisory'] },
        childSessionId: 'final-child',
      })
      let replans = 0
      const replanner: PlannerSpawn = async () => {
        replans += 1
        return APPENDIX([{ id: 'c', title: 'C', spec: 'do c', deps: [] }])
      }
      const s = scheduler(
        scripted(VALID_ARTIFACT),
        round,
        scriptedVerifier(VERDICT_ACHIEVED),
        scriptedUsage(RECORDED_USAGE),
        3,
        { replanner },
      )
      const snapshot = await s.set(agent, { objective: 'ship it' })
      expect(snapshot.status).toBe('complete')
      expect(replans).toBe(0)
      expect(snapshot.pendingDiscoveries).toEqual([])
      expect(snapshot.planVersion).toBe(1)
    })

    it('rejects an appendix that depends on a dead or unknown node', async () => {
      const round = scriptedRound(
        { outcome: { kind: 'done', summary: 'ok', discovered: ['more work'] }, childSessionId: 'c1' },
        ROUND_DONE,
        ROUND_DONE,
      )
      let calls = 0
      const replanner: PlannerSpawn = async () => {
        calls += 1
        return APPENDIX([{ id: 'c', title: 'C', spec: 'do c', deps: ['gn-00000000'] }])
      }
      const s = scheduler(
        scripted(VALID_ARTIFACT),
        round,
        scriptedVerifier(VERDICT_ACHIEVED),
        scriptedUsage(RECORDED_USAGE),
        3,
        { replanner },
      )
      const snapshot = await s.set(agent, { objective: 'ship it' })
      console.log('DBG guard states:', snapshot.nodes.map(n => `${n.id}:${n.state}:${n.failure ?? ''}`).join(' | '))
      expect(snapshot.status).toBe('complete')
      expect(calls).toBe(2)
      expect(snapshot.replanRuns).toBe(1)
    })

    it('drains quietly when replanning is disabled (cap 0)', async () => {
      const round = scriptedRound(
        { outcome: { kind: 'done', summary: 'ok', discovered: ['more work'] }, childSessionId: 'c1' },
        ROUND_DONE,
        ROUND_DONE,
      )
      let replans = 0
      const replanner: PlannerSpawn = async () => {
        replans += 1
        return APPENDIX([{ id: 'c', title: 'C', spec: 'do c', deps: [] }])
      }
      const s = scheduler(
        scripted(VALID_ARTIFACT),
        round,
        scriptedVerifier(VERDICT_ACHIEVED),
        scriptedUsage(RECORDED_USAGE),
        3,
        { replanner, replanCap: 0 },
      )
      const snapshot = await s.set(agent, { objective: 'ship it' })
      expect(snapshot.status).toBe('complete')
      expect(replans).toBe(0)
      expect(snapshot.pendingDiscoveries).toEqual([])
      expect(snapshot.planVersion).toBe(1)
    })

    it('keeps discoveries queued when the budget is exhausted at the boundary', async () => {
      agent.session.append('workgraph/change', {
        kind: 'workgraph/change',
        version: 1,
        graph: {
          ...installedSnapshot('wg-seeded', 'ship it'),
          tokenBudget: 5,
          tokensSpent: 5,
          pendingDiscoveries: [{ description: 'queued work', from: canonicalNodeId('a') }],
          status: 'user_paused' as const,
          pauseReason: 'restored',
        },
      })
      const s = scheduler()
      // The dispatch gate trips before any replan: entries stay queued.
      const resumed = await s.resume(agent)
      expect(resumed.status).toBe('budget_limited')
      expect(resumed.pendingDiscoveries).toHaveLength(1)
    })

    it('replans within a budgeted graph and folds with the budget intact', async () => {
      const round = scriptedRound(
        { outcome: { kind: 'done', summary: 'ok', discovered: ['more work'] }, childSessionId: 'c1' },
        ROUND_DONE,
        ROUND_DONE,
        ROUND_DONE,
      )
      const replanner: PlannerSpawn = async () => APPENDIX([{ id: 'c', title: 'C', spec: 'do c', deps: [] }])
      const s = scheduler(
        scripted(VALID_ARTIFACT),
        round,
        scriptedVerifier(VERDICT_ACHIEVED),
        scriptedUsage({ tokens: 2, recorded: true }),
        3,
        { replanner },
      )
      const snapshot = await s.set(agent, { objective: 'ship it', tokenBudget: 100 })
      expect(snapshot.status).toBe('complete')
      expect(snapshot.planVersion).toBe(2)
    })

    it('pauses infra when freezing the replan baseline collides with an existing version', async () => {
      // A restored graph whose v2 baseline is already frozen: the replan
      // install bumps to v2, the freeze collides, and the graph pauses infra
      // with the baseline message — resume re-enters the pass.
      const seeded = {
        ...installedSnapshot('wg-seeded', 'ship it'),
        status: 'user_paused' as const,
        pauseReason: 'restored',
        pendingDiscoveries: [{ description: 'more work', from: canonicalNodeId('a') }],
      }
      agent.session.append('workgraph/change', {
        kind: 'workgraph/change',
        version: 1,
        graph: seeded,
      })
      const baselineDir = join(dir, 'workgraph', 'baselines', 'wg-seeded')
      await mkdir(baselineDir, { recursive: true })
      await writeFile(join(baselineDir, 'v2.json'), '[]\n')
      const replanner: PlannerSpawn = async () => APPENDIX([{ id: 'c', title: 'C', spec: 'do c', deps: [] }])
      const s = scheduler(
        scripted(VALID_ARTIFACT),
        scriptedRound(ROUND_DONE),
        scriptedVerifier(VERDICT_ACHIEVED),
        scriptedUsage(RECORDED_USAGE),
        3,
        { replanner },
      )
      const resumed = await s.resume(agent)
      expect(resumed.status).toBe('infra_paused')
      expect(resumed.pauseReason).toContain('failed to freeze the replan baseline')
    })

    it('rethrows a non-domain replan baseline failure instead of pausing', async () => {
      // A file squatting on the workgraph dir makes the replan's baseline
      // mkdir fail with a plain fs error, which must propagate — only
      // WorkGraphError pauses the graph.
      const seeded = {
        ...installedSnapshot('wg-seeded', 'ship it'),
        status: 'user_paused' as const,
        pauseReason: 'restored',
        pendingDiscoveries: [{ description: 'more work', from: canonicalNodeId('a') }],
      }
      agent.session.append('workgraph/change', {
        kind: 'workgraph/change',
        version: 1,
        graph: seeded,
      })
      await writeFile(join(dir, 'workgraph'), 'squat\n')
      const replanner: PlannerSpawn = async () => APPENDIX([{ id: 'c', title: 'C', spec: 'do c', deps: [] }])
      const s = scheduler(
        scripted(VALID_ARTIFACT),
        scriptedRound(ROUND_DONE),
        scriptedVerifier(VERDICT_ACHIEVED),
        scriptedUsage(RECORDED_USAGE),
        3,
        { replanner },
      )
      await expect(s.resume(agent)).rejects.toThrow()
    })
  })

  describe('budget', () => {
    it('trips the budget at a settlement and requires a top-up to resume', async () => {
      const s = scheduler(
        scripted(VALID_ARTIFACT),
        scriptedRound(ROUND_DONE, ROUND_DONE, ROUND_DONE),
        scriptedVerifier(VERDICT_ACHIEVED),
        scriptedUsage({ tokens: 6, recorded: true }, { tokens: 6, recorded: true }),
      )
      const snapshot = await s.set(agent, { objective: 'ship it', tokenBudget: 10 })
      expect(snapshot.status).toBe('budget_limited')
      expect(snapshot.pauseReason).toContain('budget exhausted')
      expect(snapshot.tokensSpent).toBe(12)
      expect(snapshot.history.map(entry => entry.kind)).toContain('budget-exceeded')
      const a = snapshot.nodes.find(node => node.id === canonicalNodeId('a'))!
      expect(a.state).toBe('achieved')
      await expect(s.resume(agent)).rejects.toEqual(
        new WorkGraphError('budget exhausted; top up with resume --budget <tokens>', 'WORKGRAPH_INVALID_BUDGET'),
      )
      const resumed = await s.resume(agent, { budget: 5 })
      expect(resumed.status).toBe('complete')
      expect(resumed.tokenBudget).toBe(17)
    })

    it('trips the budget at dispatch when a restored snapshot is already at zero', async () => {
      // Foreign data can fold into a blocked graph whose spend already
      // equals the budget; retry re-activates it and the dispatch gate trips.
      const seeded = { ...failedChainSnapshot(), tokenBudget: 5, tokensSpent: 5 }
      agent.session.append('workgraph/change', {
        kind: 'workgraph/change',
        version: 1,
        graph: seeded,
      })
      const s = scheduler()
      const snapshot = await s.retry(agent, canonicalNodeId('a'))
      expect(snapshot.status).toBe('budget_limited')
      expect(snapshot.history.map(entry => entry.kind)).toContain('budget-exceeded')
    })

    it('rejects a configured budget at set when the parent log shows no usage recording', async () => {
      agent.session.append('assistant/message', {
        turn: 1,
        step: 1,
        message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'hi' }], source: { kind: 'model', provider: 'mock', model: 'mock' } }),
      }, { surfaceOp: 'append', sourceEventSeqs: [] })
      const s = scheduler()
      await expect(s.set(agent, { objective: 'ship it', tokenBudget: 10 })).rejects.toEqual(
        new WorkGraphError(
          'token budget configured but the composition records no provider usage',
          'WORKGRAPH_INVALID_BUDGET',
        ),
      )
    })

    it('accepts a configured budget when the parent log carries usage evidence', async () => {
      agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'hello' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      agent.session.append('assistant/message', {
        turn: 1,
        step: 1,
        message: createMessage({ role: 'assistant', content: [{ type: 'text', text: 'hi' }], source: { kind: 'model', provider: 'mock', model: 'mock' } }),
        usage: { inputTokens: 2, outputTokens: 3 },
      }, { surfaceOp: 'append', sourceEventSeqs: [] })
      const s = scheduler()
      const snapshot = await s.set(agent, { objective: 'ship it', tokenBudget: 20 })
      expect(snapshot.status).toBe('complete')
      expect(snapshot.tokensSpent).toBe(15)
    })

    it('pauses infra on a failing first child when the composition records no usage', async () => {
      const round = scriptedRound({
        outcome: { kind: 'blocked', reason: 'no toolchain here', discovered: [] },
        childSessionId: 'c1',
      })
      const s = scheduler(
        scripted(VALID_ARTIFACT),
        round,
        scriptedVerifier(VERDICT_ACHIEVED),
        scriptedUsage({ tokens: 0, recorded: false }),
      )
      const snapshot = await s.set(agent, { objective: 'ship it', tokenBudget: 10 })
      expect(snapshot.status).toBe('infra_paused')
      expect(snapshot.pauseReason).toContain('records no provider usage')
      // The node demoted to ready — a resource stop, never a verdict.
      const a = snapshot.nodes.find(node => node.id === canonicalNodeId('a'))!
      expect(a.state).toBe('ready')
    })

    it('pauses infra at the first child when the composition records no usage', async () => {
      const s = scheduler(
        scripted(VALID_ARTIFACT),
        scriptedRound(ROUND_DONE),
        scriptedVerifier(VERDICT_ACHIEVED),
        scriptedUsage({ tokens: 0, recorded: false }),
      )
      const snapshot = await s.set(agent, { objective: 'ship it', tokenBudget: 10 })
      expect(snapshot.status).toBe('infra_paused')
      expect(snapshot.pauseReason).toContain('records no provider usage')
      const a = snapshot.nodes.find(node => node.id === canonicalNodeId('a'))!
      expect(a.state).toBe('ready')
    })
  })

  describe('status / pause / resume', () => {
    it('returns null before any graph is set and the snapshot afterwards', async () => {
      const s = scheduler()
      expect(await s.status(agent)).toBeNull()
      const snapshot = await s.set(agent, { objective: 'ship it' })
      expect(await s.status(agent)).toEqual(snapshot)
    })

    it('pauses an active graph as user-paused and resumes it into the drive', async () => {
      // Seed an installed graph through the session log (fold path); the
      // engine surface is what is under test here.
      const seeded = installedSnapshot('wg-seeded', 'ship it')
      agent.session.append('workgraph/change', {
        kind: 'workgraph/change',
        version: 1,
        graph: seeded,
      })
      const s = scheduler()
      const paused = await s.pause(agent, 'need a break')
      expect(paused.status).toBe('user_paused')
      expect(paused.pauseReason).toBe('need a break')
      const resumed = await s.resume(agent)
      expect(resumed.status).toBe('complete')
      expect(resumed.history.at(-1)!.kind).toBe('completed')
    })

    it('throws NOT_FOUND for operations without a graph', async () => {
      const s = scheduler()
      await expect(s.pause(agent)).rejects.toEqual(
        new WorkGraphError('no work graph is set', 'WORKGRAPH_NOT_FOUND'),
      )
      await expect(s.resume(agent)).rejects.toEqual(
        new WorkGraphError('no work graph is set', 'WORKGRAPH_NOT_FOUND'),
      )
      await expect(s.retry(agent, WorkNodeId('gn-aaaaaaaa'))).rejects.toEqual(
        new WorkGraphError('no work graph is set', 'WORKGRAPH_NOT_FOUND'),
      )
      await expect(s.clear(agent)).rejects.toEqual(
        new WorkGraphError('no work graph is set', 'WORKGRAPH_NOT_FOUND'),
      )
    })

    it('rejects pausing a complete graph and a bad resume top-up', async () => {
      const s = scheduler()
      const complete = await s.set(agent, { objective: 'ship it' })
      expect(complete.status).toBe('complete')
      await expect(s.pause(agent)).rejects.toEqual(
        new WorkGraphError('cannot pause a complete graph', 'WORKGRAPH_INVALID_TRANSITION'),
      )
      await expect(s.resume(agent, { budget: -1 })).rejects.toEqual(
        new WorkGraphError('budget top-up must be a positive integer', 'WORKGRAPH_INVALID_BUDGET'),
      )
      await expect(s.resume(agent)).rejects.toEqual(
        new WorkGraphError('cannot resume a complete graph', 'WORKGRAPH_INVALID_TRANSITION'),
      )
    })

    it('re-plans a pending graph on resume after a planning failure', async () => {
      const s = scheduler(scripted({ structured: undefined, stopReason: 'error' }, VALID_ARTIFACT))
      const failed = await s.set(agent, { objective: 'ship it' })
      expect(failed.status).toBe('infra_paused')
      const resumed = await s.resume(agent)
      expect(resumed.status).toBe('complete')
      expect(resumed.nodes).toHaveLength(3)
      expect(resumed.history.map(entry => entry.kind)).toContain('planning-completed')
    })

    it('pauses infra when the re-freeze of a seeded pending graph collides', async () => {
      // Seed a pending graph through the session log (fold path), with a
      // baseline file pre-created for its version so freeze fails loudly.
      agent.session.append('workgraph/change', {
        kind: 'workgraph/change',
        version: 1,
        graph: pendingSnapshot('wg-seeded'),
      })
      const baselineDir = join(dir, 'workgraph', 'baselines', 'wg-seeded')
      await mkdir(baselineDir, { recursive: true })
      await writeFile(join(baselineDir, 'v1.json'), '[]\n')
      const s = scheduler()
      const resumed = await s.resume(agent)
      expect(resumed.status).toBe('infra_paused')
      expect(resumed.pauseReason).toContain('failed to freeze the plan baseline')
    })

    it('fails closed on resume of a pending graph when the planner errors', async () => {
      agent.session.append('workgraph/change', {
        kind: 'workgraph/change',
        version: 1,
        graph: pendingSnapshot('wg-seeded'),
      })
      const s = scheduler(scripted({ structured: undefined, stopReason: 'error' }))
      const resumed = await s.resume(agent)
      expect(resumed.status).toBe('infra_paused')
      expect(resumed.pauseReason).toContain('graph planning failed')
    })
  })

  describe('retry / clear', () => {
    it('resets a failed node and its blocked chain through the fold path', async () => {
      agent.session.append('workgraph/change', {
        kind: 'workgraph/change',
        version: 1,
        graph: failedChainSnapshot(),
      })
      const s = scheduler()
      const snapshot = await s.retry(agent, canonicalNodeId('a'))
      // The reset batch re-runs through the serial episode to completion.
      expect(snapshot.status).toBe('complete')
      expect(snapshot.nodes.every(node => node.state === 'achieved')).toBe(true)
      expect(snapshot.history.map(entry => entry.kind)).toContain('node-retried')
    })

    it('refuses a retry whose upstream dependency is not achieved', async () => {
      agent.session.append('workgraph/change', {
        kind: 'workgraph/change',
        version: 1,
        graph: failedChainSnapshot(),
      })
      const s = scheduler()
      await expect(s.retry(agent, canonicalNodeId('b'))).rejects.toEqual(
        new WorkGraphError(
          `node ${canonicalNodeId('b')} cannot retry before ${canonicalNodeId('a')}`,
          'WORKGRAPH_RETRY_UPSTREAM_NOT_ACHIEVED',
        ),
      )
    })

    it('clears the graph with a durable tombstone', async () => {
      const s = scheduler()
      await s.set(agent, { objective: 'ship it' })
      await s.clear(agent)
      expect(await s.status(agent)).toBeNull()
      const event = agent.session.events.at(-1) as SessionEvent
      expect(event.type).toBe('workgraph/change')
      const clearData = event.data as { kind: 'workgraph/change'; version: 1; operation: 'clear'; cleared: string; clearedAt: number }
      expect(clearData.kind).toBe('workgraph/change')
      expect(clearData.version).toBe(1)
      expect(clearData.operation).toBe('clear')
      expect(clearData.cleared).toBeTypeOf('string')
      expect(clearData.clearedAt).toBeTypeOf('number')
    })
  })
  describe('subagentPlannerSpawn', () => {
    it('spawns a structured-output child and disposes the run', async () => {
      const started: unknown[] = []
      const fakeCtx = {
        subagents: {
          start: async (name: string, request: unknown) => {
            started.push({ name, request })
            return {
              result: Promise.resolve({ structured: { nodes: [] }, stopReason: 'completed' }),
              dispose: async () => {},
            }
          },
        },
      }
      const { subagentPlannerSpawn } = await import('@deepseek-ai/dsh-workgraph-scheduler/src/scheduler.ts')
      const spawn = subagentPlannerSpawn(fakeCtx as unknown as Context, agent)
      const outcome = await spawn({ prompt: 'plan it', signal: new AbortController().signal })
      expect(outcome).toEqual({ structured: { nodes: [] }, stopReason: 'completed' })
      expect(started).toHaveLength(1)
      const call = started[0] as { name: string; request: { label: string; outputSchema: unknown } }
      expect(call.name).toBe('spawn')
      expect(call.request.label).toBe('graph plan writer')
      expect(call.request.outputSchema).toBeDefined()
    })
  })

  describe('freeze failure discipline', () => {
    it('rethrows a non-domain baseline error instead of pausing', async () => {
      agent.session.append('workgraph/change', {
        kind: 'workgraph/change',
        version: 1,
        graph: pendingSnapshot('wg-seeded'),
      })
      // A file squatting on the workgraph dir makes the baseline mkdir fail
      // with a plain fs error, which must propagate — only WorkGraphError
      // pauses the graph.
      await writeFile(join(dir, 'workgraph'), 'squat\n')
      const s = scheduler()
      await expect(s.resume(agent)).rejects.toThrow()
    })

    it('resumes a reason-less paused snapshot restored from foreign data', async () => {
    // A user_paused snapshot without a pause reason cannot arise from tracker
    // transitions, but a persisted log from an older version can fold into
    // one; resume must tolerate it (withoutPauseReason early return).
      const reasonless = { ...pendingSnapshot('wg-seeded'), status: 'user_paused' as const }
      delete (reasonless as { pauseReason?: string }).pauseReason
      agent.session.append('workgraph/change', {
        kind: 'workgraph/change',
        version: 1,
        graph: reasonless,
      })
      const s = scheduler()
      const resumed = await s.resume(agent)
      expect(resumed.status).toBe('complete')
      expect(resumed.pauseReason).toBeUndefined()
    })

    describe('configuration seams', () => {
      it('exposes the optimizer toggle and tunables from the resolved config', () => {
        const on = new WorkGraphScheduler(new Context(), { workgraphDir: dir })
        expect(on.optimizerEnabled()).toBe(true)
        const off = new WorkGraphScheduler(new Context(), {
          workgraphDir: dir,
          optimizer: false,
          nodeRounds: 5,
          concurrency: 2,
          maxNodes: 8,
        })
        expect(off.optimizerEnabled()).toBe(false)
      })

      it('honors explicit limits from the config', async () => {
        const ctx = new Context()
        const threeNodes = {
          structured: {
            nodes: [
              { id: 'a', title: 'A', spec: 'do a', deps: [] },
              { id: 'b', title: 'B', spec: 'do b', deps: ['a'] },
              { id: 'c', title: 'C', spec: 'do c', deps: ['b'] },
            ],
          },
          stopReason: 'completed',
        }
        const s = new WorkGraphScheduler(ctx, {
          workgraphDir: dir,
          limits: { maxNodes: 2, historyMax: 8 },
          plannerSpawn: scripted(threeNodes),
        })
        const snapshot = await s.set(agent, { objective: 'ship it' })
        // maxNodes 2 rejects the three-node artifact on both attempts.
        expect(snapshot.status).toBe('infra_paused')
        expect(snapshot.pauseReason).toContain('plan rejected twice')
        expect(snapshot.pauseReason).toContain('exceeds the node cap')
      })

      it('falls back to the ctx.subagents default spawn when no seam is configured', async () => {
        const started: unknown[] = []
        let childSeq = 0
        const fakeSubagents = {
          start: async (name: string, request: unknown) => {
            started.push({ name, request })
            const outputSchema = (request as { outputSchema?: unknown }).outputSchema
            return {
              result: Promise.resolve({
                // The verifier gets a verdict; the planner a plan artifact;
                // the optimizer a respected empty op list.
                structured: outputSchema === VERIFIER_OUTPUT_SCHEMA
                  ? { verdict: 'achieved', gaps: [], discovered: [] }
                  : outputSchema === OPTIMIZER_OUTPUT_SCHEMA
                    ? { ops: [] }
                    : VALID_ARTIFACT.structured,
                stopReason: 'completed',
              }),
              dispose: async () => {},
            }
          },
          startContinuable: async () => {
            childSeq += 1
            const childId = `wg-child-${childSeq}`
            started.push({ name: 'startContinuable', childId })
            // The worker epoch end fires after the listener attaches.
            const emit = createLifecycleEmitter(ctx, () => ({}))
            const info: SubagentRunEndInfo = {
              runId: `run-${childId}` as never,
              provider: 'spawn',
              id: childId as never,
              local: true,
              stopReason: 'completed',
              lastAssistantMessage: [{
                type: 'text',
                text: 'REPORT: {"status":"done","summary":"ok","discovered":[]}',
              }],
            }
            setTimeout(() =>{  emit('subagent/end', info, agent) }, 0)
            return { childId, messageId: `m-${childId}` }
          },
          followup: async () => ({ id: 'm-followup' }),
        }
        const ctx = Object.assign(new Context(), {
          subagents: fakeSubagents,
          sessions: { get: () => undefined },
        })
        const s = new WorkGraphScheduler(ctx, { workgraphDir: dir })
        const snapshot = await s.set(agent, { objective: 'ship it' })
        expect(snapshot.status).toBe('complete')
        // 1 planner + 1 optimizer pass after planning + 3 boundary
        // optimizer passes (all respected no-ops) + 3 workers + 3 verifiers.
        expect(started).toHaveLength(11)
      })
    })
  })

  describe('serial drive', () => {
    it('drives the chain with bare hooks when no replan seam is configured', async () => {
      const a = canonicalNodeId('a')
      const b = canonicalNodeId('b')
      const final = WorkNodeId('gn-final')
      let current: WorkGraphSnapshot = {
        id: WorkGraphId('wg-serial-bare'),
        objective: 'ship it',
        status: 'active',
        planVersion: 1,
        nodes: [
          { id: a, title: 'A', spec: 'do a', blocks: [], state: 'ready', rounds: 0 },
          { id: b, title: 'B', spec: 'do b', blocks: [a], state: 'waiting', rounds: 0 },
          { id: final, title: 'Final verification', spec: 'verify', blocks: [a, b], state: 'waiting', rounds: 0 },
        ],
        pendingDiscoveries: [],
        history: [],
        tokensSpent: 0,
        replanRuns: 0,
        createdAt: 1,
        updatedAt: 1,
      }
      const hooks: SerialDriverHooks = {
        commit: (snapshot) => { current = snapshot },
        current: () => current,
        aborted: () => false,
        signal: () => new AbortController().signal,
        limits: { maxNodes: 8, historyMax: 64 },
        workerRound: scriptedRound(ROUND_DONE),
        verifierSpawn: scriptedVerifier(VERDICT_ACHIEVED),
        nodeRounds: 3,
        readUsage: scriptedUsage(RECORDED_USAGE),
        now: () => 2,
      // No replan seam on purpose: the boundary hook must be optional.
      }
      const finalSnapshot = await driveSerial(current, hooks)
      expect(finalSnapshot.status).toBe('complete')
      expect(finalSnapshot.nodes.every(node => node.state === 'achieved')).toBe(true)
      expect(finalSnapshot.tokensSpent).toBe(15)
    })
  })
})
