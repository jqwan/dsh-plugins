/**
 * Cache exporter: dsh session events → pi session JSONL.
 *
 * The pi file is a disposable working cache for the pi process (its context
 * lives in its own format). The dsh log is the single source of truth; this
 * exporter regenerates the cache from it at every pi-kernel agent start, so
 * the cache is always a pure function of the log and never needs staleness
 * detection.
 *
 * Mapping (inverse of replay.ts, lossless where pi's format allows):
 *   user/message        → message(user)
 *   assistant/message    → message(assistant) — stopReason inferred from
 *                          tool-call blocks; arguments parsed back to objects
 *   tool/result          → message(toolResult) — toolName recovered from the
 *                          paired tool/call event
 *   request/header       → model_change (+ thinking_level_change) on route change
 *   session/title        → session_info(name)
 *   everything else      → skipped (boundaries, prompts, approvals, …)
 *
 * @module @deepseek-ai/dsh-pi-agent/exporter
 */

import { randomUUID } from 'node:crypto'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** One pi JSONL entry under construction. */
interface PiOutEntry {
  type: string
  id: string
  parentId: string
  timestamp: string
  [key: string]: unknown
}

/** Pull the plain text out of dsh content blocks (non-text blocks dropped). */
function dshText(blocks: unknown): string {
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return ''
  return blocks
    .map(block => (block !== null && typeof block === 'object' && (block as { type?: string }).type === 'text'
      ? String((block as { text?: string }).text ?? '')
      : ''))
    .filter(part => part !== '')
    .join('\n')
}

/** Translate dsh assistant content blocks into pi content blocks. */
function dshAssistantBlocks(blocks: unknown): unknown[] {
  if (!Array.isArray(blocks)) return []
  const out: unknown[] = []
  for (const raw of blocks) {
    const block = raw as Record<string, unknown>
    switch (block?.type) {
      case 'text':
        out.push({ type: 'text', text: String(block.text ?? '') })
        break
      case 'reasoning':
        out.push({ type: 'thinking', thinking: String(block.text ?? '') })
        break
      case 'tool-call': {
        let args: unknown = {}
        try {
          args = typeof block.arguments === 'string' && block.arguments !== '' ? JSON.parse(block.arguments) : {}
        } catch {
          args = { raw: block.arguments }
        }
        out.push({ type: 'toolCall', id: String(block.id ?? ''), name: String(block.name ?? ''), arguments: args })
        break
      }
      default:
        break
    }
  }
  return out
}

