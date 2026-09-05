/**
 * Visitor presence — EPHEMERAL CANDIDATE INDEX (discovery only).
 *
 * PROBLEM
 * -------
 * With scheme v2 (one presence channel per session) Centrifugo can answer
 * "is THIS session connected?" cheaply, but it cannot be asked "who is
 * connected?" without enumerating channels. Discovery therefore needs an
 * index of session ids. It must NOT live in PostgreSQL: a per-session
 * periodic UPDATE — whatever it is called, heartbeat or candidacy touch —
 * reintroduces exactly the write load this architecture removed
 * (1M visitors / 10 min ≈ 1.6k writes per second for zero business facts),
 * and it corrupts `visitor_presence.updated_at`, which the UI reads as real
 * activity recency.
 *
 * SHAPE
 * -----
 *   MODE 2 / MODE 3 (app_routed_redis / load_balanced_redis)
 *     Redis/Valkey sorted set, the same instance Centrifugo already needs:
 *
 *       key    vp:index:{workspace_id}
 *       member session_id
 *       score  lease_expires_at (epoch ms)
 *
 *     Written with one ZADD per presence negotiation/renewal (no periodic
 *     writes), read with ZRANGEBYSCORE now..+inf. Stale members expire by
 *     score, so no reliable disconnect event is required.
 *
 *   MODE 1 (single_memory, small deployments)
 *     Centrifugo's `channels` API with the `vp:v2:{workspace}:*` pattern.
 *     Deliberately restricted to Mode 1: that call has no pagination and
 *     returns every matching active channel.
 *
 *   NO INDEX AVAILABLE
 *     The caller keeps its durable PostgreSQL window. Degraded discovery,
 *     never wrong data — and still zero periodic writes.
 *
 * Redis is NOT a source of truth here. Presence truth stays in Centrifugo:
 * a stale index entry whose socket died is corrected by `presence_stats = 0`.
 */
import type { ServerConfig } from '../../config.js';
import { getRedisClient } from '../../lib/redisClient.js';
import { loadRealtimeConfig } from '../realtime/store.js';
import { resolveDeploymentMode } from '../realtime/types.js';
import { resolveCentrifugoApiEndpoints } from '../realtime/apiEndpoints.js';
import {
  buildVisitorPresenceChannelName,
  parseVisitorPresenceChannel,
  VISITOR_PRESENCE_MAX_CANDIDATES,
} from '../realtime/types.js';

export type CandidateIndexBackend = 'redis' | 'centrifugo_channels' | 'none';

export interface CandidateListResult {
  backend: CandidateIndexBackend;
  session_ids: string[];
  /** True when the backend answered and the list may be trusted as complete. */
  authoritative: boolean;
}

/** Safety net so an index key can never outlive the deployment that wrote it. */
const INDEX_KEY_TTL_SECONDS = 24 * 60 * 60;
/** Backend resolution cache (avoids re-reading realtime config per request). */
const BACKEND_CACHE_TTL_MS = 15_000;
/** Read cache — operator polling must not hammer the index. */
const LIST_CACHE_TTL_MS = 3_000;
/** Local de-dupe of identical ZADDs from repeated negotiations. */
const TOUCH_DEDUPE_MS = 30_000;
const TOUCH_MAP_MAX = 50_000;
/**
 * Opportunistic garbage collection interval, per workspace.
 *
 * Expiry-by-score alone is not enough: in a busy workspace whose operators do
 * not open the Visitors page for days, nothing would ever run
 * ZREMRANGEBYSCORE while ZADD keeps pushing the key's TTL forward — the set
 * would grow without bound and the first operator read would pay one huge
 * prune. GC therefore rides on the WRITE path (bounded: at most one prune per
 * workspace per interval, regardless of visitor count), never on a timer.
 */
const PRUNE_INTERVAL_MS = 45_000;
const PRUNE_MAP_MAX = 10_000;

const metrics = {
  touches: 0,
  touches_deduped: 0,
  touch_failures: 0,
  prunes: 0,
  lists: 0,
  list_cache_hits: 0,
  list_failures: 0,
  candidates_returned: 0,
};

