/**
 * Browser bridge for the authorization seam (`ctx.authorization`). The seam's
 * `begin()` takes a live `AuthorizationInteraction` — functions that cannot
 * cross the gateway — so this controller owns the interaction on the host and
 * exposes a polling protocol instead: `begin` starts the attempt and returns
 * an opaque handle, `poll` drains the notices and the current prompt it has
 * produced, and `answer` / `decline` / `cancel` steer it from the browser.
 *
 * One attempt per key at a time is the seam's own contract; this controller
 * keeps one bridge per handle and refuses to start a second attempt for a key
 * that is already running.
 *
 * @module @deepseek-ai/dsh-authorization-web
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {
  AuthorizationInteraction, AuthorizationNotice, AuthorizationPrompt, AuthorizationService,
} from '@deepseek-ai/dsh-authorization'
import { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization'
import { parseCredentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AuthorizationEntryView, AuthorizationNoticeView, AuthorizationPollResultView,
  AuthorizationPromptView, AuthorizationSettlementView,
} from './types.ts'

/** One prompt the flow is waiting on, addressable from the browser. */
interface PendingPrompt {
  readonly promptId: string
  readonly view: AuthorizationPromptView
  readonly resolve: (value: string) => void
  readonly reject: (error: unknown) => void
  readonly dispose: () => void
}

/** One running attempt, keyed by the handle the browser received from `begin`. */
interface AttemptBridge {
  readonly handle: string
  readonly key: CredentialKey
  /** Notices the flow produced since the last poll drained them. */
  notices: AuthorizationNoticeView[]
  /** The prompt currently awaiting an answer, if any. */
  prompt: PendingPrompt | undefined
  /** Terminal state once the attempt has settled (sticky). */
  settled: AuthorizationSettlementView | undefined
  /** Ignore callbacks from a flow that outlived its attempt. */
  closed: boolean
}

async function entryView(entry: {
  key: CredentialKey
  label: string
  methods: readonly { id: string; label: string }[]
  inFlight: boolean
}, credentials: CredentialProvider): Promise<AuthorizationEntryView> {
  const record = await credentials.describeRecord(entry.key)
  return {
    key: entry.key,
    label: entry.label,
    methods: entry.methods,
    configured: record.configured,
    inFlight: entry.inFlight,
  }
}

function noticeView(notice: AuthorizationNotice): AuthorizationNoticeView {
  return {
    message: notice.message,
    ...notice.url === undefined ? {} : { url: notice.url },
    ...notice.code === undefined ? {} : { code: notice.code },
  }
}

function promptView(prompt: AuthorizationPrompt, promptId: string): AuthorizationPromptView {
  if (prompt.kind === 'select') {
    return { promptId, kind: 'select', message: prompt.message, options: prompt.options }
  }
  return {
    promptId,
    kind: prompt.kind,
    message: prompt.message,
    ...prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder },
  }
}

