/** The data consumed by the transplanted DSH model menu, supplied by pi RPC. */
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
export interface ModelSelection { provider: string; model: string; reasoningEffort?: string }
export interface ModelReasoningEffort { id: string; name: string }
export interface ModelDirectoryState {
  current: ModelSelection | null
  routable: boolean | null
  groups: Array<{ id: string; name: string; models: Array<{ id: string; name: string; reasoning?: { defaultEffort?: string; efforts: ModelReasoningEffort[] } }> }>
  failures: Array<{ id: string; name: string; message: string }>
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  error: string | null
}
export interface ModelSelectInjected {
  available: boolean
  directory: SnapshotStore<ModelDirectoryState>
  load: () => void
  select: (selection: ModelSelection) => Promise<boolean>
}
