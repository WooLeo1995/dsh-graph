// @vitest-environment jsdom
// WorkGraphNode behavior: the layered DAG card — state dots, the budget and
// pause lines, the waiting-on caption, blocked failure origins, the final
// node distinction, node selection detail (dependents unlock hint), the
// running glyph, and the legend — driven purely through props, no wire.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import {
  OPEN_WORKGRAPH_PANEL_EVENT, type WorkGraphPanelOpenDetail,
} from '../src/client/ActivityPanel.tsx'
import { WorkGraphNode } from '../src/client/WorkGraphNode.tsx'
import type { WorkGraphChatData, WorkGraphNodeData } from '../src/client/workgraph-definition.ts'
import { zh } from '../src/client/locales.ts'
// Importing the client entry also merges its LocaleNamespaceMap augmentation.
import type {} from '../src/client/index.ts'

// The framework-injected t seat, stubbed over the zh dictionaries (the default locale).
const t: Parameters<typeof WorkGraphNode>[0]['t'] = makeTranslate(zh, commonZh)

afterEach(cleanup)

const A = 'gn-aaaaaaaa'
const B = 'gn-bbbbbbbb'
const C = 'gn-cccccccc'
const FINAL = 'gn-final'

function node(id: string, title: string, state: WorkGraphNodeData['state'], blocks: string[], extra: Partial<WorkGraphNodeData> = {}): WorkGraphNodeData {
  return {
    id,
    title,
    spec: `spec of ${title}`,
    state,
    rounds: 0,
    blocks,
    ...extra,
  } as WorkGraphNodeData
}

/** The chat-node prop wrapper: the keyed renderer receives the view node. */
function nodeProp(
  data: WorkGraphChatData,
  over: { id?: string; sessionId?: string } = {},
): Parameters<typeof WorkGraphNode>[0] {
  return {
    node: { id: over.id ?? 'wg-1', data },
    ...(over.sessionId === undefined ? {} : { sessionId: over.sessionId }),
  } as Parameters<typeof WorkGraphNode>[0]
}

function data(over: Partial<WorkGraphChatData> = {}): WorkGraphChatData {
  return {
    objective: 'ship it',
    status: 'user_paused',
    planVersion: 1,
    layers: [
      [node(A, 'A', 'ready', [])],
      [node(B, 'B', 'waiting', [A])],
      [
        node(C, 'C', 'failed', [B], { failure: 'worker episode failed: boom', rounds: 2, discoveredFrom: [A] }),
        node(FINAL, 'Final verification', 'blocked', [B], { final: true, failure: `blocked: dependency chain failed at ${B}` }),
      ],
    ],
    tokensSpent: 7,
    tokenBudget: 10,
    pauseReason: 'restored',
    pendingDiscoveries: 1,
    ...over,
  }
}

