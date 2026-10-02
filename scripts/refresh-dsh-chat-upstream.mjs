/** Refresh docs/dsh-chat-upstream.json against a DSH checkout after adapting the local copies. */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
const root = resolve(import.meta.dirname, '..')
const source = resolve(process.argv[2] || resolve(root, '../deepseek-harness'))
const version = process.argv[3]
const commit = process.argv[4]
if (version === undefined || commit === undefined) {
  throw new Error('usage: node scripts/refresh-dsh-chat-upstream.mjs [dsh-checkout] <version> <commit>')
}
const file = resolve(root, 'docs/dsh-chat-upstream.json')
const manifest = JSON.parse(await readFile(file, 'utf8'))
const clientRoot = resolve(root, 'packages/client/ui-workbench/src/client')
for (const entry of manifest.files) {
  if (!entry.file.includes('/')) throw new Error(`manifest entry needs a directory prefix: ${entry.file}`)
  const localPath = resolve(clientRoot, entry.file)
  const bytes = await readFile(localPath)
  entry.sha256 = createHash('sha256').update(bytes).digest('hex')
}
manifest.version = version
manifest.commit = commit
await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`Baseline refreshed: DSH ${version} (${commit}); ${manifest.files.length} tracked files.`)
