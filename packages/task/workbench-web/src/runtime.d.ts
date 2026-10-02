import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

/** 桥内 dsh 会话运行态句柄（详细形状见 src/dsh/bridge.js） */
export interface DshBridge {
  readonly available: boolean
  createSession(context: { task?: unknown; workingDir?: string | null }): Promise<string>
  readSession(child: Record<string, unknown>): unknown
  isRunning(child: Record<string, unknown>): boolean
  sendPrompt(child: Record<string, unknown>, text: string): Promise<void>
  stop(child: Record<string, unknown>): Promise<boolean>
  forget(child: Record<string, unknown>): void
  dispose(): Promise<void>
}

/** 宿主注入的服务：dsh 会话能力与事件订阅点（均可选；缺失时降级为仅 pi 会话） */
export interface WorkbenchRuntimeServices {
  /** 宿主 sessionController 服务（ctx.sessionController） */
  sessionController?: unknown
  /** 宿主工作区注册表（ctx.workspaceRegistry），用于把 dsh 会话挂到匹配的工作区 */
  workspaceRegistry?: unknown
  /** 订阅宿主会话事件（session/event）；返回 disposer */
  onSessionEvent?(handler: (sessionId: string, event: unknown) => void): () => void
  /** 订阅宿主 agent 运行状态（agent/status）；返回 disposer */
  onAgentStatus?(handler: (sessionId: string, running: boolean) => void): () => void
}

export interface WorkbenchRuntimeOptions {
  /** 工作台前端静态资源目录 */
  publicDir: string
  /** xterm 三件套静态资源目录 */
  vendorDir: string
  /** 数据目录（默认 $DSH_HOME/data/workbench，退化为包内 data/） */
  dataDir?: string
  /** pi 会话 JSONL 目录（默认 dataDir/sessions） */
  sessionsDir?: string
  /** pi cli.js 绝对路径；缺省时尝试从插件依赖解析 */
  piCliEntry?: string
  /** 宿主注入的服务 */
  services?: WorkbenchRuntimeServices
}

export interface WorkbenchRuntime {
  /** webServer prefix handler（内部剥离 /workbench 前缀） */
  handleRequest(req: IncomingMessage, res: ServerResponse): void
  /** webServer upgrade handler（/workbench/ws） */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void
  readonly dshBridge: DshBridge
  start(): void
  close(): Promise<void>
}

export function createRuntime(options: WorkbenchRuntimeOptions): WorkbenchRuntime
