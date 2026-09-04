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
 * ─── TRANSITION HANDOFF (realtime → database) ─────────────────────────
 * While Centrifugo is healthy nobody writes the lease, so at the moment of
 * a failure the `operator_presence_live` row for a connected operator may be
 * HOURS old — or missing entirely. Widening the DB liveness window cannot
 * fix that. Instead the transition carries the last known-good realtime
 * roster: on the FIRST failed read we
 *   a) publish a shared fallback entry (see below) containing that roster,
 *      so every instance immediately resumes lease writes on the next beat,
 *   b) treat the roster as connected until `handoff_until`
 *      (= heartbeat interval + grace), i.e. long enough for the first
 *      fallback heartbeat to land,
 *   c) union the roster with the DB lease, so as soon as real beats arrive
 *      the lease becomes authoritative and the roster simply expires.
 * Result: no transient `not_connected`, no routing/widget flap, and no
 * periodic writes in the healthy path.
 *
 * ─── SHARED CIRCUIT-BREAKER STATE (multi-instance) ────────────────────
 * `operator_presence_fallback_state` holds at most one row per failing
 * scope — `global` (Centrifugo itself unreachable) or a single workspace id
 * (that channel's presence read failed). It is written ONLY on activation,
 * renewal (when its TTL is half-spent) and recovery — never per heartbeat —
 * and it auto-expires, so one workspace's blip never pins the whole platform
 * into high-write fallback and a stale row cannot survive a restart storm.
 * Every instance reads it through a 5-second process-local cache, so the
 * heartbeat path costs at most one tiny SELECT per instance per 5s.
 *
 * Read amplification is bounded elsewhere too: a very short TTL cache plus
 * single-flight coalescing per workspace collapses N concurrent
 * team-presence / routing / widget reads into one Centrifugo API call.
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
/** Roster handoff window: one heartbeat interval + grace. */
const HANDOFF_MS = PRESENCE_HEARTBEAT_MS + PRESENCE_TRANSITION_GRACE_MS;
/** Auto-expiry of a fallback entry when nothing refreshes it. */
const FALLBACK_TTL_MS = 10 * 60 * 1000;
/** TTL of the presence read cache (request coalescing, not a source of truth). */
const READ_CACHE_TTL_MS = 3_000;
/** TTL of the shared fallback-state cache. */
const SHARED_STATE_TTL_MS = 5_000;
/** How long the resolved presence mode is cached (avoids a health probe per read). */
const MODE_CACHE_TTL_MS = 15_000;
/** Bound on process-local maps and on the persisted roster. */
const CACHE_MAX = 2_000;
const ROSTER_MAX = 200;

const GLOBAL_SCOPE = 'global';
const FALLBACK_TABLE = 'operator_presence_fallback_state';

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
  /**
   * True when Centrifugo IS the configured primary presence backend but is
   * currently unusable (health down / degraded resolution). That is a
   * realtime→database TRANSITION and needs the same breaker + bounded
   * handoff as a failed presence read — even though the presence API was
   * never called. False for native database mode (polling / disabled /
   * Supabase without presence), where the lease has always been written.
   */
  realtimeFailure: boolean;
  checkedAt: number;
}

interface FallbackEntry {
  scope: string;
  reason: string | null;
  /** Workspace-scoped roster ONLY. The global entry never carries one. */
  roster: string[];
  /**
   * False ⇒ the roster is not a trustworthy full list (global breaker, cold
   * instance with no snapshot, or a workspace with more operators than the
   * bounded cap). Handoff then fails OPEN instead of silently marking the
   * missing operators offline.
   */
  rosterComplete: boolean;
  handoffUntil: number;
  expiresAt: number;
}

interface RealtimeSnapshot {
  users: Set<string>;
  at: number;
}

let modeState: ModeState | null = null;
const realtimeCache = new Map<string, RealtimeSnapshot>();
const inflight = new Map<string, Promise<PresenceRead>>();

