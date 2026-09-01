/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-authorization`.
 * @module @deepseek-ai/dsh-client-ui-authorization/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-authorization'

/** Cordis companion plugin name. */
export const name = 'client-ui-authorization-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the UI owns only slot and locale registrations plus
 * component-local state; their Fiber disposers are the authoritative lifecycle
 * relationship and are covered by the Client apply and component tests.
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
