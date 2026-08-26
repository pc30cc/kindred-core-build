/**
 * Phase 3 — Admin observability client.
 * All endpoints require global admin (server-enforced).
 */

const API_BASE = import.meta.env.VITE_API_BASE_URL;

export interface MetricsSummary {
  range: string;
  since: string;
  counts: Record<string, {
    total: number;
    by_driver: Record<string, number>;
    by_source: Record<string, number>;
  }>;
}

export interface MetricEventRow {
  id: string;
  occurred_at: string;
  metric: string;
  workspace_id: string | null;
  conversation_id: string | null;
  driver: string | null;
  source: string;
  tags: Record<string, unknown>;
}

export async function fetchMetricsSummary(range: '1h' | '24h' | '7d' = '1h'): Promise<MetricsSummary> {
  const headers = {};
  const res = await fetch(`${API_BASE}/api/admin/metrics/summary?range=${range}`, {credentials: 'include', headers });
  if (!res.ok) throw new Error(`Failed to load summary: ${res.status}`);
  return res.json();
}

export async function fetchMetricsEvents(opts: { metric?: string; limit?: number } = {}): Promise<{ events: MetricEventRow[] }> {
  const headers = {};
  const params = new URLSearchParams();
  if (opts.metric) params.set('metric', opts.metric);
  if (opts.limit) params.set('limit', String(opts.limit));
  const res = await fetch(`${API_BASE}/api/admin/metrics/events?${params}`, {credentials: 'include', headers });
  if (!res.ok) throw new Error(`Failed to load events: ${res.status}`);
  return res.json();
}
