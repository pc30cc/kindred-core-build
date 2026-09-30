/**
 * Phase 8 — Widget Availability Resolver
 *
 * Server-authoritative computation of whether a workspace is currently
 * "online" for live chat, derived from `widget_settings`:
 *   - business_hours.enabled
 *   - business_hours.timezone (IANA)
 *   - business_hours.weekly[mon..sun] => [{ from: "HH:mm", to: "HH:mm" }, ...]
 *   - business_hours.overrides => [{ date: "YYYY-MM-DD", closed?: true, intervals?: [...] }]
 *   - offline_mode: 'hide_widget' | 'show_offline_message' | 'capture_message'
 *   - availability_labels (per-locale)
 *   - offline_message_localized (per-locale)
 *   - offline_message (legacy fallback)
 *
 * LOCKED RULES (do not regress):
 *  1. business_hours.enabled === false  =>  the WORKSPACE imposes no time
 *     restriction. It does NOT force 'online': operator manual status
 *     (offline/invisible) and personal schedules still decide reachability.
 *     Workspaces with zero members fail open.

 *  2. The client never decides availability. Bootstrap and message endpoints
 *     re-resolve here.
 *  3. Localized offline message comes from offline_message_localized first,
 *     then offline_message, then empty string. No translation pipeline.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { anyCustomerAvailableOperator, type WorkspaceAvailabilityPrefs } from './customerAvailability.js';

export type AvailabilityState = 'online' | 'offline';
export type OfflineMode = 'hide_widget' | 'show_offline_message' | 'capture_message';
export type AvailabilityReason =
  | 'within_hours'
  | 'outside_hours'
  | 'override_closed'
  | 'always_offline'
  | 'no_operators_online'
  | 'disabled';

export interface AvailabilitySnapshot {
  state: AvailabilityState;
  reason: AvailabilityReason;
  next_open_at: string | null; // ISO UTC
  timezone: string;
  offline_mode: OfflineMode;
  labels: { online: string; offline: string };
  offline_message: string;
  /**
   * The configured schedule, only when the caller asked for it
   * (`includeSchedule`) and business hours are on. Server-side only:
   * snapshotToWirePayload leaves it out.
   */
  schedule?: BusinessHoursSchedule | null;
}

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
type DayKey = (typeof DAY_KEYS)[number];

/**
 * Business hours as the AI states them to a visitor ("when are you open?").
 * Every time is wall-clock time in `timezone`.
 */
export interface BusinessHoursSchedule {
  timezone: string;
  /** Monday first. A day without an interval is closed. */
  weekly: Array<{ day: DayKey; intervals: HoursInterval[] }>;
  /** Date overrides from today through the next UPCOMING_DAYS - 1 days. */
  upcoming: Array<{ date: string; day: DayKey; closed: boolean; intervals: HoursInterval[] }>;
  /** Workspace wall clock at resolve time. */
  now: { date: string; day: DayKey; time: string };
  /** Inside a scheduled interval right now (the schedule alone, operators aside). */
  open_now: boolean;
  /** Start of the next scheduled interval, when closed by the schedule. */
  next_open: { date: string; day: DayKey; time: string } | null;
}

const DEFAULT_LABELS: Record<string, { online: string; offline: string }> = {
  en: { online: "We're online", offline: "We're offline" },
  fa: { online: 'آنلاین هستیم', offline: 'آفلاین هستیم' },
  tr: { online: 'Çevrimiçiyiz', offline: 'Çevrimdışıyız' },
};

function normalizeOfflineMode(value: unknown): OfflineMode {
  if (value === 'hide_widget' || value === 'show_offline_message' || value === 'capture_message') {
    return value;
  }
  return 'capture_message';
}

