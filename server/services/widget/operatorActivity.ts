/**
 * INTERNAL OPERATOR ACTIVITY (active vs. away) — ephemeral.
 *
 * The teammate-facing presence model needs "is this operator actually doing
 * something right now?", with an EXACT 5-minute threshold. It must NOT
 * introduce a periodic PostgreSQL heartbeat.
 *
 * Sources, newest wins:
 *
 *   1. PROCESS-LOCAL MAP (primary, precise, zero writes) — every
 *      interaction-gated operator beat that lands on this instance stamps
 *      `user → ts` here. Bounded and self-pruning.
 *   2. REDIS/VALKEY EXACT INDEX (multi-node, precise) — the same instance the
 *      realtime engine already needs:
 *
 *        key    op:activity:{workspace_id}
 *        member user_id
 *        score  exact last-interaction epoch ms
 *
 *      Written coalesced (at most one ZADD per operator per
 *      ACTIVITY_WRITE_COALESCE_MS while they are interacting) — never on a
 *      timer, never against PostgreSQL. Read with ZSCORE, so cross-node
 *      `away` lands exactly at 5 minutes, not 5–10.
 *
 * Without the exact index a node knows only the interactions it received
 * itself, so on a multi-node deployment an operator active on another node
 * reads as `away` (never offline: connection state comes from elsewhere).
 * The coarse `operator_activity_samples` fallback that used to cover that gap
 * went with its table (database/migrations/223).
 *
 * This module never reads or writes PostgreSQL.
 */

import type { ServerConfig } from '../../config.js';
import { getRedisClient } from '../../lib/redisClient.js';

/** Inactivity threshold that separates `active` from `away`. */
export const OPERATOR_ACTIVITY_ACTIVE_MS = 5 * 60_000;

/** At most one Redis write per operator per this window while interacting. */
export const ACTIVITY_WRITE_COALESCE_MS = 20_000;
/** Opportunistic GC of the exact index, per workspace, on the write path. */
const PRUNE_INTERVAL_MS = 45_000;
/** Safety net so an index key can never outlive the deployment that wrote it. */
const INDEX_KEY_TTL_SECONDS = 60 * 60;

const MAX_ENTRIES = 20_000;
const local = new Map<string, number>();
const lastRedisWriteAt = new Map<string, number>();
const lastPruneAt = new Map<string, number>();
/** Latest interaction seen inside an open coalescing window (trailing edge). */
const pending = new Map<string, number>();
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();


const metrics = { writes: 0, writes_coalesced: 0, write_failures: 0, reads: 0, read_failures: 0 };

export const operatorActivityKey = (workspaceId: string) => `op:activity:${workspaceId}`;

export function getOperatorActivityMetrics() {
  return { ...metrics, backend: activityRedisUrl() ? 'redis' : 'process_local' };
}

function key(workspaceId: string, userId: string): string {
  return `${workspaceId}:${userId}`;
}

/**
 * Explicit opt-in only — a generic `REDIS_URL` is deliberately NOT accepted.
 */
function activityRedisUrl(): string | null {
  const raw =
    process.env.OPERATOR_ACTIVITY_REDIS_URL ||
    process.env.REALTIME_REDIS_URL ||
    '';
  const url = raw.trim();
  return url ? url : null;
}

/** Stamp an operator interaction. In-memory always; Redis coalesced. */
export function recordOperatorActivity(
  workspaceId: string,
  userId: string,
  at: number = Date.now(),
): void {
  if (local.size >= MAX_ENTRIES) {
    const cutoff = at - 2 * OPERATOR_ACTIVITY_ACTIVE_MS;
    for (const [k, ts] of local) if (ts < cutoff) local.delete(k);
    if (local.size >= MAX_ENTRIES) local.clear();
  }
  local.set(key(workspaceId, userId), at);
  void publishOperatorActivity(workspaceId, userId, at);
}

/**
 * Coalesced ZADD of the exact timestamp, with a TRAILING-EDGE FLUSH.
 *
 * Leading edge  → immediate ZADD.
 * Inside window → remember the LATEST real interaction timestamp only.
 * Window end    → one-shot timer writes that latest timestamp.
 *
 * Without the trailing flush the index would keep the first timestamp of the
 * window, so another node could flip an operator to `away` up to
 * ACTIVITY_WRITE_COALESCE_MS too early. The timer is one-shot per operator —
 * not a heartbeat, and never a PostgreSQL write.
 */
/**
 * Monotonic score write: an older timestamp can NEVER overwrite a newer one.
 *
 * A trailing-flush timer armed before a `lastRedisWriteAt` eviction can fire
 * after a newer immediate write, so an unconditional ZADD could move the score
 * backwards. `ZADD GT` gives us the guarantee natively (Redis/Valkey >= 6.2);
 * older servers reject the flag, so we fall back to an atomic Lua CAS.
 */
let zaddGtSupported: boolean | null = null;

const MONOTONIC_ZADD_LUA =
  "local cur = redis.call('ZSCORE', KEYS[1], ARGV[2]) " +
  "if (not cur) or (tonumber(cur) < tonumber(ARGV[1])) then " +
  "redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2]) return 1 end return 0";

async function monotonicZAdd(
  client: { command: (...args: Array<string | number>) => Promise<unknown> },
  indexKey: string,
  score: number,
  member: string,
): Promise<void> {
  if (zaddGtSupported !== false) {
    try {
      await client.command('ZADD', indexKey, 'GT', 'CH', score, member);
      zaddGtSupported = true;
      return;
    } catch (err) {
      const msg = String((err as Error)?.message || err).toUpperCase();
      // Only treat "unknown flag / wrong args" as unsupported — real
      // connection failures must still propagate to the caller.
      const unsupported = msg.includes('SYNTAX') || msg.includes('ERR ');
      if (!unsupported) throw err;
      zaddGtSupported = false;
    }
  }
  await client.command('EVAL', MONOTONIC_ZADD_LUA, 1, indexKey, score, member);
}

