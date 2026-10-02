/**
 * workbench-web 独立冒烟脚本：绕过 Cordis，用裸 http 服务器驱动
 * createRuntime()，验证 REST / 静态资源 / SSE 三条链路。
 * 用法：node scripts/smoke-workbench.mjs
 */
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../src/runtime.js';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'workbench-smoke-'));
const runtime = createRuntime({
  publicDir: path.join(packageDir, 'public'),
  vendorDir: path.join(packageDir, 'vendor'),
  dataDir,
  sessionsDir: path.join(dataDir, 'sessions'),
});

const server = createServer((req, res) => runtime.handleRequest(req, res));
server.on('upgrade', (req, socket, head) => runtime.handleUpgrade(req, socket, head));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}/workbench`;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`✔ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`✖ ${name}: ${error?.message || error}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message || '断言失败');
}

await check('GET /workbench/ 返回 index.html', async () => {
  const res = await fetch(`${base}/`);
  const text = await res.text();
  assert(res.status === 200, `status ${res.status}`);
  assert(text.includes('<script'), '不像 index.html');
});
await check('GET /workbench/app.js 返回前端脚本', async () => {
  const res = await fetch(`${base}/app.js`);
  assert(res.status === 200, `status ${res.status}`);
  assert((await res.text()).length > 10000, 'app.js 过小');
});
await check('GET /workbench/vendor/xterm/lib/xterm.mjs 可用', async () => {
  const res = await fetch(`${base}/vendor/xterm/lib/xterm.mjs`);
  assert(res.status === 200, `status ${res.status}`);
});
await check('GET /workbench/vendor/xterm-fit/addon-fit.mjs 可用', async () => {
  const res = await fetch(`${base}/vendor/xterm-fit/addon-fit.mjs`);
  assert(res.status === 200, `status ${res.status}`);
});
await check('POST /workbench/api/tasks 创建任务', async () => {
  const res = await fetch(`${base}/api/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '冒烟任务', workingDirs: [packageDir], description: 'smoke' }),
  });
  const body = await res.json();
  assert(res.status === 200, `status ${res.status}: ${JSON.stringify(body)}`);
  assert(body.task?.id, '缺 task.id');
  globalThis.__taskId = body.task.id;
});
await check('POST /workbench/api/tasks/:id/sessions 创建 pi 会话', async () => {
  const res = await fetch(`${base}/api/tasks/${globalThis.__taskId}/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '新会话' }),
  });
  const body = await res.json();
  assert(res.status === 200, `status ${res.status}: ${JSON.stringify(body)}`);
  assert(body.session?.kind === 'pi', `kind=${body.session?.kind}`);
  assert(body.session?.sessionFile, '缺 sessionFile');
});
await check('POST /workbench/api/tasks/:id/sessions 创建 dsh 会话被拒绝（桥未接入）', async () => {
  const res = await fetch(`${base}/api/tasks/${globalThis.__taskId}/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'dsh' }),
  });
  assert(res.status === 501, `status ${res.status}，期望 501`);
});
await check('GET /workbench/api/config 返回配置', async () => {
  const res = await fetch(`${base}/api/config`);
  const body = await res.json();
  assert(res.status === 200, `status ${res.status}`);
  assert(typeof body.maxConcurrent === 'number', '缺 maxConcurrent');
  assert(body.dshAvailable === false, 'dshAvailable 应为 false');
});
await check('GET /workbench/api/events SSE 连接', async () => {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: controller.signal });
  assert(res.status === 200, `status ${res.status}`);
  assert(String(res.headers.get('content-type')).includes('text/event-stream'), 'content-type 不是 SSE');
  const reader = res.body.getReader();
  const { value } = await reader.read();
  assert(new TextDecoder().decode(value).includes('connected'), '首帧应包含 connected');
  controller.abort();
});
await check('GET /workbench/api/tasks 列出任务（含 kind 序列化）', async () => {
  const res = await fetch(`${base}/api/tasks`);
  const body = await res.json();
  assert(res.status === 200, `status ${res.status}`);
  const task = body.tasks.find((item) => item.id === globalThis.__taskId);
  assert(task, '任务未返回');
  assert(Array.isArray(task.sessions) && task.sessions[0]?.kind === 'pi', '会话缺 kind 字段');
});
await check('未知路径 404', async () => {
  const res = await fetch(`${base}/api/nope`);
  assert(res.status === 404, `status ${res.status}`);
});

await runtime.close();
await new Promise((resolve) => server.close(resolve));
rmSync(dataDir, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项失败` : '\n冒烟全部通过');
process.exit(failed ? 1 : 0);
