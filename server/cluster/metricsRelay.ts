/**
 * Monitoring samples for the whole container, in cluster mode
 * (docs/operations/BACKEND_PROCESSES.md, "Metrics").
 *
 * Each worker keeps its own in-memory collector (services/observability/
 * collector/index.ts). Wrapped by this decorator, a worker records each
 * request and realtime sample locally as before, and also sends it to the
 * primary in a batch every RELAY_EVERY_MS (at most MAX_BATCH samples); the
 * primary passes each batch to every other worker, which records it into its
 * own collector and never sends it on. So every worker's collector holds the
 * whole container's samples, at most about a second late against windows of
 * a minute or more: failover (realtime/failoverHealth.ts), alerting, the
 * admin monitoring pages and /metrics see all the traffic, not 1/N of it.
 *
 * Process samples (event-loop lag, memory) stay per worker: they describe
 * the process that took them.
 */
import type { MonitoringCollector, RealtimeMetricInput, RequestSampleInput } from '../services/observability/collector/types.js';
import { onPrimaryNotice, sendToPrimary } from './client.js';
import type { MetricsBatch, PrimaryNotice } from './protocol.js';

export const RELAY_EVERY_MS = 1_000;
export const MAX_BATCH = 2_000;

export class RelayingMonitoringCollector implements MonitoringCollector {
  private realtime: RealtimeMetricInput[] = [];
  private perf: RequestSampleInput[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly inner: MonitoringCollector,
    private readonly send: (message: unknown) => void = sendToPrimary,
  ) {}

  private queued(): number {
    return this.realtime.length + this.perf.length;
  }

  private schedule(): void {
    if (this.queued() >= MAX_BATCH) {
      this.flush();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), RELAY_EVERY_MS);
    this.timer.unref?.();
  }

  /** Sends what is queued now (also on the timer). */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.queued()) return;
    const batch: MetricsBatch = { realtime: this.realtime, perf: this.perf };
    this.realtime = [];
    this.perf = [];
    this.send({ kcb: 1, op: 'metrics', batch });
  }

  /** A sibling's batch: recorded here, never sent on. */
  ingest(batch: MetricsBatch | null | undefined): void {
    if (!batch) return;
    for (const r of Array.isArray(batch.realtime) ? batch.realtime : []) {
      if (r && typeof (r as RealtimeMetricInput).metric === 'string') this.inner.recordRealtimeMetric(r as RealtimeMetricInput);
    }
    for (const p of Array.isArray(batch.perf) ? batch.perf : []) {
      if (p && typeof (p as RequestSampleInput).routeGroup === 'string') this.inner.recordRequestSample(p as RequestSampleInput);
    }
  }

  recordRealtimeMetric(input: RealtimeMetricInput): void {
    this.inner.recordRealtimeMetric(input);
    this.realtime.push(input);
    this.schedule();
  }
  recordRequestSample(input: RequestSampleInput): void {
    this.inner.recordRequestSample(input);
    this.perf.push(input);
    this.schedule();
  }

  queryRealtimeSummary(range: '1h' | '24h' | '7d') {
    return this.inner.queryRealtimeSummary(range);
  }
  queryRealtimeEvents(opts: { metric?: string; limit: number }) {
    return this.inner.queryRealtimeEvents(opts);
  }
  queryRealtimeCount(metric: string, windowSeconds: number) {
    return this.inner.queryRealtimeCount(metric, windowSeconds);
  }
  queryRealtimeRatio(numerator: string, denominator: string, windowSeconds: number) {
    return this.inner.queryRealtimeRatio(numerator, denominator, windowSeconds);
  }
  queryRealtimeCountByDriver(metric: string, driver: string, windowSeconds: number) {
    return this.inner.queryRealtimeCountByDriver(metric, driver, windowSeconds);
  }
  queryPerfSummary(range: '1h' | '24h') {
    return this.inner.queryPerfSummary(range);
  }
  queryPerfPercentile(routeGroup: string, pct: number, windowSeconds: number) {
    return this.inner.queryPerfPercentile(routeGroup, pct, windowSeconds);
  }
  queryPerfErrorRate(routeGroup: string, windowSeconds: number) {
    return this.inner.queryPerfErrorRate(routeGroup, windowSeconds);
  }
  queryPerfP95ForRouteGroups(routeGroups: string[], windowSeconds: number) {
    return this.inner.queryPerfP95ForRouteGroups(routeGroups, windowSeconds);
  }
  snapshotProcessNow() {
    return this.inner.snapshotProcessNow();
  }
  queryProcessTrend(range: '1h' | '24h') {
    return this.inner.queryProcessTrend(range);
  }
  queryProcessAverage(metric: Parameters<MonitoringCollector['queryProcessAverage']>[0], windowSeconds: number, budgetBytes?: number) {
    return this.inner.queryProcessAverage(metric, windowSeconds, budgetBytes);
  }
  validateReconnect(workspaceId: string, subjectId: string) {
    return this.inner.validateReconnect(workspaceId, subjectId);
  }
  recordGrant(workspaceId: string, subjectId: string, tokenTtlMs: number): void {
    this.inner.recordGrant(workspaceId, subjectId, tokenTtlMs);
  }
}

/** Wraps the worker's collector and ingests the batches the primary passes on. */
export function relayMonitoringCollector(inner: MonitoringCollector): RelayingMonitoringCollector {
  const relay = new RelayingMonitoringCollector(inner);
  onPrimaryNotice('metrics', (notice: PrimaryNotice) => {
    if (notice.op === 'metrics') relay.ingest(notice.batch);
  });
  return relay;
}
