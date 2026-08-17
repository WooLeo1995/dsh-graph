// Activity-model projections: nodeStages layering (missing/non-finite depth
// degrades to 0, stable sort), relatedNodeIds upstream/downstream traversal
// (cycle-safe, unknown id), the panel session-ownership predicate, and the
// compact-DAG geometry (depth-column layout, cubic edge routing, focus
// precedence, label compaction, parallel-grid fallback).

import { describe, expect, it } from 'vitest'
import type { WorkGraphPanelNode } from '@deepseek-ai/dsh-workgraph'
import {
  activityPanelExpandedForSession,
  compactDagLayout,
  compactNodeLabel,
  dependencyFocusNodeId,
  nodeStages,
  relatedNodeIds,
  usesParallelGrid,
  type RelationshipNode,
} from '../src/client/activity-model.ts'

function node(id: string, blocks: string[], depth: number): RelationshipNode {
  return { id, blocks, depth }
}

describe('activityPanelExpandedForSession', () => {
  it('expands only when open, owned, and matching the current session', () => {
    expect(activityPanelExpandedForSession(true, 's1', 's1')).toBe(true)
    expect(activityPanelExpandedForSession(false, 's1', 's1')).toBe(false)
    expect(activityPanelExpandedForSession(true, undefined, 's1')).toBe(false)
    expect(activityPanelExpandedForSession(true, 's1', undefined)).toBe(false)
    expect(activityPanelExpandedForSession(true, 's1', 's2')).toBe(false)
  })
})

describe('nodeStages', () => {
  it('groups nodes by depth into ascending stages with stable id order', () => {
    const stages = nodeStages([
      node('gn-b', [], 1),
      node('gn-a', [], 0),
      node('gn-c', [], 2),
      node('gn-aa', [], 0),
    ])
    expect(stages.map(stage => stage.depth)).toEqual([0, 1, 2])
    expect(stages[0]?.nodes.map(n => n.id)).toEqual(['gn-a', 'gn-aa'])
    expect(stages[1]?.nodes.map(n => n.id)).toEqual(['gn-b'])
    expect(stages[2]?.nodes.map(n => n.id)).toEqual(['gn-c'])
  })

  it('degrades non-finite, negative, and fractional depths to layer 0', () => {
    const stages = nodeStages([
      node('nan', [], Number.NaN),
      node('inf', [], Number.POSITIVE_INFINITY),
      node('neg', [], -2),
      node('frac', [], 1.8),
    ])
    expect(stages.map(stage => stage.depth)).toEqual([0, 1])
    expect(stages[0]?.nodes.map(n => n.id).sort()).toEqual(['inf', 'nan', 'neg'])
    expect(stages[1]?.nodes.map(n => n.id)).toEqual(['frac'])
  })

  it('returns an empty stage list for no nodes', () => {
    expect(nodeStages([])).toEqual([])
  })
})

describe('relatedNodeIds', () => {
  const graph: RelationshipNode[] = [
    node('gn-root', [], 0),
    node('gn-mid', ['gn-root'], 1),
    node('gn-leaf', ['gn-mid'], 2),
    node('gn-other', [], 0),
  ]

  it('returns the full upstream and downstream chain around a node', () => {
    expect([...relatedNodeIds('gn-mid', graph)].sort()).toEqual(['gn-leaf', 'gn-mid', 'gn-root'])
  })

  it('includes the node itself and both directions from a root and a leaf', () => {
    expect([...relatedNodeIds('gn-root', graph)].sort()).toEqual(['gn-leaf', 'gn-mid', 'gn-root'])
    expect([...relatedNodeIds('gn-leaf', graph)].sort()).toEqual(['gn-leaf', 'gn-mid', 'gn-root'])
  })

  it('isolates unrelated nodes', () => {
    expect([...relatedNodeIds('gn-other', graph)]).toEqual(['gn-other'])
  })

  it('returns an empty set for an unknown id', () => {
    expect(relatedNodeIds('gn-nope', graph).size).toBe(0)
  })

  it('is cycle-safe: a cyclic dependency edge terminates without hanging', () => {
    const cyclic: RelationshipNode[] = [
      node('gn-x', ['gn-y'], 0),
      node('gn-y', ['gn-x'], 0),
    ]
    expect([...relatedNodeIds('gn-x', cyclic)].sort()).toEqual(['gn-x', 'gn-y'])
  })

  it('includes dangling block references in the chain (like the source set)', () => {
    const dangling: RelationshipNode[] = [
      node('gn-a', ['gn-missing'], 1),
      node('gn-b', ['gn-a'], 2),
    ]
    expect([...relatedNodeIds('gn-b', dangling)].sort()).toEqual(['gn-a', 'gn-b', 'gn-missing'])
  })
})

