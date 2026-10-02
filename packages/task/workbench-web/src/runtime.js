import { piModelCatalog, resolvePiDraftModel } from './pi/model-catalog.js';
import { nextRunFromSchedule } from './schedule.js';
/**
 * 工作台运行时：移植自 workspace 工程 server.js。
 * 与独立运行形态的差异：
 * - 不再自行 listen，由宿主（ctx.webServer）转发请求与 WebSocket 升级；
 * - 数据目录可配置（默认 $DSH_HOME/data/workbench，退化为包内 data/）；
 * - pi CLI 入口可配置（configurePi）；
 * - 子会话分 pi / dsh 两种类型，dsh 会话经由 dsh/bridge.js 接入。
 */
import express from 'express';
import { WebSocketServer } from 'ws';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  paths, configurePaths,
  loadTasks, saveTasks, listTasks, getTask, createTask, updateTask, deleteTask, normalizeSchedule,
  listNotes, getNote, createNote, updateNote, deleteNote, reorderNotes, subscribeTasks, listDefaultNoteIds, updateDefaultNoteIds,
} from './store/store.js';
import { parseSessionFile, extractText } from './store/session.js';
import { killPi } from './pi/executor.js';
import { configurePi } from './pi/tui-executor.js';
import {
  startWebTui, stopWebTui, stopWebTuiAndWait, stopWebTuiForRestart, stopAllWebTuis, writeWebTui, resizeWebTui,
  isWebTuiRunning, subscribeWebTui, claimWebTuiInput, releaseWebTuiInput, sendWebTuiPrompt,
} from './pi/tui-executor.js';
import {
  startPiChat, getPiChat, isPiChatRunning, subscribePiChat, piChatSnapshot, sendPiChatPrompt, abortPiChat,
  requestPiChatState, respondPiChatUi, stopPiChatAndWait, stopAllPiChatsForTask, stopAllPiChats, piChatCommand,
} from './pi/chat-executor.js';
import { createDshBridge } from './dsh/bridge.js';

const PREFIX = '/workbench';
const DEFAULT_CONFIG = { port: 7777, maxConcurrent: 0, approvePi: true };

