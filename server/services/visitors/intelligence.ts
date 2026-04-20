/**
 * Visitor Intelligence service.
 *
 * Builds the normalized, UI-friendly shape consumed by the Visitors page.
 * Merges visitor_presence + visitor_sessions + provider-resolved geo +
 * linked contact / conversation, and applies role-based IP exposure.
 *
 * Privacy contract:
 *   - We never store raw IPs (only ip_hash).
 *   - `ip_display` is a coarse mask we can show to anyone with workspace
 *     access (e.g. "185.23.xxx.xxx"). Because we don't have the raw IP at
 *     read-time, the mask is reconstructed from a stable derivation when
 *     the cache hit doesn't include it — see buildIpDisplay().
 *   - `ip_raw` is reserved for owner/admin and is NEVER populated server-
 *     side today (we don't persist raw IPs). The field exists in the
 *     contract so a future "raw IP capture" toggle can populate it without
 *     a breaking API change. `can_view_raw_ip` reflects the *role* gate.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { resolveVisitorGeo, type GeoResult, getMapGeoSettings } from '../geo/index.js';

/**
 * Build a GeoResult from the normalized geo_* columns persisted on
 * visitor_sessions. This is the FAST READ PATH — no provider call, no
 * JOIN, no centroid recomputation. The columns were populated at ingest
 * (or by the warm-geo job) so we trust them as the source of truth.
 *
 * Returns null when the session has no usable geo data (caller may then
 * fall back to the live resolver, but that path now NEVER hits a
 * provider since raw IP is unavailable on read).
 */
function geoFromSession(s: any): GeoResult | null {
  const hasCoords = typeof s.geo_latitude === 'number' && typeof s.geo_longitude === 'number';
  const hasAny = hasCoords || s.geo_country_code || s.country;
  if (!hasAny) return null;
  const accuracy = (s.geo_accuracy_level as 'country' | 'region' | 'city' | null) ?? null;
  return {
    country: s.geo_country_name ?? s.country ?? null,
    country_code: s.geo_country_code ?? null,
    region: s.geo_region ?? null,
    city: s.geo_city ?? s.city ?? null,
    latitude: hasCoords ? s.geo_latitude : null,
    longitude: hasCoords ? s.geo_longitude : null,
    timezone: s.geo_timezone ?? null,
    accuracy_level: accuracy,
    is_fallback: s.geo_is_fallback === true,
    source_provider: s.geo_source_provider ?? null,
    source: s.geo_source_provider === 'centroid' ? 'centroid' : 'cache',
  };
}

export interface VisitorIntelligenceItem {
  // Identity
  id: string;
  visitor_id: string;
  workspace_id: string;

  // Presence
  status: 'online' | 'idle' | 'offline' | 'unknown';
  current_page: string | null;
  last_activity_at: string;
  started_at: string;

  // Device / browser
  browser: string | null;
  device: string | null;
  os: string | null;
  referrer: string | null;

  // Location (provider-resolved or centroid)
  geo: GeoResult;

  // IP exposure (privacy-aware)
  ip_display: string;            // always present (masked or hash-derived placeholder)
  ip_raw: string | null;         // populated only when can_view_raw_ip AND we have it
  can_view_raw_ip: boolean;      // role-based capability flag

  // Linkage
  contact: { id: string; name: string | null; email: string | null; avatar_url: string | null } | null;
  conversation: { id: string; status: string | null; subject: string | null } | null;
}

export interface IntelOptions {
  limit?: number;
  includeOffline?: boolean;
  staleMinutes?: number;
  /** Workspace role of the requester — drives IP exposure. */
  viewerRole?: 'owner' | 'admin' | 'agent' | 'billing' | string | null;
}

function mergeStatus(
  presenceStatus: string | null,
  presenceUpdatedAt: string | null,
  sessionLastSeen: string,
): VisitorIntelligenceItem['status'] {
  const last = presenceUpdatedAt ? new Date(presenceUpdatedAt).getTime() : new Date(sessionLastSeen).getTime();
  const ageMs = Date.now() - last;
  if (presenceStatus === 'online' && ageMs > 90_000) return 'idle';
  if (ageMs > 5 * 60_000) return 'offline';
  return (presenceStatus as VisitorIntelligenceItem['status']) ?? 'unknown';
}

