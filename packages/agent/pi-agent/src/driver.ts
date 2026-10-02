/**
 * Per-agent pi RPC session: owns the child process lifecycle for one dsh
 * agent, drives prompts/steers/aborts, and feeds protocol frames to the
 * translation layer (PiAgent) synchronously as they arrive.
 *
 * v1 scope: text + tool cycles. `extension_ui_request` frames are answered
 * `cancelled` with a log line (the dsh approval/ask bridge lands later);
 * compaction and retry frames pass through untranslated.
 *
 * @module @deepseek-ai/dsh-pi-agent/driver
 */

import { join } from 'node:path'
import { PiRpcProcess, type RpcFrame } from './rpc.ts'
import { piCatalog, resolvePiCliEntry } from './catalog.ts'

/** Outcome of one finished pi run (one dsh turn). */
export interface DriverTurnOutcome {
  /** pi final stop reason folded into dsh's turn-end taxonomy. */
  kind: 'completed' | 'max-tokens' | 'error' | 'aborted'
  /** Structured failure facts for `kind: 'error'`. */
  error?: { message: string; code: string }
}

/** pi route facts as read from `get_state`. */
export interface PiRoute {
  provider?: string
  model?: string
  thinkingLevel?: string
}

interface RunLatch {
  promise: Promise<DriverTurnOutcome>
  resolve: (outcome: DriverTurnOutcome) => void
}

export interface PiDriverOptions {
  /** pi cli.js path; resolved from the plugin dependency when omitted. */
  piCliEntry?: string
  /** Workspace the agent operates in. */
  cwd: string
  /** Root directory holding `<sessionId>.jsonl` pi session files. */
  sessionsDir: string
  /** dsh session id; determines the deterministic pi session file name. */
  sessionId: string
  /** Optional provider/model argv overrides (route from dsh selection). */
  provider?: string
  model?: string
  /** pi thinking level passed as `--thinking`. */
  thinkingLevel?: string
  /** Frame consumer, invoked synchronously in arrival order. */
  onFrame: (frame: RpcFrame) => void
  /** Diagnostics sink. */
  logger: { info: (message: string) => void; warn: (message: string) => void }
}

/**
 * pi session handle for one agent. Lazy: the child process starts on the
 * first prompt and dies with `stop()` (agent disposal) or a fatal exit.
 */
export class PiDriver {
  private process: PiRpcProcess | undefined
  /** Set while a prompt is in flight; resolves at the run's final agent_end. */
  private run: RunLatch | undefined
  private lastStopReason: string | undefined
  private lastErrorMessage: string | undefined
  private abortRequested = false
  private seq = 0
  private route: PiRoute

  constructor(private readonly options: PiDriverOptions) {
    this.route = {
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
    }
  }

  /** Deterministic pi session file for this dsh session. */
  get sessionFile(): string {
    return join(this.options.sessionsDir, `${this.options.sessionId}.jsonl`)
  }

  /** The provider/model route pi is currently on, when known. */
  get currentRoute(): PiRoute {
    return this.route
  }

  private nextId(): string {
    this.seq += 1
    return `pa-${this.seq}`
  }

  /** Spawn the child (once) and read its state; returns the live route. */
  async start(): Promise<PiRoute> {
    const proc = await this.ensureProcess()
    const state = await proc.command({ type: 'get_state', id: this.nextId() }, 8000)
    if (state.success && state.data !== undefined && state.data !== null) {
      this.route = this.readRoute(state.data as Record<string, unknown>)
    }
    return this.route
  }

  /**
   * Submit one user turn. Frames stream through `onFrame`; the returned
   * promise settles at the run's final `agent_end` (or process exit).
   */
  async prompt(text: string): Promise<DriverTurnOutcome> {
    if (this.run !== undefined) throw new Error('pi driver: a prompt is already in flight')
    const proc = await this.ensureProcess()
    this.lastStopReason = undefined
    this.lastErrorMessage = undefined
    this.abortRequested = false
    const latch = Promise.withResolvers<DriverTurnOutcome>()
    this.run = latch
    const response = await proc.command({
      type: 'prompt',
      id: this.nextId(),
      message: text,
      streamingBehavior: 'followUp',
    }, 30_000)
    if (!response.success) {
      this.run = undefined
      throw new Error(`pi rejected the prompt: ${response.error ?? 'unknown error'}`)
    }
    return await latch.promise
  }

