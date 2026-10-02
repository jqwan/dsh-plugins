/**
 * pi RPC transport: one `pi --mode rpc` child process speaking JSONL over
 * stdin/stdout. Commands are correlated by id; every other stdout line is a
 * protocol frame (agent events, extension UI requests) handed to `onFrame`
 * synchronously in arrival order.
 *
 * Protocol facts (pi 0.84.4, dist/modes/rpc): responses are
 * `{type:'response', command, id?, success, data?|error}`; events are the
 * AgentSessionEvent union; extension UI requests need an
 * `extension_ui_response` with the same `id`.
 *
 * @module @deepseek-ai/dsh-pi-agent/rpc
 */

import { spawn } from 'node:child_process'

const COMMAND_TIMEOUT_MS = 20_000
const MAX_STDERR_BYTES = 16 * 1024

/** One stdin command; `type` plus free-form protocol fields. */
export interface RpcCommand {
  id?: string
  type: string
  [key: string]: unknown
}

/** One stdout frame: a response or an unsolicited protocol event. */
export interface RpcFrame {
  type: string
  [key: string]: unknown
}

/** A settled command response. */
export interface RpcResponse extends RpcFrame {
  type: 'response'
  command?: string
  id?: string
  success: boolean
  data?: unknown
  error?: string
}

export interface PiRpcOptions {
  /** Absolute path of pi's cli.js entry. */
  cliEntry: string
  /** Working directory the pi agent operates in. */
  cwd: string
  /** Extra argv after `--mode rpc` (session file, provider/model, flags). */
  args: string[]
  /** Synchronous frame consumer, invoked in arrival order. */
  onFrame: (frame: RpcFrame) => void
  /** Optional stderr mirror for live diagnostics. */
  onStderr?: (text: string) => void
  /** Process exit callback (once). */
  onExit?: (info: { exitCode: number | null; signal: NodeJS.Signals | null }) => void
}

/** Strict `\n` JSONL reader (readline splits on extra Unicode separators). */
function attachLineReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    buffer += chunk
    let index: number
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      if (line) onLine(line)
    }
  })
}

let commandSeq = 0
function nextCommandId(): string {
  commandSeq += 1
  return `pi-agent-${Date.now().toString(36)}-${commandSeq}`
}

/** One live pi RPC child process. */
export class PiRpcProcess {
  readonly child: ReturnType<typeof spawn>
  private readonly pending = new Map<string, { resolve: (response: RpcResponse) => void; timer: NodeJS.Timeout }>()
  private exited = false
  exitPromise: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>
  private stderrTail = ''

  constructor(private readonly options: PiRpcOptions) {
    this.child = spawn(process.execPath, [options.cliEntry, '--mode', 'rpc', ...options.args], {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })
    attachLineReader(this.child.stdout!, line => this.handleLine(line))
    this.child.stderr!.setEncoding('utf8')
    this.child.stderr!.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-MAX_STDERR_BYTES)
      if (chunk.trim() !== '') this.options.onStderr?.(chunk.trim())
    })
    this.exitPromise = new Promise(resolve => {
      this.child.once('exit', (exitCode, signal) => {
        this.exited = true
        this.settleAll('pi process has exited')
        options.onExit?.({ exitCode, signal })
        resolve({ exitCode, signal })
      })
    })
    this.child.once('error', error => {
      if (!this.exited) this.settleAll(`pi process failed to start: ${error.message}`)
    })
  }

  /** Whether the child has already exited. */
  get isExited(): boolean {
    return this.exited
  }

  /** Last stderr lines, for failure diagnostics. */
  get stderrHint(): string {
    return this.stderrTail.trim().split('\n').slice(-3).join('\n')
  }

  /** Write a command without waiting for its response. */
  write(command: RpcCommand): boolean {
    if (this.exited || !this.child.stdin || this.child.stdin.destroyed) return false
    this.child.stdin.write(`${JSON.stringify(command)}\n`)
    return true
  }

  /** Write a correlated command and await its response (timeout-backed). */
  command(command: RpcCommand, timeoutMs = COMMAND_TIMEOUT_MS): Promise<RpcResponse> {
    return new Promise(resolve => {
      const id = command.id ?? nextCommandId()
      const payload = { ...command, id }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ type: 'response', command: payload.type, id, success: false, error: 'pi command timed out' })
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, timer })
      if (!this.write(payload)) {
        clearTimeout(timer)
        this.pending.delete(id)
        resolve({ type: 'response', command: payload.type, id, success: false, error: 'pi process is not running' })
      }
    })
  }

  /** SIGTERM → wait → SIGKILL; resolves when the child is gone. */
  async stop(timeoutMs = 4000): Promise<void> {
    if (this.exited) return
    try { this.child.kill('SIGTERM') } catch { /* already gone */ }
    const deadline = Date.now() + timeoutMs
    while (!this.exited && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 30))
    }
    if (!this.exited) {
      try { this.child.kill('SIGKILL') } catch { /* already gone */ }
      await this.exitPromise
    }
  }

  private handleLine(line: string): void {
    let frame: RpcFrame
    try {
      frame = JSON.parse(line) as RpcFrame
    } catch {
      return
    }
    if (!frame || typeof frame !== 'object') return
    if (frame.type === 'response') {
      const id = typeof frame.id === 'string' ? frame.id : undefined
      const pending = id === undefined ? undefined : this.pending.get(id)
      if (pending !== undefined) {
        this.pending.delete(id!)
        clearTimeout(pending.timer)
        pending.resolve(frame as RpcResponse)
        return
      }
    }
    this.options.onFrame(frame)
  }

  private settleAll(error: string): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.resolve({ type: 'response', success: false, error })
    }
    this.pending.clear()
  }
}
