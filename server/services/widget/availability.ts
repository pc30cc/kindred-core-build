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
 *  1. business_hours.enabled === false  =>  state forced to 'online' AND
 *     offline_mode is ignored. There is no "disabled hours but still offline"
 *     state. The only way to be offline is enabled hours that resolve to
 *     outside_hours, or every day being empty (always_offline).
 *  2. The client never decides availability. Bootstrap and message endpoints
 *     re-resolve here.
 *  3. Localized offline message comes from offline_message_localized first,
 *     then offline_message, then empty string. No translation pipeline.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { anyCustomerAvailableOperator } from './customerAvailability.js';

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
}

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

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
function partsInTz(date: Date, timeZone: string): {
  y: number; mo: number; d: number; h: number; min: number; dow: number;
} {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
    }).formatToParts(date);
  } catch {
    // Invalid tz — fall back to UTC parts so we still produce *something*.
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
    }).formatToParts(date);
  }
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

function intervalsForDate(weekly: any, overrides: any[], tzParts: { y: number; mo: number; d: number; dow: number }):
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

function nextOpenAt(weekly: any, overrides: any[], now: Date, tz: string): string | null {
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
}

/**
 * Single source of truth. All callers must go through here.
 */
export async function resolveAvailability(
  config: ServerConfig,
  input: ResolveAvailabilityInput,
): Promise<AvailabilitySnapshot> {
  const { workspaceId } = input;
  const locale = (input.locale || 'en').toLowerCase().split('-')[0];
  const now = input.now || new Date();

  const supabase = getServiceClient(config);
  const { data: row } = await supabase
    .from('widget_settings')
    .select('business_hours, offline_mode, availability_labels, offline_message, offline_message_localized, live_chat_enabled')
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  const offlineMode = normalizeOfflineMode((row as any)?.offline_mode);
  const labelsSrc = (row as any)?.availability_labels as Record<string, { online?: string; offline?: string }> | null;
  const localizedMsgSrc = (row as any)?.offline_message_localized as Record<string, string> | null;
  const legacyOfflineMsg = typeof (row as any)?.offline_message === 'string' ? (row as any).offline_message : '';

  const localeLabels = labelsSrc && typeof labelsSrc === 'object' ? (labelsSrc[locale] || labelsSrc['en'] || {}) : {};
  const def = DEFAULT_LABELS[locale] || DEFAULT_LABELS.en;
  const labels = {
    online: typeof localeLabels.online === 'string' && localeLabels.online ? localeLabels.online : def.online,
    offline: typeof localeLabels.offline === 'string' && localeLabels.offline ? localeLabels.offline : def.offline,
  };

  const offlineMessage = pickLocalized(localizedMsgSrc, locale, legacyOfflineMsg);

  const bh = (row as any)?.business_hours as any;
  const enabled = !!bh?.enabled;
  const tz = (typeof bh?.timezone === 'string' && bh.timezone) || 'UTC';
  const liveChatEnabled = (row as any)?.live_chat_enabled !== false;

  // LOCKED RULE 1: business_hours.enabled === false  =>  state forced to
  // 'online' AND offline_mode is ignored. live_chat_enabled is intentionally
  // NOT consulted here so admins can never produce a "hours off but widget
  // still offline" state via the hours toggle.
  if (!enabled) {
    return {
      state: 'online',
      reason: 'disabled',
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

  const weekly = bh?.weekly && typeof bh.weekly === 'object' ? bh.weekly : {};
  const overrides = Array.isArray(bh?.overrides) ? bh.overrides : [];

  // Empty schedule (every day empty AND no overrides with intervals) => always_offline.
  const anyIntervalDefined =
    DAY_KEYS.some((k) => Array.isArray(weekly[k]) && weekly[k].length > 0) ||
    overrides.some((o: any) => Array.isArray(o?.intervals) && o.intervals.length > 0);
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
    // Within business hours — but if every operator is force-offline or
    // outside their own personal schedule, flip the widget to offline so
    // visitors aren't promised "we're online" when nobody can reply.
    // Failing-open (treat as online) when the workspace literally has
    // zero members keeps brand-new workspaces usable.
    try {
      // CUSTOMER-FACING ONLY: manual status + personal schedule. Connection
      // state (tab, socket, Centrifugo) is deliberately NOT an input, so a
      // minimized browser or a realtime outage can never flip the messenger
      // offline.
      const { anyAvailable, memberCount } = await anyCustomerAvailableOperator(
        config,
        workspaceId,
        now,
      );
      if (memberCount > 0 && !anyAvailable) {
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
    } catch (err: any) {
      // Never block the bootstrap on presence lookup failure — fall
      // through to the within_hours online state.
      console.warn('[availability] operator presence lookup failed:', err?.message);
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
