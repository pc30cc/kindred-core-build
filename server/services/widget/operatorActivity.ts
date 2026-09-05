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
 *   3. `operator_activity_samples` (5-minute analytics buckets) — READ ONLY,
 *      and only as a LAST RESORT when no exact index is configured/reachable.
 *      Coarse by construction (±5 min); it can only make an operator look
 *      active longer, never falsely away.
 *
 * ZERO new PostgreSQL writes are introduced by this module.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { getRedisClient } from '../../lib/redisClient.js';

/** Inactivity threshold that separates `active` from `away`. */
export const OPERATOR_ACTIVITY_ACTIVE_MS = 5 * 60_000;
/** Analytics buckets are floored to 5 minutes; add that to the read window. */
const ANALYTICS_BUCKET_MS = 5 * 60_000;

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

const metrics = { writes: 0, writes_coalesced: 0, write_failures: 0, reads: 0, read_failures: 0 };

export const operatorActivityKey = (workspaceId: string) => `op:activity:${workspaceId}`;

export function getOperatorActivityMetrics() {
  return { ...metrics, backend: activityRedisUrl() ? 'redis' : 'analytics_buckets' };
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

/** Coalesced ZADD of the exact timestamp. Fire-and-forget, never throws. */
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
    return;
  }
  if (lastRedisWriteAt.size >= MAX_ENTRIES) lastRedisWriteAt.clear();
  lastRedisWriteAt.set(k, at);
  try {
    const client = getRedisClient(url);
    const indexKey = operatorActivityKey(workspaceId);
    await client.command('ZADD', indexKey, Math.floor(at), userId);
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

/** Test/ops hook. */
export function resetOperatorActivity(): void {
  local.clear();
  lastRedisWriteAt.clear();
  lastPruneAt.clear();
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
  config: ServerConfig,
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

  const staleOrMissing = () =>
    userIds.filter((id) => {
      const v = out.get(id);
      return !v || ts - v >= OPERATOR_ACTIVITY_ACTIVE_MS;
    });

  let missing = staleOrMissing();
  if (!missing.length) return out;

  // 1) Exact distributed index — precise to the millisecond, so `away`
  //    triggers at exactly 5 minutes even when the beat landed elsewhere.
  const exact = await readExactActivity(workspaceId, missing);
  if (exact) {
    for (const [id, at] of exact) {
      const capped = Math.min(at, ts);
      if (capped > (out.get(id) || 0)) out.set(id, capped);
    }
    // The exact index answered — the coarse analytics fallback must NOT run,
    // otherwise it would re-inflate a correctly-aged operator back to active.
    return out;
  }

  missing = staleOrMissing();
  if (!missing.length) return out;

  try {
    const sb = getServiceClient(config);
    const since = new Date(ts - OPERATOR_ACTIVITY_ACTIVE_MS - ANALYTICS_BUCKET_MS).toISOString();
    const { data } = await sb
      .from('operator_activity_samples')
      .select('user_id, bucket')
      .eq('workspace_id', workspaceId)
      .in('user_id', missing)
      .gte('bucket', since);
    for (const row of (data || []) as Array<{ user_id: string; bucket: string }>) {
      // A bucket labelled T covers [T, T+5m); credit its end so a beat inside
      // the bucket is not aged by up to five extra minutes.
      const at = (Date.parse(row.bucket) || 0) + ANALYTICS_BUCKET_MS;
      const capped = Math.min(at, ts);
      const prev = out.get(row.user_id) || 0;
      if (capped > prev) out.set(row.user_id, capped);
    }
  } catch {
    // Analytics unreadable ⇒ fall back to the local map only. Worst case an
    // operator on another node shows as `away`, never as offline.
  }
  return out;
}
