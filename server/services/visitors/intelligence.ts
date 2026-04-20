/**
 * Visitor Intelligence service.
 *
 * Builds the normalized, UI-friendly shape consumed by the Visitors page.
 * Merges visitor_presence + visitor_sessions + (optional) geo enrichment +
 * linked contact / conversation, applying provider-based geo resolution.
 *
 * No raw IPs ever leave this layer.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { resolveVisitorGeo, type GeoResult } from '../geo/index.js';

export interface VisitorIntelligenceItem {
  // Identity
  id: string;                 // visitor_session.id
  visitor_id: string;
  workspace_id: string;

  // Presence
  status: 'online' | 'idle' | 'offline' | 'unknown';
  current_page: string | null;
  last_activity_at: string;   // last_seen_at OR presence.updated_at, whichever is newer
  started_at: string;

  // Device / browser
  browser: string | null;
  device: string | null;
  os: string | null;
  referrer: string | null;

  // Location (provider-resolved or centroid)
  geo: GeoResult;

  // Linkage
  contact: { id: string; name: string | null; email: string | null; avatar_url: string | null } | null;
  conversation: { id: string; status: string | null; subject: string | null } | null;
}

function mergeStatus(
  presenceStatus: string | null,
  presenceUpdatedAt: string | null,
  sessionLastSeen: string,
): VisitorIntelligenceItem['status'] {
  // Stale presence row → degrade to offline.
  const last = presenceUpdatedAt ? new Date(presenceUpdatedAt).getTime() : new Date(sessionLastSeen).getTime();
  const ageMs = Date.now() - last;
  if (presenceStatus === 'online' && ageMs > 90_000) return 'idle';
  if (ageMs > 5 * 60_000) return 'offline';
  return (presenceStatus as VisitorIntelligenceItem['status']) ?? 'unknown';
}

/**
 * List active visitor sessions with full intelligence shape.
 * Filters: only sessions whose last_seen_at OR presence.updated_at is within
 * `staleMinutes` minutes (default 30). Caller can filter further client-side.
 */
export async function listVisitorIntelligence(
  config: ServerConfig,
  workspaceId: string,
  opts: { limit?: number; includeOffline?: boolean; staleMinutes?: number } = {},
): Promise<VisitorIntelligenceItem[]> {
  const sb = getServiceClient(config);
  const limit = Math.min(opts.limit ?? 200, 500);
  const staleMinutes = opts.staleMinutes ?? 30;
  const since = new Date(Date.now() - staleMinutes * 60_000).toISOString();

  // Pull presence + session in one query. visitor_presence is the "live" state
  // and visitor_sessions has the static info.
  const { data: rows, error } = await sb
    .from('visitor_presence')
    .select(`
      id,
      status,
      current_page,
      updated_at,
      visitor_session_id,
      workspace_id,
      visitor_sessions!inner (
        id, visitor_id, workspace_id,
        current_page, referrer, browser, device, os,
        country, city, ip_hash,
        started_at, last_seen_at
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

  const items: VisitorIntelligenceItem[] = [];

  // Resolve linked conversation/contact in a second batched lookup.
  const sessionIds = (rows ?? []).map(r => (r.visitor_sessions as any).id).filter(Boolean);
  let convsBySession = new Map<string, { id: string; status: string | null; subject: string | null; contact_id: string | null }>();
  let contactsById = new Map<string, { id: string; name: string | null; email: string | null; avatar_url: string | null }>();

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

  for (const r of rows ?? []) {
    const session = r.visitor_sessions as any;
    const geo = await resolveVisitorGeo(config, workspaceId, {
      country: session.country,
      city: session.city,
      ip_hash: session.ip_hash,
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
      browser: session.browser,
      device: session.device,
      os: session.os,
      referrer: session.referrer,
      geo,
      contact,
      conversation: conv ? { id: conv.id, status: conv.status, subject: conv.subject } : null,
    });
  }

  return items;
}

/** Detail for a single session — same shape as a list item. */
export async function getVisitorIntelligence(
  config: ServerConfig,
  workspaceId: string,
  sessionId: string,
): Promise<VisitorIntelligenceItem | null> {
  const sb = getServiceClient(config);
  const { data: presence } = await sb
    .from('visitor_presence')
    .select(`
      id, status, current_page, updated_at, visitor_session_id, workspace_id,
      visitor_sessions!inner (
        id, visitor_id, workspace_id, current_page, referrer, browser, device, os,
        country, city, ip_hash, started_at, last_seen_at
      )
    `)
    .eq('workspace_id', workspaceId)
    .eq('visitor_session_id', sessionId)
    .maybeSingle();

  if (!presence) {
    // No presence row — fall back to session only.
    const { data: session } = await sb
      .from('visitor_sessions')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('id', sessionId)
      .maybeSingle();
    if (!session) return null;
    const geo = await resolveVisitorGeo(config, workspaceId, {
      country: session.country, city: session.city, ip_hash: session.ip_hash,
    });
    return {
      id: session.id, visitor_id: session.visitor_id, workspace_id: session.workspace_id,
      status: 'offline', current_page: session.current_page,
      last_activity_at: session.last_seen_at, started_at: session.started_at,
      browser: session.browser, device: session.device, os: session.os, referrer: session.referrer,
      geo, contact: null, conversation: null,
    };
  }

  const session = presence.visitor_sessions as any;
  const geo = await resolveVisitorGeo(config, workspaceId, {
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
    contact,
    conversation: conv ? { id: conv.id, status: conv.status, subject: conv.subject } : null,
  };
}