/** Pi user messages delimit transcript groups; tool-result messages live in the tool map. */
import type { ChatMessage } from './pi-chat.tsx'
export function groupTurns(messages: readonly ChatMessage[]): Array<{ key: string; messages: ChatMessage[] }> {
  const turns: Array<{ key: string; messages: ChatMessage[] }> = []
  for (const [index, message] of messages.entries()) {
    if (message.role === 'user' || !turns.length) turns.push({ key: `${message.time ?? index}:${index}`, messages: [] })
    turns[turns.length - 1].messages.push(message)
  }
  return turns
}
