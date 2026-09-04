/**
 * Admin performance API — request/process performance.
 * Mounted under /api/admin/perf (admin auth applied by adminRouter).
 *
 * Endpoints (all admin-only):
 *   GET /summary?range=1h|24h
 *     → per-(route_group, method) p50/p95/p99 + count + error_count + error_rate.
 *       Both ranges are histogram-approximated from the Live Monitoring
 *       collector's bounded ring buffers (an intentional design choice —
 *       see server/services/observability/collector/perfCollector.ts —
 *       not a precision regression from the old exact-from-raw-rows path).
 *   GET /process?range=1h|24h
 *     → time-ordered process samples for charting; `latest` is always a
 *       fresh live snapshot, never a stale buffered sample.
 *
 * Backed by the Live Monitoring collector — no longer reads
 * perf_request_samples / perf_process_samples / perf_request_hourly from
 * Postgres.
 */

import { Router } from 'express';
import { getMonitoringCollector } from '../services/observability/collector/index.js';

export const adminPerfRouter = Router();

function normalizePerfRange(raw: unknown): '1h' | '24h' {
  return raw === '24h' ? '24h' : '1h';
}

adminPerfRouter.get('/summary', (req, res) => {
  try {
    const range = normalizePerfRange(req.query.range);
    res.json(getMonitoringCollector().queryPerfSummary(range));
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to load perf summary' });
  }
});

adminPerfRouter.get('/process', (req, res) => {
  try {
    const range = normalizePerfRange(req.query.range);
    res.json(getMonitoringCollector().queryProcessTrend(range));
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to load process samples' });
  }
});
