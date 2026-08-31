/**
 * Call Center — public visitor-facing routes for the standalone call widget.
 * Mounted at /api/call-widget/*. CORS is dynamic per workspace allowed_domains.
 * No service tokens leak to visitors. Visitors get short-lived HMAC sessions.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import {
  findWorkspaceByPublicKey,
  getOrCreateWorkspaceSettings,
  getPlatformCallCenterSettings,
  computeEffectiveCallCenterCaps,
  computeEffectiveCallCenterLocales,
  originAllowed,
  type WorkspaceCallCenterSettings,
} from '../services/callCenter/settings.js';
import { signWidgetSession, verifyWidgetSession } from '../services/callCenter/widgetSession.js';
import { resolveEffectiveCallProvider } from '../services/calls/providerResolver.js';
import { loadEffectiveCallEntitlements } from '../services/calls/entitlementComposer.js';
import {
  checkPlanConcurrencyCeiling,
  planConcurrencyDenialBody,
} from '../services/calls/concurrencyLimit.js';
import {
  checkPlanMonthlyMinutesCeiling,
  planMinutesDenialBody,
} from '../services/calls/monthlyMinutesLimit.js';
import { publishQueueEvent, publishCallEvent } from '../services/callCenter/realtime.js';
import { buildClientConnectInfo } from '../services/callCenter/connectInfo.js';
import { computeRecordingCapability } from '../services/callCenter/recording.js';
import { routeIncomingCall } from '../services/callCenter/routing.js';
import { resolveGlobalStorageConfig, getFileUrlWithConfig } from '../services/storage/index.js';
import {
  resolveVisitorIdentity,
  readVisitorCookie,
  isSecureRequest,
} from '../services/widget/visitorIdentity.js';
import { mergeVisitorIdentity } from '../services/widget/identityMerge.js';
import {
  findContactForVisitor,
  resolveSessionNetworkContext,
  ensureVisitorSessionRow as ensureSharedVisitorSessionRow,
} from '../services/widget/crossWidgetIdentity.js';
import type { Request as ExpressRequest } from 'express';
import {
  createSignedContactContinuityToken,
  persistContinuityToken,
  readContinuityCookie,
  resolveContinuityToken,
  setContinuityCookie,
} from '../services/widget/continuity.js';
import { getClientIp, hashIp, getClientCountry } from '../utils/clientIp.js';
import { getWidgetAssetName, getOptionalWidgetAssetName } from '../services/widget/manifest.js';
import { resolveWidgetAssetBase, getLoaderAssetBase } from '../services/widget/public.js';
import { widgetTemplateAssetKeys, resolveWidgetTemplateId } from '../services/widget/presentationAssets.js';
import crypto from 'crypto';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const callWidgetRouter = Router();

// Compute a deterministic version token for /call-widget/runtime.{js,css}
// so the loader can append `?v=<token>` and bypass any stale browser /
// CDN cache. Computed at startup from the file contents (md5 hash), with
// a graceful fallback to the server start timestamp when the files are
// not reachable from this process (e.g. when nginx is the only thing
// serving them in production split deployments). Re-computing on every
// request is unnecessary — the loader itself is no-store so a process
// restart on deploy is enough to roll the token.
const CALL_WIDGET_ASSETS_VERSION: string = (() => {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(here, '..', '..', 'public', 'call-widget'),
      path.resolve(here, '..', 'public', 'call-widget'),
      path.resolve(process.cwd(), 'public', 'call-widget'),
    ];
    for (const dir of candidates) {
      const js = path.join(dir, 'runtime.js');
      const css = path.join(dir, 'runtime.css');
      if (existsSync(js) && existsSync(css)) {
        const h = crypto.createHash('md5');
        h.update(readFileSync(js));
        h.update(readFileSync(css));
        return h.digest('hex').slice(0, 12);
      }
    }
  } catch {/* fall through */}
  return String(Date.now()).slice(-12);
})();

