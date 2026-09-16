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
import { emitLog } from '../observability/metrics.js';
import { flushAnalytics, bufferedRowCount } from './writer.js';

/** Poll cadence, not the flush interval — the writer applies the operator's. */
const TICK_MS = 1_000;

let timer: ReturnType<typeof setInterval> | null = null;
let shutdownHooked = false;

export function startAnalyticsFlushTicker(config: ServerConfig): void {
  if (timer) return;
  timer = setInterval(() => {
    void flushAnalytics(config, { reason: 'tick' }).catch((err: unknown) => {
      emitLog(config, 'warn', 'analytics_flush_threw', {
        error: err instanceof Error ? err.message : 'unknown',
      });
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
    const drain = () => {
      if (bufferedRowCount() === 0) return;
      void flushAnalytics(config, { reason: 'shutdown', force: true });
    };
    process.once('SIGTERM', drain);
    process.once('SIGINT', drain);
    process.once('beforeExit', drain);
  }
}

export function __stopAnalyticsFlushTickerForTests(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
