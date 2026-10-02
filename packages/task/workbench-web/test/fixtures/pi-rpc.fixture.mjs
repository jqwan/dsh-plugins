/** Controlled subprocess for testing the actual JSONL executor without a model or network. */
import { createInterface } from 'node:readline'
const emit = frame => process.stdout.write(JSON.stringify(frame) + '\n')
for await (const line of createInterface({ input: process.stdin })) {
  const cmd = JSON.parse(line)
  const response = (data = {}) => emit({ type: 'response', command: cmd.type, id: cmd.id, success: true, data })
  if (cmd.type === 'get_messages') { response({ messages: [{ role: 'user', content: 'history', timestamp: 1 }] }); continue }
  if (cmd.type === 'get_entries') {
    response({
      entries: [
        { id: 'other', parentId: null, type: 'message', message: { role: 'user', content: 'other branch' } },
        { id: 'e1', parentId: null, type: 'message', message: { role: 'user', content: 'history', timestamp: 1 } },
      ],
      leafId: 'e1',
    })
    continue
  }
  if (cmd.type === 'get_state') { response({ isStreaming: true, pendingMessageCount: 1 }); continue }
  if (cmd.type === 'prompt') {
    if (cmd.streamingBehavior !== 'followUp' && cmd.streamingBehavior !== 'steer') { emit({ type: 'response', id: cmd.id, success: false, error: 'missing streamingBehavior' }); continue }
    response()
    emit({ type: 'agent_start' })
    emit({ type: 'message_start', message: { role: 'assistant', timestamp: 2, content: [] } })
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } })
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: cmd.streamingBehavior } })
    emit({ type: 'extension_ui_request', id: 'select-1', method: 'select', title: 'Select', options: ['Allow', 'Block'] })
    continue
  }
  if (cmd.type === 'extension_ui_response') { emit({ type: 'test_ui_response', value: cmd.value }); continue }
  response()
}
