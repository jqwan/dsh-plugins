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
}

function run(command, args, cwd = root) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with ${String(code)}`)))
  })
}

function cssModulePlugin() {
  return {
    name: 'dsh-css-module',
    setup(buildContext) {
      buildContext.onLoad({ filter: /\.module\.css$/ }, async ({ path }) => {
        const original = await readFile(path, 'utf8')
        const names = [...new Set([...original.matchAll(/\.([A-Za-z_][\w-]*)/g)].map(match => match[1]))]
        const prefix = `dshAuth_${basename(path, '.module.css')}_`
        const mapping = Object.fromEntries(names.map(name => [name, `${prefix}${name}`]))
        let css = original
        for (const [name, mapped] of Object.entries(mapping)) {
          css = css.replaceAll(new RegExp(`\\.${name}(?=[^A-Za-z0-9_-])`, 'g'), `.${mapped}`)
        }
        const source = `const css = ${JSON.stringify(css)}\nconst styles = ${JSON.stringify(mapping)}\nif (typeof document !== 'undefined' && !document.querySelector('style[data-dsh-css=${JSON.stringify(path)}]')) {\n  const tag = document.createElement('style')\n  tag.dataset.dshCss = ${JSON.stringify(path)}\n  tag.textContent = css\n  document.head.appendChild(tag)\n}\nexport default styles\n`
        return { contents: source, loader: 'js' }
      })
    },
  }
}

async function emitDeclarations(name, config) {
  const directory = resolve(root, config.directory)
  await rm(join(directory, 'lib/types'), { recursive: true, force: true })
  await run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json', '--pretty', 'false'], directory)
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

async function buildClient() {
  const config = packages['client-ui-authorization']
  const directory = resolve(root, config.directory)
  const inner = join(directory, 'lib/client.inner.cjs')
  await build({
    entryPoints: [join(directory, 'src/client/index.ts')],
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
      '@deepseek-ai/dsh-client-ui-primitives',
    ],
    plugins: [cssModulePlugin()],
    sourcemap: false,
    legalComments: 'none',
  })
  const body = await readFile(inner, 'utf8')
  await writeFile(join(directory, 'lib/client.js'), `window.__ModuleLoader__.load({\n  id: '@deepseek-ai/dsh-client-ui-authorization',\n  factory: (require) => {\n    var module = { exports: {} }\n    var exports = module.exports\n${body}\n    return module.exports\n  },\n})\n`)
  await rm(inner, { force: true })
}

async function buildOne(name) {
  const config = packages[name]
  await emitDeclarations(name, config)
  await buildHost(config)
  if (name === 'client-ui-authorization') await buildClient()
}

async function buildAll() {
  await emitDeclarations('authorization-web', packages['authorization-web'])
  await emitDeclarations('client-ui-authorization', packages['client-ui-authorization'])
  await buildHost(packages['authorization-web'])
  await buildHost(packages['client-ui-authorization'])
  await buildClient()
}

const packageFlagIndex = process.argv.indexOf('--package')
const requested = packageFlagIndex === -1 ? undefined : process.argv[packageFlagIndex + 1]
if (requested !== undefined && requested !== '--package') {
  if (!(requested in packages)) throw new Error(`unknown package: ${requested}`)
  await buildOne(requested)
} else {
  await buildAll()
}
