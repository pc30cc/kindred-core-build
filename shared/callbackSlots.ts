/**
 * Callback slots: the times a visitor may book a callback for, from the
 * workspace's callback hours (the 2026-10 call widget design, screen 17's
 * day chips and slot row; migration 277).
 *
 * The hours are `call_center_settings.business_hours`, in the chat widget's
 * business-hours shape (`BusinessHoursConfig`: `enabled`, `timezone`,
 * `weekly{sun..sat:[{from,to}]}`, `overrides[{date, closed?, intervals?}]`),
 * every time wall-clock time in `timezone`. They make slots only while the
 * workspace turned slots on (`callback_slots_enabled`, off by default): that
 * switch decides, not `enabled` (a legacy value written before 277 never
 * changes a live widget).
 *
 * The server computes the slots (the public bootstrap's
 * `callback_policy.slots`, and again for every booking it checks); the
 * dashboard's preview computes them from the hours being edited, so it shows
 * what a visitor will see. The time-zone helpers came out of
 * server/services/widget/availability.ts (the chat's availability), which
 * imports them from here: one implementation.
 *
 * Pure: no I/O, no Node or DOM API (Intl only).
 */

export const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type DayKey = (typeof DAY_KEYS)[number];

// Shapes of business_hours as stored (all fields optional: the JSON is edited
// by the dashboard and must be read defensively).
export type HoursInterval = { from: string; to: string };
export type WeeklyHours = Record<string, HoursInterval[] | undefined>;
export type HoursOverride = { date?: string; closed?: boolean; intervals?: HoursInterval[] } | null;
export type BusinessHours = {
  enabled?: boolean;
  timezone?: unknown;
  weekly?: WeeklyHours | null;
  overrides?: HoursOverride[] | null;
};

/** The intervals of one day the resolvers honour (and a save may store). */
export const MAX_INTERVALS_PER_DAY = 6;

export function parseHHMM(v: unknown): { h: number; m: number } | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mm)) return null;
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  return { h, m: mm };
}

/**
 * Formatters per time zone. Building an Intl.DateTimeFormat costs far more
 * than using one, and an outside-hours resolve walks up to two weeks of days,
 * so each visitor request used to build dozens. An invalid zone maps to null
 * (callers fall back to UTC). The set of zones in use is small; the bound only
 * guards against junk values.
 */
const tzFormatters = new Map<string, Intl.DateTimeFormat | null>();
const MAX_TZ_FORMATTERS = 200;

export function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  let fmt = tzFormatters.get(timeZone);
  if (fmt !== undefined) return fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
    });
  } catch {
    fmt = null;
  }
  if (tzFormatters.size >= MAX_TZ_FORMATTERS) tzFormatters.clear();
  tzFormatters.set(timeZone, fmt);
  return fmt;
}

/** An IANA zone this runtime knows (Intl accepts it). */
export function isValidTimeZone(timeZone: unknown): timeZone is string {
  return typeof timeZone === 'string' && timeZone.length > 0 && timeZone.length <= 64 && formatterFor(timeZone) !== null;
}

/**
 * Convert a Date to {y,m,d,h,min,dow} as observed in the given IANA tz.
 * Uses Intl.DateTimeFormat — Node 18+ supports IANA tz natively.
 */
export function partsInTz(date: Date, timeZone: string): {
  y: number; mo: number; d: number; h: number; min: number; dow: number;
} {
  // Invalid tz — fall back to UTC parts so we still produce *something*.
  const fmt = formatterFor(timeZone) ?? formatterFor('UTC')!;
  const parts = fmt.formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    y: Number(get('year')),
    mo: Number(get('month')),
    d: Number(get('day')),
    h: Number(get('hour') === '24' ? '0' : get('hour')),
    min: Number(get('minute')),
    dow: dowMap[get('weekday') as string] ?? 0,
  };
}

/**
 * Find the wall-clock UTC instant corresponding to (y, mo, d, h, min) in tz.
 * Two-pass approximation: build a UTC guess, measure tz offset at that guess,
 * subtract. Good enough for hour-boundary checks; DST edges land on the next
 * resolvable boundary which is the desired UX behavior.
 */
