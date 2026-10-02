/**
 * 中心区看板集合：任务看板、便签看板、会话看板、统计、回收站、设置。
 * v1 提供完整的核心操作（建/改/状态流转/归档恢复/发送到会话），视觉与
 * 交互细节在一期 iframe 退役前持续对齐。
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import type { PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { api, type WbNote, type WbSession, type WbTask } from './api.ts'
import { createWorkbenchStore, EMPTY_TASK_FORM, taskToForm, type TaskFormState } from './store.ts'
import { ICONS, Masonry, Modal, StateChip, TASK_COLORS, colorClass, relativeTime, useWorkbenchData, type SessionVisualState } from './ui.tsx'
import { NoteScheduleDialog, NoteSendDialog } from './note-send.tsx'
import css from './workbench.module.css'

/** 看板统一的会话打开回调：由中心面实现（含视图切换）。 */
export type OpenSessionFn = (taskId: string, sessionId: string) => void

/** 会话四色状态判定（中心面注入：warning/error/ongoing/done 或 null）。 */
export type StateOf = (task: WbTask, session: WbSession) => SessionVisualState | null

/** 看板共享 store 的读写面（中心面传入）。 */
type StoreHandle = ReturnType<typeof createWorkbenchStore>
export type BoardStoreProps = {
  useStore: PropsStore<StoreHandle>['useStore']
  actions: PropsStore<StoreHandle>['actions']
}

// ========== 任务看板 ==========

type TaskFilter = 'unfinished' | 'done' | 'archived'

