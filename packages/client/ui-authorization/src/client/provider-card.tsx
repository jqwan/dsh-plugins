/**
 * The Models-page provider-card login surface: one sign-in button per provider
 * row whose `llm-pi-ai/<id>` credential has a registered authorization flow,
 * opening the attempt dialog.
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProviderCardExtrasOwnerProps } from '@deepseek-ai/dsh-client-ui-settings-models/client'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AuthorizationEntryView } from '@deepseek-ai/dsh-authorization-web/types'
import type { AuthorizationKey } from './locales.ts'
import type { AuthorizationRemote } from './remote.ts'
import { AuthorizationDialog } from './dialog.tsx'
import css from './provider-card.module.css'

/** Props the renderer binds for one provider-card occurrence. */
export type ProviderCardExtrasProps =
  PropsRuntime<'settings.models.provider-card'>
  & PropsLocale<'authorization'>
  & InjectFace<ProviderCardExtrasFace>

/** The business face this registrant injects. */
export interface ProviderCardExtrasFace {
  /** The mounted `authorization` remote namespace. */
  authorization: AuthorizationRemote
}

type ProviderDirectoryIdentity = ProviderCardExtrasOwnerProps['provider']

/** The credential record key of one provider route (`llm-pi-ai/<id>`). */
export function credentialKeyOf(provider: ProviderDirectoryIdentity): string {
  return `llm-pi-ai/${provider.provider}`
}

/** Translate seat narrowed to this package's dictionary. */
export type Translate = (key: AuthorizationKey) => string

/**
 * Render the sign-in affordance for one provider card.
 * @param props - the card's directory row, the injected authorization remote, and locale copy.
 * @returns the login button (and its dialog), or nothing when the provider has no login flow.
 */
export function ProviderCardExtras(props: ProviderCardExtrasProps): ReactElement | null {
  const { provider, keyConfigured, authorization, t } = props
  const key = credentialKeyOf(provider)
  const [entry, setEntry] = useState<AuthorizationEntryView | null | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [signOutError, setSignOutError] = useState<string | undefined>(undefined)

  useEffect(() => {
    let alive = true
    setEntry(undefined)
    authorization.describe(key)
      .then((response) => {
        if (alive && response.ok) setEntry(response.value)
      })
      .catch((_error: unknown) => {
        if (alive) setEntry(null)
      })
    return () => { alive = false }
  }, [authorization, key])

  // A key-configured provider needs no OAuth login (its api-key credential
  // already authenticates the route); a provider without a flow has nothing
  // to sign into. Undefined hides the affordance while the flow lookup is in
  // flight.
  if (keyConfigured || entry === undefined || entry === null || entry.methods.length === 0) return null
  if (entry.configured) {
    return (
      <span className={css['connectedGroup']}>
        <span className={css['connectedStatus']} role="status">
          <StateDot state="done" />
          {t('connected')}
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={signingOut}
          onClick={() => {
            setSigningOut(true)
            setSignOutError(undefined)
            void authorization.signOut(key)
              .then((response) => {
                if (response.ok) {
                  setEntry(previous => previous === null || previous === undefined
                    ? previous
                    : { ...previous, configured: false })
                } else {
                  setSignOutError(response.error.message)
                }
              })
              .catch((error: unknown) => {
                setSignOutError(error instanceof Error ? error.message : String(error))
              })
              .finally(() => { setSigningOut(false) })
          }}
        >
          {t('signOut')}
        </Button>
        {signOutError !== undefined && <span role="alert">{signOutError}</span>}
      </span>
    )
  }
  const method = entry.methods[0] as { id: string }
  const apiKeyMethod = method.id === 'api-key'

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={entry.inFlight}
        onClick={() => {
          setEntry(previous => previous === null || previous === undefined
            ? previous
            : { ...previous, inFlight: true })
          setOpen(true)
        }}
      >
        {apiKeyMethod ? t('configureApiKey') : t('signIn')}
      </Button>
      <AuthorizationDialog
        open={open}
        title={`${apiKeyMethod ? t('configureApiKey') : t('signInTitle')} · ${provider.displayName}`}
        credentialKey={key}
        method={method.id}
        authorization={authorization}
        t={t}
        apiKeyMethod={apiKeyMethod}
        onAuthorized={() => {
          setEntry(previous => previous === null || previous === undefined
            ? previous
            : { ...previous, configured: true, inFlight: false })
        }}
        onClose={() => {
          setOpen(false)
          void authorization.describe(key)
            .then((response) => {
              if (response.ok) setEntry(response.value)
            })
            .catch(() => { setEntry(null) })
        }}
      />
    </>
  )
}
