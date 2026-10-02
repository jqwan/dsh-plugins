/**
 * 工作台 UI 状态：中心区当前视图、会话列表类型（pi/dsh）、选中 pi 会话、
 * 侧栏几何（区域右缘回写）、会话排序，以及界面切换历史（前进/后退）。
 * 侧栏品牌行、中心面、看板等多个 slot 共享。
 */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/** 中心区视图：dsh = 原生聊天（中心面不渲染）。 */
export type WorkbenchView = 'dsh' | 'pi-draft' | 'terminal' | 'tasks' | 'notes' | 'sessions' | 'stats' | 'archive'

/** 工作台看板的五个页签视图；进入工作台时恢复上次停留的页签。 */
export const BOARD_VIEW_IDS = ['tasks', 'notes', 'sessions', 'archive', 'stats'] as const
export type BoardView = (typeof BOARD_VIEW_IDS)[number]

/** 会话排序键。 */
export type SessionSort = 'updated' | 'created' | 'title'

/** 会话列表分组方式：按工作路径 / 按任务（不显示路径层级）/ 平铺列表。 */
export type SessionGroupBy = 'path' | 'task' | 'flat'

/** 任务看板的筛选/分组/排序（各看板状态互不影响、切换不重置）。 */
export interface TaskBoardState {
  filter: 'unfinished' | 'done' | 'archived'
  groupBy: 'none' | 'path' | 'color'
  sortBy: 'updated' | 'title'
}

/** 便签看板筛选：all = 全部未废弃；default/plain = 是否已设为"新任务默认便签"；archived = 废弃。 */
export type NotesFilter = 'all' | 'default' | 'plain' | 'archived'
const NOTES_FILTERS: NotesFilter[] = ['all', 'default', 'plain', 'archived']

const BOARD_STATE_KEY = 'workbench-board-state'

/** 可跨刷新恢复的视图：dsh 原生区、pi 英雄与五个看板页签（pi 终端依赖内存态，不恢复）。 */
const RESTORABLE_VIEWS: WorkbenchView[] = ['dsh', 'pi-draft', 'tasks', 'notes', 'sessions', 'archive', 'stats']

function loadBoardState(): {
  view: WorkbenchView; kind: 'pi' | 'dsh'; heroTaskId: string | null; piDraftTaskId: string | null; dshNativeSessionId: string | null
  taskBoard: TaskBoardState; notesFilter: NotesFilter; sessionGroupBy: SessionGroupBy; hiddenTasks: string[]; boardView: BoardView
} {
  try {
    const raw = JSON.parse(localStorage.getItem(BOARD_STATE_KEY) || '{}')
    const taskBoard = raw.taskBoard || {}
    return {
      // 刷新后恢复上次视图：看板类即刻恢复；pi 英雄带暂选任务恢复；dsh 由原生
      // 异步重开会话（配套启动对齐：会话态等待重开、英雄态清除原生自动恢复）
      view: RESTORABLE_VIEWS.includes(raw.view) ? raw.view : 'dsh',
      kind: raw.kind === 'dsh' ? 'dsh' : 'pi',
      heroTaskId: typeof raw.heroTaskId === 'string' ? raw.heroTaskId : null,
      piDraftTaskId: typeof raw.piDraftTaskId === 'string' ? raw.piDraftTaskId : null,
      dshNativeSessionId: typeof raw.dshNativeSessionId === 'string' ? raw.dshNativeSessionId : null,
      taskBoard: {
        filter: ['unfinished', 'done', 'archived'].includes(taskBoard.filter) ? taskBoard.filter : 'unfinished',
        groupBy: ['none', 'path', 'color'].includes(taskBoard.groupBy) ? taskBoard.groupBy : 'none',
        sortBy: ['updated', 'created', 'title'].includes(taskBoard.sortBy) ? taskBoard.sortBy : 'updated',
      },
      // 旧版只存了 notesArchived 布尔，迁移：true → 废弃页，false → 全部
      notesFilter: NOTES_FILTERS.includes(raw.notesFilter) ? raw.notesFilter : (raw.notesArchived ? 'archived' : 'all'),
      sessionGroupBy: ['path', 'task', 'flat'].includes(raw.sessionGroupBy) ? raw.sessionGroupBy : 'path',
      hiddenTasks: Array.isArray(raw.hiddenTasks) ? raw.hiddenTasks.filter((id: unknown) => typeof id === 'string') : [],
      boardView: BOARD_VIEW_IDS.includes(raw.boardView) ? raw.boardView : 'tasks',
    }
  } catch {
    return {
      view: 'dsh', kind: 'pi', heroTaskId: null, piDraftTaskId: null, dshNativeSessionId: null,
      taskBoard: { filter: 'unfinished', groupBy: 'none', sortBy: 'updated' }, notesFilter: 'all', sessionGroupBy: 'path', hiddenTasks: [], boardView: 'tasks',
    }
  }
}

