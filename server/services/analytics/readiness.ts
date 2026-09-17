/**
 * CUTOVER READINESS — is this deployment able to stop writing analytics to
 * PostgreSQL?
 *
 * Every check answers from a LIVE signal, never from a stored flag. That
 * distinction is the whole point: a readiness card that reports what an
 * operator once ticked is worse than no card, because it manufactures
 * confidence. So "the primary is healthy" means a probe object was written,
 * read back, queried and deleted; "durable ingestion is ready" means this
 * process just proved it can write to the spool directory; "historical
 * backfill is complete" means the seal ledger says so for every day that
 * has data.
 *
 * Three states, and the difference between the last two matters:
 *
 *   ready    — nothing left to do for this check.
 *   warning  — degraded, but would not corrupt or lose data at cutover.
 *   blocked  — flipping `s3_only` with this unresolved risks losing data or
 *              serving wrong numbers. ANY blocked check blocks the cutover.
 *
 * This module answers the question. It does not act on it: `s3_only` and
 * `readMode: 's3'` stay refused by the admin route regardless of what this
 * reports, because Phase 2.5 is not the cutover.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import {
  analyticsReplicaHealth,
  readAnalyticsPool,
  resolveAnalyticsTopology,
  type AnalyticsStoragePool,
} from './pool.js';
import { duckDbAvailability } from './duckdb.js';
import { parquetRuntimeSupport } from './parquet.js';
import { analyticsDurabilityReadiness } from './writer.js';
import { readParityState } from '../webAnalytics/store/parity.js';
import { readAnalyticsInstances } from './instances.js';

export type ReadinessState = 'ready' | 'warning' | 'blocked';

export interface ReadinessCheck {
  /** Stable key — the UI translates it; this is never user-facing prose. */
  key: string;
  state: ReadinessState;
  /**
   * A short, non-secret detail: a count, a version, a vendor name. Never a
   * credential, an endpoint or a bucket name.
   */
  detail?: string | null;
}

export interface CutoverReadiness {
  checks: ReadinessCheck[];
  /** True only when NO check is blocked. Warnings do not block. */
  s3OnlyEligible: boolean;
  /**
   * Always false in this build. The phase lock is independent of the checks
   * — even an all-green deployment does not get `s3_only` in Phase 2.5.
   */
  s3OnlyUnlocked: boolean;
  blockedCount: number;
  warningCount: number;
}

/** How long a parity run stays meaningful before it is treated as stale. */
const PARITY_FRESH_MS = 7 * 24 * 60 * 60 * 1000;

async function backfillCheck(
  config: ServerConfig,
  pool: AnalyticsStoragePool,
): Promise<ReadinessCheck> {
  if (!pool.enabled) return { key: 'historicalBackfill', state: 'blocked', detail: null };

  try {
    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('analytics_day_seals')
      .select('sealed_at, verified')
      .limit(5000);
    if (error) return { key: 'historicalBackfill', state: 'warning', detail: null };

    const rows = (data ?? []) as { sealed_at: string | null; verified: boolean }[];
    if (rows.length === 0) {
      // Nothing sealed at all. Not an error — a new install looks like this
      // — but it is not a deployment anyone should cut over either.
      return { key: 'historicalBackfill', state: 'blocked', detail: '0' };
    }

    const unsealed = rows.filter((r) => !r.sealed_at).length;
    const unverified = rows.filter((r) => r.sealed_at && !r.verified).length;

    // An unverified seal means the rebuilt row count did NOT match what
    // PostgreSQL held for that day. Cutting over on that is cutting over on
    // known-incomplete history.
    if (unverified > 0) return { key: 'historicalBackfill', state: 'blocked', detail: `${unverified}` };
    if (unsealed > 0) return { key: 'historicalBackfill', state: 'warning', detail: `${unsealed}` };
    return { key: 'historicalBackfill', state: 'ready', detail: `${rows.length}` };
  } catch {
    return { key: 'historicalBackfill', state: 'warning', detail: null };
  }
}

async function parityCheck(config: ServerConfig): Promise<ReadinessCheck> {
  try {
    const parity = await readParityState(config);
    if (!parity) return { key: 'productionParity', state: 'blocked', detail: null };
    if (parity.unavailable) return { key: 'productionParity', state: 'blocked', detail: null };
    if (parity.regressions > 0) {
      return { key: 'productionParity', state: 'blocked', detail: `${parity.regressions}` };
    }
    const age = Date.now() - Date.parse(parity.at);
    if (!Number.isFinite(age) || age > PARITY_FRESH_MS) {
      // Green, but too old to mean anything about the code running now.
      return { key: 'productionParity', state: 'warning', detail: parity.at };
    }
    return { key: 'productionParity', state: 'ready', detail: parity.at };
  } catch {
    return { key: 'productionParity', state: 'warning', detail: null };
  }
}

/**
 * Has workspace deletion been proven to reach the analytics namespace?
 *
 * Answered from the deletion ledger: a job that completed AFTER the
 * analytics prefixes were registered on the pool had to walk them, because
 * the worker cannot reach `db_cleanup` until every namespace pass verifies.
 * No completed job since then means the path is untested HERE, whatever the
 * test suite says about it elsewhere.
 */
async function deletionCheck(config: ServerConfig, pool: AnalyticsStoragePool): Promise<ReadinessCheck> {
  if (!pool.enabled) return { key: 'workspaceDeletion', state: 'blocked', detail: null };
  try {
    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('workspace_deletion_jobs')
      .select('status')
      .eq('status', 'completed')
      .limit(1);
    if (error) return { key: 'workspaceDeletion', state: 'warning', detail: null };
    const proven = ((data ?? []) as unknown[]).length > 0;
    return {
      key: 'workspaceDeletion',
      // A warning, not a block: never having deleted a workspace is the
      // normal state of a healthy install, and it does not risk data loss
      // at cutover the way an unproven spool does.
      state: proven ? 'ready' : 'warning',
      detail: proven ? 'verified' : null,
    };
  } catch {
    return { key: 'workspaceDeletion', state: 'warning', detail: null };
  }
}

