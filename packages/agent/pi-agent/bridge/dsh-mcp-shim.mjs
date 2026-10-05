/**
 * DSH tool bridge — MCP stdio shim.
 *
 * pi 1.0.x's builtin MCP client spawns this script (configured in
 * ~/.pi/agent/mcp.json) and speaks MCP over stdin/stdout (newline-delimited
 * JSON-RPC 2.0). The shim translates to the dsh tool-bridge socket protocol
 * (list/execute/cancel) toward the ToolBridgeServer inside the dsh host:
 *
 *   pi model → pi builtin MCP client → this shim (stdio)
 *     → unix socket (env DSH_TOOL_BRIDGE_SOCKET) → ToolBridgeServer
 *     → ctx.tools.execute({agent}) → native approval/sandbox
 *
 * The socket path rides the environment: the dsh driver injects it into the
 * pi process and pi's stdio transport inherits the parent env. Without the
 * env (pi run outside dsh) the shim serves an empty tool list, inert.
 *
 * Deliberately written as a pure callback state machine — no async/await or
 * promise plumbing — so every transition is synchronous and observable.
 * Zero dependencies.
 */

import { connect } from 'node:net'

const SOCKET_PATH = process.env.DSH_TOOL_BRIDGE_SOCKET || ''
const SHIM_PROTOCOL_VERSION = '2024-11-05'
const CONNECT_MAX_ATTEMPTS = 8

/** --- state --- */

let socket = null
let socketReady = false
let connectTimer = null
let connectAttempts = 0
/** pending socket requests awaiting their reply frame */
const socketPending = new Map()
/** MCP request id → in-flight socket correlation id */
const callSocketIds = new Map()
let socketSeq = 0

/** --- stdio (MCP wire) --- */

function mcpWrite(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function mcpReplyResult(id, result) {
  mcpWrite({ jsonrpc: '2.0', id, result })
}

function mcpReplyError(id, code, message) {
  mcpWrite({ jsonrpc: '2.0', id, error: { code, message } })
}

/** --- socket transport (dsh bridge protocol) --- */

function socketSend(frame) {
  if (!socketReady || socket === null) return false
  socket.write(`${JSON.stringify(frame)}\n`)
  return true
}

function socketRequest(frame, onReply) {
  const id = `c${socketSeq += 1}`
  if (!socketSend({ id, ...frame })) {
    onReply({ id, ok: false, error: 'dsh tool bridge is not connected' })
    return id
  }
  socketPending.set(id, onReply)
  return id
}

function tryConnect() {
  if (socketReady) return
  if (SOCKET_PATH === '') return // inert without the bridge env
  const s = connect(SOCKET_PATH)
  s.setEncoding('utf8')
  let buffer = ''
  s.on('connect', () => {
    socket = s
    socketReady = true
    connectAttempts = 0
  })
  s.on('data', (chunk) => {
    buffer += chunk
    let idx = buffer.indexOf('\n')
    while (idx !== -1) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      if (line.trim() !== '') dispatchSocketFrame(line)
      idx = buffer.indexOf('\n')
    }
  })
  s.on('error', () => {
    const wasReady = socketReady
    if (socket === s) { socket = null; socketReady = false }
    if (!wasReady) scheduleReconnect()
  })
  s.on('close', () => {
    if (socket === s) { socket = null; socketReady = false }
    // Fail every pending request; pi surfaces the error to the model.
    for (const [id, onReply] of socketPending) {
      socketPending.delete(id)
      onReply({ id, ok: false, error: 'dsh tool bridge disconnected' })
    }
  })
}

function scheduleReconnect() {
  if (connectTimer !== null || socketReady) return
  connectAttempts += 1
  if (connectAttempts > CONNECT_MAX_ATTEMPTS) return // stay inert
  connectTimer = setTimeout(() => {
    connectTimer = null
    tryConnect()
  }, 250 * connectAttempts)
}