export function tzWallToUtc(y: number, mo: number, d: number, h: number, min: number, tz: string): Date {
  const guess = new Date(Date.UTC(y, mo - 1, d, h, min, 0));
  const observed = partsInTz(guess, tz);
  // Difference between what we asked for and what tz actually shows for our guess.
  const observedUtcGuess = Date.UTC(observed.y, observed.mo - 1, observed.d, observed.h, observed.min, 0);
  const targetUtcGuess = Date.UTC(y, mo - 1, d, h, min, 0);
  const diffMs = targetUtcGuess - observedUtcGuess;
  return new Date(guess.getTime() + diffMs);
}

export function dateKey(y: number, mo: number, d: number): string {
  return `${y.toString().padStart(4, '0')}-${mo.toString().padStart(2, '0')}-${d.toString().padStart(2, '0')}`;
}

export function hhmm(t: { h: number; m: number }): string {
  return `${String(t.h).padStart(2, '0')}:${String(t.m).padStart(2, '0')}`;
}

export function intervalsForDate(weekly: WeeklyHours | null | undefined, overrides: HoursOverride[], tzParts: { y: number; mo: number; d: number; dow: number }):
  { intervals: Array<{ from: string; to: string }>; closedByOverride: boolean } {
  const ovList = Array.isArray(overrides) ? overrides : [];
  const key = dateKey(tzParts.y, tzParts.mo, tzParts.d);
  const hit = ovList.find((o) => o && o.date === key);
  if (hit) {
    if (hit.closed === true) return { intervals: [], closedByOverride: true };
    if (Array.isArray(hit.intervals)) return { intervals: hit.intervals, closedByOverride: false };
  }
  const dayKey = DAY_KEYS[tzParts.dow] || 'mon';
  const list = weekly && typeof weekly === 'object' ? weekly[dayKey] : null;
  return { intervals: Array.isArray(list) ? list : [], closedByOverride: false };
}

/**
 * The intervals the resolver itself would honour, in order: valid HH:mm and
 * `from` before `to` (isWithin never matches any other interval).
 */
export function usableIntervals(list: unknown): HoursInterval[] {
  if (!Array.isArray(list)) return [];
  const out: Array<{ start: number; it: HoursInterval }> = [];
  for (const raw of list) {
    const f = parseHHMM((raw as HoursInterval | null)?.from);
    const t = parseHHMM((raw as HoursInterval | null)?.to);
    if (!f || !t || f.h * 60 + f.m >= t.h * 60 + t.m) continue;
    out.push({ start: f.h * 60 + f.m, it: { from: hhmm(f), to: hhmm(t) } });
  }
  return out.sort((a, b) => a.start - b.start).slice(0, MAX_INTERVALS_PER_DAY).map((x) => x.it);
}

// ─── Callback slots ─────────────────────────────────────────────────────────

/** One bookable time: its instant (ISO 8601 with the business zone's offset) and whether a visitor may pick it. */
export interface CallbackSlot {
  at: string;
  available: boolean;
}

/** A slot sooner than this is shown, but cannot be picked (the visitor needs time to submit). */
export const CALLBACK_SLOT_LEAD_MS = 5 * 60_000;
/** How far a booked time may be from a slot's instant and still be that slot. */
export const CALLBACK_SLOT_TOLERANCE_MS = 60_000;
/** Slots of one day, at most (a 10-minute slot over a long day stops here). */
export const MAX_CALLBACK_SLOTS_PER_DAY = 32;
/** Slots in the list, at most: four full days, whatever `daysAhead` says. */
export const MAX_CALLBACK_SLOTS = 4 * MAX_CALLBACK_SLOTS_PER_DAY;
/** Calendar days looked at for open days (a long closure by overrides ends the list). */
const MAX_WALK_DAYS = 62;
/**
 * The furthest ahead a callback may be booked (POST /api/call-widget/
 * callbacks/request refuses a later time): no slot past it is offered, so a
 * workspace open only now and then never shows a time the booking refuses.
 */
