/**
 * 会话底部便签：便签属于全局资源，底部栏显示当前任务的便签配置，
 * 因而同一任务的所有子会话共享增删结果。便签内容可粘贴到输入框，
 * 也可直接发送；编辑始终修改全局便签。
 */

import { useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type WbNote } from './api.ts'
import { ICONS, Modal, TASK_COLORS, colorClass, useWorkbenchData } from './ui.tsx'
import css from './workbench.module.css'

export interface PinnedNotesBarProps {
  /** 当前会话所属任务；任务配置由所有子会话共享。 */
  current: { taskId: string; sessionId: string } | null
  /** 将便签内容追加到当前会话输入框，而不是发送。 */
  onPaste?: (text: string) => void
  className?: string
}

export function PinnedNotesBar(props: PinnedNotesBarProps): ReactElement | null {
  const data = useWorkbenchData()
  const [sending, setSending] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [editing, setEditing] = useState<WbNote | null>(null)
  const addRef = useRef<HTMLButtonElement | null>(null)
  const current = props.current
  const task = current ? data.tasks.find((item) => item.id === current.taskId) : null
  const taskNoteIds = task?.noteIds || []
  const notes = useMemo(() => {
    const byId = new Map(data.notes.map((note) => [note.id, note]))
    return taskNoteIds.map((id) => byId.get(id)).filter((note): note is WbNote => Boolean(note && note.status !== 'archived'))
  }, [data.notes, taskNoteIds])
  const candidates = useMemo(
    () => data.notes.filter((note) => note.status !== 'archived').sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [data.notes],
  )

  if (!current || !task) return null

  const updateTaskNotes = (next: string[]) => {
    void api(`/tasks/${task.id}`, { method: 'PUT', body: { noteIds: next } }).catch(() => {})
  }
  const togglePin = (note: WbNote) => {
    const has = taskNoteIds.includes(note.id)
    updateTaskNotes(has ? taskNoteIds.filter((id) => id !== note.id) : [...taskNoteIds, note.id])
  }
  const send = (note: WbNote) => {
    setSending(note.id)
    void api(`/notes/${note.id}/send`, { method: 'POST', body: { taskId: current.taskId, sessionId: current.sessionId, mode: 'current' } })
      .catch((error: unknown) => { console.error('[workbench] 发送便签失败', error) })
      .finally(() => setSending(null))
  }
  const menuItems: MenuEntry[] = candidates.map((note) => ({
    id: note.id,
    label: note.title || '未命名便签',
    icon: <span className={`${css.cDot} ${colorClass(note.color)}`} />,
  }))

  return (
    <div className={`${css.notesBar}${props.className ? ` ${props.className}` : ''}`}>
      <button ref={addRef} type="button" className={css.noteAdd} title="管理当前任务便签" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>{ICONS.pin}</button>
      <Menu open={menuOpen} portal anchor={null} getAnchorRect={() => addRef.current?.getBoundingClientRect() ?? null} align="start" side="top" dense items={menuItems}
        footer={[{ id: '::create', label: '新建便签…', icon: <span>＋</span> }]}
        selectedIds={taskNoteIds}
        onSelect={(id) => {
          if (id === '::create') { setMenuOpen(false); setEditing({ id: '', title: '', description: '', color: 'yellow', deadline: null, overdue: false, status: 'active', createdAt: '', updatedAt: '' }); return }
          const note = candidates.find((item) => item.id === id)
          if (note) togglePin(note)
        }} onClose={() => setMenuOpen(false)}
      />
      {notes.map((note) => (
        <div key={note.id} className={css.noteChipWrap}>
          <div className={css.noteChip} title={note.description ? `便签：${note.description}` : '未命名便签'}>
            <span className={`${css.cDot} ${colorClass(note.color)}`} />
            <span className={css.noteChipLabel}>{note.title || '未命名便签'}</span>
          </div>
          <div className={css.noteChipActions} role="toolbar" aria-label={`${note.title || '便签'}操作`}>
            <button type="button" title="粘贴到输入框" aria-label="粘贴到输入框" onClick={() => { props.onPaste?.(note.description) }}>↳</button>
            <button type="button" title="直接发送" aria-label="直接发送" disabled={sending === note.id} onClick={() => send(note)}>↑</button>
            <button type="button" title="编辑便签" aria-label="编辑便签" onClick={() => setEditing(note)}>✎</button>
          </div>
        </div>
      ))}
      {editing ? <NoteEditorModal note={editing.id ? editing : null} taskId={task.id} currentNoteIds={taskNoteIds} onClose={() => setEditing(null)} /> : null}
    </div>
  )
}

