import { chmod, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkGraphError, WorkGraphId, WorkNodeId } from '@deepseek-ai/dsh-workgraph'
import { createBaselineStore } from '@deepseek-ai/dsh-workgraph-scheduler'

const ID = WorkGraphId('wg-baseline')
const NODES = [
  { id: WorkNodeId('gn-aaaaaaaa'), title: 'A', spec: 'do a', blocks: [], state: 'waiting' as const, rounds: 0 },
  { id: WorkNodeId('gn-bbbbbbbb'), title: 'B', spec: 'do b', blocks: [WorkNodeId('gn-aaaaaaaa')], state: 'waiting' as const, rounds: 0 },
]

describe('createBaselineStore', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'workgraph-baselines-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('freezes a version and reads it back byte-identical', async () => {
    const store = createBaselineStore(dir)
    await store.freeze(ID, 1, NODES)
    expect(await store.read(ID, 1)).toEqual(NODES)
    const raw = await readFile(join(dir, 'workgraph', 'baselines', ID, 'v1.json'), 'utf8')
    expect(JSON.parse(raw)).toEqual(NODES)
  })

  it('never overwrites a frozen version (create-new semantics)', async () => {
    const store = createBaselineStore(dir)
    await store.freeze(ID, 1, NODES)
    await expect(store.freeze(ID, 1, NODES)).rejects.toEqual(
      new WorkGraphError(
        `baseline v1 for graph ${ID} is already frozen`,
        'WORKGRAPH_BASELINE_EXISTS',
      ),
    )
  })

  it('returns undefined for an unfrozen version', async () => {
    const store = createBaselineStore(dir)
    expect(await store.read(ID, 1)).toBeUndefined()
    expect(await store.read(ID, 2)).toBeUndefined()
  })

  it('freezes distinct versions independently', async () => {
    const store = createBaselineStore(dir)
    await store.freeze(ID, 1, NODES)
    await store.freeze(ID, 2, NODES.slice(0, 1))
    expect(await store.read(ID, 1)).toEqual(NODES)
    expect(await store.read(ID, 2)).toEqual(NODES.slice(0, 1))
  })
})

describe('createBaselineStore failure paths', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'workgraph-baselines-fail-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('rethrows a non-EEXIST freeze failure loudly', async () => {
    const store = createBaselineStore(dir)
    // A read-only baseline dir makes the wx write fail with EACCES, which
    // must propagate — only EEXIST means "already frozen".
    const baselineDir = join(dir, 'workgraph', 'baselines', ID)
    await mkdir(baselineDir, { recursive: true })
    await chmod(baselineDir, 0o555)
    try {
      await expect(store.freeze(ID, 1, NODES)).rejects.toThrow()
    } finally {
      await chmod(baselineDir, 0o755)
    }
  })

  it('rethrows a non-ENOENT read failure loudly', async () => {
    const store = createBaselineStore(dir)
    // A directory squatting on the v1.json path makes the read fail with
    // EISDIR, which must propagate — only ENOENT means "no baseline".
    await mkdir(join(dir, 'workgraph', 'baselines', ID, 'v1.json'), { recursive: true })
    await expect(store.read(ID, 1)).rejects.toThrow()
  })
})
