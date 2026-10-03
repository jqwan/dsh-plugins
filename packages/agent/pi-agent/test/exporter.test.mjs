/**
 * Golden exporter test: a realistic dsh event stream must round-trip into a
 * valid pi session file — linear parent chain, tool calls paired with named
 * results, routes preserved as model_change entries.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { exportPiSession } from '../lib/index.js'

const T = (ms) => ms

const EVENTS = [
  { type: 'turn/start', seq: 0, time: T(1000), data: { turn: 1 } },
  { type: 'user/message', seq: 1, time: T(1100), data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '列一下目录' }], source: { kind: 'user' } }, surfaceOp: 'append' },
  { type: 'request/header', seq: 2, time: T(1200), data: { header: { config: { provider: 'deepseek', model: 'deepseek-v4-pro' } }, reason: 'initial' } },
  { type: 'step/start', seq: 3, time: T(1300), data: { turn: 1, step: 1 } },
  { type: 'assistant/message', seq: 4, time: T(2000), data: {
    turn: 1, step: 1,
    message: { id: 'a1', role: 'assistant', content: [
      { type: 'reasoning', text: '想一下' },
      { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
    ], source: { kind: 'model', provider: 'deepseek', model: 'deepseek-v4-pro' } },
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 3, totalTokens: 15 },
    stream: [],
  }, surfaceOp: 'append' },
  { type: 'tool/call', seq: 5, time: T(2050), data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' } },
  { type: 'tool/result', seq: 6, time: T(3000), data: {
    turn: 1, step: 1,
    message: { id: 'r1', role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'a.txt' }], isError: false },
  }, surfaceOp: 'append', sourceEventSeqs: [5] },
  { type: 'assistant/message', seq: 7, time: T(4000), data: {
    turn: 1, step: 1,
    message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: '目录里有 a.txt。' }], source: { kind: 'model', provider: 'deepseek', model: 'deepseek-v4-pro' } },
    stream: [],
  }, surfaceOp: 'append' },
  { type: 'turn/end', seq: 8, time: T(4100), data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'session/title', seq: 9, time: T(4200), data: { title: '目录测试', messageSeqs: [], source: { kind: 'user' } } },
  { type: 'model/selection', seq: 10, time: T(4300), data: { provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'high' } },
]

test('exporter produces a valid pi session file from dsh events', () => {
  const content = exportPiSession(EVENTS, 'session-test-1', '/tmp/proj')
  const lines = content.trim().split('\n').map(line => JSON.parse(line))

  // Header
  assert.equal(lines[0].type, 'session')
  assert.equal(lines[0].id, 'session-test-1')
  assert.equal(lines[0].cwd, '/tmp/proj')
  assert.equal(lines[0].version, 3)

  // Entry type sequence: user, route, assistant(tool), toolResult, assistant, title, route+thinking
  assert.deepEqual(lines.slice(1).map(e => e.type), [
    'message',
    'model_change',
    'message',
    'message',
    'message',
    'session_info',
    'model_change',
    'thinking_level_change',
  ])

  // Linear parent chain: header → entries in order
  let expectedParent = lines[0].id
  for (const entry of lines.slice(1)) {
    assert.equal(entry.parentId, expectedParent)
    expectedParent = entry.id
  }

  // Route preserved from request/header
  assert.deepEqual([lines[2].provider, lines[2].modelId], ['deepseek', 'deepseek-v4-pro'])

  // User message text
  assert.equal(lines[1].message.role, 'user')
  assert.equal(lines[1].message.content, '列一下目录')

  // Assistant with tool call: reasoning → thinking, arguments parsed to object
  const assistantWithCall = lines[3]
  assert.equal(assistantWithCall.message.role, 'assistant')
  assert.equal(assistantWithCall.message.stopReason, 'toolUse')
  assert.equal(assistantWithCall.message.content[0].type, 'thinking')
  assert.equal(assistantWithCall.message.content[1].type, 'toolCall')
  assert.deepEqual(assistantWithCall.message.content[1].arguments, { command: 'ls' })
  assert.equal(assistantWithCall.message.usage.input, 10)
  assert.equal(assistantWithCall.message.usage.cacheRead, 2)

  // Tool result recovers the tool name from the paired call
  const toolResult = lines[4]
  assert.equal(toolResult.message.role, 'toolResult')
  assert.equal(toolResult.message.toolName, 'bash')
  assert.equal(toolResult.message.isError, false)
  assert.deepEqual(toolResult.message.content, [{ type: 'text', text: 'a.txt' }])

  // Final assistant: stop
  assert.equal(lines[5].message.stopReason, 'stop')

  // Title
  assert.equal(lines[6].name, '目录测试')

  // Trailing selection: route + thinking level
  assert.deepEqual([lines[7].provider, lines[7].modelId], ['deepseek', 'deepseek-flash'])
  assert.equal(lines[8].thinkingLevel, 'high')
})

test('exporter emits an empty chain for a fresh session', () => {
  const content = exportPiSession([], 'session-fresh')
  const lines = content.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(lines.length, 1)
  assert.equal(lines[0].type, 'session')
})
