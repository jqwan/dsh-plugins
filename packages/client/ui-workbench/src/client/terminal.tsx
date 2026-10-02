/**
 * pi 原生终端视图：xterm.js + 同源 /workbench/ws TUI 协议（tui_hello 拉起
 * PTY，tui_input/resize 上行，tui_data/reset/exit 下行）。交互细节自一期
 * app.js 移植：选区复制、粘贴走 pi 原生剪贴板键、断线手动重连。
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { api, isDarkScheme, terminalTheme } from './api.ts'
import { useWbTheme } from './ui.tsx'
import css from './workbench.module.css'

const MAX_QUEUED_WRITES = 80

interface TerminalProps {
  taskId: string
  sessionId: string
  /** 连接状态上报（工作台侧栏红点用）：error/closed 记错误，ready/connecting 清除。 */
  onStatus?: (status: 'connecting' | 'ready' | 'closed' | 'error') => void
  pasteRequest?: { id: number; text: string }
}

/**
 * 渲染一个 pi 会话的终端。切换会话或手动重连（nonce 变化）时整体重建，
 * 与一期“旧会话延迟帧不污染新终端”的守卫语义一致。
 */
export function PiTerminal(props: TerminalProps): ReactElement {
  const { taskId, sessionId, onStatus } = props
  const hostRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const pasteRef = useRef<(text: string) => void>(() => {})
  const [nonce, setNonce] = useState(0)
  const [status, setStatus] = useState<'connecting' | 'ready' | 'closed' | 'error'>('connecting')
  const [message, setMessage] = useState('')
  const theme = useWbTheme()

  const reportStatus = onStatus
  const updateStatus = (next: 'connecting' | 'ready' | 'closed' | 'error') => {
    setStatus(next)
    reportStatus?.(next)
  }

  useEffect(() => {
    const box = hostRef.current
    if (!box) return
    let disposed = false
    let errored = false
    let socket: WebSocket | null = null
    let resizeObserver: ResizeObserver | null = null
    let writeTimer: ReturnType<typeof requestAnimationFrame> | null = null
    const writeBuffer: string[] = []

    const queueWrite = (data: string) => {
      writeBuffer.push(data)
      if (writeBuffer.length > MAX_QUEUED_WRITES) writeBuffer.splice(0, writeBuffer.length - MAX_QUEUED_WRITES)
      if (writeTimer !== null) return
      writeTimer = requestAnimationFrame(() => {
        writeTimer = null
        const chunk = writeBuffer.join('')
        writeBuffer.length = 0
        terminalRef.current?.write(chunk)
      })
    }
    const flushSync = () => {
      if (writeTimer !== null) { cancelAnimationFrame(writeTimer); writeTimer = null }
      const chunk = writeBuffer.join('')
      writeBuffer.length = 0
      terminalRef.current?.write(chunk)
    }

    const dark = isDarkScheme()
    const terminal = new Terminal({
      cursorBlink: false,
      cursorStyle: 'bar',
      cursorWidth: 2,
      convertEol: true,
      scrollback: 10000,
      scrollOnUserInput: false,
      fontSize: 13,
      fontFamily: 'SFMono-Regular, Menlo, Consolas, "PingFang SC", monospace',
      theme: terminalTheme(),
    })
    terminalRef.current = terminal
    pasteRef.current = (text) => {
      terminal.paste(text)
      terminal.focus()
    }
    // Windows IME 依赖可见硬件光标（与 pi 约定一致），xterm 自行渲染不闪烁。
    const isMacLike = /mac/i.test(navigator.platform || navigator.userAgent)
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      const key = event.key.toLowerCase()
      if (!event.ctrlKey && !(event.metaKey && key === 'v')) return true
      if (key === 'c' && terminal.hasSelection()) {
        event.preventDefault()
        event.stopPropagation()
        void navigator.clipboard?.writeText(terminal.getSelection()).catch(() => {})
        terminal.clearSelection()
        return false
      }
      if (key === 'v') {
        event.preventDefault()
        event.stopPropagation()
        // 让 pi 自己读系统剪贴板：macOS/Linux Ctrl+V，Windows Alt+V。
        const pasteKey = isMacLike ? '\x16' : '\x1bv'
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'tui_input', data: pasteKey }))
        return false
      }
      return true
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(box)
    fitAddon.fit()
    terminal.focus()

    const sendSize = () => {
      try { fitAddon.fit() } catch { /* 布局切换中 */ }
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'tui_resize', cols: terminal.cols, rows: terminal.rows }))
      }
    }
    terminal.onData((data) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'tui_input', data }))
    })
    resizeObserver = new ResizeObserver(sendSize)
    resizeObserver.observe(box)

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    socket = new WebSocket(`${protocol}//${location.host}/workbench/ws`)
    socket.onopen = () => {
      if (disposed) { socket?.close(); return }
      socket?.send(JSON.stringify({ type: 'tui_hello', taskId, sessionId, cols: terminal.cols, rows: terminal.rows, theme: dark ? 'dark' : 'light' }))
      requestAnimationFrame(() => requestAnimationFrame(sendSize))
    }
    socket.onmessage = ({ data }) => {
      if (disposed) return
      let event: { type?: string; data?: string; exitCode?: number; error?: string }
      try { event = JSON.parse(String(data)) } catch { return }
      if (event.type === 'tui_ready') updateStatus('ready')
      else if (event.type === 'tui_reset') { flushSync(); terminal.reset(); sendSize() }
      else if (event.type === 'tui_data') queueWrite(event.data || '')
      else if (event.type === 'tui_exit') queueWrite(`\r\n\r\n[工作台] pi 已退出（${event.exitCode ?? '未知'}）。\r\n`)
      else if (event.type === 'tui_error') {
        if (event.error === '会话未运行') return
        errored = true
        updateStatus('error')
        setMessage(event.error || '终端错误')
      }
    }
    socket.onerror = () => {
      if (disposed) return
      errored = true
      updateStatus('error')
      setMessage('会话连接失败')
    }
    socket.onclose = () => {
      if (disposed || errored) return
      updateStatus('closed')
      setMessage('终端连接已断开')
    }

    return () => {
      disposed = true
      if (writeTimer !== null) cancelAnimationFrame(writeTimer)
      resizeObserver?.disconnect()
      socket?.close()
      terminal.dispose()
      if (terminalRef.current === terminal) terminalRef.current = null
      pasteRef.current = () => {}
    }
  }, [taskId, sessionId, nonce])

  useEffect(() => {
    if (props.pasteRequest) pasteRef.current(props.pasteRequest.text)
  }, [props.pasteRequest])

  // 亮暗/风格变化时同步 xterm 调色板；pi 进程内部配色在下次重开会话时生效。
  useEffect(() => {
    const terminal = terminalRef.current
    if (terminal) terminal.options.theme = terminalTheme()
  }, [theme.style, theme.scheme])

  return (
    <div className={css.terminalWrap}>
      <div ref={hostRef} className={css.terminalHost} />
      {status === 'connecting' || status === 'error' || status === 'closed' ? (
        <div className={css.terminalStatus}>
          <span className={css.terminalStatusSpacer} />
          {status === 'connecting' ? <span>连接中…</span> : null}
          {status === 'error' || status === 'closed' ? (
            <>
              <span>{message}</span>
              <button type="button" className={`${css.btn} ${css.small}`} onClick={() => { updateStatus('connecting'); setMessage(''); setNonce((value) => value + 1) }}>
                重新连接
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
