import { PiModelSelect } from './pi-model.tsx'
import type { PiModel } from './pi-chat.tsx'
import type { ModelSelection } from './pi-model-types.ts'
import { observePiWidth } from './pi-width.ts'
/** Pi draft: task selection and editing do not allocate a persisted session. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, refresh } from './api.ts'
import { createWorkbenchStore, EMPTY_TASK_FORM } from './store.ts'
import { ICONS, useWorkbenchData } from './ui.tsx'
import { dotClass } from './hero-task.tsx'
import { PiPixelMark } from './brand.tsx'
import { PiChat, type PiInitialPrompt } from './pi-chat.tsx'
import { PiComposer } from './pi-composer.tsx'
import { chatT } from './pi-locale.ts'
import root from './dsh-chat/ConversationRoot.module.css'
import hero from './dsh-chat/HeroShell.module.css'
import css from './workbench.module.css'

/** First submission owns session allocation; a synchronous latch excludes duplicate clicks. */
export function PiDraft({ useStore, actions }: PropsStore<ReturnType<typeof createWorkbenchStore>>) {
  const taskId = useStore(state => state.piDraftTaskId)
  const { tasks } = useWorkbenchData()
  const task = tasks.find(item => item.id === taskId && item.status !== 'archived')
  const [input, setInput] = useState('')
  const [menu, setMenu] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const latch = useRef(false)
  const mounted = useRef(true)
  const [models, setModels] = useState<PiModel[]>([])
  const [modelLoading, setModelLoading] = useState(false)
  const [modelError, setModelError] = useState<string | null>(null)
  const [selection, setSelection] = useState<ModelSelection | null>(null)
  const [defaults, setDefaults] = useState<ModelSelection | null>(null)
  const catalogRequest = useRef(0)
  const loadModels = async () => {
    const request = ++catalogRequest.current
    setModelLoading(true); setModelError(null)
    try {
      const result = await api(`/pi/models${taskId ? `?taskId=${encodeURIComponent(taskId)}` : ''}`)
      if (!mounted.current || request !== catalogRequest.current) return
      setModels(result.models)
      setDefaults(result.current?.provider && result.current?.model ? result.current : null)
    } catch (error) {
      if (mounted.current && request === catalogRequest.current) setModelError(error instanceof Error ? error.message : String(error))
    } finally {
      if (mounted.current && request === catalogRequest.current) setModelLoading(false)
    }
  }
  useEffect(() => {
    setSelection(null); setDefaults(null); setModels([])
    void loadModels()
    return () => { catalogRequest.current++ }
  }, [taskId])
  const chosen = selection ?? (task?.model && task.modelProvider ? { provider: task.modelProvider, model: task.model, reasoningEffort: task.thinkingLevel || undefined } : defaults)
  const currentModel = chosen ? models.find(model => model.provider === chosen.provider && model.id === chosen.model) ?? { provider: chosen.provider, id: chosen.model } : null
  const chipRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [created, setCreated] = useState<{ taskId: string; sessionId: string; prompt: PiInitialPrompt } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!created && rootRef.current) return observePiWidth(rootRef.current)
  }, [created])
  if (created) return <PiChat taskId={created.taskId} sessionId={created.sessionId} taskTitle={task?.title} initialPrompt={created.prompt}
    onFirstAccepted={() => { void refresh().then(() => { if (!mounted.current) return; actions.unhideTask(created.taskId); actions.selectPi(created.taskId, created.sessionId) }) }} />
  return <div ref={rootRef} className={`${root.root} ${css.chatWrap}`} data-pi-phase="hero"><div className={css.chatHero}><div className={`${root.composerStack} ${root.composerHero}`}>
    <div className={hero.root}><div className={hero.stack}><div className={hero.headline}><span className={hero.fishHitbox}><PiPixelMark size={34} /></span><span className={hero.headlineText}>{chatT('hero.headline')}</span><span className={hero.previewBadge}>{chatT('hero.preview')}</span></div></div></div>
    <div className={root.heroWorkspaceRow} data-pi-task-picker="">
      <button ref={chipRef} className={css.heroTaskChip} type="button" disabled={busy} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(value => !value)}>
        <span className={css.heroTaskIcon}>{ICONS.tasks}</span>
        <span className={css.heroTaskLabel}>{task?.title || chatT('hero.selectTask')}</span>
        <span className={css.heroTaskChevron}><IconChevronDownOutlineRegular /></span>
      </button>
      {/* 下拉与 dsh 英雄任务菜单同款：dense、颜色点、当前任务高亮、按最近更新排序取前 50 */}
      <Menu open={menu} onClose={() => setMenu(false)} portal anchor={null} getAnchorRect={() => chipRef.current?.getBoundingClientRect() ?? null} align="start" dense
        selectedIds={task ? [task.id] : []}
        items={tasks.filter(item => item.status !== 'archived').sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, 50).map(item => ({ id: item.id, label: item.title || '未命名任务', icon: <span className={`${css.cDot} ${dotClass(item.color)}`} /> }))}
        footer={[{ id: '::new', label: chatT('hero.newTask'), icon: ICONS.tasks }]}
        onSelect={id => { setMenu(false); setError(''); if (id === '::new') actions.setTaskForm({ ...EMPTY_TASK_FORM }); else actions.setPiDraftTask(id) }} />
    </div>
    {error && <div role="alert" className={css.chatErrorRow}>{error}</div>}
    {/* 未选任务：输入卡进入触发态（虚线描边、不可编辑），点击直接弹新建任务 */}
    <PiComposer hero cardTrigger={!task} onCardTrigger={task ? undefined : () => actions.setTaskForm({ ...EMPTY_TASK_FORM })}
      accepted={0} input={input} onInput={setInput} disabled={busy} running={false} onStop={() => {}} model={task ? <span onClick={event => event.stopPropagation()}><PiModelSelect models={models} current={currentModel} thinking={chosen?.reasoningEffort || ''} levels={currentModel?.levels || []} loading={modelLoading} error={modelError} disabled={busy} load={() => void loadModels()} select={async value => { setSelection(value); return { success: true } }} /></span> : null} commands={[]} onCommand={() => {}}
      draftOnly onSend={(mode, images) => {
        if (!task) { setError(chatT('hero.needTask')); setMenu(true); return }
        if (latch.current || (!input.trim() && !images.length)) return
        latch.current = true; setBusy(true); setError('')
        const prompt = { text: input, mode, images }
        void api(`/tasks/${task.id}/sessions/draft`, { method: 'POST', body: { title: '新会话', kind: 'pi', ui: 'chat', ...(chosen ? { modelSelection: chosen } : {}) } })
          .then(payload => {
            if (!payload.session?.id) throw new Error(chatT('hero.createFailed'))
            setCreated({ taskId: task.id, sessionId: payload.session.id, prompt })
          })
          .catch(cause => { setError(String(cause instanceof Error ? cause.message : cause)); latch.current = false; setBusy(false) })
      }} />
  </div></div></div>
}
