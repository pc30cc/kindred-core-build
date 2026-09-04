/**
 * Live Monitoring — bounded in-memory MonitoringCollector.
 *
 * Composes the four sub-collectors behind the MonitoringCollector interface
 * (types.ts). This is the ONLY concrete implementation today; callers
 * should depend on the interface, not this class, so a future Redis- or
 * OpenTelemetry-backed implementation can be swapped in without touching
 * any call site.
 *
 * Total worst-case memory across every structure here is well under 2MB,
 * independent of traffic volume, workspace count, or conversation count —
 * every Map is either pre-populated from a fixed key set or hard-capped by
 * entry count with FIFO eviction. Restarting the process clears all of it,
 * which is an accepted trade-off (see the project's Live Monitoring plan).
 */
import type { ServerConfig } from '../../../config.js';
import type { MonitoringCollector } from './types.js';
import { RealtimeCollector, type RealtimeMetricInput } from './realtimeCollector.js';
import { PerfCollector, type RequestSampleInput } from './perfCollector.js';
import { ProcessCollector, type ProcessAverageMetric } from './processCollector.js';
import { ReconnectClassifier } from './reconnectClassifier.js';

const PROCESS_TREND_SAMPLE_MS = 60_000;

class InMemoryMonitoringCollector implements MonitoringCollector {
  private readonly realtime = new RealtimeCollector();
  private readonly perf = new PerfCollector();
  private readonly process = new ProcessCollector();
  private readonly reconnect = new ReconnectClassifier();

  recordRealtimeMetric(input: RealtimeMetricInput): void {
    this.realtime.record(input);
  }
  queryRealtimeSummary(range: '1h' | '24h' | '7d') {
    return this.realtime.querySummary(range);
  }
  queryRealtimeEvents(opts: { metric?: string; limit: number }) {
    return this.realtime.queryEvents(opts);
  }
  queryRealtimeCount(metric: string, windowSeconds: number): number {
    return this.realtime.queryCount(metric, windowSeconds);
  }
  queryRealtimeRatio(numerator: string, denominator: string, windowSeconds: number) {
    return this.realtime.queryRatio(numerator, denominator, windowSeconds);
  }
  queryRealtimeCountByDriver(metric: string, driver: string, windowSeconds: number): number {
    return this.realtime.queryCountByDriver(metric, driver, windowSeconds);
  }

  recordRequestSample(input: RequestSampleInput): void {
    this.perf.record(input);
  }
  queryPerfSummary(range: '1h' | '24h') {
    return this.perf.querySummary(range);
  }
  queryPerfPercentile(routeGroup: string, pct: number, windowSeconds: number) {
    return this.perf.queryPercentile(routeGroup, pct, windowSeconds);
  }
  queryPerfErrorRate(routeGroup: string, windowSeconds: number) {
    return this.perf.queryErrorRate(routeGroup, windowSeconds);
  }
  queryPerfP95ForRouteGroups(routeGroups: string[], windowSeconds: number) {
    return this.perf.queryP95ForRouteGroups(routeGroups, windowSeconds);
  }

  snapshotProcessNow() {
    return this.process.snapshotNow();
  }
  queryProcessTrend(range: '1h' | '24h') {
    return this.process.queryTrend(range);
  }
  queryProcessAverage(metric: ProcessAverageMetric, windowSeconds: number, budgetBytes?: number) {
    return this.process.queryAverage(metric, windowSeconds, budgetBytes);
  }

  validateReconnect(workspaceId: string, subjectId: string) {
    return this.reconnect.validateReconnect(workspaceId, subjectId);
  }
  recordGrant(workspaceId: string, subjectId: string, tokenTtlMs: number): void {
    this.reconnect.recordGrant(workspaceId, subjectId, tokenTtlMs);
  }

  startTrendSampler(): void {
    this.process.startTrendSampler(PROCESS_TREND_SAMPLE_MS);
  }
  stopTrendSampler(): void {
    this.process.stopTrendSampler();
  }
}

let instance: InMemoryMonitoringCollector | null = null;

export function getMonitoringCollector(): MonitoringCollector {
  if (!instance) instance = new InMemoryMonitoringCollector();
  return instance;
}

/** Call once at boot (server/index.ts) — starts the process trend sampler. */
export function startMonitoringCollector(_config: ServerConfig): void {
  getMonitoringCollector();
  instance!.startTrendSampler();
}

export function __resetMonitoringCollectorForTests(): void {
  if (instance) instance.stopTrendSampler();
  instance = null;
}

export type { MonitoringCollector } from './types.js';