describe('WorkGraphNode', () => {
  it('renders the layered DAG with the budget line, pause reason, and legend', () => {
    render(<WorkGraphNode {...nodeProp(data())} t={t} />)
    expect(screen.getByText('ship it')).toBeTruthy()
    expect(screen.getByText('已暂停：restored')).toBeTruthy()
    expect(screen.getByText(/Plan v1/)).toBeTruthy()
    expect(screen.getByText(/已用 7/)).toBeTruthy()
    expect(screen.getByText(/预算 10/)).toBeTruthy()
    expect(screen.getByText(/1 条待重规划发现/)).toBeTruthy()
    for (const label of ['已达成', '运行中', '就绪', '等待中', '失败', '受阻']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }
    // Four node cards (one per node across the three layer rows) plus the
    // header activity-panel button.
    expect(screen.getAllByRole('button')).toHaveLength(5)
  })

  it('marks the final node distinct and shows waiting-on captions', () => {
    render(<WorkGraphNode {...nodeProp(data())} t={t} />)
    const finalCard = screen.getByLabelText(/终节点/)
    expect(finalCard.getAttribute('data-final')).toBe('true')
    expect(screen.getByText(/等待 gn-aaaaaaaa/)).toBeTruthy()
  })

  it('shows the failure origin on failed and blocked cards', () => {
    render(<WorkGraphNode {...nodeProp(data())} t={t} />)
    expect(screen.getByText(/worker episode failed: boom/)).toBeTruthy()
    expect(screen.getByText(/dependency chain failed/)).toBeTruthy()
  })

  it('opens and closes the node detail on selection', () => {
    render(<WorkGraphNode {...nodeProp(data())} t={t} />)
    fireEvent.click(screen.getByLabelText(/C，失败/))
    expect(screen.getByText('节点详情')).toBeTruthy()
    expect(screen.getByText('spec of C')).toBeTruthy()
    expect(screen.getByText(/2/)).toBeTruthy()
    expect(screen.getByText('gn-aaaaaaaa')).toBeTruthy()
    fireEvent.click(screen.getByText('关闭详情'))
    expect(screen.queryByText('节点详情')).toBeNull()
  })

  it('toggles selection off when reselecting the same node', () => {
    render(<WorkGraphNode {...nodeProp(data())} t={t} />)
    const card = screen.getByLabelText(/A，就绪/)
    fireEvent.click(card)
    expect(screen.getByText('节点详情')).toBeTruthy()
    fireEvent.click(card)
    expect(screen.queryByText('节点详情')).toBeNull()
  })

  it('shows the achieved rounds badge and hides the discoveries line when empty', () => {
    render(<WorkGraphNode {...nodeProp(data({
      layers: [[node(A, 'A', 'achieved', [], { rounds: 3 })]],
      pendingDiscoveries: 0,
    }))} t={t} />)
    expect(screen.getByText(/3 轮/)).toBeTruthy()
    expect(screen.queryByText(/待重规划/)).toBeNull()
  })

  it('shows the dependents unlock hint in the node detail (with and without downstream nodes)', () => {
    render(<WorkGraphNode {...nodeProp(data())} t={t} />)
    // A unlocks its single dependent B.
    fireEvent.click(screen.getByLabelText(/A，就绪/))
    expect(screen.getByText('完成后解锁 gn-bbbbbbbb')).toBeTruthy()
    // B unlocks its two dependents C and the final node.
    fireEvent.click(screen.getByLabelText(/B，等待中/))
    expect(screen.getByText('完成后解锁 gn-cccccccc, gn-final')).toBeTruthy()
    // Nothing blocks on C: the no-dependents state.
    fireEvent.click(screen.getByLabelText(/C，失败/))
    expect(screen.getByText('无下游节点')).toBeTruthy()
  })

  it('renders the running glyph on running cards only', () => {
    render(<WorkGraphNode {...nodeProp(data({
      layers: [
        [node(A, 'A', 'ready', [])],
        [node(B, 'B', 'running', [A])],
      ],
    }))} t={t} />)
    const runningCard = screen.getByLabelText(/B，运行中/)
    const glyph = runningCard.querySelector('[data-running-glyph]')
    expect(glyph).not.toBeNull()
    // The six-square WorkGlyph dot matrix, animating.
    expect(glyph!.querySelectorAll('rect')).toHaveLength(6)
    expect(glyph!.querySelector('svg')!.getAttribute('data-active')).toBe('true')
    // Non-running cards carry no glyph.
    expect(screen.getByLabelText(/A，就绪/).querySelector('[data-running-glyph]')).toBeNull()
  })

  it('renders an active budget-free graph without the budget line', () => {
    const { tokenBudget: _unbudgeted, pauseReason: _unpaused, ...rest } = data()
    void _unbudgeted
    void _unpaused
    render(<WorkGraphNode {...nodeProp({ ...rest, status: 'active' })} t={t} />)
    expect(screen.getByText('进行中')).toBeTruthy()
    expect(screen.queryByText(/预算/)).toBeNull()
    expect(screen.queryByText(/已暂停/)).toBeNull()
  })

  it('highlights the dependency chain on hover and restores on leave', () => {
    render(<WorkGraphNode {...nodeProp(data())} t={t} />)
    const cCard = screen.getByLabelText(/C，失败/)
    const aCard = screen.getByLabelText(/A，就绪/)
    const finalCard = screen.getByLabelText(/终节点/)
    fireEvent.mouseEnter(cCard)
    // C's chain (C ← B ← A) is focused; the unrelated final node is dimmed.
    expect(cCard.getAttribute('data-focused')).toBe('true')
    expect(aCard.getAttribute('data-focused')).toBe('true')
    expect(finalCard.getAttribute('data-dimmed')).toBe('true')
    expect(aCard.getAttribute('data-dimmed')).toBeNull()
    fireEvent.mouseLeave(cCard)
    expect(cCard.getAttribute('data-focused')).toBeNull()
    expect(finalCard.getAttribute('data-dimmed')).toBeNull()
  })

  it('pins the chain on click (with the detail) and clears it on Escape', () => {
    render(<WorkGraphNode {...nodeProp(data())} t={t} />)
    const cCard = screen.getByLabelText(/C，失败/)
    fireEvent.click(cCard)
    // Pinned: the chain stays highlighted and the detail stays open.
    expect(screen.getByLabelText(/A，就绪/).getAttribute('data-focused')).toBe('true')
    expect(screen.getByLabelText(/终节点/).getAttribute('data-dimmed')).toBe('true')
    expect(screen.getByText('节点详情')).toBeTruthy()
    // Hovering elsewhere must not override the pinned chain.
    fireEvent.mouseEnter(screen.getByLabelText(/终节点/))
    expect(screen.getByLabelText(/A，就绪/).getAttribute('data-focused')).toBe('true')
    // Escape clears the pin and closes the detail.
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByLabelText(/A，就绪/).getAttribute('data-dimmed')).toBeNull()
    expect(screen.queryByText('节点详情')).toBeNull()
  })

  it('highlights via keyboard focus and ignores non-Escape keys', () => {
    render(<WorkGraphNode {...nodeProp(data())} t={t} />)
    const cCard = screen.getByLabelText(/C，失败/)
    fireEvent.focus(cCard)
    expect(cCard.getAttribute('data-focused')).toBe('true')
    expect(screen.getByLabelText(/终节点/).getAttribute('data-dimmed')).toBe('true')
    fireEvent.blur(cCard)
    expect(cCard.getAttribute('data-focused')).toBeNull()
    // A non-Escape key leaves the pinned chain (and its detail) untouched.
    fireEvent.click(cCard)
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(screen.getByLabelText(/A，就绪/).getAttribute('data-focused')).toBe('true')
    expect(screen.queryByText('节点详情')).not.toBeNull()
  })

  it('dispatches the open-panel window event with the graph detail', () => {
    const events: Array<CustomEvent<WorkGraphPanelOpenDetail>> = []
    const listener = (event: Event): void => {
      events.push(event as CustomEvent<WorkGraphPanelOpenDetail>)
    }
    window.addEventListener(OPEN_WORKGRAPH_PANEL_EVENT, listener)
    try {
      render(<WorkGraphNode {...nodeProp(data(), { sessionId: 's-9' })} t={t} />)
      fireEvent.click(screen.getByText('活动面板'))
      expect(events).toHaveLength(1)
      expect(events[0]!.detail).toEqual({
        graphId: 'wg-1',
        sessionId: 's-9',
        objective: 'ship it',
        status: 'user_paused',
      })
    } finally {
      window.removeEventListener(OPEN_WORKGRAPH_PANEL_EVENT, listener)
    }
  })

  it('still dispatches the panel event when the session id is unavailable', () => {
    let detail: WorkGraphPanelOpenDetail | undefined
    const listener = (event: Event): void => {
      detail = (event as CustomEvent<WorkGraphPanelOpenDetail | undefined>).detail
    }
    window.addEventListener(OPEN_WORKGRAPH_PANEL_EVENT, listener)
    try {
      render(<WorkGraphNode {...nodeProp(data())} t={t} />)
      fireEvent.click(screen.getByText('活动面板'))
      // The graph id always travels; the session id degrades to undefined
      // (the floater opens for the current session regardless).
      expect(detail?.graphId).toBe('wg-1')
      expect(detail?.sessionId).toBeUndefined()
    } finally {
      window.removeEventListener(OPEN_WORKGRAPH_PANEL_EVENT, listener)
    }
  })
})
