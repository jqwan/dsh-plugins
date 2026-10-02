/**
 * 工作台共享 UI 小件：图标、主题（风格 × 宿主亮暗）hook、数据 hook、弹层。
 */

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import { isDarkScheme, refresh, startWorkbenchEvents, workbenchData, type TaskSchedule, type WorkbenchStyle } from './api.ts'
import type { WbSession } from './api.ts'
import type { NativeSessionList, NativeSessionsFace, UiSessionFace } from './host.ts'
import { observeScheme } from './theme.ts'
import css from './workbench.module.css'



/** 当前显示风格 + 宿主亮暗；风格变化（设置弹层）与宿主主题变化都会触发重渲染。 */
export function useWbTheme(): { style: WorkbenchStyle; scheme: 'light' | 'dark' } {
  const [scheme, setScheme] = useState<'light' | 'dark'>(() => (isDarkScheme() ? 'dark' : 'light'))
  useEffect(() => {
    const off = observeScheme((next) => setScheme(next))
    return () => { off() }
  }, [])
  return { style: 'classic' as WorkbenchStyle, scheme }
}

/** 数据面根属性：只带风格/亮暗标记；className 由调用方自行与 css.wb 组合。 */
export function wbSurfaceProps(theme: { style: WorkbenchStyle; scheme: 'light' | 'dark' }) {
  return {
    'data-wb-style': theme.style,
    'data-wb-scheme': theme.scheme,
  } as const
}

/** 组合工作台根类 + 表面类（css.wb 必须显式参与，避免被展开覆盖）。 */
export function wbClass(theme: { style: WorkbenchStyle; scheme: 'light' | 'dark' }, surfaceClass: string): string {
  return `${css.wb} ${surfaceClass}`
}

/** 订阅工作台后端数据（首次订阅时自动拉取 + 建 SSE）。 */
export function useWorkbenchData() {
  return useSyncExternalStore(workbenchData.subscribe, workbenchData.getSnapshot)
}

