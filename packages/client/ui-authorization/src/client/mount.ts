/**
 * Browser entry wiring: $mount the generated `authorization` remote
 * contribution from `@deepseek-ai/dsh-authorization-web`, then register the
 * Models-page login surface into the `settings.models.provider-card` slot.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { ProviderCardExtras } from './provider-card.tsx'
import { NS, en, zh } from './locales.ts'

/** The Models-page provider-card slot, keyed by its owning settings namespace. */
const PROVIDER_CARD_SLOT = 'settings.models.provider-card' as const
const PI_AI_NAMESPACE = 'llm-pi-ai'

/**
 * Mount the remote contribution and the sign-in UI.
 * @param ctx - Client context carrying the gateway, slots, and locale services.
 * @param contribution - the generated authorization descriptors to mount.
 * @returns disposer unwinding the UI and the remote namespace.
 */
export async function mountAuthorizationUi(
  ctx: ClientContext,
  contribution: TypertRemoteContribution,
): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote', 'remote.authorization', 'slots', 'locale'], registerUi)
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await disposeRemote()
    throw error
  }
  return async () => {
    await ui.dispose()
    await disposeRemote()
  }
}

/** The services the browser entry needs. */
export const inject = ['remote', 'slots', 'locale']

/** Register the dictionaries and the provider-card login surface. */
function registerUi(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-authorization: dictionaries')
  ctx.slots.inject(PROVIDER_CARD_SLOT, () => {
    return ctx.slots.register({
      name: PROVIDER_CARD_SLOT,
      key: PI_AI_NAMESPACE,
      locale: NS,
      inject: () => ({ authorization: ctx.remote.authorization }),
    }, ProviderCardExtras)
  })
}
