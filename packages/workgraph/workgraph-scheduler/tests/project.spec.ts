/**
 * Cross-session project revive tests (issue 09): the `.dsh/graph.jsonl`
 * round-trip, the exclusive sidecar lock, revive sanitization (Running →
 * Ready, Active → user_paused), malformed-content loudness, clear removal,
 * and the scheduler wiring (lock at set, projection writes, refused resume
 * for a second holder, read-only status revive).
 * @module
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { WorkGraphError, WorkGraphId, WorkNodeId } from '@deepseek-ai/dsh-workgraph'
import type { WorkGraphSnapshot } from '@deepseek-ai/dsh-workgraph'
import {
  WorkGraphScheduler, canonicalNodeId, RESTORE_PAUSE_REASON,
} from '@deepseek-ai/dsh-workgraph-scheduler'
import {
  acquireProjectLock, parseProject, projectPaths, readProject, removeProject,
  serializeProject, writeProject,
} from '@deepseek-ai/dsh-workgraph-scheduler/src/project.ts'
import { ROUND_DONE, VERDICT_ACHIEVED, RECORDED_USAGE, VALID_ARTIFACT } from './fixtures.ts'

function stubAgent(id: string, cwd?: string): Agent {
  const session = Session.create(
    SessionId(id),
    undefined,
    cwd === undefined ? undefined : { version: 0, id: SessionId(id), createdAt: 1, cwd },
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

/** An installed snapshot: a → b plus the gated final, roots ready. */
function snapshot(over: Partial<WorkGraphSnapshot> = {}): WorkGraphSnapshot {
  const a = canonicalNodeId('a')
  const b = canonicalNodeId('b')
  return {
    id: WorkGraphId('wg-1'),
    objective: 'ship it',
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
    ...over,
  }
}

function scheduler(workgraphDir: string, round?: () => Promise<typeof ROUND_DONE>): WorkGraphScheduler {
  return new WorkGraphScheduler(new Context(), {
    workgraphDir,
    plannerSpawn: async () => VALID_ARTIFACT,
    workerRound: round ?? (async () => ROUND_DONE),
    verifierSpawn: async () => VERDICT_ACHIEVED,
    readChildUsage: async () => RECORDED_USAGE,
    replannerSpawn: async () => ({ structured: { nodes: [] }, stopReason: 'completed' }),
    optimizerSpawn: async () => ({ structured: { ops: [] }, stopReason: 'completed' }),
    // The wiring tests carry a cwd; keep the drive serial (no subagents service).
    workspaceCapable: false,
    childAwaitBudget: 0.02,
  })
}

describe('project file', () => {
  let dir: string
  let mainDir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'workgraph-project-'))
    mainDir = join(dir, 'repo')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('round-trips the orchestration: header line, then one node per line', async () => {
    await writeProject(mainDir, snapshot())
    const text = await readFile(projectPaths(mainDir).file, 'utf8')
    const lines = text.split('\n').filter(line => line.length > 0)
    expect(lines).toHaveLength(4) // header + 3 nodes
    const header = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(header['nodes']).toBeUndefined()
    expect(parseProject(text)).toEqual(snapshot())
  })

  it('is line-mergeable: identical content-hash ids serialize identically', () => {
    expect(serializeProject(snapshot())).toBe(serializeProject(snapshot()))
  })

  it('is a loud error when malformed, never "no graph"', async () => {
    await writeProject(mainDir, snapshot())
    const file = projectPaths(mainDir).file
    await writeFile(file, 'not json\n{}\n')
    expect(() => parseProject('not json\n{}\n')).toThrow('header line is not JSON')
    const inlineNodes = `${JSON.stringify({ ...snapshot(), nodes: [snapshot().nodes[0]] })}\n{}\n`
    expect(() => parseProject(inlineNodes)).toThrow('missing fields')
    await writeFile(file, `${JSON.stringify({ id: 'wg-1', objective: 'o', status: 'active', planVersion: 1, tokensSpent: 0, replanRuns: 0, createdAt: 1, updatedAt: 1, pendingDiscoveries: [], history: [] })}\n{broken\n`)
    const badNodeLine = await readFile(file, 'utf8')
    expect(() => parseProject(badNodeLine)).toThrow('node line 2')
    // A non-object header and a non-object node row are loud too.
    expect(() => parseProject('null\n{}\n')).toThrow('not an object')
    expect(() => parseProject(`${JSON.stringify({ id: 'wg-1', objective: 'o', status: 'active', planVersion: 1, tokensSpent: 0, replanRuns: 0, createdAt: 1, updatedAt: 1, pendingDiscoveries: [], history: [] })}\n7\n`))
      .toThrow('node line 2')
  })

  it('holds the exclusive lock for one holder and refuses a second', async () => {
    const first = await acquireProjectLock(mainDir, 'wg-1')
    expect(first).not.toBeNull()
    const second = await acquireProjectLock(mainDir, 'wg-1')
    expect(second).toBeNull()
    await first!.release()
    const after = await acquireProjectLock(mainDir, 'wg-1')
    expect(after).not.toBeNull()
    await after!.release()
  })

  it('is a loud NOT_FOUND when no projection exists', async () => {
    await expect(readProject(mainDir)).rejects.toEqual(
      new WorkGraphError('no graph projection exists in this repository', 'WORKGRAPH_NOT_FOUND'),
    )
  })

  it('revives sanitized and demoted: Running → Ready, Active → user_paused', async () => {
    const running = snapshot({
      nodes: snapshot().nodes.map(node => node.id === canonicalNodeId('a')
        ? { ...node, state: 'running' as const }
        : node),
    })
    await writeProject(mainDir, running)
    const revived = await readProject(mainDir)
    expect(revived.nodes.find(node => node.id === canonicalNodeId('a'))!.state).toBe('ready')
    expect(revived.status).toBe('user_paused')
    expect(revived.pauseReason).toBe(RESTORE_PAUSE_REASON)
  })

  it('removeProject removes the file and the lock', async () => {
    const lock = await acquireProjectLock(mainDir, 'wg-1')
    await writeProject(mainDir, snapshot())
    await removeProject(mainDir)
    const { file, lock: lockPath } = projectPaths(mainDir)
    await expect(readFile(file)).rejects.toThrow()
    await expect(readFile(lockPath)).rejects.toThrow()
    void lock
  })
})

