/**
 * Phase 5A — Performance / latency observability (server-only).
 *
 * Two collection paths:
 *   1. HTTP request samples — recorded by perfHttpMiddleware on a small,
 *      explicit allow-list of routes. Buffered in memory and flushed every
 *      5s as a single batched insert. Best-effort; never blocks the request.
 *   2. Process samples — sampled every 60s by perfProcessTicker (event-loop
 *      lag, RSS, heap, uptime).
 *
 * Design rules:
 *   • Never throws. Buffer overflows drop oldest. Inserts are fire-and-forget.
 *   • Only the routes registered via PERF_ROUTE_GROUPS are instrumented.
 *   • No PII, no message bodies, no IPs, no workspace ids in samples.
 *   • Gated by widget_platform_settings.perf_metrics_enabled (default true).
 *   • All SQL inserts go through service client.
 */
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import type { RequestHandler } from 'express';
import { getServiceClient } from '../../supabase.js';
import type { ServerConfig } from '../../config.js';
import { getMonitoringCollector, startMonitoringCollector, __resetMonitoringCollectorForTests } from './collector/index.js';

export type RouteGroup =
  | 'realtime.operator_connect'
  | 'realtime.subscribe'
  | 'widget.bootstrap'
  | 'widget.session_refresh'
  | 'widget.action';

export interface RequestSample {
  route_group: RouteGroup;
  method: string;
  status_code: number;
  status_group: '2xx' | '3xx' | '4xx' | '5xx';
  duration_ms: number;
  is_error: boolean;
  occurred_at: string;
}

const BUFFER_MAX = 500;
const FLUSH_INTERVAL_MS = 5_000;
const PROCESS_SAMPLE_MS = 60_000;

let buffer: RequestSample[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let processTimer: ReturnType<typeof setInterval> | null = null;
let elDelay: ReturnType<typeof monitorEventLoopDelay> | null = null;

function statusGroup(code: number): RequestSample['status_group'] {
  if (code >= 500) return '5xx';
  if (code >= 400) return '4xx';
  if (code >= 300) return '3xx';
  return '2xx';
}

export function perfHttpMiddleware(routeGroup: RouteGroup): RequestHandler {
  return (req, res, next) => {
    const start = performance.now();
    res.on('finish', () => {
      try {
        const dur = Math.max(0, Math.round(performance.now() - start));
        const code = res.statusCode || 0;

        // Dual-write (Live Monitoring migration, step 2/9): feed the
        // bounded in-memory collector from the same instrumentation point
        // as the raw DB buffer below, so it accumulates real production
        // data before any reader is cut over to it.
        try {
          getMonitoringCollector().recordRequestSample({
            routeGroup,
            method: req.method,
            statusCode: code,
            durationMs: dur,
          });
        } catch {
          // Never break the response cycle.
        }

        if (buffer.length >= BUFFER_MAX) {
          // Drop oldest to bound memory; we'd rather lose samples than block.
          buffer.shift();
        }
        buffer.push({
          route_group: routeGroup,
          method: req.method,
          status_code: code,
          status_group: statusGroup(code),
          duration_ms: dur,
          is_error: code >= 500,
          occurred_at: new Date().toISOString(),
        });
      } catch {
        // Never break the response cycle.
      }
    });
    next();
  };
}

async function flushBuffer(config: ServerConfig): Promise<void> {
  if (buffer.length === 0) return;
  const batch = buffer.splice(0, buffer.length);
  try {
    const sb = getServiceClient(config);
    await sb.from('perf_request_samples').insert(batch);
  } catch {
    // Best-effort. Drop the batch on failure.
  }
}

export function startPerfCollectors(config: ServerConfig): void {
  // Dual-write (Live Monitoring migration, step 2/9): the collector samples
  // process metrics directly from the Node runtime on its own 60s cadence,
  // independent of the legacy sampleProcess()/perf_process_samples path
  // below — both run side by side until the legacy path is removed.
  startMonitoringCollector(config);

  if (!flushTimer) {
    flushTimer = setInterval(() => {
      void flushBuffer(config);
    }, FLUSH_INTERVAL_MS);
    if (typeof (flushTimer as any)?.unref === 'function') (flushTimer as any).unref();
  }

  if (!elDelay) {
    elDelay = monitorEventLoopDelay({ resolution: 20 });
    elDelay.enable();
  }

  if (!processTimer) {
    processTimer = setInterval(() => {
      void sampleProcess(config);
    }, PROCESS_SAMPLE_MS);
    if (typeof (processTimer as any)?.unref === 'function') (processTimer as any).unref();
  }
}

async function sampleProcess(config: ServerConfig): Promise<void> {
  try {
    const mem = process.memoryUsage();
    // mean is in nanoseconds; convert to ms with 3 decimals.
    const lagMs = elDelay ? Number((elDelay.mean / 1e6).toFixed(3)) : 0;
    if (elDelay) elDelay.reset();
    const sb = getServiceClient(config);
    await sb.from('perf_process_samples').insert({
      event_loop_lag_ms: lagMs,
      rss_bytes: mem.rss,
      heap_used_bytes: mem.heapUsed,
      heap_total_bytes: mem.heapTotal,
      uptime_seconds: Math.round(process.uptime()),
    });
  } catch {
    // Best-effort.
  }
}

export function __stopPerfCollectorsForTests(): void {
  if (flushTimer) clearInterval(flushTimer);
  if (processTimer) clearInterval(processTimer);
  flushTimer = null;
  processTimer = null;
  buffer = [];
  if (elDelay) {
    elDelay.disable();
    elDelay = null;
  }
  __resetMonitoringCollectorForTests();
}
