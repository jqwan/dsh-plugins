/**
 * 旧 workspace 数据一次性导入：
 *   node scripts/import-data.mjs <旧workspace目录> [目标数据目录]
 * 复制 data/tasks.json（含便签）与 sessions/*.jsonl 到插件数据目录。
 * 只读取源目录，不回写；目标目录中已存在的同名会话文件跳过。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = process.argv[2];
const dataDir = process.argv[3]
  || process.env.DSH_HOME && path.join(process.env.DSH_HOME, 'data', 'workbench')
  || path.join(packageDir, 'data');

if (!sourceDir || !existsSync(path.join(sourceDir, 'data', 'tasks.json'))) {
  console.error('用法：node scripts/import-data.mjs <旧workspace目录> [目标数据目录]');
  console.error('源目录需包含 data/tasks.json');
  process.exit(1);
}

const sessionsSource = path.join(sourceDir, 'sessions');
const sessionsTarget = path.join(dataDir, 'sessions');
mkdirSync(sessionsTarget, { recursive: true });

// 读取 tasks.json 并把指向旧 sessions 目录的 sessionFile 重写到新目录（同名文件已复制过去）。
const raw = JSON.parse(readFileSync(path.join(sourceDir, 'data', 'tasks.json'), 'utf8'));
let rewritten = 0;
for (const task of Array.isArray(raw.tasks) ? raw.tasks : []) {
  for (const session of Array.isArray(task.sessions) ? task.sessions : []) {
    if (!session.sessionFile) continue;
    const name = path.basename(session.sessionFile);
    if (path.dirname(session.sessionFile) === sessionsSource) {
      session.sessionFile = path.join(sessionsTarget, name);
      rewritten += 1;
    }
  }
  if (task.sessionFile && path.dirname(task.sessionFile) === sessionsSource) {
    task.sessionFile = path.join(sessionsTarget, path.basename(task.sessionFile));
  }
}
writeFileSync(path.join(dataDir, 'tasks.json'), JSON.stringify(raw, null, 2));
console.log(`已导入 tasks.json（重写 ${rewritten} 个会话路径）→ ${path.join(dataDir, 'tasks.json')}`);

let copied = 0;
let skipped = 0;
if (existsSync(sessionsSource)) {
  for (const entry of readdirSync(sessionsSource)) {
    if (!entry.endsWith('.jsonl')) continue;
    const target = path.join(sessionsTarget, entry);
    if (existsSync(target)) { skipped += 1; continue; }
    cpSync(path.join(sessionsSource, entry), target);
    copied += 1;
  }
}
console.log(`会话文件：复制 ${copied} 个，跳过已存在 ${skipped} 个 → ${sessionsTarget}`);

// 旧配置里的 maxConcurrent / approvePi 仍然有效，一并带过来。
const oldConfig = path.join(sourceDir, 'data', 'config.json');
if (existsSync(oldConfig) && !existsSync(path.join(dataDir, 'config.json'))) {
  cpSync(oldConfig, path.join(dataDir, 'config.json'));
  console.log(`已导入 config.json → ${path.join(dataDir, 'config.json')}`);
}

// 校验：tasks.json 必须可解析
try {
  const parsed = JSON.parse(readFileSync(path.join(dataDir, 'tasks.json'), 'utf8'));
  console.log(`校验通过：${Array.isArray(parsed.tasks) ? parsed.tasks.length : 0} 个任务，${Array.isArray(parsed.notes) ? parsed.notes.length : 0} 条便签`);
} catch (error) {
  console.error(`tasks.json 解析失败：${error.message}`);
  process.exit(1);
}
