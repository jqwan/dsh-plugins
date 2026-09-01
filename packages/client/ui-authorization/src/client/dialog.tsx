/**
 * The sign-in attempt dialog: runs one authorization attempt against the
 * browser bridge, renders the flow's notices and prompt, and reports how it
 * settled.
 *
 * The host interaction cannot be pushed to the browser (forwarded events are
 * core-owned), so the dialog polls the attempt handle while it is open.
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AuthorizationNoticeView, AuthorizationPromptView, AuthorizationSettlementView,
} from '@deepseek-ai/dsh-authorization-web/types'
import type { Translate } from './provider-card.tsx'
import type { AuthorizationRemote } from './remote.ts'
import css from './dialog.module.css'

/** Polling cadence for attempt output. */
const POLL_INTERVAL_MS = 250

/** Props of the attempt dialog. */
export interface AuthorizationDialogProps {
  /** Whether the dialog is showing. */
  open: boolean
  /** Dialog heading, e.g. "Sign in · OpenAI Codex". */
  title: string
  /** The credential record to authorize (`llm-pi-ai/openai-codex`). */
  credentialKey: string
  /** One of the flow's login methods (the flow's first, most preferred). */
  method: string
  /** The mounted `authorization` remote namespace. */
  authorization: AuthorizationRemote
  /** Locale copy. */
  t: Translate
  /** Whether the selected method stores an API key rather than using browser OAuth. */
  apiKeyMethod: boolean
  /** Notify the card after the host confirms that the credential was stored. */
  onAuthorized: () => void
  /** Dismiss the dialog (also withdraws a still-running attempt). */
  onClose: () => void
}

/**
 * Render one authorization attempt.
 * @param props - the attempt identity, remote, copy, and close handler.
 * @returns the modal, or null while closed.
 */
export function AuthorizationDialog(props: AuthorizationDialogProps): ReactElement | null {
  const { open, title, credentialKey, method, authorization, t, apiKeyMethod, onAuthorized, onClose } = props
  const [notices, setNotices] = useState<readonly AuthorizationNoticeView[]>([])
  const [prompt, setPrompt] = useState<AuthorizationPromptView | null>(null)
  const [settled, setSettled] = useState<AuthorizationSettlementView | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const handleRef = useRef<string | undefined>(undefined)
  const settledRef = useRef<boolean>(false)
  const pollInFlightRef = useRef(false)
  const cancelRequestedRef = useRef(false)
  const beginPendingRef = useRef(false)
  const onAuthorizedRef = useRef(onAuthorized)
  onAuthorizedRef.current = onAuthorized

  useEffect(() => {
    if (!open) return
    setNotices([])
    setPrompt(null)
    setSettled(undefined)
    setError(undefined)
    setValue('')
    setBusy(false)
    settledRef.current = false
    pollInFlightRef.current = false
    cancelRequestedRef.current = false
    beginPendingRef.current = true
    handleRef.current = undefined
    let alive = true

    const poll = (): void => {
      const handle = handleRef.current
      if (handle === undefined || settledRef.current || pollInFlightRef.current) return
      pollInFlightRef.current = true
      void authorization.poll(handle)
        .then((response) => {
          if (!alive) return
          if (!response.ok) {
            if (response.error.code === 'authorization/unknown-handle') {
              settledRef.current = true
              setError(response.error.message)
            }
            return
          }
          const view = response.value
          if (view.notices.length > 0) setNotices(previous => [...previous, ...view.notices])
          if (view.prompt !== null) {
            setPrompt(previous => previous?.promptId === view.prompt?.promptId ? previous : view.prompt)
          } else if (view.settled === undefined) {
            setPrompt(null)
          }
          if (view.settled !== undefined) {
            settledRef.current = true
            setSettled(view.settled)
            setPrompt(null)
            if (view.settled.status === 'authorized') onAuthorizedRef.current()
          }
        })
        .catch(() => { /* a transient poll failure is retried on the next tick */ })
        .finally(() => { pollInFlightRef.current = false })
    }
    const timer = window.setInterval(poll, POLL_INTERVAL_MS)

    authorization.begin(credentialKey, method)
      .then((response) => {
        beginPendingRef.current = false
        if (!response.ok) {
          if (cancelRequestedRef.current) {
            onClose()
          } else if (alive) {
            settledRef.current = true
            setError(response.error.message)
          }
          return
        }
        handleRef.current = response.value.handle
        if (!alive || cancelRequestedRef.current) {
          void authorization.cancel(response.value.handle).finally(() => {
            settledRef.current = true
            handleRef.current = undefined
            if (cancelRequestedRef.current) onClose()
          })
          return
        }
        poll()
      })
      .catch(() => {
        beginPendingRef.current = false
        if (cancelRequestedRef.current) {
          onClose()
        } else if (alive) {
          settledRef.current = true
          setError(t('failed'))
        }
      })

    return () => {
      alive = false
      window.clearInterval(timer)
      const handle = handleRef.current
      if (!settledRef.current) {
        cancelRequestedRef.current = true
        if (handle !== undefined) void authorization.cancel(handle)
      }
    }
  }, [open, credentialKey, method, authorization, t])

  const submitPrompt = (promptId: string, answer: string): void => {
    const handle = handleRef.current
    if (handle === undefined || busy) return
    setBusy(true)
    void authorization.answer(handle, promptId, answer)
      .then((response) => {
        if (response.ok) {
          setPrompt(null)
          setValue('')
        } else {
          setError(response.error.message)
        }
      })
      .catch(() => { setError(t('failed')) })
      .finally(() => { setBusy(false) })
  }

  const requestClose = (): void => {
    if (settled === undefined && error === undefined) {
      cancelRequestedRef.current = true
      const handle = handleRef.current
      if (handle !== undefined) {
        void authorization.cancel(handle).finally(() => {
          settledRef.current = true
          handleRef.current = undefined
          onClose()
        })
        return
      }
      if (beginPendingRef.current) return
    }
    onClose()
  }

  const footer: ReactNode = settled !== undefined || error !== undefined
    ? (
      <Button variant="outline" onClick={onClose}>
        {t('close')}
      </Button>
    )
    : undefined

  return (
    <Modal
      open={open}
      onClose={requestClose}
      title={title}
      closeLabel={t('close')}
      description={t(apiKeyMethod ? 'apiKeyDescription' : 'signInDescription')}
      contentClassName={css['scrollContent'] ?? ''}
      footer={footer}
    >
      <div aria-live="polite">
        {notices.map((notice, index) => <NoticeRow key={index} notice={notice} t={t} />)}
      </div>
      {prompt !== null && (
        <PromptForm
          prompt={prompt}
          value={value}
          busy={busy}
          onValue={setValue}
          onSubmit={(answer) => { submitPrompt(prompt.promptId, answer) }}
          onCancel={requestClose}
          t={t}
        />
      )}
      {settled !== undefined && (
        <p role="status">{settlementLabel(settled, t)}</p>
      )}
      {error !== undefined && <p role="alert">{error}</p>}
      {settled === undefined && error === undefined && prompt === null && (
        <p role="status">{t('inProgress')}</p>
      )}
    </Modal>
  )
}

