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

await run(dsh, ['plugin', '--profile', profile, 'remove', '@deepseek-ai/dsh-client-ui-authorization'], true)
await run(dsh, ['plugin', '--profile', profile, 'remove', '@deepseek-ai/dsh-authorization-web'], true)
await run(dsh, ['plugin', '--profile', profile, 'add', './packages/credentials/authorization-web'])
await run(dsh, ['plugin', '--profile', profile, 'add', './packages/client/ui-authorization'])
console.log(`Installed personal authorization plugins into profile ${profile}.`)
