/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-authorization-web`.
 * @module @deepseek-ai/dsh-authorization-web/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-authorization-web'

/** Cordis companion plugin name. */
export const name = 'authorization-web-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the controller's attempt map and prompt callbacks are
 * private state, and the public authorization/settled event is emitted by the
 * underlying seam before the bridge records its terminal view. Lifecycle tests
 * therefore own the observable cleanup contract.
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
