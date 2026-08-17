/**
 * Workgraph activity panel: the top-right floater monitoring the current
 * session's work graph.
 *
 * Pattern-ported from the AgentTeams activity panel
 * (dsh-agent-teams/src/client/ActivityPanel.tsx, MIT — author 程序员阿江 /
 * Relakkes) and adapted to the work-graph domain: instead of polling a
 * durable team snapshot it polls the host `/plugins/dsh-workgraph/state`
 * route for the scheduler's in-memory graph snapshot (whole-value, one graph
 * per session). The dependency map follows the AgentTeams 8/17 rebuild
 * (commits c5eb6ed, 00857a1, 1327d03): a compact DAG of 92x30 nodes with
 * SVG cubic edge routing, 180ms-debounced hover highlighting, keyboard
 * focus, click pin, Esc clear, and a fallback detail row; a segmented
 * progress overview with a one-line summary sits above it.
 *
 * The floater mounts through a body portal (the web shell has no top-right
 * slot) and is the *live content* channel; the conversation card remains the
 * durable *anchor* (event fold) — the two are decoupled, exactly like the
 * AgentTeams panel/card split. On wide viewports the panel cooperatively
 * makes the conversation column yield space; narrow viewports keep overlay
 * mode.
 * @module @deepseek-ai/dsh-client-ui-workgraph/activity
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import {
  IconBranchOutline16, IconCloseOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  activityPanelExpandedForSession, compactDagLayout, compactNodeLabel, dependencyFocusNodeId,
  relatedNodeIds, usesParallelGrid, COMPACT_DAG_NODE_HEIGHT, COMPACT_DAG_NODE_WIDTH,
} from './activity-model.ts'
import type { WorkGraphKey } from './locales.ts'
import type { WorkGraphNodeState, WorkGraphStatus } from './workgraph-definition.ts'
// The panel snapshot vocabulary is the host-assembled projection (t7): the
// client consumes it read-only across the JSON route. Type-only import — no
// runtime identity is pulled into the browser bundle.
import type { WorkGraphPanelNode, WorkGraphPanelSnapshot } from '@deepseek-ai/dsh-workgraph'
import css from './ActivityPanel.module.css'

/** Poll cadence for the host snapshot route. */
const POLL_MS = 1000
/** Hover debounce before a node's dependency chain is highlighted. */
const HOVER_DELAY_MS = 180
/** Grace before the panel collapses once no graph remains. */
const AUTOCLOSE_GRACE_MS = 2000
/**
 * Page-settle window after mount: activity restored on page load only shows
 * the collapsed badge, so the panel never yanks the conversation column
 * right after load. New activity after this window auto-expands as usual.
 */
const AUTO_OPEN_SETTLE_MS = 4000
/** Host route serving the scheduler's graph snapshot. */
const STATE_URL = '/plugins/dsh-workgraph/state'
/** Root marker shared with the panel CSS while the portal is expanded. */
const PANEL_OPEN_ATTRIBUTE = 'data-workgraph-panel-open'
/**
 * Window event name the floater listens for to open itself. The conversation
 * card dispatches it (recovery path after the floater was closed, or when an
 * old session is re-opened for review).
 */
export const OPEN_WORKGRAPH_PANEL_EVENT = 'workgraph:open-panel'

// The host-assembled snapshot vocabulary (t7, @deepseek-ai/dsh-workgraph):
// re-exported so consumers (tests, the t9 card) import one source of truth.
export type { WorkGraphPanelNode, WorkGraphPanelSnapshot } from '@deepseek-ai/dsh-workgraph'

/** Detail payload carried by the open-panel window event (card → panel). */
export interface WorkGraphPanelOpenDetail {
  readonly graphId: string
  readonly sessionId: SessionId
  readonly objective: string
  readonly status: WorkGraphStatus
}

/** Complete panel props: the sessions list store plus the namespace-bound translator. */
export interface ActivityPanelProps {
  readonly sessionsList: ObservableSnapshot<SessionListState>
  readonly t: TranslateNS<'workgraph'>
}

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

/** Segment/glyph tone per node state (five visual keys; ready and waiting
 * share the muted "pending" tone). */
function progressTone(state: WorkGraphNodeState): 'completed' | 'running' | 'failed' | 'blocked' | 'pending' {
  switch (state) {
    case 'achieved': return 'completed'
    case 'running': return 'running'
    case 'failed': return 'failed'
    case 'blocked': return 'blocked'
    case 'ready':
    case 'waiting': return 'pending'
    /* v8 ignore next -- WorkGraphNodeState is closed and every variant is handled above. */
    default: return state satisfies never
  }
}

