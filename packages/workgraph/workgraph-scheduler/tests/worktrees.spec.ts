import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  captureHead,
  changedFiles,
  createGitSeam,
  isGitRepo,
  mergeFileBytes,
  mergeWorktree,
  mintWorktree,
  readBlob,
  removeWorktree,
  worktreePath,
  type GitSeam,
} from '@deepseek-ai/dsh-workgraph-scheduler'

describe('mergeFileBytes', () => {
  it('applies the 3-way matrix', () => {
    expect(mergeFileBytes('base', 'base', 'theirs')).toEqual({ kind: 'take-theirs' })
    expect(mergeFileBytes('base', 'theirs', 'theirs')).toEqual({ kind: 'already-present' })
    expect(mergeFileBytes('base', 'ours', 'theirs')).toEqual({ kind: 'conflict' })
  })
})

describe('git seam + worktree orchestration', () => {
  let dir: string
  let mainDir: string
  let baseDir: string
  let worktree: string
  let calls: string[][]

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'workgraph-wt-'))
    mainDir = join(dir, 'main')
    baseDir = join(dir, 'base')
    worktree = join(dir, 'wt')
    await mkdir(mainDir, { recursive: true })
    await mkdir(baseDir, { recursive: true })
    await mkdir(worktree, { recursive: true })
    calls = []
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  /** A fake git seam mirroring the plumbing the merge uses, over real files. */
  function fakeGit(): GitSeam {
    return {
      run: async (args, _cwd) => {
        calls.push([...args])
        const [command, ...rest] = args
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
          await rm(rest[2]!, { recursive: true, force: true })
          return { code: 0, stdout: '' }
        }
        if (command === 'diff' && rest[0] === '--name-only') {
          // Files whose content differs from the fan-out base, including
          // files deleted in the worktree (missing there).
          const names: string[] = []
          const seen = new Set<string>()
          for (const name of await listFiles(worktree)) {
            seen.add(name)
            const base = await readFile(join(baseDir, name), 'utf8').catch(() => '')
            const theirs = await readFile(join(worktree, name), 'utf8').catch(() => '')
            if (base !== theirs) names.push(name)
          }
          for (const name of await listFiles(baseDir)) {
            if (seen.has(name)) continue
            // Deleted in the worktree.
            names.push(name)
          }
          return { code: 0, stdout: names.join('\n') }
        }
        if (command === 'show') {
          const path = String(rest[0]).split(':').slice(1).join(':')
          return { code: 0, stdout: await readFile(join(baseDir, path), 'utf8').catch(() => '') }
        }
        if (command === 'ls-files') {
          // Files in the worktree that do not exist in the main tree.
          const names: string[] = []
          for (const name of await listFiles(worktree)) {
            const exists = await readFile(join(mainDir, name), 'utf8').catch(() => null)
            if (exists === null) names.push(name)
          }
          return { code: 0, stdout: names.join('\n') }
        }
        return { code: 1, stdout: '' }
      },
    }
  }

  async function listFiles(root: string): Promise<string[]> {
    const names: string[] = []
    async function walk(prefix: string): Promise<void> {
      for (const entry of await (await import('node:fs/promises')).readdir(join(root, prefix), { withFileTypes: true })) {
        const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
        if (entry.isDirectory()) await walk(rel)
        else names.push(rel)
      }
    }
    await walk('')
    return names
  }

  it('mints a worktree and reports the repo state', async () => {
    const seam = fakeGit()
    expect(await isGitRepo(seam, mainDir)).toBe(true)
    await mintWorktree(seam, mainDir, worktree, 'deadbeef')
    expect(calls.some(args => args[0] === 'worktree' && args[1] === 'add')).toBe(true)
    expect(worktreePath(dir, 'session-1', 'gn-abc')).toBe(join(dir, 'workgraph', 'worktrees', 'session-1', 'gn-abc'))
  })

  it('merges a clean batch: take-theirs writes, already-present skips, worktree removed', async () => {
    await writeFile(join(baseDir, 'a.ts'), 'base-a\n')
    await writeFile(join(baseDir, 'b.ts'), 'base-b\n')
    await writeFile(join(baseDir, 'c.ts'), 'base-c\n')
    await writeFile(join(mainDir, 'a.ts'), 'base-a\n')
    await writeFile(join(mainDir, 'b.ts'), 'base-b\n')
    await writeFile(join(mainDir, 'c.ts'), 'already\n')
    await writeFile(join(worktree, 'a.ts'), 'theirs-a\n')
    await writeFile(join(worktree, 'b.ts'), 'base-b\n')
    // c: base differs from both sides, but main and worktree agree — the
    // change is already present, nothing to merge.
    await writeFile(join(worktree, 'c.ts'), 'already\n')
    const seam = fakeGit()
    const result = await mergeWorktree(seam, mainDir, worktree, 'deadbeef', 'deadbeef')
    expect(result).toEqual({ ok: true })
    expect(await readFile(join(mainDir, 'a.ts'), 'utf8')).toBe('theirs-a\n')
    expect(await readFile(join(mainDir, 'c.ts'), 'utf8')).toBe('already\n')
    expect(calls.some(args => args[0] === 'worktree' && args[1] === 'remove')).toBe(true)
  })

  it('fails only the node on a conflict, naming the file', async () => {
    await writeFile(join(baseDir, 'a.ts'), 'base-a\n')
    await writeFile(join(baseDir, 'conflict.ts'), 'base-conflict\n')
    await writeFile(join(mainDir, 'a.ts'), 'base-a\n')
    await writeFile(join(mainDir, 'conflict.ts'), 'ours\n')
    await writeFile(join(worktree, 'a.ts'), 'theirs-a\n')
    await writeFile(join(worktree, 'conflict.ts'), 'theirs\n')
    const seam = fakeGit()
    const result = await mergeWorktree(seam, mainDir, worktree, 'deadbeef', 'deadbeef')
    expect(result).toEqual({ ok: false, reason: 'merge conflict on conflict.ts' })
    // The worktree is kept for postmortem.
    expect(await readFile(join(worktree, 'a.ts'), 'utf8')).toBe('theirs-a\n')
  })

  it('fails the node loudly when the main HEAD moved since fan-out', async () => {
    const seam = fakeGit()
    const result = await mergeWorktree(seam, mainDir, worktree, 'oldhead', 'newhead')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('main HEAD moved since fan-out')
  })

  it('lands untracked files and removes deleted files', async () => {
    await writeFile(join(baseDir, 'gone.ts'), 'base-gone\n')
    await writeFile(join(mainDir, 'gone.ts'), 'base-gone\n')
    await writeFile(join(worktree, 'new.ts'), 'brand new\n')
    // Deleted in the worktree: the main copy must be removed.
    const seam = fakeGit()
    const result = await mergeWorktree(seam, mainDir, worktree, 'deadbeef', 'deadbeef')
    expect(result).toEqual({ ok: true })
    expect(await readFile(join(mainDir, 'new.ts'), 'utf8')).toBe('brand new\n')
    expect(await readFile(join(mainDir, 'gone.ts'), 'utf8').catch(() => null)).toBeNull()
  })

  it('reports the changed set from the diff and untracked files', async () => {
    await writeFile(join(baseDir, 'a.ts'), 'base\n')
    await writeFile(join(mainDir, 'a.ts'), 'base\n')
    await writeFile(join(worktree, 'a.ts'), 'changed\n')
    await writeFile(join(worktree, 'new.ts'), 'new\n')
    const seam = fakeGit()
    const files = await changedFiles(seam, worktree, 'deadbeef')
    expect(files.sort()).toEqual(['a.ts', 'new.ts'])
  })
})


