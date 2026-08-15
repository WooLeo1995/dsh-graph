/**
 * Plan-version baselines: each version's full node set is frozen before any
 * node of that version executes and can never be overwritten (create-new
 * semantics). Files live under the harness home workgraph dir, honoring the
 * scheduler's write isolation: nothing but `.dsh/graph.jsonl` and its lock
 * ever enters the repo.
 * @module @deepseek-ai/dsh-workgraph-scheduler/baselines
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { WorkGraphError } from '@deepseek-ai/dsh-workgraph'
import type { WorkNode } from '@deepseek-ai/dsh-workgraph'
import type { WorkGraphId } from '@deepseek-ai/dsh-workgraph/types'

/** Baseline storage; a store never overwrites a frozen version. */
export interface BaselineStore {
  /**
   * Freeze one plan version's full node set. Re-freezing the same version
   * fails loudly with `WORKGRAPH_BASELINE_EXISTS`.
   * @param graphId - the owning graph.
   * @param version - the plan version being frozen.
   * @param nodes - the complete installed node set (final node included).
   */
  freeze(graphId: WorkGraphId, version: number, nodes: readonly WorkNode[]): Promise<void>
  /**
   * Read one frozen baseline.
   * @param graphId - the owning graph.
   * @param version - the plan version to read.
   * @returns the frozen node set, or `undefined` when no baseline exists.
   */
  read(graphId: WorkGraphId, version: number): Promise<readonly WorkNode[] | undefined>
}

/**
 * A filesystem baseline store rooted at the harness home workgraph dir.
 * Layout: `<root>/workgraph/baselines/<graphId>/v<version>.json`.
 * @param rootDir - the harness home directory.
 * @returns the store.
 */
export function createBaselineStore(rootDir: string): BaselineStore {
  const baselinePath = (graphId: WorkGraphId, version: number): string =>
    join(rootDir, 'workgraph', 'baselines', graphId, `v${version}.json`)
  return {
    async freeze(graphId, version, nodes) {
      const path = baselinePath(graphId, version)
      await mkdir(dirname(path), { recursive: true })
      try {
        await writeFile(path, `${JSON.stringify(nodes, null, 2)}\n`, { flag: 'wx' })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new WorkGraphError(
            `baseline v${version} for graph ${graphId} is already frozen`,
            'WORKGRAPH_BASELINE_EXISTS',
          )
        }
        throw error
      }
    },
    async read(graphId, version) {
      try {
        const text = await readFile(baselinePath(graphId, version), 'utf8')
        return JSON.parse(text) as readonly WorkNode[]
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
    },
  }
}
