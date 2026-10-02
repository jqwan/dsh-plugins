import { WORKBENCH_TABS, isWorkbenchView } from './workbench-navigation.ts'
/**
 * 中心区切换面：shell.overlay 上的工作台条目。当前视图为 dsh 时只渲染
 * 底部便签按钮条（原生聊天完整露出）；其余视图渲染覆盖中心列的工作台面，
 * 左缘从侧栏右沿开始（几何来自侧栏区域的 DOM 测量回写）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { InjectFace, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { api, refresh, type WbSession, type WbTask } from './api.ts'
import { ArchiveView, NotesBoard, SessionsBoard, StatsView, TasksBoard } from './boards.tsx'
import { PinnedNotesBar } from './notes-bar.tsx'
import type { NativeSessionsFace } from './host.ts'
import type { WorkbenchFace } from './sidebar.tsx'
import { createWorkbenchStore, taskToForm } from './store.ts'
import nativeRoot from './dsh-chat/ConversationRoot.module.css'
import { PiDraft } from './pi-draft.tsx'
import { PiChat } from './pi-chat.tsx'
import { SessionTitle, WorkbenchSessionTitle } from './session-title.tsx'
import { PiTerminal } from './terminal.tsx'
import { resolveSessionState, useNativeSessionsList, usePendingInteractions, useWbTheme, useWorkbenchBoot, useWorkbenchData, wbClass, wbSurfaceProps, type SessionStateContext } from './ui.tsx'
import css from './workbench.module.css'

export type WorkbenchCenterProps =
  & PropsRuntime<'shell.overlay'>
  & PropsStore<ReturnType<typeof createWorkbenchStore>>
  & InjectFace<WorkbenchFace>

/**
 * 渲染工作台中心面；视图为 dsh（原生聊天）时仅渲染底部便签条。
 * @param props - 共享 store + 注入业务面。
 */
