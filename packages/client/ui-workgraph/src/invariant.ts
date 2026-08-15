/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-workgraph`.
 * @module @deepseek-ai/dsh-client-ui-workgraph/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-workgraph'

/** Cordis companion plugin name. */
export const name = 'client-ui-workgraph-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this view owns no event stream or state projection;
 * the chat-node definition folds the session log's `workgraph/change` events
 * and its presentation is a pure function of that logged state, covered by
 * package tests.
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
