/** Recorded pi extension measurements; old sessions legitimately have none. */
import type { ChatMessage, ToolOutput } from './pi-chat.tsx'
import type { PiTrajectoryEntry } from './pi-trajectory-data.ts'
export interface PiTiming { startedAt: number; durationMs: number; firstTokenMs?: number }
/** Join measurements only to the matching message timestamp or tool call id. */
export function applyPiTelemetry(messages: ChatMessage[], tools: Map<string, ToolOutput>, entries: PiTrajectoryEntry[]): void {
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== 'dsh-workbench.telemetry.v1' || !entry.data || typeof entry.data !== 'object') continue
    const data = entry.data as Record<string, unknown>
    const tool = typeof data.callId === 'string' ? tools.get(data.callId) : undefined
    if (data.kind === 'tool-schema') {
      if (tool && data.schema && typeof data.schema === 'object') tool.schema = data.schema
      continue
    }
    if (typeof data.startedAt !== 'number' || !Number.isFinite(data.startedAt) || typeof data.durationMs !== 'number' || !Number.isFinite(data.durationMs) || data.durationMs < 0) continue
    const timing: PiTiming = { startedAt: data.startedAt, durationMs: data.durationMs }
    if (typeof data.firstTokenMs === 'number' && data.firstTokenMs >= 0 && data.firstTokenMs <= data.durationMs) timing.firstTokenMs = data.firstTokenMs
    if (data.kind === 'tool') { if (tool) tool.timing = timing; continue }
    if (typeof data.timestamp !== 'number' || !Number.isFinite(data.timestamp)) continue
    const message = messages.find(item => item.role === 'assistant' && item.time === data.timestamp)
    if (message && data.kind === 'assistant') message.timing = timing
    if (message && data.kind === 'run') message.runTiming = timing
  }
}
/** Aggregate all assistant calls in a user turn, including intermediate tool requests. */
export function piTurnUsage(messages: readonly ChatMessage[]) {
  const buckets = messages.filter(message => message.role === 'assistant').flatMap(message => message.usage ? [message.usage] : [])
  if (!buckets.length) return undefined
  const sum = (key: 'input' | 'output' | 'cacheRead' | 'cacheWrite') => buckets.reduce((total, usage) => total + (usage[key] ?? 0), 0)
  const owners = messages.filter(message => message.role === 'assistant' && message.usage)
  const routes = owners.every(message => message.provider && message.model) ? [...new Map(owners.map(message => [`${message.provider}/${message.model}`, { provider: message.provider!, model: message.model! }])).values()] : undefined
  return { ...(routes ? { routes } : {}), uncachedInputTokens: sum('input'), outputTokens: sum('output'), totalTokens: sum('input') + sum('output') + sum('cacheRead') + sum('cacheWrite'),
    ...(buckets.every(usage => usage.cacheRead !== undefined) ? { cacheReadTokens: sum('cacheRead') } : {}),
    ...(buckets.every(usage => usage.cacheWrite !== undefined) ? { cacheWriteTokens: sum('cacheWrite') } : {}) }
}

/** Throughput uses only measured decode intervals; missing samples suppress the rate. */
export function piTurnTiming(messages: readonly ChatMessage[]) {
  const assistants = messages.filter(message => message.role === 'assistant')
  const run = assistants.at(-1)?.runTiming
  if (!run) return undefined
  const complete = assistants.every(message => message.usage && message.timing?.firstTokenMs !== undefined && message.timing.durationMs > message.timing.firstTokenMs)
  const decodeMs = complete ? assistants.reduce((sum, message) => sum + message.timing!.durationMs - message.timing!.firstTokenMs!, 0) : 0
  return { runMs: run.durationMs, ttftMs: assistants[0]?.timing?.firstTokenMs,
    ...(decodeMs > 0 ? { tokensPerSecond: assistants.reduce((sum, message) => sum + message.usage!.output, 0) * 1000 / decodeMs } : {}) }
}