function saveBoardState(state: WorkbenchUiState): void {
  try {
    localStorage.setItem(BOARD_STATE_KEY, JSON.stringify({
      view: state.view, kind: state.kind, heroTaskId: state.heroTaskId, piDraftTaskId: state.piDraftTaskId,
      dshNativeSessionId: state.dshNativeSessionId, taskBoard: state.taskBoard, notesFilter: state.notesFilter,
      sessionGroupBy: state.sessionGroupBy, hiddenTasks: state.hiddenTasks, boardView: state.boardView,
    }))
  } catch { /* 存储不可用时忽略 */
  }
}

/** 新建/编辑任务表单的共享状态（null = 关闭）。 */
export interface TaskFormState {
  id?: string
  title: string
  description: string
  /** 工作路径逐条编辑（与定时发送项同款交互，每条独立增删选）。 */
  workingDirs: string[]
  deadline: string
  color: string
  // —— 更多设置 ——
  /** 新建会话的默认类型。 */
  runKind: 'pi' | 'dsh'
  /** 模型选择：'provider::model'，空 = 默认模型。 */
  model: string
  /** 思考等级：空 = 不指定；low/medium/high。 */
  thinkingLevel: string
}

export const EMPTY_TASK_FORM: TaskFormState = {
  title: '', description: '', workingDirs: [''], deadline: '', color: 'blue',
  runKind: 'dsh', model: '', thinkingLevel: '',
}

/** 任务数据 → 编辑表单初值。 */
export function taskToForm(task: {
  id: string; title: string; description?: string; workingDir?: string | null; workingDirs?: string[] | null
  deadline?: string | null; color: string
  runKind?: 'pi' | 'dsh'; model?: string | null; modelProvider?: string | null; thinkingLevel?: string | null
}): TaskFormState {
  const dirs = task.workingDirs?.length ? [...task.workingDirs] : task.workingDir ? [task.workingDir] : []
  return {
    id: task.id,
    title: task.title,
    description: task.description || '',
    workingDirs: dirs.length ? dirs : [''],
    deadline: task.deadline || '',
    color: task.color,
    runKind: task.runKind ?? 'dsh',
    model: task.model && task.modelProvider ? `${task.modelProvider}::${task.model}` : '',
    thinkingLevel: task.thinkingLevel ?? '',
  }
}

/** 历史回溯点：界面切换记录的最小状态集。 */
export interface WorkbenchPoint {
  view: WorkbenchView
  kind: 'pi' | 'dsh'
  piTaskId: string | null
  piSessionId: string | null
}

export interface WorkbenchUiState {
  view: WorkbenchView
  kind: 'pi' | 'dsh'
  piTaskId: string | null
  piSessionId: string | null
  sidebarWidth: number
  sidebarCollapsed: boolean
  sessionSort: SessionSort
  sessionGroupBy: SessionGroupBy
  taskForm: TaskFormState | null
  taskBoard: TaskBoardState
  notesFilter: NotesFilter
  /** 上次停留的看板页签：从 dsh/终端视图点「工作台」时恢复它。 */
  boardView: BoardView
  histPast: WorkbenchPoint[]
  histFuture: WorkbenchPoint[]
  /** pi 会话"新回复"提醒（键 taskId/sessionId）。纯内存，刷新即清——对齐 dsh 原生 completed 提醒。 */
  piReminders: string[]
  /** pi 会话 latestMessageId 基线；首见只记基线不提醒（与原生 prevRunning 同语义）。 */
  piBaseline: Record<string, string | null>
  /** pi 会话终端连接错误（键 taskId/sessionId）。纯内存，由终端视图上报。 */
  piErrors: string[]
  /** 从会话列表隐藏的任务（本地视图偏好，不改动任务数据）。看板入口打开/建会话时恢复。 */
  hiddenTasks: string[]
  /** dsh 新建会话窗口暂选的任务：会话发出首条消息后自动挂到该任务名下。纯内存。 */
  piDraftTaskId: string | null
  /** 刷新前 dsh 视图打开的原生会话 id（null = 英雄空态），用于刷新后区分恢复路径。 */
  dshNativeSessionId: string | null
  heroTaskId: string | null
}

