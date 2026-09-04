/**
 * Prometheus/OpenTelemetry readiness — text-exposition renderer.
 *
 * Interface-first: this is the concrete implementation the future `/metrics`
 * endpoint (server/routes/metricsExport.ts) renders through, kept off by
 * default behind an env flag. Only four cardinality-safe metric families are
 * exposed, all labeled with fixed, small-cardinality dimensions (metric
 * name, driver, source, route_group, method, status_group) — never
 * workspace_id, conversation_id, call_id, or any other UUID. The admin-only
 * recent-events buffer (which does carry workspace_id/conversation_id, same
 * as GET /api/admin/metrics/events today) is deliberately excluded from
 * this exporter.
 */
import type { MonitoringCollector } from './types.js';
import { KNOWN_REALTIME_METRICS } from './constants.js';

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function line(name: string, labels: Record<string, string>, value: number): string {
  const labelStr = Object.entries(labels)
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
    .join(',');
  return `${name}{${labelStr}} ${value}`;
}

export function renderPrometheusText(collector: MonitoringCollector): string {
  const out: string[] = [];
  const now1h = '1h' as const;

  // realtime_metric_total{metric,driver,source}
  out.push('# HELP realtime_metric_total Count of realtime/observability events in the last hour.');
  out.push('# TYPE realtime_metric_total counter');
  const realtime = collector.queryRealtimeSummary(now1h);
  for (const metric of KNOWN_REALTIME_METRICS) {
    const bucket = realtime.counts[metric];
    if (!bucket) continue;
    for (const [driver, count] of Object.entries(bucket.by_driver)) {
      const source = Object.keys(bucket.by_source)[0] || 'server';
      out.push(line('realtime_metric_total', { metric, driver, source }, count));
    }
  }

  // http_requests_total{route_group,method,status_group} and
  // http_request_duration_ms_bucket{route_group,method,le} (cumulative, per Prometheus histogram convention)
  out.push('# HELP http_requests_total Count of instrumented HTTP requests in the last hour.');
  out.push('# TYPE http_requests_total counter');
  out.push('# HELP http_request_duration_ms Request-duration percentiles (ms) in the last hour, summary-style.');
  out.push('# TYPE http_request_duration_ms summary');
  const perf = collector.queryPerfSummary(now1h);
  for (const row of perf.rows) {
    for (const [statusGroup, count] of Object.entries(row.status_groups)) {
      out.push(line('http_requests_total', { route_group: row.route_group, method: row.method, status_group: statusGroup }, count));
    }
    // Percentiles only (not true histogram buckets) — the collector's
    // PerfSummary exposes p50/p95/p99, not raw bucket counts per row.
    // A future true histogram export can read the bucket keys directly
    // from BUCKET_EDGES_MS once that's threaded through PerfSummary.
    for (const [quantile, value] of [
      ['0.5', row.p50],
      ['0.95', row.p95],
      ['0.99', row.p99],
    ] as const) {
      out.push(line('http_request_duration_ms', { route_group: row.route_group, method: row.method, quantile }, value));
    }
  }

  // process_* gauges — unlabeled, single value each.
  const proc = collector.snapshotProcessNow();
  out.push('# HELP process_event_loop_lag_ms Current Node.js event-loop lag in milliseconds.');
  out.push('# TYPE process_event_loop_lag_ms gauge');
  out.push(`process_event_loop_lag_ms ${proc.event_loop_lag_ms}`);
  out.push('# HELP process_rss_bytes Current resident set size in bytes.');
  out.push('# TYPE process_rss_bytes gauge');
  out.push(`process_rss_bytes ${proc.rss_bytes}`);
  out.push('# HELP process_heap_used_bytes Current V8 heap used in bytes.');
  out.push('# TYPE process_heap_used_bytes gauge');
  out.push(`process_heap_used_bytes ${proc.heap_used_bytes}`);
  out.push('# HELP process_heap_total_bytes Current V8 heap total in bytes.');
  out.push('# TYPE process_heap_total_bytes gauge');
  out.push(`process_heap_total_bytes ${proc.heap_total_bytes}`);
  out.push('# HELP process_uptime_seconds Process uptime in seconds.');
  out.push('# TYPE process_uptime_seconds gauge');
  out.push(`process_uptime_seconds ${proc.uptime_seconds}`);

  return out.join('\n') + '\n';
}
