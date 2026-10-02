import { compactNumber, deadline, esc, number, time } from './ui/format.js';
import { api } from './ui/api.js';
import {
  COLORS, MAX_CUSTOM_COLORS, STATUS, colorCatalog, customColors, saveCustomColors, state, taskColor,
  applyViewSettings, loadLayoutState, saveLayoutState, updateViewSetting,
} from './ui/state.js';

const $ = (selector, root = document) => root.querySelector(selector);

function customColorStyle(key) {
  const color = customColors[key];
  return color ? ` style="--task-color:${esc(color.value)}"` : '';
}
function customColorUseCount(key) {
  const assignedCount = [...state.tasks, ...state.notes].filter((item) => item.color === key).length;
  return (Number(customColors[key]?.useCount) || 0) + assignedCount;
}
function createCustomColor(value) {
  const existing = Object.entries(colorCatalog()).find(([, color]) => color.value === value);
  if (existing) return existing[0];
  const entries = Object.entries(customColors);
  let key;
  if (entries.length < MAX_CUSTOM_COLORS) {
    key = `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  } else {
    const [leastUsedKey] = entries.slice().sort(([aKey, a], [bKey, b]) => customColorUseCount(aKey) - customColorUseCount(bKey)
      || (Number(a.lastUsedAt) || Number(a.createdAt) || 0) - (Number(b.lastUsedAt) || Number(b.createdAt) || 0)
      || aKey.localeCompare(bKey))[0];
    key = leastUsedKey;
  }
  customColors[key] = { label: value.toUpperCase(), value, createdAt: Date.now(), useCount: 0, lastUsedAt: 0 };
  saveCustomColors();
  return key;
}
function markCustomColorUsed(key) {
  if (!customColors[key]) return;
  customColors[key].useCount = (Number(customColors[key].useCount) || 0) + 1;
  customColors[key].lastUsedAt = Date.now();
  saveCustomColors();
}

loadLayoutState();
let layoutInitialized = false;
let tuiSocket = null;
let terminal = null;
let fitAddon = null;
let terminalSearchAddon = null;
let terminalResizeObserver = null;
let terminalImeCursorHandler = null;
let terminalCursorSubscription = null;
let terminalWriteParsedSubscription = null;
let terminalWriteTimer = null;
let terminalWriteBuffer = [];
let terminalImePositionFrame = null;
let terminalFocusRetryTimer = null;
let terminalImeComposing = false;
let terminalImeInputStyle = null;
let tuiOpening = null;
// 宿主是否提供 dsh 会话服务（来自 GET /api/config 的 dshAvailable）。
let dshAvailable = false;
let modalRestoreFocus = null;
let sessionTaskDetailsOpen = false;
let sessionActionMenuOpen = false;
let sessionSwitchMenuOpen = null;
let marqueeMotionFrame = null;
let marqueeMotion = null;
let renderedPinnedNotesSignature = '';
let renderedSessionTreeSignature = '';
let sessionTreeClickTimer = null;
const SESSION_TREE_SORT_OPTIONS = [
  { value: 'created', label: '按创建时间' },
  { value: 'updated', label: '按最近更新' },
  { value: 'title', label: '按标题名称' },
  { value: 'path', label: '按工作路径' },
  { value: 'color', label: '按颜色标签' },
  { value: 'status', label: '按任务状态' },
];
const SESSION_TREE_SORT_VALUES = new Set(SESSION_TREE_SORT_OPTIONS.map((option) => option.value));
let sessionTreeQuery = '';
let sessionTreeSort = SESSION_TREE_SORT_VALUES.has(localStorage.getItem('workbench-session-tree-sort'))
  ? localStorage.getItem('workbench-session-tree-sort')
  : 'updated';
let sessionTreeSearchOpen = false;
let sessionTreeSortOpen = false;
let noteDragTimer = null;
let noteDrag = null;
let suppressNoteClickUntil = 0;
const seenSessionMessageIds = new Map();
const readRequests = new Map();

function hiddenWorkingDirs() {
  try { const parsed = JSON.parse(localStorage.getItem('workbench-hidden-working-dirs') || '[]'); if (Array.isArray(parsed)) return parsed; } catch { /* ignore malformed browser data */ }
  return [];
}
function recentWorkingDirs() {
  let saved = [];
  try { const parsed = JSON.parse(localStorage.getItem('workbench-working-dirs') || '[]'); if (Array.isArray(parsed)) saved = parsed; } catch { /* ignore malformed browser data */ }
  const hidden = new Set(hiddenWorkingDirs());
  const taskDirs = state.tasks.flatMap((task) => Array.isArray(task.workingDirs) ? task.workingDirs : [task.workingDir]);
  return [...new Set([...saved, ...taskDirs].filter((item) => item && !hidden.has(item)))].slice(0, 12);
}
function rememberWorkingDir(value) {
  const dir = String(value || '').trim();
  if (!dir) return;
  localStorage.setItem('workbench-hidden-working-dirs', JSON.stringify(hiddenWorkingDirs().filter((item) => item !== dir)));
  localStorage.setItem('workbench-working-dirs', JSON.stringify([dir, ...recentWorkingDirs().filter((item) => item !== dir)].slice(0, 12)));
}
function forgetWorkingDir(value) {
  const dir = String(value || '').trim();
  if (!dir) return;
  let saved = [];
  try { const parsed = JSON.parse(localStorage.getItem('workbench-working-dirs') || '[]'); if (Array.isArray(parsed)) saved = parsed; } catch { /* ignore malformed browser data */ }
  localStorage.setItem('workbench-working-dirs', JSON.stringify(saved.filter((item) => item !== dir)));
  localStorage.setItem('workbench-hidden-working-dirs', JSON.stringify([dir, ...hiddenWorkingDirs().filter((item) => item !== dir)].slice(0, 50)));
}
function syncDisplaySettings() {
  const style = localStorage.getItem('workbench-style') || 'classic';
  document.querySelectorAll('[data-theme-style]').forEach((button) => {
    const active = button.dataset.themeStyle === style;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', String(active));
  });
  const theme = ['system', 'light', 'dark'].includes(localStorage.getItem('workbench-theme')) ? localStorage.getItem('workbench-theme') : 'system';
  document.querySelectorAll('[data-display-mode]').forEach((button) => {
    const active = button.dataset.displayMode === theme;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', String(active));
  });
}
const THEME_STYLES = ['classic', 'geek-terminal', 'aurora', 'newspaper'];
const THEME_CLASS_NAMES = { classic: 'classic', 'geek-terminal': 'geek', aurora: 'aurora', newspaper: 'newspaper' };
const THEME_BODY_CLASSES = ['classic', 'geek', 'geek-terminal', 'aurora', 'newspaper'];
function applyThemeStyle(style) {
  const normalized = style === 'geek' ? 'geek-terminal' : style;
  const selected = THEME_STYLES.includes(normalized) ? normalized : 'classic';
  THEME_BODY_CLASSES.forEach((name) => document.body.classList.toggle(`theme-${name}`, THEME_CLASS_NAMES[selected] === name));
  localStorage.setItem('workbench-style', selected);
  syncDisplaySettings();
}
function applyTheme(theme) {
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.body.classList.toggle('theme-light', theme === 'light');
  document.body.classList.toggle('theme-dark', theme === 'dark');
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  const style = THEME_STYLES.includes(localStorage.getItem('workbench-style')) ? localStorage.getItem('workbench-style') : 'classic';
  const themeColors = {
    classic: { light: '#f6f6f6', dark: '#111821' },
    'geek-terminal': { light: '#edf5ef', dark: '#070b09' },
    aurora: { light: '#f7f1ff', dark: '#0f1224' },
    newspaper: { light: '#efede6', dark: '#181816' },
  };
  const themeColor = themeColors[style][dark ? 'dark' : 'light'];
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColor);
  localStorage.setItem('workbench-theme', theme);
  syncDisplaySettings();
}
function isTerminalDark() {
  // TUI 的配色必须跟随工作台当前的亮暗模式，不能只看浏览器默认主题。
  return document.body.classList.contains('theme-dark')
    || (!document.body.classList.contains('theme-light') && matchMedia('(prefers-color-scheme: dark)').matches);
}
function syncViewportHeight() {
  document.documentElement.style.setProperty('--app-viewport-height', `${window.visualViewport?.height || window.innerHeight}px`);
}
applyThemeStyle(localStorage.getItem('workbench-style'));
applyTheme(['system', 'light', 'dark'].includes(localStorage.getItem('workbench-theme')) ? localStorage.getItem('workbench-theme') : 'system');
// 嵌入 dsh 时跟随宿主主题：父页面通过 postMessage 推送 light/dark。
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== window.parent) return;
  const data = event.data;
  if (data?.type !== 'workbench-theme' || !['light', 'dark'].includes(data.mode)) return;
  if (localStorage.getItem('workbench-theme') === data.mode) return;
  applyTheme(data.mode);
  void restartTuiForTheme();
});
syncViewportHeight();
function applySidebarCollapsed(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  const button = $('#sidebar-toggle');
  button.title = collapsed ? '展开侧边栏' : '收起侧边栏';
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-expanded', String(!collapsed));
  if (!button.querySelector('.sidebar-toggle-line')) {
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="3" width="20" height="18" rx="3"/><path class="sidebar-toggle-line" d="M9 3v18"/></svg>';
  }
}

// 工作区导航记录的是“看过的界面”，不干涉任务内容和终端内的 undo/redo。
const workspaceHistory = { entries: [], index: -1, restoring: false };
function workspaceViewSnapshot() {
  return {
    module: state.module,
    boardType: state.boardType,
    status: state.status,
    archiveType: state.archiveType,
    noteFilter: state.noteFilter,
    sessionFilter: state.sessionFilter,
    sessionTask: state.module === 'session' ? state.sessionTask : null,
    sessionSessionId: state.module === 'session' ? state.sessionSessionId : null,
  };
}
function sameWorkspaceView(a, b) {
  return Boolean(a && b && ['module', 'boardType', 'status', 'archiveType', 'noteFilter', 'sessionFilter', 'sessionTask', 'sessionSessionId'].every((key) => a[key] === b[key]));
}
function syncWorkspaceHistoryControls() {
  const back = $('#workspace-back');
  const forward = $('#workspace-forward');
  if (!back || !forward) return;
  back.disabled = workspaceHistory.index <= 0;
  forward.disabled = workspaceHistory.index < 0 || workspaceHistory.index >= workspaceHistory.entries.length - 1;
  back.title = back.disabled ? '' : '返回（Alt+←）';
  forward.title = forward.disabled ? '' : '前进（Alt+→）';
  back.setAttribute('aria-disabled', String(back.disabled));
  forward.setAttribute('aria-disabled', String(forward.disabled));
}
function recordWorkspaceView() {
  if (workspaceHistory.restoring) return;
  const snapshot = workspaceViewSnapshot();
  if (sameWorkspaceView(workspaceHistory.entries[workspaceHistory.index], snapshot)) return;
  workspaceHistory.entries.splice(workspaceHistory.index + 1);
  workspaceHistory.entries.push(snapshot);
  workspaceHistory.index = workspaceHistory.entries.length - 1;
  syncWorkspaceHistoryControls();
}
async function restoreWorkspaceView(snapshot) {
  workspaceHistory.restoring = true;
  try {
    state.boardType = snapshot.boardType;
    state.status = snapshot.status;
    state.archiveType = snapshot.archiveType;
    state.noteFilter = snapshot.noteFilter;
    state.sessionFilter = snapshot.sessionFilter || 'all';
    applyViewSettings();
    if (snapshot.module === 'session') {
      if (snapshot.sessionTask && currentTask(snapshot.sessionTask)) await selectSession(snapshot.sessionTask, snapshot.sessionSessionId, { record: false });
      else await selectSession(null, null, { record: false });
    } else {
      switchModule('tasks');
      saveLayoutState();
    }
  } finally {
    workspaceHistory.restoring = false;
    syncWorkspaceHistoryControls();
  }
}
async function moveWorkspaceHistory(delta) {
  const nextIndex = workspaceHistory.index + delta;
  const snapshot = workspaceHistory.entries[nextIndex];
  if (!snapshot) return;
  workspaceHistory.index = nextIndex;
  syncWorkspaceHistoryControls();
  await restoreWorkspaceView(snapshot);
}

// 通知消息框每次只播放一条便签，过长内容截断以保持轨道稳定。
const MARQUEE_MAX_MESSAGE_CHARS = 300;
const TITLE_MARQUEE_SPEED = 28; // px/s，标题滚动采用恒定的像素速度
const SORT_OPTIONS = [
  { value: 'updated', label: '最近更新', icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5l3.5 2"/></svg>' },
  { value: 'created', label: '创建时间', icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5.5" width="16" height="14" rx="2"/><path d="M8 4v3M16 4v3M4 9.5h16M8 13h.01M12 13h.01M16 13h.01M8 16.5h.01M12 16.5h.01"/></svg>' },
  { value: 'deadline', label: '截止时间', icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4v3M18 4v3M4 9h16M6 5h12a2 2 0 0 1 2 2v11H4V7a2 2 0 0 1 2-2Z"/><path d="M12 12v3l2 1"/></svg>' },
];
const BOARD_GROUP_ICONS = {
  single: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="1.5"/></svg>',
  status: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 12h10M5 17h6"/></svg>',
  path: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5h6l2 2h9v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2zM3.5 7.5v-1a2 2 0 0 1 2-2h4l2 2h5"/></svg>',
  color: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4a8 8 0 1 0 0 16h1.5a2 2 0 0 0 0-4H12a1.5 1.5 0 0 1 0-3h3a5 5 0 0 0 5-5c0-2.2-3.6-4-8-4Z"/><circle cx="8" cy="9" r="1"/><circle cx="11" cy="7.5" r="1"/><circle cx="14.5" cy="7.5" r="1"/></svg>',
  kind: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="6" width="13" height="14" rx="1.5"/><path d="M8 4h11a1 1 0 0 1 1 1v12"/></svg>',
  task: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="m8 12 2.5 2.5L16 9"/></svg>',
  noteCategory: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="6" height="6" rx="1"/><rect x="14" y="5" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></svg>',
};
const EMPTY_TRASH_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14"/><path d="M9 7V5h6v2"/><path d="M7 8h10l-1 12H8L7 8Z"/><path d="m10 11 4 4m0-4-4 4"/></svg>';
function syncTaskToolbarTitle() {
  const archived = state.status === 'archived';
  const notes = !archived && state.boardType === 'notes';
  const sessions = !archived && state.boardType === 'sessions';
  const clearArchivedButton = $('#purge-archived');
  if (clearArchivedButton) {
    clearArchivedButton.innerHTML = EMPTY_TRASH_ICON;
    const archivedTaskCount = state.tasks.filter((task) => task.status === 'archived').length;
    const archivedNoteCount = state.notes.filter((note) => note.status === 'archived').length;
    const archivedSessionCount = state.tasks.flatMap((task) => task.sessions || []).filter((session) => session.status === 'archived').length;
    const archivedCounts = { all: archivedTaskCount + archivedNoteCount + archivedSessionCount, tasks: archivedTaskCount, notes: archivedNoteCount, sessions: archivedSessionCount };
    clearArchivedButton.classList.toggle('hidden', !archived);
    clearArchivedButton.disabled = archivedCounts[state.archiveType] === 0;
  }
  const searchInput = $('#search');
  let searchLabel = '搜索任务';
  if (archived) searchLabel = '搜索回收站';
  else if (notes) searchLabel = '搜索便签';
  else if (sessions) searchLabel = '搜索会话';
  if (searchInput) searchInput.setAttribute('aria-label', searchLabel);
  const newItemButton = $('#toolbar-new-item');
  if (newItemButton) {
    const label = notes ? '新建便签' : sessions ? '新建会话' : '新建任务';
    newItemButton.classList.toggle('hidden', archived);
    newItemButton.title = label;
    newItemButton.setAttribute('aria-label', label);
  }
  syncArchiveButton();
  syncModuleTabs();
}
function syncSortControl() {
  const button = $('#sort-toggle');
  const option = SORT_OPTIONS.find((item) => item.value === state.sort) || SORT_OPTIONS[0];
  button.innerHTML = option.icon;
  button.title = `排序：${option.label}（点击切换）`;
  button.setAttribute('aria-label', button.title);
}
function syncCardLayoutControl() {
  const button = $('#board-card-layout');
  const compact = state.boardCardLayout === 'compact';
  button.innerHTML = compact
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="5" height="12" rx="1.2"/><rect x="9.5" y="6" width="5" height="12" rx="1.2"/><rect x="16" y="6" width="5" height="12" rx="1.2"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="4" width="12" height="16" rx="1.5"/></svg>';
  button.title = `切换布局（当前：${compact ? '紧凑' : '单列'}）`;
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-pressed', String(compact));
}
applySidebarCollapsed(state.sidebarCollapsed);
syncTaskToolbarTitle();
syncBoardFilter();
syncSortControl();
syncCardLayoutControl();
$('#search').value = state.search;
workspaceHistory.entries = [workspaceViewSnapshot()];
workspaceHistory.index = 0;
syncWorkspaceHistoryControls();
$('#workspace-back').onclick = () => { void moveWorkspaceHistory(-1); };
$('#workspace-forward').onclick = () => { void moveWorkspaceHistory(1); };
document.addEventListener('keydown', (event) => {
  if ($('.modal') || event.defaultPrevented) return;
  const target = event.target;
  const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable;
  if (typing) return;
  const back = (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === 'ArrowLeft')
    || (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key === '[');
  const forward = (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === 'ArrowRight')
    || (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key === ']');
  if (!back && !forward) return;
  event.preventDefault();
  void moveWorkspaceHistory(back ? -1 : 1);
});
window.addEventListener('resize', () => { syncViewportHeight(); syncMasonryColumns(); syncOverflowTooltips(); });
window.addEventListener('pagehide', saveLayoutState);
window.visualViewport?.addEventListener('resize', syncViewportHeight);

// 将原 Toast 内容输出到运行后端的终端，不再显示浏览器弹窗。
function toast(message, type = '') {
  const text = String(message || '').trim();
  if (!text) return;
  void api('/client-log', { method: 'POST', body: { message: text, type } }).catch(() => {});
}
function currentTask(id) { return state.tasks.find((task) => task.id === id); }
function currentNote(id) { return state.notes.find((note) => note.id === id); }
const LAST_OPENED_SESSION_KEY = 'workbench-last-opened-session';
function rememberLastOpenedSession(taskId, sessionId) {
  if (!taskId || !sessionId) return;
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_OPENED_SESSION_KEY) || '{}');
    const sessions = saved && typeof saved === 'object' && saved.sessions && typeof saved.sessions === 'object' ? saved.sessions : {};
    if (!saved.sessions && saved && typeof saved.taskId === 'string' && typeof saved.sessionId === 'string') sessions[saved.taskId] = saved.sessionId;
    sessions[taskId] = sessionId;
    localStorage.setItem(LAST_OPENED_SESSION_KEY, JSON.stringify({ taskId, sessionId, sessions }));
  } catch { /* ignore unavailable browser storage */ }
}
function storedLastOpenedSession(taskId = null) {
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_OPENED_SESSION_KEY) || 'null');
    if (!saved || typeof saved !== 'object') return null;
    if (taskId && saved.sessions && typeof saved.sessions[taskId] === 'string') return { taskId, sessionId: saved.sessions[taskId] };
    if (saved && typeof saved.taskId === 'string' && typeof saved.sessionId === 'string') return saved;
  } catch { /* ignore malformed browser data */ }
  return null;
}
function lastOpenedSessionForTask(task) {
  if (!task) return null;
  const sessions = availableSessions(task);
  const stored = storedLastOpenedSession(task.id);
  const remembered = stored && sessions.find((session) => session.id === stored.sessionId);
  if (remembered) return remembered;
  const active = sessions.find((session) => session.id === task.activeSessionId);
  if (active) return active;
  return sessions.slice().sort((a, b) => sessionTreeTime(b.updatedAt) - sessionTreeTime(a.updatedAt))[0] || null;
}
function noteInitial(note) {
  const source = `${note?.title || ''} ${note?.description || ''}`.trim();
  const chars = [...source].filter((char) => !/\s/u.test(char));
  if (!chars.length) return { primary: '', secondary: '' };
  const firstIsChinese = /\p{Script=Han}/u.test(chars[0]);
  const secondIsChinese = /\p{Script=Han}/u.test(chars[1] || '');
  // 首字符是中文，或第二字符是中文时，都只显示首字符；仅前两个字符都非中文时显示双字符缩写。
  return { primary: chars[0], secondary: !firstIsChinese && !secondIsChinese ? (chars[1] || '') : '' };
}
function noteInitialMarkup(note) {
  const { primary, secondary } = noteInitial(note);
  if (!primary && !secondary) return '';
  return `<span class="note-initial"><span class="note-initial-primary">${esc(primary)}</span>${secondary ? `<span class="note-initial-secondary">${esc(secondary)}</span>` : ''}</span>`;
}
function noteLabel(note) { return note?.title ? `${note.title}：${note.description}` : note?.description || ''; }
function orderedPinnedNotes(flag, orderKey) {
  return state.notes.filter((note) => note.status !== 'archived' && note[flag]).sort((a, b) => Number(a[orderKey]) - Number(b[orderKey]) || new Date(a.createdAt) - new Date(b.createdAt));
}
const MARQUEE_INITIAL_ITEMS = 8;
const MARQUEE_MAX_ITEMS = 24;
const MARQUEE_GAP = 28;
function stopMarqueeMotion() {
  if (marqueeMotionFrame !== null) cancelAnimationFrame(marqueeMotionFrame);
  marqueeMotionFrame = null;
  marqueeMotion = null;
}
function marqueeMessages() {
  return state.notes.filter((note) => note.status !== 'archived').map((note) => {
    const chars = [...noteLabel(note)];
    return chars.length > MARQUEE_MAX_MESSAGE_CHARS ? `${chars.slice(0, MARQUEE_MAX_MESSAGE_CHARS).join('')}…` : chars.join('');
  }).filter(Boolean);
}
function shuffledMarqueeMessages(messages) {
  const shuffled = messages.slice();
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
  }
  return shuffled;
}
function nextMarqueeMessage(motion) {
  if (motion.roundIndex >= motion.round.length) {
    motion.round = shuffledMarqueeMessages(motion.messages);
    motion.roundIndex = 0;
  }
  return motion.round[motion.roundIndex++];
}
function marqueeItemMarkup(message) {
  return `<span class="note-marquee-item" title="${esc(message)}">${esc(message)}</span>`;
}
function appendMarqueeItem(motion) {
  const message = nextMarqueeMessage(motion);
  motion.track.insertAdjacentHTML('beforeend', marqueeItemMarkup(message));
}
function startMarqueeMotion(motion) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const { root, track } = motion;
  marqueeMotion = motion;
  const tick = (now) => {
    // 悬停只改变像素速度，不重置 transform，因此不会产生回跳或卡顿。
    const speed = root.matches(':hover') ? 30 : 90;
    motion.travel += Math.min(Math.max(0, now - motion.lastTime), 120) * speed / 1000;
    motion.lastTime = now;
    const first = track.firstElementChild;
    if (first) {
      const width = first.getBoundingClientRect().width;
      // 每帧最多回收一个节点，避免大步长触发无界循环。
      if (motion.travel >= root.clientWidth + width) {
        motion.travel -= width + MARQUEE_GAP;
        first.remove();
        if (track.children.length < MARQUEE_INITIAL_ITEMS) appendMarqueeItem(motion);
      }
    }
    track.style.transform = `translate3d(${root.clientWidth - motion.travel}px, 0, 0)`;
    marqueeMotionFrame = requestAnimationFrame(tick);
  };
  motion.tick = tick;
  track.style.transform = `translate3d(${root.clientWidth}px, 0, 0)`;
  motion.lastTime = performance.now();
  marqueeMotionFrame = requestAnimationFrame(tick);
}
function pauseMarqueeMotion() {
  if (marqueeMotionFrame !== null) cancelAnimationFrame(marqueeMotionFrame);
  marqueeMotionFrame = null;
}
function resumeMarqueeMotion() {
  if (!marqueeMotion || marqueeMotionFrame !== null) return;
  if (!marqueeMotion.tick) {
    const motion = marqueeMotion;
    marqueeMotionFrame = requestAnimationFrame(() => {
      marqueeMotionFrame = null;
      if (marqueeMotion === motion) startMarqueeMotion(motion);
    });
    return;
  }
  marqueeMotion.lastTime = performance.now();
  marqueeMotionFrame = requestAnimationFrame(marqueeMotion.tick);
}
function renderMarquee() {
  stopMarqueeMotion();
  const root = $('#note-marquee');
  const shell = $('#toast-root');
  root.classList.remove('notice', 'error');
  root.setAttribute('aria-hidden', 'true');
  const messages = marqueeMessages();
  if (!messages.length) {
    root.classList.add('empty'); shell.classList.add('notification-empty');
    root.innerHTML = '';
    return;
  }
  root.classList.remove('empty'); shell.classList.remove('notification-empty');
  const motion = { root, track: null, messages, round: [], roundIndex: 0, travel: 0, lastTime: 0 };
  const initialItems = Array.from({ length: MARQUEE_INITIAL_ITEMS }, () => marqueeItemMarkup(nextMarqueeMessage(motion))).join('');
  root.innerHTML = `<span class="note-marquee-track">${initialItems}</span>`;
  motion.track = root.querySelector('.note-marquee-track');
  marqueeMotion = motion;
  // 有界预填充：最多补到 24 个节点，不使用可能失控的 while。
  for (let index = MARQUEE_INITIAL_ITEMS; index < MARQUEE_MAX_ITEMS && motion.track.getBoundingClientRect().width < root.clientWidth * 2; index += 1) {
    appendMarqueeItem(motion);
  }
  // DOM 插入当帧即定位到右侧，不能等 rAF 回调，否则低帧率下会闪到左侧。
  motion.track.style.transform = `translate3d(${root.clientWidth}px, 0, 0)`;
  marqueeMotionFrame = requestAnimationFrame(() => {
    marqueeMotionFrame = null;
    startMarqueeMotion(motion);
  });
}
function renderTopbarNoteButtons() {
  const root = $('#topbar-note-buttons');
  if (!root) return;
  const notes = orderedPinnedNotes('pinnedToTopBar', 'topbarOrder');
  root.innerHTML = `${notes.map((note) => `<button type="button" class="note-button color-${taskColor(note)}${customColors[taskColor(note)] ? ' custom-color' : ''}"${customColorStyle(taskColor(note))} data-topbar-note="${esc(note.id)}" data-note-id="${esc(note.id)}" data-note-placement="topbar" aria-label="${esc(noteLabel(note))}" aria-haspopup="menu" aria-expanded="false" title="${esc(noteLabel(note))}">${noteInitialMarkup(note)}</button>`).join('')}<button type="button" class="note-button note-add-button" data-new-topbar-note aria-label="新建提醒便签" title="新建提醒便签">＋</button><section id="topbar-note-panel" class="session-description-panel topbar-note-panel hidden" aria-label="便签详情"></section>`;
}
function renderPinnedNotes() {
  // 会话输出也会触发 refresh；仅在便签自身变化时重绘，不能重启动画。
  const signature = JSON.stringify(state.notes.map((note) => [note.id, note.updatedAt, note.status, note.title, note.description, note.color, note.pinnedToTopBar, note.pinnedToSessionBar, note.topbarOrder, note.sessionOrder]));
  if (signature === renderedPinnedNotesSignature) return;
  renderedPinnedNotesSignature = signature;
  renderTopbarNoteButtons();
  const messages = marqueeMessages();
  if (messages.length && marqueeMotion?.track?.isConnected) {
    marqueeMotion.messages = messages;
    marqueeMotion.round = [];
    marqueeMotion.roundIndex = 0;
  }
  else renderMarquee();
}
function renderSessionNoteButtons() {
  const root = $('#session-note-buttons');
  if (!root) return;
  closeSessionNoteMenu();
  const notes = orderedPinnedNotes('pinnedToSessionBar', 'sessionOrder');
  root.innerHTML = `${notes.map((note) => `<button type="button" class="note-button session-note-button color-${taskColor(note)}${customColors[taskColor(note)] ? ' custom-color' : ''}"${customColorStyle(taskColor(note))} data-session-note="${esc(note.id)}" data-note-id="${esc(note.id)}" data-note-placement="session" aria-label="${esc(noteLabel(note))}" aria-haspopup="menu" aria-expanded="false" title="${esc(noteLabel(note))}">${noteInitialMarkup(note)}</button>`).join('')}<button type="button" class="note-button note-add-button" data-new-session-note aria-label="新建会话便签" title="新建会话便签">＋</button>`;
}
function sessionMarkerKey(taskId, sessionId) { return `${taskId}\u0000${sessionId}`; }
function rememberCurrentSessionMessage() {
  if (state.module !== 'session' || document.visibilityState !== 'visible' || !state.sessionTask || !state.sessionSessionId) return;
  const session = currentTask(state.sessionTask)?.sessions?.find((item) => item.id === state.sessionSessionId);
  if (session?.latestMessageId) seenSessionMessageIds.set(sessionMarkerKey(state.sessionTask, state.sessionSessionId), session.latestMessageId);
}
function masonryItems(container, selector) {
  return [...container.children].flatMap((child) => child.classList.contains('masonry-column')
    ? [...child.children].filter((item) => item.matches(selector))
    : child.matches(selector) ? [child] : []);
}
function arrangeMasonry(container, selector, columns, className) {
  const items = masonryItems(container, selector);
  if (!items.length) return;
  const count = Math.max(1, Math.min(columns, items.length));
  container.classList.add('is-masonry');
  container.style.setProperty('--masonry-column-count', String(count));
  const columnNodes = Array.from({ length: count }, () => {
    const column = document.createElement('div');
    column.className = `masonry-column ${className}`;
    return column;
  });
  container.replaceChildren(...columnNodes);
  const heights = Array(count).fill(0);
  items.forEach((item) => {
    const shortest = heights.indexOf(Math.min(...heights));
    columnNodes[shortest].append(item);
    heights[shortest] = columnNodes[shortest].getBoundingClientRect().height;
  });
}
function restoreMasonry(container, selector) {
  const items = masonryItems(container, selector);
  if (!items.length || !container.querySelector(':scope > .masonry-column')) return;
  container.classList.remove('is-masonry');
  container.replaceChildren(...items);
}
let masonryLayoutFrame = null;
function syncMasonryColumns(root = document) {
  const board = root.querySelector('.task-board');
  if (!board || board.clientWidth <= 0) return;
  const boardColumns = Math.max(1, Math.floor((board.clientWidth + 14) / 374));

  // 先放置看板以得到内部列表的最终宽度；下一帧再计算紧凑卡片的列数。
  arrangeMasonry(board, '.task-board-column', boardColumns, 'board-masonry-column');
  if (masonryLayoutFrame !== null) cancelAnimationFrame(masonryLayoutFrame);
  masonryLayoutFrame = requestAnimationFrame(() => {
    masonryLayoutFrame = null;
    const currentBoard = root.querySelector('.task-board');
    if (!currentBoard || currentBoard.clientWidth <= 0) return;
    const currentBoardColumns = Math.max(1, Math.floor((currentBoard.clientWidth + 14) / 374));
    const compact = currentBoard.classList.contains('compact-card-layout');
    currentBoard.querySelectorAll('.task-board-list').forEach((list) => {
      if (!compact) {
        restoreMasonry(list, '.card');
        return;
      }
      const cardColumns = Math.max(1, Math.floor((list.clientWidth + 10) / 270));
      arrangeMasonry(list, '.card', cardColumns, 'card-masonry-column');
    });

    // 卡片分列会改变看板高度，最后按新的真实高度再平衡一次外层瀑布流。
    if (masonryItems(currentBoard, '.task-board-column').length > 1) {
      arrangeMasonry(currentBoard, '.task-board-column', currentBoardColumns, 'board-masonry-column');
    }
  });
}
const titleAnimations = new WeakMap();
function nativeTooltip(value) {
  return String(value || '').split('\n').map((line) => {
    const chars = [...line];
    const lines = [];
    while (chars.length > 32) lines.push(chars.splice(0, 32).join(''));
    lines.push(chars.join(''));
    return lines.join('\n');
  }).join('\n');
}
function titleIsHovered(node) {
  const owner = node.closest('.session-task-heading, .session-child-session, .session-title-row');
  return Boolean(owner && (owner.matches(':hover') || owner.matches(':focus-within')));
}
function titleTransformX(node) {
  const transform = getComputedStyle(node).transform;
  if (!transform || transform === 'none') return 0;
  const values = transform.match(/^matrix3d\(([^)]+)\)$/)?.[1] || transform.match(/^matrix\(([^)]+)\)$/)?.[1];
  if (!values) return 0;
  const parts = values.split(',').map(Number);
  return transform.startsWith('matrix3d') ? (parts[12] || 0) : (parts[4] || 0);
}
function syncTitleMarquee(node, overflowing) {
  const current = titleAnimations.get(node);
  if (!overflowing || !titleIsHovered(node) || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    current?.animation.cancel();
    titleAnimations.delete(node);
    return;
  }
  const distance = Math.max(0, node.scrollWidth - node.clientWidth);
  if (current?.distance === distance) return;
  // 操作按钮显隐会改变标题视口宽度；重测距离时保留当前动画位置，避免新动画从 0 开始造成“先后退再前进”。
  const previousX = current ? titleTransformX(node) : 0;
  const previousTiming = current?.animation.effect?.getComputedTiming();
  current?.animation.cancel();
  const duration = (distance / TITLE_MARQUEE_SPEED) * 1000;
  const animation = node.animate([
    { transform: 'translateX(0)' },
    { transform: `translateX(${-distance}px)` },
  ], { duration, iterations: Infinity, direction: 'alternate', easing: 'linear', fill: 'both' });
  if (current && previousTiming && distance > 0) {
    const iteration = Math.max(0, Number(previousTiming.currentIteration) || 0);
    const clampedX = Math.min(0, Math.max(-distance, previousX));
    const progress = iteration % 2 === 0
      ? -clampedX / distance
      : 1 + clampedX / distance;
    animation.currentTime = (iteration + Math.min(1, Math.max(0, progress))) * duration;
  }
  titleAnimations.set(node, { animation, distance });
}
function syncOverflowTooltips(root = document) {
  root.querySelectorAll('[data-tooltip]').forEach((node) => {
    const overflowing = node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight + 1;
    const scrollingTitle = node.matches('.session-title-text');
    // 侧栏标题用悬停滚动展示全文，不再触发浏览器原生全文提示框。
    node.title = scrollingTitle ? '' : (overflowing ? nativeTooltip(node.dataset.tooltip) : '');
    node.classList.toggle('is-overflowing', overflowing);
    node.closest('.session-title-text-viewport')?.classList.toggle('is-overflowing', scrollingTitle && overflowing);
    if (scrollingTitle) syncTitleMarquee(node, overflowing);
  });
}
const overflowTooltipObserver = new MutationObserver(() => requestAnimationFrame(() => syncOverflowTooltips()));
overflowTooltipObserver.observe(document.body, { childList: true, subtree: true });
// 悬停时右侧操作按钮会出现并触发布局过渡；等过渡结束后再测量，避免动画先按旧宽度前进、再被重置后退。
document.addEventListener('mouseover', (event) => {
  const item = event.target.closest('.session-task-heading, .session-child-session, .session-title-row');
  if (item) setTimeout(() => syncOverflowTooltips(item), 180);
});
document.addEventListener('focusin', (event) => {
  const item = event.target.closest('.session-task-heading, .session-child-session, .session-title-row');
  if (item) setTimeout(() => syncOverflowTooltips(item), 180);
});
document.addEventListener('mouseout', (event) => {
  const item = event.target.closest('.session-task-heading, .session-child-session, .session-title-row');
  if (!item || item.contains(event.relatedTarget)) return;
  requestAnimationFrame(() => syncOverflowTooltips(item));
});
document.addEventListener('focusout', (event) => {
  const item = event.target.closest('.session-task-heading, .session-child-session, .session-title-row');
  if (!item || item.contains(event.relatedTarget)) return;
  requestAnimationFrame(() => syncOverflowTooltips(item));
});
document.addEventListener('transitionend', (event) => {
  const target = event.target;
  if (!(target instanceof Element) || event.propertyName !== 'padding-right') return;
  if (!target.matches('.session-task-title, .session-child-open')) return;
  const item = target.closest('.session-task-heading, .session-child-session');
  if (item) syncOverflowTooltips(item);
});
function renderStats() {
  const counts = { unfinished: 0, done: 0 };
  let overdue = 0;
  state.tasks.forEach((task) => { if (counts[task.status] !== undefined) counts[task.status]++; if (task.overdue) overdue++; });
  $('#stats').innerHTML = ['unfinished', 'done'].map((key) => `<span class="chip ${STATUS[key].cls}">${STATUS[key].label} ${number(counts[key])}</span>`).join('') + (overdue ? `<span class="chip overdue">逾期 ${number(overdue)}</span>` : '');
}
const GROUP_ICONS = {
  '': '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="1.5"/></svg>',
  unfinished: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>',
  done: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/><path d="m8 12 2.5 2.5L16 9"/></svg>',
  archived: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>',
};
const STATUS_ICONS = {
  unfinished: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>',
  done: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/><path d="m8 12 2.5 2.5L16 9"/></svg>',
  archived: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>',
};
function syncArchiveButton() {
  const button = $('#archive-toggle');
  if (!button) return;
  const count = state.tasks.filter((task) => task.status === 'archived').length + state.notes.filter((note) => note.status === 'archived').length + state.tasks.flatMap((task) => archivedSessions(task)).length;
  button.title = `回收站${count ? `（${count}）` : ''}`;
  button.setAttribute('aria-label', button.title);
  button.classList.toggle('active', state.status === 'archived');
}
// 兼容旧的刷新调用；任务/便签筛选已移至顶部内容入口。
function renderTaskSidebar() {
  syncArchiveButton();
  syncModuleTabs();
}
function syncBoardFilter() {
  const root = $('#board-filter-tabs');
  const activeTasks = state.tasks.filter((task) => task.status !== 'archived');
  const activeNotes = state.notes.filter((note) => note.status !== 'archived');
  const archivedTasks = state.tasks.filter((task) => task.status === 'archived');
  const archivedNotes = state.notes.filter((note) => note.status === 'archived');
  let options;
  if (state.status === 'archived') {
    options = [
      ['all', '全部', archivedTasks.length + archivedNotes.length, state.archiveType === 'all', 'archive'],
      ['tasks', '任务', archivedTasks.length, state.archiveType === 'tasks', 'archive'],
      ['notes', '便签', archivedNotes.length, state.archiveType === 'notes', 'archive'],
      ['sessions', '会话', state.tasks.flatMap((task) => task.sessions || []).filter((session) => session.status === 'archived').length, state.archiveType === 'sessions', 'archive'],
    ];
  } else if (state.boardType === 'notes') {
    options = [
      ['all', '全部', activeNotes.length, state.noteFilter === 'all', 'note'],
      ['normal', '无标记', activeNotes.filter((note) => !note.pinnedToTopBar && !note.pinnedToSessionBar).length, state.noteFilter === 'normal', 'note'],
      ['topbar', '提醒标记', activeNotes.filter((note) => note.pinnedToTopBar).length, state.noteFilter === 'topbar', 'note'],
      ['session', '会话标记', activeNotes.filter((note) => note.pinnedToSessionBar).length, state.noteFilter === 'session', 'note'],
    ];
  } else if (state.boardType === 'sessions') {
    const sessions = state.tasks.filter((task) => task.status !== 'archived').flatMap((task) => (task.sessions || []).filter((session) => session.status !== 'archived'));
    options = [
      ['all', '全部', sessions.length, state.sessionFilter === 'all', 'session'],
      ['favorite', '收藏', sessions.filter((session) => session.favorite).length, state.sessionFilter === 'favorite', 'session'],
      ['running', '运行中', sessions.filter((session) => session.running).length, state.sessionFilter === 'running', 'session'],
      ['stopped', '关闭中', sessions.filter((session) => !session.running).length, state.sessionFilter === 'stopped', 'session'],
    ];
  } else {
    options = [
      ['', '全部', activeTasks.length, !state.status, 'task'],
      ['unfinished', '未完成', activeTasks.filter((task) => task.status === 'unfinished').length, state.status === 'unfinished', 'task'],
      ['done', '已完成', activeTasks.filter((task) => task.status === 'done').length, state.status === 'done', 'task'],
    ];
  }
  root.innerHTML = options.map(([value, label, count, active, type]) => `<button type="button" class="board-filter-option${active ? ' active' : ''}" data-filter-value="${esc(value)}" data-filter-type="${type}" aria-label="${esc(label)}" aria-pressed="${active}"><span>${esc(label)}</span><b>${number(count)}</b></button>`).join('');
  let label = '任务筛选';
  if (state.status === 'archived') label = '回收站筛选';
  else if (state.boardType === 'notes') label = '便签筛选';
  else if (state.boardType === 'sessions') label = '会话筛选';
  root.setAttribute('aria-label', label);
}
function visibleTasks() {
  return state.tasks.filter((task) => (state.status ? task.status === state.status : task.status !== 'archived') && (!state.search || `${task.title} ${task.description}`.toLowerCase().includes(state.search.toLowerCase()))).sort((a, b) => {
    if (state.sort === 'deadline') return (a.deadline ? new Date(a.deadline).getTime() : Infinity) - (b.deadline ? new Date(b.deadline).getTime() : Infinity) || new Date(b.updatedAt) - new Date(a.updatedAt);
    if (state.sort === 'created') return new Date(b.createdAt) - new Date(a.createdAt);
    return new Date(b.updatedAt) - new Date(a.updatedAt);
  });
}
const ACTION_ICONS = {
  open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4zM7 9l2 2-2 2M12 13h4"/></svg>',
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6.75 6.75 10.5 10.5M17.25 6.75 6.75 17.25"/></svg>',
  complete: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>',
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 16 10-10 4 4L8 20H4zM13 7l4 4"/></svg>',
  delete: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>',
  restore: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10V4h6M4 4l4 4a8 8 0 1 1-1 10"/></svg>',
  reopen: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10V4h6M4 4l4 4a8 8 0 1 1-1 10"/></svg>',
  purge: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13"/></svg>',
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5h6l2 2h9v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2zM3.5 7.5v-1a2 2 0 0 1 2-2h4l2 2h5"/></svg>',
  clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5l3.5 2"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5.5" width="16" height="14" rx="2"/><path d="M8 4v3M16 4v3M4 9.5h16"/></svg>',
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 4 8 8M14 4l6 6-3 1-3 5-2 2-5-3-1 3-2-2 2-2 5-3 1-3-6-6Z"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/></svg>',
  topbar: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 9h16M8 7h.01M11 7h.01"/></svg>',
  session: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H8l-4 3z"/><path d="M8 9h8M8 12h5"/></svg>',
  task: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="m8 12 2.5 2.5L16 9"/></svg>',
  chevronDown: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
};
function actionButton(action, id, label, iconName, className = '', pressed = null) {
  const pressedAttribute = pressed === null ? '' : ` aria-pressed="${pressed}"`;
  return `<button type="button" class="icon-button ${className}" data-action="${action}" data-id="${esc(id)}" title="${label}" aria-label="${label}"${pressedAttribute}>${ACTION_ICONS[iconName]}</button>`;
}
function sessionActionButton(action, taskId, sessionId, label, iconName, className = '', pressed = null) {
  const pressedAttribute = pressed === null ? '' : ` aria-pressed="${pressed}"`;
  return `<button type="button" class="icon-button ${className}" data-action="${action}" data-task-id="${esc(taskId)}" data-session-id="${esc(sessionId)}" title="${label}" aria-label="${label}"${pressedAttribute}>${ACTION_ICONS[iconName]}</button>`;
}
function actions(task) {
  if (task.status === 'archived') return `${actionButton('open-archived-session', task.id, '打开会话', 'open', 'primary')}${actionButton('restore', task.id, '恢复任务', 'restore')}${actionButton('purge', task.id, '永久删除', 'purge', 'danger')}`;
  if (task.status === 'unfinished') {
    const openAction = availableSessions(task).length ? 'session' : 'execute';
    return `${actionButton(openAction, task.id, '打开会话', 'open', 'primary')}${actionButton('complete', task.id, '标记完成', 'complete')}${actionButton('edit', task.id, '编辑', 'edit')}${actionButton('delete', task.id, '删除', 'delete', 'danger')}`;
  }
  if (task.status === 'done') return `${actionButton('session', task.id, '打开会话', 'open', 'primary')}${actionButton('reopen', task.id, '重开任务', 'reopen')}${actionButton('edit', task.id, '编辑', 'edit')}${actionButton('delete', task.id, '删除', 'delete', 'danger')}`;
  return `${actionButton('reopen', task.id, '重开任务', 'reopen')}${actionButton('delete', task.id, '删除', 'delete', 'danger')}`;
}
function card(task, compact = false) {
  const archiveInfo = task.status === 'archived' ? `<div class="archive-info">废弃 · ${time(task.archivedAt)}</div>` : '';
  const folder = task.workingDir ? `<span class="task-folder" data-tooltip="${esc(task.workingDir)}">${ACTION_ICONS.folder} ${esc(task.workingDir)}</span>` : '';
  const description = task.description?.trim();
  const colorKey = taskColor(task);
  const customClass = customColors[colorKey] ? ' custom-color' : '';
  return `<article class="card ${task.status} color-${colorKey}${customClass}${compact ? ' compact' : ''}"${customColorStyle(colorKey)}><div class="card-head"><div class="card-heading"><div class="card-title-row"><span class="card-status-icon ${task.status}" role="img" aria-label="状态：${esc(STATUS[task.status]?.label || '未知')}" title="${esc(STATUS[task.status]?.label || '未知状态')}">${STATUS_ICONS[task.status] || '•'}</span><h3 class="card-title" data-tooltip="${esc(task.title)}">${esc(task.title)}</h3><span class="spacer"></span>${task.deadline ? `<span class="deadline ${task.overdue ? 'overdue' : ''}">${ACTION_ICONS.calendar} ${deadline(task.deadline)}${task.overdue ? ' · 逾期' : ''}</span>` : ''}</div>${folder}</div></div>${description ? `<p class="card-desc" data-tooltip="${esc(description)}">${esc(description)}</p>` : ''}${archiveInfo}<div class="card-actions">${actions(task)}</div></article>`;
}
function visibleNotes() {
  const archived = state.status === 'archived';
  const query = state.search.toLowerCase();
  return state.notes.filter((note) => {
    if (archived) {
      if (note.status !== 'archived') return false;
    } else {
      if (note.status === 'archived') return false;
      if (state.noteFilter === 'normal' && (note.pinnedToTopBar || note.pinnedToSessionBar)) return false;
      if (state.noteFilter === 'topbar' && !note.pinnedToTopBar) return false;
      if (state.noteFilter === 'session' && !note.pinnedToSessionBar) return false;
    }
    return !query || `${note.title} ${note.description}`.toLowerCase().includes(query);
  }).sort((a, b) => {
    if (state.sort === 'deadline') return (a.deadline ? new Date(a.deadline).getTime() : Infinity) - (b.deadline ? new Date(b.deadline).getTime() : Infinity) || new Date(b.updatedAt) - new Date(a.updatedAt);
    if (state.sort === 'created') return new Date(b.createdAt) - new Date(a.createdAt);
    return new Date(b.updatedAt) - new Date(a.updatedAt);
  });
}
function noteCard(note, compact = false) {
  const colorKey = taskColor(note);
  const customClass = customColors[colorKey] ? ' custom-color' : '';
  const title = note.title?.trim();
  const deadlineText = note.deadline ? `<span class="deadline ${note.overdue ? 'overdue' : ''}">${ACTION_ICONS.calendar} ${deadline(note.deadline)}${note.overdue ? ' · 逾期' : ''}</span>` : '';
  const archiveInfo = note.status === 'archived' ? `<div class="archive-info">废弃${note.archivedAt ? ` · ${time(note.archivedAt)}` : ''}</div>` : '';
  const actionsHtml = note.status === 'archived'
    ? `${actionButton('restore-note', note.id, '恢复便签', 'restore')}${actionButton('purge-note', note.id, '永久删除便签', 'purge', 'danger')}`
    : `${actionButton('edit-note', note.id, '编辑便签', 'edit')}${actionButton('toggle-top-note', note.id, note.pinnedToTopBar ? '取消提醒标记' : '提醒标记', 'topbar', note.pinnedToTopBar ? 'note-pin-active' : '', note.pinnedToTopBar)}${actionButton('toggle-session-note', note.id, note.pinnedToSessionBar ? '取消会话标记' : '会话标记', 'session', note.pinnedToSessionBar ? 'note-pin-active' : '', note.pinnedToSessionBar)}${actionButton('delete-note', note.id, '废弃便签', 'delete', 'danger')}`;
  return `<article class="card note-card${note.status === 'archived' ? ' archived' : ''} color-${colorKey}${customClass}${compact ? ' compact' : ''}"${customColorStyle(colorKey)}><div class="card-head"><div class="card-heading"><div class="card-title-row">${title ? `<h3 class="card-title" data-tooltip="${esc(title)}">${esc(title)}</h3>` : '<span class="spacer"></span>'}${title ? '<span class="spacer"></span>' : ''}${deadlineText}</div></div></div><p class="card-desc" data-tooltip="${esc(note.description)}">${esc(note.description)}</p>${archiveInfo}<div class="card-actions">${actionsHtml}</div></article>`;
}
const NOTE_CATEGORY_GROUPS = [
  { label: '无标记', match: (note) => !note.pinnedToTopBar && !note.pinnedToSessionBar },
  { label: '提醒标记', match: (note) => note.pinnedToTopBar && !note.pinnedToSessionBar },
  { label: '会话标记', match: (note) => note.pinnedToSessionBar && !note.pinnedToTopBar },
  { label: '提醒标记 + 会话标记', match: (note) => note.pinnedToTopBar && note.pinnedToSessionBar },
];
function colorGroups(items, itemValue = (item) => item) {
  return Object.entries(colorCatalog()).map(([key, value]) => ({
    label: value.label,
    colorKey: key,
    colorValue: value.value,
    customColor: Boolean(customColors[key]),
    items: items.filter((item) => taskColor(itemValue(item)) === key),
  })).filter((group) => group.items.length > 0);
}
function boardGroupBadge(group) {
  const colorClass = group.colorKey ? ` color-group-badge color-${group.colorKey}${group.customColor ? ' custom-color' : ''}` : '';
  const colorStyle = group.customColor ? ` style="--task-color:${esc(group.colorValue)}"` : '';
  return `<span class="badge ${group.badgeClass || 'board-group-badge'}${colorClass}"${colorStyle} title="${esc(group.label)}">${esc(group.label)}</span>`;
}
function noteGroups(notes) {
  if (state.boardGroup === 'color') return colorGroups(notes);
  if (state.boardGroup === 'noteCategory') return NOTE_CATEGORY_GROUPS.map((group) => ({ label: group.label, items: notes.filter(group.match) })).filter((group) => group.items.length > 0);
  return [{ label: '便签', items: notes }];
}
function renderNotesList() {
  document.body.classList.add('board-mode');
  syncTaskToolbarTitle(); syncBoardFilter(); syncSortControl(); syncCardLayoutControl(); syncBoardGroupOptions();
  const notes = visibleNotes();
  const groups = noteGroups(notes);
  const compact = state.boardCardLayout === 'compact';
  const empty = `<div class="task-board-empty"><strong>${state.search ? '没有匹配的便签' : '还没有便签'}</strong><p>${state.search ? '试试调整搜索词。' : '创建一张便签，记录临时想法。'}</p>${state.search ? '<button type="button" data-action="clear-note-filters">清除搜索</button>' : ''}</div>`;
  const board = notes.length ? groups.map((group) => `<section class="task-board-column"><header class="task-board-head">${boardGroupBadge(group)}<b>${number(group.items.length)}</b></header><div class="task-board-list">${group.items.map((note) => noteCard(note, compact)).join('')}</div></section>`).join('') : empty;
  $('#task-list').innerHTML = `<div class="task-board${compact ? ' compact-card-layout' : ''}">${board}</div>`;
  syncMasonryColumns($('#task-list')); syncOverflowTooltips($('#task-list'));
}
function archivedGroups(items) {
  if (state.boardGroup === 'color') return colorGroups(items, (item) => item.value);
  if (state.archiveType === 'all' && state.boardGroup === 'kind') return [
    { label: '任务', items: items.filter((item) => item.kind === 'task') },
    { label: '便签', items: items.filter((item) => item.kind === 'note') },
    { label: '会话', items: items.filter((item) => item.kind === 'session') },
  ].filter((group) => group.items.length > 0);
  if (state.archiveType === 'tasks' && state.boardGroup === 'status') {
    return ['unfinished', 'done', 'archived'].map((key) => ({ label: STATUS[key].label, items: items.filter((item) => (item.value.archivedFromStatus || item.value.status) === key) })).filter((group) => group.items.length > 0);
  }
  if (state.archiveType === 'tasks' && state.boardGroup === 'path') {
    const groups = new Map();
    items.forEach((item) => {
      const key = item.value.workingDir || '未设置工作路径';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    });
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, 'zh-CN')).map(([label, groupItems]) => ({ label, items: groupItems }));
  }
  if (state.archiveType === 'notes' && state.boardGroup === 'noteCategory') return NOTE_CATEGORY_GROUPS.map((group) => ({ label: group.label, items: items.filter((item) => group.match(item.value)) })).filter((group) => group.items.length > 0);
  if (state.archiveType === 'sessions' && state.boardGroup === 'path') {
    const groups = new Map();
    items.forEach((item) => { const key = item.value.task.workingDir || '未设置工作路径'; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(item); });
    return [...groups.entries()].map(([label, groupItems]) => ({ label, items: groupItems }));
  }
  return [{ label: '废弃卡片', items }];
}
function archivedCard(item, compact) {
  if (item.kind === 'task') return card(item.value, compact);
  if (item.kind === 'note') return noteCard(item.value, compact);
  return sessionCard(item.value, compact);
}
function renderArchivedList() {
  document.body.classList.add('board-mode');
  syncTaskToolbarTitle(); syncBoardFilter(); syncSortControl(); syncCardLayoutControl(); syncBoardGroupOptions();
  const items = [
    ...(state.archiveType === 'all' || state.archiveType === 'tasks' ? visibleTasks().map((task) => ({ kind: 'task', value: task })) : []),
    ...(state.archiveType === 'all' || state.archiveType === 'notes' ? visibleNotes().map((note) => ({ kind: 'note', value: note })) : []),
    ...(state.archiveType === 'all' || state.archiveType === 'sessions' ? sessionEntries({ archived: true }).filter(({ task, session }) => !state.search || `${task.title} ${task.workingDir || ''} ${session.title || ''}`.toLowerCase().includes(state.search.toLowerCase())).map((entry) => ({ kind: 'session', value: entry })) : []),
  ].sort((a, b) => new Date(b.value.updatedAt) - new Date(a.value.updatedAt));
  const groups = archivedGroups(items);
  const compact = state.boardCardLayout === 'compact';
  const board = items.length ? groups.map((group) => `<section class="task-board-column"><header class="task-board-head">${boardGroupBadge(group)}<b>${number(group.items.length)}</b></header><div class="task-board-list">${group.items.map((item) => archivedCard(item, compact)).join('')}</div></section>`).join('') : '<div class="task-board-empty"><strong>回收站为空</strong></div>';
  $('#task-list').innerHTML = `<div class="task-board${compact ? ' compact-card-layout' : ''}">${board}</div>`;
  syncMasonryColumns($('#task-list')); syncOverflowTooltips($('#task-list'));
}
function boardGroupOptions() {
  if (state.status === 'archived') {
    if (state.archiveType === 'tasks') return [{ value: 'single', label: '全部' }, { value: 'status', label: '任务状态' }, { value: 'path', label: '工作路径' }, { value: 'color', label: '颜色' }];
    if (state.archiveType === 'notes') return [{ value: 'single', label: '全部' }, { value: 'noteCategory', label: '便签标记' }, { value: 'color', label: '颜色' }];
    if (state.archiveType === 'sessions') return [{ value: 'single', label: '全部' }, { value: 'path', label: '工作路径' }, { value: 'color', label: '颜色' }];
    return [{ value: 'single', label: '全部' }, { value: 'kind', label: '卡片类别' }, { value: 'color', label: '颜色' }];
  }
  if (state.boardType === 'notes') {
    const options = [{ value: 'single', label: '全部' }, { value: 'color', label: '按颜色' }];
    if (state.noteFilter === 'all') options.push({ value: 'noteCategory', label: '按便签类别' });
    return options;
  }
  if (state.boardType === 'sessions') {
    const options = [{ value: 'single', label: '全部' }, { value: 'path', label: '按路径' }, { value: 'color', label: '按任务颜色' }];
    if (state.sessionFilter === 'all' || state.sessionFilter === 'favorite') options.splice(1, 0, { value: 'status', label: '按运行状态' });
    options.splice(options.findIndex((option) => option.value === 'path'), 0, { value: 'task', label: '按所属任务' });
    return options;
  }
  const options = [{ value: 'single', label: '全部' }];
  if (!state.status) options.push({ value: 'status', label: '按状态' });
  options.push({ value: 'path', label: '按路径' }, { value: 'color', label: '按颜色' });
  return options;
}
function syncBoardGroupOptions() {
  const options = boardGroupOptions();
  const fallback = options[0]?.value || 'single';
  if (!options.some((option) => option.value === state.boardGroup)) updateViewSetting('boardGroup', fallback);
  const option = options.find((item) => item.value === state.boardGroup) || options[0];
  const button = $('#board-group-toggle');
  button.innerHTML = BOARD_GROUP_ICONS[option.value];
  button.title = `分布：${option.label}（点击切换）`;
  button.setAttribute('aria-label', button.title);
}
function boardGroups(tasks) {
  if (state.boardGroup === 'path') {
    const groups = new Map();
    tasks.forEach((task) => {
      const key = task.workingDir || '未设置工作路径';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(task);
    });
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, 'zh-CN')).map(([label, items]) => ({ label, items }));
  }
  if (state.boardGroup === 'color') {
    return colorGroups(tasks);
  }
  if (state.boardGroup === 'status' && !state.status) {
    return Object.keys(STATUS).map((key) => ({ label: STATUS[key].label, badgeClass: key, items: tasks.filter((task) => task.status === key) })).filter((group) => group.items.length > 0);
  }
  return [{ label: state.status ? STATUS[state.status]?.label || '当前分组' : '任务', items: tasks }];
}
function renderList() {
  if (state.status === 'archived') return renderArchivedList();
  if (state.boardType === 'notes') return renderNotesList();
  if (state.boardType === 'sessions') return renderSessionsList();
  document.body.classList.add('board-mode');
  syncTaskToolbarTitle();
  syncBoardFilter();
  syncSortControl();
  syncCardLayoutControl();
  syncBoardGroupOptions();
  const tasks = visibleTasks();
  const groups = boardGroups(tasks);
  const compact = state.boardCardLayout === 'compact';
  const clearArchived = state.status === 'archived' && tasks.length ? '<div class="archive-actions"><button type="button" class="danger" data-action="purge-archived">全部清空</button></div>' : '';
  const hasFilters = Boolean(state.search || state.status);
  const emptyState = `<div class="task-board-empty"><strong>${hasFilters ? '没有匹配的任务' : '还没有任务'}</strong><p>${hasFilters ? '试试调整搜索词或清除筛选条件。' : '创建一个任务，开始你的下一次执行。'}</p>${hasFilters ? '<button type="button" data-action="clear-filters">清除筛选</button>' : ''}</div>`;
  const board = groups.length && tasks.length ? groups.map((group) => `<section class="task-board-column"><header class="task-board-head">${boardGroupBadge(group)}<b>${number(group.items.length)}</b></header><div class="task-board-list">${group.items.map((task) => card(task, compact)).join('') || '<div class="task-board-empty">暂无任务</div>'}</div></section>`).join('') : emptyState;
  $('#task-list').innerHTML = clearArchived + `<div class="task-board${compact ? ' compact-card-layout' : ''}">${board}</div>`;
  syncMasonryColumns($('#task-list'));
  syncOverflowTooltips($('#task-list'));
}

function availableSessions(task) {
  return Array.isArray(task?.sessions) ? task.sessions.filter((session) => session.status !== 'archived') : [];
}
function archivedSessions(task) {
  return Array.isArray(task?.sessions) ? task.sessions.filter((session) => session.status === 'archived') : [];
}
function sessionEntries({ archived = false } = {}) {
  return state.tasks.flatMap((task) => (task.sessions || [])
    .filter((session) => (session.status === 'archived') === archived)
    .map((session) => ({ task, session })));
}
function sessionCard(entry, compact = false) {
  const { task, session } = entry;
  const isArchived = session.status === 'archived';
  const taskArchived = task.status === 'archived';
  const title = session.title || '新会话';
  const colorKey = taskColor(task);
  const customClass = customColors[colorKey] ? ' custom-color' : '';
  const current = state.module === 'session' && state.sessionTask === task.id && state.sessionSessionId === session.id;
  const unread = current ? 0 : (Number(session.unreadCount) || 0);
  const marker = sessionTreeMarker(session, unread);
  const stateIcon = `<span class="session-card-marker${sessionMarkerClassSuffix(session, unread)}" role="img" aria-label="${marker.actionLabel}" title="${marker.actionLabel}">${marker.icon}</span>`;
  const stats = session.stats || {};
  const totalTokens = (Number(stats.input) || 0) + (Number(stats.output) || 0) + (Number(stats.cacheRead) || 0) + (Number(stats.cacheWrite) || 0);
  const summary = stats.messages || totalTokens
    ? `总消息 ${compactNumber(stats.messages)} · 总 token ${compactNumber(totalTokens)} · 输入 ${compactNumber(stats.input)} · 输出 ${compactNumber(stats.output)}${session.unreadCount ? ` · 未读 ${compactNumber(session.unreadCount)}` : ''}`
    : '尚未开始对话';
  let actionsHtml;
  if (isArchived) {
    const restoreState = session.restorableWithTask ? '可随任务恢复' : '不可随任务恢复';
    const restoreTitle = session.restorableWithTask ? '恢复任务时将一并恢复此会话' : '该会话不会随任务恢复';
    const openButton = taskArchived ? '' : sessionActionButton('open-session-card', task.id, session.id, '打开会话（恢复并进入）', 'open', 'primary');
    const stateLabel = taskArchived ? `<span class="session-restore-state" title="${restoreTitle}">${restoreState}</span>` : '';
    actionsHtml = `${openButton}${stateLabel}${sessionActionButton('purge-session', task.id, session.id, '永久删除会话', 'purge', 'danger')}`;
  } else {
    const favoriteLabel = session.favorite ? '取消收藏' : '收藏';
    const favoriteClass = session.favorite ? 'note-pin-active' : '';
    actionsHtml = `${sessionActionButton('open-session-card', task.id, session.id, '打开会话', 'open', 'primary')}${sessionActionButton('toggle-session-favorite', task.id, session.id, favoriteLabel, 'star', favoriteClass, session.favorite)}${sessionActionButton('rename-session', task.id, session.id, '重命名会话', 'edit')}${sessionActionButton('delete-session-card', task.id, session.id, '删除会话', 'delete', 'danger')}`;
  }
  return `<article class="card session-card${isArchived ? ' archived' : ''} color-${colorKey}${customClass}${compact ? ' compact' : ''}"${customColorStyle(colorKey)}><div class="card-head"><div class="card-heading"><div class="card-title-row">${stateIcon}<h3 class="card-title" data-tooltip="${esc(title)}">${esc(title)}</h3></div><div class="session-card-task" data-tooltip="${esc(task.workingDir || '未设置工作路径')}">${ACTION_ICONS.folder} ${esc(task.workingDir || '未设置工作路径')}</div></div></div><p class="card-desc" data-tooltip="${esc(summary)}">${esc(summary)}</p><div class="session-card-meta"><span data-tooltip="${esc(task.title)}">${ACTION_ICONS.task} ${esc(task.title)}</span><span>${ACTION_ICONS.clock} 更新于 ${time(session.updatedAt)}</span></div>${isArchived ? `<div class="archive-info">废弃 · ${time(session.archivedAt)}</div>` : ''}<div class="card-actions">${actionsHtml}</div></article>`;
}
function visibleSessionEntries() {
  const query = state.search.toLowerCase();
  return sessionEntries().filter(({ task, session }) => {
    if (task.status === 'archived') return false;
    if (state.sessionFilter === 'favorite' && !session.favorite) return false;
    if (state.sessionFilter === 'running' && !session.running) return false;
    if (state.sessionFilter === 'stopped' && session.running) return false;
    return !query || `${task.title} ${task.workingDir || ''} ${session.title || ''}`.toLowerCase().includes(query);
  }).sort((a, b) => {
    if (state.sort === 'created') return new Date(b.session.createdAt) - new Date(a.session.createdAt);
    return new Date(b.session.updatedAt) - new Date(a.session.updatedAt);
  });
}
function sessionGroups(items) {
  if (state.boardGroup === 'status') {
    return [
      { label: '运行中', items: items.filter(({ session }) => session.running) },
      { label: '关闭中', items: items.filter(({ session }) => !session.running) },
    ].filter((group) => group.items.length > 0);
  }
  if (state.boardGroup === 'task') {
    const groups = new Map();
    items.forEach((entry) => { const key = entry.task.id; if (!groups.has(key)) groups.set(key, { label: entry.task.title, items: [] }); groups.get(key).items.push(entry); });
    return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
  }
  if (state.boardGroup === 'path') {
    const groups = new Map();
    items.forEach((entry) => { const key = entry.task.workingDir || '未设置工作路径'; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(entry); });
    return [...groups.entries()].map(([label, groupItems]) => ({ label, items: groupItems }));
  }
  if (state.boardGroup === 'color') return colorGroups(items, (entry) => entry.task);
  return [{ label: '会话', items }];
}
function renderSessionsList() {
  document.body.classList.add('board-mode');
  syncTaskToolbarTitle(); syncBoardFilter(); syncSortControl(); syncCardLayoutControl(); syncBoardGroupOptions();
  const entries = visibleSessionEntries();
  const groups = sessionGroups(entries);
  const compact = state.boardCardLayout === 'compact';
  const empty = `<div class="task-board-empty"><strong>${state.search ? '没有匹配的会话' : '还没有会话'}</strong><p>${state.search ? '试试调整搜索词。' : '创建任务并新建会话，开始协作。'}</p>${state.search ? '<button type="button" data-action="clear-session-filters">清除搜索</button>' : ''}</div>`;
  const board = entries.length ? groups.map((group) => `<section class="task-board-column"><header class="task-board-head">${boardGroupBadge(group)}<b>${number(group.items.length)}</b></header><div class="task-board-list">${group.items.map((entry) => sessionCard(entry, compact)).join('')}</div></section>`).join('') : empty;
  $('#task-list').innerHTML = `<div class="task-board${compact ? ' compact-card-layout' : ''}">${board}</div>`;
  syncMasonryColumns($('#task-list')); syncOverflowTooltips($('#task-list'));
}
function showSessionTask(taskId) {
  state.sessionTaskIds.add(taskId);
  state.hiddenCompletedSessionTasks.delete(taskId);
  saveLayoutState();
}
function sessionTasks() {
  return state.tasks.filter((task) => (availableSessions(task).length > 0 || state.sessionTaskIds.has(task.id)) && !state.hiddenCompletedSessionTasks.has(task.id));
}
function sessionTreeText(value) {
  return String(value || '').trim().toLocaleLowerCase('zh-CN');
}
function workingPathLabel(path) {
  const normalized = String(path || '').trim().replace(/[\\/]+$/, '');
  if (!normalized) return '未设置工作路径';
  return normalized.split(/[\\/]/).pop() || normalized;
}
function sessionTreeTime(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}
function sessionTreeLatestUpdate(task) {
  return Math.max(sessionTreeTime(task?.updatedAt), ...availableSessions(task).map((session) => sessionTreeTime(session.updatedAt)));
}
function sessionTreeCompareText(a, b) {
  return sessionTreeText(a).localeCompare(sessionTreeText(b), 'zh-CN', { numeric: true, sensitivity: 'base' });
}
function sessionTreeCompareTasks(a, b) {
  const option = sessionTreeSort;
  let result = 0;
  if (option === 'created') result = sessionTreeTime(b.createdAt) - sessionTreeTime(a.createdAt);
  else if (option === 'updated') result = sessionTreeLatestUpdate(b) - sessionTreeLatestUpdate(a);
  else if (option === 'title') result = sessionTreeCompareText(a.title, b.title);
  else if (option === 'path') result = sessionTreeCompareText(a.workingDir, b.workingDir);
  else if (option === 'color') {
    const colors = Object.keys(colorCatalog());
    result = (colors.indexOf(taskColor(a)) + 1 || Number.MAX_SAFE_INTEGER) - (colors.indexOf(taskColor(b)) + 1 || Number.MAX_SAFE_INTEGER);
  } else if (option === 'status') {
    const statusOrder = { unfinished: 0, done: 1, archived: 2 };
    result = (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99);
  }
  return result || sessionTreeCompareText(a.title, b.title) || String(a.id || '').localeCompare(String(b.id || ''));
}
function sessionTreeCompareSessions(a, b) {
  let result = 0;
  if (sessionTreeSort === 'created') result = sessionTreeTime(b.createdAt) - sessionTreeTime(a.createdAt);
  else if (sessionTreeSort === 'updated') result = sessionTreeTime(b.updatedAt) - sessionTreeTime(a.updatedAt);
  else if (sessionTreeSort === 'title') result = sessionTreeCompareText(a.title, b.title);
  return result || sessionTreeCompareText(a.title, b.title) || String(a.id || '').localeCompare(String(b.id || ''));
}
function sessionTreeVisibleTasks() {
  const query = sessionTreeText(sessionTreeQuery);
  return sessionTasks().map((task) => {
    const taskMatches = !query || sessionTreeText(task.title).includes(query);
    const sessions = availableSessions(task).filter((session) => taskMatches || sessionTreeText(session.title || '新会话').includes(query)).sort(sessionTreeCompareSessions);
    return { task, sessions, taskMatches };
  }).filter(({ sessions, taskMatches }) => !query || taskMatches || sessions.length).sort(({ task: a }, { task: b }) => sessionTreeCompareTasks(a, b));
}
function sessionSwitchMetaText(label) {
  return `<span class="session-switch-meta-text">${esc(label)}</span>`;
}
function sessionSwitchMetaGroup(...items) {
  return `<span class="session-switch-option-meta">${items.join('')}</span>`;
}
function taskSwitchStatusIcon(status) {
  const normalizedStatus = STATUS[status] ? status : 'unfinished';
  const label = STATUS[normalizedStatus].label;
  return `<span class="card-status-icon ${normalizedStatus}" role="img" aria-label="状态：${esc(label)}" title="${esc(label)}">${STATUS_ICONS[normalizedStatus]}</span>`;
}
function sessionSwitchSessionMarker(session, current = false) {
  const unread = current ? 0 : (Number(session.unreadCount) || 0);
  const marker = sessionTreeMarker(session, unread);
  return `<span class="session-card-marker session-switch-marker${sessionMarkerClassSuffix(session, unread)}" role="img" aria-label="${marker.actionLabel}" title="${marker.actionLabel}">${marker.icon}</span>`;
}
function sessionSwitchOptionMarkup(label, attributes, active = false, metaHtml = '') {
  return `<button type="button" role="menuitem" class="session-switch-option${active ? ' active' : ''}" ${attributes}><span class="session-switch-option-label" data-tooltip="${esc(label)}">${esc(label)}</span>${metaHtml}</button>`;
}
function sessionTasksWithChildren() {
  return sessionTasks().filter((item) => availableSessions(item).length > 0);
}
function sessionTasksWithChildrenForPath(path = currentTask(state.sessionTask)?.workingDir || '') {
  return sessionTasksWithChildren().filter((task) => (task.workingDir || '') === path);
}
function sessionPathSwitchOptions() {
  const groups = new Map();
  sessionTasksWithChildren().forEach((task) => {
    const path = task.workingDir || '';
    if (!groups.has(path)) groups.set(path, []);
    groups.get(path).push(task);
  });
  return [...groups.entries()].map(([path, tasks]) => ({ path, tasks })).sort((a, b) => sessionTreeCompareText(a.path || '未设置工作路径', b.path || '未设置工作路径'));
}
function sessionSwitchEntries(task) {
  if (!task) return [];
  const visibleTasks = sessionTreeVisibleTasks();
  if (state.sessionTreeGroupMode === 'path') {
    const path = task.workingDir || '未设置工作路径';
    return sessionTreePathGroups(visibleTasks).find((group) => group.path === path)?.entries || [];
  }
  const visibleTask = visibleTasks.find((entry) => entry.task.id === task.id);
  return visibleTask ? visibleTask.sessions.map((session) => ({ task: visibleTask.task, session })) : [];
}
function lastOpenedSessionForPath(path) {
  const tasks = sessionPathSwitchOptions().find((item) => item.path === path)?.tasks || [];
  const entries = tasks.flatMap((task) => availableSessions(task).map((session) => ({ task, session })));
  return entries.sort(({ session: a }, { session: b }) => sessionTreeTime(b.updatedAt) - sessionTreeTime(a.updatedAt))[0] || null;
}
function renderSessionSwitchMenus(task, sessions) {
  const pathMenu = $('#session-path-switch-menu');
  const taskMenu = $('#session-task-switch-menu');
  const sessionMenu = $('#session-session-switch-menu');
  const pathMode = state.sessionTreeGroupMode === 'path';
  const combinedMode = state.sessionTreeGroupMode === 'combined';
  const pathOptions = sessionPathSwitchOptions();
  const currentPath = task?.workingDir || '';
  pathMenu.setAttribute('aria-label', '切换工作路径');
  pathMenu.innerHTML = pathOptions.length
    ? pathOptions.map((item) => sessionSwitchOptionMarkup(
      item.path || '未设置工作路径',
      `data-session-switch-path="${esc(item.path)}"`,
      item.path === currentPath,
    )).join('')
    : '<span class="session-switch-empty">暂无具有子会话的工作路径</span>';
  const taskOptions = combinedMode ? sessionTasksWithChildrenForPath(currentPath) : sessionTasksWithChildren();
  taskMenu.setAttribute('aria-label', '切换任务');
  taskMenu.innerHTML = taskOptions.length
    ? taskOptions.map((item) => sessionSwitchOptionMarkup(
      item.title || '未命名任务',
      `data-session-switch-task="${esc(item.id)}"`,
      item.id === state.sessionTask,
      sessionSwitchMetaGroup(taskSwitchStatusIcon(item.status)),
    )).join('')
    : '<span class="session-switch-empty">暂无具有子会话的任务</span>';
  sessionMenu.innerHTML = sessions.length
    ? sessions.map(({ task: sessionTask, session: item }) => sessionSwitchOptionMarkup(
      item.title || '新会话',
      `data-session-switch-session="${esc(item.id)}" data-session-switch-task="${esc(sessionTask.id)}"`,
      item.id === state.sessionSessionId,
      sessionSwitchMetaGroup(sessionSwitchSessionMarker(item, item.id === state.sessionSessionId)),
    )).join('')
    : '<span class="session-switch-empty">暂无可用子会话</span>';
  pathMenu.classList.toggle('hidden', !pathMode && !combinedMode || sessionSwitchMenuOpen !== 'path');
  taskMenu.classList.toggle('hidden', pathMode || sessionSwitchMenuOpen !== 'task');
  sessionMenu.classList.toggle('hidden', sessionSwitchMenuOpen !== 'session');
  $('#session-path-name').setAttribute('aria-expanded', String(sessionSwitchMenuOpen === 'path'));
  $('#session-task-name').setAttribute('aria-expanded', String(sessionSwitchMenuOpen === 'task'));
  $('#session-name').setAttribute('aria-expanded', String(sessionSwitchMenuOpen === 'session'));
}
function renderSessionHeader() {
  const task = currentTask(state.sessionTask);
  renderSessionNoteButtons();
  $('#session-view').classList.toggle('no-session', !task);
  const sessionEntries = sessionSwitchEntries(task);
  const child = availableSessions(task).find((session) => session.id === state.sessionSessionId);
  const sessionName = child ? (child.title || '新会话') : (task ? '新会话' : '选择一个子会话');
  const taskName = task?.title?.trim() || '';
  const pathMode = state.sessionTreeGroupMode === 'path';
  const combinedMode = state.sessionTreeGroupMode === 'combined';
  const showPath = pathMode || combinedMode;
  const showTask = !pathMode;
  const pathName = task ? workingPathLabel(task.workingDir) : '';
  const pathTooltip = task?.workingDir || '未设置工作路径';
  const displayName = task
    ? (combinedMode ? `${pathName} / ${taskName} / ${sessionName}` : `${showPath ? pathName : taskName} / ${sessionName}`)
    : sessionName;
  const pathNameNode = $('#session-path-name');
  const taskNameNode = $('#session-task-name');
  const pathTaskSeparatorNode = $('#session-path-task-separator');
  const sessionSeparatorNode = $('#session-title-separator');
  pathNameNode.textContent = pathName || '选择工作路径';
  pathNameNode.classList.toggle('hidden', !showPath || !pathName);
  pathNameNode.disabled = !task;
  pathNameNode.title = task ? '切换工作路径' : '暂无可用工作路径';
  pathNameNode.setAttribute('aria-label', task ? '切换工作路径' : '暂无可用工作路径');
  pathNameNode.dataset.tooltip = pathTooltip;
  taskNameNode.textContent = taskName || '选择任务';
  taskNameNode.classList.toggle('hidden', !showTask || !taskName);
  taskNameNode.disabled = !task;
  taskNameNode.title = task ? '切换任务' : '暂无可用任务';
  taskNameNode.setAttribute('aria-label', task ? '切换任务' : '暂无可用任务');
  taskNameNode.dataset.tooltip = taskName || '选择任务';
  pathTaskSeparatorNode.classList.toggle('hidden', !showPath || !pathName || !showTask || !taskName);
  sessionSeparatorNode.classList.toggle('hidden', !(showTask ? taskName : pathName));
  $('#session-name').textContent = sessionName;
  $('#session-name').disabled = !task || !sessionEntries.length;
  $('#session-name').title = task && sessionEntries.length ? '切换子会话' : '暂无可用子会话';
  $('#session-name').dataset.tooltip = displayName;
  if (!task) {
    sessionTaskDetailsOpen = false;
    sessionActionMenuOpen = false;
    sessionSwitchMenuOpen = null;
  }
  renderSessionSwitchMenus(task, sessionEntries);
  const titleRow = $('#session-name').closest('.session-title-row');
  syncOverflowTooltips(titleRow);
  requestAnimationFrame(() => syncOverflowTooltips(titleRow));
  const sessionActionsButton = $('#copy-session-file');
  const actionMenu = $('#session-action-menu');
  const description = task?.description?.trim() || '';
  const sessionPath = child?.sessionFile || '';
  sessionActionsButton.disabled = !task;
  sessionActionsButton.title = task ? '会话操作' : '暂无会话操作';
  sessionActionsButton.setAttribute('aria-label', sessionActionsButton.title);
  sessionActionsButton.setAttribute('aria-expanded', String(Boolean(task && sessionActionMenuOpen)));
  actionMenu.classList.toggle('hidden', !task || !sessionActionMenuOpen);
  $('#session-action-copy-command').disabled = !sessionPath;
  $('#session-action-copy-description').disabled = !description;
  $('#session-action-copy-working-dir').disabled = !task?.workingDir?.trim();
  $('#session-action-rename').disabled = !child;
  $('#session-task-details-panel').classList.toggle('hidden', !task || !sessionTaskDetailsOpen);
  $('#session-task-title-detail').textContent = task?.title || '暂无任务标题';
  $('#session-description-text').textContent = description || '暂无任务描述';
  $('#session-working-dir-detail').textContent = task?.workingDir?.trim() || '未设置工作路径';
  $('#session-file-path-detail').textContent = sessionPath || '暂无会话文件路径';
  $('#session-task-select').innerHTML = '<option value="">选择一个任务会话</option>' + sessionTasks().filter((item) => availableSessions(item).length > 0).map((item) => `<option value="${item.id}"${item.id === state.sessionTask ? ' selected' : ''}>${esc(item.title)}</option>`).join('');
}
function closeSessionTaskDetails() {
  if (!sessionTaskDetailsOpen) return;
  sessionTaskDetailsOpen = false;
  renderSessionHeader();
}
function closeSessionActionMenu() {
  if (!sessionActionMenuOpen) return;
  sessionActionMenuOpen = false;
  const menu = $('#session-action-menu');
  const button = $('#copy-session-file');
  menu?.classList.add('hidden');
  button?.setAttribute('aria-expanded', 'false');
}
function closeSessionSwitchMenu() {
  if (!sessionSwitchMenuOpen) return;
  sessionSwitchMenuOpen = null;
  const task = currentTask(state.sessionTask);
  renderSessionSwitchMenus(task, sessionSwitchEntries(task));
}
function sessionTaskHasRunningSessions(task) {
  return Boolean(task?.piRunning || availableSessions(task).some((session) => session.running));
}
function syncSessionTreeActions(tasks) {
  const root = $('#session-tree');
  for (const button of root.querySelectorAll('[data-remove-completed-task]')) {
    const task = tasks.find((item) => item.id === button.dataset.removeCompletedTask);
    if (!task) continue;
    const running = sessionTaskHasRunningSessions(task);
    const label = running ? `关闭任务「${task.title}」下的全部子会话` : '从会话栏移除任务及其子会话';
    button.innerHTML = running ? ACTION_ICONS.stop : ACTION_ICONS.close;
    button.classList.toggle('running', running);
    button.title = label;
    button.setAttribute('aria-label', label);
  }
  for (const button of root.querySelectorAll('[data-remove-session-path]')) {
    const path = button.dataset.removeSessionPath;
    const pathTasks = tasks.filter((task) => (task.workingDir || '未设置工作路径') === path);
    const running = pathTasks.some(sessionTaskHasRunningSessions);
    const label = running ? `关闭工作路径「${workingPathLabel(path === '未设置工作路径' ? '' : path)}」下的全部子会话` : '从会话栏移除工作路径及其子会话';
    button.innerHTML = running ? ACTION_ICONS.stop : ACTION_ICONS.close;
    button.classList.toggle('running', running);
    button.title = label;
    button.setAttribute('aria-label', label);
  }
}
function syncSessionTreeUnread(tasks) {
  const root = $('#session-tree');
  syncSessionTreeActions(tasks);
  for (const task of tasks) {
    for (const session of availableSessions(task)) {
      const row = [...root.querySelectorAll('.session-child-session')].find((item) => item.dataset.sessionTask === task.id && item.dataset.sessionId === session.id);
      if (!row) continue;
      const current = state.module === 'session' && state.sessionTask === task.id && state.sessionSessionId === session.id;
      const unread = current ? 0 : (Number(session.unreadCount) || 0);
      const title = session.title || '新会话';
      const unreadLabel = unread > 99 ? '99+' : String(unread);
      const marker = sessionTreeMarker(session, unread);
      const favoriteButton = row.querySelector('.child-favorite');
      if (favoriteButton) {
        favoriteButton.innerHTML = marker.icon;
        favoriteButton.classList.toggle('favorite', Boolean(session.favorite));
        favoriteButton.classList.toggle('unread', unread > 0);
        favoriteButton.classList.toggle('running', Boolean(session.running));
        favoriteButton.classList.toggle('stopped', !session.running);
        favoriteButton.title = marker.actionLabel;
        favoriteButton.setAttribute('aria-label', marker.actionLabel);
        favoriteButton.setAttribute('aria-pressed', String(Boolean(session.favorite)));
      }
      row.querySelector('.session-child-open')?.setAttribute('aria-label', `${title}${unread ? `，${unreadLabel}条未读消息` : ''}`);
      const deleteButton = row.querySelector('.session-child-delete');
      if (deleteButton) {
        const sessionActionLabel = session.running ? '关闭会话' : '删除会话';
        deleteButton.innerHTML = session.running ? ACTION_ICONS.stop : ACTION_ICONS.delete;
        deleteButton.title = sessionActionLabel;
        deleteButton.setAttribute('aria-label', sessionActionLabel);
      }
    }
  }
}
function sessionMarkerClassSuffix(session, unread) {
  return `${session.favorite ? ' favorite' : ''}${unread > 0 ? ' unread' : ''}${session.running ? ' running' : ' stopped'}`;
}
function sessionTreeMarker(session, unread) {
  const hasUnread = unread > 0;
  const favorite = Boolean(session.favorite);
  const running = Boolean(session.running);
  const icon = favorite
    ? `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path class="session-marker-${hasUnread ? 'filled' : 'outline'}" d="M12 3.5 14.63 8.83l5.88.85-4.25 4.14 1 5.85L12 16.91l-5.26 2.76 1-5.85-4.25-4.14 5.88-.85L12 3.5Z"/></svg>`
    : `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle class="session-marker-${hasUnread ? 'filled' : 'outline'}" cx="12" cy="12" r="6.5"/></svg>`;
  const action = favorite ? '取消收藏会话' : '收藏会话';
  const unreadText = hasUnread ? `${unread > 99 ? '99+' : unread}条未读消息` : '无未读消息';
  return { icon, actionLabel: `${running ? '运行中' : '关闭中'}，${action}，${unreadText}` };
}
function sessionItemMarkup(task, session, index) {
  const title = session.title || `子会话 ${index + 1}`;
  const current = state.module === 'session' && state.sessionTask === task.id && state.sessionSessionId === session.id;
  const unread = current ? 0 : (Number(session.unreadCount) || 0);
  const unreadLabel = unread > 99 ? '99+' : String(unread);
  const marker = sessionTreeMarker(session, unread);
  const sessionActionLabel = session.running ? '关闭会话' : '删除会话';
  const sessionActionIcon = session.running ? ACTION_ICONS.stop : ACTION_ICONS.delete;
  return `<div class="session-child-session${current ? ' active' : ''}" data-session-task="${esc(task.id)}" data-session-id="${esc(session.id)}"><button type="button" class="child-favorite${sessionMarkerClassSuffix(session, unread)}" data-favorite-session-task="${esc(task.id)}" data-favorite-session-id="${esc(session.id)}" title="${marker.actionLabel}" aria-label="${marker.actionLabel}" aria-pressed="${Boolean(session.favorite)}">${marker.icon}</button><button type="button" class="session-child-open" aria-label="${esc(title)}${unread ? `，${unreadLabel}条未读消息` : ''}"><span class="session-title-text-viewport"><span class="session-child-name session-title-text" data-tooltip="${esc(title)}">${esc(title)}</span>${session.kind === 'dsh' ? '<span class="session-kind-badge" title="dsh 会话">dsh</span>' : ''}</span></button><button type="button" class="session-child-delete" data-delete-session="${esc(task.id)}" data-session-id="${esc(session.id)}" title="${sessionActionLabel}" aria-label="${sessionActionLabel}">${sessionActionIcon}</button></div>`;
}
function sessionGroupMarkup(task, visibleSessions = availableSessions(task), className = '') {
  const collapsed = state.collapsedSessionTasks.has(task.id);
  const colorKey = taskColor(task);
  const customClass = customColors[colorKey] ? ' custom-color' : '';
  const running = sessionTaskHasRunningSessions(task);
  const removeLabel = running ? `关闭任务「${task.title}」下的全部子会话` : '从会话栏移除任务及其子会话';
  const taskStatus = STATUS[task.status] ? task.status : 'unfinished';
  const taskStatusLabel = STATUS[taskStatus].label;
  const taskStatusIcon = `<span class="card-status-icon session-task-status-icon ${taskStatus}" role="img" aria-label="状态：${esc(taskStatusLabel)}" title="${esc(taskStatusLabel)}">${STATUS_ICONS[taskStatus]}</span>`;
  const taskActions = `<button type="button" class="session-new-child" data-new-session-task="${esc(task.id)}" title="新建子会话" aria-label="为${esc(task.title)}新建子会话">＋</button><button type="button" class="session-remove-task${running ? ' running' : ''}" data-remove-completed-task="${esc(task.id)}" title="${esc(removeLabel)}" aria-label="${esc(removeLabel)}">${running ? ACTION_ICONS.stop : ACTION_ICONS.close}</button>`;
  const sessions = visibleSessions.map((session, index) => sessionItemMarkup(task, session, index)).join('');
  const items = collapsed ? '' : sessions;
  return `<div class="session-task-group${className ? ` ${className}` : ''}"><div class="session-task-heading"><button type="button" class="session-task-title color-${colorKey}${customClass}"${customColorStyle(colorKey)} data-session-group="${esc(task.id)}" aria-label="${esc(task.title)}" aria-expanded="${!collapsed}">${taskStatusIcon}<span class="session-title-text-viewport"><span class="session-title-text" data-tooltip="${esc(task.title)}">${esc(task.title)}</span></span></button>${taskActions}</div>${items}</div>`;
}
function sessionTreePathGroups(visibleTasks) {
  const groups = new Map();
  visibleTasks.forEach(({ task, sessions }) => {
    const path = task.workingDir || '未设置工作路径';
    if (!groups.has(path)) groups.set(path, []);
    const group = groups.get(path);
    group.push({ task, sessions, entries: sessions.map((session) => ({ task, session })) });
  });
  return [...groups.entries()].map(([path, tasks]) => ({
    path,
    tasks: tasks.sort(({ task: a }, { task: b }) => sessionTreeCompareTasks(a, b)),
    entries: tasks.flatMap(({ entries }) => entries).sort(({ session: a }, { session: b }) => sessionTreeCompareSessions(a, b)),
  })).sort((a, b) => sessionTreeCompareText(a.path, b.path));
}
function sessionPathActionsMarkup(path, tasks) {
  const label = workingPathLabel(path === '未设置工作路径' ? '' : path);
  const running = tasks.some(({ task }) => sessionTaskHasRunningSessions(task));
  const removeLabel = running ? `关闭工作路径「${label}」下的全部子会话` : '从会话栏移除工作路径及其子会话';
  return `<button type="button" class="session-new-child" data-new-session-path="${esc(path)}" title="新建会话" aria-label="在工作路径${esc(path)}下新建会话">＋</button><button type="button" class="session-remove-task${running ? ' running' : ''}" data-remove-session-path="${esc(path)}" title="${esc(removeLabel)}" aria-label="${esc(removeLabel)}">${running ? ACTION_ICONS.stop : ACTION_ICONS.close}</button>`;
}
function sessionPathGroupMarkup(path, entries) {
  const collapsed = state.collapsedSessionPaths.has(path);
  const sessions = collapsed ? '' : entries.map(({ task, session }, index) => sessionItemMarkup(task, session, index)).join('');
  const label = workingPathLabel(path === '未设置工作路径' ? '' : path);
  const pathTasks = [...new Map(entries.map(({ task }) => [task.id, task])).values()];
  const actions = sessionPathActionsMarkup(path, pathTasks.map((task) => ({ task })));
  return `<div class="session-task-group session-path-group"><div class="session-task-heading session-path-heading"><button type="button" class="session-task-title color-gray" data-session-path-group="${esc(path)}" aria-label="${esc(path)}" aria-expanded="${!collapsed}"><span aria-hidden="true">${collapsed ? '▸' : '▾'}</span><span class="session-title-text-viewport"><span class="session-title-text" data-tooltip="${esc(path)}">${esc(label)}</span></span></button>${actions}</div>${sessions}</div>`;
}
function sessionCombinedPathGroupMarkup(path, tasks) {
  const collapsed = state.collapsedSessionPaths.has(path);
  const label = workingPathLabel(path === '未设置工作路径' ? '' : path);
  const actions = sessionPathActionsMarkup(path, tasks);
  const items = collapsed ? '' : tasks.map(({ task, sessions }) => sessionGroupMarkup(task, sessions, 'session-combined-task-group')).join('');
  return `<div class="session-task-group session-path-group session-combined-path-group"><div class="session-task-heading session-path-heading"><button type="button" class="session-task-title color-gray" data-session-path-group="${esc(path)}" aria-label="${esc(path)}" aria-expanded="${!collapsed}"><span aria-hidden="true">${collapsed ? '▸' : '▾'}</span><span class="session-title-text-viewport"><span class="session-title-text" data-tooltip="${esc(path)}">${esc(label)}</span></span></button>${actions}</div>${items}</div>`;
}
function renderSessionTree() {
  renderSessionHeader();
  const visibleTasks = sessionTreeVisibleTasks();
  const tasks = sessionTasks();
  const pathGroups = sessionTreePathGroups(visibleTasks);
  // 终端输入/输出也会触发刷新；树结构未变化时不要重建 DOM，避免标题滚动动画从头开始。
  const treeSignature = JSON.stringify({
    module: state.module,
    sessionTask: state.sessionTask,
    sessionSessionId: state.sessionSessionId,
    query: sessionTreeQuery,
    sort: sessionTreeSort,
    groupMode: state.sessionTreeGroupMode,
    collapsed: [...state.collapsedSessionTasks].sort(),
    collapsedPaths: [...state.collapsedSessionPaths].sort(),
    tasks: visibleTasks.map(({ task, sessions }) => [task.id, task.title, task.status, task.color, task.createdAt, task.updatedAt, sessions.map((session) => [session.id, session.title, session.favorite, session.createdAt, session.updatedAt])]),
  });
  if (treeSignature === renderedSessionTreeSignature) {
    syncSessionTreeUnread(tasks);
    return;
  }
  renderedSessionTreeSignature = treeSignature;
  const emptyText = sessionTreeText(sessionTreeQuery) ? '没有匹配的任务或会话' : '暂无可打开的会话';
  $('#session-tree').innerHTML = visibleTasks.length
    ? state.sessionTreeGroupMode === 'path'
      ? pathGroups.map(({ path, entries }) => sessionPathGroupMarkup(path, entries)).join('')
      : state.sessionTreeGroupMode === 'combined'
        ? pathGroups.map(({ path, tasks }) => sessionCombinedPathGroupMarkup(path, tasks)).join('')
        : visibleTasks.map(({ task, sessions }) => sessionGroupMarkup(task, sessions)).join('')
    : `<div class="empty sidebar-empty">${emptyText}</div>`;
  syncOverflowTooltips($('#session-tree'));
  syncSessionTreeUnread(tasks);
}
async function refresh() {
  try {
    const [data, noteData] = await Promise.all([api('/tasks'), api('/notes')]);
    const signature = JSON.stringify({ tasks: data.tasks.map((task) => [task.id, task.status, task.updatedAt, task.activeSessionId, task.sessions?.map((session) => [session.id, session.status, session.running, session.favorite, session.unreadCount, session.updatedAt])]), notes: noteData.notes.map((note) => [note.id, note.updatedAt, note.pinnedToTopBar, note.pinnedToSessionBar]) });
    state.tasks = data.tasks;
    state.notes = noteData.notes;
    renderPinnedNotes();
    const taskIds = new Set(data.tasks.map((task) => task.id));
    const sessionKeys = new Set(data.tasks.flatMap((task) => availableSessions(task).map((session) => sessionMarkerKey(task.id, session.id))));
    for (const key of [...seenSessionMessageIds.keys()]) if (!sessionKeys.has(key)) seenSessionMessageIds.delete(key);
    for (const key of [...readRequests.keys()]) if (!sessionKeys.has(key)) readRequests.delete(key);
    let layoutChanged = false;
    for (const taskId of [...state.sessionTaskIds]) {
      if (!taskIds.has(taskId)) { state.sessionTaskIds.delete(taskId); layoutChanged = true; }
    }
    for (const taskId of [...state.hiddenCompletedSessionTasks]) {
      if (!taskIds.has(taskId)) { state.hiddenCompletedSessionTasks.delete(taskId); layoutChanged = true; }
    }
    data.tasks.forEach((task) => { if (availableSessions(task).length > 0) state.sessionTaskIds.add(task.id); });
    if (layoutChanged) saveLayoutState();
    rememberCurrentSessionMessage();
    if (state.sessionTask && (!currentTask(state.sessionTask) || !(currentTask(state.sessionTask).sessions || []).some((session) => session.id === state.sessionSessionId))) {
      detachTui();
      state.sessionTask = null;
      state.sessionSessionId = null;
      saveLayoutState();
    }
    renderStats(); renderTaskSidebar(); renderSessionTree();
    if (signature !== state.signature && !$('.modal')) renderList();
    state.signature = signature;
    if (!layoutInitialized) {
      layoutInitialized = true;
      if (state.module === 'session') {
        switchModule('session');
        const task = currentTask(state.sessionTask);
        if (task && sessionTasks().some((item) => item.id === task.id) && availableSessions(task).length > 0) selectSession(task.id, state.sessionSessionId, { record: false, autoHandoff: false });
        else {
          state.sessionTask = null;
          state.sessionSessionId = null;
          renderSessionTree();
          saveLayoutState();
        }
      }
    }
  } catch (error) { toast(error.message, 'error'); }
}

function terminalFontFamily() {
  // CSS 是主题字体的唯一来源；xterm 与工作台主题共享同一变量。
  const configured = getComputedStyle(document.body).getPropertyValue('--terminal-font-family').trim();
  if (configured) return configured;
  const platform = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '';
  const mac = /mac/i.test(platform);
  if (document.body.classList.contains('theme-geek')) {
    return mac
      ? '"JetBrains Mono", "SFMono-Regular", Menlo, "PingFang SC", monospace'
      : '"JetBrains Mono", "DengXian", "等线", "Microsoft YaHei UI", monospace';
  }
  if (document.body.classList.contains('theme-aurora')) {
    return mac
      ? '"SFMono-Regular", Menlo, "PingFang SC", monospace'
      : '"Cascadia Mono", "Microsoft YaHei UI", monospace';
  }
  if (document.body.classList.contains('theme-newspaper')) {
    // macOS 使用 Kaiti SC / STKaiti 注册楷体，Windows 则通常使用 KaiTi。
    const macKaiti = mac ? '"Kaiti SC", "STKaiti", ' : '';
    return `"Courier New", ${macKaiti}"KaiTi", "楷体", "Courier Prime", monospace`;
  }
  return mac
    ? '"SFMono-Regular", Menlo, "PingFang SC", monospace'
    : 'Consolas, "Cascadia Mono", "Microsoft YaHei UI", monospace';
}
function terminalTheme() {
  const styles = getComputedStyle(document.body);
  const cssVar = (name) => styles.getPropertyValue(name).trim();
  // 终端与工作区使用同一主题底色，避免切换主题后出现色差。
  const background = cssVar('--bg');
  const foreground = cssVar('--terminal-ink') || cssVar('--ink');
  const muted = cssVar('--terminal-muted') || cssVar('--muted');
  const accent = cssVar('--terminal-accent') || cssVar('--accent');
  const selectionBackground = cssVar('--terminal-selection') || cssVar('--accent-soft');
  const dark = isTerminalDark();
  let theme = 'classic';
  if (document.body.classList.contains('theme-geek')) theme = 'geek';
  else if (document.body.classList.contains('theme-newspaper')) theme = 'newspaper';
  else if (document.body.classList.contains('theme-aurora')) theme = 'aurora';
  const palettes = {
    classic: {
      light: { black: '#172b36', red: '#c84822', green: '#2f855a', yellow: '#a16207', blue: '#075985', magenta: '#7c3aed', cyan: '#078c86', white: '#fbfcfa' },
      dark: { black: '#10252d', red: '#ff8b72', green: '#7fd69b', yellow: '#f6c85f', blue: '#8cc8ff', magenta: '#d4a5ff', cyan: '#67d8d1', white: '#e6f0ed' },
    },
    geek: {
      light: { black: '#17251f', red: '#b42318', green: '#166534', yellow: '#8a5a00', blue: '#075985', magenta: '#6b21a8', cyan: '#0f766e', white: '#fbfdfb' },
      dark: { black: '#0b120e', red: '#fb7185', green: '#4ade80', yellow: '#facc15', blue: '#7dd3fc', magenta: '#c4b5fd', cyan: '#5eead4', white: '#e5f3ea' },
    },
    aurora: {
      light: { black: '#25213f', red: '#c2415d', green: '#2f855a', yellow: '#a16207', blue: '#0ea5e9', magenta: '#7c3aed', cyan: '#0f8fa5', white: '#ffffff' },
      dark: { black: '#0e1020', red: '#ff9ba9', green: '#83d995', yellow: '#f5c451', blue: '#82cfff', magenta: '#c4a8ff', cyan: '#67e8f9', white: '#f3efff' },
    },
    newspaper: {
      light: { black: '#28231d', red: '#a3332f', green: '#39704b', yellow: '#936b12', blue: '#385d82', magenta: '#78506f', cyan: '#3e6d68', white: '#fffaf0' },
      dark: { black: '#171716', red: '#c98972', green: '#9baea4', yellow: '#d1b56e', blue: '#9aafba', magenta: '#b99bad', cyan: '#9baea4', white: '#eee6d5' },
    },
  };
  return {
    background,
    foreground,
    // Pi keeps the hardware cursor enabled for Windows IME positioning. Match
    // its paint to the terminal background so the parked cursor is not visible.
    cursor: background,
    cursorAccent: background,
    selectionBackground,
    ...palettes[theme][dark ? 'dark' : 'light'],
    brightBlack: muted,
  };
}
function focusTerminalInput() {
  if (!terminal || state.module !== 'session') return false;
  const input = terminal.textarea || terminal.element?.querySelector('.xterm-helper-textarea');
  if (!input) return false;
  input.autofocus = true;
  input.focus({ preventScroll: true });
  return document.activeElement === input;
}
function ensureTerminalInputFocus() {
  if (terminalFocusRetryTimer !== null) clearTimeout(terminalFocusRetryTimer);
  let attempts = 0;
  const focus = () => {
    terminalFocusRetryTimer = null;
    if (state.module !== 'session' || !terminal || focusTerminalInput()) return;
    if (attempts >= 5) return;
    attempts += 1;
    terminalFocusRetryTimer = setTimeout(focus, 50);
  };
  focus();
}
function clearQueuedTerminalWrite() {
  if (terminalWriteTimer !== null) clearTimeout(terminalWriteTimer);
  terminalWriteTimer = null;
  terminalWriteBuffer = [];
}
function flushQueuedTerminalWrite() {
  terminalWriteTimer = null;
  const data = terminalWriteBuffer.join('');
  terminalWriteBuffer = [];
  if (data && terminal) terminal.write(data);
}
function queueTerminalWrite(data) {
  if (!terminal || !data) return;
  terminalWriteBuffer.push(String(data));
  // PTY chunks can split one Pi redraw. Paint complete redraws together so
  // the editor cursor never briefly disappears between ANSI operations.
  if (terminalWriteTimer === null) terminalWriteTimer = setTimeout(flushQueuedTerminalWrite, 16);
}
function disposeTerminal() {
  clearTerminalSearch();
  terminalSearchAddon?.dispose(); terminalSearchAddon = null;
  terminalResizeObserver?.disconnect(); terminalResizeObserver = null;
  terminalCursorSubscription?.dispose(); terminalCursorSubscription = null;
  terminalWriteParsedSubscription?.dispose(); terminalWriteParsedSubscription = null;
  clearQueuedTerminalWrite();
  if (terminalFocusRetryTimer !== null) clearTimeout(terminalFocusRetryTimer);
  terminalFocusRetryTimer = null;
  if (terminalImePositionFrame !== null) cancelAnimationFrame(terminalImePositionFrame);
  terminalImePositionFrame = null;
  terminalImeComposing = false; terminalImeInputStyle = null;
  const box = $('#session-terminal');
  if (terminalImeCursorHandler) {
    box.removeEventListener('compositionstart', terminalImeCursorHandler);
    box.removeEventListener('compositionend', terminalImeCursorHandler);
    box.removeEventListener('focusin', terminalImeCursorHandler);
    box.removeEventListener('focusout', terminalImeCursorHandler);
  }
  terminalImeCursorHandler = null;
  try { terminal?.dispose(); } catch { /* already disposed */ }
  terminal = null; fitAddon = null;
  box.innerHTML = '';
}
function detachTui() {
  if (tuiSocket) { tuiSocket.onclose = null; tuiSocket.close(); tuiSocket = null; }
  disposeTerminal();
  document.body.classList.remove('tui-active');
}
function showSessionSurface(kind) {
  const terminal = $('#session-terminal');
  const chat = $('#session-chat');
  if (!terminal || !chat) return;
  terminal.classList.toggle('hidden', kind !== 'terminal');
  chat.classList.toggle('hidden', kind !== 'chat');
}
function positionTerminalImeInput() {
  const input = terminal?.element?.querySelector('.xterm-helper-textarea');
  const screen = terminal?.element?.querySelector('.xterm-screen');
  if (!input || !screen || !terminal?.cols || !terminal?.rows) return null;
  const rect = screen.getBoundingClientRect();
  const cursor = terminal.buffer.active;
  input.style.left = `${Math.max(0, Math.min(terminal.cols - 1, cursor.cursorX)) * rect.width / terminal.cols}px`;
  input.style.top = `${Math.max(0, Math.min(terminal.rows - 1, cursor.cursorY)) * rect.height / terminal.rows}px`;
  input.style.width = `${Math.max(1, rect.width / terminal.cols)}px`;
  input.style.height = `${Math.max(1, rect.height / terminal.rows)}px`;
  input.style.zIndex = '5';
  return { left: input.style.left, top: input.style.top, width: input.style.width, height: input.style.height, zIndex: input.style.zIndex };
}
function restoreTerminalImeInput() {
  const input = terminal?.element?.querySelector('.xterm-helper-textarea');
  if (input && terminalImeInputStyle) Object.assign(input.style, terminalImeInputStyle);
}
function scheduleTerminalImeInputPosition() {
  if (terminalImePositionFrame !== null) return;
  terminalImePositionFrame = requestAnimationFrame(() => {
    terminalImePositionFrame = null;
    if (terminalImeComposing) restoreTerminalImeInput();
    else positionTerminalImeInput();
  });
}
function currentSession() {
  const task = currentTask(state.sessionTask);
  return (task?.sessions || []).find((item) => item.id === state.sessionSessionId) || null;
}
function openDshChat({ autoHandoff = true } = {}) {
  const session = currentSession();
  if (!session?.dshSessionId) return;
  // 第二期：工作台不再自绘 dsh 聊天，移交宿主原生界面打开。
  // 启动恢复场景（autoHandoff=false）只显示占位，不主动跳出工作台。
  showSessionSurface('chat');
  if (autoHandoff && window.parent !== window) {
    window.parent.postMessage({ type: 'workbench-open-dsh', sessionId: session.dshSessionId }, location.origin);
  }
}
async function openNativeTui() {
  // 动态加载 xterm 期间可能再次切换会话。等待当前打开动作结束后，
  // 只为最后仍然选中的会话继续打开，避免旧请求把新请求吞掉。
  const taskId = state.sessionTask;
  const sessionId = state.sessionSessionId;
  if (tuiOpening) {
    try { await tuiOpening; } catch { /* 当前打开失败，下面仍可尝试最新会话 */ }
    if (state.sessionTask !== taskId || state.sessionSessionId !== sessionId || tuiSocket) return;
  }
  const task = currentTask(taskId);
  if (!task) return toast('请先选择一个会话', 'error');
  const session = (task?.sessions || []).find((item) => item.id === sessionId);
  if (!session) return toast('没有可用的历史会话', 'error');
  if (session.kind === 'dsh') return openDshChat();
  tuiOpening = (async () => {
    detachTui();
    showSessionSurface('terminal');
    document.body.classList.add('tui-active');
    const box = $('#session-terminal');
    try {
      const [{ Terminal }, { FitAddon }, { SearchAddon }] = await Promise.all([import('/workbench/vendor/xterm/lib/xterm.mjs'), import('/workbench/vendor/xterm-fit/addon-fit.mjs'), import('/workbench/vendor/xterm-search/addon-search.mjs')]);
      if (state.sessionTask !== taskId || state.sessionSessionId !== sessionId) return;
      terminal = new Terminal({ cursorBlink: false, cursorStyle: 'bar', cursorWidth: 2, convertEol: true, scrollback: 10000, scrollOnUserInput: false, fontSize: 13, fontFamily: terminalFontFamily(), theme: terminalTheme() });
      const browserPlatform = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '';
      const isWindowsBrowser = /^win/i.test(browserPlatform);
      terminal.attachCustomKeyEventHandler((event) => {
        if (event.type !== 'keydown') return true;
        const key = event.key.toLowerCase();
        if ((event.ctrlKey || event.metaKey) && key === 'f') {
          event.preventDefault();
          event.stopPropagation();
          focusTerminalSearch(true);
          return false;
        }
        if (!event.ctrlKey && !(event.metaKey && key === 'v')) return true;
        if (key === 'c' && terminal.hasSelection()) {
          event.preventDefault();
          event.stopPropagation();
          if (navigator.clipboard) void navigator.clipboard.writeText(terminal.getSelection()).catch(() => toast('复制失败，请使用右键菜单', 'error')); 
          else toast('复制失败，请使用右键菜单', 'error');
          terminal.clearSelection();
          return false;
        }
        if (key === 'v') {
          event.preventDefault();
          event.stopPropagation();
          // Ask pi to read the native clipboard instead of letting xterm send
          // the browser shortcut as terminal input. Pi uses Ctrl+V on
          // macOS/Linux and Alt+V on Windows; both paths support text fallback
          // and clipboard images (inserted as a temporary file path).
          const pasteKey = isWindowsBrowser ? '\x1bv' : '\x16';
          if (tuiSocket?.readyState === WebSocket.OPEN) tuiSocket.send(JSON.stringify({ type: 'tui_input', data: pasteKey }));
          else toast('粘贴失败，请先连接会话', 'error');
          return false;
        }
        return true;
      });
      fitAddon = new FitAddon(); terminal.loadAddon(fitAddon); terminal.open(box); fitAddon.fit();
      terminalSearchAddon = new SearchAddon();
      terminal.loadAddon(terminalSearchAddon);
      searchTerminal();
      ensureTerminalInputFocus();
      terminalImeCursorHandler = (event) => {
        if (event?.type === 'compositionstart') {
          terminalImeComposing = true;
          terminalImeInputStyle = positionTerminalImeInput();
          return;
        }
        if (event?.type === 'compositionend' || event?.type === 'focusout') {
          terminalImeComposing = false;
          terminalImeInputStyle = null;
        }
        // xterm relocates its helper textarea for every cursor movement. Keep
        // it fixed throughout an IME composition, even while Pi redraws.
        if (terminalImeComposing) return restoreTerminalImeInput();
        scheduleTerminalImeInputPosition();
      };
      terminalCursorSubscription = terminal.onCursorMove(terminalImeCursorHandler);
      terminalWriteParsedSubscription = terminal.onWriteParsed(terminalImeCursorHandler);
      box.addEventListener('compositionstart', terminalImeCursorHandler);
      box.addEventListener('compositionend', terminalImeCursorHandler);
      box.addEventListener('focusin', terminalImeCursorHandler);
      box.addEventListener('focusout', terminalImeCursorHandler);
      terminalImeCursorHandler();
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${location.host}/workbench/ws`);
      tuiSocket = socket;
      const sendSize = () => {
        try { fitAddon?.fit(); } catch { /* layout is changing */ }
        if (socket.readyState === WebSocket.OPEN && terminal) socket.send(JSON.stringify({ type: 'tui_resize', cols: terminal.cols, rows: terminal.rows }));
      };
      // regular mode leaves wheel scrolling to xterm.js and its viewport.
      terminal.onData((data) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'tui_input', data })); });
      terminalResizeObserver = new ResizeObserver(sendSize); terminalResizeObserver.observe(box);
      socket.onopen = () => {
        // 防止旧会话延迟到达的 WebSocket 帧污染当前终端。
        if (tuiSocket !== socket || state.sessionTask !== taskId || state.sessionSessionId !== sessionId) {
          socket.close();
          return;
        }
        socket.send(JSON.stringify({ type: 'tui_hello', taskId, sessionId, cols: terminal.cols, rows: terminal.rows, theme: isTerminalDark() ? 'dark' : 'light' }));
        requestAnimationFrame(() => requestAnimationFrame(sendSize));
      };
      socket.onmessage = ({ data }) => {
        if (tuiSocket !== socket || state.sessionTask !== taskId || state.sessionSessionId !== sessionId) return;
        try {
          const event = JSON.parse(data);
          if (event.type === 'tui_reset') { clearQueuedTerminalWrite(); terminal?.reset(); sendSize(); }
          else if (event.type === 'tui_data') queueTerminalWrite(event.data || '');
          else if (event.type === 'tui_exit') queueTerminalWrite(`\r\n\r\n[工作台] pi 已退出（${event.exitCode ?? '未知'}）。\r\n`);
          else if (event.type === 'tui_error') {
            const error = event.error || '终端错误';
            // Ignore stale frames emitted while a PTY is already exiting.
            if (error === '会话未运行') return;
            toast(error, 'error');
          }
        } catch { /* ignore malformed frames */ }
      };
      socket.onerror = () => toast('会话连接失败，请查看服务终端中的错误信息', 'error');
      socket.onclose = () => {
        const current = tuiSocket === socket;
        if (current) tuiSocket = null;
        if (current && state.sessionTask === taskId && state.sessionSessionId === sessionId && terminal) queueTerminalWrite('\r\n[工作台] 终端连接已断开，点击“重新连接”可恢复。\r\n');
      };
    } catch (error) {
      detachTui();
      toast(`加载终端组件失败：${error.message}`, 'error');
    }
  })().finally(() => { tuiOpening = null; });
  return tuiOpening;
}
async function restartCurrentTui(message = '正在重启会话…') {
  const taskId = state.sessionTask;
  if (!taskId) return;
  toast(message);
  detachTui();
  try {
    await api(`/tasks/${taskId}/tui/restart`, { method: 'POST', body: { sessionId: state.sessionSessionId } });
  } catch { /* the process may already have exited */ }
  await refresh();
  if (state.sessionTask === taskId) await openNativeTui();
}
async function restartTuiForTheme() {
  if (!state.sessionTask || !tuiSocket) return;
  await restartCurrentTui('主题已切换，正在重启会话…');
}
function selectSession(taskId, sessionId = null, { record = true, autoHandoff = true } = {}) {
  if (state.module !== 'session') switchModule('session');
  const task = currentTask(taskId);
  const target = (task?.sessions || []).find((session) => session.id === sessionId);
  // 传入的 id 不存在时回退到服务端活跃会话或首个会话
  const nextSessionId = target?.id || task?.activeSessionId || availableSessions(task)[0]?.id || null;
  const changing = state.sessionTask !== taskId || state.sessionSessionId !== nextSessionId;
  if (state.sessionTask && changing) leaveCurrentSession();
  // 重复点击当前子会话不应重启 TUI。
  if (taskId && !changing && tuiSocket) {
    rememberCurrentSessionMessage();
    renderSessionTree();
    return;
  }
  detachTui();
  state.sessionTask = taskId || null;
  state.sessionSessionId = nextSessionId;
  if (taskId && nextSessionId) rememberLastOpenedSession(taskId, nextSessionId);
  rememberCurrentSessionMessage();
  renderSessionTree();
  saveLayoutState();
  if (record) recordWorkspaceView();
  if (taskId) {
    const selected = (task?.sessions || []).find((item) => item.id === nextSessionId);
    return selected?.kind === 'dsh' ? openDshChat({ autoHandoff }) : openNativeTui();
  }
  return Promise.resolve();
}

