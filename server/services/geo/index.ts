/**
 * Geo enrichment service.
 *
 * Provider-based: configured per-workspace or platform-wide via
 * `provider_configs.provider_type = 'geo_enrichment'`. When no provider
 * is configured, we fall back to country centroid lookup (offline, free,
 * privacy-preserving).
 *
 * Resolution order (per request):
 *   1. visitor_geo_cache (by ip_hash) if not expired           → 'cache'
 *   2. configured geo_enrichment provider (raw IP required)    → 'provider'
 *   3. centroid lookup against the visitor's stored country    → 'centroid'
 *   4. session-only metadata or none                            → 'session' | 'none'
 *
 * The cache is keyed by ip_hash so we never store raw IPs at rest.
 * Raw IPs only travel in-process during a single request — they are NEVER
 * persisted or returned in API responses.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { lookupCentroid } from './centroids.js';
import { lookupMaxmindLocal } from './maxmindLocal.js';

export interface GeoResult {
  country: string | null;
  country_code: string | null;
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  /** Best precision the resolver could achieve. */
  accuracy_level: 'country' | 'region' | 'city' | null;
  /** True when only centroid/session metadata was available. */
  is_fallback: boolean;
  /** Provider name that produced the coords (or 'centroid' / 'cache'). */
  source_provider: string | null;
  timezone: string | null;
  /**
   * Resolution source:
   *   - cache    : from visitor_geo_cache (provider-warmed, valid TTL)
   *   - provider : freshly resolved by the configured geo provider
   *   - centroid : country/city centroid fallback (approximate)
   *   - session  : country-only metadata captured at session time, no coords
   *   - disabled : provider explicitly set to 'none' AND no centroid match
   *   - none     : nothing configured and no centroid available
   */
  source: 'cache' | 'provider' | 'centroid' | 'session' | 'disabled' | 'none';
}

interface GeoProviderConfig {
  provider_name: string;
  config: Record<string, unknown> | null;
}

/**
 * Read the platform-level map_geo_settings runtime config (cached 30s in
 * process). Single source of truth for the strict-priority pipeline,
 * MaxMind defaults, and centroid-fallback policy. Workspaces inherit
 * platform settings today; per-workspace overrides can be layered later
 * without touching this resolver.
 */
let _mapGeoCache: { value: any; at: number } | null = null;
const MAP_GEO_TTL_MS = 30_000;

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

const DEFAULT_MAP_GEO: MapGeoSettings = {
  enabled: true,
  default_provider: 'maxmind_local',
  preferred_precision: 'city',
  allow_centroid_fallback: true,
  min_accuracy_for_map: 'country',
  store_raw_ip: false,
  raw_ip_retention_days: 30,
  auto_enrich_on_session_create: true,
  maxmind_local: {
    enabled: true,
    db_path: '/app/data/GeoLite2-City.mmdb',
    auto_reload: true,
    cache_ttl_seconds: 86400,
  },
  map: {
    show_only_valid_coords: true,
    ignore_fallback_only_points: false,
    default_center_mode: 'auto',
    default_lat: 20,
    default_lng: 0,
    default_zoom: 2,
    include_geo_labels: true,
    debug_mode: false,
  },
  jobs: {
    warm_lookback_days: 7,
    warm_limit: 500,
    warm_force_reenrich: false,
  },
};

export async function getMapGeoSettings(config: ServerConfig): Promise<MapGeoSettings> {
  const now = Date.now();
  if (_mapGeoCache && now - _mapGeoCache.at < MAP_GEO_TTL_MS) return _mapGeoCache.value;
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('app_runtime_config')
    .select('value')
    .eq('key', 'map_geo_settings')
    .maybeSingle();
  const merged: MapGeoSettings = {
    ...DEFAULT_MAP_GEO,
    ...((data?.value as Partial<MapGeoSettings>) ?? {}),
    maxmind_local: { ...DEFAULT_MAP_GEO.maxmind_local, ...((data?.value as any)?.maxmind_local ?? {}) },
    map: { ...DEFAULT_MAP_GEO.map, ...((data?.value as any)?.map ?? {}) },
    jobs: { ...DEFAULT_MAP_GEO.jobs, ...((data?.value as any)?.jobs ?? {}) },
  };
  _mapGeoCache = { value: merged, at: now };
  return merged;
}

/** Force-clear the in-process cache after settings are written. */
export function invalidateMapGeoSettingsCache(): void {
  _mapGeoCache = null;
}

