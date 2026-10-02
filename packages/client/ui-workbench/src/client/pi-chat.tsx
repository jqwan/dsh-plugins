import { StatsLineContent } from './dsh-chat/StatsLine.tsx'
import { piSessionStatsGroups } from './pi-session-stats.ts'
import { WIDTH_PREF_KEY, readWidthPreference, resolveContentWidth, observePiWidth } from './pi-width.ts'
import { readPiViewport, savePiViewport } from './pi-viewport.ts'
import { applyPiTelemetry, piTurnUsage, piTurnTiming, type PiTiming } from './pi-telemetry.ts'
import { TurnUsagePanel, TurnTimePanel } from './dsh-chat/TurnUsagePanel.tsx'
/** Pi RPC chat using versioned DSH conversation chrome and operation adapters. */

import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, useLayoutEffect } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import {
  DisclosureRow, IconChevronDownOutlineRegular, IconCodeOutlineRegular, IconThinkOutlineRegular, JsonBlock, MarkdownText,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { MessageIconActions } from './dsh-chat/MessageIconActions.tsx'
import { chatT } from './pi-locale.ts'
import nativeMessage from './dsh-chat/MessageItem.module.css'
import nativeChat from './dsh-chat/ChatView.module.css'
import nativeRoot from './dsh-chat/ConversationRoot.module.css'
import nativeProcess from './dsh-chat/TurnProcessNodeView.module.css'
import nativeQueue from './dsh-chat/QueueDock.module.css'
import { TurnNavigator, type TurnRailItem } from './dsh-chat/TurnNavigator.tsx'
import { PinnedNotesBar } from './notes-bar.tsx'
import { PiModelSelect } from './pi-model.tsx'
import heroCss from './dsh-chat/HeroShell.module.css'
import { PiPixelMark } from './brand.tsx'
import type { PiTrajectoryEntry } from './pi-trajectory-data.ts'
import { PiTrajectory } from './pi-trajectory.tsx'
import { PiComposer } from './pi-composer.tsx'
import { groupTurns } from './pi-turns.ts'
import { ICONS } from './ui.tsx'

import css from './workbench.module.css'

// —— 数据模型 ——

export type ChatBlock =
  | { kind: 'image'; data: string; mimeType: string }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'toolCall'; id: string; name: string; args: unknown }
  | { kind: 'toolResult'; toolCallId: string | null; toolName: string; isError: boolean; text: string }

export interface ChatMessage {
  /** 渲染角色：user/assistant 为消息，notice 为居中提示行（进程退出等）。 */
  role: 'user' | 'assistant' | 'notice'
  blocks: ChatBlock[]
  text?: string
  /** 消息时间（epoch ms），用于日期分隔。 */
  time?: number | null
  stopReason?: string | null
  errorText?: string | null
  streaming?: boolean
  /** JSONL 条目 id（分叉锚点）；仅快照加载的消息携带，实时流收尾后经快照刷新补上。 */
  entryId?: string | null
  provider?: string
  model?: string
  timing?: PiTiming
  runTiming?: PiTiming
  usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number } | null
}

export interface ToolOutput {
  schema?: unknown
  timing?: PiTiming
  name?: string
  args?: unknown
  status: 'running' | 'done' | 'error'
  text?: string
}

interface UiRequest {
  id: string
  method: string
  title?: string
  message?: string
  options?: Array<string | { label?: string; value?: unknown }>
  placeholder?: string
  prefill?: string
}

export interface PiModel {
  id: string
  name?: string
  provider: string
  reasoning?: boolean
  levels?: string[]
}

interface ProcessSegment {
  type: 'process'
  items: ChatBlock[]
}
interface TextSegment {
  type: 'text'
  block: Extract<ChatBlock, { kind: 'text' }>
}
type AssistantSegment = ProcessSegment | TextSegment

const MD_LABELS = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' }

function blocksOfLive(message: { role: string; content?: unknown }): ChatBlock[] {
  const content = Array.isArray(message.content)
    ? message.content
    : typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : []
  const blocks: ChatBlock[] = []
  for (const block of content) {
    const typed = block as { type?: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown }
    if (typed.type === 'image' && typeof (block as { data?: unknown }).data === 'string') blocks.push({ kind: 'image', data: (block as { data: string }).data, mimeType: (block as { mimeType: string }).mimeType })
    else if (typed.type === 'text' && typed.text) blocks.push({ kind: 'text', text: typed.text })
    else if (typed.type === 'thinking' && typed.thinking) blocks.push({ kind: 'thinking', text: typed.thinking })
    else if (typed.type === 'toolCall' && typed.id) blocks.push({ kind: 'toolCall', id: typed.id, name: typed.name || '', args: typed.arguments ?? null })
  }
  return blocks
}

/** 助手块 → 展示段：连续的思考/工具调用收进一个"执行过程"段（dsh 回合过程样式）。 */
function segmentBlocks(blocks: ChatBlock[]): AssistantSegment[] {
  const segments: AssistantSegment[] = []
  let process: ChatBlock[] | null = null
  const flush = () => {
    if (process?.length) segments.push({ type: 'process', items: process })
    process = null
  }
  for (const block of blocks) {
    if (block.kind === 'text') {
      flush()
      segments.push({ type: 'text', block })
    } else {
      if (!process) process = []
      process.push(block)
    }
  }
  flush()
  return segments
}

