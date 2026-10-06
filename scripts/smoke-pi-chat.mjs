/** Real installed pi RPC smoke; --model includes one benign model turn.
 *
 * Self-contained: resolves pi's cli.js the same way the pi-agent plugin does
 * (explicit PI_SMOKE_CLI -> npm -g of the running node -> workspace fallback),
 * spawns `--mode rpc`, and exercises the RPC commands a healthy kernel needs.
 */
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

function resolvePiCliEntry() {
  const explicit = process.env.PI_SMOKE_CLI
  if (explicit) return explicit
  const prefix = dirname(dirname(process.execPath))
  for (const candidate of [
    join(prefix, 'lib', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'),
    join(prefix, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'),
  ]) {
    if (existsSync(candidate)) return candidate
  }
  try {
    const main = spawnSync(process.execPath, ['--input-type=module', '--eval',
      `console.log(import.meta.resolve('@earendil-works/pi-coding-agent'))`], { encoding: 'utf8' })
    if (main.status === 0 && main.stdout.trim()) {
      return join(dirname(fileURLToPath(main.stdout.trim())), 'cli.js')
    }
  } catch { /* fall through */ }
  throw new Error('pi not found: npm i -g @earendil-works/pi-coding-agent or set PI_SMOKE_CLI')
}

const COMMAND_TIMEOUT_MS = 20_000
const MAX_STDERR_BYTES = 8 * 1024

function attachLineReader(stream, onLine) {
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      if (line) onLine(line)
    }
  })
}

const directory = await mkdtemp(join(tmpdir(), 'dsh-pi-smoke-'))
const child = spawn(process.execPath, [resolvePiCliEntry(), '--mode', 'rpc',
  '--session', join(directory, 'session.jsonl')], {
  cwd: directory,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env },
})

let stderrTail = ''
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk).slice(-MAX_STDERR_BYTES) })

const listeners = new Set()
let commandSeq = 0
const pending = new Map()
/** Completed assistant messages, from pi's own session bookkeeping. */
const assistantMessages = []
let lastStopReason
let streamError

child.on('exit', (code, signal) => {
  for (const { resolve } of pending.values()) resolve({ type: 'response', success: false, error: `pi exited (${code ?? signal})` })
  pending.clear()
})

attachLineReader(child.stdout, (line) => {
  let frame
  try { frame = JSON.parse(line) } catch { return }
  if (frame.type === 'response') {
    const waiter = frame.id ? pending.get(frame.id) : undefined
    if (waiter) {
      pending.delete(frame.id)
      clearTimeout(waiter.timer)
      waiter.resolve(frame)
    } else if (frame.success === false && frame.error) {
      streamError = String(frame.error)
    }
    return
  }
  if (frame.type === 'message_end' && frame.message?.role === 'assistant') {
    assistantMessages.push(frame.message)
    lastStopReason = frame.message.stopReason
  }
  if (frame.type === 'message_update' && frame.assistantMessageEvent?.type === 'error') {
    streamError = String(frame.assistantMessageEvent.error ?? 'assistant stream error')
  }
  for (const listener of listeners) listener(frame)
})

function write(command) {
  child.stdin.write(`${JSON.stringify(command)}\n`)
}

function rpc(command, { timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  commandSeq += 1
  const id = `smoke-${commandSeq}`
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve({ type: 'response', success: false, error: `${command.type} timed out after ${timeoutMs}ms` })
    }, timeoutMs)
    timer.unref?.()
    pending.set(id, { resolve, timer })
    write({ ...command, id })
  })
}

const exitWaiter = new Promise((resolve) => { child.on('exit', resolve) })

try {
  const state = await rpc({ type: 'get_state' }, { timeoutMs: 30_000 })
  if (!state.success) throw new Error(`get_state: ${state.error ?? stderrTail.trim()}`)
  console.log('Real pi state:', JSON.stringify({
    model: state.data.model?.id,
    provider: state.data.model?.provider,
    thinking: state.data.thinkingLevel,
  }))
  for (const type of ['get_available_models', 'get_available_thinking_levels', 'get_commands', 'get_session_stats']) {
    const response = await rpc({ type })
    if (!response.success) throw new Error(`${type}: ${response.error}`)
    console.log(`${type}: accepted`)
  }
  if (process.argv.includes('--model')) {
    const finished = new Promise((resolve, reject) => {
      const check = (frame) => {
        if (frame.type === 'agent_end') resolve()
      }
      listeners.add(check)
      setTimeout(() => {
        listeners.delete(check)
        reject(new Error('Model smoke timed out'))
      }, 120_000).unref?.()
    })
    const telemetry = process.argv.includes('--telemetry')
    if (telemetry) await writeFile(join(directory, 'check.txt'), 'PI_CHAT_OK\n')
    const response = await rpc({ type: 'prompt',
      message: telemetry
        ? 'Use the read tool to read check.txt, then reply with exactly its contents. Do not modify any files.'
        : 'Reply with exactly PI_CHAT_OK. Do not use tools.',
      streamingBehavior: 'followUp' }, { timeoutMs: 130_000 })
    if (!response.success) throw new Error(`prompt: ${response.error}`)
    await finished
    const last = assistantMessages.at(-1)
    if (!last || lastStopReason === 'error' || !last.content.some(block => block.type === 'text' && block.text.trim() === 'PI_CHAT_OK')) {
      throw new Error(streamError ?? 'Model did not return the expected reply')
    }
    if (telemetry) {
      console.log('(telemetry check dropped: it belonged to the retired workbench extension)')
    }
    console.log('Real model turn: PI_CHAT_OK')
  }
} finally {
  listeners.clear()
  write({ type: 'abort' })
  child.kill('SIGTERM')
  const deadline = Date.now() + 4000
  while (!child.exitCode && Date.now() < deadline) await new Promise(r => setTimeout(r, 50))
  if (!child.exitCode) child.kill('SIGKILL')
  await exitWaiter
  await rm(directory, { recursive: true, force: true })
}
