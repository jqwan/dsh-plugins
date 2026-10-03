/**
 * The pi-backed Agent: dsh's Agent runtime contract driven by a pi RPC
 * process. Owns the phase machine and durable inbox (ported from agent-loop's
 * ReactLoopAgent) and translates pi's event stream into dsh session events:
 * pi run = dsh turn; pi model cycle (`turn_start…turn_end`) = dsh step; pi
 * tool executions map onto `tool/call` + `tool/result` pairs.
 *
 * Ordering contract (matches agent-loop): `turn/start` → `step/start` →
 * `user/message` → `request/header` → `assistant/message` → `tool/call` →
 * `tool/result` → `step/end` → `turn/end`. Step 1 opens synchronously when
 * the run starts, so a pi spawn failure still leaves a closed step and the
 * claimed user messages in the durable log.
 *
 * @module @deepseek-ai/dsh-pi-agent/pi-agent
 */

import type {
  Agent,
  AgentCancelCause,
  AgentEventDispatch,
  AssistantStreamFrame,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  InboxTarget,
} from '@deepseek-ai/dsh-agent'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, LlmCallConfig, TokenUsage, ToolCallId, UserMessage } from '@deepseek-ai/dsh-llm'
import { LlmAttemptId } from '@deepseek-ai/dsh-llm'
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  errorChain,
} from '@deepseek-ai/dsh-llm'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Session, SessionId, SessionSeq, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { canonicalHeader, headerEquals } from '@deepseek-ai/dsh-session'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandRuntime, CommandResult } from '@deepseek-ai/dsh-commands'
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-commands'
import { PiInbox } from './inbox.ts'
import { PiDriver, type DriverTurnOutcome } from './driver.ts'
import { exportPiSession } from './exporter.ts'

type Phase =
  | { kind: 'idle'; lastTurn: number }
  | { kind: 'maintenance'; abort: AbortController; lastTurn: number; wakeRequested: boolean }
  | { kind: 'running'; abort: AbortController; turn: number; wakeRequested: boolean }

/** Copy the cancel cause `cancel()` planted on a loop-owned signal, minus volatile fields. */
function abortedCancelCause(signal: AbortSignal): AgentCancelCause | undefined {
  if (!signal.aborted) return undefined
  const cause = signal.reason as AgentCancelCause
  switch (cause.kind) {
    case 'user':
    case 'parent':
    case 'disposed':
      return { kind: cause.kind }
    case 'hook':
      return { kind: 'hook', reason: cause.reason }
    default:
      return { kind: 'user' }
  }
}

/** Join a pi user message's text content (blocks or bare string). */
function userMessageText(message: UserMessage): string {
  const content = message.content as unknown
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => (block !== null && typeof block === 'object' && (block as { type?: string }).type === 'text'
      ? String((block as { text?: string }).text ?? '')
      : ''))
    .filter(part => part !== '')
    .join('\n')
}

/** Translate pi assistant content blocks into dsh content blocks (lossless subset). */
export function translateAssistantBlocks(piBlocks: unknown): ContentBlock[] {
  if (!Array.isArray(piBlocks)) return []
  const blocks: ContentBlock[] = []
  for (const raw of piBlocks) {
    const block = raw as Record<string, unknown>
    switch (block?.type) {
      case 'text':
        blocks.push({ type: 'text', text: String(block.text ?? '') })
        break
      case 'thinking':
        blocks.push({ type: 'reasoning', text: String(block.thinking ?? '') })
        break
      case 'toolCall':
        blocks.push({
          type: 'tool-call',
          id: String(block.id ?? '') as ToolCallId,
          name: String(block.name ?? ''),
          arguments: typeof block.arguments === 'string'
            ? block.arguments
            : JSON.stringify(block.arguments ?? {}),
        })
        break
      default:
        break
    }
  }
  return blocks
}

