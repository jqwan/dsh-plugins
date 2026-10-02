/** Native DSH trajectory components with pi-only data adaptation. */
import { useMemo, useState } from 'react'
import type { ChatMessage, ToolOutput } from './pi-chat.tsx'
import type { PiTrajectoryEntry } from './pi-trajectory-data.ts'
import { piTrajectoryLayout } from './pi-trajectory-layout.ts'
import { TrajectoryTable } from './dsh-trajectory/TrajectoryTable.tsx'
import { TrajectoryTimeline } from './dsh-trajectory/TrajectoryTimeline.tsx'
import { TrajectoryToolbar } from './dsh-trajectory/TrajectoryToolbar.tsx'
import { trajectoryTimelineFocusIndexes, type TrajectoryTimeRange } from './dsh-trajectory/timeline.ts'
import { trajectoryRecordId } from './dsh-trajectory/trajectory-record.ts'
import { zh as common } from './dsh-trajectory/common-locales.ts'
import { zh, type TrajectoryTranslate } from './dsh-trajectory/locales.ts'
import css from './dsh-trajectory/views.module.css'
const dictionary = { ...common, ...zh }
const t: TrajectoryTranslate = (key, params = {}) => dictionary[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''))
const noHostImages = () => null
/** Timeline, grouped ledger, inspector, search and folding share native rendering. */
export function PiTrajectory({ messages, tools, entries }: { messages: ChatMessage[]; tools: Map<string, ToolOutput>; entries: PiTrajectoryEntry[] }) {
  const turns = useMemo(() => piTrajectoryLayout(messages, tools, entries, t), [messages, tools, entries])
  const [actualDuration, setActualDuration] = useState(false)
  const [query, setQuery] = useState('')
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<number>>(new Set())
  const [collapsedAssistants, setCollapsedAssistants] = useState<ReadonlySet<string>>(new Set())
  const [range, setRange] = useState<TrajectoryTimeRange | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [selection, setSelection] = useState<{ index: number } | null>(null)
  const [focus, setFocus] = useState<{ index: number } | null>(null)
  const cells = turns.flatMap(turn => turn.groups.flatMap(group => group.cells))
  const turnIds = turns.flatMap(turn => turn.turn === null ? [] : [turn.turn])
  const assistantIds = cells.filter(cell => cell.kind === 'message').map(trajectoryRecordId)
  const search = query.trim().toLocaleLowerCase()
  const matches = search ? new Set(cells.filter(cell => [cell.text, cell.previewMarkdown, cell.inputDetail, cell.outputDetail, cell.thinkingDetail].some(value => value?.toLocaleLowerCase().includes(search))).map(cell => cell.index)) : null
  const allTurns = turnIds.length > 0 && turnIds.every(id => collapsedTurns.has(id))
  const allAssistants = assistantIds.length > 0 && assistantIds.every(id => collapsedAssistants.has(id))
  const toggleTurn = (id: number) => setCollapsedTurns(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const toggleAssistant = (id: string) => setCollapsedAssistants(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next })
  return <div className={css.root} style={{ flex: 1, height: 'auto' }}>
    <TrajectoryToolbar t={t} timingAvailable={cells.some(cell => cell.timeSeconds !== null)} actualDuration={actualDuration} actualTime={false} onActualDurationChange={setActualDuration} onActualTimeChange={() => {}}
      allTurnsCollapsed={allTurns} onToggleAllTurns={() => setCollapsedTurns(new Set(allTurns ? [] : turnIds))}
      allAssistantsCollapsed={allAssistants} onToggleAllAssistants={() => setCollapsedAssistants(new Set(allAssistants ? [] : assistantIds))} searchQuery={query} onSearchQueryChange={setQuery} />
    <TrajectoryTimeline t={t} turns={turns} mode={actualDuration ? 'duration' : 'sequence'} range={range} onRangeChange={setRange} selectedIndex={selected} searchMatchIndexes={matches}
      onRecordSelect={index => { setSelection({ index }); setSelected(index) }} onRecordFocus={index => setFocus({ index })} />
    <div className={css.ledger} style={{ '--dsh-trajectory-bottom-clearance': '16px' } as React.CSSProperties}>
      <TrajectoryTable t={t} renderImages={noHostImages} turns={turns} collapsedTurns={collapsedTurns} collapsedAssistants={collapsedAssistants}
        onToggleTurn={toggleTurn} onToggleAssistant={toggleAssistant} searchMatchIndexes={matches} timelineFocusIndexes={range ? trajectoryTimelineFocusIndexes(turns, range, actualDuration ? 'duration' : 'sequence') : null}
        recordSelection={selection} recordFocus={focus} onSelectedIndexChange={setSelected} onRecordSelect={index => { setSelected(index); setRange(null) }} onClearSelection={() => setRange(null)} />
    </div>
  </div>
}
