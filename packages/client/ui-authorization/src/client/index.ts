/**
 * Browser entry of the sign-in surface: mounts the generated `authorization`
 * remote contribution and registers the login button into the Models page's
 * provider-card slot.
 */

import authorizationRemote from '@deepseek-ai/dsh-authorization-web/remote'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { AuthorizationKey, NS } from './locales.ts'
import { mountAuthorizationUi } from './mount.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Sign-in surface copy for the Models-page provider cards. */
    [NS]: AuthorizationKey
  }
}

export { inject } from './mount.ts'
export type { AuthorizationRemote } from './remote.ts'
export type { ProviderCardExtrasProps } from './provider-card.tsx'

/** Mount the remote contribution and its browser UI. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  return await mountAuthorizationUi(ctx, authorizationRemote)
}