/** Map pi usage counters onto dsh TokenUsage (disjoint input semantics match). */
export function translateUsage(piUsage: unknown): TokenUsage | undefined {
  if (piUsage === undefined || piUsage === null || typeof piUsage !== 'object') return undefined
  const usage = piUsage as Record<string, unknown>
  const input = typeof usage.input === 'number' ? usage.input : undefined
  const output = typeof usage.output === 'number' ? usage.output : undefined
  if (input === undefined || output === undefined) return undefined
  return {
    inputTokens: input,
    outputTokens: output,
    ...(typeof usage.cacheRead === 'number' ? { cacheReadTokens: usage.cacheRead } : {}),
    ...(typeof usage.cacheWrite === 'number' ? { cacheWriteTokens: usage.cacheWrite } : {}),
    ...(typeof usage.totalTokens === 'number' ? { totalTokens: usage.totalTokens } : {}),
    ...(typeof usage.reasoning === 'number' ? { reasoningTokens: usage.reasoning } : {}),
  }
}

/** Reduce a pi tool result payload into text blocks (tolerant shape). */
function toolResultBlocks(result: unknown): ContentBlock[] {
  if (typeof result === 'string') return [{ type: 'text', text: result }]
  if (result !== undefined && result !== null && typeof result === 'object') {
    const record = result as Record<string, unknown>
    if (typeof record.text === 'string' && record.text !== '') {
      return [{ type: 'text', text: record.text }]
    }
    if (record.content !== undefined) {
      const text = translateAssistantBlocks(record.content)
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('\n')
      if (text !== '') return [{ type: 'text', text }]
    }
    return [{ type: 'text', text: JSON.stringify(result) }]
  }
  return [{ type: 'text', text: '' }]
}

/** Fold a driver run outcome into dsh's turn-end taxonomy. */
function foldTurnEnd(outcome: DriverTurnOutcome): TurnEndReason {
  switch (outcome.kind) {
    case 'completed':
      return { kind: 'completed' }
    case 'aborted':
      return { kind: 'aborted', reason: { kind: 'user' } }
    case 'max-tokens':
      return { kind: 'max-tokens' }
    case 'error':
      return { kind: 'error', error: outcome.error ?? { message: 'pi run failed', code: 'PI_RUN_FAILED' } }
  }
}

export interface PiAgentOptions extends AgentOptions {
  /** pi session root override (driver option). */
  sessionsDir?: string
  /** pi cli entry override (driver option). */
  piCliEntry?: string
  /** pi thinking level (driver option). */
  thinkingLevel?: string
}

/** One pi-driven agent over one dsh session. */
export class PiAgent implements Agent {
  readonly inbox: PiInbox
  private phase: Phase
  private activityDone: Promise<void> = Promise.resolve()

  /** The agent-scoped registration boundary; the lifecycle owner unwinds it. */
  readonly scope: Scope
  readonly ctx: Context

  private readonly dispatch: AgentEventDispatch
  private readonly driver: PiDriver

  /** Whether this instance has appended its initial/resume request anchor. */
  private requestHeaderLogged = false
  /** Run-scoped translation state: current step within the open turn. */
  private runStep = 0
  /** Step whose `step/end` has been appended. */
  private settledStep = 0
  /** Pi model cycles observed within the open run (step 1 opens eagerly). */
  private cyclesSeen = 0
  /** Call seqs of tool/call events within the open run, by pi callId. */
  private readonly callSeqs = new Map<string, SessionSeq>()
  /** Stops the model/selection watcher at disposal. */
  private stopSelectionWatch: (() => void) | undefined
  /** Whether pi's slash commands have been mirrored into the agent scope. */
  private commandsLoaded = false
  /** Live streaming attempt handed to the native chat UI. */
  private stream: { attemptId: AssistantStreamFrame["attemptId"]; revision: number; index: number; openBlocks: Set<number>; ended: boolean } | undefined
  private streamRevision = 0
  private attemptCounter = 0

