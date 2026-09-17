/**
 * ANALYTICS DAY SEALING — durability for the in-process buffer, without a
 * queue, a spool service, or a single new container.
 *
 * ── The problem, stated exactly ──────────────────────────────────
 *
 * Rows live in memory between flushes (./writer.ts). SIGTERM, a container
 * restart, a crash, an OOM kill, a deploy, or a long S3 outage can destroy
 * a buffer whose events the tracking endpoint already accepted.
 *
 * ── Why this is not a spool ──────────────────────────────────────
 *
 * The rows are ALREADY durable. Phase 1 dual-writes, so every analytics row
 * exists in PostgreSQL (`visitor_page_views`, `web_analytics_events`,
 * `visitor_sessions`). The buffer therefore never needed to be durable — it
 * needed to be RECONSTRUCTIBLE.
 *
 * So the lake is two layers:
 *
 *   speed layer  — live `part-*.parquet` objects the flusher writes within
 *                  seconds, so today's data is queryable now. Lossy by
 *                  design: it is a cache of a durable source.
 *   batch layer  — once a UTC day is over, ONE pass rebuilds that
 *                  workspace-day from PostgreSQL, replaces every object for
 *                  the day, verifies the row count against the source, and
 *                  records the day as sealed.
 *
 * Whatever the buffer lost is restored by the rebuild, because the rebuild
 * never reads the buffer. Every failure mode in scope resolves to "at most
 * the current day's speed layer is incomplete, and the seal fixes it":
 *
 *   SIGTERM / deploy   — the ticker drains on shutdown; anything missed is
 *                        rebuilt when the day seals.
 *   crash / OOM        — nothing drains; the seal rebuilds the day.
 *   S3 unavailable     — flushes fail, rows are requeued, and if the outage
 *                        outlasts the process the seal rebuilds the day.
 *   duplicate flush    — the rebuild REPLACES the day, so duplicates cannot
 *                        survive a seal either.
 *
 * ── What was rejected, and why ───────────────────────────────────
 *
 *   Redis — server/lib/redisClient.ts is explicitly "strictly a cache:
 *           every failure mode degrades to no index, never to wrong data",
 *           is opt-in per feature, and is absent in most self-host
 *           deployments. Storing data whose loss matters in an optional
 *           cache is not durability.
 *   background_jobs — durable, but it is a Postgres table: routing each
 *           batch through it reintroduces exactly the PostgreSQL write
 *           volume this whole migration exists to remove, and its payload
 *           column is not a place for Parquet bytes.
 *   local disk spool — the backend does mount a persistent volume
 *           (`geoip-data:/app/data`), so a crash-safe append-and-replay
 *           spool is possible. But its guarantee is deployment-dependent:
 *           a REPLACED container, a scaled-down node, or a deployment
 *           without that volume loses the spool, and a mechanism whose
 *           guarantee silently does not hold is worse than one whose
 *           limits are stated. It also would not compact, would not
 *           deduplicate, and would not carry erasure.
 *
 * ── Cost ─────────────────────────────────────────────────────────
 *
 * One bookkeeping row per workspace-day, and one rebuild per workspace-day
 * — not per event, not per batch. Against roughly 10,000 rows per flush
 * that is a rounding error, and the rebuild replaces a day's many small
 * live objects with a few large ones, which is a net reduction in object
 * count.
 *
 * ── What this is for, and when it stops being needed ─────────────
 *
 * Sealing exists to make a lost in-memory buffer free WHILE PostgreSQL is
 * still receiving every row. It rebuilds the day from that source. So it is
 * a `dual_write` mechanism, and under `s3_only` it cannot do its job at all:
 * the source it rebuilds from is gone.
 *
 * The durable spool (./spool.ts) is what carries durability after cutover —
 * an accepted event is on disk before the enqueue returns, and replays on the
 * next boot. Those two mechanisms answer the same question for different
 * write modes; they are not layered.
 *
 * Therefore:
 *   dual_write — sealing runs, and is the backstop.
 *   s3_only    — sealing does NOT run. `runSealCycle` returns immediately,
 *                because rebuilding a day from a database that no longer has
 *                the rows would replace good objects with incomplete ones.
 *
 * `analytics_day_seals` records ONE fact per workspace-day: that the day is
 * canonical. `sealed_at` is the only column any code reads back, so it is
 * now the only one written — a failed rebuild stores nothing at all and the
 * day is simply offered as work again next cycle. The counters and error
 * strings the table used to carry were analytics recording its own history,
 * and are gone. Nothing drops the table or its columns; after cutover it
 * simply stops being written to.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { readAnalyticsPool } from './pool.js';
import { backfillWorkspaceDay } from './backfill.js';

/**
 * How long after a UTC day ends before it may be sealed.
 *
 * Long enough that a straggling flush, a retried batch, or a clock skew
 * between nodes cannot race the rebuild; short enough that a day becomes
 * canonical while anyone still cares. A day sealed too early would simply
 * be resealed later if it changed, so this is a tuning value, not a
 * correctness boundary.
 */
