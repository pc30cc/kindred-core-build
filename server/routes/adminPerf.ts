/**
 * Phase 5A — Admin performance API.
 * Mounted under /api/admin/perf (admin auth applied by adminRouter).
 *
 * Endpoints (all admin-only):
 *   GET /summary?range=1h|24h
 *     → per-(route_group, method) p50/p95/p99 + count + error_count + error_rate.
 *       For 1h, percentiles are computed from raw perf_request_samples (exact).
 *       For 24h, percentiles are computed from histogram buckets in
 *       perf_request_hourly (approximate, cheap).
 *   GET /process?range=1h|24h
 *     → time-ordered process samples for charting.
 *   POST /rollup → trigger perf_metrics_rollup_and_prune now.
 */

import { Router } from 'express';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';

export const adminPerfRouter = Router();

const RANGE_MS: Record<string, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
};

// Histogram bucket upper bounds (ms). Must match perf_metrics_rollup_and_prune.
const BUCKET_EDGES_MS: Array<{ key: string; upper: number }> = [
  { key: '5', upper: 5 },
  { key: '10', upper: 10 },
  { key: '25', upper: 25 },
  { key: '50', upper: 50 },
  { key: '100', upper: 100 },
  { key: '200', upper: 200 },
  { key: '400', upper: 400 },
  { key: '800', upper: 800 },
  { key: '1500', upper: 1500 },
  { key: '3000', upper: 3000 },
  { key: '6000', upper: 6000 },
  { key: '12000', upper: 12000 },
  { key: '30000', upper: 30000 },
  { key: 'inf', upper: 60000 }, // upper sentinel for percentile interpolation
];

interface RouteAgg {
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
}

function percentileFromSorted(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function percentileFromHistogram(
  hist: Record<string, number>,
  total: number,
  p: number,
): number {
  if (total <= 0) return 0;
  const target = (p / 100) * total;
  let cum = 0;
  let prevUpper = 0;
  for (const { key, upper } of BUCKET_EDGES_MS) {
    const c = Number(hist[key] || 0);
    if (cum + c >= target) {
      // Linear interp inside the bucket.
      const need = target - cum;
      const frac = c > 0 ? need / c : 0;
      return Math.round(prevUpper + (upper - prevUpper) * frac);
    }
    cum += c;
    prevUpper = upper;
  }
  return prevUpper;
}

adminPerfRouter.get('/summary', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const range = String(req.query.range || '1h');
    const ms = RANGE_MS[range] ?? RANGE_MS['1h'];
    const since = new Date(Date.now() - ms).toISOString();
    const sb = getServiceClient(config);

    if (range === '1h') {
      // Exact percentiles from raw samples.
      const { data, error } = await (sb.from as any)('perf_request_samples')
        .select('route_group, method, status_group, duration_ms, is_error')
        .gte('occurred_at', since)
        .limit(20_000);
      if (error) return res.status(500).json({ error: error.message });

      const groups = new Map<string, { samples: number[]; ec: number; sum: number; max: number; status: Record<string, number> }>();
      for (const row of data || []) {
        const key = `${row.route_group}|${row.method}`;
        let g = groups.get(key);
        if (!g) {
          g = { samples: [], ec: 0, sum: 0, max: 0, status: {} };
          groups.set(key, g);
        }
        const d = Number(row.duration_ms) || 0;
        g.samples.push(d);
        if (row.is_error) g.ec += 1;
        g.sum += d;
        if (d > g.max) g.max = d;
        const sg = String(row.status_group || '2xx');
        g.status[sg] = (g.status[sg] || 0) + 1;
      }
      const rows: (RouteAgg & { status_groups: Record<string, number> })[] = [];
      for (const [key, g] of groups) {
        const [route_group, method] = key.split('|');
        const sorted = g.samples.slice().sort((a, b) => a - b);
        const count = sorted.length;
        rows.push({
          route_group,
          method,
          count,
          error_count: g.ec,
          sum_ms: g.sum,
          max_ms: g.max,
          p50: percentileFromSorted(sorted, 50),
          p95: percentileFromSorted(sorted, 95),
          p99: percentileFromSorted(sorted, 99),
          error_rate: count ? g.ec / count : 0,
          status_groups: g.status,
        });
      }
      rows.sort((a, b) => b.count - a.count);
      return res.json({ range, since, rows });
    }

    // 24h — read hourly rollups.
    const sinceHour = new Date(Date.now() - ms).toISOString();
    const { data, error } = await (sb.from as any)('perf_request_hourly')
      .select('route_group, method, status_group, count, error_count, sum_ms, max_ms, histogram')
      .gte('bucket_hour', sinceHour)
      .limit(5_000);
    if (error) return res.status(500).json({ error: error.message });

    const groups = new Map<string, { hist: Record<string, number>; count: number; ec: number; sum: number; max: number; status: Record<string, number> }>();
    for (const row of data || []) {
      const key = `${row.route_group}|${row.method}`;
      let g = groups.get(key);
      if (!g) {
        g = { hist: {}, count: 0, ec: 0, sum: 0, max: 0, status: {} };
        groups.set(key, g);
      }
      const c = Number(row.count) || 0;
      g.count += c;
      g.ec += Number(row.error_count) || 0;
      g.sum += Number(row.sum_ms) || 0;
      g.max = Math.max(g.max, Number(row.max_ms) || 0);
      const sg = String(row.status_group || '2xx');
      g.status[sg] = (g.status[sg] || 0) + c;
      const hist = (row.histogram || {}) as Record<string, number>;
      for (const k of Object.keys(hist)) {
        g.hist[k] = (g.hist[k] || 0) + Number(hist[k] || 0);
      }
    }
    const rows: (RouteAgg & { status_groups: Record<string, number> })[] = [];
    for (const [key, g] of groups) {
      const [route_group, method] = key.split('|');
      rows.push({
        route_group,
        method,
        count: g.count,
        error_count: g.ec,
        sum_ms: g.sum,
        max_ms: g.max,
        p50: percentileFromHistogram(g.hist, g.count, 50),
        p95: percentileFromHistogram(g.hist, g.count, 95),
        p99: percentileFromHistogram(g.hist, g.count, 99),
        error_rate: g.count ? g.ec / g.count : 0,
        status_groups: g.status,
      });
    }
    rows.sort((a, b) => b.count - a.count);
    res.json({ range, since: sinceHour, rows });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to load perf summary' });
  }
});

adminPerfRouter.get('/process', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const range = String(req.query.range || '1h');
    const ms = RANGE_MS[range] ?? RANGE_MS['1h'];
    const since = new Date(Date.now() - ms).toISOString();
    const sb = getServiceClient(config);
    const { data, error } = await (sb.from as any)('perf_process_samples')
      .select('occurred_at, event_loop_lag_ms, rss_bytes, heap_used_bytes, heap_total_bytes, uptime_seconds')
      .gte('occurred_at', since)
      .order('occurred_at', { ascending: false })
      .limit(2_000);
    if (error) return res.status(500).json({ error: error.message });
    const samples = (data || []).slice().reverse();
    const latest = samples.length ? samples[samples.length - 1] : null;
    res.json({ range, since, samples, latest });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to load process samples' });
  }
});

adminPerfRouter.post('/rollup', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);
    const { data, error } = await sb.rpc('perf_metrics_rollup_and_prune' as any);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, result: data });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Rollup failed' });
  }
});