describe('compactDagLayout', () => {
  it('lays a chain out left-to-right in depth columns', () => {
    const layout = compactDagLayout([
      node('gn-a', [], 0),
      node('gn-b', ['gn-a'], 1),
      node('gn-c', ['gn-b'], 2),
    ])
    expect(layout.width).toBe(3 * 92 + 2 * 26)
    expect(layout.height).toBe(30)
    expect(layout.nodes.map(entry => [entry.node.id, entry.x, entry.y])).toEqual([
      ['gn-a', 0, 0],
      ['gn-b', 118, 0],
      ['gn-c', 236, 0],
    ])
  })

  it('routes one cubic edge per real block reference', () => {
    const layout = compactDagLayout([
      node('gn-a', [], 0),
      node('gn-b', ['gn-a'], 1),
      node('gn-c', ['gn-b'], 2),
    ])
    expect(layout.edges).toEqual([
      { from: 'gn-a', to: 'gn-b', path: 'M92 15C106 15,104 15,118 15' },
      { from: 'gn-b', to: 'gn-c', path: 'M210 15C224 15,222 15,236 15' },
    ])
    for (const edge of layout.edges) {
      expect(edge.path.startsWith('M')).toBe(true)
      expect(edge.path.includes('C')).toBe(true)
    }
  })

  it('arranges a diamond with id-stable rows and fan-in edges', () => {
    const layout = compactDagLayout([
      node('gn-d', ['gn-b', 'gn-c'], 2),
      node('gn-a', [], 0),
      node('gn-c', ['gn-a'], 1),
      node('gn-b', ['gn-a'], 1),
    ])
    expect(layout.nodes.map(entry => [entry.node.id, entry.x, entry.y])).toEqual([
      ['gn-a', 0, 0],
      ['gn-b', 118, 0],
      ['gn-c', 118, 38],
      ['gn-d', 236, 0],
    ])
    expect(layout.edges).toEqual([
      { from: 'gn-a', to: 'gn-b', path: 'M92 15C106 15,104 15,118 15' },
      { from: 'gn-a', to: 'gn-c', path: 'M92 15C106 15,104 53,118 53' },
      { from: 'gn-b', to: 'gn-d', path: 'M210 15C224 15,222 15,236 15' },
      { from: 'gn-c', to: 'gn-d', path: 'M210 53C224 53,222 15,236 15' },
    ])
  })

  it('returns zero size and no items for an empty node set', () => {
    const layout = compactDagLayout([])
    expect(layout.width).toBe(0)
    expect(layout.height).toBe(0)
    expect(layout.nodes).toEqual([])
    expect(layout.edges).toEqual([])
  })

  it('degrades missing, non-finite, and negative depth to column 0', () => {
    const layout = compactDagLayout([
      node('gn-x', [], Number.NaN),
      node('gn-y', [], Number.POSITIVE_INFINITY),
      node('gn-z', [], -2),
    ])
    expect(layout.width).toBe(92)
    expect(layout.height).toBe(3 * 30 + 2 * 8)
    expect(layout.nodes.map(entry => [entry.node.id, entry.x, entry.y])).toEqual([
      ['gn-x', 0, 0],
      ['gn-y', 0, 38],
      ['gn-z', 0, 76],
    ])
  })

  it('skips dangling block references instead of routing an edge', () => {
    const layout = compactDagLayout([node('gn-a', ['gn-missing'], 0)])
    expect(layout.edges).toEqual([])
    expect(layout.nodes).toHaveLength(1)
  })

  it('accepts the live panel node shape (WorkGraphPanelNode adaptation)', () => {
    const panelNodes: readonly WorkGraphPanelNode[] = []
    expect(compactDagLayout(panelNodes)).toEqual({ width: 0, height: 0, nodes: [], edges: [] })
  })
})

describe('dependencyFocusNodeId', () => {
  it('prefers the pinned node over keyboard focus and hover', () => {
    expect(dependencyFocusNodeId('gn-pin', 'gn-kb', 'gn-hover')).toBe('gn-pin')
  })

  it('falls back to keyboard focus when unpinned', () => {
    expect(dependencyFocusNodeId(null, 'gn-kb', 'gn-hover')).toBe('gn-kb')
  })

  it('falls back to hover when unpinned and unfocused', () => {
    expect(dependencyFocusNodeId(null, null, 'gn-hover')).toBe('gn-hover')
  })

  it('returns null when nothing is focused', () => {
    expect(dependencyFocusNodeId(null, null, null)).toBeNull()
  })
})

describe('compactNodeLabel', () => {
  it('keeps short titles unchanged', () => {
    expect(compactNodeLabel('产出需求文档')).toBe('产出需求文档')
  })

  it('truncates titles past 18 characters with an ellipsis', () => {
    const long = '一二三四五六七八九十甲乙丙丁戊己庚辛壬'
    expect(long.length).toBeGreaterThan(18)
    expect(compactNodeLabel(long)).toBe('一二三四五六七八九十甲乙丙丁戊己庚…')
  })

  it('takes the first segment before an inline separator', () => {
    expect(compactNodeLabel('产出需求文档（含评审）')).toBe('产出需求文档')
    expect(compactNodeLabel('目标：实现数据管线')).toBe('目标')
    expect(compactNodeLabel('调研·设计·实现')).toBe('调研')
  })

  it('handles empty and whitespace-only titles', () => {
    expect(compactNodeLabel('')).toBe('')
    expect(compactNodeLabel('   ')).toBe('')
  })
})

describe('usesParallelGrid', () => {
  it('returns false for an empty node set', () => {
    expect(usesParallelGrid([])).toBe(false)
  })

  it('returns true for nodes without real dependency edges', () => {
    expect(usesParallelGrid([node('gn-a', [], 0)])).toBe(true)
    expect(usesParallelGrid([node('gn-a', [], 0), node('gn-b', [], 0)])).toBe(true)
  })

  it('treats a dangling block reference as no real edge', () => {
    expect(usesParallelGrid([node('gn-a', ['gn-missing'], 0)])).toBe(true)
  })

  it('returns false once a real dependency edge exists', () => {
    expect(usesParallelGrid([node('gn-a', [], 0), node('gn-b', ['gn-a'], 1)])).toBe(false)
  })
})
