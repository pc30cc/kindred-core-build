/**
 * Canonical Visitor Network Profile — THE source of truth for every
 * operator-facing surface that shows a visitor's IP / geo / device.
 *
 * Consumed by: Visitors (list, detail, map), Inbox (conversation sidebar),
 * Call Center (live queue, calls, call detail), Callbacks, Contacts.
 *
 * ── Why this module exists ────────────────────────────────────────────────
 * Before it, three independent readers existed:
 *   - visitors/intelligence.ts re-ran `resolveVisitorGeo()` per row (N+1, and
 *     it ignored the `geo_*` columns that ingestion had already persisted),
 *   - useConversations.ts derived the Inbox flag from the *contact's newest*
 *     session instead of the conversation's own session,
 *   - contacts.ts had its own, weaker, IP permission rule.
 * They could and did disagree. Now they all call in here.
 *
 * ── Read-path precedence (NO provider lookup ever happens here) ───────────
 *   1. persisted `visitor_sessions.geo_*`      → authoritative
 *   2. `geo_ip_cache`      (ip_hash keyed, TTL) → canonical cache
 *   3. `visitor_geo_cache` (ip_hash keyed, TTL) → legacy cache
 *   4. legacy `visitor_sessions.country/city`   → compatibility only
 *   5. unavailable
 *
 * Provider resolution belongs exclusively to the WRITE path
 * (`enrichVisitorSessionGeo`, invoked at ingestion). A UI read must never
 * cause an outbound geo lookup — that is what produced N+1 provider calls on
 * every Visitors poll.
 *
 * Caches are keyed on `ip_hash`, so two different visitors only ever share a
 * cache entry when they genuinely share an IP.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { checkEntitlementFromDB } from '../../middleware/featureGating.js';
import { maskIp } from '../../utils/clientIp.js';
import { countryNameFromCode, toCountryCode } from '../geo/countryNames.js';

export type GeoSourceCategory =
  | 'persisted'
  | 'cache'
  | 'provider'
  | 'centroid'
  | 'session'
  | 'none';

export interface VisitorNetworkGeo {
  country_code: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string | null;
  /** Coarse category — safe for UI grouping/counters. */
  source: GeoSourceCategory;
  /** Concrete producer, e.g. 'maxmind_local' | 'ipapi' | 'centroid'. */
  provider: string | null;
  accuracy_level: 'city' | 'region' | 'country' | null;
  is_fallback: boolean;
  resolved_at: string | null;
}

export interface VisitorNetworkIp {
  /** Real address. Non-null ONLY for owner/admin with the plan capability. */
  raw: string | null;
  /** What the UI may render: raw, masked, hash-anchored placeholder, or ''. */
  display: string;
  /** sha256-derived hash. Never exposed when the plan lacks the capability. */
  hash: string | null;
  /** true when the plan does not include `contact_ip_visibility`. */
  locked: boolean;
  can_view_raw: boolean;
}

export interface VisitorNetworkProfile {
  visitor_session_id: string;
  visitor_id: string | null;
  workspace_id: string;
  ip: VisitorNetworkIp;
  geo: VisitorNetworkGeo;
  device: { browser: string | null; os: string | null; device: string | null };
}

// ────────────────────────────────────────────────────────────────────────────
// IP visibility policy — ONE rule for Visitors, Inbox, Contacts, Call Center.
//
//   plan lacks `contact_ip_visibility` → nothing at all leaves the server
//                                        (no raw, no mask, no hash)
//   entitled + owner/admin             → raw IP when it was persisted,
//                                        else a stable hash placeholder
//   entitled + any other member        → masked IP ("185.23.xxx.xxx") when raw
//                                        was persisted, else hash placeholder
//
// `store_raw_ip = false` means no raw IP was ever written, so even an owner
// only ever sees the masked/hash form. Privacy and entitlement are therefore
// independent gates and both are enforced here, server-side.
// ────────────────────────────────────────────────────────────────────────────

export interface IpVisibilityPolicy {
  entitled: boolean;
  canViewRaw: boolean;
}

