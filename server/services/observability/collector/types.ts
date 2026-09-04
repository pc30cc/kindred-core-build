/**
 * The Live Monitoring swap boundary. Only this interface should be
 * imported by callers (admin routes, the alert evaluator, failoverHealth,
 * the reconnect-labeling fix) — a future Redis- or OpenTelemetry-backed
 * implementation can replace InMemoryMonitoringCollector (collector/index.ts)
 * without touching any call site.
 */
import type { RealtimeMetricInput, RealtimeEventRow, RealtimeSummary } from './realtimeCollector.js';
import type { RequestSampleInput, PerfSummary } from './perfCollector.js';
import type { ProcessSnapshot, ProcessTrend, ProcessAverageMetric } from './processCollector.js';
import type { ReconnectValidation } from './reconnectClassifier.js';

export type {
  RealtimeMetricInput,
  RealtimeEventRow,
  RealtimeSummary,
  RequestSampleInput,
  PerfSummary,
  ProcessSnapshot,
  ProcessTrend,
  ProcessAverageMetric,
  ReconnectValidation,
};
export type { PerfRouteRow } from './perfCollector.js';

export interface MonitoringCollector {
  // Realtime metrics (replaces realtime_metric_events)
  recordRealtimeMetric(input: RealtimeMetricInput): void;
  queryRealtimeSummary(range: '1h' | '24h' | '7d'): RealtimeSummary;
  queryRealtimeEvents(opts: { metric?: string; limit: number }): RealtimeEventRow[];
  queryRealtimeCount(metric: string, windowSeconds: number): number;
  queryRealtimeRatio(numerator: string, denominator: string, windowSeconds: number): { num: number; den: number };
  queryRealtimeCountByDriver(metric: string, driver: string, windowSeconds: number): number;

  // Request performance (replaces perf_request_samples / perf_request_hourly)
  recordRequestSample(input: RequestSampleInput): void;
  queryPerfSummary(range: '1h' | '24h'): PerfSummary;
  queryPerfPercentile(routeGroup: string, pct: number, windowSeconds: number): { value: number; sample: number };
  queryPerfErrorRate(routeGroup: string, windowSeconds: number): { rate: number; sample: number };
  queryPerfP95ForRouteGroups(routeGroups: string[], windowSeconds: number): { p95: number | null; sample: number };

  // Process performance (replaces perf_process_samples)
  snapshotProcessNow(): ProcessSnapshot;
  queryProcessTrend(range: '1h' | '24h'): ProcessTrend;
  queryProcessAverage(metric: ProcessAverageMetric, windowSeconds: number, budgetBytes?: number): { value: number; sample: number };

  // Reconnect-labeling fix — the client declares intent; this is
  // dedup/validation support only, not classification. See
  // reconnectClassifier.ts.
  validateReconnect(workspaceId: string, subjectId: string): ReconnectValidation;
  recordGrant(workspaceId: string, subjectId: string, tokenTtlMs: number): void;
}
