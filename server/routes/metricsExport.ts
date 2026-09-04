/**
 * Prometheus/OpenTelemetry readiness stub — GET /metrics.
 *
 * Off by default (returns 404, indistinguishable from a route that doesn't
 * exist) unless OBSERVABILITY_PROMETHEUS_ENABLED=1. Even when enabled, this
 * is never an unauthenticated public endpoint — a scraper must present
 * `Authorization: Bearer <OBSERVABILITY_PROMETHEUS_TOKEN>`. Scrapers don't
 * carry the admin session cookie, so this is mounted at the top level, not
 * under adminRouter's requireAdmin gate.
 *
 * Cardinality is enforced entirely in collector/prometheusExport.ts — this
 * route never touches the admin-only recent-events buffer, which is the
 * only structure carrying workspace_id/conversation_id.
 */
import { Router } from 'express';
import { getMonitoringCollector } from '../services/observability/collector/index.js';
import { renderPrometheusText } from '../services/observability/collector/prometheusExport.js';

export const metricsExportRouter = Router();

metricsExportRouter.get('/', (req, res) => {
  if (process.env.OBSERVABILITY_PROMETHEUS_ENABLED !== '1') {
    return res.status(404).end();
  }
  const expected = process.env.OBSERVABILITY_PROMETHEUS_TOKEN;
  if (!expected) {
    return res.status(503).type('text/plain').send('# prometheus export enabled but no token configured\n');
  }
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${expected}`) {
    return res.status(401).end();
  }
  res.set('Content-Type', 'text/plain; version=0.0.4');
  res.send(renderPrometheusText(getMonitoringCollector()));
});
