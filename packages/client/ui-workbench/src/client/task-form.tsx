/**
 * 全局新建/编辑任务弹层：shell.overlay 条目，任何视图（含 dsh 原生聊天）
 * 下都能由侧栏或工作台编辑按钮唤起。模型与思考设置可折叠。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { api } from './api.ts'
import { ICONS, colorClass, TASK_COLORS, useWbTheme, wbClass, wbSurfaceProps, useWorkbenchData } from './ui.tsx'
import { createWorkbenchStore, EMPTY_TASK_FORM, type TaskFormState } from './store.ts'
import css from './workbench.module.css'

export type TaskFormOverlayProps =
  & PropsRuntime<'shell.overlay'>
  & PropsStore<ReturnType<typeof createWorkbenchStore>>

const THINKING_LEVELS: Array<[string, string]> = [
  ['', '默认'],
  ['low', '低'],
  ['medium', '中'],
  ['high', '高'],
]

/** taskForm 非空时渲染弹层；表单内部状态以打开时的初值为种子。 */
export function TaskFormOverlay(props: TaskFormOverlayProps): ReactElement | null {
  const { useStore, actions } = props
  const theme = useWbTheme()
  const seed = useStore((state) => state.taskForm)
  // formKey 跟随种子变化，保证每次打开都是全新表单状态。
  const formKey = seed ? JSON.stringify(seed) : 'closed'
  if (!seed) return null
  return (
    <div {...wbSurfaceProps(theme)} className={wbClass(theme, css.modalBackdrop)} role="dialog" aria-label={seed.id ? '编辑任务' : '新建任务'}>
      <TaskFormModal key={formKey} initial={seed} onClose={() => actions.setTaskForm(null)} />
    </div>
  )
}

