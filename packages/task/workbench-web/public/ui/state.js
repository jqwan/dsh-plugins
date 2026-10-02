export const STATUS = {
  unfinished: { label: '未完成', cls: 'unfinished' },
  done: { label: '已完成', cls: 'done' },
  archived: { label: '废弃', cls: 'archived' },
};

export const COLORS = {
  red: { label: '#DF7468', value: '#df7468' },
  orange: { label: '#E59654', value: '#e59654' },
  yellow: { label: '#D3B13E', value: '#d3b13e' },
  green: { label: '#6EAA7B', value: '#6eaa7b' },
  cyan: { label: '#4DA9A4', value: '#4da9a4' },
  blue: { label: '#7098C0', value: '#7098c0' },
  purple: { label: '#A184B6', value: '#a184b6' },
  gray: { label: '#96A5A7', value: '#96a5a7' },
};

const CUSTOM_COLORS_STORAGE_KEY = 'workbench-custom-colors';
export const MAX_CUSTOM_COLORS = 9;
const LAYOUT_STORAGE_KEY = 'workbench-layout';
const LEGACY_COLOR = { high: 'red', medium: 'yellow', low: 'blue' };

const NOTE_FILTER_KEYS = ['all', 'normal', 'topbar', 'session'];
const NOTE_VIEW_SETTING_KEYS = NOTE_FILTER_KEYS.map((key) => `notes:${key}`);
const SESSION_FILTER_KEYS = ['all', 'favorite', 'running', 'stopped'];
const SESSION_VIEW_SETTING_KEYS = SESSION_FILTER_KEYS.map((key) => `sessions:${key}`);
const ARCHIVE_TYPE_KEYS = ['all', 'tasks', 'notes', 'sessions'];
const ARCHIVE_VIEW_SETTING_KEYS = ARCHIVE_TYPE_KEYS.map((key) => `archive:${key}`);
const VIEW_SETTING_KEYS = ['', ...Object.keys(STATUS), ...NOTE_VIEW_SETTING_KEYS, ...SESSION_VIEW_SETTING_KEYS, ...ARCHIVE_VIEW_SETTING_KEYS];
const DEFAULT_VIEW_SETTINGS = { sort: 'updated', boardGroup: 'single', boardCardLayout: 'single' };
function normalizeViewStatus(value) {
  if (value === 'todo' || value === 'running' || value === 'unfinished') return 'unfinished';
  return value === 'done' || value === 'archived' ? value : '';
}
function normalizeViewSettingsKey(value) {
  const key = String(value || '');
  if (key.startsWith('notes:')) return NOTE_VIEW_SETTING_KEYS.includes(key) ? key : null;
  if (key.startsWith('sessions:')) return SESSION_VIEW_SETTING_KEYS.includes(key) ? key : null;
  if (key.startsWith('archive:')) return ARCHIVE_VIEW_SETTING_KEYS.includes(key) ? key : null;
  if (key === '') return '';
  const normalized = normalizeViewStatus(key);
  return ['unfinished', 'done', 'archived'].includes(normalized) ? normalized : null;
}
function currentViewSettingsKey(status = state.status) {
  if (status === 'archived') return `archive:${state.archiveType}`;
  if (state.boardType === 'notes') return `notes:${state.noteFilter}`;
  if (state.boardType === 'sessions') return `sessions:${state.sessionFilter}`;
  return status;
}

export const state = {
  tasks: [], notes: [], boardType: 'tasks', archiveType: 'all', noteFilter: 'all', sessionFilter: 'all', status: '',
  boardGroup: 'single', boardCardLayout: 'single', sort: 'updated', search: '', signature: '',
  viewSettings: Object.fromEntries(VIEW_SETTING_KEYS.map((key) => [key, { ...DEFAULT_VIEW_SETTINGS }])),
  module: 'tasks', sidebarCollapsed: false, sessionTask: null, sessionSessionId: null,
  collapsedSessionTasks: new Set(), collapsedSessionPaths: new Set(), sessionTreeGroupMode: 'task', sessionTaskIds: new Set(), hiddenCompletedSessionTasks: new Set(),
};

export function applyViewSettings(status = state.status) {
  const settings = state.viewSettings[currentViewSettingsKey(status)] || DEFAULT_VIEW_SETTINGS;
  state.sort = settings.sort;
  state.boardGroup = settings.boardGroup;
  state.boardCardLayout = settings.boardCardLayout;
}

export function updateViewSetting(key, value) {
  if (!Object.hasOwn(DEFAULT_VIEW_SETTINGS, key)) return;
  const settingsKey = currentViewSettingsKey();
  const current = state.viewSettings[settingsKey] || { ...DEFAULT_VIEW_SETTINGS };
  state.viewSettings[settingsKey] = { ...current, [key]: value };
  state[key] = value;
}

export let customColors = loadCustomColors();

function loadCustomColors() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CUSTOM_COLORS_STORAGE_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    const entries = Object.entries(parsed)
      .filter(([key, value]) => /^custom-[a-z0-9-]+$/.test(key) && value && /^#[0-9a-f]{6}$/i.test(value.value))
      .map(([key, value]) => [key, {
        label: value.value.toUpperCase(),
        value: value.value.toLowerCase(),
        createdAt: Number(value.createdAt) || 0,
        useCount: Math.max(0, Number(value.useCount) || 0),
        lastUsedAt: Number(value.lastUsedAt) || 0,
      }])
      // 兼容历史数据：超过上限时优先保留使用次数和最近使用时间更高的颜色。
      .sort(([, a], [, b]) => b.useCount - a.useCount || b.lastUsedAt - a.lastUsedAt || b.createdAt - a.createdAt);
    return Object.fromEntries(entries.slice(0, MAX_CUSTOM_COLORS));
  } catch { return {}; }
}

