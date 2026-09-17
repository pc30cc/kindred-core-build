/**
 * CUSTOMER-FACING OPERATOR AVAILABILITY.
 *
 * This module answers ONE question: "should a visitor/messenger be told the
 * team is reachable?" — and it answers it WITHOUT ever looking at a browser
 * tab, a WebSocket, or Centrifugo presence.
 *
 * Inputs (the only ones allowed here):
 *   - `user_availability_prefs` (manual status + personal schedule + tz)
 *
 * Explicitly NOT inputs:
 *   - Centrifugo channel membership / connection state
 *   - `operator_presence_live` leases
 *   - tab visibility, minimize, sleep, network blips
 *
 * MANUAL STATUS CONTRACT (mapped onto the existing schema — no migration):
 *   force_offline = true                       → 'offline'
 *   available_when_using_app === false         → 'invisible'
 *   otherwise                                  → 'online'
 *
 *   online     → customer-available, subject to the personal schedule
 *   offline    → customer-unavailable
 *   invisible  → customer-unavailable AND hidden from teammates as active
 *
 * Internal (teammate-facing) presence lives in `operatorPresence.ts`;
 * routing eligibility lives in `chatRouting.ts`. The three concepts are
 * intentionally separate and must not be re-merged.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
type DayKey = (typeof DAY_KEYS)[number];

export type ManualAvailability = 'online' | 'offline' | 'invisible';
export type CustomerAvailability = 'available' | 'unavailable';

export type CustomerAvailabilityReason =
  | 'manual_offline'
  | 'manual_invisible'
  | 'within_schedule'
  | 'outside_schedule'
  | 'day_disabled'
  | 'always_available'
  | 'no_prefs';

export interface AvailabilityPrefsRow {
  user_id?: string;
  force_offline: boolean | null;
  available_when_using_app: boolean | null;
  schedule_enabled: boolean | null;
  timezone: string | null;
  weekly_schedule: any;
}

export const AVAILABILITY_PREFS_COLUMNS =
  'user_id, force_offline, available_when_using_app, schedule_enabled, timezone, weekly_schedule';

export function partsInTz(date: Date, tz: string): { h: number; m: number; dow: DayKey } {
  let parts: Intl.DateTimeFormatPart[];
  const opts: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  };
  try {
    parts = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: tz }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }).formatToParts(date);
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
  const dowMap: Record<string, DayKey> = {
    Sun: 'sun', Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat',
  };
  return {
    h: Number(get('hour') === '24' ? '0' : get('hour')),
    m: Number(get('minute')),
    dow: dowMap[get('weekday') as string] ?? 'mon',
  };
}

export function isWithinIntervals(intervals: any, h: number, m: number): boolean {
  const cur = h * 60 + m;
  if (!Array.isArray(intervals)) return false;
  for (const it of intervals) {
    const f = /^(\d{1,2}):(\d{2})$/.exec(it?.from || '');
    const t = /^(\d{1,2}):(\d{2})$/.exec(it?.to || '');
    if (!f || !t) continue;
    const fm = Number(f[1]) * 60 + Number(f[2]);
    const tm = Number(t[1]) * 60 + Number(t[2]);
    if (fm <= cur && cur < tm) return true;
  }
  return false;
}

/** Canonical manual status derived from the legacy boolean columns. */
export function manualAvailabilityOf(
  prefs: AvailabilityPrefsRow | null | undefined,
): ManualAvailability {
  if (!prefs) return 'online';
  if (prefs.force_offline === true) return 'offline';
  if (prefs.available_when_using_app === false) return 'invisible';
  return 'online';
}

/**
 * THE customer-facing decision. Pure, synchronous, connection-free.
 */
export function computeCustomerAvailability(
  prefs: AvailabilityPrefsRow | null | undefined,
  now: Date = new Date(),
): {
  availability: CustomerAvailability;
  manual: ManualAvailability;
  reason: CustomerAvailabilityReason;
} {
  const manual = manualAvailabilityOf(prefs);
  if (manual === 'offline') {
    return { availability: 'unavailable', manual, reason: 'manual_offline' };
  }
  if (manual === 'invisible') {
    return { availability: 'unavailable', manual, reason: 'manual_invisible' };
  }
  if (!prefs) {
    return { availability: 'available', manual, reason: 'no_prefs' };
  }
  if (prefs.schedule_enabled !== true) {
    // Manual online + no personal schedule ⇒ always customer-available.
    // Closing a laptop, switching tabs or losing the socket is IRRELEVANT here.
    return { availability: 'available', manual, reason: 'always_available' };
  }

  const { h, m, dow } = partsInTz(now, prefs.timezone || 'UTC');
  const day = (prefs.weekly_schedule || {})[dow];
  if (!day || day.enabled === false) {
    return { availability: 'unavailable', manual, reason: 'day_disabled' };
  }
  return isWithinIntervals(day.intervals, h, m)
    ? { availability: 'available', manual, reason: 'within_schedule' }
    : { availability: 'unavailable', manual, reason: 'outside_schedule' };
}

/** Member ids + their global availability prefs for a workspace. */
export async function loadWorkspaceAvailabilityPrefs(
  config: ServerConfig,
  workspaceId: string,
): Promise<{ memberIds: string[]; prefsByUser: Map<string, AvailabilityPrefsRow> }> {
  const sb = getServiceClient(config);
  const { data: members } = await sb
    .from('workspace_members')
    .select('user_id')
    .eq('workspace_id', workspaceId);
  const memberIds = (members || []).map((m: any) => m.user_id).filter(Boolean);
  const prefsByUser = new Map<string, AvailabilityPrefsRow>();
  if (!memberIds.length) return { memberIds, prefsByUser };

  // Global prefs (workspace_id IS NULL) — where the Account › Availability
  // page writes. Per-workspace overrides can be layered later.
  const { data: prefRows } = await sb
    .from('user_availability_prefs')
    .select(AVAILABILITY_PREFS_COLUMNS)
    .in('user_id', memberIds)
    .is('workspace_id', null);
  for (const r of (prefRows || []) as any[]) prefsByUser.set(r.user_id, r);
  return { memberIds, prefsByUser };
}

/** Operators a visitor may consider reachable right now. */
export async function listCustomerAvailableOperators(
  config: ServerConfig,
  workspaceId: string,
  now: Date = new Date(),
): Promise<{
  memberCount: number;
  available: Array<{ user_id: string; manual: ManualAvailability; reason: CustomerAvailabilityReason }>;
}> {
  const { memberIds, prefsByUser } = await loadWorkspaceAvailabilityPrefs(config, workspaceId);
  const available: Array<{ user_id: string; manual: ManualAvailability; reason: CustomerAvailabilityReason }> = [];
  for (const id of memberIds) {
    const r = computeCustomerAvailability(prefsByUser.get(id) || null, now);
    if (r.availability === 'available') {
      available.push({ user_id: id, manual: r.manual, reason: r.reason });
    }
  }
  return { memberCount: memberIds.length, available };
}

/**
 * Cheap predicate for the widget bootstrap path. Never touches realtime, so a
 * Centrifugo outage cannot flip a messenger offline.
 */
export async function anyCustomerAvailableOperator(
  config: ServerConfig,
  workspaceId: string,
  now: Date = new Date(),
): Promise<{ anyAvailable: boolean; memberCount: number }> {
  const { memberCount, available } = await listCustomerAvailableOperators(config, workspaceId, now);
  return { anyAvailable: available.length > 0, memberCount };
}
