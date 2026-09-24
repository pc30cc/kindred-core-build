/**
 * Aggregated, cardinality-safe counters for live commerce reads.
 *
 * In-process only — no database writes. Labels are fixed and small:
 * provider × operation × outcome. Never a workspace, connection, customer or
 * order id. Exported through the existing Prometheus renderer
 * (server/services/observability/collector/prometheusExport.ts) and readable
 * in tests for the resource report.
 */
import { publicCache, liveSingleFlight, connectionGuard } from './liveGuard.js';

interface Bucket {
  count: number;
  totalMs: number;
  maxMs: number;
  responseBytes: number;
  evidenceBytes: number;
  storeQueries: number;
}

const MAX_BUCKETS = 200;
const buckets = new Map<string, Bucket>();
let stagesSkippedNoIntent = 0;

export type LiveOutcome = 'ok' | 'cache_hit' | 'shared' | 'error' | 'rejected';

export function recordLiveRead(input: {
  provider: string;
  op: string;
  outcome: LiveOutcome;
  durationMs: number;
  responseBytes?: number;
  evidenceBytes?: number;
  storeQueries?: number | null;
}): void {
  const key = `${input.provider}|${input.op}|${input.outcome}`;
  let b = buckets.get(key);
  if (!b) {
    if (buckets.size >= MAX_BUCKETS) return;
    b = { count: 0, totalMs: 0, maxMs: 0, responseBytes: 0, evidenceBytes: 0, storeQueries: 0 };
    buckets.set(key, b);
  }
  b.count += 1;
  b.totalMs += Math.max(0, input.durationMs);
  b.maxMs = Math.max(b.maxMs, input.durationMs);
  b.responseBytes += input.responseBytes ?? 0;
  b.evidenceBytes += input.evidenceBytes ?? 0;
  b.storeQueries += input.storeQueries ?? 0;
}

/** A turn where the commerce stage decided no store call was needed. */
export function recordNoStoreCall(): void {
  stagesSkippedNoIntent += 1;
}

export function commerceMetricsSnapshot() {
  return {
    reads: [...buckets.entries()].map(([key, b]) => {
      const [provider, op, outcome] = key.split('|');
      return { provider, op, outcome, ...b };
    }),
    turnsWithoutStoreCall: stagesSkippedNoIntent,
    cache: publicCache.snapshot(),
    singleFlightShared: liveSingleFlight.shared,
    singleFlightInflight: liveSingleFlight.size,
    breaker: { opened: connectionGuard.opened, rejected: connectionGuard.rejected },
  };
}

export function resetCommerceMetrics(): void {
  buckets.clear();
  stagesSkippedNoIntent = 0;
  liveSingleFlight.shared = 0;
}

function esc(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export function renderCommercePrometheus(): string[] {
  const snap = commerceMetricsSnapshot();
  const out: string[] = [];
  out.push('# HELP commerce_live_reads_total Live store reads by provider, operation and outcome (process lifetime).');
  out.push('# TYPE commerce_live_reads_total counter');
  for (const r of snap.reads) out.push(`commerce_live_reads_total{provider="${esc(r.provider)}",op="${esc(r.op)}",outcome="${esc(r.outcome)}"} ${r.count}`);
  out.push('# HELP commerce_live_read_ms_sum Total milliseconds spent in live store reads.');
  out.push('# TYPE commerce_live_read_ms_sum counter');
  for (const r of snap.reads) out.push(`commerce_live_read_ms_sum{provider="${esc(r.provider)}",op="${esc(r.op)}",outcome="${esc(r.outcome)}"} ${Math.round(r.totalMs)}`);
  out.push('# HELP commerce_live_response_bytes_sum Bytes received from stores.');
  out.push('# TYPE commerce_live_response_bytes_sum counter');
  for (const r of snap.reads) out.push(`commerce_live_response_bytes_sum{provider="${esc(r.provider)}",op="${esc(r.op)}"} ${r.responseBytes}`);
  out.push('# HELP commerce_live_store_queries_sum Database queries the stores reported running for these reads.');
  out.push('# TYPE commerce_live_store_queries_sum counter');
  for (const r of snap.reads) out.push(`commerce_live_store_queries_sum{provider="${esc(r.provider)}",op="${esc(r.op)}"} ${r.storeQueries}`);
  out.push('# HELP commerce_public_cache_entries Entries in the public live-read cache.');
  out.push('# TYPE commerce_public_cache_entries gauge');
  out.push(`commerce_public_cache_entries ${snap.cache.entries}`);
  out.push('# HELP commerce_public_cache_bytes Bytes held by the public live-read cache.');
  out.push('# TYPE commerce_public_cache_bytes gauge');
  out.push(`commerce_public_cache_bytes ${snap.cache.bytes}`);
  out.push('# HELP commerce_public_cache_hits_total Public cache hits.');
  out.push('# TYPE commerce_public_cache_hits_total counter');
  out.push(`commerce_public_cache_hits_total ${snap.cache.hits}`);
  out.push('# HELP commerce_public_cache_misses_total Public cache misses.');
  out.push('# TYPE commerce_public_cache_misses_total counter');
  out.push(`commerce_public_cache_misses_total ${snap.cache.misses}`);
  out.push('# HELP commerce_breaker_open_total Times a store circuit opened.');
  out.push('# TYPE commerce_breaker_open_total counter');
  out.push(`commerce_breaker_open_total ${snap.breaker.opened}`);
  return out;
}
