/**
 * Data-retention worker (WORKER_KIND=retention).
 *
 * A ticker, not a job queue: retention is a periodic sweep over declared
 * policies, and the engine itself is already idempotent, bounded and
 * resumable (server/services/retention/retentionService.ts), so there is
 * nothing to enqueue. Deployed from the same shared Dockerfile.worker image
 * as every other kind.
 *
 * RETENTION_DRY_RUN=1 makes this container report-only — useful for the
 * first production rollout, where you want the run ledger populated before
 * anything is deleted.
 */
import { loadConfig } from '../../server/config.js';
import { runAllPolicies } from '../../server/services/retention/retentionService.js';
import { ensureFuturePartitions, validatePartitionLayout } from '../../server/services/retention/partitionService.js';
import { intFromEnv } from '../../server/services/jobs/idleBackoff.js';

// Clamped: a bare parseInt read "6h" as 6ms, and NaN as a 1ms timer — a
// retention sweep running back to back forever.
const INTERVAL_MS = intFromEnv(process.env.RETENTION_INTERVAL_MS, 6 * 60 * 60 * 1000, 60_000, 7 * 24 * 60 * 60 * 1000);
const DRY_RUN = process.env.RETENTION_DRY_RUN === '1' || process.env.RETENTION_DRY_RUN === 'true';

function log(event: string, data: Record<string, unknown> = {}) {
  try { console.log(`[retention-worker] ${event}`, JSON.stringify(data)); }
  catch { console.log(`[retention-worker] ${event}`); }
}

let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const config = loadConfig();

    // Partition maintenance runs FIRST and independently: a missing future
    // partition is an availability problem, so it must not be blocked by a
    // slow or failing retention sweep. Creation is idempotent and additive.
    try {
      const created = await ensureFuturePartitions(config);
      for (const c of created) log('partitions ensured', { table: c.table, partitions: c.partitions });
      const layout = await validatePartitionLayout(config);
      for (const a of layout.alerts) log('partition alert', { table: a.table, severity: a.severity, code: a.code });
    } catch (err) {
      log('partition maintenance failed', { message: (err as Error)?.message });
    }

    const outcomes = await runAllPolicies(config, { dryRun: DRY_RUN, triggeredBy: 'scheduler' });
    for (const o of outcomes) {
      log('policy run', {
        policy: o.policyKey, status: o.status, matched: o.rowsMatched,
        deleted: o.rowsDeleted, archived: o.rowsArchived, error: o.error,
      });
    }
  } catch (err) {
    log('tick failed', { message: (err as Error)?.message });
  } finally {
    running = false;
  }
}

export function startRetentionWorker(): void {
  log('starting', { intervalMs: INTERVAL_MS, dryRun: DRY_RUN });
  // First sweep shortly after boot, then on the configured interval.
  setTimeout(() => { void tick(); }, 30_000);
  setInterval(() => { void tick(); }, INTERVAL_MS);
}
