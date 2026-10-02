import { build } from 'esbuild'
import { mkdir, readFile, rm, writeFile, cp } from 'node:fs/promises'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packages = {
  'authorization-web': {
    directory: 'packages/credentials/authorization-web',
    source: 'src/index.ts',
    invariant: 'src/invariant.ts',
  },
  'client-ui-authorization': {
    directory: 'packages/client/ui-authorization',
    source: 'src/index.ts',
    invariant: 'src/invariant.ts',
  },
  'workbench-web': {
    directory: 'packages/task/workbench-web',
    source: 'src/index.ts',
    invariant: 'src/invariant.ts',
    externals: ['express', 'ws', 'node-pty'],
  },
  'pi-agent': {
    directory: 'packages/agent/pi-agent',
    source: 'src/index.ts',
    invariant: 'src/invariant.ts',
    // dsh 运行时包一律 external：宿主进程里必须与 harness 同实例（双实例即类型撕裂）。
    externals: [
      '@deepseek-ai/schemastery',
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-commands',
      '@deepseek-ai/dsh-user-approval',
      '@deepseek-ai/dsh-brand',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-scope',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-session-persistence',
      '@deepseek-ai/dsh-session-projection',
      '@deepseek-ai/dsh-util-values',
    ],
  },
  'client-ui-workbench': {
    directory: 'packages/client/ui-workbench',
    source: 'src/index.ts',
    invariant: 'src/invariant.ts',
    client: {
      id: '@deepseek-ai/dsh-client-ui-workbench',
      source: 'src/client/index.ts',
      cssPrefix: 'dshWorkbench',
    },
  },
}

