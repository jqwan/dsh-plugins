import { isWorkbenchView } from './workbench-navigation.ts'
/**
 * 工作台侧栏区：以更低 priority 遮蔽 ui-workspace 的 WorkspaceBrowser
 * （sidebar.workspaces 槽位），把会话浏览区替换为工作台结构——顶部"新任务"
 * 大按钮、工具行（搜索/视图选项/看板入口）、会话树。原生侧栏壳保留：品牌行、
 * 折叠状态机、原生设置行都照常工作；原生 New Session 按钮由工作台的
 * "新任务"大按钮替代（注入样式隐藏）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { InjectFace, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { FishLogo, IconChecklistOutlineRegular, IconFolderCloseRegular, IconFolderOpenRegular, IconListPenOutlineRegular, IconPersonalizationOutlineRegular, IconProjectAddOutlineRegular, IconSearchOutlineRegular, IconTriangleRightFillRegular, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { api, refresh, type WbSession, type WbTask } from './api.ts'
import { EMPTY_TASK_FORM, taskToForm, type SessionSort, type WorkbenchView } from './store.ts'
import { WorkbenchHeroTaskMount } from './hero-task.tsx'
import { PiPixelMark } from './brand.tsx'
import type { NativeSessionsFace, UiSessionFace } from './host.ts'
import { createWorkbenchStore } from './store.ts'
import nativeRoot from './dsh-chat/ConversationRoot.module.css'
import { ICONS, Modal, resolveSessionState, useNativeSessionsList, usePendingInteractions, useWbTheme, useWorkbenchBoot, useWorkbenchData, wbClass, wbSurfaceProps, type SessionStateContext } from './ui.tsx'
import css from './workbench.module.css'

/** apply 注入的业务面。 */
export interface WorkbenchFace {
  /** 在 dsh 原生聊天界面打开一个 dsh 会话。 */
  openDshSession(sessionId: string): void
  /** 宿主原生会话列表（completed 位、running 位来源）。 */
  nativeSessions: NativeSessionsFace | null
  /** 宿主挂起的用户交互（dsh 会话琥珀点来源）。 */
  pendingInteractions: UiSessionFace['pendingInteractions'] | null
}

export type WorkbenchSidebarProps =
  & PropsRuntime<'sidebar.workspaces'>
  & PropsStore<ReturnType<typeof createWorkbenchStore>>
  & InjectFace<WorkbenchFace>

/**
 * 把所属任务名注入原生 dsh 会话头部的面包屑最前（任务 / 会话标题，与 pi
 * 头部同步）。原生头部没有任务概念，这里用 MutationObserver 自愈式插入
 * 一个带标记的 crumb 节点；当前原生会话不属于任何工作台任务时不显示。
 */
function WorkbenchNativeHeaderCrumb(props: { current: string | null; tasks: WbTask[] }): ReactElement {
  const dataRef = useRef({ current: props.current, tasks: props.tasks })
  const syncRef = useRef<() => void>(() => {})
  dataRef.current = { current: props.current, tasks: props.tasks }
  useEffect(() => {
    let node: HTMLElement | null = null
    const remove = () => { node?.remove(); node = null }
    const sync = () => {
      const { current, tasks } = dataRef.current
      const nav = document.querySelector('div[data-phase] > header nav')
      const task = current
        ? tasks.find((item) => item.sessions.some((session) => session.kind === 'dsh' && session.status === 'active' && session.dshSessionId === current))
        : undefined
      if (!nav || !task) { remove(); return }
      const title = task.title || '未命名任务'
      if (node && node.isConnected && node.dataset.taskTitle === title) return
      remove()
      const seg = document.createElement('span')
      seg.className = nativeRoot.crumbSeg
      seg.dataset.taskTitle = title
      const label = document.createElement('span')
      label.className = nativeRoot.crumb
      label.style.cursor = 'default'
      label.textContent = title
      label.title = `所属任务：${title}`
      const sep = document.createElement('span')
      sep.className = nativeRoot.crumbSep
      sep.textContent = '/'
      seg.append(label, sep)
      nav.insertBefore(seg, nav.firstChild)
      node = seg
    }
    const observer = new MutationObserver(sync)
    observer.observe(document.body, { childList: true, subtree: true })
    syncRef.current = sync
    sync()
    return () => { observer.disconnect(); remove(); syncRef.current = () => {} }
  }, [])
  // 任务重命名等纯数据变化不会引发头部 DOM 变更，observer 察觉不到；随数据主动重同步
  useEffect(() => { syncRef.current() })
  return <></>
}

