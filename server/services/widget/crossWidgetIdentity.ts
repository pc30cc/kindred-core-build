/**
 * Cross-widget visitor identity continuity.
 *
 * The chat widget (pre-chat form) and the call widget (pre-call form) are two
 * separate runtimes on the same page, but they must behave as ONE identity:
 *
 *   - A visitor who completed the chat pre-chat form must not be asked again
 *     by the call widget — the call starts immediately with the same contact.
 *   - A visitor who completed the pre-call form (or a callback request) must
 *     not be asked again by the chat pre-chat form.
 *
 * Both surfaces share the signed `dvsid` visitor cookie and the contact
 * continuity cookie, so this module centralizes the resolution chain:
 *
 *   1. `visitor_sessions.contact_id` for this visitor
 *   2. `contacts.metadata->>visitor_id` (row written by mergeVisitorIdentity)
 *   3. the signed continuity cookie (survives cookie partitioning / rotation)
 *
 * Whatever path resolves, the contact is re-pinned on the visitor's sessions
 * and the continuity cookie is refreshed so the next surface resolves on the
 * fastest path.
 */
import type { Request, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ServerConfig } from '../../config.js';
import { enrichVisitorSessionGeo } from '../geo/index.js';
import { getClientCountry, getClientIp, hashIp } from '../../utils/clientIp.js';
import {
  createSignedContactContinuityToken,
  persistContinuityToken,
  readContinuityCookie,
  resolveContinuityToken,
  setContinuityCookie,
} from './continuity.js';

export interface WidgetContact {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  avatar_url: string | null;
}

export type IdentitySource = 'chat_widget' | 'call_widget';

async function getContactById(
  sb: SupabaseClient,
  workspaceId: string,
  contactId: string,
): Promise<WidgetContact | null> {
  const { data } = await sb
    .from('contacts')
    .select('id, name, email, phone, avatar_url')
    .eq('workspace_id', workspaceId)
    .eq('id', contactId)
    .maybeSingle();
  return (data as WidgetContact) || null;
}

/**
 * Network identity for the CURRENT request, resolved once and reused by every
 * writer that touches `visitor_sessions`.
 *
 * `ipRaw` is already privacy-gated: it is non-null only when the workspace
 * opted in via `widget_settings.store_raw_ip`. `rawIp` (in-memory only) is
 * the un-gated address, used for geo lookup / hashing within this request and
 * never persisted directly.
 */
export interface SessionNetworkContext {
  /** sha256-derived, safe at rest. Empty string → unknown IP. */
  ipHash: string | null;
  /** Persistable raw IP (null unless store_raw_ip = true). */
  ipRaw: string | null;
  /** In-memory raw IP for geo resolution. Never persist this directly. */
  rawIp: string | null;
  /** Country code from CF-IPCountry, only when behind a trusted proxy. */
  cfCountry: string | null;
}

export async function resolveSessionNetworkContext(
  sb: SupabaseClient,
  req: Request,
  workspaceId: string,
): Promise<SessionNetworkContext> {
  const rawIp = getClientIp(req);
  const ipHash = hashIp(rawIp) || null;
  let storeRawIp = false;
  try {
    const { data } = await sb
      .from('widget_settings')
      .select('store_raw_ip')
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    storeRawIp = (data as any)?.store_raw_ip === true;
  } catch { /* fail closed: do not persist raw IP */ }
  return {
    ipHash,
    ipRaw: storeRawIp ? rawIp : null,
    rawIp,
    cfCountry: getClientCountry(req),
  };
}

/** Columns to apply on a visitor_sessions insert/update for this request. */
function networkPatch(net?: SessionNetworkContext | null): Record<string, unknown> {
  if (!net) return {};
  return {
    ...(net.ipHash ? { ip_hash: net.ipHash } : {}),
    // Always written so turning store_raw_ip off clears stale raw IPs.
    ip_raw: net.ipRaw,
  };
}

/**
 * THE single visitor-session writer shared by the chat widget, the call widget
 * and the identity bootstrap. Every surface goes through here so session
 * creation, IP hashing, raw-IP privacy and geo enrichment can never drift
 * apart (they used to: the call widget had its own copy that wrote ip_hash but
 * never enriched geo, so call-only visitors had no country/city at all).
 *
 * Pass `net` (see resolveSessionNetworkContext) so the row is created WITH its
 * network identity, and `opts.config` so the same canonical geo pipeline that
 * /api/widget/track uses runs for this visitor too.
 */
export interface EnsureSessionOptions {
  /** Required to run geo enrichment (fire-and-forget, never blocks). */
  config?: ServerConfig;
  /** Mark the visitor online so they appear in the Visitors list. */
  touchPresence?: boolean;
}

export async function ensureVisitorSessionRow(
  sb: SupabaseClient,
  workspaceId: string,
  visitorId: string,
  pageUrl: string | null,
  source: IdentitySource,
  net?: SessionNetworkContext | null,
  opts: EnsureSessionOptions = {},
): Promise<string | null> {
  let sessionId: string | null = null;
  let previousIpHash: string | null = null;
  try {
    const { data: existing } = await sb
      .from('visitor_sessions')
      .select('id, ip_hash')
      .eq('workspace_id', workspaceId)
      .eq('visitor_id', visitorId)
      .order('last_seen_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing?.id) {
      previousIpHash = ((existing as any).ip_hash as string | null) ?? null;
      await sb
        .from('visitor_sessions')
        .update({
          last_seen_at: new Date().toISOString(),
          ...(pageUrl ? { current_page: pageUrl } : {}),
          ...networkPatch(net),
        })
        .eq('id', existing.id);
      sessionId = existing.id;
    } else {
      const { data: created } = await sb
        .from('visitor_sessions')
        .insert({
          workspace_id: workspaceId,
          visitor_id: visitorId,
          current_page: pageUrl,
          metadata: { source },
          ...networkPatch(net),
        })
        .select('id')
        .maybeSingle();
      sessionId = created?.id ?? null;
    }
  } catch {
    return null;
  }
  if (!sessionId) return null;

  if (opts.touchPresence) {
    await upsertVisitorPresence(sb, workspaceId, sessionId, pageUrl);
  }

  // Same canonical geo pipeline as the chat widget's /track — shared code, not
  // a second implementation. Fire-and-forget so no widget request waits on it.
  if (opts.config && net) {
    void enrichVisitorSessionGeo(opts.config, {
      sessionId,
      workspaceId,
      ipHash: net.ipHash,
      rawIp: net.rawIp,
      country: net.cfCountry,
      previousIpHash,
    });
  }
  return sessionId;
}

