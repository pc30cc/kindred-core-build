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
 *   customer-available + connected + act <5m     → active
 *   customer-available + connected + act ≥5m     → away
 *   customer-available + NOT connected           → disconnected
 *
 * `state` ('online' | 'offline') is kept for backward compatibility and means
 * "connected AND customer-available" (active or away).
 *
 * Presence source: `operatorPresenceSource.ts` (Centrifugo channel membership,
 * with the bounded DB-lease fallback). Activity: `operatorActivity.ts`
 * (ephemeral; zero new writes).
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { createStorageUrlResolver, userAvatarUrlMap } from '../storage/urlResolver.js';
import { getConnectedOperators } from './operatorPresenceSource.js';
import {
  AVAILABILITY_PREFS_COLUMNS,
  computeCustomerAvailability,
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
 * Records a fallback live-presence lease beat. Single-row UPSERT; no history.
 * Called from the heartbeat route ONLY when the presence provider is in
 * database-fallback mode (see `shouldWriteFallbackPresence`).
 */
export async function recordOperatorPresenceBeat(
  config: ServerConfig,
  workspaceId: string,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  const sb = getServiceClient(config);
  const iso = now.toISOString();
  const { error } = await sb
    .from('operator_presence_live')
    .upsert(
      { workspace_id: workspaceId, user_id: userId, last_seen_at: iso, updated_at: iso },
      { onConflict: 'workspace_id,user_id' },
    );
  if (error) console.warn('[presence] fallback lease write failed:', error.message);
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

  const { data: prefRows } = await sb
    .from('user_availability_prefs')
    .select(AVAILABILITY_PREFS_COLUMNS)
    .in('user_id', ids)
    .is('workspace_id', null);
  const byUser = new Map<string, RawPrefs>();
  for (const r of (prefRows || [])) byUser.set(r.user_id, r);

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
    const isActive = lastActivity !== null && ts - lastActivity < OPERATOR_ACTIVITY_ACTIVE_MS;

    let presence_state: OperatorPresenceState;
    let reason: OperatorPresence['reason'];
    if (customer.availability === 'unavailable') {
      presence_state = 'offline';
      reason =
        customer.reason === 'manual_offline' ? 'force_offline'
        : customer.reason === 'manual_invisible' ? 'unavailable_when_using_app'
        : customer.reason === 'day_disabled' ? 'day_disabled'
        : 'outside_schedule';
    } else if (!isConnected) {
      presence_state = 'disconnected';
      reason = 'not_connected';
    } else if (!isActive) {
      presence_state = 'away';
      reason = 'inactive';
    } else {
      presence_state = 'active';
      reason =
        customer.reason === 'within_schedule' ? 'within_schedule'
        : customer.reason === 'no_prefs' ? 'no_prefs'
        : 'available_when_using_app';
    }

    const prof = profileById.get(id);
    return {
      user_id: id,
      state: presence_state === 'active' || presence_state === 'away' ? 'online' : 'offline',
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
