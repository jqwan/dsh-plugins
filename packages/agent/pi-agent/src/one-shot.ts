/**
 * One-shot pi completion: a throwaway `pi --mode rpc` child with a fresh
 * session file that turns one rendered prompt into one text reply. Serves
 * host-side callers that legitimately go through `ctx.llm` (stock /compact,
 * LLM session titles) without touching any live pi session.
 *
 * @module @deepseek-ai/dsh-pi-agent/one-shot
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiRpcProcess, type RpcFrame } from './rpc.ts'

export interface OneShotOptions {
  cliEntry: string
  /** Text handed to pi as one user prompt. */
  prompt: string
  provider?: string
  model?: string
  /** Session's provider argv only when it is a pi route (callers pre-filter). */
  signal?: AbortSignal
  /** Hard wall-clock budget for the whole completion. */
  timeoutMs?: number
}

/**
 * Run one completion. Resolves with the assistant text, or rejects on
 * spawn failure, model error, timeout, or abort. The child is always stopped.
 */
export async function piOneShot(options: OneShotOptions): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-agent-shot-'))
  const sessionFile = join(dir, 'shot.jsonl')
  const timeoutMs = options.timeoutMs ?? 120_000
  try {
    return await new Promise<string>((resolvePromise, rejectPromise) => {
      let settled = false
      const settle = (settleError: unknown, text?: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        void proc.stop(2000).catch(() => {})
        if (settleError !== undefined) rejectPromise(settleError instanceof Error ? settleError : new Error(String(settleError)))
        else resolvePromise(text ?? '')
      }
      const fail = (error: string): void => { settle(new Error(`pi one-shot: ${error}`)) }

      const timer = setTimeout(() => { fail(`timed out after ${String(timeoutMs)}ms`) }, timeoutMs)
      timer.unref?.()
      const onAbort = (): void => { fail('aborted') }
      options.signal?.addEventListener('abort', onAbort, { once: true })

      let lastError: string | undefined
      let captured = ''
      let promptSent = false

      const proc = new PiRpcProcess({
        cliEntry: options.cliEntry,
        cwd: tmpdir(),
        args: [
          '--session', sessionFile,
          ...(options.provider !== undefined && options.model !== undefined
            ? ['--provider', options.provider, '--model', options.model]
            : []),
        ],
        onFrame: (frame: RpcFrame) => {
          if (settled) return
          if (frame.type === 'extension_ui_request') return
          if (frame.type === 'message_end') {
            const message = frame.message as Record<string, unknown> | undefined
            if (message === undefined || message.role !== 'assistant') return
            if (message.stopReason === 'error') {
              lastError = typeof message.errorMessage === 'string' ? message.errorMessage : 'model error'
              return
            }
            const blocks = Array.isArray(message.content) ? message.content : []
            captured = blocks
              .map(block => (block !== null && typeof block === 'object' && (block as { type?: string }).type === 'text'
                ? String((block as { text?: string }).text ?? '')
                : ''))
              .filter(part => part !== '')
              .join('\n')
            return
          }
          if (frame.type === 'agent_end') {
            if (lastError !== undefined) { fail(lastError); return }
            settle(undefined, captured)
          }
        },
        onExit: ({ exitCode, signal }) => {
          if (!settled) fail(`process exited (code ${String(exitCode)}, signal ${String(signal)})`)
        },
      })
      // The child answers get_state as soon as its RPC loop is up; a tiny
      // readiness wait avoids dropping the prompt on a slow spawn.
      const sendPrompt = async (): Promise<void> => {
        const ready = await proc.command({ type: 'get_state', id: 'ready' }, 15_000)
        if (!ready.success) { fail('process did not become ready'); return }
        if (settled) return
        promptSent = true
        const response = await proc.command({
          type: 'prompt',
          id: 'shot',
          message: options.prompt,
          streamingBehavior: 'followUp',
        }, 30_000)
        if (!response.success && !settled) fail(`prompt rejected: ${response.error ?? 'unknown'}`)
      }
      void sendPrompt()
      void promptSent
    })
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