function settlementView(status: 'authorized' | 'cancelled' | 'failed', message?: string): AuthorizationSettlementView {
  return message === undefined ? { status } : { status, message }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function credentialKeyOf(value: string): CredentialKey {
  try {
    return parseCredentialKey(value)
  } catch (error) {
    throw new RemoteError('gateway/bad-request', messageOf(error), {})
  }
}

/** The Gateway service the browser signs in through. */
export class AuthorizationBrowserController extends TypertRemoteService {
  static inject = ['authorization', 'credentials']

  private readonly attempts = new Map<string, AttemptBridge>()
  private readonly retentionTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(ctx: Context) {
    super(ctx, 'authorizationBrowser', { namespace: 'authorization' })
    ctx.effect(() => () => { this.dispose() }, 'authorization-browser: attempts')
  }

  private dispose(): void {
    const authorization = this.ctx.get('authorization')
    for (const bridge of this.attempts.values()) {
      if (bridge.settled === undefined) authorization?.cancel(bridge.key)
      this.closeBridge(bridge)
    }
    for (const timer of this.retentionTimers.values()) clearTimeout(timer)
    this.retentionTimers.clear()
    this.attempts.clear()
  }

  private closeBridge(bridge: AttemptBridge, settlement?: AuthorizationSettlementView): void {
    bridge.closed = true
    const pending = bridge.prompt
    bridge.prompt = undefined
    pending?.dispose()
    pending?.reject(new Error('the authorization attempt ended'))
    if (settlement !== undefined && bridge.settled === undefined) bridge.settled = settlement
  }

  private retain(bridge: AttemptBridge): void {
    const timer = setTimeout(() => {
      this.retentionTimers.delete(bridge.handle)
      this.attempts.delete(bridge.handle)
    }, 60_000)
    timer.unref()
    this.retentionTimers.set(bridge.handle, timer)
  }

  private bridge(handle: string): AttemptBridge {
    const bridge = this.attempts.get(handle)
    if (bridge === undefined) {
      throw new RemoteError(
        'authorization/unknown-handle',
        `no authorization attempt is running for handle "${handle}"`,
        {},
      )
    }
    return bridge
  }

  /** Every login flow a surface can offer, most preferred first.
   * @returns the available login flows with current credential and lifecycle state.
   */
  @Remote
  async list(): Promise<AuthorizationEntryView[]> {
    const authorization = (this.ctx as Context & { authorization: AuthorizationService }).authorization
    const credentials = (this.ctx as Context & { credentials: CredentialProvider }).credentials
    return await Promise.all(authorization.list().map(entry => entryView(entry, credentials)))
  }

  /** One login flow, or null when nothing claims the key.
   * @param key - the credential record key.
   * @returns the flow view, or null when no flow claims the key.
   */
  @Remote
  async describe(key: CredentialKey): Promise<AuthorizationEntryView | null> {
    const parsedKey = credentialKeyOf(key)
    const entry = (this.ctx as Context & { authorization: AuthorizationService }).authorization.describe(parsedKey)
    if (entry === undefined) return null
    const credentials = (this.ctx as Context & { credentials: CredentialProvider }).credentials
    return await entryView(entry, credentials)
  }

  /**
   * Start one sign-in attempt and return the handle the browser polls.
   * The attempt runs in the background; its notices, prompt, and terminal
   * state arrive through {@link poll}.
   * @param key - the credential record to authorize (`llm-pi-ai/openai-codex`).
   * @param method - one of the flow's login methods; omitted uses the first.
   * @returns the attempt handle.
   * @throws RemoteError `authorization/no-flow`, `authorization/unknown-method`,
   *   or `authorization/in-flight` when the attempt cannot start.
   */
  @Remote
  begin(key: CredentialKey, method?: string): { handle: string } {
    const parsedKey = credentialKeyOf(key)
    const authorization = (this.ctx as Context & { authorization: AuthorizationService }).authorization
    const flow = authorization.describe(parsedKey)
    if (flow === undefined) {
      throw new RemoteError('authorization/no-flow', `no authorization flow is registered for "${parsedKey}"`, {})
    }
    if (method !== undefined && !flow.methods.some(candidate => candidate.id === method)) {
      throw new RemoteError(
        'authorization/unknown-method',
        `authorization flow for "${parsedKey}" offers no method "${method}"`,
        {},
      )
    }
    if (flow.inFlight) {
      throw new RemoteError(
        'authorization/in-flight',
        `an authorization attempt for "${parsedKey}" is already running`,
        {},
      )
    }
    const handle = randomUUID()
    const bridge: AttemptBridge = {
      handle, key: parsedKey, notices: [], prompt: undefined, settled: undefined, closed: false,
    }
    this.attempts.set(handle, bridge)
    void this.runAttempt(bridge, parsedKey, method)
    return { handle }
  }

  /** Everything new since the previous poll: notices, the current prompt, and the terminal state when it has settled.
   * @param handle - the opaque attempt handle returned by {@link begin}.
   * @returns the drained notices, current prompt, and sticky terminal state.
   */
  @Remote
  poll(handle: string): AuthorizationPollResultView {
    const bridge = this.bridge(handle)
    const notices = bridge.notices
    bridge.notices = []
    return {
      handle,
      notices,
      prompt: bridge.prompt?.view ?? null,
      ...bridge.settled === undefined ? {} : { settled: bridge.settled },
    }
  }

  /** Answer the prompt currently awaiting an answer.
   * @param handle - the opaque attempt handle returned by {@link begin}.
   * @param promptId - the prompt identifier returned by {@link poll}.
   * @param value - the user's answer.
   */
  @Remote
  answer(handle: string, promptId: string, value: string): void {
    const bridge = this.bridge(handle)
    const pending = bridge.prompt
    if (pending === undefined || pending.promptId !== promptId) {
      throw new RemoteError(
        'authorization/stale-prompt',
        'this authorization prompt is no longer awaiting an answer',
        {},
      )
    }
    bridge.prompt = undefined
    pending.dispose()
    pending.resolve(value)
  }

  /** Decline the prompt currently awaiting an answer; the attempt settles `cancelled`.
   * @param handle - the opaque attempt handle returned by {@link begin}.
   * @param promptId - the prompt identifier returned by {@link poll}.
   */
  @Remote
  decline(handle: string, promptId: string): void {
    const bridge = this.bridge(handle)
    const pending = bridge.prompt
    if (pending === undefined || pending.promptId !== promptId) {
      throw new RemoteError(
        'authorization/stale-prompt',
        'this authorization prompt is no longer awaiting an answer',
        {},
      )
    }
    bridge.prompt = undefined
    pending.dispose()
    pending.reject(new AuthorizationDeclinedError())
  }

  /** Withdraw one attempt, if it is still running.
   * @param handle - the opaque attempt handle returned by {@link begin}.
   * @returns when the authorization service has released the attempt key.
   */
  @Remote
  async cancel(handle: string): Promise<void> {
    const bridge = this.bridge(handle)
    if (bridge.settled !== undefined) return
    const authorization = (this.ctx as Context & { authorization: AuthorizationService }).authorization
    const released = Promise.withResolvers<void>()
    const dispose = this.ctx.on('authorization/settled', (key) => {
      if (key !== bridge.key) return
      dispose()
      released.resolve()
    })
    this.closeBridge(bridge, settlementView('cancelled'))
    if (authorization.describe(bridge.key)?.inFlight !== true) {
      dispose()
      released.resolve()
    } else {
      authorization.cancel(bridge.key)
    }
    await released.promise
  }

  /** Forget a stored login for a registered authorization flow.
   * @param key - the credential record key owned by the flow.
   * @returns when the credential record has been deleted.
   * @throws RemoteError `authorization/no-flow` when no flow claims the key, or
   *   `authorization/in-flight` while its attempt is running.
   */
  @Remote
  async signOut(key: CredentialKey): Promise<void> {
    const parsedKey = credentialKeyOf(key)
    const authorization = (this.ctx as Context & { authorization: AuthorizationService }).authorization
    const flow = authorization.describe(parsedKey)
    if (flow === undefined) {
      throw new RemoteError('authorization/no-flow', `no authorization flow is registered for "${parsedKey}"`, {})
    }
    if (flow.inFlight) {
      throw new RemoteError('authorization/in-flight', `an authorization attempt for "${parsedKey}" is already running`, {})
    }
    await (this.ctx as Context & { credentials: { deleteRecord(key: CredentialKey): Promise<void> } }).credentials.deleteRecord(parsedKey)
  }

  /** Run one seam attempt with the browser-facing interaction, recording its output on the bridge. */
  private async runAttempt(
    bridge: AttemptBridge,
    key: CredentialKey,
    method: string | undefined,
  ): Promise<void> {
    const interaction: AuthorizationInteraction = {
      notify: (notice) => {
        if (!bridge.closed && bridge.settled === undefined) bridge.notices.push(noticeView(notice))
      },
      prompt: (prompt) => {
        if (bridge.closed || bridge.settled !== undefined) {
          return Promise.reject(new Error('the authorization attempt ended'))
        }
        return new Promise<string>((resolve, reject) => {
          const promptId = randomUUID()
          let disposed = false
          const dispose = (): void => {
            if (disposed) return
            disposed = true
            prompt.signal?.removeEventListener('abort', onAbort)
          }
          const onAbort = (): void => {
            dispose()
            if (bridge.prompt?.promptId === promptId) bridge.prompt = undefined
            reject(new Error('the authorization prompt was withdrawn'))
          }
          if (prompt.signal?.aborted === true) {
            reject(new Error('the authorization prompt was withdrawn'))
            return
          }
          bridge.prompt = { promptId, view: promptView(prompt, promptId), resolve, reject, dispose }
          prompt.signal?.addEventListener('abort', onAbort, { once: true })
        })
      },
    }
    if (bridge.closed) {
      this.retain(bridge)
      return
    }
    try {
      const outcome = await (this.ctx as Context & { authorization: AuthorizationService }).authorization
        .begin({
          key,
          ...method === undefined ? {} : { method },
          interaction,
        })
      if (bridge.settled === undefined) bridge.settled = settlementView(outcome.status)
    } catch (error) {
      if (bridge.settled === undefined) bridge.settled = settlementView('failed', messageOf(error))
    } finally {
      this.closeBridge(bridge)
      this.retain(bridge)
    }
  }
}


declare module '@deepseek-ai/cordis' {
  interface Context {
    authorizationBrowser: AuthorizationBrowserController
  }
}
