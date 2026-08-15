import { describe, expect, it } from 'vitest'
import type { WorkGraphLimits } from '@deepseek-ai/dsh-workgraph'
import {
  canonicalNodeId,
  renderPlannerPrompt,
  renderWorkerPrompt,
  runPlannerEpisode,
} from '@deepseek-ai/dsh-workgraph-scheduler'
import type { PlannerSpawn, PlannerSpawnResult } from '@deepseek-ai/dsh-workgraph-scheduler'

const LIMITS: WorkGraphLimits = { maxNodes: 24, historyMax: 64 }

/** A spawn scripting one artifact per call, recording prompts verbatim. */
function scripted(...artifacts: PlannerSpawnResult[]): {
  spawn: PlannerSpawn
  prompts: string[]
} {
  const prompts: string[] = []
  let call = 0
  return {
    prompts,
    spawn: async ({ prompt }) => {
      prompts.push(prompt)
      return artifacts[Math.min(call++, artifacts.length - 1)]!
    },
  }
}

const VALID_ARTIFACT = {
  structured: {
    nodes: [
      { id: 'a', title: 'A', spec: 'do a', deps: [] },
      { id: 'b', title: 'B', spec: 'do b', deps: ['a'] },
    ],
  },
  stopReason: 'completed',
}

describe('runPlannerEpisode', () => {
  it('returns the installed plan for a valid artifact (final node appended)', async () => {
    const { spawn } = scripted(VALID_ARTIFACT)
    const outcome = await runPlannerEpisode({
      objective: 'ship it',
      feedback: '',
      limits: LIMITS,
      signal: new AbortController().signal,
      spawn,
    })
    expect(outcome.kind).toBe('planned')
    if (outcome.kind !== 'planned') return
    expect(outcome.nodes.map(node => node.id)).toEqual([
      canonicalNodeId('a'),
      canonicalNodeId('b'),
      'gn-final',
    ])
    expect(outcome.nodes.at(-1)!.blocks).toEqual([canonicalNodeId('a'), canonicalNodeId('b')])
  })

  it('rejects an invalid artifact with the precise gate reason', async () => {
    const { spawn } = scripted({
      structured: {
        nodes: [
          { id: 'a', title: 'A', spec: 'do a', deps: [] },
          { id: 'b', title: 'B', spec: 'do b', deps: ['b'] },
        ],
      },
      stopReason: 'completed',
    })
    const outcome = await runPlannerEpisode({
      objective: 'ship it',
      feedback: '',
      limits: LIMITS,
      signal: new AbortController().signal,
      spawn,
    })
    expect(outcome).toEqual({
      kind: 'invalid',
      reason: 'node "b" depends on itself',
    })
  })

  it('renders the objective and the retry feedback into the prompt', async () => {
    const { spawn, prompts } = scripted(VALID_ARTIFACT)
    await runPlannerEpisode({
      objective: 'ship it',
      feedback: 'node "b" depends on itself',
      limits: LIMITS,
      signal: new AbortController().signal,
      spawn,
    })
    expect(prompts[0]).toContain('OBJECTIVE:\nship it')
    expect(prompts[0]).toContain('CONTEXT:\nnode "b" depends on itself')
    expect(prompts[0]).toContain('gn-final')
  })

  it('fails closed when the child ends with a non-completed stop reason', async () => {
    const { spawn } = scripted({ structured: undefined, stopReason: 'max-tokens' })
    const outcome = await runPlannerEpisode({
      objective: 'ship it',
      feedback: '',
      limits: LIMITS,
      signal: new AbortController().signal,
      spawn,
    })
    expect(outcome).toEqual({
      kind: 'fail-closed',
      reason: 'planner child ended with stop reason "max-tokens"',
    })
  })

  it('fails closed when the child commits no structured artifact', async () => {
    const { spawn } = scripted({ structured: undefined, stopReason: 'completed' })
    const outcome = await runPlannerEpisode({
      objective: 'ship it',
      feedback: '',
      limits: LIMITS,
      signal: new AbortController().signal,
      spawn,
    })
    expect(outcome).toEqual({
      kind: 'fail-closed',
      reason: 'planner produced no structured plan artifact',
    })
  })
})

describe('renderPlannerPrompt', () => {
  it('embeds the objective and context verbatim', () => {
    const prompt = renderPlannerPrompt('build the thing', 'feedback line')
    expect(prompt).toContain('OBJECTIVE:\nbuild the thing')
    expect(prompt).toContain('CONTEXT:\nfeedback line')
  })
})

describe('runPlannerEpisode fail-loud discipline', () => {
  it('rethrows a non-domain error from the gate instead of papering over it', async () => {
    // A proxy whose property read explodes bypasses WorkGraphError: the gate
    // cannot classify it, so the episode must rethrow, not map it to invalid.
    const artifact = new Proxy({}, {
      get() {
        throw new Error('boom')
      },
    })
    const { spawn } = scripted({ structured: artifact, stopReason: 'completed' })
    await expect(runPlannerEpisode({
      objective: 'ship it',
      feedback: '',
      limits: LIMITS,
      signal: new AbortController().signal,
      spawn,
    })).rejects.toThrow('boom')
  })
})


describe('renderWorkerPrompt', () => {
  it('renders the node contract and the prior round gaps', () => {
    const prompt = renderWorkerPrompt({
      position: 2,
      total: 3,
      title: 'B',
      spec: 'do b',
      objective: 'ship it',
      gaps: ['verify the tests', 'close the lints'],
    })
    expect(prompt).toContain('[Graph node 2/3: B]')
    expect(prompt).toContain('do b')
    expect(prompt).toContain('ship it')
    expect(prompt).toContain('## GAPS')
    expect(prompt).toContain('- verify the tests')
    expect(prompt).toContain('- close the lints')
  })

  it('marks a first round with no gaps', () => {
    const prompt = renderWorkerPrompt({
      position: 1,
      total: 1,
      title: 'A',
      spec: 'do a',
      objective: 'ship it',
      gaps: [],
    })
    expect(prompt).toContain('(none — first round)')
  })
})
