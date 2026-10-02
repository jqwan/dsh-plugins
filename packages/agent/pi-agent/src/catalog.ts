/**
 * pi model catalog reader: reads pi's model registry without starting an
 * agent or hitting the network, via the pi SDK that ships with the plugin's
 * own `@earendil-works/pi-coding-agent` dependency.
 *
 * Ported from workbench `model-catalog.js` (proven against pi 0.84.4):
 * `ModelRuntime.create({ allowModelNetwork: false })` exposes the available
 * model snapshot; `@earendil-works/pi-ai/compat` exposes the supported
 * thinking levels per model.
 *
 * @module @deepseek-ai/dsh-pi-agent/catalog
 */

import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findPackageJSON } from 'node:module'

/** One pi model as exposed to dsh's model catalog. */
export interface PiModelInfo {
  id: string
  name: string
  provider: string
  reasoning: boolean
  contextWindow?: number
  /** Supported reasoning-effort levels (pi thinking levels). */
  levels: string[]
}

export interface PiCatalog {
  models: PiModelInfo[]
  /** Distinct provider routes in catalog order. */
  providers: string[]
  /** pi's own default route from `~/.pi` settings. */
  current: { provider: string; model: string; reasoningEffort?: string }
}

/** Resolve pi's cli.js from the plugin's own dependency, or an explicit path. */
export function resolvePiCliEntry(explicit?: string): string | undefined {
  if (explicit !== undefined && explicit !== '') return explicit
  try {
    // import.meta.resolve lands on the package main (dist/index.js); the RPC
    // entry is the sibling cli.js.
    return join(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), 'cli.js')
  } catch {
    return undefined
  }
}

let cache: PiCatalog | undefined

/** Read the full pi model catalog. Result is cached per process. */
export async function piCatalog(cliEntry: string): Promise<PiCatalog> {
  if (cache !== undefined) return cache
  const entry = realpathSync(cliEntry)
  const sdk = await import(pathToFileURL(join(dirname(entry), 'index.js')).href)
  const aiPackagePath = findPackageJSON('@earendil-works/pi-ai', pathToFileURL(entry))
  if (aiPackagePath === undefined) throw new Error('pi model capability module (@earendil-works/pi-ai) not found')
  const aiPackage = JSON.parse(readFileSync(aiPackagePath, 'utf8')) as {
    exports?: Record<string, { import?: string }>
  }
  const compatExport = aiPackage.exports?.['./compat']?.import
  if (typeof compatExport !== 'string') throw new Error('pi model capability module does not ship an ESM compat export')
  const { getSupportedThinkingLevels } = await import(new URL(compatExport, pathToFileURL(aiPackagePath)).href) as {
    getSupportedThinkingLevels: (model: unknown) => string[]
  }
  const runtime = await sdk.ModelRuntime.create({ allowModelNetwork: false })
  if (runtime.getError()) throw new Error(runtime.getError())
  const settings = sdk.SettingsManager.create(process.cwd())
  const models: PiModelInfo[] = runtime.getAvailableSnapshot().map((model: Record<string, unknown>) => ({
    id: model.id as string,
    name: model.name as string,
    provider: model.provider as string,
    reasoning: model.reasoning === true,
    ...(typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {}),
    levels: getSupportedThinkingLevels(model),
  }))
  cache = {
    models,
    providers: [...new Set(models.map(model => model.provider))],
    current: {
      provider: settings.getDefaultProvider(),
      model: settings.getDefaultModel(),
      ...(settings.getDefaultThinkingLevel() === undefined ? {} : { reasoningEffort: settings.getDefaultThinkingLevel() }),
    },
  }
  return cache
}
