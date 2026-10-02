import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSchedule, type ScheduleFormState } from '../src/client/task-schedule.ts'

const base: ScheduleFormState = {
  scheduleEnabled: false,
  scheduleMode: 'daily',
  scheduleTime: '09:00',
  scheduleWeekday: 1,
  scheduleDayOfMonth: 1,
  scheduleAt: '',
}

test('disabled scheduling tolerates unfilled dates; enabled scheduling requires valid inputs', () => {
  assert.equal(buildSchedule({ ...base, scheduleMode: 'custom' }), null)
  assert.throws(() => buildSchedule({ ...base, scheduleEnabled: true, scheduleMode: 'custom' }), /日期/)
  assert.throws(() => buildSchedule({ ...base, scheduleEnabled: true, scheduleTime: '24:00' }), /时间/)
  assert.throws(() => buildSchedule({ ...base, scheduleEnabled: true, scheduleMode: 'monthly', scheduleDayOfMonth: 32 }), /31/)
})

test('switching to daily drops inactive monthly and one-time fields', () => {
  assert.deepEqual(buildSchedule({ ...base, scheduleEnabled: true, scheduleAt: '2030-01-01T09:00', scheduleDayOfMonth: 31 }), { enabled: true, mode: 'daily', time: '09:00' })
})