function messageTime(message: { timestamp?: unknown }): number | null {
  if (typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)) return message.timestamp
  if (typeof message.timestamp === 'string') {
    const parsed = Date.parse(message.timestamp)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** 工具行折叠摘要：优先常见参数（command/path/pattern），否则短 JSON。 */
function argsSummary(name: string, args: unknown): string {
  if (args && typeof args === 'object') {
    const record = args as Record<string, unknown>
    for (const key of ['command', 'path', 'file_path', 'pattern', 'url', 'query']) {
      const value = record[key]
      if (typeof value === 'string' && value.trim()) {
        const text = value.trim().replace(/\s+/g, ' ')
        return text.length > 80 ? `${text.slice(0, 80)}…` : text
      }
    }
  }
  try {
    const text = JSON.stringify(args ?? null)
    return !text || text.length <= 80 ? text || name : `${text.slice(0, 80)}…`
  } catch {
    return name
  }
}

/** 从工具结果对象中提取可读文本（RPC result 与 JSONL toolResult 结构不同，都兜住）。 */
function toolOutputText(result: unknown): string {
  if (result == null) return ''
  if (typeof result === 'string') return result
  const typed = result as { content?: unknown; output?: unknown; text?: unknown }
  if (Array.isArray(typed.content)) {
    return typed.content
      .map((block) => (block && typeof block === 'object' && typeof (block as { text?: string }).text === 'string' ? (block as { text: string }).text : ''))
      .filter(Boolean)
      .join('\n')
  }
  if (typeof typed.output === 'string') return typed.output
  if (typeof typed.text === 'string') return typed.text
  try { return JSON.stringify(result) } catch { return String(result) }
}

function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return (newline === -1 ? text : text.slice(0, newline)).trimEnd()
}

/** pi RPC get_session_stats 的返回形状（agent-session.ts SessionStats 子集）。 */
export interface PiSessionStats {
  userMessages: number
  assistantMessages: number
  toolCalls: number
  toolResults: number
  totalMessages: number
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
  cost: number
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null } | null
}

