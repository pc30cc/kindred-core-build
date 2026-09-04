/**
 * Live Monitoring — canonical combined admin endpoint.
 * Mounted under /api/admin/monitoring (admin-auth applied by adminRouter).
 *
 *   GET /live → { generated_at, process, requests, realtime, health }
 *
 * A thin aggregator over the same MonitoringCollector that backs the
 * legacy /api/admin/metrics and /api/admin/perf endpoints — not duplicated
 * logic. SystemPage.tsx's at-a-glance card is the intended caller; the
 * per-tab granular endpoints stay in place for ObservabilityPage.tsx's
 * range selectors.
 */
import { Router } from 'express';
import type { ServerConfig } from '../config.js';
import { getMonitoringCollector } from '../services/observability/collector/index.js';
import { loadControlPlane } from '../services/realtime/controlPlane.js';
import { evaluateProviderHealth } from '../services/realtime/failoverHealth.js';

export const adminMonitoringRouter = Router();

adminMonitoringRouter.get('/live', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const collector = getMonitoringCollector();

    const policy = await loadControlPlane(config).catch(() => null);
    const health = policy ? await evaluateProviderHealth(config, policy).catch(() => null) : null;

    res.json({
      generated_at: new Date().toISOString(),
      process: collector.snapshotProcessNow(),
      requests: collector.queryPerfSummary('1h'),
      realtime: collector.queryRealtimeSummary('1h'),
      health: health ? health.providers : null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to load live monitoring snapshot' });
  }
});
