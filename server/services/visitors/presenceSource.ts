/**
 * Visitor presence — realtime-first source of truth.
 *
 * ARCHITECTURE
 * ------------
 * While Centrifugo presence is healthy, "is this visitor here right now?" is
 * answered by CONNECTION MEMBERSHIP, not by a database timestamp:
 *
 *   widget page load ──subscribe──▶ vp:{workspace}:{shard}
 *   operator read    ──presence───▶ same shard(s)  (backend API key only)
 *
 * PostgreSQL is then written ONLY for durable business facts (session created,
 * navigation, contact linkage, messages). No row is touched merely because a
 * socket is open — the measurable goal is: DB liveness writes while Centrifugo
 * presence is healthy = 0.
 *
 * Sharding keeps the read bounded: resolving a page of 50 visitors costs at
 * most VISITOR_PRESENCE_SHARDS presence calls (cached for a few seconds),
 * never one call per visitor, and never a per-visitor channel.
 *
 * FAILURE SEMANTICS (no false offline)
 * -----------------------------------
 *   • realtime read fails            → workspace-scoped fallback is armed
 *                                      (jittered, bounded TTL) and the DB
 *                                      liveness path takes over
 *   • realtime says "not a member"   → 'unknown' during the handoff grace
 *                                      window, never an immediate 'offline'
 *   • no evidence at all             → 'unknown', the caller falls back to the
 *                                      stored DB status
 *
 * Nothing in this module writes to PostgreSQL.
 */
import type { ServerConfig } from '../../config.js';
import { loadRealtimeConfig, resolveRealtimeProvider } from '../realtime/index.js';
import { CentrifugoDriver } from '../realtime/centrifugo.js';
import {
  VISITOR_PRESENCE_SHARDS,
  buildVisitorPresenceChannelName,
  visitorPresenceShard,
} from '../realtime/types.js';

export type VisitorPresenceMode = 'realtime' | 'database';

/** Presence read cache TTL — bounds Centrifugo calls under operator polling. */
const READ_CACHE_TTL_MS = 5_000;
/** Realtime-mode resolution cache TTL (health probe amortisation). */
const MODE_CACHE_TTL_MS = 15_000;
/** How long a workspace stays in DB fallback after a realtime read failure. */
const FALLBACK_TTL_MS = 60_000;
/** Extra jitter so all workspaces do not fail back to realtime in lockstep. */
const FALLBACK_JITTER_MS = 30_000;
/**
 * Grace window after a realtime read in which a session that is NOT present is
 * reported 'unknown' instead of offline. Covers reconnects, tab switches and
 * the gap between session creation and the widget's first subscribe.
 */
export const VISITOR_PRESENCE_HANDOFF_MS = 45_000;

interface ShardCacheEntry {
  sessions: Set<string>;
  at: number;
}

interface ModeState {
  mode: VisitorPresenceMode;
  checkedAt: number;
}

let modeState: ModeState | null = null;
const shardCache = new Map<string, ShardCacheEntry>();
const shardInflight = new Map<string, Promise<Set<string> | null>>();
const fallbackUntil = new Map<string, number>();

/** Observability counters (exposed through the admin diagnostics endpoint). */
const metrics = {
  realtime_reads: 0,
  realtime_read_failures: 0,
  fallback_activations: 0,
  db_liveness_writes: 0,
  db_liveness_coalesced: 0,
  db_liveness_writes_while_realtime_healthy: 0,
  cache_hits: 0,
  centrifugo_presence_calls: 0,
};

export type VisitorPresenceMetrics = typeof metrics;

export function getVisitorPresenceMetrics(): VisitorPresenceMetrics & {
  workspaces_in_fallback: number;
} {
  const now = Date.now();
  let inFallback = 0;
  for (const until of fallbackUntil.values()) if (until > now) inFallback += 1;
  return { ...metrics, workspaces_in_fallback: inFallback };
}

/** Test/ops hook — drop every process-local cache and counter. */
export function resetVisitorPresenceCache(): void {
  modeState = null;
  shardCache.clear();
  shardInflight.clear();
  fallbackUntil.clear();
  for (const k of Object.keys(metrics) as (keyof typeof metrics)[]) metrics[k] = 0;
}

