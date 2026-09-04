/**
 * Bounded in-memory replacement for `perf_request_samples` /
 * `perf_request_hourly`.
 *
 * Keyed by `${route_group}|${method}` — in practice exactly 5 keys, one per
 * perfHttpMiddleware() call site (all compile-time literals, never derived
 * from request input), each holding a 60-slot minute ring (1h) and a
 * 24-slot hour ring (24h, replacing the old perf_request_hourly table).
 */
import { MINUTE_SLOTS, HOURLY_SLOTS_PERF, MAX_PERF_ROUTE_KEYS } from './constants.js';
import {
  PerfBucket,
  makePerfBucket,
  advancePerf,
  sumPerfWindow,
  percentileFromHistogram,
  bucketKeyForDuration,
} from './ringBuffer.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export interface RequestSampleInput {
  routeGroup: string;
  method: string;
  statusCode: number;
  durationMs: number;
}

export interface PerfRouteRow {
  route_group: string;
  method: string;
  count: number;
  error_count: number;
  sum_ms: number;
  max_ms: number;
  p50: number;
  p95: number;
  p99: number;
  error_rate: number;
  status_groups: Record<string, number>;
}

export interface PerfSummary {
  range: string;
  since: string;
  rows: PerfRouteRow[];
}

interface RouteState {
  routeGroup: string;
  method: string;
  minuteRing: PerfBucket[];
  hourRing: PerfBucket[];
}

function statusGroup(code: number): string {
  if (code >= 500) return '5xx';
  if (code >= 400) return '4xx';
  if (code >= 300) return '3xx';
  return '2xx';
}

export class PerfCollector {
  private readonly routes = new Map<string, RouteState>();

  private stateFor(routeGroup: string, method: string): RouteState | null {
    const key = `${routeGroup}|${method}`;
    let state = this.routes.get(key);
    if (!state) {
      if (this.routes.size >= MAX_PERF_ROUTE_KEYS) return null; // defensive bound, should never trigger
      state = {
        routeGroup,
        method,
        minuteRing: Array.from({ length: MINUTE_SLOTS }, makePerfBucket),
        hourRing: Array.from({ length: HOURLY_SLOTS_PERF }, makePerfBucket),
      };
      this.routes.set(key, state);
    }
    return state;
  }

  record(input: RequestSampleInput): void {
    const state = this.stateFor(input.routeGroup, input.method);
    if (!state) return;
    const now = Date.now();
    const isError = input.statusCode >= 500;
    const sg = statusGroup(input.statusCode);
    const histKey = bucketKeyForDuration(input.durationMs);

    for (const [ring, slotMs] of [
      [state.minuteRing, MINUTE_MS],
      [state.hourRing, HOUR_MS],
    ] as const) {
      const bucket = advancePerf(ring, now, slotMs);
      bucket.count += 1;
      if (isError) bucket.errorCount += 1;
      bucket.sumMs += input.durationMs;
      if (input.durationMs > bucket.maxMs) bucket.maxMs = input.durationMs;
      bucket.histogram[histKey] = (bucket.histogram[histKey] || 0) + 1;
      bucket.statusGroups[sg] = (bucket.statusGroups[sg] || 0) + 1;
    }
  }

  querySummary(range: '1h' | '24h'): PerfSummary {
    const now = Date.now();
    const rows: PerfRouteRow[] = [];
    for (const state of this.routes.values()) {
      const routeGroup = state.routeGroup;
      const agg =
        range === '1h'
          ? sumPerfWindow(state.minuteRing, now, MINUTE_MS, MINUTE_SLOTS)
          : sumPerfWindow(state.hourRing, now, HOUR_MS, HOURLY_SLOTS_PERF);
      if (agg.count === 0) continue;
      rows.push({
        route_group: routeGroup,
        method: state.method,
        count: agg.count,
        error_count: agg.errorCount,
        sum_ms: agg.sumMs,
        max_ms: agg.maxMs,
        p50: percentileFromHistogram(agg.histogram, agg.count, 50),
        p95: percentileFromHistogram(agg.histogram, agg.count, 95),
        p99: percentileFromHistogram(agg.histogram, agg.count, 99),
        error_rate: agg.count ? agg.errorCount / agg.count : 0,
        status_groups: agg.statusGroups,
      });
    }
    rows.sort((a, b) => b.count - a.count);
    const sinceMs = range === '1h' ? now - MINUTE_MS * MINUTE_SLOTS : now - HOUR_MS * HOURLY_SLOTS_PERF;
    return { range, since: new Date(sinceMs).toISOString(), rows };
  }

  queryPercentile(routeGroup: string, pct: number, windowSeconds: number): { value: number; sample: number } {
    const agg = this.windowAggForRouteGroup(routeGroup, windowSeconds);
    if (!agg || agg.count === 0) return { value: 0, sample: 0 };
    return { value: percentileFromHistogram(agg.histogram, agg.count, pct), sample: agg.count };
  }

  queryErrorRate(routeGroup: string, windowSeconds: number): { rate: number; sample: number } {
    const agg = this.windowAggForRouteGroup(routeGroup, windowSeconds);
    if (!agg || agg.count === 0) return { rate: 0, sample: 0 };
    return { rate: agg.errorCount / agg.count, sample: agg.count };
  }

  queryP95ForRouteGroups(routeGroups: string[], windowSeconds: number): { p95: number | null; sample: number } {
    let count = 0;
    const merged: Record<string, number> = {};
    for (const rg of routeGroups) {
      const agg = this.windowAggForRouteGroup(rg, windowSeconds);
      if (!agg) continue;
      count += agg.count;
      for (const [k, v] of Object.entries(agg.histogram)) merged[k] = (merged[k] || 0) + v;
    }
    if (count === 0) return { p95: null, sample: 0 };
    return { p95: percentileFromHistogram(merged, count, 95), sample: count };
  }

  private windowAggForRouteGroup(
    routeGroup: string,
    windowSeconds: number,
  ): { count: number; errorCount: number; sumMs: number; maxMs: number; histogram: Record<string, number>; statusGroups: Record<string, number> } | null {
    const now = Date.now();
    const windowSlots = Math.max(1, Math.ceil(windowSeconds / 60));
    let merged: ReturnType<typeof sumPerfWindow> | null = null;
    for (const [key, state] of this.routes) {
      if (!key.startsWith(`${routeGroup}|`)) continue;
      const agg = sumPerfWindow(state.minuteRing, now, MINUTE_MS, windowSlots);
      if (!merged) {
        merged = agg;
        continue;
      }
      merged.count += agg.count;
      merged.errorCount += agg.errorCount;
      merged.sumMs += agg.sumMs;
      merged.maxMs = Math.max(merged.maxMs, agg.maxMs);
      for (const [k, v] of Object.entries(agg.histogram)) merged.histogram[k] = (merged.histogram[k] || 0) + v;
      for (const [k, v] of Object.entries(agg.statusGroups)) merged.statusGroups[k] = (merged.statusGroups[k] || 0) + v;
    }
    return merged;
  }
}