/** The node's blocks that do not resolve to achieved nodes. */
function waitingOn(node: WorkGraphPanelNode, nodes: readonly WorkGraphPanelNode[]): string[] {
  const byId = new Map(nodes.map(candidate => [candidate.id, candidate]))
  return node.blocks.filter((block) => {
    const dependency = byId.get(block)
    return dependency === undefined || dependency.state !== 'achieved'
  })
}

/** Compact id list for a summary sentence: at most three ids, then "等 N 项". */
function compactIds(nodes: readonly WorkGraphPanelNode[]): string {
  const shown = nodes.slice(0, 3).map(node => node.id).join('、')
  return nodes.length > 3 ? `${shown} 等 ${nodes.length} 项` : shown
}

/** One-line progress summary in workgraph semantics, following the upstream
 * taskSummary hierarchy: blocked+running > running > ready > blocked. */
function nodeSummary(nodes: readonly WorkGraphPanelNode[], t: TranslateNS<'workgraph'>): string {
  const completed = nodes.filter(node => node.state === 'achieved')
  const running = nodes.filter(node => node.state === 'running')
  const blocked = nodes.filter(node => node.state === 'blocked' || node.state === 'failed')
  const ready = nodes.filter(node => node.state === 'ready' || node.state === 'waiting')
  if (nodes.length === 0) return t('summary.empty')
  if (completed.length === nodes.length) return t('summary.allDone', { count: completed.length })
  if (blocked.length > 0 && running.length > 0) return t('summary.blockedRunning', { ids: compactIds(blocked) })
  if (running.length > 0) return t('summary.running', { ids: compactIds(running), done: completed.length, total: nodes.length })
  if (ready.length > 0) return t('summary.ready', { ids: compactIds(ready) })
  // Unconditional by exhaustion: every WorkGraphNodeState lands in one of the
  // buckets above, so the nodes left here (not achieved, not running, not
  // ready/waiting) are exactly the blocked-or-failed ones.
  return t('summary.blocked', { ids: compactIds(blocked) })
}

/** Animated dot grid shown while a node is running. */
function WorkGlyph({ active }: { readonly active: boolean }) {
  return (
    <svg className={css.workGlyph} data-active={active} width="11" height="11" viewBox="0 0 11 11" fill="currentColor" aria-hidden>
      {[[0, 0], [4.2, 0], [8.4, 0], [0, 4.2], [4.2, 4.2], [8.4, 4.2]].map(([x, y], index) => (
        <rect key={`${x}:${y}`} x={x} y={y} width="2.6" height="2.6" rx=".6" style={{ animationDelay: `${index * 0.15}s` }} />
      ))}
    </svg>
  )
}

/** Collapsed badge: an always-visible corner pill while any graph exists. */
function CollapsedBadge({ count, busy, onClick, t }: {
  readonly count: number
  readonly busy: boolean
  readonly onClick: () => void
  readonly t: TranslateNS<'workgraph'>
}) {
  return (
    <button type="button" className={css.badge} data-busy={busy} onClick={onClick} aria-label={t('panel.badgeAria', { count })}>
      <span className={css.badgeDot} data-busy={busy} aria-hidden />
      <span className={css.badgeCount}>{count}</span>
    </button>
  )
}

/** One compact DAG node button: id row with state dot + running glyph, and
 * the compacted title. Position is inline so both the absolute DAG canvas
 * and the fill-width parallel grid can reuse the same card. */
function CompactNode({ node, focused, dimmed, pinned, style, onPin, onHover, onKeyboard }: {
  readonly node: WorkGraphPanelNode
  readonly focused: boolean
  readonly dimmed: boolean
  readonly pinned: boolean
  readonly style?: CSSProperties
  readonly onPin: (id: string) => void
  readonly onHover: (id: string | null) => void
  readonly onKeyboard: (id: string | null) => void
}) {
  return (
    <button
      type="button"
      className={css.dagNode}
      style={style}
      data-node-id={node.id}
      data-state={node.state}
      data-final={node.final || undefined}
      data-focused={focused}
      data-dimmed={dimmed}
      aria-pressed={pinned}
      title={`${node.id} · ${node.title}`}
      onClick={() => { onPin(node.id) }}
      onMouseEnter={() => { onHover(node.id) }}
      onMouseLeave={() => { onHover(null) }}
      onFocus={() => { onKeyboard(node.id) }}
      onBlur={() => { onKeyboard(null) }}
    >
      <span className={css.dagNodeHead}>
        <span className={css.dagNodeDot} data-state={node.state} aria-hidden />
        <span className={css.dagNodeId}>{node.id}</span>
        {node.state === 'running' && <WorkGlyph active />}
      </span>
      <span className={css.dagNodeLabel}>{compactNodeLabel(node.title)}</span>
    </button>
  )
}

