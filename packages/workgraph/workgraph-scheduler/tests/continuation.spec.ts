import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import { createLifecycleEmitter } from '@deepseek-ai/dsh-subagent/src/lifecycle.ts'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { continuationWorkerRound } from '@deepseek-ai/dsh-workgraph-scheduler'

function stubAgent(): Agent {
  const session = Session.create(SessionId('continuation-test'))
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

/** A fake subagents seam scripting worker epochs through the event bus. */
function fakeSubagents(
  ctx: Context,
  agent: Agent,
  script: Array<{ text: string; stopReason?: string }>,
): {
  startContinuable: () => Promise<{ childId: string; messageId: string }>
  followup: (_parent: unknown, childId: unknown, content: unknown) => Promise<{ id: string }>
  started: unknown[]
} {
  const started: unknown[] = []
  let seq = 0
  const emit = createLifecycleEmitter(ctx, () => ({}))
  const emitEnd = (childId: unknown, scripted: { text: string; stopReason?: string }): void => {
    const info: SubagentRunEndInfo = {
      runId: `run-${childId}` as never,
      provider: 'spawn',
      id: childId as never,
      local: true,
      stopReason: scripted.stopReason as never ?? 'completed',
      ...(scripted.text.length > 0
        ? { lastAssistantMessage: [{ type: 'text', text: scripted.text }] }
        : {}),
    }
    emit('subagent/end', info, agent)
  }
  const startContinuable = async (): Promise<{ childId: string; messageId: string }> => {
    seq += 1
    const childId = `child-${seq}`
    started.push({ kind: 'start', childId })
    const scripted = script[seq - 1]
    // Empty-script tests replace the end emission themselves; never schedule
    // a timer that dereferences an exhausted script entry.
    if (scripted !== undefined) setTimeout(() => { emitEnd(childId, scripted) }, 0)
    return { childId, messageId: `m-${childId}` }
  }
  const followup = async (_parent: unknown, childId: unknown, content: unknown): Promise<{ id: string }> => {
    started.push({ kind: 'followup', childId, content })
    const scripted = script[seq]
    if (scripted !== undefined) setTimeout(() => { emitEnd(childId, scripted) }, 0)
    return { id: 'followup-accepted' }
  }
  return { startContinuable, followup, started }
}

const ENVELOPE = (status: string, summary: string): string =>
  `REPORT: {"status":"${status}","summary":"${summary}","discovered":[]}`

describe('continuationWorkerRound', () => {
  it('spawns round 1 and continues the SAME child with the gaps prompt on round 2', async () => {
    const ctx = new Context()
    const agent = stubAgent()
    const subagents = fakeSubagents(ctx, agent, [
      { text: ENVELOPE('done', 'first attempt') },
      { text: ENVELOPE('done', 'gaps closed') },
    ])
    const round = continuationWorkerRound(
      Object.assign(ctx, { subagents }),
      agent,
    )
    const first = await round({
      prompt: 'round one prompt',
      signal: new AbortController().signal,
      round: 1,
    })
    expect(first.outcome).toEqual({ kind: 'done', summary: 'first attempt', discovered: [] })
    expect(first.childSessionId).toBe('child-1')
    const second = await round({
      prompt: 'round two with gaps',
      signal: new AbortController().signal,
      round: 2,
      childSessionId: first.childSessionId,
    })
    expect(second.childSessionId).toBe('child-1')
    expect(second.outcome).toEqual({ kind: 'done', summary: 'gaps closed', discovered: [] })
    const followup = subagents.started.find(entry => (entry as { kind: string }).kind === 'followup') as {
      childId: string
      content: Array<{ type: string; text: string }>
    }
    expect(followup.childId).toBe('child-1')
    expect(followup.content[0]!.text).toBe('round two with gaps')
  })

  it('passes the workspace override into the startContinuable request', async () => {
    const ctx = new Context()
    const agent = stubAgent()
    const subagents = fakeSubagents(ctx, agent, [{ text: ENVELOPE('done', 'ok') }])
    const started: Array<{ request?: { workspace?: string } }> = []
    const original = subagents.startContinuable
    ;(subagents as { startContinuable: typeof original }).startContinuable = async (spec?: unknown) => {
      started.push(spec as { request?: { workspace?: string } })
      return original()
    }
    const round = continuationWorkerRound(
      Object.assign(ctx, { subagents }),
      agent,
    )
    await round({
      prompt: 'p',
      signal: new AbortController().signal,
      round: 1,
      workspace: '/tmp/worktree-1',
    })
    expect(started[0]!.request!.workspace).toBe('/tmp/worktree-1')
  })

  it('fails closed when a worker epoch ends with a non-completed stop reason', async () => {
    const ctx = new Context()
    const agent = stubAgent()
    const subagents = fakeSubagents(ctx, agent, [{ text: '', stopReason: 'error' }])
    const round = continuationWorkerRound(
      Object.assign(ctx, { subagents }),
      agent,
    )
    const result = await round({
      prompt: 'p',
      signal: new AbortController().signal,
      round: 1,
    })
    expect(result.outcome).toEqual({
      kind: 'fail-closed',
      reason: 'worker child ended with stop reason "error"',
    })
  })

  it('treats an epoch without a final message as an empty output', async () => {
    const ctx = new Context()
    const agent = stubAgent()
    const subagents = fakeSubagents(ctx, agent, [])
    const original = subagents.startContinuable
    const emit = createLifecycleEmitter(ctx, () => ({}))
    ;(subagents as { startContinuable: typeof original }).startContinuable = async () => {
      const { childId, messageId } = await original()
      setTimeout(() => {
        const info: SubagentRunEndInfo = {
          runId: `run-${childId}` as never,
          provider: 'spawn',
          id: childId as never,
          local: true,
          stopReason: 'completed',
        }
        emit('subagent/end', info, agent)
      }, 0)
      return { childId, messageId }
    }
    const round = continuationWorkerRound(
      Object.assign(ctx, { subagents }),
      agent,
    )
    const result = await round({
      prompt: 'p',
      signal: new AbortController().signal,
      round: 1,
    })
    expect(result.outcome).toEqual({
      kind: 'unparseable',
      reason: 'worker final output carries no REPORT: envelope',
    })
  })

  it('ignores end events from other children', async () => {
    const ctx = new Context()
    const agent = stubAgent()
    const emit = createLifecycleEmitter(ctx, () => ({}))
    const subagents = {
      startContinuable: async () => {
        const childId = 'mine'
        const other: SubagentRunEndInfo = {
          runId: 'run-other' as never,
          provider: 'spawn',
          id: 'other-child' as never,
          local: true,
          stopReason: 'completed',
          lastAssistantMessage: [{ type: 'text', text: ENVELOPE('done', 'not mine') }],
        }
        const mine: SubagentRunEndInfo = {
          runId: 'run-mine' as never,
          provider: 'spawn',
          id: childId as never,
          local: true,
          stopReason: 'completed',
          lastAssistantMessage: [{ type: 'text', text: ENVELOPE('done', 'mine') }],
        }
        setTimeout(() => { emit('subagent/end', other, agent) }, 0)
        setTimeout(() => { emit('subagent/end', mine, agent) }, 5)
        return { childId, messageId: 'm-mine' }
      },
    }
    const round = continuationWorkerRound(
      Object.assign(ctx, { subagents }),
      agent,
    )
    const result = await round({ prompt: 'p', signal: new AbortController().signal, round: 1 })
    expect(result.outcome).toEqual({ kind: 'done', summary: 'mine', discovered: [] })
  })

  it('fails closed on a non-completed continuation round', async () => {
    const ctx = new Context()
    const agent = stubAgent()
    const subagents = fakeSubagents(ctx, agent, [
      { text: ENVELOPE('done', 'first') },
      { text: '', stopReason: 'error' },
    ])
    const round = continuationWorkerRound(
      Object.assign(ctx, { subagents }),
      agent,
    )
    const first = await round({ prompt: 'p1', signal: new AbortController().signal, round: 1 })
    const second = await round({
      prompt: 'p2',
      signal: new AbortController().signal,
      round: 2,
      childSessionId: first.childSessionId,
    })
    expect(second.outcome).toEqual({
      kind: 'fail-closed',
      reason: 'worker child ended with stop reason "error"',
    })
  })

  it('rejects the round when the epoch wait is aborted', async () => {
    const ctx = new Context()
    const agent = stubAgent()
    const subagents = fakeSubagents(ctx, agent, [])
    const original = subagents.startContinuable
    ;(subagents as { startContinuable: () => Promise<{ childId: string; messageId: string }> }).startContinuable = async () => {
      const { childId, messageId } = await original()
      setTimeout(() => {
        // No end event: the wait is aborted instead.
        void childId
      }, 0)
      return { childId, messageId }
    }
    const round = continuationWorkerRound(
      Object.assign(ctx, { subagents }),
      agent,
    )
    const controller = new AbortController()
    const pending = round({ prompt: 'p', signal: controller.signal, round: 1 })
    setTimeout(() => { controller.abort() }, 5)
    await expect(pending).rejects.toThrow('workgraph: child epoch aborted')
  })

  it('rejects a continuation round without a child session id', async () => {
    const ctx = new Context()
    const agent = stubAgent()
    const round = continuationWorkerRound(
      Object.assign(ctx, { subagents: { startContinuable: async () => { throw new Error('unused') } } }),
      agent,
    )
    await expect(round({
      prompt: 'p',
      signal: new AbortController().signal,
      round: 2,
    })).rejects.toThrow('continuation round without a child session id')
  })
})