/** 工作路径分组键：去尾部斜杠，避免同一目录出现两个分组。 */
function pathKeyOf(task: WbTask): string {
  const raw = task.workingDir || '未设置工作路径'
  return raw === '未设置工作路径' ? raw : (raw.replace(/\/+$/, '') || '/')
}

interface TreeEntry {
  task: WbTask
  session: WbSession
}

/**
 * 渲染工作台侧栏会话区（原生壳内的浏览区域，始终渲染）。
 * @param props - owner 形态（wide/expandSidebar）+ 共享 store + 注入业务面。
 */
export function WorkbenchSidebar(props: WorkbenchSidebarProps): ReactElement {
  const { wide, expandSidebar, useStore, actions, openDshSession, nativeSessions, pendingInteractions } = props
  const theme = useWbTheme()
  useWorkbenchBoot()
  const data = useWorkbenchData()
  const view = useStore((state) => state.view)
  const boardView = useStore((state) => state.boardView)
  const kind = useStore((state) => state.kind)
  const piTaskId = useStore((state) => state.piTaskId)
  const piSessionId = useStore((state) => state.piSessionId)
  const piReminders = useStore((state) => state.piReminders)
  const piErrors = useStore((state) => state.piErrors)
  const hiddenTasks = useStore((state) => state.hiddenTasks)
  const nativeList = useNativeSessionsList(nativeSessions)
  const pending = usePendingInteractions(pendingInteractions ?? undefined)
  const regionRef = useRef<HTMLDivElement | null>(null)

  // 区域右缘 = 侧栏列宽（区域左缘贴窗口左边），回写给共享 store 供中心面
  // 计算覆盖起点；折叠/拖拽调宽时随 ResizeObserver 自动更新。
  useEffect(() => {
    const element = regionRef.current
    if (!element) return
    const sync = () => { actions.setSidebarGeometry(element.getBoundingClientRect().right, !wide) }
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(element)
    return () => observer.disconnect()
  }, [actions, wide])

  // 宿主当前 dsh 会话被真正切换时（含原生入口打开），中心区跟随切回原生聊天。
  // 只比较 current 值：列表自身的刷新（标题更新等）不应打断用户所在的看板。
  const lastCurrentRef = useRef(nativeSessions?.list.getSnapshot().current)
  useEffect(() => {
    if (!nativeSessions) return
    return nativeSessions.list.subscribe(() => {
      const current = nativeSessions.list.getSnapshot().current
      const previous = lastCurrentRef.current
      lastCurrentRef.current = current
      // 仅在“一个会话切到另一个会话”时跟随；启动首次加载（previous 为空）不抢视图。
      if (current && previous && current !== previous) actions.setView('dsh')
    })
  }, [nativeSessions, actions])

  const [viewMenuOpen, setViewMenuOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [search, setSearch] = useState('')
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const searchSlotRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])
  // 搜索没输入内容时，点击输入框以外区域自动收起；有内容则保持展开
  useEffect(() => {
    if (!searchOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (search.trim()) return
      const slot = searchSlotRef.current
      if (slot && event.target instanceof Node && !slot.contains(event.target)) setSearchOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [searchOpen, search])
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(new Set())
  const [collapsedTasks, setCollapsedTasks] = useState<Set<string>>(new Set())
  const sessionSort = useStore((state) => state.sessionSort)
  const sessionGroupBy = useStore((state) => state.sessionGroupBy)

  // 会话排序比较器（收藏置顶），分组/平铺/按任务三种模式共用
  const compareEntries = useCallback((left: TreeEntry, right: TreeEntry) => {
    if (left.session.favorite !== right.session.favorite) return left.session.favorite ? -1 : 1
    if (sessionSort === 'title') return (left.session.title || '新会话').localeCompare(right.session.title || '新会话', 'zh-CN')
    const leftKey = sessionSort === 'created' ? left.session.createdAt : left.session.updatedAt
    const rightKey = sessionSort === 'created' ? right.session.createdAt : right.session.updatedAt
    return rightKey.localeCompare(leftKey)
  }, [sessionSort])

  const groups = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    const byPath = new Map<string, { task: WbTask; entries: TreeEntry[] }>()
    for (const task of data.tasks) {
      if (task.status === 'archived' || hiddenTasks.includes(task.id)) continue
      const sessions = task.sessions.filter((session) => session.status === 'active' && session.kind === kind)
      const rawKey = task.workingDir || '未设置工作路径'
      const groupKey = rawKey === '未设置工作路径' ? rawKey : (rawKey.replace(/\/+$/, '') || '/')
      const matched = keyword
        ? sessions.filter((session) =>
            (session.title || '新会话').toLowerCase().includes(keyword)
            || task.title.toLowerCase().includes(keyword))
        : sessions
      // 空会话任务不再被隐藏：标题照样出现（右侧提供移除按钮）。
      if (!matched.length && !(keyword ? task.title.toLowerCase().includes(keyword) : true)) continue
      const bucket = byPath.get(groupKey) ?? { task, entries: [] }
      for (const session of matched) bucket.entries.push({ task, session })
      byPath.set(groupKey, bucket)
    }
    return [...byPath.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([path, { entries }]) => {
        const sorted = [...entries].sort(compareEntries)
        const tasks = [...new Map(sorted.map(({ task }) => [task.id, task])).values()]
        const emptyTasks = data.tasks.filter((task) =>
          task.status !== 'archived'
          && !hiddenTasks.includes(task.id)
          && pathKeyOf(task) === path
          && !tasks.some((seen) => seen.id === task.id)
          && (!keyword || task.title.toLowerCase().includes(keyword)))
        return {
          path,
          entries: sorted,
          tasks: [...tasks, ...emptyTasks]
            .sort((left, right) => {
              const leftKey = left.sessions.filter((item) => item.status === 'active' && item.kind === kind)
              const rightKey = right.sessions.filter((item) => item.status === 'active' && item.kind === kind)
              if (!leftKey.length || !rightKey.length) return leftKey.length ? -1 : 1
              return compareEntries({ task: left, session: leftKey[0] }, { task: right, session: rightKey[0] })
            }),
        }
      })
  }, [data.tasks, hiddenTasks, kind, search, compareEntries])

  // 按任务分组：不显示工作路径层级，直接列任务块（搜索语义与路径分组一致）
  const taskGroups = useMemo(() => {
    if (sessionGroupBy !== 'task') return null
    const keyword = search.trim().toLowerCase()
    const result: Array<{ task: WbTask; entries: TreeEntry[] }> = []
    for (const task of data.tasks) {
      if (task.status === 'archived' || hiddenTasks.includes(task.id)) continue
      const matched = task.sessions
        .filter((session) => session.status === 'active' && session.kind === kind
          && (!keyword || (session.title || '新会话').toLowerCase().includes(keyword)))
        .map((session) => ({ task, session }))
      if (!matched.length && keyword && !task.title.toLowerCase().includes(keyword)) continue
      result.push({ task, entries: matched.sort(compareEntries) })
    }
    // 有会话的任务在前，组间按各自第一个会话的排序键比较
    return result.sort((left, right) => {
      if (!left.entries.length || !right.entries.length) return left.entries.length ? -1 : 1
      return compareEntries(left.entries[0], right.entries[0])
    })
  }, [data.tasks, hiddenTasks, kind, search, sessionGroupBy, compareEntries])

  // 平铺列表：跨任务的全部活动会话（分组方式=平铺时使用）
  const flatEntries = useMemo(() => {
    if (sessionGroupBy !== 'flat') return null
    const keyword = search.trim().toLowerCase()
    const entries: TreeEntry[] = []
    for (const task of data.tasks) {
      if (task.status === 'archived' || hiddenTasks.includes(task.id)) continue
      for (const session of task.sessions) {
        if (session.status !== 'active' || session.kind !== kind) continue
        if (keyword && !(session.title || '新会话').toLowerCase().includes(keyword) && !task.title.toLowerCase().includes(keyword)) continue
        entries.push({ task, session })
      }
    }
    return entries.sort((left, right) => {
      if (left.session.favorite !== right.session.favorite) return left.session.favorite ? -1 : 1
      if (sessionSort === 'title') return (left.session.title || '新会话').localeCompare(right.session.title || '新会话', 'zh-CN')
      const leftKey = sessionSort === 'created' ? left.session.createdAt : left.session.updatedAt
      const rightKey = sessionSort === 'created' ? right.session.createdAt : right.session.updatedAt
      return rightKey.localeCompare(leftKey)
    })
  }, [data.tasks, hiddenTasks, kind, search, sessionSort, sessionGroupBy])

  const activeNativeId = nativeList?.current
  const stateCtx: SessionStateContext = useMemo(() => ({
    nativeById: nativeList?.byId,
    piReminders,
    piErrors,
    pendingKinds: pending ?? undefined,
  }), [nativeList, piReminders, piErrors, pending])

  // pi 会话"新回复"提醒对账：每次数据/选择变化时推进 latestMessageId 基线，
  // 变化且非当前打开 → 点亮；打开中的会话 → 消费（dsh 会话提醒由宿主原生管理）。
  useEffect(() => {
    actions.reconcilePi(data.tasks, view, piTaskId, piSessionId)
    actions.pruneHidden(data.tasks)
  }, [actions, data, view, piTaskId, piSessionId])

  // 新建会话窗口暂选任务的挂载监听：当前 dsh 会话从空白变为有首条消息
  // （或冷启动直接出现非空会话）时，把它挂到任务名下；没发消息就切到
  // 旧会话则撤销暂存。
  const heroTaskId = useStore((state) => state.heroTaskId)
  const heroTaskRef = useRef(heroTaskId)
  heroTaskRef.current = heroTaskId
  useEffect(() => {
    if (!nativeSessions) return
    const blankSeen = new Map<string, boolean>()
    const initial = nativeSessions.list.getSnapshot()
    for (const id of initial.ids) blankSeen.set(id, Boolean(initial.byId[id]?.blank))
    return nativeSessions.list.subscribe(() => {
      const snap = nativeSessions.list.getSnapshot()
      for (const id of snap.ids) {
        if (!blankSeen.has(id)) blankSeen.set(id, Boolean(snap.byId[id]?.blank))
      }
      const staged = heroTaskRef.current
      const current = snap.current
      const row = current ? snap.byId[current] : undefined
      if (!staged || !current || !row) return
      const wasBlank = blankSeen.get(current)
      blankSeen.set(current, row.blank)
      if (row.blank) return
      if (wasBlank === false) {
        actions.setHeroTask(null)
        return
      }
      const title = String(row.displayTitle || row.title || '').trim()
      void api(`/tasks/${staged}/sessions/attach`, { method: 'POST', body: { dshSessionId: current, title } })
        .then(() => {
          // 会话已落到该任务名下：若任务此前被移出会话列表，这里恢复显示
          actions.unhideTask(staged)
        })
        .catch(() => { /* 挂载失败不阻塞会话使用；任务侧下次刷新对齐 */ })
        .finally(() => { if (heroTaskRef.current === staged) actions.setHeroTask(null) })
    })
  }, [nativeSessions, actions])

  const openSession = (task: WbTask, session: WbSession) => {
    if (session.kind === 'dsh') {
      if (session.dshSessionId) openDshSession(session.dshSessionId)
      actions.setView('dsh')
    } else {
      actions.selectPi(task.id, session.id)
    }
  }

  const toggleFavorite = async (task: WbTask, session: WbSession) => {
    try {
      await api(`/tasks/${task.id}/sessions/${session.id}`, { method: 'PATCH', body: { favorite: !session.favorite } })
    } catch { /* 列表会在下次刷新时对齐 */ }
  }

  const deleteSession = async (task: WbTask, session: WbSession) => {
    // 打开中的会话删除后跳回英雄界面（pi → 草稿；dsh → 清当前会话回英雄空态）
    const isOpen = session.kind === 'dsh'
      ? view === 'dsh' && session.dshSessionId === activeNativeId
      : view === 'terminal' && piTaskId === task.id && piSessionId === session.id
    try {
      // 运行中的会话由服务端先停再删；空会话直接永久删除，有内容的进回收站
      await api(`/tasks/${task.id}/sessions/${session.id}`, { method: 'DELETE' })
      if (!isOpen) return
      if (session.kind === 'dsh') { actions.setHeroTask(null); nativeSessions?.clear?.(); actions.setView('dsh') }
      else actions.openPiDraft(null)
    } catch { /* 下次刷新对齐 */ }
  }

  const togglePath = (path: string) => {
    setCollapsedPaths((previous) => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }
  const toggleTask = (taskId: string) => {
    setCollapsedTasks((previous) => {
      const next = new Set(previous)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }

  const createSession = (task: WbTask) => {
    if (kind === 'pi') { actions.openPiDraft(task.id); return }
    // dsh 与 pi 同款：发送了消息才算新建子会话。这里只打开“草稿”会话
    // （真实 dsh 会话挂工作区、不落任务记录，同一任务复用空白草稿），
    // 暂选任务后由挂载监听在首条消息时落账。
    actions.setHeroTask(task.id)
    actions.setView('dsh')
    void api(`/tasks/${task.id}/sessions/draft`, { method: 'POST', body: {} })
      .then((payload) => { if (payload?.dshSessionId) openDshSession(payload.dshSessionId) })
      .catch((error: unknown) => { console.error('[workbench] 打开 dsh 草稿会话失败', error) })
  }

  const [menuTaskId, setMenuTaskId] = useState<string | null>(null)
  // 会话行删除按钮的两段式确认：待确认的会话 id
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  // 任务行原位重命名：待重命名的任务 id 与输入值
  const [renamingTaskId, setRenamingTaskId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const commitTaskRename = (task: WbTask) => {
    const next = renameValue.trim()
    setRenamingTaskId(null)
    if (!next || next === task.title) return
    void api(`/tasks/${task.id}`, { method: 'PUT', body: { title: next } })
      .then(() => refresh())
      .catch(() => { /* 下次刷新对齐 */ })
  }
  // 确认态下点击其他位置自动退回删除按钮
  useEffect(() => {
    if (!confirmDelete) return
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-confirm-delete]')) return
      setConfirmDelete(null)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [confirmDelete])

  /** 重命名任务：原位编辑行内标题（Enter 确认 / Esc 取消）。 */
  const startTaskRename = (task: WbTask) => {
    setRenameValue(task.title)
    setRenamingTaskId(task.id)
  }

  /** 移除任务：先关闭所有运行中的子会话（pi 终端 / dsh 回合），再移出会话列表。 */
  const removeTaskFromList = (task: WbTask) => {
    for (const session of task.sessions) {
      if (session.status === 'active' && session.running) {
        void api(`/tasks/${task.id}/sessions/${session.id}/stop`, { method: 'POST', body: {} }).catch(() => { /* 下次刷新对齐 */ })
      }
    }
    actions.hideTask(task.id)
  }

  // 删除工作路径：确认弹窗目标 + 永久删除该路径下全部非归档任务（含会话文件）
  const [deletePathTarget, setDeletePathTarget] = useState<string | null>(null)
  const deletePathCount = deletePathTarget
    ? data.tasks.filter((task) => task.status !== 'archived' && pathKeyOf(task) === deletePathTarget).length
    : 0
  const deleteWorkingPath = async (path: string) => {
    const targets = data.tasks.filter((task) => task.status !== 'archived' && pathKeyOf(task) === path)
    for (const task of targets) {
      try { await api(`/tasks/${task.id}/permanent`, { method: 'DELETE' }) } catch { /* 单个失败继续处理其余任务 */ }
    }
  }

  const sessionRow = ({ task, session }: TreeEntry) => {
    const active = session.kind === 'dsh'
      ? view === 'dsh' && session.dshSessionId === activeNativeId
      : view === 'terminal' && piTaskId === task.id && piSessionId === session.id
    // 会话状态融进行首收藏图标：形状表达是否收藏，颜色表达四色状态（右侧不再另设状态点）
    const visual = resolveSessionState(session, task.id, stateCtx)
    const markerClass = `${css.fav}${session.favorite ? ` ${css.favorite}` : ''}${visual ? ` ${css[`state-${visual.state}`]}` : ''}`
    return (
      <div key={session.id} className={`${css.sessionRow}${active ? ` ${css.active}` : ''}`}>
        <button
          type="button"
          className={markerClass}
          title={[visual?.label, session.favorite ? '取消收藏会话' : '收藏会话'].filter(Boolean).join(' · ')}
          onClick={() => void toggleFavorite(task, session)}
        >
          {session.favorite ? ICONS.star : ICONS.circle}
        </button>
        <button type="button" className={css.sessOpen} onClick={() => openSession(task, session)}>
          <span className={css.sessTitle}>{session.title || '新会话'}</span>
        </button>
        <button
          type="button"
          data-confirm-delete={confirmDelete === session.id || undefined}
          className={`${css.iconBtn} ${css.sessDelete}${confirmDelete === session.id ? ` ${css.sessDeleteConfirm}` : ''}`}
          title={confirmDelete === session.id ? '再次点击确认删除（运行中的会话先关闭，有内容的进回收站）' : '删除会话'}
          onClick={() => {
            if (confirmDelete === session.id) { setConfirmDelete(null); void deleteSession(task, session) }
            else setConfirmDelete(session.id)
          }}
        >
          {confirmDelete === session.id ? ICONS.check : ICONS.trash}
        </button>
      </div>
    )
  }

  // 任务块：路径分组与按任务分组共用（taskHead + 子会话列表）
  const renderTaskGroup = (task: WbTask, taskEntries: TreeEntry[]) => {
    const taskOpen = !collapsedTasks.has(task.id)
    return (
      <div key={task.id} className={css.taskGroup}>
        <div className={css.taskHeadRow}>
          {renamingTaskId === task.id ? (
            <>
              <span className={`${css.leadIcon}${task.status === 'done' ? ` ${css.done}` : ''}`}>
                <IconListPenOutlineRegular size={14} />
              </span>
              <input className={css.taskRenameInput} value={renameValue} maxLength={80} autoFocus
                onFocus={event => event.currentTarget.select()}
                onChange={event => setRenameValue(event.target.value)}
                onBlur={() => commitTaskRename(task)}
                onKeyDown={event => {
                  if (event.key === 'Enter') commitTaskRename(task)
                  else if (event.key === 'Escape') setRenamingTaskId(null)
                }} />
            </>
          ) : (
            <button type="button" className={css.taskHead} onClick={() => toggleTask(task.id)} title={task.title}>
              {/* 行首图标对齐原生 WorkspaceBrowser：悬浮行时换成展开箭头；
                  任务收起=清单、展开=清单+笔（与路径的文件夹开合区分），已完成染成功色 */}
              <span className={`${css.leadIcon}${task.status === 'done' ? ` ${css.done}` : ''}`}>
                {taskOpen ? <IconListPenOutlineRegular size={14} /> : <IconChecklistOutlineRegular size={14} />}
              </span>
              <span className={`${css.leadChevron}${taskOpen ? ` ${css.open}` : ''}`}><IconTriangleRightFillRegular /></span>
              <span className={css.taskTitle}>{task.title}</span>
              <span className={css.taskHeadSpacer} />
            </button>
          )}
          <span className={css.taskActions}>
            <Menu
              open={menuTaskId === task.id}
              portal
              align="end"
              dense
              anchor={
                <button
                  type="button"
                  className={css.iconBtn}
                  title="更多操作"
                  onClick={() => setMenuTaskId(menuTaskId === task.id ? null : task.id)}
                >
                  ⋯
                </button>
              }
              items={[
                { id: 'rename', label: '重命名任务', icon: ICONS.pencil },
                { id: 'remove', label: '移除任务', icon: ICONS.close },
              ]}
              onSelect={(id) => {
                setMenuTaskId(null)
                if (id === 'rename') startTaskRename(task)
                else removeTaskFromList(task)
              }}
              onClose={() => setMenuTaskId(null)}
            />
            <button type="button" className={css.iconBtn} title="新建子会话" onClick={() => createSession(task)}>＋</button>
          </span>
        </div>
        {taskOpen ? taskEntries.map(sessionRow) : null}
      </div>
    )
  }

  // 折叠轨：只留展开按钮；π/dsh 切换由品牌行图标承担，看板入口在宽侧栏工具行。
  if (!wide) {
    return (
      <div ref={regionRef} {...wbSurfaceProps(theme)} className={wbClass(theme, css.rail)}>
        <button type="button" className={css.iconBtn} title="展开侧边栏" onClick={expandSidebar}>{ICONS.chevron}</button>
        <WorkbenchHeroTaskMount useStore={useStore} actions={actions} nativeSessions={nativeSessions} />
        <WorkbenchNativeHeaderCrumb current={nativeList?.current ?? null} tasks={data.tasks} />
      </div>
    )
  }

  return (
    <div ref={regionRef} {...wbSurfaceProps(theme)} className={wbClass(theme, css.sidebar)}>
      <WorkbenchNativeHeaderCrumb current={nativeList?.current ?? null} tasks={data.tasks} />
      <WorkbenchHeroTaskMount useStore={useStore} actions={actions} nativeSessions={nativeSessions} />
      <button type="button" className={css.newTaskBtn} onClick={() => actions.setTaskForm({ ...EMPTY_TASK_FORM })}>
        <IconProjectAddOutlineRegular size={16} />
        <span>新任务</span>
      </button>
      <div className={css.top}>
        <button
          type="button"
          className={css.iconBtn}
          title={`切换到 ${kind === 'pi' ? 'dsh' : 'pi'} 会话列表`}
          onClick={() => actions.setKind(kind === 'pi' ? 'dsh' : 'pi')}
        >{kind === 'pi' ? <PiPixelMark size={15} /> : <FishLogo size={15} />}</button>
        <div ref={searchSlotRef} className={`${css.searchSlot}${searchOpen ? ` ${css.searchSlotExpanded}` : ''}`}>
          <div
            className={css.search}
            onClick={() => { setSearchOpen(true); searchInputRef.current?.focus() }}
          >
            <button
              type="button"
              className={css.searchButton}
              title="搜索会话"
              onClick={() => setSearchOpen(true)}
            >
              <IconSearchOutlineRegular size={searchOpen ? 11 : 14} />
            </button>
            {searchOpen ? (
              <>
                <input
                  ref={searchInputRef}
                  className={css.searchField}
                  value={search}
                  placeholder="搜索会话…"
                  onChange={(event) => setSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Escape') return
                    setSearch('')
                    setSearchOpen(false)
                  }}
                />
                <button
                  type="button"
                  className={css.searchClear}
                  title="清除搜索"
                  onClick={(event) => {
                    event.stopPropagation()
                    setSearch('')
                    setSearchOpen(false)
                  }}
                >
                  {ICONS.close}
                </button>
              </>
            ) : null}
          </div>
        </div>
        <div className={`${css.headerActions}${searchOpen ? ` ${css.headerActionsHidden}` : ''}`}>
          <Menu
            open={viewMenuOpen}
            portal
            align="end"
            dense
            anchor={
              <button
                type="button"
                className={css.iconBtn}
                title="视图选项"
                onClick={() => setViewMenuOpen(!viewMenuOpen)}
              >
                <IconPersonalizationOutlineRegular />
              </button>
            }
            items={[
              { type: 'label', id: 'group-by', text: '分组方式' },
              { id: 'path', label: '按工作路径' },
              { id: 'task', label: '按任务' },
              { id: 'flat', label: '平铺列表' },
              { type: 'separator', id: 'order-sep' },
              { type: 'label', id: 'sort-by', text: '排序方式' },
              { id: 'updated', label: '最近更新' },
              { id: 'created', label: '创建时间' },
              { id: 'title', label: '标题' },
            ] as MenuEntry[]}
            selectedIds={[sessionGroupBy, sessionSort]}
            onSelect={(id) => {
              if (id === 'path' || id === 'task' || id === 'flat') { actions.setSessionGroupBy(id); setViewMenuOpen(false); return }
              actions.setSessionSort(id as SessionSort)
              setViewMenuOpen(false)
            }}
            onClose={() => setViewMenuOpen(false)}
          />
          <button type="button" className={`${css.iconBtn}${isWorkbenchView(view) ? ` ${css.iconActive}` : ''}`} title="工作台" aria-label="工作台" onClick={() => { if (!isWorkbenchView(view)) actions.setView(boardView) }}>{ICONS.tasks}</button>
        </div>
      </div>

      <div className={css.tree}>
        {data.error && !data.loaded ? <div className={css.treeError}>工作台后端连接失败：{data.error}</div> : null}
        {!data.error && data.loaded && (flatEntries ? !flatEntries.length : taskGroups ? !taskGroups.length : !groups.length) ? (
          <div className={css.treeEmpty}>{kind === 'pi' ? '暂无 pi 会话' : '暂无 dsh 会话'}<br />在任务看板新建任务后会出现在这里</div>
        ) : null}
        {flatEntries ? flatEntries.map(sessionRow) : taskGroups ? taskGroups.map(({ task, entries }) => renderTaskGroup(task, entries)) : groups.map(({ path, entries, tasks }) => {
          const pathOpen = !collapsedPaths.has(path)
          return (
            <div key={path} className={css.pathGroup}>
              <div className={css.pathHeadRow}>
                <button type="button" className={css.pathHead} onClick={() => togglePath(path)} title={path}>
                  <span className={css.leadIcon}>{pathOpen ? <IconFolderOpenRegular size={14} /> : <IconFolderCloseRegular size={14} />}</span>
                  <span className={`${css.leadChevron}${pathOpen ? ` ${css.open}` : ''}`}><IconTriangleRightFillRegular /></span>
                  <span className={css.pathLabel}>{path}</span>
                </button>
                <button
                  type="button"
                  className={`${css.iconBtn} ${css.pathDelete}`}
                  title="删除工作路径（其下任务与子会话一并永久删除）"
                  onClick={() => setDeletePathTarget(path)}
                >{ICONS.close}</button>
              </div>
              {pathOpen ? tasks.map((task) => renderTaskGroup(task, entries.filter((entry) => entry.task.id === task.id))) : null}
            </div>
          )
        })}
      </div>

      {deletePathTarget ? (
        <Modal title="删除工作路径" onClose={() => setDeletePathTarget(null)}>
          <p className={css.settingsNote}>
            将永久删除 {deletePathTarget} 下的 {deletePathCount} 个任务及其全部子会话（含会话文件），不可恢复。确定删除吗？
          </p>
          <div className={css.modalActions}>
            <button type="button" className={css.btn} onClick={() => setDeletePathTarget(null)}>取消</button>
            <button
              type="button"
              className={`${css.btn} ${css.danger}`}
              onClick={() => { const target = deletePathTarget; setDeletePathTarget(null); void deleteWorkingPath(target) }}
            >删除</button>
          </div>
        </Modal>
      ) : null}

    </div>
  )
}
