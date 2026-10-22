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
 *   - `operator_activity_samples`
 *   - tab visibility, minimize, sleep, network blips
 *
 * MANUAL STATUS CONTRACT (the boolean columns, first match wins):
 *   force_offline = true                       → 'offline'
 *   available_when_using_app === false         → 'invisible'
 *   manual_away = true (migration 282)         → 'away'
 *   otherwise                                  → 'online'
 *
 *   online     → customer-available, subject to the personal schedule
 *   offline    → customer-unavailable
 *   invisible  → customer-unavailable AND hidden from teammates as active
 *   away       → customer-unavailable (no new chats, R-26); teammates see
 *                them away while connected, and they keep the chats they hold
 *
 * WHO COUNTS: only the members chat routing may give a conversation (owner
 * decision of 2026-10-21) — the owner and the team roles
 * (shared/chatRoles.ts), never staff; not suspended; seat not paused by the
 * plan; "Receive chats automatically" on (migration 278). The widget says
 * "online" only when one of THEM is available, so it never promises a
 * person routing could not give the visitor.
 *
 * Internal (teammate-facing) presence lives in `operatorPresence.ts`;
 * routing eligibility lives in `chatRouting.ts`. The three concepts are
 * intentionally separate and must not be re-merged.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { isRoutableChatRole } from '../../../shared/chatRoles.js';
import { resolveLockState } from '../billing/locks/state.js';
import { isMemberLocked } from '../billing/locks/predicates.js';

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
type DayKey = (typeof DAY_KEYS)[number];

export type ManualAvailability = 'online' | 'away' | 'offline' | 'invisible';
export type CustomerAvailability = 'available' | 'unavailable';

export type CustomerAvailabilityReason =
  | 'manual_offline'
  | 'manual_invisible'
  | 'manual_away'
  | 'within_schedule'
  | 'outside_schedule'
  | 'day_disabled'
  | 'always_available'
  | 'no_prefs';

/** One interval of a personal schedule day, as the Availability page stores it. */
export interface ScheduleInterval {
  from?: string;
  to?: string;
}

/** One day of a personal weekly schedule. */
export interface ScheduleDay {
  enabled?: boolean;
  intervals?: unknown;
}

export interface AvailabilityPrefsRow {
  user_id?: string;
  force_offline: boolean | null;
  available_when_using_app: boolean | null;
  /** "Away from desk" chosen by the operator (migration 282); absent on older rows and readers. */
  manual_away?: boolean | null;
  schedule_enabled: boolean | null;
  timezone: string | null;
  weekly_schedule: Partial<Record<DayKey, ScheduleDay>> | null;
}

export const AVAILABILITY_PREFS_COLUMNS =
  'user_id, force_offline, available_when_using_app, manual_away, schedule_enabled, timezone, weekly_schedule';

/**
 * Formatters per time zone, as in availability.ts: availability is computed
 * for every member on every widget page view (from the cached config
 * snapshot), and building an Intl.DateTimeFormat costs far more than using
 * one. An invalid zone maps to null (→ UTC, as before); the bound only guards
 * against junk values.
 */
const PARTS_OPTIONS: Intl.DateTimeFormatOptions = {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  weekday: 'short',
};
const tzFormatters = new Map<string, Intl.DateTimeFormat | null>();
const MAX_TZ_FORMATTERS = 200;

function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  let fmt = tzFormatters.get(timeZone);
  if (fmt !== undefined) return fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-US', { ...PARTS_OPTIONS, timeZone });
  } catch {
    fmt = null;
  }
  if (tzFormatters.size >= MAX_TZ_FORMATTERS) tzFormatters.clear();
  tzFormatters.set(timeZone, fmt);
  return fmt;
}

