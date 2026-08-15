/**
 * WorkGraphNode: the keyed chat renderer for one work graph. The layered
 * DAG (state-colored node cards, dependency edges, the budget line, the
 * pause reason) is a pure render of the projected chat data; selecting a
 * node opens its detail (objective, spec, rounds, failure, discovery
 * origin). The final node is visually distinct; blocked chains carry their
 * failure origin on the card.
 */

import { useMemo, useState } from 'react'
import { StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  WorkGraphNodeData, WorkGraphNodeState, WorkGraphStatus,
} from './workgraph-definition.ts'
import type { WorkGraphKey } from './locales.ts'
import css from './WorkGraphNode.module.css'

/** Complete keyed Chat renderer props: the conversation node plus copy. */
export type WorkGraphPanelProps =
  PropsRuntime<'conversation.chat.node', 'workgraph'>
  & PropsLocale<'workgraph'>

const STATUS_KEYS = {
  active: 'status.active',
  user_paused: 'status.user_paused',
  infra_paused: 'status.infra_paused',
  blocked: 'status.blocked',
  budget_limited: 'status.budget_limited',
  complete: 'status.complete',
} as const satisfies Record<WorkGraphStatus, WorkGraphKey>

const NODE_KEYS = {
  waiting: 'node.waiting',
  ready: 'node.ready',
  running: 'node.running',
  achieved: 'node.achieved',
  failed: 'node.failed',
  blocked: 'node.blocked',
} as const satisfies Record<WorkGraphNodeState, WorkGraphKey>

/** The ledger dot state per node state (StateDot carries four variants). */
function dotState(state: WorkGraphNodeState): StateDotState {
  switch (state) {
    case 'achieved': return 'done'
    case 'running':
    case 'ready': return 'ongoing'
    case 'failed': return 'error'
    case 'blocked':
    case 'waiting': return 'warning'
    /* v8 ignore next -- WorkGraphNodeState is closed and every variant is handled above. */
    default: return state satisfies never
  }
}

/** StateDot only carries done/ongoing/error/warning; waiting/ready share idle. */

/** Whether the node's blocks all resolve to achieved nodes. */
function waitingOn(node: WorkGraphNodeData, byId: Map<string, WorkGraphNodeData>): string[] {
  return node.blocks.filter((block) => {
    const dep = byId.get(block)
    return dep === undefined || dep.state !== 'achieved'
  })
}

export function WorkGraphNode({ node, t }: WorkGraphPanelProps) {
  const data = node.data
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const byId = useMemo(
    () => new Map(data.layers.flat().map(node => [node.id, node])),
    [data.layers],
  )
  const selected = selectedId === null ? undefined : byId.get(selectedId)
  const statusLabel = t(STATUS_KEYS[data.status])
  const headerBits = [
    `Plan v${data.planVersion}`,
    data.tokenBudget === undefined
      ? t('header.spend', { spent: data.tokensSpent })
      : `${t('header.spend', { spent: data.tokensSpent })} | ${t('header.budget', { budget: data.tokenBudget })}`,
  ]
  if (data.pendingDiscoveries > 0) {
    headerBits.push(t('header.discoveries', { count: data.pendingDiscoveries }))
  }
  return (
    <section className={css.card} aria-label={data.objective}>
      <header className={css.header}>
        <span className={css.objective}>{data.objective}</span>
        <span className={css.status} data-status={data.status}>{statusLabel}</span>
        <span className={css.meta}>{headerBits.join(' · ')}</span>
        {data.pauseReason !== undefined && (
          <span className={css.pause} data-status={data.status}>
            {t('header.paused', { reason: data.pauseReason })}
          </span>
        )}
      </header>
      <div className={css.dag}>
        {data.layers.map((layer, index) => (
          <div className={css.layer} key={index}>
            {layer.map((node) => {
              const waiting = waitingOn(node, byId)
              const label = node.final ? t('node.final') : node.title
              return (
                <button
                  type="button"
                  key={node.id}
                  className={css.node}
                  data-state={node.state}
                  data-final={node.final || undefined}
                  data-selected={node.id === selectedId || undefined}
                  aria-label={t('node.aria', { title: label, state: t(NODE_KEYS[node.state]) })}
                  onClick={() => setSelectedId(node.id === selectedId ? null : node.id)}
                >
                  <span className={css.nodeLine}>
                    <StateDot state={dotState(node.state)} />
                    <span className={css.nodeTitle}>{label}</span>
                    {node.state === 'achieved' && (
                      <span className={css.nodeMeta}>{t('node.rounds', { rounds: node.rounds })}</span>
                    )}
                  </span>
                  {waiting.length > 0 && (
                    <span className={css.nodeWaiting}>
                      {t('node.waitingOn', { deps: waiting.join(', ') })}
                    </span>
                  )}
                  {node.failure !== undefined && (
                    <span className={css.nodeFailure}>{t('node.failure', { failure: node.failure })}</span>
                  )}
                </button>
              )
            })}
          </div>
        ))}
      </div>
      <footer className={css.legend}>
        {(['achieved', 'running', 'ready', 'waiting', 'failed', 'blocked'] as const).map(state => (
          <span className={css.legendItem} key={state}>
            <StateDot state={dotState(state)} />
            {t(`legend.${state}`)}
          </span>
        ))}
      </footer>
      {selected !== undefined && (
        <aside className={css.detail}>
          <header className={css.detailHeader}>
            <span>{t('detail.title')}</span>
            <button type="button" className={css.close} onClick={() => setSelectedId(null)}>
              {t('detail.close')}
            </button>
          </header>
          <dl className={css.detailBody}>
            <dt>{t('detail.objective')}</dt>
            <dd>{selected.title}</dd>
            <dt>{t('detail.spec')}</dt>
            <dd>{selected.spec}</dd>
            <dt>{t('detail.rounds')}</dt>
            <dd>{selected.rounds}</dd>
            <dt>{t('detail.blocks')}</dt>
            <dd>{selected.blocks.length === 0 ? t('detail.none') : selected.blocks.join(', ')}</dd>
            {selected.discoveredFrom !== undefined && (
              <>
                <dt>{t('detail.discoveredFrom')}</dt>
                <dd>{selected.discoveredFrom.join(', ')}</dd>
              </>
            )}
            {selected.failure !== undefined && (
              <>
                <dt>{t('node.failure')}</dt>
                <dd>{selected.failure}</dd>
              </>
            )}
          </dl>
        </aside>
      )}
    </section>
  )
}