function dispatchSocketFrame(line) {
  let frame
  try { frame = JSON.parse(line) } catch { return }
  const onReply = socketPending.get(frame.id)
  if (onReply === undefined) return
  socketPending.delete(frame.id)
  onReply(frame)
}

/** --- MCP method handlers (pure callbacks) --- */

function sendToolsList(id) {
  const onReady = () => {
    socketRequest({ kind: 'list' }, (reply) => {
      const tools = Array.isArray(reply.tools) ? reply.tools : []
      mcpReplyResult(id, {
        tools: tools
          .filter(schema => schema !== null && typeof schema === 'object' && typeof schema.name === 'string')
          .map(schema => ({
            name: schema.name,
            description: typeof schema.description === 'string' ? schema.description : '',
            inputSchema: (schema.parameters !== null && typeof schema.parameters === 'object')
              ? schema.parameters
              : { type: 'object', properties: {} },
          })),
      })
    })
  }
  if (socketReady) onReady()
  else {
    // One deferred attempt; the host socket is normally ready long before.
    connectAttempts = 0
    tryConnect()
    setTimeout(() => {
      if (socketReady) onReady()
      else mcpReplyResult(id, { tools: [] })
    }, 600)
  }
}

function sendToolsCall(id, params) {
  const name = params && typeof params.name === 'string' ? params.name : ''
  if (name === '') {
    mcpReplyError(id, -32602, 'tools/call requires a tool name')
    return
  }
  const onReady = () => {
    const socketId = socketRequest({ kind: 'execute', name, arguments: params.arguments ?? {} }, (reply) => {
      callSocketIds.delete(id)
      if (!reply.ok) {
        // Execution-level failure: an MCP tool result with isError, not a
        // protocol error — the model should see the failure text.
        mcpReplyResult(id, {
          content: [{ type: 'text', text: typeof reply.error === 'string' ? reply.error : 'dsh tool failed' }],
          isError: true,
        })
        return
      }
      mcpReplyResult(id, {
        content: [{ type: 'text', text: typeof reply.text === 'string' ? reply.text : '' }],
        isError: reply.isError === true,
      })
    })
    callSocketIds.set(id, socketId)
  }
  if (socketReady) onReady()
  else mcpReplyResult(id, { content: [{ type: 'text', text: 'dsh tool bridge is not connected' }], isError: true })
}

function handleMcpMessage(message) {
  if (message === null || typeof message !== 'object') return
  const { id, method, params } = message
  const isRequest = id !== undefined && id !== null
  if (method === 'initialize') {
    // Echo the client's requested version; pi's client rejects versions
    // outside its own supported list.
    const requested = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : SHIM_PROTOCOL_VERSION
    mcpReplyResult(id, {
      protocolVersion: requested,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'dsh-tools', version: '1.0.0' },
    })
    return
  }
  if (typeof method === 'string' && method.startsWith('notifications/')) {
    if (method === 'notifications/cancelled') {
      const socketId = callSocketIds.get(params && params.requestId)
      if (socketId !== undefined) socketSend({ kind: 'cancel', id: socketId })
    }
    return // notifications get no reply
  }
  if (method === 'ping') {
    if (isRequest) mcpReplyResult(id, {})
    return
  }
  if (method === 'tools/list') {
    if (isRequest) sendToolsList(id)
    return
  }
  if (method === 'tools/call') {
    if (isRequest) sendToolsCall(id, params)
    return
  }
  if (isRequest) mcpReplyError(id, -32601, `method not found: ${String(method)}`)
}

/** --- wiring --- */

let stdinBuffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk
  let idx = stdinBuffer.indexOf('\n')
  while (idx !== -1) {
    const line = stdinBuffer.slice(0, idx)
    stdinBuffer = stdinBuffer.slice(idx + 1)
    if (line.trim() !== '') {
      let message
      try { message = JSON.parse(line) } catch { continue }
      handleMcpMessage(message)
    }
    idx = stdinBuffer.indexOf('\n')
  }
})
process.stdin.on('end', () => {
  process.exit(0)
})
tryConnect()
