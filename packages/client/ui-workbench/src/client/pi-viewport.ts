/** Per-session transcript positions survive view unmounts within this page. */
export interface PiViewport { top: number; nearBottom: boolean; visibleCount: number }
const positions = new Map<string, PiViewport>()
/** Read a detached copy so rendering cannot mutate another session's saved position. */
export function readPiViewport(key: string): PiViewport {
  return { ...(positions.get(key) ?? { top: 0, nearBottom: true, visibleCount: 80 }) }
}
/** Retain recent session positions without keeping transcript contents. */
export function savePiViewport(key: string, value: PiViewport): void {
  positions.delete(key)
  positions.set(key, { ...value })
  if (positions.size > 100) positions.delete(positions.keys().next().value!)
}
