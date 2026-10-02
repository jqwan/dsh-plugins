import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRunFromSchedule } from '../src/schedule.js';

test('daily preview uses the imminent minute and rolls past times to tomorrow', () => {
  const from = new Date(2026, 8, 8, 8, 59, 45);
  assert.equal(nextRunFromSchedule({ enabled: true, mode: 'daily', time: '09:00' }, from), new Date(2026, 8, 8, 9).getTime());
  assert.equal(nextRunFromSchedule({ enabled: true, mode: 'daily', time: '08:00' }, from), new Date(2026, 8, 9, 8).getTime());
});

test('monthly day 31 skips a month without that day', () => {
  const next = new Date(nextRunFromSchedule({ enabled: true, mode: 'monthly', dayOfMonth: 31, time: '09:00' }, new Date(2026, 3, 1)));
  assert.equal(next.getMonth(), 4);
  assert.equal(next.getDate(), 31);
});

test('expired one-time and disabled schedules have no next occurrence', () => {
  const from = new Date(2026, 8, 8, 10);
  assert.equal(nextRunFromSchedule({ enabled: true, mode: 'custom', at: '2026-09-08T09:00' }, from), null);
  assert.equal(nextRunFromSchedule(null, from), null);
  assert.equal(nextRunFromSchedule({ enabled: true, mode: 'daily', time: '25:00' }, from), null);
});
