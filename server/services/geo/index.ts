/**
 * Geo enrichment service.
 *
 * Provider-based: configured per-workspace or platform-wide via
 * `provider_configs.provider_type = 'geo_enrichment'`. When no provider
 * is configured, we fall back to country centroid lookup (offline, free,
 * privacy-preserving).
 *
 * Resolution order (per request):
 *   1. visitor_geo_cache (by ip_hash) if not expired
 *   2. configured geo_enrichment provider (workspace override → platform default)
 *   3. centroid lookup against the visitor's stored country
 *   4. null coords (UI degrades to country-only display)
 *
 * The cache is keyed by ip_hash so we never store raw IPs.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { lookupCentroid } from './centroids.js';

export interface GeoResult {
  country: string | null;
  country_code: string | null;
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  source: 'cache' | 'provider' | 'centroid' | 'session' | 'none';
}

interface GeoProviderConfig {
  provider_name: string; // 'ipapi' | 'ipinfo' | 'centroid' | etc.
  config: Record<string, unknown> | null;
}

/** Resolve which geo_enrichment provider is active for this workspace. */
async function resolveProviderConfig(
  config: ServerConfig,
  workspaceId: string | null,
): Promise<GeoProviderConfig | null> {
  const sb = getServiceClient(config);
  // Workspace-level override
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
  // Platform default (workspace_id IS NULL)
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

/** Persist a successful provider lookup to the cache. */
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

/** Built-in `ipapi.co` adapter — opt-in only when configured. */
async function callIpapi(ipHash: string, providerCfg: Record<string, unknown> | null): Promise<Omit<GeoResult, 'source'> | null> {
  // The hash itself can't be looked up — but operators can use this provider
  // upstream (where the raw IP is still available via x-forwarded-for in their
  // own proxy layer) by providing a per-IP base URL. For the MVP, we treat the
  // provider as enabled-but-no-op when we only have the hash; centroid fallback
  // wins. This keeps the integration honest and privacy-safe.
  void providerCfg;
  void ipHash;
  return null;
}

/**
 * Main entrypoint. `session` carries whatever the client tracked
 * (browser/os/country/city), `ipHash` is the SHA-256(ip).slice(0,16)
 * already stored on the session.
 */
export async function resolveVisitorGeo(
  config: ServerConfig,
  workspaceId: string | null,
  session: { country?: string | null; city?: string | null; ip_hash?: string | null },
): Promise<GeoResult> {
  const ipHash = session.ip_hash ?? '';

  // 1. Cache
  if (ipHash) {
    const cached = await readCache(config, ipHash);
    if (cached) return cached;
  }

  // 2. Configured provider (best effort)
  const provider = await resolveProviderConfig(config, workspaceId);
  if (provider) {
    try {
      let result: Omit<GeoResult, 'source'> | null = null;
      if (provider.provider_name === 'ipapi') {
        result = await callIpapi(ipHash, provider.config);
      }
      // 'centroid' provider name is explicitly the no-network fallback.
      if (result) {
        await writeCache(config, ipHash, result, provider.provider_name);
        return { ...result, source: 'provider' };
      }
    } catch (err) {
      console.warn('[geo] provider failed, falling back to centroid:', (err as Error).message);
    }
  }

  // 3. Country centroid fallback
  const centroid = lookupCentroid(session.country);
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

  // 4. Whatever the session gave us (no coords)
  return {
    country: session.country ?? null,
    country_code: null,
    region: null,
    city: session.city ?? null,
    latitude: null,
    longitude: null,
    source: session.country ? 'session' : 'none',
  };
}