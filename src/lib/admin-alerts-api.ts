/**
 * Phase 4 — Admin alerting client.
 * All endpoints require global admin (server-enforced).
 */

const API_BASE = import.meta.env.VITE_API_BASE_URL;

export interface AlertRule {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  kind:
    | 'count'
    | 'ratio'
    | 'perf_p95'
    | 'perf_p99'
    | 'perf_error_rate'
    | 'process_avg'
    | 'process_ratio'
    | 'combined';
  metric: string | null;
  numerator: string | null;
  denominator: string | null;
  route_group: string | null;
  aggregation: string | null;
  subrules: string[] | null;
  window_seconds: number;
  warn_threshold: number;
  critical_threshold: number;
  min_sample: number;
  enabled: boolean;
  is_builtin: boolean;
  updated_at: string;
}

export interface AlertEvent {
  id: string;
  rule_id: string;
  rule_slug: string;
  severity: 'warn' | 'critical' | 'resolved';
  state: 'open' | 'resolved';
  metric_value: number | null;
  threshold_value: number | null;
  window_seconds: number;
  sample_size: number | null;
  details: Record<string, unknown>;
  fired_at: string;
  resolved_at: string | null;
  webhook_status: string | null;
  webhook_attempts: number;
  webhook_last_error: string | null;
}

export interface ActiveAlert {
  id: string;
  rule_slug: string;
  severity: 'warn' | 'critical';
  metric_value: number | null;
  threshold_value: number | null;
  fired_at: string;
}

export interface WebhookConfig {
  alerting_enabled: boolean;
  webhook_url: string | null;
  webhook_secret_set: boolean;
}

export async function fetchAlertRules(): Promise<{ rules: AlertRule[] }> {
  const headers = {};
  const res = await fetch(`${API_BASE}/api/admin/alerts/rules`, {credentials: 'include', headers });
  if (!res.ok) throw new Error(`Failed to load rules: ${res.status}`);
  return res.json();
}

export async function updateAlertRule(
  id: string,
  patch: Partial<
    Pick<AlertRule, 'enabled' | 'warn_threshold' | 'critical_threshold' | 'window_seconds' | 'min_sample'>
  >,
): Promise<{ rule: AlertRule }> {
  const headers = {};
  const res = await fetch(`${API_BASE}/api/admin/alerts/rules/${id}`, {credentials: 'include', 
    method: 'PATCH',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.error === 'string' ? body.error : `Update failed: ${res.status}`);
  }
  return res.json();
}

export async function fetchAlertEvents(
  opts: { state?: 'open' | 'resolved'; limit?: number } = {},
): Promise<{ events: AlertEvent[] }> {
  const headers = {};
  const params = new URLSearchParams();
  if (opts.state) params.set('state', opts.state);
  if (opts.limit) params.set('limit', String(opts.limit));
  const res = await fetch(`${API_BASE}/api/admin/alerts/events?${params}`, {credentials: 'include', headers });
  if (!res.ok) throw new Error(`Failed to load events: ${res.status}`);
  return res.json();
}

export async function fetchActiveAlerts(): Promise<{ active: ActiveAlert[] }> {
  const headers = {};
  const res = await fetch(`${API_BASE}/api/admin/alerts/active`, {credentials: 'include', headers });
  if (!res.ok) throw new Error(`Failed to load active alerts: ${res.status}`);
  return res.json();
}

export async function evaluateAlertsNow(): Promise<{ ok: boolean; result: { evaluated: number; state_changes: number; ran_at: string } }> {
  const headers = {};
  const res = await fetch(`${API_BASE}/api/admin/alerts/evaluate`, {credentials: 'include', 
    method: 'POST',
    headers,
  });
  if (!res.ok) throw new Error(`Evaluation failed: ${res.status}`);
  return res.json();
}

export async function fetchAlertWebhookConfig(): Promise<WebhookConfig> {
  const headers = {};
  const res = await fetch(`${API_BASE}/api/admin/alerts/webhook`, {credentials: 'include', headers });
  if (!res.ok) throw new Error(`Failed to load webhook config: ${res.status}`);
  return res.json();
}

export async function updateAlertWebhookConfig(input: {
  alerting_enabled?: boolean;
  webhook_url: string | null;
  webhook_secret?: string | null;
}): Promise<{ ok: boolean }> {
  const headers = {};
  const res = await fetch(`${API_BASE}/api/admin/alerts/webhook`, {credentials: 'include', 
    method: 'PUT',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.error === 'string' ? body.error : `Update failed: ${res.status}`);
  }
  return res.json();
}