export type CandidateIndexMetrics = typeof metrics & { backend: CandidateIndexBackend };

let backendState: { backend: CandidateIndexBackend; url: string | null; at: number } | null = null;
const touchedAt = new Map<string, number>();
const prunedAt = new Map<string, number>();
const listCache = new Map<string, { at: number; result: CandidateListResult }>();

export const candidateIndexKey = (workspaceId: string) => `vp:index:${workspaceId}`;

export function getCandidateIndexMetrics(): CandidateIndexMetrics {
  return { ...metrics, backend: backendState?.backend ?? 'none' };
}

export function resetCandidateIndex(): void {
  backendState = null;
  touchedAt.clear();
  prunedAt.clear();
  listCache.clear();
  for (const k of Object.keys(metrics) as (keyof typeof metrics)[]) metrics[k] = 0;
}

/**
 * Explicit opt-in only. A generic `REDIS_URL` is deliberately NOT accepted:
 * that variable tends to grow into "the app's cache/job Redis" later, and
 * presence discovery must never silently start writing into an unrelated
 * instance. Only the dedicated variable, or the realtime engine's own Redis
 * (which this index is designed to share), count.
 */
function redisUrl(): string | null {
  const raw =
    process.env.VISITOR_CANDIDATE_INDEX_REDIS_URL ||
    process.env.REALTIME_REDIS_URL ||
    '';
  const url = raw.trim();
  return url ? url : null;
}

/**
 * Which discovery backend applies right now. Redis wins whenever it is
 * configured; the Centrifugo `channels` scan is allowed for `single_memory`
 * only, because it is unbounded by design.
 */
export async function resolveCandidateIndexBackend(
  config: ServerConfig,
  now: number = Date.now(),
): Promise<{ backend: CandidateIndexBackend; url: string | null }> {
  if (backendState && now - backendState.at < BACKEND_CACHE_TTL_MS) {
    return { backend: backendState.backend, url: backendState.url };
  }
  let backend: CandidateIndexBackend = 'none';
  const url = redisUrl();
  try {
    const cfg = await loadRealtimeConfig(config);
    const mode = resolveDeploymentMode(cfg.centrifugo);
    if (url) backend = 'redis';
    else if (mode === 'single_memory') backend = 'centrifugo_channels';
    else backend = 'none';
  } catch {
    backend = url ? 'redis' : 'none';
  }
  backendState = { backend, url, at: now };
  return { backend, url };
}

/**
 * Record/refresh this session's candidacy. Called ONLY on presence
 * negotiation and in-place lease renewal — never on a timer, never per page
 * view, and never against PostgreSQL.
 */
export async function touchVisitorCandidate(
  config: ServerConfig,
  workspaceId: string,
  sessionId: string,
  leaseExpiresAtMs: number,
  now: number = Date.now(),
): Promise<void> {
  const { backend, url } = await resolveCandidateIndexBackend(config, now);
  if (backend !== 'redis' || !url) return; // channels-mode needs no writes

  const key = `${workspaceId}:${sessionId}`;
  const last = touchedAt.get(key);
  if (last && now - last < TOUCH_DEDUPE_MS) {
    metrics.touches_deduped += 1;
    return;
  }
  if (touchedAt.size >= TOUCH_MAP_MAX) touchedAt.clear();
  touchedAt.set(key, now);

  try {
    const client = getRedisClient(url);
    const indexKey = candidateIndexKey(workspaceId);
    await client.command('ZADD', indexKey, Math.floor(leaseExpiresAtMs), sessionId);
    metrics.touches += 1;
    // Steady state costs exactly one command per renewal. The prune + TTL
    // refresh piggyback at most once per PRUNE_INTERVAL_MS per workspace.
    if (shouldPrune(workspaceId, now)) {
      await client.command('ZREMRANGEBYSCORE', indexKey, '-inf', `(${now}`);
      await client.command('EXPIRE', indexKey, INDEX_KEY_TTL_SECONDS);
      metrics.prunes += 1;
    }
  } catch {
    metrics.touch_failures += 1;
    touchedAt.delete(key);
  }
}