describe('createGitSeam', () => {
  let gitDir: string

  beforeEach(async () => {
    gitDir = await mkdtemp(join(tmpdir(), 'workgraph-git-'))
  })

  afterEach(async () => {
    await rm(gitDir, { recursive: true, force: true })
  })

  it('runs git and reports the exit code', async () => {
    const seam = createGitSeam()
    const version = await seam.run(['--version'], gitDir)
    expect(version.code).toBe(0)
    expect(version.stdout).toContain('git version')
    // A non-git directory reports false through the repo probe.
    expect(await isGitRepo(seam, gitDir)).toBe(false)
  })

  it('reports a failure code when git cannot run', async () => {
    const seam = createGitSeam()
    const result = await seam.run(['rev-parse', '--bogus'], join(gitDir, 'does-not-exist'))
    expect(result.code).not.toBe(0)
  })
})

describe('failure paths', () => {
  let failDir: string
  let failMain: string
  let failWt: string

  beforeEach(async () => {
    failDir = await mkdtemp(join(tmpdir(), 'workgraph-wtfail-'))
    failMain = join(failDir, 'main')
    failWt = join(failDir, 'wt')
    await mkdir(failMain, { recursive: true })
    await mkdir(failWt, { recursive: true })
  })

  afterEach(async () => {
    await rm(failDir, { recursive: true, force: true })
  })

  it('throws when the HEAD cannot be resolved or a worktree cannot be minted', async () => {
    const failing: GitSeam = {
      run: async (args) => {
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { code: 1, stdout: 'fatal: not a git repo' }
        return { code: 1, stdout: 'boom' }
      },
    }
    await expect(captureHead(failing, failMain)).rejects.toThrow('cannot resolve the main HEAD')
    await expect(mintWorktree(failing, failMain, failWt, 'head')).rejects.toThrow('failed to mint worktree')
  })

  it('reports a failed worktree removal', async () => {
    const failing: GitSeam = {
      run: async () => ({ code: 1, stdout: 'cannot remove' }),
    }
    expect(await removeWorktree(failing, failMain, failWt)).toBe(false)
  })

  it('reads a missing blob as empty', async () => {
    const missing: GitSeam = {
      run: async () => ({ code: 1, stdout: '' }),
    }
    expect(await readBlob(missing, failMain, 'deadbeef', 'nope.ts')).toBe('')
  })
})

describe('changedFiles failure tolerance', () => {
  let wtDir: string
  let wtMain: string

  beforeEach(async () => {
    wtDir = await mkdtemp(join(tmpdir(), 'workgraph-wtcf-'))
    wtMain = join(wtDir, 'main')
    await mkdir(wtMain, { recursive: true })
  })

  afterEach(async () => {
    await rm(wtDir, { recursive: true, force: true })
  })

  it('degrades to the untracked set when the diff plumbing fails', async () => {
    let failDiff = true
    let failLs = false
    const seam: GitSeam = {
      run: async (args) => {
        if (args[0] === 'diff') return failDiff ? { code: 1, stdout: '' } : { code: 0, stdout: 'tracked.ts' }
        if (args[0] === 'ls-files') return failLs ? { code: 1, stdout: '' } : { code: 0, stdout: 'new.ts' }
        return { code: 0, stdout: '' }
      },
    }
    expect(await changedFiles(seam, wtMain, 'deadbeef')).toEqual(['new.ts'])
    failDiff = false
    failLs = true
    expect(await changedFiles(seam, wtMain, 'deadbeef')).toEqual(['tracked.ts'])
  })
})
