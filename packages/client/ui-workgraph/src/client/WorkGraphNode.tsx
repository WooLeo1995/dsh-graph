/**
 * WorkGraphNode: the keyed chat renderer for one work graph. The layered
 * DAG (state-colored node cards, dependency edges, the budget line, the
 * pause reason, the running-node glyph) is a pure render of the projected
 * chat data; selecting a node pins its dependency-chain highlight and opens
 * its detail (objective, spec, rounds, failure, discovery origin,
 * dependents — which nodes this one unlocks); hovering previews the chain
 * without opening the detail (Esc clears the pin). The header's activity
 * button dispatches {@link OPEN_WORKGRAPH_PANEL_EVENT} so the top-right
 * floater can reopen for this graph. Interaction pattern ported from the
 * AgentTeams activity panel's DependencyMap
 * (dsh-agent-teams/src/client/ActivityPanel.tsx, MIT — hover preview, click
 * pin, related-chain highlight, Esc clear); the card stays a read-only
 * projection — all interaction is component-local state, no session events.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { relatedNodeIds } from './activity-model.ts'
import {
  OPEN_WORKGRAPH_PANEL_EVENT, type WorkGraphPanelOpenDetail,
} from './ActivityPanel.tsx'
import type {
  WorkGraphNodeData, WorkGraphNodeState, WorkGraphStatus,
} from './workgraph-definition.ts'
import type { WorkGraphKey } from './locales.ts'
import css from './WorkGraphNode.module.css'

/** Complete keyed Chat renderer props: the conversation node plus copy. */
export type WorkGraphPanelProps =
  PropsRuntime<'conversation.chat.node', 'workgraph'>
  & PropsLocale<'workgraph'>

/** The floating card width when expanded over the conversation. */
const FLOAT_WIDTH = 460
/** Viewport margin kept around the floating card. */
const FLOAT_MARGIN = 12

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

/** The bar dot for the graph lifecycle status (four StateDot variants). */
function statusDot(status: WorkGraphStatus): StateDotState {
  switch (status) {
    case 'complete': return 'done'
    case 'active': return 'ongoing'
    case 'blocked':
    case 'budget_limited':
    case 'user_paused':
    case 'infra_paused': return 'warning'
    /* v8 ignore next -- WorkGraphStatus is closed and every variant is handled above. */
    default: return status satisfies never
  }
}

/** Whether the node's blocks all resolve to achieved nodes. */
function waitingOn(node: WorkGraphNodeData, byId: Map<string, WorkGraphNodeData>): string[] {
  return node.blocks.filter((block) => {
    const dep = byId.get(block)
    return dep === undefined || dep.state !== 'achieved'
  })
}

/** Ids of the nodes that block on the given node (its downstream dependents). */
function dependentIds(nodeId: string, byId: Map<string, WorkGraphNodeData>): string[] {
  const dependents: string[] = []
  for (const candidate of byId.values()) {
    if (candidate.blocks.includes(nodeId)) dependents.push(candidate.id)
  }
  return dependents
}

/** Whether the graph's nodes are all achieved (bar progress display). */
function achievedCount(data: WorkGraphChatData): number {
  return data.layers.flat().filter(row => row.state === 'achieved').length
}

/**
 * The running-work dot matrix: six squares pulsing in a staggered loop.
 * Ported from the AgentTeams activity panel's WorkGlyph
 * (dsh-agent-teams/src/client/ActivityPanel.tsx, MIT — commit 00857a1); the
 * animation lives in the module CSS so the card never paints it when idle.
 */
function WorkGlyph({ active }: { readonly active: boolean }) {
  return (
    <svg className={css.workGlyph} data-active={active} width="11" height="11" viewBox="0 0 11 11" fill="currentColor" aria-hidden>
      {[[0, 0], [4.2, 0], [8.4, 0], [0, 4.2], [4.2, 4.2], [8.4, 4.2]].map(([x, y], index) => (
        <rect key={`${x}:${y}`} x={x} y={y} width="2.6" height="2.6" rx=".6" style={{ animationDelay: `${index * 0.15}s` }} />
      ))}
    </svg>
  )
}