/** 相对时间的中文摘要（看板卡片、发送项元信息共用）。 */
export function relativeTime(value: string): string {
  const delta = Date.now() - new Date(value).getTime()
  if (Number.isNaN(delta)) return ''
  const minutes = Math.floor(delta / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return new Date(value).toLocaleDateString('zh-CN')
}

/** 定时设置的中文摘要（便签定时发送项展示）；未启用返回 null。 */
export function scheduleLabel(schedule: TaskSchedule | null | undefined): string | null {
  if (!schedule?.enabled) return null
  if (schedule.mode === 'daily') return `每日 ${schedule.time}`
  if (schedule.mode === 'weekly') return `每周${'日一二三四五六'[schedule.weekday ?? 1]} ${schedule.time}`
  if (schedule.mode === 'monthly') return `每月${schedule.dayOfMonth ?? 1}日 ${schedule.time}`
  const at = schedule.at ? new Date(schedule.at) : null
  return at && !Number.isNaN(at.getTime()) ? `单次 ${at.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}` : '单次'
}

/** 订阅任意宿主可观察快照（face 为 null 时恒定返回 null，保证 hook 顺序稳定）。 */
function useHostObservable<T>(observable: { getSnapshot(): T; subscribe(listener: () => void): () => void } | null | undefined): T | null {
  const subscribe = useCallback(
    (listener: () => void) => observable?.subscribe(listener) ?? (() => {}),
    [observable],
  )
  const getSnapshot = useCallback(() => observable?.getSnapshot() ?? null, [observable])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** 订阅宿主原生会话列表快照。 */
export function useNativeSessionsList(face: NativeSessionsFace | null): NativeSessionList | null {
  return useHostObservable(face?.list)
}

/** 订阅宿主挂起的用户交互（琥珀点来源，仅 dsh 会话可能有）。 */
export function usePendingInteractions(observable: UiSessionFace['pendingInteractions'] | null | undefined): ReadonlyMap<string, { kind: string }> | null {
  return useHostObservable(observable)
}

/** 会话行的四色状态（对齐 dsh 原生 StateDot：warning > error > ongoing > done）。 */
export interface SessionVisualState {
  state: StateDotState
  label: string
}

/** dsh 挂起交互类型 → 中文标签（与原生 visiblePendingKind 的三类对齐）。 */
const PENDING_LABELS: Record<string, string> = {
  approval: '等待审批',
  'plan-review': '等待计划评审',
  question: '等待回答',
}

/** 会话状态判定的输入面（侧栏/中心面各自组装）。 */
export interface SessionStateContext {
  nativeById?: NativeSessionList['byId']
  piReminders: readonly string[]
  piErrors: readonly string[]
  pendingKinds?: ReadonlyMap<string, { kind: string }>
}

/**
 * 解析一个会话应显示的四色状态，无状态返回 null（空闲不显示点，与原生一致）。
 * dsh：宿主 pendingInteractions → running → completed（错误位宿主快照没有，缺省）。
 * pi：终端连接错误 → 回合出错（文件里最后回合 error 收场）→ 回合进行中（agentBusy）→ 新回复提醒。
 */
export function resolveSessionState(session: WbSession, taskId: string, ctx: SessionStateContext): SessionVisualState | null {
  if (session.kind === 'dsh') {
    const dshId = session.dshSessionId
    if (!dshId) return null
    const pending = ctx.pendingKinds?.get(dshId)
    if (pending) {
      const label = PENDING_LABELS[pending.kind] || '等待操作'
      return { state: 'warning', label }
    }
    const row = ctx.nativeById?.[dshId]
    // 运行位优先用工作台服务端信号（bridge onAgentStatus，随 SSE 推送）；
    // 原生快照的 running 在桥接驱动的回合上不可靠。
    if (session.running || row?.running) return { state: 'ongoing', label: '运行中' }
    if (row?.completed) return { state: 'done', label: '有新回复' }
    return null
  }
  const key = `${taskId}/${session.id}`
  if (ctx.piErrors.includes(key)) return { state: 'error', label: '连接错误' }
  if (session.turnFailed) return { state: 'error', label: '回合出错' }
  if (session.agentBusy) return { state: 'ongoing', label: '运行中' }
  // PTY 存活但空闲在提示符：不显示点（蓝色只表示回合真正进行中）
  if (ctx.piReminders.includes(key)) return { state: 'done', label: '有新回复' }
  return null
}

/** 卡片上的状态章：原生状态点 + 中文标签。 */
export function StateChip(props: { visual: SessionVisualState }): ReactElement {
  return (
    <span className={css.stateChip} title={props.visual.label}>
      <StateDot state={props.visual.state} size={8} />
      {props.visual.label}
    </span>
  )
}

/** 订阅一次：确保事件流与首次数据加载（多表面共享，幂等）。 */
export function useWorkbenchBoot(): void {
  useEffect(() => {
    startWorkbenchEvents()
    void refresh()
  }, [])
}

export const ICONS = {
  pi: (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 6.5h16" /><path d="M7.5 6.5v13" /><path d="M16.5 6.5v13" /></svg>
  ),
  dsh: (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" /></svg>
  ),
  collapse: (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M9.5 4v16" /></svg>
  ),
  tasks: (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3.5" y="3.5" width="7.5" height="7.5" rx="1.5" /><rect x="13" y="3.5" width="7.5" height="7.5" rx="1.5" /><rect x="3.5" y="13" width="7.5" height="7.5" rx="1.5" /><rect x="13" y="13" width="7.5" height="7.5" rx="1.5" /></svg>
  ),
  notes: (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v9l-5.5 5.5H5A1.5 1.5 0 0 1 3.5 19V6A1.5 1.5 0 0 1 5 4.5Z" /><path d="M14.5 20.5v-4a1.5 1.5 0 0 1 1.5-1.5h4" /></svg>
  ),
  sessions: (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 6.5h16M4 12h16M4 17.5h10" /><circle cx="19" cy="17.5" r="1.6" fill="currentColor" stroke="none" /></svg>
  ),
  stats: (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 20V10M10 20V4M16 20v-7M21 20H3.5" /></svg>
  ),
  archive: (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3.5" y="4" width="17" height="5" rx="1" /><path d="M5.5 9v9.5A1.5 1.5 0 0 0 7 20h10a1.5 1.5 0 0 0 1.5-1.5V9M10 13h4" /></svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="3.2" /><path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1" /></svg>
  ),
  search: (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="6.5" /><path d="m15.9 15.9 4.3 4.3" /></svg>
  ),
  chevron: (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M9 5.5 15.5 12 9 18.5" /></svg>
  ),
  star: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><path className={css.markerFilled} d="M12 3.5 14.63 8.83l5.88.85-4.25 4.14 1 5.85L12 16.91l-5.26 2.76 1-5.85-4.25-4.14 5.88-.85L12 3.5Z" /></svg>
  ),
  circle: (
    <svg viewBox="0 0 24 24" aria-hidden="true"><circle className={css.markerFilled} cx="12" cy="12" r="6.5" /></svg>
  ),
  close: (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 6 12 12M18 6 6 18" /></svg>
  ),
  stop: (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
  ),
  trash: (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4.5 6.5h15M9.5 6V4.5h5V6M6.5 6.5l1 13h9l1-13M10 10.5v5.5M14 10.5v5.5" /></svg>
  ),
  pencil: (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4.5 19.5h4L20 8a2.1 2.1 0 0 0-3-3L5.5 16.5l-1 3Z" /><path d="m14.5 6.5 3 3" /></svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
  ),
  undo: (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.9"><path d="M8.5 5.5 4 10l4.5 4.5" /><path d="M4 10h9.5a5.5 5.5 0 1 1 0 11H9" /></svg>
  ),
  openArrow: (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="8.6" /><path d="M8.5 12h6.5M12.5 9l3 3-3 3" /></svg>
  ),
  pin: (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16.5V21" /><path d="M9.2 10.9a2 2 0 0 1-1.1 1.79l-1.4.72A2 2 0 0 0 5.5 15.18v.32a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-.32a2 2 0 0 0-1.2-1.77l-1.4-.72a2 2 0 0 1-1.1-1.79V5.5h1a2 2 0 0 0 0-4h-8a2 2 0 0 0 0 4h1z" /></svg>
  ),
  pinFilled: (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16.5V21" /><path fill="currentColor" d="M9.2 10.9a2 2 0 0 1-1.1 1.79l-1.4.72A2 2 0 0 0 5.5 15.18v.32a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-.32a2 2 0 0 0-1.2-1.77l-1.4-.72a2 2 0 0 1-1.1-1.79V5.5h1a2 2 0 0 0 0-4h-8a2 2 0 0 0 0 4h1z" /></svg>
  ),
  send: (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M20.5 3.5 3.5 10.7l7 3 3 7 7-17.2Z" /><path d="M10.5 13.7 20.5 3.5" /></svg>
  ),
  clock: (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="8.6" /><path d="M12 7.2V12l3.2 2.1" /></svg>
  ),
  sort: (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 7h12M4 12h8M4 17h4" /><path d="M17 10.5V19M17 19l-3.2-3.2M17 19l3.2-3.2" /></svg>
  ),
  statusUnfinished: (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.6"><circle cx="12" cy="12" r="8.6" /></svg>
  ),
  statusDone: (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.6"><circle cx="12" cy="12" r="8.6" /><path d="m8.2 12.3 2.6 2.6 5-5.4" /></svg>
  ),
}

/** 简易弹层：点击背景不关闭（防误触），Esc 关闭。 */
export function Modal(props: { title: string; onClose: () => void; children: ReactNode }): ReactElement {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') props.onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props])
  return (
    <div className={css.modalBackdrop} role="dialog" aria-label={props.title}>
      <div className={css.modal}>
        <h2>{props.title}</h2>
        {props.children}
      </div>
    </div>
  )
}

/** 内置八色（与工作台数据模型一致）。 */
export const TASK_COLORS = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'gray'] as const