const SEAL_GRACE_MS = 2 * 60 * 60 * 1000;

/** Workspace-days rebuilt per cycle. Bounds one cycle's work, never the total. */
const MAX_DAYS_PER_CYCLE = 25;

/** How far back to look for unsealed days. A longer outage is caught by repeated cycles. */
const LOOKBACK_DAYS = 45;

export interface SealCandidate {
  workspaceId: string;
  day: string;
}

export interface SealOutcome {
  workspaceId: string;
  day: string;
  sealed: boolean;
  rows: number;
  objects: number;
  replaced: number;
  sourceRows: number;
  verified: boolean;
  error?: string;
}

function dayKey(value: string | Date): string {
  return (value instanceof Date ? value.toISOString() : value).slice(0, 10);
}

/**
 * Workspace-days that have analytics rows in PostgreSQL, are old enough to
 * seal, and are not sealed yet.
 *
 * Derived from the SOURCE tables rather than from a work queue: a day that
 * exists in PostgreSQL and not in the seal table is unsealed by definition,
 * so there is no queue to get out of sync with reality, and a day whose
 * seal was invalidated (an erasure) simply reappears.
 */
export async function findSealCandidates(
  config: ServerConfig,
  opts?: { now?: number; limit?: number },
): Promise<SealCandidate[]> {
  const sb = getServiceClient(config);
  const now = opts?.now ?? Date.now();
  const cutoff = new Date(now - SEAL_GRACE_MS);
  const cutoffDay = dayKey(cutoff);
  const since = new Date(now - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const candidates = new Set<string>();

  // Page views and custom events are what a day's analytics objects are
  // made of; a session with neither produces a session_start/session_end
  // pair, so sessions are consulted too.
  const sources: { table: string; column: string }[] = [
    { table: 'visitor_page_views', column: 'viewed_at' },
    { table: 'web_analytics_events', column: 'created_at' },
    { table: 'visitor_sessions', column: 'started_at' },
  ];

  for (const source of sources) {
    const { data, error } = await sb
      .from(source.table)
      .select(`workspace_id, ${source.column}`)
      .gte(source.column, since)
      .lt(source.column, cutoff.toISOString())
      .order(source.column, { ascending: false })
      .limit(5000);
    if (error) throw new Error(`analytics_seal_scan_failed[${source.table}]: ${error.message}`);
    for (const row of (data ?? []) as unknown as Record<string, string>[]) {
      const day = dayKey(row[source.column]);
      // Strictly BEFORE the cutoff day: a day may only be sealed once it
      // has fully ended AND the grace period has elapsed since. `>` would
      // admit a day that ended minutes ago, whose last flushes may still be
      // in flight, and the rebuild would then replace objects the speed
      // layer was still writing.
      if (day >= cutoffDay) continue;
      candidates.add(`${row.workspace_id}|${day}`);
    }
  }

  if (candidates.size === 0) return [];

  // Subtract the days already sealed. One read for the whole candidate set.
  const { data: seals, error: sealError } = await sb
    .from('analytics_day_seals')
    .select('workspace_id, day, sealed_at')
    .gte('day', dayKey(new Date(now - LOOKBACK_DAYS * 24 * 60 * 60 * 1000)));
  if (sealError) throw new Error(`analytics_seal_state_read_failed: ${sealError.message}`);

  const sealed = new Set(
    ((seals ?? []) as { workspace_id: string; day: string; sealed_at: string | null }[])
      .filter((row) => row.sealed_at !== null)
      .map((row) => `${row.workspace_id}|${dayKey(row.day)}`),
  );

  // A workspace being deleted must NEVER be sealed. The rebuild reads
  // PostgreSQL rows the purge has not cascaded away yet and would write
  // fresh objects into a prefix the deletion walker has already verified
  // empty — objects no future job would ever walk, because the job is gone.
  const deleting = await deletingWorkspaceIds(sb);

  return [...candidates]
    .filter((key) => !sealed.has(key))
    .filter((key) => !deleting.has(key.split('|')[0]))
    .sort()
    .slice(0, opts?.limit ?? MAX_DAYS_PER_CYCLE)
    .map((key) => {
      const [workspaceId, day] = key.split('|');
      return { workspaceId, day };
    });
}

/**
 * Workspaces with deletion in flight, or already gone.
 *
 * Read fail-closed: if the lookup errors we cannot prove a workspace is
 * safe to seal, and writing objects into a namespace mid-purge is worse
 * than delaying a seal by one cycle.
 */
async function deletingWorkspaceIds(sb: ReturnType<typeof getServiceClient>): Promise<Set<string>> {
  const ids = new Set<string>();
  const { data, error } = await sb
    .from('workspace_deletion_jobs')
    .select('workspace_id, status')
    .in('status', ['pending', 'storage_cleanup', 'db_cleanup']);
  if (error) throw new Error(`analytics_seal_deletion_check_failed: ${error.message}`);
  for (const row of (data ?? []) as { workspace_id: string }[]) ids.add(row.workspace_id);
  return ids;
}

/**
 * Rebuild one workspace-day from PostgreSQL and record the outcome.
 *
 * The day is marked sealed ONLY when the rebuild wrote exactly as many rows
 * as PostgreSQL held and reported no errors. A partial rebuild leaves the
 * day unsealed with the error recorded, so the next cycle retries it rather
 * than the lake quietly claiming a day it did not finish.
 */
export async function sealWorkspaceDay(
  config: ServerConfig,
  workspaceId: string,
  day: string,
): Promise<SealOutcome> {
  const base: SealOutcome = {
    workspaceId, day, sealed: false, rows: 0, objects: 0, replaced: 0, sourceRows: 0, verified: false,
  };

  let result;
  try {
    // 'day' supersession: the rebuilt set replaces the speed layer, which is
    // exactly what makes a lost buffer costless.
    result = await backfillWorkspaceDay(config, workspaceId, day, { supersede: 'day' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await recordSeal(config, { ...base, error: message });
    return { ...base, error: message };
  }

  if (!result.ok || !result.report) {
    const message = result.error ?? 'rebuild failed';
    await recordSeal(config, { ...base, error: message });
    return { ...base, error: message };
  }

  const report = result.report;
  const outcome: SealOutcome = {
    workspaceId,
    day,
    sealed: report.verified,
    rows: report.rows,
    objects: report.objects.length,
    replaced: report.replaced,
    sourceRows: report.expected,
    verified: report.verified,
    error: report.verified ? undefined : (report.errors[0] ?? 'row count did not match the source'),
  };

  await recordSeal(config, outcome);
  return outcome;
}

async function recordSeal(config: ServerConfig, outcome: SealOutcome): Promise<void> {
  try {
    const sb = getServiceClient(config);
    await sb.rpc('record_analytics_day_seal', {
      _workspace_id: outcome.workspaceId,
      _day: outcome.day,
      _row_count: outcome.rows,
      _objects: outcome.objects,
      _source_row_count: outcome.sourceRows,
      _verified: outcome.verified,
      _error: outcome.error ?? null,
    });
  } catch (err: unknown) {
    // Never throw into the caller: the objects are already written, and a
    // lost bookkeeping write only costs one redundant reseal next cycle.
    console.error('[analytics] could not record day seal:', err instanceof Error ? err.message : err);
  }
}

export interface SealCycleResult {
  considered: number;
  sealed: number;
  failed: number;
  rows: number;
  objects: number;
}

/**
 * One sealing cycle: find unsealed past days and rebuild a bounded number
 * of them. No-ops entirely while analytics storage is disabled or has no
 * primary — there is nothing to make canonical.
 */
export async function runSealCycle(
  config: ServerConfig,
  opts?: { now?: number; limit?: number },
): Promise<SealCycleResult> {
  const empty: SealCycleResult = { considered: 0, sealed: 0, failed: 0, rows: 0, objects: 0 };

  const pool = await readAnalyticsPool(config);
  if (!pool.enabled || !pool.primary) return empty;

  // Sealing rebuilds a day FROM PostgreSQL. Under `s3_only` PostgreSQL no
  // longer receives the rows, so a rebuild would replace complete objects
  // with an incomplete day. See this file's header: after cutover the spool
  // carries durability and this mechanism retires rather than degrades.
  if (pool.writeMode === 's3_only') return empty;

  const candidates = await findSealCandidates(config, opts);
  if (candidates.length === 0) return empty;

  const result: SealCycleResult = { ...empty, considered: candidates.length };

  for (const candidate of candidates) {
    const outcome = await sealWorkspaceDay(config, candidate.workspaceId, candidate.day);
    if (outcome.sealed) {
      result.sealed++;
      result.rows += outcome.rows;
      result.objects += outcome.objects;
    } else {
      result.failed++;
    }
  }

  return result;
}

/**
 * Invalidate seals so the affected days are rebuilt from the (now changed)
 * PostgreSQL source.
 *
 * This is how an erasure reaches an immutable columnar store: you do not
 * edit Parquet, you rewrite the day. The privacy anonymizer rotates a
 * subject's `visitor_id` and clears their referrer in PostgreSQL; unsealing
 * the days they were active makes the next cycle rewrite those objects from
 * the anonymized rows.
 */
export async function unsealDays(
  config: ServerConfig,
  workspaceId: string,
  fromDay: string,
  toDay: string,
): Promise<number> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('unseal_analytics_days', {
    _workspace_id: workspaceId,
    _from: fromDay,
    _to: toDay,
  });
  if (error) throw new Error(`analytics_unseal_failed: ${error.message}`);
  return ((data ?? {}) as { unsealed?: number }).unsealed ?? 0;
}