/** Accept only external web links in provider notices. */
function safeHref(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : undefined
  } catch {
    return undefined
  }
}

/** One notice row: message, optional page link, optional verification code. */
function NoticeRow({ notice, t }: { notice: AuthorizationNoticeView; t: Translate }): ReactElement {
  const href = notice.url === undefined ? undefined : safeHref(notice.url)
  return (
    <div>
      <p>{notice.message}</p>
      {href !== undefined && (
        <p><a href={href} target="_blank" rel="noopener noreferrer">{t('openPage')}</a></p>
      )}
      {notice.code !== undefined && <p><code>{notice.code}</code></p>}
    </div>
  )
}

/** The prompt form: text/secret input or select options. */
function PromptForm(props: {
  prompt: AuthorizationPromptView
  value: string
  busy: boolean
  onValue: (value: string) => void
  onSubmit: (value: string) => void
  onCancel: () => void
  t: Translate
}): ReactElement {
  const { prompt, value, busy, onValue, onSubmit, onCancel, t } = props
  if (prompt.kind === 'select') {
    return (
      <div role="group" aria-label={prompt.message}>
        <p>{prompt.message}</p>
        <div className={css['promptOptions']}>
          {(prompt.options ?? []).map((option, index) => (
            <Button
              key={option.id}
              type="button"
              variant="outline"
              size="sm"
              className={css['promptOption']}
              autoFocus={index === 0}
              disabled={busy}
              onClick={() => { onSubmit(option.id) }}
            >
              <span>{option.label}</span>
              {option.description !== undefined && <small>{option.description}</small>}
            </Button>
          ))}
        </div>
        <div className={css['promptActions']}>
          <Button variant="ghost" type="button" disabled={busy} onClick={onCancel}>
            {t('cancel')}
          </Button>
        </div>
      </div>
    )
  }
  return (
    <form
      className={css['promptForm']}
      onSubmit={(event) => {
        event.preventDefault()
        if (value.length > 0) onSubmit(value)
      }}
    >
      <label className={css['promptLabel']}>
        {prompt.message}
        <input
          className={css['promptInput']}
          type={prompt.kind === 'secret' ? 'password' : 'text'}
          value={value}
          placeholder={prompt.placeholder ?? t('promptPlaceholder')}
          autoFocus
          onChange={(event) => { onValue(event.target.value) }}
        />
      </label>
      <div className={css['promptActions']}>
        <Button variant="primary" type="submit" disabled={busy || value.length === 0}>
          {t('promptSubmit')}
        </Button>
        <Button variant="ghost" type="button" disabled={busy} onClick={onCancel}>
          {t('cancel')}
        </Button>
      </div>
    </form>
  )
}

/** Localized label for one terminal settlement. */
function settlementLabel(settled: AuthorizationSettlementView, t: Translate): string {
  switch (settled.status) {
    case 'authorized': return t('authorized')
    case 'cancelled': return t('cancelled')
    default: return settled.message === undefined ? t('failed') : `${t('failed')}: ${settled.message}`
  }
}
