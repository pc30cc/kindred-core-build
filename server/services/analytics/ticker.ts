/**
 * ANALYTICS FLUSH TICKER — in-process, same pattern as every other ticker
 * in this backend (alerting, auto-actions, enforcement, rank tracking): a
 * timer inside the running server, no new container, no new queue service.
 *
 * ONE deliberate difference from those tickers: it takes NO cross-replica
 * lease. The others coordinate work that must happen exactly once across
 * the fleet; this one drains a buffer that is LOCAL to this process. Every
 * process must flush its own, so a lease would strand rows on whichever
 * replica failed to win it.
 *
 * The timer runs at a fixed, short interval and asks the writer which
 * batches are actually due; the operator-configured `flushIntervalMs` is
 * what decides that, so changing it in the admin panel takes effect without
 * a restart.
 */
import type { ServerConfig } from '../../config.js';
import { acquireTickerLease, releaseTickerLease } from '../observability/tickerLease.js';
import { flushAnalytics, bufferedRowCount, replaySpooledRows } from './writer.js';
import { runSealCycle } from './sealing.js';
import { fsyncSpool } from './spool.js';

/** Poll cadence, not the flush interval — the writer applies the operator's. */
const TICK_MS = 1_000;

let timer: ReturnType<typeof setInterval> | null = null;
let shutdownHooked = false;

export function startAnalyticsFlushTicker(config: ServerConfig): void {
  if (timer) return;

  // BEFORE the first tick: put back whatever a previous process accepted
  // but never got into S3. Doing it here rather than in index.ts keeps the
  // ordering guarantee local — replay must not race the flush that drains
  // it. Never throws: a deployment with no writable spool boots exactly as
  // it did in Phase 2.
  try {
    const replayed = replaySpooledRows(config);
    if (replayed.rows > 0) {
    }
  } catch (err: unknown) {
  }

  timer = setInterval(() => {
    void flushAnalytics(config, { reason: 'tick' }).catch((err: unknown) => {
    });
  }, TICK_MS);
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }

  if (!shutdownHooked) {
    shutdownHooked = true;
    // A rolling deploy must not discard a partially filled buffer. Best
    // effort: if the process is killed hard, PostgreSQL still holds every
    // row (Phase 1 dual-writes), so nothing is lost that matters.
    //
    // CAREFUL: registering a SIGTERM/SIGINT listener REPLACES Node's default
    // behaviour of terminating on that signal. If this were the only
    // listener, adding it would stop the process exiting on deploy — every
    // rolling restart would stall until the container's grace period
    // expired. So the handler drains with a hard deadline and then exits
    // itself, restoring the semantics it displaced.
    const SHUTDOWN_DRAIN_MS = 5_000;
    let draining = false;

    const drain = (signal: NodeJS.Signals) => {
      if (draining) return;
      draining = true;

      const finish = () => {
        // Last thing before handing the signal back: push the spool's page
        // cache to disk. Whatever the drain below could not write to S3 is
        // then on the volume and replays on the next boot.
        try { fsyncSpool(); } catch { /* exiting regardless */ }
        process.kill(process.pid, signal === 'SIGINT' ? 'SIGINT' : 'SIGTERM');
      };
      // Re-raise on the DEFAULT handler once we are done (or out of time).
      process.removeListener('SIGTERM', drain);
      process.removeListener('SIGINT', drain);

      if (bufferedRowCount() === 0) { finish(); return; }

      const deadline = setTimeout(finish, SHUTDOWN_DRAIN_MS);
      if (typeof (deadline as { unref?: () => void }).unref === 'function') {
        (deadline as { unref: () => void }).unref();
      }
      void flushAnalytics(config, { reason: 'shutdown', force: true })
        .catch(() => undefined)
        .finally(() => { clearTimeout(deadline); finish(); });
    };

    process.once('SIGTERM', drain);
    process.once('SIGINT', drain);
    // beforeExit fires only on a natural, empty-loop exit — no signal to
    // re-raise there, so it just drains best-effort.
    process.once('beforeExit', () => {
      if (bufferedRowCount() > 0) void flushAnalytics(config, { reason: 'shutdown', force: true }).catch(() => undefined);
    });
  }
}

export function __stopAnalyticsFlushTickerForTests(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

// ─── Day sealing ─────────────────────────────────────────────────

/**
 * How often to look for past days that are not yet canonical.
 *
 * Unlike the flush timer above, this one DOES take a cross-replica lease:
 * sealing rebuilds a workspace-day and replaces its objects, which is
 * whole-fleet work that must happen exactly once at a time, not once per
 * process. The flush timer drains a buffer that is local to this process;
 * the seal cycle operates on shared storage.
 */
const SEAL_TICK_MS = 10 * 60 * 1000;
const SEAL_LEASE = 'analytics_day_seal';

let sealTimer: ReturnType<typeof setInterval> | null = null;

export function startAnalyticsSealTicker(config: ServerConfig): void {
  if (sealTimer) return;
  // Not immediately at boot: let the flush ticker and the rest of the
  // backend settle first, and avoid every replica of a rolling deploy
  // racing for the same lease in the same second.
  setTimeout(() => void runOnce(config), 90_000);
  sealTimer = setInterval(() => void runOnce(config), SEAL_TICK_MS);
  if (typeof (sealTimer as { unref?: () => void }).unref === 'function') {
    (sealTimer as { unref: () => void }).unref();
  }
}

async function runOnce(config: ServerConfig): Promise<void> {
  let leased = false;
  try {
    leased = await acquireTickerLease(config, SEAL_LEASE);
  } catch (err: unknown) {
    // Fail closed: skip this cycle rather than risk two replicas rebuilding
    // the same workspace-day and racing on its objects.
    return;
  }
  if (!leased) return;

  try {
    await runSealCycle(config);
  } catch (err: unknown) {
  } finally {
    await releaseTickerLease(config, SEAL_LEASE);
  }
}

export function __stopAnalyticsSealTickerForTests(): void {
  if (sealTimer) clearInterval(sealTimer);
  sealTimer = null;
}
