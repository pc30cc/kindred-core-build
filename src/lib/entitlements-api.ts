/**
 * Entitlements / capability registry — frontend client.
 *
 * Thin wrappers around the additive backend endpoints exposed by
 * `server/routes/plans.ts`. The shapes here mirror the registry
 * defined in `server/services/billing/capabilityRegistry.ts`.
 *
 * The backend remains the source of truth — these helpers exist
 * so admin / app UI does not duplicate plan interpretation logic.
 */

import { API_BASE } from './api';

/**
 * Plans routes authorize per real user (workspace membership) or platform
 * admin. The publishable anon key is not an identity, so every call carries
 * the current Supabase session token.
 */
async function authHeaders(): Promise<Record<string, string>> {
  const { supabase } = await import('@/integrations/supabase/client');
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export type CapabilityType = 'feature' | 'module' | 'channel' | 'limit';

export interface CapabilityDefinition {
  key: string;
  type: CapabilityType;
  label: string;
  description?: string;
  group: string;
  defaultValue: boolean | number | null;
  planConfigurable: boolean;
  workspaceOverridable: boolean;
  userVisible: boolean;
  internalOnly?: boolean;
  unit?: string;
  sortOrder?: number;
}

export interface EffectiveState<T = boolean | number | null> {
  value: T;
  source: 'override' | 'plan' | 'default';
  note?: string | null;
  unit?: string;
}

export interface WorkspaceEffectiveEntitlements {
  workspaceId: string;
  plan: any;
  subscription: any;
  features: Record<string, EffectiveState<boolean>>;
  modules: Record<string, EffectiveState<boolean>>;
  channels: Record<string, EffectiveState<boolean>>;
  limits: Record<string, EffectiveState<number | null>>;
  usage: Record<string, any> | null;
  raw: { entitlements: Record<string, unknown>; limits: Record<string, unknown> };
}

export interface EntitlementDiagnostics {
  registrySize: number;
  plansChecked: number;
  unknownKeysInDb: Array<{ planSlug: string; key: string; bucket: 'entitlements' | 'limits' }>;
  registryKeysMissingEverywhere: string[];
  invalidLimitValues: Array<{ planSlug: string; key: string; value: unknown }>;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {credentials: 'include', headers: await authHeaders() });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `Entitlements API error: ${res.status}`);
  }
  return res.json();
}

export async function fetchCapabilityCatalog(filter?: { type?: CapabilityType; group?: string }) {
  const params = new URLSearchParams();
  if (filter?.type) params.set('type', filter.type);
  if (filter?.group) params.set('group', filter.group);
  const qs = params.toString();
  return get<{ capabilities: CapabilityDefinition[]; total: number }>(`/api/plans/capabilities${qs ? `?${qs}` : ''}`);
}

export async function fetchWorkspaceEffective(workspaceId: string) {
  return get<WorkspaceEffectiveEntitlements>(`/api/plans/workspace/${workspaceId}/effective`);
}

export async function validatePlanPayload(payload: {
  entitlements?: Record<string, unknown>;
  limits?: Record<string, unknown>;
}) {
  const res = await fetch(`${API_BASE}/api/plans/admin/validate`, {credentials: 'include', 
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Validate failed: ${res.status}`);
  return res.json() as Promise<{ valid: boolean; issues: Array<{ level: 'error' | 'warning'; key: string; message: string }> }>;
}

export async function fetchEntitlementDiagnostics() {
  return get<{
    registrySize: number;
    plansChecked: number;
    unknownKeysInDb: Array<{ planSlug: string; key: string; bucket: 'entitlements' | 'limits' }>;
    registryKeysMissingEverywhere: string[];
    invalidLimitValues: Array<{ planSlug: string; key: string; value: unknown }>;
  }>(`/api/plans/admin/diagnostics`);
}

/** Set or clear a workspace module override (Super Admin). */
export async function setWorkspaceModuleOverride(input: {
  workspaceId: string; moduleKey: string; enabled: boolean; adminNotes?: string;
}) {
  const res = await fetch(`${API_BASE}/api/plans/admin/overrides/module`, {credentials: 'include', 
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Override failed: ${res.status}`);
  return res.json();
}

export async function setWorkspaceChannelOverride(input: {
  workspaceId: string; channelKey: string; enabled: boolean; adminNotes?: string;
}) {
  const res = await fetch(`${API_BASE}/api/plans/admin/overrides/channel`, {credentials: 'include', 
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Override failed: ${res.status}`);
  return res.json();
}

export async function deleteWorkspaceModuleOverride(id: string) {
  const res = await fetch(`${API_BASE}/api/plans/admin/overrides/module/${id}`, {credentials: 'include', 
    method: 'DELETE',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`Delete override failed: ${res.status}`);
  return res.json();
}

export async function deleteWorkspaceChannelOverride(id: string) {
  const res = await fetch(`${API_BASE}/api/plans/admin/overrides/channel/${id}`, {credentials: 'include', 
    method: 'DELETE',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`Delete override failed: ${res.status}`);
  return res.json();
}

/** Set or clear a workspace numeric limit override (Super Admin).
 *  `limitValue` of -1 means unlimited; >= 0 caps the limit. */
export async function setWorkspaceLimitOverride(input: {
  workspaceId: string; limitKey: string; limitValue: number; adminNotes?: string;
}) {
  const res = await fetch(`${API_BASE}/api/plans/admin/overrides/limit`, {credentials: 'include', 
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Override failed: ${res.status}`);
  return res.json();
}

export async function deleteWorkspaceLimitOverride(id: string) {
  const res = await fetch(`${API_BASE}/api/plans/admin/overrides/limit/${id}`, {credentials: 'include', 
    method: 'DELETE',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`Delete override failed: ${res.status}`);
  return res.json();
}

export interface WorkspaceOverrideRow {
  id: string;
  workspace_id: string;
  enabled?: boolean;
  admin_notes?: string | null;
  module_key?: string;
  channel_key?: string;
  limit_key?: string;
  limit_value?: number;
}

/** List existing module + channel overrides for a workspace (Super Admin). */
export async function fetchWorkspaceOverrides(workspaceId: string) {
  return get<{ modules: WorkspaceOverrideRow[]; channels: WorkspaceOverrideRow[]; limits: WorkspaceOverrideRow[] }>(
    `/api/plans/admin/overrides/${workspaceId}`,
  );
}

/** Group capabilities by `group` field, preserving sortOrder. */
export function groupCapabilities(caps: CapabilityDefinition[]): Record<string, CapabilityDefinition[]> {
  const out: Record<string, CapabilityDefinition[]> = {};
  for (const c of caps) (out[c.group] ||= []).push(c);
  for (const g of Object.keys(out)) {
    out[g].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  }
  return out;
}