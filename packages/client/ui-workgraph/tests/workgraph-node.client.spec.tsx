// @vitest-environment jsdom
// WorkGraphNode behavior: the layered DAG card — state dots, the budget and
// pause lines, the waiting-on caption, blocked failure origins, the final
// node distinction, node selection detail, and the legend — driven purely
// through props, no wire.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
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
function nodeProp(data: WorkGraphChatData): Parameters<typeof WorkGraphNode>[0] {
  return { node: { data } } as Parameters<typeof WorkGraphNode>[0]
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
    // Four node cards (one per node across the three layer rows).
    expect(screen.getAllByRole('button')).toHaveLength(4)
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

  it('renders an active budget-free graph without the budget line', () => {
    const { tokenBudget: _unbudgeted, pauseReason: _unpaused, ...rest } = data()
    void _unbudgeted
    void _unpaused
    render(<WorkGraphNode {...nodeProp({ ...rest, status: 'active' })} t={t} />)
    expect(screen.getByText('进行中')).toBeTruthy()
    expect(screen.queryByText(/预算/)).toBeNull()
    expect(screen.queryByText(/已暂停/)).toBeNull()
  })
})