export type WorkbenchUiActions = {
  setView: (draft: WorkbenchUiState, view: WorkbenchView) => void
  setKind: (draft: WorkbenchUiState, kind: 'pi' | 'dsh') => void
  setPiDraftTask: (draft: WorkbenchUiState, taskId: string | null) => void
  openPiDraft: (draft: WorkbenchUiState, taskId: string | null) => void
  selectPi: (draft: WorkbenchUiState, taskId: string, sessionId: string) => void
  setSidebarGeometry: (draft: WorkbenchUiState, width: number, collapsed: boolean) => void
  setSessionSort: (draft: WorkbenchUiState, sort: SessionSort) => void
  setSessionGroupBy: (draft: WorkbenchUiState, mode: SessionGroupBy) => void
  setTaskForm: (draft: WorkbenchUiState, form: TaskFormState | null) => void
  setDshNativeSession: (draft: WorkbenchUiState, sessionId: string | null) => void
  setTaskBoard: (draft: WorkbenchUiState, patch: Partial<TaskBoardState>) => void
  setNotesFilter: (draft: WorkbenchUiState, filter: NotesFilter) => void
  goBack: (draft: WorkbenchUiState) => void
  goForward: (draft: WorkbenchUiState) => void
  /**
   * 对齐 dsh 原生 completed 提醒算法（manager.ts syncCompletedNotifications）：
   * 数据快照到达时对比 pi 会话 latestMessageId 基线——变化且非当前打开的会话
   * 则点亮提醒；当前打开的会话消费提醒；消失的会话清键。
   */
  reconcilePi: (draft: WorkbenchUiState, tasks: Array<{ id: string; status: string; sessions: Array<{ id: string; kind: string; status: string; latestMessageId: string | null }> }>, view: WorkbenchView, piTaskId: string | null, piSessionId: string | null) => void
  /** 终端视图上报连接状态：error/closed 记红点，ready/connecting 清除。 */
  setPiError: (draft: WorkbenchUiState, taskId: string, sessionId: string, hasError: boolean) => void
  /** 把任务从会话列表隐藏（不进回收站）。 */
  hideTask: (draft: WorkbenchUiState, taskId: string) => void
  /** 恢复任务在会话列表的显示。 */
  unhideTask: (draft: WorkbenchUiState, taskId: string) => void
  /** 清理已不存在的隐藏任务 id。 */
  pruneHidden: (draft: WorkbenchUiState, tasks: Array<{ id: string }>) => void
  /** 暂存/清除 dsh 新建会话窗口选择的任务。 */
  setHeroTask: (draft: WorkbenchUiState, taskId: string | null) => void
}

const HISTORY_LIMIT = 60
const BOARD_DEFAULTS = loadBoardState()

function pointOf(draft: WorkbenchUiState): WorkbenchPoint {
  return { view: draft.view, kind: draft.kind, piTaskId: draft.piTaskId, piSessionId: draft.piSessionId }
}

/** 界面状态变化前记录回溯点，并清空前进分支。 */
function record(draft: WorkbenchUiState): void {
  draft.histPast.push(pointOf(draft))
  if (draft.histPast.length > HISTORY_LIMIT) draft.histPast.shift()
  draft.histFuture = []
}

