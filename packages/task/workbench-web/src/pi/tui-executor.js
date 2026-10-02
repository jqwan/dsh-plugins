import pty from 'node-pty';
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const terminals = new Map();
const MAX_REPLAY_BYTES = 4 * 1024 * 1024;
function terminalKey(taskId, sessionId = null) { return `${taskId}:${sessionId || 'unknown'}`; }
function taskRecords(taskId) { return [...terminals.values()].filter((record) => record.taskId === taskId); }

function normalizeTheme(theme) {
  return theme === 'dark' ? 'dark' : 'light';
}

function clearSessionName(sessionFile) {
  if (!existsSync(sessionFile)) return;
  const entries = readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean);
  let parentId = null;
  for (let index = entries.length - 1; index >= 0; index--) {
    try {
      const entry = JSON.parse(entries[index]);
      if (entry.id) { parentId = entry.id; break; }
    } catch { /* ignore incomplete trailing data */ }
  }
  appendFileSync(sessionFile, `${JSON.stringify({ type: 'session_info', id: randomUUID(), parentId, timestamp: new Date().toISOString(), name: '' })}\n`);
}

function buildArgs({ sessionFile, provider, model, thinkingLevel, readOnly, approve, theme, appendSystemPrompt }) {
  const args = ['--session', sessionFile, '--tui-mode', 'regular', '--use-theme', normalizeTheme(theme)];
  if (appendSystemPrompt) args.push('--append-system-prompt', appendSystemPrompt);
  if (provider && model) args.push('--provider', provider, '--model', model);
  if (thinkingLevel) args.push('--thinking', thinkingLevel);
  if (readOnly) args.push('--tools', 'read,grep,find,ls');
  args.push(approve === false ? '--no-approve' : '--approve');
  return args;
}

export function isWebTuiRunning(taskId, sessionId = null) {
  return sessionId ? terminals.has(terminalKey(taskId, sessionId)) : taskRecords(taskId).length > 0;
}

export async function stopAllWebTuis() {
  await Promise.all([...terminals.values()].map((record) => stopRecord(record, true, true)));
}

export function getWebTui(taskId, sessionId = null) {
  return sessionId ? terminals.get(terminalKey(taskId, sessionId)) || null : taskRecords(taskId)[0] || null;
}

export function subscribeWebTui(taskId, sessionId, listener) {
  const record = terminals.get(terminalKey(taskId, sessionId));
  if (!record) return () => {};
  record.listeners.add(listener);
  if (record.replayReset) listener({ type: 'tui_reset' });
  if (record.output) listener({ type: 'tui_data', data: record.output });
  return () => record.listeners.delete(listener);
}

function broadcast(record, message) {
  for (const listener of record.listeners) {
    try { listener(message); } catch { /* browser disconnected */ }
  }
}

// pi 包在插件形态下未必可解析；允许宿主注入 cli.js 入口，解析失败则尝试 PATH 上的 pi 可执行文件，仍失败则 pi TUI 不可用。
let piCliEntryOverride = null;
export function configurePi({ cliEntry } = {}) {
  piCliEntryOverride = cliEntry || null;
}
export function resolvePiCliEntry() {
  if (piCliEntryOverride) return piCliEntryOverride;
  try {
    return path.join(path.dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'cli.js');
  } catch { /* fall through to PATH lookup */ }
  // node-pty 在 POSIX 上经 posix_spawnp 解析 PATH，可直接运行带 shebang 的 pi。
  // Windows 下 ConPTY 需要完整可执行路径且 npm 的 pi.cmd 引号不安全，跳过该兜底。
  if (process.platform !== 'win32') {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      try {
        const candidate = path.join(dir, 'pi');
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* not here */ }
    }
  }
  return null;
}

