/**
 * dsh 会话桥：让 dsh 会话在服务端呈现为与 pi 会话同形的接口。
 *
 * 工作台其余部分（未读水位、标题自动命名、统计、会话树）只依赖
 * parseSessionFile() 的同形结构 { exists, header, entries, lastMessage, stats }，
 * 本桥把 dsh 会话事件流折叠成该结构并维护一份同步可读的视图缓存；
 * 异步刷新由宿主 session/事件驱动，配合 runtime 的 SSE 去抖通知前端。
 *
 * 上下文注入：pi 版通过 --append-system-prompt 注入任务描述与 AGENTS.md；
 * dsh 会话没有对应的系统提示词入口，改为在会话首条用户输入前拼接同样的
 * 上下文（后续轮次上下文已在会话历史中）。
 */

import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';

const EMPTY_PARSE = { exists: false, header: null, entries: [], leaf: null, lastMessage: null, stats: null };
const REFRESH_DEBOUNCE_MS = 150;

function emptyStats() {
  return { messages: 0, user: 0, assistant: 0, toolResults: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, errors: 0 };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((block) => block && block.type === 'text').map((block) => block.text).join('\n');
  }
  return '';
}

function eventTime(event) {
  const value = event?.time;
  const time = typeof value === 'number' ? value : new Date(value || 0).getTime();
  return Number.isFinite(time) && time > 0 ? time : Date.now();
}

/**
 * @param {{
 *   sessionController?: object,
 *   onSessionEvent?: (handler: (sessionId: string, event: object) => void) => () => void,
 *   onAgentStatus?: (handler: (sessionId: string, running: boolean) => void) => () => void,
 *   listDshSessions?: () => Array<{ taskId: string, child: object }>,
 *   onActivity?: (dshSessionId: string) => void,
 * }} services 宿主注入的会话服务与事件订阅点
 */
