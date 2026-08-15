import { describe, expect, it } from 'vitest'
import { canonicalNodeId, FINAL_NODE_ID, fnv1a32 } from '@deepseek-ai/dsh-workgraph-scheduler'

describe('fnv1a32', () => {
  it('matches the reference FNV-1a 32-bit vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5)
    expect(fnv1a32('a')).toBe(0xe40c292c)
    expect(fnv1a32('foobar')).toBe(0xbf9cf968)
  })
})

describe('canonicalNodeId', () => {
  it('renders the hash as gn- plus eight lowercase hex characters', () => {
    expect(canonicalNodeId('a')).toBe('gn-e40c292c')
    expect(canonicalNodeId('ship-it')).toMatch(/^gn-[0-9a-f]{8}$/)
    expect(canonicalNodeId('A')).not.toBe(canonicalNodeId('a'))
  })
})

describe('FINAL_NODE_ID', () => {
  it('is the fixed non-hash identity', () => {
    expect(FINAL_NODE_ID).toBe('gn-final')
  })
})
