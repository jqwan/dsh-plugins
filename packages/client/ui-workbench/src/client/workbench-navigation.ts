/** Ordered sections of the unified workbench; view ids retain navigation history. */
import { BOARD_VIEW_IDS, type WorkbenchView } from './store.ts'
export const WORKBENCH_TABS = [
  { id: 'tasks', label: '任务' }, { id: 'notes', label: '便签' }, { id: 'sessions', label: '会话' },
  { id: 'archive', label: '回收站' }, { id: 'stats', label: '统计' },
] as const
export function isWorkbenchView(view: WorkbenchView): boolean { return (BOARD_VIEW_IDS as readonly string[]).includes(view) }
