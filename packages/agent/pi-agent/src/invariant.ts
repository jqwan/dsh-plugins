/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-pi-agent`.
 * @module @deepseek-ai/dsh-pi-agent/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-pi-agent'

/** Cordis companion plugin name. */
export const name = 'pi-agent-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the kernel translation pipeline is covered by the
 * package's node tests plus the manual launch flow; lifecycle ownership is
 * the AgentFactory contract's own rollback.
 */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
