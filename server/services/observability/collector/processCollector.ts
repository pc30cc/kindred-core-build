/**
 * Bounded in-memory replacement for `perf_process_samples`.
 *
 * `snapshotNow()` is computed live from the Node runtime on every call — no
 * buffering needed for "current" values. A separate, low-frequency trend
 * sampler pushes one snapshot per tick into a fixed PROCESS_TREND_CAPACITY-slot
 * (1440, i.e. 24h at 60s cadence) circular array purely to drive the admin
 * dashboard's sparkline / `/process?range=` `samples` array — never
 * PostgreSQL. This preserves the pre-migration perf_process_samples 24h
 * query contract; it is still bounded (fixed slot count, not fixed duration
 * — a longer sample interval would cover more wall-clock time, a shorter
 * one less).
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import { PROCESS_TREND_CAPACITY } from './constants.js';

export interface ProcessSnapshot {
  occurred_at: string;
  event_loop_lag_ms: number;
  rss_bytes: number;
  heap_used_bytes: number;
  heap_total_bytes: number;
  /** V8's hard ceiling for this process. Constant for the process lifetime. */
  heap_limit_bytes: number;
  uptime_seconds: number;
}

export interface ProcessTrend {
  range: string;
  since: string;
  samples: ProcessSnapshot[];
  latest: ProcessSnapshot | null;
}

export type ProcessAverageMetric =
  | 'event_loop_lag_ms'
  | 'rss_pct_of_budget'
  | 'heap_used_over_total'
  /**
   * True heap saturation: heapUsed / V8 heap_size_limit.
   *
   * heap_used_over_total is NOT a saturation signal — V8 keeps heapTotal
   * only slightly above heapUsed and shrinks it after a GC, so a healthy
   * process idles around 0.75-0.95 on that ratio and any threshold on it
   * fires constantly. The limit is fixed, so this ratio only rises when the
   * process is genuinely approaching OOM.
   */
  | 'heap_used_over_limit';

const DEFAULT_BUDGET_BYTES = 512 * 1024 * 1024;
const HEAP_LIMIT_BYTES = getHeapStatistics().heap_size_limit;

export class ProcessCollector {
  private elDelay: ReturnType<typeof monitorEventLoopDelay> | null = null;
  private readonly trend: ProcessSnapshot[] = [];
  private trendCursor = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  private ensureEventLoopMonitor(): void {
    if (!this.elDelay) {
      this.elDelay = monitorEventLoopDelay({ resolution: 20 });
      this.elDelay.enable();
    }
  }

  /** Live snapshot — never buffered. Does not reset the event-loop-lag histogram (only the trend sampler tick does), so concurrent admin requests don't perturb each other's reading. */
  snapshotNow(): ProcessSnapshot {
    this.ensureEventLoopMonitor();
    const mem = process.memoryUsage();
    const rawLag = this.elDelay ? this.elDelay.mean / 1e6 : 0;
    const lagMs = Number.isFinite(rawLag) ? Number(rawLag.toFixed(3)) : 0;
    return {
      occurred_at: new Date().toISOString(),
      event_loop_lag_ms: lagMs,
      rss_bytes: mem.rss,
      heap_used_bytes: mem.heapUsed,
      heap_total_bytes: mem.heapTotal,
      heap_limit_bytes: HEAP_LIMIT_BYTES,
      uptime_seconds: Math.round(process.uptime()),
    };
  }

  startTrendSampler(intervalMs: number): void {
    this.ensureEventLoopMonitor();
    if (this.timer) return;
    this.timer = setInterval(() => {
      const snap = this.snapshotNow();
      if (this.elDelay) this.elDelay.reset();
      if (this.trend.length < PROCESS_TREND_CAPACITY) {
        this.trend.push(snap);
      } else {
        this.trend[this.trendCursor] = snap;
      }
      this.trendCursor = (this.trendCursor + 1) % PROCESS_TREND_CAPACITY;
    }, intervalMs);
    if (typeof (this.timer as any)?.unref === 'function') (this.timer as any).unref();
  }

  stopTrendSampler(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.trend.length = 0;
    this.trendCursor = 0;
    if (this.elDelay) {
      this.elDelay.disable();
      this.elDelay = null;
    }
  }

  private orderedTrend(): ProcessSnapshot[] {
    if (this.trend.length < PROCESS_TREND_CAPACITY) return this.trend.slice();
    return [...this.trend.slice(this.trendCursor), ...this.trend.slice(0, this.trendCursor)];
  }

  /**
   * The trend ring only ever covers PROCESS_TREND_CAPACITY * sample-interval
   * (24h at the default 60s cadence) regardless of the requested range — a
   * process that has been up less than the requested range will show
   * "since boot", not a full window of history. `latest` is always a fresh
   * live snapshot, never a stale trend entry.
   */
  queryTrend(range: '1h' | '24h'): ProcessTrend {
    const samples = this.orderedTrend();
    const sinceMs = Date.now() - (range === '1h' ? 3_600_000 : 86_400_000);
    return { range, since: new Date(sinceMs).toISOString(), samples, latest: this.snapshotNow() };
  }

  queryAverage(metric: ProcessAverageMetric, windowSeconds: number, budgetBytes?: number): { value: number; sample: number } {
    const cutoff = Date.now() - windowSeconds * 1000;
    const within = this.orderedTrend().filter((s) => new Date(s.occurred_at).getTime() >= cutoff);
    if (within.length === 0) return { value: 0, sample: 0 };

    if (metric === 'event_loop_lag_ms') {
      const avg = within.reduce((sum, s) => sum + s.event_loop_lag_ms, 0) / within.length;
      return { value: avg, sample: within.length };
    }
    if (metric === 'rss_pct_of_budget') {
      const budget = budgetBytes && budgetBytes > 0 ? budgetBytes : DEFAULT_BUDGET_BYTES;
      const avg = within.reduce((sum, s) => sum + s.rss_bytes / budget, 0) / within.length;
      return { value: avg, sample: within.length };
    }
    if (metric === 'heap_used_over_limit') {
      const avgUsedB = within.reduce((sum, s) => sum + s.heap_used_bytes, 0) / within.length;
      const limit = within[within.length - 1].heap_limit_bytes || HEAP_LIMIT_BYTES;
      return { value: limit > 0 ? avgUsedB / limit : 0, sample: within.length };
    }
    // heap_used_over_total — AVG(heap_used)/AVG(heap_total), matching the
    // original SQL semantics exactly (not an average of per-sample ratios).
    const avgUsed = within.reduce((sum, s) => sum + s.heap_used_bytes, 0) / within.length;
    const avgTotal = within.reduce((sum, s) => sum + s.heap_total_bytes, 0) / within.length;
    return { value: avgTotal > 0 ? avgUsed / avgTotal : 0, sample: within.length };
  }
}
