// @vitest-environment jsdom
// ActivityPanel behavior: the top-right floater — 1s polling of the host
// snapshot route with an inFlight guard, the collapsed badge (auto-expand
// after the settle window, auto-close after the grace), per-session graph
// filtering, the compact dependency DAG (debounced hover / keyboard focus /
// click pin / Esc clear, SVG edge routing, fallback detail row), the
// progress overview (segments, legend, one-line summary), card-summoned
// historic summaries, and portal lifecycle.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  ActivityPanel, OPEN_WORKGRAPH_PANEL_EVENT,
  type WorkGraphPanelNode, type WorkGraphPanelOpenDetail, type WorkGraphPanelSnapshot,
} from '../src/client/ActivityPanel.tsx'
import { zh } from '../src/client/locales.ts'
// Importing the client entry also merges its LocaleNamespaceMap augmentation.
import type {} from '../src/client/index.ts'

const t = makeTranslate(zh, commonZh)

const STATE_URL = '/plugins/dsh-workgraph/state'

/** Minimal session-list store: the panel only reads `.current`. */
function makeStore(current: string | undefined) {
  let state = { current } as unknown as SessionListState
  const listeners = new Set<() => void>()
  return {
    list: {
      subscribe: (fn: () => void): (() => void) => {
        listeners.add(fn)
        return () => { listeners.delete(fn) }
      },
      getSnapshot: (): SessionListState => state,
    },
    setCurrent(next: string | undefined): void {
      state = { ...state, current: next as SessionId | undefined }
      for (const listener of [...listeners]) listener()
    },
  }
}

/** Factory overrides: `blocks` accepted as plain ids (branded at the cast). */
type PanelNodeOver = Partial<Omit<WorkGraphPanelNode, 'id' | 'blocks'>> & { readonly blocks?: readonly string[] }

function panelNode(id: string, over: PanelNodeOver = {}): WorkGraphPanelNode {
  return {
    id,
    title: `title ${id}`,
    state: 'ready',
    blocks: [],
    depth: 0,
    rounds: 0,
    final: false,
    ...over,
  } as WorkGraphPanelNode
}

function graph(sessionId: string, over: Partial<WorkGraphPanelSnapshot> = {}): WorkGraphPanelSnapshot {
  return {
    sessionId,
    graphId: `g-${sessionId}`,
    objective: `objective ${sessionId}`,
    status: 'active',
    planVersion: 1,
    nodes: [],
    tokensSpent: 0,
    pendingDiscoveries: 0,
    ...over,
  } as WorkGraphPanelSnapshot
}

function okResponse(graphs: readonly WorkGraphPanelSnapshot[]): Response {
  return { ok: true, json: async () => ({ graphs }) } as Response
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  cleanup()
})

/** Flush the poll microtask (initial tick + resolved fetch) under act. */
async function flush(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
}

