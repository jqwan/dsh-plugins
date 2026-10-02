/**
 * dsh 原生"新建会话"首屏的任务化改造：
 * - WorkbenchHeroTaskMount：用 MutationObserver 找到原生工作区行，在工作区
 *   chip（已被 CSS 隐藏）与模式按钮之间植入"选择任务"按钮（React portal）。
 * - 选择任务即会话的工作路径：冷启动（尚无会话）时选中任务立即创建 dsh
 *   会话（服务端按任务工作目录建会话并挂到任务名下）并原生打开，输入框
 *   随之可用；已有空会话时仅暂存，首条消息发出后由侧栏监听自动挂载。
 * - WorkbenchHeroWorkspaceGate：接管原生工作区选择槽位（渲染为空）。原生
 *   在未选工作区时把"点击输入框"路由为打开工作区选择（open=true），这里
 *   改道为弹出新工作台新建任务弹窗——必须先选/建任务才能发起会话。
 */

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import type { PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutlineRegular, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type WbTask } from './api.ts'
import type { NativeSessionsFace } from './host.ts'
import { EMPTY_TASK_FORM, type WorkbenchUiActions } from './store.ts'
import { ICONS, useWorkbenchData } from './ui.tsx'
import css from './workbench.module.css'

/** 原生首屏工作区行的哈希类后缀（模块名前缀随构建变化，后缀稳定）。 */
const HERO_ROW_SELECTOR = 'div[class*="_heroWorkspaceRow"]:not([data-pi-task-picker])'

type HeroStoreProps = PropsStore<ReturnType<typeof import('./store.ts').createWorkbenchStore>>

/** 工作区选择槽位改道器：不渲染任何内容，原生请求打开选择时改为新建任务弹窗。 */
export function WorkbenchHeroWorkspaceGate(props: PropsRuntime<'conversation.hero.workspace'> & HeroStoreProps): ReactElement | null {
  const { open, onClose, actions } = props
  const firedRef = useRef(false)
  useEffect(() => {
    if (!open) { firedRef.current = false; return }
    if (firedRef.current) return
    firedRef.current = true
    actions.setTaskForm({ ...EMPTY_TASK_FORM })
    onClose?.()
  }, [open, onClose, actions])
  return null
}

/** 任务颜色 → 颜色点类（自定义颜色回退灰色）；pi 英雄任务菜单共用。 */
export function dotClass(color: string): string {
  const known = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'gray']
  return css[`c${known.includes(color) ? color : 'gray'}`]
}

/** 挂载点：在原生工作区行里找位置并渲染任务按钮；行消失时一并收走。 */
export function WorkbenchHeroTaskMount(props: HeroStoreProps & { nativeSessions: NativeSessionsFace | null }): ReactElement {
  const { useStore, actions, nativeSessions } = props
  // anchor = 原生工作区行；host = 我们插入该行的占位节点
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [host, setHost] = useState<HTMLElement | null>(null)
  useEffect(() => {
    let row: HTMLElement | null = null
    const observer = new MutationObserver(() => {
      const found = document.querySelector<HTMLElement>(HERO_ROW_SELECTOR)
      if (found === row) return
      row = found
      setAnchor(found)
    })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!anchor) return
    // 占位节点插在模式按钮（行内最后一个元素）之前；没有模式按钮时贴行尾，
    // 两种路径都落在工作区按钮与模式按钮之间。
    const span = document.createElement('span')
    span.dataset.dshHeroTask = ''
    anchor.insertBefore(span, anchor.lastElementChild)
    setHost(span)
    return () => {
      setHost(null)
      span.remove()
    }
  }, [anchor])
  if (!host) return <></>
  return createPortal(<WorkbenchHeroTaskChip useStore={useStore} actions={actions} nativeSessions={nativeSessions} />, host)
}

/** 任务选择按钮：样式对齐原生工作区 chip（图标 + 标题 + 下拉箭头）。 */
function WorkbenchHeroTaskChip(props: HeroStoreProps & { nativeSessions: NativeSessionsFace | null }): ReactElement {
  const { useStore, actions, nativeSessions } = props
  const heroTaskId = useStore((state) => state.heroTaskId)
  const data = useWorkbenchData()
  const [menuOpen, setMenuOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const chipRef = useRef<HTMLButtonElement | null>(null)
  const heroTask = useMemo(
    () => data.tasks.find((task) => task.id === heroTaskId && task.status !== 'archived') ?? null,
    [data.tasks, heroTaskId],
  )
  // 候选任务：非归档，按最近更新排序，取前 50 个防菜单过长
  const candidates = useMemo(
    () => data.tasks
      .filter((task) => task.status !== 'archived')
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 50),
    [data.tasks],
  )
  const items: MenuEntry[] = useMemo(() => candidates.map((task: WbTask) => ({
    id: task.id,
    label: task.title || '未命名任务',
    icon: <span className={`${css.cDot} ${dotClass(task.color)}`} />,
  })), [candidates])
  // 尾项只留“新建任务…”：不再提供取消关联（重进英雄首屏即重置暂选任务）
  const footer: MenuEntry[] = useMemo(() => [{ id: '::new-task', label: '新建任务…', icon: ICONS.tasks }], [])
  /** 选中任务：暂存；冷启动（尚无会话）时立即为任务创建会话并打开——
   * dsh 任务走原生会话，pi 任务进入不创建会话的草稿页。 */
  const pickTask = (task: WbTask) => {
    if (task.runKind === 'pi') { actions.openPiDraft(task.id); return }
    actions.setHeroTask(task.id)
    if (nativeSessions?.list.getSnapshot().current) return
    setBusy(true)
    // 冷启动同样只开草稿会话：不落任务记录，首条消息后由侧栏挂载监听落账
    void api(`/tasks/${task.id}/sessions/draft`, { method: 'POST', body: {} })
      .then((payload) => {
        const dshId: string | undefined = payload?.dshSessionId
        if (dshId && nativeSessions) return Promise.resolve(nativeSessions.open(dshId))
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
        setTimeout(() => setError(''), 3200)
      })
      .finally(() => setBusy(false))
  }

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className={css.heroTaskChip}
        title={heroTask ? `新会话将挂到任务「${heroTask.title || '未命名任务'}」名下` : '为新会话选择所属任务（必选）'}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen(!menuOpen)}
      >
        <span className={css.heroTaskIcon}>{busy ? ICONS.sessions : ICONS.tasks}</span>
        <span className={css.heroTaskLabel}>{busy ? '正在创建会话…' : heroTask ? (heroTask.title || '未命名任务') : '选择任务'}</span>
        <span className={css.heroTaskChevron}><IconChevronDownOutlineRegular size={12} /></span>
      </button>
      {error ? <span className={css.heroTaskError}>{error}</span> : null}
      <Menu
        open={menuOpen}
        portal
        anchor={null}
        getAnchorRect={() => chipRef.current?.getBoundingClientRect() ?? null}
        align="start"
        dense
        items={items}
        footer={footer}
        selectedIds={heroTask ? [heroTask.id] : []}
        onSelect={(id) => {
          setMenuOpen(false)
          if (id === '::new-task') {
            actions.setTaskForm({ ...EMPTY_TASK_FORM })
            return
          }
          const task = candidates.find((item) => item.id === id)
          if (task) pickTask(task)
        }}
        onClose={() => setMenuOpen(false)}
      />
    </>
  )
}
