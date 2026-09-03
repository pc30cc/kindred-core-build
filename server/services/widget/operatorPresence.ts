/**
 * Phase 9 — Operator presence resolver.
 *
 * Computes whether ANY workspace member is currently "available" given:
 *   - user_availability_prefs (force_offline / available_when_using_app /
 *     schedule_enabled + weekly_schedule + timezone)
 *   - missing row => treated as the schema defaults from
 *     server/routes/availability.ts (always available when using app).
 *
 * Used by:
 *   - server/services/widget/availability.ts to flip the widget to offline
 *     when nobody on the team is around (Crisp parity).
 *   - server/routes/availability.ts (team endpoint) to render presence
 *     dots in the operator panel.
 *
 * Pure function over raw rows — no IO inside the per-member loop so this
 * is cheap to call from the bootstrap hot path.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
type DayKey = (typeof DAY_KEYS)[number];

export interface OperatorPresence {
  user_id: string;
  state: 'online' | 'offline';
  /** Identity fields, filled from `profiles` so UIs can render name + avatar. */
  full_name?: string | null;
  email?: string | null;
  avatar_url?: string | null;
  reason:
    | 'force_offline'
    | 'available_when_using_app'
    | 'unavailable_when_using_app'
    | 'within_schedule'
    | 'outside_schedule'
    | 'day_disabled'
    | 'not_connected'
    | 'no_prefs';
  /** Last heartbeat bucket seen for this operator (null when never/stale). */
  last_seen_at?: string | null;
}

interface RawPrefs {
  user_id: string;
  force_offline: boolean | null;
  available_when_using_app: boolean | null;
  schedule_enabled: boolean | null;
  timezone: string | null;
  weekly_schedule: any;
}

function partsInTz(date: Date, tz: string) {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      weekday: 'short',
    }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      weekday: 'short',
    }).formatToParts(date);
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

function isWithinIntervals(intervals: any, h: number, m: number) {
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

export function computeOperatorState(
  prefs: RawPrefs | null | undefined,
  now: Date,
): { state: 'online' | 'offline'; reason: OperatorPresence['reason'] } {
  if (!prefs) return { state: 'online', reason: 'no_prefs' };

  if (prefs.force_offline === true) {
    return { state: 'offline', reason: 'force_offline' };
  }

  if (prefs.schedule_enabled !== true) {
    return prefs.available_when_using_app !== false
      ? { state: 'online', reason: 'available_when_using_app' }
      : { state: 'offline', reason: 'unavailable_when_using_app' };
  }

  const tz = prefs.timezone || 'UTC';
  const { h, m, dow } = partsInTz(now, tz);
  const day = (prefs.weekly_schedule || {})[dow];
  if (!day || day.enabled === false) {
    return { state: 'offline', reason: 'day_disabled' };
  }
  return isWithinIntervals(day.intervals, h, m)
    ? { state: 'online', reason: 'within_schedule' }
    : { state: 'offline', reason: 'outside_schedule' };
}

/**
 * Returns presence for every member of the workspace. Members with no row
 * in user_availability_prefs are treated as "no_prefs / online" because
 * that mirrors the Account › Availability default ("Available when using
 * the app").
 */
/**
 * How long a heartbeat keeps an operator "connected". The panel beats every
 * 60s (minute buckets), so 3 minutes tolerates one missed beat + clock skew.
 */
export const PRESENCE_LIVENESS_MS = 3 * 60 * 1000;

export async function listWorkspacePresence(
  config: ServerConfig,
  workspaceId: string,
  now: Date = new Date(),
): Promise<OperatorPresence[]> {
  const sb = getServiceClient(config);
  const { data: members } = await sb
    .from('workspace_members')
    .select('user_id')
    .eq('workspace_id', workspaceId);
  const ids = (members || []).map((m: any) => m.user_id).filter(Boolean);
  if (ids.length === 0) return [];

  // Pull global prefs (workspace_id IS NULL) — that's where the Account
  // › Availability page writes. Per-workspace overrides could be added
  // later without changing call sites.
  const { data: prefRows } = await sb
    .from('user_availability_prefs')
    .select('user_id, force_offline, available_when_using_app, schedule_enabled, timezone, weekly_schedule')
    .in('user_id', ids)
    .is('workspace_id', null);
  const byUser = new Map<string, RawPrefs>();
  for (const r of (prefRows || []) as any[]) byUser.set(r.user_id, r);

  // Identity for UI rendering (name + avatar). Never fails the presence call.
  const profileById = new Map<string, { full_name: string | null; email: string | null; avatar_url: string | null }>();
  const { data: profileRows } = await sb
    .from('profiles')
    .select('id, full_name, email, avatar_url')
    .in('id', ids);
  for (const p of (profileRows || []) as any[]) {
    profileById.set(p.id, { full_name: p.full_name ?? null, email: p.email ?? null, avatar_url: p.avatar_url ?? null });
  }

  // Liveness: prefs say "may be online", heartbeats say "actually connected".
  // Without this, a member who never opens the panel (or has no prefs row at
  // all) would render as online forever.
  const liveSince = new Date(now.getTime() - PRESENCE_LIVENESS_MS).toISOString();
  const connected = new Set<string>();
  const lastSeenById = new Map<string, string>();
  const { data: beats } = await sb
    .from('operator_activity_samples')
    .select('user_id, bucket')
    .eq('workspace_id', workspaceId)
    .in('user_id', ids)
    .gte('bucket', liveSince)
    .order('bucket', { ascending: false })
    .limit(500);
  for (const b of (beats || []) as any[]) {
    connected.add(b.user_id);
    if (!lastSeenById.has(b.user_id)) lastSeenById.set(b.user_id, b.bucket);
  }

  return ids.map((id: string) => {
    const computed = computeOperatorState(byUser.get(id) || null, now);
    const isConnected = connected.has(id);
    const state: 'online' | 'offline' =
      computed.state === 'online' && isConnected ? 'online' : 'offline';
    const reason: OperatorPresence['reason'] =
      computed.state === 'online' && !isConnected ? 'not_connected' : computed.reason;
    const prof = profileById.get(id);
    return {
      user_id: id,
      state,
      reason,
      last_seen_at: lastSeenById.get(id) ?? null,
      full_name: prof?.full_name ?? null,
      email: prof?.email ?? null,
      avatar_url: prof?.avatar_url ?? null,
    };
  });
}


/**
 * Cheap predicate for the widget bootstrap path: are there any operators
 * marked online right now? Returns true also when the workspace has no
 * members at all *during business hours* — failing closed (offline) on
 * bootstrap would be a worse UX than allowing the visitor to leave a
 * message, but the resolver will still flag the reason.
 */
export async function anyOperatorOnline(
  config: ServerConfig,
  workspaceId: string,
  now: Date = new Date(),
): Promise<{ anyOnline: boolean; memberCount: number }> {
  const list = await listWorkspacePresence(config, workspaceId, now);
  return {
    anyOnline: list.some((p) => p.state === 'online'),
    memberCount: list.length,
  };
}
