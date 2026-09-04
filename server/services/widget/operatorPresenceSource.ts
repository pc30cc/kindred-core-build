/**
 * OPERATOR LIVE PRESENCE — provider abstraction (realtime-first).
 *
 * Two implementations behind one contract:
 *
 *   1. REALTIME (primary) — Centrifugo presence over the operator-only
 *      channel `ws:{workspace_id}:operators`. The operator panel subscribes
 *      while its tab is VISIBLE and unsubscribes when hidden/closed, so
 *      channel membership *is* the live signal. Zero PostgreSQL writes.
 *      Used when the effective realtime vendor is Centrifugo, the vendor
 *      advertises `supportsPresence`, `presence_enabled` is on, and the
 *      provider is not down.
 *
 *   2. DATABASE (fallback) — the `operator_presence_live` lease table,
 *      refreshed by the 2-minute operator heartbeat. Used for
 *      polling_builtin / disabled / Supabase (supportsPresence = false)
 *      and whenever Centrifugo presence is unreadable.
 *
 * `operator_activity_samples` is ANALYTICS ONLY and is never consulted here.
 *
 * Production-safety rules encoded below:
 *   • A Centrifugo presence read that FAILS never means "everyone offline".
 *     The last good snapshot is honoured for a short grace window, and the
 *     DB lease is consulted with an extended liveness window during the
 *     transition, so routing never drops every candidate because the
 *     presence backend blipped.
 *   • Read amplification is bounded: a very short TTL cache plus
 *     single-flight coalescing per workspace, so N concurrent team-presence
 *     / routing / widget reads collapse into one Centrifugo API call.
 *   • Nothing here is durable state — the caches are process-local hints
 *     only, so multi-instance correctness is preserved.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import {
  getCentrifugoDriver,
  resolveRealtimeProvider,
} from '../realtime/index.js';
import { buildOperatorPresenceChannelName } from '../realtime/types.js';

/** Heartbeat cadence of the operator panel (fallback mode only). */
export const PRESENCE_HEARTBEAT_MS = 120_000;
/** DB-lease liveness window = 2× heartbeat + skew. */
export const PRESENCE_LIVENESS_MS = 5 * 60 * 1000;
/** Extra slack applied to the DB lease right after a realtime→DB transition. */
export const PRESENCE_TRANSITION_GRACE_MS = 2 * 60 * 1000;
/** How long a last-known-good realtime snapshot survives a failed read. */
const REALTIME_SNAPSHOT_GRACE_MS = 60_000;
/** TTL of the presence read cache (request coalescing, not a source of truth). */
const READ_CACHE_TTL_MS = 3_000;
/** How long the resolved presence mode is cached (avoids a health probe per read). */
const MODE_CACHE_TTL_MS = 15_000;
/** Bound on process-local maps. */
const CACHE_MAX = 2_000;

export type PresenceMode = 'realtime' | 'database';

export interface PresenceSnapshot {
  mode: PresenceMode;
  /** Operator user ids considered connected right now. */
  connected: Set<string>;
  /** Best-effort last-seen per user (DB mode only; realtime is instantaneous). */
  lastSeen: Map<string, string>;
  /** True when realtime presence was expected but unreadable (grace path). */
  degraded: boolean;
}

interface ModeState {
  mode: PresenceMode;
  checkedAt: number;
}

let modeState: ModeState | null = null;

interface RealtimeSnapshot {
  users: Set<string>;
  at: number;
}

const realtimeCache = new Map<string, RealtimeSnapshot>();
const inflight = new Map<string, Promise<Set<string> | null>>();
/** Timestamp until which the DB fallback lease is considered authoritative. */
let fallbackUntil = 0;

function boundedSet<K, V>(map: Map<K, V>, key: K, value: V) {
  if (map.size >= CACHE_MAX) map.clear();
  map.set(key, value);
}

/**
 * Resolve which presence backend is authoritative right now. Cached for a
 * few seconds so hot paths (routing, widget bootstrap, team presence poll)
 * don't each run a provider health probe.
 */
export async function resolvePresenceMode(
  config: ServerConfig,
  now: number = Date.now(),
): Promise<PresenceMode> {
  if (modeState && now - modeState.checkedAt < MODE_CACHE_TTL_MS) return modeState.mode;
  let mode: PresenceMode = 'database';
  try {
    const resolved = await resolveRealtimeProvider(config);
    if (
      resolved.effective_vendor === 'centrifugo' &&
      resolved.capabilities.supportsPresence &&
      resolved.public_config.presence_enabled === true &&
      resolved.health.status !== 'down'
    ) {
      mode = 'realtime';
    }
  } catch {
    mode = 'database';
  }
  modeState = { mode, checkedAt: now };
  return mode;
}

/** Test/ops hook — drop the cached mode + presence reads. */
export function resetPresenceSourceCache(): void {
  modeState = null;
  realtimeCache.clear();
  inflight.clear();
  fallbackUntil = 0;
}

