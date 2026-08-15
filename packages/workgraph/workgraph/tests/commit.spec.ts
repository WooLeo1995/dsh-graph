import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { commitWorkGraphChange, WorkGraphId } from '@deepseek-ai/dsh-workgraph'
import type { WorkGraphChanged, WorkGraphSnapshot } from '@deepseek-ai/dsh-workgraph'

function snapshot(): WorkGraphSnapshot {
  return {
    id: WorkGraphId('wg-1'),
    objective: 'ship it',
    status: 'active',
    planVersion: 1,
    nodes: [],
    pendingDiscoveries: [],
    history: [],
    tokensSpent: 0,
    replanRuns: 0,
    createdAt: 1,
    updatedAt: 1,
  }
}

function stubAgent(): Agent {
  const session = Session.create(SessionId('workgraph-commit-test'))
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

describe('commitWorkGraphChange', () => {
  it('appends the whole-value session event, then emits the live notification', () => {
    const ctx = new Context()
    const agent = stubAgent()
    const seen: { agent: Agent; change: WorkGraphChanged }[] = []
    ctx.on('workgraph/changed', (payload) => {
      seen.push({ agent: payload.agent, change: payload.change })
    })
    const graph = snapshot()
    commitWorkGraphChange(
      ctx,
      agent,
      { kind: 'workgraph/change', version: 1, graph },
      'set',
    )
    const event = agent.session.events.at(-1) as SessionEvent
    expect(event.type).toBe('workgraph/change')
    expect(event.data).toEqual({ kind: 'workgraph/change', version: 1, graph })
    expect(seen).toEqual([{ agent, change: { operation: 'set', graph } }])
  })

  it('emits the clear verb for a tombstone regardless of the passed operation', () => {
    const ctx = new Context()
    const agent = stubAgent()
    const seen: WorkGraphChanged[] = []
    ctx.on('workgraph/changed', (payload) => {
      seen.push(payload.change)
    })
    commitWorkGraphChange(
      ctx,
      agent,
      { kind: 'workgraph/change', version: 1, operation: 'clear', cleared: WorkGraphId('wg-1'), clearedAt: 9 },
      'clear',
    )
    expect(seen).toEqual([{ operation: 'clear' }])
    expect(agent.session.events.at(-1)!.type).toBe('workgraph/change')
  })
})
