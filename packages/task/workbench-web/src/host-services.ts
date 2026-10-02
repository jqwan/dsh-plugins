/**
 * 工作台消费的宿主服务最小类型（不做 cordis 模块增强——增强在 NodeNext
 * 下会遮蔽宿主自身的类型合并）。运行时这些服务由宿主注入，是宿主的
 * 真实实例；这里只声明我们用到的方法面。
 */

/** 工作台消费的最小 dsh 会话事件形状（seq/type/time/data 子集） */
export interface DshSessionEvent {
  seq?: number
  type: string
  time?: number | string
  data?: {
    id?: string
    content?: unknown
    source?: { kind?: string }
    message?: { id?: string; role?: string; content?: unknown }
    usage?: {
      inputTokens?: number
      outputTokens?: number
      cacheReadTokens?: number
      cacheWriteTokens?: number
      reasoningTokens?: number
    }
    interrupted?: boolean
  }
}

/** dsh 可路由模型目录（按 provider 分组；bridge 原样透传给 /api/models）。 */
export interface DshModelCatalog {
  default?: { provider?: string; id?: string; name?: string } | null
  groups?: Array<{ id: string; name?: string; models: Array<{ id: string; name?: string }> }>
}

/** 宿主 sessionController 的工作面子集（ctx.sessionController） */
export interface SessionControllerApi {
  /** workspaceId（经 workspaceRegistry create-or-get 得到）或 cwd 二选一。 */
  create(request: { cwd?: string; workspaceId?: string; sessionId?: string; agentPreset?: string }): Promise<{ sessionId: string }>
  prompt(request: {
    requestId: string
    sessionId: string
    mode: 'queue' | 'steer'
    content: Array<{ type: 'text'; text: string }>
    clientTimeZone?: string
  }, signal?: AbortSignal): Promise<{ accepted: true }>
  cancel(request: { sessionId: string }): Promise<{ accepted: true }>
  rename(request: { sessionId: string; title: string }): Promise<unknown>
  /** 可路由模型目录；旧版本宿主未提供时缺省（bridge 会回退到空目录）。 */
  modelCatalog?(): Promise<DshModelCatalog>
  /** 会话级模型/思考等级选择；旧版本宿主未提供时缺省。 */
  selectModel?(request: { sessionId: string; provider: string; model: string; reasoningEffort?: string }): Promise<unknown>
  inspect(sessionId: string): Promise<{
    meta: { id?: string; cwd?: string; createdAt?: string }
    inheritedEventCount?: number
    events: DshSessionEvent[]
  }>
}

/** 宿主工作区注册表的工作面子集（ctx.workspaceRegistry） */
export interface WorkspaceRegistryApi {
  list(): Array<{ id: string; path: string }>
  /** create-or-get：同规范路径返回既有工作区（attach 幂等）。 */
  create(path: string, title?: string): Promise<{
    id: string
    path: string
    sessionIds?: readonly string[]
    attachSession?(sessionId: string): Promise<void>
  }>
}

/** cordis 事件总线的工作面子集（ctx.on） */
export interface HostEventBus {
  on(name: string, listener: (...args: unknown[]) => void): () => unknown
}
