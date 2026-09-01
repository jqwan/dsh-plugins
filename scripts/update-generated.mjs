import { cp, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const sourceRoot = process.argv[2]
if (sourceRoot === undefined) throw new Error('usage: node scripts/update-generated.mjs <deepseek-harness-checkout>')

const source = resolve(sourceRoot, 'packages/credentials/authorization-web/lib')
const destination = resolve('packages/credentials/authorization-web/generated')
const files = ['typert.host.js', 'typert.host.d.ts', 'typert.remote-client.js', 'typert.remote-client.d.ts']

for (const file of files) {
  await access(join(source, file))
  await cp(join(source, file), join(destination, file))
}
console.log(`Copied ${String(files.length)} Typert artifacts from ${sourceRoot}.`)
