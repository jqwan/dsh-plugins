/**
 * 工作台后端数据层：同源 REST + SSE 折叠进一个快照 store。
 * 所有任务/便签/未读/运行态都来自 workbench-web 插件的 /workbench/api。
 */

import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

export type WorkbenchStyle = 'classic'

export interface WbSessionStats {
  messages: number
  user: number
  assistant: number
  toolResults: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  errors: number
}

export interface WbSession {
  id: string
  kind: 'pi' | 'dsh'
  title: string
  status: 'active' | 'archived'
  favorite: boolean
  /** pi 会话的界面形态：tui=原生终端（默认）/ chat=聊天窗口。 */
  ui?: 'tui' | 'chat' | null
  running: boolean
  /** pi：回合进行中（TUI 存活且最后消息未收尾）。dsh 恒 false。 */
  agentBusy?: boolean
  /** pi：最后回合以 error 收场。dsh 恒 false。 */
  turnFailed?: boolean
  /** 任务级会话便签配置，所有子会话共享。 */
  noteIds: string[]
  restorableWithTask: boolean
  dshSessionId?: string | null
  sessionFile?: string | null
  createdAt: string
  updatedAt: string
  archivedAt?: string | null
  stats: WbSessionStats | null
  latestMessageId: string | null
}

/** 任务定时发布配置（服务端 normalizeSchedule 已规范化）。 */
export interface TaskSchedule {
  enabled: boolean
  /** daily/weekly/monthly 为周期；custom 为指定时间单次发布。 */
  mode: 'daily' | 'weekly' | 'monthly' | 'custom'
  time: string
  weekday?: number
  dayOfMonth?: number
  /** custom 模式的单次发布时间（datetime-local 字符串）。 */
  at?: string
}

export interface WbTask {
  id: string
  title: string
  description: string
  status: 'unfinished' | 'done' | 'archived'
  color: string
  workingDir: string
  workingDirs: string[]
  /** 提醒时间（日期）；overdue = 已过期未完成。 */
  deadline: string | null
  overdue: boolean
  createdAt: string
  updatedAt: string
  archivedAt?: string | null
  /** 任务级便签配置，所有子会话共享。 */
  noteIds: string[]
  sessions: WbSession[]
  activeSessionId: string | null
  piRunning: boolean
  /** 新建会话的默认类型。 */
  runKind: 'pi' | 'dsh'
  /** 模型设置：pi 用于启动参数，dsh 用于会话级模型选择。 */
  model: string | null
  modelProvider: string | null
  thinkingLevel: string | null
}

/** 便签定时发送项：到点把便签内容发往任务的已有会话（sessionId）或新建会话（sessionId 为 null）。 */
export interface WbNoteSend {
  id: string
  taskId: string
  sessionId: string | null
  kind: 'pi' | 'dsh'
  schedule: TaskSchedule
  lastFiredAt: string | null
}

export interface WbNote {
  id: string
  title: string
  description: string
  color: string
  deadline: string | null
  overdue: boolean
  status: 'active' | 'archived'
  createdAt: string
  updatedAt: string
  archivedAt?: string | null
  /** 定时发送设置列表。 */
  sends?: WbNoteSend[]
}

export interface WbConfig {
  dshAvailable: boolean
  defaultNoteIds?: string[]
  maxConcurrent?: number
  port?: number
  sessionsDir?: string
}

export interface WorkbenchData {
  tasks: WbTask[]
  notes: WbNote[]
  config: WbConfig
  loaded: boolean
  connected: boolean
  error: string | null
}

const EMPTY: WorkbenchData = { tasks: [], notes: [], config: { dshAvailable: false }, loaded: false, connected: false, error: null }

const store = createSnapshotStore<WorkbenchData>(EMPTY)
export const workbenchData: ObservableSnapshot<WorkbenchData> = store

let refreshTimer: ReturnType<typeof setTimeout> | null = null
let inFlight: Promise<void> | null = null
let events: EventSource | null = null

export async function api(path: string, options: { method?: string; body?: unknown } = {}): Promise<any> {
  const response = await fetch(`/workbench/api${path}`, {
    method: options.method || 'GET',
    headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.error || `请求失败（${response.status}）`)
  return payload
}

function scheduleRefresh(delay = 150): void {
  if (refreshTimer) return
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    void refresh()
  }, delay)
}

/** 拉取任务/便签/配置并写入 store；并发去重。 */
export async function refresh(): Promise<void> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const [tasksPayload, notesPayload, config] = await Promise.all([
        api('/tasks'),
        api('/notes'),
        api('/config').catch(() => ({ dshAvailable: false })),
      ])
      store.update((draft) => {
        draft.tasks = tasksPayload.tasks || []
        draft.notes = notesPayload.notes || []
        draft.config = config
        draft.loaded = true
        draft.connected = true
        draft.error = null
      })
    } catch (error) {
      store.update((draft) => {
        draft.error = error instanceof Error ? error.message : String(error)
      })
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

/** 启动 SSE 订阅（幂等）；任何 tasks_changed 都触发去抖刷新。 */
export function startWorkbenchEvents(): void {
  if (events) return
  try {
    const source = new EventSource('/workbench/api/events')
    events = source
    source.onmessage = () => scheduleRefresh()
    source.onerror = () => {
      store.update((draft) => { draft.connected = false })
    }
    source.onopen = () => {
      store.update((draft) => { draft.connected = true })
      scheduleRefresh(0)
    }
  } catch {
    store.update((draft) => { draft.error = '事件订阅失败' })
  }
}

// —— 显示风格：仅保留默认主题（配色效仿 dsh 原生）——

export function currentStyle(): WorkbenchStyle {
  return 'classic'
}

/** 终端与界面共用的深浅判定（跟随 dsh 宿主）。 */
export function isDarkScheme(): boolean {
  return document.documentElement.style.colorScheme === 'dark'
    || (!document.documentElement.style.colorScheme && window.matchMedia('(prefers-color-scheme: dark)').matches)
}


// —— 终端配色：静态映射 dsh 原生亮暗色（xterm 无法使用 CSS 变量）——

/** 计算当前亮暗下的 xterm 主题（配色效仿 dsh 原生）。 */
export function terminalTheme(): Record<string, string> {
  const dark = isDarkScheme()
  return {
    background: dark ? '#151517' : '#ffffff',
    foreground: dark ? '#f9fafb' : '#0f1115',
    cursor: dark ? '#f9fafb' : '#0f1115',
    cursorAccent: dark ? '#151517' : '#ffffff',
    selectionBackground: dark ? '#3a3b3e' : '#dbe2ea',
    black: dark ? '#151517' : '#0f1115',
    brightBlack: dark ? '#8b8e94' : '#61666b',
    red: dark ? '#ff6b6b' : '#d64545',
    green: dark ? '#4ed17e' : '#1a9e4b',
    yellow: dark ? '#f5b93f' : '#b07d10',
    blue: dark ? '#7aa5ff' : '#2660c4',
    magenta: dark ? '#d0a3ff' : '#8d44c8',
    cyan: dark ? '#62d0c8' : '#0f7d76',
    white: dark ? '#f9fafb' : '#ffffff',
  }
}
