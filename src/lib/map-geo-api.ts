import { supabase } from '@/lib/supabase';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token || '';
  return token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
}

export interface MapGeoSettings {
  geo: {
    enabled: boolean;
    default_provider: string;
    preferred_precision: 'country' | 'region' | 'city';
    allow_centroid_fallback: boolean;
    min_accuracy_for_map: 'country' | 'region' | 'city';
    store_raw_ip: boolean;
    raw_ip_retention_days: number;
    auto_enrich_on_session_create: boolean;
    cache_ttl_seconds: number;
  };
  maxmind_local: { enabled: boolean; db_path: string; auto_reload: boolean; cache_ttl_seconds: number };
  maxmind_update: { mode: 'manual' | 'auto'; account_id: string; license_key: string; edition_id: string; interval_hours: number; last_run_at: string | null; last_status: string | null; last_error: string | null };
  tiles: { provider: string; url_template: string; attribution: string; min_zoom: number; max_zoom: number; subdomains: string };
  behavior: { show_only_valid_coords: boolean; ignore_fallback_only: boolean; include_geo_labels: boolean; debug_metadata: boolean; default_center_mode: 'auto' | 'fixed'; default_center_lat: number; default_center_lng: number; default_zoom: number };
  display: { height_px: number; fill_viewport: boolean };
  presence: { heartbeat_interval_ms: number; live_refresh_ms: number; stale_after_ms: number };
}

async function call<T>(method: string, path: string, body?: any): Promise<T> {
  const res = await fetch(`${API_BASE}/api/admin/map-geo${path}`, {
    method,
    headers: await authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(j.error || `Error ${res.status}`);
  }
  return res.json();
}

export const mapGeoApi = {
  getSettings: () => call<{ settings: MapGeoSettings }>('GET', '/settings'),
  updateSettings: (patch: Partial<MapGeoSettings>) => call<{ settings: MapGeoSettings }>('PUT', '/settings', patch),
  health: () => call<{ maxmind_local: any; tiles: any }>('GET', '/health'),
  testResolve: (ip: string) => call<any>('POST', '/test-resolve', { ip }),
  runUpdate: () => call<any>('POST', '/maxmind/run-update'),
  purgeCache: () => call<{ ok: boolean; purged: number }>('POST', '/cache/purge'),
};