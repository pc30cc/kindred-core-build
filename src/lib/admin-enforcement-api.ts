import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';
/**
 * Phase 7.5 — Admin enforcement client.
 * All endpoints require global admin (server-enforced).
 */

const API_BASE = RESOLVED_API_BASE;

export type EnforcementTriggerType = 'slo_breach' | 'health_score' | 'alert_rate';

export interface EnforcementRule {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  trigger_type: EnforcementTriggerType;
  condition_json: Record<string, unknown>;
  actions_json: string[];
  cooldown_seconds: number;
  ttl_seconds: number;
  priority: number;
  enabled: boolean;
  is_builtin: boolean;
  created_at: string;
  updated_at: string;
}

export interface SloBreachEvent {
  id: string;
  slo_id: string;
  slo_slug: string;
  scope_type: string;
  scope_key: string;
  state: 'open' | 'resolved';
  observed_value: number | null;
  target_value: number;
  target_type: 'min' | 'max';
  consecutive_breaches: number;
  first_breach_at: string;
  last_breach_at: string;
  resolved_at: string | null;
  details: Record<string, unknown>;
}

export interface EnforcementActionAudit {
  id: string;
  rule_id: string;
  rule_slug: string;
  trigger_type: EnforcementTriggerType;
  trigger_payload: Record<string, unknown>;
  auto_action_event_id: string | null;
  scope_type: string;
  scope_key: string;
  dry_run: boolean;
  created_at: string;
}

export interface ActiveEnforcementAction {
  id: string;
  action_slug: string;
  action_type: string;
  trigger_rule_slug: string | null;
  started_at: string;
  expires_at: string;
  details: Record<string, unknown>;
  state: string;
}

export interface EnforcementFlags {
  kill_switch: boolean;
  dry_run: boolean;
  max_concurrent: number;
}

export interface EnforcementNormalization {
  id: string;
  created_at: string;
  cycle_ran_at: string;
  raw_actions: Array<{
    rule_slug: string;
    rule_priority: number;
    action_type: string;
  }>;
  normalized_actions: Array<{
    rule_slug: string;
    rule_priority: number;
    action_type: string;
    merged_with: string[];
    suppressed: { action_type: string; reason: string }[];
    annotations: string[];
  }>;
  reasons: Array<{
    kind: 'merged' | 'suppressed' | 'annotated';
    action_type: string;
    rule_slug: string;
    detail: string;
  }>;
  context: Record<string, unknown>;
}

async function get<T>(path: string): Promise<T> {
  const headers = {};
  const res = await fetch(`${API_BASE}/api/admin/enforcement${path}`, {credentials: 'include', headers });
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

async function send<T>(path: string, method: string, body?: any): Promise<T> {
  const headers = {};
  const res = await fetch(`${API_BASE}/api/admin/enforcement${path}`, {credentials: 'include', 
    method,
    headers: { ...headers, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(typeof data.error === 'string' ? data.error : `Request failed: ${res.status}`);
  }
  return res.json();
}

export const fetchEnforcementRules = () =>
  get<{ rules: EnforcementRule[] }>('/rules');

export const updateEnforcementRule = (
  id: string,
  patch: {
    enabled?: boolean;
    cooldown_seconds?: number;
    ttl_seconds?: number;
    priority?: number;
  },
) => send<{ rule: EnforcementRule }>(`/rules/${id}`, 'PATCH', patch);

export const fetchSloBreaches = (state?: 'open' | 'resolved') =>
  get<{ breaches: SloBreachEvent[] }>(`/breaches${state ? `?state=${state}` : ''}`);

export const fetchEnforcementActions = (limit = 50) =>
  get<{ actions: EnforcementActionAudit[] }>(`/actions?limit=${limit}`);

export const fetchActiveEnforcementActions = () =>
  get<{ active: ActiveEnforcementAction[] }>('/active');

export const fetchEnforcementFlags = () =>
  get<{ flags: EnforcementFlags }>('/flags');

export const updateEnforcementFlags = (
  patch: Partial<EnforcementFlags>,
) => send<{ ok: true }>('/flags', 'POST', patch);

export const evaluateEnforcementNow = () =>
  send<{ ok: true; slo: any; enforcement: any }>('/evaluate', 'POST');

export const overrideEnforcementAction = (eventId: string) =>
  send<{ ok: true }>(`/actions/${eventId}/override`, 'POST');

export const fetchEnforcementNormalizations = (limit = 50) =>
  get<{ normalizations: EnforcementNormalization[] }>(
    `/normalizations?limit=${limit}`,
  );