describe('polling and the collapsed badge', () => {
  it('polls the host route and renders the collapsed badge for the current session', async () => {
    const store = makeStore('s1')
    fetchMock.mockResolvedValue(okResponse([graph('s1', { nodes: [panelNode('gn-a')] })]))
    render(<ActivityPanel sessionsList={store.list} t={t} />)
    await flush()
    expect(fetchMock).toHaveBeenCalledWith(STATE_URL, { cache: 'no-store' })
    // Data present at load: badge only, no panel yank.
    expect(screen.getByLabelText('Workgraph 活动，1 个图')).toBeTruthy()
    expect(document.querySelector('[data-workgraph-activity]')).toBeNull()
  })

  it('shows nothing before a session is picked or when no graph exists', async () => {
    const noSession = makeStore(undefined)
    fetchMock.mockResolvedValue(okResponse([graph('s1')]))
    const { container } = render(<ActivityPanel sessionsList={noSession.list} t={t} />)
    await flush()
    expect(container.firstChild).toBeNull()

    const other = makeStore('s2')
    fetchMock.mockResolvedValue(okResponse([]))
    const { container: otherContainer } = render(<ActivityPanel sessionsList={other.list} t={t} />)
    await flush()
    expect(otherContainer.firstChild).toBeNull()
  })

  it('filters graphs to the current session only', async () => {
    const store = makeStore('s1')
    fetchMock.mockResolvedValue(okResponse([graph('s1'), graph('s2')]))
    render(<ActivityPanel sessionsList={store.list} t={t} />)
    await flush()
    // The badge counts only the current session's graph (s2 is filtered out).
    fireEvent.click(screen.getByLabelText('Workgraph 活动，1 个图'))
    expect(screen.getByText('objective s1')).toBeTruthy()
    expect(screen.queryByText('objective s2')).toBeNull()
  })

  it('tolerates failed polls while a graph is live and keeps the last snapshot', async () => {
    const store = makeStore('s1')
    fetchMock
      .mockResolvedValueOnce(okResponse([graph('s1')]))
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ graphs: 'nope' }) })
      .mockRejectedValueOnce(new Error('host down'))
      .mockResolvedValue(okResponse([graph('s1')]))
    render(<ActivityPanel sessionsList={store.list} t={t} />)
    await flush()
    expect(screen.getByLabelText('Workgraph 活动，1 个图')).toBeTruthy()
    // Ticks 2-4 tolerate non-ok / malformed / rejected responses; the last
    // good snapshot is kept and the badge stays.
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(screen.getByLabelText('Workgraph 活动，1 个图')).toBeTruthy()
  })

  it('pauses the poll loop while the current session has no graph', async () => {
    const store = makeStore('s1')
    fetchMock.mockResolvedValue(okResponse([]))
    render(<ActivityPanel sessionsList={store.list} t={t} />)
    await flush()
    // The mount discovery poll ran once; a graph-less session then stops.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(screen.queryByLabelText(/Workgraph 活动/)).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('resumes polling when a later session owns a graph', async () => {
    const store = makeStore('s1')
    fetchMock
      .mockResolvedValueOnce(okResponse([]))
      .mockResolvedValue(okResponse([graph('s2')]))
    render(<ActivityPanel sessionsList={store.list} t={t} />)
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Switching to the session that owns a graph wakes the loop...
    act(() => { store.setCurrent('s2') })
    await flush()
    expect(screen.getByLabelText('Workgraph 活动，1 个图')).toBeTruthy()
    // ...and the interval keeps it alive.
    const callsBefore = fetchMock.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore)
  })

  it('guards against overlapping polls while a fetch is in flight', async () => {
    const store = makeStore('s1')
    let resolve!: (value: Response) => void
    fetchMock
      .mockResolvedValueOnce(okResponse([graph('s1')]))
      .mockReturnValueOnce(new Promise<Response>((res) => { resolve = res }))
    render(<ActivityPanel sessionsList={store.list} t={t} />)
    await flush()
    // The graph keeps polling active; the second (wake) fetch is still in
    // flight when the interval tick fires, so the in-flight guard skips it.
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await act(async () => { resolve(okResponse([graph('s1')])) })
    await flush()
    expect(screen.getByLabelText('Workgraph 活动，1 个图')).toBeTruthy()
  })

  it('drops a late fetch result after unmount', async () => {
    const store = makeStore('s1')
    let resolve!: (value: Response) => void
    fetchMock.mockReturnValueOnce(new Promise<Response>((res) => { resolve = res }))
    const { unmount } = render(<ActivityPanel sessionsList={store.list} t={t} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    unmount()
    await act(async () => { resolve(okResponse([graph('s1')])) })
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('expand and collapse', () => {
  it('auto-expands when a graph appears after the settle window (woken by a session switch)', async () => {
    const store = makeStore('s1')
    fetchMock
      .mockResolvedValueOnce(okResponse([]))
      .mockResolvedValue(okResponse([graph('s2', { nodes: [panelNode('gn-a', { state: 'running' })] })]))
    render(<ActivityPanel sessionsList={store.list} t={t} />)
    await flush()
    expect(document.querySelector('[data-workgraph-activity]')).toBeNull()
    // The graph-less session stays quiet through the settle window (its poll
    // loop is paused, so no further fetches fire).
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    expect(screen.queryByLabelText(/Workgraph 活动/)).toBeNull()
    // Switching to the session that owns the graph wakes the loop; the settle
    // window has elapsed, so the fresh graph auto-expands (busy dot: running).
    act(() => { store.setCurrent('s2') })
    await flush()
    expect(document.querySelector('[data-workgraph-activity]')).toBeTruthy()
    expect(document.querySelector('[data-busy="true"]')).toBeTruthy()
  })

  it('opens on badge click and closes on the close button', async () => {
    const store = makeStore('s1')
    fetchMock.mockResolvedValue(okResponse([graph('s1', { nodes: [panelNode('gn-a')] })]))
    render(<ActivityPanel sessionsList={store.list} t={t} />)
    await flush()
    fireEvent.click(screen.getByLabelText('Workgraph 活动，1 个图'))
    expect(screen.getByText('Workgraph 活动')).toBeTruthy()
    expect(document.documentElement.hasAttribute('data-workgraph-panel-open')).toBe(true)
    fireEvent.click(screen.getByLabelText('关闭'))
    expect(screen.queryByText('Workgraph 活动')).toBeNull()
    expect(document.documentElement.hasAttribute('data-workgraph-panel-open')).toBe(false)
    // Badge returns: the graph is still live.
    expect(screen.getByLabelText('Workgraph 活动，1 个图')).toBeTruthy()
  })

  it('auto-closes after the grace when the graph disappears', async () => {
    const store = makeStore('s1')
    fetchMock.mockResolvedValue(okResponse([graph('s1')]))
    render(<ActivityPanel sessionsList={store.list} t={t} />)
    await flush()
    fireEvent.click(screen.getByLabelText('Workgraph 活动，1 个图'))
    expect(document.querySelector('[data-workgraph-activity]')).toBeTruthy()
    // The graph disappears at the next poll; the open panel shows the empty
    // state (and the poll loop pauses for the graph-less session).
    fetchMock.mockResolvedValue(okResponse([]))
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(screen.getByText('暂无图活动')).toBeTruthy()
    // After the 2s grace the floater collapses entirely.
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(document.querySelector('[data-workgraph-activity]')).toBeNull()
    expect(document.documentElement.hasAttribute('data-workgraph-panel-open')).toBe(false)
  })

  it('resets the panel when the current session changes', async () => {
    const store = makeStore('s1')
    fetchMock.mockResolvedValue(okResponse([graph('s1')]))
    render(<ActivityPanel sessionsList={store.list} t={t} />)
    await flush()
    fireEvent.click(screen.getByLabelText('Workgraph 活动，1 个图'))
    expect(screen.getByText('Workgraph 活动')).toBeTruthy()
    act(() => { store.setCurrent('s2') })
    expect(screen.queryByText('Workgraph 活动')).toBeNull()
    expect(document.documentElement.hasAttribute('data-workgraph-panel-open')).toBe(false)
  })
})

describe('card-summoned panel', () => {
  it('opens from the window event and shows the historic summary', async () => {
    const store = makeStore('s1')
    fetchMock.mockResolvedValue(okResponse([]))
    render(<ActivityPanel sessionsList={store.list} t={t} />)
    await flush()
    const detail: WorkGraphPanelOpenDetail = {
      graphId: 'g-historic', sessionId: 's1' as SessionId, objective: 'old run', status: 'complete',
    }
    act(() => {
      window.dispatchEvent(new CustomEvent(OPEN_WORKGRAPH_PANEL_EVENT, { detail }))
    })
    expect(screen.getByText('Workgraph 活动')).toBeTruthy()
    expect(screen.getByText('old run')).toBeTruthy()
    expect(screen.getByText('已清除')).toBeTruthy()
    expect(screen.getByText('已完成')).toBeTruthy()
  })

  it('opens without a historic entry when the detail lacks a graphId', async () => {
    const store = makeStore('s1')
    fetchMock.mockResolvedValue(okResponse([]))
    render(<ActivityPanel sessionsList={store.list} t={t} />)
    await flush()
    act(() => {
      window.dispatchEvent(new CustomEvent(OPEN_WORKGRAPH_PANEL_EVENT, { detail: { sessionId: 's1' } }))
    })
    expect(screen.getByText('暂无图活动')).toBeTruthy()
  })

  it('ignores the event before a session is picked', async () => {
    const store = makeStore(undefined)
    fetchMock.mockResolvedValue(okResponse([]))
    const { container } = render(<ActivityPanel sessionsList={store.list} t={t} />)
    await flush()
    act(() => {
      window.dispatchEvent(new CustomEvent(OPEN_WORKGRAPH_PANEL_EVENT, {
        detail: { graphId: 'g', sessionId: 's1' as SessionId, objective: 'x', status: 'active' },
      }))
    })
    expect(container.firstChild).toBeNull()
  })

  it('hides a historic entry once the graph is live again', async () => {
    const store = makeStore('s1')
    fetchMock.mockResolvedValue(okResponse([graph('s1', { nodes: [panelNode('gn-a')] })]))
    render(<ActivityPanel sessionsList={store.list} t={t} />)
    await flush()
    act(() => {
      window.dispatchEvent(new CustomEvent(OPEN_WORKGRAPH_PANEL_EVENT, {
        detail: { graphId: 'g-s1', sessionId: 's1' as SessionId, objective: 'objective s1', status: 'active' },
      }))
    })
    expect(screen.queryByText('已清除')).toBeNull()
  })
})

describe('the compact dependency map', () => {
  // Two independent chains so cross-chain edges exist: root→mid→leaf and
  // root2→side. gn-mid is running (glyph), gn-leaf achieved.
  const dag = (): WorkGraphPanelSnapshot => graph('s1', {
    nodes: [
      panelNode('gn-root', { depth: 0 }),
      panelNode('gn-mid', { depth: 1, blocks: ['gn-root'], state: 'running' }),
      panelNode('gn-leaf', { depth: 2, blocks: ['gn-mid'], state: 'achieved', rounds: 3 }),
      panelNode('gn-other', { depth: 0 }),
      panelNode('gn-root2', { depth: 0 }),
      panelNode('gn-side', { depth: 1, blocks: ['gn-root2'] }),
    ],
  })

  async function openPanel(): Promise<void> {
    const store = makeStore('s1')
    fetchMock.mockResolvedValue(okResponse([dag()]))
    render(<ActivityPanel sessionsList={store.list} t={t} />)
    await flush()
    fireEvent.click(screen.getByLabelText('Workgraph 活动，1 个图'))
  }

  it('renders the compact DAG canvas with absolutely positioned node buttons', async () => {
    await openPanel()
    const map = document.querySelector('[data-dependency-map]')!
    const nodes = map.querySelectorAll('[data-node-id]')
    expect(nodes.length).toBe(6)
    // 92x30 node at its depth-column / id-row position.
    const mid = map.querySelector('[data-node-id="gn-mid"]') as HTMLElement
    expect(mid.style.left).toBe('118px')
    expect(mid.style.top).toBe('0px')
    expect(mid.style.width).toBe('92px')
    expect(mid.style.height).toBe('30px')
    // The node card shows the compacted title, not the stage labels.
    expect(mid.textContent).toContain('title gn-mid')
    expect(screen.queryByText('起点')).toBeNull()
    expect(screen.queryByText('依赖层 1')).toBeNull()
  })

  it('routes one SVG cubic edge path per real block reference', async () => {
    await openPanel()
    const paths = [...document.querySelectorAll('[data-dag-edges] path')]
    expect(paths.length).toBe(3)
    expect(paths.map(path => path.getAttribute('d'))).toEqual([
      'M92 53C106 53,104 15,118 15',
      'M92 91C106 91,104 53,118 53',
      'M210 15C224 15,222 15,236 15',
    ])
    // No focus yet: edges are neither active nor dimmed.
    for (const path of paths) {
      expect(path.getAttribute('data-active')).toBe('false')
      expect(path.getAttribute('data-dimmed')).toBe('false')
    }
  })

  it('highlights the chain after the 180ms hover debounce and dims the rest', async () => {
    await openPanel()
    const mid = document.querySelector('[data-node-id="gn-mid"]')!
    const root = document.querySelector('[data-node-id="gn-root"]')!
    const other = document.querySelector('[data-node-id="gn-other"]')!
    // Debounce: nothing highlights until the timer fires.
    fireEvent.mouseEnter(mid)
    expect(mid.getAttribute('data-focused')).toBe('false')
    expect(other.getAttribute('data-dimmed')).toBe('false')
    await act(async () => { await vi.advanceTimersByTimeAsync(180) })
    expect(mid.getAttribute('data-focused')).toBe('true')
    expect(root.getAttribute('data-focused')).toBe('true')
    expect(other.getAttribute('data-dimmed')).toBe('true')
    // Chain edges go active; the cross-chain edge is dimmed, not active.
    const paths = [...document.querySelectorAll('[data-dag-edges] path')]
    expect(paths[0]!.getAttribute('data-active')).toBe('true')
    expect(paths[1]!.getAttribute('data-active')).toBe('false')
    expect(paths[1]!.getAttribute('data-dimmed')).toBe('true')
    expect(paths[2]!.getAttribute('data-active')).toBe('true')
    // Leaving clears the highlight immediately (no clear debounce).
    fireEvent.mouseLeave(mid)
    expect(mid.getAttribute('data-focused')).toBe('false')
    expect(other.getAttribute('data-dimmed')).toBe('false')
  })

  it('cancels a pending hover when the pointer moves between nodes quickly', async () => {
    await openPanel()
    const mid = document.querySelector('[data-node-id="gn-mid"]')!
    const side = document.querySelector('[data-node-id="gn-side"]')!
    fireEvent.mouseEnter(mid)
    // Moving on before the debounce fires cancels the first node's timer.
    fireEvent.mouseEnter(side)
    await act(async () => { await vi.advanceTimersByTimeAsync(180) })
    expect(side.getAttribute('data-focused')).toBe('true')
    expect(mid.getAttribute('data-focused')).toBe('false')
    // Leaving before the next timer fires cancels the highlight entirely.
    fireEvent.mouseEnter(side)
    fireEvent.mouseLeave(side)
    expect(side.getAttribute('data-focused')).toBe('false')
  })

  it('unpins when the pinned node is clicked again', async () => {
    await openPanel()
    const mid = document.querySelector('[data-node-id="gn-mid"]')!
    fireEvent.click(mid)
    expect(mid.getAttribute('aria-pressed')).toBe('true')
    // Clicking the same node toggles the pin off; nothing stays focused.
    fireEvent.click(mid)
    expect(mid.getAttribute('aria-pressed')).toBe('false')
    expect(mid.getAttribute('data-focused')).toBe('false')
  })

  it('clears a pending hover timer on unmount', async () => {
    const store = makeStore('s1')
    fetchMock.mockResolvedValue(okResponse([dag()]))
    const { unmount } = render(<ActivityPanel sessionsList={store.list} t={t} />)
    await flush()
    fireEvent.click(screen.getByLabelText('Workgraph 活动，1 个图'))
    const mid = document.querySelector('[data-node-id="gn-mid"]')!
    fireEvent.mouseEnter(mid)
    unmount()
  })

  it('pins the chain on click, unpins on re-click or Escape', async () => {
    await openPanel()
    const mid = document.querySelector('[data-node-id="gn-mid"]')!
    fireEvent.click(mid)
    expect(mid.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('gn-mid 已固定 · Esc 取消')).toBeTruthy()
    // Pinning keeps the chain highlighted after the pointer leaves.
    fireEvent.mouseLeave(mid)
    expect(mid.getAttribute('data-focused')).toBe('true')
    // A non-Escape key leaves the pin alone (keydown false path).
    fireEvent.keyDown(window, { key: 'a' })
    expect(mid.getAttribute('aria-pressed')).toBe('true')
    // Re-clicking the pinned node unpins it (onPin null path).
    fireEvent.click(mid)
    expect(mid.getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByText('悬停高亮依赖链 · 点击固定')).toBeTruthy()
    // Re-pin, then Escape clears the pin.
    fireEvent.click(mid)
    expect(mid.getAttribute('aria-pressed')).toBe('true')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(mid.getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByText('悬停高亮依赖链 · 点击固定')).toBeTruthy()
  })

  it('highlights the keyboard-focused chain immediately and beats a later hover', async () => {
    await openPanel()
    const root = document.querySelector('[data-node-id="gn-root"]')!
    const other = document.querySelector('[data-node-id="gn-other"]')!
    fireEvent.focus(root)
    expect(root.getAttribute('data-focused')).toBe('true')
    expect(other.getAttribute('data-dimmed')).toBe('true')
    fireEvent.blur(root)
    expect(other.getAttribute('data-dimmed')).toBe('false')
    // A hover that resolves later loses to the keyboard focus.
    fireEvent.mouseEnter(root)
    fireEvent.focus(other)
    await act(async () => { await vi.advanceTimersByTimeAsync(180) })
    expect(other.getAttribute('data-focused')).toBe('true')
    expect(root.getAttribute('data-focused')).toBe('false')
  })

  it('renders the running glyph inside running nodes only', async () => {
    await openPanel()
    const mid = document.querySelector('[data-node-id="gn-mid"]')!
    const root = document.querySelector('[data-node-id="gn-root"]')!
    expect(mid.querySelector('svg')).toBeTruthy()
    expect(root.querySelector('svg')).toBeNull()
  })

  it('falls back to the most interesting node for the detail row (blocked first)', async () => {
    const snapshot = graph('s1', {
      nodes: [
        panelNode('gn-a', { depth: 0, state: 'ready' }),
        panelNode('gn-b', { depth: 1, blocks: ['gn-a'], state: 'running' }),
        panelNode('gn-c', { depth: 2, blocks: ['gn-b'], state: 'blocked' }),
      ],
    })
    const store = makeStore('s1')
    fetchMock.mockResolvedValue(okResponse([snapshot]))
    render(<ActivityPanel sessionsList={store.list} t={t} />)
    await flush()
    fireEvent.click(screen.getByLabelText('Workgraph 活动，1 个图'))
    // No focus: blocked wins over running.
    expect(document.querySelector('[data-task-detail="gn-c"]')).toBeTruthy()
    // Blocked node waits on its unachieved dependency.
    expect(screen.getByText('等待 gn-b')).toBeTruthy()
  })

  it('falls back to the running node, then the first node', async () => {
    const runningOnly = graph('s1', {
      nodes: [
        panelNode('gn-a', { depth: 0, state: 'ready' }),
        panelNode('gn-b', { depth: 1, blocks: ['gn-a'], state: 'running' }),
      ],
    })
    const store = makeStore('s1')
    fetchMock.mockResolvedValue(okResponse([runningOnly]))
    render(<ActivityPanel sessionsList={store.list} t={t} />)
    await flush()
    fireEvent.click(screen.getByLabelText('Workgraph 活动，1 个图'))
    expect(document.querySelector('[data-task-detail="gn-b"]')).toBeTruthy()
  })

  it('falls back to the first node when nothing is interesting', async () => {
    const quiet = graph('s1', { nodes: [panelNode('gn-a'), panelNode('gn-b')] })
    const store = makeStore('s1')
    fetchMock.mockResolvedValue(okResponse([quiet]))
    render(<ActivityPanel sessionsList={store.list} t={t} />)
    await flush()
    fireEvent.click(screen.getByLabelText('Workgraph 活动，1 个图'))
    expect(document.querySelector('[data-task-detail="gn-a"]')).toBeTruthy()
    expect(screen.getByText('无前置可开工')).toBeTruthy()
  })

  it('shows waiting/failure/ready detail lines and the unlocks meta', async () => {
    const snapshot = graph('s1', {
      nodes: [
        panelNode('gn-a', { depth: 0, state: 'achieved', rounds: 2 }),
        panelNode('gn-other', { depth: 0, state: 'ready' }),
        panelNode('gn-f', { depth: 1, blocks: ['gn-a'], state: 'failed', failure: 'boom' }),
        panelNode('gn-b', { depth: 1, blocks: ['gn-other'], state: 'blocked' }),
        panelNode('gn-final', { depth: 2, blocks: ['gn-b'], final: true }),
      ],
    })
    const store = makeStore('s1')
    fetchMock.mockResolvedValue(okResponse([snapshot]))
    render(<ActivityPanel sessionsList={store.list} t={t} />)
    await flush()
    fireEvent.click(screen.getByLabelText('Workgraph 活动，1 个图'))
    const finalNode = document.querySelector('[data-node-id="gn-final"]')!
    expect(finalNode.getAttribute('data-final')).toBe('true')
    // No focus: the failed node (first interesting) with its failure reason.
    expect(screen.getByText('已失败：boom')).toBeTruthy()
    // Focus the achieved node: done line, unlocks its dependents.
    fireEvent.focus(document.querySelector('[data-node-id="gn-a"]')!)
    expect(screen.getByText('已完成')).toBeTruthy()
    expect(screen.getByText('完成后解锁 gn-f')).toBeTruthy()
    // Focus the blocked node: waits on the unachieved dependency, unlocks the final node.
    fireEvent.focus(document.querySelector('[data-node-id="gn-b"]')!)
    expect(screen.getByText('等待 gn-other')).toBeTruthy()
    expect(screen.getByText('完成后解锁 gn-final')).toBeTruthy()
  })

  it('shows ready-with-dependencies and no-downstream detail lines', async () => {
    const snapshot = graph('s1', {
      nodes: [
        panelNode('gn-a', { depth: 0, state: 'achieved' }),
        panelNode('gn-b', { depth: 1, blocks: ['gn-a'], state: 'ready' }),
        panelNode('gn-c', { depth: 0, state: 'failed' }),
      ],
    })
    const store = makeStore('s1')
    fetchMock.mockResolvedValue(okResponse([snapshot]))
    render(<ActivityPanel sessionsList={store.list} t={t} />)
    await flush()
    fireEvent.click(screen.getByLabelText('Workgraph 活动，1 个图'))
    // Ready node whose only dependency is achieved: dependencies ready.
    fireEvent.focus(document.querySelector('[data-node-id="gn-b"]')!)
    expect(screen.getByText('前置已就绪')).toBeTruthy()
    // Failed node without a failure reason: plain failed, no dependents.
    fireEvent.focus(document.querySelector('[data-node-id="gn-c"]')!)
    expect(screen.getByText('已失败')).toBeTruthy()
    expect(screen.getByText('无下游节点')).toBeTruthy()
  })

  it('falls back to the first node when the focused node disappears', async () => {
    const store = makeStore('s1')
    fetchMock
      // The mount poll and the badge-click refresh both see both nodes; only
      // the interval tick after the pin drops gn-a.
      .mockResolvedValueOnce(okResponse([graph('s1', { nodes: [panelNode('gn-a'), panelNode('gn-b')] })]))
      .mockResolvedValueOnce(okResponse([graph('s1', { nodes: [panelNode('gn-a'), panelNode('gn-b')] })]))
      .mockResolvedValue(okResponse([graph('s1', { nodes: [panelNode('gn-b')] })]))
    render(<ActivityPanel sessionsList={store.list} t={t} />)
    await flush()
    fireEvent.click(screen.getByLabelText('Workgraph 活动，1 个图'))
    const a = document.querySelector('[data-node-id="gn-a"]')!
    fireEvent.click(a)
    expect(document.querySelector('[data-task-detail="gn-a"]')).toBeTruthy()
    // The next poll drops gn-a; the stale pin id falls back to the first node.
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(document.querySelector('[data-task-detail="gn-b"]')).toBeTruthy()
  })

  it('renders a fill-width parallel grid when the graph has no dependency edges', async () => {
    const snapshot = graph('s1', { nodes: [panelNode('gn-a'), panelNode('gn-b')] })
    const store = makeStore('s1')
    fetchMock.mockResolvedValue(okResponse([snapshot]))
    render(<ActivityPanel sessionsList={store.list} t={t} />)
    await flush()
    fireEvent.click(screen.getByLabelText('Workgraph 活动，1 个图'))
    expect(document.querySelector('[data-parallel-grid]')).toBeTruthy()
    expect(document.querySelector('[data-dag-edges]')).toBeNull()
    expect(document.querySelectorAll('[data-parallel-grid] [data-node-id]').length).toBe(2)
    // Pinning works in the grid layout too: clicking the same node toggles off.
    const a = document.querySelector('[data-parallel-grid] [data-node-id="gn-a"]')!
    fireEvent.click(a)
    expect(a.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(a)
    expect(a.getAttribute('aria-pressed')).toBe('false')
  })

  it('renders the graph header bits (budget, discoveries, pause reason)', async () => {
    const snapshot = graph('s1', {
      status: 'user_paused',
      tokenBudget: 100,
      tokensSpent: 7,
      pendingDiscoveries: 2,
      pauseReason: 'restored',
      nodes: [panelNode('gn-a')],
    })
    const store = makeStore('s1')
    fetchMock.mockResolvedValue(okResponse([snapshot]))
    render(<ActivityPanel sessionsList={store.list} t={t} />)
    await flush()
    fireEvent.click(screen.getByLabelText('Workgraph 活动，1 个图'))
    expect(screen.getByText(/计划 v1/)).toBeTruthy()
    expect(screen.getByText(/已用 7 \| 预算 100/)).toBeTruthy()
    expect(screen.getByText(/2 条待重规划发现/)).toBeTruthy()
    expect(screen.getByText('已暂停：restored')).toBeTruthy()
    expect(screen.getByText('用户已暂停')).toBeTruthy()
  })

  it('omits the budget segment when unlimited and hides the dependency map for an empty graph', async () => {
    const snapshot = graph('s1', { nodes: [] })
    const store = makeStore('s1')
    fetchMock.mockResolvedValue(okResponse([snapshot]))
    render(<ActivityPanel sessionsList={store.list} t={t} />)
    await flush()
    fireEvent.click(screen.getByLabelText('Workgraph 活动，1 个图'))
    expect(screen.getByText(/已用 0$/)).toBeTruthy()
    expect(document.querySelector('[data-dependency-map]')).toBeNull()
    expect(screen.getByText('等待规划/调度')).toBeTruthy()
    expect(document.querySelector('[data-progress-empty]')).toBeTruthy()
  })
})

describe('progress overview', () => {
  async function openSnapshot(nodes: readonly WorkGraphPanelNode[]): Promise<void> {
    const store = makeStore('s1')
    fetchMock.mockResolvedValue(okResponse([graph('s1', { nodes })]))
    render(<ActivityPanel sessionsList={store.list} t={t} />)
    await flush()
    fireEvent.click(screen.getByLabelText('Workgraph 活动，1 个图'))
  }

  it('renders one tone segment per node and the legend counts', async () => {
    await openSnapshot([
      panelNode('gn-a', { state: 'achieved' }),
      panelNode('gn-b', { state: 'running' }),
      panelNode('gn-c', { state: 'blocked' }),
      panelNode('gn-d', { state: 'failed' }),
      panelNode('gn-e', { state: 'ready' }),
      panelNode('gn-f', { state: 'waiting' }),
    ])
    const segments = [...document.querySelectorAll('[data-progress-segments] > span')]
    expect(segments.length).toBe(6)
    expect(segments.map(segment => segment.getAttribute('data-state'))).toEqual([
      'completed', 'running', 'blocked', 'failed', 'pending', 'pending',
    ])
    expect(screen.getByText('运行中 1')).toBeTruthy()
    expect(screen.getByText('等待依赖 1')).toBeTruthy()
    expect(screen.getByText('已达成 1')).toBeTruthy()
    // Blocked (incl. failed) nodes coexist with running work: the
    // blocked+running summary wins and keeps the warning tone.
    const line = screen.getByText('gn-c、gn-d 等待前置，其余已开工')
    expect(line.closest('span[data-state]')!.getAttribute('data-state')).toBe('warning')
  })

  it('summarizes an all-achieved graph with the completed tone', async () => {
    await openSnapshot([
      panelNode('gn-a', { state: 'achieved' }),
      panelNode('gn-b', { state: 'achieved' }),
    ])
    expect(screen.getByText('全部 2 项已达成')).toBeTruthy()
    const line = screen.getByText('全部 2 项已达成')
    expect(line.closest('span[data-state]')!.getAttribute('data-state')).toBe('completed')
  })

  it('summarizes running work with the achieved count', async () => {
    await openSnapshot([
      panelNode('gn-root', { state: 'ready' }),
      panelNode('gn-mid', { state: 'running' }),
      panelNode('gn-leaf', { state: 'achieved' }),
    ])
    expect(screen.getByText('gn-mid 正在执行，1/3 已达成')).toBeTruthy()
    const line = screen.getByText('gn-mid 正在执行，1/3 已达成')
    expect(line.closest('span[data-state]')!.getAttribute('data-state')).toBe('running')
  })

  it('summarizes blocked-plus-running work', async () => {
    await openSnapshot([
      panelNode('gn-a', { state: 'running' }),
      panelNode('gn-b', { state: 'blocked' }),
      panelNode('gn-c', { state: 'blocked' }),
    ])
    expect(screen.getByText('gn-b、gn-c 等待前置，其余已开工')).toBeTruthy()
  })

  it('summarizes a blocked-only graph without running or ready work', async () => {
    await openSnapshot([
      panelNode('gn-a', { state: 'achieved' }),
      panelNode('gn-b', { state: 'blocked' }),
    ])
    const line = screen.getByText('gn-b 等待前置')
    expect(line.closest('span[data-state]')!.getAttribute('data-state')).toBe('warning')
  })

  it('summarizes ready nodes and caps the id list at three', async () => {
    await openSnapshot([
      panelNode('gn-a', { state: 'ready' }),
      panelNode('gn-b', { state: 'waiting' }),
      panelNode('gn-c', { state: 'ready' }),
      panelNode('gn-d', { state: 'ready' }),
    ])
    // compactIds appends "等 4 项" and the locale joins with a space.
    expect(screen.getByText('gn-a、gn-b、gn-c 等 4 项 已就绪待开工')).toBeTruthy()
  })
})