/** Status sentence for the detail row, driven by the node's own state and
 * which of its blocks are still unachieved. */
function detailStatusLine(node: WorkGraphPanelNode, waiting: readonly string[], t: TranslateNS<'workgraph'>): string {
  if (node.state === 'achieved') return t('detail.completed')
  if (node.state === 'failed') {
    return node.failure === undefined ? t('detail.failed') : t('detail.failedWith', { failure: node.failure })
  }
  if (node.blocks.length === 0) return t('detail.noDeps')
  if (waiting.length === 0) return t('detail.ready')
  return t('node.waitingOn', { deps: waiting.join('、') })
}

/** The compact dependency map: a depth-column DAG with SVG edge routing,
 * 180ms-debounced hover preview, keyboard focus, click pin (Esc clears), and
 * a fallback detail row for the most interesting node. Empty graphs render
 * nothing; dependency-free graphs fall back to a fill-width node grid. */
function DependencyMap({ nodes, t }: {
  readonly nodes: readonly WorkGraphPanelNode[]
  readonly t: TranslateNS<'workgraph'>
}) {
  const [hoverNodeId, setHoverNodeId] = useState<string | null>(null)
  const [keyboardNodeId, setKeyboardNodeId] = useState<string | null>(null)
  const [pinnedNodeId, setPinnedNodeId] = useState<string | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const focusedNodeId = dependencyFocusNodeId(pinnedNodeId, keyboardNodeId, hoverNodeId)
  const layout = useMemo(() => compactDagLayout(nodes), [nodes])
  const parallel = useMemo(() => usesParallelGrid(nodes), [nodes])
  const related = useMemo(
    () => focusedNodeId === null ? null : relatedNodeIds(focusedNodeId, nodes),
    [focusedNodeId, nodes],
  )
  // Delayed pointer intent: a quick pass-over must not steal the highlighted
  // chain from a pinned or keyboard-focused node, and an older hover timer
  // is cancelled when the pointer moves on.
  const scheduleHover = (id: string | null): void => {
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
    if (id === null) {
      setHoverNodeId(null)
      return
    }
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null
      setHoverNodeId(id)
    }, HOVER_DELAY_MS)
  }
  // Clear a pending hover timer on unmount.
  useEffect(() => () => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current)
  }, [])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPinnedNodeId(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [])
  const first = nodes[0]
  if (first === undefined) return null
  // The detail row falls back to the most interesting node when nothing is
  // focused: blocked/failed first, then running, then the first node.
  const fallbackNode = nodes.find(node => node.state === 'blocked' || node.state === 'failed')
    ?? nodes.find(node => node.state === 'running')
    ?? first
  const detailNode = (focusedNodeId === null
    ? undefined
    : nodes.find(node => node.id === focusedNodeId)) ?? fallbackNode
  const waiting = waitingOn(detailNode, nodes)
  const dependents = nodes.filter(node => node.blocks.includes(detailNode.id))
  return (
    <section className={css.dependencySection} aria-label={t('panel.deps')} data-dependency-map>
      <header className={css.sectionHead}>
        <span className={css.sectionTitle}><IconBranchOutline16 /> {t('panel.deps')}</span>
        <span className={css.sectionHint}>{pinnedNodeId === null ? t('panel.hint') : t('panel.pinned', { id: pinnedNodeId })}</span>
      </header>
      {parallel ? (
        <div className={css.dagParallelGrid} data-parallel-grid>
          {layout.nodes.map(({ node }) => (
            <CompactNode
              key={node.id}
              node={node}
              focused={related?.has(node.id) ?? false}
              dimmed={related !== null && !related.has(node.id)}
              pinned={pinnedNodeId === node.id}
              style={{ width: COMPACT_DAG_NODE_WIDTH, height: COMPACT_DAG_NODE_HEIGHT }}
              onPin={(id) => { setPinnedNodeId(current => current === id ? null : id) }}
              onHover={scheduleHover}
              onKeyboard={setKeyboardNodeId}
            />
          ))}
        </div>
      ) : (
        <div className={css.dagViewport}>
          <div className={css.dagCanvas} style={{ width: layout.width, height: layout.height }}>
            <svg className={css.dagEdges} data-dag-edges width={layout.width} height={layout.height} aria-hidden>
              {layout.edges.map((edge) => {
                const active = related !== null && related.has(edge.from) && related.has(edge.to)
                return <path key={`${edge.from}:${edge.to}`} d={edge.path} data-active={active} data-dimmed={related !== null && !active} />
              })}
            </svg>
            {layout.nodes.map(({ node, x, y }) => (
              <CompactNode
                key={node.id}
                node={node}
                focused={related?.has(node.id) ?? false}
                dimmed={related !== null && !related.has(node.id)}
                pinned={pinnedNodeId === node.id}
                style={{ left: x, top: y, width: COMPACT_DAG_NODE_WIDTH, height: COMPACT_DAG_NODE_HEIGHT }}
                onPin={(id) => { setPinnedNodeId(current => current === id ? null : id) }}
                onHover={scheduleHover}
                onKeyboard={setKeyboardNodeId}
              />
            ))}
          </div>
        </div>
      )}
      <section className={css.taskDetail} data-task-detail={detailNode.id}>
        <span className={css.taskDetailHead}>
          <span className={css.taskDetailId}>{detailNode.id}</span>
          <span className={css.taskDetailSubject} title={detailNode.title}>{detailNode.title}</span>
          <span className={css.taskDetailBadge} data-state={detailNode.state}>{t(NODE_KEYS[detailNode.state])}</span>
        </span>
        <span className={css.taskDetailLine}>{detailStatusLine(detailNode, waiting, t)}</span>
        <span className={css.taskDetailMeta}>
          {dependents.length === 0 ? t('detail.noDependents') : t('detail.dependents', { ids: dependents.map(node => node.id).join('、') })}
        </span>
      </section>
    </section>
  )
}

