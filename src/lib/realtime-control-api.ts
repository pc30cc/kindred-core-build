import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';
/**
 * Phase 6A — Realtime control-plane admin client.
 * Talks to the self-hosted Express backend (NEVER edge functions).
 */

const API_BASE = RESOLVED_API_BASE || '';

export type RealtimeProviderId =
  | 'centrifugo'
  | 'supabase_realtime'
  | 'polling_builtin';

export interface RealtimeControlSettings {
  // Degradation
  realtime_degraded_mode_enabled: boolean;
  realtime_disable_typing_on_overload: boolean;
  realtime_force_polling_on_critical_degradation: boolean;
  realtime_reconnect_backoff_multiplier_on_overload: number;
  realtime_degraded_mode_ttl_seconds: number;
  realtime_degraded_mode_auto_recover: boolean;
  realtime_fail_open_if_control_plane_stale: boolean;
  // Failover
  realtime_failover_enabled: boolean;
  realtime_failback_enabled: boolean;
  realtime_failover_cooldown_seconds: number;
  realtime_failback_stable_window_seconds: number;
  realtime_failover_error_threshold: number;
  realtime_failover_latency_threshold_ms: number;
  realtime_failover_health_window_seconds: number;
  realtime_provider_order: RealtimeProviderId[];
  realtime_provider_lock: RealtimeProviderId | null;
}

export interface RealtimeControlActiveSnapshot {
  configured_vendor: string;
  effective_vendor: string;
  source: string;
  health: { status: string; checked_at?: number; message?: string };
  fallback_policy: string;
}

export interface RealtimeControlBundle {
  settings: RealtimeControlSettings;
  defaults: RealtimeControlSettings;
  active: RealtimeControlActiveSnapshot;
}

export interface RealtimeControlAuditEntry {
  id: string;
  changed_by: string | null;
  action: string;
  config_diff: Record<string, { from: unknown; to: unknown }> | null;
  result: string | null;
  error_message: string | null;
  ip_address: string | null;
  created_at: string;
}

export interface RealtimeFailoverProviderHealth {
  provider: RealtimeProviderId;
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  error_rate: number | null;
  p95_latency_ms: number | null;
  sample_size: number;
  reason: string;
  checked_at: number;
}

export interface RealtimeFailoverState {
  effective_provider: RealtimeProviderId;
  provider_lock: RealtimeProviderId | null;
  provider_order: RealtimeProviderId[];
  failover_enabled: boolean;
  failback_enabled: boolean;
  cooldown_until: string | null;
  cooldown_remaining_ms: number;
  failback_eligible_at: string | null;
  failback_remaining_ms: number;
  candidate_recovery_provider: RealtimeProviderId | null;
  candidate_recovery_since: string | null;
  last_failover_at: string | null;
  last_failover_reason: string | null;
  last_health: Record<string, RealtimeFailoverProviderHealth>;
  last_evaluated_at: string | null;
}

export const realtimeControlApi = {
  async get(): Promise<RealtimeControlBundle> {
    const res = await fetch(`${API_BASE}/api/realtime/admin/control`, {credentials: 'include', 
    });
    if (!res.ok) throw new Error(`Load failed: ${res.status}`);
    return res.json();
  },
  async update(
    patch: Partial<RealtimeControlSettings>,
  ): Promise<{ ok: boolean; settings: RealtimeControlSettings }> {
    const res = await fetch(`${API_BASE}/api/realtime/admin/control`, {
      credentials: 'include',
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Save failed');
    return json;
  },
  async audit(): Promise<RealtimeControlAuditEntry[]> {
    const res = await fetch(`${API_BASE}/api/realtime/admin/control/audit`, {credentials: 'include', 
    });
    if (!res.ok) return [];
    const json = await res.json();
    return (json.entries ?? []) as RealtimeControlAuditEntry[];
  },
  async failover(): Promise<RealtimeFailoverState> {
    const res = await fetch(`${API_BASE}/api/realtime/admin/control/failover`, {credentials: 'include', 
    });
    if (!res.ok) throw new Error(`Load failed: ${res.status}`);
    return res.json();
  },
  async evaluateFailover(): Promise<{ ok: boolean; effective_provider: RealtimeProviderId }> {
    const res = await fetch(
      `${API_BASE}/api/realtime/admin/control/failover/evaluate`,
      {credentials: 'include', method: 'POST', headers: {} },
    );
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Evaluate failed');
    return json;
  },
};
