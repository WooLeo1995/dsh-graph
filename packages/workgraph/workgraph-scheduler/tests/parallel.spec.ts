import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { canonicalNodeId, WorkGraphScheduler } from '@deepseek-ai/dsh-workgraph-scheduler'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import { createLifecycleEmitter } from '@deepseek-ai/dsh-subagent/src/lifecycle.ts'
import type { WorkerRound, WorkerRoundResult, WorkerSpawn, GitSeam, ParallelDriverHooks } from '@deepseek-ai/dsh-workgraph-scheduler'
import type { WorkGraphSnapshot } from '@deepseek-ai/dsh-workgraph'
import { ROUND_DONE, VERDICT_ACHIEVED, RECORDED_USAGE } from './fixtures.ts'

function stubAgent(cwd?: string): Agent {
  const session = Session.create(
    SessionId('parallel-test'),
    undefined,
    cwd === undefined ? undefined : { version: 0, id: SessionId('parallel-test'), createdAt: 1, cwd },
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

/** A git seam that reports a repo and no-ops worktree ops, recording calls. */
function fakeGit(): { seam: GitSeam; calls: string[][] } {
  const calls: string[][] = []
  const seam: GitSeam = {
    run: async (args) => {
      calls.push([...args])
      const [command, ...rest] = args
      console.log('DBG git run:', JSON.stringify(args))
      if (command === 'rev-parse' && rest[0] === '--is-inside-work-tree') {
        return { code: 0, stdout: 'true' }
      }
      if (command === 'rev-parse' && rest[0] === 'HEAD') {
        return { code: 0, stdout: 'deadbeef' }
      }
      if (command === 'worktree' && rest[0] === 'add') {
        await mkdir(rest[2]!, { recursive: true })
        return { code: 0, stdout: '' }
      }
      if (command === 'worktree' && rest[0] === 'remove') {
        return { code: 0, stdout: '' }
      }
      return { code: 0, stdout: '' }
    },
  }
  return { seam, calls }
}

describe('parallel batches', () => {
  let dir: string
  let mainDir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'workgraph-par-'))
    mainDir = join(dir, 'main')
    await mkdir(mainDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function scheduler(
    round: WorkerRound,
    verifier?: WorkerSpawn,
    options?: { concurrency?: number; workspaceCapable?: boolean; git?: GitSeam; mainDir?: string },
  ): { s: WorkGraphScheduler; agent: Agent } {
    const agent = stubAgent(options?.mainDir ?? mainDir)
    const s = new WorkGraphScheduler(new Context(), {
      workgraphDir: dir,
      plannerSpawn: async () => ({
        structured: {
          nodes: [
            { id: 'a', title: 'A', spec: 'do a', deps: [] },
            { id: 'b', title: 'B', spec: 'do b', deps: [] },
          ],
        },
        stopReason: 'completed',
      }),
      workerRound: round,
      verifierSpawn: verifier ?? (async () => VERDICT_ACHIEVED),
      readChildUsage: async () => RECORDED_USAGE,
      concurrency: options?.concurrency ?? 3,
      workspaceCapable: options?.workspaceCapable ?? true,
      ...(options?.git === undefined ? {} : { git: options.git }),
      // Pause tests gate children after pause; keep the bounded-settlement
      // wait short so the budget race resolves instead of hanging the suite.
      childAwaitBudget: 0.02,
    })
    return { s, agent }
  }

  it('runs two independent roots as a batch, each isolated in its own worktree', async () => {
    const { seam: git, calls } = fakeGit()
    const workspaces: string[] = []
    const round: WorkerRound = async (request) => {
      workspaces.push(request.workspace ?? '')
      return ROUND_DONE
    }
    const { s, agent } = scheduler(round, undefined, { git })
    const snapshot = await s.set(agent, { objective: 'ship it' })
    expect(snapshot.status).toBe('complete')
    // The two roots got distinct worktree workspaces; the final node serial.
    expect(workspaces.filter(w => w !== '')).toHaveLength(2)
    expect(new Set(workspaces.filter(w => w !== '')).size).toBe(2)
    expect(workspaces.filter(w => w !== '')).toEqual([
      join(dir, 'workgraph', 'worktrees', agent.id, canonicalNodeId('a')),
      join(dir, 'workgraph', 'worktrees', agent.id, canonicalNodeId('b')),
    ])
    // Worktrees minted at fan-out for both roots.
    const adds = calls.filter(args => args[0] === 'worktree' && args[1] === 'add')
    expect(adds).toHaveLength(2)
    expect(adds.every(args => args.at(-1) === 'deadbeef')).toBe(true)
  })

  it('fails only the conflicting node on merge-back; siblings continue', async () => {
    const seam: GitSeam = {
      run: async (args, cwd) => {
        const [command, ...rest] = args
        if (command === 'rev-parse' && rest[0] === '--is-inside-work-tree') return { code: 0, stdout: 'true' }
        if (command === 'rev-parse' && rest[0] === 'HEAD') return { code: 0, stdout: 'deadbeef' }
        if (command === 'worktree' && rest[0] === 'add') {
          await mkdir(rest[2]!, { recursive: true })
          // Node a's worktree contains a file that conflicts with the main
          // working tree (base differs from both sides).
          if (String(rest[2]).includes(canonicalNodeId('a'))) {
            await writeFile(join(rest[2]!, 'x.ts'), 'theirs\n')
            await writeFile(join(mainDir, 'x.ts'), 'ours\n')
          }
          return { code: 0, stdout: '' }
        }
        if (command === 'worktree' && rest[0] === 'remove') return { code: 0, stdout: '' }
        if (command === 'diff' && cwd.includes(canonicalNodeId('a'))) {
          return { code: 0, stdout: 'x.ts' }
        }
        if (command === 'show') return { code: 0, stdout: 'base\n' }
        return { code: 0, stdout: '' }
      },
    }
    const { s, agent } = scheduler(async () => ROUND_DONE, undefined, { git: seam })
    const snapshot = await s.set(agent, { objective: 'ship it' })
    // a failed on the conflict; b and the final node achieved.
    const a = snapshot.nodes.find(node => node.id === canonicalNodeId('a'))!
    const b = snapshot.nodes.find(node => node.id === canonicalNodeId('b'))!
    expect(a.state).toBe('failed')
    expect(a.failure).toContain('merge-back failed')
    expect(a.failure).toContain('conflict')
    expect(b.state).toBe('achieved')
    // The failed root wedges the graph: the final node blocks on it.
    expect(snapshot.status).toBe('blocked')
    const final = snapshot.nodes.find(node => node.id === 'gn-final')!
    expect(final.state).toBe('blocked')
  })

  it('fails the node when the main HEAD moved since fan-out', async () => {
    let head = 'deadbeef'
    const seam: GitSeam = {
      run: async (args) => {
        const [command, ...rest] = args
        if (command === 'rev-parse' && rest[0] === '--is-inside-work-tree') return { code: 0, stdout: 'true' }
        if (command === 'rev-parse' && rest[0] === 'HEAD') {
          // The HEAD moves after the first read (fan-out).
          if (head === 'deadbeef') {
            head = 'cafebabe'
            return { code: 0, stdout: 'deadbeef' }
          }
          return { code: 0, stdout: head }
        }
        if (command === 'worktree' && rest[0] === 'add') {
          await mkdir(rest[2]!, { recursive: true })
          return { code: 0, stdout: '' }
        }
        return { code: 0, stdout: '' }
      },
    }
    const { s, agent } = scheduler(async () => ROUND_DONE, undefined, { git: seam })
    const snapshot = await s.set(agent, { objective: 'ship it' })
    const a = snapshot.nodes.find(node => node.id === canonicalNodeId('a'))!
    expect(a.state).toBe('failed')
    expect(a.failure).toContain('main HEAD moved since fan-out')
  })

  it('stops the batch when a pause lands during worktree minting', async () => {
    let releaseMint!: () => void
    const mintGate = new Promise<void>((resolve) => { releaseMint = resolve })
    let mints = 0
    const seam: GitSeam = {
      run: async (args) => {
        const [command, ...rest] = args
        if (command === 'rev-parse' && rest[0] === '--is-inside-work-tree') return { code: 0, stdout: 'true' }
        if (command === 'rev-parse' && rest[0] === 'HEAD') return { code: 0, stdout: 'deadbeef' }
        if (command === 'worktree' && rest[0] === 'add') {
          mints += 1
          if (mints === 1) await mintGate
          await mkdir(rest[2]!, { recursive: true })
          return { code: 0, stdout: '' }
        }
        return { code: 0, stdout: '' }
      },
    }
    const { s, agent } = scheduler(async () => ROUND_DONE, undefined, { git: seam })
    const pending = s.set(agent, { objective: 'ship it' })
    // Poll until the first mint is in flight (the gate holds it), then
    // pause mid-mint: deterministic under load.
    const mintStartedAt = Date.now()
    while (mints === 0) {
      if (Date.now() - mintStartedAt > 5000) throw new Error('minting never started')
      await new Promise<void>(resolve => setTimeout(resolve, 5))
    }
    const paused = await s.pause(agent, 'stop now')
    expect(paused.status).toBe('user_paused')
    releaseMint()
    const final = await pending
    expect(final.status).toBe('user_paused')
    expect(mints).toBeGreaterThanOrEqual(1)
  })

  it('stops the batch on a pause and demotes the in-flight node', async () => {
    const { seam: git } = fakeGit()
    let release!: (result: WorkerRoundResult) => void
    const gate = new Promise<WorkerRoundResult>((resolve) => { release = resolve })
    let calls = 0
    const round: WorkerRound = async (request) => {
      calls += 1
      if (calls === 1) {
        // Report the publication like the real transport, then hold the
        // round in flight.
        await request.onSpawned?.('child-1')
        return gate
      }
      return ROUND_DONE
    }
    const { s, agent } = scheduler(round, undefined, { git })
    const pending = s.set(agent, { objective: 'ship it' })
    // Poll for the installed batch rather than sleep: under suite contention
    // the pause can otherwise land DURING planning, where the aborted plan
    // install is abandoned and no node exists to demote (the pause still
    // sticks; the pending graph stays pending). The round reports its
    // publication like the real transport, so the running transition is
    // observable at spawn.
    const startedAt = Date.now()
    for (;;) {
      // status() is null until the dispatch's pending commit lands; poll
      // through that window too.
      const live = await s.status(agent)
      const a = live?.nodes.find(node => node.id === canonicalNodeId('a'))
      if (a !== undefined && a.state === 'running') break
      if (Date.now() - startedAt > 5000) throw new Error('batch never started')
      await new Promise<void>(resolve => setTimeout(resolve, 5))
    }
    const paused = await s.pause(agent, 'stop now')
    expect(paused.status).toBe('user_paused')
    release(ROUND_DONE)
    const final = await pending
    expect(final.status).toBe('user_paused')
    const a = final.nodes.find(node => node.id === canonicalNodeId('a'))!
    expect(a.state).toBe('ready')
  })

  it('skips the merge for a node that failed its rounds inside a batch', async () => {
    const { seam: git, calls } = fakeGit()
    const round: WorkerRound = async (request) => {
      return request.round === 1 && request.workspace !== undefined
        ? { outcome: { kind: 'blocked', reason: 'impossible here', discovered: [] }, childSessionId: 'c1' }
        : ROUND_DONE
    }
    const { s, agent } = scheduler(round, undefined, { git })
    const snapshot = await s.set(agent, { objective: 'ship it' })
    const a = snapshot.nodes.find(node => node.id === canonicalNodeId('a'))!
    expect(a.state).toBe('failed')
    expect(a.failure).toBe('impossible here')
    // No merge-back ran for the failed node.
    expect(calls.filter(args => args[0] === 'worktree' && args[1] === 'remove')).toHaveLength(0)
  })

  it('continues a rejected parallel node on the SAME child with gaps in its worktree', async () => {
    const { seam: git } = fakeGit()
    const requests: Array<{ round: number; workspace?: string }> = []
    const round: WorkerRound = async (request) => {
      requests.push({ round: request.round, ...(request.workspace === undefined ? {} : { workspace: request.workspace }) })
      return ROUND_DONE
    }
    let workspaceVerifies = 0
    const verifier: WorkerSpawn = async (request) => {
      if (request.workspace !== undefined && workspaceVerifies++ === 0) {
        return { structured: { verdict: 'not_achieved', gaps: ['fix it'], discovered: [] }, stopReason: 'completed' }
      }
      return VERDICT_ACHIEVED
    }
    const { s, agent } = scheduler(round, verifier, { git })
    const snapshot = await s.set(agent, { objective: 'ship it' })
    expect(snapshot.status).toBe('complete')
    // One root iterated round 2 inside its worktree (the other passed on
    // round 1); the final node ran serial without a workspace.
    const withWorkspace = requests.filter(r => r.workspace !== undefined)
    expect(withWorkspace).toHaveLength(3)
    expect(withWorkspace.filter(r => r.round === 2)).toHaveLength(1)
    expect(requests.some(r => r.workspace === undefined)).toBe(true)
  })

  it('degrades to serial outside a git repo', async () => {
    const { seam: seamBase, calls } = fakeGit()
    const seam = seamBase
    const seamNoRepo: GitSeam = {
      ...seam,
      run: async (args, cwd) => {
        if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
          return { code: 1, stdout: 'false' }
        }
        return seam.run(args, cwd)
      },
    }
    const workspaces: string[] = []
    const { s, agent } = scheduler(async (request) => {
      workspaces.push(request.workspace ?? '')
      return ROUND_DONE
    }, undefined, { git: seamNoRepo })
    const snapshot = await s.set(agent, { objective: 'ship it' })
    expect(snapshot.status).toBe('complete')
    expect(workspaces.every(w => w === '')).toBe(true)
    expect(calls.filter(args => args[0] === 'worktree')).toHaveLength(0)
  })

  it('degrades to serial with concurrency 1 or a workspace-incapable composition', async () => {
    const workspaces: string[] = []
    const round: WorkerRound = async (request) => {
      workspaces.push(request.workspace ?? '')
      return ROUND_DONE
    }
    const { s: s1, agent: a1 } = scheduler(round, undefined, { concurrency: 1 })
    const snap1 = await s1.set(a1, { objective: 'ship it' })
    expect(snap1.status).toBe('complete')
    expect(workspaces).toHaveLength(3)
    const workspaces2: string[] = []
    const { s: s2, agent: a2 } = scheduler(async (request) => {
      workspaces2.push(request.workspace ?? '')
      return ROUND_DONE
    }, undefined, { workspaceCapable: false, mainDir: join(dir, 'main2') })
    const snap2 = await s2.set(a2, { objective: 'ship it' })
    expect(snap2.status).toBe('complete')
    expect(workspaces2).toHaveLength(3)
    expect(workspaces2.every(w => w === '')).toBe(true)
  })

  it('breaks out of the serial fallback when nothing is runnable', async () => {
    // A foreign active graph with no ready node (all waiting on a failed
    // dep) drives through the parallel loop's serial fallback and stops.
    const { seam: git } = fakeGit()
    const { s, agent } = scheduler(async () => ROUND_DONE, undefined, { git })
    const { WorkGraphId, WorkNodeId } = await import('@deepseek-ai/dsh-workgraph')
    const a = canonicalNodeId('a')
    agent.session.append('workgraph/change', {
      kind: 'workgraph/change',
      version: 1,
      graph: {
        id: WorkGraphId('wg-stuck'),
        objective: 'ship it',
        status: 'user_paused' as const,
        pauseReason: 'restored',
        planVersion: 1,
        nodes: [
          { id: a, title: 'A', spec: 'do a', blocks: [], state: 'failed', rounds: 1, failure: 'boom' },
          { id: WorkNodeId('gn-final'), title: 'Final verification of the overall objective', spec: 'verify', blocks: [a], state: 'waiting', rounds: 0 },
        ],
        pendingDiscoveries: [],
        history: [{ at: 1, kind: 'node-failed', node: a, detail: 'boom' }],
        tokensSpent: 0,
        replanRuns: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    })
    const resumed = await s.resume(agent)
    expect(resumed.status).toBe('active')
  })

  it('runs a batch through the default subagent spawns, workspace included', async () => {
    const { seam: git } = fakeGit()
    const started: Array<{ name: string; workspace?: string }> = []
    let childSeq = 0
    const ctx = new Context()
    const agent = stubAgent(mainDir)
    const emit = createLifecycleEmitter(ctx, () => ({}))
    ctx.on('subagent/end', () => {})
    const emitEnd = (childId: string): void => {
      const info: SubagentRunEndInfo = {
        runId: `run-${childId}` as never,
        provider: 'spawn',
        id: childId as never,
        local: true,
        stopReason: 'completed',
        lastAssistantMessage: [{ type: 'text', text: 'REPORT: {"status":"done","summary":"ok","discovered":[]}' }],
      }
      emit('subagent/end', info, agent)
    }
    const fakeSubagents = {
      getProvider: () => ({ capabilities: { workspace: true } }),
      start: async (_name: string, request: { workspace?: string }) => {
        started.push({ name: 'start', ...(request.workspace === undefined ? {} : { workspace: request.workspace }) })
        return {
          result: Promise.resolve({ structured: { verdict: 'achieved', gaps: [], discovered: [] }, stopReason: 'completed' }),
          dispose: async () => {},
        }
      },
      startContinuable: async (_spec: unknown) => {
        childSeq += 1
        const childId = `child-${childSeq}`
        const specWorkspace = (_spec as { request?: { workspace?: string } }).request?.workspace
        started.push({ name: 'startContinuable', ...(specWorkspace === undefined ? {} : { workspace: specWorkspace }) })
        setTimeout(() => { emitEnd(childId) }, 0)
        return { childId, messageId: `m-${childId}` }
      },
      followup: async () => ({ id: 'm' }),
    }
    const s = new WorkGraphScheduler(
      Object.assign(ctx, { subagents: fakeSubagents, sessions: { get: () => undefined } }),
      {
        workgraphDir: dir,
        plannerSpawn: async () => ({
          structured: { nodes: [{ id: 'a', title: 'A', spec: 'do a', deps: [] }, { id: 'b', title: 'B', spec: 'do b', deps: [] }] },
          stopReason: 'completed',
        }),
        readChildUsage: async () => RECORDED_USAGE,
        git,
      },
    )
    const snapshot = await s.set(agent, { objective: 'ship it' })
    expect(snapshot.status).toBe('complete')
    // The worker continuation children and the verifiers carried the
    // worktree workspace through the default spawns.
    expect(started.some(call => call.name === 'startContinuable')).toBe(true)
    expect(started.some(call => call.name === 'start' && call.workspace !== undefined)).toBe(true)
  })

  it('resolves the workspace capability from the spawn provider when not configured', async () => {
    const { seam: git } = fakeGit()
    const agent = stubAgent(mainDir)
    const fakeSubagents = {
      getProvider: () => ({ capabilities: { workspace: true } }),
    }
    const s = new WorkGraphScheduler(
      Object.assign(new Context(), { subagents: fakeSubagents }),
      {
        workgraphDir: dir,
        plannerSpawn: async () => ({
          structured: { nodes: [{ id: 'a', title: 'A', spec: 'do a', deps: [] }, { id: 'b', title: 'B', spec: 'do b', deps: [] }] },
          stopReason: 'completed',
        }),
        workerRound: async () => ROUND_DONE,
        verifierSpawn: async () => VERDICT_ACHIEVED,
        readChildUsage: async () => RECORDED_USAGE,
        git,
      },
    )
    const snapshot = await s.set(agent, { objective: 'ship it' })
    expect(snapshot.status).toBe('complete')
  })

  it('passes the workspace to the verifier children too', async () => {
    const { seam: git } = fakeGit()
    const verifierWorkspaces: string[] = []
    const verifier: WorkerSpawn = async (request) => {
      verifierWorkspaces.push(request.workspace ?? '')
      return VERDICT_ACHIEVED
    }
    const { s, agent } = scheduler(async () => ROUND_DONE, verifier, { git })
    const snapshot = await s.set(agent, { objective: 'ship it' })
    expect(snapshot.status).toBe('complete')
    expect(verifierWorkspaces.filter(w => w !== '')).toHaveLength(2)
  })

  it('drives a batch and the serial fallback with bare hooks (no replan seam)', async () => {
    const { seam: git } = fakeGit()
    const { driveParallel } = await import('@deepseek-ai/dsh-workgraph-scheduler/src/parallel.ts')
    const { WorkGraphId, WorkNodeId } = await import('@deepseek-ai/dsh-workgraph')
    const agent = stubAgent(mainDir)
    const a = canonicalNodeId('a')
    const b = canonicalNodeId('b')
    const final = WorkNodeId('gn-final')
    let current: WorkGraphSnapshot = {
      id: WorkGraphId('wg-bare'),
      objective: 'ship it',
      status: 'active',
      planVersion: 1,
      nodes: [
        { id: a, title: 'A', spec: 'do a', blocks: [], state: 'ready', rounds: 0 },
        { id: b, title: 'B', spec: 'do b', blocks: [], state: 'ready', rounds: 0 },
        { id: final, title: 'Final verification', spec: 'verify', blocks: [a, b], state: 'waiting', rounds: 0 },
      ],
      pendingDiscoveries: [],
      history: [],
      tokensSpent: 0,
      replanRuns: 0,
      createdAt: 1,
      updatedAt: 1,
    }
    const rounds: string[] = []
    const hooks: ParallelDriverHooks = {
      agent,
      workspaceCapable: true,
      concurrency: 3,
      workgraphDir: dir,
      mainDir,
      git,
      commit: (snapshot) => { current = snapshot },
      current: () => current,
      aborted: () => false,
      signal: () => new AbortController().signal,
      limits: { maxNodes: 8, historyMax: 64 },
      workerRound: async () => {
        rounds.push('round')
        return ROUND_DONE
      },
      verifierSpawn: async () => VERDICT_ACHIEVED,
      nodeRounds: 2,
      readUsage: async () => RECORDED_USAGE,
      now: () => 2,
      // No replan seam on purpose: the boundary hook must be optional.
    }
    const finalSnapshot = await driveParallel(current, hooks)
    expect(rounds).toHaveLength(3)
    expect(finalSnapshot.nodes.every(node => node.state === 'achieved')).toBe(true)
    expect(finalSnapshot.history.map(entry => entry.kind)).toContain('node-achieved')
  })

  it('replans through the default subagent spawn when no replanner seam is configured', async () => {
    const { seam: git } = fakeGit()
    const started: string[] = []
    const fakeSubagents = {
      getProvider: () => ({ capabilities: { workspace: true } }),
      start: async () => {
        started.push('start')
        return {
          result: Promise.resolve({ structured: { nodes: [] }, stopReason: 'completed' }),
          dispose: async () => {},
        }
      },
    }
    const s = new WorkGraphScheduler(
      Object.assign(new Context(), { subagents: fakeSubagents, sessions: { get: () => undefined } }),
      {
        workgraphDir: dir,
        plannerSpawn: async () => ({
          structured: { nodes: [{ id: 'a', title: 'A', spec: 'do a', deps: [] }, { id: 'b', title: 'B', spec: 'do b', deps: [] }] },
          stopReason: 'completed',
        }),
        workerRound: async () => ({ outcome: { kind: 'done', summary: 'ok', discovered: ['more work'] }, childSessionId: 'c1' }),
        verifierSpawn: async () => VERDICT_ACHIEVED,
        readChildUsage: async () => RECORDED_USAGE,
        git,
      },
    )
    const agent = stubAgent(mainDir)
    const snapshot = await s.set(agent, { objective: 'ship it' })
    expect(snapshot.status).toBe('complete')
    // The default replanner spawn drove the discovery pass (empty appendix,
    // version bumped) instead of a configured seam.
    expect(started).toContain('start')
    expect(snapshot.planVersion).toBe(2)
  })
})
