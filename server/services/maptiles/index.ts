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

function buildFromConfig(name: string, cfg: Record<string, unknown> | null): MapTilesConfig {
  const c = cfg ?? {};
  const get = (k: string) => (typeof c[k] === 'string' ? (c[k] as string) : '');
  // Built-in / legacy alias
  if (name === 'osm' || name === 'osm_public') return DEFAULT_OSM;
  if (name === 'none' || name === 'disabled') return NO_MAP;
  // ── Self-hosted tile server (TileServer GL etc.) ─────────────────
  if (name === 'tileserver_selfhosted') {
    const url = get('tile_url');
    if (!url) return DEFAULT_OSM; // safe fallback
    return {
      enabled: true,
      provider: 'tileserver_selfhosted',
      tile_url: url,
      attribution: get('attribution') || '&copy; OpenStreetMap contributors',
      max_zoom: Number(c['max_zoom']) || 19,
      min_zoom: Number(c['min_zoom']) || 1,
      deployment: 'selfhosted',
      health_url: get('health_url') || null,
      fallback_no_map: false,
    };
  }
  // ── Self-hosted OpenMapTiles ─────────────────────────────────────
  if (name === 'openmaptiles_selfhosted') {
    const url = get('tile_url');
    if (!url) return DEFAULT_OSM;
    return {
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
    };
  }
  if (name === 'maptiler') {
    const key = get('api_key');
    if (!key) return DEFAULT_OSM;
    const style = get('style') || 'streets-v2';
    return {
      enabled: true, provider: 'maptiler',
      tile_url: `https://api.maptiler.com/maps/${style}/{z}/{x}/{y}.png?key=${key}`,
      attribution: '&copy; <a href="https://www.maptiler.com/">MapTiler</a> &copy; OpenStreetMap',
      max_zoom: 19, min_zoom: 1, deployment: 'external', fallback_no_map: false,
    };
  }
  if (name === 'mapbox') {
    const token = get('access_token');
    const style = get('style_id') || 'mapbox/streets-v12';
    if (!token) return DEFAULT_OSM;
    return {
      enabled: true, provider: 'mapbox',
      tile_url: `https://api.mapbox.com/styles/v1/${style}/tiles/{z}/{x}/{y}?access_token=${token}`,
      attribution: '&copy; <a href="https://www.mapbox.com/about/maps/">Mapbox</a> &copy; OpenStreetMap',
      max_zoom: 22, min_zoom: 1, deployment: 'external', fallback_no_map: false,
    };
  }
  if (name === 'stadia') {
    const key = get('api_key');
    const style = get('style') || 'alidade_smooth';
    const url = `https://tiles.stadiamaps.com/tiles/${style}/{z}/{x}/{y}{r}.png${key ? `?api_key=${key}` : ''}`;
    return {
      enabled: true, provider: 'stadia', tile_url: url,
      attribution: '&copy; <a href="https://stadiamaps.com/">Stadia Maps</a> &copy; OpenStreetMap',
      max_zoom: 20, min_zoom: 1, deployment: 'external', fallback_no_map: false,
    };
  }
  if (name === 'custom') {
    const url = get('tile_url');
    if (!url) return DEFAULT_OSM;
    return {
      enabled: true, provider: 'custom', tile_url: url,
      attribution: get('attribution') || '',
      max_zoom: Number(c['max_zoom']) || 19,
      min_zoom: Number(c['min_zoom']) || 1,
      deployment: 'selfhosted',
      fallback_no_map: false,
    };
  }
  return DEFAULT_OSM;
}

export async function resolveMapTilesConfig(
  config: ServerConfig,
  workspaceId: string | null,
): Promise<MapTilesConfig> {
  const sb = getServiceClient(config);
  if (workspaceId) {
    const { data: ws } = await sb
      .from('provider_configs')
      .select('provider_name, config, is_active')
      .eq('workspace_id', workspaceId)
      .eq('provider_type', 'map_tiles')
      .eq('is_active', true)
      .maybeSingle();
    if (ws) return buildFromConfig(ws.provider_name, ws.config as any);
  }
  const { data: platform } = await sb
    .from('provider_configs')
    .select('provider_name, config, is_active')
    .is('workspace_id', null)
    .eq('provider_type', 'map_tiles')
    .eq('is_active', true)
    .maybeSingle();
  if (platform) return buildFromConfig(platform.provider_name, platform.config as any);
  // Default: free OSM, no key required, self-host friendly.
  return DEFAULT_OSM;
}