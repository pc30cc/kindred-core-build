/**
 * Admin observability API — realtime metrics.
 * Mounted under /api/admin/metrics (admin-auth applied by adminRouter).
 *
 * Endpoints (all admin-only):
 *   GET  /summary?range=1h|24h|7d          → counters by metric (driver-split)
 *   GET  /events?metric=&limit=            → recent events (bounded in-memory buffer, not a time range)
 *
 * Backed by the Live Monitoring collector (server/services/observability/collector)
 * — no longer reads realtime_metric_events from Postgres.
 */

import { Router } from 'express';
import { getMonitoringCollector } from '../services/observability/collector/index.js';

export const adminMetricsRouter = Router();

adminMetricsRouter.get('/summary', (req, res) => {
  try {
    const range = String(req.query.range || '1h') as '1h' | '24h' | '7d';
    const collector = getMonitoringCollector();
    res.json(collector.queryRealtimeSummary(range === '24h' || range === '7d' ? range : '1h'));
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to load summary' });
  }
});

adminMetricsRouter.get('/events', (req, res) => {
  try {
    const metric = req.query.metric ? String(req.query.metric) : undefined;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '50'), 10) || 50, 1), 200);
    const events = getMonitoringCollector().queryRealtimeEvents({ metric, limit });
    res.json({ events });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to load events' });
  }
});
