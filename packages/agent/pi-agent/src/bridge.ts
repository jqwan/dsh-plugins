/**
 * DSH tool bridge (host side): exposes the dsh tool registry to the in-process
 * pi bridge extension over a private unix-socket JSONL channel. One server per
 * pi agent: the socket path rides the spawned pi process's environment, the
 * extension connects, pulls the wire schemas visible to that agent, and relays
 * every model tool call through `ctx.tools.execute` — which fills in this
 * agent as the execution identity, so approval, permissions, and sandbox all
 * resolve through the native pipeline.
 *
 * Protocol (JSON lines, one JSON object each):
 *   extension → host  {"id","kind":"list"}
 *   host → extension  {"id","tools":[ToolSchema…]}
 *   extension → host  {"id","kind":"execute","name","arguments"}
 *   host → extension  {"id","ok":true,"text"} | {"id","ok":false,"error"}
 *   extension → host  {"kind":"cancel","id"}   (no reply; aborts the call)
 *
 * @module @deepseek-ai/dsh-pi-agent/bridge
 */

import { createServer, type Server, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionInput, ToolExecutionResult, ToolRuntime } from '@deepseek-ai/dsh-tools'

/** One bridged tool call in flight. */
interface InFlightCall {
  controller: AbortController
}

export interface ToolBridgeOptions {
  /** The pi-backed agent on whose behalf every bridged call runs. */
  agent: Agent
  /** The dsh tool runtime (the global registry service). */
  tools: ToolRuntime
  /**
   * The agent registry, used to wrap every bridged execution in the agent's
   * initiator boundary — model-requested calls run "inside the agent's active
   * driver" in the native kernel, and authority checks (goal tools) read that
   * attribution via agents.currentInitiator(). A socket callback starts a
   * fresh async context, so the boundary must be re-established here.
   */
  agents: AgentRegistry
  /** Unix socket path; unlinked stale files before listening. */
  socketPath: string
  logger: { info: (message: string) => void; warn: (message: string) => void }
}

/**
 * Own the bridge channel for one pi agent. The server lives from `start()`
 * until `stop()`; a dead pi child simply drops its connection, and every
 * in-flight call aborts with its disconnect.
 */
export class ToolBridgeServer {
  private readonly agent: Agent
  private readonly tools: ToolRuntime
  private readonly agents: AgentRegistry
  private readonly socketPath: string
  private readonly logger: ToolBridgeOptions['logger']
  private server: Server | undefined
  /** Every open shim (MCP server) connection, for teardown. */
  private readonly connections = new Set<Socket>()
  /** Call id → in-flight execution (all connections share one map). */
  private readonly inFlight = new Map<string, InFlightCall>()
  private callSeq = 0
  private starting: Promise<void> | undefined

  constructor(options: ToolBridgeOptions) {
    this.agent = options.agent
    this.tools = options.tools
    this.agents = options.agents
    this.socketPath = options.socketPath
    this.logger = options.logger
  }

  /** Listen (idempotent). Resolves once the socket accepts connections. */
  start(): Promise<void> {
    this.starting ??= new Promise((resolve, reject) => {
      const server = createServer(socket => this.onConnection(socket))
      this.server = server
      server.once('error', error => {
        this.server = undefined
        reject(error)
      })
      // A crashed predecessor can leave a dead socket file behind.
      server.listen(this.socketPath, () => resolve())
    })
    return this.starting
  }

  /** Close the server, drop every connection, and abort in-flight calls. */
  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.abortAll(new Error('pi tool bridge stopped'))
    for (const socket of this.connections) socket.destroy()
    this.connections.clear()
    if (server === undefined) return
    await new Promise<void>(resolve => {
      server.close(() => resolve())
    })
  }

  private onConnection(socket: Socket): void {
    this.connections.add(socket)
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim() !== '') this.handleLine(socket, line)
        newline = buffer.indexOf('\n')
      }
    })
    const drop = (): void => {
      this.connections.delete(socket)
    }
    socket.on('close', drop)
    socket.on('error', error => {
      this.logger.warn(`pi bridge connection error: ${error.message}`)
      drop()
    })
  }

  private handleLine(socket: Socket, line: string): void {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(line) as Record<string, unknown>
    } catch {
      this.logger.warn('pi bridge: dropping malformed JSON line')
      return
    }
    const kind = frame.kind
    if (kind === 'list') {
      this.reply(socket, frame.id, { tools: this.visibleSchemas() })
      return
    }
    if (kind === 'execute') {
      void this.execute(socket, frame)
      return
    }
    if (kind === 'cancel') {
      const id = typeof frame.id === 'string' ? frame.id : undefined
      if (id !== undefined) this.inFlight.get(id)?.controller.abort(new Error('pi cancelled the tool call'))
      return
    }
    this.logger.warn(`pi bridge: unknown frame kind "${String(kind)}"`)
  }

  /** The agent-scoped wire schemas, the same view the request anchor reports. */
  private visibleSchemas(): ToolSchema[] {
    try {
      return this.tools.schemas(this.agent as never)
    } catch (error: unknown) {
      this.logger.warn(`pi bridge: schema listing failed (${error instanceof Error ? error.message : String(error)})`)
      return []
    }
  }

  private async execute(socket: Socket, frame: Record<string, unknown>): Promise<void> {
    const id = typeof frame.id === 'string' ? frame.id : ''
    const name = typeof frame.name === 'string' ? frame.name : ''
    if (id === '' || name === '') {
      this.reply(socket, id, { ok: false, error: 'malformed execute frame' })
      return
    }
    const controller = new AbortController()
    this.inFlight.set(id, { controller })
    const callId = ToolCallId(`pi-bridge-${this.callSeq += 1}-${randomUUID().slice(0, 8)}`)
    try {
      // Attribute the call to this agent's driver: the socket callback starts
      // a fresh async context, so agents.currentInitiator() would be undefined
      // without the boundary — authority checks (goal tools) require it.
      const result = await this.agents.withInitiator(this.agent, () => this.tools.execute({
        callId,
        name,
        arguments: frame.arguments,
        agent: this.agent,
        signal: controller.signal,
      } satisfies ToolExecutionInput))
      this.reply(socket, id, { ok: true, text: resultText(result), isError: result.isError })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this.reply(socket, id, { ok: false, error: message })
    } finally {
      this.inFlight.delete(id)
    }
  }

  private reply(socket: Socket, id: unknown, payload: Record<string, unknown>): void {
    if (socket.destroyed) return
    socket.write(`${JSON.stringify({ id, ...payload })}\n`)
  }

  private abortAll(reason: Error): void {
    for (const call of this.inFlight.values()) call.controller.abort(reason)
    this.inFlight.clear()
  }
}

/**
 * Flatten a dsh execution result into the single text the pi tool result
 * carries: text blocks joined; an empty render falls back to the canonical
 * JSON value so the model never sees a vacuous result.
 */
function resultText(result: ToolExecutionResult): string {
  const parts: string[] = []
  for (const block of result.content) {
    if (block !== null && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string' && text !== '') parts.push(text)
    }
  }
  if (parts.length > 0) return parts.join('\n')
  if (!result.isError && result.value !== undefined) return JSON.stringify(result.value)
  return result.isError ? 'tool failed' : '(empty result)'
}