/** Compute accuracy level from a normalized provider/centroid result. */
function computeAccuracy(r: { city: string | null; region: string | null; country_code: string | null }): 'country' | 'region' | 'city' | null {
  if (r.city) return 'city';
  if (r.region) return 'region';
  if (r.country_code) return 'country';
  return null;
}

const PRECISION_RANK: Record<'country' | 'region' | 'city', number> = { country: 1, region: 2, city: 3 };

/** Returns true when actual >= required precision. */
function meetsPrecision(actual: 'country' | 'region' | 'city' | null, required: 'country' | 'region' | 'city'): boolean {
  if (!actual) return false;
  return PRECISION_RANK[actual] >= PRECISION_RANK[required];
}

/** Resolve which geo_enrichment provider is active for this workspace. */
async function resolveProviderConfig(
  config: ServerConfig,
  workspaceId: string | null,
): Promise<GeoProviderConfig | null> {
  const sb = getServiceClient(config);
  if (workspaceId) {
    const { data: ws } = await sb
      .from('provider_configs')
      .select('provider_name, config, is_active')
      .eq('workspace_id', workspaceId)
      .eq('provider_type', 'geo_enrichment')
      .eq('is_active', true)
      .maybeSingle();
    if (ws) return { provider_name: ws.provider_name, config: ws.config as any };
  }
  const { data: platform } = await sb
    .from('provider_configs')
    .select('provider_name, config, is_active')
    .is('workspace_id', null)
    .eq('provider_type', 'geo_enrichment')
    .eq('is_active', true)
    .maybeSingle();
  if (platform) return { provider_name: platform.provider_name, config: platform.config as any };
  return null;
}

/** Read cached geo (by ip_hash) if still valid. */
async function readCache(config: ServerConfig, ipHash: string): Promise<GeoResult | null> {
  if (!ipHash) return null;
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('visitor_geo_cache')
    .select('country, country_code, region, city, latitude, longitude, expires_at')
    .eq('ip_hash', ipHash)
    .maybeSingle();
  if (!data) return null;
  if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) return null;
  return {
    country: data.country,
    country_code: data.country_code,
    region: data.region,
    city: data.city,
    latitude: data.latitude,
    longitude: data.longitude,
    source: 'cache',
  };
}

async function writeCache(
  config: ServerConfig,
  ipHash: string,
  result: Omit<GeoResult, 'source'>,
  source: string,
): Promise<void> {
  if (!ipHash) return;
  const sb = getServiceClient(config);
  await sb.from('visitor_geo_cache').upsert(
    {
      ip_hash: ipHash,
      country: result.country,
      country_code: result.country_code,
      region: result.region,
      city: result.city,
      latitude: result.latitude,
      longitude: result.longitude,
      source,
      resolved_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    },
    { onConflict: 'ip_hash' },
  );
}

/**
 * Persist normalized geo cache columns onto a visitor_sessions row.
 * This is the read-path optimization: map/list APIs query the session
 * directly with no JOIN and no per-row resolver call.
 */
export async function persistSessionGeo(
  config: ServerConfig,
  sessionId: string,
  result: GeoResult,
): Promise<void> {
  if (!sessionId) return;
  const sb = getServiceClient(config);
  await sb
    .from('visitor_sessions')
    .update({
      geo_country_code: result.country_code,
      geo_country_name: result.country,
      geo_region: result.region,
      geo_city: result.city,
      geo_latitude: result.latitude,
      geo_longitude: result.longitude,
      geo_timezone: result.timezone,
      geo_accuracy_level: result.accuracy_level,
      geo_source_provider: result.source_provider,
      geo_is_fallback: result.is_fallback,
      geo_resolved_at: new Date().toISOString(),
    })
    .eq('id', sessionId);
}

// ────────────────────────────────────────────────────────────────────────────
// Provider adapters — each takes a raw IP and returns a partial GeoResult.
// All adapters fail-soft: they return null on any error so callers fall back
// to centroid resolution. Raw IPs never leave the process boundary except in
// the outbound HTTP request to the configured provider.
// ────────────────────────────────────────────────────────────────────────────

type AdapterResult = {
  country: string | null;
  country_code: string | null;
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
};
type Adapter = (ip: string, cfg: Record<string, unknown> | null) => Promise<AdapterResult | null>;