export const CALLBACK_BOOKING_MAX_AHEAD_MS = 30 * 24 * 60 * 60_000;

export const CALLBACK_SLOT_MINUTES = { min: 10, max: 240, default: 30 } as const;
export const CALLBACK_DAYS_AHEAD = { min: 1, max: 14, default: 4 } as const;
export const CALLBACK_SLOT_CAPACITY = { min: 1, max: 100 } as const;

function clampInt(value: unknown, range: { min: number; max: number; default: number }): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : NaN;
  if (Number.isNaN(n)) return range.default;
  return Math.min(range.max, Math.max(range.min, n));
}

/** The hours' zone when it is a real one, else `fallback` (when real), else UTC. */
export function callbackHoursTimeZone(hours: BusinessHours | null | undefined, fallback?: string | null): string {
  if (isValidTimeZone(hours?.timezone)) return hours!.timezone as string;
  if (isValidTimeZone(fallback)) return fallback;
  return 'UTC';
}

/** Do the hours name at least one usable interval (a weekday or an override)? */
export function callbackHoursHaveInterval(hours: BusinessHours | null | undefined): boolean {
  if (!hours || typeof hours !== 'object') return false;
  const weekly = hours.weekly && typeof hours.weekly === 'object' ? hours.weekly : {};
  if (DAY_KEYS.some((day) => usableIntervals(weekly[day]).length > 0)) return true;
  const overrides = Array.isArray(hours.overrides) ? hours.overrides : [];
  return overrides.some((o) => !!o && o.closed !== true && usableIntervals(o.intervals).length > 0);
}

