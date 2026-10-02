/** Shared host-local schedule calculation for execution and preview. */
function parseClockTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? { hour, minute } : null;
}

/** 计算任务的下一次触发时间戳；不可触发返回 null。custom 为单次：时间已过即不再触发。 */
export function nextRunFromSchedule(schedule, from = new Date()) {
  if (!schedule?.enabled) return null;
  if (schedule.mode === 'custom') {
    const at = new Date(schedule.at || '').getTime();
    return Number.isFinite(at) && at > from.getTime() ? at : null;
  }
  const time = parseClockTime(schedule.time);
  if (!time) return null;
  const base = new Date(from.getTime() + 60_000);
  base.setSeconds(0, 0);
  const at = (year, month, day) => new Date(year, month, day, time.hour, time.minute).getTime();
  if (schedule.mode === 'daily') {
    const today = at(base.getFullYear(), base.getMonth(), base.getDate());
    return today >= base.getTime() ? today : at(base.getFullYear(), base.getMonth(), base.getDate() + 1);
  }
  if (schedule.mode === 'weekly') {
    for (let offset = 0; offset < 8; offset++) {
      const candidate = at(base.getFullYear(), base.getMonth(), base.getDate() + offset);
      if (candidate >= base.getTime() && new Date(candidate).getDay() === schedule.weekday) return candidate;
    }
    return null;
  }
  if (schedule.mode === 'monthly') {
    for (let offset = 0; offset < 366; offset++) {
      const candidate = at(base.getFullYear(), base.getMonth(), base.getDate() + offset);
      if (candidate >= base.getTime() && new Date(candidate).getDate() === schedule.dayOfMonth) return candidate;
    }
    return null;
  }
  return null;
}

