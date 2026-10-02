/** Persist plugin telemetry as non-model-visible pi custom entries. */
export default function telemetry(pi) {
  let request = null;
  let run = null;
  let lastAssistant = null;
  const tools = new Map();
  const start = () => ({ startedAt: Date.now(), tick: performance.now() });
  const finish = value => ({ startedAt: value.startedAt, durationMs: Math.max(0, performance.now() - value.tick) });
  const save = data => pi.appendEntry('dsh-workbench.telemetry.v1', data);
  pi.on('agent_start', () => { run = start(); lastAssistant = null; });
  pi.on('before_provider_request', () => { request = start(); });
  pi.on('message_update', event => {
    if (request && request.firstTokenMs === undefined && ['text_delta', 'thinking_delta', 'toolcall_delta'].includes(event.assistantMessageEvent.type)) {
      request.firstTokenMs = performance.now() - request.tick;
    }
  });
  pi.on('message_end', event => {
    if (event.message.role !== 'assistant') return;
    lastAssistant = event.message.timestamp;
    if (request) save({ kind: 'assistant', timestamp: lastAssistant, ...finish(request), firstTokenMs: request.firstTokenMs });
    request = null;
  });
  pi.on('tool_execution_start', event => {
    const tool = pi.getAllTools().find(item => item.name === event.toolName);
    tools.set(event.toolCallId, start());
    save({ kind: 'tool-schema', callId: event.toolCallId, schema: tool?.parameters });
  });
  pi.on('tool_execution_end', event => {
    const value = tools.get(event.toolCallId);
    if (value) save({ kind: 'tool', callId: event.toolCallId, ...finish(value) });
    tools.delete(event.toolCallId);
  });
  pi.on('agent_end', () => {
    if (run && lastAssistant !== null) save({ kind: 'run', timestamp: lastAssistant, ...finish(run) });
    run = null;
    request = null;
    tools.clear();
  });
}
