/**
 * 工作台原生融合入口（第二期）：
 * - `sidebar.workspaces`（priority -1，遮蔽原生 WorkspaceBrowser）→ 工作台
 *   会话树接管侧栏浏览区（工具行左端图标按钮切换 pi/dsh 会话列表）；
 *   `sidebar.brand.mark/name` → 标识当前列表类型，点击进对应英雄首屏
 *   （dsh 与 pi 同款：先选任务，未选任务时输入保持惰性、不能发送）；
 *   原生折叠/原生设置保留；
 * - `shell.overlay` 条目 `workbench-center` → 中心区切换面（pi 终端/聊天、
 *   任务/便签/会话看板、统计、回收站；dsh 视图不渲染，原生聊天零改动露出）；
 * - `conversation.hero.workspace` → 接管原生新建会话首屏的工作区选择槽位
 *   （渲染为空），把"点击输入框"改道为新建任务弹窗；"选择任务" chip 由
 *   WorkbenchHeroTaskMount 植入原生工作区行；
 * - `conversation.composer.dock` → dsh 原生聊天输入框下方的便签按钮区
 *   （文档流内，不遮挡会话内容）；
 * - `shell.overlay` 条目 `workbench-task-form` → 全局新建/编辑任务弹层
 *   （任何视图下可唤起，含定时发布/模型等更多设置）。
 * 主题仅保留 classic 单风格，亮暗跟随宿主；数据与 PTY 全部来自同源
 * workbench-web 插件（/workbench/api + /workbench/ws）。
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { WorkbenchBrandMark, WorkbenchBrandName } from './brand.tsx'
import { WorkbenchCenter } from './center.tsx'
import { WorkbenchHeroWorkspaceGate } from './hero-task.tsx'
import { TaskFormOverlay } from './task-form.tsx'
import { WorkbenchNotesDock } from './notes-bar.tsx'
import { WorkbenchSidebar, type WorkbenchFace } from './sidebar.tsx'
import type { NativeSessionsFace, UiSessionFace } from './host.ts'
import { createWorkbenchStore } from './store.ts'

/** 浏览器半边需要的宿主服务：slots 注册面 + sessions 会话模型 + uiSession 挂起交互 + theme 覆盖面。 */
export const inject = ['slots', 'sessions', 'uiSession']

