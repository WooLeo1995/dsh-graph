/**
 * Per-node git worktrees and the sequential merge-back: mint an isolated
 * checkout per parallel node under the harness home, capture the main HEAD
 * at fan-out, and merge each achieved node's changed files back 3-way over
 * raw bytes (base = blob at the fan-out HEAD, ours = main working file,
 * theirs = worktree file). A moved main HEAD or a conflict fails only that
 * node — siblings continue, dependents block; a successful merge removes
 * the worktree best-effort, a failed node keeps it for postmortem.
 * @module @deepseek-ai/dsh-workgraph-scheduler/worktrees
 */

import { readFile, unlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join } from 'node:path'

/** The git execution seam; tests script plumbing through it. */
export interface GitSeam {
  /** Run one git command; resolves with the exit code and stdout. */
  run(args: readonly string[], cwd: string): Promise<{ code: number; stdout: string }>
}

/** The production git seam over `node:child_process`. */
export function createGitSeam(): GitSeam {
  return {
    run: (args, cwd) => new Promise((resolve) => {
      execFile('git', [...args], { cwd }, (error, stdout) => {
        /* v8 ignore next -- execFile always delivers a stdout string, so the nullish fallback is unreachable */
        resolve({ code: error === null ? 0 : (error as { code?: number }).code ?? 1, stdout: stdout ?? '' })
      })
    }),
  }
}

/** Whether the directory is inside a git work tree. */
export async function isGitRepo(seam: GitSeam, dir: string): Promise<boolean> {
  const result = await seam.run(['rev-parse', '--is-inside-work-tree'], dir)
  return result.code === 0 && result.stdout.trim() === 'true'
}

/** The current HEAD commit of the main tree. */
export async function captureHead(seam: GitSeam, dir: string): Promise<string> {
  const result = await seam.run(['rev-parse', 'HEAD'], dir)
  if (result.code !== 0) throw new Error('workgraph: cannot resolve the main HEAD')
  return result.stdout.trim()
}

/** The per-node worktree path under the harness home. */
export function worktreePath(workgraphDir: string, sessionId: string, nodeId: string): string {
  return join(workgraphDir, 'workgraph', 'worktrees', sessionId, nodeId)
}

/** Mint a detached worktree at the fan-out HEAD. */
export async function mintWorktree(
  seam: GitSeam,
  mainDir: string,
  path: string,
  head: string,
): Promise<void> {
  const result = await seam.run(['worktree', 'add', '--detach', path, head], mainDir)
  if (result.code !== 0) {
    throw new Error(`workgraph: failed to mint worktree for the node: ${result.stdout.trim()}`)
  }
}

/** Remove a merged worktree best-effort (a failure is logged by the caller). */
export async function removeWorktree(seam: GitSeam, mainDir: string, path: string): Promise<boolean> {
  const result = await seam.run(['worktree', 'remove', '--force', path], mainDir)
  return result.code === 0
}

/** The files the worker changed in its worktree relative to the fan-out HEAD. */
export async function changedFiles(
  seam: GitSeam,
  worktree: string,
  base: string,
): Promise<string[]> {
  const [diff, untracked] = await Promise.all([
    seam.run(['diff', '--name-only', base], worktree),
    seam.run(['ls-files', '--others', '--exclude-standard'], worktree),
  ])
  const names = `${diff.code === 0 ? diff.stdout : ''}\n${untracked.code === 0 ? untracked.stdout : ''}`
  return [...new Set(names.split('\n').map(line => line.trim()).filter(line => line.length > 0))]
}

/** Read one blob at a revision ('' when the path does not exist at that rev). */
export async function readBlob(seam: GitSeam, dir: string, rev: string, path: string): Promise<string> {
  const result = await seam.run(['show', `${rev}:${path}`], dir)
  return result.code === 0 ? result.stdout : ''
}

/** One file's 3-way merge outcome. */
export type FileMerge =
  | { readonly kind: 'take-theirs' }
  | { readonly kind: 'already-present' }
  | { readonly kind: 'conflict' }

/**
 * The 3-way byte merge for one changed file: base == ours takes theirs
 * (the worker's change applies cleanly); ours == theirs is already present
 * in the main working tree; anything else is a conflict.
 */
export function mergeFileBytes(
  base: string,
  ours: string,
  theirs: string,
): FileMerge {
  if (base === ours) return { kind: 'take-theirs' }
  if (ours === theirs) return { kind: 'already-present' }
  return { kind: 'conflict' }
}

/**
 * Merge one achieved node's worktree back into the main tree. Fails the node
 * (returns the conflict) when the main HEAD moved since fan-out or any file
 * conflicts; the node keeps its worktree for postmortem. On success the
 * merged files land in the main working tree and the worktree is removed
 * best-effort.
 */
export async function mergeWorktree(
  seam: GitSeam,
  mainDir: string,
  worktree: string,
  fanOutHead: string,
  currentHead: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (fanOutHead !== currentHead) {
    return {
      ok: false,
      reason: `main HEAD moved since fan-out (${fanOutHead.slice(0, 8)} → ${currentHead.slice(0, 8)}); refusing to merge`,
    }
  }
  const files = await changedFiles(seam, worktree, fanOutHead)
  for (const path of files) {
    const base = await readBlob(seam, mainDir, fanOutHead, path)
    const ours = await readFile(join(mainDir, path), 'utf8').catch(() => '')
    const theirs = await readFile(join(worktree, path), 'utf8').catch(() => '')
    const outcome = mergeFileBytes(base, ours, theirs)
    if (outcome.kind === 'conflict') {
      return { ok: false, reason: `merge conflict on ${path}` }
    }
    if (outcome.kind === 'take-theirs') {
      const mainPath = join(mainDir, path)
      if (theirs === '' && base !== '') {
        /* v8 ignore next -- best-effort removal; a racing recreate is not our failure to surface */
        await unlink(mainPath).catch(() => {})
      } else {
        await writeFile(mainPath, theirs, 'utf8')
      }
    }
  }
  await removeWorktree(seam, mainDir, worktree)
  return { ok: true }
}
