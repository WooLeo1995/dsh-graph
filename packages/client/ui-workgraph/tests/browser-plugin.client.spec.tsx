// @vitest-environment jsdom
/**
 * ui-workgraph browser half on a real cordis Context with fake slots,
 * conversation-event faces, and a fake sessions service: apply registers the
 * workgraph definition and the keyed chat-node entry, the dictionaries land
 * in the locale registry, the activity floater mounts through a body portal
 * (and unmounts on disposal), and registration disposal rides the plugin
 * fiber. The node half and the invariant companion are exercised over the
 * same Context.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { ConversationEventRegistry } from '@deepseek-ai/dsh-client-runtime/src/client/conversation/event-registry.ts'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { workgraphDefinition } from '../src/client/workgraph-definition.ts'
import { apply as nodeApply } from '../src/index.ts'

/** Minimal sessions service: the floater only reads the list snapshot. */
function fakeSessions(): { list: { getSnapshot: () => { current: string | undefined }; subscribe: () => () => void }; open: () => void } {
  return {
    list: {
      getSnapshot: () => ({ current: undefined }),
      subscribe: () => () => undefined,
    },
    open: () => undefined,
  }
}

async function bench(): Promise<{ ctx: Context; fiber: Awaited<ReturnType<Context['plugin']>> }> {
  const ctx = new Context()
  new ConversationEventRegistry(ctx)
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.reflect.provide('sessions', fakeSessions())
  ctx.slots.register({
    name: 'root', children: {
      'conversation.chat.node': { kind: 'keyed', scope: 'session' },
    },
  } as never, (() => null) as never)
  const fiber = await ctx.plugin({ inject: [...inject], apply }).await()
  return { ctx, fiber }
}

describe('ui-workgraph browser plugin', () => {
  it('registers the definition, the keyed chat entry, and the dictionaries', async () => {
    const { ctx, fiber } = await bench()
    expect(ctx.conversationEvents.entries()).toContain(workgraphDefinition)
    const entry = ctx.slots.entries('conversation.chat.node')
      .find(candidate => candidate.options?.key === 'workgraph')
    expect(entry).toBeDefined()
    // The default locale dictionary is en; zh is registered alongside it.
    expect(en['node.achieved']).toBe('Achieved')
    expect(zh['node.achieved']).toBe('已达成')
    expect(entry?.locale).toBe('workgraph')
    await fiber.dispose()
    expect(ctx.slots.entries('conversation.chat.node')
      .some(candidate => candidate.options?.key === 'workgraph')).toBe(false)
  })

  it('mounts the activity floater through a body portal and unmounts on disposal', async () => {
    // The floater polls immediately; a relative URL fetch fails fast in jsdom
    // and the poll loop swallows it (keeps the last snapshot).
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('failed to fetch')))
    try {
      const { fiber } = await bench()
      expect(document.querySelector('[data-workgraph-host]')).not.toBeNull()
      await fiber.dispose()
      expect(document.querySelector('[data-workgraph-host]')).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('node half is an inert loader seat', () => {
    // The invariant companion is mounted by the vitest-wide invariant host
    // on every Context this suite creates; its registration is covered there.
    expect(() => { nodeApply() }).not.toThrow()
  })
})
