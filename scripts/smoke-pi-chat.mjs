/** Real installed pi RPC smoke; --model includes one benign model turn. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startPiChat, piChatCommand, piChatSnapshot, sendPiChatPrompt, subscribePiChat, stopPiChatAndWait } from '../packages/task/workbench-web/src/pi/chat-executor.js'
const directory = await mkdtemp(join(tmpdir(), 'dsh-pi-smoke-'))
try {
  await startPiChat({ taskId: 'smoke', childSessionId: 'rpc', sessionFile: join(directory, 'session.jsonl'), workingDir: directory, provider: process.env.PI_SMOKE_PROVIDER, model: process.env.PI_SMOKE_MODEL })
  const state = await piChatCommand('smoke', 'rpc', { type: 'get_state' })
  if (!state.success) throw new Error(state.error)
  console.log('Real pi state:', JSON.stringify({ model: state.data.model?.id, provider: state.data.model?.provider, thinking: state.data.thinkingLevel }))
  for (const type of ['get_available_models', 'get_available_thinking_levels', 'get_commands', 'get_session_stats']) {
    const response = await piChatCommand('smoke', 'rpc', { type })
    if (!response.success) throw new Error(`${type}: ${response.error}`)
    console.log(`${type}: accepted`)
  }
  await piChatSnapshot('smoke', 'rpc')
  if (process.argv.includes('--model')) {
    let finish, fail
    const finished = new Promise((resolve, reject) => { finish = resolve; fail = reject })
    const unsubscribe = subscribePiChat('smoke', 'rpc', frame => { if (frame.event?.type === 'agent_end') finish() })
    const timer = setTimeout(() => fail(new Error('Model smoke timed out')), 120_000)
    try {
      const telemetry = process.argv.includes('--telemetry')
      if (telemetry) await writeFile(join(directory, 'check.txt'), 'PI_CHAT_OK\n')
      const response = await sendPiChatPrompt('smoke', 'rpc', telemetry ? 'Use the read tool to read check.txt, then reply with exactly its contents. Do not modify any files.' : 'Reply with exactly PI_CHAT_OK. Do not use tools.')
      if (!response.success) throw new Error(response.error)
      await finished
      const snapshot = await piChatSnapshot('smoke', 'rpc')
      const last = snapshot.messages.filter(message => message.role === 'assistant').at(-1)
      if (!last || last.stopReason === 'error' || !last.content.some(block => block.type === 'text' && block.text.trim() === 'PI_CHAT_OK')) throw new Error(last?.errorMessage || 'Model did not return the expected reply')
      if (telemetry) {
        const records = snapshot.entries.filter(entry => entry.customType === 'dsh-workbench.telemetry.v1').map(entry => entry.data)
        for (const kind of ['assistant', 'tool-schema', 'tool', 'run']) {
          if (!records.some(record => record.kind === kind && (kind === 'tool-schema' ? record.schema?.type === 'object' : record.durationMs >= 0))) throw new Error(`Missing persisted ${kind} telemetry`)
        }
        console.log('Persisted request, tool, run timing and tool schema: verified')
      }
      console.log('Real model turn: PI_CHAT_OK')
    } finally { clearTimeout(timer); unsubscribe() }
  }
} finally {
  await stopPiChatAndWait('smoke', 'rpc')
  await rm(directory, { recursive: true, force: true })
}
