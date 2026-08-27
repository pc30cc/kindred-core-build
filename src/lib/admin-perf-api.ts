import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';
/**
 * Phase 5A — Admin performance API client.
 * All endpoints require global admin (server-enforced).
 */

const API_BASE = RESOLVED_API_BASE;

export type PerfRange = '1h' | '24h';

export interface PerfRouteRow {
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
  status_groups: Record<string, number>;
}

export interface PerfSummary {
  range: PerfRange;
  since: string;
  rows: PerfRouteRow[];
}

export interface PerfProcessSample {
  occurred_at: string;
  event_loop_lag_ms: number;
  rss_bytes: number;
  heap_used_bytes: number;
  heap_total_bytes: number;
  uptime_seconds: number;
}

export interface PerfProcessResponse {
  range: PerfRange;
  since: string;
  samples: PerfProcessSample[];
  latest: PerfProcessSample | null;
}

export async function fetchPerfSummary(range: PerfRange = '1h'): Promise<PerfSummary> {
  const headers = {};
  const res = await fetch(`${API_BASE}/api/admin/perf/summary?range=${range}`, {credentials: 'include', headers });
  if (!res.ok) throw new Error(`Failed to load perf summary: ${res.status}`);
  return res.json();
}

export async function fetchPerfProcess(range: PerfRange = '1h'): Promise<PerfProcessResponse> {
  const headers = {};
  const res = await fetch(`${API_BASE}/api/admin/perf/process?range=${range}`, {credentials: 'include', headers });
  if (!res.ok) throw new Error(`Failed to load process samples: ${res.status}`);
  return res.json();
}

export async function triggerPerfRollup(): Promise<{ ok: boolean }> {
  const headers = { ...({}), 'Content-Type': 'application/json' };
  const res = await fetch(`${API_BASE}/api/admin/perf/rollup`, {credentials: 'include', method: 'POST', headers });
  if (!res.ok) throw new Error(`Failed to trigger rollup: ${res.status}`);
  return res.json();
}
