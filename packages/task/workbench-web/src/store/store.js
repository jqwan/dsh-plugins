import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(LIB_DIR, '..', '..');
// 插件形态下数据目录由宿主配置注入；默认落在包根目录（与独立运行形态一致）。
export const paths = {
  ROOT,
  DATA_DIR: path.join(ROOT, 'data'),
  SESSIONS_DIR: path.join(ROOT, 'sessions'),
  SCRIPTS_DIR: path.join(ROOT, 'data', 'scripts'),
  TASKS_FILE: path.join(ROOT, 'data', 'tasks.json'),
  CONFIG_FILE: path.join(ROOT, 'data', 'config.json'),
};
export function configurePaths({ dataDir, sessionsDir } = {}) {
  if (dataDir) {
    paths.DATA_DIR = dataDir;
    paths.SCRIPTS_DIR = path.join(dataDir, 'scripts');
    paths.TASKS_FILE = path.join(dataDir, 'tasks.json');
    paths.CONFIG_FILE = path.join(dataDir, 'config.json');
  }
  if (sessionsDir) paths.SESSIONS_DIR = sessionsDir;
}

let tasks = [];
let notes = [];
let defaultNoteIds = [];
const taskListeners = new Set();
const VALID_STATUSES = new Set(['unfinished', 'done', 'archived']);
const VALID_COLORS = new Set(['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'gray']);

function validColor(color) {
  return VALID_COLORS.has(color) || /^custom-[a-z0-9-]+$/.test(String(color || ''));
}
function normalizeStatus(status) {
  if (status === 'todo' || status === 'running' || !VALID_STATUSES.has(status)) return 'unfinished';
  return status;
}
function normalizeArchivedFromStatus(status) {
  if (status === 'todo' || status === 'running') return 'unfinished';
  if (status === 'unfinished' || status === 'done') return status;
  return 'unfinished';
}

export function ensureDirs() {
  for (const dir of [paths.DATA_DIR, paths.SESSIONS_DIR, paths.SCRIPTS_DIR]) mkdirSync(dir, { recursive: true });
}

export function normalizeTasks(input, now = new Date()) {
  const normalized = Array.isArray(input) ? input : [];
  let changed = false;
  for (const task of normalized) {
    if (!Array.isArray(task.sessions)) {
      task.sessions = task.sessionFile ? [{ id: randomUUID(), title: '新会话', sessionFile: task.sessionFile, createdAt: task.createdAt, updatedAt: task.updatedAt }] : [];
      changed = true;
    }
    for (const session of task.sessions) {
      if (!session || typeof session !== 'object') continue;
      if (!session.id) { session.id = randomUUID(); changed = true; }
      // 会话类型：pi（原生 TUI，sessionFile）或 dsh（dsh harness 会话，dshSessionId）。旧数据一律视为 pi。
      const kind = session.kind === 'dsh' ? 'dsh' : 'pi';
      if (session.kind !== kind) { session.kind = kind; changed = true; }
      if (session.kind === 'dsh' && !Object.prototype.hasOwnProperty.call(session, 'dshSessionId')) { session.dshSessionId = null; changed = true; }
      if (!session.title) { session.title = '新会话'; changed = true; }
      if (!session.createdAt) { session.createdAt = task.createdAt || now.toISOString(); changed = true; }
      if (!session.updatedAt) { session.updatedAt = session.createdAt; changed = true; }
      const status = session.status === 'archived' ? 'archived' : 'active';
      const defaults = {
        status,
        archivedAt: status === 'archived' ? (session.archivedAt || now.toISOString()) : null,
        favorite: Boolean(session.favorite),
        restorableWithTask: Boolean(session.restorableWithTask),
      };
      for (const [key, value] of Object.entries(defaults)) {
        if (session[key] !== value) { session[key] = value; changed = true; }
      }
    }
    const normalizedStatus = normalizeStatus(task.status);
    if (task.status !== normalizedStatus) { task.status = normalizedStatus; changed = true; }
    if (Object.prototype.hasOwnProperty.call(task, 'archivedFromStatus')) {
      const normalizedArchivedFromStatus = task.archivedFromStatus == null ? null : normalizeArchivedFromStatus(task.archivedFromStatus);
      if (task.archivedFromStatus !== normalizedArchivedFromStatus) { task.archivedFromStatus = normalizedArchivedFromStatus; changed = true; }
    }
    if (Object.prototype.hasOwnProperty.call(task, 'lastRun')) { delete task.lastRun; changed = true; }
    if (Object.hasOwn(task, 'purgeAt')) { delete task.purgeAt; changed = true; }
    if (!Object.prototype.hasOwnProperty.call(task, 'archivedFromStatus')) { task.archivedFromStatus = null; changed = true; }
    if (Array.isArray(task.workingDirs)) {
      const workingDirs = [...new Set(task.workingDirs.map((value) => String(value || '').trim()).filter(Boolean))];
      const primaryWorkingDir = workingDirs[0] || null;
      if (JSON.stringify(task.workingDirs) !== JSON.stringify(workingDirs)) { task.workingDirs = workingDirs; changed = true; }
      if (task.workingDir !== primaryWorkingDir) { task.workingDir = primaryWorkingDir; changed = true; }
    }
    // 运行类型 / 模型设置（旧数据缺省回填）；任务级定时发布已移除，旧 schedule 字段直接清理
    if (Object.hasOwn(task, 'schedule')) { delete task.schedule; changed = true; }
    const runKind = task.runKind === 'pi' ? 'pi' : 'dsh';
    if (task.runKind !== runKind) { task.runKind = runKind; changed = true; }
    for (const key of ['model', 'modelProvider', 'thinkingLevel']) {
      const value = task[key] == null ? null : String(task[key]);
      if (task[key] !== value) { task[key] = value; changed = true; }
    }
    const noteIds = Array.isArray(task.noteIds)
      ? [...new Set(task.noteIds.map((id) => String(id).trim()).filter(Boolean))]
      : [];
    // 字段缺失时也必须写回（noteIds === [] 与 undefined 相等，不能据此跳过赋值，
    // 否则内存里的 noteIds 保持 undefined，加载期的 filter 直接抛错清空全部数据）
    if (task.noteIds === undefined || JSON.stringify(task.noteIds) !== JSON.stringify(noteIds)) { task.noteIds = noteIds; changed = true; }
    const readOnly = Boolean(task.readOnly);
    if (task.readOnly !== readOnly) { task.readOnly = readOnly; changed = true; }
  }
  return { tasks: normalized, changed };
}

/** 定时发布配置规范化：非法/未开启返回 null。custom 为指定时间单次发布。 */
export function normalizeSchedule(input) {
  if (!input || typeof input !== 'object' || input.enabled !== true) return null;
  const mode = ['daily', 'weekly', 'monthly', 'custom'].includes(input.mode) ? input.mode : null;
  if (!mode) return null;
  const schedule = { enabled: true, mode, time: '' };
  if (mode === 'custom') {
    const at = new Date(input.at || '');
    if (Number.isNaN(at.getTime())) return null;
    schedule.at = String(input.at);
    return schedule;
  }
  const time = /^\d{1,2}:\d{2}$/.test(String(input.time || '').trim()) ? String(input.time).trim() : null;
  if (!time) return null;
  const [hour, minute] = time.split(':').map(Number);
  if (hour > 23 || minute > 59) return null;
  schedule.time = time;
  if (mode === 'weekly') {
    const weekday = Number(input.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return null;
    schedule.weekday = weekday;
  }
  if (mode === 'monthly') {
    const dayOfMonth = Number(input.dayOfMonth);
    if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) return null;
    schedule.dayOfMonth = dayOfMonth;
  }
  return schedule;
}

export function normalizeNotes(input) {
  const normalized = Array.isArray(input) ? input : [];
  let changed = false;
  for (let index = normalized.length - 1; index >= 0; index--) {
    const note = normalized[index];
    if (!note || typeof note !== 'object' || !String(note.description || '').trim()) { normalized.splice(index, 1); changed = true; continue; }
    const description = String(note.description).trim();
    const title = String(note.title || '').trim();
    if (note.description !== description) { note.description = description; changed = true; }
    if (note.title !== title) { note.title = title; changed = true; }
    if (!validColor(note.color)) { note.color = 'yellow'; changed = true; }
    const isArchived = note.status === 'archived';
    const status = isArchived ? 'archived' : 'active';
    if (note.status !== status) { note.status = status; changed = true; }
    const existingArchivedAt = note.archivedAt && !Number.isNaN(new Date(note.archivedAt).getTime()) ? note.archivedAt : null;
    const archivedAt = isArchived ? (existingArchivedAt || new Date().toISOString()) : null;
    if (note.archivedAt !== archivedAt) { note.archivedAt = archivedAt; changed = true; }
    if (Object.hasOwn(note, 'purgeAt')) { delete note.purgeAt; changed = true; }
    for (const key of ['pinnedToTopBar', 'pinnedToSessionBar', 'pinnedSessions', 'topbarOrder', 'sessionOrder']) {
      if (Object.hasOwn(note, key)) { delete note[key]; changed = true; }
    }
    if (!note.id) { note.id = randomUUID(); changed = true; }
    if (!note.createdAt) { note.createdAt = new Date().toISOString(); changed = true; }
    if (!note.updatedAt) { note.updatedAt = note.createdAt; changed = true; }
    const deadline = note.deadline || null;
    if (note.deadline !== deadline) { note.deadline = deadline; changed = true; }
    // 定时发送项：形状不合法的直接剔除；任务/会话是否仍存在由执行端在触发时校验。
    // schedule 必须有效（normalizeSchedule），否则该项没有触发意义。
    const rawSends = Array.isArray(note.sends) ? note.sends : [];
    const sends = [];
    for (const send of rawSends) {
      if (!send || typeof send !== 'object' || !String(send.taskId || '').trim()) { changed = true; continue; }
      const schedule = normalizeSchedule(send.schedule);
      if (!schedule) { changed = true; continue; }
      const item = {
        id: String(send.id || '').trim() || randomUUID(),
        taskId: String(send.taskId).trim(),
        sessionId: send.sessionId ? String(send.sessionId).trim() : null,
        kind: send.kind === 'pi' ? 'pi' : 'dsh',
        schedule,
        lastFiredAt: send.lastFiredAt || null,
      };
      if (JSON.stringify(send) !== JSON.stringify(item)) changed = true;
      sends.push(item);
    }
    if (rawSends.length !== sends.length || JSON.stringify(rawSends) !== JSON.stringify(sends)) { note.sends = sends; changed = true; }
  }
  return { notes: normalized, changed };
}

export function loadTasks() {
  ensureDirs();
  if (existsSync(paths.TASKS_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(paths.TASKS_FILE, 'utf8'));
      let taskInput = [];
      if (Array.isArray(raw.tasks)) taskInput = raw.tasks;
      else if (Array.isArray(raw)) taskInput = raw;
      const taskResult = normalizeTasks(taskInput);
      const noteResult = normalizeNotes(Array.isArray(raw.notes) ? raw.notes : []);
      const noteIds = new Set(noteResult.notes.map((note) => note.id));
      const normalizedDefaults = Array.isArray(raw.defaultNoteIds)
        ? [...new Set(raw.defaultNoteIds.map((id) => String(id).trim()).filter((id) => noteIds.has(id)))]
        : [];
      tasks = taskResult.tasks;
      notes = noteResult.notes;
      for (const task of tasks) task.noteIds = (task.noteIds || []).filter((id) => noteIds.has(id));
      defaultNoteIds = normalizedDefaults;
      if (taskResult.changed || noteResult.changed || JSON.stringify(raw.defaultNoteIds || []) !== JSON.stringify(normalizedDefaults) || !Array.isArray(raw.notes)) saveTasks();
    } catch { tasks = []; notes = []; defaultNoteIds = []; }
  }
  return tasks;
}

export function saveTasks() {
  ensureDirs();
  const tmp = paths.TASKS_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify({ tasks, notes, defaultNoteIds }, null, 2));
  renameSync(tmp, paths.TASKS_FILE);
}
export function listTasks() { return tasks; }
export function listNotes() { return notes; }
export function listDefaultNoteIds() { return [...defaultNoteIds]; }
export function updateDefaultNoteIds(ids) {
  defaultNoteIds = [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id).trim()).filter(Boolean))];
  saveTasks();
  emitTaskEvent({ type: 'defaults-updated' });
  return [...defaultNoteIds];
}
export function subscribeTasks(listener) { taskListeners.add(listener); return () => taskListeners.delete(listener); }
function emitTaskEvent(event) { for (const listener of taskListeners) try { listener(event); } catch { /* observer failure must not break persistence */ } }
export function getTask(id) { return tasks.find((t) => t.id === id) || null; }
export function getNote(id) { return notes.find((note) => note.id === id) || null; }