  constructor(
    private readonly loopCtx: Context,
    public readonly id: SessionId,
    public readonly options: PiAgentOptions,
    public readonly session: Session,
    private readonly commands: CommandRuntime,
    private readonly approval: ApprovalService,
    private readonly toolSchemas: () => ToolSchema[],
  ) {
    this.dispatch = agentEvents(loopCtx, this)
    this.scope = createScope(loopCtx, this)
    this.ctx = this.scope.ctx
    this.inbox = new PiInbox(this.ctx.sessionProjections, session, this.dispatch)
    const lastTurn = this.loopCtx.sessionProjections.stateOf(session, 'turnBoundary')?.lastTurn ?? 0
    this.phase = { kind: 'idle', lastTurn }
    this.driver = new PiDriver({
      ...(options.piCliEntry === undefined ? {} : { piCliEntry: options.piCliEntry }),
      sessionsDir: options.sessionsDir ?? '.',
      cwd: session.header.cwd ?? process.cwd(),
      sessionId: id,
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
      onFrame: frame => this.translateFrame(frame),
      onInteractiveExtUi: async request => {
        // pi extension confirm → native approval card. Only valid inside an
        // open turn (the audit pair needs one); idle asks auto-cancel.
        if (request.method !== 'confirm') return undefined
        if (this.phase.kind !== 'running') return undefined
        const outcome = await this.approval.request({
          agent: this,
          toolName: 'pi-extension',
          reason: request.title ?? 'pi extension asks for confirmation',
          signal: this.phase.abort.signal,
        })
        if (outcome === 'allowed-once') return { confirmed: true }
        if (outcome === 'rejected') return { confirmed: false }
        return undefined
      },
      logger: {
        info: message => loopCtx.logger.info(`pi[${id}] ${message}`),
        warn: message => loopCtx.logger.warn(`pi[${id}] ${message}`),
      },
    })
    // The native picker's selection lands as a durable model/selection event;
    // mirror it into pi (set_model + set_thinking_level).
    this.stopSelectionWatch = loopCtx.on('session/event', (watched, event) => {
      // 'model/selection' merges into SessionEventMap via the api layer; the
      // plugin only needs the payload shape.
      if (watched !== this.session || (event.type as string) !== 'model/selection') return
      const selection = (event as unknown as { data: { provider?: string; model?: string; reasoningEffort?: string } }).data
      if (typeof selection.provider !== 'string' || typeof selection.model !== 'string') return
      void this.driver.setModel({ provider: selection.provider, model: selection.model, ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }) })
    })
  }

  get status(): AgentStatus {
    return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running'
  }

  /** Stop the pi child process after the phase machine has quiesced. */
  async disposeDriver(): Promise<void> {
    this.stopSelectionWatch?.()
    this.stopSelectionWatch = undefined
    await this.driver.stop()
    // The cache is disposable by definition: the dsh log holds everything.
    await rm(join(this.options.sessionsDir ?? '.', `${this.id}.jsonl`), { force: true }).catch(() => {})
  }

  private setPhase(next: Phase): void {
    const previousStatus = this.status
    this.phase = next
    const status = this.status
    if (status !== previousStatus) {
      this.dispatch.emit('agent/status', { status })
    }
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
    this.inbox.splice(resolvedTarget, Infinity, 0, [message])
    if (wakeup) this.wakeDriver(wakingAfterAbort)
  }

  followup(input: UserMessage): void {
    this.send(input, 'next-turn', true)
  }

  steer(input: UserMessage): void {
    this.send(input, 'next-step', true)
  }

  inject(input: UserMessage): void {
    this.send(input, 'next-step', false)
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) {
      this.inbox.clear()
      if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
    }
    if (this.phase.kind !== 'idle') {
      this.phase.abort.abort(cause)
      this.driver.abort()
    }
  }

  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    const done = Promise.withResolvers<void>()
    const maintenance: Phase = {
      kind: 'maintenance',
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false,
    }
    this.setPhase(maintenance)
    this.activityDone = done.promise
    return (async () => {
      try {
        return await job(maintenance.abort.signal)
      } finally {
        this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn })
        const cause = abortedCancelCause(maintenance.abort.signal)
        if (cause?.kind !== 'disposed' && maintenance.wakeRequested && this.inbox.hasPending) this.wakeDriver()
        done.resolve()
      }
    })()
  }

  /**
   * Rebuild the pi cache file from the dsh log (the single source of truth).
   * Runs unconditionally before every pi spawn, so the cache is a pure
   * function of the log — no staleness detection. The driver then points
   * pi's --session at it; live turns append pi's own record until disposal.
   */
  private async refreshCache(): Promise<void> {
    const events = this.session.snapshotEvents()
    const content = exportPiSession(events, this.id, this.session.header.cwd)
    const cachePath = join(this.options.sessionsDir ?? '.', `${this.id}.jsonl`)
    await mkdir(join(cachePath, '..'), { recursive: true })
    await writeFile(cachePath, content, 'utf8')
  }

  private wakeDriver(wakeAfterAbort = false): void {
    if (this.phase.kind !== 'idle') {
      const reason = abortedCancelCause(this.phase.abort.signal)
      if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
        this.phase.wakeRequested = true
      }
      return
    }
    const driver = Promise.withResolvers<void>()
    this.activityDone = driver.promise
    this.setPhase({
      kind: 'running',
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      wakeRequested: false,
    })
    this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject)
  }

  async whenIdle(): Promise<void> {
    let activity: Promise<void>
    do {
      await (activity = this.activityDone)
    } while (activity !== this.activityDone)
  }

  private async kick(): Promise<void> {
    try {
      while (await this.turn()) {}
    } catch {
      // Reported failures and cancellation are contained at the driver boundary.
    } finally {
      if (this.phase.kind === 'running') {
        const { turn, wakeRequested } = this.phase
        this.setPhase({ kind: 'idle', lastTurn: turn })
        if (wakeRequested && this.inbox.hasPending) this.wakeDriver()
      }
    }
  }

  /**
   * One pi run: open the turn, open step 1, log the claimed input, submit one
   * prompt, and translate frames until the driver settles the outcome.
   */
  private async turn(): Promise<boolean> {
    if (this.phase.kind !== 'running') {
      throw new Error(`agent "${this.id}": turn without driver reservation`)
    }
    const phase = this.phase
    const { signal } = phase.abort
    signal.throwIfAborted()
    const turn = phase.turn + 1
    this.session.append('turn/start', { turn })
    phase.turn = turn
    let reason: TurnEndReason = { kind: 'completed' }
    try {
      const claimed = this.inbox.claim('next-turn', turn)
      if (claimed.length === 0) {
        reason = { kind: 'completed' }
      } else {
        this.runStep = 1
        this.settledStep = 0
        this.cyclesSeen = 0
        this.callSeqs.clear()
        this.session.append('step/start', { turn, step: 1 })
        for (const message of claimed) {
          this.session.append('user/message', message, { surfaceOp: 'append' })
        }
        const text = claimed.map(userMessageText).filter(part => part !== '').join('\n\n')
        await this.refreshCache()
        await this.driver.start()
        this.appendRequestAnchor()
        void this.loadPiCommands().catch((error: unknown) => {
          this.loopCtx.logger.warn(`pi[${this.id}] command registry unavailable: ${errorChain(error)}`)
        })
        const outcome = await this.driver.prompt(text)
        reason = outcome.kind === 'aborted'
          ? { kind: 'aborted', reason: abortedCancelCause(signal) ?? { kind: 'user' } }
          : foldTurnEnd(outcome)
      }
    } catch (error: unknown) {
      const cause = abortedCancelCause(signal)
      reason = cause !== undefined
        ? { kind: 'aborted', reason: cause }
        : { kind: 'error', error: { message: errorChain(error), code: 'UNKNOWN' } }
    } finally {
      // Close a pi cycle the driver never settled (crash between frames).
      if (this.runStep > this.settledStep) {
        this.session.append('step/end', { turn, step: this.runStep })
        this.settledStep = this.runStep
      }
      this.session.append('turn/end', { turn, reason })
    }
    if (reason.kind === 'error') {
      this.dispatch.emit('agent/error', { turn, step: this.runStep, error: reason.error })
      return false
    }
    if (reason.kind === 'aborted') {
      throw signal.reason instanceof Error ? signal.reason : new Error('pi turn aborted')
    }
    if (!this.inbox.hasPending) return false
    phase.abort = new AbortController()
    phase.wakeRequested = false
    return true
  }

  /**
   * pi frame → dsh session events. Runs synchronously in the transport's line
   * reader, so append order always matches pi's event order.
   */
  private translateFrame(frame: { type: string; [key: string]: unknown }): void {
    const turn = this.phase.kind === 'running' ? this.phase.turn : undefined
    if (turn === undefined) return
    switch (frame.type) {
      case 'turn_start': {
        if (this.runStep === 0) return
        this.cyclesSeen += 1
        if (this.cyclesSeen > 1) {
          // A new pi cycle opens after the previous turn_end settled its step.
          if (this.runStep > this.settledStep) {
            this.session.append('step/end', { turn, step: this.runStep })
            this.settledStep = this.runStep
          }
          const step = this.runStep + 1
          this.session.append('step/start', { turn, step })
          this.runStep = step
        }
        const steers = this.inbox.claim('next-step', turn)
        if (steers.length > 0) {
          const text = steers.map(userMessageText).filter(part => part !== '').join('\n\n')
          if (text !== '') void this.driver.steer(text)
        }
        return
      }
      case 'turn_end': {
        if (this.runStep > this.settledStep) {
          this.session.append('step/end', { turn, step: this.runStep })
          this.settledStep = this.runStep
        }
        return
      }
      case 'message_start': {
        const message = frame.message as Record<string, unknown> | undefined
        if (message === undefined || message.role !== 'assistant') return
        // Open a streaming attempt for the native chat UI.
        this.streamRevision += 1
        this.stream = {
          attemptId: LlmAttemptId(`${this.id}-a${this.attemptCounter += 1}`),
          revision: this.streamRevision,
          index: 0,
          openBlocks: new Set<number>(),
          ended: false,
        }
        this.dispatch.emit('agent/assistant-stream', {
          frame: {
            type: 'start',
            attemptId: this.stream.attemptId,
            revision: this.stream.revision,
            turn,
            step: this.runStep,
          },
        })
        return
      }
      case 'message_update': {
        const update = (frame as { assistantMessageEvent?: { type?: string; contentIndex?: number; delta?: string } }).assistantMessageEvent
        if (update === undefined || this.stream === undefined || this.stream.ended) return
        const index = typeof update.contentIndex === 'number' ? update.contentIndex : 0
        if ((update.type === 'text_delta' || update.type === 'thinking_delta') && typeof update.delta === 'string' && update.delta !== '') {
          if (!this.stream.openBlocks.has(index)) {
            this.stream.openBlocks.add(index)
            this.dispatch.emit('agent/assistant-stream', {
              frame: {
                type: 'chunk',
                attemptId: this.stream.attemptId,
                revision: this.stream.revision,
                index: this.stream.index,
                time: Date.now(),
                chunk: { type: 'block-start', index, blockType: update.type === 'text_delta' ? 'text' : 'reasoning' },
              },
            })
            this.stream.index += 1
          }
          this.dispatch.emit('agent/assistant-stream', {
            frame: {
              type: 'chunk',
              attemptId: this.stream.attemptId,
              revision: this.stream.revision,
              index: this.stream.index,
              time: Date.now(),
              chunk: update.type === 'text_delta'
                ? { type: 'text-delta', index, text: update.delta }
                : { type: 'reasoning-delta', index, text: update.delta },
            },
          })
          this.stream.index += 1
        }
        return
      }
      case 'message_end': {
        const message = frame.message as Record<string, unknown> | undefined
        if (message === undefined || message.role !== 'assistant') return
        const usage = translateUsage(message.usage)
        const piMessage = createAssistantMessage({
          content: translateAssistantBlocks(message.content),
          source: {
            provider: typeof message.provider === 'string' ? message.provider : 'pi',
            model: typeof message.model === 'string' ? message.model : 'default',
          },
        })
        const committed = this.session.append('assistant/message', {
          turn,
          step: this.runStep,
          message: piMessage,
          ...(usage === undefined ? {} : { usage }),
          stream: [],
          ...(message.stopReason === 'aborted' ? { interrupted: true } : {}),
        }, { surfaceOp: 'append' })
        // Settle the streaming attempt against the durable event.
        const stream = this.stream
        if (stream !== undefined && !stream.ended) {
          stream.ended = true
          this.dispatch.emit('agent/assistant-stream', {
            frame: {
              type: 'end',
              attemptId: stream.attemptId,
              revision: stream.revision,
              index: stream.index,
              outcome: { kind: 'committed', eventType: 'assistant/message', seq: committed.seq },
            },
          })
        }
        this.stream = undefined
        return
      }
      case 'tool_execution_start': {
        const callId = String(frame.toolCallId ?? '') as ToolCallId
        const event = this.session.append('tool/call', {
          turn,
          step: this.runStep,
          callId,
          name: String(frame.toolName ?? 'unknown'),
          arguments: JSON.stringify(frame.args ?? {}),
        })
        this.callSeqs.set(callId, event.seq)
        return
      }
      case 'tool_execution_end': {
        const callId = String(frame.toolCallId ?? '') as ToolCallId
        const isError = frame.isError === true
        const message = createToolResultMessage({
          callId,
          content: toolResultBlocks(frame.result),
          isError,
        })
        const callSeq = this.callSeqs.get(callId)
        this.callSeqs.delete(callId)
        this.session.append('tool/result', {
          turn,
          step: this.runStep,
          message,
          ...(isError ? { error: { name: String(frame.toolName ?? 'tool'), code: 'PI_TOOL_ERROR' } } : {}),
        }, { surfaceOp: 'append', ...(callSeq === undefined ? {} : { sourceEventSeqs: [callSeq] }) })
        return
      }
      default:
        return
    }
  }

  /**
   * Mirror pi's slash commands as agent-scoped dsh commands. Scoped same-name
   * registration shadows the global dsh command for this session. A command
   * entered while idle opens its own turn (pi consumes slash lines before the
   * model); while running it goes in as steering input.
   */
  private async loadPiCommands(): Promise<void> {
    if (this.commandsLoaded) return
    this.commandsLoaded = true
    const commands = await this.driver.getCommands()
    for (const command of commands) {
      if (!/^[a-z][a-z0-9_-]*$/.test(command.name)) continue
      try {
        this.commands.register({
          name: command.name,
          description: command.description ?? `(pi ${command.source} command)`,
          handler: (invocation: CommandInvocation): CommandResult => {
            const text = `/${command.name}${invocation.rawInput}`
            if (this.status === 'running') {
              void this.driver.steer(text)
              return { kind: 'success', text: 'sent to pi as steering input' }
            }
            this.followup(createUserMessage({
              content: [{ type: 'text' as const, text }],
              source: { kind: 'user' },
            }))
            return { kind: 'success' }
          },
        })
      } catch (error: unknown) {
        this.loopCtx.logger.warn(`pi[${this.id}] command "${command.name}" registration failed: ${errorChain(error)}`)
      }
    }
    // Shadow dsh's /compact: the stock command drives ctx.compaction over
    // the LLM runtime, which the pi kernel does not use (the catalog adapter's
    // stream() fails by design). Route compaction to pi instead.
    try { (await import('node:fs')).appendFileSync('/tmp/pi-agent-debug.log', 'registering compact shadow\\n') } catch {}
    this.commands.register({
      name: 'compact',
      description: 'Compact the conversation context (pi kernel)',
      handler: async (): Promise<CommandResult> => {
        const started = await this.driver.compact()
        return started
          ? { kind: 'success', text: 'pi compaction requested' }
          : { kind: 'error', text: 'pi is not running yet — send a message first' }
      },
    })
    try { (await import('node:fs')).appendFileSync('/tmp/pi-agent-debug.log', 'compact shadow registered\\n') } catch {}
    if (commands.length > 0) {
      this.loopCtx.logger.info(`pi[${this.id}] registered ${commands.length} pi commands + compact shadow`)
    }
  }

  /** Append the request anchor once per session and on route changes. */
  private appendRequestAnchor(): void {
    const route = this.driver.currentRoute
    const config: LlmCallConfig = {
      provider: route.provider ?? this.options.provider ?? 'pi',
      model: route.model ?? this.options.model ?? 'default',
      ...(this.options.reasoningEffort === undefined ? {} : { reasoningEffort: this.options.reasoningEffort }),
      ...(this.options.maxTokens === undefined ? {} : { maxTokens: this.options.maxTokens }),
    }
    // The anchor records the native registry's schemas so a future native-
    // kernel resume sees a coherent tool history (an empty tools baseline
    // would make the native loop flag every tool as a deferred addition).
    const tools = this.toolSchemas()
    const header = canonicalHeader({ config, ...(tools.length > 0 ? { tools } : {}) })
    const baseline = this.session.requestHeader()
    if (!this.requestHeaderLogged) {
      this.session.append('request/header', {
        header,
        reason: baseline === undefined ? 'initial' : 'resume',
      })
      this.requestHeaderLogged = true
    } else if (baseline === undefined || !headerEquals(baseline, header)) {
      this.session.append('request/header', { header, reason: 'change' })
    }
    const previous = this.session.requestContext()
    if (previous?.provider !== config.provider || previous?.model !== config.model) {
      this.session.append('request/context', { provider: config.provider, model: config.model })
    }
  }
}
