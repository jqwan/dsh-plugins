/**
 * Wire-safe vocabulary of the browser authorization bridge. Every value here
 * survives a JSON round-trip; the live seam types (`AuthorizationInteraction`,
 * `AbortSignal`, …) never cross the gateway — the controller owns them on the
 * host and this package is what the browser sees.
 *
 * @module @deepseek-ai/dsh-authorization-web/types
 */

/** One login flow a provider offers, as a browser surface lists it. */
export interface AuthorizationEntryView {
  /** The credential record the flow writes (`llm-pi-ai/openai-codex`). */
  readonly key: string
  /** User-facing name of what is being authorized. */
  readonly label: string
  /** The login methods offered, most preferred first. */
  readonly methods: readonly { readonly id: string; readonly label: string }[]
  /** Whether the credential record currently exists, without exposing its value. */
  readonly configured: boolean
  /** Whether an attempt for this key is running right now. */
  readonly inFlight: boolean
}

/** One progress report or instruction from the running flow. */
export interface AuthorizationNoticeView {
  /** What is happening, or what the human must do next. */
  readonly message: string
  /** A page the human must open to continue. */
  readonly url?: string
  /** A short code the human must enter on that page. */
  readonly code?: string
}

/** One choice offered by a `select` prompt. */
export interface AuthorizationPromptOptionView {
  /** Value returned when this option is chosen. */
  readonly id: string
  /** User-facing label. */
  readonly label: string
  /** Optional extra context rendered by capable surfaces. */
  readonly description?: string
}

/** One question the flow needs answered before it can continue. */
export interface AuthorizationPromptView {
  /** Stable id the browser echoes back when answering. */
  readonly promptId: string
  /** How the value should be presented; `secret` is masked and kept out of logs. */
  readonly kind: 'text' | 'secret' | 'select'
  /** What to ask. */
  readonly message: string
  /** Optional field placeholder. */
  readonly placeholder?: string
  /** Options for a `select` prompt. */
  readonly options?: readonly AuthorizationPromptOptionView[]
}

/** The terminal state of one attempt, as the browser learns it. */
export interface AuthorizationSettlementView {
  /** `authorized` once the record is committed; `cancelled` when the human or caller withdrew; `failed` otherwise. */
  readonly status: 'authorized' | 'cancelled' | 'failed'
  /** Diagnostic for a failed attempt (the caller-facing error message). */
  readonly message?: string
}

/** One `poll` response: everything new since the last poll. */
export interface AuthorizationPollResultView {
  /** The attempt handle this view belongs to. */
  readonly handle: string
  /** Notices received since the previous poll (drained). */
  readonly notices: readonly AuthorizationNoticeView[]
  /** The prompt currently awaiting an answer, if any. */
  readonly prompt: AuthorizationPromptView | null
  /** Present once the attempt has ended; sticky across polls. */
  readonly settled?: AuthorizationSettlementView
}

/** Remote failure codes the browser controller raises. */
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'authorization/no-flow': {}
    'authorization/unknown-method': {}
    'authorization/in-flight': {}
    'authorization/unknown-handle': {}
    'authorization/stale-prompt': {}
  }
}