export function isAdminWorkspaceRole(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

export async function resolveIpVisibilityPolicy(
  config: ServerConfig,
  workspaceId: string,
  viewerRole: string | null | undefined,
): Promise<IpVisibilityPolicy> {
  let entitled = false;
  try {
    const r = await checkEntitlementFromDB(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      workspaceId,
      'contact_ip_visibility',
    );
    entitled = r.allowed === true;
  } catch {
    entitled = false; // fail closed
  }
  return { entitled, canViewRaw: entitled && isAdminWorkspaceRole(viewerRole) };
}

/** Stable, non-reversible placeholder derived from the hash (e.g. "a1b2·c3d4"). */
export function hashPlaceholder(ipHash: string | null | undefined): string {
  if (!ipHash) return '—';
  return `${ipHash.slice(0, 4)}·${ipHash.slice(4, 8)}`;
}

export function buildIpView(
  session: { ip_hash?: string | null; ip_raw?: string | null },
  policy: IpVisibilityPolicy,
): VisitorNetworkIp {
  if (!policy.entitled) {
    return { raw: null, display: '', hash: null, locked: true, can_view_raw: false };
  }
  const raw = session.ip_raw ?? null;
  const hash = session.ip_hash ?? null;
  if (policy.canViewRaw) {
    return {
      raw,
      display: raw ?? hashPlaceholder(hash),
      hash,
      locked: false,
      can_view_raw: true,
    };
  }
  return {
    raw: null,
    display: raw ? maskIp(raw) : hashPlaceholder(hash),
    hash,
    locked: false,
    can_view_raw: false,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Geo normalization
// ────────────────────────────────────────────────────────────────────────────

const EMPTY_GEO: VisitorNetworkGeo = {
  country_code: null, country: null, region: null, city: null,
  latitude: null, longitude: null, timezone: null,
  source: 'none', provider: null, accuracy_level: null,
  is_fallback: false, resolved_at: null,
};

export function accuracyOf(g: { city: string | null; region: string | null; country_code: string | null }):
  'city' | 'region' | 'country' | null {
  if (g.city) return 'city';
  if (g.region) return 'region';
  if (g.country_code) return 'country';
  return null;
}

/**
 * Map a stored `geo_source_provider` value onto the coarse UI category.
 * Historical rows stored the category itself ('provider' | 'cache' | ...);
 * newer rows store the concrete provider name ('maxmind_local', 'ipapi', …).
 * Both must land on the same category so the Visitors legend never shows the
 * same resolution two different ways.
 */
export function categorizeGeoSource(
  provider: string | null | undefined,
  isFallback: boolean,
): GeoSourceCategory {
  const p = (provider || '').toLowerCase();
  if (!p) return isFallback ? 'session' : 'none';
  if (p === 'cache') return 'cache';
  if (p === 'centroid') return 'centroid';
  if (p === 'session' || p === 'cf' || p === 'cloudflare') return 'session';
  if (p === 'none' || p === 'disabled') return 'none';
  return isFallback ? 'centroid' : 'provider';
}

/** Country code is normalized here, on the server — never with UI heuristics. */
function normalizeCountry(code: unknown, name: unknown): { code: string | null; name: string | null } {
  const cc = toCountryCode(typeof code === 'string' ? code : null)
    ?? toCountryCode(typeof name === 'string' ? name : null);
  const resolved = countryNameFromCode(cc);
  if (resolved) return { code: cc, name: resolved };
  const fallbackName = typeof name === 'string' && name.trim() && !toCountryCode(name) ? name : null;
  return { code: cc, name: fallbackName };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Step 1 — persisted `geo_*`. Authoritative; never overwritten by a fallback. */
export function geoFromPersistedSession(s: Record<string, any>): VisitorNetworkGeo | null {
  const hasAny =
    s.geo_country_code || s.geo_country_name || s.geo_city || s.geo_region ||
    num(s.geo_latitude) !== null || num(s.geo_longitude) !== null;
  if (!hasAny) return null;
  const c = normalizeCountry(s.geo_country_code, s.geo_country_name);
  const isFallback = s.geo_is_fallback === true;
  const geo: VisitorNetworkGeo = {
    country_code: c.code,
    country: c.name,
    region: s.geo_region ?? null,
    city: s.geo_city ?? null,
    latitude: num(s.geo_latitude),
    longitude: num(s.geo_longitude),
    timezone: s.geo_timezone ?? null,
    source: 'persisted',
    provider: s.geo_source_provider ?? null,
    accuracy_level: null,
    is_fallback: isFallback,
    resolved_at: s.geo_resolved_at ?? null,
  };
  geo.accuracy_level = (s.geo_accuracy_level as any) ?? accuracyOf(geo);
  return geo;
}

function geoFromIpCache(row: Record<string, any>): VisitorNetworkGeo {
  const c = normalizeCountry(row.country_code, row.country_name ?? row.country);
  const geo: VisitorNetworkGeo = {
    country_code: c.code,
    country: c.name,
    region: row.region ?? null,
    city: row.city ?? null,
    latitude: num(row.latitude),
    longitude: num(row.longitude),
    timezone: row.timezone ?? null,
    source: 'cache',
    provider: row.source ?? 'cache',
    accuracy_level: (row.accuracy_level as any) ?? null,
    is_fallback: row.is_fallback === true,
    resolved_at: row.resolved_at ?? null,
  };
  if (!geo.accuracy_level) geo.accuracy_level = accuracyOf(geo);
  return geo;
}

/** Step 4 — legacy `country`/`city` columns. Lowest precedence, by design. */
function geoFromLegacySession(s: Record<string, any>): VisitorNetworkGeo | null {
  if (!s.country && !s.city) return null;
  const c = normalizeCountry(s.country, s.country);
  const geo: VisitorNetworkGeo = {
    ...EMPTY_GEO,
    country_code: c.code,
    country: c.name,
    city: s.city ?? null,
    source: 'session',
    provider: null,
    is_fallback: true,
  };
  geo.accuracy_level = accuracyOf(geo);
  return geo;
}

function notExpired(expiresAt: unknown): boolean {
  if (!expiresAt) return true;
  const t = new Date(String(expiresAt)).getTime();
  return Number.isFinite(t) ? t >= Date.now() : true;
}

export const SESSION_NETWORK_COLUMNS =
  'id, visitor_id, workspace_id, contact_id, browser, device, os, country, city, ' +
  'ip_hash, ip_raw, geo_country_code, geo_country_name, geo_region, geo_city, ' +
  'geo_latitude, geo_longitude, geo_timezone, geo_source_provider, ' +
  'geo_accuracy_level, geo_is_fallback, geo_resolved_at';

/**
 * Build a profile from an already-fetched session row plus (optionally) a
 * cache row for its ip_hash. Pure — no I/O, so it is directly unit-testable.
 */
export function buildNetworkProfile(
  session: Record<string, any>,
  policy: IpVisibilityPolicy,
  cacheRow?: Record<string, any> | null,
): VisitorNetworkProfile {
  // An expired cache row is treated as absent here too, not only in the batch
  // query — otherwise a caller passing a stale row would surface old geo.
  const usableCache = cacheRow && notExpired(cacheRow.expires_at) ? cacheRow : null;
  const geo =
    geoFromPersistedSession(session) ??
    (usableCache ? geoFromIpCache(usableCache) : null) ??
    geoFromLegacySession(session) ??
    EMPTY_GEO;
  return {
    visitor_session_id: session.id,
    visitor_id: session.visitor_id ?? null,
    workspace_id: session.workspace_id,
    ip: buildIpView(session, policy),
    geo,
    device: {
      browser: session.browser ?? null,
      os: session.os ?? null,
      device: session.device ?? null,
    },
  };
}

/**
 * Batch resolver. One session query + at most two cache queries, regardless of
 * how many sessions are requested — this is what keeps Inbox / Visitors /
 * Calls lists free of N+1 lookups.
 *
 * Always workspace-scoped: a session id belonging to another workspace simply
 * does not come back, so no caller can use it for a cross-workspace read.
 */
export async function resolveNetworkProfiles(
  config: ServerConfig,
  workspaceId: string,
  sessionIds: string[],
  policy: IpVisibilityPolicy,
): Promise<Map<string, VisitorNetworkProfile>> {
  const out = new Map<string, VisitorNetworkProfile>();
  const ids = Array.from(new Set(sessionIds.filter(Boolean)));
  if (!ids.length) return out;
  const sb = getServiceClient(config);
  const { data: sessions } = await sb
    .from('visitor_sessions')
    .select(SESSION_NETWORK_COLUMNS)
    .eq('workspace_id', workspaceId)
    .in('id', ids);
  const rows = (sessions ?? []) as any[];
  if (!rows.length) return out;

  // Only sessions WITHOUT persisted geo need a cache lookup.
  const needCache = rows.filter((s) => !geoFromPersistedSession(s) && s.ip_hash);
  const cacheByHash = new Map<string, Record<string, any>>();
  if (needCache.length) {
    const hashes = Array.from(new Set(needCache.map((s) => s.ip_hash as string)));
    const { data: ipCache } = await sb
      .from('geo_ip_cache')
      .select('ip_hash, source, country_code, country_name, region, city, latitude, longitude, timezone, accuracy_level, is_fallback, resolved_at, expires_at')
      .in('ip_hash', hashes);
    for (const r of (ipCache ?? []) as any[]) {
      if (notExpired(r.expires_at)) cacheByHash.set(r.ip_hash, r);
    }
    const missing = hashes.filter((h) => !cacheByHash.has(h));
    if (missing.length) {
      const { data: legacyCache } = await sb
        .from('visitor_geo_cache')
        .select('ip_hash, source, country, country_code, region, city, latitude, longitude, resolved_at, expires_at')
        .in('ip_hash', missing);
      for (const r of (legacyCache ?? []) as any[]) {
        if (notExpired(r.expires_at)) cacheByHash.set(r.ip_hash, r);
      }
    }
  }

  for (const s of rows) {
    out.set(s.id, buildNetworkProfile(s, policy, s.ip_hash ? cacheByHash.get(s.ip_hash) ?? null : null));
  }
  return out;
}

export async function resolveNetworkProfile(
  config: ServerConfig,
  workspaceId: string,
  sessionId: string,
  policy: IpVisibilityPolicy,
): Promise<VisitorNetworkProfile | null> {
  const map = await resolveNetworkProfiles(config, workspaceId, [sessionId], policy);
  return map.get(sessionId) ?? null;
}

/**
 * Collapse the canonical geo onto the legacy `GeoResult.source` union that the
 * Visitors page / map legend already speak. Kept in ONE place so the mapping
 * can never drift between surfaces.
 */
export function legacyGeoSource(
  geo: VisitorNetworkGeo,
): 'cache' | 'provider' | 'centroid' | 'session' | 'none' {
  if (geo.source === 'persisted') {
    const cat = categorizeGeoSource(geo.provider, geo.is_fallback);
    return cat === 'persisted' ? 'provider' : cat;
  }
  return geo.source;
}
