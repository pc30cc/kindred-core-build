/**
 * Visitor presence — realtime-first source of truth (candidate-driven).
 *
 * ARCHITECTURE
 * ------------
 * While Centrifugo presence is healthy, "is this visitor here right now?" is
 * answered by CONNECTION MEMBERSHIP, not by a database timestamp:
 *
 *   widget page load ──subscribe──▶ vp:v2:{workspace}:{session_id}
 *   operator read    ──batch presence_stats──▶ only the CANDIDATE channels
 *
 * PostgreSQL is written ONLY for durable business facts (session created,
 * navigation, contact linkage, messages). No row is touched merely because a
 * socket is open — the measurable goal is: DB liveness writes while Centrifugo
 * presence is healthy = 0.
 *
 * BOUNDED BY CONSTRUCTION
 * -----------------------
 * There is no "who is online?" query against Centrifugo. Discovery belongs to
 * PostgreSQL (the candidate window); realtime only answers a yes/no per
 * candidate. Resolving a page of K visitors costs
 * ceil(K / VISITOR_PRESENCE_BATCH_MAX) HTTP requests and a payload of K
 * integers, whether the workspace has 50 or 1,000,000 visitors online.
 *
 * FAILURE SEMANTICS (no false offline)
 * -----------------------------------
 *   • realtime read fails            → at most one alternate endpoint is
 *                                      tried, then a SHARED (cross-instance)
 *                                      workspace fallback is armed with a
 *                                      jittered TTL and the DB path takes over
 *   • realtime says "not connected"  → 'unknown' during the handoff grace
 *                                      window, never an immediate 'offline'
 *   • no evidence at all             → the stored DB status wins
 *
 * Nothing in this module writes liveness to PostgreSQL. The only write is the
 * shared fallback row, which changes on transition/renewal — never per read.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { loadRealtimeConfig, resolveRealtimeProvider } from '../realtime/index.js';
import {
  resolveCentrifugoApiEndpoints,
  PRESENCE_READ_MAX_ENDPOINTS,
} from '../realtime/apiEndpoints.js';
import {
  buildVisitorPresenceChannelName,
  parseVisitorPresenceChannel,
  VISITOR_PRESENCE_BATCH_MAX,
  VISITOR_PRESENCE_MAX_CANDIDATES,
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
/** Shared-fallback cache TTL (one tiny SELECT per instance per window). */
const FALLBACK_CACHE_TTL_MS = 5_000;
/** Shared fallback table — reused from operator presence, distinct scopes. */
const FALLBACK_TABLE = 'operator_presence_fallback_state';
/** Scope key for a workspace's visitor presence fallback. */
const scopeKey = (workspaceId: string) => `visitor:${workspaceId}`;

/**
 * Grace window after a realtime read in which a session that is NOT connected
 * is reported 'unknown' instead of offline. Covers reconnects, tab switches
 * and the gap between session creation and the widget's first subscribe.
 */
export const VISITOR_PRESENCE_HANDOFF_MS = 45_000;

interface SessionCacheEntry {
  online: boolean;
  at: number;
}

interface ModeState {
  mode: VisitorPresenceMode;
  checkedAt: number;
}

let modeState: ModeState | null = null;
const sessionCache = new Map<string, SessionCacheEntry>();
/** Process-local mirror of the shared fallback rows. */
const fallbackUntil = new Map<string, number>();
let fallbackLoadedAt = 0;
let fallbackInflight: Promise<void> | null = null;

/** Observability counters (exposed through the admin diagnostics endpoint). */
const metrics = {
  realtime_reads: 0,
  realtime_read_failures: 0,
  realtime_endpoint_retries: 0,
  fallback_activations: 0,
  fallback_recoveries: 0,
  db_liveness_writes: 0,
  db_liveness_coalesced: 0,
  db_liveness_writes_while_realtime_healthy: 0,
  heartbeats_skipped_by_lease: 0,
  cache_hits: 0,
  centrifugo_presence_calls: 0,
  candidates_resolved: 0,
  candidates_truncated: 0,
  full_scan_rejected: 0,
};


