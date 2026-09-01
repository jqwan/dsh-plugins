/**
 * Authorization-web plugin: mounts the authorization seam (a service
 * definition with no mount in the shipped bundles — `llm-pi-ai` registers its
 * provider sign-in flows once the seam appears) and the gateway controller the
 * browser signs in through.
 *
 * @module @deepseek-ai/dsh-authorization-web
 */

import type { Context } from '@deepseek-ai/cordis'
import { AuthorizationService } from '@deepseek-ai/dsh-authorization'
import { AuthorizationBrowserController } from './controller.ts'

export type {
  AuthorizationEntryView, AuthorizationNoticeView, AuthorizationPollResultView,
  AuthorizationPromptOptionView, AuthorizationPromptView, AuthorizationSettlementView,
} from './types.ts'
export { AuthorizationBrowserController } from './controller.ts'

/**
 * Mount the seam (when no other layer has) and the browser controller.
 * Mounting is idempotent-friendly: a composition that already provides
 * `ctx.authorization` keeps its instance and only gains the controller.
 * @param ctx - Host context with the credentials service mounted.
 */
export function apply(ctx: Context): void {
  if (ctx.get('authorization') === undefined) {
    ctx.plugin(AuthorizationService)
  }
  ctx.plugin(AuthorizationBrowserController)
}
