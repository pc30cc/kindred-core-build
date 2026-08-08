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
import { readIpCache, writeIpCache } from './ipCache.js';
import { getMapGeoSettings } from './settings.js';

export interface GeoResult {
  country: string | null;
  country_code: string | null;
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
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

// ────────────────────────────────────────────────────────────────────────────
// Provider adapters — each takes a raw IP and returns a partial GeoResult.
// All adapters fail-soft: they return null on any error so callers fall back
// to centroid resolution. Raw IPs never leave the process boundary except in
// the outbound HTTP request to the configured provider.
// ────────────────────────────────────────────────────────────────────────────

type Adapter = (ip: string, cfg: Record<string, unknown> | null) => Promise<Omit<GeoResult, 'source'> | null>;

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
  };
};

/**
 * MaxMind local MMDB adapter — fully self-hosted, no external calls.
 * Reads from a GeoLite2/GeoIP2 .mmdb file mounted on the server filesystem.
 * Uses an in-process LRU of opened DB readers keyed by path so we don't
 * reopen the file on every request.
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
  // Load admin runtime settings (cached cheaply by Postgres). These take
  // precedence over the legacy provider_configs row for self-host defaults.
  const mapGeo = await getMapGeoSettings(config).catch(() => null);
  const provider = await resolveProviderConfig(config, workspaceId);
  const defaultProvider = mapGeo?.geo.default_provider ?? provider?.provider_name ?? 'maxmind_local';
  const externalDisabled = defaultProvider === 'none' || provider?.provider_name === 'none';
  const allowCentroid = mapGeo?.geo.allow_centroid_fallback ?? true;
  const cacheTtl = mapGeo?.geo.cache_ttl_seconds ?? 30 * 24 * 60 * 60;

  // 1a. Legacy visitor_geo_cache (kept for backwards compatibility).
  if (ipHash) {
    const cached = await readCache(config, ipHash);
    if (cached) return cached;
  }
  // 1b. New geo_ip_cache (cross-workspace, ip_hash keyed).
  if (ipHash) {
    const ipCached = await readIpCache(config, ipHash);
    if (ipCached && ipCached.latitude !== null && ipCached.longitude !== null) {
      return {
        country: ipCached.country_name,
        country_code: ipCached.country_code,
        region: ipCached.region,
        city: ipCached.city,
        latitude: ipCached.latitude,
        longitude: ipCached.longitude,
        source: 'cache',
      };
    }
  }

  // 2a. Self-hosted maxmind_local first (preferred default, no external call).
  if (session.raw_ip && mapGeo?.maxmind_local.enabled && mapGeo.maxmind_local.db_path && !externalDisabled) {
    try {
      const local = await lookupMaxmindLocal(mapGeo.maxmind_local.db_path, session.raw_ip, {
        autoReload: mapGeo.maxmind_local.auto_reload,
      });
      if (local) {
        if (ipHash) {
          await writeIpCache(config, ipHash, {
            source: 'maxmind_local',
            country_code: local.country_code,
            country_name: local.country,
            region: local.region,
            city: local.city,
            latitude: local.latitude,
            longitude: local.longitude,
            timezone: null,
            accuracy_level: local.city ? 'city' : local.region ? 'region' : 'country',
            is_fallback: false,
          }, cacheTtl);
          await writeCache(config, ipHash, local, 'maxmind_local');
        }
        return { ...local, source: 'provider' };
      }
    } catch (err) {
      console.warn('[geo] maxmind_local failed:', (err as Error).message);
    }
  }

  // 2b. Optional configured provider (legacy path).
  if (session.raw_ip && !externalDisabled && provider && ADAPTERS[provider.provider_name]) {
    try {
      const result = await ADAPTERS[provider.provider_name](session.raw_ip, provider.config);
      if (result && ipHash) {
        await writeCache(config, ipHash, result, provider.provider_name);
        await writeIpCache(config, ipHash, {
          source: provider.provider_name,
          country_code: result.country_code,
          country_name: result.country,
          region: result.region,
          city: result.city,
          latitude: result.latitude,
          longitude: result.longitude,
          timezone: null,
          accuracy_level: result.city ? 'city' : result.region ? 'region' : 'country',
          is_fallback: false,
        }, cacheTtl);
      }
      if (result) return { ...result, source: 'provider' };
    } catch (err) {
      console.warn('[geo] provider failed, falling back:', (err as Error).message);
    }
  }

  // 3. Country centroid fallback (only when allowed by admin policy).
  const centroid = allowCentroid ? lookupCentroid(session.country) : null;
  if (centroid) {
    return {
      country: session.country ?? null,
      country_code: session.country && session.country.length === 2 ? session.country.toUpperCase() : null,
      region: null,
      city: session.city ?? null,
      latitude: centroid.lat,
      longitude: centroid.lng,
      source: 'centroid',
    };
  }

  // 4. Whatever the session gave us (no coords).
  // When external enrichment is explicitly disabled and we still have no
  // coords, surface 'disabled' so the UI can label it correctly.
  return {
    country: session.country ?? null,
    country_code: null,
    region: null,
    city: session.city ?? null,
    latitude: null,
    longitude: null,
    source: session.country
      ? 'session'
      : externalDisabled
        ? 'disabled'
        : 'none',
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

/**
 * Enrich a single visitor_session row with geo data and persist the
 * `geo_*` columns. Safe to call fire-and-forget from the widget /track
 * route — never throws, never blocks the response. Uses cache when
 * available; only writes if we actually resolved usable coordinates or
 * country info beyond what's already stored.
 */
export async function enrichVisitorSessionGeo(
  config: ServerConfig,
  params: {
    sessionId: string;
    workspaceId: string;
    ipHash?: string | null;
    rawIp?: string | null;
    /** Country code from Cloudflare's CF-IPCountry header (see
     * server/utils/clientIp.ts's getClientCountry) — lets the centroid
     * fallback (step 3 in resolveVisitorGeo) produce a country-level
     * result even when no geo_enrichment provider is configured. */
    country?: string | null;
  },
): Promise<void> {
  try {
    const result = await resolveVisitorGeo(config, params.workspaceId, {
      ip_hash: params.ipHash ?? null,
      raw_ip: params.rawIp ?? null,
      country: params.country ?? null,
    });
    if (!result || (result.source === 'none' || result.source === 'disabled')) return;
    if (
      result.country_code == null &&
      result.city == null &&
      result.latitude == null &&
      result.longitude == null
    ) {
      return;
    }
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
        geo_source_provider: result.source,
        geo_is_fallback: result.source === 'centroid' || result.source === 'session',
        geo_accuracy_level: result.city
          ? 'city'
          : result.region
            ? 'region'
            : result.country_code
              ? 'country'
              : null,
        geo_resolved_at: new Date().toISOString(),
        // Mirror simple country/city onto legacy columns for older readers.
        country: result.country_code ?? result.country ?? undefined,
        city: result.city ?? undefined,
      })
      .eq('id', params.sessionId)
      .eq('workspace_id', params.workspaceId);
  } catch (err) {
    console.warn('[geo] enrichVisitorSessionGeo failed:', (err as Error).message);
  }
}