/** 令牌数缩写：999 → 999，1234 → 1.2k，1234567 → 1.23M。 */
function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(Math.round(count / 10_000) / 100).toFixed(2)}M`
  if (count >= 1_000) return `${(Math.round(count / 100) / 10).toFixed(1)}k`
  return String(count)
}

// —— 会话宽度轴（对齐原生 ConversationRoot：两侧拖拽改宽，偏好与 dsh 会话共享同一存储键） ——

/** 拖宽手柄：指针捕获 + rAF 节流的对称缩放（移植原生 ConversationRoot 同名组件）。 */
function WidthHandle(props: { side: 'left' | 'right'; onStart: () => number; onDrag: (width: number) => void; onCommit: (width: number) => void; onEnd: () => void }) {
  const [dragging, setDragging] = useState(false)
  const base = useRef(0)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const callbacks = useRef(props)
  callbacks.current = props

  const outwardWidth = () => {
    const dx = latest.current - origin.current
    return base.current + (props.side === 'right' ? dx : -dx) * 2
  }
  const cancelFrame = () => {
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
  }
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    origin.current = e.clientX
    latest.current = e.clientX
    base.current = callbacks.current.onStart()
    setDragging(true)
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    e.currentTarget.style.setProperty('--dsh-width-handle-pointer-y', `${e.clientY - box.top}px`)
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    latest.current = e.clientX
    if (frame.current === null) {
      frame.current = requestAnimationFrame(() => {
        frame.current = null
        callbacks.current.onDrag(outwardWidth())
      })
    }
  }
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    cancelFrame()
    latest.current = e.clientX
    if (latest.current !== origin.current) callbacks.current.onCommit(outwardWidth())
    setDragging(false)
    callbacks.current.onEnd()
  }
  const onPointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    cancelFrame()
    setDragging(false)
    callbacks.current.onEnd()
  }
  return (
    <div
      className={nativeRoot.widthHandle}
      data-side={props.side}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
    />
  )
}

// —— 展示组件 ——

const ThinkRow = memo(function ThinkRow(props: { text: string }): ReactElement {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className={css.chatThinkRow}>
      <DisclosureRow
        rowClassName={css.chatThinkDisclosure}
        icon={<IconThinkOutlineRegular size={14} />}
        title="思考"
        open={expanded}
        expandable
        expandOnRowClick
        onToggle={() => setExpanded((value) => !value)}
        collapsedContent={
          props.text.trim()
            ? (
              <>
                <span className={css.chatThinkSep} aria-hidden />
                <span className={css.chatThinkSummary}>{firstLine(props.text)}</span>
              </>
            )
            : undefined
        }
      >
        <div className={css.chatThinkBody}>{props.text}</div>
      </DisclosureRow>
    </div>
  )
})

const ToolRow = memo(function ToolRow(props: { name: string; args: unknown; output: ToolOutput | undefined }): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const state = props.output?.status ?? 'running'
  const summary = state === 'running' ? '运行中…' : argsSummary(props.name, props.args)
  const output = props.output?.text?.trim()
  return (
    <div className={css.chatToolRow} data-state={state}>
      <DisclosureRow
        rowClassName={css.chatToolDisclosure}
        icon={<IconCodeOutlineRegular size={14} />}
        title={props.name || 'tool'}
        open={expanded}
        expandable
        expandOnRowClick
        onToggle={() => setExpanded((value) => !value)}
        collapsedContent={
          <>
            <span className={css.chatThinkSep} aria-hidden />
            <span className={`${css.chatThinkSummary} ${css.chatToolSummary}`}>{summary}</span>
          </>
        }
      >
        <div className={css.chatToolBody}>
          {props.args != null ? <JsonBlock label="参数" payload={props.args} truncatedLabel={() => '…'} /> : null}
          {output ? <pre className={`${css.chatToolOutput} ${state === 'error' ? css.chatToolOutputError : ''}`}>{output}</pre> : null}
        </div>
      </DisclosureRow>
    </div>
  )
})

const AssistantMessageView = memo(function AssistantMessageView(props: {
  message: ChatMessage
  tools: Map<string, ToolOutput>
  streaming: boolean
}): ReactElement {
  const { message } = props
  const segments = useMemo(() => segmentBlocks(message.blocks), [message.blocks])
  const lastTextIndex = segments.length - 1 - [...segments].reverse().findIndex((segment) => segment.type === 'text')
  return (
    <div className={css.chatAssistantWrap}>
      {segments.map((segment, index) => segment.type === 'text' ? (
        <MarkdownText
          key={index}
          text={segment.block.text}
          streaming={props.streaming && index === lastTextIndex}
          labels={MD_LABELS}
        />
      ) : (
        <Fragment key={index}>{segment.items.map((item, i) => item.kind === 'thinking' ? <ThinkRow key={i} text={item.text} /> : item.kind === 'toolCall' ? <ToolRow key={item.id} name={item.name} args={item.args} output={props.tools.get(item.id)} /> : item.kind === 'image' ? <img key={i} className={css.chatImage} src={`data:${item.mimeType};base64,${item.data}`} alt="图片" /> : null)}</Fragment>
      ))}
      {message.stopReason === 'aborted' ? <div className={css.chatAborted}>已中断</div> : null}
      {message.stopReason === 'error' && message.errorText ? <div className={css.chatTurnError}>{message.errorText}</div> : null}

    </div>
  )
})

// —— 主视图 ——

export interface PiInitialPrompt { text: string; mode: 'queue' | 'steer'; images: Array<{ type: 'image'; data: string; mimeType: string }> }
interface PiChatProps {
  trajectory?: boolean
  initialPrompt?: PiInitialPrompt
  /** Existing-session hero label; the row keeps empty chat spacing equal to dsh. */
  taskTitle?: string
  onFirstAccepted?: () => void
  taskId: string
  sessionId: string
  /** 连接状态上报（侧栏红点）：error/closed 记错误，ready/connecting 清除。 */
  onStatus?: (status: 'connecting' | 'ready' | 'closed' | 'error') => void
  /** 从指定 JSONL 条目分叉出新会话（由中心面实现并切换到分支会话）。 */
  onBranch?: (entryId: string) => void
}

export function PiChat(props: PiChatProps): ReactElement {
  const { taskId, sessionId, onStatus } = props
  const viewportKey = `${taskId}/${sessionId}`
  const initialViewport = useRef(readPiViewport(viewportKey))
  const [snapshotLoaded, setSnapshotLoaded] = useState(false)
  const firstPrompt = useRef(props.initialPrompt)
  const firstAccepted = useRef(props.onFirstAccepted)
  const [nonce, setNonce] = useState(0)
  const [status, setStatus] = useState<'connecting' | 'ready' | 'closed' | 'error'>('connecting')
  const [trajectoryEntries, setTrajectoryEntries] = useState<PiTrajectoryEntry[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [tools, setTools] = useState<Map<string, ToolOutput>>(new Map())
  const [streaming, setStreaming] = useState(false)
  const [currentModel, setCurrentModel] = useState<PiModel | null>(null)
  const [thinking, setThinking] = useState('')
  const [models, setModels] = useState<PiModel[]>([])
  // Reserve the native model trigger from the first paint.  Its label changes
  // from the loading state to the session model when chat_ready arrives, but
  // the composer toolbar never gains a late control during a session switch.
  const [modelsLoading, setModelsLoading] = useState(true)
  const selectionRequests = useRef(new Map<string, (result: { success: boolean; error?: string }) => void>())
  const [queued, setQueued] = useState(0)
  const [commands, setCommands] = useState<Array<{ name: string; description?: string }>>([])
  const [thinkingLevels, setThinkingLevels] = useState<string[]>([])
  const [stats, setStats] = useState<PiSessionStats | null>(null)
  const [statsOpen, setStatsOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [accepted, setAccepted] = useState(0)
  const submission = useRef<{ id: string; text: string } | null>(null)
  // 紧凑显示（历史消息折叠过程输出）取自本地偏好，只读；入口已随会话选项按钮移除
  const [compact] = useState(() => localStorage.getItem('pi-chat-display') !== 'normal')
  const [visibleCount, setVisibleCount] = useState(initialViewport.current.visibleCount)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [activeTurn, setActiveTurn] = useState<number | null>(null)
  const [showJump, setShowJump] = useState(false)
  const [error, setError] = useState('')
  const [uiRequests, setUiRequests] = useState<UiRequest[]>([])
  const [input, setInput] = useState(() => sessionStorage.getItem(`pi-draft:${taskId}/${sessionId}`) || '')
  const [elapsed, setElapsed] = useState(0)
  const dialog = uiRequests[0]
  const hero = snapshotLoaded && messages.length === 0 && !streaming && !dialog
  const turns = useMemo(() => groupTurns(messages), [messages])
  // 渲染窗口首回合在全会话中的下标（导航条与 DOM 定位都按全量下标对齐）
  const firstVisible = Math.max(0, turns.length - Math.min(visibleCount, turns.length))
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const draggingRef = useRef(false)
  useLayoutEffect(() => observePiWidth(rootRef.current!, () => draggingRef.current), [])
  const savedScrollTop = useRef(initialViewport.current.top)
  const nearBottomRef = useRef(initialViewport.current.nearBottom)
  const socketRef = useRef<WebSocket | null>(null)
  useEffect(() => { sessionStorage.setItem(`pi-draft:${taskId}/${sessionId}`, input) }, [taskId, sessionId, input])

  const onStatusRef = useRef(onStatus)
  useLayoutEffect(() => { onStatusRef.current = onStatus }, [onStatus])
  const updateStatus = useCallback((next: 'connecting' | 'ready' | 'closed' | 'error') => {
    setStatus(next)
    onStatusRef.current?.(next)
  }, [])

  // 运行中计时
  useEffect(() => {
    if (!streaming) { setElapsed(0); return }
    const started = Date.now()
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [streaming])

  // WebSocket 事件流
  useEffect(() => {
    let disposed = false
    let errored = false
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/workbench/ws`)
    socketRef.current = socket
    const send = (message: unknown) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
    }

    /** 把一条 RPC 事件并进消息列表（无消息 id，按流式尾位置 upsert）。 */
    const applyEvent = (event: { type?: string; message?: { role: string; content?: unknown; stopReason?: string; errorMessage?: string; timestamp?: unknown }; toolCallId?: string; toolName?: string; args?: unknown; result?: unknown; partialResult?: unknown; isError?: boolean }) => {
      if (event.type === 'agent_start') { setStreaming(true); return }
      if (event.type === 'agent_end') {
        setStreaming(false)
        send({ type: 'chat_state' })
        // 回合收尾后刷新底部统计行，并拉取快照补齐 entryId（分叉锚点）
        send({ type: 'chat_command', command: 'get_session_stats' })
        send({ type: 'chat_snapshot' })
        return
      }
      if (event.type === 'tool_execution_start') {
        const id = String(event.toolCallId || '')
        if (!id) return
        setTools((previous) => new Map(previous).set(id, { name: event.toolName, args: event.args, status: 'running' }))
        return
      }
      if (event.type === 'tool_execution_update' || event.type === 'tool_execution_end') {
        const id = String(event.toolCallId || '')
        if (!id) return
        setTools((previous) => new Map(previous).set(id, {
          name: event.toolName, args: event.args,
          status: event.type === 'tool_execution_update' ? 'running' : event.isError ? 'error' : 'done',
          text: toolOutputText(event.result ?? event.partialResult),
        }))
        return
      }
      if (event.type !== 'message_start' && event.type !== 'message_update' && event.type !== 'message_end') return
      const message = event.message
      if (!message) return
      const role = message.role
      if (role === 'toolResult') {
        const id = String((message as { toolCallId?: string }).toolCallId || '')
        if (!id) return
        const result = message as { toolName?: string; isError?: boolean; content?: unknown }
        setTools(previous => new Map(previous).set(id, { name: result.toolName, status: result.isError ? 'error' : 'done', text: toolOutputText(result) }))
        return
      }
      if (role === 'user') {
        if (event.type === 'message_update') return
        if (event.type !== 'message_end') return
        const settled: ChatMessage = { role: 'user', blocks: blocksOfLive(message), time: messageTime(message) }
        setMessages(previous => [...previous, settled])
        send({ type: 'chat_state' })
        return
      }
      if (role === 'assistant') {
        const blocks = blocksOfLive(message)
        const finished = event.type === 'message_end'
        const assembled: ChatMessage = {
          role: 'assistant', blocks, time: messageTime(message),
          stopReason: message.stopReason ?? null, errorText: message.errorMessage ?? null, streaming: !finished,
          usage: (message as { usage?: ChatMessage['usage'] }).usage ?? null,
          provider: (message as { provider?: string }).provider, model: (message as { model?: string }).model,
        }
        setMessages((previous) => {
          const next = previous.slice()
          const last = next[next.length - 1]
          if (last?.role === 'assistant' && last.streaming) next[next.length - 1] = assembled
          else next.push(assembled)
          return next
        })
        return
      }
    }

    socket.onopen = () => {
      if (disposed) { socket.close(); return }
      send({ type: 'chat_hello', taskId, sessionId })
    }
    socket.onmessage = ({ data }) => {
      if (disposed) return
      let frame: Record<string, unknown>
      try { frame = JSON.parse(String(data)) } catch { return }
      const type = frame.type
      if (type === 'chat_selection_result') {
        selectionRequests.current.get(String(frame.requestId))?.({ success: Boolean(frame.success), error: frame.error as string | undefined })
        selectionRequests.current.delete(String(frame.requestId))
        send({ type: 'chat_command', command: 'get_available_thinking_levels' })
      } else if (type === 'chat_snapshot') {
        setTrajectoryEntries(Array.isArray(frame.entries) ? frame.entries as PiTrajectoryEntry[] : [])
        const list: ChatMessage[] = []
        const toolMap = new Map<string, ToolOutput>()
        for (const raw of (Array.isArray(frame.messages) ? frame.messages : [])) {
          const message = raw as { role: string; content?: unknown; timestamp?: unknown; toolCallId?: string; toolName?: string; isError?: boolean; stopReason?: string; errorMessage?: string }
          if (message.role === 'toolResult') {
            if (message.toolCallId) toolMap.set(message.toolCallId, { name: message.toolName, status: message.isError ? 'error' : 'done', text: toolOutputText(message) })
          } else if (message.role === 'user' || message.role === 'assistant') {
            list.push({ role: message.role, blocks: blocksOfLive(message), time: messageTime(message), stopReason: message.stopReason, errorText: message.errorMessage, entryId: (message as { entryId?: string }).entryId ?? null, usage: (message as { usage?: ChatMessage['usage'] }).usage ?? null, provider: (message as { provider?: string }).provider, model: (message as { model?: string }).model })
          }
        }
        if (frame.live) {
          const live = frame.live as { role: string; content?: unknown; timestamp?: unknown }
          list.push({ role: 'assistant', blocks: blocksOfLive(live), time: messageTime(live), streaming: true })
        }
        applyPiTelemetry(list, toolMap, Array.isArray(frame.entries) ? frame.entries as PiTrajectoryEntry[] : [])
        setSnapshotLoaded(true)
        setMessages(list)
        setTools(toolMap)
        setUiRequests((frame.requests as UiRequest[]) || [])
      } else if (type === 'chat_prompt_result') {
        if (submission.current && frame.requestId === submission.current.id) {
          if (!frame.success) { setInput(submission.current.text); setError(String(frame.error || '发送失败')) }
          if (frame.success) { setAccepted(value => value + 1); firstAccepted.current?.(); firstAccepted.current = undefined }
          submission.current = null
          setSending(false)
        }
      } else if (type === 'chat_ui_resolved') {
        setUiRequests(previous => previous.filter(item => item.id !== frame.id))
      } else if (type === 'chat_command_result') {
        if (!frame.success) {
          // 统计拉取失败静默（底部行自动刷新，不值得打断用户）
          if (frame.command !== 'get_session_stats') setError(String(frame.error || '操作失败'))
        } else if (frame.command === 'get_commands') setCommands((frame.data as { commands: Array<{ name: string; description?: string }> }).commands)
        else if (frame.command === 'get_available_thinking_levels') setThinkingLevels((frame.data as { levels: string[] }).levels)
        else if (frame.command === 'get_session_stats') setStats((frame.data as PiSessionStats) ?? null)
        else if (frame.command === 'clear_queue') {
          const data = frame.data as { steering: string[]; followUp: string[] }
          setInput(previous => [previous, ...data.steering, ...data.followUp].filter(Boolean).join('\n\n'))
        }
      } else if (type === 'chat_ready') {
        updateStatus('ready')
        if (firstPrompt.current) {
          const prompt = firstPrompt.current
          firstPrompt.current = undefined
          const requestId = crypto.randomUUID()
          submission.current = { id: requestId, text: prompt.text }
          setSending(true)
          send({ type: 'chat_prompt', requestId, ...prompt })
        }
        send({ type: 'chat_command', command: 'get_commands' })
        send({ type: 'chat_command', command: 'get_available_thinking_levels' })
        send({ type: 'chat_command', command: 'get_session_stats' })
        // 模型目录主动拉一次：触发按钮的思考等级标签取自目录里的 reasoning 元数据，
        // 等到点击才加载会让按钮在首次进入时只显示模型名
        send({ type: 'chat_models' })
        const state = frame.state as { model?: PiModel; thinkingLevel?: string; isStreaming?: boolean; pendingMessageCount?: number } | undefined
        if (state?.model?.id) setCurrentModel({ id: state.model.id, name: state.model.name, provider: state.model.provider || '' })
        setThinking(state?.thinkingLevel || '')
        if (typeof state?.isStreaming === 'boolean') setStreaming(state.isStreaming)
        if (typeof state?.pendingMessageCount === 'number') setQueued(state.pendingMessageCount)
      } else if (type === 'chat_state') {
        const state = frame.state as { model?: PiModel; thinkingLevel?: string; isStreaming?: boolean; pendingMessageCount?: number } | undefined
        if (state?.model?.id) setCurrentModel({ id: state.model.id, name: state.model.name, provider: state.model.provider || '' })
        setThinking(state?.thinkingLevel || '')
        if (typeof state?.isStreaming === 'boolean') setStreaming(state.isStreaming)
        if (typeof state?.pendingMessageCount === 'number') setQueued(state.pendingMessageCount)
      } else if (type === 'chat_models') {
        setModels(Array.isArray(frame.models) ? (frame.models as PiModel[]) : [])
        setModelsLoading(false)
        setModelsError(frame.error ? String(frame.error) : null)
      } else if (type === 'chat_event') {
        applyEvent(frame.event as Parameters<typeof applyEvent>[0])
      } else if (type === 'chat_ui_request') {
        const method = String(frame.method || '')
        if (method === 'set_editor_text') { setInput(String(frame.text || '')); return }
        if (method === 'notify') { setError(String(frame.message || '')); return }
        if (!['confirm', 'select', 'input', 'editor'].includes(method)) return
        setUiRequests((previous) => [...previous.filter((item) => item.id !== frame.id), {
          id: String(frame.id), method, title: frame.title as string | undefined, message: frame.message as string | undefined,
          options: frame.options as UiRequest['options'], placeholder: frame.placeholder as string | undefined, prefill: frame.prefill as string | undefined,
        }])
      } else if (type === 'chat_exit') {
        setStreaming(false)
        setQueued(0)
        setUiRequests([])
        setMessages((previous) => [...previous, { role: 'notice', blocks: [], text: `pi 进程已退出（${(frame.exitCode as number | null) ?? '未知'}）` }])
        if (!errored) updateStatus('closed')
      } else if (type === 'chat_error') {
        const detail = String(frame.error || '')
        if (detail === '聊天进程未运行，请重新打开会话' || detail.startsWith('打开聊天会话失败')) {
          errored = true
          updateStatus('error')
          setError(detail)
        } else {
          setError(detail)
        }
      }
    }
    socket.onerror = () => {
      if (disposed) return
      errored = true
      updateStatus('error')
      setError('会话连接失败')
    }
    socket.onclose = () => {
      for (const settle of selectionRequests.current.values()) settle({ success: false, error: '连接已关闭' })
      selectionRequests.current.clear()
      if (disposed) return
      if (!errored) updateStatus('closed')
      setStreaming(false)
      setSending(false)
      if (submission.current) { setInput(submission.current.text); submission.current = null; setError('连接中断，发送结果未知，请检查历史后重试') }
    }

    return () => {
      disposed = true
      socketRef.current = null
      socket.close()
      for (const settle of selectionRequests.current.values()) settle({ success: false, error: '会话已关闭' })
      selectionRequests.current.clear()
    }
  }, [taskId, sessionId, nonce, updateStatus])

  useLayoutEffect(() => {
    const box = scrollRef.current
    if (box) box.scrollTop = nearBottomRef.current ? box.scrollHeight : savedScrollTop.current
  }, [props.trajectory, snapshotLoaded])

  // 贴底自动滚动 + 回到底部按钮可见性
  useLayoutEffect(() => {
    const box = scrollRef.current
    if (!box) return
    if (nearBottomRef.current) box.scrollTop = box.scrollHeight
    setShowJump(!nearBottomRef.current && box.scrollHeight - box.clientHeight > 300)
  }, [messages, tools, streaming, uiRequests])

  useLayoutEffect(() => {
    const box = scrollRef.current
    if (!box) return
    const root = box.parentElement!
    const publish = () => {
      // 导航条/回到底部等浮动件依赖这两个原生测量变量。注意 viewport 是原生
      // 语义 = 含输入区在内的整个滚动视口（原生输入卡粘在滚动口内），这里的
      // 等价物是 chatWrap 整体高度；输入区高度单独由 composer 变量扣减。
      root.style.setProperty('--dsh-conversation-viewport-height', `${root.clientHeight}px`)
      const seat = root.querySelector<HTMLElement>('[data-composer-seat]')
      if (seat) root.style.setProperty('--dsh-composer-height', `${seat.offsetHeight}px`)

    }
    const observer = new ResizeObserver(() => {
      publish()
      if (nearBottomRef.current) box.scrollTop = box.scrollHeight
    })
    observer.observe(root)
    if (box.firstElementChild) observer.observe(box.firstElementChild)
    const seat = root.querySelector('[data-composer-seat]')
    if (seat) observer.observe(seat)
    publish()
    return () => observer.disconnect()
  }, [hero, props.trajectory, snapshotLoaded])

  // 右侧回合导航条：按视口 35% 基线判定当前回合（下标换算回全量序）
  const updateActiveTurn = () => {
    const box = scrollRef.current
    if (!box) return
    const nodes = box.querySelectorAll<HTMLElement>('[data-turn-index]')
    if (!nodes.length) { if (activeTurn !== null) setActiveTurn(null); return }
    const line = box.getBoundingClientRect().top + box.clientHeight * 0.35
    let local = 0
    nodes.forEach((node, index) => { if (node.getBoundingClientRect().top <= line) local = index })
    const id = firstVisible + local
    if (id !== activeTurn) setActiveTurn(id)
  }

  const jumpToTurn = (index: number, behavior: ScrollBehavior = 'smooth') => {
    const box = scrollRef.current
    if (!box) return
    const node = box.querySelector<HTMLElement>(`[data-turn-index="${index}"]`)
    if (!node) return
    nearBottomRef.current = false
    setActiveTurn(index)
    const top = node.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 8
    box.scrollTo({ top, behavior })
  }

  const onScroll = () => {
    const box = scrollRef.current
    if (!box) return
    savedScrollTop.current = box.scrollTop
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight <= 24
    nearBottomRef.current = nearBottom
    savePiViewport(viewportKey, { top: box.scrollTop, nearBottom, visibleCount })
    setShowJump(!nearBottom && box.scrollHeight - box.clientHeight > 300)
    updateActiveTurn()
  }

  // 导航条点击：目标回合未渲染时先扩窗，渲染完成后再跳（对应原生的 page-in）
  const pendingJumpRef = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (pendingJumpRef.current === null) { updateActiveTurn(); return }
    const target = pendingJumpRef.current
    pendingJumpRef.current = null
    jumpToTurn(target, 'instant')
  }, [visibleCount, turns, props.trajectory, snapshotLoaded])
  const navigateTurn = useCallback((item: TurnRailItem) => {
    nearBottomRef.current = false
    const index = item.turn - 1
    if (index >= firstVisible) { jumpToTurn(index); return }
    setVisibleCount(visibleCount + (firstVisible - index) + 10)
    pendingJumpRef.current = index
  }, [firstVisible, visibleCount])

  const jumpToBottom = () => {
    const box = scrollRef.current
    if (!box) return
    nearBottomRef.current = true
    setShowJump(false)
    box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' })
  }

  const send = (mode: 'queue' | 'steer' = 'queue', images: Array<{ type: 'image'; data: string; mimeType: string }> = []) => {
    const text = input.trim()
    if ((!text && !images.length) || status !== 'ready' || sending || socketRef.current?.readyState !== WebSocket.OPEN) return
    const id = crypto.randomUUID()
    submission.current = { id, text: input }
    setSending(true)
    setInput('')
    setError('')
    nearBottomRef.current = true
    socketRef.current.send(JSON.stringify({ type: 'chat_prompt', requestId: id, text, mode, images }))
  }
  const command = (name: string) => socketRef.current?.send(JSON.stringify({ type: 'chat_command', command: name }))
  const statsGroups = useMemo(() => piSessionStatsGroups(stats, messages, tools), [stats, messages, tools])
  const railItems = useMemo<TurnRailItem[]>(() => turns.map((turn, index) => {
    const firstUser = turn.messages.find((message) => message.role === 'user')
    const prompt = firstUser ? firstUser.blocks.map((block) => block.kind === 'text' ? block.text : '').join(' ') : ''
    const lastAssistant = [...turn.messages].reverse().find((message) => message.role === 'assistant')
    const response = lastAssistant ? lastAssistant.blocks.map((block) => block.kind === 'text' ? block.text : '').join(' ') : ''
    return { turn: index + 1, prompt: prompt.slice(0, 160), response: response.slice(0, 160), anchor: index < firstVisible ? { kind: 'unloaded' as const, seq: index } : { kind: 'loaded' as const, key: turn.key } }
  }), [turns, firstVisible])

  const respondUi = (id: string, payload: Record<string, unknown>) => {
    setUiRequests((previous) => previous.filter((item) => item.id !== id))
    socketRef.current?.send(JSON.stringify({ type: 'chat_ui_response', id, ...payload }))
  }

  const onHandleStart = useCallback(() => {
    draggingRef.current = true
    return resolveContentWidth(rootRef.current?.offsetWidth ?? 680, readWidthPreference())
  }, [])
  const onHandleDrag = useCallback((width: number) => {
    const root = rootRef.current
    if (!root) return
    root.style.setProperty('--dsh-chat-user-width', `${resolveContentWidth(root.offsetWidth, width)}px`)
  }, [])
  const onHandleCommit = useCallback((width: number) => {
    const root = rootRef.current
    if (!root) return
    localStorage.setItem(WIDTH_PREF_KEY, `${resolveContentWidth(root.offsetWidth, width)}`)
  }, [])
  const onHandleEnd = useCallback(() => {
    draggingRef.current = false
    const root = rootRef.current
    if (!root) return
    const preference = readWidthPreference()
    if (preference === null) root.style.removeProperty('--dsh-chat-user-width')
    else root.style.setProperty('--dsh-chat-user-width', `${resolveContentWidth(root.offsetWidth, preference)}px`)
  }, [])

  const pasteNote = useCallback((text: string) => setInput(value => value ? `${value}\n${text}` : text), [])
  const dock = (
    <>
      <StatsLineContent groups={statsGroups} line={statsGroups.join(' | ')} />
      <PinnedNotesBar current={{ taskId, sessionId }} onPaste={pasteNote} className={css.notesDock} />
    </>
  )
  const composer = (
    <PiComposer initialImages={props.initialPrompt?.images} accepted={accepted} input={input} onInput={setInput} onSend={send} disabled={status !== 'ready' || sending}
      running={streaming} onStop={() => socketRef.current?.send(JSON.stringify({ type: 'chat_abort' }))} hero={hero} dock={dock}
      context={stats?.contextUsage?.percent != null ? { percent: stats.contextUsage.percent, tokens: stats.contextUsage.tokens, contextWindow: stats.contextUsage.contextWindow } : null}
      model={<PiModelSelect current={currentModel} models={models} error={modelsError} loading={modelsLoading} levels={thinkingLevels} thinking={thinking} disabled={status !== 'ready'}
        load={() => { setModelsLoading(true); socketRef.current?.send(JSON.stringify({ type: 'chat_models' })) }}
        select={selection => new Promise(resolve => {
          const requestId = crypto.randomUUID()
          selectionRequests.current.set(requestId, resolve)
          socketRef.current?.send(JSON.stringify({ type: 'chat_select_model', requestId, selection }))
        })} />} commands={commands}
      onCommand={(name) => { if (name === 'get_session_stats') setStatsOpen(true); command(name) }} />
  )

  const errorBlock = error ? (
    <div className={css.chatErrorRow}>
      <span>{error}</span>
      {status !== 'ready'
        ? <button type="button" className={`${css.btn} ${css.small}`} onClick={() => { updateStatus('connecting'); setError(''); setNonce((value) => value + 1) }}>重新连接</button>
        : null}
    </div>
  ) : null

  return (
    <div ref={rootRef} data-pi-phase={hero ? 'hero' : 'active'} className={`${nativeRoot.root} ${css.chatWrap}`}>
      {!snapshotLoaded ? <><div className={css.chatLoading} role="status">{chatT('chat.loadingHistory')}{errorBlock}</div>{composer}</> : props.trajectory ? <><PiTrajectory messages={messages} tools={tools} entries={trajectoryEntries} />{errorBlock}{composer}</> : hero ? (
        <div className={css.chatHero}>
          <div className={`${nativeRoot.composerStack} ${nativeRoot.composerHero}`}>
            <div className={heroCss.root}><div className={heroCss.stack}><div className={heroCss.headline}><span className={heroCss.fishHitbox}><PiPixelMark size={34} /></span><span className={heroCss.headlineText}>{chatT('hero.headline')}</span><span className={heroCss.previewBadge}>{chatT('hero.preview')}</span></div></div></div>
            <div className={nativeRoot.heroWorkspaceRow} data-pi-task-picker="">
              <span className={`${css.heroTaskChip} ${css.heroTaskChipReadonly}`} aria-label={props.taskTitle || chatT('hero.selectTask')}>
                <span className={css.heroTaskIcon}>{ICONS.tasks}</span>
                <span className={css.heroTaskLabel}>{props.taskTitle || chatT('hero.selectTask')}</span>
              </span>
            </div>
            {composer}
          </div>
          {errorBlock}
        </div>
      ) : (
        <>
          <div ref={scrollRef} className={nativeChat.scroll} onScroll={onScroll}>
            <div className={nativeChat.column}>
              {turns.length > visibleCount && <button type="button" onClick={() => {
                const box = scrollRef.current
                const height = box?.scrollHeight || 0
                setVisibleCount(value => value + 80)
                requestAnimationFrame(() => { if (box) box.scrollTop += box.scrollHeight - height })
              }}>加载更早</button>}
              {turns.slice(-visibleCount).map((turn, index) => (
                <div key={turn.key} data-turn-index={firstVisible + index}>
                  <TurnView messages={turn.messages} tools={tools} onBranch={props.onBranch}
                    compact={compact} running={streaming && index === Math.min(turns.length, visibleCount) - 1} />
                </div>
              ))}
              {streaming ? (
                <div className={nativeChat.turnStatus}>
                  深度求索中...
                  {elapsed >= 15 ? <span className={css.chatStatusClock}>{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</span> : null}
                </div>
              ) : null}
            </div>
            {showJump ? (
              <div className={nativeChat.toBottomSlot}>
                <button type="button" className={nativeChat.toBottom} title="回到底部" onClick={jumpToBottom}>
                  <IconChevronDownOutlineRegular size={16} />
                </button>
              </div>
            ) : null}
          </div>
          {/* 右侧回合导航条：移植原生 TurnNavigator（宿主定位见 turnRailSlot） */}
          <div className={css.turnRailSlot}>
            <TurnNavigator items={railItems} activeTurn={activeTurn === null ? null : activeTurn + 1} busyTurn={null} onNavigate={navigateTurn} t={chatT} />
          </div>
          {errorBlock}
          {dialog ? (
        <div key={dialog.id} className={css.chatDialog} role="region" aria-label={dialog.title || 'pi 请求输入'}>
          <div className={css.chatDialogTitle}>{dialog.title || (dialog.method === 'confirm' ? 'pi 请求确认' : 'pi 请求输入')}</div>
          {dialog.message ? <div className={css.chatDialogMessage}>{dialog.message}</div> : null}
          {dialog.method === 'select' && dialog.options?.length ? (
            <div className={css.chatDialogOptions}>
              {dialog.options.map((option, index) => (
                <button key={index} type="button" className={`${css.btn} ${css.small}`} onClick={() => respondUi(dialog.id, { value: typeof option === 'string' ? option : option.value ?? index })}>{typeof option === 'string' ? option : option.label ?? String(option.value ?? index)}</button>
              ))}
            </div>
          ) : null}
          {dialog.method === 'input' || dialog.method === 'editor' ? (
            <form
              className={css.chatDialogOptions}
              onSubmit={(event) => {
                event.preventDefault()
                const value = (event.currentTarget.elements.namedItem('ui-input') as HTMLInputElement | null)?.value ?? ''
                respondUi(dialog.id, { value })
              }}
            >
              <textarea name="ui-input" className={css.input} defaultValue={dialog.prefill || ''} placeholder={dialog.placeholder || ''} />
              <button type="submit" className={`${css.btn} ${css.small}`}>确定</button>
            </form>
          ) : null}
          {dialog.method !== 'confirm' && <button type="button" className={css.btn} onClick={() => respondUi(dialog.id, { cancelled: true })}>取消</button>}
          {dialog.method === 'confirm' ? (
            <div className={css.chatDialogOptions}>
              <button type="button" className={`${css.btn} ${css.small}`} onClick={() => respondUi(dialog.id, { confirmed: true })}>同意</button>
              <button type="button" className={`${css.btn} ${css.small}`} onClick={() => respondUi(dialog.id, { cancelled: true })}>取消</button>
            </div>
          ) : null}
        </div>
      ) : null}
      {queued > 0 && <div className={nativeQueue.dock}><div className={nativeQueue.panel}>
        <button type="button" className={nativeQueue.header} onClick={() => command('clear_queue')}>{queued} 条排队中 · 撤回到输入框</button>
      </div></div>}
          {!dialog && composer}
        </>
      )}
      {statsOpen && stats !== null && <div className={css.chatDialog}><button type="button" className={css.btn} onClick={() => setStatsOpen(false)}>关闭用量</button><JsonBlock label="会话用量" payload={stats} truncatedLabel={() => '…'} /></div>}

      {!hero && !props.trajectory && (['left', 'right'] as const).map((side) => (
        <WidthHandle key={side} side={side} onStart={onHandleStart} onDrag={onHandleDrag} onCommit={onHandleCommit} onEnd={onHandleEnd} />
      ))}

    </div>
  )
}

