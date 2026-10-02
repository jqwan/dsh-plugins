import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { resolvePiCliEntry } from './tui-executor.js';

/**
 * pi 聊天模式执行器：以 `--mode rpc` 无头方式运行 pi（stdin/stdout JSONL 协议），
 * 与 TUI 共用同一份 session JSONL，但同一时刻只允许一个 pi 进程写同一文件
 * （由 runtime 在 chat/tui 互切时先停另一方保证）。
 *
 * RPC 协议（pi-coding-agent dist/modes/rpc）：
 * - 命令：stdin 每行一个 JSON（{type, id?, ...}），应答为 {type:'response', command, success, data|error, id}
 * - 事件：stdout 上的 AgentSessionEvent；其中 message_update 被换成交量事件
 *   {type:'message_update', usage, assistantMessageEvent}，本模块用其中的
 *   partial/message/error 还原成完整消息再转发，前端无需理解增量协议。
 * - 扩展 UI：{type:'extension_ui_request', id, method, ...}，需回
 *   {type:'extension_ui_response', id, ...}；超时未应答自动取消。
 */

const chats = new Map();
const UI_RESPONSE_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 15_000;
const MAX_STDERR_BYTES = 8 * 1024;

function chatKey(taskId, sessionId) { return `${taskId}:${sessionId}`; }
function taskChats(taskId) { return [...chats.values()].filter((record) => record.taskId === taskId); }

export function isPiChatRunning(taskId, sessionId = null) {
  return sessionId ? chats.has(chatKey(taskId, sessionId)) : taskChats(taskId).length > 0;
}

export function getPiChat(taskId, sessionId) {
  return chats.get(chatKey(taskId, sessionId)) || null;
}

function broadcast(record, message) {
  message = { ...message, sequence: ++record.sequence };
  for (const listener of record.listeners) {
    try { listener(message); } catch { /* 单个订阅者异常不影响其余 */ }
  }
}

/** 严格按 \n 分帧读取 JSONL（不用 readline：它会按多余 Unicode 分隔符切行）。 */
function attachLineReader(stream, onLine) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line) onLine(line);
    }
  });
}

function settlePending(record, payload) {
  const id = payload.id;
  const pending = id ? record.pending.get(id) : null;
  if (!pending) return;
  record.pending.delete(id);
  clearTimeout(pending.timer);
  pending.resolve({ ...payload, sequence: record.sequence, live: record.liveAssistant ? structuredClone(record.liveAssistant) : null });
}

/**
 * 把 pi RPC 的 message_update 增量事件还原为完整消息事件。
 *
 * RPC 帧里的 assistantMessageEvent.partial 是空壳（实测 content 不随增量增长），
 * 只有 delta 字段携带本次增量，因此这里按 contentIndex 自行累积出实时消息：
 * text/thinking 追加 delta；toolCall 累积参数 JSON 文本（toolcall_end 给全量兜底）；
 * done/error 直接用官方最终消息。
 */
function createLiveAssistant() {
  return { role: 'assistant', content: [] };
}

