import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profileIndex = process.argv.indexOf('--profile')
const profile = profileIndex >= 0 ? process.argv[profileIndex + 1] : 'web'
const dsh = process.env.DSH_BIN ?? 'dsh'
if (profile === undefined || profile.startsWith('-')) throw new Error('usage: pnpm run install:profile -- --profile <profile>')

function run(command, args, allowFailure = false) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', code => {
      if (code === 0 || allowFailure) resolvePromise()
      else reject(new Error(`${command} exited with ${String(code)}`))
    })
  })
}

// dsh CLI 以自身 cwd 解析相对路径（经 DSH_BIN 包装后 cwd 通常是 harness 仓库），
// add 一律传绝对路径，保证任何包装方式下都指向本仓库的包目录。
// 历史插件（workbench 对、授权对）已于 2026-10-06 从仓库删除（退役/停接）：
// 需清理旧 profile 时用 `dsh plugin --profile <profile> remove <name>`。
const packages = {
  piAgent: resolve(root, 'packages/agent/pi-agent'),
}

await run(dsh, ['plugin', '--profile', profile, 'add', packages.piAgent])
console.log(`Installed pi-agent plugin into profile ${profile}.`)