/**
 * True when the DB lease must be refreshed by the heartbeat, i.e. we are NOT
 * in healthy realtime-presence mode. In Centrifugo-healthy mode this returns
 * false and the heartbeat performs ZERO live-presence writes.
 */
export async function shouldWriteFallbackPresence(
  config: ServerConfig,
  now: number = Date.now(),
): Promise<boolean> {
  if (now < fallbackUntil) return true;
  return (await resolvePresenceMode(config, now)) === 'database';
}

async function readCentrifugoPresence(
  config: ServerConfig,
  workspaceId: string,
  now: number,
): Promise<Set<string> | null> {
  const cached = realtimeCache.get(workspaceId);
  if (cached && now - cached.at < READ_CACHE_TTL_MS) return cached.users;

  const pending = inflight.get(workspaceId);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const driver = await getCentrifugoDriver(config);
      if (!driver) return null;
      const users = await driver.presenceUsers(buildOperatorPresenceChannelName(workspaceId));
      if (!users) return null;
      // Subject format is `op_<user_id>` (server-authoritative, minted from
      // the session — never from a client-supplied id).
      const ids = new Set<string>();
      for (const u of users) {
        if (u.startsWith('op_')) ids.add(u.slice(3));
      }
      boundedSet(realtimeCache, workspaceId, { users: ids, at: Date.now() });
      return ids;
    } catch {
      return null;
    } finally {
      inflight.delete(workspaceId);
    }
  })();
  inflight.set(workspaceId, promise);
  return promise;
}

async function readDatabasePresence(
  config: ServerConfig,
  workspaceId: string,
  userIds: string[],
  now: number,
  windowMs: number,
): Promise<{ connected: Set<string>; lastSeen: Map<string, string> }> {
  const sb = getServiceClient(config);
  const since = new Date(now - windowMs).toISOString();
  const connected = new Set<string>();
  const lastSeen = new Map<string, string>();
  const { data } = await sb
    .from('operator_presence_live')
    .select('user_id, last_seen_at')
    .eq('workspace_id', workspaceId)
    .in('user_id', userIds)
    .gte('last_seen_at', since);
  for (const row of (data || []) as Array<{ user_id: string; last_seen_at: string }>) {
    connected.add(row.user_id);
    const prev = lastSeen.get(row.user_id);
    if (!prev || prev < row.last_seen_at) lastSeen.set(row.user_id, row.last_seen_at);
  }
  return { connected, lastSeen };
}

/**
 * THE presence contract. Returns which of `userIds` are live right now.
 */
export async function getConnectedOperators(
  config: ServerConfig,
  workspaceId: string,
  userIds: string[],
  now: Date = new Date(),
): Promise<PresenceSnapshot> {
  const ts = now.getTime();
  if (userIds.length === 0) {
    return { mode: 'database', connected: new Set(), lastSeen: new Map(), degraded: false };
  }

  const mode = await resolvePresenceMode(config, ts);

  if (mode === 'realtime') {
    const users = await readCentrifugoPresence(config, workspaceId, ts);
    if (users) {
      fallbackUntil = 0;
      const connected = new Set(userIds.filter((id) => users.has(id)));
      return { mode: 'realtime', connected, lastSeen: new Map(), degraded: false };
    }

    // Presence read failed. 1) honour the last good snapshot briefly, so a
    // single API blip never marks the whole team offline.
    const stale = realtimeCache.get(workspaceId);
    if (stale && ts - stale.at < REALTIME_SNAPSHOT_GRACE_MS) {
      const connected = new Set(userIds.filter((id) => stale.users.has(id)));
      return { mode: 'realtime', connected, lastSeen: new Map(), degraded: true };
    }

    // 2) Transition to the DB lease and tell the heartbeat to resume writing.
    //    Widen the liveness window for one heartbeat interval + grace so
    //    operators whose lease went stale while realtime was healthy are not
    //    dropped before their next beat lands.
    fallbackUntil = ts + PRESENCE_HEARTBEAT_MS + PRESENCE_TRANSITION_GRACE_MS;
    modeState = { mode: 'database', checkedAt: ts };
    const db = await readDatabasePresence(
      config,
      workspaceId,
      userIds,
      ts,
      PRESENCE_LIVENESS_MS + PRESENCE_HEARTBEAT_MS + PRESENCE_TRANSITION_GRACE_MS,
    );
    return { mode: 'database', connected: db.connected, lastSeen: db.lastSeen, degraded: true };
  }

  const windowMs =
    ts < fallbackUntil
      ? PRESENCE_LIVENESS_MS + PRESENCE_HEARTBEAT_MS + PRESENCE_TRANSITION_GRACE_MS
      : PRESENCE_LIVENESS_MS;
  const db = await readDatabasePresence(config, workspaceId, userIds, ts, windowMs);
  return { mode: 'database', connected: db.connected, lastSeen: db.lastSeen, degraded: false };
}