function parseHHMM(v: unknown): { h: number; m: number } | null {
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
 * Convert a Date to {y,m,d,h,min,dow} as observed in the given IANA tz.
 * Uses Intl.DateTimeFormat — Node 18+ supports IANA tz natively.
 */
/**
 * Formatters per time zone. Building an Intl.DateTimeFormat costs far more
 * than using one, and an outside-hours resolve walks up to two weeks of days,
 * so each visitor request used to build dozens. An invalid zone maps to null
 * (callers fall back to UTC). The set of zones in use is small; the bound only
 * guards against junk values.
 */
const tzFormatters = new Map<string, Intl.DateTimeFormat | null>();
const MAX_TZ_FORMATTERS = 200;

function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
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

function partsInTz(date: Date, timeZone: string): {
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
function tzWallToUtc(y: number, mo: number, d: number, h: number, min: number, tz: string): Date {
  const guess = new Date(Date.UTC(y, mo - 1, d, h, min, 0));
  const observed = partsInTz(guess, tz);
  // Difference between what we asked for and what tz actually shows for our guess.
  const observedUtcGuess = Date.UTC(observed.y, observed.mo - 1, observed.d, observed.h, observed.min, 0);
  const targetUtcGuess = Date.UTC(y, mo - 1, d, h, min, 0);
  const diffMs = targetUtcGuess - observedUtcGuess;
  return new Date(guess.getTime() + diffMs);
}

function dateKey(y: number, mo: number, d: number): string {
  return `${y.toString().padStart(4, '0')}-${mo.toString().padStart(2, '0')}-${d.toString().padStart(2, '0')}`;
}

// Shapes of widget_settings.business_hours as stored (all fields optional:
// the JSON is edited by the dashboard and must be read defensively).
type HoursInterval = { from: string; to: string };
type WeeklyHours = Record<string, HoursInterval[] | undefined>;
type HoursOverride = { date?: string; closed?: boolean; intervals?: HoursInterval[] } | null;
type BusinessHours = { enabled?: boolean; timezone?: unknown; weekly?: WeeklyHours | null; overrides?: HoursOverride[] | null };
type WidgetAvailabilityRow = {
  business_hours?: BusinessHours | null;
  offline_mode?: unknown;
  availability_labels?: Record<string, { online?: string; offline?: string }> | null;
  offline_message?: unknown;
  offline_message_localized?: Record<string, string> | null;
  live_chat_enabled?: boolean | null;
};

function intervalsForDate(weekly: WeeklyHours | null | undefined, overrides: HoursOverride[], tzParts: { y: number; mo: number; d: number; dow: number }):
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

function isWithin(intervals: Array<{ from: string; to: string }>, h: number, min: number): boolean {
  const cur = h * 60 + min;
  for (const it of intervals) {
    const f = parseHHMM(it?.from);
    const t = parseHHMM(it?.to);
    if (!f || !t) continue;
    const fm = f.h * 60 + f.m;
    const tm = t.h * 60 + t.m;
    if (fm <= cur && cur < tm) return true;
  }
  return false;
}

function nextOpenAt(weekly: WeeklyHours | null | undefined, overrides: HoursOverride[], now: Date, tz: string): string | null {
  // Walk up to 14 days forward looking for the next interval start strictly after `now`.
  for (let offset = 0; offset < 14; offset++) {
    const probe = new Date(now.getTime() + offset * 86400000);
    const parts = partsInTz(probe, tz);
    const { intervals } = intervalsForDate(weekly, overrides, parts);
    if (!intervals.length) continue;
    // Sort intervals by start time
    const sorted = intervals
      .map((it) => ({ f: parseHHMM(it?.from), to: parseHHMM(it?.to) }))
      .filter((x) => x.f && x.to)
      .sort((a, b) => (a.f!.h * 60 + a.f!.m) - (b.f!.h * 60 + b.f!.m));
    for (const it of sorted) {
      const candidate = tzWallToUtc(parts.y, parts.mo, parts.d, it.f!.h, it.f!.m, tz);
      if (candidate.getTime() > now.getTime()) {
        return candidate.toISOString();
      }
    }
  }
  return null;
}

const WEEK_ORDER: readonly DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const UPCOMING_DAYS = 14;
const MAX_INTERVALS_PER_DAY = 6;

function hhmm(t: { h: number; m: number }): string {
  return `${String(t.h).padStart(2, '0')}:${String(t.m).padStart(2, '0')}`;
}

/**
 * The intervals the resolver itself would honour, in order: valid HH:mm and
 * `from` before `to` (isWithin never matches any other interval).
 */
function usableIntervals(list: unknown): HoursInterval[] {
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

function wallClock(date: Date, tz: string): { date: string; day: DayKey; time: string } {
  const p = partsInTz(date, tz);
  return { date: dateKey(p.y, p.mo, p.d), day: DAY_KEYS[p.dow] || 'mon', time: hhmm({ h: p.h, m: p.min }) };
}

/**
 * Describe the configured business hours from a widget_settings row the
 * caller already holds. Pure: no I/O. Null when hours are off or no interval
 * is defined anywhere (nothing to state).
 */
export function describeBusinessHours(
  bh: BusinessHours | null | undefined,
  now: Date,
  nextOpenAtIso: string | null,
): BusinessHoursSchedule | null {
  if (!bh?.enabled) return null;
  const rawTz = (typeof bh.timezone === 'string' && bh.timezone) || 'UTC';
  const tz = formatterFor(rawTz) ? rawTz : 'UTC';
  const weeklyRaw: WeeklyHours = bh.weekly && typeof bh.weekly === 'object' ? bh.weekly : {};
  const overrides = Array.isArray(bh.overrides) ? bh.overrides : [];

  const weekly = WEEK_ORDER.map((day) => ({ day, intervals: usableIntervals(weeklyRaw[day]) }));

  // Calendar days from today in the workspace's zone. Date arithmetic in UTC
  // on the local date — no zone lookups per day.
  const today = partsInTz(now, tz);
  const upcoming: BusinessHoursSchedule['upcoming'] = [];
  for (let offset = 0; offset < UPCOMING_DAYS; offset++) {
    const d = new Date(Date.UTC(today.y, today.mo - 1, today.d + offset));
    const key = dateKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    const hit = overrides.find((o) => o && o.date === key);
    // Same precedence as intervalsForDate: closed, then an interval list.
    if (!hit || (hit.closed !== true && !Array.isArray(hit.intervals))) continue;
    const intervals = hit.closed === true ? [] : usableIntervals(hit.intervals);
    upcoming.push({ date: key, day: DAY_KEYS[d.getUTCDay()] || 'mon', closed: intervals.length === 0, intervals });
  }

  const anyInterval = weekly.some((w) => w.intervals.length > 0) || upcoming.some((u) => u.intervals.length > 0);
  if (!anyInterval) return null;

  const { intervals: todays } = intervalsForDate(weeklyRaw, overrides, today);
  const openNow = isWithin(todays, today.h, today.min);
  return {
    timezone: tz,
    weekly,
    upcoming,
    now: wallClock(now, tz),
    open_now: openNow,
    next_open: !openNow && nextOpenAtIso ? wallClock(new Date(nextOpenAtIso), tz) : null,
  };
}

function pickLocalized<T extends string>(
  source: Record<string, T> | null | undefined,
  locale: string,
  fallback: T,
): T {
  if (!source || typeof source !== 'object') return fallback;
  const direct = source[locale];
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const en = source['en'];
  if (typeof en === 'string' && en.length > 0) return en;
  return fallback;
}

export interface ResolveAvailabilityInput {
  workspaceId: string;
  locale?: string;
  now?: Date;
  /**
   * The workspace's widget_settings row, when the caller already read it for
   * this request (any row carrying the availability columns). Omitted: read
   * here.
   */
  settingsRow?: Partial<WidgetAvailabilityRow> | null;
  /** Members + availability prefs, when the caller already loaded them. */
  availabilityPrefs?: WorkspaceAvailabilityPrefs;
  /**
   * Also describe the configured schedule (`snapshot.schedule`), from the
   * same row. For the AI's answers; visitor-facing paths leave it off.
   */
  includeSchedule?: boolean;
}

/**
 * CUSTOMER-FACING ONLY: manual status + personal schedule. Connection state
 * (tab, socket, Centrifugo) is deliberately NOT an input, so a minimized
 * browser or a realtime outage can never flip the messenger offline.
 * Fails open (never offline) on lookup errors and for member-less workspaces.
 */
async function customerFacingState(
  config: ServerConfig,
  workspaceId: string,
  now: Date,
  preloaded?: WorkspaceAvailabilityPrefs,
): Promise<{ offline: boolean }> {
  try {
    const { anyAvailable, memberCount } = await anyCustomerAvailableOperator(config, workspaceId, now, preloaded);
    return { offline: memberCount > 0 && !anyAvailable };
  } catch (err: unknown) {
    console.warn('[availability] operator availability lookup failed:', err instanceof Error ? err.message : err);
    return { offline: false };
  }
}


/**
 * Single source of truth. All callers must go through here.
 */
export async function resolveAvailability(
  config: ServerConfig,
  input: ResolveAvailabilityInput,
): Promise<AvailabilitySnapshot> {
  const now = input.now || new Date();
  const settings = input.settingsRow !== undefined
    ? ((input.settingsRow ?? null) as WidgetAvailabilityRow | null)
    : await readAvailabilityRow(config, input.workspaceId);
  const snapshot = await snapshotFor(config, input, now, settings);
  if (input.includeSchedule) {
    snapshot.schedule = describeBusinessHours(settings?.business_hours, now, snapshot.next_open_at);
  }
  return snapshot;
}

async function readAvailabilityRow(config: ServerConfig, workspaceId: string): Promise<WidgetAvailabilityRow | null> {
  const supabase = getServiceClient(config);
  const { data, error: rowError } = await supabase
    .from('widget_settings')
    .select('business_hours, offline_mode, availability_labels, offline_message, offline_message_localized, live_chat_enabled')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  // A failed read must not look like "no settings": every field below would
  // silently fall back to its default (no business hours, default labels).
  if (rowError) {
    console.warn('[widget availability] widget_settings read failed:', rowError.message);
  }
  return (data ?? null) as WidgetAvailabilityRow | null;
}

async function snapshotFor(
  config: ServerConfig,
  input: ResolveAvailabilityInput,
  now: Date,
  settings: WidgetAvailabilityRow | null,
): Promise<AvailabilitySnapshot> {
  const { workspaceId } = input;
  const locale = (input.locale || 'en').toLowerCase().split('-')[0];

  const offlineMode = normalizeOfflineMode(settings?.offline_mode);
  const labelsSrc = settings?.availability_labels ?? null;
  const localizedMsgSrc = settings?.offline_message_localized ?? null;
  const legacyOfflineMsg = typeof settings?.offline_message === 'string' ? settings.offline_message : '';

  const localeLabels = labelsSrc && typeof labelsSrc === 'object' ? (labelsSrc[locale] || labelsSrc['en'] || {}) : {};
  const def = DEFAULT_LABELS[locale] || DEFAULT_LABELS.en;
  const labels = {
    online: typeof localeLabels.online === 'string' && localeLabels.online ? localeLabels.online : def.online,
    offline: typeof localeLabels.offline === 'string' && localeLabels.offline ? localeLabels.offline : def.offline,
  };

  const offlineMessage = pickLocalized(localizedMsgSrc, locale, legacyOfflineMsg);

  const bh = settings?.business_hours ?? null;
  const enabled = !!bh?.enabled;
  const tz = (typeof bh?.timezone === 'string' && bh.timezone) || 'UTC';
  const liveChatEnabled = settings?.live_chat_enabled !== false;

  // LOCKED RULE 1 (clarified): business_hours.enabled === false means the
  // WORKSPACE imposes no time restriction — it does NOT mean "force the
  // messenger online". Operator-level manual offline/invisible and personal
  // schedules still decide reachability. Workspaces with zero members keep
  // failing open so a brand-new workspace stays usable.
  if (!enabled) {
    const state = await customerFacingState(config, workspaceId, now, input.availabilityPrefs);
    return {
      state: state.offline ? 'offline' : 'online',
      reason: state.offline ? 'no_operators_online' : 'disabled',
      next_open_at: null,
      timezone: tz,
      offline_mode: offlineMode,
      labels,
      offline_message: offlineMessage,
    };
  }


  // Hours are enabled. If live_chat_enabled is explicitly false, treat as
  // an always-offline workspace (operators chose to be unreachable). This
  // path is only reachable when business_hours.enabled === true.
  if (liveChatEnabled === false) {
    return {
      state: 'offline',
      reason: 'always_offline',
      next_open_at: null,
      timezone: tz,
      offline_mode: offlineMode,
      labels,
      offline_message: offlineMessage,
    };
  }

  const weekly: WeeklyHours = bh?.weekly && typeof bh.weekly === 'object' ? bh.weekly : {};
  const overrides = Array.isArray(bh?.overrides) ? bh.overrides : [];

  // Empty schedule (every day empty AND no overrides with intervals) => always_offline.
  const anyIntervalDefined =
    DAY_KEYS.some((k) => Array.isArray(weekly[k]) && weekly[k].length > 0) ||
    overrides.some((o) => Array.isArray(o?.intervals) && o.intervals.length > 0);
  if (!anyIntervalDefined) {
    return {
      state: 'offline',
      reason: 'always_offline',
      next_open_at: null,
      timezone: tz,
      offline_mode: offlineMode,
      labels,
      offline_message: offlineMessage,
    };
  }

  const parts = partsInTz(now, tz);
  const { intervals, closedByOverride } = intervalsForDate(weekly, overrides, parts);
  const within = isWithin(intervals, parts.h, parts.min);

  if (within) {
    // Within business hours — but if every operator is force-offline,
    // invisible or outside their own personal schedule, flip the widget to
    // offline so visitors aren't promised "we're online".
    if ((await customerFacingState(config, workspaceId, now, input.availabilityPrefs)).offline) {
      return {
        state: 'offline',
        reason: 'no_operators_online',
        next_open_at: null,
        timezone: tz,
        offline_mode: offlineMode,
        labels,
        offline_message: offlineMessage,
      };
    }


    return {
      state: 'online',
      reason: 'within_hours',
      next_open_at: null,
      timezone: tz,
      offline_mode: offlineMode,
      labels,
      offline_message: offlineMessage,
    };
  }

  return {
    state: 'offline',
    reason: closedByOverride ? 'override_closed' : 'outside_hours',
    next_open_at: nextOpenAt(weekly, overrides, now, tz),
    timezone: tz,
    offline_mode: offlineMode,
    labels,
    offline_message: offlineMessage,
  };
}

/**
 * Reduce an AvailabilitySnapshot to the additive payload exposed on
 * /bootstrap and /config so the widget runtime never has to know about
 * the internal weekly schedule shape.
 */
export function snapshotToWirePayload(snap: AvailabilitySnapshot) {
  return {
    state: snap.state,
    reason: snap.reason,
    next_open_at: snap.next_open_at,
    timezone: snap.timezone,
    offline_mode: snap.offline_mode,
    labels: snap.labels,
    offline_message: snap.offline_message,
  };
}