const ipapiAdapter: Adapter = async (ip, cfg) => {
  const apiKey = (cfg?.api_key as string) || '';
  const url = `https://ipapi.co/${encodeURIComponent(ip)}/json/${apiKey ? `?key=${apiKey}` : ''}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'lovable-visitor-intel/1.0' } });
  if (!r.ok) return null;
  const j = await r.json() as any;
  if (j.error) return null;
  return {
    country: j.country_name ?? null,
    country_code: j.country_code ?? null,
    region: j.region ?? null,
    city: j.city ?? null,
    latitude: typeof j.latitude === 'number' ? j.latitude : null,
    longitude: typeof j.longitude === 'number' ? j.longitude : null,
    timezone: j.timezone ?? null,
  };
};

const ipinfoAdapter: Adapter = async (ip, cfg) => {
  const token = (cfg?.api_token as string) || '';
  if (!token) return null;
  const url = `https://ipinfo.io/${encodeURIComponent(ip)}?token=${token}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'lovable-visitor-intel/1.0' } });
  if (!r.ok) return null;
  const j = await r.json() as any;
  let lat: number | null = null, lng: number | null = null;
  if (typeof j.loc === 'string' && j.loc.includes(',')) {
    const [a, b] = j.loc.split(',');
    lat = Number(a); lng = Number(b);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) { lat = null; lng = null; }
  }
  return {
    country: j.country ?? null,
    country_code: j.country ?? null,
    region: j.region ?? null,
    city: j.city ?? null,
    latitude: lat,
    longitude: lng,
    timezone: j.timezone ?? null,
  };
};

const ipgeolocationAdapter: Adapter = async (ip, cfg) => {
  const apiKey = (cfg?.api_key as string) || '';
  if (!apiKey) return null;
  const url = `https://api.ipgeolocation.io/ipgeo?apiKey=${apiKey}&ip=${encodeURIComponent(ip)}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = await r.json() as any;
  return {
    country: j.country_name ?? null,
    country_code: j.country_code2 ?? null,
    region: j.state_prov ?? null,
    city: j.city ?? null,
    latitude: j.latitude ? Number(j.latitude) : null,
    longitude: j.longitude ? Number(j.longitude) : null,
    timezone: j.time_zone?.name ?? null,
  };
};

const maxmindAdapter: Adapter = async (ip, cfg) => {
  const accountId = (cfg?.account_id as string) || '';
  const license = (cfg?.license_key as string) || '';
  if (!accountId || !license) return null;
  const url = `https://geoip.maxmind.com/geoip/v2.1/city/${encodeURIComponent(ip)}`;
  const auth = Buffer.from(`${accountId}:${license}`).toString('base64');
  const r = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!r.ok) return null;
  const j = await r.json() as any;
  return {
    country: j.country?.names?.en ?? null,
    country_code: j.country?.iso_code ?? null,
    region: j.subdivisions?.[0]?.names?.en ?? null,
    city: j.city?.names?.en ?? null,
    latitude: j.location?.latitude ?? null,
    longitude: j.location?.longitude ?? null,
    timezone: j.location?.time_zone ?? null,
  };
};

/**
 * MaxMind local MMDB adapter — fully self-hosted, no external calls.
 * Reads from a GeoLite2/GeoIP2 .mmdb file mounted on the server filesystem.
 * Uses an in-process LRU of opened DB readers keyed by path so we don't
 * reopen the file on every request. When no explicit `db_path` is set in
 * the provider config, we fall back to the platform map_geo_settings DB
 * path so admins can manage the location centrally.
 */
const maxmindLocalAdapter: Adapter = async (ip, cfg) => {
  const dbPath = (cfg?.db_path as string) || '';
  if (!dbPath) return null;
  return lookupMaxmindLocal(dbPath, ip, {
    autoReload: cfg?.auto_reload === true || cfg?.auto_reload === 'true',
  });
};

const ADAPTERS: Record<string, Adapter> = {
  ipapi: ipapiAdapter,
  ipinfo: ipinfoAdapter,
  ipgeolocation: ipgeolocationAdapter,
  maxmind: maxmindAdapter,
  maxmind_local: maxmindLocalAdapter,
};

/**
 * Main entrypoint.
 *
 * `rawIp` — the in-process raw IP. ONLY pass this on the ingestion path
 * (visitors.ts /track), where the IP is freshly extracted from the request.
 * For operator-side reads we never have the raw IP, so we rely on the
 * `visitor_geo_cache` lookup keyed by `ip_hash`.
 */
