/**
 * Phase 7 — Admin reliability / SLA / business / workspace-health client.
 * All endpoints require global admin (server-enforced).
 */
import { supabase } from '@/integrations/supabase/client';

const API_BASE = import.meta.env.VITE_API_BASE_URL;

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export type Range = '1h' | '24h' | '7d' | '30d';

export interface SlaSummary {
  uptime_pct: number | null;
  realtime_availability_pct: number | null;
  degraded_minutes: number;
  forced_polling_minutes: number;
  critical_alert_count: number;
  warn_alert_count: number;
  failover_count: number;
  recovery_count: number;
  mean_failover_recovery_seconds: number | null;
}

export interface BusinessSummary {
  new_conversations: number;
  resolved_conversations: number;
  unanswered_conversations: number;
  stale_open_conversations: number;
  messages_sent: number;
  avg_first_response_p50: number | null;
  avg_first_response_p95: number | null;
  avg_resolution_seconds: number | null;
}

export interface WorkspaceHealthRow {
  id: string;
  workspace_id: string;
  captured_at: string;
  health_score: number;
  state: 'healthy' | 'warning' | 'at_risk';
  components: Record<string, number>;
}

export interface SloDefinition {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  scope_type: string;
  metric_key: string;
  target_type: 'min' | 'max';
  target_value: number;
  window_seconds: number;
  enabled: boolean;
  is_builtin: boolean;
}

export async function fetchSla(range: Range = '24h', scope_type = 'platform') {
  const headers = await authHeader();
  const r = await fetch(`${API_BASE}/api/admin/reliability/sla?range=${range}&scope_type=${scope_type}`, {credentials: 'include', headers });
  if (!r.ok) throw new Error(`SLA load failed: ${r.status}`);
  return r.json() as Promise<{ range: Range; summary: SlaSummary; rows: any[] }>;
}

export async function fetchBusinessMetrics(range: Range = '24h') {
  const headers = await authHeader();
  const r = await fetch(`${API_BASE}/api/admin/reliability/business?range=${range}`, {credentials: 'include', headers });
  if (!r.ok) throw new Error(`Business metrics load failed: ${r.status}`);
  return r.json() as Promise<{ range: Range; summary: BusinessSummary; rows: any[] }>;
}

export async function fetchWorkspaceHealth() {
  const headers = await authHeader();
  const r = await fetch(`${API_BASE}/api/admin/reliability/workspace-health`, {credentials: 'include', headers });
  if (!r.ok) throw new Error(`Workspace health load failed: ${r.status}`);
  return r.json() as Promise<{
    counts: { healthy: number; warning: number; at_risk: number };
    total: number;
    latest: WorkspaceHealthRow[];
    at_risk: WorkspaceHealthRow[];
  }>;
}

export async function fetchSlos() {
  const headers = await authHeader();
  const r = await fetch(`${API_BASE}/api/admin/reliability/slos`, {credentials: 'include', headers });
  if (!r.ok) throw new Error(`SLOs load failed: ${r.status}`);
  return r.json() as Promise<{ slos: SloDefinition[] }>;
}

export async function updateSlo(
  id: string,
  patch: Partial<Pick<SloDefinition, 'target_value' | 'window_seconds' | 'enabled'>>,
) {
  const headers = await authHeader();
  const r = await fetch(`${API_BASE}/api/admin/reliability/slos/${id}`, {credentials: 'include', 
    method: 'PATCH',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`SLO update failed: ${r.status}`);
  return r.json();
}

export async function triggerReliabilityRollup() {
  const headers = await authHeader();
  const r = await fetch(`${API_BASE}/api/admin/reliability/rollup`, {credentials: 'include', method: 'POST', headers });
  if (!r.ok) throw new Error(`Rollup failed: ${r.status}`);
  return r.json();
}