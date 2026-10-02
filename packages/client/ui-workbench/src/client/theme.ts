/**
 * dsh 主题读取与监听：宿主通过 documentElement 的 colorScheme 标记亮暗，
 * 与工作台 iframe 内的机制一致，读它即可对齐。
 */

export type Scheme = 'light' | 'dark'

/** 读取宿主当前解析后的亮暗模式。 */
export function currentScheme(): Scheme {
  const inline = document.documentElement.style.colorScheme
  if (inline === 'light' || inline === 'dark') return inline
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/**
 * 监听宿主亮暗模式变化。
 * @param onChange - 每次解析结果变化时回调（含初始注册后的首次变化）。
 * @returns 取消监听的 disposer。
 */
export function observeScheme(onChange: (scheme: Scheme) => void): () => void {
  let last = currentScheme()
  const notify = () => {
    const next = currentScheme()
    if (next === last) return
    last = next
    onChange(next)
  }
  const observer = new MutationObserver(notify)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const listener = () => notify()
  media.addEventListener('change', listener)
  return () => {
    observer.disconnect()
    media.removeEventListener('change', listener)
  }
}