/** At most one prune per workspace per interval, decided locally (cheap). */
function shouldPrune(workspaceId: string, now: number): boolean {
  const last = prunedAt.get(workspaceId);
  if (last && now - last < PRUNE_INTERVAL_MS) return false;
  if (prunedAt.size >= PRUNE_MAP_MAX) prunedAt.clear();
  prunedAt.set(workspaceId, now);
  return true;
}

/** Drop a session from the index (explicit widget teardown). Best effort. */
export async function removeVisitorCandidate(
  config: ServerConfig,
  workspaceId: string,
  sessionId: string,
): Promise<void> {
  const { backend, url } = await resolveCandidateIndexBackend(config);
  if (backend !== 'redis' || !url) return;
  touchedAt.delete(`${workspaceId}:${sessionId}`);
  try {
    await getRedisClient(url).command('ZREM', candidateIndexKey(workspaceId), sessionId);
  } catch {
    /* expiry by score is the real garbage collector */
  }
}

/**
 * Session ids that plausibly hold a live presence subscription.
 *
 * The answer is a CANDIDATE set, not truth: the caller must still confirm each
 * id with a batched `presence_stats` read.
 */
export async function listVisitorCandidates(
  config: ServerConfig,
  workspaceId: string,
  limit: number = VISITOR_PRESENCE_MAX_CANDIDATES,
  now: number = Date.now(),
): Promise<CandidateListResult> {
  const cap = Math.max(1, Math.min(limit, VISITOR_PRESENCE_MAX_CANDIDATES));
  const cacheKey = `${workspaceId}|${cap}`;
  const cached = listCache.get(cacheKey);
  if (cached && now - cached.at < LIST_CACHE_TTL_MS) {
    metrics.list_cache_hits += 1;
    return cached.result;
  }

  const { backend, url } = await resolveCandidateIndexBackend(config, now);
  let result: CandidateListResult = { backend, session_ids: [], authoritative: false };

  if (backend === 'redis' && url) {
    try {
      const client = getRedisClient(url);
      const key = candidateIndexKey(workspaceId);
      // Reads still prune (bounded by the write-path GC above, so this is
      // never the huge one-off sweep it used to be).
      if (shouldPrune(workspaceId, now)) {
        await client.command('ZREMRANGEBYSCORE', key, '-inf', `(${now}`);
        metrics.prunes += 1;
      }
      const raw = await client.command(
        'ZRANGEBYSCORE', key, String(now), '+inf', 'LIMIT', 0, cap,
      );
      const ids = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
      result = { backend, session_ids: ids, authoritative: true };
      metrics.lists += 1;
      metrics.candidates_returned += ids.length;
    } catch {
      metrics.list_failures += 1;
      result = { backend, session_ids: [], authoritative: false };
    }
  } else if (backend === 'centrifugo_channels') {
    try {
      const [endpoint] = await resolveCentrifugoApiEndpoints(config);
      const prefix = buildVisitorPresenceChannelName(workspaceId, '');
      const channels = endpoint ? await endpoint.driver.channels(`${prefix}*`, cap) : null;
      if (channels) {
        const ids: string[] = [];
        for (const channel of channels) {
          const parsed = parseVisitorPresenceChannel(channel);
          if (parsed && parsed.workspaceId === workspaceId && parsed.sessionId) {
            ids.push(parsed.sessionId);
          }
        }
        result = { backend, session_ids: ids.slice(0, cap), authoritative: true };
        metrics.lists += 1;
        metrics.candidates_returned += result.session_ids.length;
      } else {
        metrics.list_failures += 1;
      }
    } catch {
      metrics.list_failures += 1;
    }
  }

  listCache.set(cacheKey, { at: now, result });
  if (listCache.size > 5_000) {
    for (const [k, v] of listCache) if (now - v.at > LIST_CACHE_TTL_MS) listCache.delete(k);
  }
  return result;
}
