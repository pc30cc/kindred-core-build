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
import { resolveVisitorGeo, type GeoResult } from '../geo/index.js';
import { checkEntitlementFromDB } from '../../middleware/featureGating.js';

/**
 * Plan gate for IP exposure. The `contact_ip_visibility` capability governs
 * every IP surface in the product (contacts *and* visitors). When the plan
 * does not include it, no IP value — raw or masked — ever leaves the server.
 */
async function isIpVisibilityEntitled(config: ServerConfig, workspaceId: string): Promise<boolean> {
  try {
    const r = await checkEntitlementFromDB(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      workspaceId,
      'contact_ip_visibility',
    );
    return r.allowed === true;
  } catch {
    return false;
  }
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
  ip_locked: boolean;            // true when the plan does not include IP visibility

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
  // Pull the configured stale window from platform settings so the
  // Visitors page can be tuned without redeploying. Falls back to 30 min.
  let staleMs = (opts.staleMinutes ?? 30) * 60_000;
  try {
    const { getMapGeoSettings } = await import('../geo/settings.js');
    const s = await getMapGeoSettings(config);
    if ((s as any).presence?.stale_after_ms) {
      staleMs = Math.max(15_000, (s as any).presence.stale_after_ms);
    }
  } catch { /* keep default */ }
  const since = new Date(Date.now() - staleMs).toISOString();
  const ipEntitled = await isIpVisibilityEntitled(config, workspaceId);
  const canViewRaw = ipEntitled && isAdminRole(opts.viewerRole ?? null);

  const { data: rows, error } = await sb
    .from('visitor_presence')
    .select(`
      id, status, current_page, updated_at, visitor_session_id, workspace_id,
      visitor_sessions!inner (
        id, visitor_id, workspace_id, contact_id, current_page, referrer, browser, device, os,
        country, city, ip_hash, ip_raw, started_at, last_seen_at
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

  // Collect contact ids that are pinned directly on each visitor_session
  // (this is the canonical link populated by prechat / continuity-token /
  // identity-merge flows — *every* visitor that has typed their name or
  // matched an existing contact has it set here, even before a conversation
  // is created). Looking these up first guarantees the Visitors list shows
  // a real name for those sessions rather than "Unknown visitor".
  const sessionContactIds = (rows ?? [])
    .map(r => (r.visitor_sessions as any).contact_id)
    .filter(Boolean) as string[];

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
    // Union of contact ids from sessions + their conversations.
    const contactIds = Array.from(new Set([
      ...sessionContactIds,
      ...[...convsBySession.values()].map(c => c.contact_id).filter(Boolean) as string[],
    ]));
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
    const geo = await resolveVisitorGeo(config, workspaceId, {
      country: session.country, city: session.city, ip_hash: session.ip_hash,
    });
    const conv = convsBySession.get(session.id) ?? null;
    // Prefer the session-pinned contact (set the moment the visitor identified
    // via prechat or matched an existing contact). Fall back to the contact
    // attached to the most recent conversation. This guarantees identified
    // visitors show their real name in the list — without merging two
    // separate visitors that happen to share an IP, because the lookup
    // is keyed on the session row, not the IP.
    const contactId = session.contact_id ?? conv?.contact_id ?? null;
    const contact = contactId ? contactsById.get(contactId) ?? null : null;
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
      ip_display: !ipEntitled ? '' : (canViewRaw && (session as any).ip_raw ? (session as any).ip_raw : buildIpDisplay(session.ip_hash)),
      ip_raw: canViewRaw ? ((session as any).ip_raw ?? null) : null,
      can_view_raw_ip: canViewRaw,
      ip_locked: !ipEntitled,
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
  const ipEntitled = await isIpVisibilityEntitled(config, workspaceId);
  const canViewRaw = ipEntitled && isAdminRole(opts.viewerRole ?? null);

  const { data: presence } = await sb
    .from('visitor_presence')
    .select(`
      id, status, current_page, updated_at, visitor_session_id, workspace_id,
      visitor_sessions!inner (
        id, visitor_id, workspace_id, contact_id, current_page, referrer, browser, device, os,
        country, city, ip_hash, ip_raw, started_at, last_seen_at
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
    const geo = await resolveVisitorGeo(config, workspaceId, {
      country: session.country, city: session.city, ip_hash: session.ip_hash,
    });
    // Resolve the session-pinned contact even when the visitor is offline
    // (no presence row) so the detail panel still shows their name.
    let offlineContact: VisitorIntelligenceItem['contact'] = null;
    if ((session as any).contact_id) {
      const { data: c } = await sb
        .from('contacts')
        .select('id, name, email, avatar_url')
        .eq('id', (session as any).contact_id)
        .maybeSingle();
      if (c) offlineContact = c;
    }
    return {
      id: session.id, visitor_id: session.visitor_id, workspace_id: session.workspace_id,
      status: 'offline', current_page: session.current_page,
      last_activity_at: session.last_seen_at, started_at: session.started_at,
      browser: session.browser, device: session.device, os: session.os, referrer: session.referrer,
      geo,
      ip_display: !ipEntitled ? '' : (canViewRaw && (session as any).ip_raw ? (session as any).ip_raw : buildIpDisplay(session.ip_hash)),
      ip_raw: canViewRaw ? ((session as any).ip_raw ?? null) : null,
      can_view_raw_ip: canViewRaw,
      ip_locked: !ipEntitled,
      contact: offlineContact, conversation: null,
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
  // Same precedence rule as the list query: session.contact_id wins, then
  // fall back to the most recent conversation's contact_id.
  const resolvedContactId = (session.contact_id as string | null) ?? conv?.contact_id ?? null;
  if (resolvedContactId) {
    const { data: c } = await sb
      .from('contacts')
      .select('id, name, email, avatar_url')
      .eq('id', resolvedContactId)
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
    ip_display: !ipEntitled ? '' : (canViewRaw && (session as any).ip_raw ? (session as any).ip_raw : buildIpDisplay(session.ip_hash)),
    ip_raw: canViewRaw ? ((session as any).ip_raw ?? null) : null,
    can_view_raw_ip: canViewRaw,
    ip_locked: !ipEntitled,
    contact,
    conversation: conv ? { id: conv.id, status: conv.status, subject: conv.subject } : null,
  };
}