/** Closed turns fold only before a final answer; running and failed turns preserve evidence. */
function TurnView({ messages, tools, running, compact, onBranch }: { messages: ChatMessage[]; tools: Map<string, ToolOutput>; running: boolean; compact: boolean; onBranch?: (entryId: string) => void }) {
  const [open, setOpen] = useState(false)
  const processRef = useRef<HTMLDivElement>(null)
  const last = messages[messages.length - 1]
  const final = last?.role === 'assistant' && !last.blocks.some(block => block.kind === 'toolCall')
    && last.blocks.some(block => block.kind === 'text' && block.text.trim() || block.kind === 'image')
    && last.stopReason !== 'error' && last.stopReason !== 'aborted' ? last : null
  const process = messages.filter(message => message.role === 'assistant' && message !== final)
  const finalThinking = final?.blocks.filter(block => block.kind === 'thinking') || []
  const foldable = compact && !running && final !== null && (process.length > 0 || finalThinking.length > 0)
  useEffect(() => {
    if (foldable && processRef.current?.contains(document.activeElement)) setOpen(true)
  }, [foldable])
  const effectiveOpen = open
  const toolCount = messages.flatMap(message => message.blocks).filter(block => block.kind === 'toolCall').length
  const replyCount = process.filter(message => message.blocks.some(block => block.kind === 'text' && block.text.trim())).length
  const label = [toolCount ? `${toolCount} 个工具调用` : '', replyCount ? `${replyCount} 条消息` : ''].filter(Boolean).join(' · ') || '已思考'
  const usage = piTurnUsage(messages)
  const timing = piTurnTiming(messages)
  const usageAction = <>
    {usage && <TurnUsagePanel usage={usage} t={chatT} />}
    {timing && <TurnTimePanel {...timing} t={chatT} />}
  </>
  return <div className={css.chatTurn}>
    {messages.filter(message => message.role !== 'assistant').map((message, index) => message.role === 'notice'
      ? <div key={index} className={css.chatNotice}>{message.text}</div>
      : <div key={index} className={nativeMessage.userRow} data-actions-reveal="hover"><div className={nativeMessage.userStack}>
        {message.blocks.some(block => block.kind === 'text') && <div className={nativeMessage.bubble}>{message.blocks.map(block => block.kind === 'text' ? block.text : '').join('')}</div>}
        {message.blocks.map((block, i) => block.kind === 'image' ? <img key={i} className={css.chatImage} src={`data:${block.mimeType};base64,${block.data}`} alt="图片" /> : null)}
      </div><MessageIconActions text={message.blocks.map(block => block.kind === 'text' ? block.text : '').join('')} clock="start" time={message.time ?? undefined} t={chatT} /></div>)}
    {foldable && <button type="button" className={nativeProcess.root} data-open={effectiveOpen || undefined} aria-expanded={effectiveOpen} onClick={event => { event.currentTarget.focus(); setOpen(value => !value) }}>
      <span className={nativeProcess.label}>{label}</span><IconChevronDownOutlineRegular className={nativeProcess.chevron} />
    </button>}
    <div ref={processRef} hidden={foldable && !effectiveOpen} className={css.chatTurnProcess}>
      {process.map((message, index) => <AssistantMessageView key={index} message={message} tools={tools} streaming={Boolean(message.streaming)} />)}
      {finalThinking.map((block, index) => block.kind === 'thinking' ? <ThinkRow key={index} text={block.text} /> : null)}
    </div>
    {final && <AssistantMessageView message={{ ...final, blocks: final.blocks.filter(block => block.kind !== 'thinking') }} tools={tools} streaming={Boolean(final.streaming) && running} />}
    {!running && final && <MessageIconActions clock="end" time={final.time ?? undefined} text={final.blocks.map(block => block.kind === 'text' ? block.text : '').join('\n\n')} t={chatT}
      onBranch={onBranch && final.entryId ? () => onBranch(final.entryId as string) : undefined}
      branchUnavailable={!final.entryId}
      usageAction={usageAction} />}
  </div>
}
