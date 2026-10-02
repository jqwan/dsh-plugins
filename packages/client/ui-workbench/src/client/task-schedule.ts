/** 定时设置的表单态 → 服务端计划对象；不完整的启用设置直接抛错。 */
import type { TaskSchedule } from './api.ts'

/** 定时设置表单字段（便签定时发送弹窗使用）。 */
export interface ScheduleFormState {
  scheduleEnabled: boolean
  scheduleMode: 'daily' | 'weekly' | 'monthly' | 'custom'
  scheduleTime: string
  scheduleWeekday: number
  scheduleDayOfMonth: number
  scheduleAt: string
}

export function buildSchedule(form: ScheduleFormState): TaskSchedule | null {
  if (!form.scheduleEnabled) return null
  if (form.scheduleMode === 'custom') {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(form.scheduleAt)) throw new Error('请选择单次执行日期和时间')
    return { enabled: true, mode: 'custom', time: '', at: form.scheduleAt }
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(form.scheduleTime)) throw new Error('请选择有效的执行时间')
  if (form.scheduleMode === 'weekly' && (!Number.isInteger(form.scheduleWeekday) || form.scheduleWeekday < 0 || form.scheduleWeekday > 6)) throw new Error('请选择每周执行日')
  if (form.scheduleMode === 'monthly' && (!Number.isInteger(form.scheduleDayOfMonth) || form.scheduleDayOfMonth < 1 || form.scheduleDayOfMonth > 31)) throw new Error('每月执行日应为 1 至 31')
  return { enabled: true, mode: form.scheduleMode, time: form.scheduleTime,
    ...(form.scheduleMode === 'weekly' ? { weekday: form.scheduleWeekday } : {}),
    ...(form.scheduleMode === 'monthly' ? { dayOfMonth: form.scheduleDayOfMonth } : {}),
  }
}
