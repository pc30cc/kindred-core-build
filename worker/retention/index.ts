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

const INTERVAL_MS = parseInt(process.env.RETENTION_INTERVAL_MS || String(6 * 60 * 60 * 1000), 10);
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