/** `date` as ISO 8601 in `tz` with that zone's offset, minute precision (2026-10-23T16:30:00+03:30). */
export function isoWithOffset(date: Date, tz: string): string {
  const p = partsInTz(date, tz);
  const wall = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.min, 0);
  const instant = Math.floor(date.getTime() / 60_000) * 60_000;
  const offset = Math.round((wall - instant) / 60_000);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${dateKey(p.y, p.mo, p.d)}T${hhmm({ h: p.h, m: p.min })}:00${sign}${hhmm({ h: Math.floor(abs / 60), m: abs % 60 })}`;
}

/**
 * The instant a wall time in `tz` names, or null when that day has no such
 * time (a daylight-saving gap). tzWallToUtc's estimate, refined against what
 * the zone shows: it is exact for every time that exists, near a transition
 * too (the chat's resolver keeps its own approximation).
 */
function wallInstant(y: number, mo: number, d: number, h: number, min: number, tz: string): number | null {
  const target = Date.UTC(y, mo - 1, d, h, min, 0);
  let t = tzWallToUtc(y, mo, d, h, min, tz).getTime();
  for (let pass = 0; pass < 3; pass++) {
    const p = partsInTz(new Date(t), tz);
    const diff = target - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.min, 0);
    if (diff === 0) return t;
    t += diff;
  }
  return null;
}

export interface ComputeCallbackSlotsInput {
  /** The workspace's callback hours (business_hours). */
  hours: BusinessHours | null | undefined;
  /** Slot length in minutes (10–240; 30 when unusable). */
  slotMinutes: number;
  /** Open days offered, today included (1–14; 4 when unusable). */
  daysAhead: number;
  /** Callbacks per slot; null/undefined = unlimited. */
  capacity?: number | null;
  /** The times already booked (open callbacks' scheduled_for), any ISO spelling. */
  booked?: ReadonlyArray<string | null | undefined> | null;
  now: Date | number;
  /** The zone when the hours name none (or an unknown one): Iran Asia/Tehran, International UTC. */
  defaultTimeZone?: string | null;
}

/**
 * Every slot start inside the open intervals of the next `daysAhead` open
 * days (today included, its past slots too), in the hours' zone, in order:
 * `{ at, available }` with `at` in ISO 8601 with that zone's offset.
 * `available` is false for a slot sooner than now + 5 minutes and for one
 * whose bookings reached `capacity` (a booking counts for the slot it falls
 * in: from a minute before its start until the next slot). A day of a
 * daylight-saving gap skips the wall times that do not exist. At most 32
 * slots a day and 128 in all (four full days).
 */
export function computeCallbackSlots(input: ComputeCallbackSlotsInput): CallbackSlot[] {
  const hours = input.hours && typeof input.hours === 'object' ? input.hours : null;
  if (!hours) return [];
  const tz = callbackHoursTimeZone(hours, input.defaultTimeZone);
  const slotMinutes = clampInt(input.slotMinutes, CALLBACK_SLOT_MINUTES);
  const daysAhead = clampInt(input.daysAhead, CALLBACK_DAYS_AHEAD);
  const capacity = typeof input.capacity === 'number' && Number.isFinite(input.capacity) && input.capacity >= 1
    ? Math.trunc(input.capacity)
    : null;
  const nowMs = typeof input.now === 'number' ? input.now : input.now.getTime();
  const earliest = nowMs + CALLBACK_SLOT_LEAD_MS;
  const horizon = nowMs + CALLBACK_BOOKING_MAX_AHEAD_MS;
  const weekly: WeeklyHours = hours.weekly && typeof hours.weekly === 'object' ? hours.weekly : {};
  const overrides = Array.isArray(hours.overrides) ? hours.overrides : [];
  const booked = capacity == null
    ? []
    : (input.booked ?? []).map((iso) => (typeof iso === 'string' ? Date.parse(iso) : NaN)).filter((t) => Number.isFinite(t));

  const today = partsInTz(new Date(nowMs), tz);
  const instants: number[] = [];
  const seen = new Set<number>();
  let openDays = 0;
  for (let offset = 0; offset < MAX_WALK_DAYS && openDays < daysAhead && instants.length < MAX_CALLBACK_SLOTS; offset++) {
    // Calendar days from today in the business zone: date arithmetic in UTC
    // on the local date, no zone lookups per day.
    const day = new Date(Date.UTC(today.y, today.mo - 1, today.d + offset));
    const y = day.getUTCFullYear();
    const mo = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    const list = usableIntervals(intervalsForDate(weekly, overrides, { y, mo, d, dow: day.getUTCDay() }).intervals);
    if (!list.length) continue;
    openDays++;
    let inDay = 0;
    for (const it of list) {
      const from = parseHHMM(it.from)!;
      const to = parseHHMM(it.to)!;
      for (let m = from.h * 60 + from.m; m < to.h * 60 + to.m && inDay < MAX_CALLBACK_SLOTS_PER_DAY; m += slotMinutes) {
        const h = Math.floor(m / 60);
        const min = m % 60;
        const t = wallInstant(y, mo, d, h, min, tz);
        // A wall time a daylight-saving gap skips does not exist that day.
        if (t == null || seen.has(t)) continue; // (or overlapping intervals)
        if (t > horizon) break; // past the booking window (later times too)
        seen.add(t);
        instants.push(t);
        inDay++;
      }
    }
  }
  instants.sort((a, b) => a - b);
  return instants.slice(0, MAX_CALLBACK_SLOTS).map((t) => {
    let full = false;
    if (capacity != null) {
      const end = t + slotMinutes * 60_000 - CALLBACK_SLOT_TOLERANCE_MS;
      const count = booked.filter((b) => b >= t - CALLBACK_SLOT_TOLERANCE_MS && b < end).length;
      full = count >= capacity;
    }
    return { at: isoWithOffset(new Date(t), tz), available: t >= earliest && !full };
  });
}

/** Is `iso` one of the available slots (within a minute of its instant)? */
export function isBookableSlot(slots: ReadonlyArray<CallbackSlot>, iso: unknown): boolean {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return false;
  return slots.some((s) => s.available && Math.abs(Date.parse(s.at) - t) <= CALLBACK_SLOT_TOLERANCE_MS);
}
