/**
 * Config surface tests (issue 07): spec defaults, load-time clamps, and
 * loud out-of-range failures.
 * @module
 */

import { describe, expect, it } from 'vitest'
import type { WorkGraphConfig } from '@deepseek-ai/dsh-workgraph-scheduler/src/config.ts'
import {
  DEFAULT_CHILD_AWAIT_BUDGET,
  DEFAULT_CONCURRENCY,
  DEFAULT_HISTORY_MAX,
  DEFAULT_MAX_NODES,
  DEFAULT_NODE_ROUNDS,
  DEFAULT_OPTIMIZER,
  DEFAULT_PLAN_BYTES_MAX,
  DEFAULT_REPLAN_CAP,
  resolveWorkGraphConfig,
  workGraphConfigSchema,
} from '@deepseek-ai/dsh-workgraph-scheduler/src/config.ts'

describe('work graph config', () => {
  it('resolves every tunable to its spec default', () => {
    const resolved = resolveWorkGraphConfig({})
    expect(resolved.concurrency).toBe(DEFAULT_CONCURRENCY)
    expect(resolved.nodeRounds).toBe(DEFAULT_NODE_ROUNDS)
    expect(resolved.replanCap).toBe(DEFAULT_REPLAN_CAP)
    expect(resolved.optimizer).toBe(DEFAULT_OPTIMIZER)
    expect(resolved.maxNodes).toBe(DEFAULT_MAX_NODES)
    expect(resolved.historyMax).toBe(DEFAULT_HISTORY_MAX)
    expect(resolved.planBytesMax).toBe(DEFAULT_PLAN_BYTES_MAX)
    expect(resolved.childAwaitBudget).toBe(DEFAULT_CHILD_AWAIT_BUDGET)
    expect(resolved.limits).toEqual({
      maxNodes: DEFAULT_MAX_NODES,
      historyMax: DEFAULT_HISTORY_MAX,
      planBytesMax: DEFAULT_PLAN_BYTES_MAX,
    })
  })

  it('honors explicit tunables and feeds the limits', () => {
    const resolved = resolveWorkGraphConfig({ maxNodes: 8, concurrency: 2, childAwaitBudget: 0.02 })
    expect(resolved.maxNodes).toBe(8)
    expect(resolved.concurrency).toBe(2)
    expect(resolved.childAwaitBudget).toBe(0.02)
    expect(resolved.limits.maxNodes).toBe(8)
    expect(resolved.limits.planBytesMax).toBe(DEFAULT_PLAN_BYTES_MAX)
  })

  it('fails loudly on out-of-range tunables at direct construction', () => {
    expect(() => resolveWorkGraphConfig({ concurrency: 9 })).toThrow('workgraph.concurrency')
    expect(() => resolveWorkGraphConfig({ concurrency: 0 })).toThrow('workgraph.concurrency')
    expect(() => resolveWorkGraphConfig({ nodeRounds: 0 })).toThrow('workgraph.nodeRounds')
    expect(() => resolveWorkGraphConfig({ replanCap: -1 })).toThrow('workgraph.replanCap')
    expect(() => resolveWorkGraphConfig({ maxNodes: 0 })).toThrow('workgraph.maxNodes')
    expect(() => resolveWorkGraphConfig({ historyMax: 1.5 })).toThrow('workgraph.historyMax')
    expect(() => resolveWorkGraphConfig({ planBytesMax: 0 })).toThrow('workgraph.planBytesMax')
    expect(() => resolveWorkGraphConfig({ childAwaitBudget: 0 })).toThrow('workgraph.childAwaitBudget')
    // The documented upper clamp holds at direct construction too: a pause
    // that waits past an hour is a silent misconfig. Sub-1-second values
    // remain the bounded-settlement test seam's fast-settle accommodation.
    expect(() => resolveWorkGraphConfig({ childAwaitBudget: 3601 })).toThrow('workgraph.childAwaitBudget')
    expect(() => resolveWorkGraphConfig({ childAwaitBudget: 3600.5 })).toThrow('workgraph.childAwaitBudget')
    expect(() => resolveWorkGraphConfig({ childAwaitBudget: 3600 })).not.toThrow()
  })

  it('enforces the documented clamps at the cordis load boundary', () => {
    // The schema input is the full validated shape; defaults still apply.
    const base: WorkGraphConfig = {
      workgraphDir: '/tmp/wg',
      concurrency: DEFAULT_CONCURRENCY,
      nodeRounds: DEFAULT_NODE_ROUNDS,
      replanCap: DEFAULT_REPLAN_CAP,
      optimizer: DEFAULT_OPTIMIZER,
      maxNodes: DEFAULT_MAX_NODES,
      historyMax: DEFAULT_HISTORY_MAX,
      planBytesMax: DEFAULT_PLAN_BYTES_MAX,
      childAwaitBudget: DEFAULT_CHILD_AWAIT_BUDGET,
    }
    expect(workGraphConfigSchema({ ...base }).concurrency).toBe(DEFAULT_CONCURRENCY)
    expect(workGraphConfigSchema({ ...base, concurrency: 8, replanCap: 10 }).replanCap).toBe(10)
    expect(() => workGraphConfigSchema({ ...base, concurrency: 9 })).toThrow()
    expect(() => workGraphConfigSchema({ ...base, nodeRounds: 9 })).toThrow()
    expect(() => workGraphConfigSchema({ ...base, replanCap: 11 })).toThrow()
    expect(() => workGraphConfigSchema({ ...base, replanCap: -1 })).toThrow()
    expect(() => workGraphConfigSchema({ ...base, childAwaitBudget: 3601 })).toThrow()
    expect(() => workGraphConfigSchema({ ...base, childAwaitBudget: 0 })).toThrow()
    expect(workGraphConfigSchema({ ...base, optimizer: false }).optimizer).toBe(false)
    expect(workGraphConfigSchema({ ...base, planBytesMax: 512 }).planBytesMax).toBe(512)
    expect(workGraphConfigSchema({ ...base }).workgraphDir).toBe('/tmp/wg')
  })
})