/**
 * Has erasure been carried through to the lake?
 *
 * An erasure marks the affected workspace-days for rebuild; the seal cycle
 * then rewrites them from the anonymized source. A day that is marked and
 * still not rebuilt means the erased value is still in the objects, which is
 * the one state that must never be cut over on.
 */
async function erasureCheck(config: ServerConfig, pool: AnalyticsStoragePool): Promise<ReadinessCheck> {
  if (!pool.enabled) return { key: 'erasureApplied', state: 'blocked', detail: null };
  try {
    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('analytics_day_seals')
      .select('sealed_at, attempts')
      .is('sealed_at', null)
      .limit(1000);
    if (error) return { key: 'erasureApplied', state: 'warning', detail: null };

    // Days that were unsealed and have already been retried are the ones
    // stuck: a day unsealed a moment ago is simply waiting for the cycle.
    const rows = (data ?? []) as { sealed_at: string | null; attempts: number }[];
    const stuck = rows.filter((r) => (r.attempts ?? 0) > 0).length;
    if (stuck > 0) return { key: 'erasureApplied', state: 'blocked', detail: `${stuck}` };
    if (rows.length > 0) return { key: 'erasureApplied', state: 'warning', detail: `${rows.length}` };
    return { key: 'erasureApplied', state: 'ready', detail: '0' };
  } catch {
    return { key: 'erasureApplied', state: 'warning', detail: null };
  }
}

export async function cutoverReadiness(config: ServerConfig): Promise<CutoverReadiness> {
  const pool = await readAnalyticsPool(config);
  const topology = await resolveAnalyticsTopology(config, pool);
  const checks: ReadinessCheck[] = [];

  // 1 — an analytics primary is chosen AND has credentials.
  checks.push({
    key: 'primaryConfigured',
    state: topology.primary ? 'ready' : 'blocked',
    detail: pool.primary ?? null,
  });

  // 2 — the primary's last object round-trip. `lastError` is set by the
  // writer and the health check and cleared by a success.
  checks.push({
    key: 'primaryHealth',
    state: !topology.primary ? 'blocked' : pool.lastError ? 'blocked' : pool.lastWriteAt ? 'ready' : 'warning',
    detail: pool.lastWriteAt ?? null,
  });

  // 3 — replicas. Dirty replicas do not block a WRITE cutover (the primary
  // is canonical); they block PROMOTION, which is a different decision.
  const dirty = pool.replicas.filter((name) => analyticsReplicaHealth(pool, name) !== 'synchronized');
  checks.push({
    key: 'replicaHealth',
    state: pool.replicas.length === 0 ? 'warning' : dirty.length > 0 ? 'warning' : 'ready',
    detail: pool.replicas.length === 0 ? null : `${pool.replicas.length - dirty.length}/${pool.replicas.length}`,
  });

  // 4 — the embedded query engine. Without it there is no S3 read path at
  // all, so a read cutover is impossible.
  const engine = await duckDbAvailability();
  checks.push({
    key: 'duckdbAvailable',
    state: engine.available ? 'ready' : 'blocked',
    detail: engine.available ? 'installed' : null,
  });

  // 5 / 6 — history and parity.
  checks.push(await backfillCheck(config, pool));
  checks.push(await parityCheck(config));

  // 7 — deletion reaches the analytics namespace.
  checks.push(await deletionCheck(config, pool));

  // 8 — durable ingestion. THE `s3_only` blocker: without it, an accepted
  // event lives only in memory once PostgreSQL stops receiving it.
  const durability = analyticsDurabilityReadiness();
  checks.push({
    key: 'durableIngestion',
    state: durability.ready ? (durability.spoolEnabled ? 'ready' : 'warning') : 'blocked',
    detail: durability.ready ? (durability.spoolEnabled ? 'active' : 'available') : null,
  });

  // 9 — the runtime can actually produce the format.
  const runtime = parquetRuntimeSupport();
  checks.push({
    key: 'nodeRuntime',
    state: runtime.supported ? 'ready' : 'blocked',
    detail: runtime.nodeVersion,
  });

  // 10 — how many processes hold un-flushed rows, and does each have its own
  // durable volume? The spool is node-local, so a fleet is only as durable as
  // its weakest mount, and nothing inside a container can verify a mount.
  // One instance needs no promise; several need an explicit one, recorded
  // against the exact hostnames it was made for.
  const census = await readAnalyticsInstances(config);
  checks.push({
    key: 'multiInstanceDurability',
    state: !census.multiInstance ? 'ready' : census.acknowledged ? 'warning' : 'blocked',
    detail: `${census.count}`,
  });

  // 11 — erasure reaches the lake. `unseal_analytics_days` is what the
  // privacy anonymizer calls so a rebuilt day drops the erased values; a day
  // still sitting unsealed means an erasure was requested and the rebuild
  // that carries it out has not run.
  checks.push(await erasureCheck(config, pool));

  const blockedCount = checks.filter((c) => c.state === 'blocked').length;
  const warningCount = checks.filter((c) => c.state === 'warning').length;

  return {
    checks,
    s3OnlyEligible: blockedCount === 0,
    // Hard-coded. Phase 2.5 builds the readiness signal; it does not grant
    // the cutover, and no combination of green checks changes that here.
    s3OnlyUnlocked: false,
    blockedCount,
    warningCount,
  };
}
