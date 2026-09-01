/**
 * The browser-side face of the authorization remote namespace. The generated
 * remote artifact from `@deepseek-ai/dsh-authorization-web` supplies the wire
 * descriptors this client $mounts; this structural interface types the calls
 * against the shared wire vocabulary.
 */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AuthorizationEntryView, AuthorizationPollResultView,
} from '@deepseek-ai/dsh-authorization-web/types'

/** The `authorization` remote namespace as this client calls it. */
export interface AuthorizationRemote {
  list(): Promise<RemoteResult<AuthorizationEntryView[]>>
  describe(key: string): Promise<RemoteResult<AuthorizationEntryView | null>>
  begin(key: string, method?: string): Promise<RemoteResult<{ handle: string }>>
  poll(handle: string): Promise<RemoteResult<AuthorizationPollResultView>>
  answer(handle: string, promptId: string, value: string): Promise<RemoteResult<void>>
  decline(handle: string, promptId: string): Promise<RemoteResult<void>>
  cancel(handle: string): Promise<RemoteResult<void>>
  signOut(key: string): Promise<RemoteResult<void>>
}
