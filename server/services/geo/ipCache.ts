/**
 * geo_ip_cache — second-tier cache keyed by ip_hash.
 *
 * Sits between the legacy `visitor_geo_cache` (which stores resolution
 * outcomes alongside visitor sessions) and the live MaxMind reader.
 * The point of this table is to keep IP→geo lookups cheap when the same
 * IP is observed across many visitor sessions / workspaces.
 *
 * Keys: ip_hash (sha256 of IP, never the raw IP).
 * TTL controlled by map_geo_settings.geo.cache_ttl_seconds.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export interface CachedGeo {
  source: string;
  country_code: string | null;
  country_name: string | null;
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
  accuracy_level: string | null;
  is_fallback: boolean;
}

export async function readIpCache(
  config: ServerConfig,
  ipHash: string,
): Promise<CachedGeo | null> {
  if (!ipHash) return null;
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('geo_ip_cache')
    .select('source, country_code, country_name, region, city, latitude, longitude, timezone, accuracy_level, is_fallback, expires_at')
    .eq('ip_hash', ipHash)
    .maybeSingle();
  if (!data) return null;
  if (data.expires_at && new Date(data.expires_at as any).getTime() < Date.now()) return null;
  return {
    source: data.source,
    country_code: data.country_code,
    country_name: data.country_name,
    region: data.region,
    city: data.city,
    latitude: data.latitude,
    longitude: data.longitude,
    timezone: data.timezone,
    accuracy_level: data.accuracy_level,
    is_fallback: !!data.is_fallback,
  };
}

export async function writeIpCache(
  config: ServerConfig,
  ipHash: string,
  geo: CachedGeo,
  ttlSeconds: number,
): Promise<void> {
  if (!ipHash) return;
  const sb = getServiceClient(config);
  const expires_at = new Date(Date.now() + Math.max(60, ttlSeconds) * 1000).toISOString();
  await sb.from('geo_ip_cache').upsert(
    {
      ip_hash: ipHash,
      source: geo.source,
      country_code: geo.country_code,
      country_name: geo.country_name,
      region: geo.region,
      city: geo.city,
      latitude: geo.latitude,
      longitude: geo.longitude,
      timezone: geo.timezone,
      accuracy_level: geo.accuracy_level,
      is_fallback: geo.is_fallback,
      resolved_at: new Date().toISOString(),
      expires_at,
    },
    { onConflict: 'ip_hash' },
  );
}

/** Purge expired rows. Cheap to call hourly. */
export async function purgeExpiredIpCache(config: ServerConfig): Promise<number> {
  const sb = getServiceClient(config);
  const { count } = await sb
    .from('geo_ip_cache')
    .delete({ count: 'exact' })
    .lt('expires_at', new Date().toISOString());
  return count ?? 0;
}