/** 注册工作台侧栏区、中心切换面、设置分区与全局换肤。 */
export function apply(ctx: ClientContext): void {
  const store = createWorkbenchStore()
  const face: WorkbenchFace = {
    openDshSession: (sessionId) => {
      const sessions = (ctx as unknown as { sessions?: NativeSessionsFace }).sessions
      if (!sessions?.open) {
        console.error('[ui-workbench] sessions 服务不可用，无法打开 dsh 会话')
        return
      }
      void Promise.resolve(sessions.open(sessionId)).catch((error: unknown) => {
        console.error('[ui-workbench] 打开 dsh 会话失败', error)
      })
    },
    nativeSessions: (ctx as unknown as { sessions?: NativeSessionsFace }).sessions ?? null,
    pendingInteractions: (ctx as unknown as { uiSession?: UiSessionFace }).uiSession?.pendingInteractions ?? null,
  }
  ctx.slots.inject('sidebar.workspaces', () =>
    ctx.slots.register(
      {
        name: 'sidebar.workspaces',
        // 遮蔽 ui-workspace 的 WorkspaceBrowser（priority 0）：最低 priority 渲染。
        priority: -1,
        store,
        inject: () => face,
      },
      WorkbenchSidebar,
    ))
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'workbench-center',
        store,
        inject: () => face,
      },
      WorkbenchCenter,
    ))
  // 品牌行接管：π/dsh 合并切换按钮（替换 dsh 图标与版本号）+ 界面前进/后退。
  // 原生壳把这两个座位渲染在自己的 New Session 按钮里；点击一律拦下——
  // dsh 不再透传 startSession（它会继承最近工作区开出无归属空会话），
  // 改为清暂选任务 + 清当前会话回英雄空态，与 pi 英雄同款先选任务再发言。
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.register({ name: 'sidebar.brand.mark', store, inject: () => face }, WorkbenchBrandMark))
  ctx.slots.inject('sidebar.brand.name', () =>
    ctx.slots.register({ name: 'sidebar.brand.name', store, inject: () => face }, WorkbenchBrandName))
  // 新建会话首屏：工作区选择被任务选择取代。隐藏原生工作区 chip；工作区
  // 选择槽位改为空渲染的改道器——原生在未选工作区时把"点击输入框"路由为
  // 打开工作区选择，这里拦截并改为弹出新工作台的新建任务弹窗（必须先
  // 选/建任务才能发起会话，任务承担工作路径职责）。
  ctx.slots.inject('conversation.hero.workspace', () =>
    ctx.slots.register({ name: 'conversation.hero.workspace', priority: -1, store }, WorkbenchHeroWorkspaceGate))
  ctx.slots.inject('conversation.composer.dock', () =>
    ctx.slots.register(
      // order 1：排在原生会话统计行（StatsLine，order 0）之后，便签区贴视图最底部，
      // 与 pi 聊天/终端的底部落位一致
      { name: 'conversation.composer.dock', id: 'workbench-notes', order: 1 },
      WorkbenchNotesDock,
    ))
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      { name: 'shell.overlay', id: 'workbench-task-form', store },
      TaskFormOverlay,
    ))

  // 原生壳的独立“New Session”大按钮与工作台会话树功能重复，注入样式隐藏；
  // 品牌行（已接管为 π/dsh 切换）不在此列。
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.dshCss = 'ui-workbench-hide-new-session'
    // 原生按钮的哈希类以 _newSession 结尾（模块名前缀随构建变化，后缀稳定）
    tag.textContent = 'button[class*="newSession"] { display: none !important; }'
    document.head.append(tag)
    return () => { tag.remove() }
  }, 'ui-workbench: hide native new-session button')

  // 原生壳微调：品牌行压缩留白；品牌身份区占满按钮宽度（‹ › 推到折叠按钮
  // 旁边）；会话列表区贴窗口左缘，品牌/底部行保持原生左右间距。
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.dshCss = 'ui-workbench-shell-layout'
    tag.textContent = [
      // 原生品牌行 60px 高留白偏多，压紧并缩小与下方新任务按钮的间距
      '[class*="_logoRow"] { height: 44px; margin-bottom: 4px; }',
      // 新建会话首屏：隐藏工作区选择 chip（任务选择取代之）
      'div[class*="_heroWorkspaceRow"] > button[class*="_workspace"] { display: none !important; }',
      '[class*="_brandIdentity"] { width: 100%; gap: 0; }',
      '[class*="_brandName"] { flex: 1; min-width: 0; }',
      '[class*="_regionArea"] { margin-left: calc(-1 * var(--dsh-sidebar-inline-padding, 12px)); padding-left: 0; }',
    ].join('\n')
    document.head.append(tag)
    return () => { tag.remove() }
  }, 'ui-workbench: shell layout')

  // 工作台语义对齐：原生未选工作区的占位文案“选择一个工作区开始”改为
  // “选择一个任务开始”（locale 不能重复注册覆盖，走自愈的 DOM 文案替换，
  // 只精确匹配原文案，自身写入不会回环）。pi 触发态占位在 PiComposer 同文案。
  ctx.effect(() => {
    const SOURCE = '选择一个工作区开始'
    const TARGET = '选择一个任务开始'
    const swap = () => {
      for (const node of document.querySelectorAll('[data-composer-placeholder]')) {
        if (node.textContent === SOURCE) node.textContent = TARGET
      }
    }
    swap()
    const observer = new MutationObserver(swap)
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    return () => observer.disconnect()
  }, 'ui-workbench: composer placeholder wording')

}