function TaskFormModal(props: { initial: TaskFormState; onClose: () => void }): ReactElement {
  const [form, setForm] = useState<TaskFormState>({ ...props.initial })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [moreOpen, setMoreOpen] = useState(
    props.initial.model !== '' || props.initial.thinkingLevel !== '' || props.initial.runKind === 'pi',
  )
  const [modelGroups, setModelGroups] = useState<Array<{ id: string; name: string; models: ReadonlyArray<{ id: string; name: string }> }>>([])
  // 工作路径输入框点击后弹出“已有工作路径”菜单：收集自全部任务的去重路径
  const data = useWorkbenchData()
  const dirInputRef = useRef<HTMLInputElement | null>(null)
  const [dirMenuRow, setDirMenuRow] = useState<number | null>(null)
  const knownDirs = useMemo(() => {
    const seen = new Set<string>()
    for (const task of data.tasks) {
      for (const dir of (task.workingDirs?.length ? task.workingDirs : task.workingDir ? [task.workingDir] : [])) {
        if (dir) seen.add(dir)
      }
    }
    return [...seen]
  }, [data.tasks])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !savingRef.current) props.onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props])

  // 展开更多设置时拉取 dsh 可路由模型目录（pi 侧同名字段作启动参数）
  useEffect(() => {
    if (!moreOpen || modelGroups.length) return
    let cancelled = false
    void api('/models')
      .then((payload) => {
        if (cancelled) return
        setModelGroups(Array.isArray(payload?.groups) ? payload.groups : [])
      })
      .catch(() => { /* 目录拉取失败时下拉为空，仍可手填 */ })
    return () => { cancelled = true }
  }, [moreOpen, modelGroups.length])

  const patch = (patchPart: Partial<TaskFormState>) => setForm((current) => ({ ...current, ...patchPart }))

  const submit = async () => {
    if (savingRef.current) return
    if (form.model && (!form.model.includes('::') || !form.model.split('::')[0].trim() || !form.model.split('::').slice(1).join('::').trim())) { setError('模型请填写 provider::model，或留空使用默认模型'); return }
    const workingDirs = form.workingDirs.map((line) => line.trim()).filter(Boolean)
    if (!workingDirs.length) { setError('请至少填写一个工作路径'); return }
    savingRef.current = true; setSaving(true); setError('')
    const [provider, ...modelRest] = form.model.split('::')
    const body = {
      title: form.title,
      description: form.description,
      workingDirs,
      deadline: form.deadline || null,
      color: form.color,
      runKind: form.runKind,
      modelProvider: provider.trim() || null,
      model: modelRest.join('::').trim() || null,
      thinkingLevel: form.thinkingLevel || null,
    }
    try {
      if (form.id) await api(`/tasks/${form.id}`, { method: 'PUT', body })
      else await api('/tasks', { method: 'POST', body })
      props.onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { savingRef.current = false; setSaving(false) }
  }

  return (
    <div className={css.modal} aria-busy={saving}>
      <h2>{form.id ? '编辑任务' : '新建任务'}</h2><fieldset disabled={saving} className={css.taskFormFields}>
        <div className={css.field}>
          <span className={css.label}>标题</span>
          <input className={css.input} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} autoFocus />
        </div>
        <div className={css.field}>
          <span className={css.label}>描述</span>
          <textarea className={css.textarea} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
        </div>
        <div className={css.field}>
          <span className={css.label}>工作路径（支持 ~，每条一个）</span>
          {form.workingDirs.map((dir, index) => (
            <div key={index} className={css.fieldRow}>
              <input
                className={css.input}
                value={dir}
                placeholder={knownDirs.length ? '点击选择已有路径，或输入新路径' : '~/projects/workspace'}
                onClick={(event) => { if (knownDirs.length) { dirInputRef.current = event.currentTarget; setDirMenuRow(index) } }}
                onChange={(event) => setForm({ ...form, workingDirs: form.workingDirs.map((item, i) => i === index ? event.target.value : item) })}
              />
              <button
                type="button"
                className={`${css.btn} ${css.small}`}
                onClick={() => {
                  void api('/select-directory', { method: 'POST' })
                    .then((result) => {
                      if (result?.path) setForm((current) => ({ ...current, workingDirs: current.workingDirs.map((item, i) => i === index ? result.path : item) }))
                    })
                    .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
                }}
              >选择目录…</button>
              {form.workingDirs.length > 1 ? (
                <button type="button" className={css.iconAction} title="移除此路径" onClick={() => setForm({ ...form, workingDirs: form.workingDirs.filter((_, i) => i !== index) })}>{ICONS.close}</button>
              ) : null}
            </div>
          ))}
          <div>
            <button type="button" className={`${css.btn} ${css.small}`} onClick={() => setForm({ ...form, workingDirs: [...form.workingDirs, ''] })}>＋ 添加工作路径</button>
          </div>
          {knownDirs.length ? (
            <Menu
              open={dirMenuRow !== null}
              portal
              anchor={null}
              getAnchorRect={() => dirInputRef.current?.getBoundingClientRect() ?? null}
              align="start"
              dense
              items={knownDirs.map((dir) => ({ id: dir, label: dir })) as MenuEntry[]}
              selectedIds={[]}
              onSelect={(id) => {
                if (dirMenuRow !== null) setForm({ ...form, workingDirs: form.workingDirs.map((item, i) => i === dirMenuRow ? id : item) })
                setDirMenuRow(null)
              }}
              onClose={() => setDirMenuRow(null)}
            />
          ) : null}
        </div>
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
        <div className={css.field}>
          <button type="button" className={`${css.btn} ${css.small}`} onClick={() => setMoreOpen(!moreOpen)}>
            {moreOpen ? '收起模型设置 ▲' : '模型与思考设置 ▼'}
          </button>
        </div>
        {moreOpen ? (
          <div className={css.moreSettings}>
            <label className={css.field}>会话引擎<select aria-label="会话引擎" className={css.select} value={form.runKind} onChange={event => patch({ runKind: event.target.value as TaskFormState['runKind'] })}><option value="dsh">dsh</option><option value="pi">pi</option></select></label>
            <div className={css.field}>
              <span className={css.label}>使用模型（空 = 默认；该任务新会话生效）</span>
              {form.runKind === 'dsh' && modelGroups.length ? (
                <select className={css.select} value={form.model} onChange={(event) => patch({ model: event.target.value })}>
                  <option value="">默认模型</option>
                  {form.model && !modelGroups.some(group => group.models.some(model => `${group.id}::${model.id}` === form.model)) && <option value={form.model}>{form.model}</option>}
                  {modelGroups.map((group) => (
                    <optgroup key={group.id} label={group.name || group.id}>
                      {group.models.map((item) => (
                        <option key={`${group.id}::${item.id}`} value={`${group.id}::${item.id}`}>{item.name || item.id}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              ) : (
                <input className={css.input} value={form.model} onChange={(event) => patch({ model: event.target.value })} placeholder="provider::model（目录不可用时手动填写）" />
              )}
            </div>
            <div className={css.field}>
              <span className={css.label}>思考等级</span>
              <select className={css.select} value={form.thinkingLevel} onChange={(event) => patch({ thinkingLevel: event.target.value })}>
                {THINKING_LEVELS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </div>
          </div>
        ) : null}
        {error ? <p role="alert" className={css.errorText}>{error}</p> : null}
        </fieldset><div className={css.modalActions}>
          <button type="button" className={css.btn} disabled={saving} onClick={props.onClose}>取消</button>
          <button type="button" className={`${css.btn} ${css.primary}`} disabled={saving || !form.title.trim()} onClick={() => void submit()}>{saving ? '保存中…' : '保存'}</button>
        </div>
    </div>
  )
}
