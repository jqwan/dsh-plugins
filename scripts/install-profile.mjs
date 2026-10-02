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
// 授权对（authorization-web + client-ui-authorization）已停止接入：0.2.0 宿主下
// client 端的 sessions/uiSession 服务注入激活失败；包源码保留在仓库里，需要时手动装回。
const packages = {
  workbenchWeb: resolve(root, 'packages/task/workbench-web'),
  clientUiWorkbench: resolve(root, 'packages/client/ui-workbench'),
}

await run(dsh, ['plugin', '--profile', profile, 'remove', '@deepseek-ai/dsh-client-ui-authorization'], true)
await run(dsh, ['plugin', '--profile', profile, 'remove', '@deepseek-ai/dsh-authorization-web'], true)
await run(dsh, ['plugin', '--profile', profile, 'remove', '@deepseek-ai/dsh-client-ui-workbench'], true)
await run(dsh, ['plugin', '--profile', profile, 'remove', '@deepseek-ai/dsh-workbench-web'], true)
await run(dsh, ['plugin', '--profile', profile, 'add', packages.workbenchWeb])
await run(dsh, ['plugin', '--profile', profile, 'add', packages.clientUiWorkbench])
console.log(`Installed workbench plugins into profile ${profile}.`)
