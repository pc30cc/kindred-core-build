/**
 * Bounded in-memory replacement for `realtime_metric_events`.
 *
 * Two structures, both fixed-size regardless of traffic volume:
 *   1. Per-metric counters — a Map pre-populated with every entry in
 *      KNOWN_REALTIME_METRICS (never grows), each holding a 60-slot minute
 *      ring (1h at full resolution) and a 168-slot hour ring (7 days).
 *   2. A 1000-entry circular "recent events" buffer for the admin-only
 *      debug feed (GET /api/admin/metrics/events) — this is the one
 *      structure that intentionally carries workspace_id/conversation_id,
 *      matching what that endpoint already returns today. It is never fed
 *      into the Prometheus exporter (see collector/prometheusExport.ts).
 */
import {
  KNOWN_REALTIME_METRICS,
  MINUTE_SLOTS,
  HOURLY_SLOTS_REALTIME,
  RECENT_EVENTS_CAPACITY,
  MAX_DRIVER_KEYS_PER_BUCKET,
  MAX_SOURCE_KEYS_PER_BUCKET,
} from './constants.js';
import { RealtimeBucket, makeRealtimeBucket, advanceRealtime, sumRealtimeWindow } from './ringBuffer.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export interface RealtimeMetricInput {
  metric: string;
  driver?: string | null;
  source?: string | null;
  workspaceId?: string | null;
  conversationId?: string | null;
  tags?: Record<string, unknown>;
}

export interface RealtimeEventRow {
  id: string;
  occurred_at: string;
  metric: string;
  workspace_id: string | null;
  conversation_id: string | null;
  driver: string | null;
  source: string;
  tags: Record<string, unknown>;
}

export interface RealtimeSummary {
  range: string;
  since: string;
  counts: Record<string, { total: number; by_driver: Record<string, number>; by_source: Record<string, number> }>;
}

interface MetricState {
  lastAt: number;
  minuteRing: RealtimeBucket[];
  hourRing: RealtimeBucket[];
}

export class RealtimeCollector {
  private readonly metrics = new Map<string, MetricState>();
  private readonly recentEvents: (RealtimeEventRow | undefined)[] = new Array(RECENT_EVENTS_CAPACITY);
  private recentWriteCursor = 0;
  private recentCount = 0;
  private nextEventSeq = 1;

  constructor() {
    for (const name of KNOWN_REALTIME_METRICS) {
      this.metrics.set(name, {
        lastAt: 0,
        minuteRing: Array.from({ length: MINUTE_SLOTS }, makeRealtimeBucket),
        hourRing: Array.from({ length: HOURLY_SLOTS_REALTIME }, makeRealtimeBucket),
      });
    }
  }

  record(input: RealtimeMetricInput): void {
    const state = this.metrics.get(input.metric);
    if (!state) return; // unknown metric — dropped, not stored (keeps the Map bounded)
    const now = Date.now();
    state.lastAt = now;
    const driver = input.driver || '_none_';
    const source = input.source || 'server';

    for (const [ring, slotMs] of [
      [state.minuteRing, MINUTE_MS],
      [state.hourRing, HOUR_MS],
    ] as const) {
      const bucket = advanceRealtime(ring, now, slotMs);
      bucket.total += 1;
      const driverKeys = Object.keys(bucket.byDriver).length;
      if (bucket.byDriver[driver] !== undefined || driverKeys < MAX_DRIVER_KEYS_PER_BUCKET) {
        bucket.byDriver[driver] = (bucket.byDriver[driver] || 0) + 1;
      }
      const sourceKeys = Object.keys(bucket.bySource).length;
      if (bucket.bySource[source] !== undefined || sourceKeys < MAX_SOURCE_KEYS_PER_BUCKET) {
        bucket.bySource[source] = (bucket.bySource[source] || 0) + 1;
      }
    }

    const row: RealtimeEventRow = {
      id: String(this.nextEventSeq++),
      occurred_at: new Date(now).toISOString(),
      metric: input.metric,
      workspace_id: input.workspaceId ?? null,
      conversation_id: input.conversationId ?? null,
      driver: input.driver ?? null,
      source,
      tags: input.tags || {},
    };
    this.recentEvents[this.recentWriteCursor] = row;
    this.recentWriteCursor = (this.recentWriteCursor + 1) % RECENT_EVENTS_CAPACITY;
    if (this.recentCount < RECENT_EVENTS_CAPACITY) this.recentCount += 1;
  }

  querySummary(range: '1h' | '24h' | '7d'): RealtimeSummary {
    const now = Date.now();
    const counts: RealtimeSummary['counts'] = {};
    for (const [metric, state] of this.metrics) {
      const agg =
        range === '1h'
          ? sumRealtimeWindow(state.minuteRing, now, MINUTE_MS, MINUTE_SLOTS)
          : sumRealtimeWindow(state.hourRing, now, HOUR_MS, range === '24h' ? 24 : HOURLY_SLOTS_REALTIME);
      if (agg.total > 0) {
        counts[metric] = { total: agg.total, by_driver: agg.byDriver, by_source: agg.bySource };
      }
    }
    const sinceMs =
      range === '1h' ? now - MINUTE_MS * MINUTE_SLOTS : range === '24h' ? now - HOUR_MS * 24 : now - HOUR_MS * HOURLY_SLOTS_REALTIME;
    return { range, since: new Date(sinceMs).toISOString(), counts };
  }

  /** Most-recent-first, from the bounded recent-events ring (not a time-range query — capped by entry count). */
  queryEvents(opts: { metric?: string; limit: number }): RealtimeEventRow[] {
    const out: RealtimeEventRow[] = [];
    let idx = (this.recentWriteCursor - 1 + RECENT_EVENTS_CAPACITY) % RECENT_EVENTS_CAPACITY;
    for (let i = 0; i < this.recentCount && out.length < opts.limit; i++) {
      const row = this.recentEvents[idx];
      if (row && (!opts.metric || row.metric === opts.metric)) out.push(row);
      idx = (idx - 1 + RECENT_EVENTS_CAPACITY) % RECENT_EVENTS_CAPACITY;
    }
    return out;
  }

  queryCount(metric: string, windowSeconds: number): number {
    const state = this.metrics.get(metric);
    if (!state) return 0;
    const windowSlots = Math.max(1, Math.ceil(windowSeconds / 60));
    return sumRealtimeWindow(state.minuteRing, Date.now(), MINUTE_MS, windowSlots).total;
  }

  queryRatio(numerator: string, denominator: string, windowSeconds: number): { num: number; den: number } {
    return { num: this.queryCount(numerator, windowSeconds), den: this.queryCount(denominator, windowSeconds) };
  }

  queryCountByDriver(metric: string, driver: string, windowSeconds: number): number {
    const state = this.metrics.get(metric);
    if (!state) return 0;
    const windowSlots = Math.max(1, Math.ceil(windowSeconds / 60));
    const agg = sumRealtimeWindow(state.minuteRing, Date.now(), MINUTE_MS, windowSlots);
    return agg.byDriver[driver] || 0;
  }

  lastOccurrence(metric: string): number {
    return this.metrics.get(metric)?.lastAt || 0;
  }
}
