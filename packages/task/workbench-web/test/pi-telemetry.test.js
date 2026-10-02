import { test } from 'node:test';
import assert from 'node:assert/strict';
import telemetry from '../src/pi/pi-telemetry-extension.js';

test('records request TTFT, overlapping tools and the full run without model messages', t => {
  let tick = 0;
  t.mock.method(performance, 'now', () => tick);
  t.mock.method(Date, 'now', () => 1000 + tick);
  const handlers = new Map();
  const records = [];
  const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
  telemetry({ on: (name, handler) => handlers.set(name, handler), appendEntry: (type, data) => records.push({ type, data }), getAllTools: () => [{ name: 'read', parameters: schema }] });
  const emit = (name, data = {}) => handlers.get(name)(data);
  emit('agent_start');
  tick = 10; emit('before_provider_request');
  tick = 30; emit('message_update', { assistantMessageEvent: { type: 'thinking_delta' } });
  tick = 50; emit('message_update', { assistantMessageEvent: { type: 'text_delta' } });
  tick = 100; emit('message_end', { message: { role: 'assistant', timestamp: 1010 } });
  tick = 110; emit('tool_execution_start', { toolCallId: 'a', toolName: 'read' });
  tick = 120; emit('tool_execution_start', { toolCallId: 'b', toolName: 'read' });
  tick = 150; emit('tool_execution_end', { toolCallId: 'b' });
  tick = 190; emit('tool_execution_end', { toolCallId: 'a' });
  tick = 200; emit('agent_end');
  assert.deepEqual(records.map(record => record.data), [
    { kind: 'assistant', timestamp: 1010, startedAt: 1010, durationMs: 90, firstTokenMs: 20 },
    { kind: 'tool-schema', callId: 'a', schema }, { kind: 'tool-schema', callId: 'b', schema },
    { kind: 'tool', callId: 'b', startedAt: 1120, durationMs: 30 },
    { kind: 'tool', callId: 'a', startedAt: 1110, durationMs: 80 },
    { kind: 'run', timestamp: 1010, startedAt: 1000, durationMs: 200 },
  ]);
  assert.ok(records.every(record => record.type === 'dsh-workbench.telemetry.v1'));
  emit('agent_start'); emit('agent_end');
  assert.equal(records.length, 6);
});