export function createTask({ title, description, color, workingDir, workingDirs, deadline, runKind, model, modelProvider, thinkingLevel, noteIds = defaultNoteIds }) {
  const now = new Date().toISOString();
  const normalizedWorkingDirs = [...new Set((Array.isArray(workingDirs) ? workingDirs : [workingDir])
    .map((value) => String(value || '').trim()).filter(Boolean))];
  const task = {
    id: randomUUID(), title: String(title.trim()), description: String(description || '').trim(),
    status: 'unfinished', color: validColor(color) ? color : 'blue',
    workingDir: normalizedWorkingDirs[0] || null, workingDirs: normalizedWorkingDirs, deadline: deadline || null, model: model == null ? null : String(model), modelProvider: modelProvider == null ? null : String(modelProvider), thinkingLevel: thinkingLevel == null ? null : String(thinkingLevel),
    runKind: runKind === 'pi' ? 'pi' : 'dsh',
    readOnly: false, sessionFile: null, createdAt: now, updatedAt: now, completedAt: null,
    archivedFromStatus: null, noteIds: [...new Set((Array.isArray(noteIds) ? noteIds : []).map((id) => String(id).trim()).filter(Boolean))], sessions: [],
  };
  tasks.push(task);
  saveTasks();
  emitTaskEvent({ type: 'created', taskId: task.id });
  return task;
}
export function createNote({ title, description, color, deadline }) {
  const now = new Date().toISOString();
  const note = {
    id: randomUUID(), title: String(title || '').trim(), description: String(description).trim(),
    color: validColor(color) ? color : 'yellow', deadline: deadline || null, status: 'active',
    archivedAt: null, createdAt: now, updatedAt: now,
  };
  notes.push(note);
  saveTasks();
  emitTaskEvent({ type: 'note-created', noteId: note.id });
  return note;
}
export function updateTask(id, patch) {
  const task = getTask(id);
  if (!task) return null;
  Object.assign(task, patch, { updatedAt: new Date().toISOString() });
  saveTasks();
  emitTaskEvent({ type: 'updated', taskId: task.id });
  return task;
}
export function reorderNotes(placement, ids) {
  const key = placement === 'session' ? 'sessionOrder' : placement === 'topbar' ? 'topbarOrder' : null;
  if (!key) return null;
  const byId = new Map(notes.map((note) => [note.id, note]));
  const selected = [...new Set(ids)].map((id) => byId.get(id)).filter(Boolean);
  const selectedNotes = new Set(selected);
  const remaining = notes.filter((note) => !selectedNotes.has(note)).sort((a, b) => Number(a[key]) - Number(b[key]));
  // 调整提醒栏顺序不是便签内容更新，保留 updatedAt，避免触发看板卡片重绘。
  [...selected, ...remaining].forEach((note, index) => { note[key] = index + 1; });
  saveTasks();
  emitTaskEvent({ type: 'note-reordered', placement });
  return notes;
}
export function updateNote(id, patch) {
  const note = getNote(id);
  if (!note) return null;
  Object.assign(note, patch, { updatedAt: new Date().toISOString() });
  saveTasks();
  emitTaskEvent({ type: 'note-updated', noteId: note.id });
  return note;
}
export function deleteTask(id) {
  const index = tasks.findIndex((task) => task.id === id);
  if (index < 0) return null;
  const [task] = tasks.splice(index, 1);
  saveTasks();
  emitTaskEvent({ type: 'deleted', taskId: task.id });
  return task;
}
export function deleteNote(id) {
  const index = notes.findIndex((note) => note.id === id);
  if (index < 0) return null;
  const [note] = notes.splice(index, 1);
  defaultNoteIds = defaultNoteIds.filter((noteId) => noteId !== id);
  for (const task of tasks) task.noteIds = Array.isArray(task.noteIds) ? task.noteIds.filter((noteId) => noteId !== id) : [];
  saveTasks();
  emitTaskEvent({ type: 'note-deleted', noteId: note.id });
  return note;
}