export function WorkGraphNode({ node, sessionId, t }: WorkGraphPanelProps) {
  const data = node.data
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  // The chat node defaults to a compact in-stream bar; expanding floats the
  // full DAG card over the conversation (the bar stays as its anchor).
  const [expanded, setExpanded] = useState(false)
  const [anchor, setAnchor] = useState<{ readonly x: number; readonly y: number } | null>(null)
  const barRef = useRef<HTMLButtonElement | null>(null)
  const byId = useMemo(
    () => new Map(data.layers.flat().map(node => [node.id, node])),
    [data.layers],
  )
  // The chat payload encodes depth implicitly as the layer index; the
  // relationship projections need explicit depth rows, so adapt the layers.
  const relationshipNodes = useMemo(
    () => data.layers.flatMap((layer, depth) => layer.map(row => ({
      id: row.id,
      blocks: row.blocks,
      depth,
    }))),
    [data.layers],
  )
  // The pinned (selected) node wins over the hover preview, exactly like the
  // activity panel's DependencyMap; both drive the same chain highlight.
  const focusedId = selectedId ?? hoveredId
  const related = useMemo(
    () => focusedId === null ? null : relatedNodeIds(focusedId, relationshipNodes),
    [focusedId, relationshipNodes],
  )
  const selected = selectedId === null ? undefined : byId.get(selectedId)
  // The downstream hint is a pure local projection of the layered data:
  // every node whose blocks reference the selected node (stable order).
  const dependents = selected === undefined ? [] : dependentIds(selected.id, byId)
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
  // Escape clears the pinned highlight (and the detail it drives); the
  // hover preview clears itself on pointer leave.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSelectedId(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [])

  /** Ask the activity floater to open for this graph (recovery path). */
  const openActivityPanel = (): void => {
    const detail: WorkGraphPanelOpenDetail = {
      graphId: node.id,
      sessionId,
      objective: data.objective,
      status: data.status,
    }
    window.dispatchEvent(new CustomEvent(OPEN_WORKGRAPH_PANEL_EVENT, { detail }))
  }

  /** Toggle the floating card, anchoring it to the in-stream bar. */
  const toggleExpanded = (): void => {
    setExpanded(current => {
      if (!current) {
        const rect = barRef.current?.getBoundingClientRect()
        setAnchor(rect === undefined ? null : {
          x: Math.min(rect.left, window.innerWidth - FLOAT_WIDTH - FLOAT_MARGIN),
          y: Math.max(FLOAT_MARGIN, rect.top),
        })
      }
      return !current
    })
  }

  const done = achievedCount(data)
  const total = data.layers.flat().length

  /** The full card body (header, DAG, legend, detail) shared by the float. */
  const renderCardBody = () => (
    <>
      <header className={css.header}>
        <span className={css.objective}>{data.objective}</span>
        <span className={css.status} data-status={data.status}>{statusLabel}</span>
        <span className={css.meta}>{headerBits.join(' · ')}</span>
        {data.pauseReason !== undefined && (
          <span className={css.pause} data-status={data.status}>
            {t('header.paused', { reason: data.pauseReason })}
          </span>
        )}
        <button type="button" className={css.openPanel} onClick={openActivityPanel}>
          {t('card.openPanel')}
        </button>
        <button type="button" className={css.openPanel} data-collapse onClick={toggleExpanded} aria-label={t('card.collapse')}>
          {t('card.collapse')}
        </button>
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
                  data-focused={related?.has(node.id) || undefined}
                  data-dimmed={related !== null && !related.has(node.id) || undefined}
                  aria-label={t('node.aria', { title: label, state: t(NODE_KEYS[node.state]) })}
                  onClick={() => { setSelectedId(node.id === selectedId ? null : node.id) }}
                  onMouseEnter={() => { setHoveredId(node.id) }}
                  onMouseLeave={() => { setHoveredId(null) }}
                  onFocus={() => { setHoveredId(node.id) }}
                  onBlur={() => { setHoveredId(null) }}
                >
                  <span className={css.nodeLine}>
                    <StateDot state={dotState(node.state)} />
                    <span className={css.nodeTitle}>{label}</span>
                    {node.state === 'running' && (
                      <span className={css.nodeRunning} data-running-glyph>
                        <WorkGlyph active />
                      </span>
                    )}
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
            <button type="button" className={css.close} onClick={() => { setSelectedId(null) }}>
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
          <p className={css.detailDependents}>
            {dependents.length === 0
              ? t('detail.noDependents')
              : t('detail.dependents', { ids: dependents.join(', ') })}
          </p>
        </aside>
      )}
    </>
  )

  return (
    <>
      {/* The compact in-stream anchor bar: status dot, objective, progress,
          expand chevron. It stays rendered while expanded so the chat node
          keeps its height and the floating card has a stable anchor. */}
      <button
        ref={barRef}
        type="button"
        className={css.bar}
        data-expanded={expanded || undefined}
        data-workgraph-bar
        aria-expanded={expanded}
        aria-label={t('card.barAria', { status: statusLabel, done, total })}
        onClick={toggleExpanded}
      >
        <StateDot state={statusDot(data.status)} />
        <span className={css.barObjective}>{data.objective}</span>
        <span className={css.barProgress}>{t('card.progress', { done, total })}</span>
        <svg className={css.chevron} data-open={expanded} width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
          <path d="M3.5 2l3 3-3 3" />
        </svg>
      </button>
      {expanded && anchor !== null && createPortal(
        <section
          className={`${css.card} ${css.float}`}
          data-workgraph-float
          aria-label={data.objective}
          style={{
            left: anchor.x,
            top: anchor.y,
            width: FLOAT_WIDTH,
            maxHeight: window.innerHeight - anchor.y - FLOAT_MARGIN,
          }}
        >
          {renderCardBody()}
        </section>,
        document.body,
      )}
    </>
  )
}