function run(command, args, cwd = root, extraEnv = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...extraEnv } })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with ${String(code)}`)))
  })
}

function cssModulePlugin(prefix = 'dshAuth') {
  return {
    name: 'dsh-css-module',
    setup(buildContext) {
      buildContext.onLoad({ filter: /\.module\.css$/ }, async ({ path }) => {
        const original = await readFile(path, 'utf8')
        const names = [...new Set([...original.matchAll(/\.([A-Za-z_][\w-]*)/g)].map(match => match[1]))]
        const filePrefix = `${prefix}_${basename(path, '.module.css')}_`
        const mapping = Object.fromEntries(names.map(name => [name, `${filePrefix}${name}`]))
        let css = original.replace(/:global\(([^)]+)\)/g, '$1')
        // 分段重写：url(...) 内部（如 mask 数据 URL 里的 ".w3.org"）不是类名，
        // 必须整段跳过，否则会被误改成带前缀的类名、毁掉整个 data URL
        const rewriteClasses = (part) => {
          for (const [name, mapped] of Object.entries(mapping)) {
            part = part.replaceAll(new RegExp(`\\.${name}(?=[^A-Za-z0-9_-])`, 'g'), `.${mapped}`)
          }
          return part
        }
        css = css.split(/(url\([^)]*\))/g).map(part => part.startsWith('url(') ? part : rewriteClasses(part)).join('')
        const source = `const css = ${JSON.stringify(css)}\nconst styles = ${JSON.stringify(mapping)}\nif (typeof document !== 'undefined' && !document.querySelector('style[data-dsh-css=${JSON.stringify(path)}]')) {\n  const tag = document.createElement('style')\n  tag.dataset.dshCss = ${JSON.stringify(path)}\n  tag.textContent = css\n  document.head.appendChild(tag)\n}\nexport default styles\n`
        return { contents: source, loader: 'js' }
      })
      // 普通 CSS（如 @xterm/xterm 的 xterm.css）：去重后注入 <style>，不产出独立 css 文件。
      buildContext.onLoad({ filter: /\.css$/ }, async ({ path }) => {
        if (path.endsWith('.module.css')) return undefined
        const original = await readFile(path, 'utf8')
        const source = `const css = ${JSON.stringify(original)}\nif (typeof document !== 'undefined' && !document.querySelector('style[data-dsh-css=${JSON.stringify(path)}]')) {\n  const tag = document.createElement('style')\n  tag.dataset.dshCss = ${JSON.stringify(path)}\n  tag.textContent = css\n  document.head.appendChild(tag)\n}\n`
        return { contents: source, loader: 'js' }
      })
    },
  }
}

async function emitDeclarations(name, config) {
  const directory = resolve(root, config.directory)
  await rm(join(directory, 'lib/types'), { recursive: true, force: true })
  await run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json', '--pretty', 'false'], directory, { NODE_OPTIONS: '--max-old-space-size=12288' })
  if (name === 'authorization-web') {
    for (const file of ['typert.host.js', 'typert.host.d.ts', 'typert.remote-client.js', 'typert.remote-client.d.ts']) {
      await cp(join(directory, 'generated', file), join(directory, 'lib', file))
    }
  }
}

async function buildHost(config) {
  const directory = resolve(root, config.directory)
  await mkdir(join(directory, 'lib'), { recursive: true })
  const external = [
    'node:crypto',
    'zod',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-authorization',
    '@deepseek-ai/dsh-credentials',
    '@deepseek-ai/dsh-invariants',
    '@deepseek-ai/dsh-typert-protocol',
    ...(config.externals ?? []),
  ]
  await build({
    entryPoints: [join(directory, config.source)],
    outfile: join(directory, 'lib/index.js'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    external,
    sourcemap: false,
    legalComments: 'none',
  })
  await build({
    entryPoints: [join(directory, config.invariant)],
    outfile: join(directory, 'lib/invariant.js'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    external,
    sourcemap: false,
    legalComments: 'none',
  })
  if (config.directory === 'packages/task/workbench-web') {
    await cp(join(directory, 'src/pi/pi-telemetry-extension.js'), join(directory, 'lib/pi-telemetry-extension.js'))
  }
  if (config.directory.includes('authorization-web')) {
    await build({
      entryPoints: [join(directory, 'src/types.ts')],
      outfile: join(directory, 'lib/types/types.js'),
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'es2022',
      external,
      sourcemap: false,
      legalComments: 'none',
    })
  }
}

async function buildClient(config) {
  const directory = resolve(root, config.directory)
  const inner = join(directory, 'lib/client.inner.cjs')
  await build({
    entryPoints: [join(directory, config.client.source)],
    outfile: inner,
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    external: [
      'react',
      'react/jsx-runtime',
      'react-dom',
      'react-dom/client',
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-store',
      '@deepseek-ai/dsh-client-ui-primitives',
    ],
    plugins: [cssModulePlugin(config.client.cssPrefix)],
    sourcemap: false,
    legalComments: 'none',
  })
  const body = await readFile(inner, 'utf8')
  await writeFile(join(directory, 'lib/client.js'), `window.__ModuleLoader__.load({\n  id: ${JSON.stringify(config.client.id)},\n  factory: (require) => {\n    var module = { exports: {} }\n    var exports = module.exports\n${body}\n    return module.exports\n  },\n})\n`)
  await rm(inner, { force: true })
}

// pnpm 的内容寻址存储会丢掉 node-pty 预编译产物里 spawn-helper 的可执行位，
// 没有 +x 时 posix_spawnp 直接失败。每次构建时兜底修复。
async function fixNodePtySpawnHelper() {
  const storeDir = join(root, 'node_modules', '.pnpm')
  try {
    const entries = await (await import('node:fs/promises')).readdir(storeDir)
    for (const entry of entries) {
      if (!entry.startsWith('node-pty@')) continue
      for (const platform of ['darwin-arm64', 'darwin-x64']) {
        const helper = join(storeDir, entry, 'node_modules', 'node-pty', 'prebuilds', platform, 'spawn-helper')
        try {
          await (await import('node:fs/promises')).chmod(helper, 0o755)
        } catch { /* 平台目录不存在时跳过 */ }
      }
    }
  } catch { /* store 不存在时跳过 */ }
}

async function buildOne(name) {
  await fixNodePtySpawnHelper()
  const config = packages[name]
  await emitDeclarations(name, config)
  await buildHost(config)
  if (config.client) await buildClient(config)
}

async function buildAll() {
  await fixNodePtySpawnHelper()
  for (const [name, config] of Object.entries(packages)) await emitDeclarations(name, config)
  for (const [name, config] of Object.entries(packages)) {
    await buildHost(config)
    if (config.client) await buildClient(config)
  }
}

const packageFlagIndex = process.argv.indexOf('--package')
const requested = packageFlagIndex === -1 ? undefined : process.argv[packageFlagIndex + 1]
if (requested !== undefined && requested !== '--package') {
  if (!(requested in packages)) throw new Error(`unknown package: ${requested}`)
  await buildOne(requested)
} else {
  await buildAll()
}
