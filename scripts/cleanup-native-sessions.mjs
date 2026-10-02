/**
 * 清理未被工作台任务持有的 dsh 原生会话（含本地文件）。
 *
 * 用法：
 *   node scripts/cleanup-native-sessions.mjs          # 空跑：仅列出将删除的内容
 *   node scripts/cleanup-native-sessions.mjs --yes    # 实际删除
 *
 * 安全约束：
 * - 必须先停止 `dsh web`，运行中删除会导致服务从内存回写已删会话；
 * - 工作台任务名下的 dshSessionId 一律保留；
 * - 只删除 ~/.dsh/sessions/<encoded>/session-<id>/ 目录与
 *   ~/.dsh/storages/session_projcache/sessions/<id>.json 投影缓存。
 */

import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const yes = process.argv.includes('--yes')
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const sessionsRoot = join(dshHome, 'sessions')
const projcacheRoot = join(dshHome, 'storages', 'session_projcache', 'sessions')
const workbenchTasks = join(dshHome, 'data', 'workbench', 'tasks.json')

if (!existsSync(workbenchTasks)) {
  console.error(`未找到工作台数据：${workbenchTasks}`)
  process.exit(1)
}

const tasks = JSON.parse(readFileSync(workbenchTasks, 'utf8')).tasks || []
const owned = new Set()
for (const task of tasks) {
  for (const session of task.sessions || []) {
    if (session.kind === 'dsh' && session.dshSessionId) owned.add(session.dshSessionId)
  }
}
console.log(`工作台持有的 dsh 会话：${owned.size} 个（一律保留）`)

const candidates = []
for (const encoded of existsSync(sessionsRoot) ? readdirSync(sessionsRoot) : []) {
  const dir = join(sessionsRoot, encoded)
  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith('session-')) continue
    const id = entry
    if (owned.has(id)) continue
    candidates.push({ id, path: dir })
  }
}
const projCandidates = []
for (const file of existsSync(projcacheRoot) ? readdirSync(projcacheRoot) : []) {
  const id = file.replace(/\.json$/, '')
  if (!id.startsWith('session-') || owned.has(id)) continue
  if (candidates.some((item) => item.id === id)) projCandidates.push(join(projcacheRoot, file))
}

if (!candidates.length) {
  console.log('没有需要清理的原生会话。')
  process.exit(0)
}

console.log(`\n将删除 ${candidates.length} 个原生会话目录：`)
for (const item of candidates) console.log(`  - ${item.path}  [${item.id}]`)
console.log(`并将删除 ${projCandidates.length} 个投影缓存文件。`)

if (!yes) {
  console.log('\n空跑模式：未删除任何文件。确认无误后追加 --yes 执行删除。')
  process.exit(0)
}

for (const item of candidates) rmSync(item.path, { recursive: true, force: true })
for (const file of projCandidates) rmSync(file, { force: true })
console.log(`\n已删除 ${candidates.length} 个会话目录与 ${projCandidates.length} 个投影缓存。`)
