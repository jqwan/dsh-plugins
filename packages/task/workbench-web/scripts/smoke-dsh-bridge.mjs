/**
 * dsh 会话桥端到端冒烟：注入假的 sessionController 与事件订阅，
 * 验证 创建→读取→发送（首条带上下文）→运行状态→停止 全链路。
 * 用法：node scripts/smoke-dsh-bridge.mjs
 */
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../src/runtime.js';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── 假 sessionController ──────────────────────────────────────
const sessions = new Map(); // sessionId → { cwd, events: [], prompts: [] }
let nextId = 1;
let agentRunning = new Set();
const sessionController = {
  async create(request) {
    const id = `session-${nextId++}`;
    sessions.set(id, { cwd: request.cwd, events: [], prompts: [] });
    return { sessionId: id };
  },
  async prompt(request) {
    const record = sessions.get(request.sessionId);
    if (!record) throw new Error('no such session');
    record.prompts.push(request);
    const text = request.content?.[0]?.text || '';
    const seq = () => record.events.length + 1;
    record.events.push({ seq: seq(), type: 'user/message', time: Date.now(), data: { id: `u${seq()}`, source: { kind: 'user' }, content: [{ type: 'text', text }] } });
    emitSessionEvent(request.sessionId, 'user/message');
    // 模拟一次回合：assistant 回复
    agentRunning.add(request.sessionId);
    emitStatus(request.sessionId, 'running');
    setTimeout(() => {
      record.events.push({ seq: seq(), type: 'assistant/message', time: Date.now(), data: { interrupted: false, message: { id: `a${seq()}`, role: 'assistant', content: [{ type: 'text', text: `回复：${text.slice(-6)}` }] }, usage: { inputTokens: 10, outputTokens: 5 } } });
      emitSessionEvent(request.sessionId, 'assistant/message');
      agentRunning.delete(request.sessionId);
      emitStatus(request.sessionId, 'idle');
    }, 30);
    return { accepted: true };
  },
  async cancel(request) {
    agentRunning.delete(request.sessionId);
    return { accepted: true };
  },
  async rename() { return {}; },
  async inspect(sessionId) {
    const record = sessions.get(sessionId);
    if (!record) throw new Error('no such session');
    return { meta: { cwd: record.cwd }, events: record.events };
  },
};

const eventHandlers = [];
const statusHandlers = [];
function emitSessionEvent(sessionId, type) {
  for (const handler of eventHandlers) handler({ id: sessionId }, { type });
}
function emitStatus(sessionId, status) {
  for (const handler of statusHandlers) handler({ agent: { id: sessionId }, status });
}
const services = {
  sessionController,
  onSessionEvent: (handler) => { eventHandlers.push((session, event) => handler(session.id, event)); return () => {}; },
  onAgentStatus: (handler) => { statusHandlers.push((payload) => handler(payload.agent.id, payload.status === 'running')); return () => {}; },
};

const dataDir = mkdtempSync(path.join(tmpdir(), 'workbench-dsh-smoke-'));
const runtime = createRuntime({
  publicDir: path.join(packageDir, 'public'),
  vendorDir: path.join(packageDir, 'vendor'),
  dataDir,
  sessionsDir: path.join(dataDir, 'sessions'),
  services,
});
const server = createServer((req, res) => runtime.handleRequest(req, res));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}/workbench`;
runtime.start();

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`✔ ${name}`); }
  catch (error) { failed += 1; console.error(`✖ ${name}: ${error?.message || error}`); }
}
function assert(condition, message) { if (!condition) throw new Error(message || '断言失败'); }
const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

await check('config 报告 dshAvailable', async () => {
  const res = await fetch(`${base}/api/config`);
  const body = await res.json();
  assert(body.dshAvailable === true, `dshAvailable=${body.dshAvailable}`);
});

let taskId;
let sessionId;
let dshSessionId;
await check('创建任务与 dsh 会话', async () => {
  const task = await post('/api/tasks', { title: 'dsh 冒烟', workingDirs: [packageDir] });
  taskId = task.body.task.id;
  const created = await post(`/api/tasks/${taskId}/sessions`, { title: '新会话', kind: 'dsh' });
  assert(created.status === 200, `status ${created.status}: ${JSON.stringify(created.body)}`);
  assert(created.body.session.kind === 'dsh', 'kind 不是 dsh');
  sessionId = created.body.session.id;
  dshSessionId = created.body.session.dshSessionId;
  assert(dshSessionId?.startsWith('session-'), `dshSessionId=${dshSessionId}`);
  assert(sessions.get(dshSessionId).cwd === packageDir, 'create 未带 cwd');
});

await check('空会话消息列表', async () => {
  const res = await fetch(`${base}/api/tasks/${taskId}/sessions/${sessionId}/messages`);
  const body = await res.json();
  assert(res.status === 200, `status ${res.status}`);
  assert(body.messages.length === 0 && body.running === false, JSON.stringify(body));
});

await check('发送首条消息自动拼接任务上下文', async () => {
  const sent = await post(`/api/tasks/${taskId}/sessions/${sessionId}/messages`, { text: '你好' });
  assert(sent.status === 200, `status ${sent.status}: ${JSON.stringify(sent.body)}`);
  const record = sessions.get(dshSessionId);
  const promptText = record.prompts[0].content[0].text;
  assert(promptText.includes('【工作台任务】'), '首条消息未拼接任务上下文');
  assert(promptText.includes('你好'), '用户消息丢失');
  assert(promptText.includes('dsh 冒烟'), '任务标题未注入');
});

await check('助手回复出现在消息列表', async () => {
  await new Promise((resolve) => setTimeout(resolve, 400));
  const res = await fetch(`${base}/api/tasks/${taskId}/sessions/${sessionId}/messages`);
  const body = await res.json();
  assert(body.messages.length === 2, `messages=${body.messages.length}`);
  assert(body.messages[1].role === 'assistant' && body.messages[1].text.startsWith('回复：'), JSON.stringify(body.messages[1]));
  assert(body.messages[1].usage?.output === 5, 'usage 未适配');
});

await check('pi 会话消息接口被拒绝', async () => {
  const created = await post(`/api/tasks/${taskId}/sessions`, { title: 'pi 会话' });
  const piSessionId = created.body.session.id;
  const res = await fetch(`${base}/api/tasks/${taskId}/sessions/${piSessionId}/messages`);
  assert(res.status === 400, `status ${res.status}，期望 400`);
});

await check('stop 走 cancel', async () => {
  agentRunning.add(dshSessionId);
  emitStatus(dshSessionId, 'running');
  const stopped = await post(`/api/tasks/${taskId}/sessions/${sessionId}/stop`, {});
  assert(stopped.status === 200 && stopped.body.stopped === true, JSON.stringify(stopped.body));
  assert(!agentRunning.has(dshSessionId), 'cancel 未被调用');
});

await check('任务详情包含 dsh 会话统计', async () => {
  await new Promise((resolve) => setTimeout(resolve, 250));
  const res = await fetch(`${base}/api/tasks`);
  const body = await res.json();
  const task = body.tasks.find((item) => item.id === taskId);
  const session = task.sessions.find((item) => item.kind === 'dsh');
  assert(session.stats?.assistant === 1, `stats=${JSON.stringify(session.stats)}`);
  assert(session.latestMessageId, '缺 latestMessageId');
});

await runtime.close();
await new Promise((resolve) => server.close(resolve));
rmSync(dataDir, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项失败` : '\n桥冒烟全部通过');
process.exit(failed ? 1 : 0);