export async function publishOperatorActivity(
  workspaceId: string,
  userId: string,
  at: number = Date.now(),
): Promise<void> {
  const url = activityRedisUrl();
  if (!url) return;
  const k = key(workspaceId, userId);
  const last = lastRedisWriteAt.get(k);
  if (last && at - last < ACTIVITY_WRITE_COALESCE_MS) {
    metrics.writes_coalesced += 1;
    // Keep only the newest pending interaction and make sure exactly one
    // flush timer is armed for this operator's window.
    const prev = pending.get(k);
    if (!prev || at > prev) pending.set(k, at);
    if (!flushTimers.has(k)) {
      const delay = Math.max(0, last + ACTIVITY_WRITE_COALESCE_MS - at);
      const timer = setTimeout(() => {
        flushTimers.delete(k);
        const ts = pending.get(k);
        pending.delete(k);
        if (ts === undefined) return;
        lastRedisWriteAt.delete(k); // force the flush past the coalescing gate
        void publishOperatorActivity(workspaceId, userId, ts);
      }, delay);
      (timer as { unref?: () => void }).unref?.();
      flushTimers.set(k, timer);
    }
    return;
  }
  if (lastRedisWriteAt.size >= MAX_ENTRIES) lastRedisWriteAt.clear();
  lastRedisWriteAt.set(k, at);
  try {
    const client = getRedisClient(url);
    const indexKey = operatorActivityKey(workspaceId);
    await monotonicZAdd(client, indexKey, Math.floor(at), userId);
    metrics.writes += 1;
    const prunedAt = lastPruneAt.get(workspaceId) || 0;
    if (at - prunedAt >= PRUNE_INTERVAL_MS) {
      lastPruneAt.set(workspaceId, at);
      await client.command(
        'ZREMRANGEBYSCORE',
        indexKey,
        '-inf',
        `(${at - 2 * OPERATOR_ACTIVITY_ACTIVE_MS}`,
      );
      await client.command('EXPIRE', indexKey, INDEX_KEY_TTL_SECONDS);
    }
  } catch {
    metrics.write_failures += 1;
    lastRedisWriteAt.delete(k);
  }
}

/** Test/ops hook: run every armed trailing flush immediately. */
export async function flushOperatorActivityWrites(): Promise<void> {
  const entries = [...flushTimers.entries()];
  for (const [k, timer] of entries) {
    clearTimeout(timer);
    flushTimers.delete(k);
    const ts = pending.get(k);
    pending.delete(k);
    if (ts === undefined) continue;
    const idx = k.indexOf(':');
    const workspaceId = k.slice(0, idx);
    const userId = k.slice(idx + 1);
    lastRedisWriteAt.delete(k);
    await publishOperatorActivity(workspaceId, userId, ts);
  }
}

/** Test hook: emulate the MAX_ENTRIES eviction of the coalescing map. */
export function __evictActivityCoalesceState(): void {
  lastRedisWriteAt.clear();
}

/** Test/ops hook. */
export function resetOperatorActivity(): void {
  zaddGtSupported = null;
  local.clear();
  lastRedisWriteAt.clear();
  lastPruneAt.clear();
  for (const t of flushTimers.values()) clearTimeout(t);
  flushTimers.clear();
  pending.clear();
  for (const m of Object.keys(metrics) as (keyof typeof metrics)[]) metrics[m] = 0;
}


/** Exact cross-node timestamps for the operators we don't know locally. */
async function readExactActivity(
  workspaceId: string,
  userIds: string[],
): Promise<Map<string, number> | null> {
  const url = activityRedisUrl();
  if (!url || !userIds.length) return null;
  try {
    const client = getRedisClient(url);
    const indexKey = operatorActivityKey(workspaceId);
    const out = new Map<string, number>();
    for (const id of userIds) {
      const score = await client.command('ZSCORE', indexKey, id);
      const v = typeof score === 'string' ? Number(score) : null;
      if (v && Number.isFinite(v)) out.set(id, v);
    }
    metrics.reads += 1;
    return out;
  } catch {
    metrics.read_failures += 1;
    return null;
  }
}

/**
 * Last-activity timestamp (ms) per operator. Missing ⇒ no activity known.
 */
export async function getOperatorLastActivity(
  _config: ServerConfig,
  workspaceId: string,
  userIds: string[],
  now: Date = new Date(),
): Promise<Map<string, number>> {
  const ts = now.getTime();
  const out = new Map<string, number>();
  for (const id of userIds) {
    const v = local.get(key(workspaceId, id));
    if (v) out.set(id, v);
  }

  const missing = userIds.filter((id) => {
    const v = out.get(id);
    return !v || ts - v >= OPERATOR_ACTIVITY_ACTIVE_MS;
  });
  if (!missing.length) return out;

  // Exact distributed index — precise to the millisecond, so `away` triggers
  // at exactly 5 minutes even when the beat landed elsewhere. Without it only
  // this node's own map answers (see the header).
  const exact = await readExactActivity(workspaceId, missing);
  if (exact) {
    for (const [id, at] of exact) {
      const capped = Math.min(at, ts);
      if (capped > (out.get(id) || 0)) out.set(id, capped);
    }
  }
  return out;
}