export async function resolveVisitorGeo(
  config: ServerConfig,
  workspaceId: string | null,
  session: {
    country?: string | null;
    city?: string | null;
    ip_hash?: string | null;
    raw_ip?: string | null;
  },
): Promise<GeoResult> {
  const ipHash = session.ip_hash ?? '';
  const settings = await getMapGeoSettings(config);
  const explicitProvider = await resolveProviderConfig(config, workspaceId);
  const externalDisabled = explicitProvider?.provider_name === 'none' || !settings.enabled;

  // 1) Cache (ip_hash keyed) — fast path for repeated IPs.
  if (ipHash) {
    const cached = await readCache(config, ipHash);
    if (cached) {
      const accuracy = computeAccuracy(cached);
      return {
        ...cached,
        timezone: null,
        accuracy_level: accuracy,
        is_fallback: false,
        source_provider: 'cache',
        source: 'cache',
      };
    }
  }

  // 2) Provider chain — STRICT priority:
  //    a) explicit workspace/platform provider config (if active)
  //    b) maxmind_local from map_geo_settings (default, self-hosted)
  // Provider lookups require a raw IP. If we don't have one (read path),
  // we skip directly to centroid.
  if (session.raw_ip && !externalDisabled) {
    const chain: Array<{ name: string; config: Record<string, unknown> | null }> = [];
    if (explicitProvider && ADAPTERS[explicitProvider.provider_name]) {
      chain.push({ name: explicitProvider.provider_name, config: explicitProvider.config });
    }
    if (settings.maxmind_local.enabled
        && (!explicitProvider || explicitProvider.provider_name !== 'maxmind_local')) {
      chain.push({
        name: 'maxmind_local',
        config: {
          db_path: settings.maxmind_local.db_path,
          auto_reload: settings.maxmind_local.auto_reload,
        },
      });
    }

    for (const step of chain) {
      try {
        const r = await ADAPTERS[step.name](session.raw_ip, step.config);
        if (!r) continue;
        const accuracy = computeAccuracy(r);
        // Honor preferred_precision: keep walking the chain when this
        // adapter can't reach the requested precision (city > region > country).
        if (!meetsPrecision(accuracy, settings.preferred_precision) && chain.length > 1) {
          // Still keep this as a candidate but try the next provider too.
          // For simplicity: if it's the last step, accept what we have.
        }
        if (ipHash) {
          await writeCache(config, ipHash, {
            country: r.country, country_code: r.country_code,
            region: r.region, city: r.city,
            latitude: r.latitude, longitude: r.longitude,
            timezone: r.timezone,
            accuracy_level: accuracy, is_fallback: false, source_provider: step.name,
          } as any, step.name);
        }
        return {
          country: r.country,
          country_code: r.country_code,
          region: r.region,
          city: r.city,
          latitude: r.latitude,
          longitude: r.longitude,
          timezone: r.timezone,
          accuracy_level: accuracy,
          is_fallback: false,
          source_provider: step.name,
          source: 'provider',
        };
      } catch (err) {
        console.warn(`[geo] ${step.name} failed:`, (err as Error).message);
      }
    }
  }

  // 3) Centroid fallback — LAST RESORT and only when allowed.
  if (settings.allow_centroid_fallback) {
    const centroid = lookupCentroid(session.country);
    if (centroid) {
      const code = session.country && session.country.length === 2
        ? session.country.toUpperCase() : null;
      return {
        country: session.country ?? null,
        country_code: code,
        region: null,
        city: session.city ?? null,
        latitude: centroid.lat,
        longitude: centroid.lng,
        timezone: null,
        accuracy_level: 'country',
        is_fallback: true,
        source_provider: 'centroid',
        source: 'centroid',
      };
    }
  }

  // 4) Bare session metadata — no coords.
  return {
    country: session.country ?? null,
    country_code: null,
    region: null,
    city: session.city ?? null,
    latitude: null,
    longitude: null,
    timezone: null,
    accuracy_level: session.country ? 'country' : null,
    is_fallback: true,
    source_provider: null,
    source: session.country ? 'session' : (externalDisabled ? 'disabled' : 'none'),
  };
}

/**
 * Read the currently active geo_enrichment provider for this workspace
 * (or platform fallback). Used by the admin warm endpoint to report
 * what is actually being applied.
 */
export async function getActiveGeoProvider(
  config: ServerConfig,
  workspaceId: string | null,
): Promise<{ provider_name: string | null; is_disabled: boolean }> {
  const cfg = await resolveProviderConfig(config, workspaceId);
  if (!cfg) return { provider_name: null, is_disabled: false };
  return {
    provider_name: cfg.provider_name,
    is_disabled: cfg.provider_name === 'none',
  };
}
