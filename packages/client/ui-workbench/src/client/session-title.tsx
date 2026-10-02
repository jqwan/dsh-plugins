/** Shared task/session title controls for native dsh and pi headers. */
import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { api, refresh, type WbTask, type WbSession } from './api.ts'
import { createWorkbenchStore, taskToForm } from './store.ts'
import { chatT } from './pi-locale.ts'
import native from './dsh-chat/ConversationRoot.module.css'
import css from './workbench.module.css'
import { useWorkbenchData } from './ui.tsx'

export function SessionTitle({ task, session, editTask }: { task: WbTask; session: WbSession; editTask: () => void }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(session.title)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const cancelled = useRef(false)
  const commit = () => {
    if (pending.current || cancelled.current) return
    const next = title.trim()
    if (!next) { setError(chatT('header.emptyName')); return }
    if (next === session.title) { setEditing(false); return }
    pending.current = true
    setBusy(true)
    setError('')
    void api(`/tasks/${task.id}/sessions/${session.id}`, { method: 'PATCH', body: { title: next } })
      .then(() => refresh())
      .then(() => setEditing(false))
      .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => { pending.current = false; setBusy(false) })
  }
  return (
    <span className={native.crumbSeg} data-workbench-session-title="">
      <button type="button" className={native.crumb} title={chatT('header.editTask')} onClick={editTask}>{task.title}</button>
      <span className={native.crumbSep}>/</span>
      {editing ? (
        <input className={`${native.crumb} ${css.crumbEdit}`} value={title} maxLength={80} autoFocus disabled={busy}
          aria-label={chatT('header.sessionName')} aria-invalid={Boolean(error)} title={error || undefined}
          onFocus={event => event.currentTarget.select()}
          onChange={event => setTitle(event.target.value)}
          onBlur={commit}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter') { event.preventDefault(); commit() }
            else if (event.key === 'Escape') { event.preventDefault(); cancelled.current = true; setEditing(false); setError('') }
          }} />
      ) : (
        <button type="button" className={`${native.crumb} ${native.crumbCurrent}`} title={chatT('header.rename')} onClick={() => { cancelled.current = false; setTitle(session.title); setError(''); setEditing(true) }}>{session.title}</button>
      )}
      {error && <span role="alert" className={css.errorText}>{error}</span>}
    </span>
  )
}

/** Root-owned title portal preserves the native header's tabs and utilities. */
export function WorkbenchSessionTitle(props: PropsStore<ReturnType<typeof createWorkbenchStore>> & { sessionId?: string }) {
  const { tasks } = useWorkbenchData()
  const [target, setTarget] = useState<HTMLElement | null>(null)
  const task = tasks.find(task => task.sessions.some(session => session.dshSessionId === props.sessionId))
  const session = task?.sessions.find(session => session.dshSessionId === props.sessionId)
  useLayoutEffect(() => {
    if (!task || !session) return
    const host = document.createElement('span')
    host.dataset.workbenchTitleHost = ''
    let current: HTMLElement | null = null
    const mount = () => {
      const nav = document.querySelector<HTMLElement>('[data-slot="conversation.session.header"] header nav')
      if (nav === current) return
      if (current) delete current.dataset.workbenchTitle
      host.remove()
      current = nav
      if (nav) { nav.append(host); nav.dataset.workbenchTitle = ''; setTarget(host) }
      else setTarget(null)
    }
    mount()
    const observer = new MutationObserver(mount)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => { observer.disconnect(); if (current) delete current.dataset.workbenchTitle; host.remove(); setTarget(null) }
  }, [task?.id, session?.id])
  return target && task && session ? createPortal(<SessionTitle key={session.id} task={task} session={session} editTask={() => props.actions.setTaskForm(taskToForm(task))} />, target) : null
}