/** Translate dsh TokenUsage into pi's usage shape (cost zeroed — log lost pricing). */
function dshUsage(usage: unknown): Record<string, unknown> | undefined {
  if (usage === undefined || usage === null || typeof usage !== 'object') return undefined
  const u = usage as Record<string, unknown>
  const input = typeof u.inputTokens === 'number' ? u.inputTokens : 0
  const output = typeof u.outputTokens === 'number' ? u.outputTokens : 0
  const cacheRead = typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : 0
  const cacheWrite = typeof u.cacheWriteTokens === 'number' ? u.cacheWriteTokens : 0
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: typeof u.totalTokens === 'number' ? u.totalTokens : input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

/**
 * Export one dsh event stream into pi session-file content (header line +
 * entry lines, trailing newline). `sessionId` names the pi session inside
 * the file; `cwd` seeds the header.
 */
export function exportPiSession(
  events: readonly SessionEvent[],
  sessionId: string,
  cwd?: string,
): string {
  const timestamp = (time: number): string => new Date(Number.isFinite(time) ? time : Date.now()).toISOString()

  const header: PiOutEntry = {
    type: 'session',
    parentId: '',
    version: 3,
    id: sessionId,
    timestamp: timestamp(events[0]?.time ?? Date.now()),
    ...(cwd === undefined ? {} : { cwd }),
  }
  const lines: string[] = [JSON.stringify(header)]

  let parentId = header.id
  let lastRoute: { provider: string; model: string } | undefined
  let lastThinking: string | undefined
  const toolNames = new Map<string, string>()

  for (const raw of events) {
    // 'model/selection' / 'session/title' merge into SessionEventMap from
    // other packages; treat the discriminant loosely for the exporter.
    const event = raw as unknown as { type: string; time: number; data: Record<string, unknown> }
    const data = event.data
    switch (event.type) {
      case 'user/message': {
        const text = dshText(data.content)
        if (text === '') break
        const entry: PiOutEntry = {
          type: 'message',
          id: randomUUID().slice(0, 8),
          parentId,
          timestamp: timestamp(event.time),
          message: { role: 'user', content: text, timestamp: event.time },
        }
        lines.push(JSON.stringify(entry))
        parentId = entry.id
        break
      }
      case 'assistant/message': {
        const message = data.message as Record<string, unknown> | undefined
        if (message === undefined) break
        const blocks = dshAssistantBlocks(message.content)
        const usage = dshUsage(data.usage)
        const source = message.source as Record<string, unknown> | undefined
        const entry: PiOutEntry = {
          type: 'message',
          id: randomUUID().slice(0, 8),
          parentId,
          timestamp: timestamp(event.time),
          message: {
            role: 'assistant',
            content: blocks,
            api: '',
            provider: String(source?.provider ?? 'pi'),
            model: String(source?.model ?? 'default'),
            usage: usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: blocks.some(block => (block as { type?: string }).type === 'toolCall')
              ? 'toolUse'
              : (data.interrupted === true ? 'aborted' : 'stop'),
            timestamp: event.time,
          },
        }
        lines.push(JSON.stringify(entry))
        parentId = entry.id
        break
      }
      case 'tool/call': {
        toolNames.set(String(data.callId), String(data.name))
        break
      }
      case 'tool/result': {
        const message = data.message as Record<string, unknown> | undefined
        if (message === undefined) break
        const callId = String(message.toolCallId ?? '')
        const text = dshText(message.content)
        const entry: PiOutEntry = {
          type: 'message',
          id: randomUUID().slice(0, 8),
          parentId,
          timestamp: timestamp(event.time),
          message: {
            role: 'toolResult',
            toolCallId: callId,
            toolName: toolNames.get(callId) ?? '',
            content: text === '' ? [] : [{ type: 'text', text }],
            isError: message.isError === true,
            timestamp: event.time,
          },
        }
        lines.push(JSON.stringify(entry))
        parentId = entry.id
        break
      }
      case 'request/header': {
        const headerData = data.header as { config?: Record<string, unknown> } | undefined
        const config = headerData?.config
        const provider = typeof config?.provider === 'string' ? config.provider : undefined
        const model = typeof config?.model === 'string' ? config.model : undefined
        if (provider === undefined || model === undefined) break
        if (lastRoute?.provider === provider && lastRoute?.model === model) break
        lastRoute = { provider, model }
        const entry: PiOutEntry = {
          type: 'model_change',
          id: randomUUID().slice(0, 8),
          parentId,
          timestamp: timestamp(event.time),
          provider,
          modelId: model,
        }
        lines.push(JSON.stringify(entry))
        parentId = entry.id
        break
      }
      case 'model/selection': {
        // A pending user selection is the effective continuation route when it
        // lands after the last request header.
        const provider = typeof data.provider === 'string' ? data.provider : undefined
        const model = typeof data.model === 'string' ? data.model : undefined
        if (provider === undefined || model === undefined) break
        lastRoute = { provider, model }
        const entry: PiOutEntry = {
          type: 'model_change',
          id: randomUUID().slice(0, 8),
          parentId,
          timestamp: timestamp(event.time),
          provider,
          modelId: model,
        }
        lines.push(JSON.stringify(entry))
        parentId = entry.id
        const effort = typeof data.reasoningEffort === 'string' ? data.reasoningEffort : undefined
        if (effort !== undefined && effort !== lastThinking) {
          lastThinking = effort
          const thinking: PiOutEntry = {
            type: 'thinking_level_change',
            id: randomUUID().slice(0, 8),
            parentId: entry.id,
            timestamp: timestamp(event.time),
            thinkingLevel: effort,
          }
          lines.push(JSON.stringify(thinking))
          parentId = thinking.id
        }
        break
      }
      case 'session/title': {
        const title = typeof data.title === 'string' ? data.title : ''
        if (title === '') break
        const entry: PiOutEntry = {
          type: 'session_info',
          id: randomUUID().slice(0, 8),
          parentId,
          timestamp: timestamp(event.time),
          name: title,
        }
        lines.push(JSON.stringify(entry))
        parentId = entry.id
        break
      }
      default:
        break
    }
  }

  return lines.join('\n') + '\n'
}
