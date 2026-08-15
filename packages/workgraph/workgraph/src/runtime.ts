/** Runtime constructors and protocol constants for the work-graph domain. */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { WorkGraphErrorCode } from './domain.ts'
import type { WorkGraphId as WorkGraphIdType, WorkNodeId as WorkNodeIdType } from './types.ts'

/** Version of the work-graph change carried by every durable mutation. */
export const WORKGRAPH_CHANGE_VERSION = 1

/**
 * Brand a string as a work-graph id.
 * @param id - raw work-graph identifier.
 * @returns the same string with the compile-time brand.
 */
export function WorkGraphId(id: string): WorkGraphIdType {
  return id as WorkGraphIdType
}

/**
 * Brand a string as a canonical work-node id.
 * @param id - raw `gn-` node identifier.
 * @returns the same string with the compile-time brand.
 */
export function WorkNodeId(id: string): WorkNodeIdType {
  return id as WorkNodeIdType
}

/** Error returned by the work-graph domain boundary. */
export class WorkGraphError extends HarnessError {
  /**
   * @param message - human-readable rejection reason.
   * @param code - stable machine-routable classification.
   */
  // Keep the constructor to narrow HarnessError's string code at this boundary.
  // oxlint-disable-next-line typescript/no-useless-constructor -- type-only narrowing
  constructor(message: string, code: WorkGraphErrorCode) {
    super(message, code)
  }
}