export type VisitorPresenceMetrics = typeof metrics;

export function getVisitorPresenceMetrics(): VisitorPresenceMetrics & {
  workspaces_in_fallback: number;
  channel_scheme: string;
} {
  const now = Date.now();
  let inFallback = 0;
  for (const until of fallbackUntil.values()) if (until > now) inFallback += 1;
  return { ...metrics, workspaces_in_fallback: inFallback, channel_scheme: 'vp:v2:{ws}:{session}' };
}

/** Test/ops hook — drop every process-local cache and counter. */
export function resetVisitorPresenceCache(): void {
  modeState = null;
  sessionCache.clear();
  fallbackUntil.clear();
  fallbackLoadedAt = 0;
  fallbackInflight = null;
  for (const k of Object.keys(metrics) as (keyof typeof metrics)[]) metrics[k] = 0;
}

/**
 * DISCOVERY IS NOT PERSISTED HERE.
 *
 * A "candidacy touch" that writes `visitor_presence.updated_at` on a timer is
 * a heartbeat under another name: at 1M connected visitors even a 10-minute
 * cadence is ~1.6k UPDATEs/second that carry no business fact, and it makes an
 * idle visitor look freshly active to Visitor Intelligence.
 *
 * Candidate discovery therefore lives in an EPHEMERAL index —
 * `./candidateIndex.ts` (Redis sorted set in Mode 2/3, Centrifugo active
 * channels in Mode 1). PostgreSQL keeps only durable business data.
 */



/**
 * Record a DB liveness write (or a coalesced skip) for observability. Writing
 * while realtime presence owns the session is an architecture violation, so it
 * is counted separately and logged — that counter feeds the
 * `visitor_db_liveness_write_while_realtime_healthy` alert.
 */