function tryParseArgs(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

function normalizeToolCallBlock(block) {
  if (!block || block.type !== 'toolCall') return block;
  if (block.argsText !== undefined) {
    return { type: 'toolCall', id: block.id, name: block.name, arguments: block.arguments ?? tryParseArgs(block.argsText) };
  }
  return block;
}

function applyAssistantDelta(live, delta) {
  switch (delta.type) {
    case 'text_start':
      live.content[delta.contentIndex] = { type: 'text', text: '' };
      break;
    case 'text_delta': {
      const block = live.content[delta.contentIndex];
      if (block?.type === 'text') block.text += delta.delta || '';
      break;
    }
    case 'text_end': {
      const block = live.content[delta.contentIndex];
      if (block?.type === 'text' && typeof delta.content === 'string') block.text = delta.content;
      break;
    }
    case 'thinking_start':
      live.content[delta.contentIndex] = { type: 'thinking', thinking: '' };
      break;
    case 'thinking_delta': {
      const block = live.content[delta.contentIndex];
      if (block?.type === 'thinking') block.thinking += delta.delta || '';
      break;
    }
    case 'thinking_end': {
      const block = live.content[delta.contentIndex];
      if (block?.type === 'thinking' && typeof delta.content === 'string') block.thinking = delta.content;
      break;
    }
    case 'toolcall_start': {
      // toolcall_start 的参数形态随 provider 不同，先占位；name/id 若 partial 带了就取用
      const seeded = delta.partial?.content?.[delta.contentIndex];
      live.content[delta.contentIndex] = {
        type: 'toolCall',
        id: seeded?.id || '',
        name: seeded?.name || '',
        argsText: typeof seeded?.arguments === 'string' ? seeded.arguments : JSON.stringify(seeded?.arguments ?? {}) === '{}' ? '' : JSON.stringify(seeded?.arguments ?? {}),
      };
      break;
    }
    case 'toolcall_delta': {
      const block = live.content[delta.contentIndex];
      if (block?.type === 'toolCall' && typeof delta.delta === 'string') block.argsText = (block.argsText || '') + delta.delta;
      break;
    }
    case 'toolcall_end':
      if (delta.toolCall) live.content[delta.contentIndex] = { ...delta.toolCall };
      break;
    default:
      break;
  }
}

function normalizeAgentEvent(event, record) {
  if (event?.type !== 'message_update') return event;
  const deltaEvent = event.assistantMessageEvent || {};
  const live = record.liveAssistant;
  if (deltaEvent.type === 'done') return { type: 'message_update', message: deltaEvent.message, usage: event.usage ?? deltaEvent.message?.usage ?? null };
  if (deltaEvent.type === 'error') return { type: 'message_update', message: deltaEvent.error, usage: event.usage ?? null };
  if (!live) return null;
  applyAssistantDelta(live, deltaEvent);
  const message = {
    role: 'assistant',
    content: live.content.filter(Boolean).map(normalizeToolCallBlock),
    stopReason: undefined,
    timestamp: live.timestamp,
  };
  return { type: 'message_update', message, usage: event.usage ?? null };
}

function handleStdoutLine(record, line) {
  let frame;
  try { frame = JSON.parse(line); } catch { return; }
  if (!frame || typeof frame !== 'object') return;
  if (frame.type === 'response') {
    settlePending(record, frame);
    if (frame.success === false && frame.error) broadcast(record, { type: 'chat_error', error: String(frame.error) });
    return;
  }
  if (frame.type === 'extension_ui_request') {
    const id = frame.id;
    if (id && ['select', 'confirm', 'input', 'editor'].includes(frame.method)) {
      const timer = setTimeout(() => {
        if (record.pendingUi.has(id)) {
          record.pendingUi.delete(id);
          broadcast(record, { type: 'chat_ui_resolved', id });
          writeCommand(record, { type: 'extension_ui_response', id, cancelled: true });
        }
      }, typeof frame.timeout === 'number' && frame.timeout > 0 ? Math.min(frame.timeout, UI_RESPONSE_TIMEOUT_MS) : UI_RESPONSE_TIMEOUT_MS);
      timer.unref?.();
      record.pendingUi.set(id, { timer, frame });
    }
    const { type: _frameType, ...uiRequest } = frame;
    broadcast(record, { type: 'chat_ui_request', ...uiRequest });
    return;
  }
  // agent_settled / auto_compaction_* 等内部事件原样透传，前端按需忽略
  if (frame.type === 'agent_start') record.state.isStreaming = true;
  if (frame.type === 'agent_end') {
    record.state.isStreaming = false;
    record.liveAssistant = null;
  }
  if (frame.type === 'message_start') {
    // 每条新的助手消息重置增量累积器（user/toolResult 等消息用不到）
    record.liveAssistant = frame.message?.role === 'assistant'
      ? { role: 'assistant', content: Array.isArray(frame.message.content) ? frame.message.content.map((block) => ({ ...block })) : [], timestamp: frame.message.timestamp }
      : null;
  }
  if (frame.type === 'message_end' && frame.message?.role === 'assistant') record.liveAssistant = null;
  if (frame.type === 'message_update') {
    const normalized = normalizeAgentEvent(frame, record);
    if (normalized) broadcast(record, { type: 'chat_event', event: normalized });
    return;
  }
  if (frame.type === 'turn_end' || frame.type === 'agent_end') {
    broadcast(record, { type: 'chat_event', event: frame });
    try { record.onTurnEnd?.(); } catch { /* 标题持久化失败不影响会话 */ }
    return;
  }
  broadcast(record, { type: 'chat_event', event: frame });
}

function writeCommand(record, command) {
  if (!record.child.stdin || record.child.stdin.destroyed) return false;
  record.child.stdin.write(`${JSON.stringify(command)}\n`);
  return true;
}

function sendCommand(record, command, { timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const id = command.id;
    const timer = setTimeout(() => {
      if (id) record.pending.delete(id);
      resolve({ type: 'response', command: command.type, success: false, error: '命令响应超时' });
    }, timeoutMs);
    timer.unref?.();
    if (id) record.pending.set(id, { resolve, timer });
    if (!writeCommand(record, command)) {
      clearTimeout(timer);
      if (id) record.pending.delete(id);
      resolve({ type: 'response', command: command.type, success: false, error: '聊天进程未运行' });
    }
  });
}