/** Segmented progress bar with legend counts and a one-line summary. */
function ProgressOverview({ nodes, t }: {
  readonly nodes: readonly WorkGraphPanelNode[]
  readonly t: TranslateNS<'workgraph'>
}) {
  const running = nodes.filter(node => node.state === 'running').length
  const blocked = nodes.filter(node => node.state === 'blocked').length
  const completed = nodes.filter(node => node.state === 'achieved').length
  const summaryTone = blocked > 0 ? 'warning' : completed === nodes.length && nodes.length > 0 ? 'completed' : 'running'
  return (
    <section className={css.progressOverview} aria-label={t('progress.title')} data-progress-summary>
      <span className={css.progressTitle}>{t('progress.title')}</span>
      {nodes.length > 0 ? (
        <span className={css.progressSegments} data-progress-segments aria-hidden>
          {nodes.map(node => <span key={node.id} data-state={progressTone(node.state)} />)}
        </span>
      ) : <span className={css.progressEmpty} data-progress-empty />}
      <span className={css.progressLegend}>
        <span data-state="running">{t('progress.legendRunning', { count: running })}</span>
        <span data-state="blocked">{t('progress.legendBlocked', { count: blocked })}</span>
        <span data-state="completed">{t('progress.legendCompleted', { count: completed })}</span>
      </span>
      <span className={css.progressSummary} data-state={summaryTone}>
        <span className={css.progressSummaryDot} aria-hidden />
        <span data-progress-line>{nodeSummary(nodes, t)}</span>
      </span>
    </section>
  )
}

/** One live graph section: header (objective, status, plan/spend, pause) +
 * progress overview + the compact dependency DAG. */
function GraphSection({ graph, t }: {
  readonly graph: WorkGraphPanelSnapshot
  readonly t: TranslateNS<'workgraph'>
}) {
  const headerBits = [
    t('header.plan', { version: graph.planVersion }),
    graph.tokenBudget === undefined
      ? t('header.spend', { spent: graph.tokensSpent })
      : `${t('header.spend', { spent: graph.tokensSpent })} | ${t('header.budget', { budget: graph.tokenBudget })}`,
  ]
  if (graph.pendingDiscoveries > 0) {
    headerBits.push(t('header.discoveries', { count: graph.pendingDiscoveries }))
  }
  return (
    <section className={css.graph} data-graph-id={graph.graphId}>
      <header className={css.graphHead}>
        <span className={css.objective} title={graph.objective}>{graph.objective}</span>
        <span className={css.status} data-status={graph.status}>{t(STATUS_KEYS[graph.status])}</span>
        <span className={css.meta}>{headerBits.join(' · ')}</span>
        {graph.pauseReason !== undefined && (
          <span className={css.pause} data-status={graph.status}>{t('header.paused', { reason: graph.pauseReason })}</span>
        )}
      </header>
      <ProgressOverview nodes={graph.nodes} t={t} />
      <DependencyMap nodes={graph.nodes} t={t} />
    </section>
  )
}

