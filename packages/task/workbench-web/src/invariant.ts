/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-workbench-web`.
 * @module @deepseek-ai/dsh-workbench-web/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-workbench-web'

/* jscpd:ignore-start */
/** Cordis companion plugin name. */
export const name = 'workbench-web-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the workbench runtime owns its lifecycle through the
 * apply effect (route/upgrade registration and close on dispose), and its
 * observable behavior is covered by the package's node tests plus the manual
 * workbench flow checks.
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
