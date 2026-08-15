import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  chargeTokenUsage,
  readSessionUsage,
  sessionChildUsageReader,
} from '@deepseek-ai/dsh-workgraph-scheduler'

describe('chargeTokenUsage', () => {
  it('charges input, output, and cache reads/writes', () => {
    expect(chargeTokenUsage({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheWriteTokens: 3,
    })).toBe(38)
    expect(chargeTokenUsage({ inputTokens: 1, outputTokens: 2 })).toBe(3)
  })
})

describe('readSessionUsage', () => {
  function sessionWith(...messages: Array<{ usage?: object }>): Session {
    const session = Session.create(SessionId('usage-test'))
    for (const message of messages) {
      session.append('assistant/message', {
        turn: 1,
        step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          source: { kind: 'model', provider: 'mock', model: 'mock' },
        }),
        ...(message.usage === undefined ? {} : { usage: message.usage as never }),
      }, { surfaceOp: 'append', sourceEventSeqs: [] })
    }
    return session
  }

  it('reports no recording and zero tokens for a session without usage', () => {
    const session = sessionWith({})
    expect(readSessionUsage(session)).toEqual({ tokens: 0, recorded: false })
  })

  it('folds adapter-reported usage across messages', () => {
    const session = sessionWith(
      { usage: { inputTokens: 10, outputTokens: 5 } },
      { usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 1 } },
      {},
    )
    expect(readSessionUsage(session)).toEqual({ tokens: 21, recorded: true })
  })
})

describe('sessionChildUsageReader', () => {
  it('reads a live child session and reports absent sessions as unrecorded', async () => {
    const child = Session.create(SessionId('child-usage'))
    child.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
      usage: { inputTokens: 4, outputTokens: 6 },
    }, { surfaceOp: 'append', sourceEventSeqs: [] })
    const ctx = {
      sessions: {
        get: (id: unknown) => (String(id) === 'child-usage' ? child : undefined),
      },
    }
    const reader = sessionChildUsageReader(ctx as unknown as Context)
    expect(await reader('child-usage')).toEqual({ tokens: 10, recorded: true })
    expect(await reader('missing')).toEqual({ tokens: 0, recorded: false })
  })
})
