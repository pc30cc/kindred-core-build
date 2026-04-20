/**
 * Map tiles provider resolution.
 *
 * Returns the configuration the client needs to render the visitor map.
 * Provider-based: looked up from `provider_configs` (workspace override
 * → platform default) and falls back to OpenStreetMap (no key required).
 *
 * The renderer used in the UI is always Leaflet for now; the provider only
 * controls *which tile source* (and attribution) to use. This abstraction
 * lets us add MapLibre / vector tiles later without touching the Visitors page.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export interface MapTilesConfig {
  enabled: boolean;
  provider:
    | 'osm_public'
    | 'tileserver_selfhosted'
    | 'openmaptiles_selfhosted'
    | 'maptiler'
    | 'mapbox'
    | 'stadia'
    | 'custom'
    | 'osm'           // legacy alias for osm_public
    | 'none';
  tile_url: string | null;          // e.g. https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png
  attribution: string;
  max_zoom: number;
  min_zoom: number;
  /** Optional vector style URL for MapLibre-compatible renderers. */
  style_url?: string | null;
  /** Self-host vs cloud classification, surfaced to admin UI. */
  deployment?: 'selfhosted' | 'external' | 'builtin' | 'disabled';
  /** Optional health check URL (operator-supplied). */
  health_url?: string | null;
  // True if the renderer should fall back to the no-map list-only mode.
  fallback_no_map: boolean;
  // ── Observability fields (added in hardening pass) ────────────────
  /** Provider the operator actually configured (or null when unset). */
  requested_provider?: string | null;
  /** Provider currently powering tile rendering. May differ from requested. */
  resolved_provider?: string;
  /** Set when we silently fell back from `requested_provider`. */
  fallback_provider?: string | null;
  /** Human-readable reason for the fallback (e.g. "missing tile_url"). */
  fallback_reason?: string | null;
  /** Coarse health classification for the resolved provider. */
  health_status?: 'healthy' | 'unconfigured' | 'fallback' | 'disabled';
}

const DEFAULT_OSM: MapTilesConfig = {
  enabled: true,
  provider: 'osm_public',
  tile_url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  max_zoom: 19,
  min_zoom: 1,
  deployment: 'builtin',
  fallback_no_map: false,
};

const NO_MAP: MapTilesConfig = {
  enabled: false,
  provider: 'none',
  tile_url: null,
  attribution: '',
  max_zoom: 0,
  min_zoom: 0,
  deployment: 'disabled',
  fallback_no_map: true,
};

/**
 * "Tiles not configured" sentinel — returned in production self-host mode
 * when no provider is configured or the configured provider is invalid.
 * The UI renders a placeholder grid + admin banner instead of silently
 * pulling from public OSM. This is the new safe default.
 */
const UNCONFIGURED: MapTilesConfig = {
  enabled: false,
  provider: 'none',
  tile_url: null,
  attribution: '',
  max_zoom: 0,
  min_zoom: 0,
  deployment: 'disabled',
  fallback_no_map: true,
};

/**
 * Build the renderer config for a given provider name + raw config blob.
 * Returns both the active config and any silent fallback metadata so the
 * UI can communicate what is actually being rendered (precision/observability).
 */