function modal(html) {
  const root = $('#modal-root');
  modalRestoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  root.innerHTML = `<div class="overlay" role="presentation"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1">${html}</div></div>`;
  const dialog = $('.modal', root);
  const heading = dialog.querySelector('h2');
  if (heading) { heading.id = 'modal-title'; heading.classList.remove('sr-only'); }
  (dialog.querySelector('input, textarea, select, button') || dialog).focus();
  return dialog;
}
function closeModal() {
  const restore = modalRestoreFocus;
  modalRestoreFocus = null;
  $('#modal-root').innerHTML = '';
  if (restore?.isConnected) restore.focus();
}
document.addEventListener('keydown', (event) => {
  const dialog = $('.modal');
  if (!dialog) return;
  if (event.key === 'Escape') { event.preventDefault(); closeModal(); return; }
  if (event.key !== 'Tab') return;
  const focusable = [...dialog.querySelectorAll('button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])')].filter((node) => !node.disabled && node.offsetParent !== null);
  if (!focusable.length) { event.preventDefault(); dialog.focus(); return; }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
function setFieldError(form, inputId, message = '') {
  const input = $(`#${inputId}`, form);
  const error = form.querySelector(`[data-error-for="${inputId}"]`);
  if (!input || !error) return;
  input.setAttribute('aria-invalid', String(Boolean(message)));
  error.textContent = message;
  error.classList.toggle('hidden', !message);
}
function openNoteForm(note = null, options = {}) {
  const editing = Boolean(note);
  const form = modal(`<h2>${editing ? '编辑便签' : '新建便签'}</h2><label for="note-title">标题（可选）<input id="note-title" autocomplete="off" value="${esc(note?.title || '')}"></label><label for="note-desc">描述<textarea id="note-desc" autocomplete="off" rows="5">${esc(note?.description || '')}</textarea><span class="field-error hidden" data-error-for="note-desc" role="alert"></span></label><div class="row"><label>颜色<div class="color-selector"><button type="button" id="note-color-trigger" class="color-trigger" aria-expanded="false" aria-controls="note-color-picker"><span id="note-color-swatch" class="color-trigger-swatch" aria-hidden="true"></span><span id="note-color-label"></span></button><div id="note-color-picker" class="color-picker hidden" role="group" aria-label="颜色选项"></div><input id="note-custom-color-value" class="color-native-input" type="color" aria-label="新增颜色" value="#E85F32"></div><input type="hidden" id="note-color" value="${taskColor(note || {})}"></label><label for="note-deadline">截止<input id="note-deadline" type="datetime-local" value="${esc(note?.deadline || '')}"></label></div><label class="note-switch"><input id="note-topbar" type="checkbox"${(note?.pinnedToTopBar || options.pinnedToTopBar) ? ' checked' : ''}> 是否启用提醒标记</label><label class="note-switch"><input id="note-sessionbar" type="checkbox"${(note?.pinnedToSessionBar || options.pinnedToSessionBar) ? ' checked' : ''}> 是否启用会话标记</label><div class="modal-actions"><button type="button" class="primary" id="save-note">${editing ? '保存' : '创建'}</button><button type="button" data-close>取消</button></div>`);
  $('[data-close]', form).onclick = closeModal;
  const colorPicker = $('#note-color-picker', form);
  const colorTrigger = $('#note-color-trigger', form);
  const customInput = $('#note-custom-color-value', form);
  const setPicker = (open) => { colorPicker.classList.toggle('hidden', !open); colorTrigger.setAttribute('aria-expanded', String(open)); };
  const renderPicker = () => {
    const selected = $('#note-color', form).value;
    const color = colorCatalog()[selected] || COLORS.yellow;
    $('#note-color-label', form).textContent = color.label;
    $('#note-color-swatch', form).style.background = color.value;
    const options = Object.entries(colorCatalog()).map(([key, value]) => `<div class="color-entry"><button type="button" class="color-option color-${key}${customColors[key] ? ' custom-color-option' : ''}${selected === key ? ' active' : ''}" data-note-color-value="${esc(key)}" aria-label="${esc(value.label)}" aria-pressed="${selected === key}"><span${customColors[key] ? ` style="--swatch:${esc(value.value)}"` : ''}></span></button></div>`).join('');
    colorPicker.innerHTML = `<button type="button" class="color-add" data-add-note-color title="新增颜色（最多9个，超出替换最少使用）" aria-label="新增颜色（最多9个，超出替换最少使用）">＋</button>${options}`;
  };
  colorTrigger.onclick = () => setPicker(colorPicker.classList.contains('hidden'));
  colorPicker.onclick = (event) => { const option = event.target.closest('[data-note-color-value]'); if (option) { $('#note-color', form).value = option.dataset.noteColorValue; renderPicker(); } if (event.target.closest('[data-add-note-color]')) { setPicker(false); customInput.click(); } };
  customInput.onchange = () => {
    const value = customInput.value.toLowerCase();
    const key = createCustomColor(value);
    $('#note-color', form).value = key;
    renderPicker();
  };
  form.addEventListener('click', (event) => { if (!event.target.closest('.color-selector')) setPicker(false); });
  renderPicker();
  $('#save-note', form).onclick = async () => {
    const button = $('#save-note', form);
    const description = $('#note-desc', form).value.trim();
    setFieldError(form, 'note-desc');
    if (!description) { setFieldError(form, 'note-desc', '请输入便签描述。'); $('#note-desc', form).focus(); return; }
    try {
      button.disabled = true;
      const body = {
        title: $('#note-title', form).value,
        description,
        color: $('#note-color', form).value,
        deadline: $('#note-deadline', form).value || null,
        pinnedToTopBar: $('#note-topbar', form).checked,
        pinnedToSessionBar: $('#note-sessionbar', form).checked,
      };
      const url = editing ? `/notes/${note.id}` : '/notes';
      const method = editing ? 'PUT' : 'POST';
      await api(url, { method, body });
      markCustomColorUsed(body.color);
      closeModal();
      toast(editing ? '便签已保存' : '便签已创建');
      await refresh();
    } catch (error) { button.disabled = false; toast(error.message, 'error'); }
  };
}
function openDeleteNoteModal(note) {
  const form = modal(`<h2>废弃便签</h2><p>确定将这张便签移入回收站吗？</p><div class="modal-actions"><button class="danger" id="confirm-delete-note">移入回收站</button><button data-close>取消</button></div>`);
  $('[data-close]', form).onclick = closeModal;
  $('#confirm-delete-note', form).onclick = async () => {
    try {
      await api(`/notes/${note.id}`, { method: 'DELETE' });
      closeModal();
      toast('便签已移入回收站');
      refresh();
    } catch (error) {
      toast(error.message, 'error');
    }
  };
}
function openTaskForm(task = null, options = {}) {
  const openSessionAfterCreate = Boolean(options.openSessionAfterCreate && !task);
  const saveLabel = task ? '保存' : '确认';
  const openSessionOption = task ? '' : `<label class="note-switch"><input id="task-open-session" type="checkbox"${openSessionAfterCreate ? ' checked' : ''}> 创建后打开新会话</label>`;
  const workingDirEditable = true;
  const workingDirHint = task ? '（仅新会话使用这些路径）' : '';
  const workingDirReadonly = workingDirEditable ? '' : ' disabled';
  const form = modal(`<h2>${task ? '编辑任务' : '新建任务'}</h2><label for="task-title">标题<input id="task-title" name="title" autocomplete="off" value="${esc(task?.title || '')}"><span class="field-error hidden" data-error-for="task-title" role="alert"></span></label><label>工作目录${workingDirHint}<div id="task-working-dirs" class="task-working-dirs"></div><button type="button" id="add-task-working-dir" class="add-working-dir hidden">＋ 添加子路径</button><span class="field-error hidden" data-error-for="task-working-dir" role="alert"></span></label><label for="task-desc">描述<textarea id="task-desc" name="description" autocomplete="off" rows="4">${esc(task?.description || '')}</textarea></label><div class="row"><label>颜色<div class="color-selector"><button type="button" id="color-trigger" class="color-trigger" aria-expanded="false" aria-controls="color-picker"><span id="color-trigger-swatch" class="color-trigger-swatch" aria-hidden="true"></span><span id="color-trigger-label"></span></button><div id="color-picker" class="color-picker hidden" role="group" aria-label="颜色选项"></div><input id="custom-color-value" class="color-native-input" type="color" aria-label="新增颜色" value="#E85F32"></div><input type="hidden" id="task-color" name="color" value="${taskColor(task || {})}"></label><label for="task-deadline">截止<input id="task-deadline" name="deadline" type="datetime-local" value="${esc(task?.deadline || '')}"></label></div>${openSessionOption}<div class="modal-actions"><button type="button" class="primary" id="save-task">${saveLabel}</button><button type="button" data-close>取消</button></div>`);
  $('[data-close]', form).onclick = closeModal;
  const colorPicker = $('#color-picker', form);
  const colorTrigger = $('#color-trigger', form);
  const customColorValue = $('#custom-color-value', form);
  const colorCapacity = () => {
    const contentWidth = colorPicker.clientWidth - 16;
    const columns = Math.max(1, Math.floor((contentWidth + 4) / 27));
    return Math.max(Object.keys(COLORS).length, columns * 2 - 1);
  };
  const setColorPopup = (open) => {
    colorPicker.classList.toggle('hidden', !open);
    colorTrigger.setAttribute('aria-expanded', String(open));
  };
  const updateColorTrigger = () => {
    const selected = $('#task-color', form).value;
    const color = colorCatalog()[selected] || COLORS.blue;
    $('#color-trigger-label', form).textContent = color.label;
    $('#color-trigger-swatch', form).style.background = color.value;
    colorTrigger.setAttribute('aria-label', `当前颜色 ${color.label}，点击选择`);
    colorPicker.querySelectorAll('[data-color-value]').forEach((item) => {
      const active = item.dataset.colorValue === selected;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', String(active));
    });
  };
  const selectColor = (key, close = false) => {
    $('#task-color', form).value = key;
    updateColorTrigger();
    if (close) setColorPopup(false);
  };
  const renderColorPicker = () => {
    const selected = $('#task-color', form).value;
    colorPicker.innerHTML = '<button type="button" id="add-custom-color" class="color-add" title="新增颜色（最多9个，超出替换最少使用）" aria-label="新增颜色（最多9个，超出替换最少使用）">＋</button>' + Object.entries(colorCatalog()).map(([key, value]) => {
      const custom = Boolean(customColors[key]);
      return `<div class="color-entry"><button type="button" class="color-option color-${key}${custom ? ' custom-color-option' : ''}${selected === key ? ' active' : ''}" data-color-value="${esc(key)}" aria-label="${esc(value.label)}" title="${esc(value.label)}" aria-pressed="${selected === key}"><span${custom ? ` style="--swatch:${esc(value.value)}"` : ''} aria-hidden="true"></span></button></div>`;
    }).join('');
    colorPicker.querySelectorAll('[data-color-value]').forEach((button) => {
      button.onclick = () => selectColor(button.dataset.colorValue);
      button.ondblclick = () => selectColor(button.dataset.colorValue, true);
      button.onkeydown = (event) => {
        const buttons = [...colorPicker.querySelectorAll('[data-color-value]')];
        const columns = Math.max(1, Math.ceil((colorCapacity() + 1) / 2));
        const index = buttons.indexOf(button);
        let next = index;
        if (event.key === 'ArrowRight') next = Math.min(buttons.length - 1, index + 1);
        else if (event.key === 'ArrowLeft') next = Math.max(0, index - 1);
        else if (event.key === 'ArrowDown') next = Math.min(buttons.length - 1, index + columns);
        else if (event.key === 'ArrowUp') next = Math.max(0, index - columns);
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = buttons.length - 1;
        else if (event.key === 'Escape') { event.preventDefault(); setColorPopup(false); colorTrigger.focus(); return; }
        else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectColor(button.dataset.colorValue, true); return; }
        else return;
        event.preventDefault();
        buttons[next]?.focus();
      };
    });
    $('#add-custom-color', form).onclick = () => { setColorPopup(false); customColorValue.click(); };
    updateColorTrigger();
  };
  colorTrigger.onclick = () => setColorPopup(colorPicker.classList.contains('hidden'));
  form.addEventListener('click', (event) => { if (!event.target.closest('.color-selector')) setColorPopup(false); });
  customColorValue.addEventListener('change', () => {
    const value = customColorValue.value.toLowerCase();
    const key = createCustomColor(value);
    $('#task-color', form).value = key;
    renderColorPicker();
  });
  renderColorPicker();
  const workingDirsRoot = $('#task-working-dirs', form);
  const addWorkingDirButton = $('#add-task-working-dir', form);
  const initialWorkingDirs = Array.isArray(task?.workingDirs) && task.workingDirs.length
    ? task.workingDirs
    : [task?.workingDir || ''];
  const currentWorkingDirs = () => [...workingDirsRoot.querySelectorAll('[data-working-dir-input]')].map((input) => input.value.trim());
  const updateAddWorkingDirButton = () => {
    const inputs = [...workingDirsRoot.querySelectorAll('[data-working-dir-input]')];
    addWorkingDirButton.classList.toggle('hidden', !inputs.length || !inputs.at(-1).value.trim());
    workingDirsRoot.querySelectorAll('[data-remove-working-dir]').forEach((button) => {
      button.classList.toggle('hidden', inputs.length <= 1);
    });
  };
  const bindWorkingDirRow = (row) => {
    const input = $('[data-working-dir-input]', row);
    const recentList = $('[data-working-dir-recent]', row);
    const hideRecentOptions = () => { recentList.classList.add('hidden'); input.setAttribute('aria-expanded', 'false'); };
    const renderRecentOptions = () => {
      const query = input.value.trim().toLowerCase();
      const dirs = recentWorkingDirs().filter((dir) => !query || dir.toLowerCase().includes(query));
      recentList.innerHTML = dirs.length ? dirs.map((dir) => `<div class="recent-dir-option"><button type="button" class="recent-dir-option-name" data-recent-dir="${esc(dir)}">${esc(dir)}</button><button type="button" class="recent-dir-delete" data-remove-recent-dir="${esc(dir)}" aria-label="删除路径" title="删除路径">×</button></div>`).join('') : '';
      recentList.classList.toggle('hidden', !dirs.length);
      input.setAttribute('aria-expanded', String(Boolean(dirs.length)));
    };
    input.addEventListener('focus', renderRecentOptions);
    input.addEventListener('input', () => { renderRecentOptions(); updateAddWorkingDirButton(); });
    input.addEventListener('blur', () => setTimeout(hideRecentOptions, 150));
    recentList.onclick = (event) => {
      const remove = event.target.closest('[data-remove-recent-dir]');
      if (remove) {
        forgetWorkingDir(remove.dataset.removeRecentDir);
        renderRecentOptions();
        return;
      }
      const option = event.target.closest('[data-recent-dir]');
      if (!option) return;
      input.value = option.dataset.recentDir;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      hideRecentOptions();
    };
    $('[data-choose-working-dir]', row).onclick = async () => {
      try {
        const result = await api('/select-directory', { method: 'POST' });
        if (result.path) { rememberWorkingDir(result.path); input.value = result.path; input.dispatchEvent(new Event('input', { bubbles: true })); }
      } catch (error) { toast(error.message, 'error'); }
    };
    $('[data-remove-working-dir]', row).onclick = () => {
      const values = currentWorkingDirs();
      values.splice(Number(row.dataset.workingDirIndex), 1);
      renderWorkingDirs(values);
    };
  };
  function renderWorkingDirs(values) {
    const rows = values.length ? values : [''];
    workingDirsRoot.innerHTML = rows.map((value, index) => `<div class="task-working-dir-row path-picker-row" data-working-dir-index="${index}"><div class="working-dir-field"><input id="task-working-dir-${index}" data-working-dir-input name="workingDirs" autocomplete="off" placeholder="${index ? '输入子工作路径' : '输入默认工作路径'}" aria-autocomplete="list" aria-expanded="false" aria-controls="recent-task-dir-list-${index}" aria-label="${index ? `子工作目录 ${index}` : '默认工作目录'}" value="${esc(value)}"${workingDirReadonly}><div id="recent-task-dir-list-${index}" data-working-dir-recent class="recent-dir-list hidden" role="group" aria-label="最近工作路径"></div></div><button type="button" data-choose-working-dir class="icon-button" title="选择文件夹" aria-label="选择文件夹"${workingDirReadonly}>${ACTION_ICONS.folder}</button><button type="button" data-remove-working-dir class="icon-button working-dir-remove" title="移除路径" aria-label="移除路径">×</button></div>`).join('');
    workingDirsRoot.querySelectorAll('.task-working-dir-row').forEach(bindWorkingDirRow);
    updateAddWorkingDirButton();
  }
  addWorkingDirButton.onclick = () => { renderWorkingDirs([...currentWorkingDirs(), '']); [...workingDirsRoot.querySelectorAll('[data-working-dir-input]')].at(-1)?.focus(); };
  renderWorkingDirs(initialWorkingDirs.map((value) => String(value || '')));
  $('#save-task', form).onclick = async () => {
    const button = $('#save-task', form);
    try {
      const title = $('#task-title', form).value.trim();
      const workingDirs = currentWorkingDirs().filter(Boolean);
      setFieldError(form, 'task-title');
      setFieldError(form, 'task-working-dir');
      if (!title) { setFieldError(form, 'task-title', '请输入任务标题。'); $('#task-title', form).focus(); return; }
      if (workingDirEditable && !workingDirs.length) { setFieldError(form, 'task-working-dir', '请选择或输入工作目录。'); $('[data-working-dir-input]', form)?.focus(); return; }
      button.disabled = true;
      button.textContent = task ? '保存中…' : '确认中…';
      if (workingDirEditable) workingDirs.forEach(rememberWorkingDir);
      const body = { title, description: $('#task-desc', form).value, color: $('#task-color', form).value, deadline: $('#task-deadline', form).value || null, workingDir: workingDirs[0], workingDirs };
      const result = await api(task ? `/tasks/${task.id}` : '/tasks', { method: task ? 'PUT' : 'POST', body });
      markCustomColorUsed(body.color);
      closeModal();
      if (!task && $('#task-open-session', form)?.checked && result.task) {
        await openExecute(result.task);
        return;
      }
      toast(task ? '任务已保存' : '任务已创建');
      refresh();
    } catch (error) { button.disabled = false; button.textContent = saveLabel; toast(error.message, 'error'); }
  };
}
async function restoreTask(task) {
  const result = await api(`/tasks/${task.id}/restore`, { method: 'POST' });
  // 保留当前回收站视图；刷新后恢复的卡片会从回收站列表中消失。
  // 恢复只改变任务状态；保持任务在会话列表中的原有展示状态。
  await refresh();
  saveLayoutState();
  return currentTask(task.id) || result.task;
}
async function openTaskSession(task) {
  showSessionTask(task.id);
  const sessions = Array.isArray(task.sessions) ? task.sessions : [];
  const session = sessions.find((item) => item.id === task.activeSessionId) || sessions[0];
  if (session) await selectSession(task.id, session.id);
  else await openExecute(task);
}
function runningSessionCount(task) {
  return availableSessions(task).filter((session) => session.running).length || (task.piRunning ? 1 : 0);
}
async function completeTask(task) {
  await api(`/tasks/${task.id}/complete`, { method: 'POST' });
  state.hiddenCompletedSessionTasks.add(task.id);
  if (state.sessionTask === task.id) {
    leaveCurrentSession();
    detachTui();
    state.sessionTask = null;
    state.sessionSessionId = null;
  }
}
async function finishCompleteTask(task) {
  await completeTask(task);
  await refresh();
  saveLayoutState();
  toast('任务已完成');
}
function openCompleteTaskModal(task) {
  const runningCount = runningSessionCount(task);
  const form = modal(`<h2>完成正在运行的任务？</h2><p>任务「${esc(task.title)}」当前有 ${runningCount} 个会话正在运行。标记完成将停止运行中的会话，是否继续？</p><div class="modal-actions"><button type="button" class="danger" id="confirm-complete-task">停止并标记完成</button><button type="button" data-close>取消</button></div>`);
  $('[data-close]', form).onclick = closeModal;
  $('#confirm-complete-task', form).onclick = async () => {
    const button = $('#confirm-complete-task', form);
    button.disabled = true;
    try {
      await completeTask(task);
      closeModal();
      await refresh();
      saveLayoutState();
      toast('任务已完成');
    } catch (error) {
      button.disabled = false;
      toast(error.message, 'error');
    }
  };
}
async function openExecute(task) {
  if (!task.workingDir) return openTaskForm(task);
  try {
    const result = await api(`/tasks/${task.id}/sessions`, { method: 'POST', body: { title: '新会话' } });
    showSessionTask(task.id);
    await refresh(); switchModule('session'); selectSession(task.id, result.session.id);
    toast(task.description ? '已打开会话，请在 pi 输入框中发送任务描述。' : '已打开会话。');
  } catch (error) { toast(error.message, 'error'); }
}
function openDeleteTaskModal(task) {
  const runningCount = runningSessionCount(task);
  const runningWarning = runningCount ? `<p class="danger">当前有 ${runningCount} 个会话正在运行，移入回收站后将关闭这些会话。</p>` : '';
  const confirmLabel = runningCount ? '关闭会话并移入废弃' : '移入废弃';
  const form = modal(`<h2>废弃任务</h2><p>确定将「${esc(task.title)}」移入废弃任务吗？之后可在回收站中恢复或永久删除。</p>${runningWarning}<div class="modal-actions"><button class="danger" id="confirm-archive-task">${confirmLabel}</button><button data-close>取消</button></div>`);
  $('[data-close]', form).onclick = closeModal;
  $('#confirm-archive-task', form).onclick = async () => {
    try {
      await api(`/tasks/${task.id}`, { method: 'DELETE' });
      state.sessionTaskIds.delete(task.id);
      state.hiddenCompletedSessionTasks.add(task.id);
      if (state.sessionTask === task.id) {
        leaveCurrentSession();
        detachTui();
        state.sessionTask = null;
        state.sessionSessionId = null;
      }
      // 废弃卡片后保留当前任务分类筛选，刷新后卡片自然从列表中移除。
      closeModal(); await refresh();
      saveLayoutState();
      toast('任务已移入废弃，可在回收站中恢复');
    } catch (error) { toast(error.message, 'error'); }
  };
}
function openPurgeTaskModal(task) {
  const form = modal(`<h2>永久删除任务</h2><p>确定永久删除「${esc(task.title)}」及其全部会话吗？此操作不可恢复。</p><div class="modal-actions"><button class="danger" id="confirm-purge-task">永久删除</button><button data-close>取消</button></div>`);
  $('[data-close]', form).onclick = closeModal;
  $('#confirm-purge-task', form).onclick = async () => { try { await api(`/tasks/${task.id}/permanent`, { method: 'DELETE' }); closeModal(); toast('任务已永久删除'); refresh(); } catch (error) { toast(error.message, 'error'); } };
}
function openClearArchivedModal() {
  const categoryLabel = { all: '卡片', tasks: '任务', notes: '便签', sessions: '会话' }[state.archiveType] || '卡片';
  const description = state.archiveType === 'sessions'
    ? '确定永久删除全部废弃会话吗？此操作不可恢复。'
    : `确定永久删除全部废弃${categoryLabel}${state.archiveType === 'notes' ? '' : '及其会话文件'}吗？此操作不可恢复。`;
  const form = modal(`<h2>清空${categoryLabel}</h2><p>${description}</p><div class="modal-actions"><button class="danger" id="confirm-purge-archived">全部清空</button><button data-close>取消</button></div>`);
  $('[data-close]', form).onclick = closeModal;
  $('#confirm-purge-archived', form).onclick = async () => {
    const button = $('#confirm-purge-archived', form);
    button.disabled = true;
    try {
      const result = await api('/archived', { method: 'DELETE', body: { type: state.archiveType } });
      closeModal();
      toast(`已永久删除 ${result.removed || 0} 个废弃卡片`);
      refresh();
    } catch (error) {
      button.disabled = false;
      toast(error.message, 'error');
    }
  };
}
async function createChildSession(task) {
  try {
    const result = await api(`/tasks/${task.id}/sessions`, { method: 'POST', body: { title: '新会话' } });
    showSessionTask(task.id);
    await refresh();
    selectSession(task.id, result.session.id);
    toast('子会话已创建');
  } catch (error) {
    toast(error.message, 'error');
  }
}
function openNewSessionModal(workingDir = null) {
  const tasks = state.tasks.filter((task) => task.status !== 'archived'
    && (workingDir === null || (task.workingDir || '未设置工作路径') === workingDir));
  if (!tasks.length) {
    toast(workingDir === null ? '请先新建一个任务' : '此工作路径下没有可用任务', 'error');
    return;
  }
  const kindRow = dshAvailable
    ? '<label>会话类型<div id="new-session-kind" class="session-kind-toggle" role="radiogroup" aria-label="会话类型"><button type="button" class="session-kind-option active" data-session-kind="pi" aria-checked="true">pi 终端</button><button type="button" class="session-kind-option" data-session-kind="dsh" aria-checked="false">dsh 聊天</button></div></label>'
    : '';
  const form = modal(`<h2>新建会话</h2><label for="new-session-task-input">所属任务<div class="working-dir-field new-session-task-field"><input id="new-session-task-input" name="taskId" autocomplete="off" readonly aria-autocomplete="list" aria-expanded="false" aria-controls="new-session-task-list" title="点击选择任务" value="${esc(tasks[0].title)}"><span class="new-session-task-dropdown-icon" aria-hidden="true">${ACTION_ICONS.chevronDown}</span><div id="new-session-task-list" class="recent-dir-list hidden" role="listbox" aria-label="现有任务">${tasks.map((task) => `<div class="recent-dir-option"><button type="button" class="recent-dir-option-name" role="option" data-new-session-task-id="${esc(task.id)}" aria-selected="${task.id === tasks[0].id}">${esc(task.title)}</button></div>`).join('')}</div></div><span class="field-error hidden" data-error-for="new-session-task-input" role="alert"></span></label><label for="new-session-title-input">会话名称<input id="new-session-title-input" name="sessionTitle" autocomplete="off" value="新会话" placeholder="例如：检查登录模块…"><span class="field-error hidden" data-error-for="new-session-title-input" role="alert"></span></label>${kindRow}<div class="modal-actions"><button type="button" class="primary" id="create-new-session">创建并进入终端</button><button type="button" data-close>取消</button></div>`);
  form.classList.add('new-session-modal');
  $('[data-close]', form).onclick = closeModal;
  const taskInput = $('#new-session-task-input', form);
  const taskList = $('#new-session-task-list', form);
  let taskId = tasks[0].id;
  let sessionKind = 'pi';
  const kindToggle = $('#new-session-kind', form);
  if (kindToggle) {
    kindToggle.onclick = (event) => {
      const option = event.target.closest('[data-session-kind]');
      if (!option) return;
      sessionKind = option.dataset.sessionKind;
      kindToggle.querySelectorAll('[data-session-kind]').forEach((item) => {
        const active = item === option;
        item.classList.toggle('active', active);
        item.setAttribute('aria-checked', String(active));
      });
      $('#create-new-session', form).textContent = sessionKind === 'dsh' ? '创建并进入聊天' : '创建并进入终端';
    };
  }
  const closeTaskList = () => { taskList.classList.add('hidden'); taskInput.setAttribute('aria-expanded', 'false'); };
  const openTaskList = () => { taskList.classList.remove('hidden'); taskInput.setAttribute('aria-expanded', 'true'); };
  taskInput.onclick = () => {
    if (taskList.classList.contains('hidden')) openTaskList();
    else closeTaskList();
  };
  taskInput.onblur = () => setTimeout(closeTaskList, 150);
  taskList.onclick = (event) => {
    const option = event.target.closest('[data-new-session-task-id]');
    if (!option) return;
    taskId = option.dataset.newSessionTaskId;
    taskInput.value = currentTask(taskId)?.title || option.textContent;
    taskList.querySelectorAll('[data-new-session-task-id]').forEach((item) => item.setAttribute('aria-selected', String(item === option)));
    closeTaskList();
  };
  $('#create-new-session', form).onclick = async () => {
    const button = $('#create-new-session', form);
    const title = $('#new-session-title-input', form).value.trim();
    setFieldError(form, 'new-session-task-input');
    setFieldError(form, 'new-session-title-input');
    if (!taskId || !currentTask(taskId)) {
      setFieldError(form, 'new-session-task-input', '请选择一个现有任务。');
      return;
    }
    if (!title) {
      setFieldError(form, 'new-session-title-input', '请输入会话名称。');
      $('#new-session-title-input', form).focus();
      return;
    }
    try {
      button.disabled = true;
      button.textContent = '创建中…';
      const result = await api(`/tasks/${taskId}/sessions`, { method: 'POST', body: { title, kind: sessionKind } });
      showSessionTask(taskId);
      closeModal();
      await refresh();
      await selectSession(taskId, result.session.id);
      toast('会话已创建');
    } catch (error) {
      button.disabled = false;
      button.textContent = '创建并进入终端';
      toast(error.message, 'error');
    }
  };
}
function openSessionModal(task, session = null) {
  const editing = Boolean(session);
  const form = modal(`<h2>${editing ? '重命名子会话' : '新建子会话'}</h2><p class="hint">任务：${esc(task.title)}</p><label for="session-title-input">会话名称<input id="session-title-input" name="sessionTitle" autocomplete="off" value="${esc(session?.title || '新会话')}" placeholder="例如：检查登录模块…"><span class="field-error hidden" data-error-for="session-title-input" role="alert"></span></label><div class="modal-actions"><button type="button" class="primary" id="save-session">${editing ? '保存' : '创建'}</button><button type="button" data-close>取消</button></div>`);
  $('[data-close]', form).onclick = closeModal;
  $('#save-session', form).onclick = async () => {
    const button = $('#save-session', form);
    try {
      const title = $('#session-title-input', form).value.trim();
      setFieldError(form, 'session-title-input');
      if (!title) { setFieldError(form, 'session-title-input', '请输入会话名称。'); $('#session-title-input', form).focus(); return; }
      button.disabled = true;
      button.textContent = editing ? '保存中…' : '创建中…';
      const result = await api(editing ? `/tasks/${task.id}/sessions/${session.id}` : `/tasks/${task.id}/sessions`, { method: editing ? 'PATCH' : 'POST', body: { title } });
      if (!editing) showSessionTask(task.id);
      closeModal(); await refresh(); if (!editing || (state.sessionTask === task.id && state.sessionSessionId === session.id)) selectSession(task.id, result.session.id);
    } catch (error) { button.disabled = false; button.textContent = editing ? '保存' : '创建'; toast(error.message, 'error'); }
  };
}
function openDeleteSessionModal(task, sessionId) {
  const session = (task.sessions || []).find((item) => item.id === sessionId);
  const emptySession = (session?.stats?.messages || 0) === 0;
  const prompt = emptySession
    ? `「${esc(session?.title || '新会话')}」没有任何消息，删除后将直接永久删除会话文件，且无法恢复。`
    : `确定将「${esc(task.title)}」下的这个子会话移入回收站吗？会话文件会保留，直到在回收站中永久删除。`;
  const confirmLabel = emptySession ? '直接永久删除' : '移入回收站';
  const form = modal(`<h2>${emptySession ? '删除空会话' : '删除子会话'}</h2><p>${prompt}</p><div class="modal-actions"><button class="danger" id="confirm-delete-session">${confirmLabel}</button><button data-close>取消</button></div>`);
  $('[data-close]', form).onclick = closeModal;
  $('#confirm-delete-session', form).onclick = async () => {
    try {
      const deletingCurrent = state.sessionTask === task.id && state.sessionSessionId === sessionId;
      if (deletingCurrent) leaveCurrentSession();
      const result = await api(`/tasks/${task.id}/sessions/${sessionId}`, { method: 'DELETE' });
      if (deletingCurrent) {
        detachTui();
        state.sessionTask = null;
        state.sessionSessionId = null;
      }
      closeModal();
      await refresh();
      if (deletingCurrent) openSessionsBoard();
      saveLayoutState();
      toast(result.permanentlyDeleted ? '空会话已直接永久删除' : '会话已移入回收站');
    } catch (error) { toast(error.message, 'error'); }
  };
}
function leaveCurrentSession() {
  if (!state.sessionTask || !state.sessionSessionId) return;
  markSessionRead(state.sessionTask, state.sessionSessionId);
}
function clearCurrentSessionSelection(taskId = null, sessionId = null) {
  if (!state.sessionTask || (taskId && state.sessionTask !== taskId) || (sessionId && state.sessionSessionId !== sessionId)) return false;
  leaveCurrentSession();
  detachTui();
  state.sessionTask = null;
  state.sessionSessionId = null;
  saveLayoutState();
  return true;
}
function hideSessionTask(task) {
  state.sessionTaskIds.delete(task.id);
  state.hiddenCompletedSessionTasks.add(task.id);
  if (state.sessionTask === task.id) {
    leaveCurrentSession();
    detachTui();
    state.sessionTask = null;
    state.sessionSessionId = null;
  }
  renderSessionTree();
  saveLayoutState();
  toast('任务已从会话列表移除');
}
async function closeSessionTaskSessions(task) {
  try {
    const current = state.sessionTask === task.id;
    await api(`/tasks/${task.id}/terminate`, { method: 'POST' });
    if (current) clearCurrentSessionSelection(task.id);
    await refresh();
    toast(`任务「${task.title}」下的全部子会话已关闭`);
  } catch (error) {
    toast(error.message, 'error');
  }
}
function handleSessionTaskAction(task) {
  return sessionTaskHasRunningSessions(task) ? closeSessionTaskSessions(task) : hideSessionTask(task);
}
function hideSessionPath(path) {
  const tasks = sessionTasks().filter((task) => (task.workingDir || '未设置工作路径') === path);
  if (!tasks.length) return;
  tasks.forEach((task) => {
    state.sessionTaskIds.delete(task.id);
    state.hiddenCompletedSessionTasks.add(task.id);
  });
  state.collapsedSessionPaths.delete(path);
  if (tasks.some((task) => task.id === state.sessionTask)) {
    leaveCurrentSession();
    detachTui();
    state.sessionTask = null;
    state.sessionSessionId = null;
  }
  renderSessionTree();
  saveLayoutState();
  toast('工作路径已从会话列表移除');
}
async function closeSessionPathSessions(path) {
  const tasks = sessionTasks().filter((task) => (task.workingDir || '未设置工作路径') === path);
  const runningTasks = tasks.filter(sessionTaskHasRunningSessions);
  if (!runningTasks.length) return hideSessionPath(path);
  try {
    const current = tasks.some((task) => task.id === state.sessionTask);
    await Promise.all(runningTasks.map((task) => api(`/tasks/${task.id}/terminate`, { method: 'POST' })));
    if (current) clearCurrentSessionSelection();
    await refresh();
    toast(`工作路径「${workingPathLabel(path === '未设置工作路径' ? '' : path)}」下的全部子会话已关闭`);
  } catch (error) {
    toast(error.message, 'error');
  }
}
function handleSessionPathAction(path) {
  const tasks = sessionTasks().filter((task) => (task.workingDir || '未设置工作路径') === path);
  return tasks.some(sessionTaskHasRunningSessions) ? closeSessionPathSessions(path) : hideSessionPath(path);
}
function markSessionRead(taskId, sessionId, { keepalive = false } = {}) {
  if (!taskId || !sessionId) return;
  const key = sessionMarkerKey(taskId, sessionId);
  const readThroughMessageId = seenSessionMessageIds.get(key);
  if (!readThroughMessageId || readRequests.get(key) === readThroughMessageId) return;
  readRequests.set(key, readThroughMessageId);
  void api(`/tasks/${encodeURIComponent(taskId)}/sessions/${encodeURIComponent(sessionId)}/read`, {
    method: 'POST', keepalive, body: { readThroughMessageId },
  }).then(() => {
    if (!keepalive) void refresh();
  }).catch(() => {
    // 保留本地旧计数；下次离开会话会重试，避免把失败误显示为已读。
  }).finally(() => {
    if (readRequests.get(key) === readThroughMessageId) readRequests.delete(key);
  });
}
function syncModuleTabs() {
  syncArchiveButton();
  const session = state.module === 'session';
  const tasks = $('#module-tasks');
  const notes = $('#module-notes');
  const sessionTab = $('#module-sessions');
  const workspaceTasks = $('#workspace-module-tasks');
  const workspaceNotes = $('#workspace-module-notes');
  const workspaceSession = $('#workspace-module-session');
  const taskCount = state.tasks.filter((task) => task.status !== 'archived').length;
  const noteCount = state.notes.filter((note) => note.status !== 'archived').length;
  const runningSessionCount = state.tasks
    .filter((task) => task.status !== 'archived')
    .reduce((count, task) => count + availableSessions(task).filter((item) => item.running).length, 0);
  tasks.querySelector('span:nth-of-type(2)').textContent = '任务';
  notes.querySelector('span:nth-of-type(2)').textContent = '便签';
  sessionTab.querySelector('span:nth-of-type(2)').textContent = '会话';
  tasks.querySelector('.module-count').textContent = number(taskCount);
  notes.querySelector('.module-count').textContent = number(noteCount);
  sessionTab.querySelector('.module-count').textContent = number(runningSessionCount);
  tasks.setAttribute('aria-label', `任务，${number(taskCount)}个`);
  notes.setAttribute('aria-label', `便签，${number(noteCount)}个`);
  sessionTab.setAttribute('aria-label', `会话，当前运行${number(runningSessionCount)}个`);
  tasks.tabIndex = 0;
  notes.tabIndex = 0;
  sessionTab.tabIndex = 0;
  const taskActive = !session && state.status !== 'archived' && state.boardType === 'tasks';
  const noteActive = !session && state.status !== 'archived' && state.boardType === 'notes';
  // 进入具体子会话后，选中态只由会话树中的子会话表示；顶部“会话”按钮仅表示会话看板。
  const sessionActive = !session && !state.status && state.boardType === 'sessions';
  tasks.classList.toggle('active', taskActive);
  notes.classList.toggle('active', noteActive);
  sessionTab.classList.toggle('active', sessionActive);
  tasks.setAttribute('aria-selected', String(taskActive));
  notes.setAttribute('aria-selected', String(noteActive));
  sessionTab.setAttribute('aria-selected', String(sessionActive));
  workspaceTasks?.classList.toggle('active', taskActive);
  workspaceNotes?.classList.toggle('active', noteActive);
  workspaceSession?.classList.toggle('active', sessionActive);
  workspaceTasks?.setAttribute('aria-pressed', String(taskActive));
  workspaceNotes?.setAttribute('aria-pressed', String(noteActive));
  workspaceSession?.setAttribute('aria-pressed', String(sessionActive));
}
function switchModule(module) {
  const session = module === 'session';
  if (session && state.status === 'archived') {
    state.status = '';
    applyViewSettings();
  }
  if (!session && state.sessionTask) leaveCurrentSession();
  state.module = session ? 'session' : 'tasks';
  saveLayoutState();
  document.body.classList.toggle('session-mode', session);
  syncModuleTabs();
  // 会话树始终留在侧边栏，只有主区域在任务/便签和终端之间切换。
  $('#task-toolbar').classList.toggle('hidden', session); $('#task-list').classList.toggle('hidden', session); $('#session-view').classList.toggle('hidden', !session);
  if (session) {
    rememberCurrentSessionMessage();
    renderSessionTree();
    // 返回会话页时恢复 xterm 的输入焦点，避免焦点停留在内容切换按钮上。
    requestAnimationFrame(() => {
      if (state.module === 'session') ensureTerminalInputFocus();
    });
  } else {
    // 离开会话页后保留会话上下文，但不让侧栏继续显示选中态。
    renderSessionTree();
    renderList();
  }
}

function closeThemeMenu() {
  const menu = $('#display-settings-menu');
  if (!menu || menu.classList.contains('hidden')) return;
  menu.classList.add('hidden');
  $('#display-settings-toggle').setAttribute('aria-expanded', 'false');
}
const SESSION_TREE_GROUP_ICONS = {
  task: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4.5" width="16" height="4" rx="1"/><rect x="4" y="10" width="16" height="4" rx="1"/><rect x="4" y="15.5" width="16" height="4" rx="1"/></svg>',
  path: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5h6l2 2h9v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2zM3.5 7.5v-1a2 2 0 0 1 2-2h4l2 2h5"/></svg>',
  combined: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16M4 12h9M4 19h5M7 5v14M13 12v7M16 12h4M16 19h4"/></svg>',
};
function syncSessionTreeToolState() {
  const groupToggle = $('#session-tree-group-toggle');
  const searchToggle = $('#session-tree-search-toggle');
  const sortToggle = $('#session-tree-sort-toggle');
  const searchPanel = $('#session-tree-search-panel');
  const sortMenu = $('#session-tree-sort-menu');
  const groupLabels = { task: '按任务分类', path: '按工作路径分类', combined: '按融合分类' };
  const mode = groupLabels[state.sessionTreeGroupMode] ? state.sessionTreeGroupMode : 'task';
  const groupLabel = groupLabels[mode];
  if (groupToggle) groupToggle.innerHTML = SESSION_TREE_GROUP_ICONS[mode];
  groupToggle?.classList.toggle('active', mode === 'combined');
  groupToggle?.setAttribute('title', `${groupLabel}（点击切换）`);
  groupToggle?.setAttribute('aria-label', `${groupLabel}，点击切换`);
  searchToggle?.classList.toggle('active', sessionTreeSearchOpen || Boolean(sessionTreeQuery.trim()));
  searchToggle?.setAttribute('aria-expanded', String(sessionTreeSearchOpen));
  sortToggle?.classList.toggle('active', sessionTreeSortOpen);
  sortToggle?.setAttribute('aria-expanded', String(sessionTreeSortOpen));
  searchPanel?.classList.toggle('hidden', !sessionTreeSearchOpen);
  sortMenu?.classList.toggle('hidden', !sessionTreeSortOpen);
  const input = $('#session-tree-search-input');
  if (input && input.value !== sessionTreeQuery) input.value = sessionTreeQuery;
  document.querySelectorAll('[data-session-sort]').forEach((button) => {
    button.setAttribute('aria-checked', String(button.dataset.sessionSort === sessionTreeSort));
  });
}
function closeSessionTreeTools() {
  if (!sessionTreeSearchOpen && !sessionTreeSortOpen) return;
  sessionTreeSearchOpen = false;
  sessionTreeSortOpen = false;
  syncSessionTreeToolState();
}
function toggleSessionTreeSearch() {
  sessionTreeSearchOpen = !sessionTreeSearchOpen;
  if (sessionTreeSearchOpen) { sessionTreeSortOpen = false; }
  if (sessionTreeSearchOpen) closeThemeMenu();
  syncSessionTreeToolState();
  if (sessionTreeSearchOpen) requestAnimationFrame(() => $('#session-tree-search-input')?.focus());
}
function toggleSessionTreeSort() {
  sessionTreeSortOpen = !sessionTreeSortOpen;
  if (sessionTreeSortOpen) { sessionTreeSearchOpen = false; }
  if (sessionTreeSortOpen) closeThemeMenu();
  syncSessionTreeToolState();
}
function toggleSessionTreeGroup() {
  const modes = ['task', 'path', 'combined'];
  const current = modes.includes(state.sessionTreeGroupMode) ? state.sessionTreeGroupMode : 'task';
  state.sessionTreeGroupMode = modes[(modes.indexOf(current) + 1) % modes.length];
  sessionSwitchMenuOpen = null;
  sessionTreeSearchOpen = false;
  sessionTreeSortOpen = false;
  closeThemeMenu();
  renderSessionTree();
  syncSessionTreeToolState();
  saveLayoutState();
}
let topbarNoteMenuAnchor = null;
function openTopbarNotePanel(note) {
  const panel = $('#topbar-note-panel');
  if (!panel) return;
  const title = note.title?.trim();
  panel.innerHTML = `${title ? `<div class="session-detail-row"><span>标题</span><p>${esc(title)}</p></div>` : ''}<div class="session-detail-row"><span>便签内容</span><p>${esc(note.description)}</p></div>`;
  panel.dataset.noteId = note.id;
  panel.classList.remove('hidden');
}
function closeTopbarNotePanel() {
  topbarNoteMenuAnchor?.setAttribute('aria-expanded', 'false');
  topbarNoteMenuAnchor = null;
  document.querySelector('.topbar-note-menu')?.remove();
  const panel = $('#topbar-note-panel');
  if (!panel) return;
  delete panel.dataset.noteId;
  panel.classList.add('hidden');
}
function openTopbarNoteMenu(button, note) {
  closeTopbarNotePanel();
  const menu = document.createElement('div');
  menu.className = 'session-note-menu topbar-note-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `<div class="session-note-menu-title">${esc(note.title?.trim() || '便签')}</div><button type="button" role="menuitem" data-topbar-note-action="details">查看详情</button><button type="button" role="menuitem" data-topbar-note-action="copy-description">复制描述</button><button type="button" role="menuitem" data-topbar-note-action="edit">编辑</button><button type="button" role="menuitem" data-topbar-note-action="remove">取消标记</button>`;
  document.body.append(menu);
  const rect = button.getBoundingClientRect();
  const gap = 8;
  const left = Math.min(Math.max(8, rect.right - menu.offsetWidth), window.innerWidth - menu.offsetWidth - 8);
  const top = rect.bottom + menu.offsetHeight + gap <= window.innerHeight
    ? rect.bottom + gap
    : Math.max(8, rect.top - menu.offsetHeight - gap);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  topbarNoteMenuAnchor = button;
  button.setAttribute('aria-expanded', 'true');
  menu.onclick = (event) => {
    const action = event.target.closest('[data-topbar-note-action]');
    if (!action) return;
    closeTopbarNotePanel();
    if (action.dataset.topbarNoteAction === 'details') openTopbarNotePanel(note);
    else if (action.dataset.topbarNoteAction === 'copy-description') void copySessionNoteDescription(note);
    else if (action.dataset.topbarNoteAction === 'edit') openNoteForm(note);
    else void removeTopbarNote(note);
  };
}
function toggleThemeMenu() {
  const menu = $('#display-settings-menu');
  const open = menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !open);
  $('#display-settings-toggle').setAttribute('aria-expanded', String(open));
}
$('#display-settings-toggle').onclick = () => toggleThemeMenu();
$('#display-settings-menu').onclick = (event) => {
  const style = event.target.closest('[data-theme-style]');
  const mode = event.target.closest('[data-display-mode]');
  if (style) applyThemeStyle(style.dataset.themeStyle);
  else if (mode) applyTheme(mode.dataset.displayMode);
  else return;
  void restartTuiForTheme();
  closeThemeMenu();
};
document.addEventListener('click', (event) => {
  if (!event.target.closest('#display-settings-toggle, #display-settings-menu')) closeThemeMenu();
  if (!event.target.closest('#session-tree-search-toggle, #session-tree-search-panel')) {
    sessionTreeSearchOpen = false;
    syncSessionTreeToolState();
  }
  if (!event.target.closest('#session-tree-sort-toggle, #session-tree-sort-menu')) {
    sessionTreeSortOpen = false;
    syncSessionTreeToolState();
  }
  if (!event.target.closest('#topbar-note-buttons, .topbar-note-menu')) closeTopbarNotePanel();
  if (!event.target.closest('#session-note-buttons, .session-note-menu:not(.topbar-note-menu)')) closeSessionNoteMenu();
  if (!event.target.closest('.session-title-switcher, .session-switch-menu')) closeSessionSwitchMenu();
  if (!event.target.closest('#session-context-copy')) {
    closeSessionActionMenu();
    if (sessionTaskDetailsOpen) closeSessionTaskDetails();
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeThemeMenu(); closeTopbarNotePanel(); closeSessionNoteMenu();
    closeSessionTreeTools();
    closeSessionActionMenu();
    closeSessionSwitchMenu();
    if (sessionTaskDetailsOpen) closeSessionTaskDetails();
  }
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (localStorage.getItem('workbench-theme') === 'system') { applyTheme('system'); void restartTuiForTheme(); } });
function openNewBoardItem(type) {
  if (state.status === 'archived') {
    state.status = '';
    state.boardType = type;
    applyViewSettings(); renderList(); saveLayoutState();
    recordWorkspaceView();
  }
  if (type === 'notes') openNoteForm();
  else openTaskForm();
}
function openBoardType(type) {
  state.boardType = type;
  if (state.status === 'archived') state.status = '';
  applyViewSettings();
  switchModule('tasks');
  saveLayoutState();
  recordWorkspaceView();
}
function openSessionsBoard() { openBoardType('sessions'); }
$('#module-tasks').onclick = () => openBoardType('tasks');
$('#module-notes').onclick = () => openBoardType('notes');
$('#module-sessions').onclick = openSessionsBoard;
$('#workspace-module-tasks').onclick = () => openBoardType('tasks');
$('#workspace-module-notes').onclick = () => openBoardType('notes');
$('#workspace-module-session').onclick = openSessionsBoard;
$('#session-tree-group-toggle').onclick = (event) => {
  event.stopPropagation();
  toggleSessionTreeGroup();
};
$('#session-tree-search-toggle').onclick = (event) => {
  event.stopPropagation();
  toggleSessionTreeSearch();
};
$('#session-tree-sort-toggle').onclick = (event) => {
  event.stopPropagation();
  toggleSessionTreeSort();
};
$('#session-tree-search-input').oninput = (event) => {
  sessionTreeQuery = event.target.value;
  renderSessionTree();
  syncSessionTreeToolState();
};
$('#session-tree-search-input').onkeydown = (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeSessionTreeTools();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    event.target.select();
  }
};
$('#session-tree-search-clear').onclick = (event) => {
  event.stopPropagation();
  sessionTreeQuery = '';
  renderSessionTree();
  syncSessionTreeToolState();
  $('#session-tree-search-input')?.focus();
};
$('#session-tree-sort-menu').onclick = (event) => {
  const option = event.target.closest('[data-session-sort]');
  if (!option || !SESSION_TREE_SORT_VALUES.has(option.dataset.sessionSort)) return;
  sessionTreeSort = option.dataset.sessionSort;
  localStorage.setItem('workbench-session-tree-sort', sessionTreeSort);
  sessionTreeSortOpen = false;
  renderSessionTree();
  syncSessionTreeToolState();
};
$('#sidebar-toggle').onclick = () => {
  const collapsed = !document.body.classList.contains('sidebar-collapsed');
  state.sidebarCollapsed = collapsed;
  applySidebarCollapsed(collapsed);
  syncMasonryColumns();
  syncOverflowTooltips();
  localStorage.setItem('workbench-sidebar-collapsed', String(collapsed));
  saveLayoutState();
};
[$('#module-tasks'), $('#module-notes'), $('#module-sessions')].forEach((tab, index, tabs) => {
  tab.onkeydown = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    let nextIndex = index;
    if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.length - 1;
    else nextIndex = (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[nextIndex].focus();
    tabs[nextIndex].click();
  };
});
$('#archive-toggle').onclick = () => {
  state.status = 'archived';
  applyViewSettings();
  switchModule('tasks');
  renderList();
  saveLayoutState();
  recordWorkspaceView();
};
// 两个新建任务入口共用同一弹窗；侧栏入口默认打开新会话，工具栏入口默认不打开。
$('#sidebar-new-task').onclick = () => openTaskForm(null, { openSessionAfterCreate: true });
$('#sidebar-new-note').onclick = () => openNewBoardItem('notes');
$('#toolbar-new-item').onclick = () => state.boardType === 'sessions' ? openNewSessionModal() : openNewBoardItem(state.boardType);
$('#sidebar-new-session-task').onclick = () => openNewSessionModal();
function clearTerminalSearch() {
  const input = $('#terminal-search-input');
  if (!input) return;
  input.value = '';
  const results = $('#terminal-search-results');
  results.textContent = '';
  results.hidden = true;
  terminalSearchAddon?.clearDecorations();
}
function focusTerminalSearch(select = false) {
  const panel = $('#terminal-search');
  const input = $('#terminal-search-input');
  if (!panel || !input) return;
  panel.classList.remove('hidden');
  input.focus();
  if (select) input.select();
}
function searchTerminal(previous = false) {
  const input = $('#terminal-search-input');
  const results = $('#terminal-search-results');
  const term = input?.value || '';
  if (!term) {
    terminalSearchAddon?.clearDecorations();
    if (results) { results.textContent = ''; results.hidden = true; }
    return;
  }
  if (!terminalSearchAddon) {
    if (results) { results.textContent = '终端未就绪'; results.hidden = false; }
    return;
  }
  const found = previous
    ? terminalSearchAddon.findPrevious(term)
    : terminalSearchAddon.findNext(term);
  // 未找到时不在顶部工具栏额外占位显示提示，搜索结果仍由 xterm 的高亮反馈。
  if (results) { results.textContent = ''; results.hidden = true; }
}
$('#terminal-search-results').hidden = true;
$('#session-task-select').onchange = (event) => selectSession(event.target.value);
$('#terminal-search-previous').onclick = () => searchTerminal(true);
$('#terminal-search-next').onclick = () => searchTerminal();
$('#terminal-search-input').oninput = () => searchTerminal();
$('#terminal-search-input').onkeydown = (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    clearTerminalSearch();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    searchTerminal(event.shiftKey);
  }
};
// 会话页的空白区域不应把焦点从终端输入框移走；真正的交互控件仍保留自己的焦点行为。
function keepTerminalFocusOnBlankArea(event) {
  if (state.module !== 'session' || !terminal || $('.modal')) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest('button, a, input, select, textarea, [contenteditable="true"], [tabindex]:not([tabindex="-1"]), [role="button"], [role="tab"], [role="menuitem"], .session-name-title, .session-description-panel, .session-note-menu, .xterm')) return;
  // 阻止浏览器在空白控制带上产生临时焦点，再把焦点交还给终端。
  if (event.type === 'pointerdown') event.preventDefault();
  ensureTerminalInputFocus();
}
document.addEventListener('pointerdown', keepTerminalFocusOnBlankArea, true);
document.addEventListener('click', keepTerminalFocusOnBlankArea);
// 侧边栏按钮完成动作后也不保留按钮焦点；有弹窗时则把焦点留给弹窗。
function restoreTerminalFocusAfterSidebarInteraction(event) {
  if (state.module !== 'session' || !terminal || $('.modal')) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest('#app-sidebar button');
  if (!button) return;
  button.blur();
  ensureTerminalInputFocus();
}
document.addEventListener('pointerup', restoreTerminalFocusAfterSidebarInteraction);
document.addEventListener('click', restoreTerminalFocusAfterSidebarInteraction);
function toggleSessionSwitchMenu(kind) {
  const task = currentTask(state.sessionTask);
  const mode = state.sessionTreeGroupMode;
  if (kind === 'path' && !['path', 'combined'].includes(mode)) return;
  if (kind === 'path' && !sessionPathSwitchOptions().length) return;
  if (kind === 'task' && mode === 'path') return;
  if (kind === 'task' && !(mode === 'combined' ? sessionTasksWithChildrenForPath(task?.workingDir || '').length : sessionTasksWithChildren().length)) return;
  if (kind === 'session' && (!task || !sessionSwitchEntries(task).length)) return;
  sessionActionMenuOpen = false;
  sessionTaskDetailsOpen = false;
  sessionSwitchMenuOpen = sessionSwitchMenuOpen === kind ? null : kind;
  renderSessionHeader();
}
$('#session-path-name').onclick = (event) => {
  event.stopPropagation();
  toggleSessionSwitchMenu('path');
};
$('#session-task-name').onclick = (event) => {
  event.stopPropagation();
  toggleSessionSwitchMenu('task');
};
$('#session-name').onclick = (event) => {
  event.stopPropagation();
  toggleSessionSwitchMenu('session');
};
$('#session-path-switch-menu').onclick = (event) => {
  const option = event.target.closest('[data-session-switch-path]');
  if (!option) return;
  const entry = lastOpenedSessionForPath(option.dataset.sessionSwitchPath);
  if (!entry) return;
  sessionSwitchMenuOpen = null;
  void selectSession(entry.task.id, entry.session.id);
};
$('#session-task-switch-menu').onclick = (event) => {
  const option = event.target.closest('[data-session-switch-task]');
  if (!option) return;
  const task = currentTask(option.dataset.sessionSwitchTask);
  if (!task) return;
  sessionSwitchMenuOpen = null;
  const session = lastOpenedSessionForTask(task);
  if (session) {
    void selectSession(task.id, session.id);
    return;
  }
};
$('#session-session-switch-menu').onclick = (event) => {
  const option = event.target.closest('[data-session-switch-session]');
  if (!option) return;
  const task = currentTask(option.dataset.sessionSwitchTask);
  const session = availableSessions(task).find((item) => item.id === option.dataset.sessionSwitchSession);
  if (!task || !session) return;
  sessionSwitchMenuOpen = null;
  void selectSession(task.id, session.id);
};
$('#copy-session-file').onclick = (event) => {
  event.stopPropagation();
  const task = currentTask(state.sessionTask);
  if (!task) return;
  sessionSwitchMenuOpen = null;
  sessionActionMenuOpen = !sessionActionMenuOpen;
  if (sessionActionMenuOpen) sessionTaskDetailsOpen = false;
  renderSessionHeader();
};
$('#session-action-menu').onclick = async (event) => {
  const action = event.target.closest('[data-session-action]');
  if (!action || action.disabled) return;
  const task = currentTask(state.sessionTask);
  const session = (task?.sessions || []).find((item) => item.id === state.sessionSessionId);
  const commandPath = session?.sessionFile;
  const description = task?.description?.trim();
  const workingDir = task?.workingDir?.trim();
  const kind = action.dataset.sessionAction;
  if (kind === 'copy') return; // 顶层「复制」仅负责展开子菜单（悬停）
  closeSessionActionMenu();
  if (kind === 'details') {
    sessionTaskDetailsOpen = true;
    renderSessionHeader();
    return;
  }
  if (kind === 'rename') {
    openSessionModal(task, session);
    return;
  }
  const text = kind === 'copy-command'
    ? (commandPath ? `pi --session "${commandPath}"` : '')
    : kind === 'copy-working-dir'
      ? workingDir || ''
      : (description || '');
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    const copyMessages = { 'copy-command': 'pi 会话命令已复制', 'copy-working-dir': '工作路径已复制', 'copy-description': '任务描述已复制' };
    toast(copyMessages[kind] || '已复制');
  } catch {
    toast('复制失败，请手动选择内容', 'error');
  }
};
let sessionNoteMenuAnchor = null;
function closeSessionNoteMenu() {
  sessionNoteMenuAnchor?.setAttribute('aria-expanded', 'false');
  sessionNoteMenuAnchor = null;
  document.querySelector('.session-note-menu:not(.topbar-note-menu)')?.remove();
}
function openSessionNoteMenu(button, note) {
  closeSessionNoteMenu();
  const menu = document.createElement('div');
  menu.className = 'session-note-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `<div class="session-note-menu-title">${esc(note.title?.trim() || '便签')}</div><button type="button" role="menuitem" data-session-note-mode="current">发送到当前会话</button><button type="button" role="menuitem" data-session-note-mode="new">新建后台会话并发送</button><button type="button" role="menuitem" data-session-note-action="copy-description">复制描述</button><button type="button" role="menuitem" data-session-note-action="edit">编辑</button><button type="button" role="menuitem" data-session-note-action="remove">取消标记</button>`;
  document.body.append(menu);
  const rect = button.getBoundingClientRect();
  const gap = 8;
  const left = Math.min(Math.max(8, rect.right - menu.offsetWidth), window.innerWidth - menu.offsetWidth - 8);
  const top = rect.bottom + menu.offsetHeight + gap <= window.innerHeight
    ? rect.bottom + gap
    : Math.max(8, rect.top - menu.offsetHeight - gap);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  sessionNoteMenuAnchor = button;
  button.setAttribute('aria-expanded', 'true');
  menu.onclick = (event) => {
    const action = event.target.closest('[data-session-note-action]');
    if (action) {
      closeSessionNoteMenu();
      if (action.dataset.sessionNoteAction === 'copy-description') void copySessionNoteDescription(note);
      else if (action.dataset.sessionNoteAction === 'edit') openNoteForm(note);
      else void removeSessionNote(note);
      return;
    }
    const option = event.target.closest('[data-session-note-mode]');
    if (!option) return;
    const mode = option.dataset.sessionNoteMode;
    closeSessionNoteMenu();
    void sendSessionNote(note, mode);
  };
}
async function sendSessionNote(note, mode) {
  const taskId = state.sessionTask;
  const sessionId = state.sessionSessionId;
  if (!taskId || !sessionId) return toast('请先打开一个会话', 'error');
  try {
    const result = await api(`/notes/${note.id}/send`, { method: 'POST', body: { taskId, sessionId, mode } });
    await refresh();
    toast(mode === 'new' ? '已在后台新建会话并发送便签' : '便签已发送到当前会话');
    return result;
  } catch (error) { toast(error.message, 'error'); }
}
async function copySessionNoteDescription(note) {
  const description = note.description?.trim();
  if (!description) return toast('便签没有描述内容', 'error');
  try {
    await navigator.clipboard.writeText(description);
    toast('便签描述已复制');
  } catch {
    toast('复制失败，请手动选择内容', 'error');
  }
}
async function removeSessionNote(note) {
  try {
    await api(`/notes/${note.id}`, { method: 'PUT', body: { pinnedToSessionBar: false } });
    await refresh();
    toast('已移除会话标记');
  } catch (error) { toast(error.message, 'error'); }
}
async function removeTopbarNote(note) {
  try {
    await api(`/notes/${note.id}`, { method: 'PUT', body: { pinnedToTopBar: false } });
    await refresh();
    toast('已取消提醒标记');
  } catch (error) { toast(error.message, 'error'); }
}
function finishNoteDrag(commit = false) {
  clearTimeout(noteDragTimer); noteDragTimer = null;
  const drag = noteDrag;
  noteDrag = null;
  if (!drag?.active) return;
  drag.button.classList.remove('note-dragging');
  drag.root.classList.remove('note-drag-active');
  try { drag.button.releasePointerCapture(drag.pointerId); } catch { /* capture already released */ }
  suppressNoteClickUntil = Date.now() + 500;
  if (!commit) return;
  const ids = [...drag.root.querySelectorAll(`button[data-note-placement="${drag.placement}"]`)].map((item) => item.dataset.noteId);
  void api('/notes/reorder', { method: 'POST', body: { placement: drag.placement, ids } }).then(() => refresh()).catch((error) => toast(error.message, 'error'));
}
function bindNoteDrag(root) {
  root.addEventListener('pointerdown', (event) => {
    const button = event.target.closest('button[data-note-placement]');
    if (!button || event.button !== 0) return;
    const placement = button.dataset.notePlacement;
    noteDrag = { button, root, placement, pointerId: event.pointerId, active: false };
    clearTimeout(noteDragTimer);
    noteDragTimer = setTimeout(() => {
      if (!noteDrag || noteDrag.button !== button) return;
      noteDrag.active = true;
      button.classList.add('note-dragging'); root.classList.add('note-drag-active');
      button.setPointerCapture(event.pointerId);
      navigator.vibrate?.(12);
    }, 450);
  });
  root.addEventListener('pointermove', (event) => {
    if (!noteDrag?.active || noteDrag.root !== root) return;
    event.preventDefault();
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(`button[data-note-placement="${noteDrag.placement}"]`);
    if (!target || target === noteDrag.button || !root.contains(target)) return;
    const rect = target.getBoundingClientRect();
    root.insertBefore(noteDrag.button, event.clientX < rect.left + rect.width / 2 ? target : target.nextSibling);
  });
  root.addEventListener('pointerup', (event) => {
    if (noteDrag?.root === root && noteDrag.pointerId === event.pointerId) finishNoteDrag(true);
  });
  root.addEventListener('pointercancel', (event) => {
    if (noteDrag?.root === root && noteDrag.pointerId === event.pointerId) finishNoteDrag(false);
  });
  root.addEventListener('contextmenu', (event) => { if (noteDrag?.active) event.preventDefault(); });
}
bindNoteDrag($('#session-note-buttons'));
bindNoteDrag($('#topbar-note-buttons'));
// 指针移出按钮容器后，pointerup 可能不再经过容器；全局兜底，确保拖动态总能清理。
window.addEventListener('pointerup', (event) => {
  if (noteDrag?.pointerId === event.pointerId) finishNoteDrag(true);
});
window.addEventListener('pointercancel', (event) => {
  if (noteDrag?.pointerId === event.pointerId) finishNoteDrag(false);
});
window.addEventListener('blur', () => finishNoteDrag(false));
$('#topbar-note-buttons').onclick = (event) => {
  if (Date.now() < suppressNoteClickUntil) return;
  if (event.target.closest('[data-new-topbar-note]')) { openNoteForm(null, { pinnedToTopBar: true }); return; }
  const button = event.target.closest('[data-topbar-note]');
  if (!button) return;
  const note = currentNote(button.dataset.topbarNote);
  if (!note) return;
  if (topbarNoteMenuAnchor === button) {
    closeTopbarNotePanel();
    button.blur();
    return;
  }
  openTopbarNoteMenu(button, note);
};
$('#session-note-buttons').onclick = (event) => {
  if (Date.now() < suppressNoteClickUntil) return;
  if (event.target.closest('[data-new-session-note]')) { openNoteForm(null, { pinnedToSessionBar: true }); return; }
  const button = event.target.closest('[data-session-note]');
  if (!button) return;
  const note = currentNote(button.dataset.sessionNote);
  if (!note) return;
  if (sessionNoteMenuAnchor === button) {
    closeSessionNoteMenu();
    button.blur();
    ensureTerminalInputFocus();
    return;
  }
  openSessionNoteMenu(button, note);
};
async function reconnectTreeSession(taskId, sessionId) {
  // 仅当前正在查看的子会话支持双击重新连接；其他项仍按普通打开处理。
  if (state.module !== 'session' || state.sessionTask !== taskId || state.sessionSessionId !== sessionId) return selectSession(taskId, sessionId);
  return restartCurrentTui('正在重新连接会话…');
}
async function closeOrDeleteSession(task, sessionId) {
  const session = availableSessions(task).find((item) => item.id === sessionId);
  if (!session) return;
  const current = state.sessionTask === task.id && state.sessionSessionId === sessionId;
  try {
    if (session.running) {
      await api(`/tasks/${task.id}/sessions/${sessionId}/stop`, { method: 'POST' });
      if (current) clearCurrentSessionSelection(task.id, sessionId);
      await refresh();
      return;
    }
    if (current) leaveCurrentSession();
    await api(`/tasks/${task.id}/sessions/${sessionId}`, { method: 'DELETE' });
    if (current) {
      detachTui();
      state.sessionTask = null;
      state.sessionSessionId = null;
    }
    await refresh();
    if (current) openSessionsBoard();
    saveLayoutState();
  } catch (error) {
    toast(error.message, 'error');
  }
}
async function toggleSessionFavorite(task, session) {
  try {
    await api(`/tasks/${task.id}/sessions/${session.id}`, { method: 'PATCH', body: { favorite: !session.favorite } });
    await refresh();
  } catch (error) {
    toast(error.message, 'error');
  }
}
$('#session-tree').onclick = (event) => {
  const create = event.target.closest('[data-new-session-task]');
  if (create) { const task = currentTask(create.dataset.newSessionTask); if (task) void createChildSession(task); return; }
  const createPath = event.target.closest('[data-new-session-path]');
  if (createPath) { openNewSessionModal(createPath.dataset.newSessionPath); return; }
  const favorite = event.target.closest('[data-favorite-session-task]');
  if (favorite) {
    event.stopPropagation();
    const task = currentTask(favorite.dataset.favoriteSessionTask);
    const session = availableSessions(task).find((item) => item.id === favorite.dataset.favoriteSessionId);
    if (task && session) void toggleSessionFavorite(task, session);
    return;
  }
  const removeCompleted = event.target.closest('[data-remove-completed-task]');
  if (removeCompleted) {
    event.stopPropagation();
    removeCompleted.blur();
    const task = currentTask(removeCompleted.dataset.removeCompletedTask);
    if (task) void handleSessionTaskAction(task);
    return;
  }
  const removePath = event.target.closest('[data-remove-session-path]');
  if (removePath) {
    event.stopPropagation();
    removePath.blur();
    void handleSessionPathAction(removePath.dataset.removeSessionPath);
    return;
  }
  const remove = event.target.closest('[data-delete-session]');
  if (remove) {
    event.stopPropagation();
    remove.blur();
    const task = currentTask(remove.dataset.deleteSession);
    if (task) void closeOrDeleteSession(task, remove.dataset.sessionId);
    return;
  }
  const group = event.target.closest('[data-session-group]');
  if (group) {
    const id = group.dataset.sessionGroup;
    if (state.collapsedSessionTasks.has(id)) state.collapsedSessionTasks.delete(id);
    else state.collapsedSessionTasks.add(id);
    renderSessionTree();
    saveLayoutState();
    return;
  }
  const pathGroup = event.target.closest('[data-session-path-group]');
  if (pathGroup) {
    const path = pathGroup.dataset.sessionPathGroup;
    if (state.collapsedSessionPaths.has(path)) state.collapsedSessionPaths.delete(path);
    else state.collapsedSessionPaths.add(path);
    renderSessionTree();
    saveLayoutState();
    return;
  }
  const item = event.target.closest('[data-session-task]');
  if (!item) return;
  const taskId = item.dataset.sessionTask;
  const sessionId = item.dataset.sessionId;
  // 首击先等待一小段时间，不重绘树，第二击才能可靠地被识别为双击。
  if (sessionTreeClickTimer) {
    clearTimeout(sessionTreeClickTimer);
    sessionTreeClickTimer = null;
    void reconnectTreeSession(taskId, sessionId);
    return;
  }
  sessionTreeClickTimer = setTimeout(() => {
    sessionTreeClickTimer = null;
    void selectSession(taskId, sessionId);
  }, 240);
};
$('#board-filter-tabs').onclick = (event) => {
  const filter = event.target.closest('[data-filter-value]');
  if (!filter) return;
  const value = filter.dataset.filterValue;
  if (filter.dataset.filterType === 'archive') {
    state.status = 'archived';
    state.archiveType = value;
  } else if (filter.dataset.filterType === 'note') {
    state.boardType = 'notes';
    state.status = '';
    state.noteFilter = value;
  } else if (filter.dataset.filterType === 'session') {
    state.boardType = 'sessions';
    state.status = '';
    state.sessionFilter = value;
  } else {
    state.boardType = 'tasks';
    state.status = value;
  }
  applyViewSettings(); renderTaskSidebar(); renderList(); saveLayoutState();
  recordWorkspaceView();
};
$('#sort-toggle').onclick = () => {
  const index = SORT_OPTIONS.findIndex((option) => option.value === state.sort);
  updateViewSetting('sort', SORT_OPTIONS[(index + 1) % SORT_OPTIONS.length].value);
  syncSortControl(); renderList(); saveLayoutState();
};
$('#board-group-toggle').onclick = () => {
  const options = boardGroupOptions();
  const index = options.findIndex((option) => option.value === state.boardGroup);
  updateViewSetting('boardGroup', options[(index + 1) % options.length].value);
  renderList(); saveLayoutState();
};
$('#board-card-layout').onclick = () => { updateViewSetting('boardCardLayout', state.boardCardLayout === 'compact' ? 'single' : 'compact'); syncCardLayoutControl(); renderList(); saveLayoutState(); };
$('#search').oninput = (event) => { state.search = event.target.value; renderList(); saveLayoutState(); };
document.addEventListener('keydown', (event) => {
  if ($('.modal') || state.module !== 'tasks') return;
  const target = event.target;
  const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable;
  const key = event.key.toLowerCase();
  if ((event.metaKey || event.ctrlKey) && key === 'k') {
    event.preventDefault(); $('#search').focus(); $('#search').select();
  } else if (!typing && key === '/') {
    event.preventDefault(); $('#search').focus();
  } else if (!typing && !event.metaKey && !event.ctrlKey && key === 'n') {
    event.preventDefault();
    if (state.boardType === 'notes') openNoteForm();
    else openTaskForm();
  }
});
function clearBoardSearch() {
  state.search = '';
  $('#search').value = '';
  renderList();
  saveLayoutState();
  recordWorkspaceView();
}
$('#task-list').onclick = async (event) => {
  const button = event.target.closest('[data-action]'); if (!button) return;
  if (button.dataset.action === 'purge-archived') {
    openClearArchivedModal();
    return;
  }
  if (button.dataset.action === 'clear-note-filters' || button.dataset.action === 'clear-session-filters') {
    clearBoardSearch();
    return;
  }
  if (button.dataset.taskId && button.dataset.sessionId) {
    const task = currentTask(button.dataset.taskId);
    const session = (task?.sessions || []).find((item) => item.id === button.dataset.sessionId);
    if (!task || !session) return;
    try {
      switch (button.dataset.action) {
        case 'open-session-card':
          if (session.status === 'archived' && task.status !== 'archived') {
            await api(`/tasks/${task.id}/sessions/${session.id}/restore`, { method: 'POST' });
            await refresh();
          }
          showSessionTask(task.id);
          await selectSession(task.id, session.id);
          break;
        case 'toggle-session-favorite':
          await toggleSessionFavorite(task, session);
          break;
        case 'rename-session':
          openSessionModal(task, session);
          break;
        case 'delete-session-card':
          openDeleteSessionModal(task, session.id);
          break;
        case 'purge-session': {
          const form = modal(`<h2>永久删除会话</h2><p>确定永久删除会话「${esc(session.title || '新会话')}」及其会话文件吗？此操作不可恢复。</p><div class="modal-actions"><button class="danger" id="confirm-purge-session">永久删除</button><button data-close>取消</button></div>`);
          $('[data-close]', form).onclick = closeModal;
          $('#confirm-purge-session', form).onclick = async () => {
            try {
              await api(`/tasks/${task.id}/sessions/${session.id}/permanent`, { method: 'DELETE' });
              closeModal();
              await refresh();
              toast('会话已永久删除');
            } catch (error) {
              toast(error.message, 'error');
            }
          };
          break;
        }
        default:
          break;
      }
    } catch (error) {
      toast(error.message, 'error');
    }
    return;
  }
  const noteActions = ['edit-note', 'delete-note', 'restore-note', 'purge-note', 'toggle-top-note', 'toggle-session-note'];
  // 回收站的“全部”视图可能在便签页状态下同时渲染任务和便签，不能仅凭 boardType 分流。
  if (button.closest('.note-card') || noteActions.includes(button.dataset.action)) {
    const note = currentNote(button.dataset.id);
    if (!note) return;
    try {
      if (button.dataset.action === 'edit-note') openNoteForm(note);
      else if (button.dataset.action === 'delete-note') openDeleteNoteModal(note);
      else if (button.dataset.action === 'restore-note') { await api(`/notes/${note.id}/restore`, { method: 'POST' }); await refresh(); toast('便签已恢复'); }
      else if (button.dataset.action === 'purge-note') { await api(`/notes/${note.id}/permanent`, { method: 'DELETE' }); await refresh(); toast('便签已永久删除'); }
      else if (button.dataset.action === 'toggle-top-note' || button.dataset.action === 'toggle-session-note') {
        const key = button.dataset.action === 'toggle-top-note' ? 'pinnedToTopBar' : 'pinnedToSessionBar';
        await api(`/notes/${note.id}`, { method: 'PUT', body: { [key]: !note[key] } });
        await refresh();
      }
    } catch (error) { toast(error.message, 'error'); }
    return;
  }
  const task = currentTask(button.dataset.id);
  try {
    if (button.dataset.action === 'clear-filters') {
      state.search = ''; state.status = '';
      applyViewSettings();
      $('#search').value = '';
      renderTaskSidebar(); renderList(); saveLayoutState();
      recordWorkspaceView();
      $('#search').focus();
    } else if (button.dataset.action === 'execute') {
      button.disabled = true;
      button.textContent = '打开中…';
      await openExecute(task);
    }
    else if (button.dataset.action === 'session') {
      showSessionTask(task.id);
      if (!availableSessions(task).length) {
        const result = await api(`/tasks/${task.id}/sessions`, { method: 'POST', body: { title: '新会话' } });
        saveLayoutState();
        await refresh();
        switchModule('session'); selectSession(task.id, result.session.id);
        toast('已新建会话。');
      } else {
        saveLayoutState();
        switchModule('session'); selectSession(task.id, task.activeSessionId || null);
      }
    }
    else if (button.dataset.action === 'edit') openTaskForm(task);
    else if (button.dataset.action === 'delete') openDeleteTaskModal(task);
    else if (button.dataset.action === 'open-archived-session') {
      await openTaskSession(task);
      toast('已进入子会话，任务仍为废弃状态');
    }
    else if (button.dataset.action === 'restore') {
      const restoredTask = await restoreTask(task);
      const restoredLabel = STATUS[restoredTask?.status]?.label || '已恢复';
      toast(`任务已恢复到${restoredLabel}`);
    }
    else if (button.dataset.action === 'purge') openPurgeTaskModal(task);
    else if (button.dataset.action === 'purge-archived') openClearArchivedModal();
    else if (button.dataset.action === 'complete') {
      if (runningSessionCount(task)) openCompleteTaskModal(task);
      else await finishCompleteTask(task);
    }
    else if (button.dataset.action === 'reopen') { await api(`/tasks/${task.id}/reopen`, { method: 'POST' }); toast('任务已重开'); refresh(); }
    else if (button.dataset.action === 'terminate' && confirm('确定终止当前 pi TUI 吗？')) { await api(`/tasks/${task.id}/terminate`, { method: 'POST' }); toast('执行已终止'); refresh(); }
  } catch (error) { toast(error.message, 'error'); }
};
$('#purge-archived').onclick = () => openClearArchivedModal();

let refreshTimer = null;
function scheduleRefresh(delay = 100) {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; void refresh(); }, delay);
}
const taskEvents = new EventSource('/workbench/api/events');
taskEvents.onmessage = ({ data }) => {
  try {
    const event = JSON.parse(data);
    if (event.type === 'tasks_changed') scheduleRefresh();
  } catch { /* ignore malformed event */ }
};
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { pauseMarqueeMotion(); return; }
  resumeMarqueeMotion();
  if (state.module === 'session') void refresh();
});
window.addEventListener('pagehide', () => {
  stopMarqueeMotion();
  if (state.sessionTask) markSessionRead(state.sessionTask, state.sessionSessionId, { keepalive: true });
  taskEvents.close();
}, { once: true });
void api('/config').then((config) => { dshAvailable = Boolean(config?.dshAvailable); }).catch(() => {});
syncSessionTreeToolState();
refresh();
// SSE 是实时更新路径；不再对任务列表进行定时轮询，避免无必要地重绘任务卡片。
