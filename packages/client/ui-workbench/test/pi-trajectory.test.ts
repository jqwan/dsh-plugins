import { test } from 'node:test'
import assert from 'node:assert/strict'
import { piTrajectoryLayout } from '../src/client/pi-trajectory-layout.ts'
import { zh, type TrajectoryTranslate } from '../src/client/dsh-trajectory/locales.ts'
import { zh as common } from '../src/client/dsh-trajectory/common-locales.ts'
const dictionary = { ...common, ...zh }
const t: TrajectoryTranslate = (key, params = {}) => dictionary[key].replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''))

test('native layout keeps reasoning and usage on the assistant and joins each tool result to its call', () => {
  const turns = piTrajectoryLayout([
    { role: 'user', entryId: 'u', blocks: [{ kind: 'text', text: 'hello' }] },
    { role: 'assistant', entryId: 'a', blocks: [{ kind: 'thinking', text: 'reason' }, { kind: 'toolCall', id: 'call', name: 'read', args: { path: 'file' } }], usage: { input: 3, output: 2 } },
  ], new Map([['call', { status: 'error', text: 'missing' }]]), [], t)
  const cells = turns.flatMap(turn => turn.groups.flatMap(group => group.cells))
  assert.deepEqual(cells.map(cell => cell.kind), ['user', 'message', 'tool'])
  assert.equal(cells[1].thinkingDetail, 'reason')
  assert.equal(cells[1].input, 3)
  assert.equal(cells[2].outputDetail, 'missing')
  assert.equal(cells[2].isError, true)
  assert.ok(cells.every(cell => cell.timeSeconds === null))
  assert.match(cells[2].inputDetail!, /file/)
  assert.equal(turns[0].turn, 1)
})

test('metadata retains its position between messages and does not create a request', () => {
  const turns = piTrajectoryLayout([
    { role: 'user', entryId: 'u', blocks: [{ kind: 'text', text: 'one' }] },
    { role: 'assistant', entryId: 'a', blocks: [{ kind: 'text', text: 'two' }] },
  ], new Map(), [{ id: 'c', type: 'compaction', afterEntryId: 'u', summary: 'summary' }], t)
  assert.deepEqual(turns.map(turn => turn.turn), [1, null, 1])
  assert.equal(turns[1].groups[0].cells[0].kind, 'compacted')
  assert.deepEqual(piTrajectoryLayout([], new Map(), [], t), [])
})

test('inline images remain available to the native inspector and running tools have no final result', () => {
  const turns = piTrajectoryLayout([{ role: 'assistant', blocks: [{ kind: 'image', data: 'YWJj', mimeType: 'image/png' }, { kind: 'toolCall', id: 'call', name: 'read', args: {} }] }], new Map([['call', { status: 'running', text: 'partial' }]]), [], t)
  const cells = turns[0].groups[0].cells
  assert.equal(cells[0].sourceBlocks?.[0].inlineImageUrl, 'data:image/png;base64,YWJj')
  assert.equal(cells[1].outputDetail, undefined)
})
