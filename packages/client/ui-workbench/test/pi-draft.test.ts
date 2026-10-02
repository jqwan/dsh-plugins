import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWorkbenchStore } from '../src/client/store.ts'

test('reopening the pi hero and choosing tasks stays a draft without a session identity', () => {
  const store = createWorkbenchStore().create()
  store.actions.openPiDraft(null)
  store.actions.openPiDraft(null)
  store.actions.setPiDraftTask('task-a')
  store.actions.setPiDraftTask('task-b')
  assert.equal(store.getSnapshot().view, 'pi-draft')
  assert.equal(store.getSnapshot().piDraftTaskId, 'task-b')
  assert.equal(store.getSnapshot().piSessionId, null)
  assert.equal(store.getSnapshot().histPast.length, 1)
})

test('a draft preserves the prior session for back navigation', () => {
  const store = createWorkbenchStore().create()
  store.actions.selectPi('task', 'existing')
  store.actions.openPiDraft('task')
  store.actions.goBack()
  assert.equal(store.getSnapshot().view, 'terminal')
  assert.equal(store.getSnapshot().piSessionId, 'existing')
})

test('pi task selection remains independent of native draft association', () => {
  const store = createWorkbenchStore().create()
  store.actions.setHeroTask('native-task')
  store.actions.openPiDraft('pi-task')
  store.actions.setHeroTask(null)
  assert.equal(store.getSnapshot().piDraftTaskId, 'pi-task')
})
