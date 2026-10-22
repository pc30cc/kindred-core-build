/**
 * What makes business hours unfit to save: an interval that is not HH:mm or
 * does not end after it starts (the server's businessHoursSchema refuses it,
 * and the resolver would never match it, so the day would silently be
 * closed), or a time zone this browser does not know. Shared by the hours
 * editor (the message under a day) and Widget → Availability (which keeps
 * such hours a draft until fixed).
 */
import type { BusinessHoursConfig } from '@/types/models';
import { isValidTimeZone } from '../../../../shared/callbackSlots';

type Interval = { from: string; to: string };

export type HoursProblem = 'invalidTime' | 'endAfterStart' | 'invalidTimezone';

/** The first problem of one day's intervals, or null. */
export function intervalsProblem(list: Interval[] | undefined): Exclude<HoursProblem, 'invalidTimezone'> | null {
  if (!list || list.length === 0) return null;
  for (const it of list) {
    const from = /^(\d{1,2}):(\d{2})$/.exec(it.from || '');
    const to = /^(\d{1,2}):(\d{2})$/.exec(it.to || '');
    if (!from || !to || Number(from[1]) > 23 || Number(to[1]) > 23 || Number(from[2]) > 59 || Number(to[2]) > 59) {
      return 'invalidTime';
    }
    if (!(Number(to[1]) * 60 + Number(to[2]) > Number(from[1]) * 60 + Number(from[2]))) return 'endAfterStart';
  }
  return null;
}

/** The first problem anywhere in the hours (its zone, a day, a dated override), or null: hours a save may send. */
export function hoursProblem(hours: BusinessHoursConfig): HoursProblem | null {
  if (hours.timezone && !isValidTimeZone(hours.timezone)) return 'invalidTimezone';
  for (const list of Object.values(hours.weekly || {})) {
    const problem = intervalsProblem(list);
    if (problem) return problem;
  }
  for (const ov of hours.overrides || []) {
    const problem = ov.closed ? null : intervalsProblem(ov.intervals);
    if (problem) return problem;
  }
  return null;
}
