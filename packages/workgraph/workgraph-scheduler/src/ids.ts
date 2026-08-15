/** Canonical work-node identity: FNV-1a 32-bit content hashes of planner slugs. */

import { WorkNodeId } from '@deepseek-ai/dsh-workgraph'
import type { WorkNodeId as WorkNodeIdType } from '@deepseek-ai/dsh-workgraph/types'

/** FNV-1a 32-bit offset basis. */
const FNV_OFFSET = 0x811c9dc5
/** FNV-1a 32-bit prime. */
const FNV_PRIME = 0x01000193

/**
 * Compute the FNV-1a 32-bit hash of a string.
 * @param value - the string to hash.
 * @returns the unsigned 32-bit hash.
 */
export function fnv1a32(value: string): number {
  let hash = FNV_OFFSET
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, FNV_PRIME) >>> 0
  }
  return hash >>> 0
}

/**
 * Canonicalize a planner slug into a durable node id: `gn-` plus the slug's
 * FNV-1a hash as eight lowercase hex characters, stable across processes.
 * @param slug - the validated planner slug.
 * @returns the canonical node id.
 */
export function canonicalNodeId(slug: string): WorkNodeIdType {
  return WorkNodeId(`gn-${fnv1a32(slug).toString(16).padStart(8, '0')}`)
}

/** The harness-appended final node's fixed identity (not a hash form). */
export const FINAL_NODE_ID: WorkNodeIdType = WorkNodeId('gn-final')