export function colorClass(color: string): string {
  const known = TASK_COLORS.includes(color as (typeof TASK_COLORS)[number]) ? color : 'gray'
  return css[`c${known}`] ?? css.cgray
}

/** 瀑布流列容器：React 按列分发（替代 CSS columns，杜绝列平衡导致的重叠）。 */
export function Masonry<T>(props: {
  items: T[]
  keyOf: (item: T) => string
  minWidth?: number
  gap?: number
  renderItem: (item: T) => ReactNode
}): ReactElement {
  const { items, keyOf, minWidth = 240, gap = 10, renderItem } = props
  const ref = useRef<HTMLDivElement | null>(null)
  const [count, setCount] = useState(1)
  // 绘制前同步测量，避免首帧以 1 列闪现
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => {
      const width = element.getBoundingClientRect().width
      setCount(Math.max(1, Math.floor((width + gap) / (minWidth + gap)) || 1))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [minWidth, gap])
  const buckets: T[][] = Array.from({ length: count }, () => [])
  items.forEach((item, index) => { buckets[index % count].push(item) })
  return (
    <div ref={ref} className={css.masonryRow} style={{ gap }}>
      {buckets.map((bucket, index) => (
        <div key={index} className={css.masonryCol} style={{ gap }}>
          {bucket.map((item) => (
            <Fragment key={keyOf(item)}>{renderItem(item)}</Fragment>
          ))}
        </div>
      ))}
    </div>
  )
}