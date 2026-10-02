/** Shared DSH width preference for pi drafts and active conversations. */
export const WIDTH_PREF_KEY = 'dsh.conversation.contentWidth'
const CONTENT_MIN = 640
const CONTENT_EDGE_BUDGET = 176

export function readWidthPreference(): number | null {
  const raw = localStorage.getItem(WIDTH_PREF_KEY)
  if (raw === null) return null
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : null
}

export function resolveContentWidth(columnWidth: number, preference: number | null): number {
  const max = Math.max(CONTENT_MIN, columnWidth - CONTENT_EDGE_BUDGET)
  if (preference !== null) return Math.min(Math.max(preference, CONTENT_MIN), max)
  return Math.max(680, Math.min(columnWidth * 0.64, 920))
}

/** Publish width before paint and keep it in sync with the conversation column. */
export function observePiWidth(root: HTMLElement, dragging: () => boolean = () => false): () => void {
  const publish = () => {
    root.style.setProperty('--dsh-conversation-column-width', `${root.clientWidth}px`)
    if (dragging()) return
    const preference = readWidthPreference()
    if (preference === null) root.style.removeProperty('--dsh-chat-user-width')
    else root.style.setProperty('--dsh-chat-user-width', `${resolveContentWidth(root.clientWidth, preference)}px`)
  }
  publish()
  const observer = new ResizeObserver(publish)
  observer.observe(root)
  return () => observer.disconnect()
}