export function WorkbenchCenter(props: WorkbenchCenterProps): ReactElement | null {
  const { useStore, actions, openDshSession, nativeSessions, pendingInteractions } = props
  const theme = useWbTheme()
  useWorkbenchBoot()
  const data = useWorkbenchData()
  const view = useStore((state) => state.view)
  const kind = useStore((state) => state.kind)
  const piTaskId = useStore((state) => state.piTaskId)
  const piSessionId = useStore((state) => state.piSessionId)
  const [trajectory, setTrajectory] = useState(false)
  const dshNativeSessionId = useStore((state) => state.dshNativeSessionId)
  const [terminalPaste, setTerminalPaste] = useState<{ id: number; text: string } | undefined>()
  useEffect(() => { setTrajectory(false); setTerminalPaste(undefined) }, [piTaskId, piSessionId])
  const sidebarWidth = useStore((state) => state.sidebarWidth)

  // 统一的会话打开入口：dsh → 宿主原生聊天；pi → 终端视图。
  // 提醒消费：dsh 由原生 open()（select 即消费）；pi 由 reconcile 对账消费。
  const openSession = (taskId: string, sessionId: string) => {
    const task = data.tasks.find((item) => item.id === taskId)
    const session = task?.sessions.find((item) => item.id === sessionId)
    if (!task || !session) return
    // 从看板入口打开会话 = 任务重新进入会话列表
    actions.unhideTask(taskId)
    if (session.kind === 'dsh') {
      if (session.dshSessionId) openDshSession(session.dshSessionId)
      actions.setView('dsh')
    } else {
      actions.selectPi(taskId, sessionId)
    }
  }

  // 任务卡片“新建会话”：按当前 logo 切换的类型创建并打开。
  const createSession = (taskId: string) => {
    if (kind === 'pi') { actions.openPiDraft(taskId); return }
    // dsh 与侧栏/英雄同款：发送了消息才算新建子会话。这里只打开“草稿”会话
    // （真实 dsh 会话挂工作区、不落任务记录，同一任务复用空白草稿），
    // 暂选任务后由侧栏挂载监听在首条消息时落账。
    actions.unhideTask(taskId)
    actions.setHeroTask(taskId)
    actions.setView('dsh')
    void api(`/tasks/${taskId}/sessions/draft`, { method: 'POST', body: {} })
      .then((payload) => { if (payload?.dshSessionId) openDshSession(payload.dshSessionId) })
      .catch((error: unknown) => { console.error('[workbench] 打开 dsh 草稿会话失败', error) })
  }

  const terminalTask = view === 'terminal' ? data.tasks.find((item) => item.id === piTaskId) : undefined
  const terminalSession = terminalTask?.sessions.find((item) => item.id === piSessionId)
  // pi 会话的界面形态：chat=聊天窗口（仿 dsh 会话），tui=原生终端（默认）
  const chatMode = terminalSession?.ui === 'chat'

  /** 切换 pi 会话界面形态（服务端在打开时保证 TUI/聊天进程互斥）。 */
  const toggleSessionUi = useCallback((taskId: string, sessionId: string, ui: 'tui' | 'chat') => {
    void api(`/tasks/${taskId}/sessions/${sessionId}`, { method: 'PATCH', body: { ui } })
      .then(() => refresh())
      .catch(() => {})
  }, [])

  // 分叉：截取会话至指定条目生成新子会话，并切换到分支的聊天界面
  const branchSession = useCallback((taskId: string, sessionId: string, entryId: string) => {
    void api(`/tasks/${taskId}/sessions/${sessionId}/branch`, { method: 'POST', body: { entryId } })
      .then((payload) => {
        if (!payload?.session) return
        void refresh()
        actions.unhideTask(taskId)
        actions.selectPi(taskId, payload.session.id)
      })
      .catch(() => {})
  }, [actions])

  // 会话四色状态判定（dsh：琥珀挂起/蓝运行/绿完成；pi：红错误/蓝运行/绿完成），供看板卡片消费。
  const nativeList = useNativeSessionsList(nativeSessions)
  const piReminders = useStore((state) => state.piReminders)
  const piErrors = useStore((state) => state.piErrors)
  const pending = usePendingInteractions(pendingInteractions ?? undefined)
  const stateCtx: SessionStateContext = useMemo(() => ({
    nativeById: nativeList?.byId,
    piReminders,
    piErrors,
    pendingKinds: pending ?? undefined,
  }), [nativeList, piReminders, piErrors, pending])
  const stateOf = useCallback((task: WbTask, session: WbSession) => resolveSessionState(session, task.id, stateCtx), [stateCtx])
  // 记录 dsh 视图当前打开的原生会话 id（持久化）：刷新后区分“恢复会话”还是“回到英雄”
  const nativeCurrentId = nativeList?.current ?? null
  useEffect(() => { actions.setDshNativeSession(nativeCurrentId) }, [nativeCurrentId])
  const reportTerminalStatus = useCallback((taskId: string, sessionId: string) => (status: 'connecting' | 'ready' | 'closed' | 'error') => {
    actions.setPiError(taskId, sessionId, status === 'error' || status === 'closed')
  }, [actions])

  // openSession/createSession 闭包随渲染更新；data 已在依赖中覆盖其主要输入。
  const body = useMemo(() => {
    switch (view) {
      case 'pi-draft': return <PiDraft useStore={useStore} actions={actions} />
      case 'terminal': {
        if (!terminalTask || !terminalSession) {
          return <div className={css.boardBody}><div className={css.empty}>会话不存在或已删除<br />请从左侧会话树重新选择</div></div>
        }
        // 对齐 dsh 原生会话头：标题下方是对话/终端选项卡（聊天窗口 / pi TUI），
        // 两种界面共用同一顶部栏与底部便签区
        return (
          <>
            <header className={nativeRoot.header}>
              <div className={nativeRoot.titleRow}>
                <div className={nativeRoot.titleCluster}>
                  <nav className={nativeRoot.crumbs} aria-label="会话路径">
                    <SessionTitle key={terminalSession.id} task={terminalTask} session={terminalSession} editTask={() => actions.setTaskForm(taskToForm(terminalTask))} />
                  </nav>
                </div>
              </div>
              <div className={nativeRoot.tabs} role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={chatMode && !trajectory}
                  className={`${nativeRoot.tab}${chatMode && !trajectory ? ` ${nativeRoot.tabActive}` : ''}`}
                  onClick={() => { setTrajectory(false); if (!chatMode) toggleSessionUi(terminalTask.id, terminalSession.id, 'chat') }}
                >对话</button>
                <button type="button" role="tab" aria-selected={chatMode && trajectory} className={`${nativeRoot.tab}${chatMode && trajectory ? ` ${nativeRoot.tabActive}` : ''}`} onClick={() => { setTrajectory(true); if (!chatMode) toggleSessionUi(terminalTask.id, terminalSession.id, 'chat') }}>轨迹</button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={!chatMode}
                  className={`${nativeRoot.tab}${!chatMode ? ` ${nativeRoot.tabActive}` : ''}`}
                  onClick={() => { if (chatMode) toggleSessionUi(terminalTask.id, terminalSession.id, 'tui') }}
                >终端</button>
              </div>
            </header>
            {/* 便签区落位：聊天界面由 PiComposer 的 dock 承载（输入卡片下方，
                与 dsh 一致：统计行 → 便签区）；终端无输入卡，由这里放视图底部 */}
            {chatMode
              ? (
                <PiChat trajectory={trajectory}
                  key={`${terminalTask.id}/${terminalSession.id}`}
                  taskId={terminalTask.id}
                  sessionId={terminalSession.id}
                  taskTitle={terminalTask.title}
                  onStatus={reportTerminalStatus(terminalTask.id, terminalSession.id)}
                  onBranch={(entryId) => branchSession(terminalTask.id, terminalSession.id, entryId)}
                />
              )
              : (
                <>
                  <PiTerminal
                    key={`${terminalTask.id}/${terminalSession.id}`}
                    taskId={terminalTask.id}
                    sessionId={terminalSession.id}
                    pasteRequest={terminalPaste}
                    onStatus={reportTerminalStatus(terminalTask.id, terminalSession.id)}
                  />
                  <PinnedNotesBar current={{ taskId: terminalTask.id, sessionId: terminalSession.id }} onPaste={(text) => setTerminalPaste({ id: Date.now(), text })} className={`${css.notesDock} ${css.notesDockTerminal}`} />
                </>
              )}
          </>
        )
      }
      case 'tasks':
        return <TasksBoard openSession={openSession} createSession={createSession} openTaskForm={(form) => actions.setTaskForm(form)} store={{ useStore, actions }} stateOf={stateOf} />
      case 'notes':
        return <NotesBoard openSession={openSession} store={{ useStore, actions }} />
      case 'sessions':
        return <SessionsBoard openSession={openSession} stateOf={stateOf} />
      case 'stats':
        return <StatsView stateOf={stateOf} />
      case 'archive':
        return <ArchiveView />
      default:
        return null
    }
  }, [trajectory, terminalPaste, view, data, piTaskId, piSessionId, terminalTask, terminalSession, useStore, actions, stateOf, reportTerminalStatus])

  // dsh 视图：便签按钮区由 conversation.composer.dock 槽位在原生布局内渲染；
  // 刷新后按持久化的原生会话 id 对齐：会话态盖遮罩等重开，英雄态清原生自动恢复。
  if (view === 'dsh') return <>
    <WorkbenchSessionTitle useStore={useStore} actions={actions} sessionId={nativeList?.current} />
    <DshBootAlign dshNativeSessionId={dshNativeSessionId} nativeSessions={nativeSessions} />
  </>
  return (
    <div className={css.centerLayer}>
      <div
        {...wbSurfaceProps(theme)}
        className={wbClass(theme, css.centerSurface)}
        style={{ left: sidebarWidth }}
      >
        {isWorkbenchView(view) ? <>
          <header className={nativeRoot.header}>
            <div className={nativeRoot.titleRow}><div className={nativeRoot.titleCluster}><span className={nativeRoot.crumbCurrent}>工作台</span></div></div>
            <nav className={`${nativeRoot.tabs} ${css.workbenchTabs}`} role="tablist" aria-label="工作台分类">
              {WORKBENCH_TABS.map((tab, index) => <button type="button" key={tab.id} id={`workbench-tab-${tab.id}`} role="tab" aria-selected={view === tab.id} aria-controls="workbench-panel" tabIndex={view === tab.id ? 0 : -1} className={`${nativeRoot.tab}${view === tab.id ? ` ${nativeRoot.tabActive}` : ''}`}
                onClick={() => actions.setView(tab.id)} onKeyDown={event => {
                  const next = event.key === 'ArrowRight' ? (index + 1) % WORKBENCH_TABS.length : event.key === 'ArrowLeft' ? (index + WORKBENCH_TABS.length - 1) % WORKBENCH_TABS.length : event.key === 'Home' ? 0 : event.key === 'End' ? WORKBENCH_TABS.length - 1 : null
                  if (next === null) return
                  event.preventDefault(); actions.setView(WORKBENCH_TABS[next].id)
                  document.getElementById(`workbench-tab-${WORKBENCH_TABS[next].id}`)?.focus()
                }}>{tab.label}</button>)}
            </nav>
          </header>
          <section id="workbench-panel" role="tabpanel" aria-labelledby={`workbench-tab-${view}`} className={css.workbenchPanel}>{body}</section>
        </> : body}
      </div>
    </div>
  )
}

