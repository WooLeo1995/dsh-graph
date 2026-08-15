/** Browser plugin for the durable work-graph Conversation Node. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { WorkGraphNode } from './WorkGraphNode.tsx'
import { en, NS, type WorkGraphKey, zh } from './locales.ts'
import { workgraphDefinition } from './workgraph-definition.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Durable work-graph node copy. */
    workgraph: WorkGraphKey
  }
}

/** Required services for Definition, keyed renderer, and copy. */
export const inject = ['conversationEvents', 'slots', 'locale']

/** Register the workgraph Definition, dictionary, and keyed Chat renderer. */
export function apply(ctx: ClientContext): void {
  ctx.conversationEvents.register(workgraphDefinition)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-workgraph: dictionaries')
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'workgraph',
    locale: NS,
  }, WorkGraphNode))
}