/** A card-summoned graph summary shown when the graph is no longer live. */
function HistoricSection({ detail, t }: {
  readonly detail: WorkGraphPanelOpenDetail
  readonly t: TranslateNS<'workgraph'>
}) {
  return (
    <section className={css.graph} data-graph-id={detail.graphId} data-historic>
      <header className={css.graphHead}>
        <span className={css.objective} title={detail.objective}>{detail.objective}</span>
        <span className={css.historicPill}>{t('panel.historic')}</span>
        <span className={css.status} data-status={detail.status}>{t(STATUS_KEYS[detail.status])}</span>
      </header>
    </section>
  )
}

/** The top-right activity floater. The graph follows the current session:
 * live snapshots and card-summoned summaries are only shown while their
 * owning session is the one currently open. */
export function ActivityPanel({ sessionsList, t }: ActivityPanelProps) {
  const [graphs, setGraphs] = useState<readonly WorkGraphPanelSnapshot[]>([])
  const [open, setOpen] = useState(false)
  const [openOwner, setOpenOwner] = useState<SessionId | undefined>()
  const [autoOpened, setAutoOpened] = useState(false)
  const [wasActive, setWasActive] = useState(false)
  const [historic, setHistoric] = useState<ReadonlyMap<string, WorkGraphPanelOpenDetail>>(new Map())
  // Bumped by a panel summon so a paused poll loop refetches (the graph may
  // have been set since the last poll).
  const [pollEpoch, setPollEpoch] = useState(0)
  const current = useSyncExternalStore(
    (listener: () => void) => sessionsList.subscribe(listener),
    () => sessionsList.getSnapshot(),
  ).current
  const currentRef = useRef(current)
  useEffect(() => { currentRef.current = current }, [current])
  const mountedAtRef = useRef(performance.now())
  const expanded = activityPanelExpandedForSession(open, openOwner, current)
  // Whether the last poll found a graph owned by the current session. This
  // gates the steady-state interval: a graph-less session stops spinning the
  // 1s poll loop entirely instead of idling forever.
  const sessionHasGraph = current !== undefined && graphs.some(graph => graph.sessionId === current)

  // This portal survives conversation route changes. Gate expansion by its
  // owning session during render, then clear stale state before paint. This
  // removes the old panel immediately instead of waiting for the no-graph
  // autoclose grace period on the destination page.
  useLayoutEffect(() => {
    if (openOwner === undefined || openOwner === current) return
    setOpen(false)
    setOpenOwner(undefined)
    setWasActive(false)
    setAutoOpened(false)
  }, [current, openOwner])

  // The activity panel is a body portal, so announce its open state on body.
  // CSS can then make the conversation column yield space without knowing the
  // host shell's hashed module class names. Narrow viewports keep overlay mode.
  useLayoutEffect(() => {
    const root = document.documentElement
    if (expanded) root.setAttribute(PANEL_OPEN_ATTRIBUTE, '')
    else root.removeAttribute(PANEL_OPEN_ATTRIBUTE)
    return () => { root.removeAttribute(PANEL_OPEN_ATTRIBUTE) }
  }, [expanded])

  // The poll loop: one discovery poll on every restart (mount, session
  // change, panel summon), and the 1s interval only while the current
  // session owns a graph. A graph-less session pauses the loop; the next
  // session change or card summon wakes it (a graph may be set anytime), so
  // polling is paused, never killed.
  useEffect(() => {
    let cancelled = false
    let inFlight = false
    const tick = async (): Promise<void> => {
      if (inFlight || cancelled) return
      inFlight = true
      try {
        const response = await fetch(STATE_URL, { cache: 'no-store' })
        if (response.ok) {
          const body = (await response.json()) as { graphs?: unknown }
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- cancelled flips true in the cleanup after an awaited fetch
          if (!cancelled && Array.isArray(body.graphs)) {
            setGraphs(body.graphs as readonly WorkGraphPanelSnapshot[])
          }
        }
      } catch {
        // Host restarting; keep the last snapshot.
      } finally {
        inFlight = false
      }
    }
    void tick()
    if (!sessionHasGraph) {
      // Paused: the discovery poll above already ran; no interval.
      return () => { cancelled = true }
    }
    const timer = setInterval(() => { void tick() }, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [sessionHasGraph, pollEpoch, current])

  useEffect(() => {
    const onOpenPanel = (event: Event): void => {
      const activeSession = currentRef.current
      if (activeSession === undefined) return
      setOpenOwner(activeSession)
      setOpen(true)
      // Wake the poll loop: a summon while the session was paused must fetch
      // fresh data (the graph may have been set since the last poll).
      setPollEpoch(epoch => epoch + 1)
      // The card may dispatch without a full detail (or at all); the guards
      // below are runtime-defensive despite the event's typed payload.
      const detail = (event as CustomEvent<WorkGraphPanelOpenDetail | undefined>).detail
      if (detail?.graphId !== undefined) {
        // A card from a log that predates the live snapshot belongs to the
        // session that activated it (the current one at injection time).
        const key = `${detail.sessionId}:${detail.graphId}`
        setHistoric((previous) => {
          const next = new Map(previous)
          next.set(key, detail)
          return next
        })
      }
    }
    window.addEventListener(OPEN_WORKGRAPH_PANEL_EVENT, onOpenPanel)
    return () => {
      window.removeEventListener(OPEN_WORKGRAPH_PANEL_EVENT, onOpenPanel)
    }
  }, [])

  // Graphs follow the current session: live snapshots and card-summoned
  // summaries are visible only while their owning session is current.
  const visibleGraphs = useMemo(
    // No current session (initial load): show nothing until one is picked,
    // so cross-session graphs never leak into the floater.
    () => (current === undefined ? [] : graphs.filter(graph => graph.sessionId === current)),
    [graphs, current],
  )
  const visibleHistoric = useMemo(
    () => (current === undefined ? [] : [...historic.values()].filter(detail =>
      detail.sessionId === current && !graphs.some(graph =>
        graph.sessionId === current && graph.graphId === detail.graphId,
      ),
    )),
    [historic, current, graphs],
  )
  const visibleCount = visibleGraphs.length + visibleHistoric.length

  useEffect(() => {
    if (visibleCount > 0) {
      setWasActive(true)
      // Auto-expand only after the page-settle window: opening (and its
      // main-column yield) right after load reads as a whole-page flicker.
      const settled = performance.now() - mountedAtRef.current >= AUTO_OPEN_SETTLE_MS
      if (!autoOpened && settled) {
        setOpenOwner(current)
        setOpen(true)
        setAutoOpened(true)
      }
      return
    }
    if (!wasActive) return
    const timer = setTimeout(() => {
      setOpen(false)
      setOpenOwner(undefined)
      setWasActive(false)
      // Re-arm auto-expand: a later graph (new set, new session) may open
      // the panel on its own again.
      setAutoOpened(false)
    }, AUTOCLOSE_GRACE_MS)
    return () => { clearTimeout(timer) }
  }, [visibleCount, autoOpened, wasActive])

  const busy = useMemo(
    () => visibleGraphs.some(graph => graph.nodes.some(node => node.state === 'running')),
    [visibleGraphs],
  )
  const hasGraphs = visibleCount > 0

  if (!hasGraphs && !expanded) return null

  return (
    <>
      {!expanded && (
        <CollapsedBadge count={visibleCount} busy={busy} onClick={() => {
          /* v8 ignore next 2 -- the badge only renders while hasGraphs, which requires a current session */
          if (current === undefined) return
          setOpenOwner(current)
          setOpen(true)
        }} t={t} />
      )}
      {expanded && (
        <aside className={css.panel} data-workgraph-activity>
          <header className={css.panelHead}>
            <span className={css.panelTitle}>
              {t('panel.title')}
              <span className={css.panelDot} data-busy={busy} aria-hidden />
            </span>
            <button
              type="button"
              className={css.closeButton}
              onClick={() => {
                setOpen(false)
                setOpenOwner(undefined)
              }}
              aria-label={t('panel.close')}
            >
              <IconCloseOutline16 />
            </button>
          </header>
          <div className={css.graphs}>
            {visibleCount === 0
              ? <span className={css.emptyHint}>{t('panel.empty')}</span>
              : (
                <>
                  {visibleGraphs.map(graph => (
                    <GraphSection key={graph.graphId} graph={graph} t={t} />
                  ))}
                  {visibleHistoric.map(detail => (
                    <HistoricSection key={`${detail.sessionId}:${detail.graphId}`} detail={detail} t={t} />
                  ))}
                </>
              )}
          </div>
        </aside>
      )}
    </>
  )
}