  /**
   * Switch the live (or next) pi model route: dsh `model/selection` events
   * land here. Updates the route the request anchor reports, too.
   */
  async setModel(selection: { provider: string; model: string; reasoningEffort?: string }): Promise<void> {
    this.route = {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { thinkingLevel: selection.reasoningEffort }),
    }
    if (this.process === undefined || this.process.isExited) return
    const response = await this.process.command({
      type: 'set_model',
      id: this.nextId(),
      provider: selection.provider,
      modelId: selection.model,
    }, 15_000)
    if (!response.success) {
      this.options.logger.warn(`pi set_model failed: ${response.error ?? 'unknown error'}`)
      return
    }
    if (selection.reasoningEffort !== undefined) {
      await this.process.command({
        type: 'set_thinking_level',
        id: this.nextId(),
        level: selection.reasoningEffort,
      }, 15_000)
    }
  }

  /** Queue steering input into the live run (pi `steer` command). */
  async steer(text: string): Promise<void> {
    const proc = this.process
    if (proc === undefined || proc.isExited) return
    await proc.command({ type: 'steer', id: this.nextId(), message: text }, 15_000)
  }

  /** Abort the live run; its promise settles `aborted` at the next agent_end. */
  abort(): void {
    this.abortRequested = true
    void this.process?.command({ type: 'abort', id: this.nextId() }, 10_000)
  }

  /** Terminate the child; safe to call repeatedly. */
  async stop(timeoutMs = 4000): Promise<void> {
    const proc = this.process
    this.process = undefined
    if (proc === undefined) return
    if (this.run !== undefined) {
      const run = this.run
      this.run = undefined
      run.resolve(this.abortRequested
        ? { kind: 'aborted' }
        : { kind: 'error', error: { message: 'pi process stopped mid-turn', code: 'PI_DRIVER_STOPPED' } })
    }
    await proc.stop(timeoutMs)
  }

  private async ensureProcess(): Promise<PiRpcProcess> {
    if (this.process !== undefined && !this.process.isExited) return this.process
    const cliEntry = resolvePiCliEntry(this.options.piCliEntry)
    if (cliEntry === undefined) throw new Error('pi not found: install @earendil-works/pi-coding-agent or set piCliEntry')
    // dsh's default model route (e.g. deepseek-official) is not a pi route:
    // only forward provider/model that pi's own catalog recognizes, else let
    // pi fall back to its ~/.pi default. The catalog-only LLM adapter (P3)
    // makes the native picker pi-routable so this filter becomes a no-op.
    let provider = this.options.provider
    let model = this.options.model
    if (provider !== undefined || model !== undefined) {
      try {
        const catalog = await piCatalog(cliEntry)
        const known = catalog.models.some(entry => entry.provider === provider && entry.id === model)
        if (!known) {
          this.options.logger.warn(
            `route ${String(provider ?? '')}/${String(model ?? '')} is not in the pi catalog; using pi's default model`,
          )
          provider = undefined
          model = undefined
          this.route = { ...(this.options.thinkingLevel === undefined ? {} : { thinkingLevel: this.options.thinkingLevel }) }
        }
      } catch (error: unknown) {
        this.options.logger.warn(`pi catalog unavailable (${error instanceof Error ? error.message : String(error)}); forwarding route as-is`)
      }
    }
    const args = [
      '--session', this.sessionFile,
      ...(provider !== undefined && model !== undefined
        ? ['--provider', provider, '--model', model]
        : []),
      ...(this.options.thinkingLevel === undefined ? [] : ['--thinking', this.options.thinkingLevel]),
    ]
    this.options.logger.info(`spawn: node ${cliEntry} ${args.join(' ')} (cwd ${this.options.cwd})`)
    const proc = new PiRpcProcess({
      cliEntry,
      cwd: this.options.cwd,
      args,
      onFrame: frame => this.handleFrame(frame),
      onStderr: text => this.options.logger.warn(`pi stderr: ${text.slice(0, 300)}`),
      onExit: ({ exitCode, signal }) => {
        this.process = undefined
        if (this.run !== undefined) {
          const run = this.run
          this.run = undefined
          run.resolve(this.abortRequested
            ? { kind: 'aborted' }
            : {
              kind: 'error',
              error: {
                message: `pi process exited mid-turn (code ${String(exitCode)}, signal ${String(signal)}): ${proc.stderrHint || 'no stderr'}`,
                code: 'PI_PROCESS_EXITED',
              },
            })
        }
      },
    })
    this.process = proc
    return proc
  }

  private handleFrame(frame: RpcFrame): void {
    // Extension UI requests (pi extensions asking for user input) are out of
    // v1 scope: cancel interactive ones (select/confirm/input/editor) so pi
    // extensions never hang on a missing answer; non-interactive pushes
    // (setStatus/setWidget/notify/setTitle) need no reply and are ignored.
    if (frame.type === 'extension_ui_request') {
      const method = typeof frame.method === 'string' ? frame.method : undefined
      const id = typeof frame.id === 'string' ? frame.id : undefined
      if (id !== undefined && method !== undefined && ['select', 'confirm', 'input', 'editor'].includes(method)) {
        void this.process?.write({ type: 'extension_ui_response', id, cancelled: true })
        this.options.logger.warn(`pi extension_ui_request cancelled (v1): ${method}`)
      }
      return
    }
    if (frame.type === 'message_end' || frame.type === 'turn_end') {
      const message = frame.message as Record<string, unknown> | undefined
      if (message !== undefined) {
        if (typeof message.stopReason === 'string') this.lastStopReason = message.stopReason
        if (typeof message.errorMessage === 'string' && message.errorMessage !== '') {
          this.lastErrorMessage = message.errorMessage
        }
      }
    }
    if (frame.type === 'agent_end') {
      this.options.onFrame(frame)
      const run = this.run
      if (run !== undefined && frame.willRetry !== true) {
        this.run = undefined
        run.resolve(this.foldOutcome())
      }
      return
    }
    this.options.onFrame(frame)
  }

  private foldOutcome(): DriverTurnOutcome {
    const reason = this.abortRequested ? 'aborted' : this.lastStopReason
    switch (reason) {
      case 'aborted':
        return { kind: 'aborted' }
      case 'length':
        return { kind: 'max-tokens' }
      case 'error':
        return {
          kind: 'error',
          error: { message: this.lastErrorMessage ?? 'pi model request failed', code: 'PI_MODEL_ERROR' },
        }
      default:
        return { kind: 'completed' }
    }
  }

  private readRoute(state: Record<string, unknown>): PiRoute {
    const model = state.model as Record<string, unknown> | undefined
    const provider = typeof model?.provider === 'string' ? model.provider : undefined
    const modelId = typeof model?.id === 'string' ? model.id : undefined
    const thinkingLevel = typeof state.thinkingLevel === 'string' ? state.thinkingLevel : undefined
    return {
      ...(provider === undefined ? {} : { provider }),
      ...(modelId === undefined ? {} : { model: modelId }),
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    }
  }
}
