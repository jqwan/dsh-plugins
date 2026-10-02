/**
 * Catalog-only LLM adapter: exposes pi's model registry (from `~/.pi`) as
 * provider routes in dsh's LLM runtime so the native model picker lists pi
 * models with zero UI work. Generation deliberately fails — the kernel drives
 * models through the pi RPC process, not through `ctx.llm`.
 *
 * @module @deepseek-ai/dsh-pi-agent/llm-adapter
 */

import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { PiCatalog } from './catalog.ts'

/** Read the current catalog (undefined until the async loader settles). */
export type CatalogRef = () => PiCatalog | undefined

export class PiCatalogAdapter extends LlmAdapter {
  constructor(private readonly catalog: CatalogRef) {
    super()
  }

  override providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: `${provider} · pi` }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = this.catalog()?.models.filter(model => model.provider === provider) ?? []
    return Promise.resolve(models.map(model => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: model.reasoning ? (['text'] as const) : (['text'] as const),
    })))
  }

  override resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const entry = this.catalog()?.models.find(candidate => candidate.provider === provider && candidate.id === model)
    if (entry === undefined) return Promise.resolve({ provider, id: model, name: model })
    return Promise.resolve({
      provider,
      id: entry.id,
      name: entry.name,
      ...(entry.contextWindow === undefined ? {} : { context: { contextWindow: entry.contextWindow } }),
      ...(entry.levels.length === 0 ? {} : {
        reasoning: {
          efforts: entry.levels.map(level => ({ id: ReasoningEffortId(level), name: level })),
        },
      }),
    })
  }

  /** The kernel routes every generation through the pi process. */
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new LlmError(
      'pi models generate through the pi kernel (pi-agent plugin), not the dsh LLM runtime',
      'PI_CATALOG_ONLY',
    )
  }
}