export function createDshBridge(services = {}) {
  const sessionController = services.sessionController ?? null;
  const workspaceRegistry = services.workspaceRegistry ?? null;
  const views = new Map();       // dshSessionId → parseSessionFile 同形视图
  const refreshing = new Map();  // dshSessionId → 去抖定时器
  const running = new Set();     // 有进行中回合的 dshSessionId
  const tracked = new Set();     // 工作台名下的 dshSessionId
  const disposers = [];

  const onActivity = (sessionId) => services.onActivity?.(sessionId);
  const track = (sessionId) => {
    if (!sessionId) return;
    if (!tracked.has(sessionId)) {
      tracked.add(sessionId);
      void refresh(sessionId);
    }
  };

  async function refresh(sessionId) {
    if (!sessionController) return;
    try {
      const inspection = await sessionController.inspect(sessionId);
      views.set(sessionId, adaptView(inspection));
    } catch {
      // 会话可能已被删除或不可读；保留空视图，避免反复报错。
      views.set(sessionId, { ...EMPTY_PARSE, stats: emptyStats() });
    }
  }
  function scheduleRefresh(sessionId) {
    if (refreshing.has(sessionId)) return;
    const timer = setTimeout(() => {
      refreshing.delete(sessionId);
      void refresh(sessionId).then(() => onActivity(sessionId));
    }, REFRESH_DEBOUNCE_MS);
    timer.unref?.();
    refreshing.set(sessionId, timer);
  }

  if (services.onSessionEvent) {
    disposers.push(services.onSessionEvent((sessionId, event) => {
      if (!tracked.has(sessionId)) return;
      if (event?.type === 'user/message' || event?.type === 'assistant/message' || event?.type === 'tool/result') {
        scheduleRefresh(sessionId);
      }
    }));
  }
  if (services.onAgentStatus) {
    disposers.push(services.onAgentStatus((sessionId, isRunning) => {
      if (!tracked.has(sessionId)) return;
      const was = running.has(sessionId);
      if (isRunning) running.add(sessionId);
      else running.delete(sessionId);
      if (was !== isRunning) onActivity(sessionId);
    }));
  }

  /** 把 inspect() 的事件快照折叠成 parseSessionFile 同形结构 */
  function adaptView(inspection) {
    const entries = [];
    const stats = emptyStats();
    for (const event of Array.isArray(inspection?.events) ? inspection.events : []) {
      const time = eventTime(event);
      const stamp = new Date(time).toISOString();
      const fallbackId = `dsh-${event.seq ?? entries.length}`;
      if (event.type === 'user/message') {
        const message = event.data || {};
        const human = message.source?.kind === 'user';
        entries.push({
          id: message.id || fallbackId,
          type: 'message',
          timestamp: stamp,
          message: { role: 'user', content: textOf(message.content), timestamp: time, source: message.source?.kind || 'user' },
        });
        if (human) { stats.messages += 1; stats.user += 1; }
      } else if (event.type === 'assistant/message') {
        const data = event.data || {};
        const message = data.message || {};
        const usage = data.usage || {};
        entries.push({
          id: message.id || fallbackId,
          type: 'message',
          timestamp: stamp,
          message: {
            role: 'assistant',
            content: textOf(message.content),
            timestamp: time,
            interrupted: data.interrupted === true || undefined,
            usage: usage.inputTokens !== undefined
              ? {
                  input: usage.inputTokens || 0,
                  output: usage.outputTokens || 0,
                  cacheRead: usage.cacheReadTokens || 0,
                  cacheWrite: usage.cacheWriteTokens || 0,
                }
              : undefined,
          },
        });
        if (textOf(message.content).trim()) { stats.messages += 1; stats.assistant += 1; }
        if (data.interrupted === true) stats.errors += 1;
        stats.input += usage.inputTokens || 0;
        stats.output += usage.outputTokens || 0;
        stats.cacheRead += usage.cacheReadTokens || 0;
        stats.cacheWrite += usage.cacheWriteTokens || 0;
      } else if (event.type === 'tool/result') {
        const message = event.data?.message || {};
        entries.push({
          id: fallbackId,
          type: 'message',
          timestamp: stamp,
          message: { role: 'toolResult', content: textOf(message.content), timestamp: time },
        });
        stats.toolResults += 1;
      }
    }
    const messages = entries.filter((entry) => entry.type === 'message');
    return {
      exists: true,
      header: { type: 'session', cwd: inspection?.meta?.cwd || null },
      entries,
      leaf: entries.at(-1) || null,
      lastMessage: messages.at(-1) || null,
      stats,
    };
  }

  // 已确认工作区关联的 dshSessionId（避免 track 反复触发补挂查询）
  const ensuredWorkspaces = new Set();
  async function ensureWorkspaceAttached(task, sessionId) {
    if (!workspaceRegistry?.create || !sessionId || ensuredWorkspaces.has(sessionId)) return;
    ensuredWorkspaces.add(sessionId);
    const cwd = task?.workingDir;
    if (!cwd) return;
    try {
      const workspace = await workspaceRegistry.create(realpathSync(cwd));
      if (!workspace.sessionIds?.includes(sessionId)) await workspace.attachSession(sessionId);
    } catch (error) {
      // 失败只记录：工作区关联缺失不影响会话本身的使用
      console.error(`[workbench] 补挂工作区失败（${sessionId}）：${error?.message || error}`);
    }
  }

  return {
    /** dsh 会话能力是否可用（宿主未提供 sessionController 时降级为仅 pi） */
    available: Boolean(sessionController),
    /** Persist an explicit user title in the native session controller. */
    async rename(sessionId, title) {
      if (!sessionController) throw new Error('宿主未提供 dsh 会话服务');
      await sessionController.rename({ sessionId, title });
    },

    /**
     * 通过 sessionController 创建一个真实持久的 dsh 会话（带完整 agent 生命周期）。
     * 返回 dshSessionId。
     */
    async createSession({ task, workingDir } = {}) {
      if (!sessionController) throw new Error('宿主未提供 dsh 会话服务');
      const cwd = workingDir || task?.workingDir;
      if (!cwd) throw new Error('请先为任务设置工作目录');
      // 以工作区承载工作路径关联：create-or-get 幂等（同路径返回既有工作区），
      // 这样 dsh 原生侧会话自动挂到对应工作区，而不是停留在“选择工作区”空态。
      let workspaceId;
      if (workspaceRegistry?.create) {
        try {
          const workspace = await workspaceRegistry.create(realpathSync(cwd));
          workspaceId = workspace.id;
        } catch (error) {
          console.error(`[workbench] 注册工作区失败（${cwd}）：${error?.message || error}`);
        }
      }
      const value = await sessionController.create(workspaceId ? { workspaceId } : { cwd });
      track(value.sessionId);
      ensuredWorkspaces.add(value.sessionId);
      // 不再把会话改名为任务标题：原生侧的自动命名（首条消息）是真实会话名，
      // 顶部栏由客户端注入"任务 / 会话名"两级面包屑（见 ui-workbench sidebar）
      return value.sessionId;
    },

    /**
     * 草稿会话：创建真实 dsh 会话并挂到任务工作区，但不落任务记录——
     * 首条消息发出后由 /sessions/attach 落账（对齐 pi“发送了消息才算
     * 新建子会话”）。同一工作区已有空白会话时直接复用，连点新建按钮
     * 不会堆积空会话。
     */
    async draftSession({ task, workingDir } = {}) {
      if (!sessionController) throw new Error('宿主未提供 dsh 会话服务');
      const cwd = workingDir || task?.workingDir;
      if (!cwd) throw new Error('请先为任务设置工作目录');
      // 工作区注册失败（路径不存在 / ~ 路径 / 注册表异常）不致命：退化为按 cwd 建会话
      let workspace = null;
      if (workspaceRegistry?.create) {
        try {
          workspace = await workspaceRegistry.create(realpathSync(cwd));
        } catch (error) {
          console.error(`[workbench] 注册工作区失败（${cwd}）：${error?.message || error}`);
        }
      }
      // 空白复用：同工作区下没有用户消息的会话直接当草稿，连点不堆积
      for (const sessionId of workspace?.sessionIds || []) {
        try {
          const inspection = await sessionController.inspect(sessionId);
          if ((inspection?.events || []).some((event) => event?.type === 'user/message')) continue;
          track(sessionId);
          ensuredWorkspaces.add(sessionId);
          return sessionId;
        } catch { continue; }
      }
      const value = await sessionController.create(workspace ? { workspaceId: workspace.id } : { cwd });
      track(value.sessionId);
      ensuredWorkspaces.add(value.sessionId);
      return value.sessionId;
    },

    /** 收养原生侧创建的 dsh 会话：纳入视图跟踪并补挂工作区（新建会话窗口选任务） */
    adopt(sessionId, task) {
      if (!sessionId) return;
      track(sessionId);
      void ensureWorkspaceAttached(task, sessionId);
    },

    /** 读取会话视图（同步）；未就绪时返回空结构并触发一次异步刷新 */
    readSession(child) {
      const sessionId = child?.dshSessionId;
      if (!sessionId) return { ...EMPTY_PARSE, stats: emptyStats() };
      track(sessionId);
      return views.get(sessionId) || { ...EMPTY_PARSE, stats: emptyStats() };
    },

    /** 会话是否有进行中的回合 */
    isRunning(child) {
      return running.has(child?.dshSessionId);
    },

    /**
     * 向会话发送用户输入。首条输入带一行任务头部（对齐 pi 版任务上下文语义；
     * AGENTS.md 由 dsh 宿主的 workspace instructions 自动注入，不重复拼接）。
     */
    async sendPrompt(child, text, { task } = {}) {
      if (!sessionController) throw new Error('宿主未提供 dsh 会话服务');
      const sessionId = child?.dshSessionId;
      if (!sessionId) throw new Error('dsh 会话未绑定');
      const promptText = task && (this.readSession(child).stats?.messages || 0) === 0
        ? `【工作台任务】${task.title || ''}\n${task.description || ''}\n\n${text}`.trim()
        : text;
      return sessionController.prompt({
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: promptText }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }, new AbortController().signal);
    },

    /** 取消当前回合（任务完成/归档/删除/终止时调用），不删除会话数据 */
    async stop(child) {
      const sessionId = child?.dshSessionId;
      if (!sessionId || !running.has(sessionId) || !sessionController) return false;
      await sessionController.cancel({ sessionId });
      running.delete(sessionId);
      return true;
    },

    /** dsh 可路由模型目录（按 provider 分组），供任务"更多设置"选择模型 */
    async modelCatalog() {
      if (!sessionController?.modelCatalog) return { default: null, groups: [] };
      try {
        return await sessionController.modelCatalog();
      } catch {
        return { default: null, groups: [] };
      }
    },

    /** 为 dsh 会话安装会话级模型/思考等级选择；失败仅记录，不阻塞运行 */
    async selectModel(sessionId, provider, model, thinkingLevel) {
      if (!sessionController?.selectModel || !sessionId || !provider || !model) return false;
      try {
        await sessionController.selectModel({
          sessionId,
          provider,
          model,
          ...(thinkingLevel ? { reasoningEffort: String(thinkingLevel) } : {}),
        });
        return true;
      } catch (error) {
        console.error(`[workbench] 设置 dsh 会话模型失败（${sessionId}）：${error?.message || error}`);
        return false;
      }
    },

    /** 永久丢弃视图缓存（会话被永久删除时调用） */
    forget(child) {
      const sessionId = child?.dshSessionId;
      if (!sessionId) return;
      tracked.delete(sessionId);
      views.delete(sessionId);
      running.delete(sessionId);
    },

    /** 启动时预热全部工作台名下的 dsh 会话视图，并为存量会话补挂工作区 */
    warm() {
      const known = services.listDshSessions?.() || [];
      for (const { task, child } of known) {
        track(child?.dshSessionId);
        void ensureWorkspaceAttached(task, child?.dshSessionId);
      }
    },

    async dispose() {
      for (const dispose of disposers.splice(0)) {
        try { await dispose(); } catch { /* host is tearing down */ }
      }
      for (const timer of refreshing.values()) clearTimeout(timer);
      refreshing.clear();
      views.clear();
      running.clear();
      tracked.clear();
    },
  };
}