export function recordVisitorLivenessWrite(
  outcome: 'wrote' | 'coalesced' | 'skipped_lease',
  mode: VisitorPresenceMode,
): void {
  if (outcome === 'skipped_lease') {
    metrics.heartbeats_skipped_by_lease += 1;
    return;
  }
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

/* ─────────────────────── shared workspace fallback ──────────────────────── */

/**
 * Load the shared fallback rows. Cached for a few seconds, so the heartbeat
 * path costs at most one tiny SELECT per instance per window. A workspace put
 * into fallback by ONE instance must be honoured by all of them, otherwise
 * half the fleet keeps suppressing liveness writes during an outage.
 */
async function loadFallbackState(config: ServerConfig, now: number): Promise<void> {
  if (now - fallbackLoadedAt < FALLBACK_CACHE_TTL_MS) return;
  if (fallbackInflight) return fallbackInflight;
  fallbackInflight = (async () => {
    try {
      const sb = getServiceClient(config);
      const { data } = await sb
        .from(FALLBACK_TABLE)
        .select('scope, expires_at')
        .like('scope', 'visitor:%')
        .gte('expires_at', new Date(now).toISOString());
      const next = new Map<string, number>();
      for (const row of (data || []) as Array<Record<string, any>>) {
        const scope = String(row.scope || '');
        if (!scope.startsWith('visitor:')) continue;
        next.set(scope.slice('visitor:'.length), Date.parse(row.expires_at) || 0);
      }
      // Keep locally-armed entries that have not yet been persisted.
      for (const [ws, until] of fallbackUntil) {
        if (until > now && !next.has(ws)) next.set(ws, until);
      }
      fallbackUntil.clear();
      for (const [k, v] of next) fallbackUntil.set(k, v);
      fallbackLoadedAt = now;
    } catch {
      // Shared state unreadable → keep the local view (fail safe: whatever is
      // armed locally stays armed).
      fallbackLoadedAt = now;
    } finally {
      fallbackInflight = null;
    }
  })();
  return fallbackInflight;
}

async function armFallback(config: ServerConfig, workspaceId: string, now: number): Promise<void> {
  const until = now + FALLBACK_TTL_MS + Math.floor(Math.random() * FALLBACK_JITTER_MS);
  const prev = fallbackUntil.get(workspaceId) ?? 0;
  const isNew = prev <= now;
  if (isNew) metrics.fallback_activations += 1;
  fallbackUntil.set(workspaceId, until);
  if (fallbackUntil.size > 5_000) {
    for (const [k, v] of fallbackUntil) if (v <= now) fallbackUntil.delete(k);
  }
  // Publish only on activation or when the entry is more than half-spent —
  // never per read.
  if (!isNew && prev - now > FALLBACK_TTL_MS / 2) return;
  try {
    const sb = getServiceClient(config);
    await sb.from(FALLBACK_TABLE).upsert(
      {
        scope: scopeKey(workspaceId),
        reason: 'visitor_presence_read_failed',
        roster: [],
        roster_complete: false,
        handoff_until: new Date(now + VISITOR_PRESENCE_HANDOFF_MS).toISOString(),
        expires_at: new Date(until).toISOString(),
        updated_at: new Date(now).toISOString(),
      },
      { onConflict: 'scope' },
    );
  } catch {
    /* best effort — the local entry still drives this instance */
  }
}

/* ──────────────────────────────── mode ──────────────────────────────────── */

/**
 * Is Centrifugo visitor presence authoritative right now?
 *
 * `enabled` alone is not enough — the CONFIGURED primary must be Centrifugo
 * with presence on, AND the control-plane resolver must still consider it
 * usable. A degraded resolver (lenient fallback to polling, or health `down`)
 * means database mode.
 */
export async function resolveVisitorPresenceMode(
  config: ServerConfig,
  workspaceId?: string,
  now: number = Date.now(),
): Promise<VisitorPresenceMode> {
  if (workspaceId) {
    await loadFallbackState(config, now);
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
  if (modeState?.mode === 'database' && mode === 'realtime') metrics.fallback_recoveries += 1;
  modeState = { mode, checkedAt: now };
  return mode;
}

/**
 * True when the widget heartbeat must persist liveness in PostgreSQL.
 *
 * `hasLease` is the PER-SESSION signal: a valid lease proves this particular
 * visitor holds an open presence subscription, so its liveness needs no write
 * even in a workspace that is otherwise fine. Without a lease the database
 * path runs regardless of workspace mode — that is what keeps a visitor whose
 * WebSocket is blocked visible to operators.
 */
export async function shouldWriteVisitorLiveness(
  config: ServerConfig,
  workspaceId: string,
  hasLease = false,
  now: number = Date.now(),
): Promise<boolean> {
  if (hasLease && (await resolveVisitorPresenceMode(config, workspaceId, now)) === 'realtime') {
    return false;
  }
  return true;
}

/* ───────────────────────────── realtime reads ───────────────────────────── */

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Read connection counts for the given channels, trying at most
 * PRESENCE_READ_MAX_ENDPOINTS endpoints. Returns null when no endpoint could
 * answer — the caller then arms the database fallback.
 */
async function readPresence(
  config: ServerConfig,
  channels: string[],
): Promise<Map<string, number> | null> {
  const endpoints = (await resolveCentrifugoApiEndpoints(config)).slice(
    0,
    PRESENCE_READ_MAX_ENDPOINTS,
  );
  if (!endpoints.length) return null;

  for (let i = 0; i < endpoints.length; i += 1) {
    if (i > 0) metrics.realtime_endpoint_retries += 1;
    const merged = new Map<string, number>();
    let ok = true;
    for (const batch of chunk(channels, VISITOR_PRESENCE_BATCH_MAX)) {
      metrics.centrifugo_presence_calls += 1;
      let res: Map<string, number> | null = null;
      try {
        res = await endpoints[i].driver.presenceStatsBatch(batch);
      } catch {
        res = null;
      }
      if (!res) {
        ok = false;
        break;
      }
      for (const [k, v] of res) merged.set(k, v);
    }
    if (ok) return merged;
  }
  return null;
}

export interface VisitorPresenceResolution {
  mode: VisitorPresenceMode;
  /** Session ids proven connected right now (empty when mode is database). */
  online: Set<string>;
  /** True when realtime evidence was obtained for every requested session. */
  authoritative: boolean;
  /** Milliseconds of grace before "absent from presence" becomes offline. */
  handoffMs: number;
}

const emptyResolution = (mode: VisitorPresenceMode): VisitorPresenceResolution => ({
  mode,
  online: new Set(),
  authoritative: false,
  handoffMs: VISITOR_PRESENCE_HANDOFF_MS,
});

/**
 * CENTRAL RESOLVER — the single entry point every read path must use.
 *
 * Candidate-driven by contract: `sessionIds` MUST be the (already bounded) set
 * of sessions the caller is about to render. There is no "resolve everything"
 * mode; asking for nothing returns nothing rather than scanning the cluster.
 */
export async function resolveVisitorPresenceForSessions(
  config: ServerConfig,
  workspaceId: string,
  sessionIds: string[],
  now: number = Date.now(),
): Promise<VisitorPresenceResolution> {
  const mode = await resolveVisitorPresenceMode(config, workspaceId, now);
  if (mode !== 'realtime') return emptyResolution(mode);

  const unique = [...new Set(sessionIds.filter(Boolean))];
  if (!unique.length) {
    // A caller that wants "everyone online" is asking Centrifugo to be a
    // database. Refuse loudly (counter + non-authoritative answer) instead of
    // silently issuing an unbounded scan.
    metrics.full_scan_rejected += 1;
    return emptyResolution('realtime');
  }

  const candidates = unique.slice(0, VISITOR_PRESENCE_MAX_CANDIDATES);
  if (candidates.length < unique.length) metrics.candidates_truncated += 1;
  metrics.candidates_resolved += candidates.length;

  const online = new Set<string>();
  const toRead: string[] = [];
  for (const id of candidates) {
    const cached = sessionCache.get(`${workspaceId}|${id}`);
    if (cached && now - cached.at < READ_CACHE_TTL_MS) {
      metrics.cache_hits += 1;
      if (cached.online) online.add(id);
      continue;
    }
    toRead.push(id);
  }

  if (!toRead.length) {
    return { mode: 'realtime', online, authoritative: true, handoffMs: VISITOR_PRESENCE_HANDOFF_MS };
  }

  metrics.realtime_reads += 1;
  const channels = toRead.map((id) => buildVisitorPresenceChannelName(workspaceId, id));
  const stats = await readPresence(config, channels);

  if (!stats) {
    metrics.realtime_read_failures += 1;
    await armFallback(config, workspaceId, now);
    return emptyResolution('database');
  }

  if (sessionCache.size > 20_000) sessionCache.clear();
  let missing = 0;
  for (const channel of channels) {
    const parsed = parseVisitorPresenceChannel(channel);
    if (!parsed) continue;
    const count = stats.get(channel);
    if (count === undefined) {
      // Per-channel error → no evidence for this session. Never treated as
      // offline; it simply does not become authoritative.
      missing += 1;
      continue;
    }
    const isOnline = count > 0;
    sessionCache.set(`${workspaceId}|${parsed.sessionId}`, { online: isOnline, at: now });
    if (isOnline) online.add(parsed.sessionId);
  }

  return {
    mode: 'realtime',
    online,
    authoritative: missing === 0,
    handoffMs: VISITOR_PRESENCE_HANDOFF_MS,
  };
}

/** @deprecated Use {@link resolveVisitorPresenceForSessions} — same contract. */
export const resolveVisitorPresence = resolveVisitorPresenceForSessions;

/**
 * Apply a resolution to ONE session, given whatever the database still knows.
 *
 * Rules:
 *   • connected in realtime                      → 'online'
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
