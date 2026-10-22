/**
 * INTERNAL OPERATOR PRESENCE — what teammates see about each other.
 *
 * THREE INDEPENDENT CONCEPTS (never merge them again):
 *
 *   1. Customer-facing availability → `customerAvailability.ts`
 *      (manual status + personal schedule ONLY; no connection input).
 *   2. Internal presence (this file) → `active | away | disconnected | offline`
 *      (Centrifugo connection + 5-minute activity threshold).
 *   3. Routing eligibility → `chatRouting.ts`.
 *
 * Internal decision matrix:
 *
 *   manual offline/invisible OR schedule closed  → offline
 *   manual away + connected                      → away (manual: never routed)
 *   manual away + NOT connected                  → offline
 *   customer-available + connected + act <5m     → active
 *   customer-available + connected + act ≥5m     → away
 *   customer-available + NOT connected           → disconnected
 *
 * `state` ('online' | 'offline') is kept for backward compatibility and means
 * "connected AND customer-available" (active or away; not a manual away).
 *
 * Presence source: `operatorPresenceSource.ts` (Centrifugo channel membership,
 * with the bounded DB-lease fallback). Activity: `operatorActivity.ts`
 * (ephemeral; zero new writes).
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { createStorageUrlResolver, userAvatarUrlMap } from '../storage/urlResolver.js';
import { getConnectedOperators, PRESENCE_LIVENESS_MS } from './operatorPresenceSource.js';
import {
  computeCustomerAvailability,
  readGlobalAvailabilityPrefs,
  type AvailabilityPrefsRow,
  type CustomerAvailability,
  type ManualAvailability,
} from './customerAvailability.js';
import {
  getOperatorLastActivity,
  OPERATOR_ACTIVITY_ACTIVE_MS,
} from './operatorActivity.js';

export type OperatorPresenceState = 'active' | 'away' | 'disconnected' | 'offline';

export interface OperatorPresence {
  user_id: string;
  /** LEGACY: connected AND customer-available. Kept for existing callers. */
  state: 'online' | 'offline';
  /** Internal, teammate-facing presence. */
  presence_state: OperatorPresenceState;
  /** Customer-facing availability — independent of any connection. */
  customer_availability: CustomerAvailability;
  /** Canonical manual status. */
  manual: ManualAvailability;
  /** True when a live connection was observed for this operator. */
  connected: boolean;
  /** Identity fields, filled from `profiles` so UIs can render name + avatar. */
  full_name?: string | null;
  email?: string | null;
  avatar_url?: string | null;
  reason:
    | 'force_offline'
    | 'manual_invisible'
    | 'manual_away'
    | 'available_when_using_app'
    | 'unavailable_when_using_app'
    | 'always_available'
    | 'within_schedule'
    | 'outside_schedule'
    | 'day_disabled'
    | 'not_connected'
    | 'inactive'
    | 'no_prefs';
  /** Last live-presence beat seen for this operator (null when never/stale). */
  last_seen_at?: string | null;
  /** Last known interaction (ISO) — internal activity only. */
  last_activity_at?: string | null;
}

type RawPrefs = AvailabilityPrefsRow & { user_id: string };

/**
 * LEGACY SHIM — old callers asked "is this operator online?" meaning
 * "customer-available". It now delegates to the customer-facing resolver so
 * there is exactly one implementation of the schedule/manual rules.
 */
export function computeOperatorState(
  prefs: RawPrefs | null | undefined,
  now: Date,
): { state: 'online' | 'offline'; reason: OperatorPresence['reason'] } {
  const r = computeCustomerAvailability(prefs, now);
  const reasonMap: Record<string, OperatorPresence['reason']> = {
    manual_offline: 'force_offline',
    manual_invisible: 'unavailable_when_using_app',
    manual_away: 'manual_away',
    always_available: 'available_when_using_app',
    within_schedule: 'within_schedule',
    outside_schedule: 'outside_schedule',
    day_disabled: 'day_disabled',
    no_prefs: 'no_prefs',
  };
  return {
    state: r.availability === 'available' ? 'online' : 'offline',
    reason: reasonMap[r.reason] || 'no_prefs',
  };
}

export { PRESENCE_HEARTBEAT_MS, PRESENCE_LIVENESS_MS } from './operatorPresenceSource.js';

/**
 * The source of a beat that names none: the desktop and phone apps, and
 * panels from before migration 282b. Such a client never sends a beacon, so
 * its part of the lease only expires.
 */
export const LEGACY_PRESENCE_SOURCE = '_';

const PRESENCE_SOURCE_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** A panel tab's source id as the client sent it, or null when it is not one. */
export function presenceSourceOf(value: unknown): string | null {
  return typeof value === 'string' && PRESENCE_SOURCE_RE.test(value) ? value : null;
}

/** "Function does not exist" (a database before migration 282b): PostgREST PGRST202 / Postgres 42883. */
function isMissingFunction(error: { code?: unknown; message?: unknown } | null | undefined): boolean {
  const code = String(error?.code ?? '');
  return code === '42883' || code === 'PGRST202'
    || /could not find the function .*operator_presence_|function public\.operator_presence_\w+\(.*\) does not exist/i.test(String(error?.message ?? ''));
}