export type { WbSession, WbTask }

// 本次页面生命周期是否已完成启动对齐；页面加载时刻用于限定对齐只在启动窗口内
// 进行——之后从其他视图进入英雄属于用户操作（品牌按钮已自带 clear），再对齐
// 反而会误等已被清空的状态。
const PAGE_LOAD_AT = Date.now()
let bootAligned = false

/**
 * 刷新后的 dsh 启动对齐。刷新前停在会话：盖遮罩等原生重开会话，落定即撤
 * （最多 2.5s 兜底，防会话已删除时永久遮挡）。刷新前停在英雄空态：原生可能
 * 自动恢复了上次的工作区/会话（英雄变成可直接输入的未门控态），立刻清一次
 * 并在短延迟后补一刀，回到受任务门控的英雄。
 * */
function DshBootAlign(props: { dshNativeSessionId: string | null; nativeSessions: NativeSessionsFace | null }): ReactElement | null {
  const [settled, setSettled] = useState(bootAligned)
  const sessionRef = useRef(props)
  sessionRef.current = props
  useEffect(() => {
    if (bootAligned) { setSettled(true); return }
    if (Date.now() - PAGE_LOAD_AT > 2500) { bootAligned = true; setSettled(true); return }
    if (!sessionRef.current.dshNativeSessionId) {
      sessionRef.current.nativeSessions?.clear?.()
      const timer = window.setTimeout(() => {
        sessionRef.current.nativeSessions?.clear?.()
        bootAligned = true
        setSettled(true)
      }, 400)
      return () => window.clearTimeout(timer)
    }
    const settle = () => { bootAligned = true; setSettled(true) }
    if (document.querySelector('[data-phase="active"], [data-phase="settling"]')) { settle(); return }
    const observer = new MutationObserver(() => {
      if (document.querySelector('[data-phase="active"], [data-phase="settling"]')) { observer.disconnect(); settle() }
    })
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-phase'], subtree: true })
    const timer = window.setTimeout(() => { observer.disconnect(); settle() }, 2500)
    return () => { observer.disconnect(); window.clearTimeout(timer) }
  }, [])
  if (settled) return null
  return <div className={css.bootCover} aria-hidden="true" />
}