export function createWorkbenchStore(): EngineStoreHandle<WorkbenchUiState, WorkbenchUiActions> {
  return defineStore({
    init: (): WorkbenchUiState => ({
      view: BOARD_DEFAULTS.view,
      kind: BOARD_DEFAULTS.kind,
      piTaskId: null,
      piSessionId: null,
      sidebarWidth: 264,
      sidebarCollapsed: false,
      sessionSort: 'updated',
      sessionGroupBy: BOARD_DEFAULTS.sessionGroupBy,
      taskForm: null,
      taskBoard: BOARD_DEFAULTS.taskBoard,
      notesFilter: BOARD_DEFAULTS.notesFilter,
      boardView: BOARD_DEFAULTS.boardView,
      histPast: [],
      histFuture: [],
      piReminders: [],
      piBaseline: {},
      piErrors: [],
      hiddenTasks: BOARD_DEFAULTS.hiddenTasks,
      heroTaskId: BOARD_DEFAULTS.heroTaskId,
      piDraftTaskId: BOARD_DEFAULTS.piDraftTaskId,
      dshNativeSessionId: BOARD_DEFAULTS.dshNativeSessionId,
    }),
    actions: {
      setView: (draft, view) => {
        if (view === draft.view) return
        record(draft)
        draft.view = view
        if ((BOARD_VIEW_IDS as readonly string[]).includes(view)) draft.boardView = view as BoardView
        saveBoardState(draft)
      },
      setKind: (draft, kind) => {
        if (kind === draft.kind) return
        record(draft)
        draft.kind = kind
        saveBoardState(draft)
      },
      setPiDraftTask: (draft, taskId) => { draft.piDraftTaskId = taskId; saveBoardState(draft) },
      openPiDraft: (draft, taskId) => {
        if (draft.view !== 'pi-draft') record(draft)
        draft.view = 'pi-draft'
        draft.kind = 'pi'
        draft.piDraftTaskId = taskId
        saveBoardState(draft)
      },
      selectPi: (draft, taskId, sessionId) => {
        record(draft)
        draft.view = 'terminal'
        draft.piTaskId = taskId
        draft.piSessionId = sessionId
      },
      setSidebarGeometry: (draft, width, collapsed) => {
        draft.sidebarWidth = width
        draft.sidebarCollapsed = collapsed
      },
      setSessionSort: (draft, sort) => { draft.sessionSort = sort },
      setSessionGroupBy: (draft, mode) => {
        draft.sessionGroupBy = mode
        saveBoardState(draft)
      },
      setTaskForm: (draft, form) => { draft.taskForm = form },
      setDshNativeSession: (draft, sessionId) => {
        if (sessionId === draft.dshNativeSessionId) return
        draft.dshNativeSessionId = sessionId
        saveBoardState(draft)
      },
      setTaskBoard: (draft, patch) => {
        draft.taskBoard = { ...draft.taskBoard, ...patch }
        saveBoardState(draft)
      },
      setNotesFilter: (draft, filter) => {
        if (filter === draft.notesFilter) return
        draft.notesFilter = filter
        saveBoardState(draft)
      },
      goBack: (draft) => {
        const previous = draft.histPast.pop()
        if (!previous) return
        draft.histFuture.push(pointOf(draft))
        draft.view = previous.view
        draft.kind = previous.kind
        draft.piTaskId = previous.piTaskId
        draft.piSessionId = previous.piSessionId
        saveBoardState(draft)
      },
      goForward: (draft) => {
        const next = draft.histFuture.pop()
        if (!next) return
        draft.histPast.push(pointOf(draft))
        draft.view = next.view
        draft.kind = next.kind
        draft.piTaskId = next.piTaskId
        draft.piSessionId = next.piSessionId
        saveBoardState(draft)
      },
      reconcilePi: (draft, tasks, view, piTaskId, piSessionId) => {
        const selectedKey = view === 'terminal' && piTaskId && piSessionId ? `${piTaskId}/${piSessionId}` : null
        const seen = new Set<string>()
        for (const task of tasks) {
          if (task.status === 'archived') continue
          for (const session of task.sessions) {
            if (session.status !== 'active' || session.kind !== 'pi') continue
            const key = `${task.id}/${session.id}`
            seen.add(key)
            const previous = draft.piBaseline[key]
            if (previous === undefined) {
              // 首见只记基线：加载/刷新时已有的消息不提醒（与原生一致）
              draft.piBaseline[key] = session.latestMessageId
              continue
            }
            const changed = session.latestMessageId !== previous
            draft.piBaseline[key] = session.latestMessageId
            if (key === selectedKey) {
              // 看着会话时不提醒，并消费已有提醒（原生：select 即消费）
              if (draft.piReminders.includes(key)) draft.piReminders = draft.piReminders.filter((item) => item !== key)
            } else if (changed && !draft.piReminders.includes(key)) {
              draft.piReminders.push(key)
            }
          }
        }
        for (const key of Object.keys(draft.piBaseline)) {
          if (!seen.has(key)) delete draft.piBaseline[key]
        }
        if (draft.piReminders.some((key) => !seen.has(key))) {
          draft.piReminders = draft.piReminders.filter((key) => seen.has(key))
        }
        if (draft.piErrors.some((key) => !seen.has(key))) {
          draft.piErrors = draft.piErrors.filter((key) => seen.has(key))
        }
      },
      setPiError: (draft, taskId, sessionId, hasError) => {
        const key = `${taskId}/${sessionId}`
        const has = draft.piErrors.includes(key)
        if (hasError && !has) draft.piErrors.push(key)
        else if (!hasError && has) draft.piErrors = draft.piErrors.filter((item) => item !== key)
      },
      hideTask: (draft, taskId) => {
        if (draft.hiddenTasks.includes(taskId)) return
        draft.hiddenTasks.push(taskId)
        saveBoardState(draft)
      },
      unhideTask: (draft, taskId) => {
        if (!draft.hiddenTasks.includes(taskId)) return
        draft.hiddenTasks = draft.hiddenTasks.filter((item) => item !== taskId)
        saveBoardState(draft)
      },
      pruneHidden: (draft, tasks) => {
        // 后端尚未返回数据时（如重启后页面首帧）tasks 为空，此时不清算，
        // 否则会把用户的隐藏清单误当成"任务已全部删除"整单抹掉
        if (!tasks.length) return
        const ids = new Set(tasks.map((task) => task.id))
        if (draft.hiddenTasks.some((id) => !ids.has(id))) {
          draft.hiddenTasks = draft.hiddenTasks.filter((id) => ids.has(id))
          saveBoardState(draft)
        }
      },
      setHeroTask: (draft, taskId) => {
        if (taskId === draft.heroTaskId) return
        draft.heroTaskId = taskId
        saveBoardState(draft)
      },
    },
  })
}
