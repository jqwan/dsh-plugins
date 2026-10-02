import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readPiViewport, savePiViewport } from '../src/client/pi-viewport.ts'

test('switching sessions preserves each reading position and initial visits follow the tail', () => {
  assert.deepEqual(readPiViewport('new'), { top: 0, nearBottom: true, visibleCount: 80 })
  savePiViewport('one', { top: 3535, nearBottom: false, visibleCount: 160 })
  savePiViewport('two', { top: 420, nearBottom: true, visibleCount: 80 })
  assert.deepEqual(readPiViewport('one'), { top: 3535, nearBottom: false, visibleCount: 160 })
  const copy = readPiViewport('one')
  copy.top = 0
  assert.equal(readPiViewport('one').top, 3535)
})
