/**
 * 宿主客户端服务的最小本地类型（不依赖 @deepseek-ai 包的类型面，
 * 避免 rc/alpha 版本线混入 lockfile）。只声明我们消费的成员。
 */

/** 宿主 dsh 会话行（api-session-controller SessionSummary 的子集）。 */
export interface NativeSessionRow {
  id: string
  title?: string
  displayTitle: string
  cwd?: string
  running: boolean
  /** 跑完时未被选中且尚未打开（原生绿色"完成"提醒点）。缺省 = false。 */
  completed?: boolean
  blank: boolean
  updatedAt: number
}

/** 宿主会话列表快照（SessionListState 的子集）。 */
export interface NativeSessionList {
  ids: string[]
  byId: Record<string, NativeSessionRow>
  current: string | undefined
}

/** 客户端 sessions 服务的消费面（ISessions 子集）。 */
export interface NativeSessionsFace {
  list: {
    getSnapshot(): NativeSessionList
    subscribe(listener: () => void): () => void
  }
  open(id: string): Promise<unknown> | void
  /** 清空当前选中（进英雄首屏的 pi 式空态；回到“未选工作区”惰性输入）。 */
  clear?(): void
}

/** 宿主挂起的用户交互（审批/计划评审/提问，琥珀点来源）。 */
export interface NativePendingInteraction {
  key: string
  kind: string
  sessionId: string
}

/** 宿主 uiSession 服务的消费面（UiSession 子集）。 */
export interface UiSessionFace {
  pendingInteractions: {
    getSnapshot(): ReadonlyMap<string, NativePendingInteraction>
    subscribe(listener: () => void): () => void
  }
}

/** 侧栏 owner props 回传的几何事实。 */
export interface SidebarOwnerProps {
  collapsed: boolean
  width: number
}
