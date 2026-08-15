/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-workgraph-scheduler`.
 * @module @deepseek-ai/dsh-workgraph-scheduler/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-workgraph-scheduler'

/** Cordis companion plugin name. */
export const name = 'workgraph-scheduler-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the tracker, gate, and scheduler provider is exercised by package tests; every
 * accepted mutation is validated by the domain before it commits.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
