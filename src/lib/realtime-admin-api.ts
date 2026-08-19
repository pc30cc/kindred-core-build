/**
 * Admin Realtime API client.
 * Talks to the self-hosted Express backend (NEVER edge functions).
 * Auth: Bearer (Supabase user access token).
 */

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

export interface RealtimeAdminConfig {
  vendor: 'centrifugo' | 'polling_builtin' | 'disabled';
  enabled: boolean;
  fallback_policy: 'lenient' | 'strict';
  fallback_vendor: 'polling_builtin' | null;
  centrifugo?: {
    ws_url?: string;
    api_url?: string;
    api_key?: string; // masked from server
    token_hmac_secret?: string; // masked from server
    allowed_origins?: string[];
    connect_timeout_ms?: number;
    subscribe_timeout_ms?: number;
    presence_enabled?: boolean;
    typing_enabled?: boolean;
    token_ttl_seconds?: number;
  };
}

export interface RealtimeAdminAuditEntry {
  id: string;
  changed_by: string | null;
  action: string;
  vendor: string | null;
  prev_vendor: string | null;
  config_diff: Record<string, unknown> | null;
  result: string | null;
  error_message: string | null;
  ip_address: string | null;
  created_at: string;
}

export const realtimeAdminApi = {
  async getConfig(): Promise<RealtimeAdminConfig> {
    const res = await fetch(`${API_BASE}/api/realtime/admin/config`, {credentials: 'include', headers: {} });
    if (!res.ok) throw new Error(`Load failed: ${res.status}`);
    const json = await res.json();
    return json.config as RealtimeAdminConfig;
  },

  async saveConfig(payload: Partial<RealtimeAdminConfig>): Promise<RealtimeAdminConfig> {
    const res = await fetch(`${API_BASE}/api/realtime/admin/config`, {
      credentials: 'include',
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Save failed');
    return json.config as RealtimeAdminConfig;
  },

  async testConnection(): Promise<{ status: 'healthy' | 'degraded' | 'down' | 'unknown'; message?: string; checked_at?: number }> {
    const res = await fetch(`${API_BASE}/api/realtime/admin/test`, {credentials: 'include', 
      method: 'POST',
    });
    return res.json();
  },

  async resolved(): Promise<unknown> {
    const res = await fetch(`${API_BASE}/api/realtime/admin/resolved`, {credentials: 'include', headers: {} });
    return res.json();
  },

  async audit(): Promise<RealtimeAdminAuditEntry[]> {
    const res = await fetch(`${API_BASE}/api/realtime/admin/audit`, {credentials: 'include', headers: {} });
    if (!res.ok) return [];
    const json = await res.json();
    return (json.entries ?? []) as RealtimeAdminAuditEntry[];
  },

  async refresh(): Promise<void> {
    await fetch(`${API_BASE}/api/realtime/admin/refresh`, {credentials: 'include', method: 'POST', headers: {} });
  },
};
