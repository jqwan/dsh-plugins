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
// 已停止接入的插件（remove 保留用于清理旧 profile，包源码都在仓库里）：
// - 授权对（authorization-web + client-ui-authorization）：0.2.0 宿主下
//   client 端的 sessions/uiSession 服务注入激活失败。
// - workbench 对（workbench-web + client-ui-workbench）：UI 融合方向已退役，
//   转做 pi-agent 内核插件、UI 全原生（2026-10-04）。
const packages = {
  piAgent: resolve(root, 'packages/agent/pi-agent'),
}

await run(dsh, ['plugin', '--profile', profile, 'remove', '@deepseek-ai/dsh-client-ui-authorization'], true)
await run(dsh, ['plugin', '--profile', profile, 'remove', '@deepseek-ai/dsh-authorization-web'], true)
await run(dsh, ['plugin', '--profile', profile, 'remove', '@deepseek-ai/dsh-client-ui-workbench'], true)
await run(dsh, ['plugin', '--profile', profile, 'remove', '@deepseek-ai/dsh-workbench-web'], true)
await run(dsh, ['plugin', '--profile', profile, 'add', packages.piAgent])
console.log(`Installed pi-agent plugin into profile ${profile}.`)
