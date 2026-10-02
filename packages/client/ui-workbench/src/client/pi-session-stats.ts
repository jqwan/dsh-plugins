/** DSH footer groups backed by pi billing and complete recorded timing samples. */
import type { ChatMessage, PiSessionStats, ToolOutput } from './pi-chat.tsx'
import { chatT } from './pi-locale.ts'
import { formatCacheHitPercent, formatTokens } from './dsh-chat/token-format.ts'
import { formatTokensPerSecond } from './dsh-chat/message-chrome.ts'

function duration(ms: number): string {
  if (ms < 60_000) return chatT('duration.compactSeconds', { seconds: Math.round(ms / 100) / 10 })
  const seconds = Math.round(ms / 1000)
  return chatT('duration.compactMinutes', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 })
}

/** Missing historical measurements suppress timing totals instead of counting them as zero. */
export function piSessionStatsGroups(stats: PiSessionStats | null, messages: readonly ChatMessage[], tools: ReadonlyMap<string, ToolOutput>): string[] {
  if (!stats) return []
  const groups: string[] = []
  if (stats.assistantMessages > 0) groups.push(chatT('stats.counts', { turns: stats.userMessages, steps: stats.assistantMessages }))
  const assistants = messages.filter(message => message.role === 'assistant' && !message.streaming)
  const complete = assistants.length > 0 && assistants.length === stats.assistantMessages
  const durations: string[] = []
  if (complete && assistants.every(message => message.timing)) {
    durations.push(chatT('stats.llm', { duration: duration(assistants.reduce((sum, message) => sum + message.timing!.durationMs, 0)) }))
  }
  const results = [...tools.values()]
  if (results.length > 0 && results.length === stats.toolCalls && results.every(tool => tool.timing)) {
    durations.push(chatT('stats.toolCall', { duration: duration(results.reduce((sum, tool) => sum + tool.timing!.durationMs, 0)) }))
  }
  if (durations.length) groups.push(durations.join(' · '))
  if (complete && assistants.every(message => message.timing?.firstTokenMs !== undefined)) {
    const speeds = [chatT('stats.ttftAverage', { duration: duration(assistants.reduce((sum, message) => sum + message.timing!.firstTokenMs!, 0) / assistants.length) })]
    if (assistants.every(message => message.usage && message.timing!.durationMs > message.timing!.firstTokenMs!)) {
      const decodeMs = assistants.reduce((sum, message) => sum + message.timing!.durationMs - message.timing!.firstTokenMs!, 0)
      const output = assistants.reduce((sum, message) => sum + message.usage!.output, 0)
      speeds.push(chatT('stats.tokensPerSecond', { throughput: formatTokensPerSecond(output * 1000 / decodeMs) }))
    }
    groups.push(speeds.join(' · '))
  }
  const input = stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite
  if (input > 0 || stats.tokens.output > 0) {
    const percent = formatCacheHitPercent(stats.tokens.cacheRead, input)
    if (percent !== null) groups.push(chatT('stats.cacheHit', { percent }))
    groups.push(chatT('stats.tokens', { input: formatTokens(input, chatT), output: formatTokens(stats.tokens.output, chatT) }))
  }
  return groups
}