/** Process-local view of the shared circuit-breaker table. */
let fallbackCache = new Map<string, FallbackEntry>();
let fallbackLoadedAt = 0;
let fallbackInflight: Promise<Map<string, FallbackEntry>> | null = null;

function boundedSet<K, V>(map: Map<K, V>, key: K, value: V) {
  if (map.size >= CACHE_MAX) map.clear();
  map.set(key, value);
}

/* ───────────────────────── shared fallback state ───────────────────────── */

async function loadFallbackState(
  config: ServerConfig,
  now: number,
): Promise<Map<string, FallbackEntry>> {
  if (now - fallbackLoadedAt < SHARED_STATE_TTL_MS) return fallbackCache;
  if (fallbackInflight) return fallbackInflight;

  fallbackInflight = (async () => {
    try {
      const sb = getServiceClient(config);
      const { data } = await sb
        .from(FALLBACK_TABLE)
        .select('scope, reason, roster, roster_complete, handoff_until, expires_at')
        .gte('expires_at', new Date(now).toISOString());
      const next = new Map<string, FallbackEntry>();
      for (const row of (data || []) as Array<Record<string, any>>) {
        next.set(String(row.scope), {
          scope: String(row.scope),
          reason: row.reason ?? null,
          roster: Array.isArray(row.roster) ? row.roster.map(String) : [],
          rosterComplete: row.roster_complete === true,
          handoffUntil: Date.parse(row.handoff_until) || 0,
          expiresAt: Date.parse(row.expires_at) || 0,
        });
      }
      fallbackCache = next;
      fallbackLoadedAt = now;
    } catch {
      // Shared state unreadable: keep the last view. Failing open here would
      // silently stop lease writes during an outage.
      fallbackLoadedAt = now;
    } finally {
      fallbackInflight = null;
    }
    return fallbackCache;
  })();
  return fallbackInflight;
}

function activeEntry(
  state: Map<string, FallbackEntry>,
  scope: string,
  now: number,
): FallbackEntry | null {
  const entry = state.get(scope);
  return entry && entry.expiresAt > now ? entry : null;
}

/**
 * Publish/renew a fallback entry. Writes happen only on activation and when
 * the entry is more than half-spent — never on the heartbeat path.
 */
async function activateFallback(
  config: ServerConfig,
  scope: string,
  reason: string,
  roster: string[] | null,
  now: number,
): Promise<FallbackEntry> {
  const state = await loadFallbackState(config, now);
  const existing = activeEntry(state, scope, now);
  const expiresAt = now + FALLBACK_TTL_MS;
  const handoffUntil = existing ? existing.handoffUntil : now + HANDOFF_MS;

  if (existing && existing.expiresAt - now > FALLBACK_TTL_MS / 2) return existing;

  // `roster === null` means "no trustworthy roster" (global breaker, cold
  // instance, or an oversized workspace). Never truncate silently: a roster
  // larger than the bounded cap is persisted as INCOMPLETE and fails open.
  const keepExisting = !!existing && existing.handoffUntil > now;
  const rosterComplete = keepExisting
    ? existing!.rosterComplete
    : roster !== null && roster.length <= ROSTER_MAX;
  const entry: FallbackEntry = {
    scope,
    reason,
    roster: keepExisting ? existing!.roster : rosterComplete ? roster! : [],
    rosterComplete,
    handoffUntil,
    expiresAt,
  };
  fallbackCache.set(scope, entry);
  try {
    const sb = getServiceClient(config);
    await sb.from(FALLBACK_TABLE).upsert(
      {
        scope,
        reason,
        roster: entry.roster,
        roster_complete: entry.rosterComplete,
        handoff_until: new Date(entry.handoffUntil).toISOString(),
        expires_at: new Date(entry.expiresAt).toISOString(),
        updated_at: new Date(now).toISOString(),
      },
      { onConflict: 'scope' },
    );
  } catch {
    // Best effort — the local entry still drives this instance.
  }
  return entry;
}

