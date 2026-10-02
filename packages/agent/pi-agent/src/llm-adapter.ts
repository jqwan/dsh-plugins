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
import { piOneShot } from './one-shot.ts'

/** Read the current catalog (undefined until the async loader settles). */
export type CatalogRef = () => PiCatalog | undefined

export interface PiAdapterOptions {
  catalog: CatalogRef
  /** pi cli.js for one-shot host-side completions (compaction, titles). */
  piCliEntry?: string
  logger?: { warn: (message: string) => void }
}

export class PiCatalogAdapter extends LlmAdapter {
  constructor(private readonly options: PiAdapterOptions) {
    super()
  }

  private get catalogRef(): CatalogRef {
    return this.options.catalog
  }

  override providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: `${provider} · pi` }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = this.catalogRef()?.models.filter(model => model.provider === provider) ?? []
    return Promise.resolve(models.map(model => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: model.reasoning ? (['text'] as const) : (['text'] as const),
    })))
  }

  override resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const entry = this.catalogRef()?.models.find(candidate => candidate.provider === provider && candidate.id === model)
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

  /**
   * Host-side callers (stock /compact, LLM session titles) get a one-shot
   * completion through a throwaway pi process. Live agent turns never come
   * through here — the kernel drives its own pi child directly.
   */
  override async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    const cliEntry = this.options.piCliEntry
    if (cliEntry === undefined) {
      throw new LlmError('pi one-shot unavailable: no piCliEntry', 'PI_CATALOG_ONLY')
    }
    if (!Array.isArray(request.messages) || request.messages.length === 0) {
      throw new LlmError('pi one-shot: empty request', 'PI_REQUEST_EMPTY')
    }
    const prompt = renderRequestPrompt(request.messages)
    const text = await piOneShot({
      cliEntry,
      prompt,
      provider: request.provider,
      model: request.model,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Flatten dsh request messages into the plain text a one-shot prompt carries. */
function renderRequestPrompt(messages: GenerateOptions['messages']): string {
  const lines: string[] = []
  for (const message of messages) {
    const role = message.role
    const content = Array.isArray(message.content) ? message.content : []
    const text = content
      .map(block => {
        if (block === null || typeof block !== 'object') return ''
        const record = block as { type?: string; text?: string }
        if (record.type === 'text') return String(record.text ?? '')
        if (record.type === 'reasoning') return ''
        return ''
      })
      .filter(part => part !== '')
      .join('\n')
    if (text === '') continue
    lines.push(`[${role}]\n${text}`)
  }
  return lines.join('\n\n')
}
