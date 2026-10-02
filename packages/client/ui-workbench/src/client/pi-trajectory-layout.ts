/** Maps pi records to the native trajectory ledger without inventing request timing. */
import { chatT } from './pi-locale.ts'
import type { ChatMessage, ToolOutput } from './pi-chat.tsx'
import type { PiTrajectoryEntry } from './pi-trajectory-data.ts'
import type { TrajectoryTurnModel, TrajectoryGroupModel } from './dsh-trajectory/layout.ts'
import type { TrajectoryCellProps, TrajectorySourceBlock } from './dsh-trajectory/trajectory-record.ts'
import type { TrajectoryTranslate } from './dsh-trajectory/locales.ts'

/** Build native assistant/tool groups, keeping thinking and usage on their owning assistant. */
export function piTrajectoryLayout(messages: readonly ChatMessage[], tools: ReadonlyMap<string, ToolOutput>, entries: readonly PiTrajectoryEntry[], t: TrajectoryTranslate): TrajectoryTurnModel[] {
  const turns: Array<{ turn: number | null; groups: TrajectoryGroupModel[] }> = []
  let turn = 0
  let step = 0
  let index = 0
  let current: { turn: number | null; groups: TrajectoryGroupModel[] } | undefined
  const metadata = (anchor: string | null) => {
    for (const entry of entries.filter(item => (item.afterEntryId ?? null) === anchor)) {
      if (!['compaction', 'branch_summary', 'model_change', 'thinking_level_change'].includes(entry.type)) continue
      turns.push({ turn: null, groups: [{ title: entry.type, cells: [{ index: ++index, recordId: `entry:${entry.id}`, kind: entry.type === 'compaction' ? 'compacted' : 'context', text: chatT(`trajectory.${entry.type}`), inputDetail: JSON.stringify(entry, null, 2), timeSeconds: null }] }] })
      current = undefined
    }
  }
  metadata(null)
  messages.forEach((message, ordinal) => {
    if (message.role === 'user') { turn++; step = 0; current = undefined }
    if (!current) { current = { turn: turn || null, groups: [] }; turns.push(current) }
    const id = message.entryId || `pi:${ordinal}`
    const text = message.blocks.filter(block => block.kind === 'text').map(block => block.text).join('\n\n').trim()
    const thinking = message.blocks.filter(block => block.kind === 'thinking').map(block => block.text).join('\n\n').trim()
    const sourceBlocks: TrajectorySourceBlock[] = message.blocks.flatMap<TrajectorySourceBlock>(block => {
      if (block.kind === 'text' || block.kind === 'thinking') return [{ type: block.kind, content: block.text }]
      if (block.kind === 'toolCall') return [{ type: 'tool-call', content: JSON.stringify(block.args, null, 2), callId: block.id, toolName: block.name }]
      if (block.kind === 'image' && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(block.mimeType)) return [{ type: 'image', content: '', inlineImageUrl: `data:${block.mimeType};base64,${block.data}` }]
      return []
    })
    const assistant = message.role === 'assistant'
    const cells: TrajectoryCellProps[] = [{
      index: ++index, recordId: id, kind: assistant ? 'message' : message.role === 'user' ? 'user' : 'context',
      text: message.text?.trim() || (text || thinking ? '' : sourceBlocks.some(block => block.type === 'image') ? t('layout.imageOnly', { count: sourceBlocks.filter(block => block.type === 'image').length }) : t('layout.toolCallOnly')), previewMarkdown: text || thinking,
      ...(assistant ? { outputDetail: text || message.errorText || (message.stopReason === 'aborted' ? chatT('trajectory.aborted') : ''), thinkingDetail: thinking } : { inputDetail: text || message.text }), sourceBlocks,
      opensTurn: message.role === 'user', timeSeconds: message.timing ? message.timing.durationMs / 1000 : null, startedAt: message.timing?.startedAt, timingSource: chatT('trajectory.timingSource'),
      ...(message.usage ? { input: message.usage.input, output: message.usage.output, cacheRead: message.usage.cacheRead, cacheWrite: message.usage.cacheWrite } : {}),
      isError: message.stopReason === 'error' || message.stopReason === 'aborted',
    }]
    for (const block of message.blocks) {
      if (block.kind !== 'toolCall') continue
      const result = tools.get(block.id)
      const args = JSON.stringify(block.args, null, 2)
      const done = result && result.status !== 'running'
      cells.push({ index: ++index, recordId: `tool:${block.id}`, kind: 'tool', callId: block.id, text: block.name, previewMarkdown: args, inputDetail: args,
        ...(done ? { resultPreviewMarkdown: result.text || '', result: result.text || '', outputDetail: result.text || '', outputBlocks: [{ type: 'text', content: result.text || '' }] } : {}), isError: result?.status === 'error', timeSeconds: result?.timing ? result.timing.durationMs / 1000 : null, startedAt: result?.timing?.startedAt, timingSource: chatT('trajectory.timingSource'), schemaDetail: result?.schema ? JSON.stringify(result.schema, null, 2) : undefined })
    }
    current.groups.push({ title: assistant ? t('group.step', { step: ++step }) : t('group.message'), cells })
    if (message.entryId) metadata(message.entryId)
  })
  return turns
}
