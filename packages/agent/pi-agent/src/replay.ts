/**
 * Reverse translator: one pi session JSONL file → one dsh event stream.
 *
 * Walks the file's active leaf chain (pi entries form a parentId tree; the
 * last line is the current leaf) and synthesizes the dsh vocabulary the
 * native UI consumes: synthetic turn/step boundaries, surface messages,
 * request anchors, model selections, and titles. Entry timestamps carry over
 * so the trajectory timeline keeps pi's pacing.
 *
 * Mapping (v1):
 *   message(user)       → turn/start + user/message
 *   message(assistant)  → step/start + request/header·context + assistant/message
 *                         (+ tool/call per toolCall block)
 *   message(toolResult) → tool/result (paired to its call seq)
 *   model_change        → model/selection
 *   session_info(name)  → session/title
 *   everything else     → skipped (compaction summaries, labels, custom entries)
 *
 * @module @deepseek-ai/dsh-pi-agent/replay
 */

import { randomUUID } from 'node:crypto'
import type {
  ContentBlock,
  ToolCallId,
  UserMessage,
} from '@deepseek-ai/dsh-llm'
import {
  createAssistantMessage,
  createToolResultMessage,
  MessageId,
} from '@deepseek-ai/dsh-llm'
import type {
  SessionEvent,
  SessionEventMap,
  SessionHeader,
  SessionId,
} from '@deepseek-ai/dsh-session'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { canonicalHeader } from '@deepseek-ai/dsh-session'
import { translateAssistantBlocks, translateUsage } from './pi-agent.ts'

/** One parsed pi JSONL entry (loose — the file is another product's format). */
interface PiEntry {
  type: string
  id?: string
  parentId?: string | null
  timestamp?: string
  cwd?: string
  message?: Record<string, unknown>
  provider?: string
  modelId?: string
  name?: string
}

/** Result of replaying one pi file. */
export interface ReplayResult {
  /** Synthesized storage header (from the file's `session` line). */
  header: SessionHeader
  /** Fully-formed dsh events, seq 0..n-1, fold-valid order. */
  events: SessionEvent[]
}

/** Parse one pi JSONL file into its header line plus entries. */
function parsePiFile(raw: string): { headerLine: PiEntry | undefined; entries: PiEntry[] } {
  let headerLine: PiEntry | undefined
  const entries: PiEntry[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let entry: PiEntry
    try {
      entry = JSON.parse(trimmed) as PiEntry
    } catch {
      continue
    }
    if (entry === null || typeof entry !== 'object' || typeof entry.type !== 'string') continue
    if (entry.type === 'session') headerLine ??= entry
    else entries.push(entry)
  }
  return { headerLine, entries }
}

/** Walk the leaf → root parent chain of the last entry, then reverse it. */
function activeChain(entries: PiEntry[]): PiEntry[] {
  if (entries.length === 0) return []
  const byId = new Map<string, PiEntry>()
  for (const entry of entries) {
    if (typeof entry.id === 'string') byId.set(entry.id, entry)
  }
  const chain: PiEntry[] = []
  const visited = new Set<string>()
  let cursor: PiEntry | undefined = entries[entries.length - 1]!
  while (cursor !== undefined && !visited.has(cursor.id ?? '')) {
    if (cursor.id !== undefined) visited.add(cursor.id)
    chain.push(cursor)
    const parentId: string | null | undefined = cursor.parentId
    cursor = typeof parentId === 'string' ? byId.get(parentId) : undefined
  }
  chain.reverse()
  return chain
}

/** Extract a pi user message's text (string content or text blocks). */
function piUserText(message: Record<string, unknown>): string {
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => (block !== null && typeof block === 'object' && (block as { type?: string }).type === 'text'
      ? String((block as { text?: string }).text ?? '')
      : ''))
    .filter(part => part !== '')
    .join('\n')
}

/** Translate a pi toolResult content array into text blocks (images dropped in v1). */
function piToolResultBlocks(content: unknown): ContentBlock[] {
  if (!Array.isArray(content)) return []
  const text = content
    .map(block => (block !== null && typeof block === 'object' && (block as { type?: string }).type === 'text'
      ? String((block as { text?: string }).text ?? '')
      : ''))
    .filter(part => part !== '')
    .join('\n')
  return text === '' ? [] : [{ type: 'text', text }]
}

/** Timestamp helper: pi stores ISO strings; synthesized events reuse the last seen time. */
class EventWriter {
  private seq = 0
  private time = Date.now()

  /**
   * One log-only event (no surface intent). The loose `type` admits events
   * merged into SessionEventMap by other packages (model/selection,
   * session/title); the runtime envelope is identical.
   */
  log(type: string, data: unknown): void {
    this.emit(type, data)
  }

  /** One surface event appended to the visible conversation. */
  surface<K extends 'user/message' | 'assistant/message' | 'tool/result' | 'system/message' | 'developer/message'>(
    type: K,
    data: SessionEventMap[K],
    callSeq?: number,
  ): void {
    this.emit(type, data, { surfaceOp: 'append', ...(callSeq === undefined ? {} : { sourceEventSeqs: [callSeq] }) })
  }

  /** Observe an entry timestamp so synthesized events inherit pi's clock. */
  observe(entry: PiEntry): void {
    const parsed = Date.parse(entry.timestamp ?? '')
    if (!Number.isNaN(parsed)) this.time = parsed
  }

