import { describe, expect, it } from 'vitest'
import {
  buildFinalNode,
  canonicalNodeId,
  FINAL_NODE_ID,
  FINAL_NODE_TITLE,
  finalNodeSpec,
  installPlan,
  parsePlanArtifact,
} from '@deepseek-ai/dsh-workgraph-scheduler'
import type { WorkGraphLimits } from '@deepseek-ai/dsh-workgraph'
import type { WorkNodeId } from '@deepseek-ai/dsh-workgraph/types'
import { WorkGraphError } from '@deepseek-ai/dsh-workgraph'

const LIMITS: WorkGraphLimits = { maxNodes: 24, historyMax: 64 }

function row(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, title: `Title ${id}`, spec: `Spec ${id}`, deps: [], ...overrides }
}

function expectInvalid(artifact: unknown, message: string): void {
  expect(() => parsePlanArtifact(artifact, LIMITS)).toThrow(new WorkGraphError(message, 'WORKGRAPH_INVALID_PLAN'))
}

describe('parsePlanArtifact', () => {
  it('rejects non-artifact values first', () => {
    expectInvalid(null, 'plan artifact must be an object with a nodes array')
    expectInvalid({ nodes: 'nope' }, 'plan artifact must be an object with a nodes array')
  })

  it('rejects an artifact over the byte budget before deeper parsing', () => {
    const byteLimits: WorkGraphLimits = { ...LIMITS, planBytesMax: 40 }
    const artifact = { nodes: [{ id: 'a', title: 't', spec: 's', deps: [] }] }
    expect(() => parsePlanArtifact(artifact, byteLimits))
      .toThrow('plan artifact exceeds the byte budget')
    // The default (unbounded) limits accept the same artifact.
    expect(parsePlanArtifact(artifact, LIMITS)).toHaveLength(1)
  })

  it('rejects an empty plan', () => {
    expectInvalid({ nodes: [] }, 'plan must contain at least one node')
  })

  it('rejects malformed rows with their index and slug', () => {
    expectInvalid({ nodes: [7] }, 'plan node 0 must be a record')
    expectInvalid({ nodes: [{ title: 't', spec: 's', deps: [] }] }, 'plan node 0 id must be a string')
    expectInvalid(
      { nodes: [{ id: 'a', spec: 's', deps: [] }] },
      'plan node 0 (a) title must be a string',
    )
    expectInvalid(
      { nodes: [{ id: 'a', title: 't', deps: [] }] },
      'plan node 0 (a) spec must be a string',
    )
    expectInvalid(
      { nodes: [{ id: 'a', title: 't', spec: 's', deps: 'b' }] },
      'plan node 0 (a) deps must be an array',
    )
    expectInvalid(
      { nodes: [{ id: 'a', title: 't', spec: 's', deps: [7] }] },
      'plan node 0 (a) deps must be strings',
    )
  })

  it('collapses duplicate dep entries instead of reporting a cycle', () => {
    const parsed = parsePlanArtifact(
      { nodes: [row('a'), row('b', { deps: ['a', 'a'] })] },
      LIMITS,
    )
    expect(parsed[1]!.deps).toEqual(['a'])
  })

  it('enforces the node cap after parsing and before hygiene', () => {
    const many = Array.from({ length: 25 }, (_, index) => row(`n-${index}`))
    expectInvalid({ nodes: many }, 'plan exceeds the node cap (25 > 24)')
  })

  it('rejects unhygienic, duplicate, and empty slugs and fields', () => {
    expectInvalid({ nodes: [row('bad slug!')] }, 'node id "bad slug!" must be 1-64 characters of [A-Za-z0-9_-]')
    expectInvalid({ nodes: [row('')] }, 'node id "" must be 1-64 characters of [A-Za-z0-9_-]')
    expectInvalid({ nodes: [row('x'.repeat(65))] }, `node id "${'x'.repeat(65)}" must be 1-64 characters of [A-Za-z0-9_-]`)
    expectInvalid({ nodes: [row('a'), row('a')] }, 'duplicate node id "a"')
    expectInvalid({ nodes: [row('a', { title: '  ' })] }, 'node "a" has an empty title')
    expectInvalid({ nodes: [row('a', { spec: '' })] }, 'node "a" has an empty spec')
  })

  it('rejects self and unknown dependencies', () => {
    expectInvalid({ nodes: [row('a', { deps: ['a'] })] }, 'node "a" depends on itself')
    expectInvalid({ nodes: [row('a', { deps: ['ghost'] })] }, 'node "a" depends on unknown node "ghost"')
  })

  it('rejects a cycle naming its stranded members', () => {
    expectInvalid(
      { nodes: [row('a', { deps: ['b'] }), row('b', { deps: ['a'] })] },
      'plan contains a dependency cycle involving: a, b',
    )
  })

  it('orders topologically with planner order preferred among ready nodes', () => {
    const parsed = parsePlanArtifact(
      {
        nodes: [
          row('c', { deps: ['b'] }),
          row('b', { deps: ['a'] }),
          row('a'),
          row('d'),
        ],
      },
      LIMITS,
    )
    expect(parsed.map(entry => entry.slug)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('rejects a canonical-id collision between distinct slugs', () => {
    const colliding = (slug: string): WorkNodeId =>
      slug === 'one' || slug === 'two' ? canonicalNodeId('x') : canonicalNodeId(slug)
    expect(() => parsePlanArtifact({ nodes: [row('one'), row('two')] }, LIMITS, colliding)).toThrow(
      `distinct node ids "one" and "two" produce the same canonical id ${canonicalNodeId('x')}`,
    )
  })
})

describe('installPlan', () => {
  it('canonicalizes ids, rewrites blocks, keeps every node waiting, and appends the gated final node last', () => {
    const nodes = installPlan(
      { nodes: [row('a'), row('b', { deps: ['a'] })] },
      'make it real',
      LIMITS,
    )
    const idA = canonicalNodeId('a')
    const idB = canonicalNodeId('b')
    expect(nodes.map(node => node.id)).toEqual([idA, idB, FINAL_NODE_ID])
    expect(nodes[1]!.blocks).toEqual([idA])
    for (const node of nodes) {
      expect(node.state).toBe('waiting')
      expect(node.rounds).toBe(0)
    }
    const final = nodes[2]!
    expect(final.title).toBe(FINAL_NODE_TITLE)
    expect(final.blocks).toEqual([idA, idB])
    expect(final.spec).toContain('OVERALL OBJECTIVE:\nmake it real')
  })

  it('trims titles and specs on the way in', () => {
    const nodes = installPlan(
      { nodes: [row('a', { title: '  Title a  ', spec: ' Spec a ' })] },
      'objective',
      LIMITS,
    )
    expect(nodes[0]!.title).toBe('Title a')
    expect(nodes[0]!.spec).toBe('Spec a')
  })

  it('rejects a slug that canonicalizes onto the reserved final id', () => {
    const reserved = (slug: string): WorkNodeId =>
      slug === 'sneaky' ? FINAL_NODE_ID : canonicalNodeId(slug)
    expect(() => installPlan({ nodes: [row('sneaky')] }, 'objective', LIMITS, reserved)).toThrow(
      'node "sneaky" canonicalizes onto the reserved final node id',
    )
  })
})

describe('final node vocabulary', () => {
  it('exposes the fixed title and objective-embedding spec', () => {
    expect(FINAL_NODE_TITLE).toBe('Final verification of the overall objective')
    expect(finalNodeSpec('do the thing')).toContain('do the thing')
    const node = buildFinalNode('do the thing', [canonicalNodeId('a')])
    expect(node.id).toBe(FINAL_NODE_ID)
    expect(node.blocks).toEqual([canonicalNodeId('a')])
  })
})
