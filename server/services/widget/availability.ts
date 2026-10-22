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
 *     Only the members who receive chats count (customerAvailability.ts:
 *     the owner and team roles, not suspended or seat-paused, "Receive
 *     chats automatically" on); staff never make the widget online.
 *     Workspaces with zero members fail open.

 *  2. The client never decides availability. Bootstrap and message endpoints
 *     re-resolve here.
 *  3. Localized offline message comes from offline_message_localized first,
 *     then offline_message, then empty string. No translation pipeline.
 *  4. The plan decides first: without `widget_business_hours` (the panel's
 *     Availability tab: hours and offline behaviour) the stored hours and
 *     offline mode are not applied (availabilityRowForPlan), so a downgrade
 *     takes effect on visitors instead of lingering behind a locked tab.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { anyCustomerAvailableOperator, type WorkspaceAvailabilityPrefs } from './customerAvailability.js';
// The time-zone helpers are shared with the call widget's callback slots
// (one implementation; shared/callbackSlots.ts).
import {
  DAY_KEYS,
  dateKey,
  formatterFor,
  hhmm,
  intervalsForDate,
  parseHHMM,
  partsInTz,
  tzWallToUtc,
  usableIntervals,
  type BusinessHours,
  type DayKey,
  type HoursInterval,
  type HoursOverride,
  type WeeklyHours,
} from '../../../shared/callbackSlots.js';

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

// widget_settings.business_hours as stored: shared/callbackSlots.ts's
// BusinessHours (all fields optional: read defensively).
type WidgetAvailabilityRow = {
  business_hours?: BusinessHours | null;
  offline_mode?: unknown;
  availability_labels?: Record<string, { online?: string; offline?: string }> | null;
  offline_message?: unknown;
  offline_message_localized?: Record<string, string> | null;
  live_chat_enabled?: boolean | null;
};

/**
 * The availability settings a plan wears (locked rule 4). Without
 * `widget_business_hours` (`allowed === false`) the workspace has no
 * schedule and the leave-a-message form, whatever is stored (its labels and
 * offline message are copy, not behaviour, and stay). `true`, or `null` (the
 * plan could not be read: the stored settings keep applying rather than
 * flipping a live widget on a blip), returns the row as it is.
 */
export function availabilityRowForPlan<T extends Partial<WidgetAvailabilityRow>>(
  row: T | null | undefined,
  allowed: boolean | null | undefined,
): T | null {
  if (!row) return row ?? null;
  if (allowed !== false) return row;
  const bh = row.business_hours && typeof row.business_hours === 'object' ? row.business_hours : {};
  return {
    ...row,
    business_hours: { ...bh, enabled: false },
    offline_mode: 'capture_message',
  } as T;
}

/**
 * The plan's business-hours answer from resolved widget entitlements
 * (entitlements.ts): null while any answer was unreadable (`degraded` reads
 * unreadable as denied; availability must not flip on it).
 */
export function businessHoursAllowedOf(
  ent: { features: Record<string, boolean>; degraded?: boolean } | null | undefined,
): boolean | null {
  if (!ent || ent.degraded) return null;
  return ent.features.widget_business_hours !== false;
}

/** Whether the row uses anything a plan without business hours resets (no plan lookup otherwise). */
function usesPlanGatedAvailability(row: WidgetAvailabilityRow | null): boolean {
  if (!row) return false;
  return row.business_hours?.enabled === true || normalizeOfflineMode(row.offline_mode) !== 'capture_message';
}

/**
 * The plan's answer for `widget_business_hours`, for a caller that did not
 * resolve it (entitlement cache, 60 s). Null when it cannot be read.
 */
async function lookupBusinessHoursAllowed(config: ServerConfig, workspaceId: string): Promise<boolean | null> {
  try {
    const { widgetBusinessHoursAllowed } = await import('./entitlements.js');
    return await widgetBusinessHoursAllowed(config, workspaceId);
  } catch {
    return null;
  }
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
  // The visitor's language only (locked rule 3): never the owner's English
  // for a Persian visitor.
  const direct = source[locale];
  if (typeof direct === 'string' && direct.length > 0) return direct;
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
  /**
   * The plan's answer for `widget_business_hours` when the caller already
   * holds it (the widget config snapshot's entitlements); null = unreadable.
   * Omitted: looked up here, only when the row uses something it gates.
   */
  businessHoursAllowed?: boolean | null;
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
  const stored = input.settingsRow !== undefined
    ? ((input.settingsRow ?? null) as WidgetAvailabilityRow | null)
    : await readAvailabilityRow(config, input.workspaceId);
  const allowed = input.businessHoursAllowed !== undefined
    ? input.businessHoursAllowed
    : usesPlanGatedAvailability(stored) ? await lookupBusinessHoursAllowed(config, input.workspaceId) : true;
  const settings = availabilityRowForPlan(stored, allowed);
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

  // The owner's labels in the visitor's language, else the built-in ones
  // in it (never the owner's English for a Persian visitor).
  const localeLabels = labelsSrc && typeof labelsSrc === 'object' ? (labelsSrc[locale] || {}) : {};
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
 * SIMPLE BILLING phase 4 — "when the monthly quota is full the widget shows
 * the leave-a-message form" (docs/billing/SIMPLE_BILLING.md).
 *
 *   - null: billing locks are off for this edition (or self-host unlimited).
 *     The field is left out of the payload and the widget behaves as before
 *     (a first message over the quota is refused, and so is the form).
 *   - true / false: locks are on. /offline-messages then accepts a capture
 *     over the quota (tagged `over_quota`), so a widget that sees the field
 *     shows the form for a new conversation while `true`, and switches to it
 *     when a first message is refused for `max_conversations`.
 *
 * Fail open: an unreadable quota reads as not full (the /message cap still
 * decides, and its refusal still leads to the form).
 */
export async function resolveConversationQuotaFull(config: ServerConfig, workspaceId: string): Promise<boolean | null> {
  if (!workspaceId || config.selfHostBillingUnlimited === true) return null;
  try {
    const { locksEnabled } = await import('../billing/locks/state.js');
    if (!(await locksEnabled(config))) return null;
  } catch {
    return null;
  }
  try {
    const { checkMaxConversationsAllowance } = await import('../billing/conversationLimit.js');
    const allowance = await checkMaxConversationsAllowance(config, workspaceId);
    return allowance.reason === 'limit_reached';
  } catch {
    return false;
  }
}

export interface WireExtras {
  /** resolveConversationQuotaFull(); null/undefined leaves the field out. */
  quota_full?: boolean | null;
}

/**
 * Reduce an AvailabilitySnapshot to the additive payload exposed on
 * /bootstrap and /config so the widget runtime never has to know about
 * the internal weekly schedule shape.
 */
export function snapshotToWirePayload(snap: AvailabilitySnapshot, extras: WireExtras = {}) {
  return {
    state: snap.state,
    reason: snap.reason,
    next_open_at: snap.next_open_at,
    timezone: snap.timezone,
    offline_mode: snap.offline_mode,
    labels: snap.labels,
    offline_message: snap.offline_message,
    ...(typeof extras.quota_full === 'boolean' ? { quota_full: extras.quota_full } : {}),
  };
}
