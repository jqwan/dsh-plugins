import { readFileSync, existsSync, statSync } from 'node:fs';

const sessionCache = new Map();

/** 从 pi 消息 content 中提取纯文本 */
export function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
  }
  return '';
}

/**
 * 解析 pi session 文件（JSONL）。
 * 返回 { exists, header, entries, leaf, lastMessage, stats }
 */
export function parseSessionFile(file) {
  const empty = { exists: false, entries: [], leaf: null, lastMessage: null, stats: null };
  if (!file || !existsSync(file)) {
    if (file) sessionCache.delete(file);
    return empty;
  }
  let text;
  let signature;
  try {
    const stat = statSync(file);
    signature = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    const cached = sessionCache.get(file);
    if (cached?.signature === signature) return cached.value;
    text = readFileSync(file, 'utf8');
  } catch {
    sessionCache.delete(file);
    return empty;
  }
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* 忽略不完整行（可能正在写入） */
    }
  }
  const header = entries[0] && entries[0].type === 'session' ? entries[0] : null;
  const body = entries.slice(header ? 1 : 0);
  const leaf = body.length ? body[body.length - 1] : null;

  let lastMessage = null;
  for (const e of body) if (e.type === 'message') lastMessage = e;

  const stats = {
    messages: 0, user: 0, assistant: 0, toolResults: 0,
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, errors: 0,
  };
  for (const e of body) {
    if (e.type !== 'message' || !e.message) continue;
    const m = e.message;
    stats.messages++;
    if (m.role === 'user') {
      stats.user++;
    } else if (m.role === 'assistant') {
      stats.assistant++;
      if (m.usage) {
        stats.input += m.usage.input || 0;
        stats.output += m.usage.output || 0;
        stats.cacheRead += m.usage.cacheRead || 0;
        stats.cacheWrite += m.usage.cacheWrite || 0;
        if (m.usage.cost && typeof m.usage.cost.total === 'number') stats.cost += m.usage.cost.total;
      }
      if (m.stopReason === 'error') stats.errors++;
    } else if (m.role === 'toolResult') {
      stats.toolResults++;
      if (m.isError) stats.errors++;
    }
  }
  const result = { exists: true, header, entries: body, leaf, lastMessage, stats };
  sessionCache.set(file, { signature, value: result });
  return result;
}

export function invalidateSessionFile(file) {
  if (file) sessionCache.delete(file);
}

