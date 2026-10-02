/** Supplies the unmodified model-menu interaction with pi's catalog and selection acknowledgements. */
import { useEffect, useMemo } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { ModelSelect } from './dsh-chat/ModelSelect.tsx'
import { zh } from './dsh-chat/model-locales.ts'
import type { PiModel } from './pi-chat.tsx'
import type { ModelDirectoryState, ModelSelection } from './pi-model-types.ts'
import type { ChatTranslate } from './pi-locale.ts'
const t: ChatTranslate = (key, params = {}) => ((zh as Record<string, string>)[key] ?? ({ retry: '重试', back: '返回' } as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''))
export function PiModelSelect(props: {
  error: string | null; models: PiModel[]; current: PiModel | null; thinking: string; levels: string[]; loading: boolean; disabled: boolean
  load: () => void; select: (selection: ModelSelection) => Promise<{ success: boolean; error?: string }>
}) {
  const directory = useMemo(() => createSnapshotStore<ModelDirectoryState>({ current: null, routable: null, groups: [], failures: [], status: 'idle', error: null }), [])
  useEffect(() => {
    const groups: ModelDirectoryState['groups'] = []
    for (const model of props.models) {
      let group = groups.find(group => group.id === model.provider)
      if (!group) { group = { id: model.provider, name: model.provider, models: [] }; groups.push(group) }
      group.models.push({ id: model.id, name: model.name || model.id,
        ...(model.reasoning && (model.levels || model.id === props.current?.id && model.provider === props.current.provider) ? { reasoning: { efforts: (model.levels || props.levels).map(id => ({ id, name: id })) } } : {}) })
    }
    directory.set({ current: props.current ? { provider: props.current.provider, model: props.current.id, reasoningEffort: props.thinking } : null,
      groups, routable: true, failures: [], status: props.loading ? 'loading' : props.error ? 'error' : 'ready', error: props.error })
  }, [props.models, props.current, props.thinking, props.levels, props.loading, props.error, directory])
  return <ModelSelect available locked={props.disabled} directory={directory} load={props.load} t={t} select={async selection => {
    directory.set({ ...directory.getSnapshot(), status: 'selecting', error: null })
    const result = await props.select(selection)
    directory.set({ ...directory.getSnapshot(), status: result.success ? 'ready' : 'error', error: result.error || null })
    return result.success
  }} />
}