  private emit(
    type: string,
    data: unknown,
    surface?: { surfaceOp: 'append'; sourceEventSeqs?: number[] },
  ): void {
    const event = {
      type,
      seq: this.seq,
      time: this.time,
      data,
      ...(surface === undefined ? {} : surface),
    } as unknown as SessionEvent
    this.seq += 1
    this.events.push(event)
  }

  readonly events: SessionEvent[] = []
}

/**
 * Replay one pi session file's active chain into dsh events.
 * Returns `undefined` for a file without a readable session header.
 */
export function replayPiSession(raw: string, fileName: string): ReplayResult | undefined {
  const { headerLine, entries } = parsePiFile(raw)
  if (headerLine === undefined) return undefined
  const createdAt = Date.parse(headerLine.timestamp ?? '')
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: fileName.replace(/\.jsonl$/, '') as SessionId,
    createdAt: Number.isNaN(createdAt) ? Date.now() : createdAt,
    ...(typeof headerLine.cwd === 'string' && headerLine.cwd !== '' ? { cwd: headerLine.cwd } : {}),
    isSeeded: false,
  }

  const writer = new EventWriter()
  let turn = 0
  let step = 0
  let turnOpen = false
  let stepOpen = false
  let headerWritten = false
  let lastRoute: { provider: string; model: string } | undefined
  const callSeqs = new Map<string, number>()

  const closeStep = (): void => {
    if (!stepOpen) return
    writer.log('step/end', { turn, step })
    stepOpen = false
  }
  const closeTurn = (): void => {
    closeStep()
    if (!turnOpen) return
    writer.log('turn/end', { turn, reason: { kind: 'completed' } })
    turnOpen = false
  }
  const openTurn = (): void => {
    if (turnOpen) return
    turn += 1
    step = 0
    writer.log('turn/start', { turn })
    turnOpen = true
  }

  for (const entry of activeChain(entries)) {
    writer.observe(entry)
    switch (entry.type) {
      case 'message': {
        const message = entry.message
        if (message === undefined) break
        const role = message.role
        if (role === 'user') {
          closeTurn()
          openTurn()
          const text = piUserText(message)
          if (text === '') break
          const userMessage: UserMessage = {
            id: MessageId(randomUUID()),
            role: 'user',
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
          }
          writer.surface('user/message', userMessage)
          break
        }
        if (role === 'assistant') {
          openTurn()
          const provider = typeof message.provider === 'string' ? message.provider : lastRoute?.provider ?? 'pi'
          const model = typeof message.model === 'string' ? message.model : lastRoute?.model ?? 'default'
          const route = { provider, model }
          const config = { provider, model }
          if (!headerWritten || lastRoute?.provider !== provider || lastRoute?.model !== model) {
            writer.log('request/header', {
              header: canonicalHeader({ config }),
              reason: headerWritten ? 'change' : 'initial',
            })
            writer.log('request/context', { provider, model })
            headerWritten = true
          }
          lastRoute = route
          closeStep()
          step += 1
          writer.log('step/start', { turn, step })
          stepOpen = true
          const usage = translateUsage(message.usage)
          const assistantMessage = createAssistantMessage({
            content: translateAssistantBlocks(message.content),
            source: { provider, model },
          })
          writer.surface('assistant/message', {
            turn,
            step,
            message: assistantMessage,
            ...(usage === undefined ? {} : { usage }),
            stream: [],
          })
          // Tool calls asked by this message; their results arrive as later entries.
          for (const block of Array.isArray(message.content) ? message.content : []) {
            if (block === null || typeof block !== 'object' || (block as { type?: string }).type !== 'toolCall') continue
            const call = block as { id?: string; name?: string; arguments?: unknown }
            const callId = String(call.id ?? '')
            if (callId === '') continue
            writer.log('tool/call', {
              turn,
              step,
              callId: callId as ToolCallId,
              name: String(call.name ?? 'unknown'),
              arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
            })
            callSeqs.set(callId, writer.events[writer.events.length - 1]!.seq)
          }
          break
        }
        if (role === 'toolResult') {
          if (!turnOpen) break
          const callId = String(message.toolCallId ?? '')
          const callSeq = callSeqs.get(callId)
          callSeqs.delete(callId)
          const isError = message.isError === true
          const resultMessage = createToolResultMessage({
            callId: callId as ToolCallId,
            content: piToolResultBlocks(message.content),
            isError,
          })
          writer.surface('tool/result', {
            turn,
            step: Math.max(step, 1),
            message: resultMessage,
            ...(isError ? { error: { name: String(message.toolName ?? 'tool'), code: 'PI_TOOL_ERROR' } } : {}),
          }, callSeq)
          break
        }
        break
      }
      case 'model_change': {
        if (typeof entry.provider !== 'string' || typeof entry.modelId !== 'string') break
        lastRoute = { provider: entry.provider, model: entry.modelId }
        writer.log('model/selection', { provider: entry.provider, model: entry.modelId })
        break
      }
      case 'session_info': {
        if (typeof entry.name !== 'string' || entry.name === '') break
        writer.log('session/title', { title: entry.name, messageSeqs: [], source: { kind: 'user' } })
        break
      }
      default:
        break
    }
  }
  closeTurn()

  return { header, events: writer.events }
}