/**
 * Record a DB liveness write (or a coalesced skip) for observability. Writing
 * while realtime presence is healthy is an architecture violation, so it is
 * counted separately and logged — that counter feeds the
 * `visitor_db_liveness_write_while_realtime_healthy` alert.
 */
export function recordVisitorLivenessWrite(
  outcome: 'wrote' | 'coalesced',
  mode: VisitorPresenceMode,
): void {
  if (outcome === 'coalesced') {
    metrics.db_liveness_coalesced += 1;
    return;
  }
  metrics.db_liveness_writes += 1;
  if (mode === 'realtime') {
    metrics.db_liveness_writes_while_realtime_healthy += 1;
    console.warn(
      '[visitors.presence] DB liveness write happened while realtime presence is healthy',
    );
  }
}

/* ──────────────────────────────── mode ──────────────────────────────────── */

/**
 * Is Centrifugo visitor presence authoritative right now?
 *
 * Mirrors the operator-presence contract: `enabled` alone is not enough — the
 * CONFIGURED primary must be Centrifugo with presence on, AND the control-plane
 * resolver must still consider it usable. A degraded resolver (lenient
 * fallback to polling, or health `down`) means database mode.
 */
export async function resolveVisitorPresenceMode(
  config: ServerConfig,
  workspaceId?: string,
  now: number = Date.now(),
): Promise<VisitorPresenceMode> {
  if (workspaceId) {
    const until = fallbackUntil.get(workspaceId);
    if (until && until > now) return 'database';
  }
  if (modeState && now - modeState.checkedAt < MODE_CACHE_TTL_MS) return modeState.mode;

  let mode: VisitorPresenceMode = 'database';
  try {
    const cfg = await loadRealtimeConfig(config);
    const expectsCentrifugoPresence =
      cfg.enabled === true &&
      cfg.vendor === 'centrifugo' &&
      cfg.centrifugo?.presence_enabled === true;
    if (expectsCentrifugoPresence) {
      const resolved = await resolveRealtimeProvider(config);
      const usable =
        resolved.effective_vendor === 'centrifugo' &&
        resolved.capabilities.supportsPresence &&
        resolved.public_config.presence_enabled === true &&
        resolved.health.status !== 'down';
      if (usable) mode = 'realtime';
    }
  } catch {
    // Cannot prove realtime is primary → database semantics (fail safe: the
    // heartbeat keeps writing, so presence stays correct).
    mode = 'database';
  }
  modeState = { mode, checkedAt: now };
  return mode;
}

function armFallback(workspaceId: string, now: number): void {
  const until = now + FALLBACK_TTL_MS + Math.floor(Math.random() * FALLBACK_JITTER_MS);
  const prev = fallbackUntil.get(workspaceId) ?? 0;
  if (prev <= now) metrics.fallback_activations += 1;
  fallbackUntil.set(workspaceId, until);
  if (fallbackUntil.size > 5_000) {
    for (const [k, v] of fallbackUntil) if (v <= now) fallbackUntil.delete(k);
  }
}

/**
 * True when the widget heartbeat must persist liveness in PostgreSQL.
 * False in healthy realtime mode — the heartbeat then performs ZERO
 * pure-liveness writes (navigation writes are a separate, allowed path).
 */
export async function shouldWriteVisitorLiveness(
  config: ServerConfig,
  workspaceId: string,
  now: number = Date.now(),
): Promise<boolean> {
  return (await resolveVisitorPresenceMode(config, workspaceId, now)) === 'database';
}

/* ───────────────────────────── realtime reads ───────────────────────────── */

async function getDriver(config: ServerConfig): Promise<CentrifugoDriver | null> {
  try {
    const cfg = await loadRealtimeConfig(config);
    const c = cfg.centrifugo;
    if (!c?.api_url || !c?.api_key) return null;
    return new CentrifugoDriver({
      ws_url: c.ws_url ?? '',
      api_url: c.api_url,
      api_key: c.api_key,
      token_hmac_secret: c.token_hmac_secret ?? '',
    });
  } catch {
    return null;
  }
}