let commandSeq = 0;
function nextCommandId() { commandSeq += 1; return `wb-${Date.now().toString(36)}-${commandSeq}`; }

/**
 * 启动（或复用）一个 pi 聊天进程。
 * @returns 已有活动进程时直接复用；否则拉起新进程。
 */
export async function startPiChat(options) {
  const key = chatKey(options.taskId, options.childSessionId);
  const existing = chats.get(key);
  if (existing && !existing.exited) return existing;
  const cliEntry = resolvePiCliEntry();
  if (!cliEntry) throw new Error('未找到 pi（@earendil-works/pi-coding-agent），可在插件配置中指定 piCliEntry');

  const args = ['--mode', 'rpc', '--session', options.sessionFile, '--extension', fileURLToPath(new URL('./pi-telemetry-extension.js', import.meta.url))];
  if (options.appendSystemPrompt) args.push('--append-system-prompt', options.appendSystemPrompt);
  if (options.provider && options.model) args.push('--provider', options.provider, '--model', options.model);
  if (options.thinkingLevel) args.push('--thinking', options.thinkingLevel);
  if (options.readOnly) args.push('--tools', 'read,grep,find,ls');
  args.push(options.approve === false ? '--no-approve' : '--approve');

  const child = spawn(process.execPath, [cliEntry, ...args], {
    cwd: options.workingDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  let resolveExit;
  const record = {
    key, taskId: options.taskId, sessionId: options.childSessionId, sessionFile: options.sessionFile,
    child, sequence: 0, listeners: new Set(), pending: new Map(), pendingUi: new Map(),
    state: {
      isStreaming: false, isCompacting: false,
      model: options.provider && options.model ? { provider: options.provider, id: options.model } : null,
      thinkingLevel: options.thinkingLevel || null,
    },
    liveAssistant: null,
    exited: false, exitCode: null, signal: null, stderrTail: '',
    onTurnEnd: options.onTurnEnd, onExit: options.onExit,
    exit: new Promise((resolve) => { resolveExit = resolve; }),
  };
  chats.set(key, record);

  attachLineReader(child.stdout, (line) => handleStdoutLine(record, line));
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    record.stderrTail = (record.stderrTail + chunk).slice(-MAX_STDERR_BYTES);
  });
  child.on('error', (error) => {
    broadcast(record, { type: 'chat_error', error: `聊天进程启动失败：${error.message}` });
  });
  child.on('exit', (exitCode, signal) => {
    if (chats.get(key) === record) chats.delete(key);
    record.exited = true;
    record.exitCode = exitCode;
    record.signal = signal;
    for (const [, pending] of record.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ type: 'response', command: 'exit', success: false, error: '聊天进程已退出' });
    }
    record.pending.clear();
    for (const pending of record.pendingUi.values()) clearTimeout(pending.timer);
    record.pendingUi.clear();
    broadcast(record, { type: 'chat_exit', exitCode, signal, stderr: record.stderrTail.trim().split('\n').slice(-3).join('\n') });
    resolveExit({ exitCode, signal });
    record.onExit?.({ exitCode, signal });
  });
  return record;
}

export function subscribePiChat(taskId, sessionId, listener) {
  const record = chats.get(chatKey(taskId, sessionId));
  if (!record) return () => {};
  record.listeners.add(listener);
  return () => record.listeners.delete(listener);
}

/** Submit with an explicit busy delivery mode and report acceptance to the caller. */
export async function sendPiChatPrompt(taskId, sessionId, text, { mode = 'queue', images = [] } = {}) {
  const record = chats.get(chatKey(taskId, sessionId));
  if (!record || record.exited) throw new Error('聊天进程未运行，请重新打开会话');
  const prompt = String(text || '').trim();
  if (!prompt && !images.length) throw new Error('消息内容不能为空');
  if (prompt.length > 64 * 1024) throw new Error('消息内容过长');
  if (!['queue', 'steer'].includes(mode)) throw new Error('无效的发送方式');
  if (!Array.isArray(images) || images.length > 8 || images.some(image =>
    !image || image.type !== 'image' || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mimeType)
    || typeof image.data !== 'string' || image.data.length > 14 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data))) {
    throw new Error('图片格式或大小无效');
  }
  return sendCommand(record, { id: nextCommandId(), type: 'prompt', message: prompt, images,
    streamingBehavior: mode === 'steer' ? 'steer' : 'followUp' });
}