/** 任务看板：筛选 + 分组/排序（各看板状态持久化）+ 组即列布局。 */
export function TasksBoard(props: {
  openSession: OpenSessionFn
  createSession: (taskId: string) => void
  openTaskForm: (form: TaskFormState) => void
  store: BoardStoreProps
  stateOf: StateOf
}): ReactElement {
  const data = useWorkbenchData()
  const [error, setError] = useState('')
  const { useStore, actions } = props.store
  const filter = useStore((state) => state.taskBoard.filter)
  const groupBy = useStore((state) => state.taskBoard.groupBy)
  const sortBy = useStore((state) => state.taskBoard.sortBy)

  const sortTasks = (list: WbTask[]) => [...list].sort((left, right) => {
    if (sortBy === 'title') return left.title.localeCompare(right.title, 'zh-CN')
    return right.updatedAt.localeCompare(left.updatedAt)
  })

  const groups = useMemo(() => {
    const tasks = data.tasks.filter((task) => task.status === filter)
    const sorted = sortTasks(tasks)
    if (groupBy === 'none') return [{ key: '', label: '', tasks: sorted }]
    if (groupBy === 'color') {
      const COLOR_LABELS: Record<string, string> = { red: '红色', orange: '橙色', yellow: '黄色', green: '绿色', cyan: '青色', blue: '蓝色', purple: '紫色', gray: '灰色' }
      const byColor = new Map<string, WbTask[]>()
      for (const task of sorted) {
        const bucket = byColor.get(task.color) ?? []
        bucket.push(task)
        byColor.set(task.color, bucket)
      }
      return [...byColor.entries()].map(([key, list]) => ({
        key,
        label: COLOR_LABELS[key] || (key.startsWith('custom-') ? '自定义颜色' : key),
        tasks: list,
      }))
    }
    const byPath = new Map<string, WbTask[]>()
    for (const task of sorted) {
      for (const path of (task.workingDirs?.length ? task.workingDirs : task.workingDir ? [task.workingDir] : ['未设置工作路径'])) {
        const bucket = byPath.get(path) ?? []
        bucket.push(task)
        byPath.set(path, bucket)
      }
    }
    return [...byPath.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([key, list]) => ({ key, label: key, tasks: list }))
  }, [data.tasks, filter, groupBy, sortBy])

  const act = async (fn: () => Promise<unknown>) => {
    try { await fn() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  const openEditForm = (task: WbTask) => {
    setError('')
    props.openTaskForm(taskToForm(task))
  }

  return (
    <>
      <div className={css.boardBar}>
        <div className={css.tabs}>
          {(['unfinished', 'done', 'archived'] as TaskFilter[]).map((key) => (
            <button key={key} type="button" className={`${css.tab}${filter === key ? ` ${css.active}` : ''}`} onClick={() => actions.setTaskBoard({ filter: key })}>
              {key === 'unfinished' ? '进行中' : key === 'done' ? '已完成' : '废弃'}
            </button>
          ))}
        </div>
        <select className={`${css.select} ${css.toolSelect}`} value={groupBy} title="分组方式" onChange={(event) => actions.setTaskBoard({ groupBy: event.target.value as 'none' | 'path' | 'color' })}>
          <option value="none">不分组</option>
          <option value="path">按工作路径</option>
          <option value="color">按颜色</option>
        </select>
        <select className={`${css.select} ${css.toolSelect}`} value={sortBy} title="排序方式" onChange={(event) => actions.setTaskBoard({ sortBy: event.target.value as 'updated' | 'title' })}>
          <option value="updated">最近更新</option>
          <option value="title">标题</option>
        </select>
        <span className={css.boardBarSpacer} />
        <button type="button" className={`${css.btn} ${css.primary}`} onClick={() => props.openTaskForm({ ...EMPTY_TASK_FORM })}>新建任务</button>
      </div>
      <div className={css.boardBody}>
        {error ? <p className={css.errorText}>{error}</p> : null}
        {groups.some((group) => group.tasks.length) ? (
          groupBy === 'none' ? (
            <Masonry
              items={groups[0].tasks}
              keyOf={(task) => task.id}
              minWidth={250}
              renderItem={(task) => (
                <TaskCard task={task} filter={filter} onCreateSession={props.createSession} onEdit={() => openEditForm(task)} openSession={props.openSession} act={act} stateOf={props.stateOf} />
              )}
            />
          ) : (
            <Masonry
              items={groups}
              keyOf={(group) => group.key}
              minWidth={320}
              renderItem={(group) => (
                <section className={css.boardColumn}>
                  <header className={css.boardColumnHead}>
                    <span className={css.boardColumnBadge}>{group.label}</span>
                    <b className={css.boardColumnCount}>{group.tasks.length}</b>
                  </header>
                  <Masonry
                    items={group.tasks}
                    keyOf={(task) => task.id}
                    minWidth={230}
                    renderItem={(task) => (
                      <TaskCard task={task} filter={filter} onCreateSession={props.createSession} onEdit={() => openEditForm(task)} openSession={props.openSession} act={act} stateOf={props.stateOf} />
                    )}
                  />
                </section>
              )}
            />
          )
        ) : (
          <div className={css.empty}>暂无{filter === 'unfinished' ? '进行中' : filter === 'done' ? '已完成' : '废弃'}任务</div>
        )}
      </div>
    </>
  )
}

function TaskCard(props: {
  task: WbTask
  filter: TaskFilter
  onCreateSession: (taskId: string) => void
  onEdit: () => void
  openSession: (taskId: string, sessionId: string) => void
  act: (fn: () => Promise<unknown>) => Promise<void>
  stateOf: StateOf
}): ReactElement {
  const { task, filter, onCreateSession, onEdit, openSession, act, stateOf } = props
  const active = task.sessions.filter((session) => session.status === 'active')
  const states = active.map((session) => stateOf(task, session)).filter(Boolean)
  const reminded = states.some((visual) => visual?.state === 'done')
  const failed = states.filter((visual) => visual?.state === 'error').length
  const running = states.filter((visual) => visual?.state === 'ongoing').length
  const recent = active.find((session) => session.id === task.activeSessionId) || active[0]
  return (
    <div className={css.card}>
      <span className={`${css.stripe} ${colorClass(task.color)}`} />
      <div className={css.cardTop}>
        {task.status !== 'archived' ? (
          <span className={`${css.statusIcon} ${task.status === 'done' ? css.done : css.unfinished}`}>{task.status === 'done' ? ICONS.statusDone : ICONS.statusUnfinished}</span>
        ) : null}
        <h3 className={css.cardTitle}>{task.title}</h3>
      </div>
      {task.description ? <p className={css.cardDesc}>{task.description}</p> : null}
      <div className={css.cardMeta}>
        {task.deadline ? <span className={task.overdue ? css.metaBad : undefined}>提醒 {task.deadline}</span> : null}
        <span>{active.length} 会话</span>
        {reminded ? <StateChip visual={{ state: 'done', label: '有新回复' }} /> : null}
        {failed > 0 ? <StateChip visual={{ state: 'error', label: failed + ' 个连接错误' }} /> : null}
        {running > 0 ? <StateChip visual={{ state: 'ongoing', label: running + ' 个运行中' }} /> : null}
      </div>
      <div className={css.cardActions}>
        {filter !== 'archived' && recent ? (
          <button type="button" className={css.iconAction} title="打开最近会话" onClick={() => openSession(task.id, recent.id)}>{ICONS.openArrow}</button>
        ) : null}
        {filter !== 'archived' ? (
          <button type="button" className={css.iconAction} title="新建会话" onClick={() => onCreateSession(task.id)}>＋</button>
        ) : null}
        {filter === 'unfinished' ? (
          <button type="button" className={`${css.iconAction} ${css.iconOk}`} title="标记完成" onClick={() => void act(() => api(`/tasks/${task.id}/complete`, { method: 'POST', body: {} }))}>{ICONS.check}</button>
        ) : null}
        {filter === 'done' ? (
          <button type="button" className={css.iconAction} title="重新打开" onClick={() => void act(() => api(`/tasks/${task.id}/reopen`, { method: 'POST', body: {} }))}>{ICONS.undo}</button>
        ) : null}
        {filter !== 'archived' ? (
          <button type="button" className={css.iconAction} title="编辑" onClick={onEdit}>{ICONS.pencil}</button>
        ) : null}
        {filter !== 'archived' ? (
          <button type="button" className={`${css.iconAction} ${css.iconDanger}`} title="移入回收站" onClick={() => void act(() => api(`/tasks/${task.id}`, { method: 'DELETE' }))}>{ICONS.archive}</button>
        ) : (
          <>
            <button type="button" className={css.iconAction} title="恢复" onClick={() => void act(() => api(`/tasks/${task.id}/restore`, { method: 'POST', body: {} }))}>{ICONS.undo}</button>
            <button type="button" className={`${css.iconAction} ${css.iconDanger}`} title="永久删除" onClick={() => void act(() => api(`/tasks/${task.id}/permanent`, { method: 'DELETE' }))}>{ICONS.trash}</button>
          </>
        )}
      </div>
    </div>
  )
}

// ========== 便签看板 ==========

interface NoteFormState { id?: string; title: string; description: string; deadline: string; color: string }
const EMPTY_NOTE_FORM: NoteFormState = { title: '', description: '', deadline: '', color: 'yellow' }

/** 便签看板：卡片 + 编辑 + 放到会话底部。 */
export function NotesBoard(props: { openSession: OpenSessionFn; store: BoardStoreProps }): ReactElement {
  const data = useWorkbenchData()
  const { useStore, actions } = props.store
  const notesFilter = useStore((state) => state.notesFilter)
  const [form, setForm] = useState<NoteFormState | null>(null)
  const [sendNote, setSendNote] = useState<WbNote | null>(null)
  const [scheduleNote, setScheduleNote] = useState<WbNote | null>(null)
  const [error, setError] = useState('')

  // 全部/默认/非默认都不含废弃；默认与否以"新任务默认便签"清单为准。
  const notes = useMemo(() => {
    const defaults = data.config.defaultNoteIds || []
    return data.notes.filter((note) => {
      if (notesFilter === 'archived') return note.status === 'archived'
      if (note.status === 'archived') return false
      if (notesFilter === 'default') return defaults.includes(note.id)
      if (notesFilter === 'plain') return !defaults.includes(note.id)
      return true
    })
  }, [data.notes, data.config.defaultNoteIds, notesFilter])

  const act = async (fn: () => Promise<unknown>) => {
    try { await fn() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  const submitNote = async () => {
    if (!form) return
    const body = { title: form.title, description: form.description, deadline: form.deadline || null, color: form.color }
    try {
      if (form.id) await api(`/notes/${form.id}`, { method: 'PUT', body })
      else await api('/notes', { method: 'POST', body })
      setForm(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <>
      <div className={css.boardBar}>
        <div className={css.tabs}>
          {([['all', '全部'], ['default', '默认'], ['plain', '非默认'], ['archived', '废弃']] as const).map(([key, label]) => (
            <button key={key} type="button" className={`${css.tab}${notesFilter === key ? ` ${css.active}` : ''}`} onClick={() => actions.setNotesFilter(key)}>{label}</button>
          ))}
        </div>
        <span className={css.boardBarSpacer} />
        <button type="button" className={`${css.btn} ${css.primary}`} onClick={() => { setError(''); setForm({ ...EMPTY_NOTE_FORM }) }}>新建便签</button>
      </div>
      <div className={css.boardBody}>
        {error ? <p className={css.errorText}>{error}</p> : null}
        {notes.length ? (
          <Masonry
            items={notes}
            keyOf={(note) => note.id}
            minWidth={250}
            renderItem={(note) => (
              <div key={note.id} className={css.card}>
                <span className={`${css.stripe} ${colorClass(note.color)}`} />
                <div className={css.cardTop}><h3 className={css.cardTitle}>{note.title}</h3></div>
                {note.description ? <p className={css.cardDesc}>{note.description}</p> : null}
                <div className={css.cardMeta}>
                  {note.deadline ? <span className={note.overdue ? css.metaBad : undefined}>提醒 {note.deadline}</span> : null}
                  {note.sends?.length ? <span title={`定时发送 ${note.sends.length} 项`}>⏰ {note.sends.length}</span> : null}
                  <span>{relativeTime(note.updatedAt)}</span>
                </div>
                <div className={css.cardActions}>
                  {note.status !== 'archived' ? (
                    <>
                      <button
                        type="button"
                        className={`${css.iconAction}${data.config.defaultNoteIds?.includes(note.id) ? ` ${css.iconActive}` : ''}`}
                        title={data.config.defaultNoteIds?.includes(note.id) ? '从新任务默认便签中移除' : '加入新任务默认便签'}
                        onClick={() => void act(() => api('/notes/defaults', { method: 'PUT', body: { noteIds: data.config.defaultNoteIds?.includes(note.id) ? (data.config.defaultNoteIds || []).filter((id) => id !== note.id) : [...(data.config.defaultNoteIds || []), note.id] } }))}
                      >{data.config.defaultNoteIds?.includes(note.id) ? ICONS.pinFilled : ICONS.pin}</button>
                      <button type="button" className={css.iconAction} title="立即发送到任务会话" onClick={() => setSendNote(note)}>{ICONS.send}</button>
                      <button type="button" className={css.iconAction} title="定时发送设置" onClick={() => setScheduleNote(note)}>{ICONS.clock}</button>
                      <button type="button" className={css.iconAction} title="编辑" onClick={() => { setError(''); setForm({ id: note.id, title: note.title, description: note.description || '', deadline: note.deadline || '', color: note.color }) }}>{ICONS.pencil}</button>
                      <button type="button" className={`${css.iconAction} ${css.iconDanger}`} title="移入回收站" onClick={() => void act(() => api(`/notes/${note.id}`, { method: 'DELETE' }))}>{ICONS.archive}</button>
                    </>
                  ) : (
                    <>
                      <button type="button" className={css.iconAction} title="恢复" onClick={() => void act(() => api(`/notes/${note.id}/restore`, { method: 'POST', body: {} }))}>{ICONS.undo}</button>
                      <button type="button" className={`${css.iconAction} ${css.iconDanger}`} title="永久删除" onClick={() => void act(() => api(`/notes/${note.id}/permanent`, { method: 'DELETE' }))}>{ICONS.trash}</button>
                    </>
                  )}
                </div>
              </div>
            )}
          />
        ) : (
          <div className={css.empty}>{notesFilter === 'archived' ? '回收站中没有便签' : '暂无便签'}</div>
        )}
      </div>
      {form ? (
        <Modal title={form.id ? '编辑便签' : '新建便签'} onClose={() => setForm(null)}>
          <div className={css.field}>
            <span className={css.label}>标题</span>
            <input className={css.input} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} autoFocus />
          </div>
          <div className={css.field}>
            <span className={css.label}>内容（发送到会话时作为消息文本）</span>
            <textarea className={css.textarea} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
          </div>
          <div className={css.fieldRow}>
            <div className={css.field}>
              <span className={css.label}>提醒时间</span>
              <input type="date" className={css.input} value={form.deadline} onChange={(event) => setForm({ ...form, deadline: event.target.value })} />
            </div>
            <div className={css.field}>
              <span className={css.label}>颜色</span>
              <div className={css.colorRow}>
                {TASK_COLORS.map((color) => (
                  <button key={color} type="button" className={`${css.colorPick} ${colorClass(color)}${form.color === color ? ` ${css.active}` : ''}`} onClick={() => setForm({ ...form, color })} title={color} />
                ))}
              </div>
            </div>
          </div>
          <div className={css.modalActions}>
            <button type="button" className={css.btn} onClick={() => setForm(null)}>取消</button>
            <button type="button" className={`${css.btn} ${css.primary}`} disabled={!form.description.trim()} onClick={() => void submitNote()}>保存</button>
          </div>
        </Modal>
      ) : null}
      {sendNote ? <NoteSendDialog note={sendNote} tasks={data.tasks} onClose={() => setSendNote(null)} /> : null}
      {scheduleNote ? <NoteScheduleDialog note={scheduleNote} tasks={data.tasks} onClose={() => setScheduleNote(null)} /> : null}
    </>
  )
}

// ========== 会话看板 ==========

/** 会话看板：全部活动会话的时间线视图。 */
export function SessionsBoard(props: { openSession: OpenSessionFn; stateOf: StateOf }): ReactElement {
  const data = useWorkbenchData()
  const rows = useMemo(() => {
    const all: Array<{ task: WbTask; session: WbSession }> = []
    for (const task of data.tasks) {
      if (task.status === 'archived') continue
      for (const session of task.sessions) if (session.status === 'active') all.push({ task, session })
    }
    return all.sort((left, right) => right.session.updatedAt.localeCompare(left.session.updatedAt))
  }, [data.tasks])
  return (
    <>
      <div className={css.boardBar}>
        <span className={css.boardBarSpacer} />
        <span className={css.label}>{rows.length} 个活动会话</span>
      </div>
      <div className={css.boardBody}>
        {rows.length ? (
          <Masonry
            items={rows}
            keyOf={({ session }) => session.id}
            minWidth={250}
            renderItem={({ task, session }) => (
              <div className={css.card} onClick={() => props.openSession(task.id, session.id)} role="button" tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    props.openSession(task.id, session.id)
                  }
                }}>
                <span className={`${css.stripe} ${colorClass(task.color)}`} />
                <div className={css.cardTop}>
                  <h3 className={css.cardTitle}>{session.title || '新会话'}</h3>
                  {session.kind === 'dsh' ? <span className={css.kindBadge}>dsh</span> : null}
                </div>
                <p className={css.cardDesc}>{task.title}</p>
                <div className={css.cardMeta}>
                  {props.stateOf(task, session) ? <StateChip visual={props.stateOf(task, session)!} /> : null}
                  <span>{relativeTime(session.updatedAt)}</span>
                </div>
              </div>
            )}
          />
        ) : (
          <div className={css.empty}>暂无活动会话</div>
        )}
      </div>
    </>
  )
}

// ========== 统计 ==========

/** 统计视图：任务/会话/消息/Token 的聚合概览。 */
export function StatsView(props: { stateOf: StateOf }): ReactElement {
  const data = useWorkbenchData()
  const activeTasks = data.tasks.filter((task) => task.status === 'unfinished').length
  const doneTasks = data.tasks.filter((task) => task.status === 'done').length
  const sessions = data.tasks.flatMap((task) => task.sessions.filter((session) => session.status === 'active'))
  let reminded = 0
  let failed = 0
  for (const task of data.tasks) {
    for (const session of task.sessions) {
      if (session.status !== 'active') continue
      const visual = props.stateOf(task, session)
      if (visual?.state === 'done') reminded += 1
      if (visual?.state === 'error') failed += 1
    }
  }
  const running = sessions.filter((session) => session.agentBusy).length
  const messages = sessions.reduce((sum, session) => sum + (session.stats?.messages || 0), 0)
  const tokens = sessions.reduce((sum, session) => sum + (session.stats?.input || 0) + (session.stats?.output || 0) + (session.stats?.cacheRead || 0) + (session.stats?.cacheWrite || 0), 0)
  const dshCount = sessions.filter((session) => session.kind === 'dsh').length
  const cards: Array<[string | number, string]> = [
    [activeTasks, '进行中任务'],
    [doneTasks, '已完成任务'],
    [sessions.length, '活动会话'],
    [running, '运行中会话'],
    [reminded, '有新回复会话'],
    [failed, '错误会话'],
    [messages, '消息总数'],
    [tokens, 'Token 总量'],
    [`${sessions.length - dshCount} / ${dshCount}`, 'pi / dsh 会话'],
  ]
  return (
    <>

      <div className={css.boardBody}>
        <div className={css.statsGrid}>
          {cards.map(([value, label]) => (
            <div key={label} className={css.statCard}>
              <div className={css.statValue}>{value}</div>
              <div className={css.statLabel}>{label}</div>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

// ========== 回收站 ==========

/** 回收站：废弃任务/便签/会话的恢复与永久删除。 */
export function ArchiveView(): ReactElement {
  const data = useWorkbenchData()
  const [error, setError] = useState('')
  const act = async (fn: () => Promise<unknown>) => {
    try { await fn() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const tasks = data.tasks.filter((task) => task.status === 'archived')
  const notes = data.notes.filter((note) => note.status === 'archived')
  const sessions: Array<{ task: WbTask; session: WbSession }> = []
  for (const task of data.tasks) {
    if (task.status === 'archived') continue
    for (const session of task.sessions) if (session.status === 'archived') sessions.push({ task, session })
  }
  return (
    <>
      <div className={css.boardBar}>
        <span className={css.boardBarSpacer} />
        <button type="button" className={`${css.btn} ${css.danger}`} disabled={!tasks.length && !notes.length && !sessions.length} onClick={() => void act(() => api('/archived', { method: 'DELETE', body: { type: 'all' } }))}>清空全部</button>
      </div>
      <div className={css.boardBody}>
        {error ? <p className={css.errorText}>{error}</p> : null}
        <section className={css.settingsSection}>
          <p className={css.settingsTitle}>任务（{tasks.length}）</p>
          {tasks.length ? (
            <Masonry
              items={tasks}
              keyOf={(task) => task.id}
              minWidth={250}
              renderItem={(task) => (
                <div className={css.card}>
                  <span className={`${css.stripe} ${colorClass(task.color)}`} />
                  <div className={css.cardTop}><h3 className={css.cardTitle}>{task.title}</h3></div>
                  {task.description ? <p className={css.cardDesc}>{task.description}</p> : null}
                  <div className={css.cardMeta}><span>{relativeTime(task.updatedAt)}</span></div>
                  <div className={css.cardActions}>
                    <button type="button" className={css.iconAction} title="恢复" onClick={() => void act(() => api(`/tasks/${task.id}/restore`, { method: 'POST', body: {} }))}>{ICONS.undo}</button>
                    <button type="button" className={`${css.iconAction} ${css.iconDanger}`} title="永久删除" onClick={() => void act(() => api(`/tasks/${task.id}/permanent`, { method: 'DELETE' }))}>{ICONS.trash}</button>
                  </div>
                </div>
              )}
            />
          ) : <p className={css.settingsNote}>暂无</p>}
        </section>
        <section className={css.settingsSection}>
          <p className={css.settingsTitle}>便签（{notes.length}）</p>
          {notes.length ? (
            <Masonry
              items={notes}
              keyOf={(note) => note.id}
              minWidth={250}
              renderItem={(note) => (
                <div className={css.card}>
                  <span className={`${css.stripe} ${colorClass(note.color)}`} />
                  <div className={css.cardTop}><h3 className={css.cardTitle}>{note.title}</h3></div>
                  {note.description ? <p className={css.cardDesc}>{note.description}</p> : null}
                  <div className={css.cardMeta}><span>{relativeTime(note.updatedAt)}</span></div>
                  <div className={css.cardActions}>
                    <button type="button" className={css.iconAction} title="恢复" onClick={() => void act(() => api(`/notes/${note.id}/restore`, { method: 'POST', body: {} }))}>{ICONS.undo}</button>
                    <button type="button" className={`${css.iconAction} ${css.iconDanger}`} title="永久删除" onClick={() => void act(() => api(`/notes/${note.id}/permanent`, { method: 'DELETE' }))}>{ICONS.trash}</button>
                  </div>
                </div>
              )}
            />
          ) : <p className={css.settingsNote}>暂无</p>}
        </section>
        <section className={css.settingsSection}>
          <p className={css.settingsTitle}>会话（{sessions.length}）</p>
          {sessions.length ? (
            <Masonry
              items={sessions}
              keyOf={({ session }) => session.id}
              minWidth={250}
              renderItem={({ task, session }) => (
                <div className={css.card}>
                  <span className={`${css.stripe} ${colorClass(task.color)}`} />
                  <div className={css.cardTop}>
                    <h3 className={css.cardTitle}>{session.title || '新会话'}</h3>
                    {session.kind === 'dsh' ? <span className={css.kindBadge}>dsh</span> : null}
                  </div>
                  <p className={css.cardDesc}>{task.title}</p>
                  <div className={css.cardMeta}><span>{relativeTime(session.updatedAt)}</span></div>
                  <div className={css.cardActions}>
                    {session.restorableWithTask ? (
                      <button type="button" className={css.iconAction} title="恢复" onClick={() => void act(() => api(`/tasks/${task.id}/sessions/${session.id}/restore`, { method: 'POST', body: {} }))}>{ICONS.undo}</button>
                    ) : null}
                    <button type="button" className={`${css.iconAction} ${css.iconDanger}`} title="永久删除" onClick={() => void act(() => api(`/tasks/${task.id}/sessions/${session.id}/permanent`, { method: 'DELETE' }))}>{ICONS.trash}</button>
                  </div>
                </div>
              )}
            />
          ) : <p className={css.settingsNote}>暂无</p>}
        </section>
      </div>
    </>
  )
}
