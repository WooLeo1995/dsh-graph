/** Browser plugin for the durable work-graph Conversation Node and the
 * live activity floater. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { createRoot } from 'react-dom/client'
import { createElement } from 'react'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Module-loading import: the card registers into the conversation chat-node
// slot, whose keyed renderer map lives in the ui-conversation contract.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ActivityPanel } from './ActivityPanel.tsx'
import { WorkGraphNode } from './WorkGraphNode.tsx'
import { en, NS, type WorkGraphKey, zh } from './locales.ts'
import { workgraphDefinition } from './workgraph-definition.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Durable work-graph node copy. */
    workgraph: WorkGraphKey
  }
}

/** Required services: Definition, keyed renderer, dictionaries, and the
 * sessions list (the activity panel's per-session filter). */
export const inject = ['conversationEvents', 'slots', 'locale', 'sessions']

/**
 * Register the workgraph Definition, dictionary, keyed Chat renderer, and
 * mount the top-right activity floater through a body portal (the web shell
 * has no top-right slot). The floater polls the host snapshot route and
 * shows only the current session's graph; it is the live content channel,
 * decoupled from the event-folded conversation card (the durable anchor).
 */
export function apply(ctx: ClientContext): void {
  const host = document.createElement('div')
  host.dataset.workgraphHost = ''
  document.body.appendChild(host)
  const root = createRoot(host)
  // This entry file is `.ts` (the client bundle entry convention), so the
  // portal render uses createElement instead of JSX.
  root.render(createElement(ActivityPanel, { sessionsList: ctx.sessions.list, t: ctx.locale.bind(NS) }))
  ctx.effect(() => () => {
    root.unmount()
    host.remove()
  }, 'ui-workgraph: activity panel')

  ctx.conversationEvents.register(workgraphDefinition)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-workgraph: dictionaries')
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'workgraph',
    locale: NS,
  }, WorkGraphNode))
}