describe('scheduler project wiring', () => {
  let dir: string
  let mainDir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'workgraph-projwire-'))
    mainDir = join(dir, 'repo')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes the projection at set, refuses a second holder, and revives read-only', async () => {
    const s = scheduler(dir)
    const agent = stubAgent('owner', mainDir)
    const settled = await s.set(agent, { objective: 'ship it' })
    expect(settled.status).toBe('complete')
    const file = projectPaths(mainDir).file
    const text = await readFile(file, 'utf8')
    expect(text).toContain('ship it')
    // A second session in the same repository cannot set or resume.
    const second = scheduler(dir)
    const other = stubAgent('other', mainDir)
    await expect(second.set(other, { objective: 'mine' })).rejects.toEqual(
      new WorkGraphError('the repository graph projection is locked by another session', 'WORKGRAPH_LOCKED'),
    )
    // A fresh scheduler with no events revives the projection read-only;
    // a completed graph revives as-is, and the lock still refuses resume.
    const fresh = scheduler(dir)
    const revived = await fresh.status(other)
    expect(revived).not.toBeNull()
    expect(revived!.objective).toBe('ship it')
    await expect(fresh.resume(other)).rejects.toEqual(
      new WorkGraphError('the repository graph projection is locked by another session', 'WORKGRAPH_LOCKED'),
    )
  })

  it('clear removes the projection and releases the lock', async () => {
    const s = scheduler(dir)
    const agent = stubAgent('owner', mainDir)
    await s.set(agent, { objective: 'ship it' })
    await s.clear(agent)
    const { file, lock: lockPath } = projectPaths(mainDir)
    await expect(readFile(file)).rejects.toThrow()
    await expect(readFile(lockPath)).rejects.toThrow()
    // The lock is free: a new session can set again.
    const second = scheduler(dir)
    const other = stubAgent('other', mainDir)
    const settled = await second.set(other, { objective: 'again' })
    expect(settled.status).toBe('complete')
  })

  it('returns null for a cwd agent with no projection', async () => {
    const fresh = scheduler(dir)
    const other = stubAgent('other', mainDir)
    expect(await fresh.status(other)).toBeNull()
  })

  it('degrades when a projection write fails (the session log stays truth)', async () => {
    let release!: (result: typeof ROUND_DONE) => void
    const gate = new Promise<typeof ROUND_DONE>((resolve) => { release = resolve })
    const s = scheduler(dir, async () => gate)
    const agent = stubAgent('owner', mainDir)
    const pending = s.set(agent, { objective: 'ship it' })
    await new Promise<void>(resolve => setTimeout(resolve, 10))
    // A directory squatting on the projection path breaks the next write.
    await rm(projectPaths(mainDir).file, { force: true })
    await mkdir(projectPaths(mainDir).file)
    release(ROUND_DONE)
    const settled = await pending
    expect(settled.status).toBe('complete')
  })

  it('treats a malformed projection as a loud error on status', async () => {
    const s = scheduler(dir)
    const agent = stubAgent('owner', mainDir)
    const settled = await s.set(agent, { objective: 'ship it' })
    expect(settled.status).toBe('complete')
    await writeFile(projectPaths(mainDir).file, 'garbage\n')
    const fresh = scheduler(dir)
    const other = stubAgent('other', mainDir)
    await expect(fresh.status(other)).rejects.toThrow('malformed graph projection')
  })
})
