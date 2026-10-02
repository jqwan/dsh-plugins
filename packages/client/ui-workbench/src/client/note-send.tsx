/**
 * 便签发送弹窗：把便签内容发往指定任务的已有会话或新建会话。
 * NoteSendDialog 为立即发送；NoteScheduleDialog 管理定时发送设置
 * （一个便签可挂多个发送项，由服务端调度器到点投递）。
 */

import { useState } from 'react'
import type { ReactElement } from 'react'
import { api, type WbNote, type WbNoteSend, type WbTask } from './api.ts'
import { ICONS, Modal, colorClass, relativeTime, scheduleLabel, useWorkbenchData } from './ui.tsx'
import { buildSchedule, type ScheduleFormState } from './task-schedule.ts'
import css from './workbench.module.css'

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const NEW_SESSION = '::new'

/** 任务下拉（未废弃任务按最近更新排序）。 */
function TaskSelect(props: { tasks: WbTask[]; taskId: string; onPick: (taskId: string) => void }): ReactElement {
  const candidates = props.tasks.filter((task) => task.status !== 'archived')
  return (
    <select aria-label="目标任务" className={css.select} value={props.taskId} onChange={(event) => props.onPick(event.target.value)}>
      <option value="">选择任务…</option>
      {candidates.map((task) => (
        <option key={task.id} value={task.id}>{task.title || '未命名任务'}</option>
      ))}
    </select>
  )
}

/** 目标会话下拉：任务的活动会话 + “新建会话”选项；选中新建时附带引擎选择。 */
function SessionSelect(props: { task: WbTask | undefined; sessionId: string; kind: 'pi' | 'dsh'; onPick: (sessionId: string) => void; onKind: (kind: 'pi' | 'dsh') => void }): ReactElement {
  const sessions = props.task ? props.task.sessions.filter((session) => session.status === 'active') : []
  return (
    <>
      <select aria-label="目标会话" className={css.select} value={props.sessionId} onChange={(event) => props.onPick(event.target.value)}>
        <option value={NEW_SESSION}>新建会话</option>
        {sessions.map((session) => (
          <option key={session.id} value={session.id}>{session.title || '新会话'}</option>
        ))}
      </select>
      {props.sessionId === NEW_SESSION ? (
        <select aria-label="会话引擎" className={css.select} value={props.kind} onChange={(event) => props.onKind(event.target.value as 'pi' | 'dsh')}>
          <option value="dsh">dsh</option>
          <option value="pi">pi</option>
        </select>
      ) : null}
    </>
  )
}

export function NoteSendDialog(props: { note: WbNote; tasks: WbTask[]; onClose: () => void }): ReactElement {
  const [taskId, setTaskId] = useState('')
  const [sessionId, setSessionId] = useState(NEW_SESSION)
  const [kind, setKind] = useState<'pi' | 'dsh'>('dsh')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const task = props.tasks.find((item) => item.id === taskId)
  const submit = async () => {
    if (!task) { setError('请选择任务'); return }
    setSending(true); setError('')
    try {
      const body = sessionId === NEW_SESSION ? { taskId, mode: 'new', kind } : { taskId, sessionId }
      await api(`/notes/${props.note.id}/send`, { method: 'POST', body })
      props.onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setSending(false) }
  }
  return (
    <Modal title={`发送「${props.note.title || '未命名便签'}」`} onClose={props.onClose}>
      <div className={css.fieldRow}>
        <TaskSelect tasks={props.tasks} taskId={taskId} onPick={(id) => { setTaskId(id); setSessionId(NEW_SESSION) }} />
        {task ? <SessionSelect task={task} sessionId={sessionId} kind={kind} onPick={setSessionId} onKind={setKind} /> : null}
      </div>
      {error ? <p role="alert" className={css.errorText}>{error}</p> : null}
      <div className={css.modalActions}>
        <button type="button" className={css.btn} onClick={props.onClose}>取消</button>
        <button type="button" className={`${css.btn} ${css.primary}`} disabled={!task || sending} onClick={() => void submit()}>{sending ? '发送中…' : '发送'}</button>
      </div>
    </Modal>
  )
}

const EMPTY_SCHEDULE_FORM: ScheduleFormState = {
  scheduleEnabled: true, scheduleMode: 'daily', scheduleTime: '09:00',
  scheduleWeekday: 1, scheduleDayOfMonth: 1, scheduleAt: '',
}