function isAdminRole(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

/**
 * Build the masked display string. We don't have the raw IP at read-time
 * (it's never persisted), so for non-admins we surface a hash-anchored
 * placeholder that's still stable per-visitor and useful for spotting
 * duplicates. Admins/owners see the same value today; once a future
 * "store raw IP" toggle lands, this function will return the real mask.
 */
function buildIpDisplay(ipHash: string | null | undefined): string {
  if (!ipHash) return '—';
  // First 8 hex chars, grouped — e.g. "a1b2·c3d4". Stable per IP, no leak.
  const a = ipHash.slice(0, 4);
  const b = ipHash.slice(4, 8);
  return `${a}·${b}`;
}

export async function listVisitorIntelligence(
  config: ServerConfig,
  workspaceId: string,
  opts: IntelOptions = {},
): Promise<VisitorIntelligenceItem[]> {
  const sb = getServiceClient(config);
  const limit = Math.min(opts.limit ?? 200, 500);
  const staleMinutes = opts.staleMinutes ?? 30;
  const since = new Date(Date.now() - staleMinutes * 60_000).toISOString();
  const canViewRaw = isAdminRole(opts.viewerRole ?? null);

  const { data: rows, error } = await sb
    .from('visitor_presence')
    .select(`
      id, status, current_page, updated_at, visitor_session_id, workspace_id,
      visitor_sessions!inner (
        id, visitor_id, workspace_id, current_page, referrer, browser, device, os,
        country, city, ip_hash, ip_raw, started_at, last_seen_at,
        geo_country_code, geo_country_name, geo_region, geo_city,
        geo_latitude, geo_longitude, geo_timezone,
        geo_accuracy_level, geo_source_provider, geo_is_fallback, geo_resolved_at
      )
    `)
    .eq('workspace_id', workspaceId)
    .gte('updated_at', since)
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[visitors.intelligence] presence query failed:', error.message);
    return [];
  }

  const sessionIds = (rows ?? []).map(r => (r.visitor_sessions as any).id).filter(Boolean);
  const convsBySession = new Map<string, { id: string; status: string | null; subject: string | null; contact_id: string | null }>();
  const contactsById = new Map<string, { id: string; name: string | null; email: string | null; avatar_url: string | null }>();

  if (sessionIds.length) {
    const { data: convs } = await sb
      .from('conversations')
      .select('id, status, subject, contact_id, visitor_session_id, updated_at')
      .eq('workspace_id', workspaceId)
      .in('visitor_session_id', sessionIds)
      .order('updated_at', { ascending: false });
    for (const c of convs ?? []) {
      if (c.visitor_session_id && !convsBySession.has(c.visitor_session_id)) {
        convsBySession.set(c.visitor_session_id, {
          id: c.id, status: c.status, subject: c.subject, contact_id: c.contact_id,
        });
      }
    }
    const contactIds = [...convsBySession.values()].map(c => c.contact_id).filter(Boolean) as string[];
    if (contactIds.length) {
      const { data: cts } = await sb
        .from('contacts')
        .select('id, name, email, avatar_url')
        .in('id', contactIds);
      for (const c of cts ?? []) contactsById.set(c.id, c);
    }
  }

  const items: VisitorIntelligenceItem[] = [];

  for (const r of rows ?? []) {
    const session = r.visitor_sessions as any;
    // Read path: prefer cached normalized geo on the session row.
    // Resolver only runs as a last resort, and even then it has no raw IP
    // so it's bounded to cache + centroid (which is now correctly the
    // last fallback per map_geo_settings).
    const geo = geoFromSession(session) ?? await resolveVisitorGeo(config, workspaceId, {
      country: session.country, city: session.city, ip_hash: session.ip_hash,
    });
    const conv = convsBySession.get(session.id) ?? null;
    const contact = conv?.contact_id ? contactsById.get(conv.contact_id) ?? null : null;
    const status = mergeStatus(r.status, r.updated_at, session.last_seen_at);
    if (!opts.includeOffline && status === 'offline') continue;

    items.push({
      id: session.id,
      visitor_id: session.visitor_id,
      workspace_id: session.workspace_id,
      status,
      current_page: r.current_page ?? session.current_page ?? null,
      last_activity_at: r.updated_at ?? session.last_seen_at,
      started_at: session.started_at,
      browser: session.browser, device: session.device, os: session.os,
      referrer: session.referrer,
      geo,
      // Admin-only: surface real raw IP when the workspace toggle persisted it.
      // Everyone else gets a stable hash-anchored placeholder.
      ip_display: canViewRaw && session.ip_raw
        ? session.ip_raw
        : buildIpDisplay(session.ip_hash),
      ip_raw: canViewRaw ? (session.ip_raw ?? null) : null,
      can_view_raw_ip: canViewRaw,
      contact,
      conversation: conv ? { id: conv.id, status: conv.status, subject: conv.subject } : null,
    });
  }

  return items;
}