export function partsInTz(date: Date, tz: string): { h: number; m: number; dow: DayKey } {
  const parts: Intl.DateTimeFormatPart[] = (formatterFor(tz) ?? formatterFor('UTC')!).formatToParts(date);
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

export function isWithinIntervals(intervals: unknown, h: number, m: number): boolean {
  const cur = h * 60 + m;
  if (!Array.isArray(intervals)) return false;
  for (const it of intervals as Array<ScheduleInterval | null>) {
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
  if (prefs.manual_away === true) return 'away';
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
  if (manual === 'away') {
    return { availability: 'unavailable', manual, reason: 'manual_away' };
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

export interface WorkspaceAvailabilityPrefs {
  /** Every member (a member-less workspace fails open). */
  memberIds: string[];
  prefsByUser: Map<string, AvailabilityPrefsRow>;
  /**
   * The members who count (see the header: they receive chats). Absent:
   * every member counts, as before migration 278's columns were read.
   */
  chatMemberIds?: string[];
}

/** The workspace_members columns chatReceivingMemberIds reads. */
export const CHAT_MEMBER_COLUMNS = 'user_id, role, suspended_at, receives_chats';

export interface ChatMemberRow {
  user_id: string | null;
  role?: string | null;
  suspended_at?: string | null;
  receives_chats?: boolean | null;
}

/**
 * The members who count for the widget's online/offline: a role that
 * receives chats, not suspended, "Receive chats automatically" on, and a
 * seat the plan has not paused (the shared 60 s lock state; unreadable =
 * nobody paused).
 */
export async function chatReceivingMemberIds(
  config: ServerConfig,
  workspaceId: string,
  rows: ChatMemberRow[],
): Promise<string[]> {
  const ids = rows
    .filter((r) => !!r.user_id && !r.suspended_at && r.receives_chats !== false && isRoutableChatRole(r.role))
    .map((r) => r.user_id as string);
  if (!ids.length) return ids;
  const state = await resolveLockState(config, workspaceId, ['member']).catch(() => null);
  if (!state?.member?.locked) return ids;
  return ids.filter((id) => !isMemberLocked(state, id));
}

/** Member ids + their global availability prefs for a workspace. */
export async function loadWorkspaceAvailabilityPrefs(
  config: ServerConfig,
  workspaceId: string,
): Promise<WorkspaceAvailabilityPrefs> {
  const sb = getServiceClient(config);
  const { data: members } = await sb
    .from('workspace_members')
    .select(CHAT_MEMBER_COLUMNS)
    .eq('workspace_id', workspaceId);
  const rows = (members || []) as ChatMemberRow[];
  const memberIds = rows
    .map((m) => m.user_id)
    .filter((id): id is string => !!id);
  const prefsByUser = new Map<string, AvailabilityPrefsRow>();
  if (!memberIds.length) return { memberIds, prefsByUser, chatMemberIds: [] };
  const chatMemberIds = await chatReceivingMemberIds(config, workspaceId, rows);

  // Global prefs (workspace_id IS NULL) — where the Account › Availability
  // page writes. Per-workspace overrides can be layered later.
  const { data: prefRows } = await sb
    .from('user_availability_prefs')
    .select(AVAILABILITY_PREFS_COLUMNS)
    .in('user_id', memberIds)
    .is('workspace_id', null);
  for (const r of (prefRows || []) as AvailabilityPrefsRow[]) {
    if (r.user_id) prefsByUser.set(r.user_id, r);
  }
  return { memberIds, prefsByUser, chatMemberIds };
}

/**
 * Operators a visitor may consider reachable right now: the members who
 * count (header), customer-available. `memberCount` is every member, so a
 * workspace whose members all stopped receiving chats reads as offline and
 * only a member-less one fails open.
 */
export async function listCustomerAvailableOperators(
  config: ServerConfig,
  workspaceId: string,
  now: Date = new Date(),
  /** Already loaded by the caller for this request (saves two reads). */
  preloaded?: WorkspaceAvailabilityPrefs,
): Promise<{
  memberCount: number;
  available: Array<{ user_id: string; manual: ManualAvailability; reason: CustomerAvailabilityReason }>;
}> {
  const { memberIds, prefsByUser, chatMemberIds } = preloaded ?? (await loadWorkspaceAvailabilityPrefs(config, workspaceId));
  const available: Array<{ user_id: string; manual: ManualAvailability; reason: CustomerAvailabilityReason }> = [];
  for (const id of chatMemberIds ?? memberIds) {
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
  preloaded?: WorkspaceAvailabilityPrefs,
): Promise<{ anyAvailable: boolean; memberCount: number }> {
  const { memberCount, available } = await listCustomerAvailableOperators(config, workspaceId, now, preloaded);
  return { anyAvailable: available.length > 0, memberCount };
}