/** Until when this process writes the plain lease (282b's functions were missing), epoch ms. */
let presenceSourcesMissingUntil = 0;
/** How long a missing function is believed missing before it is tried again. */
const PRESENCE_SOURCES_RECHECK_MS = 10 * 60_000;

/** Test hook. */
export function __resetPresenceSourcesProbe(): void {
  presenceSourcesMissingUntil = 0;
}

/**
 * Records a live-presence lease beat: one row per (workspace, operator), no
 * history. Since migration 282b the row also records which source beat
 * (`source`: a panel tab's id, else LEGACY_PRESENCE_SOURCE), so the beacon of
 * a tab that went away ends only that tab's part (endOperatorPresenceSource).
 * Before 282b — the function is missing — the plain upsert, as always.
 */
export async function recordOperatorPresenceBeat(
  config: ServerConfig,
  workspaceId: string,
  userId: string,
  now: Date = new Date(),
  source: string = LEGACY_PRESENCE_SOURCE,
): Promise<boolean> {
  const sb = getServiceClient(config);
  const iso = now.toISOString();
  if (now.getTime() >= presenceSourcesMissingUntil) {
    const { error } = await sb.rpc('operator_presence_beat', {
      p_workspace_id: workspaceId,
      p_user_id: userId,
      p_source: source,
      p_now: iso,
      p_window_ms: PRESENCE_LIVENESS_MS,
    });
    if (!error) return true;
    if (!isMissingFunction(error)) {
      console.warn('[presence] lease write failed:', error.message);
      return false;
    }
    presenceSourcesMissingUntil = now.getTime() + PRESENCE_SOURCES_RECHECK_MS;
  }
  const { error } = await sb
    .from('operator_presence_live')
    .upsert(
      { workspace_id: workspaceId, user_id: userId, last_seen_at: iso, updated_at: iso },
      { onConflict: 'workspace_id,user_id' },
    );
  if (error) console.warn('[presence] fallback lease write failed:', error.message);
  return !error;
}

/**
 * A panel tab went away (its beacon, R-11): its part of the operator's lease
 * ends now instead of in up to PRESENCE_LIVENESS_MS. 'present': another tab
 * or app of theirs beat within the window, so they are still here; 'gone':
 * nothing else holds the lease, so routing and teammates no longer see them
 * connected (unless Centrifugo still does); 'unknown': nothing was changed
 * (no lease, a lease from before 282b, or 282b not applied, or the write
 * failed) and the lease expires as it always did. Never throws.
 */
export async function endOperatorPresenceSource(
  config: ServerConfig,
  workspaceId: string,
  userId: string,
  source: string,
  now: Date = new Date(),
): Promise<'present' | 'gone' | 'unknown'> {
  try {
    const { data, error } = await getServiceClient(config).rpc('operator_presence_leave', {
      p_workspace_id: workspaceId,
      p_user_id: userId,
      p_source: source,
      p_now: now.toISOString(),
      p_window_ms: PRESENCE_LIVENESS_MS,
    });
    if (error) {
      if (!isMissingFunction(error)) console.warn('[presence] lease end failed:', error.message);
      return 'unknown';
    }
    return data === 'present' || data === 'gone' ? data : 'unknown';
  } catch (err) {
    console.warn('[presence] lease end failed:', err instanceof Error ? err.message : err);
    return 'unknown';
  }
}

/**
 * The internal decision matrix (header) for one operator: customer
 * availability first, then the live connection, then the 5-minute activity
 * threshold. Shared by listWorkspacePresence and readRoutingPresence.
 */
function classifyPresence(
  customer: ReturnType<typeof computeCustomerAvailability>,
  isConnected: boolean,
  lastActivity: number | null,
  ts: number,
): { presence_state: OperatorPresenceState; reason: OperatorPresence['reason'] } {
  const isActive = lastActivity !== null && ts - lastActivity < OPERATOR_ACTIVITY_ACTIVE_MS;
  // Away by their own choice (R-26): teammates see them away while they are
  // here; routing reads `manualAway` and gives them nothing new.
  if (customer.reason === 'manual_away') {
    return { presence_state: isConnected ? 'away' : 'offline', reason: 'manual_away' };
  }
  if (customer.availability === 'unavailable') {
    return {
      presence_state: 'offline',
      reason:
        customer.reason === 'manual_offline' ? 'force_offline'
        : customer.reason === 'manual_invisible' ? 'unavailable_when_using_app'
        : customer.reason === 'day_disabled' ? 'day_disabled'
        : 'outside_schedule',
    };
  }
  if (!isConnected) return { presence_state: 'disconnected', reason: 'not_connected' };
  if (!isActive) return { presence_state: 'away', reason: 'inactive' };
  return {
    presence_state: 'active',
    reason:
      customer.reason === 'within_schedule' ? 'within_schedule'
      : customer.reason === 'no_prefs' ? 'no_prefs'
      : 'available_when_using_app',
  };
}

