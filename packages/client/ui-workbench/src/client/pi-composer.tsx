/** Pi operation bindings on the DSH 0.1.3-alpha.1 composer chrome. */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { IconPaperclipOutlineRegular, IconPlusOutlineRegular, Tooltip, useAnchoredMaxHeight } from '@deepseek-ai/dsh-client-ui-primitives'
import meter from './dsh-chat/ContextMeter.module.css'
import { chatT } from './pi-locale.ts'
import css from './dsh-chat/InputBar.module.css'
import wb from './workbench.module.css'
interface ImageInput { type: 'image'; data: string; mimeType: string }
interface Props {
  draftOnly?: boolean
  initialImages?: ImageInput[]
  accepted: number; input: string; onInput: (value: string) => void
  onSend: (mode: 'queue' | 'steer', images: ImageInput[]) => void
  disabled: boolean; running: boolean; onStop: () => void
  model: ReactNode
  commands: Array<{ name: string; description?: string }>; onCommand: (command: string) => void
  /** 未选任务的英雄触发态：卡片整体虚线描边、不可编辑，点击交给 onCardTrigger。 */
  cardTrigger?: boolean
  onCardTrigger?: () => void
  /** 输入卡片下方的停靠区（统计行/便签区，对齐原生 conversation.composer.dock 落位）。 */
  dock?: ReactNode
  /** 英雄姿态（空会话首屏）：root 去底部内边距，卡片随 composerHero 居中。 */
  hero?: boolean
  /** 上下文占用（百分比），来自 get_session_stats 的 contextUsage；null 不显示。 */
  context?: { percent: number; tokens: number | null; contextWindow: number } | null
}
export function PiComposer(props: Props) {
  const editor = useRef<HTMLDivElement>(null)
  const files = useRef<HTMLInputElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const [images, setImages] = useState<ImageInput[]>(props.initialImages || [])
  useEffect(() => { if (props.accepted > 0) setImages([]) }, [props.accepted])
  const [error, setError] = useState('')
  const [contextOpen, setContextOpen] = useState(false)
  const meterRoot = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!contextOpen) return
    const close = (event: PointerEvent) => { if (event.target instanceof Node && !meterRoot.current?.contains(event.target)) setContextOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setContextOpen(false) }
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape) }
  }, [contextOpen])
  const [commandMenu, setCommandMenu] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const matches = props.commands.filter(command => command.name.startsWith(props.input.slice(1)))
  // “/”指令菜单：绝对定位在卡片上沿（对齐原生 slash MenuView），设计上限 320px 并按上方空间钳制
  const slashRef = useRef<HTMLDivElement>(null)
  const plusRef = useRef<HTMLButtonElement>(null)
  const slashMax = useAnchoredMaxHeight(slashRef, 320, commandMenu ? matches : null)
  useEffect(() => { setHighlight(0) }, [props.input])
  // 仅键盘移动高亮时才把行滚进视口；指针 hover 那行本就可见，scrollIntoView 的最小滚动
  // 会把底部半露行的下缘也对齐，正好把「指令」标题（32px）顶出视口
  const keyboardNav = useRef(false)
  useEffect(() => {
    if (!commandMenu) { keyboardNav.current = false; return }
    if (!keyboardNav.current) return
    keyboardNav.current = false
    document.getElementById(`pi-slash-option-${highlight}`)?.scrollIntoView({ block: 'nearest' })
  }, [commandMenu, highlight])
  // 焦点留在输入框（combobox 模式）：指针落在菜单或 + 按钮之外即关闭（含输入框内部）
  useEffect(() => {
    if (!commandMenu) return
    const close = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return
      if (slashRef.current?.contains(event.target) || plusRef.current?.contains(event.target)) return
      setCommandMenu(false)
    }
    document.addEventListener('pointerdown', close, true)
    return () => document.removeEventListener('pointerdown', close, true)
  }, [commandMenu])
  useLayoutEffect(() => {
    if (editor.current && editor.current.innerText !== props.input) editor.current.textContent = props.input
  }, [props.input])
  useEffect(() => { if (!props.disabled && !props.cardTrigger) editor.current?.focus({ preventScroll: true }) }, [props.disabled, props.cardTrigger])
  const intake = async (picked: File[]) => {
    try {
      if (images.length + picked.length > 8) throw new Error('每条消息最多 8 张图片')
      const next = await Promise.all(picked.map(async file => {
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) throw new Error('请选择 PNG、JPEG、WebP 或 GIF 图片')
        if (file.size > 10 * 1024 * 1024) throw new Error('单张图片不能超过 10 MB')
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result).split(',')[1])
          reader.onerror = () => reject(new Error('图片读取失败'))
          reader.readAsDataURL(file)
        })
        return { type: 'image' as const, mimeType: file.type, data }
      }))
      setImages(previous => [...previous, ...next]); setError('')
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
  }
  const submit = (mode: 'queue' | 'steer') => {
    if (props.disabled || !props.input.trim() && !images.length) return
    props.onSend(mode, images)
  }
  const empty = !props.input.trim() && !images.length
  const stop = props.running && empty
  return <div className={`${css.root}${props.hero ? ` ${css.hero}` : ''}`} data-composer-seat="">
    {error && <div className={css.notice} role="alert">{error}</div>}
      <div ref={card} className={`${css.card}${props.cardTrigger ? ` ${css.cardWorkspaceTrigger}` : ''}`} onClick={props.cardTrigger ? props.onCardTrigger : undefined} onDragOver={event => { event.preventDefault() }} onDrop={event => {
      event.preventDefault(); if (!props.disabled) void intake([...event.dataTransfer.files])
    }}>
      {images.length > 0 && <div className={css.accessory}>{images.map((image, index) => <button type="button" key={index} title="移除图片" className={wb.chatAttachment} onClick={() => setImages(values => values.filter((_, i) => i !== index))}><img src={`data:${image.mimeType};base64,${image.data}`} alt="附件" /> ×</button>)}</div>}
      <div className={css.scroll}><div className={css.grow}>
        <div ref={editor} role="textbox" aria-label="发送消息" aria-multiline="true" contentEditable={!props.disabled && !props.cardTrigger} suppressContentEditableWarning
          className={css.input} onInput={event => {
            const value = event.currentTarget.innerText
            props.onInput(value); setCommandMenu(value.startsWith('/') && !value.includes(' '))
          }} onPaste={event => {
            const picked = [...event.clipboardData.files]
            if (picked.length) { event.preventDefault(); void intake(picked) }
            else { event.preventDefault(); document.execCommand('insertText', false, event.clipboardData.getData('text/plain')) }
          }} onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return
            if (commandMenu && matches.length && ['ArrowDown', 'ArrowUp', 'Tab', 'Enter'].includes(event.key) && !event.shiftKey) {
              event.preventDefault()
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { keyboardNav.current = true; setHighlight(value => (value + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length) }
              else { props.onInput(`/${matches[Math.min(highlight, matches.length - 1)].name} `); setCommandMenu(false) }
              return
            }
            if (event.repeat && event.key === 'Enter') { event.preventDefault(); return }
            if (event.key === 'Escape') { setCommandMenu(false); return }
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(event.metaKey || event.ctrlKey ? 'steer' : 'queue') }
          }} />
        {!props.input && <div className={css.placeholder}>{props.cardTrigger ? '选择一个任务开始' : '发送消息'}</div>}
      </div></div>
      <div className={css.row}><div className={css.tools}>
        <input ref={files} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={event => { void intake([...(event.target.files || [])]); event.target.value = '' }} />
        <Tooltip label="命令" side="top"><button ref={plusRef} type="button" className={css.add} aria-label="命令" aria-expanded={commandMenu} disabled={props.disabled || props.draftOnly} onMouseDown={event => event.preventDefault()} onClick={() => { setCommandMenu(value => !value); editor.current?.focus() }}><IconPlusOutlineRegular size={14} /></button></Tooltip>
        <Tooltip label="添加图片" side="top"><button type="button" className={css.add} aria-label="添加图片" disabled={props.disabled || props.cardTrigger} onMouseDown={event => event.preventDefault()} onClick={() => files.current?.click()}><IconPaperclipOutlineRegular size={14} /></button></Tooltip>
      </div><div className={css.trailing}>
        {props.model}
        {/* 上下文占用圆环（对齐原生 ContextMeter：14px 圆环 + Tooltip） */}
        {props.context ? (
          <span ref={meterRoot} className={meter.root}><Tooltip label={`上下文已用 ${Math.round(props.context.percent)}%`} side="top" disabled={contextOpen}><button type="button" className={meter.trigger} aria-label={chatT('context.details')} aria-haspopup="dialog" aria-expanded={contextOpen} onClick={() => setContextOpen(value => !value)}>
            <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden >
              <circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--dsw-alias-border-l3, #d0d3d8)" strokeWidth="2" />
              <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                strokeDasharray={`${2 * Math.PI * 5.5 * Math.min(100, Math.max(0, props.context.percent)) / 100} ${2 * Math.PI * 5.5}`}
                transform="rotate(-90 7 7)" />
            </svg>
          </button></Tooltip>
          {contextOpen && <div className={meter.panel} role="dialog" aria-label={chatT('context.details')}><div className={meter.header}><span className={meter.headline}>{chatT('context.used')}</span><span className={meter.percent}>{Math.round(props.context.percent)}%</span><span className={meter.figures}>{props.context.tokens ?? '—'} / {props.context.contextWindow}</span></div><div className={meter.bar}><div className={meter.segment} style={{ width: `${Math.min(100, Math.max(0, props.context.percent))}%` }} /></div></div>}
          </span>
        ) : null}
        <Tooltip label={stop ? '停止' : props.running ? '排队发送 · ⌘/Ctrl+Enter 立即引导' : '发送'} side="top">
          <button type="button" className={css.primary} aria-label={stop ? '停止' : props.running ? '排队发送' : '发送'} disabled={props.disabled || !stop && empty} onMouseDown={event => event.preventDefault()} onClick={() => stop ? props.onStop() : submit('queue')}>
            {/* 与原生 InputBar 相同的 16px 内联图标（14 系图标放大到 20px 会发虚走形） */}
            {stop ? (
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                <rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                <path d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z" fill="currentColor" />
              </svg>
            )}
          </button>
        </Tooltip>
      </div></div>
      <div className={css.overlayAnchor}>{commandMenu && matches.length > 0 && (
        <div ref={slashRef} className={wb.slashMenu} style={{ maxHeight: slashMax }} role="listbox" aria-label="指令">
          <div className={wb.slashViewport}>
            <div className={wb.slashGroupTitle} role="presentation">指令</div>
            {matches.map((match, index) => (
              <button type="button" key={match.name} id={`pi-slash-option-${index}`} role="option" aria-selected={index === highlight}
                className={`${wb.slashItem}${index === highlight ? ` ${wb.slashItemActive}` : ''}`}
                onMouseDown={event => { event.preventDefault(); props.onInput(`/${match.name} `); setCommandMenu(false); editor.current?.focus() }}
                onMouseMove={index === highlight ? undefined : () => setHighlight(index)}>
                <span className={wb.slashItemName}>/{match.name}</span>
                {match.description && <span className={wb.slashItemDesc}>{match.description}</span>}
              </button>
            ))}
          </div>
        </div>
      )}</div>
    </div>
    {!props.hero && props.dock}
  </div>
}