export function colorCatalog() { return { ...COLORS, ...customColors }; }

export function saveCustomColors() {
  try { localStorage.setItem(CUSTOM_COLORS_STORAGE_KEY, JSON.stringify(customColors)); } catch { /* ignore unavailable browser storage */ }
}

export function taskColor(task) {
  const catalog = colorCatalog();
  return catalog[task.color] ? task.color : LEGACY_COLOR[task.priority] || 'blue';
}

export function loadLayoutState() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) || '{}') || {}; } catch { /* ignore malformed browser data */ }
  if (saved.module === 'tasks' || saved.module === 'session') state.module = saved.module;
  if (['notes', 'tasks', 'sessions'].includes(saved.boardType)) state.boardType = saved.boardType;
  if (ARCHIVE_TYPE_KEYS.includes(saved.archiveType)) state.archiveType = saved.archiveType;
  if (NOTE_FILTER_KEYS.includes(saved.noteFilter)) state.noteFilter = saved.noteFilter;
  if (SESSION_FILTER_KEYS.includes(saved.sessionFilter)) state.sessionFilter = saved.sessionFilter;
  const savedStatus = normalizeViewStatus(saved.status);
  if (VIEW_SETTING_KEYS.includes(savedStatus)) state.status = savedStatus;

  // 将旧版全局设置迁移到“任务”和当前分类，避免升级后当前视图突然改变。
  const legacy = {};
  if (['single', 'status', 'path', 'color', 'kind', 'noteCategory'].includes(saved.boardGroup)) legacy.boardGroup = saved.boardGroup;
  if (['single', 'compact'].includes(saved.boardCardLayout)) legacy.boardCardLayout = saved.boardCardLayout;
  if (['updated', 'created', 'deadline'].includes(saved.sort)) legacy.sort = saved.sort;
  if (Object.keys(legacy).length) {
    const legacyTargets = ['', ...(state.status ? [state.status] : []), ...NOTE_VIEW_SETTING_KEYS, ...SESSION_VIEW_SETTING_KEYS, ...ARCHIVE_VIEW_SETTING_KEYS];
    legacyTargets.forEach((key) => { state.viewSettings[key] = { ...state.viewSettings[key], ...legacy }; });
  }
  if (saved.viewSettings && typeof saved.viewSettings === 'object') {
    if (saved.viewSettings.archived && typeof saved.viewSettings.archived === 'object') state.viewSettings['archive:all'] = { ...state.viewSettings['archive:all'], ...saved.viewSettings.archived };
    Object.entries(saved.viewSettings).forEach(([key, value]) => {
      const normalizedKey = normalizeViewSettingsKey(key);
      if (normalizedKey === null || !value || typeof value !== 'object') return;
      const settings = { ...state.viewSettings[normalizedKey] };
      if (['updated', 'created', 'deadline'].includes(value.sort)) settings.sort = value.sort;
      if (['single', 'status', 'path', 'color', 'kind', 'noteCategory'].includes(value.boardGroup)) settings.boardGroup = value.boardGroup;
      if (['single', 'compact'].includes(value.boardCardLayout)) settings.boardCardLayout = value.boardCardLayout;
      state.viewSettings[normalizedKey] = settings;
    });
  }
  applyViewSettings();
  if (typeof saved.search === 'string') state.search = saved.search;
  if (typeof saved.sidebarCollapsed === 'boolean') state.sidebarCollapsed = saved.sidebarCollapsed;
  else state.sidebarCollapsed = localStorage.getItem('workbench-sidebar-collapsed') === 'true';
  if (typeof saved.sessionTask === 'string' && saved.sessionTask) state.sessionTask = saved.sessionTask;
  if (typeof saved.sessionSessionId === 'string' && saved.sessionSessionId) state.sessionSessionId = saved.sessionSessionId;
  if (Array.isArray(saved.collapsedSessionTasks)) state.collapsedSessionTasks = new Set(saved.collapsedSessionTasks.filter((id) => typeof id === 'string'));
  if (Array.isArray(saved.collapsedSessionPaths)) state.collapsedSessionPaths = new Set(saved.collapsedSessionPaths.filter((path) => typeof path === 'string'));
  if (saved.sessionTreeGroupMode === 'path' || saved.sessionTreeGroupMode === 'task' || saved.sessionTreeGroupMode === 'combined') state.sessionTreeGroupMode = saved.sessionTreeGroupMode;
  if (Array.isArray(saved.sessionTaskIds)) state.sessionTaskIds = new Set(saved.sessionTaskIds.filter((id) => typeof id === 'string'));
  if (Array.isArray(saved.hiddenCompletedSessionTasks)) state.hiddenCompletedSessionTasks = new Set(saved.hiddenCompletedSessionTasks.filter((id) => typeof id === 'string'));
}

export function saveLayoutState() {
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({
      module: state.module, boardType: state.boardType, archiveType: state.archiveType, noteFilter: state.noteFilter, sessionFilter: state.sessionFilter, status: state.status, viewSettings: state.viewSettings,
      // 保留当前值，便于旧版本工作台继续读取布局状态。
      boardGroup: state.boardGroup, boardCardLayout: state.boardCardLayout, sort: state.sort,
      search: state.search, sidebarCollapsed: state.sidebarCollapsed, sessionTask: state.sessionTask,
      sessionSessionId: state.sessionSessionId,
      collapsedSessionTasks: [...state.collapsedSessionTasks], collapsedSessionPaths: [...state.collapsedSessionPaths], sessionTreeGroupMode: state.sessionTreeGroupMode,
      sessionTaskIds: [...state.sessionTaskIds], hiddenCompletedSessionTasks: [...state.hiddenCompletedSessionTasks],
    }));
  } catch { /* ignore unavailable browser storage */ }
}