export function NoteScheduleDialog(props: { note: WbNote; tasks: WbTask[]; onClose: () => void }): ReactElement {
  const data = useWorkbenchData()
  // 打开时传入的 note 是快照；按 id 从实时数据取同一条，添加/删除后列表立刻跟着刷新。
  const note = data.notes.find((item) => item.id === props.note.id) ?? props.note
  const [taskId, setTaskId] = useState('')
  const [sessionId, setSessionId] = useState(NEW_SESSION)
  const [kind, setKind] = useState<'pi' | 'dsh'>('dsh')
  const [scheduleForm, setScheduleForm] = useState<ScheduleFormState>({ ...EMPTY_SCHEDULE_FORM })
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const task = props.tasks.find((item) => item.id === taskId)
  const taskTitle = (id: string) => props.tasks.find((item) => item.id === id)?.title || '已删除任务'
  const sessionTitle = (send: WbNoteSend) => {
    if (!send.sessionId) return `新建会话（${send.kind}）`
    const session = props.tasks.find((item) => item.id === send.taskId)?.sessions.find((item) => item.id === send.sessionId)
    return session?.title || '原会话已删除'
  }
  const add = async () => {
    if (!task) { setError('请选择任务'); return }
    let schedule
    try { schedule = buildSchedule(scheduleForm) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return }
    setAdding(true); setError('')
    try {
      const body = { taskId, sessionId: sessionId === NEW_SESSION ? undefined : sessionId, kind, schedule }
      await api(`/notes/${note.id}/sends`, { method: 'POST', body })
      setScheduleForm({ ...EMPTY_SCHEDULE_FORM })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setAdding(false) }
  }
  const remove = async (sendId: string) => {
    try { await api(`/notes/${note.id}/sends/${sendId}`, { method: 'DELETE' }) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const sends = note.sends || []
  return (
    <Modal title={`定时发送「${note.title || '未命名便签'}」`} onClose={props.onClose}>
      <p className={css.label}>{sends.length ? `已设置的定时发送（${sends.length}）` : '还没有定时发送设置，在下方添加。'}</p>
      {sends.length ? (
        <div className={css.sendList}>
          {sends.map((send) => (
            <div key={send.id} className={css.sendItem}>
              <span className={`${css.cDot} ${colorClass(props.tasks.find((item) => item.id === send.taskId)?.color || 'gray')}`} />
              <span className={css.sendItemText}>
                {taskTitle(send.taskId)} / {sessionTitle(send)} · {scheduleLabel(send.schedule)}
                {send.lastFiredAt ? <span className={css.sendItemMeta}>（上次触发 {relativeTime(send.lastFiredAt)}）</span> : null}
              </span>
              <button type="button" className={css.iconAction} title="删除此定时发送" onClick={() => void remove(send.id)}>{ICONS.trash}</button>
            </div>
          ))}
        </div>
      ) : null}
      <p className={css.label}>新增定时发送</p>
      <div className={css.fieldRow}>
        <TaskSelect tasks={props.tasks} taskId={taskId} onPick={(id) => { setTaskId(id); setSessionId(NEW_SESSION) }} />
        {task ? <SessionSelect task={task} sessionId={sessionId} kind={kind} onPick={setSessionId} onKind={setKind} /> : null}
      </div>
      <div className={css.fieldRow}>
        <select aria-label="执行频率" className={css.select} value={scheduleForm.scheduleMode} onChange={(event) => setScheduleForm({ ...scheduleForm, scheduleMode: event.target.value as ScheduleFormState['scheduleMode'] })}>
          <option value="daily">每日</option>
          <option value="weekly">每周</option>
          <option value="monthly">每月</option>
          <option value="custom">单次（指定时间）</option>
        </select>
        {scheduleForm.scheduleMode === 'weekly' ? (
          <select aria-label="每周执行日" className={css.select} value={scheduleForm.scheduleWeekday} onChange={(event) => setScheduleForm({ ...scheduleForm, scheduleWeekday: Number(event.target.value) })}>
            {WEEKDAYS.map((label, index) => <option key={index} value={index}>{label}</option>)}
          </select>
        ) : null}
        {scheduleForm.scheduleMode === 'monthly' ? (
          <input aria-label="每月执行日" type="number" min={1} max={31} className={css.input} style={{ width: 90 }} value={scheduleForm.scheduleDayOfMonth || ''} onChange={(event) => setScheduleForm({ ...scheduleForm, scheduleDayOfMonth: event.target.value === '' ? 0 : Number(event.target.value) })} />
        ) : null}
        {scheduleForm.scheduleMode === 'custom' ? (
          <input aria-label="单次执行时间" type="datetime-local" className={css.input} value={scheduleForm.scheduleAt} onChange={(event) => setScheduleForm({ ...scheduleForm, scheduleAt: event.target.value })} />
        ) : (
          <input aria-label="执行时间" type="time" className={css.input} value={scheduleForm.scheduleTime} onChange={(event) => setScheduleForm({ ...scheduleForm, scheduleTime: event.target.value })} />
        )}
      </div>
      {scheduleForm.scheduleMode === 'monthly' && scheduleForm.scheduleDayOfMonth > 28 ? <p className={css.label}>当月没有该日期时跳过，不提前到月末发送。</p> : null}
      {error ? <p role="alert" className={css.errorText}>{error}</p> : null}
      <div className={css.modalActions}>
        <button type="button" className={css.btn} onClick={props.onClose}>关闭</button>
        <button type="button" className={`${css.btn} ${css.primary}`} disabled={!task || adding} onClick={() => void add()}>{adding ? '添加中…' : '添加定时发送'}</button>
      </div>
    </Modal>
  )
}