/** Session ids present on ONE shard. `null` means "could not read". */
async function readShard(
  config: ServerConfig,
  workspaceId: string,
  shard: number,
  now: number,
): Promise<Set<string> | null> {
  const key = `${workspaceId}|${shard}`;
  const cached = shardCache.get(key);
  if (cached && now - cached.at < READ_CACHE_TTL_MS) {
    metrics.cache_hits += 1;
    return cached.sessions;
  }
  const pending = shardInflight.get(key);
  if (pending) return pending;

  const promise = (async (): Promise<Set<string> | null> => {
    try {
      const driver = await getDriver(config);
      if (!driver) return null;
      metrics.centrifugo_presence_calls += 1;
      const users = await driver.presenceUsers(
        buildVisitorPresenceChannelName(workspaceId, shard),
      );
      if (!users) return null;
      const sessions = new Set<string>();
      for (const u of users) if (u.startsWith('vs_')) sessions.add(u.slice(3));
      if (shardCache.size > 4_000) shardCache.clear();
      shardCache.set(key, { sessions, at: Date.now() });
      return sessions;
    } catch {
      return null;
    } finally {
      shardInflight.delete(key);
    }
  })();
  shardInflight.set(key, promise);
  return promise;
}

export interface VisitorPresenceResolution {
  mode: VisitorPresenceMode;
  /** Session ids proven connected right now (empty when mode is database). */
  online: Set<string>;
  /** True when realtime evidence was obtained for every requested shard. */
  authoritative: boolean;
  /** Milliseconds of grace before "absent from presence" becomes offline. */
  handoffMs: number;
}

/**
 * CENTRAL RESOLVER — the single entry point every read path must use to decide
 * a visitor's live status.
 *
 * `sessionIds` empty ⇒ scan all shards (used by the visitor list to discover
 * connected sessions the DB candidate window may have missed).
 */
export async function resolveVisitorPresence(
  config: ServerConfig,
  workspaceId: string,
  sessionIds: string[] = [],
  now: number = Date.now(),
): Promise<VisitorPresenceResolution> {
  const mode = await resolveVisitorPresenceMode(config, workspaceId, now);
  if (mode !== 'realtime') {
    return { mode, online: new Set(), authoritative: false, handoffMs: VISITOR_PRESENCE_HANDOFF_MS };
  }

  const shards = sessionIds.length
    ? [...new Set(sessionIds.map((id) => visitorPresenceShard(id)))]
    : Array.from({ length: VISITOR_PRESENCE_SHARDS }, (_, i) => i);

  metrics.realtime_reads += 1;
  const results = await Promise.all(shards.map((s) => readShard(config, workspaceId, s, now)));

  const online = new Set<string>();
  let failures = 0;
  for (const r of results) {
    if (!r) {
      failures += 1;
      continue;
    }
    for (const id of r) online.add(id);
  }

  if (failures) {
    metrics.realtime_read_failures += 1;
    // Any unreadable shard means we cannot prove absence → hand this workspace
    // to the database path rather than risk a false offline.
    armFallback(workspaceId, now);
    if (failures === results.length) {
      return {
        mode: 'database',
        online: new Set(),
        authoritative: false,
        handoffMs: VISITOR_PRESENCE_HANDOFF_MS,
      };
    }
  }

  return {
    mode: 'realtime',
    online,
    authoritative: failures === 0,
    handoffMs: VISITOR_PRESENCE_HANDOFF_MS,
  };
}

/**
 * Apply a resolution to ONE session, given whatever the database still knows.
 *
 * Rules:
 *   • present in realtime                        → 'online'
 *   • authoritative realtime + absent + old row  → 'offline'
 *   • authoritative realtime + absent + fresh row→ 'unknown' (handoff grace)
 *   • non-authoritative / database mode          → the DB-derived status
 */
export function applyVisitorPresence(
  resolution: VisitorPresenceResolution,
  sessionId: string,
  databaseStatus: 'online' | 'idle' | 'offline' | 'unknown',
  lastActivityAt: string | null,
  now: number = Date.now(),
): 'online' | 'idle' | 'offline' | 'unknown' {
  if (resolution.mode !== 'realtime') return databaseStatus;
  if (resolution.online.has(sessionId)) return 'online';
  if (!resolution.authoritative) return databaseStatus;
  const last = lastActivityAt ? new Date(lastActivityAt).getTime() : 0;
  if (last && now - last < resolution.handoffMs) return 'unknown';
  return databaseStatus === 'online' ? 'offline' : databaseStatus;
}
