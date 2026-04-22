/**
 * Phase 3 — Admin observability API.
 * Mounted under /api/admin/metrics (admin-auth applied by adminRouter).
 *
 * Endpoints (all admin-only):
 *   GET  /summary?range=1h|24h            → counters by metric (driver-split)
 *   GET  /events?metric=&limit=&since=    → recent raw events (max 200)
 *   POST /rollup                          → trigger rollup_and_prune now
 *
 * The summary endpoint reads from realtime_metric_events for ranges <= 24h
 * (cheap thanks to the time-DESC index) and from realtime_metric_hourly
 * for longer ranges (added in a later iteration if needed).
 */

import { Router } from 'express';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';

export const adminMetricsRouter = Router();

const RANGE_MS: Record<string, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

adminMetricsRouter.get('/summary', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const range = String(req.query.range || '1h');
    const ms = RANGE_MS[range] ?? RANGE_MS['1h'];
    const since = new Date(Date.now() - ms).toISOString();

    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('realtime_metric_events')
      .select('metric, driver, source')
      .gte('occurred_at', since)
      .limit(10_000); // safety bound — admin UI shows last 10k events
    if (error) {
      return res.status(500).json({ error: error.message });
    }
    const counts: Record<string, { total: number; by_driver: Record<string, number>; by_source: Record<string, number> }> = {};
    for (const row of data || []) {
      const m = row.metric as string;
      if (!counts[m]) counts[m] = { total: 0, by_driver: {}, by_source: {} };
      counts[m].total += 1;
      const d = (row.driver as string) || '_none_';
      counts[m].by_driver[d] = (counts[m].by_driver[d] || 0) + 1;
      const s = (row.source as string) || 'server';
      counts[m].by_source[s] = (counts[m].by_source[s] || 0) + 1;
    }
    res.json({ range, since, counts });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to load summary' });
  }
});

adminMetricsRouter.get('/events', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const metric = req.query.metric ? String(req.query.metric) : null;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '50'), 10) || 50, 1), 200);
    const since = req.query.since
      ? new Date(String(req.query.since)).toISOString()
      : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const sb = getServiceClient(config);
    let q = sb
      .from('realtime_metric_events')
      .select('id, occurred_at, metric, workspace_id, conversation_id, driver, source, tags')
      .gte('occurred_at', since)
      .order('occurred_at', { ascending: false })
      .limit(limit);
    if (metric) q = q.eq('metric', metric);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ events: data || [] });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to load events' });
  }
});

adminMetricsRouter.post('/rollup', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);
    const { data, error } = await sb.rpc('realtime_metrics_rollup_and_prune');
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, result: data });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Rollup failed' });
  }
});
