/**
 * INTERNAL OPERATOR ACTIVITY (active vs. away) — ephemeral.
 *
 * The teammate-facing presence model needs "is this operator actually doing
 * something right now?", with a 5-minute threshold. It must NOT introduce a
 * periodic PostgreSQL heartbeat.
 *
 * Two sources, unioned, newest wins:
 *
 *   1. PROCESS-LOCAL MAP (primary, precise, zero writes) — every
 *      interaction-gated operator beat that lands on this instance stamps
 *      `user → ts` here. Bounded and self-pruning.
 *   2. `operator_activity_samples` (already written for ANALYTICS at most
 *      once per 5-minute bucket) — READ ONLY, and only to cover the
 *      multi-instance case where the beat landed on another node. Bucket
 *      granularity means cross-node activity is coarse (±5 min), which is
 *      acceptable: it can only make an operator look active slightly longer,
 *      never falsely away.
 *
 * ZERO new writes are introduced by this module.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

/** Inactivity threshold that separates `active` from `away`. */
export const OPERATOR_ACTIVITY_ACTIVE_MS = 5 * 60_000;
/** Analytics buckets are floored to 5 minutes; add that to the read window. */
const ANALYTICS_BUCKET_MS = 5 * 60_000;

const MAX_ENTRIES = 20_000;
const local = new Map<string, number>();

function key(workspaceId: string, userId: string): string {
  return `${workspaceId}:${userId}`;
}

/** Stamp an operator interaction. In-memory only. */
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
}

/** Test/ops hook. */
export function resetOperatorActivity(): void {
  local.clear();
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

  const missing = userIds.filter((id) => {
    const v = out.get(id);
    return !v || ts - v >= OPERATOR_ACTIVITY_ACTIVE_MS;
  });
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
