import { describe, expect, it } from 'vitest'
import {
  parseReportEnvelope,
  parseVerifierReport,
  renderVerifierPrompt,
  runVerifierEpisode,
  VERIFIER_OUTPUT_SCHEMA,
} from '@deepseek-ai/dsh-workgraph-scheduler'
import type { WorkerSpawn } from '@deepseek-ai/dsh-workgraph-scheduler'

describe('parseVerifierReport', () => {
  it('accepts an achieved verdict with discoveries', () => {
    expect(parseVerifierReport({
      structured: { verdict: 'achieved', gaps: [], discovered: ['follow-up work'] },
      stopReason: 'completed',
    })).toEqual({ kind: 'achieved', discovered: ['follow-up work'] })
  })

  it('accepts a rejection with concrete gaps', () => {
    expect(parseVerifierReport({
      structured: { verdict: 'not_achieved', gaps: ['  tests fail  ', ''], discovered: [] },
      stopReason: 'completed',
    })).toEqual({ kind: 'rejected', gaps: ['tests fail'], discovered: [] })
  })

  it('rejects a gap-less rejection as invalid', () => {
    expect(parseVerifierReport({
      structured: { verdict: 'not_achieved', gaps: [], discovered: [] },
      stopReason: 'completed',
    })).toEqual({ kind: 'invalid', reason: 'verifier rejected without naming any gaps' })
  })

  it('fails closed when the verifier child errors', () => {
    expect(parseVerifierReport({ structured: undefined, stopReason: 'error' })).toEqual({
      kind: 'fail-closed',
      reason: 'verifier child ended with stop reason "error"',
    })
  })

  it('fails closed on a missing verdict and an unknown verdict value', () => {
    expect(parseVerifierReport({ structured: undefined, stopReason: 'completed' })).toEqual({
      kind: 'fail-closed',
      reason: 'verifier produced no structured verdict',
    })
    expect(parseVerifierReport({
      structured: { verdict: 'maybe', gaps: [], discovered: [] },
      stopReason: 'completed',
    })).toEqual({ kind: 'fail-closed', reason: 'verifier reported unknown verdict "maybe"' })
  })

  it('tolerates a non-array discovered field by cleaning it to empty', () => {
    expect(parseVerifierReport({
      structured: { verdict: 'achieved', gaps: [], discovered: 'nope' },
      stopReason: 'completed',
    })).toEqual({ kind: 'achieved', discovered: [] })
  })

  it('fails closed when verdict or gaps are missing from the report', () => {
    expect(parseVerifierReport({
      structured: { verdict: 'achieved' },
      stopReason: 'completed',
    })).toEqual({ kind: 'fail-closed', reason: 'verifier verdict is missing verdict or gaps' })
  })
})

describe('runVerifierEpisode', () => {
  it('renders the node contract and the worker summary for the spawn', async () => {
    const prompts: string[] = []
    const spawn: WorkerSpawn = async (request) => {
      prompts.push(request.prompt)
      return { structured: { verdict: 'achieved', gaps: [], discovered: [] }, stopReason: 'completed' }
    }
    const outcome = await runVerifierEpisode({
      position: 2,
      total: 3,
      title: 'B',
      spec: 'do b',
      objective: 'ship it',
      summary: 'worker says done',
      signal: new AbortController().signal,
      spawn,
    })
    expect(outcome).toEqual({ kind: 'achieved', discovered: [] })
    expect(prompts[0]).toContain('[Graph node 2/3: B]')
    expect(prompts[0]).toContain('do b')
    expect(prompts[0]).toContain('worker says done')
    expect(prompts[0]).toContain('adversarial skeptic')
    expect(prompts[0]).toContain('Do NOT modify any file')
  })
})

describe('renderVerifierPrompt', () => {
  it('embeds the contract, summary, and the strict structured-verdict contract', () => {
    const prompt = renderVerifierPrompt({
      position: 1,
      total: 2,
      title: 'A',
      spec: 'do a',
      objective: 'ship it',
      summary: 'done',
    })
    // The verdict travels through the structured-output capture (the spawn
    // carries VERIFIER_OUTPUT_SCHEMA), so the prompt must NOT teach the
    // worker-style text `REPORT:` envelope — a model that follows it skips
    // the capture tool and the episode can never settle.
    expect(prompt).not.toContain('REPORT:')
    expect(prompt).toContain('"verdict"')
    expect(prompt).toContain('gap-less rejection is itself rejected')
  })
})

describe('parseReportEnvelope', () => {
  it('parses the strict REPORT: JSON envelope from the final output', () => {
    expect(parseReportEnvelope('finished the work\nREPORT: {"status":"done","summary":"ok","discovered":["x"]}')).toEqual({
      kind: 'done',
      summary: 'ok',
      discovered: ['x'],
    })
    expect(parseReportEnvelope('REPORT: {"status":"blocked","summary":"no toolchain","discovered":[]}')).toEqual({
      kind: 'blocked',
      reason: 'no toolchain',
      discovered: [],
    })
  })

  it('takes the LAST envelope line when several are present', () => {
    const text = 'REPORT: {"status":"done","summary":"first","discovered":[]}\nmore work\nREPORT: {"status":"blocked","summary":"second","discovered":[]}'
    expect(parseReportEnvelope(text)).toEqual({ kind: 'blocked', reason: 'second', discovered: [] })
  })

  it('is unparseable without an envelope or with malformed JSON', () => {
    expect(parseReportEnvelope('just a summary')).toEqual({
      kind: 'unparseable',
      reason: 'worker final output carries no REPORT: envelope',
    })
    expect(parseReportEnvelope('REPORT: {not json')).toEqual({
      kind: 'unparseable',
      reason: 'worker REPORT: envelope is not valid JSON',
    })
  })
})

describe('VERIFIER_OUTPUT_SCHEMA', () => {
  it('shapes the verdict contract', () => {
    expect(VERIFIER_OUTPUT_SCHEMA.type).toBe('object')
    expect(Object.keys(VERIFIER_OUTPUT_SCHEMA.properties)).toEqual(['verdict', 'gaps', 'discovered'])
  })
})