export async function startWebTui(options) {
  const theme = normalizeTheme(options.theme);
  const key = terminalKey(options.taskId, options.childSessionId);
  const current = terminals.get(key);
  if (current && current.theme === theme) {
    resizeWebTui(options.taskId, options.childSessionId, options.cols, options.rows);
    return current;
  }
  clearSessionName(options.sessionFile);

  // Launch the installed JS entry directly: npm's pi.cmd quoting is unsafe in
  // a Windows ConPTY child process.
  const cliEntry = resolvePiCliEntry();
  if (!cliEntry) throw new Error('未找到 pi（@earendil-works/pi-coding-agent），可在插件配置中指定 piCliEntry');
  const child = pty.spawn(process.execPath, [cliEntry, ...buildArgs({ ...options, theme })], {
    name: 'xterm-256color', cols: options.cols || 120, rows: options.rows || 34,
    cwd: options.workingDir,
    // Keep Pi's visible hardware cursor mode: Windows IME uses this anchor.
    // xterm itself renders it without blinking (see openNativeTui).
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', PI_HARDWARE_CURSOR: '1' },
  });

  let resolveExit;
  const record = {
    key, taskId: options.taskId, childSessionId: options.childSessionId, theme,
    process: child, listeners: new Set(), output: '', replayReset: false, pendingPrompts: [],
    inputOwner: null, onData: options.onData, onExit: options.onExit,
    exit: new Promise((resolve) => { resolveExit = resolve; }),
  };
  terminals.set(key, record);
  child.onData((data) => {
    // ANSI output is only replayable from the start of the terminal stream.
    // Never retain an arbitrary tail, which corrupts a reconnecting xterm.
    if (!record.replayReset) {
      if (record.output.length + data.length > MAX_REPLAY_BYTES) {
        record.output = '';
        record.replayReset = true;
      } else {
        record.output += data;
      }
    }
    broadcast(record, { type: 'tui_data', data });
    // 首个输出意味着 Pi 已接管 PTY；此时再注入后台便签，避免启动阶段丢失输入。
    if (record.pendingPrompts.length) {
      for (const prompt of record.pendingPrompts.splice(0)) record.process.write(prompt);
    }
    record.onData?.(data);
  });
  child.onExit(({ exitCode, signal }) => {
    if (terminals.get(key) === record) terminals.delete(key);
    broadcast(record, { type: 'tui_exit', exitCode, signal });
    resolveExit({ exitCode, signal });
    if (!record.silentStop) record.onExit?.({ exitCode, signal });
  });
  return record;
}

export function claimWebTuiInput(taskId, sessionId, ownerId) {
  const record = terminals.get(terminalKey(taskId, sessionId));
  if (!record) return false;
  record.inputOwner = ownerId;
  return true;
}

export function releaseWebTuiInput(taskId, sessionId, ownerId) {
  const record = terminals.get(terminalKey(taskId, sessionId));
  if (record?.inputOwner === ownerId) record.inputOwner = null;
}

export function writeWebTui(taskId, sessionId, ownerId, data) {
  const record = terminals.get(terminalKey(taskId, sessionId));
  if (!record) throw new Error('原生 TUI 未运行，请重新打开');
  if (record.inputOwner !== ownerId) throw new Error('该原生 TUI 已在另一页面中操作');
  const text = String(data || '');
  if (text.length > 64 * 1024) throw new Error('终端输入过长');
  record.process.write(text);
}

// 便签发送由服务端调用，仍只通过本模块写入 PTY，不能直接改写 session JSONL。
export function sendWebTuiPrompt(taskId, sessionId, text) {
  const record = terminals.get(terminalKey(taskId, sessionId));
  if (!record) throw new Error('原生 TUI 未运行，请重新打开');
  const prompt = String(text || '').trim();
  if (!prompt) throw new Error('便签描述不能为空');
  if (prompt.length > 64 * 1024) throw new Error('便签内容过长');
  const input = `${prompt}\r`;
  if (!record.output) {
    record.pendingPrompts.push(input);
    return true;
  }
  record.process.write(input);
  return true;
}

export function resizeWebTui(taskId, sessionId, cols, rows) {
  const record = terminals.get(terminalKey(taskId, sessionId));
  if (!record) return false;
  const width = Math.max(20, Math.min(500, Number(cols) || 120));
  const height = Math.max(5, Math.min(200, Number(rows) || 34));
  record.process.resize(width, height);
  return true;
}

function stopProcess(record) {
  if (process.platform === 'win32') {
    // Avoid node-pty's ConPTY AttachConsole helper when this service has no
    // Windows console; the exposed PID is the pi CLI process.
    try { process.kill(record.process.pid); } catch { /* already exited */ }
  } else {
    try { record.process.kill(); } catch { /* already exited */ }
  }
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForProcessExit(pid, timeoutMs = 1200) {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function stopRecord(record, silent = false, wait = true) {
  if (!record || terminals.get(record.key) !== record) return false;
  record.silentStop = silent;
  terminals.delete(record.key);
  stopProcess(record);
  if (wait) await record.exit;
  else await waitForProcessExit(record.process.pid);
  return true;
}
function recordsForStop(taskId, sessionId = null) {
  return sessionId ? [terminals.get(terminalKey(taskId, sessionId))].filter(Boolean) : taskRecords(taskId);
}
export async function stopWebTuiAndWait(taskId, { silent = false, sessionId = null } = {}) {
  const records = recordsForStop(taskId, sessionId);
  await Promise.all(records.map((record) => stopRecord(record, silent, true)));
  return records.length > 0;
}

// Theme changes only need the pi CLI to be gone before another CLI attaches to
// the same JSONL. Do not wait for ConPTY's delayed output-pipe cleanup.
export async function stopWebTuiForRestart(taskId, { sessionId = null } = {}) {
  const records = recordsForStop(taskId, sessionId);
  await Promise.all(records.map((record) => stopRecord(record, true, false)));
  return records.length > 0;
}

export function stopWebTui(taskId, options = {}) {
  if (!recordsForStop(taskId, options.sessionId).length) return false;
  void stopWebTuiAndWait(taskId, options);
  return true;
}