// Dynamic CORS per workspace allowed_domains
callWidgetRouter.use(async (req, res, next) => {
  const origin = req.headers.origin as string | undefined;
  if (origin) {
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-cc-session, x-cc-active-call');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

function getOrigin(req: any): string | null {
  return (req.headers.origin as string) || null;
}

/**
 * Look up the contact currently linked to a visitor cookie (if any).
 * Returns null when there is no visitor session row or no linked contact.
 */
async function findLinkedContactForVisitor(
  config: ServerConfig,
  workspaceId: string,
  visitorId: string,
): Promise<{ id: string; name: string | null; email: string | null; phone: string | null; avatar_url: string | null } | null> {
  // Shared chain with the chat widget: visitor_sessions.contact_id first,
  // then contacts.metadata->>visitor_id (covers a pre-chat merge that ran
  // before this visitor had a session row).
  const sb = getServiceClient(config);
  return await findContactForVisitor(sb, workspaceId, visitorId);
}

async function findContactById(
  config: ServerConfig,
  contactId: string,
): Promise<{ id: string; name: string | null; email: string | null; phone: string | null; avatar_url: string | null } | null> {
  const sb = getServiceClient(config);
  const { data: contact } = await sb
    .from('contacts')
    .select('id, name, email, phone, avatar_url')
    .eq('id', contactId)
    .maybeSingle();
  return contact || null;
}

async function issueContinuityCookieForContact(
  req: any,
  res: any,
  config: ServerConfig,
  workspaceId: string,
  contactId: string,
): Promise<void> {
  const existingCookie = readContinuityCookie(req);
  if (!existingCookie) {
    const sb = getServiceClient(config);
    await persistContinuityToken(sb, {
      workspaceId,
      contactId,
      deviceInfo: {
        source: 'call_widget',
        ua: req.headers['user-agent'] || null,
        origin: getOrigin(req),
      },
    });
  }
  // Always refresh a signed, DB-independent continuity cookie last so it is
  // the browser's stored value. This prevents the call widget from asking for
  // contact details again after refresh even if the DB token table is missing
  // or the anonymous visitor cookie was partitioned/rotated.
  setContinuityCookie(res, createSignedContactContinuityToken(workspaceId, contactId), req);
}

async function restoreContactFromContinuityCookie(
  req: any,
  config: ServerConfig,
  workspaceId: string,
  visitorId: string,
): Promise<{ id: string; name: string | null; email: string | null; phone: string | null; avatar_url: string | null } | null> {
  const token = readContinuityCookie(req);
  if (!token) return null;
  const sb = getServiceClient(config);
  const restored = await resolveContinuityToken(sb, workspaceId, token);
  if (!restored.valid || !restored.contactId) return null;
  await sb.rpc('merge_visitor_into_contact', {
    _workspace_id: workspaceId,
    _visitor_id: visitorId,
    _contact_id: restored.contactId,
    _method: 'token',
    _metadata: { source: 'call_widget_continuity' },
  });
  return findContactById(config, restored.contactId);
}

/**
 * Thin adapter over the SHARED writer in services/widget/crossWidgetIdentity.
 *
 * The call widget used to carry its own copy of this logic; it wrote ip_hash /
 * ip_raw but never ran geo enrichment, so a visitor who only ever opened the
 * call widget had no country/city/timezone anywhere in the product. There is
 * now exactly one implementation, and the call widget gets the identical
 * network pipeline as the chat widget.
 *
 * Returns the canonical `visitor_sessions.id` so calls, queue entries and
 * callbacks can be linked to the exact session.
 */
async function ensureVisitorSessionRow(
  config: ServerConfig,
  workspaceId: string,
  visitorId: string,
  origin: string | null,
  pageUrl: string | null,
  req?: ExpressRequest,
): Promise<string | null> {
  const sb = getServiceClient(config);
  const net = req ? await resolveSessionNetworkContext(sb, req, workspaceId) : null;
  return ensureSharedVisitorSessionRow(
    sb,
    workspaceId,
    visitorId,
    pageUrl || origin || null,
    'call_widget',
    net,
    { config, touchPresence: true },
  );
}

/**
 * Identify the visitor for a call/callback request:
 *   1. Resolve dvsid cookie → visitor_id
 *   2. Look up any contact already linked to that visitor
 *   3. If submitted name/email/phone OR a previously linked contact exists,
 *      run mergeVisitorIdentity to create/update the contact and pin it on
 *      visitor_sessions (so the visitors panel shows the contact name).
 */
async function identifyVisitorForCall(
  req: any,
  res: any,
  config: ServerConfig,
  workspaceId: string,
  origin: string | null,
  submitted: { name?: string | null; email?: string | null; phone?: string | null; page_url?: string | null },
): Promise<{
  visitorId: string;
  /** Canonical visitor_sessions.id — the relation calls/callbacks must store. */
  visitorSessionId: string | null;
  contactId: string | null;
  contact: { id: string; name: string | null; email: string | null; phone: string | null } | null;
}> {
  const { visitorId } = resolveVisitorIdentity(req, res, workspaceId);
  const visitorSessionId = await ensureVisitorSessionRow(
    config, workspaceId, visitorId, origin, submitted.page_url ?? null, req as unknown as ExpressRequest,
  );
  const existing =
    await findLinkedContactForVisitor(config, workspaceId, visitorId) ||
    await restoreContactFromContinuityCookie(req, config, workspaceId, visitorId);

  const hasSubmittedIdentity = !!(submitted.name || submitted.email || submitted.phone);
  if (!hasSubmittedIdentity && !existing) {
    return { visitorId, visitorSessionId, contactId: null, contact: null };
  }

  // If only existing contact (no new submission), nothing new to merge — but
  // make sure the session is pinned to the contact (mergeVisitorIdentity is
  // idempotent and re-pins on every call).
  const sb = getServiceClient(config);
  try {
    const merge = await mergeVisitorIdentity(config, sb, {
      workspaceId,
      visitorId,
      identity: {
        name: submitted.name ?? existing?.name ?? null,
        email: submitted.email ?? existing?.email ?? null,
        phone: submitted.phone ?? existing?.phone ?? null,
      },
      method: 'prechat',
      // Canonical resolver — no ad-hoc header parsing (spoofable).
      ipAddress: getClientIp(req as unknown as ExpressRequest),
      cfCountry: getClientCountry(req),
    });
    const { data: contact } = await sb
      .from('contacts')
      .select('id, name, email, phone')
      .eq('id', merge.contactId)
      .maybeSingle();
    await issueContinuityCookieForContact(req, res, config, workspaceId, merge.contactId);
    return { visitorId, visitorSessionId, contactId: merge.contactId, contact: contact || null };
  } catch (e: any) {
    console.warn('[call-widget] identifyVisitorForCall merge failed:', e?.message || e);
    return {
      visitorId,
      visitorSessionId,
      contactId: existing?.id || null,
      contact: existing ? { id: existing.id, name: existing.name, email: existing.email, phone: existing.phone } : null,
    };
  }
}

/**
 * Strict widget-session guard for sensitive routes.
 *
 *   - 401 invalid_session     — token missing / forged / expired
 *   - 403 origin_mismatch     — request Origin header missing or differs from session.origin
 *
 * CORS headers are not enough: a stolen session token replayed from another
 * origin (server-to-server, curl, malicious page) would otherwise pass.
 */
function requireWidgetSession(req: any, config: ServerConfig) {
  const session = getSession(req, config);
  if (!session) return { ok: false as const, status: 401, error: 'invalid_session' };
  const reqOrigin = getOrigin(req);
  if (session.origin) {
    if (!reqOrigin) return { ok: false as const, status: 403, error: 'origin_mismatch' };
    if (session.origin !== reqOrigin) return { ok: false as const, status: 403, error: 'origin_mismatch' };
  }
  return { ok: true as const, session };
}

async function resolveWorkspace(
  config: ServerConfig,
  query: { workspaceId?: string; publicKey?: string },
): Promise<WorkspaceCallCenterSettings | null> {
  if (query.publicKey) {
    return findWorkspaceByPublicKey(config, query.publicKey);
  }
  if (query.workspaceId) {
    return getOrCreateWorkspaceSettings(config, query.workspaceId);
  }
  return null;
}

function disabledResponse(reason: string, message?: Record<string, unknown>) {
  return { status: 'disabled', reason, message: message || null };
}

const ACTIVE_CALL_COOKIE_NAME = 'dvccall';
const ACTIVE_CALL_TTL_SECONDS = 60 * 60 * 6; // enough for refresh/navigation; DB state remains authoritative
const ACTIVE_CALL_STATES = ['pending', 'queued', 'ringing', 'connecting', 'active'];
const TERMINAL_CALL_STATES = ['cancelled', 'ended', 'missed', 'failed'];

function activeCallCookieSecret(config: ServerConfig): string {
  return `call-widget-active:${(config as any).widgetTokenSecret || (config as any).sessionSecret || config.supabaseServiceRoleKey}`;
}

function signActiveCallCookie(config: ServerConfig, body: string): string {
  return crypto.createHmac('sha256', activeCallCookieSecret(config)).update(body).digest('base64url');
}

function encodeActiveCallCookie(config: ServerConfig, payload: { c: string; w: string; o: string | null; iat: number; exp: number }): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${signActiveCallCookie(config, body)}`;
}

function readActiveCallCookie(config: ServerConfig, req: any, workspaceId: string, origin: string | null): { callId: string } | null {
  const raw = (req as any).cookies?.[ACTIVE_CALL_COOKIE_NAME] as string | undefined;
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot < 1) return null;
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = signActiveCallCookie(config, body);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { c?: string; w?: string; o?: string | null; exp?: number };
    if (!payload.c || payload.w !== workspaceId || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (payload.o && origin && payload.o !== origin) return null;
    return { callId: payload.c };
  } catch { return null; }
}

function setActiveCallCookie(res: any, req: any, config: ServerConfig, workspaceId: string, callId: string, origin: string | null): void {
  const now = Math.floor(Date.now() / 1000);
  const value = encodeActiveCallCookie(config, { c: callId, w: workspaceId, o: origin || null, iat: now, exp: now + ACTIVE_CALL_TTL_SECONDS });
  const secure = isSecureRequest(req);
  const attrs = [
    `${ACTIVE_CALL_COOKIE_NAME}=${value}`,
    'Path=/api',
    'HttpOnly',
    `Max-Age=${ACTIVE_CALL_TTL_SECONDS}`,
    `SameSite=${secure ? 'None' : 'Lax'}`,
  ];
  if (secure) attrs.push('Secure', 'Partitioned');
  res.append('Set-Cookie', attrs.join('; '));
}

function clearActiveCallCookie(res: any, req: any): void {
  const secure = isSecureRequest(req);
  const attrs = [
    `${ACTIVE_CALL_COOKIE_NAME}=`,
    'Path=/api',
    'HttpOnly',
    'Max-Age=0',
    `SameSite=${secure ? 'None' : 'Lax'}`,
  ];
  if (secure) attrs.push('Secure', 'Partitioned');
  res.append('Set-Cookie', attrs.join('; '));
}

async function buildActiveCallPayload(
  config: ServerConfig,
  req: any,
  res: any,
  ws: WorkspaceCallCenterSettings,
  origin: string | null,
  visitorId: string | null,
): Promise<{ call_id: string; state: string; call_type: string; created_at: string | null; queue_position: number | null; session: string } | null> {
  const sbActive = getServiceClient(config);
  let mine: any = null;
  const headerSession = verifyWidgetSession(config, String(req.headers['x-cc-active-call'] || ''));
  const headerCallId = headerSession && headerSession.workspace_id === ws.workspace_id && headerSession.call_id && (!headerSession.origin || !origin || headerSession.origin === origin)
    ? String(headerSession.call_id)
    : null;
  const cookieCall = readActiveCallCookie(config, req, ws.workspace_id, origin);
  const preferredCallIds = [headerCallId, cookieCall?.callId].filter(Boolean) as string[];
  for (const preferredCallId of preferredCallIds) {
    const { data } = await sbActive
      .from('call_sessions')
      .select('id,state,call_type,created_at,metadata')
      .eq('workspace_id', ws.workspace_id)
      .eq('entry_source', 'call_widget')
      .eq('id', preferredCallId)
      .maybeSingle();
    if (data && ACTIVE_CALL_STATES.includes(String((data as any).state || ''))) {
      mine = data;
      break;
    } else if (data && TERMINAL_CALL_STATES.includes(String((data as any).state || ''))) {
      clearActiveCallCookie(res, req);
    }
  }
  if (!mine && visitorId) {
    const { data: rows } = await sbActive
      .from('call_sessions')
      .select('id,state,call_type,created_at,metadata')
      .eq('workspace_id', ws.workspace_id)
      .eq('entry_source', 'call_widget')
      .in('state', ACTIVE_CALL_STATES)
      .order('created_at', { ascending: false })
      .limit(50);
    mine = (rows || []).find((r: any) => (r.metadata as any)?.visitor_id === visitorId) || null;
  }
  if (!mine) return null;

  const callId = String(mine.id);
  const callState = String(mine.state || 'pending');
  let position: number | null = null;
  if (!['active', 'ringing', 'connecting'].includes(callState)) {
    const { data: entry } = await sbActive
      .from('call_queue_entries')
      .select('id,workspace_id,state')
      .eq('call_session_id', callId)
      .maybeSingle();
    if (entry && ['queued', 'offered'].includes(String((entry as any).state || ''))) {
      const { data: activeRows } = await sbActive
        .from('call_queue_entries')
        .select('id,created_at,priority')
        .eq('workspace_id', (entry as any).workspace_id)
        .eq('entry_source', 'call_widget')
        .in('state', ['queued', 'offered'])
        .order('priority', { ascending: false })
        .order('created_at', { ascending: true })
        .limit(500);
      const idx = (activeRows || []).findIndex((row: any) => row.id === (entry as any).id);
      position = idx >= 0 ? idx + 1 : null;
    }
  }

  const resumedSession = signWidgetSession(config, {
    workspace_id: ws.workspace_id,
    public_key: ws.public_key,
    call_id: callId,
    visitor_id: visitorId,
    origin,
  });
  setActiveCallCookie(res, req, config, ws.workspace_id, callId, origin);
  return {
    call_id: callId,
    state: callState,
    call_type: String(mine.call_type || 'audio'),
    created_at: mine.created_at || null,
    queue_position: position,
    session: resumedSession,
  };
}

// ── Bootstrap ─────────────────────────────────────────────────────────────
callWidgetRouter.get('/bootstrap', async (req, res) => {
  const config = (req as any).serverConfig as ServerConfig;
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store');
  const ws = await resolveWorkspace(config, {
    workspaceId: req.query.workspaceId ? String(req.query.workspaceId) : undefined,
    publicKey: req.query.publicKey ? String(req.query.publicKey) : undefined,
  });
  if (!ws) return res.status(404).json({ error: 'workspace_not_found' });
  const platform = await getPlatformCallCenterSettings(config);
  if (!platform.call_center_enabled) {
    return res.json(disabledResponse('call_center_disabled', platform.disabled_message));
  }
  if (!ws.enabled) {
    return res.json(disabledResponse('workspace_disabled'));
  }
  const origin = getOrigin(req);
  if (!originAllowed(ws, origin)) {
    return res.status(403).json({ status: 'error', reason: 'origin_denied' });
  }
  const effective = computeEffectiveCallCenterCaps(platform, ws);
  // Provider readiness check (don't block bootstrap; reflect in payload)
  let provider_ready = false;
  try {
    await resolveEffectiveCallProvider(config, ws.workspace_id);
    provider_ready = true;
  } catch {/* not configured */}
  const recording = await computeRecordingCapability(config, ws.workspace_id, platform, ws);
  // Visible departments per channel — gated. Visitors only see department
  // options when the platform allows departments AND the workspace has both
  // departments_enabled and allow_visitor_department_choice turned on.
  // Server-side default_department_id fallback in /calls/request and
  // /callbacks/request still applies when this gate is closed.
  const departmentChoiceAllowed =
    !!(platform as any).departments_enabled &&
    !!(ws as any).departments_enabled &&
    !!(ws as any).allow_visitor_department_choice;
  let departments: {
    voice: Array<{ id: string; name: string; sort_order: number }>;
    video: Array<{ id: string; name: string; sort_order: number }>;
    callback: Array<{ id: string; name: string; sort_order: number }>;
  } = { voice: [], video: [], callback: [] };
  if (departmentChoiceAllowed) {
    const sbBoot = getServiceClient(config);
    const { data: deptRows } = await sbBoot
      .from('workspace_departments')
      .select('id, name, sort_order, cc_voice_enabled, cc_video_enabled, cc_callback_enabled')
      .eq('workspace_id', ws.workspace_id)
      .or('cc_voice_enabled.eq.true,cc_video_enabled.eq.true,cc_callback_enabled.eq.true')
      .order('sort_order', { ascending: true });
    const safeDept = (r: any) => ({ id: r.id, name: r.name, sort_order: r.sort_order ?? 0 });
    departments = {
      voice: (deptRows || []).filter((r: any) => r.cc_voice_enabled).map(safeDept),
      video: (deptRows || []).filter((r: any) => r.cc_video_enabled).map(safeDept),
      callback: (deptRows || []).filter((r: any) => r.cc_callback_enabled).map(safeDept),
    };
  }
  const session = signWidgetSession(config, {
    workspace_id: ws.workspace_id,
    public_key: ws.public_key,
    origin,
  });
  // Resolve / create dvsid visitor cookie so the same identity is shared
  // with the chat widget and the visitors panel. Look up any contact
  // previously linked to this visitor so the widget can pre-fill the
  // pre-call form and (when complete) skip it entirely on return visits.
  let visitorBlock: { id: string; contact: { id: string; name: string | null; email: string | null; phone: string | null } | null } | null = null;
  let resolvedVisitorId: string | null = null;
  try {
    const { visitorId } = resolveVisitorIdentity(req, res, ws.workspace_id);
    resolvedVisitorId = visitorId;
    // Make the call-widget visitor show up in the Online Visitors list as
    // soon as the widget loads — with their real contact name if known.
    await ensureVisitorSessionRow(config, ws.workspace_id, visitorId, origin, origin, req as unknown as ExpressRequest);
    const contact =
      await findLinkedContactForVisitor(config, ws.workspace_id, visitorId) ||
      await restoreContactFromContinuityCookie(req, config, ws.workspace_id, visitorId);
    if (contact) {
      // Re-pin contact_id on every refresh (cheap, idempotent) so a returning
      // identified visitor is never shown as Anonymous.
      const sbPin = getServiceClient(config);
      await sbPin
        .from('visitor_sessions')
        .update({ contact_id: contact.id })
        .eq('workspace_id', ws.workspace_id)
        .eq('visitor_id', visitorId)
        .is('contact_id', null);
      await issueContinuityCookieForContact(req, res, config, ws.workspace_id, contact.id);
    }
    visitorBlock = {
      id: visitorId,
      contact: contact
        ? { id: contact.id, name: contact.name, email: contact.email, phone: contact.phone }
        : null,
    };
  } catch (e: any) {
    console.warn('[call-widget/bootstrap] visitor resolve failed:', e?.message || e);
  }
  // Resume in-flight call across page refresh / navigation.
  // Look up any non-terminal call_session for this visitor and, if found,
  // hand the widget a session token bound to that call_id so it can keep
  // polling status without creating a new queue entry.
  let activeCall: {
    call_id: string;
    state: string;
    call_type: string;
    created_at: string | null;
    queue_position: number | null;
    session: string;
  } | null = null;
  try {
    activeCall = await buildActiveCallPayload(config, req, res, ws, origin, resolvedVisitorId);
  } catch (e: any) {
    console.warn('[call-widget/bootstrap] active_call lookup failed:', e?.message || e);
  }
  const ringbackAudio = await (async () => {
    const musicPath = (platform as any).ringback_music_path as string | null;
    const announcementPath = (platform as any).ringback_announcement_audio_path as string | null;
    const queuePaths = ((platform as any).ringback_queue_audio_paths || {}) as Record<string, string>;
    if (!musicPath && !announcementPath && Object.keys(queuePaths).length === 0) {
      return { music_url: platform.ringback_music_url, announcement_url: null, queue_urls: {} };
    }
    const storage = await resolveGlobalStorageConfig(config).catch(() => null);
    const urlFor = (p?: string | null) => (storage && p ? getFileUrlWithConfig(storage, p) : null);
    const queueUrls: Record<string, string> = {};
    for (const [pos, p] of Object.entries(queuePaths)) {
      const u = urlFor(p);
      if (u) queueUrls[pos] = u;
    }
    return {
      music_url: urlFor(musicPath) || platform.ringback_music_url,
      announcement_url: urlFor(announcementPath),
      queue_urls: queueUrls,
    };
  })();
  // Shared, hashed font asset. The call widget does NOT hard-code a font
  // path: it consumes the same immutable descriptor asset the chat widget
  // resolves, so the bytes exist exactly once and are cached once.
  const fontAssetUrl = (() => {
    try {
      const key = widgetTemplateAssetKeys(resolveWidgetTemplateId(null)).fonts;
      const name = getWidgetAssetName(key);
      const base = resolveWidgetAssetBase({
        widgetBaseUrl: null,
        widgetLoaderBaseUrl: null,
        widgetPublicBaseUrl: null,
        assetBaseUrl: null,
        loaderAssetBase: getLoaderAssetBase(req as any),
      });
      // Relative when no explicit asset base is configured — the runtime
      // resolves it against its own origin, exactly like its other assets.
      return base ? `${base}/widget/${name}` : `/widget/${name}`;
    } catch { return null; }
  })();
  res.json({
    status: 'ok',
    session,
    assets_version: CALL_WIDGET_ASSETS_VERSION,
    assets: { font_style_url: fontAssetUrl },
    workspace_id: ws.workspace_id,
    visitor: visitorBlock,
    config: {
      display_name: ws.display_name,
      avatar_url: ws.avatar_url,
      widget_position: ws.widget_position,
      widget_theme: ws.widget_theme,
      pre_call_form_enabled: ws.pre_call_form_enabled,
      pre_call_form_schema: ws.pre_call_form_schema,
      offline_behavior: ws.offline_behavior,
      recording_consent_required: ws.recording_consent_required,
      custom_texts: ws.widget_custom_texts || {},
    },
    capabilities: {
      voice: effective.voice_enabled,
      video: effective.video_enabled,
      callback: effective.callback_enabled,
      recording: effective.recording_enabled,
      operator_video_visible: ws.operator_video_visible_to_visitor !== false,
    },
    callback_policy: {
      enabled: effective.callback_enabled,
      show_when_online: platform.callback_show_when_online,
      cooldown_seconds: platform.callback_min_seconds_between_requests,
      require_contact: platform.callback_require_contact,
      min_message_length: platform.callback_min_message_length,
      honeypot_enabled: platform.callback_honeypot_enabled,
      min_form_seconds: platform.callback_min_form_seconds,
    },
    queue_experience: {
      ringback_enabled: platform.ringback_enabled,
      ringback_mode: platform.ringback_mode,
      ringback_music_url: ringbackAudio.music_url,
      ringback_announcement_audio_url: ringbackAudio.announcement_url,
      ringback_queue_audio_urls: ringbackAudio.queue_urls,
      show_position: platform.queue_show_position,
      show_eta: platform.queue_show_eta,
      eta_seconds_per_position: platform.queue_eta_seconds_per_position,
      offer_callback_after_seconds: platform.queue_offer_callback_after_seconds,
    },
    i18n: (() => {
      const eff = computeEffectiveCallCenterLocales(platform, ws);
      return {
        default_locale: eff.default_locale,
        available_locales: eff.available,
      };
    })(),
    recording,
    provider_ready,
    departments,
    active_call: activeCall,
  });
});

// Helper: extract widget session
function getSession(req: any, config: ServerConfig) {
  const tok = (req.headers['x-cc-session'] as string) || '';
  return verifyWidgetSession(config, tok);
}

// ── Request a call ────────────────────────────────────────────────────────
const requestSchema = z.object({
  call_type: z.enum(['voice', 'video']),
  visitor_name: z.string().max(120).optional().nullable(),
  visitor_email: z.string().email().max(200).optional().nullable(),
  visitor_phone: z.string().max(40).optional().nullable(),
  subject: z.string().max(500).optional().nullable(),
  page_url: z.string().max(2000).optional().nullable(),
  page_title: z.string().max(500).optional().nullable(),
  consent_recording: z.boolean().optional(),
  recording_consent: z.boolean().optional(),
  recording_consent_at: z.string().datetime().optional().nullable(),
  recording_notice_version: z.string().max(40).optional().nullable(),
  form_data: z.record(z.unknown()).optional(),
  department_id: z.string().uuid().optional().nullable(),
});

callWidgetRouter.post('/calls/request', async (req, res) => {
  const config = (req as any).serverConfig as ServerConfig;
  const guard = requireWidgetSession(req, config);
  if (!guard.ok) return res.status(guard.status).json({ error: guard.error });
  const session = guard.session;
  const ws = await getOrCreateWorkspaceSettings(config, session.workspace_id);
  const platform = await getPlatformCallCenterSettings(config);
  if (!platform.call_center_enabled) return res.status(403).json({ error: 'call_center_disabled' });
  if (!ws.enabled) return res.status(403).json({ error: 'workspace_disabled' });
  const effective = computeEffectiveCallCenterCaps(platform, ws);
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
  if (parsed.data.call_type === 'voice' && !effective.voice_enabled) return res.status(403).json({ error: 'feature_not_available' });
  if (parsed.data.call_type === 'video' && !effective.video_enabled) return res.status(403).json({ error: 'feature_not_available' });
  // Plan composer gate (deny-on-create / visitor-initiated).
  // Reuses canonical loadEffectiveCallEntitlements — does NOT introduce a
  // second composer or numeric limit. Runs BEFORE any DB insert / provider
  // resolution so we never strand half-created call objects on denial.
  try {
    const eff = await loadEffectiveCallEntitlements(config, ws.workspace_id);
    const visitorAllowed = parsed.data.call_type === 'voice'
      ? eff.visitor_voice_enabled
      : eff.visitor_video_enabled;
    if (!visitorAllowed) {
      return res.status(403).json({
        error: 'plan_forbidden',
        capability: parsed.data.call_type === 'voice' ? 'voice' : 'video',
        upgrade_required: true,
      });
    }
  } catch {
    return res.status(403).json({ error: 'plan_forbidden', capability: 'voice_video', upgrade_required: true });
  }
  if (!originAllowed(ws, getOrigin(req))) return res.status(403).json({ error: 'origin_denied' });
  // Validate optional visitor-selected department against canonical schema.
  const dbCallTypeForDept = parsed.data.call_type === 'voice' ? 'audio' : 'video';
  let chosenDepartmentId: string | null = parsed.data.department_id || null;
  {
    const sbDept = getServiceClient(config);
    if (chosenDepartmentId) {
      const { data: dept } = await sbDept
        .from('workspace_departments')
        .select('id, cc_voice_enabled, cc_video_enabled')
        .eq('workspace_id', ws.workspace_id)
        .eq('id', chosenDepartmentId)
        .maybeSingle();
      if (!dept) return res.status(404).json({ error: 'department_not_found' });
      const ok = dbCallTypeForDept === 'audio'
        ? !!(dept as any).cc_voice_enabled
        : !!(dept as any).cc_video_enabled;
      if (!ok) return res.status(400).json({ error: 'department_channel_disabled' });
    } else {
      // Fall back to workspace default_department_id only if it has the required channel.
      const defId = (ws as any).default_department_id as string | null;
      if (defId) {
        const { data: dept } = await sbDept
          .from('workspace_departments')
          .select('id, cc_voice_enabled, cc_video_enabled')
          .eq('workspace_id', ws.workspace_id)
          .eq('id', defId)
          .maybeSingle();
        const ok = !!dept && (dbCallTypeForDept === 'audio'
          ? !!(dept as any).cc_voice_enabled
          : !!(dept as any).cc_video_enabled);
        if (ok) chosenDepartmentId = defId;
      }
    }
  }
  // Recording consent enforcement (fail-closed before any DB insert).
  const recording = await computeRecordingCapability(config, ws.workspace_id, platform, ws);
  const consentGiven = !!(parsed.data.recording_consent ?? parsed.data.consent_recording);
  if (recording.effective_enabled && recording.consent_required && !consentGiven) {
    return res.status(400).json({
      error: 'recording_consent_required',
      message: 'Recording consent is required before starting this call.',
    });
  }
  // Official consent timestamp is ALWAYS server-side — never trust visitor payload.
  const consentAt = consentGiven ? new Date().toISOString() : null;
  const clientConsentAt = parsed.data.recording_consent_at || null;
  // Initial recording state stored in metadata (column enum is narrower).
  const recordingMetaState = !recording.effective_enabled
    ? 'disabled'
    : (recording.consent_required && !consentGiven ? 'consent_pending' : 'ready');
  const recordingMeta = {
    state: recordingMetaState,
    capability: {
      effective_enabled: recording.effective_enabled,
      consent_required: recording.consent_required,
      provider_supported: recording.provider_supported,
      provider_configured: recording.provider_configured,
      reason: recording.reason || null,
    },
    consent_given: consentGiven,
    consent_at: consentAt,
    client_consent_at: clientConsentAt,
    notice_version: parsed.data.recording_notice_version || null,
    artifact_id: null as string | null,
  };
  // Resolve visitor identity BEFORE creating anything. This lets refreshes,
  // page changes, duplicate clicks, and lost/partitioned visitor cookies reuse
  // the in-flight call instead of creating another queue row.
  const identity = await identifyVisitorForCall(
    req,
    res,
    config,
    ws.workspace_id,
    getOrigin(req),
    {
      name: parsed.data.visitor_name,
      email: parsed.data.visitor_email,
      phone: parsed.data.visitor_phone,
      page_url: parsed.data.page_url,
    },
  );
  const existingActiveCall = await buildActiveCallPayload(config, req, res, ws, getOrigin(req), identity.visitorId);
  if (existingActiveCall) {
    return res.json({
      status: 'resumed',
      call_id: existingActiveCall.call_id,
      call_state: existingActiveCall.state,
      call_type: existingActiveCall.call_type,
      created_at: existingActiveCall.created_at,
      queue_position: existingActiveCall.queue_position,
      session: existingActiveCall.session,
      contact: identity.contact,
    });
  }
  // Provider check (fail closed)
  let providerId: string;
  try {
    const r = await resolveEffectiveCallProvider(config, ws.workspace_id);
    providerId = r.id;
  } catch (e: any) {
    return res.status(503).json({ error: 'provider_not_configured', message: String(e?.message || e) });
  }
  // Concurrency / queue limit
  const sb = getServiceClient(config);
  const [{ count: active }, { count: queued }] = await Promise.all([
    sb.from('call_sessions').select('id', { count: 'exact', head: true })
      .eq('workspace_id', ws.workspace_id).eq('entry_source', 'call_widget').in('state', ['active', 'ringing', 'connecting']),
    sb.from('call_queue_entries').select('id', { count: 'exact', head: true })
      .eq('workspace_id', ws.workspace_id).eq('entry_source', 'call_widget').in('state', ['queued', 'offered']),
  ]);
  if ((active || 0) >= effective.max_concurrent_calls) return res.status(429).json({ error: 'limit_reached', kind: 'concurrent' });
  if ((queued || 0) >= effective.max_queue_size) return res.status(429).json({ error: 'limit_reached', kind: 'queue' });
  // Phase: max_concurrent_calls — Dual-Knob Activation.
  // The widget-scoped platform-admin knob check above stays as-is
  // (its meaning has NOT changed: "max simultaneous widget-originated
  // calls"). The check below enforces the SEPARATE plan-level
  // workspace-wide ceiling using the canonical active-call counting
  // model (all entry_source values + 'pending' state included).
  // Both ceilings may deny; first denial wins. Distinct denial shape
  // (error = 'plan_limit_reached' | 'plan_forbidden') so callers can
  // distinguish the two knobs.
  const planConc = await checkPlanConcurrencyCeiling(config, ws.workspace_id);
  if (!planConc.allowed) {
    return res.status(planConc.reason === 'plan_limit_reached' ? 429 : 403).json(planConcurrencyDenialBody(planConc));
  }

  // Phase: max_call_minutes_per_month — Final Activation.
  // Workspace-wide monthly billable-minutes ceiling, applied at the
  // same create boundary as the concurrency check. Sole counting
  // source: workspace_usage_counters.call_minutes_used. Distinct
  // denial shape (error = 'plan_limit_reached' | 'plan_forbidden',
  // capability = 'max_call_minutes_per_month') so widget callers can
  // tell which ceiling fired.
  const planMins = await checkPlanMonthlyMinutesCeiling(config, ws.workspace_id);
  if (!planMins.allowed) {
    return res.status(planMins.reason === 'plan_limit_reached' ? 429 : 403).json(planMinutesDenialBody(planMins));
  }

  // Create call session + queue entry. Retry once on transient undici
  // "fetch failed" — Supabase REST connection can be reset between idle
  // pooled HTTP/1.1 keep-alives in long-running Node processes.
  const dbCallType = dbCallTypeForDept;
  const finalVisitorName = parsed.data.visitor_name || identity.contact?.name || null;
  const finalVisitorEmail = parsed.data.visitor_email || identity.contact?.email || null;
  const finalVisitorPhone = parsed.data.visitor_phone || identity.contact?.phone || null;
  const insertPayload = {
    workspace_id: ws.workspace_id,
    entry_source: 'call_widget',
    // Canonical relation to the exact visitor session behind this call, so the
    // Call Center resolves that visitor's IP/geo instead of guessing from the
    // contact's newest session.
    visitor_session_id: identity.visitorSessionId,
    direction: 'inbound',
    call_type: dbCallType,
    context_type: 'internal',
    context_id: null,
    state: 'pending',
    initiated_by_type: 'visitor',
    visitor_name: finalVisitorName,
    visitor_email: finalVisitorEmail,
    visitor_phone: finalVisitorPhone,
    subject: parsed.data.subject || null,
    page_url: parsed.data.page_url || null,
    page_title: parsed.data.page_title || null,
    origin: getOrigin(req),
    provider: providerId,
    department_id: chosenDepartmentId,
    recording_enabled: recording.effective_enabled,
    // Column 'disabled' here only means "no provider recording active yet".
    // Readiness is tracked in metadata.recording.state ('ready' | 'consent_pending' | 'disabled').
    recording_state: 'disabled',
    metadata: {
      call_center: true,
      form_data: parsed.data.form_data || null,
      consent_recording: consentGiven,
      recording: recordingMeta,
      visitor_id: identity.visitorId,
      contact_id: identity.contactId,
      visitor_session_id: identity.visitorSessionId,
    },
  };
  let call: any = null;
  let callErr: any = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await sb.from('call_sessions').insert(insertPayload).select('*').maybeSingle();
      call = r.data;
      callErr = r.error;
      if (!callErr && call) break;
      if (callErr && /fetch failed|ETIMEDOUT|ECONNRESET|ENOTFOUND|UND_ERR/i.test(String(callErr.message || ''))) {
        console.warn('[call-widget/calls/request] transient insert error, retrying:', callErr.message);
        await new Promise((r) => setTimeout(r, 150));
        continue;
      }
      break;
    } catch (thrown: any) {
      callErr = { message: String(thrown?.message || thrown) };
      console.warn('[call-widget/calls/request] insert threw, attempt', attempt, callErr.message);
      if (/fetch failed|ETIMEDOUT|ECONNRESET|ENOTFOUND|UND_ERR/i.test(callErr.message)) {
        await new Promise((r) => setTimeout(r, 150));
        continue;
      }
      break;
    }
  }
  if (callErr || !call) {
    console.error('[call-widget/calls/request] call_create_failed:', callErr?.message, {
      workspace_id: ws.workspace_id,
      provider: providerId,
      department_id: chosenDepartmentId,
      call_type: dbCallType,
    });
    return res.status(500).json({ error: 'call_create_failed', message: callErr?.message || 'insert_returned_no_row' });
  }

  await sb.from('call_queue_entries').insert({
    workspace_id: ws.workspace_id,
    entry_source: 'call_widget',
    channel: dbCallType,
    state: 'queued',
    call_session_id: call!.id,
    requested_by: 'visitor',
    priority: 100,
    department_id: chosenDepartmentId,
    visitor_session_id: identity.visitorSessionId,
    contact_id: identity.contactId,
  });

  await sb.from('call_events').insert({
    call_session_id: call!.id,
    event_type: 'call_requested',
    actor_type: 'visitor',
    payload: { call_type: parsed.data.call_type, page_url: parsed.data.page_url },
  });
  if (recording.effective_enabled) {
    try {
      await sb.from('call_events').insert({
        call_session_id: call!.id,
        event_type: 'recording_config_ready',
        actor_type: 'system',
        payload: {
          recording_active: false,
          start_stop_wired: false,
          consent_given: consentGiven,
          consent_required: recording.consent_required,
          provider_configured: recording.provider_configured,
        },
      });
    } catch { /* best-effort */ }
  }

  // Issue a fresh session bound to this call_id
  const newSession = signWidgetSession(config, {
    workspace_id: ws.workspace_id,
    public_key: ws.public_key,
    call_id: call!.id,
    visitor_id: identity.visitorId,
    origin: session.origin || null,
  });
  setActiveCallCookie(res, req, config, ws.workspace_id, call!.id, getOrigin(req));

  await publishQueueEvent(config, ws.workspace_id, 'call_requested', { call_id: call!.id });
  try {
    await routeIncomingCall(config, {
      workspaceId: ws.workspace_id,
      callSessionId: call!.id,
      departmentId: chosenDepartmentId,
      callType: dbCallType,
    });
  } catch (e: any) { /* best-effort: queue entry already created */ }

  res.json({
    status: 'queued',
    call_id: call!.id,
    queue_position: (queued || 0) + 1,
    session: newSession,
    contact: identity.contact,
  });
});

// ── Cancel ────────────────────────────────────────────────────────────────
callWidgetRouter.post('/calls/:id/cancel', async (req, res) => {
  const config = (req as any).serverConfig as ServerConfig;
  const guard = requireWidgetSession(req, config);
  if (!guard.ok) return res.status(guard.status).json({ error: guard.error });
  const session = guard.session;
  if (session.call_id !== req.params.id) return res.status(403).json({ error: 'forbidden' });
  const sb = getServiceClient(config);
  // Preserve detailed reason in metadata; constraint allows only the four canonical end_reason values.
  const { data: prev } = await sb.from('call_sessions')
    .select('metadata, connected_at, started_at, created_at, state')
    .eq('id', req.params.id).maybeSingle();
  const prevMeta = (prev?.metadata as any) || {};
  // If the call had already connected to an operator, treat the visitor
  // hangup as a normal "ended" call and compute duration_seconds from the
  // earliest known anchor. Otherwise it's a true pre-connect cancel.
  const anchorIso = (prev as any)?.connected_at
    || (prev as any)?.started_at
    || (prev as any)?.created_at
    || null;
  const wasConnected = !!(prev as any)?.connected_at;
  const endedAtMs = Date.now();
  const endedAtIso = new Date(endedAtMs).toISOString();
  const duration = anchorIso
    ? Math.max(0, Math.round((endedAtMs - new Date(anchorIso).getTime()) / 1000))
    : 0;
  await sb.from('call_sessions').update({
    state: wasConnected ? 'ended' : 'cancelled',
    ended_at: endedAtIso,
    duration_seconds: wasConnected ? duration : null,
    end_reason: 'visitor_ended',
    ended_by: 'visitor',
    metadata: { ...prevMeta, call_center_reason: wasConnected ? 'visitor_hangup' : 'visitor_cancelled' },
  }).eq('id', req.params.id).eq('workspace_id', session.workspace_id);
  await sb.from('call_queue_entries').update({
    state: 'cancelled', ended_at: endedAtIso, ended_reason: wasConnected ? 'visitor_hangup' : 'visitor_cancelled',
  }).eq('call_session_id', req.params.id).eq('workspace_id', session.workspace_id);
  await sb.from('call_events').insert({
    call_session_id: req.params.id, event_type: wasConnected ? 'call_ended' : 'call_cancelled', actor_type: 'visitor',
    payload: { reason: wasConnected ? 'visitor_hangup' : 'visitor_cancelled', duration_seconds: wasConnected ? duration : null },
  });
  await publishQueueEvent(config, session.workspace_id, wasConnected ? 'call_ended' : 'call_cancelled', { call_id: req.params.id });
  await publishCallEvent(config, session.workspace_id, req.params.id, wasConnected ? 'call_ended' : 'call_cancelled', { duration_seconds: wasConnected ? duration : null });
  clearActiveCallCookie(res, req);
  res.json({ ok: true });
});

// ── Status poll ───────────────────────────────────────────────────────────
callWidgetRouter.get('/calls/:id/status', async (req, res) => {
  const config = (req as any).serverConfig as ServerConfig;
  const guard = requireWidgetSession(req, config);
  if (!guard.ok) return res.status(guard.status).json({ error: guard.error });
  const session = guard.session;
  if (session.call_id !== req.params.id) return res.status(403).json({ error: 'forbidden' });
  const sb = getServiceClient(config);
  const { data: call } = await sb.from('call_sessions')
    .select('id,state,ended_at,end_reason,provider,provider_room_id,call_type,recording_enabled,recording_state,assigned_agent_id,started_at,duration_seconds')
    .eq('id', req.params.id).maybeSingle();
  if (!call) return res.status(404).json({ error: 'not_found' });
  // Resolve operator display name for the visitor UI. Only the
  // operator's first/display name is exposed — never email or role.
  let operator_name: string | null = null;
  const agentId = (call as any).assigned_agent_id as string | null;
  if (agentId) {
    try {
      const { data: prof } = await sb.from('profiles')
        .select('full_name,email')
        .eq('id', agentId).maybeSingle();
      if (prof) {
        const fn = (prof as any).full_name as string | null;
        const em = (prof as any).email as string | null;
        operator_name = (fn && fn.trim())
          || (em ? em.split('@')[0] : null)
          || null;
      }
    } catch {/* ignore */}
  }
  // Compute live queue position + ETA from the queue table, not from
  // call_sessions.state. Widget calls are created as `pending` while their
  // queue row is `queued/offered`, so gating this on call.state === `queued`
  // leaves visitors stuck with the initial position forever.
  let position: number | null = null;
  let eta_seconds: number | null = null;
  const callState = String((call as any).state || '');
  if (call && !['cancelled', 'ended', 'missed', 'failed', 'active', 'ringing', 'connecting'].includes(callState)) {
    const { data: entry } = await sb.from('call_queue_entries')
      .select('id,created_at,workspace_id,channel,priority,state')
      .eq('call_session_id', req.params.id).maybeSingle();
    if (entry && ['queued', 'offered'].includes(String((entry as any).state || ''))) {
      const { data: activeRows } = await sb.from('call_queue_entries')
        .select('id,created_at,priority')
        .eq('workspace_id', (entry as any).workspace_id)
        .eq('entry_source', 'call_widget')
        .in('state', ['queued', 'offered'])
        .order('priority', { ascending: false })
        .order('created_at', { ascending: true })
        .limit(500);
      const idx = (activeRows || []).findIndex((row: any) => row.id === (entry as any).id);
      position = idx >= 0 ? idx + 1 : null;
      try {
        const platform = await getPlatformCallCenterSettings(config);
        const perPos = Math.max(5, platform.queue_eta_seconds_per_position || 45);
        eta_seconds = position ? Math.max(0, (position - 1)) * perPos + perPos : null;
      } catch { eta_seconds = position ? (position - 1) * 45 + 30 : null; }
    }
  }
  res.json({ call, position, eta_seconds, operator_name });
});

// ── Visitor join token (only after operator accepts) ──────────────────────
callWidgetRouter.post('/calls/:id/join-token', async (req, res) => {
  const config = (req as any).serverConfig as ServerConfig;
  const guard = requireWidgetSession(req, config);
  if (!guard.ok) return res.status(guard.status).json({ error: guard.error });
  const session = guard.session;
  if (session.call_id !== req.params.id) return res.status(403).json({ error: 'forbidden' });
  // Re-check workspace origin allow-list (in case allowed_domains changed
  // between bootstrap and now).
  const wsForOrigin = await getOrCreateWorkspaceSettings(config, session.workspace_id);
  if (!originAllowed(wsForOrigin, getOrigin(req))) {
    return res.status(403).json({ error: 'origin_denied' });
  }
  const sb = getServiceClient(config);
  const { data: call } = await sb.from('call_sessions').select('*').eq('id', req.params.id).maybeSingle();
  if (!call) return res.status(404).json({ error: 'not_found' });
  const c = call as any;
  if (!c.provider_room_id || !c.provider) {
    return res.status(409).json({ error: 'not_ready', reason: 'provider_room_not_ready' });
  }
  if (!['active', 'ringing', 'connecting'].includes(c.state)) {
    return res.status(409).json({ error: 'not_active', reason: 'call_not_active' });
  }
  const { provider } = await resolveEffectiveCallProvider(config, c.workspace_id);
  const tok = await provider.createParticipantToken(config, {
    callSessionId: c.id,
    providerRoomId: c.provider_room_id,
    participantId: `visitor:${c.id}`,
    participantType: 'visitor',
    canPublish: true, canSubscribe: true, canPublishData: true,
    ttlSeconds: 60 * 60,
  });
  // LiveKit identity is `<participantType>:<participantId>` (see livekitProvider).
  const identity = `visitor:visitor:${c.id}`;
  const connect = await buildClientConnectInfo(config, c.provider, c.provider_room_id, identity);
  res.json({
    token: tok.token,
    provider: c.provider,
    provider_room_id: c.provider_room_id,
    expires_at: tok.expiresAt,
    connect,
  });
});

// ── Callback request ──────────────────────────────────────────────────────
const callbackSchema = z.object({
  name: z.string().max(120).optional().nullable(),
  email: z.string().email().max(200).optional().nullable(),
  phone: z.string().max(40).optional().nullable(),
  subject: z.string().max(500).optional().nullable(),
  message: z.string().max(2000).optional().nullable(),
  channel: z.enum(['audio', 'video']).optional().nullable(),
  urgency: z.enum(['normal', 'urgent']).optional().nullable(),
  scheduled_for: z.string().datetime().optional().nullable(),
  page_url: z.string().max(2000).optional().nullable(),
  department_id: z.string().uuid().optional().nullable(),
  /** Anti-bot: invisible field that humans never fill. */
  hp_company: z.string().max(200).optional().nullable(),
  /** Anti-bot: ms timestamp when the form opened (client-reported). */
  form_opened_at: z.number().int().optional().nullable(),
});

callWidgetRouter.post('/callbacks/request', async (req, res) => {
  const config = (req as any).serverConfig as ServerConfig;
  const guard = requireWidgetSession(req, config);
  if (!guard.ok) return res.status(guard.status).json({ error: guard.error });
  const session = guard.session;
  const ws = await getOrCreateWorkspaceSettings(config, session.workspace_id);
  if (!originAllowed(ws, getOrigin(req))) {
    return res.status(403).json({ error: 'origin_denied' });
  }
  const platform = await getPlatformCallCenterSettings(config);
  const effective = computeEffectiveCallCenterCaps(platform, ws);
  if (!effective.callback_enabled) return res.status(403).json({ error: 'feature_not_available' });
  // Plan composer gate — visitor-initiated callback request.
  // Deny-on-create only; operator-side callbacks list/PATCH stay reachable.
  try {
    const eff = await loadEffectiveCallEntitlements(config, ws.workspace_id);
    if (!eff.callbacks_enabled) {
      return res.status(403).json({
        error: 'plan_forbidden',
        capability: 'call_callbacks',
        upgrade_required: true,
      });
    }
  } catch {
    return res.status(403).json({ error: 'plan_forbidden', capability: 'call_callbacks', upgrade_required: true });
  }
  const parsed = callbackSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
  // ── Anti-spam enforcement ──────────────────────────────────────────────
  // 1) Honeypot — bots fill hidden fields. Silently 200 to avoid signal.
  if (platform.callback_honeypot_enabled && parsed.data.hp_company && parsed.data.hp_company.trim() !== '') {
    return res.json({ ok: true, callback_id: 'hp_' + crypto.randomBytes(6).toString('hex') });
  }
  // 2) Minimum form-fill time.
  const minFormSec = Math.max(0, platform.callback_min_form_seconds || 0);
  if (minFormSec > 0 && parsed.data.form_opened_at) {
    const elapsedSec = Math.floor((Date.now() - Number(parsed.data.form_opened_at)) / 1000);
    if (elapsedSec >= 0 && elapsedSec < minFormSec) {
      return res.status(429).json({ error: 'too_fast', retry_after: minFormSec - elapsedSec });
    }
  }
  // 3) Require contact info.
  if (platform.callback_require_contact) {
    const hasEmail = !!(parsed.data.email && parsed.data.email.trim());
    const hasPhone = !!(parsed.data.phone && parsed.data.phone.trim());
    if (!hasEmail && !hasPhone) {
      return res.status(400).json({ error: 'contact_required' });
    }
  }
  // 4) Minimum message length.
  const minMsg = Math.max(0, platform.callback_min_message_length || 0);
  if (minMsg > 0) {
    const msg = (parsed.data.message || '').trim();
    if (msg.length < minMsg) {
      return res.status(400).json({ error: 'message_too_short', min: minMsg });
    }
  }
  const sb = getServiceClient(config);
  // 5) IP-based rate limit (per hour).
  const clientIp = getClientIp(req as any);
  const ipHash = clientIp ? hashIp(clientIp) : null;
  if (ipHash && platform.callback_max_per_ip_per_hour > 0) {
    const sinceHour = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count } = await sb
      .from('callback_requests')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', ws.workspace_id)
      .gte('created_at', sinceHour)
      .contains('metadata', { ip_hash: ipHash });
    if ((count ?? 0) >= platform.callback_max_per_ip_per_hour) {
      return res.status(429).json({ error: 'rate_limited_ip' });
    }
  }
  // 6) Per-visitor cooldown.
  const cooldownSec = Math.max(0, platform.callback_min_seconds_between_requests || 0);
  if (cooldownSec > 0) {
    const sinceCooldown = new Date(Date.now() - cooldownSec * 1000).toISOString();
    let visitorIdForLookup: string | null = null;
    try {
      const cookieVid = readVisitorCookie(req as any);
      visitorIdForLookup = cookieVid ? cookieVid.v : null;
    } catch {/* ignore */}
    if (visitorIdForLookup) {
      const { data: recent } = await sb
        .from('callback_requests')
        .select('id, created_at')
        .eq('workspace_id', ws.workspace_id)
        .gte('created_at', sinceCooldown)
        .contains('metadata', { visitor_id: visitorIdForLookup })
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (recent) {
        const ageMs = Date.now() - new Date((recent as any).created_at).getTime();
        const retryAfter = Math.max(1, Math.ceil((cooldownSec * 1000 - ageMs) / 1000));
        return res.status(429).json({ error: 'cooldown_active', retry_after: retryAfter });
      }
    }
  }
  // Validate optional visitor-selected department.
  let cbDepartmentId: string | null = parsed.data.department_id || null;
  if (cbDepartmentId) {
    const { data: dept } = await sb
      .from('workspace_departments')
      .select('id, cc_callback_enabled')
      .eq('workspace_id', ws.workspace_id)
      .eq('id', cbDepartmentId)
      .maybeSingle();
    if (!dept) return res.status(404).json({ error: 'department_not_found' });
    if (!(dept as any).cc_callback_enabled) {
      return res.status(400).json({ error: 'department_channel_disabled' });
    }
  } else {
    const defId = (ws as any).default_department_id as string | null;
    if (defId) {
      const { data: dept } = await sb
        .from('workspace_departments')
        .select('id, cc_callback_enabled')
        .eq('workspace_id', ws.workspace_id)
        .eq('id', defId)
        .maybeSingle();
      if (dept && (dept as any).cc_callback_enabled) cbDepartmentId = defId;
    }
  }
  // Identify the visitor BEFORE inserting so the callback is born with its
  // canonical relation (`visitor_session_id`) instead of only a metadata blob.
  // Never blocks the callback: on failure we simply insert without the link.
  let cbIdentity: {
    visitorId: string; visitorSessionId: string | null; contactId: string | null;
  } | null = null;
  try {
    const identity = await identifyVisitorForCall(
      req,
      res,
      config,
      ws.workspace_id,
      getOrigin(req),
      {
        name: parsed.data.name,
        email: parsed.data.email,
        phone: parsed.data.phone,
        page_url: parsed.data.page_url,
      },
    );
    cbIdentity = {
      visitorId: identity.visitorId,
      visitorSessionId: identity.visitorSessionId,
      contactId: identity.contactId,
    };
  } catch (e: any) {
    console.warn('[call-widget/callbacks] identity merge failed:', e?.message || e);
  }

  const { data, error } = await sb.from('callback_requests').insert({
    workspace_id: ws.workspace_id,
    channel: parsed.data.channel === 'video' ? 'video' : 'audio',
    status: 'requested',
    contact_id: cbIdentity?.contactId ?? null,
    visitor_session_id: cbIdentity?.visitorSessionId ?? null,
    contact_phone: parsed.data.phone || null,
    contact_email: parsed.data.email || null,
    notes: parsed.data.message || parsed.data.subject || null,
    scheduled_for: parsed.data.scheduled_for || null,
    metadata: {
      source: 'call_widget',
      name: parsed.data.name || null,
      subject: parsed.data.subject || null,
      message: parsed.data.message || null,
      urgency: parsed.data.urgency || 'normal',
      page_url: parsed.data.page_url || null,
      department_id: cbDepartmentId,
      visitor_id: cbIdentity?.visitorId ?? null,
      contact_id: cbIdentity?.contactId ?? null,
      ip_hash: ipHash,
    },
  }).select('*').maybeSingle();
  if (error) return res.status(500).json({ error: 'callback_create_failed', message: error.message });
  await publishQueueEvent(config, ws.workspace_id, 'callback_requested', { callback_id: data!.id });
  res.json({ ok: true, callback_id: data!.id });
});

// ── Post-call rating submitted by the visitor (1–5 stars + optional comment)
const ratingSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(1000).optional().nullable(),
});
callWidgetRouter.post('/calls/:id/rate', async (req, res) => {
  const config = (req as any).serverConfig as ServerConfig;
  const guard = requireWidgetSession(req, config);
  if (!guard.ok) return res.status(guard.status).json({ error: guard.error });
  const session = guard.session;
  if (session.call_id !== req.params.id) return res.status(403).json({ error: 'forbidden' });
  const parsed = ratingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  const sb = getServiceClient(config);
  const { data: call } = await sb.from('call_sessions')
    .select('id,workspace_id,state').eq('id', req.params.id).maybeSingle();
  if (!call) return res.status(404).json({ error: 'not_found' });
  try {
    await sb.from('call_ratings').upsert({
      call_session_id: req.params.id,
      workspace_id: (call as any).workspace_id,
      rating: parsed.data.rating,
      comment: parsed.data.comment || null,
    }, { onConflict: 'call_session_id' });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: 'rating_failed', message: String(e?.message || e) });
  }
});