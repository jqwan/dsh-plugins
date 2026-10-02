import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTasks, normalizeNotes, normalizeSchedule } from '../src/store/store.js';

test('normalizeTasks backfills legacy sessions and converts unknown statuses to unfinished', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const legacy = {
    id: 'legacy',
    status: 'review',
    sessionFile: '/tmp/legacy.jsonl',
    createdAt: '2025-12-01T00:00:00.000Z',
    updatedAt: '2025-12-01T00:00:00.000Z',
  };
  const result = normalizeTasks([legacy], now);
  assert.equal(result.changed, true);
  assert.equal(result.tasks[0].status, 'unfinished');
  assert.match(result.tasks[0].sessions[0].id, /^[0-9a-f-]{36}$/);
  assert.equal(result.tasks[0].sessions[0].title, '新会话');
  assert.equal(result.tasks[0].archivedAt, undefined);
  assert.equal(result.tasks[0].purgeAt, undefined);
});

test('normalizeTasks does not change valid current tasks', () => {
  const task = { id: 'current', status: 'unfinished', sessions: [], archivedFromStatus: null, runKind: 'dsh', model: null, modelProvider: null, thinkingLevel: null, readOnly: false, noteIds: [] };
  const result = normalizeTasks([task], new Date('2026-01-01T00:00:00.000Z'));
  assert.equal(result.changed, false);
  assert.strictEqual(result.tasks[0], task);
});

test('normalizeTasks strips legacy task schedules and backfills runKind/model fields', () => {
  const task = { id: 'legacy-fields', status: 'unfinished', sessions: [], schedule: { enabled: true, mode: 'daily', time: '09:00' } };
  const result = normalizeTasks([task], new Date('2026-01-01T00:00:00.000Z'));
  assert.equal(result.changed, true);
  assert.equal(Object.hasOwn(result.tasks[0], 'schedule'), false);
  assert.equal(result.tasks[0].runKind, 'dsh');
  assert.equal(result.tasks[0].model, null);
  assert.equal(result.tasks[0].modelProvider, null);
  assert.equal(result.tasks[0].thinkingLevel, null);
  assert.equal(result.tasks[0].readOnly, false);
});

test('normalizeTasks migrates legacy unfinished statuses', () => {
  const tasks = [{ id: 'todo', status: 'todo', sessions: [] }, { id: 'running', status: 'running', sessions: [] }];
  const result = normalizeTasks(tasks);
  assert.equal(result.changed, true);
  assert.deepEqual(result.tasks.map((task) => task.status), ['unfinished', 'unfinished']);
});

test('normalizeTasks adds session card lifecycle fields without changing the JSONL binding', () => {
  const sessionFile = '/tmp/session.jsonl';
  const task = { id: 'session-card', status: 'unfinished', sessions: [{ id: 'child', title: '旧会话', sessionFile }] };
  const result = normalizeTasks([task], new Date('2026-01-01T00:00:00.000Z'));
  const [session] = result.tasks[0].sessions;
  assert.equal(result.changed, true);
  assert.equal(session.sessionFile, sessionFile);
  assert.equal(session.status, 'active');
  assert.equal(session.favorite, false);
  assert.equal(session.restorableWithTask, false);
  assert.equal(session.archivedAt, null);
});

test('normalizeTasks normalizes task-level note configuration', () => {
  const result = normalizeTasks([{ id: 'task', status: 'unfinished', noteIds: ['a', 'a', 2, ''] }]);
  assert.deepEqual(result.tasks[0].noteIds, ['a', '2']);
});

test('normalizeNotes keeps optional titles and removes notes without descriptions', () => {
  const result = normalizeNotes([
    {
      id: 'note', title: '', description: '  记录内容  ', color: 'yellow',

      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    },
    { id: 'empty', title: '只有标题', description: '' },
  ]);
  assert.equal(result.changed, true);
  assert.equal(result.notes.length, 1);
  assert.equal(result.notes[0].title, '');
  assert.equal(result.notes[0].description, '记录内容');
  assert.equal(Object.hasOwn(result.notes[0], 'pinnedToTopBar'), false);
});

test('normalizeNotes removes legacy automatic purge deadlines', () => {
  const archivedAt = '2026-01-01T00:00:00.000Z';
  const result = normalizeNotes([{ id: 'archived-note', description: '已废弃', status: 'archived', archivedAt, purgeAt: '2026-01-16T00:00:00.000Z' }]);
  assert.equal(result.notes[0].archivedAt, archivedAt);
  assert.equal(Object.hasOwn(result.notes[0], 'purgeAt'), false);
});

test('normalizeNotes keeps valid note send items and drops malformed ones', () => {
  const result = normalizeNotes([
    {
      id: 'note', description: '内容', color: 'yellow', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      sends: [
        { id: 's1', taskId: 'task-a', sessionId: 'sess-1', kind: 'pi', schedule: { enabled: true, mode: 'daily', time: '09:00' }, lastFiredAt: null },
        { taskId: 'task-b', schedule: { enabled: true, mode: 'custom', time: '', at: '2026-05-01T10:00' } },
        { id: 's3', taskId: '  ', schedule: { enabled: true, mode: 'daily', time: '08:00' } },
        { id: 's4', taskId: 'task-a', schedule: { enabled: false, mode: 'daily', time: '08:00' } },
      ],
    },
  ]);
  const sends = result.notes[0].sends;
  assert.equal(sends.length, 2);
  assert.equal(sends[0].id, 's1');
  assert.equal(sends[0].sessionId, 'sess-1');
  assert.match(sends[1].id, /^[0-9a-f-]{36}$/);
  assert.equal(sends[1].sessionId, null);
  assert.equal(sends[1].kind, 'dsh');
  assert.deepEqual(sends[1].schedule, { enabled: true, mode: 'custom', time: '', at: '2026-05-01T10:00' });
});

test('normalizeSchedule rejects out-of-range hours and minutes', () => {
  for (const time of ['24:00', '12:60', '99:99', '-1:30']) {
    assert.equal(normalizeSchedule({ enabled: true, mode: 'daily', time }), null);
  }
  for (const time of ['0:00', '09:30', '23:59']) {
    assert.equal(normalizeSchedule({ enabled: true, mode: 'daily', time }).time, time);
  }
});