/** Keep a widget visitor visible in the Online Visitors list. Best effort. */
export async function upsertVisitorPresence(
  sb: SupabaseClient,
  workspaceId: string,
  sessionId: string,
  pageUrl: string | null,
): Promise<void> {
  try {
    const { data: existingPresence } = await sb
      .from('visitor_presence')
      .select('id')
      .eq('visitor_session_id', sessionId)
      .maybeSingle();
    if (existingPresence?.id) {
      await sb.from('visitor_presence').update({
        status: 'online',
        current_page: pageUrl,
        updated_at: new Date().toISOString(),
      }).eq('id', existingPresence.id);
    } else {
      await sb.from('visitor_presence').insert({
        workspace_id: workspaceId,
        visitor_session_id: sessionId,
        status: 'online',
        current_page: pageUrl,
      });
    }
  } catch { /* best effort */ }
}

/** Pin the contact on every session of this visitor that has none yet. */
export async function pinContactOnVisitorSessions(
  sb: SupabaseClient,
  workspaceId: string,
  visitorId: string,
  contactId: string,
): Promise<void> {
  try {
    await sb
      .from('visitor_sessions')
      .update({ contact_id: contactId })
      .eq('workspace_id', workspaceId)
      .eq('visitor_id', visitorId)
      .is('contact_id', null);
  } catch { /* best effort */ }
}

/** Steps 1 + 2 of the resolution chain (no cookie involved). */
export async function findContactForVisitor(
  sb: SupabaseClient,
  workspaceId: string,
  visitorId: string,
): Promise<WidgetContact | null> {
  const { data: session } = await sb
    .from('visitor_sessions')
    .select('contact_id')
    .eq('workspace_id', workspaceId)
    .eq('visitor_id', visitorId)
    .not('contact_id', 'is', null)
    .order('last_seen_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (session?.contact_id) {
    const c = await getContactById(sb, workspaceId, session.contact_id as string);
    if (c) return c;
  }
  // Fallback: the contact row itself remembers the visitor that created it,
  // which covers the case where the pre-chat merge ran before any session
  // row existed for this visitor.
  const { data: byMeta } = await sb
    .from('contacts')
    .select('id, name, email, phone, avatar_url')
    .eq('workspace_id', workspaceId)
    .eq('metadata->>visitor_id', visitorId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (byMeta as WidgetContact) || null;
}

/** Refresh (and, first time, persist) the contact continuity cookie. */
export async function issueContinuityCookieForContact(
  sb: SupabaseClient,
  req: Request,
  res: Response,
  workspaceId: string,
  contactId: string,
  source: IdentitySource,
): Promise<void> {
  try {
    if (!readContinuityCookie(req)) {
      await persistContinuityToken(sb, {
        workspaceId,
        contactId,
        deviceInfo: {
          source,
          ua: req.headers['user-agent'] || null,
          origin: (req.headers.origin as string) || null,
        },
      });
    }
    setContinuityCookie(res, createSignedContactContinuityToken(workspaceId, contactId), req);
  } catch { /* best effort */ }
}

/** Step 3: restore the contact from the continuity cookie and re-link it. */
export async function restoreContactFromContinuity(
  sb: SupabaseClient,
  req: Request,
  workspaceId: string,
  visitorId: string,
  source: IdentitySource,
): Promise<WidgetContact | null> {
  const token = readContinuityCookie(req);
  if (!token) return null;
  try {
    const restored = await resolveContinuityToken(sb, workspaceId, token);
    if (!restored.valid || !restored.contactId) return null;
    await sb.rpc('merge_visitor_into_contact', {
      _workspace_id: workspaceId,
      _visitor_id: visitorId,
      _contact_id: restored.contactId,
      _method: 'token',
      _metadata: { source: `${source}_continuity` },
    });
    return await getContactById(sb, workspaceId, restored.contactId);
  } catch {
    return null;
  }
}

/**
 * Full resolution chain used by both widgets' bootstrap paths. Returns the
 * known contact (or null) and leaves the visitor session + continuity cookie
 * consistent so the *other* widget resolves the same identity instantly.
 */
export async function resolveKnownContact(
  sb: SupabaseClient,
  req: Request,
  res: Response,
  workspaceId: string,
  visitorId: string,
  source: IdentitySource,
): Promise<WidgetContact | null> {
  const contact =
    (await findContactForVisitor(sb, workspaceId, visitorId)) ||
    (await restoreContactFromContinuity(sb, req, workspaceId, visitorId, source));
  if (!contact) return null;
  await pinContactOnVisitorSessions(sb, workspaceId, visitorId, contact.id);
  await issueContinuityCookieForContact(sb, req, res, workspaceId, contact.id, source);
  return contact;
}