/** One operator's presence as chat routing reads it. */
export interface RoutingPresence {
  state: OperatorPresenceState;
  /** Last known interaction (epoch ms); null = none seen (e.g. since a restart). */
  lastActivityAt: number | null;
  /** They chose "Away from desk" (migration 282): no new automatic chats, whatever `state` says. */
  manualAway?: boolean;
}

/**
 * The presence of the given members only, for chat routing: the same matrix
 * as listWorkspacePresence, without the member list, names or avatars (the
 * caller already knows whom it may route to). Never throws: a failed
 * connection or activity lookup reads as "not connected" / "no activity".
 */
export async function readRoutingPresence(
  config: ServerConfig,
  workspaceId: string,
  userIds: string[],
  now: Date = new Date(),
): Promise<Map<string, RoutingPresence>> {
  const out = new Map<string, RoutingPresence>();
  const ids = Array.from(new Set(userIds.filter(Boolean)));
  if (ids.length === 0) return out;
  const byUser = new Map<string, RawPrefs>();
  try {
    const { data: prefRows } = await readGlobalAvailabilityPrefs(getServiceClient(config), ids);
    for (const r of (prefRows || []) as RawPrefs[]) byUser.set(r.user_id, r);
  } catch { /* no prefs: everyone reads as available, as in the matrix */ }
  let connected = new Set<string>();
  try {
    connected = (await getConnectedOperators(config, workspaceId, ids, now)).connected;
  } catch (err) {
    console.warn('[presence] routing connection lookup failed:', err instanceof Error ? err.message : err);
  }
  let activityById = new Map<string, number>();
  try {
    activityById = await getOperatorLastActivity(config, workspaceId, ids, now);
  } catch { /* internal detail only */ }
  const ts = now.getTime();
  for (const id of ids) {
    const customer = computeCustomerAvailability(byUser.get(id) || null, now);
    const lastActivity = activityById.get(id) ?? null;
    out.set(id, {
      state: classifyPresence(customer, connected.has(id), lastActivity, ts).presence_state,
      lastActivityAt: lastActivity,
      ...(customer.manual === 'away' ? { manualAway: true } : {}),
    });
  }
  return out;
}

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
  const ids = (members || []).map((m) => m.user_id).filter(Boolean);
  if (ids.length === 0) return [];

  const { data: prefRows } = await readGlobalAvailabilityPrefs(sb, ids);
  const byUser = new Map<string, RawPrefs>();
  for (const r of (prefRows || []) as RawPrefs[]) byUser.set(r.user_id, r);

  // Identity for UI rendering (name + avatar). Never fails the presence call.
  const profileById = new Map<string, { full_name: string | null; email: string | null; avatar_url: string | null }>();
  const { data: profileRows } = await sb
    .from('profiles')
    .select('id, full_name, email, avatar_storage_key')
    .in('id', ids);
  // Avatars are derived from the stored key for the provider that is primary
  // right now — one provider resolution for the whole batch, no per-row I/O.
  const avatarUrls = await userAvatarUrlMap(createStorageUrlResolver(config), (profileRows || []));
  for (const p of (profileRows || [])) {
    profileById.set(p.id, { full_name: p.full_name ?? null, email: p.email ?? null, avatar_url: avatarUrls.get(p.id) ?? null });
  }

  // Connection + activity are INTERNAL signals only. A failure here can never
  // change customer-facing availability, which is computed above from prefs.
  let connected = new Set<string>();
  let lastSeenById = new Map<string, string>();
  try {
    const snapshot = await getConnectedOperators(config, workspaceId, ids, now);
    connected = snapshot.connected;
    lastSeenById = snapshot.lastSeen;
  } catch (err) {
    console.warn('[presence] connection lookup failed:', err?.message);
  }
  let activityById = new Map<string, number>();
  try {
    activityById = await getOperatorLastActivity(config, workspaceId, ids, now);
  } catch { /* internal detail only */ }

  const ts = now.getTime();
  return ids.map((id: string) => {
    const customer = computeCustomerAvailability(byUser.get(id) || null, now);
    const isConnected = connected.has(id);
    const lastActivity = activityById.get(id) ?? null;
    const { presence_state, reason } = classifyPresence(customer, isConnected, lastActivity, ts);

    const prof = profileById.get(id);
    return {
      user_id: id,
      state: (presence_state === 'active' || presence_state === 'away') && customer.availability === 'available' ? 'online' : 'offline',
      presence_state,
      customer_availability: customer.availability,
      manual: customer.manual,
      connected: isConnected,
      reason,
      last_seen_at: lastSeenById.get(id) ?? null,
      last_activity_at: lastActivity ? new Date(lastActivity).toISOString() : null,
      full_name: prof?.full_name ?? null,
      email: prof?.email ?? null,
      avatar_url: prof?.avatar_url ?? null,
    };
  });
}

/**
 * DEPRECATED for customer-facing decisions — use
 * `anyCustomerAvailableOperator()` from `customerAvailability.ts`.
 * Retained for internal callers that genuinely need "someone connected".
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
