/**
 * Map & Geo platform settings.
 *
 * Stored as a single JSON blob under `app_runtime_config.key = 'map_geo_settings'`.
 * Edited by platform admins via /api/admin/map-geo/settings.
 *
 * Shape mirrors the seed in migration 20251204120000_geo_ip_cache_and_settings.sql.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

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
  maxmind_local: {
    enabled: boolean;
    db_path: string;
    auto_reload: boolean;
    cache_ttl_seconds: number;
  };
  maxmind_update: {
    mode: 'manual' | 'auto';
    account_id: string;
    license_key: string;
    edition_id: string;
    interval_hours: number;
    last_run_at: string | null;
    last_status: string | null;
    last_error: string | null;
  };
  tiles: {
    provider: string;
    url_template: string;
    attribution: string;
    min_zoom: number;
    max_zoom: number;
    subdomains: string;
  };
  behavior: {
    show_only_valid_coords: boolean;
    ignore_fallback_only: boolean;
    include_geo_labels: boolean;
    debug_metadata: boolean;
    default_center_mode: 'auto' | 'fixed';
    default_center_lat: number;
    default_center_lng: number;
    default_zoom: number;
  };
  /**
   * Display tuning for the Visitors page map canvas. Persisted server-side
   * so changes are global (per-platform) and survive redeploys.
   */
  display: {
    /** Height (px) of the map panel on the Visitors page. */
    height_px: number;
    /** Whether the map panel should grow to viewport height instead of a fixed px. */
    fill_viewport: boolean;
  };
  /**
   * Realtime presence cadence — controls how quickly a new visitor shows
   * up in the panel and how aggressively the widget pings the server.
   * All values in milliseconds. Lower = more responsive, higher = cheaper.
   */
  presence: {
    /** Widget loader heartbeat interval (ms). Default 30000. */
    heartbeat_interval_ms: number;
    /** Visitors-page list/map refetch interval (ms). Default 10000. */
    live_refresh_ms: number;
    /** Marks a visitor offline after this many ms without activity. Default 90000. */
    stale_after_ms: number;
  };
}

const DEFAULTS: MapGeoSettings = {
  geo: {
    enabled: true,
    default_provider: 'maxmind_local',
    preferred_precision: 'city',
    allow_centroid_fallback: true,
    min_accuracy_for_map: 'city',
    store_raw_ip: false,
    raw_ip_retention_days: 7,
    auto_enrich_on_session_create: true,
    cache_ttl_seconds: 30 * 24 * 60 * 60,
  },
  maxmind_local: {
    enabled: true,
    db_path: '/app/data/GeoLite2-City.mmdb',
    auto_reload: true,
    cache_ttl_seconds: 30 * 24 * 60 * 60,
  },
  maxmind_update: {
    mode: 'manual',
    account_id: '',
    license_key: '',
    edition_id: 'GeoLite2-City',
    interval_hours: 168,
    last_run_at: null,
    last_status: null,
    last_error: null,
  },
  tiles: {
    provider: 'self_hosted_raster',
    url_template: '',
    attribution: '',
    min_zoom: 0,
    max_zoom: 19,
    subdomains: '',
  },
  behavior: {
    show_only_valid_coords: true,
    ignore_fallback_only: false,
    include_geo_labels: true,
    debug_metadata: false,
    default_center_mode: 'auto',
    default_center_lat: 0,
    default_center_lng: 0,
    default_zoom: 2,
  },
  display: {
    height_px: 600,
    fill_viewport: true,
  },
  presence: {
    heartbeat_interval_ms: 15_000,
    live_refresh_ms: 5_000,
    stale_after_ms: 60_000,
  },
};

function deepMerge<T>(base: T, patch: any): T {
  if (!patch || typeof patch !== 'object') return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...base };
  for (const k of Object.keys(patch)) {
    const bv = (base as any)?.[k];
    const pv = patch[k];
    if (bv && typeof bv === 'object' && !Array.isArray(bv) && pv && typeof pv === 'object' && !Array.isArray(pv)) {
      out[k] = deepMerge(bv, pv);
    } else if (pv !== undefined) {
      out[k] = pv;
    }
  }
  return out as T;
}

export async function getMapGeoSettings(config: ServerConfig): Promise<MapGeoSettings> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('app_runtime_config')
    .select('value')
    .eq('key', 'map_geo_settings')
    .maybeSingle();
  if (error) throw new Error(`Failed to load map and geo settings: ${error.message}`);
  return deepMerge(DEFAULTS, data?.value);
}

export async function patchMapGeoSettings(
  config: ServerConfig,
  patch: Partial<MapGeoSettings>,
): Promise<MapGeoSettings> {
  const sb = getServiceClient(config);
  const current = await getMapGeoSettings(config);
  const merged = deepMerge(current, patch);
  const { data, error } = await sb
    .from('app_runtime_config')
    .upsert(
      { key: 'map_geo_settings', value: merged as any, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    )
    .select('value')
    .single();
  if (error) throw new Error(`Failed to save map and geo settings: ${error.message}`);
  return deepMerge(DEFAULTS, data?.value);
}

export const MAP_GEO_DEFAULTS = DEFAULTS;