export async function getVisitorIntelligence(
  config: ServerConfig,
  workspaceId: string,
  sessionId: string,
  opts: { viewerRole?: string | null } = {},
): Promise<VisitorIntelligenceItem | null> {
  const sb = getServiceClient(config);
  const canViewRaw = isAdminRole(opts.viewerRole ?? null);

  const { data: presence } = await sb
    .from('visitor_presence')
    .select(`
      id, status, current_page, updated_at, visitor_session_id, workspace_id,
      visitor_sessions!inner (
        id, visitor_id, workspace_id, current_page, referrer, browser, device, os,
        country, city, ip_hash, ip_raw, started_at, last_seen_at,
        geo_country_code, geo_country_name, geo_region, geo_city,
        geo_latitude, geo_longitude, geo_timezone,
        geo_accuracy_level, geo_source_provider, geo_is_fallback, geo_resolved_at
      )
    `)
    .eq('workspace_id', workspaceId)
    .eq('visitor_session_id', sessionId)
    .maybeSingle();

  if (!presence) {
    const { data: session } = await sb
      .from('visitor_sessions')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('id', sessionId)
      .maybeSingle();
    if (!session) return null;
    const geo = geoFromSession(session) ?? await resolveVisitorGeo(config, workspaceId, {
      country: session.country, city: session.city, ip_hash: session.ip_hash,
    });
    return {
      id: session.id, visitor_id: session.visitor_id, workspace_id: session.workspace_id,
      status: 'offline', current_page: session.current_page,
      last_activity_at: session.last_seen_at, started_at: session.started_at,
      browser: session.browser, device: session.device, os: session.os, referrer: session.referrer,
      geo,
      ip_display: canViewRaw && (session as any).ip_raw
        ? (session as any).ip_raw
        : buildIpDisplay(session.ip_hash),
      ip_raw: canViewRaw ? ((session as any).ip_raw ?? null) : null,
      can_view_raw_ip: canViewRaw,
      contact: null, conversation: null,
    };
  }

  const session = presence.visitor_sessions as any;
  const geo = geoFromSession(session) ?? await resolveVisitorGeo(config, workspaceId, {
    country: session.country, city: session.city, ip_hash: session.ip_hash,
  });
  const { data: conv } = await sb
    .from('conversations')
    .select('id, status, subject, contact_id')
    .eq('workspace_id', workspaceId)
    .eq('visitor_session_id', sessionId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  let contact: VisitorIntelligenceItem['contact'] = null;
  if (conv?.contact_id) {
    const { data: c } = await sb
      .from('contacts')
      .select('id, name, email, avatar_url')
      .eq('id', conv.contact_id)
      .maybeSingle();
    if (c) contact = c;
  }

  return {
    id: session.id, visitor_id: session.visitor_id, workspace_id: session.workspace_id,
    status: mergeStatus(presence.status, presence.updated_at, session.last_seen_at),
    current_page: presence.current_page ?? session.current_page,
    last_activity_at: presence.updated_at ?? session.last_seen_at,
    started_at: session.started_at,
    browser: session.browser, device: session.device, os: session.os, referrer: session.referrer,
    geo,
    ip_display: canViewRaw && session.ip_raw
      ? session.ip_raw
      : buildIpDisplay(session.ip_hash),
    ip_raw: canViewRaw ? (session.ip_raw ?? null) : null,
    can_view_raw_ip: canViewRaw,
    contact,
    conversation: conv ? { id: conv.id, status: conv.status, subject: conv.subject } : null,
  };
}