/** @returns 工作台运行时句柄 */
export function createRuntime(options = {}) {
  const {
    publicDir, vendorDir,
    dataDir, sessionsDir,
    piCliEntry,
    services = {},
  } = options;
  if (!publicDir) throw new Error('createRuntime 需要 publicDir');
  configurePaths({ dataDir, sessionsDir });
  configurePi({ cliEntry: piCliEntry });
  const dshBridge = createDshBridge({
    ...services,
    listDshSessions: () => {
      const known = [];
      for (const task of listTasks()) {
        for (const child of taskSessions(task)) {
          if (child.kind === 'dsh' && child.dshSessionId) known.push({ taskId: task.id, task, child });
        }
      }
      return known;
    },
    onActivity: (dshSessionId) => {
      const task = listTasks().find((item) => taskSessions(item).some((child) => child.dshSessionId === dshSessionId));
      if (task) notifySessionChanged(task.id);
    },
  });

  const activeSessionIds = new Map();
  const tuiOpenings = new Map();
  const taskEventClients = new Set();
  const taskEventTimers = new Map();
  const sessionEventTimers = new Map();
  let config = { ...DEFAULT_CONFIG };
  try {
    if (existsSync(paths.CONFIG_FILE)) config = { ...config, ...JSON.parse(readFileSync(paths.CONFIG_FILE, 'utf8')) };
  } catch { /* 使用默认配置 */ }
  function saveConfig() {
    mkdirSync(paths.DATA_DIR, { recursive: true });
    writeFileSync(paths.CONFIG_FILE, JSON.stringify(config, null, 2));
  }

  const app = express();
  function broadcastTaskEvent(event = {}) {
    const payload = `data: ${JSON.stringify({ type: 'tasks_changed', ...event })}\n\n`;
    for (const client of taskEventClients) {
      try { client.write(payload); } catch { taskEventClients.delete(client); }
    }
  }
  function notifyTaskChanged(taskId, reason = 'task') {
    const key = taskId || '*';
    if (taskEventTimers.has(key)) return;
    const timer = setTimeout(() => {
      taskEventTimers.delete(key);
      broadcastTaskEvent({ taskId: taskId || null, reason });
    }, 200);
    taskEventTimers.set(key, timer);
    timer.unref?.();
  }
  // pi 会连续输出多个终端帧；等 JSONL 写入稳定后再通知一次即可。
  function notifySessionChanged(taskId) {
    if (!taskId) return;
    clearTimeout(sessionEventTimers.get(taskId));
    const timer = setTimeout(() => {
      sessionEventTimers.delete(taskId);
      broadcastTaskEvent({ taskId, reason: 'session' });
    }, 300);
    sessionEventTimers.set(taskId, timer);
    timer.unref?.();
  }
  subscribeTasks((event) => {
    notifyTaskChanged(event.taskId);
    if (event.noteId) rescheduleNote(getNote(event.noteId));
  });

  // ===== 便签定时发送调度：到点把便签内容发往指定任务的已有/新建会话 =====
  const SCHEDULE_TICK_MS = 20_000;
  const noteSendNextRuns = new Map(); // `${noteId}/${sendId}` -> 下次触发时间戳

  /** 重算单个发送项的下次触发时间；无有效计划（含 custom 已过期）则注销。 */
  function rescheduleNoteSend(note, send) {
    const next = nextRunFromSchedule(send.schedule);
    const key = `${note.id}/${send.id}`;
    if (next == null) noteSendNextRuns.delete(key);
    else noteSendNextRuns.set(key, next);
  }

  /** 重算便签全部发送项，并清掉已删除项的登记。 */
  function rescheduleNote(note) {
    if (!note) return;
    const prefix = `${note.id}/`;
    const alive = new Set((note.sends || []).map((send) => send.id));
    for (const key of [...noteSendNextRuns.keys()]) {
      if (key.startsWith(prefix) && !alive.has(key.slice(prefix.length))) noteSendNextRuns.delete(key);
    }
    for (const send of note.sends || []) rescheduleNoteSend(note, send);
  }

  /** 到点执行：按发送项投递便签内容，并记录触发时间。 */
  async function runNoteSend(note, send) {
    const fresh = getNote(note.id);
    if (!fresh || fresh.status === 'archived') return;
    try {
      const result = await deliverNote(fresh, send.sessionId
        ? { taskId: send.taskId, sessionId: send.sessionId, mode: 'current' }
        : { taskId: send.taskId, mode: 'new', kind: send.kind });
      const sends = (fresh.sends || []).map((item) => item.id === send.id ? { ...item, lastFiredAt: nowIso() } : item);
      updateNote(fresh.id, { sends });
      notifyTaskChanged(result.task?.id);
      console.log(`[workbench] 便签定时发送已触发（${fresh.title || '未命名便签'}）`);
    } catch (error) {
      console.error(`[workbench] 便签定时发送失败（${fresh.title || '未命名便签'}）：${error?.message || error}`);
    }
  }

  function noteSendTick() {
    const now = Date.now();
    for (const [key, next] of [...noteSendNextRuns]) {
      const split = key.indexOf('/');
      const note = getNote(key.slice(0, split));
      const send = note?.sends?.find((item) => item.id === key.slice(split + 1));
      if (!note || note.status === 'archived' || !send) { noteSendNextRuns.delete(key); continue; }
      if (now < next) continue;
      // 先重排再触发：周期项计算下一次；custom 单次项 next 变 null 自动注销
      rescheduleNoteSend(note, send);
      void runNoteSend(note, send);
    }
  }
  // 启动时为全部发送项登记下一次触发（停机期间错过的触发不补跑）
  for (const note of listNotes()) rescheduleNote(note);
  setInterval(noteSendTick, SCHEDULE_TICK_MS).unref?.();
  app.use(express.json({ limit: '2mb' }));
  app.use('/vendor/xterm', express.static(path.join(vendorDir, 'xterm')));
  app.use('/vendor/xterm-fit', express.static(path.join(vendorDir, 'xterm-fit')));
  app.use('/vendor/xterm-search', express.static(path.join(vendorDir, 'xterm-search')));
  app.use(express.static(publicDir));

  app.post('/api/client-log', (req, res) => {
    const message = String(req.body?.message || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
    if (!message) return res.status(400).json({ error: '日志内容不能为空' });
    const isError = req.body?.type === 'error';
    const output = `[workbench${isError ? ' error' : ''}] ${message}`;
    if (isError) console.error(output);
    else console.log(output);
    res.json({ ok: true });
  });

  function nowIso() { return new Date().toISOString(); }
  function sessionKind(child) { return child?.kind === 'dsh' ? 'dsh' : 'pi'; }
  function taskSessions(task) {
    if (!Array.isArray(task.sessions)) {
      task.sessions = task.sessionFile ? [{ id: randomUUID(), kind: 'pi', title: '新会话', sessionFile: task.sessionFile, createdAt: task.createdAt, updatedAt: task.updatedAt }] : [];
    }
    return task.sessions;
  }
  function activeTaskSessions(task) {
    return taskSessions(task).filter((session) => session.status !== 'archived');
  }
  function resolveTaskSession(task, sessionId) {
    if (sessionId) return taskSessions(task).find((session) => session.id === sessionId) || null;
    const sessions = activeTaskSessions(task);
    const activeSessionId = activeSessionIds.get(task.id);
    return sessions.find((session) => session.id === activeSessionId) || sessions[0] || null;
  }
  function sessionTitleFromPrompt(text) {
    const title = String(text || '').replace(/\s+/g, ' ').trim();
    if (!title) return '新会话';
    return title.length > 28 ? `${title.slice(0, 28)}…` : title;
  }
  /** 按会话类型读取事件流，产出 parseSessionFile 同形结构 */
  function readSession(child) {
    return sessionKind(child) === 'dsh' ? dshBridge.readSession(child) : parseSessionFile(child.sessionFile);
  }
  function sessionRunning(task, child) {
    if (sessionKind(child) === 'dsh') return dshBridge.isRunning(child);
    return isWebTuiRunning(task.id, child.id) || isPiChatRunning(task.id, child.id);
  }
  /** pi 任务级运行态：TUI 或聊天进程任一存活（并发上限口径）。 */
  function piSessionRunning(taskId) {
    return isWebTuiRunning(taskId) || isPiChatRunning(taskId);
  }
  /** 最后一条可见助手消息的 id（客户端 pi 会话"新回复"提醒的对比基线）。 */
  function latestAssistantMessageId(entries) {
    for (let index = (entries || []).length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry?.type === 'message' && entry.message?.role === 'assistant' && extractText(entry.message.content).trim()) {
        return entry.id || null;
      }
    }
    return null;
  }
  /**
   * pi 回合状态（状态点用）：读会话文件最后一条消息——
   * user/toolResult 结尾或 assistant(toolUse) = 回合进行中；assistant(error) = 回合出错。
   * PTY 存活但回合结束（assistant stop 结尾）= 空闲在提示符，不算运行中。
   */
  function piTurnState(child, parsed) {
    if (sessionKind(child) === 'dsh') return { busy: false, failed: false };
    const last = parsed.lastMessage;
    if (!last) return { busy: false, failed: false };
    const role = last.message?.role;
    const stopReason = last.message?.stopReason;
    if (role === 'assistant' && stopReason === 'error') return { busy: false, failed: true };
    if (role === 'user' || role === 'toolResult' || (role === 'assistant' && stopReason === 'toolUse')) {
      return { busy: true, failed: false };
    }
    return { busy: false, failed: false };
  }
  function publicSession(child) {
    let shown = child;
    const parsed = readSession(child);
    if (!child.title || child.title === '新会话') {
      for (const entry of parsed.entries) {
        if (entry.type !== 'message' || entry.message?.role !== 'user') continue;
        if (entry.message.source && entry.message.source !== 'user') continue;
        const text = extractText(entry.message.content).trim();
        if (!text || text.startsWith('## Task context')) continue;
        shown = { ...child, title: sessionTitleFromPrompt(text) };
        break;
      }
    }
    const latestMessageId = latestAssistantMessageId(parsed.entries);
    const turn = piTurnState(child, parsed);
    const parsedStats = parsed.stats;
    return {
      ...shown,
      kind: sessionKind(child),
      status: child.status === 'archived' ? 'archived' : 'active',
      favorite: Boolean(child.favorite),
      restorableWithTask: Boolean(child.restorableWithTask),
      turnBusy: turn.busy,
      turnFailed: turn.failed,
      stats: parsedStats ? {
        messages: Number(parsedStats.messages) || 0,
        user: Number(parsedStats.user) || 0,
        assistant: Number(parsedStats.assistant) || 0,
        toolResults: Number(parsedStats.toolResults) || 0,
        input: Number(parsedStats.input) || 0,
        output: Number(parsedStats.output) || 0,
        cacheRead: Number(parsedStats.cacheRead) || 0,
        cacheWrite: Number(parsedStats.cacheWrite) || 0,
        errors: Number(parsedStats.errors) || 0,
      } : null,
      latestMessageId,
    };
  }
  function persistSessionTitle(task, child) {
    if (!child || (child.title && child.title !== '新会话')) return;
    const shown = publicSession(child).title;
    if (!shown || shown === child.title) return;
    child.title = shown;
    child.updatedAt = nowIso();
    updateTask(task.id, { sessions: taskSessions(task) });
  }
  function publicTask(task) {
    const internalStatus = task.status;
    const displayStatus = ['unfinished', 'done', 'archived'].includes(internalStatus) ? internalStatus : 'unfinished';
    const sessions = taskSessions(task);
    const activeSessions = activeTaskSessions(task);
    const storedActiveSessionId = activeSessionIds.get(task.id);
    return {
      ...task,
      status: displayStatus,
      overdue: Boolean(task.deadline && task.status !== 'archived' && new Date(task.deadline).getTime() < Date.now()),
      sessions: sessions.map((session) => {
        const shown = publicSession(session);
        const running = sessionRunning(task, session);
        // agentBusy = 回合进行中且 TUI 存活；PTY 已死但文件停在半回合时不算运行中
        return { ...shown, running, agentBusy: Boolean(shown.turnBusy) && running };
      }),
      activeSessionId: activeSessions.some((session) => session.id === storedActiveSessionId) ? storedActiveSessionId : activeSessions[0]?.id || null,
      piRunning: piSessionRunning(task.id),
    };
  }
  function resolveWorkingDir(value) {
    let input = String(value || '').trim();
    if (!input || input.includes('\0')) return null;
    if (input === '~' || input.startsWith('~/')) input = path.join(process.env.HOME || '', input.slice(1));
    if (process.platform === 'win32' && path.win32.isAbsolute(input)) return path.win32.normalize(input);
    if (!path.isAbsolute(input)) return null;
    return path.normalize(input);
  }
  function resolveWorkingDirs(values) {
    const source = Array.isArray(values) ? values : [values];
    const raw = source.map((value) => String(value || '').trim()).filter(Boolean);
    if (!raw.length) return null;
    const resolved = raw.map(resolveWorkingDir);
    if (resolved.some((value) => !value)) return null;
    return [...new Set(resolved)];
  }
  function piSystemPrompt(task, workingDirs) {
    const context = workingDirs.map((workingDir) => {
      const contextFile = path.join(workingDir, 'AGENTS.md');
      let content;
      try {
        content = readFileSync(contextFile, 'utf8');
      } catch {
        content = '(未找到或无法读取该文件)';
      }
      return `${contextFile}:\n${content}`;
    }).join('\n\n');
    return [
      '## Task context',
      `task title: ${task.title || ''}`,
      `task description: ${task.description || ''}`,
      '',
      '## Project instructions',
      context || '(没有配置项目路径)',
    ].join('\n');
  }
  function concurrencyFull(extra = 0) {
    const runningTaskIds = new Set(listTasks().filter((task) => piSessionRunning(task.id)).map((task) => task.id));
    return config.maxConcurrent > 0 && runningTaskIds.size + extra > config.maxConcurrent;
  }
  async function removeTaskFiles(task) {
    // 永久删除前先取消仍在进行的 dsh 回合，避免任务删除后回合在后台继续跑
    await Promise.all(taskSessions(task)
      .filter((child) => sessionKind(child) === 'dsh')
      .map((child) => dshBridge.stop(child)));
    for (const child of taskSessions(task)) {
      if (sessionKind(child) === 'dsh') { dshBridge.forget(child); continue; }
      killPi(child.sessionFile);
      try { if (child.sessionFile && existsSync(child.sessionFile)) unlinkSync(child.sessionFile); } catch { /* ignore */ }
    }
  }
  async function stopTaskSession(task, child, options) {
    if (sessionKind(child) === 'dsh') return dshBridge.stop(child);
    const stoppedTui = await stopWebTuiAndWait(task.id, options);
    const stoppedChat = await stopAllPiChatsForTask(task.id, { sessionId: options?.sessionId ?? null });
    return stoppedTui || stoppedChat;
  }
  async function stopTaskTui(taskId, options) {
    const stoppedTui = await stopWebTuiAndWait(taskId, options);
    const stoppedChat = await stopAllPiChatsForTask(taskId);
    return stoppedTui || stoppedChat;
  }
  function withTuiLock(taskId, action) {
    const previous = tuiOpenings.get(taskId) || Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    tuiOpenings.set(taskId, current);
    return current.finally(() => {
      if (tuiOpenings.get(taskId) === current) tuiOpenings.delete(taskId);
    });
  }
  async function openTaskTui(task, childSession, cols, rows, theme, { activateSession = true } = {}) {
    if (!childSession) throw new Error('任务没有可用子会话');
    if (sessionKind(childSession) === 'dsh') throw new Error('dsh 会话不使用终端界面');
    // 已有 session 以 JSONL header 中记录的 cwd 为准；任务目录只作为新 session 的默认值。
    const sessionCwd = parseSessionFile(childSession.sessionFile).header?.cwd;
    const workingDir = resolveWorkingDir(sessionCwd || task.workingDir);
    if (!workingDir) throw new Error('请先为任务设置工作目录');
    const workingDirs = (Array.isArray(task.workingDirs) ? task.workingDirs : [task.workingDir])
      .map(resolveWorkingDir).filter(Boolean);
    mkdirSync(workingDir, { recursive: true });
    if (activateSession) activeSessionIds.set(task.id, childSession.id);
    const record = await startWebTui({
      taskId: task.id, childSessionId: childSession.id, workingDir, workingDirs, sessionFile: childSession.sessionFile,
      appendSystemPrompt: piSystemPrompt(task, workingDirs.length ? workingDirs : [workingDir]),
      title: childSession.title || task.title,
      provider: childSession.modelSelection?.provider ?? task.modelProvider,
      model: childSession.modelSelection?.model ?? task.model,
      thinkingLevel: childSession.modelSelection ? childSession.modelSelection.reasoningEffort : task.thinkingLevel, readOnly: task.readOnly, approve: config.approvePi !== false,
      cols, rows, theme: theme === 'dark' ? 'dark' : 'light',
      onData: () => notifySessionChanged(task.id),
      onExit: () => {
        const current = getTask(task.id);
        if (!current) return;
        const currentSession = resolveTaskSession(current, childSession.id);
        persistSessionTitle(current, currentSession);
        notifySessionChanged(task.id);
      },
    });
    return record;
  }

  /** 打开（或复用）pi 会话的聊天进程；与 TUI 互斥由调用方保证。 */
  async function openTaskChat(task, childSession, { activateSession = true } = {}) {
    if (!childSession) throw new Error('任务没有可用子会话');
    if (sessionKind(childSession) === 'dsh') throw new Error('dsh 会话不使用聊天界面');
    if (activateSession) activeSessionIds.set(task.id, childSession.id);
    if (isPiChatRunning(task.id, childSession.id)) return getPiChat(task.id, childSession.id);
    // 已有 session 以 JSONL header 中记录的 cwd 为准；任务目录只作为新 session 的默认值。
    const sessionCwd = parseSessionFile(childSession.sessionFile).header?.cwd;
    const workingDir = resolveWorkingDir(sessionCwd || task.workingDir);
    if (!workingDir) throw new Error('请先为任务设置工作目录');
    const workingDirs = (Array.isArray(task.workingDirs) ? task.workingDirs : [task.workingDir])
      .map(resolveWorkingDir).filter(Boolean);
    mkdirSync(workingDir, { recursive: true });
    return startPiChat({
      taskId: task.id, childSessionId: childSession.id, sessionFile: childSession.sessionFile,
      workingDir, workingDirs,
      appendSystemPrompt: piSystemPrompt(task, workingDirs.length ? workingDirs : [workingDir]),
      provider: childSession.modelSelection?.provider ?? task.modelProvider, model: childSession.modelSelection?.model ?? task.model, thinkingLevel: childSession.modelSelection ? childSession.modelSelection.reasoningEffort : task.thinkingLevel,
      readOnly: task.readOnly, approve: config.approvePi !== false,
      onTurnEnd: () => {
        const current = getTask(task.id);
        if (!current) return;
        persistSessionTitle(current, resolveTaskSession(current, childSession.id));
        notifySessionChanged(task.id);
      },
      onExit: () => notifySessionChanged(task.id),
    });
  }

  function publicNote(note) {
    return { ...note, overdue: Boolean(note.deadline && note.status !== 'archived' && new Date(note.deadline).getTime() < Date.now()) };
  }
  function notePatch(body = {}) {
    const patch = {};
    for (const key of ['title', 'description', 'color', 'deadline']) if (key in body) patch[key] = body[key];
    if ('title' in patch) patch.title = String(patch.title || '').trim();
    if ('description' in patch) patch.description = String(patch.description || '').trim();
    if ('deadline' in patch) patch.deadline = patch.deadline || null;
    return patch;
  }

  function normalizeNoteIds(ids) {
    const available = new Set(listNotes().filter((note) => note.status !== 'archived').map((note) => note.id));
    return [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id).trim()).filter((id) => available.has(id)))];
  }

  // 便签 CRUD
  app.get('/api/notes', (_req, res) => res.json({ notes: listNotes().map(publicNote), defaultNoteIds: listDefaultNoteIds() }));
  app.put('/api/notes/defaults', (req, res) => {
    const ids = normalizeNoteIds(req.body?.noteIds);
    res.json({ defaultNoteIds: updateDefaultNoteIds(ids) });
  });
  app.post('/api/notes', (req, res) => {
    const patch = notePatch(req.body || {});
    if (!patch.description) return res.status(400).json({ error: '便签描述不能为空' });
    res.json({ note: publicNote(createNote(patch)) });
  });
  app.post('/api/notes/reorder', (req, res) => {
    const placement = req.body?.placement;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id) => typeof id === 'string') : null;
    if (!['topbar', 'session'].includes(placement) || !ids) return res.status(400).json({ error: '无效的便签排序请求' });
    const notes = reorderNotes(placement, ids);
    res.json({ notes: notes.map(publicNote) });
  });
  app.put('/api/notes/:id', (req, res) => {
    const note = getNote(req.params.id);
    if (!note) return res.status(404).json({ error: '便签不存在' });
    const patch = notePatch(req.body || {});
    if ('description' in patch && !patch.description) return res.status(400).json({ error: '便签描述不能为空' });
    res.json({ note: publicNote(updateNote(note.id, patch)) });
  });
  app.delete('/api/notes/:id', (req, res) => {
    const note = getNote(req.params.id);
    if (!note) return res.status(404).json({ error: '便签不存在' });
    const archivedAt = nowIso();
    res.json({ note: publicNote(updateNote(note.id, { status: 'archived', archivedAt })) });
  });
  app.post('/api/notes/:id/restore', (req, res) => {
    const note = getNote(req.params.id);
    if (!note) return res.status(404).json({ error: '便签不存在' });
    if (note.status !== 'archived') return res.status(409).json({ error: '只有废弃便签可以恢复' });
    res.json({ note: publicNote(updateNote(note.id, { status: 'active', archivedAt: null })) });
  });
  app.delete('/api/notes/:id/permanent', (req, res) => {
    if (!deleteNote(req.params.id)) return res.status(404).json({ error: '便签不存在' });
    res.json({ ok: true });
  });

  app.delete('/api/archived', async (req, res) => {
    const type = ['all', 'tasks', 'notes', 'sessions'].includes(req.body?.type) ? req.body.type : 'all';
    const archivedTasks = ['notes', 'sessions'].includes(type) ? [] : listTasks().filter((task) => task.status === 'archived');
    for (const task of archivedTasks) {
      await stopTaskTui(task.id, { silent: true });
      await removeTaskFiles(task);
      activeSessionIds.delete(task.id);
      deleteTask(task.id);
    }
    const archivedNotes = ['tasks', 'sessions'].includes(type) ? [] : listNotes().filter((note) => note.status === 'archived');
    for (const note of archivedNotes) deleteNote(note.id);
    let archivedSessions = 0;
    if (type === 'all' || type === 'sessions') {
      for (const task of listTasks()) {
        const sessions = taskSessions(task);
        const removed = sessions.filter((session) => session.status === 'archived');
        if (!removed.length) continue;
        for (const session of removed) {
          await stopTaskSession(task, session, { silent: true, sessionId: session.id });
          if (sessionKind(session) === 'pi') {
            try { if (session.sessionFile && existsSync(session.sessionFile)) unlinkSync(session.sessionFile); } catch { /* ignore */ }
          } else {
            dshBridge.forget(session);
          }
        }
        const kept = sessions.filter((session) => session.status !== 'archived');
        const patch = { sessions: kept, sessionFile: kept.find((session) => session.sessionFile === task.sessionFile)?.sessionFile || kept[0]?.sessionFile || null };
        if (!kept.some((session) => session.id === activeSessionIds.get(task.id))) activeSessionIds.set(task.id, kept[0]?.id);
        updateTask(task.id, patch);
        archivedSessions += removed.length;
      }
    }
    res.json({ removed: archivedTasks.length + archivedNotes.length + archivedSessions });
  });

  // 会话栏中的便签始终以当前会话为上下文，不保存任务或子会话关联。
  // 立即发送端点与定时发送调度共用 deliverNote 投递核心。
  function httpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
  }

  /** 把便签内容投递到任务的目标会话；session 缺省时按 kind 新建会话。失败抛带 status 的错误。 */
  async function deliverNote(note, { taskId, sessionId, mode = 'current', kind = 'pi' }) {
    const task = getTask(taskId);
    if (!task) throw httpError(400, '请先选择一个任务');
    if (task.status === 'archived') throw httpError(409, '废弃任务不能发送便签');
    let session;
    if (mode === 'new') {
      session = { id: randomUUID(), kind, title: '新会话', status: 'active', archivedAt: null, favorite: false, restorableWithTask: false, createdAt: nowIso(), updatedAt: nowIso() };
      if (kind === 'dsh') {
        if (!dshBridge.available) throw httpError(501, 'dsh 会话暂未接入');
        session.dshSessionId = await dshBridge.createSession({ task, workingDir: task.workingDir });
      } else {
        session.sessionFile = path.join(paths.SESSIONS_DIR, `${task.id}-${randomUUID()}.jsonl`);
      }
      const sessions = taskSessions(task);
      sessions.push(session);
      const patch = { sessions };
      if (!task.sessionFile && session.sessionFile) patch.sessionFile = session.sessionFile;
      updateTask(task.id, patch);
    } else {
      session = taskSessions(task).find((item) => item.id === sessionId);
      if (!session) throw httpError(400, '目标会话不存在');
    }
    if (sessionKind(session) === 'dsh') {
      try {
        await dshBridge.sendPrompt(session, note.description, { task });
      } catch (error) {
        throw httpError(500, `发送到 dsh 会话失败：${error?.message || error}`);
      }
      return { mode, session, task: getTask(task.id) };
    }
    // pi 会话按其界面形态投递：聊天会话走聊天进程，终端会话走 TUI 输入
    if (session.ui === 'chat') {
      if (isWebTuiRunning(task.id, session.id)) await stopWebTuiAndWait(task.id, { silent: true, sessionId: session.id });
      if (!isPiChatRunning(task.id, session.id) && concurrencyFull(1)) throw httpError(409, `已达到并发上限：${config.maxConcurrent}`);
      try {
        await withTuiLock(task.id, () => openTaskChat(getTask(task.id), session, { activateSession: mode !== 'new' }));
      } catch (error) {
        throw httpError(500, `启动聊天会话失败：${error?.message || error}`);
      }
      sendPiChatPrompt(task.id, session.id, note.description);
      return { mode, session, task: getTask(task.id) };
    }
    const runningSession = isWebTuiRunning(task.id, session.id);
    if (!runningSession) {
      const runningTask = isWebTuiRunning(task.id);
      if (!runningTask && concurrencyFull(1)) throw httpError(409, `已达到并发上限：${config.maxConcurrent}`);
      await withTuiLock(task.id, () => openTaskTui(getTask(task.id), session, 120, 34, 'light', { activateSession: mode !== 'new' }));
    }
    sendWebTuiPrompt(task.id, session.id, note.description);
    return { mode, session, task: getTask(task.id) };
  }

  app.post('/api/notes/:id/send', async (req, res) => {
    const note = getNote(req.params.id);
    if (!note) return res.status(404).json({ error: '便签不存在' });
    if (note.status === 'archived') return res.status(409).json({ error: '废弃便签不能发送' });
    try {
      const result = await deliverNote(note, {
        taskId: req.body?.taskId,
        sessionId: req.body?.sessionId,
        mode: req.body?.mode === 'new' ? 'new' : 'current',
        kind: req.body?.kind === 'dsh' ? 'dsh' : 'pi',
      });
      res.json({ ok: true, mode: result.mode, session: publicSession(result.session), task: publicTask(result.task) });
    } catch (error) {
      res.status(error?.status || 500).json({ error: error?.message || '发送失败' });
    }
  });

  // 便签定时发送项：一个便签可挂多个“发送到某任务已有/新建会话”的定时设置
  app.post('/api/notes/:id/sends', (req, res) => {
    const note = getNote(req.params.id);
    if (!note) return res.status(404).json({ error: '便签不存在' });
    if (note.status === 'archived') return res.status(409).json({ error: '废弃便签不能添加定时发送' });
    const body = req.body || {};
    const task = getTask(body.taskId);
    if (!task || task.status === 'archived') return res.status(400).json({ error: '请选择一个未废弃的任务' });
    const useExisting = Boolean(body.sessionId);
    if (useExisting && !taskSessions(task).some((item) => item.id === body.sessionId && item.status !== 'archived')) {
      return res.status(400).json({ error: '目标会话不存在' });
    }
    const schedule = normalizeSchedule(body.schedule);
    if (!schedule) return res.status(400).json({ error: '请补全有效的定时设置' });
    const item = {
      id: randomUUID(),
      taskId: task.id,
      sessionId: useExisting ? String(body.sessionId) : null,
      kind: body.kind === 'pi' ? 'pi' : 'dsh',
      schedule,
      lastFiredAt: null,
    };
    updateNote(note.id, { sends: [...(note.sends || []), item] });
    res.json({ note: publicNote(getNote(note.id)) });
  });
  app.delete('/api/notes/:id/sends/:sendId', (req, res) => {
    const note = getNote(req.params.id);
    if (!note) return res.status(404).json({ error: '便签不存在' });
    const sends = (note.sends || []).filter((item) => item.id !== req.params.sendId);
    if (sends.length === (note.sends || []).length) return res.status(404).json({ error: '定时发送项不存在' });
    updateNote(note.id, { sends });
    res.json({ note: publicNote(getNote(note.id)) });
  });

  // 任务 CRUD
  app.get('/api/tasks', (_req, res) => res.json({ tasks: listTasks().map(publicTask) }));
  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    taskEventClients.add(res);
    const heartbeat = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch { /* closed response */ }
    }, 25000);
    heartbeat.unref?.();
    req.on('close', () => {
      clearInterval(heartbeat);
      taskEventClients.delete(res);
    });
  });
  app.post('/api/tasks', (req, res) => {
    const body = req.body || {};
    if (!String(body.title || '').trim()) return res.status(400).json({ error: '标题不能为空' });
    const workingDirs = resolveWorkingDirs(Object.hasOwn(body, 'workingDirs') ? body.workingDirs : body.workingDir);
    if (!workingDirs) return res.status(400).json({ error: '请选择工作目录' });
    const { noteIds: _ignoredNoteIds, ...taskBody } = body;
    res.json({ task: publicTask(createTask({ ...taskBody, workingDir: workingDirs[0], workingDirs })) });
  });
  app.put('/api/tasks/:id', (req, res) => {
    const task = getTask(req.params.id);
    if (!task) return res.status(404).json({ error: '任务不存在' });
    if (task.status === 'archived') return res.status(409).json({ error: '废弃任务不能编辑' });
    const body = req.body || {};
    const patch = {};
    for (const key of ['title', 'description', 'color']) if (key in body) patch[key] = body[key];
    if ('noteIds' in body) patch.noteIds = normalizeNoteIds(body.noteIds);
    if ('runKind' in body) {
      if (!['pi', 'dsh'].includes(body.runKind)) return res.status(400).json({ error: '会话类型无效' });
      patch.runKind = body.runKind;
    }
    for (const key of ['model', 'modelProvider', 'thinkingLevel']) {
      if (key in body) patch[key] = body[key] == null || body[key] === '' ? null : String(body[key]);
    }
    if ('deadline' in body) patch.deadline = body.deadline || null;
    if ('workingDirs' in body || 'workingDir' in body) {
      const workingDirs = resolveWorkingDirs(Object.hasOwn(body, 'workingDirs') ? body.workingDirs : body.workingDir);
      if (!workingDirs) return res.status(400).json({ error: '请选择工作目录' });
      patch.workingDir = workingDirs[0];
      patch.workingDirs = workingDirs;
    }
    if ('title' in patch && !String(patch.title).trim()) return res.status(400).json({ error: '标题不能为空' });
    if ('description' in patch) patch.description = String(patch.description || '').trim();
    res.json({ task: publicTask(updateTask(task.id, patch)) });
  });
  app.delete('/api/tasks/archived', async (_req, res) => {
    const archived = listTasks().filter((task) => task.status === 'archived');
    for (const task of archived) {
      await stopTaskTui(task.id, { silent: true });
      await removeTaskFiles(task);
      activeSessionIds.delete(task.id);
      deleteTask(task.id);
    }
    res.json({ removed: archived.length });
  });
  app.delete('/api/tasks/:id', async (req, res) => {
    const task = getTask(req.params.id);
    if (!task) return res.status(404).json({ error: '任务不存在' });
    await stopTaskTui(task.id, { silent: true });
    // 归档同时取消进行中的 dsh 回合（pi 进程由 stopTaskTui + 下方 killPi 覆盖）
    await Promise.all(taskSessions(task).filter((child) => sessionKind(child) === 'dsh').map((child) => dshBridge.stop(child)));
    for (const child of taskSessions(task)) {
      if (sessionKind(child) === 'pi') killPi(child.sessionFile);
    }
    activeSessionIds.delete(task.id);
    for (const child of taskSessions(task)) {
      if (child.status !== 'archived') {
        child.status = 'archived';
        child.archivedAt = nowIso();
        child.restorableWithTask = true;
        child.updatedAt = child.archivedAt;
      }
    }
    const archivedAt = nowIso();
    const validStatuses = ['unfinished', 'done'];
    const archivedFromStatus = validStatuses.includes(task.status) ? task.status : (validStatuses.includes(task.archivedFromStatus) ? task.archivedFromStatus : 'unfinished');
    res.json({ task: publicTask(updateTask(task.id, { status: 'archived', archivedFromStatus, archivedAt, sessions: taskSessions(task) })) });
  });
  app.post('/api/tasks/:id/restore', (req, res) => {
    const task = getTask(req.params.id);
    if (!task) return res.status(404).json({ error: '任务不存在' });
    if (task.status !== 'archived') return res.status(409).json({ error: '只有废弃任务可以恢复' });
    const validStatuses = ['unfinished', 'done'];
    const restoredStatus = validStatuses.includes(task.archivedFromStatus) ? task.archivedFromStatus : 'unfinished';
    for (const child of taskSessions(task)) {
      if (child.status === 'archived' && child.restorableWithTask) {
        child.status = 'active';
        child.archivedAt = null;
        child.restorableWithTask = false;
        child.updatedAt = nowIso();
      }
    }
    res.json({ task: publicTask(updateTask(task.id, { status: restoredStatus, archivedFromStatus: null, archivedAt: null, sessions: taskSessions(task) })) });
  });
  app.delete('/api/tasks/:id/permanent', async (req, res) => {
    const task = getTask(req.params.id);
    if (!task) return res.status(404).json({ error: '任务不存在' });
    await stopTaskTui(task.id, { silent: true });
    await removeTaskFiles(task);
    activeSessionIds.delete(task.id);
    deleteTask(task.id);
    res.json({ ok: true });
  });
  app.post('/api/tasks/:id/complete', async (req, res) => {
    const task = getTask(req.params.id);
    if (!task) return res.status(404).json({ error: '任务不存在' });
    if (task.status !== 'unfinished') return res.status(409).json({ error: '当前状态不能标记完成' });
    stopTaskTui(task.id, { silent: true });
    const result = publicTask(updateTask(task.id, { status: 'done', completedAt: nowIso() }));
    res.json({ task: result });
    // 不阻塞完成接口；进程清理由后台任务完成。
    setImmediate(() => {
      for (const child of taskSessions(getTask(task.id) || task)) {
        if (sessionKind(child) === 'pi') killPi(child.sessionFile);
        else void dshBridge.stop(child);
      }
    });
  });
  app.post('/api/tasks/:id/reopen', (req, res) => {
    const task = getTask(req.params.id);
    if (!task) return res.status(404).json({ error: '任务不存在' });
    if (task.status !== 'done') return res.status(409).json({ error: '只有已完成任务可以重开' });
    res.json({ task: publicTask(updateTask(task.id, { status: 'unfinished', completedAt: null })) });
  });

  // 子会话仅保存 pi JSONL / dsh 会话的入口信息；交互分别在原生 TUI/聊天视图与 dsh 原生聊天完成。
  /** pi 消息 → 聊天视图展示块（text/thinking/toolCall/toolResult）。 */
  function piMessageBlocks(message) {
    const content = Array.isArray(message.content)
      ? message.content
      : typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : [];
    if (message.role === 'toolResult') {
      return [{
        kind: 'toolResult', toolCallId: message.toolCallId || null, toolName: message.toolName || '',
        isError: Boolean(message.isError), text: extractText(content),
      }];
    }
    const blocks = [];
    for (const block of content) {
      if (block?.type === 'text' && block.text) blocks.push({ kind: 'text', text: block.text });
      else if (block?.type === 'thinking' && block.thinking) blocks.push({ kind: 'thinking', text: block.thinking });
      else if (block?.type === 'toolCall') blocks.push({ kind: 'toolCall', id: block.id, name: block.name, args: block.arguments ?? null });
    }
    if (!blocks.length && typeof message.content === 'string' && message.content) blocks.push({ kind: 'text', text: message.content });
    return blocks;
  }
  app.get('/api/tasks/:id/sessions/:sessionId/messages', (req, res) => {
    const task = getTask(req.params.id);
    if (!task) return res.status(404).json({ error: '任务不存在' });
    const session = taskSessions(task).find((item) => item.id === req.params.sessionId);
    if (!session) return res.status(404).json({ error: '子会话不存在' });
    if (sessionKind(session) !== 'dsh') {
      // pi 聊天模式的历史消息：直接读 session JSONL（TUI/聊天共用同一份记录）
      const parsed = parseSessionFile(session.sessionFile);
      const messages = [];
      for (const entry of parsed.entries) {
        if (entry.type !== 'message' || !entry.message) continue;
        const message = entry.message;
        messages.push({
          id: entry.id || null,
          role: message.role,
          stopReason: message.stopReason || null,
          errorMessage: message.errorMessage || null,
          timestamp: message.timestamp ?? null,
          usage: message.usage ? {
            input: message.usage.input || 0, output: message.usage.output || 0,
            cacheRead: message.usage.cacheRead || 0, cacheWrite: message.usage.cacheWrite || 0,
          } : null,
          blocks: piMessageBlocks(message),
        });
      }
      const record = isPiChatRunning(task.id, session.id) ? getPiChat(task.id, session.id) : null;
      return res.json({
        messages,
        running: sessionRunning(task, session),
        chat: record ? { model: record.state.model, thinkingLevel: record.state.thinkingLevel, isStreaming: record.state.isStreaming } : null,
      });
    }
    const parsed = dshBridge.readSession(session);
    const messages = parsed.entries
      .filter((entry) => entry.type === 'message')
      .map((entry) => ({
        id: entry.id,
        role: entry.message.role,
        source: entry.message.source || entry.message.role,
        text: typeof entry.message.content === 'string' ? entry.message.content : '',
        timestamp: entry.message.timestamp,
        interrupted: Boolean(entry.message.interrupted),
        usage: entry.message.usage || null,
      }));
    res.json({ messages, running: dshBridge.isRunning(session) });
  });
  // dsh 会话的用户输入。
  app.post('/api/tasks/:id/sessions/:sessionId/messages', async (req, res) => {
    const task = getTask(req.params.id);
    if (!task) return res.status(404).json({ error: '任务不存在' });
    if (task.status === 'archived') return res.status(409).json({ error: '废弃任务不能发送消息' });
    const session = taskSessions(task).find((item) => item.id === req.params.sessionId);
    if (!session) return res.status(404).json({ error: '子会话不存在' });
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: '消息内容不能为空' });
    if (text.length > 64 * 1024) return res.status(400).json({ error: '消息内容过长' });
    if (sessionKind(session) !== 'dsh') {
      // pi 聊天模式发送：TUI 与聊天进程互斥，先停掉该会话可能存活的 TUI 再拉起聊天
      if (isWebTuiRunning(task.id, session.id)) await stopWebTuiAndWait(task.id, { silent: true, sessionId: session.id });
      if (!isPiChatRunning(task.id, session.id) && concurrencyFull(1)) return res.status(409).json({ error: `已达到并发上限：${config.maxConcurrent}` });
      try {
        await withTuiLock(task.id, () => openTaskChat(getTask(task.id), session));
      } catch (error) {
        return res.status(500).json({ error: `启动聊天会话失败：${error?.message || error}` });
      }
      sendPiChatPrompt(task.id, session.id, text);
      activeSessionIds.set(task.id, session.id);
      notifyTaskChanged(task.id, 'session');
      return res.json({ ok: true, session: publicSession(session), task: publicTask(getTask(task.id)) });
    }
    try {
      await dshBridge.sendPrompt(session, text, { task });
    } catch (error) {
      return res.status(500).json({ error: `发送失败：${error?.message || error}` });
    }
    activeSessionIds.set(task.id, session.id);
    res.json({ ok: true, session: publicSession(session) });
  });
  app.get('/api/tasks/:id/sessions', (req, res) => {
    const task = getTask(req.params.id);
    if (!task) return res.status(404).json({ error: '任务不存在' });
    const sessions = activeTaskSessions(task);
    res.json({ sessions: sessions.map(publicSession), activeSessionId: activeSessionIds.get(task.id) || sessions[0]?.id || null });
  });
  // pi 子会话落账（通用创建与草稿端点共用）：建记录 + 会话文件，锚定任务 sessionFile。
  // modelSelection 解析失败抛错，由调用方映射为 400。
  async function createPiSessionRecord(task, body = {}) {
    const session = { id: randomUUID(), kind: 'pi', title: String(body?.title || '新会话').trim().slice(0, 80) || '新会话', status: 'active', archivedAt: null, favorite: false, restorableWithTask: false, createdAt: nowIso(), updatedAt: nowIso() };
    session.sessionFile = path.join(paths.SESSIONS_DIR, `${task.id}-${randomUUID()}.jsonl`);
    // 新建会话可直接指定界面形态（chat = 聊天窗口），新建会话首屏对 pi 任务用
    if (body?.ui === 'chat') session.ui = 'chat';
    if (body?.modelSelection !== undefined) {
      session.modelSelection = await resolvePiDraftModel(body.modelSelection, task.workingDir);
    }
    const sessions = taskSessions(task);
    sessions.push(session);
    const patch = { sessions };
    // 任务级 sessionFile（兼容字段）锚定到首个真实 pi 会话
    if (!task.sessionFile) patch.sessionFile = session.sessionFile;
    updateTask(task.id, patch);
    return session;
  }
  app.post('/api/tasks/:id/sessions', async (req, res) => {
    const task = getTask(req.params.id);
    if (!task) return res.status(404).json({ error: '任务不存在' });
    // 回收站中的任务也允许从“打开会话”入口创建新的临时子会话；
    // 新会话不参与任务恢复，任务仍保持废弃状态。
    const kind = req.body?.kind === 'dsh' ? 'dsh' : 'pi';
    if (kind === 'dsh') {
      if (!dshBridge.available) return res.status(501).json({ error: 'dsh 会话暂未接入' });
      try {
        const dshSessionId = await dshBridge.createSession({ task, workingDir: task.workingDir });
        const session = { id: randomUUID(), kind, title: String(req.body?.title || '新会话').trim().slice(0, 80) || '新会话', status: 'active', archivedAt: null, favorite: false, restorableWithTask: false, createdAt: nowIso(), updatedAt: nowIso(), dshSessionId };
        const sessions = taskSessions(task);
        sessions.push(session);
        updateTask(task.id, { sessions });
        return res.json({ session: publicSession(session), task: publicTask(getTask(task.id)) });
      } catch (error) {
        return res.status(500).json({ error: `创建 dsh 会话失败：${error?.message || error}` });
      }
    }
    try {
      const session = await createPiSessionRecord(task, req.body);
      res.json({ session: publicSession(session), task: publicTask(getTask(task.id)) });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
  // 草稿会话：pi 与通用创建同语义（首条消息发送时才调，支持 ui/modelSelection）；
  // dsh 只创建真实会话与工作区关联，不落任务记录，首条消息发出后由
  // /sessions/attach 落账（侧栏/看板新建按钮连点不会堆积空会话）。
  app.post('/api/tasks/:id/sessions/draft', async (req, res) => {
    const task = getTask(req.params.id);
    if (!task) return res.status(404).json({ error: '任务不存在' });
    try {
      if (req.body?.kind === 'pi') {
        const session = await createPiSessionRecord(task, req.body);
        return res.json({ session: publicSession(session), task: publicTask(getTask(task.id)) });
      }
      if (!dshBridge.available) return res.status(501).json({ error: 'dsh 会话暂未接入' });
      const dshSessionId = await dshBridge.draftSession({ task });
      res.json({ dshSessionId });
    } catch (error) {
      res.status(400).json({ error: `创建会话失败：${error?.message || error}` });
    }
  });
  // 把 dsh 原生新建会话窗口里创建的会话挂到任务名下（新建会话窗口选任务）。
  app.post('/api/tasks/:id/sessions/attach', async (req, res) => {
    const task = getTask(req.params.id);
    if (!task) return res.status(404).json({ error: '任务不存在' });
    const dshSessionId = String(req.body?.dshSessionId || '').trim();
    if (!dshSessionId) return res.status(400).json({ error: '缺少 dsh 会话 id' });
    // 该 dsh 会话已属于某个任务时不重复挂载，返回既有归属
    for (const existing of listTasks()) {
      const hit = taskSessions(existing).find((child) => child.kind === 'dsh' && child.dshSessionId === dshSessionId);
      if (hit) return res.json({ session: publicSession(hit), task: publicTask(existing), duplicated: true });
    }
    const session = { id: randomUUID(), kind: 'dsh', dshSessionId, title: String(req.body?.title || '').trim().slice(0, 80) || '新会话', status: 'active', archivedAt: null, favorite: false, restorableWithTask: false, createdAt: nowIso(), updatedAt: nowIso() };
    const sessions = taskSessions(task);
    sessions.push(session);
    updateTask(task.id, { sessions });
    dshBridge.adopt(dshSessionId, task);
    activeSessionIds.set(task.id, session.id);
    notifyTaskChanged(task.id, 'session');
    res.json({ session: publicSession(session), task: publicTask(getTask(task.id)) });
  });
  app.patch('/api/tasks/:id/sessions/:sessionId', async (req, res) => {
    const task = getTask(req.params.id);
    if (!task) return res.status(404).json({ error: '任务不存在' });
    const session = taskSessions(task).find((item) => item.id === req.params.sessionId);
    if (!session) return res.status(404).json({ error: '子会话不存在' });
    if (session.status === 'archived') return res.status(409).json({ error: '废弃会话不能编辑' });
    if (Object.hasOwn(req.body || {}, 'favorite')) session.favorite = Boolean(req.body.favorite);
    if (Object.hasOwn(req.body || {}, 'ui')) {
      // pi 会话的界面形态（tui=原生终端 / chat=聊天窗口），仅记录偏好；互斥停止在打开时进行
      if (sessionKind(session) === 'dsh') return res.status(400).json({ error: 'dsh 会话不支持切换界面' });
      if (!['tui', 'chat'].includes(req.body.ui)) return res.status(400).json({ error: '会话界面无效' });
      session.ui = req.body.ui;
    }
    if (Object.hasOwn(req.body || {}, 'title')) {
      const title = String(req.body?.title || '').trim();
      if (!title) return res.status(400).json({ error: '会话名称不能为空' });
      if (sessionKind(session) === 'dsh') {
        try { await dshBridge.rename(session.dshSessionId, title.slice(0, 80)); }
        catch (error) { return res.status(500).json({ error: error.message || String(error) }); }
      }
      session.title = title.slice(0, 80);
    }
    session.updatedAt = nowIso();
    updateTask(task.id, { sessions: taskSessions(task) });
    res.json({ session: publicSession(session), task: publicTask(getTask(task.id)) });
  });
  app.delete('/api/tasks/:id/sessions/:sessionId', async (req, res) => {
    const task = getTask(req.params.id);
    if (!task) return res.status(404).json({ error: '任务不存在' });
    const sessions = taskSessions(task);
    const removed = sessions.find((item) => item.id === req.params.sessionId);
    if (!removed) return res.status(404).json({ error: '子会话不存在' });
    if (removed.status === 'archived') return res.status(409).json({ error: '会话已在回收站中' });
    if (sessionRunning(task, removed)) await stopTaskSession(task, removed, { silent: true, sessionId: removed.id });
    const emptySession = (readSession(removed).stats?.messages || 0) === 0;
    if (emptySession) {
      sessions.splice(sessions.indexOf(removed), 1);
      if (sessionKind(removed) === 'pi') {
        try { if (removed.sessionFile && existsSync(removed.sessionFile)) unlinkSync(removed.sessionFile); } catch { /* ignore */ }
      } else {
        dshBridge.forget(removed);
      }
      const active = activeTaskSessions(task);
      if (!active.length) activeSessionIds.delete(task.id);
      else if (activeSessionIds.get(task.id) === removed.id) activeSessionIds.set(task.id, active[0].id);
      updateTask(task.id, { sessions, sessionFile: active.find((session) => session.sessionFile === task.sessionFile)?.sessionFile || active[0]?.sessionFile || null });
      return res.json({ ok: true, permanentlyDeleted: true, task: publicTask(getTask(task.id)) });
    }
    removed.status = 'archived';
    removed.archivedAt = nowIso();
    removed.restorableWithTask = false;
    removed.updatedAt = nowIso();
    const active = activeTaskSessions(task);
    const patch = { sessions, sessionFile: active.find((session) => session.sessionFile === task.sessionFile)?.sessionFile || active[0]?.sessionFile || null };
    if (!active.length) activeSessionIds.delete(task.id);
    else if (activeSessionIds.get(task.id) === removed.id) activeSessionIds.set(task.id, active[0].id);
    updateTask(task.id, patch);
    res.json({ ok: true, task: publicTask(getTask(task.id)) });
  });
  app.post('/api/tasks/:id/sessions/:sessionId/restore', (req, res) => {
    const task = getTask(req.params.id);
    if (!task) return res.status(404).json({ error: '任务不存在' });
    const session = taskSessions(task).find((item) => item.id === req.params.sessionId);
    if (!session) return res.status(404).json({ error: '子会话不存在' });
    if (session.status !== 'archived') return res.status(409).json({ error: '会话不在回收站中' });
    if (task.status === 'archived') return res.status(409).json({ error: '请先恢复所属任务' });
    session.status = 'active';
    session.archivedAt = null;
    session.restorableWithTask = false;
    session.updatedAt = nowIso();
    const sessions = taskSessions(task);
    updateTask(task.id, { sessions, sessionFile: task.sessionFile || session.sessionFile || null });
    res.json({ session: publicSession(session), task: publicTask(getTask(task.id)) });
  });
  app.delete('/api/tasks/:id/sessions/:sessionId/permanent', async (req, res) => {
    const task = getTask(req.params.id);
    if (!task) return res.status(404).json({ error: '任务不存在' });
    const sessions = taskSessions(task);
    const index = sessions.findIndex((item) => item.id === req.params.sessionId);
    if (index < 0) return res.status(404).json({ error: '子会话不存在' });
    const session = sessions[index];
    if (session.status !== 'archived') return res.status(409).json({ error: '只有回收站中的会话可以永久删除' });
    sessions.splice(index, 1);
    await stopTaskSession(task, session, { silent: true, sessionId: session.id });
    if (sessionKind(session) === 'pi') {
      try { if (session.sessionFile && existsSync(session.sessionFile)) unlinkSync(session.sessionFile); } catch { /* ignore */ }
    } else {
      dshBridge.forget(session);
    }
    const active = activeTaskSessions(task);
    if (!active.some((item) => item.id === activeSessionIds.get(task.id))) activeSessionIds.set(task.id, active[0]?.id);
    updateTask(task.id, { sessions, sessionFile: active.find((item) => item.sessionFile === task.sessionFile)?.sessionFile || active[0]?.sessionFile || null });
    res.json({ ok: true, task: publicTask(getTask(task.id)) });
  });
  // 分叉 pi 会话：截取 JSONL 至目标条目（含）生成新会话文件并挂到任务名下
  app.post('/api/tasks/:id/sessions/:sessionId/branch', (req, res) => {
    const task = getTask(req.params.id);
    if (!task) return res.status(404).json({ error: '任务不存在' });
    const session = taskSessions(task).find((item) => item.id === req.params.sessionId);
    if (!session) return res.status(404).json({ error: '子会话不存在' });
    if (sessionKind(session) !== 'pi' || !session.sessionFile) return res.status(400).json({ error: '只有 pi 会话支持分叉' });
    const entryId = String(req.body?.entryId || '').trim();
    if (!entryId) return res.status(400).json({ error: '缺少分叉目标条目' });
    let lines;
    try {
      lines = readFileSync(session.sessionFile, 'utf8').split('\n').filter((line) => line.trim());
    } catch {
      return res.status(500).json({ error: '会话文件不可读' });
    }
    const index = lines.findIndex((line) => {
      try { return JSON.parse(line).id === entryId; } catch { return false; }
    });
    if (index < 0) return res.status(404).json({ error: '分叉目标条目不存在' });
    const newFile = path.join(paths.SESSIONS_DIR, `${task.id}-${randomUUID()}.jsonl`);
    writeFileSync(newFile, lines.slice(0, index + 1).join('\n') + '\n');
    const newSession = { id: randomUUID(), kind: 'pi', ui: 'chat', title: `${session.title || '新会话'}（分支）`, status: 'active', archivedAt: null, favorite: false, restorableWithTask: false, createdAt: nowIso(), updatedAt: nowIso(), sessionFile: newFile };
    const sessions = taskSessions(task);
    sessions.push(newSession);
    updateTask(task.id, { sessions, ...(task.sessionFile ? {} : { sessionFile: newFile }) });
    notifyTaskChanged(task.id, 'session');
    res.json({ session: publicSession(newSession), task: publicTask(getTask(task.id)) });
  });
  app.post('/api/tasks/:id/tui/restart', async (req, res) => {
    const task = getTask(req.params.id);
    if (!task) return res.status(404).json({ error: '任务不存在' });
    const requestedSessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : null;
    const stopped = await stopWebTuiForRestart(task.id, { sessionId: requestedSessionId || activeSessionIds.get(task.id) || null });
    res.json({ stopped });
  });
  app.post('/api/tasks/:id/sessions/:sessionId/stop', async (req, res) => {
    const task = getTask(req.params.id);
    if (!task) return res.status(404).json({ error: '任务不存在' });
    const session = taskSessions(task).find((item) => item.id === req.params.sessionId);
    if (!session) return res.status(404).json({ error: '子会话不存在' });
    const stopped = await stopTaskSession(task, session, { silent: true, sessionId: session.id });
    if (stopped) notifyTaskChanged(task.id, 'session');
    res.json({ stopped, task: publicTask(getTask(task.id)) });
  });
  app.post('/api/tasks/:id/terminate', async (req, res) => {
    const task = getTask(req.params.id);
    if (!task) return res.status(404).json({ error: '任务不存在' });
    const runningPi = isWebTuiRunning(task.id);
    const runningDsh = taskSessions(task).some((child) => sessionKind(child) === 'dsh' && dshBridge.isRunning(child));
    if (!runningPi && !runningDsh) return res.status(409).json({ error: '任务不在执行中' });
    const stopped = await stopTaskTui(task.id, { silent: true });
    for (const child of taskSessions(task)) {
      if (sessionKind(child) === 'pi') killPi(child.sessionFile);
      else await dshBridge.stop(child);
    }
    res.json({ task: publicTask(getTask(task.id)) });
  });

  const webSockets = new WebSocketServer({ noServer: true });
  webSockets.on('connection', (ws) => {
    const clientId = randomUUID();
    let taskId = null;
    let sessionId = null;
    let unsubscribe = null;
    const send = (message) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(message));
    };
    const bindTui = async (id, requestedSessionId, cols, rows, theme) => {
      const task = getTask(id);
      if (!task) return send({ type: 'tui_error', error: '任务不存在' });
      const childSession = resolveTaskSession(task, requestedSessionId);
      if (!childSession) return send({ type: 'tui_error', error: '子会话不存在' });
      if (sessionKind(childSession) === 'dsh') return send({ type: 'tui_error', error: 'dsh 会话请使用聊天界面' });
      if (!isWebTuiRunning(task.id) && concurrencyFull(1)) return send({ type: 'tui_error', error: `已达到并发上限：${config.maxConcurrent}` });
      try {
        // TUI 与聊天进程互斥：同一 session 文件只允许一个 pi 进程写入
        await withTuiLock(id, async () => {
          if (isPiChatRunning(id, childSession.id)) await stopAllPiChatsForTask(id, { sessionId: childSession.id });
          return openTaskTui(getTask(id), childSession, cols, rows, theme);
        });
        if (taskId && (taskId !== id || sessionId !== childSession.id)) releaseWebTuiInput(taskId, sessionId, clientId);
        taskId = id;
        sessionId = childSession.id;
        unsubscribe?.();
        unsubscribe = subscribeWebTui(id, sessionId, send);
        claimWebTuiInput(id, sessionId, clientId);
        resizeWebTui(id, sessionId, cols, rows);
        send({ type: 'tui_ready', taskId: id, childSessionId: childSession.id });
      } catch (error) {
        const detail = error?.message || String(error);
        console.error(`[workbench] 打开原生 TUI 失败（${id}/${childSession.id}）：${detail}`);
        send({ type: 'tui_error', error: `打开原生 TUI 失败：${detail}` });
      }
    };
    const bindChat = async (id, requestedSessionId) => {
      const task = getTask(id);
      if (!task) return send({ type: 'chat_error', error: '任务不存在' });
      const childSession = resolveTaskSession(task, requestedSessionId);
      if (!childSession) return send({ type: 'chat_error', error: '子会话不存在' });
      if (sessionKind(childSession) === 'dsh') return send({ type: 'chat_error', error: 'dsh 会话请使用原生聊天界面' });
      try {
        // TUI 与聊天进程互斥：同一 session 文件只允许一个 pi 进程写入
        if (!isPiChatRunning(id, childSession.id) && concurrencyFull(1)) return send({ type: 'chat_error', error: `已达到并发上限：${config.maxConcurrent}` });
        await withTuiLock(id, async () => {
          if (isWebTuiRunning(id, childSession.id)) await stopWebTuiAndWait(id, { silent: true, sessionId: childSession.id });
          return openTaskChat(getTask(id), childSession);
        });
        if (taskId && (taskId !== id || sessionId !== childSession.id)) releaseWebTuiInput(taskId, sessionId, clientId);
        taskId = id;
        sessionId = childSession.id;
        unsubscribe?.();
        const buffered = [];
        let snapshotReady = false;
        unsubscribe = subscribePiChat(id, childSession.id, frame => {
          if (snapshotReady) send(frame); else buffered.push(frame);
        });
        const snapshot = await piChatSnapshot(id, childSession.id);
        send(snapshot);
        for (const frame of buffered) if (frame.sequence > snapshot.sequence) send(frame);
        snapshotReady = true;
        claimWebTuiInput(id, childSession.id, clientId);
        const state = await requestPiChatState(id, childSession.id);
        send({ type: 'chat_ready', taskId: id, childSessionId: childSession.id, state });
      } catch (error) {
        const detail = error?.message || String(error);
        console.error(`[workbench] 打开聊天会话失败（${id}/${childSession.id}）：${detail}`);
        send({ type: 'chat_error', error: `打开聊天会话失败：${detail}` });
      }
    };
    ws.on('message', async (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
        if (message.type === 'tui_hello') return await bindTui(message.taskId, message.sessionId, message.cols, message.rows, message.theme);
        if (message.type === 'chat_hello') return await bindChat(message.taskId, message.sessionId);
        if (message.type === 'chat_prompt') {
          if (!taskId || !sessionId || !isPiChatRunning(taskId, sessionId)) throw new Error('聊天进程未运行，请重新打开会话');
          const text = String(message.text || '').trim();
          if (!text && !message.images?.length) throw new Error('消息内容不能为空');
          if (text.length > 64 * 1024) throw new Error('消息内容过长');
          const response = await sendPiChatPrompt(taskId, sessionId, text, { mode: message.mode, images: message.images });
          send({ type: 'chat_prompt_result', requestId: message.requestId, success: response.success, error: response.error });
          const state = await requestPiChatState(taskId, sessionId);
          if (state) send({ type: 'chat_state', state });
          activeSessionIds.set(taskId, sessionId);
          return;
        }
        if (message.type === 'chat_abort') {
          if (taskId && sessionId) abortPiChat(taskId, sessionId);
          return;
        }
        if (message.type === 'chat_snapshot') {
          // 前端回合收尾后拉取快照：刷新每条消息的 entryId（分叉锚点）
          if (!taskId || !sessionId || !isPiChatRunning(taskId, sessionId)) return;
          piChatSnapshot(taskId, sessionId).then((snap) => send(snap)).catch(() => {});
          return;
        }
        if (message.type === 'chat_command') {
          if (!taskId || !sessionId) return;
          const allowed = ['get_commands', 'get_available_thinking_levels', 'get_session_stats', 'compact', 'clear_queue'];
          if (!allowed.includes(message.command)) return send({ type: 'chat_error', error: '不支持的会话操作' });
          const response = await piChatCommand(taskId, sessionId, { type: message.command });
          send({ ...response, type: 'chat_command_result', command: message.command });
          const state = await requestPiChatState(taskId, sessionId);
          if (state) send({ type: 'chat_state', state });
          if (message.command === 'compact' && response.success) send(await piChatSnapshot(taskId, sessionId));
          return;
        }
        if (message.type === 'chat_state') {
          if (!taskId || !sessionId) return;
          const state = await requestPiChatState(taskId, sessionId);
          if (state) send({ type: 'chat_state', state });
          return;
        }
        if (message.type === 'chat_models') {
          if (!taskId || !sessionId) return;
          const response = await piChatCommand(taskId, sessionId, { type: 'get_available_models' });
          send({ type: 'chat_models', models: response.success ? response.data?.models || [] : [], error: response.success ? null : response.error });
          return;
        }
        if (message.type === 'chat_select_model') {
          if (!taskId || !sessionId) return;
          const selection = message.selection;
          if (!selection || typeof selection.provider !== 'string' || typeof selection.model !== 'string') {
            send({ type: 'chat_selection_result', requestId: message.requestId, success: false, error: '模型参数无效' }); return;
          }
          let response = await piChatCommand(taskId, sessionId, { type: 'set_model', provider: selection.provider, modelId: selection.model });
          if (response.success && selection.reasoningEffort !== undefined) {
            response = await piChatCommand(taskId, sessionId, { type: 'set_thinking_level', level: selection.reasoningEffort });
          }
          const state = await requestPiChatState(taskId, sessionId);
          if (state) send({ type: 'chat_state', state });
          if (state?.model) {
            const task = getTask(taskId);
            const session = task && taskSessions(task).find(item => item.id === sessionId);
            if (session) { session.modelSelection = { provider: state.model.provider, model: state.model.id, reasoningEffort: state.thinkingLevel }; updateTask(task.id, { sessions: taskSessions(task) }); }
          }
          send({ type: 'chat_selection_result', requestId: message.requestId, success: response.success, error: response.error });
          return;
        }
        if (message.type === 'chat_set_model') {
          if (!taskId || !sessionId) return;
          const provider = String(message.provider || '').trim();
          const modelId = String(message.modelId || '').trim();
          if (!provider || !modelId) return send({ type: 'chat_error', error: '模型参数不完整' });
          const response = await piChatCommand(taskId, sessionId, { type: 'set_model', provider, modelId });
          if (!response.success) return send({ type: 'chat_error', error: `切换模型失败：${response.error || '未知错误'}` });
          const state = await requestPiChatState(taskId, sessionId);
          if (state) send({ type: 'chat_state', state });
          return;
        }
        if (message.type === 'chat_set_thinking') {
          if (!taskId || !sessionId) return;
          const level = String(message.level || '').trim();
          if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(level)) return send({ type: 'chat_error', error: '思考等级无效' });
          const response = await piChatCommand(taskId, sessionId, { type: 'set_thinking_level', level });
          if (!response.success) return send({ type: 'chat_error', error: `设置思考等级失败：${response.error || '未知错误'}` });
          const state = await requestPiChatState(taskId, sessionId);
          if (state) send({ type: 'chat_state', state });
          return;
        }
        if (message.type === 'chat_ui_response') {
          if (taskId && sessionId) respondPiChatUi(taskId, sessionId, message);
          return;
        }
        // xterm can emit a final input or resize frame while an old PTY is
        // exiting. It is harmless and should not produce a user-facing toast.
        if (message.type === 'tui_input' || message.type === 'tui_resize') {
          if (!taskId || !sessionId || !isWebTuiRunning(taskId, sessionId)) return;
          if (message.type === 'tui_input') {
            return writeWebTui(taskId, sessionId, clientId, message.data);
          }
          return resizeWebTui(taskId, sessionId, message.cols, message.rows);
        }
      } catch (error) {
        const detail = error?.message || String(error);
        console.error(`[workbench] 原生 TUI WebSocket 错误：${detail}`);
        send(message?.type === 'chat_prompt'
          ? { type: 'chat_prompt_result', requestId: message.requestId, success: false, error: detail }
          : { type: message?.type?.startsWith('chat_') ? 'chat_error' : 'tui_error', error: detail });
      }
    });
    ws.on('close', () => {
      unsubscribe?.();
      if (taskId && sessionId) releaseWebTuiInput(taskId, sessionId, clientId);
    });
  });

  function selectWindowsDirectory(res) {
    const script = [
      '$ErrorActionPreference = "Stop"', '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
      'Add-Type -AssemblyName System.Windows.Forms', '[System.Windows.Forms.Application]::EnableVisualStyles()',
      // Use the window that was active when the request was made as the dialog owner.
      // Without an owner, Windows may put the modal dialog behind the browser.
      `Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.Windows.Forms;
using System.Runtime.InteropServices;
public sealed class WorkbenchDialogOwner : IWin32Window {
  private readonly IntPtr handle;
  public WorkbenchDialogOwner(IntPtr handle) { this.handle = handle; }
  public IntPtr Handle { get { return handle; } }
}
public static class WorkbenchWindowApi {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@`,
      '$ownerHandle = [WorkbenchWindowApi]::GetForegroundWindow()',
      '$owner = if ($ownerHandle -ne [IntPtr]::Zero) { New-Object -TypeName WorkbenchDialogOwner -ArgumentList $ownerHandle } else { $null }',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog', '$dialog.Description = "选择工作目录"',
      '$dialog.ShowNewFolderButton = $true', '$result = if ($owner) { $dialog.ShowDialog($owner) } else { $dialog.ShowDialog() }',
      'if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.SelectedPath) }',
    ].join('\n');
    const args = ['-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script];
    const commands = ['powershell.exe', 'pwsh.exe'];
    let index = 0;
    const run = () => execFile(commands[index], args, { timeout: 120000, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error?.code === 'ENOENT' && index < commands.length - 1) { index += 1; return run(); }
      if (error) return res.status(500).json({ error: `打开 Windows 目录选择器失败：${error.message}` });
      const selected = String(stdout || '').replace(/^\uFEFF/, '').trim();
      if (!selected) return res.json({ cancelled: true });
      res.json({ path: selected });
    });
    run();
  }
  app.post('/api/select-directory', (_req, res) => {
    const platform = process.platform;
    if (platform === 'win32') return selectWindowsDirectory(res);
    const command = platform === 'darwin' ? 'osascript' : platform === 'linux' ? 'zenity' : null;
    const args = platform === 'darwin' ? ['-e', 'POSIX path of (choose folder with prompt "选择工作目录")'] : platform === 'linux' ? ['--file-selection', '--directory', '--title=选择工作目录'] : [];
    if (!command) return res.status(501).json({ error: '当前系统暂不支持原生目录选择，请直接输入路径' });
    execFile(command, args, { timeout: 120000, encoding: 'utf8' }, (error, stdout) => {
      if (error) {
        if (error.code === 1) return res.json({ cancelled: true });
        return res.status(500).json({ error: `打开目录选择器失败：${error.message}` });
      }
      const selected = String(stdout || '').trim();
      if (!selected) return res.json({ cancelled: true });
      res.json({ path: selected });
    });
  });
  // dsh 可路由模型目录（新建任务"更多设置"的模型下拉数据源）
  // Preview uses the same scheduler calculation and host timezone as execution.
  app.post('/api/schedule-preview', (req, res) => {
    const schedule = normalizeSchedule(req.body?.schedule);
    if (!schedule) return res.status(400).json({ error: '请补全有效的定时设置' });
    const next = nextRunFromSchedule(schedule);
    if (next == null) return res.status(400).json({ error: '没有可执行的未来时间，请调整日期或关闭定时运行' });
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return res.json({ nextRun: new Date(next).toISOString(), timeZone,
      nextRunLabel: new Intl.DateTimeFormat('zh-CN', { timeZone, dateStyle: 'full', timeStyle: 'short' }).format(next) });
  });
  app.get('/api/pi/models', async (req, res) => {
    try {
      const task = req.query.taskId ? getTask(String(req.query.taskId)) : null;
      res.json(await piModelCatalog(task?.workingDir || process.cwd()));
    } catch (error) { res.status(500).json({ error: error.message }); }
  });
  app.get('/api/models', async (_req, res) => {
    try {
      res.json(await dshBridge.modelCatalog());
    } catch {
      res.json({ default: null, groups: [] });
    }
  });
  app.get('/api/config', (_req, res) => res.json({ ...config, defaultNoteIds: listDefaultNoteIds(), sessionsDir: paths.SESSIONS_DIR, dshAvailable: dshBridge.available }));
  app.post('/api/config', (req, res) => {
    for (const key of ['maxConcurrent', 'approvePi']) if (key in (req.body || {})) config[key] = req.body[key];
    saveConfig();
    res.json(config);
  });

  // JSON 解析失败等异常统一返回 JSON，避免落入 express 默认 HTML 错误页。
  // eslint-disable-next-line no-unused-vars
  app.use((error, _req, res, _next) => {
    const status = error?.type === 'entity.parse.failed' ? 400 : 500;
    if (status === 500) console.error(`[workbench] 请求处理失败：${error?.stack || error}`);
    if (!res.headersSent) res.status(status).json({ error: status === 400 ? '请求体不是有效 JSON' : '服务器内部错误' });
  });

  /** webServer prefix handler：剥掉 /workbench 前缀后交给 express 应用 */
  function handleRequest(req, res) {
    const url = req.url || '/';
    req.url = url.startsWith(PREFIX) ? url.slice(PREFIX.length) || '/' : url;
    app(req, res);
  }
  /** webServer upgrade handler：/workbench/ws 的 TUI WebSocket */
  function handleUpgrade(req, socket, head) {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    if (url.pathname !== `${PREFIX}/ws`) { socket.destroy(); return; }
    webSockets.handleUpgrade(req, socket, head, (ws) => webSockets.emit('connection', ws, req));
  }

  return {
    handleRequest,
    handleUpgrade,
    dshBridge,
    /** 加载数据；在插件激活时调用一次 */
    start() {
      loadTasks();
      dshBridge.warm();
    },
    /** 释放全部运行态：SSE 客户端、TUI WebSocket、PTY 进程与 dsh 桥 */
    async close() {
      for (const timer of taskEventTimers.values()) clearTimeout(timer);
      taskEventTimers.clear();
      for (const timer of sessionEventTimers.values()) clearTimeout(timer);
      sessionEventTimers.clear();
      for (const client of webSockets.clients) {
        try { client.close(); } catch { /* already closed */ }
      }
      for (const client of taskEventClients) {
        try { client.end(); } catch { /* already closed */ }
      }
      taskEventClients.clear();
      await stopAllWebTuis();
      await stopAllPiChats();
      await dshBridge.dispose();
    },
  };
}