/** Recovery — remove the entry so every instance stops writing leases. */
async function clearFallback(config: ServerConfig, scope: string, now: number): Promise<void> {
  const state = await loadFallbackState(config, now);
  if (!state.has(scope)) return;
  fallbackCache.delete(scope);
  try {
    const sb = getServiceClient(config);
    await sb.from(FALLBACK_TABLE).delete().eq('scope', scope);
  } catch {
    /* best effort */
  }
}

/**
 * Resolve which presence backend is authoritative right now. Cached for a
 * few seconds so hot paths (routing, widget bootstrap, team presence poll)
 * don't each run a provider health probe.
 */
async function resolvePresenceState(
  config: ServerConfig,
  now: number = Date.now(),
): Promise<ModeState> {
  if (modeState && now - modeState.checkedAt < MODE_CACHE_TTL_MS) return modeState;
  let mode: PresenceMode = 'database';
  let realtimeFailure = false;
  try {
    const resolved = await resolveRealtimeProvider(config);
    const centrifugoPrimary =
      resolved.effective_vendor === 'centrifugo' &&
      resolved.capabilities.supportsPresence &&
      resolved.public_config.presence_enabled === true;
    if (centrifugoPrimary && resolved.health.status !== 'down') mode = 'realtime';
    else if (centrifugoPrimary) realtimeFailure = true;
  } catch {
    // Resolver itself failed: we cannot prove realtime is primary, but we
    // also cannot prove it is not. Treat it as a realtime failure so the
    // transition handoff protects operators.
    realtimeFailure = true;
  }
  modeState = { mode, realtimeFailure, checkedAt: now };
  return modeState;
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
  return (await resolvePresenceState(config, now)).mode;
}

/** Test/ops hook — drop every process-local cache. */
export function resetPresenceSourceCache(): void {
  modeState = null;
  realtimeCache.clear();
  inflight.clear();
  fallbackCache = new Map();
  fallbackLoadedAt = 0;
  fallbackInflight = null;
}

/**
 * True when the DB lease must be refreshed by the heartbeat, i.e. we are NOT
 * in healthy realtime-presence mode. In Centrifugo-healthy mode this returns
 * false and the heartbeat performs ZERO live-presence writes.
 *
 * `workspaceId` lets a workspace-scoped presence failure switch only that
 * workspace's operators into lease writes — a single bad channel never puts
 * the whole platform into high-write mode.
 */
export async function shouldWriteFallbackPresence(
  config: ServerConfig,
  now: number = Date.now(),
  workspaceId?: string,
): Promise<boolean> {
  const state = await loadFallbackState(config, now);
  if (activeEntry(state, GLOBAL_SCOPE, now)) return true;
  if (workspaceId && activeEntry(state, workspaceId, now)) return true;
  return (await resolvePresenceMode(config, now)) === 'database';
}

/* ───────────────────────────── presence reads ──────────────────────────── */

type PresenceRead =
  | { users: Set<string>; failure: null }
  | { users: null; failure: 'global' | 'workspace' };

