/**
 * Workbench-web plugin: mounts the π workbench (tasks, notes, pi TUI sessions,
 * and later dsh sessions) under the `/workbench` HTTP prefix of the web GUI.
 *
 * The runtime is an Express app ported from the standalone workspace server;
 * it never listens on its own — `ctx.webServer` forwards requests and the
 * `/workbench/ws` TUI WebSocket upgrade to it.
 *
 * @module @deepseek-ai/dsh-workbench-web
 */

import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createRuntime } from './runtime.js'
import type { WorkbenchRuntime } from './runtime.js'
import type { HostEventBus, SessionControllerApi, WorkspaceRegistryApi } from './host-services.ts'

export type { DshBridge, WorkbenchRuntime, WorkbenchRuntimeOptions } from './runtime.js'

/** Plugin configuration (all optional; persistent settings live in the data dir). */
export interface WorkbenchConfig {
  /** 数据目录；默认 `$DSH_HOME/data/workbench`，未设置 DSH_HOME 时退化为包内 data/ */
  dataDir?: string
  /** pi 会话 JSONL 目录；默认 `<dataDir>/sessions` */
  sessionsDir?: string
  /** pi cli.js 绝对路径；缺省时尝试解析插件依赖里的 pi 包 */
  piCliEntry?: string
}

export const name = 'workbench-web'
export const inject = ['webServer', 'sessionController', 'workspaceRegistry']

/**
 * Mount the workbench runtime on the web server.
 * @param ctx - Host context carrying the webServer and sessionController services.
 * @param config - Optional path overrides injected through the cordis patch.
 */
export function apply(ctx: Context, config: WorkbenchConfig = {}): void {
  // Cordis 会把省略/仅注释的 config 块以 null 传入，这里兜底为空对象。
  config = config ?? {}
  const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  // dsh 进程环境通常没有 DSH_HOME；默认落在用户 home 的 .dsh 下，数据不随仓库走。
  const defaultDataDir = process.env.DSH_HOME
    ? path.join(process.env.DSH_HOME, 'data', 'workbench')
    : path.join(homedir(), '.dsh', 'data', 'workbench')
  const runtime: WorkbenchRuntime = createRuntime({
    publicDir: path.join(packageDir, 'public'),
    vendorDir: path.join(packageDir, 'vendor'),
    dataDir: config.dataDir ?? defaultDataDir,
    sessionsDir: config.sessionsDir,
    piCliEntry: config.piCliEntry,
    services: {
      // ctx 上的宿主服务按最小工作面读取（见 host-services.ts 的说明）。
      sessionController: (ctx as unknown as { sessionController?: SessionControllerApi }).sessionController,
      workspaceRegistry: (ctx as unknown as { workspaceRegistry?: WorkspaceRegistryApi }).workspaceRegistry,
      onSessionEvent: (handler) => (ctx as unknown as HostEventBus).on(
        'session/event',
        (session, event) => handler((session as { id: string }).id, event),
      ),
      onAgentStatus: (handler) => (ctx as unknown as HostEventBus).on(
        'agent/status',
        (payload) => {
          const { agent, status } = payload as { agent: { id: string }; status: string }
          handler(agent.id, status === 'running')
        },
      ),
    },
  })

  ctx.effect(() => {
    runtime.start()
    const disposeRoute = ctx.webServer.register({
      kind: 'prefix',
      path: '/workbench',
      handler: (req, res) => runtime.handleRequest(req, res),
    })
    const disposeUpgrade = ctx.webServer.registerUpgrade({
      path: '/workbench/ws',
      handler: (req, socket, head) => runtime.handleUpgrade(req, socket, head),
    })
    return async () => {
      disposeRoute()
      disposeUpgrade()
      await runtime.close()
    }
  }, 'workbench-web: runtime')
}