/** Snapshot watermark is captured when the RPC response arrives, before later live events. */
export async function piChatSnapshot(taskId, sessionId) {
  // 当前 leaf 的祖先链是聊天历史；条目 id 同时用于分支操作。
  const response = await piChatCommand(taskId, sessionId, { type: 'get_entries' })
  if (!response.success) throw new Error(response.error)
  const record = chats.get(chatKey(taskId, sessionId))
  const entries = Array.isArray(response.data?.entries) ? response.data.entries : []
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  const branch = []
  const visited = new Set()
  let entryId = response.data?.leafId
  while (entryId != null) {
    if (visited.has(entryId)) throw new Error('pi 会话历史包含循环引用')
    visited.add(entryId)
    const entry = byId.get(entryId)
    if (!entry) throw new Error('pi 会话历史缺少父条目')
    branch.push(entry)
    entryId = entry.parentId
  }
  const messages = branch.reverse()
    .filter((entry) => entry?.type === 'message' && entry.message)
    .map((entry) => ({ ...entry.message, entryId: entry.id }))
  let afterEntryId = null
  const entriesForTrajectory = []
  for (const entry of branch) {
    if (entry.type === 'message') {
      if (entry.message?.role === 'user' || entry.message?.role === 'assistant') afterEntryId = entry.id
    } else entriesForTrajectory.push({ ...entry, afterEntryId })
  }
  return { type: 'chat_snapshot', sequence: response.sequence, messages, entries: entriesForTrajectory,
    live: response.live, requests: [...(record?.pendingUi.values() || [])].map(value => value.frame) }
}

export function abortPiChat(taskId, sessionId) {
  const record = chats.get(chatKey(taskId, sessionId));
  if (!record || record.exited) return false;
  void sendCommand(record, { id: nextCommandId(), type: 'abort' });
  return true;
}

/** 通用 RPC 命令透传（模型列表/切换模型/思考等级等）；失败以 success:false 收场。 */
export function piChatCommand(taskId, sessionId, command) {
  const record = chats.get(chatKey(taskId, sessionId));
  if (!record || record.exited) {
    return Promise.resolve({ type: 'response', command: command?.type || 'unknown', success: false, error: '聊天进程未运行' });
  }
  return sendCommand(record, { ...command, id: nextCommandId() });
}

/** 读取 RPC 会话状态（模型/思考等级/是否流式中）；失败返回 null。 */
export async function requestPiChatState(taskId, sessionId) {
  const record = chats.get(chatKey(taskId, sessionId));
  if (!record || record.exited) return null;
  const response = await sendCommand(record, { id: nextCommandId(), type: 'get_state' }, { timeoutMs: 5000 });
  if (response.success && response.data) {
    record.state = { ...record.state, ...response.data };
    return response.data;
  }
  return null;
}

/** 转发前端对扩展 UI 请求（确认/选择/输入）的应答。 */
export function respondPiChatUi(taskId, sessionId, response) {
  const record = chats.get(chatKey(taskId, sessionId));
  const id = response?.id;
  if (!record || record.exited || !id || !record.pendingUi.has(id)) return false;
  const pending = record.pendingUi.get(id);
  record.pendingUi.delete(id);
  clearTimeout(pending.timer);
  broadcast(record, { type: 'chat_ui_resolved', id });
  const payload = { type: 'extension_ui_response', id };
  for (const key of ['cancelled', 'confirmed', 'value']) if (key in response) payload[key] = response[key];
  writeCommand(record, payload);
  return true;
}

async function waitForExit(record, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!record.exited && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

/** 停止单个聊天进程（SIGTERM → 等待 → SIGKILL）。 */
export async function stopPiChatAndWait(taskId, sessionId, { timeoutMs = 4000 } = {}) {
  const record = chats.get(chatKey(taskId, sessionId));
  if (!record || record.exited) return false;
  try { record.child.kill('SIGTERM'); } catch { /* already exited */ }
  await waitForExit(record, timeoutMs);
  if (!record.exited) {
    try { record.child.kill('SIGKILL'); } catch { /* already exited */ }
    await waitForExit(record, 1500);
  }
  if (!record.exited) throw new Error('pi 进程尚未退出，不能切换会话界面');
  return true;
}

export async function stopAllPiChatsForTask(taskId, options = {}) {
  const records = options.sessionId ? [chats.get(chatKey(taskId, options.sessionId))].filter(Boolean) : taskChats(taskId);
  await Promise.all(records.map((record) => stopPiChatAndWait(taskId, record.sessionId, { timeoutMs: options.timeoutMs })));
  return records.length > 0;
}

export async function stopAllPiChats() {
  await Promise.all([...chats.values()].map((record) => stopPiChatAndWait(record.taskId, record.sessionId)));
}
