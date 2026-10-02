/** Link development dependencies to the matching sibling DSH checkout without changing it. */
import { readFile, readdir, writeFile, access } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
const root = resolve(import.meta.dirname, '..')
const source = resolve(process.argv[2] || resolve(root, '../deepseek-harness'))
const manifests = new Map()
async function collectManifests(directory, depth = 0) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = resolve(directory, entry.name)
    try {
      const pkg = JSON.parse(await readFile(resolve(path, 'package.json'), 'utf8'))
      if (pkg.name) manifests.set(pkg.name, path)
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error }
    // vendor 包在仓库根下一层，dsh 包按 <group>/<name> 嵌一层
    if (depth === 0 && entry.name !== 'packages') await collectManifests(path, depth + 1)
  }
}
await collectManifests(resolve(source, 'packages'))
if (await access(resolve(source, 'vendor')).then(() => true, () => false)) await collectManifests(resolve(source, 'vendor'))
function satisfies(installed, spec) {
  if (spec === installed) return true
  if (!spec.startsWith('^')) return false
  const [imaj, imin, ipat] = installed.split('-')[0].split('.').map(Number)
  const [bmaj, bmin, bpat] = spec.slice(1).split('.').map(Number)
  return imaj === bmaj && (imin > bmin || (imin === bmin && ipat >= bpat))
}
const overrides = {}
for (const entry of await readdir(resolve(root, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const group = entry.name
  for (const name of await readdir(resolve(root, 'packages', group))) {
    let pkg
    try { pkg = JSON.parse(await readFile(resolve(root, 'packages', group, name, 'package.json'), 'utf8')) }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; throw error }
    for (const [dependency, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies })) {
      // 已是本地链接的依赖不再重复收编（如手工指向 harness 的 dsh-attachment）
      if (!dependency.startsWith('@deepseek-ai/') || version.startsWith('workspace:') || version.startsWith('link:')) continue
      const directory = manifests.get(dependency)
      if (!directory) throw new Error(`Missing DSH package: ${dependency}`)
      const installed = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'))
      if (!satisfies(installed.version, version)) throw new Error(`${dependency}: expected ${version}, found ${installed.version}`)
      overrides[dependency] = `link:${relative(root, directory)}`
    }
  }
}
const file = resolve(root, 'pnpm-workspace.yaml')
let config = await readFile(file, 'utf8')
config = config.split('\n# Local DSH development dependencies')[0].trimEnd()
await writeFile(file, `${config}\n\n# Local DSH development dependencies\noverrides:\n${Object.entries(overrides).map(([name, path]) => `  '${name}': '${path}'`).join('\n')}\n`)
console.log(`Configured ${Object.keys(overrides).length} local DSH dependencies. Run pnpm install.`)