function NoteEditorModal(props: { note: WbNote | null; taskId?: string; currentNoteIds?: string[]; onClose: () => void }): ReactElement {
  const [title, setTitle] = useState(props.note?.title || '')
  const [description, setDescription] = useState(props.note?.description || '')
  const [color, setColor] = useState(props.note?.color || 'yellow')
  const [error, setError] = useState('')
  const submit = () => {
    if (!description.trim()) { setError('便签内容不能为空'); return }
    void api(props.note ? `/notes/${props.note.id}` : '/notes', { method: props.note ? 'PUT' : 'POST', body: { title, description, color } })
      .then((payload) => {
        if (!props.note && props.taskId && payload?.note?.id) {
          return api(`/tasks/${props.taskId}`, { method: 'PUT', body: { noteIds: [...new Set([...(props.currentNoteIds || []), payload.note.id])] } })
        }
        return null
      })
      .then(() => props.onClose()).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
  }
  return <Modal title={props.note ? '编辑便签' : '新建便签'} onClose={props.onClose}>
    <div className={css.field}><span className={css.label}>标题</span><input className={css.input} value={title} onChange={(event) => setTitle(event.target.value)} autoFocus /></div>
    <div className={css.field}><span className={css.label}>内容</span><textarea className={css.textarea} value={description} onChange={(event) => setDescription(event.target.value)} /></div>
    <div className={css.field}><span className={css.label}>颜色</span><div className={css.colorRow}>{TASK_COLORS.map((item) => <button key={item} type="button" className={`${css.colorPick} ${colorClass(item)}${color === item ? ` ${css.active}` : ''}`} onClick={() => setColor(item)} title={item} />)}</div></div>
    {error ? <p className={css.errorText}>{error}</p> : null}
    <div className={css.modalActions}><button type="button" className={css.btn} onClick={props.onClose}>取消</button><button type="button" className={`${css.btn} ${css.primary}`} disabled={!description.trim()} onClick={submit}>{props.note ? '保存' : '创建并加入任务'}</button></div>
  </Modal>
}

interface DockSessionProps { sessionId?: string; useInput: (selector: (state: { draft: string }) => string) => string; inputActions?: { setDraft?: (text: string) => void } }

export function WorkbenchNotesDock(props: PropsRuntime<'conversation.composer.dock'>): ReactElement | null {
  const data = useWorkbenchData()
  const runtime = props as unknown as DockSessionProps
  const nativeSessionId = runtime.sessionId
  // 会话作用域插槽必带 useInput，且只能在渲染期调用——事件处理器里调用 hook
  // 会抛 Invalid hook call，这是 dsh 便签“粘贴到输入框”此前失效的原因。
  // 选中原始字符串（而非对象快照），避免每次读取产生新引用导致循环重渲。
  const draftRef = useRef('')
  draftRef.current = runtime.useInput((state) => state.draft)
  const current = useMemo((): { taskId: string; sessionId: string } | null => {
    if (!nativeSessionId) return null
    for (const task of data.tasks) {
      const session = task.sessions.find((item) => item.dshSessionId === nativeSessionId && item.status === 'active')
      if (session) return { taskId: task.id, sessionId: session.id }
    }
    return null
  }, [nativeSessionId, data.tasks])
  const paste = (text: string) => {
    const draft = draftRef.current
    runtime.inputActions?.setDraft?.(draft ? `${draft}\n${text}` : text)
  }
  return <PinnedNotesBar current={current} onPaste={paste} className={css.notesDock} />
}