function buildFromConfig(
  name: string,
  cfg: Record<string, unknown> | null,
): { config: MapTilesConfig; fallback?: { reason: string } } {
  const c = cfg ?? {};
  const get = (k: string) => (typeof c[k] === 'string' ? (c[k] as string) : '');
  // Built-in / legacy alias
  if (name === 'osm' || name === 'osm_public') return { config: DEFAULT_OSM };
  if (name === 'none' || name === 'disabled') return { config: NO_MAP };
  // ── Self-hosted tile server (TileServer GL etc.) ─────────────────
  if (name === 'tileserver_selfhosted') {
    const url = get('tile_url');
    if (!url) return { config: DEFAULT_OSM, fallback: { reason: 'missing tile_url' } };
    return { config: {
      enabled: true,
      provider: 'tileserver_selfhosted',
      tile_url: url,
      attribution: get('attribution') || '&copy; OpenStreetMap contributors',
      max_zoom: Number(c['max_zoom']) || 19,
      min_zoom: Number(c['min_zoom']) || 1,
      deployment: 'selfhosted',
      health_url: get('health_url') || null,
      fallback_no_map: false,
    } };
  }
  // ── Self-hosted OpenMapTiles ─────────────────────────────────────
  if (name === 'openmaptiles_selfhosted') {
    const url = get('tile_url');
    if (!url) return { config: DEFAULT_OSM, fallback: { reason: 'missing tile_url' } };
    return { config: {
      enabled: true,
      provider: 'openmaptiles_selfhosted',
      tile_url: url,
      style_url: get('style_url') || null,
      attribution: get('attribution') || '&copy; OpenMapTiles &copy; OpenStreetMap contributors',
      max_zoom: Number(c['max_zoom']) || 19,
      min_zoom: Number(c['min_zoom']) || 1,
      deployment: 'selfhosted',
      health_url: get('health_url') || null,
      fallback_no_map: false,
    } };
  }
  if (name === 'maptiler') {
    const key = get('api_key');
    if (!key) return { config: DEFAULT_OSM, fallback: { reason: 'missing api_key' } };
    const style = get('style') || 'streets-v2';
    return { config: {
      enabled: true, provider: 'maptiler',
      tile_url: `https://api.maptiler.com/maps/${style}/{z}/{x}/{y}.png?key=${key}`,
      attribution: '&copy; <a href="https://www.maptiler.com/">MapTiler</a> &copy; OpenStreetMap',
      max_zoom: 19, min_zoom: 1, deployment: 'external', fallback_no_map: false,
    } };
  }
  if (name === 'mapbox') {
    const token = get('access_token');
    const style = get('style_id') || 'mapbox/streets-v12';
    if (!token) return { config: DEFAULT_OSM, fallback: { reason: 'missing access_token' } };
    return { config: {
      enabled: true, provider: 'mapbox',
      tile_url: `https://api.mapbox.com/styles/v1/${style}/tiles/{z}/{x}/{y}?access_token=${token}`,
      attribution: '&copy; <a href="https://www.mapbox.com/about/maps/">Mapbox</a> &copy; OpenStreetMap',
      max_zoom: 22, min_zoom: 1, deployment: 'external', fallback_no_map: false,
    } };
  }
  if (name === 'stadia') {
    const key = get('api_key');
    const style = get('style') || 'alidade_smooth';
    const url = `https://tiles.stadiamaps.com/tiles/${style}/{z}/{x}/{y}{r}.png${key ? `?api_key=${key}` : ''}`;
    return { config: {
      enabled: true, provider: 'stadia', tile_url: url,
      attribution: '&copy; <a href="https://stadiamaps.com/">Stadia Maps</a> &copy; OpenStreetMap',
      max_zoom: 20, min_zoom: 1, deployment: 'external', fallback_no_map: false,
    } };
  }
  if (name === 'custom') {
    const url = get('tile_url');
    if (!url) return { config: DEFAULT_OSM, fallback: { reason: 'missing tile_url' } };
    return { config: {
      enabled: true, provider: 'custom', tile_url: url,
      attribution: get('attribution') || '',
      max_zoom: Number(c['max_zoom']) || 19,
      min_zoom: Number(c['min_zoom']) || 1,
      deployment: 'selfhosted',
      fallback_no_map: false,
    } };
  }
  // Unknown provider name — fall back safely.
  return { config: DEFAULT_OSM, fallback: { reason: `unknown provider: ${name}` } };
}

export async function resolveMapTilesConfig(
  config: ServerConfig,
  workspaceId: string | null,
): Promise<MapTilesConfig> {
  const sb = getServiceClient(config);
  let requested: string | null = null;
  let built: { config: MapTilesConfig; fallback?: { reason: string } } | null = null;

  if (workspaceId) {
    const { data: ws } = await sb
      .from('provider_configs')
      .select('provider_name, config, is_active')
      .eq('workspace_id', workspaceId)
      .eq('provider_type', 'map_tiles')
      .eq('is_active', true)
      .maybeSingle();
    if (ws) { requested = ws.provider_name; built = buildFromConfig(ws.provider_name, ws.config as any); }
  }
  if (!built) {
    const { data: platform } = await sb
      .from('provider_configs')
      .select('provider_name, config, is_active')
      .is('workspace_id', null)
      .eq('provider_type', 'map_tiles')
      .eq('is_active', true)
      .maybeSingle();
    if (platform) { requested = platform.provider_name; built = buildFromConfig(platform.provider_name, platform.config as any); }
  }
  // Default: free OSM, no key required, self-host friendly.
  if (!built) built = { config: DEFAULT_OSM };

  // Annotate the resolved config with observability metadata.
  const resolved = built.config.provider;
  const isFallback = !!built.fallback;
  const isDisabled = resolved === 'none';
  const healthStatus: MapTilesConfig['health_status'] =
    isDisabled ? 'disabled'
      : isFallback ? 'fallback'
        : !requested ? 'unconfigured'
          : 'healthy';

  return {
    ...built.config,
    requested_provider: requested,
    resolved_provider: resolved,
    fallback_provider: isFallback ? resolved : null,
    fallback_reason: built.fallback?.reason ?? null,
    health_status: healthStatus,
  };
}