/**
 * Cross-session project revive (issue 09): `.dsh/graph.jsonl` at the repo
 * root projects the orchestration so a fresh session can revive the graph.
 * Line 1 is the header (the snapshot minus nodes), then one node per line —
 * atomic writes, line-mergeable thanks to content-hash node ids. An
 * exclusive sidecar lock (create-exclusive) is held for the graph's
 * lifetime; a second holder gets read-only status and refused resume. A
 * malformed file is a loud error, never "no graph". Revive sanitizes then
 * demotes (Active → user_paused with the restart message, Running → Ready).
 * @module @deepseek-ai/dsh-workgraph-scheduler/project
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkGraphSnapshot, WorkNode } from '@deepseek-ai/dsh-workgraph'
import { WorkGraphError } from '@deepseek-ai/dsh-workgraph'
import { restoreSnapshot } from './tracker.ts'

/** Whether another session currently holds the project lock. */
export async function projectLockExists(mainDir: string): Promise<boolean> {
  const { lock } = projectPaths(mainDir)
  try {
    await readFile(lock)
    return true
  } catch (error) {
    /* v8 ignore start -- only a non-ENOENT fs failure reaches the rethrow */
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
    /* v8 ignore stop */
  }
}

/** The projection file and its exclusive lock sidecar under a repo root. */
export function projectPaths(mainDir: string): { file: string; lock: string; dir: string } {
  const dir = join(mainDir, '.dsh')
  return { file: join(dir, 'graph.jsonl'), lock: join(dir, 'graph.lock'), dir }
}

/** An exclusive held lock on the project graph; releasing removes it. */
export interface ProjectLock {
  readonly graphId: string
  release(): Promise<void>
}

const LOCK_EEXIST = 'EEXIST'

/**
 * Acquire the exclusive project lock (create-exclusive sidecar). A second
 * holder gets `null` — read-only status, refused resume.
 * @param mainDir - the repo root.
 * @param graphId - the graph identity the holder owns.
 * @returns the held lock, or `null` when another holder owns it.
 */
export async function acquireProjectLock(
  mainDir: string,
  graphId: string,
): Promise<ProjectLock | null> {
  const { lock, dir } = projectPaths(mainDir)
  await mkdir(dir, { recursive: true })
  try {
    await writeFile(lock, `${graphId}\n`, { flag: 'wx' })
  } catch (error) {
    /* v8 ignore start -- only a non-EEXIST fs failure reaches the rethrow */
    if ((error as NodeJS.ErrnoException).code === LOCK_EEXIST) return null
    throw error
    /* v8 ignore stop */
  }
  return {
    graphId,
    release: async () => {
      await rm(lock, { force: true })
    },
  }
}

/** The snapshot minus its nodes: the projection header line. */
type ProjectHeader = Omit<WorkGraphSnapshot, 'nodes'>

/** Serialize one snapshot: header line, then one node per line. */
export function serializeProject(snapshot: WorkGraphSnapshot): string {
  const { nodes, ...header } = snapshot
  const lines = [JSON.stringify(header), ...nodes.map(node => JSON.stringify(node))]
  return `${lines.join('\n')}\n`
}

/** Decode one projection; malformed data is a LOUD error, never "no graph". */
export function parseProject(text: string): WorkGraphSnapshot {
  const lines = text.split('\n').filter(line => line.trim().length > 0)
  if (lines.length < 2) {
    throw new WorkGraphError(
      'malformed graph projection: expected a header line and at least one node line',
      'WORKGRAPH_MALFORMED_PROJECTION',
    )
  }
  let rawHeader: unknown
  try {
    /* v8 ignore next -- the two-line minimum above guarantees a first line */
    rawHeader = JSON.parse(lines[0] ?? '')
  } catch {
    throw new WorkGraphError(
      'malformed graph projection: header line is not JSON',
      'WORKGRAPH_MALFORMED_PROJECTION',
    )
  }
  if (rawHeader === null || typeof rawHeader !== 'object') {
    throw new WorkGraphError(
      'malformed graph projection: header line is not an object',
      'WORKGRAPH_MALFORMED_PROJECTION',
    )
  }
  const headerRecord = rawHeader as Record<string, unknown>
  if (typeof headerRecord['id'] !== 'string' || typeof headerRecord['objective'] !== 'string'
    || (Array.isArray(headerRecord['nodes']) && headerRecord['nodes'].length > 0)) {
    throw new WorkGraphError(
      'malformed graph projection: header carries an inline nodes list or missing fields',
      'WORKGRAPH_MALFORMED_PROJECTION',
    )
  }
  const header = rawHeader as ProjectHeader
  const nodes: WorkNode[] = []
  for (const [index, line] of lines.slice(1).entries()) {
    try {
      const node = JSON.parse(line) as WorkNode
      if (typeof node !== 'object' || node === null || typeof node['id'] !== 'string'
        || typeof node['title'] !== 'string' || typeof node['state'] !== 'string'
        || !Array.isArray(node['blocks'])) {
        throw new Error('node row shape')
      }
      nodes.push(node)
    } catch {
      throw new WorkGraphError(
        `malformed graph projection: node line ${index + 2} is not a valid node`,
        'WORKGRAPH_MALFORMED_PROJECTION',
      )
    }
  }
  return {
    ...header,
    nodes,
  } as WorkGraphSnapshot
}

/**
 * Atomically write the projection (unique temp file + rename, so concurrent
 * checkpoint writes never clobber each other's temp; the last rename wins).
 * Callers write only while holding the exclusive lock.
 * @param mainDir - the repo root.
 * @param snapshot - the current snapshot.
 */
export async function writeProject(mainDir: string, snapshot: WorkGraphSnapshot): Promise<void> {
  const { file, dir } = projectPaths(mainDir)
  await mkdir(dir, { recursive: true })
  const tmp = `${file}.tmp-${randomUUID()}`
  await writeFile(tmp, serializeProject(snapshot), { flag: 'w' })
  await rename(tmp, file)
}

/** Read and revive the projected graph: sanitize, then demote to paused. */
export async function readProject(mainDir: string): Promise<WorkGraphSnapshot> {
  const { file } = projectPaths(mainDir)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    /* v8 ignore start -- only a non-ENOENT fs failure reaches the rethrow */
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new WorkGraphError(
        'no graph projection exists in this repository',
        'WORKGRAPH_NOT_FOUND',
      )
    }
    throw error
    /* v8 ignore stop */
  }
  const parsed = parseProject(text)
  return restoreSnapshot(parsed, Date.now())
}

/** Remove the projection file and its lock sidecar. */
export async function removeProject(mainDir: string): Promise<void> {
  const { file, lock, dir } = projectPaths(mainDir)
  await rm(file, { force: true })
  await rm(lock, { force: true })
  // Best-effort dir cleanup; a concurrent holder's lock keeps the dir.
  /* v8 ignore next -- the best-effort cleanup absorbs any removal failure */
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}
