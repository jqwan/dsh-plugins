/** Report upstream changes without overwriting the pi adaptations. */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
const root = resolve(import.meta.dirname, '..')
const source = resolve(process.argv[2] || resolve(root, '../deepseek-harness'))
const manifest = JSON.parse(await readFile(resolve(root, 'docs/dsh-chat-upstream.json'), 'utf8'))
let changed = false
for (const file of manifest.files) {
  try {
    const bytes = await readFile(resolve(source, file.source))
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) { console.log(`CHANGED ${file.source}`); changed = true }
  } catch (error) { if (error.code !== 'ENOENT') throw error; console.log(`MISSING ${file.source}`); changed = true }
}
console.log(`Baseline: DSH ${manifest.version} (${manifest.commit}); ${manifest.files.length} tracked files.`)
process.exitCode = changed ? 1 : 0
