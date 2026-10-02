import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyPiTelemetry, piTurnUsage } from '../src/client/pi-telemetry.ts'
import type { ChatMessage, ToolOutput } from '../src/client/pi-chat.tsx'

test('recorded telemetry joins only its owner and old history stays untimed', () => {
  const messages: ChatMessage[] = [{ role: 'assistant', time: 10, blocks: [] }, { role: 'assistant', time: 20, blocks: [] }]
  const tools = new Map<string, ToolOutput>([['call', { status: 'done' }]])
  const entries = [
    { kind: 'assistant', timestamp: 20, startedAt: 19, durationMs: 2, firstTokenMs: 1 },
    { kind: 'run', timestamp: 20, startedAt: 5, durationMs: 16 },
    { kind: 'tool-schema', callId: 'call', schema: { type: 'object' } },
    { kind: 'tool', callId: 'call', startedAt: 12, durationMs: 5 },
    { kind: 'assistant', timestamp: 10, startedAt: 9, durationMs: -1 },
  ].map((data, i) => ({ id: String(i), type: 'custom', customType: 'dsh-workbench.telemetry.v1', data }))
  applyPiTelemetry(messages, tools, entries)
  assert.equal(messages[0].timing, undefined)
  assert.equal(messages[1].timing?.firstTokenMs, 1)
  assert.equal(messages[1].runTiming?.durationMs, 16)
  assert.deepEqual(tools.get('call')?.schema, { type: 'object' })
  assert.equal(tools.get('call')?.timing?.durationMs, 5)
})

test('turn usage includes intermediate calls and keeps unknown cache buckets absent', () => {
  const messages: ChatMessage[] = [
    { role: 'assistant', blocks: [], usage: { input: 10, output: 2, cacheRead: 8, cacheWrite: 0 } },
    { role: 'assistant', blocks: [], usage: { input: 20, output: 3, cacheRead: 7, cacheWrite: 1 } },
  ]
  assert.deepEqual(piTurnUsage(messages), { uncachedInputTokens: 30, outputTokens: 5, totalTokens: 51, cacheReadTokens: 15, cacheWriteTokens: 1 })
  messages.push({ role: 'assistant', blocks: [], usage: { input: 1, output: 1 } })
  assert.equal(piTurnUsage(messages)?.cacheReadTokens, undefined)
})

test('throughput excludes request waiting time and remains absent for unmeasured history', async () => {
  const { piTurnTiming } = await import('../src/client/pi-telemetry.ts')
  const messages: ChatMessage[] = [{ role: 'assistant', blocks: [], usage: { input: 2, output: 10 }, timing: { startedAt: 1, durationMs: 600, firstTokenMs: 100 }, runTiming: { startedAt: 1, durationMs: 700 } }]
  assert.deepEqual(piTurnTiming(messages), { runMs: 700, ttftMs: 100, tokensPerSecond: 20 })
  messages[0].timing = undefined
  assert.equal(piTurnTiming(messages)?.tokensPerSecond, undefined)
})
