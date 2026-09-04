/**
 * Request performance instrumentation (server-only).
 *
 * perfHttpMiddleware records one sample per request directly into the
 * bounded in-memory Live Monitoring collector (server/services/observability/collector/) —
 * no Postgres write. Only the routes registered via PERF_ROUTE_GROUPS
 * (below) are instrumented.
 *
 * Process metrics (event-loop lag, RSS, heap, uptime) are sampled by the
 * collector's own trend sampler, started by startPerfCollectors().
 *
 * Design rules:
 *   • Never throws.
 *   • No PII, no message bodies, no IPs, no workspace ids in samples.
 */
import { performance } from 'node:perf_hooks';
import type { RequestHandler } from 'express';
import type { ServerConfig } from '../../config.js';
import { getMonitoringCollector, startMonitoringCollector, __resetMonitoringCollectorForTests } from './collector/index.js';

export type RouteGroup =
  | 'realtime.operator_connect'
  | 'realtime.subscribe'
  | 'widget.bootstrap'
  | 'widget.session_refresh'
  | 'widget.action';

export function perfHttpMiddleware(routeGroup: RouteGroup): RequestHandler {
  return (req, res, next) => {
    const start = performance.now();
    res.on('finish', () => {
      try {
        const dur = Math.max(0, Math.round(performance.now() - start));
        const code = res.statusCode || 0;
        getMonitoringCollector().recordRequestSample({
          routeGroup,
          method: req.method,
          statusCode: code,
          durationMs: dur,
        });
      } catch {
        // Never break the response cycle.
      }
    });
    next();
  };
}

export function startPerfCollectors(config: ServerConfig): void {
  startMonitoringCollector(config);
}

export function __stopPerfCollectorsForTests(): void {
  __resetMonitoringCollectorForTests();
}
