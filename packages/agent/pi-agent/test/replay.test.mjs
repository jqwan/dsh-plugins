/**
 * Golden replay test: a realistic pi session file must translate into the
 * expected dsh event sequence, with contiguous seqs, correct surface intents,
 * and paired tool/call ↔ tool/result linking. Branch entries off the active
 * leaf chain must be excluded.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { replayPiSession } from '../lib/persistence.js'

const FIXTURE = [
  { type: 'session', version: 3, id: '01a04f7e-3114', timestamp: '2026-08-29T21:47:45.300Z', cwd: '/tmp/proj' },
  { type: 'model_change', id: 'e1', parentId: null, timestamp: '2026-08-29T21:47:45.318Z', provider: 'deepseek', modelId: 'deepseek-v4-pro' },
  { type: 'message', id: 'm1', parentId: 'e1', timestamp: '2026-08-29T21:47:53.992Z', message: { role: 'user', content: '你好', timestamp: 1 } },
  { type: 'message', id: 'm2', parentId: 'm1', timestamp: '2026-08-29T21:47:58.000Z', message: {
    role: 'assistant',
    content: [{ type: 'thinking', thinking: '想一下' }, { type: 'text', text: '你好！' }],
    provider: 'deepseek', model: 'deepseek-v4-pro',
    usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 3, totalTokens: 15 },
    stopReason: 'stop', timestamp: 2,
  } },
  // Decoy branch: never referenced by the leaf chain, must be excluded.
  { type: 'message', id: 'decoy', parentId: 'm2', timestamp: '2026-08-29T21:47:59.000Z', message: { role: 'user', content: '岔路上的消息', timestamp: 3 } },
  { type: 'message', id: 'm3', parentId: 'm2', timestamp: '2026-08-29T21:48:10.000Z', message: { role: 'user', content: '列一下目录', timestamp: 4 } },
  { type: 'message', id: 'm4', parentId: 'm3', timestamp: '2026-08-29T21:48:15.000Z', message: {
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls' } }],
    provider: 'deepseek', model: 'deepseek-v4-pro',
    usage: { input: 20, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 28 },
    stopReason: 'toolUse', timestamp: 5,
  } },
  { type: 'message', id: 'm5', parentId: 'm4', timestamp: '2026-08-29T21:48:16.000Z', message: {
    role: 'toolResult', toolCallId: 'call-1', toolName: 'bash',
    content: [{ type: 'text', text: 'a.txt\nb.txt' }], isError: false, timestamp: 6,
  } },
  { type: 'message', id: 'm6', parentId: 'm5', timestamp: '2026-08-29T21:48:20.000Z', message: {
    role: 'assistant',
    content: [{ type: 'text', text: '目录里有 a.txt 和 b.txt。' }],
    provider: 'deepseek', model: 'deepseek-v4-pro',
    usage: { input: 30, output: 12, cacheRead: 0, cacheWrite: 0, totalTokens: 42 },
    stopReason: 'stop', timestamp: 7,
  } },
  { type: 'session_info', id: 's1', parentId: 'm6', timestamp: '2026-08-29T21:48:30.000Z', name: '目录测试' },
]

function writeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pi-replay-test-'))
  const file = join(dir, 'session-test-1234.jsonl')
  writeFileSync(file, FIXTURE.map(entry => JSON.stringify(entry)).join('\n') + '\n')
  return file
}

test('replay translates the active leaf chain into fold-valid dsh events', () => {
  const result = replayPiSession(readFileSync(writeFixture(), 'utf8'), 'session-test-1234.jsonl')
  assert.ok(result, 'fixture must parse')
  const { header, events } = result

  // Header synthesis
  assert.equal(header.id, 'session-test-1234')
  assert.equal(header.cwd, '/tmp/proj')
  assert.equal(header.version, 4)
  assert.equal(header.isSeeded, false)

  // Event type sequence (branch decoy excluded, boundaries synthesized)
  const types = events.map(event => event.type)
  assert.deepEqual(types, [
    'model/selection',      // model_change
    'turn/start',           // m1 user
    'user/message',
    'request/header',       // m2 assistant, initial route
    'request/context',
    'step/start',
    'assistant/message',
    'step/end',             // m3 user closes turn 1 first…
    'turn/end',
    'turn/start',           // …then opens turn 2
    'user/message',
    'step/start',           // m4 assistant opens turn 2 step 1
    'assistant/message',
    'tool/call',
    'tool/result',          // m5 pairs with the call
    'step/end',             // m6 assistant advances to step 2
    'step/start',
    'assistant/message',
    'session/title',        // s1 session_info
    'step/end',             // final close
    'turn/end',
  ])

  // Contiguous 0-based seqs
  events.forEach((event, index) => assert.equal(event.seq, index, `seq at ${index}`))

  // Model selection carries pi's route
  assert.deepEqual(events[0].data, { provider: 'deepseek', model: 'deepseek-v4-pro' })

  // Assistant message: thinking → reasoning, usage mapping, surface intent
  const firstAssistant = events[6]
  assert.equal(firstAssistant.data.turn, 1)
  assert.equal(firstAssistant.data.usage.inputTokens, 10)
  assert.equal(firstAssistant.data.usage.cacheReadTokens, 2)
  assert.equal(firstAssistant.data.usage.cacheWriteTokens, 3)
  assert.equal(firstAssistant.data.message.content[0].type, 'reasoning')
  assert.equal(firstAssistant.data.message.content[0].text, '想一下')
  assert.equal(firstAssistant.data.message.content[1].text, '你好！')
  assert.equal(firstAssistant.surfaceOp, 'append')

  // Tool call: arguments serialized; result linked back via sourceEventSeqs
  const toolCall = events.find(event => event.type === 'tool/call')
  assert.equal(toolCall.data.callId, 'call-1')
  assert.equal(toolCall.data.name, 'bash')
  assert.equal(toolCall.data.arguments, '{"command":"ls"}')
  const toolResult = events.find(event => event.type === 'tool/result')
  assert.equal(toolResult.surfaceOp, 'append')
  assert.deepEqual(toolResult.sourceEventSeqs, [toolCall.seq])
  assert.equal(toolResult.data.message.content[0].text, 'a.txt\nb.txt')
  assert.equal(toolResult.data.message.isError, false)

  // Title from session_info
  const title = events.find(event => event.type === 'session/title')
  assert.equal(title.data.title, '目录测试')

  // Timestamps carry over from pi entries (first assistant message time)
  assert.equal(events[6].time, Date.parse('2026-08-29T21:47:58.000Z'))
})

test('replay returns undefined for a file without a session header', () => {
  assert.equal(replayPiSession('{"type":"message","id":"x"}\n', 'orphan.jsonl'), undefined)
})