async function readCentrifugoPresence(
  config: ServerConfig,
  workspaceId: string,
  now: number,
): Promise<PresenceRead> {
  const cached = realtimeCache.get(workspaceId);
  if (cached && now - cached.at < READ_CACHE_TTL_MS) return { users: cached.users, failure: null };

  const pending = inflight.get(workspaceId);
  if (pending) return pending;

  const promise = (async (): Promise<PresenceRead> => {
    const readAt = now;
    try {
      const driver = await getCentrifugoDriver(config);
      // No driver at all ⇒ the provider itself is unusable ⇒ global scope.
      if (!driver) return { users: null, failure: 'global' };
      const users = await driver.presenceUsers(buildOperatorPresenceChannelName(workspaceId));
      // Presence unreadable for THIS channel only ⇒ workspace scope.
      if (!users) return { users: null, failure: 'workspace' };
      // Subject format is `op_<user_id>` (server-authoritative, minted from
      // the session — never from a client-supplied id).
      const ids = new Set<string>();
      for (const u of users) {
        if (u.startsWith('op_')) ids.add(u.slice(3));
      }
      boundedSet(realtimeCache, workspaceId, { users: ids, at: readAt });
      return { users: ids, failure: null };
    } catch {
      return { users: null, failure: 'global' };
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
 * Transition handoff. Inside the bounded handoff window:
 *   • with a COMPLETE workspace roster ⇒ exactly those operators stay
 *     connected (precise, no false-online);
 *   • otherwise (global breaker, cold instance with no snapshot, or a
 *     workspace whose roster exceeds the bounded cap) presence is treated as
 *     UNKNOWN and fails open: candidates stay connected rather than being
 *     silently marked offline. Personal availability (force_offline /
 *     schedule) still applies, and the window closes as soon as real
 *     heartbeats refresh the lease.
 * A roster is only ever applied to the workspace it was captured in — the
 * global entry never carries one, so cross-workspace leakage is impossible.
 */
function applyHandoff(
  connected: Set<string>,
  userIds: string[],
  entry: FallbackEntry | null,
  ts: number,
): void {
  if (!entry || ts >= entry.handoffUntil) return;
  if (entry.rosterComplete && entry.scope !== GLOBAL_SCOPE) {
    const rosterSet = new Set(entry.roster);
    for (const id of userIds) if (rosterSet.has(id)) connected.add(id);
    return;
  }
  for (const id of userIds) connected.add(id);
}

/**
 * Pick the entry that governs THIS workspace's handoff: its own entry when
 * present (roster-bearing), otherwise the global breaker (roster-less ⇒
 * fail-open). Never another workspace's roster.
 */
function handoffEntryFor(
  state: Map<string, FallbackEntry>,
  workspaceId: string,
  now: number,
): FallbackEntry | null {
  return activeEntry(state, workspaceId, now) || activeEntry(state, GLOBAL_SCOPE, now);
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
    const read = await readCentrifugoPresence(config, workspaceId, ts);

    if (read.failure === null) {
      // Healthy read ⇒ recovery. Clear whichever scopes were tripped so all
      // instances stop refreshing leases again.
      const state = await loadFallbackState(config, ts);
      if (activeEntry(state, workspaceId, ts)) await clearFallback(config, workspaceId, ts);
      if (activeEntry(state, GLOBAL_SCOPE, ts)) await clearFallback(config, GLOBAL_SCOPE, ts);
      const connected = new Set(userIds.filter((id) => read.users.has(id)));
      return { mode: 'realtime', connected, lastSeen: new Map(), degraded: false };
    }

    // FAILURE. Trip the shared breaker immediately (scoped), carrying the
    // last known-good roster so the handoff works even when the lease table
    // has no row for these operators at all.
    const scope = read.failure === 'global' ? GLOBAL_SCOPE : workspaceId;
    const stale = realtimeCache.get(workspaceId);
    const roster = stale ? [...stale.users] : [];
    const entry = await activateFallback(config, scope, `presence_read_${read.failure}`, roster, ts);

    const db = await readDatabasePresence(
      config,
      workspaceId,
      userIds,
      ts,
      PRESENCE_LIVENESS_MS + HANDOFF_MS,
    );
    const connected = new Set(db.connected);
    applyHandoff(connected, userIds, entry, ts);
    return { mode: 'database', connected, lastSeen: db.lastSeen, degraded: true };
  }

  // Native database mode (polling/disabled/Supabase) — plus the widened
  // window while a transition entry is still live.
  const state = await loadFallbackState(config, ts);
  const entry = activeEntry(state, workspaceId, ts) || activeEntry(state, GLOBAL_SCOPE, ts);
  const windowMs = entry ? PRESENCE_LIVENESS_MS + HANDOFF_MS : PRESENCE_LIVENESS_MS;
  const db = await readDatabasePresence(config, workspaceId, userIds, ts, windowMs);
  const connected = new Set(db.connected);
  if (entry) applyHandoff(connected, userIds, entry, ts);
  return { mode: 'database', connected, lastSeen: db.lastSeen, degraded: !!entry };
}
