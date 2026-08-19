/**
 * Phase 5C — Admin auto-actions client.
 * All endpoints require global admin (server-enforced).
 */
import { supabase } from '@/integrations/supabase/client';

const API_BASE = import.meta.env.VITE_API_BASE_URL;

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export type AutoActionType =
  | 'disable_typing_temporarily'
  | 'force_polling_mode'
  | 'increase_reconnect_backoff'
  | 'mark_system_degraded';

export type AutoActionState = 'active' | 'expired' | 'resolved' | 'overridden';

export interface AutoActionDefinition {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  action_type: AutoActionType;
  trigger_rule_slug: string | null;
  min_severity: 'warn' | 'critical';
  enabled: boolean;
  cooldown_seconds: number;
  max_duration_seconds: number;
  is_builtin: boolean;
  updated_at: string;
}

export interface AutoActionEvent {
  id: string;
  definition_id: string;
  action_slug: string;
  action_type: AutoActionType;
  trigger_rule_slug: string | null;
  trigger_alert_event_id: string | null;
  trigger_severity: 'warn' | 'critical' | null;
  state: AutoActionState;
  started_at: string;
  expires_at: string;
  ended_at: string | null;
  ended_reason: string | null;
  details: Record<string, unknown>;
}

export interface ActiveAutoAction {
  id: string;
  action_slug: string;
  action_type: AutoActionType;
  trigger_rule_slug: string | null;
  trigger_severity: 'warn' | 'critical' | null;
  started_at: string;
  expires_at: string;
}

export async function fetchAutoActionDefinitions(): Promise<{
  definitions: AutoActionDefinition[];
}> {
  const headers = await authHeader();
  const res = await fetch(`${API_BASE}/api/admin/auto-actions/definitions`, {credentials: 'include', headers });
  if (!res.ok) throw new Error(`Failed to load definitions: ${res.status}`);
  return res.json();
}

export async function updateAutoActionDefinition(
  id: string,
  patch: Partial<
    Pick<AutoActionDefinition, 'enabled' | 'cooldown_seconds' | 'max_duration_seconds' | 'min_severity'>
  >,
): Promise<{ definition: AutoActionDefinition }> {
  const headers = await authHeader();
  const res = await fetch(`${API_BASE}/api/admin/auto-actions/definitions/${id}`, {credentials: 'include', 
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

export async function fetchAutoActionEvents(
  opts: { state?: AutoActionState; limit?: number } = {},
): Promise<{ events: AutoActionEvent[] }> {
  const headers = await authHeader();
  const params = new URLSearchParams();
  if (opts.state) params.set('state', opts.state);
  if (opts.limit) params.set('limit', String(opts.limit));
  const res = await fetch(`${API_BASE}/api/admin/auto-actions/events?${params}`, {credentials: 'include', headers });
  if (!res.ok) throw new Error(`Failed to load events: ${res.status}`);
  return res.json();
}

export async function fetchActiveAutoActions(): Promise<{ active: ActiveAutoAction[] }> {
  const headers = await authHeader();
  const res = await fetch(`${API_BASE}/api/admin/auto-actions/active`, {credentials: 'include', headers });
  if (!res.ok) throw new Error(`Failed to load active actions: ${res.status}`);
  return res.json();
}

export async function evaluateAutoActionsNow(): Promise<{
  ok: boolean;
  result: { expired: number; resolved: number; activated: number; ran_at: string };
}> {
  const headers = await authHeader();
  const res = await fetch(`${API_BASE}/api/admin/auto-actions/evaluate`, {credentials: 'include', 
    method: 'POST',
    headers,
  });
  if (!res.ok) throw new Error(`Evaluation failed: ${res.status}`);
  return res.json();
}

export async function overrideAutoAction(eventId: string): Promise<{ ok: boolean }> {
  const headers = await authHeader();
  const res = await fetch(
    `${API_BASE}/api/admin/auto-actions/events/${eventId}/override`,
    {credentials: 'include', method: 'POST', headers },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(typeof body.error === 'string' ? body.error : `Override failed: ${res.status}`);
  }
  return res.json();
}