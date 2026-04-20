/**
 * Platform Admin — Map & Geo API client.
 * Talks to /api/admin/map-geo/* on the self-hosted Express backend.
 * All calls require a Supabase user JWT; backend verifies platform admin role.
 */
import { supabase } from '@/lib/supabase';

function apiBase(): string {
  return import.meta.env.VITE_API_BASE_URL || window.location.origin;
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Not authenticated');
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

export interface MapGeoSettings {
  enabled: boolean;
  default_provider: string;
  preferred_precision: 'country' | 'region' | 'city';
  allow_centroid_fallback: boolean;
  min_accuracy_for_map: 'country' | 'region' | 'city';
  store_raw_ip: boolean;
  raw_ip_retention_days: number;
  auto_enrich_on_session_create: boolean;
  maxmind_local: {
    enabled: boolean;
    db_path: string;
    auto_reload: boolean;
    cache_ttl_seconds: number;
  };
  map: {
    show_only_valid_coords: boolean;
    ignore_fallback_only_points: boolean;
    default_center_mode: 'auto' | 'manual';
    default_lat: number;
    default_lng: number;
    default_zoom: number;
    include_geo_labels: boolean;
    debug_mode: boolean;
  };
  jobs: {
    warm_lookback_days: number;
    warm_limit: number;
    warm_force_reenrich: boolean;
  };
}

export interface MaxmindStatus {
  enabled: boolean;
  configured: boolean;
  db_path: string;
  file_exists: boolean;
  readable: boolean;
  usable: boolean;
  size_bytes: number | null;
  mtime: string | null;
  error: string | null;
}

export interface TestIpResult {
  result: {
    country: string | null;
    country_code: string | null;
    region: string | null;
    city: string | null;
    latitude: number | null;
    longitude: number | null;
    timezone: string | null;
    accuracy_level: 'country' | 'region' | 'city' | null;
    is_fallback: boolean;
    source_provider: string | null;
    source: string;
    duration_ms: number;
    ip_echo: string;
  };
  active_provider: { provider_name: string | null; is_disabled: boolean };
  settings_snapshot: {
    preferred_precision: string;
    allow_centroid_fallback: boolean;
    maxmind_enabled: boolean;
  };
  fallback_reason: string | null;
}

export interface WarmGeoResult {
  status: string;
  lookback_days: number;
  scanned: number;
  enriched: number;
  skipped_no_raw_ip: number;
  skipped_already_good: number;
  failed: number;
  fallback_count: number;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = await authHeaders();
  const res = await fetch(`${apiBase()}/api/admin/map-geo${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export const mapGeoAdminApi = {
  getSettings: () => call<{ settings: MapGeoSettings }>('/settings'),
  updateSettings: (patch: Partial<MapGeoSettings>) =>
    call<{ settings: MapGeoSettings; changed: boolean; diff?: Record<string, { from: unknown; to: unknown }> }>(
      '/settings',
      { method: 'PUT', body: JSON.stringify(patch) },
    ),
  testIp: (ip: string, workspace_id?: string) =>
    call<TestIpResult>('/test-ip', {
      method: 'POST',
      body: JSON.stringify({ ip, workspace_id }),
    }),
  maxmindStatus: () => call<MaxmindStatus>('/maxmind/status'),
  warmGeo: (opts: { lookback_days?: number; limit?: number; force?: boolean }) =>
    call<WarmGeoResult>('/warm-geo', {
      method: 'POST',
      body: JSON.stringify(opts),
    }),
};