/**
 * Call Center — public visitor-facing routes for the standalone call widget.
 * Mounted at /api/call-widget/*. CORS is dynamic per workspace allowed_domains.
 * No service tokens leak to visitors. Visitors get short-lived HMAC sessions.
 */
import { Router, type NextFunction, type Response } from 'express';
import { z } from 'zod';
import { WIDGET_CORS_EXPOSE_HEADERS, WIDGET_CORS_MAX_AGE_SECONDS } from '../middleware/widgetCors.js';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import {
  findWorkspaceByPublicKey,
  findWorkspaceSettings,
  getOrCreateWorkspaceSettings,
  getPlatformCallCenterSettings,
  computeEffectiveCallCenterCaps,
  computeEffectiveCallCenterLocales,
  originAllowed,
  callWidgetDesignSettings,
  type CallWidgetDesignSettings,
  type WorkspaceCallCenterSettings,
} from '../services/callCenter/settings.js';
import { signWidgetSession, verifyWidgetSession } from '../services/callCenter/widgetSession.js';
import { memoCallWidgetBootstrap } from '../services/callCenter/bootstrapCache.js';
import { loadPublicCallPresence, operatorOwnName } from '../services/callCenter/publicPresence.js';
import { issuePresenceTicket, readPresenceTicket } from '../services/callCenter/presenceTicket.js';
import { isWorkspaceOriginAllowed } from '../services/widget/public.js';
import { takeAnonymousCallBootstrap } from '../services/widget/security.js';
import { resolveEffectiveCallProvider } from '../services/calls/providerResolver.js';
import type { CallProviderId } from '../services/calls/providers/types.js';
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
import { createStorageUrlResolver } from '../services/storage/urlResolver.js';
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
  readContinuityCookie,
  resolveContinuityToken,
  setContinuityCookie,
} from '../services/widget/continuity.js';
import { getClientIp, hashIp, getClientCountry } from '../utils/clientIp.js';
import { getWidgetAssetName, getOptionalWidgetAssetName } from '../services/widget/manifest.js';
import { resolveWidgetAssetBase, getLoaderAssetBase } from '../services/widget/public.js';
import { widgetTemplateAssetKeys, resolveWidgetTemplateId } from '../services/widget/presentationAssets.js';
import { buildPoweredByConfig, isPoweredByAllowedForPlan } from '../services/widget/poweredBy.js';
import { getPlatformEditionOrNull } from '../services/platformRegion.js';
import { workspaceChatTemplate } from '../services/widget/configSnapshot.js';
import type { Edition } from '../../shared/edition.js';
import { widgetDateHints } from '../../shared/widgetTemplates.js';
import { callLauncherNeedsPresence, resolveCallLauncher, type CallLauncherStyle } from '../../shared/callLauncherStyles.js';
import { CALLBACK_BOOKING_MAX_AHEAD_MS, computeCallbackSlots, isBookableSlot, type CallbackSlot } from '../../shared/callbackSlots.js';
import { visitorPageUrl } from '../../shared/callCenter/visitorPageUrl.js';
import { INTL_BRAND } from '../../shared/internationalMode.js';
import { WEBYAR_BRAND, isWebyarKitEdition } from '../../shared/webyarBrand.js';
import { resolveBrandAssets } from '../services/platformBrandAssets.js';
import {
  callbackSlotHours,
  callWidgetPanelAssetKeys,
  callWidgetTemplateAssetKeys,
  normalizeCallWidgetFormSchema,
  normalizeCallWidgetOfflineBehavior,
  normalizeCallWidgetTheme,
  resolveCallWidgetTemplateId,
} from '../services/callCenter/presentation.js';
import crypto from 'crypto';
import { readFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { serverConfigOf } from '../lib/workspaceAuth.js';
import { cancelRing } from '../services/push/callRing.js';
import { notifyCallbackRequest } from '../services/push/index.js';

export const callWidgetRouter = Router();

// The version of the call widget files at their FIXED names, for loaders
// that carry no build names: the raw l.js this API image serves to old
// snippets pointing at the API origin, and loaders from before content
// hashing. A built l.js (frontend image) names content-hashed files and uses
// this only for its fallback. A hash of the files this image serves (sha256),
// or the start time when they are not here.
const CALL_WIDGET_ASSETS_VERSION: string = (() => {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(here, '..', '..', 'public', 'call-widget'),
      path.resolve(here, '..', 'public', 'call-widget'),
      path.resolve(process.cwd(), 'public', 'call-widget'),
    ];
    for (const dir of candidates) {
      // Not every candidate exists (the server image has /app/routes, so the
      // first one is /public/call-widget): a missing one must not end the search.
      if (!existsSync(dir)) continue;
      const js = path.join(dir, 'runtime.js');
      const css = path.join(dir, 'runtime.css');
      // Every presentation file (presentation-intl.css too: it was missing).
      const presentationFiles = ['presentation-registry.js', 'presentation-default.js', 'presentation-default.css']
        .concat(readdirSync(dir).filter((n) => /^presentation-[a-z0-9-]+\.(?:js|css)$/.test(n)).sort())
        .filter((n, i, all) => all.indexOf(n) === i)
        .map((n) => path.join(dir, n));
      if (existsSync(js) && existsSync(css) && presentationFiles.every(existsSync)) {
        const h = crypto.createHash('sha256');
        for (const asset of [js, css, ...presentationFiles]) h.update(readFileSync(asset));
        return h.digest('hex').slice(0, 12);
      }
    }
  } catch {/* fall through */}
  return String(Date.now()).slice(-12);
})();

/**
 * The call widget's CORS answer. The response is readable by the calling
 * origin; whether that origin may USE the workspace is decided per route
 * (callOriginAllowed: the workspace's domains, fail closed), never here.
 *
 * server/index.ts mounts this in front of the call widget's rate limiters
 * too, so a 429 carries the same headers as any other answer: the loader
 * (public/call-widget/l.js) can then read it and wait the Retry-After it
 * names (exposed below), instead of seeing a network error. The router keeps
 * its own copy for when it is mounted alone; setting the headers twice is
 * harmless.
 */
export function callWidgetCors(req: ExpressRequest, res: Response, next: NextFunction): void {
  const origin = req.headers.origin as string | undefined;
  if (origin) {
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-cc-session, x-cc-active-call');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', WIDGET_CORS_EXPOSE_HEADERS);
    // Let the browser keep the preflight (Chrome caps it at 2 h): without
    // it every status poll of a call in progress (custom headers, every
    // 5 s) paid a second request. One constant with the chat widget.
    res.setHeader('Access-Control-Max-Age', String(WIDGET_CORS_MAX_AGE_SECONDS));
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

// Dynamic CORS per workspace allowed_domains
callWidgetRouter.use(callWidgetCors);

function getOrigin(req): string | null {
  return (req.headers.origin as string) || null;
}

/**
 * ONE canonical origin boundary for the visitor-facing call widget.
 *
 * The call widget used to enforce ONLY `call_center_workspace_settings.allowed_domains`
 * and fail closed when that list was empty — so a site where the chat widget
 * worked fine got a 403 `origin_denied` from /call-widget/bootstrap.
 * The canonical widget boundary (verified workspace_domains + widget_settings
 * allowlist + subdomain rules) is the same one the chat widget uses; the
 * call-center list stays as an ADDITIONAL allowance.
 */
async function callOriginAllowed(
  config: ServerConfig,
  ws: WorkspaceCallCenterSettings,
  origin: string | null,
): Promise<boolean> {
  if (!origin) return false;
  if (originAllowed(ws, origin)) return true;
  try {
    return await isWorkspaceOriginAllowed(config, ws.workspace_id, origin);
  } catch {
    return false;
  }
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
  req,
  res,
  config: ServerConfig,
  workspaceId: string,
  contactId: string,
): Promise<void> {
  // Refresh the signed, DB-independent continuity cookie so it is the
  // browser's stored value. This prevents the call widget from asking for
  // contact details again after refresh even if the anonymous visitor cookie
  // was partitioned/rotated. It used to ALSO insert a user_continuity_tokens
  // row for a random token nobody was ever given (see
  // issueContinuityCookieForContact in services/widget/crossWidgetIdentity.ts):
  // a dead write on every call-widget page load without the cookie.
  setContinuityCookie(res, createSignedContactContinuityToken(workspaceId, contactId), req);
}

async function restoreContactFromContinuityCookie(
  req,
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
  // The bootstrap knows only the embedding site's origin, not the page; a
  // callback/call request may carry the real page_url. The origin is still
  // what a brand-new session starts with, but it must not overwrite the real
  // URL the chat widget's /track keeps on an existing session.
  const realPage = pageUrl && pageUrl !== origin ? pageUrl : null;
  return ensureSharedVisitorSessionRow(
    sb,
    workspaceId,
    visitorId,
    realPage || origin || null,
    'call_widget',
    net,
    { config, touchPresence: true, pageUrlOnlyOnCreate: !realPage },
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
  req,
  res,
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
    // The pre-call form's email/phone are unverified claims. mergeVisitorIdentity
    // (no verifiedIdentifiers / verifiedStoreIdentity) keeps them on this
    // visitor's own or a new contact and never resolves an existing contact
    // by them, so the continuity cookie issued below is always for the
    // visitor's own contact — never for a customer whose address was typed.
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
  } catch (e) {
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
function requireWidgetSession(req, config: ServerConfig) {
  const session = getSession(req, config);
  if (!session) return { ok: false as const, status: 401, error: 'invalid_session' };
  const reqOrigin = getOrigin(req);
  if (session.origin) {
    if (!reqOrigin) return { ok: false as const, status: 403, error: 'origin_mismatch' };
    if (session.origin !== reqOrigin) return { ok: false as const, status: 403, error: 'origin_mismatch' };
  }
  return { ok: true as const, session };
}

function disabledResponse(reason: string, message?: Record<string, unknown>) {
  return { status: 'disabled', reason, message: message || null };
}

const ACTIVE_CALL_COOKIE_NAME = 'dvccall';
const ACTIVE_CALL_TTL_SECONDS = 60 * 60 * 6; // enough for refresh/navigation; DB state remains authoritative
/** The `call_sessions` columns this route actually reads. */
type CallSessionRow = {
  id: string;
  workspace_id: string;
  state: string | null;
  provider: CallProviderId | null;
  provider_room_id: string | null;
};

const ACTIVE_CALL_STATES = ['pending', 'queued', 'ringing', 'connecting', 'active'];
const TERMINAL_CALL_STATES = ['cancelled', 'ended', 'missed', 'failed'];

/**
 * Optional secrets: a deployment may set either, and falls back to the
 * service-role key when it sets neither. They are not on ServerConfig's
 * declared surface, so they are read through a narrow structural type
 * rather than by widening the whole config.
 */
type OptionalCookieSecrets = { widgetTokenSecret?: string; sessionSecret?: string };

function activeCallCookieSecret(config: ServerConfig): string {
  const secrets = config as ServerConfig & OptionalCookieSecrets;
  return `call-widget-active:${secrets.widgetTokenSecret || secrets.sessionSecret || config.signingSecret || config.supabaseServiceRoleKey}`;
}

function signActiveCallCookie(config: ServerConfig, body: string): string {
  return crypto.createHmac('sha256', activeCallCookieSecret(config)).update(body).digest('base64url');
}

function encodeActiveCallCookie(config: ServerConfig, payload: { c: string; w: string; o: string | null; iat: number; exp: number }): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${signActiveCallCookie(config, body)}`;
}

function readActiveCallCookie(config: ServerConfig, req, workspaceId: string, origin: string | null): { callId: string } | null {
  const raw = req.cookies?.[ACTIVE_CALL_COOKIE_NAME] as string | undefined;
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

function setActiveCallCookie(res, req, config: ServerConfig, workspaceId: string, callId: string, origin: string | null): void {
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

function clearActiveCallCookie(res, req): void {
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
  req,
  res,
  ws: WorkspaceCallCenterSettings,
  origin: string | null,
  visitorId: string | null,
  /** Look the visitor's calls up by visitor id when no header/cookie names one (default on). */
  opts: { scanByVisitor?: boolean } = {},
): Promise<{ call_id: string; state: string; call_type: string; created_at: string | null; queue_position: number | null; session: string } | null> {
  const sbActive = getServiceClient(config);
  let mine = null;
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
    if (data && ACTIVE_CALL_STATES.includes(String(data.state || ''))) {
      mine = data;
      break;
    } else if (data && TERMINAL_CALL_STATES.includes(String(data.state || ''))) {
      clearActiveCallCookie(res, req);
    }
  }
  if (!mine && visitorId && opts.scanByVisitor !== false) {
    const { data: rows } = await sbActive
      .from('call_sessions')
      .select('id,state,call_type,created_at,metadata')
      .eq('workspace_id', ws.workspace_id)
      .eq('entry_source', 'call_widget')
      .in('state', ACTIVE_CALL_STATES)
      .order('created_at', { ascending: false })
      .limit(50);
    mine = (rows || []).find((r) => r.metadata?.visitor_id === visitorId) || null;
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
    if (entry && ['queued', 'offered'].includes(String(entry.state || ''))) {
      const { data: activeRows } = await sbActive
        .from('call_queue_entries')
        .select('id,created_at,priority')
        .eq('workspace_id', entry.workspace_id)
        .eq('entry_source', 'call_widget')
        .in('state', ['queued', 'offered'])
        .order('priority', { ascending: false })
        .order('created_at', { ascending: true })
        .limit(500);
      const idx = (activeRows || []).findIndex((row) => row.id === entry.id);
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
const BOOTSTRAP_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BOOTSTRAP_PUBLIC_KEY_RE = /^[A-Za-z0-9_-]{4,128}$/;

/**
 * The bootstrap's workspace-level part: the same for every visitor and every
 * loader (bootstrapCache.ts). What depends on the request — the loader's
 * asset origin (`loader_origin` / `asset_base` query) in the font and logo
 * URLs — is not in it, so its key names the workspace only.
 */
type PublicBootstrap = {
  ws: WorkspaceCallCenterSettings | null;
  /** A `disabled` answer, or null when the widget is on. */
  disabled: ReturnType<typeof disabledResponse> | null;
  /** The response fields that are the same for every request (no URL of the request's). */
  body: Record<string, unknown> & { assets?: Record<string, string> };
  /** The shared font stylesheet's file name (`font_style_url` is built per request). */
  fontName: string | null;
  /** The International edition's credit, as read (its logo URL is built per request). */
  brand: CallWidgetBrandRows | null;
  /** The launcher the bootstrap names (`presence.operators` is sent only for some). */
  launcherStyle?: CallLauncherStyle;
};

function loadPublicBootstrap(
  config: ServerConfig,
  query: { workspaceId?: string; publicKey?: string },
): Promise<PublicBootstrap | null> {
  // A UUID is the same in any case: one key per workspace.
  const key = query.publicKey ? `pk:${query.publicKey}` : `ws:${String(query.workspaceId).toLowerCase()}`;
  return memoCallWidgetBootstrap(key, () => computePublicBootstrap(config, query), (v) => v?.ws?.workspace_id ?? null);
}

async function computePublicBootstrap(
  config: ServerConfig,
  query: { workspaceId?: string; publicKey?: string },
): Promise<PublicBootstrap | null> {
  // Read-only: a page view never creates the settings row (the row's
  // `enabled` defaults to false, so a workspace without one is answered
  // `workspace_disabled` exactly as before — without the INSERT, or the
  // failed INSERT a made-up id caused).
  const ws = query.publicKey
    ? await findWorkspaceByPublicKey(config, query.publicKey)
    : await findWorkspaceSettings(config, String(query.workspaceId).toLowerCase());
  if (!ws && query.publicKey) return null;
  const platform = await getPlatformCallCenterSettings(config);
  if (!platform.call_center_enabled) {
    return { ws, disabled: disabledResponse('call_center_disabled', platform.disabled_message), body: {}, fontName: null, brand: null };
  }
  if (!ws || !ws.enabled) {
    return { ws, disabled: disabledResponse('workspace_disabled'), body: {}, fontName: null, brand: null };
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
    !!platform.departments_enabled &&
    !!ws.departments_enabled &&
    !!ws.allow_visitor_department_choice;
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
      // A switched-off department is never offered (Team & Departments, and
      // the settings page's preview, leave it out too).
      .eq('enabled', true)
      .or('cc_voice_enabled.eq.true,cc_video_enabled.eq.true,cc_callback_enabled.eq.true')
      .order('sort_order', { ascending: true });
    const safeDept = (r) => ({ id: r.id, name: r.name, sort_order: r.sort_order ?? 0 });
    departments = {
      voice: (deptRows || []).filter((r) => r.cc_voice_enabled).map(safeDept),
      video: (deptRows || []).filter((r) => r.cc_video_enabled).map(safeDept),
      callback: (deptRows || []).filter((r) => r.cc_callback_enabled).map(safeDept),
    };
  }
  // Ringback audio is platform-owned. Only the storage keys are persisted;
  // every link below is derived through the one resolver, for whichever
  // provider is primary at this moment. The former fallback to the stored
  // `ringback_music_url` is gone: a stored URL names the provider that was
  // primary when it was uploaded, which is exactly the staleness this
  // architecture removes.
  const ringbackAudio = await (async () => {
    const resolver = createStorageUrlResolver(config);
    const queuePaths = (platform.ringback_queue_audio_paths || {}) as Record<string, string>;
    const queue_urls: Record<string, string> = {};
    for (const [pos, key] of Object.entries(queuePaths)) {
      const u = await resolver.platform(key);
      if (u) queue_urls[pos] = u;
    }
    return {
      music_url: await resolver.platform(platform.ringback_music_path as string | null),
      announcement_url: await resolver.platform(platform.ringback_announcement_audio_path as string | null),
      queue_urls,
    };
  })();
  // Shared, hashed font asset (its URL: callWidgetFontStyleUrl, per request).
  const fontName = (() => {
    try {
      return getOptionalWidgetAssetName(widgetTemplateAssetKeys(resolveWidgetTemplateId(null)).fonts);
    } catch { return null; }
  })();
  // The platform's edition picks the template (shared/widgetTemplates.ts):
  // the Iranian edition — and an edition that cannot be read — wears
  // `default`, exactly as before; the International edition wears `intl`.
  const edition = await getPlatformEditionOrNull(config);
  const callTemplateId = resolveCallWidgetTemplateId(ws.widget_template_id, edition);
  const callTemplateAssets = callWidgetTemplateAssetKeys(callTemplateId);
  // The "powered by" credit. The Iranian edition keeps the runtime's own
  // words ("Powered by Web Yar"), so nothing is sent for it. The
  // International edition credits its own platform, by the same rules as the
  // chat widget (platform switch, brand text, link, plan gate).
  const brand = edition === 'international' ? await readCallWidgetBrand(config, ws.workspace_id) : null;
  // A logo the Super Admin uploaded (server/services/platformBrandAssets.ts)
  // credits the platform in both editions, absolute on the storage provider;
  // the panel then draws it as an image instead of the kit's own art. An
  // edition that cannot be read keeps the words.
  const brandAssets = edition ? await resolveBrandAssets(config, { edition }).catch(() => null) : null;
  const customLogo = brandAssets?.source === 'custom' ? brandAssets.logo.light : null;
  // Persian dates: Jalali in Tehran time in Iran (and unknown), Gregorian in
  // the visitor's zone abroad (shared/widgetTemplates.ts).
  const dateHints = widgetDateHints(edition);
  // Derived from `call_center_settings.avatar_storage_path` for the
  // provider that is primary right now; the row persists no URL of ours.
  const avatarUrl = (await createStorageUrlResolver(config).workspace(ws.workspace_id, ws.avatar_storage_path))
    ?? ws.avatar_url ?? null;
  // The call widget design (migration 277; its defaults while a database has
  // not got it): the launcher and placement, the panel module (loaded on the
  // visitor's first intent), and the International logo direction.
  const design = callWidgetDesignSettings(ws);
  const launcher = resolveCallLauncher({ launcher_style: design.launcher_style, widget_position: ws.widget_position });
  const panelAssets = callWidgetPanelAssetKeys(callTemplateId);
  const logoDirection = edition === 'international' ? await readCallLogoDirection(config, ws.workspace_id) : null;
  // Callback slots: only while the workspace turned them on, from hours that
  // pass the strict shape. The hours themselves are never sent.
  const slots = effective.callback_enabled
    ? await loadCallbackSlots(config, ws, design, edition, Date.now())
    : null;
  return {
    ws,
    disabled: null,
    fontName,
    brand: brand ? { ...brand, logoDirection, customLogo } : null,
    launcherStyle: launcher.style,
    body: {
      assets_version: CALL_WIDGET_ASSETS_VERSION,
      // Additive: the platform's edition (null when it cannot be read; the
      // widget then behaves as the Iranian edition).
      edition,
      calendar: dateHints.calendar,
      time_zone: dateHints.timeZone,
      // Additive, the Iranian edition only (region_mode = 'iran'; never an
      // edition that cannot be read): WebYar's Persian logotype for the
      // runtime's own fixed credit, in the brand's place. A path on the widget's
      // asset origin (the runtime resolves it against the origin it was loaded
      // from); the runtime keeps the words if the image cannot load.
      ...(isWebyarKitEdition(edition) ? { powered_by_logo: WEBYAR_BRAND.logo.light } : {}),
      ...(isWebyarKitEdition(edition) && customLogo ? { powered_by_logo: customLogo, powered_by_logo_custom: true } : {}),
      assets: {
        presentation_registry_url: `/call-widget/${callTemplateAssets.registry}`,
        presentation_script_url: `/call-widget/${callTemplateAssets.script}`,
        presentation_style_url: `/call-widget/${callTemplateAssets.style}`,
        presentation_panel_script_url: `/call-widget/${panelAssets.panelScript}`,
        presentation_panel_style_url: `/call-widget/${panelAssets.panelStyle}`,
      },
      workspace_id: ws.workspace_id,
      config: {
        display_name: ws.display_name,
        avatar_url: avatarUrl,
        // One of the five placements (a stored older spelling read as its
        // placement); the engine maps the same spellings for old servers.
        widget_position: launcher.position,
        widget_template_id: callTemplateId,
        launcher_style: launcher.style,
        ...(logoDirection ? { logoDirection } : {}),
        widget_theme: normalizeCallWidgetTheme(ws.widget_theme),
        pre_call_form_enabled: ws.pre_call_form_enabled,
        pre_call_form_schema: normalizeCallWidgetFormSchema(ws.pre_call_form_schema),
        offline_behavior: normalizeCallWidgetOfflineBehavior(ws.offline_behavior),
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
        ...(slots ? { slots } : {}),
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
        return { default_locale: eff.default_locale, available_locales: eff.available };
      })(),
      recording,
      provider_ready,
      departments,
    },
  };
}

/**
 * The International edition's logo direction for the call widget: the one the
 * workspace's chat widget wears (its template option `logoDirection`, from
 * the cached chat snapshot), `thread` otherwise and whenever it cannot be read.
 */
async function readCallLogoDirection(config: ServerConfig, workspaceId: string): Promise<'open' | 'thread'> {
  try {
    const template = await workspaceChatTemplate(config, workspaceId);
    return (template?.options as { logoDirection?: unknown } | undefined)?.logoDirection === 'open' ? 'open' : 'thread';
  } catch {
    return 'thread';
  }
}

/** The zone callback hours are in when they name none: Tehran in Iran (and unknown), UTC abroad. */
function callbackDefaultTimeZone(edition: Edition | null): string {
  return edition === 'international' ? 'UTC' : 'Asia/Tehran';
}

/** The statuses of a callback that still holds its time (the partial index idx_callback_requests_scheduled_for). */
const OPEN_CALLBACK_STATUSES = ['requested', 'scheduled', 'in_progress'];

/**
 * The workspace's callback slots now, or null while slots are off (or its
 * hours fail the strict shape, or name no interval). With a capacity, the
 * open callbacks booked in the slots' range are counted in one query.
 */
async function loadCallbackSlots(
  config: ServerConfig,
  ws: WorkspaceCallCenterSettings,
  design: CallWidgetDesignSettings,
  edition: Edition | null,
  now: number,
): Promise<CallbackSlot[] | null> {
  const hours = callbackSlotHours(design.callback_slots_enabled, ws.business_hours);
  if (!hours) return null;
  const input = {
    hours,
    slotMinutes: design.callback_slot_minutes,
    daysAhead: design.callback_days_ahead,
    capacity: design.callback_slot_capacity,
    now,
    defaultTimeZone: callbackDefaultTimeZone(edition),
  };
  const slots = computeCallbackSlots(input);
  if (design.callback_slot_capacity == null || !slots.length) return slots;
  const from = new Date(Date.parse(slots[0].at) - 60_000).toISOString();
  const to = new Date(Date.parse(slots[slots.length - 1].at) + design.callback_slot_minutes * 60_000).toISOString();
  const { data, error } = await getServiceClient(config)
    .from('callback_requests')
    .select('scheduled_for')
    .eq('workspace_id', ws.workspace_id)
    .in('status', OPEN_CALLBACK_STATUSES)
    .gte('scheduled_for', from)
    .lt('scheduled_for', to)
    .limit(5000);
  // Unreadable bookings: the slots without them (the capacity is a soft
  // limit, and the booking re-checks); never a failed bootstrap.
  if (error) {
    console.warn('[call-widget] callback bookings read failed:', error.message || error);
    return slots;
  }
  const booked = ((data || []) as Array<{ scheduled_for: string | null }>).map((r) => r.scheduled_for);
  return computeCallbackSlots({ ...input, booked });
}

/**
 * The shared font stylesheet's URL. The call widget does NOT hard-code a font
 * path: it consumes the same immutable descriptor asset the chat widget
 * resolves, so the bytes exist exactly once and are cached once. (A built
 * l.js names its own image's copy and uses this only as a fallback.)
 */
function callWidgetFontStyleUrl(fontName: string | null, loaderAssetBase: string | null): string | null {
  if (!fontName) return null;
  const base = resolveWidgetAssetBase({
    widgetBaseUrl: null,
    widgetLoaderBaseUrl: null,
    widgetPublicBaseUrl: null,
    assetBaseUrl: null,
    loaderAssetBase,
  });
  // Relative when no explicit asset base is configured — the runtime
  // resolves it against its own origin, exactly like its other assets.
  return base ? `${base}/widget/${fontName}` : `/widget/${fontName}`;
}

callWidgetRouter.get('/bootstrap', async (req, res) => {
  const config = serverConfigOf(req);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store');
  const query = {
    workspaceId: req.query.workspaceId ? String(req.query.workspaceId) : undefined,
    publicKey: req.query.publicKey ? String(req.query.publicKey) : undefined,
  };
  if (query.publicKey ? !BOOTSTRAP_PUBLIC_KEY_RE.test(query.publicKey) : !BOOTSTRAP_UUID_RE.test(query.workspaceId || '')) {
    return res.status(404).json({ error: 'workspace_not_found' });
  }
  const pub = await loadPublicBootstrap(config, query);
  if (!pub) return res.status(404).json({ error: 'workspace_not_found' });
  if (pub.disabled || !pub.ws) return res.json(pub.disabled);
  const ws = pub.ws;
  const origin = getOrigin(req);
  if (!(await callOriginAllowed(config, ws, origin))) {
    return res.status(403).json({ status: 'error', reason: 'origin_denied' });
  }
  // Without a visitor cookie this request mints a visitor (and a
  // visitor_sessions row counted against the monthly quota): per (IP,
  // workspace) cap, before any of it happens.
  if (!takeAnonymousCallBootstrap(req as unknown as ExpressRequest, res, ws.workspace_id)) return;
  const session = signWidgetSession(config, {
    workspace_id: ws.workspace_id,
    public_key: ws.public_key,
    origin,
  });
  // The visitor: dvsid cookie shared with the chat widget, the Online
  // Visitors row, and the contact to pre-fill the pre-call form with. A
  // valid presence ticket (presenceTicket.ts) means all of it was settled
  // under a minute ago on this network: no visitor query then.
  let visitorBlock: { id: string; contact: { id: string; name: string | null; email: string | null; phone: string | null } | null } | null = null;
  let resolvedVisitorId: string | null = null;
  let scanForCall = false;
  try {
    const { visitorId, isNew } = resolveVisitorIdentity(req, res, ws.workspace_id);
    resolvedVisitorId = visitorId;
    const ipHash = hashIp(getClientIp(req as unknown as ExpressRequest));
    const ticket = isNew ? null : readPresenceTicket(req as unknown as ExpressRequest, config, { workspaceId: ws.workspace_id, visitorId, ipHash });
    // A contact identified meanwhile on the chat widget arrives with a new
    // continuity cookie: an anonymous ticket does not cover it.
    const ticketHolds = !!ticket && !(ticket.c === null && readContinuityCookie(req));
    let contact: { id: string; name: string | null; email: string | null; phone: string | null } | null = null;
    if (ticketHolds) {
      contact = ticket!.c ? await findContactById(config, ticket!.c) : null;
    } else {
      // A visitor id minted just now has no session, contact or call yet.
      scanForCall = !isNew;
      const sessionRowId = await ensureVisitorSessionRow(config, ws.workspace_id, visitorId, origin, origin, req as unknown as ExpressRequest);
      contact =
        (isNew ? null : await findLinkedContactForVisitor(config, ws.workspace_id, visitorId)) ||
        await restoreContactFromContinuityCookie(req, config, ws.workspace_id, visitorId);
      // Re-pin contact_id (cheap, idempotent) so a returning identified
      // visitor is never shown as Anonymous.
      if (contact) {
        const sbPin = getServiceClient(config);
        await sbPin
          .from('visitor_sessions')
          .update({ contact_id: contact.id })
          .eq('workspace_id', ws.workspace_id)
          .eq('visitor_id', visitorId)
          .is('contact_id', null);
        await issueContinuityCookieForContact(req, res, config, ws.workspace_id, contact.id);
      }
      if (sessionRowId) {
        issuePresenceTicket(res, req as unknown as ExpressRequest, config, {
          w: ws.workspace_id, v: visitorId, s: sessionRowId, h: ipHash, c: contact?.id ?? null,
        });
      }
    }
    visitorBlock = {
      id: visitorId,
      contact: contact
        ? { id: contact.id, name: contact.name, email: contact.email, phone: contact.phone }
        : null,
    };
  } catch (e) {
    console.warn('[call-widget/bootstrap] visitor resolve failed:', e?.message || e);
  }
  // Resume in-flight call across page refresh / navigation: a non-terminal
  // call_session named by the x-cc-active-call header or the dvccall cookie,
  // or (on a full pass) found by visitor id, gets a session token bound to
  // that call_id so the widget keeps polling status without a new queue entry.
  let activeCall: Awaited<ReturnType<typeof buildActiveCallPayload>> = null;
  try {
    activeCall = await buildActiveCallPayload(config, req, res, ws, origin, resolvedVisitorId, { scanByVisitor: scanForCall });
  } catch (e) {
    console.warn('[call-widget/bootstrap] active_call lookup failed:', e?.message || e);
  }
  // The URLs that carry the loader's asset origin (a query parameter):
  // built per request, outside the memo.
  const loaderAssetBase = getLoaderAssetBase(req as ExpressRequest);
  const intlBrand = pub.brand
    ? buildCallWidgetBrand(pub.brand, loaderAssetBase)
    : null;
  const poweredBy = intlBrand ? intlBrand.poweredBy : undefined;
  // Whether an operator is available (always), and who (only for the
  // launchers that draw them): its own 30 s memo, no query on a hit.
  const withOperators = callLauncherNeedsPresence(pub.launcherStyle);
  const presence = await loadPublicCallPresence(config, ws.workspace_id, { withOperators });
  res.json({
    status: 'ok',
    session,
    ...pub.body,
    presence: withOperators
      ? { any_available: presence.any_available, operators: presence.operators }
      : { any_available: presence.any_available },
    ...(intlBrand ? { platform_brand: { names: intlBrand.names } } : {}),
    ...(poweredBy !== undefined ? { powered_by: poweredBy } : {}),
    assets: { font_style_url: callWidgetFontStyleUrl(pub.fontName, loaderAssetBase), ...pub.body.assets },
    visitor: visitorBlock,
    active_call: activeCall,
  });
});

/** What readCallWidgetBrand read: the International edition's credit, before its logo URL. */
type CallWidgetBrandRows = {
  names: Record<string, string>;
  footer: { brand: string; url: string | null } | null;
  /** widget_platform_settings.powered_by_brand_text is set: one name for every language. */
  override: boolean;
  /** The platform's widget asset origins (widget_platform_settings). */
  bases: { widgetBaseUrl?: string | null; widgetLoaderBaseUrl?: string | null; widgetPublicBaseUrl?: string | null };
  /** The workspace's logo direction (the chat widget's), for the credit's lockup. */
  logoDirection?: 'open' | 'thread' | null;
  /** The logo the Super Admin uploaded (absolute), over the kit's lockups. */
  customLogo?: string | null;
};

/**
 * The International edition's brand for the call widget, as stored: the
 * platform's name per language, and whether and how the "powered by" line
 * shows. Read errors keep the line, with whatever name could be read, like
 * the chat widget's footer.
 */
async function readCallWidgetBrand(
  config: ServerConfig,
  workspaceId: string,
): Promise<CallWidgetBrandRows> {
  const sb = getServiceClient(config);
  const [platformWidget, localized, planAllows] = await Promise.all([
    sb.from('widget_platform_settings')
      .select('powered_by_enabled, powered_by_text, powered_by_brand_text, powered_by_url, widget_asset_base_url, widget_loader_base_url, widget_public_base_url')
      .limit(1).maybeSingle()
      .then((r) => (r.error ? null : (r.data as Record<string, unknown> | null)), () => null),
    sb.from('platform_branding_localized').select('locale, platform_name')
      .then((r) => (r.error ? [] : ((r.data ?? []) as Array<{ locale?: unknown; platform_name?: unknown }>)), () => []),
    isPoweredByAllowedForPlan(sb, workspaceId),
  ]);
  const brands: Record<string, string> = {};
  for (const row of localized) {
    const name = typeof row.platform_name === 'string' ? row.platform_name.trim() : '';
    if (typeof row.locale === 'string' && name) brands[row.locale] = name;
  }
  const footer = buildPoweredByConfig(platformWidget, brands.en || Object.values(brands)[0] || '', planAllows);
  return {
    names: brands,
    footer: footer ? { brand: footer.brand, url: footer.url } : null,
    // A platform-wide brand text names the platform in every language.
    override: !!String(platformWidget?.powered_by_brand_text || '').trim(),
    bases: {
      widgetBaseUrl: platformWidget?.widget_asset_base_url as string | null | undefined,
      widgetLoaderBaseUrl: platformWidget?.widget_loader_base_url as string | null | undefined,
      widgetPublicBaseUrl: platformWidget?.widget_public_base_url as string | null | undefined,
    },
  };
}

/**
 * The International edition's brand for the call widget: the platform's name
 * per language, and the "powered by" payload:
 * null (no line) when the platform switch or the workspace's plan hides it;
 * otherwise the platform's name per widget language (platform_branding_
 * localized, or widget_platform_settings.powered_by_brand_text for every
 * language), the optional link and the logo.
 */
function buildCallWidgetBrand(
  rows: CallWidgetBrandRows,
  loaderAssetBase: string | null,
): {
  names: Record<string, string>;
  poweredBy: { brand: string; brands: Record<string, string>; url: string | null; logo: string; custom?: true } | null;
} {
  if (!rows.footer) return { names: rows.names, poweredBy: null };
  // The platform's logo (the RESPOK kit's horizontal mark, "color" variant
  // for the widget's light surface), from the frontend that serves /brand.
  // Absolute when the widget asset origin is known; otherwise a path the
  // runtime resolves against the origin it was loaded from.
  const assetBase = resolveWidgetAssetBase({ ...rows.bases, assetBaseUrl: null, loaderAssetBase });
  const logo = `${assetBase ?? ''}${INTL_BRAND.horizontal.light}`;
  // The Open lockup when the workspace's widgets wear the Open logo (as the
  // chat widget's credit does), so the footer agrees with the launcher.
  const lockup = rows.logoDirection === 'open' ? `${assetBase ?? ''}${INTL_BRAND.horizontalOpen.light}` : logo;
  const brands = rows.override ? {} : rows.names;
  if (rows.customLogo) {
    return { names: rows.names, poweredBy: { brand: rows.footer.brand, brands, url: rows.footer.url, logo: rows.customLogo, custom: true } };
  }
  return {
    names: rows.names,
    poweredBy: { brand: rows.footer.brand, brands, url: rows.footer.url, logo: lockup },
  };
}

// Helper: extract widget session
function getSession(req, config: ServerConfig) {
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
  const config = serverConfigOf(req);
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
  if (!(await callOriginAllowed(config, ws, getOrigin(req)))) return res.status(403).json({ error: 'origin_denied' });
  // The page the visitor was on, kept only on the site the widget runs on:
  // the Call Center links to it (shared/callCenter/visitorPageUrl.ts).
  const pageUrl = visitorPageUrl(parsed.data.page_url, getOrigin(req))?.href ?? null;
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
        ? !!dept.cc_voice_enabled
        : !!dept.cc_video_enabled;
      if (!ok) return res.status(400).json({ error: 'department_channel_disabled' });
    } else {
      // Fall back to workspace default_department_id only if it has the required channel.
      const defId = ws.default_department_id as string | null;
      if (defId) {
        const { data: dept } = await sbDept
          .from('workspace_departments')
          .select('id, cc_voice_enabled, cc_video_enabled')
          .eq('workspace_id', ws.workspace_id)
          .eq('id', defId)
          .maybeSingle();
        const ok = !!dept && (dbCallTypeForDept === 'audio'
          ? !!dept.cc_voice_enabled
          : !!dept.cc_video_enabled);
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
      page_url: pageUrl,
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
  } catch (e) {
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
    page_url: pageUrl,
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
  let call = null;
  let callErr = null;
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
    } catch (thrown) {
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
    payload: { call_type: parsed.data.call_type, page_url: pageUrl },
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
  } catch (e) { /* best-effort: queue entry already created */ }

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
  const config = serverConfigOf(req);
  const guard = requireWidgetSession(req, config);
  if (!guard.ok) return res.status(guard.status).json({ error: guard.error });
  const session = guard.session;
  if (session.call_id !== req.params.id) return res.status(403).json({ error: 'forbidden' });
  const sb = getServiceClient(config);
  // Preserve detailed reason in metadata; constraint allows only the four canonical end_reason values.
  const { data: prev } = await sb.from('call_sessions')
    .select('metadata, connected_at, started_at, created_at, state')
    .eq('id', req.params.id).maybeSingle();
  const prevMeta = (prev?.metadata as Record<string, unknown>) || {};
  // If the call had already connected to an operator, treat the visitor
  // hangup as a normal "ended" call and compute duration_seconds from the
  // earliest known anchor. Otherwise it's a true pre-connect cancel.
  const anchorIso = prev?.connected_at
    || prev?.started_at
    || prev?.created_at
    || null;
  const wasConnected = !!prev?.connected_at;
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
  // The visitor gave up. Every phone still ringing for them has to stop, or
  // an operator answers a call that nobody is on the other end of.
  void cancelRing(config, {
    workspaceId: session.workspace_id,
    callSessionId: req.params.id,
    reason: wasConnected ? 'ended' : 'cancelled',
  });
  await publishCallEvent(config, session.workspace_id, req.params.id, wasConnected ? 'call_ended' : 'call_cancelled', { duration_seconds: wasConnected ? duration : null });
  clearActiveCallCookie(res, req);
  res.json({ ok: true });
});

// ── Status poll ───────────────────────────────────────────────────────────
callWidgetRouter.get('/calls/:id/status', async (req, res) => {
  const config = serverConfigOf(req);
  const guard = requireWidgetSession(req, config);
  if (!guard.ok) return res.status(guard.status).json({ error: guard.error });
  const session = guard.session;
  if (session.call_id !== req.params.id) return res.status(403).json({ error: 'forbidden' });
  const sb = getServiceClient(config);
  // What the visitor's widget reads, and nothing more: not the provider nor
  // its room (the join token names them, to this visitor only).
  const { data: call } = await sb.from('call_sessions')
    .select('id,state,ended_at,end_reason,call_type,recording_enabled,recording_state,assigned_agent_id,started_at,duration_seconds')
    .eq('id', req.params.id).maybeSingle();
  if (!call) return res.status(404).json({ error: 'not_found' });
  // The operator's own name, or null: never their e-mail or any part of it
  // (the widget then says "operator"). Never their role.
  let operator_name: string | null = null;
  const agentId = call.assigned_agent_id as string | null;
  if (agentId) {
    try {
      const { data: prof } = await sb.from('profiles')
        .select('full_name')
        .eq('id', agentId).maybeSingle();
      operator_name = operatorOwnName(prof?.full_name);
    } catch {/* ignore */}
  }
  // Compute live queue position + ETA from the queue table, not from
  // call_sessions.state. Widget calls are created as `pending` while their
  // queue row is `queued/offered`, so gating this on call.state === `queued`
  // leaves visitors stuck with the initial position forever.
  let position: number | null = null;
  let eta_seconds: number | null = null;
  const callState = String(call.state || '');
  if (call && !['cancelled', 'ended', 'missed', 'failed', 'active', 'ringing', 'connecting'].includes(callState)) {
    const { data: entry } = await sb.from('call_queue_entries')
      .select('id,created_at,workspace_id,channel,priority,state')
      .eq('call_session_id', req.params.id).maybeSingle();
    if (entry && ['queued', 'offered'].includes(String(entry.state || ''))) {
      const { data: activeRows } = await sb.from('call_queue_entries')
        .select('id,created_at,priority')
        .eq('workspace_id', entry.workspace_id)
        .eq('entry_source', 'call_widget')
        .in('state', ['queued', 'offered'])
        .order('priority', { ascending: false })
        .order('created_at', { ascending: true })
        .limit(500);
      const idx = (activeRows || []).findIndex((row) => row.id === entry.id);
      position = idx >= 0 ? idx + 1 : null;
      try {
        const platform = await getPlatformCallCenterSettings(config);
        const perPos = Math.max(5, platform.queue_eta_seconds_per_position || 45);
        eta_seconds = position ? Math.max(0, (position - 1)) * perPos + perPos : null;
      } catch { eta_seconds = position ? (position - 1) * 45 + 30 : null; }
    }
  }
  // The operator's user id never reaches the visitor: `assigned_agent_id`
  // keeps its name (an older engine compares it to notice a transfer) and
  // carries an opaque reference, the same for one operator on one call.
  res.json({
    call: {
      id: call.id,
      state: call.state,
      ended_at: call.ended_at,
      end_reason: call.end_reason,
      call_type: call.call_type,
      recording_enabled: call.recording_enabled,
      recording_state: call.recording_state,
      assigned_agent_id: agentId ? operatorReference(config, String(call.id), agentId) : null,
      started_at: call.started_at,
      duration_seconds: call.duration_seconds,
    },
    position,
    eta_seconds,
    operator_name,
  });
});

/**
 * The visitor's stand-in for the operator's user id on a call: the first 16
 * hex of HMAC-SHA256 under the widget-session secret, over a prefix that no
 * other use of that secret signs (`ccw-agent-ref:`), the call and the
 * operator. Stable while that operator has the call, different on another
 * call or for another operator, and never the id itself.
 */
function operatorReference(config: ServerConfig, callId: string, agentId: string): string {
  const secrets = config as ServerConfig & OptionalCookieSecrets;
  const key = secrets.widgetTokenSecret || secrets.sessionSecret || config.signingSecret || config.supabaseServiceRoleKey;
  return crypto.createHmac('sha256', key).update(`ccw-agent-ref:${callId}:${agentId}`).digest('hex').slice(0, 16);
}

// ── Visitor join token (only after operator accepts) ──────────────────────
callWidgetRouter.post('/calls/:id/join-token', async (req, res) => {
  const config = serverConfigOf(req);
  const guard = requireWidgetSession(req, config);
  if (!guard.ok) return res.status(guard.status).json({ error: guard.error });
  const session = guard.session;
  if (session.call_id !== req.params.id) return res.status(403).json({ error: 'forbidden' });
  // Re-check workspace origin allow-list (in case allowed_domains changed
  // between bootstrap and now).
  const wsForOrigin = await getOrCreateWorkspaceSettings(config, session.workspace_id);
  if (!(await callOriginAllowed(config, wsForOrigin, getOrigin(req)))) {
    return res.status(403).json({ error: 'origin_denied' });
  }
  const sb = getServiceClient(config);
  const { data: call } = await sb.from('call_sessions').select('*').eq('id', req.params.id).maybeSingle();
  if (!call) return res.status(404).json({ error: 'not_found' });
  const c = call as CallSessionRow;
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
  // The visitor is joining the call now: this is when it starts (duration and
  // billable minutes), not when the operator accepted. First writer wins, so a
  // reconnect keeps the original start.
  await markVisitorJoined(sb, c.id);
  res.json({
    token: tok.token,
    provider: c.provider,
    provider_room_id: c.provider_room_id,
    expires_at: tok.expiresAt,
    connect,
  });
});

/**
 * Stamps call_sessions.connected_at the first time the visitor joins, and
 * records it on the call's timeline. Idempotent: guarded on connected_at IS NULL.
 * Best-effort — a failure here never keeps the visitor out of the call.
 */
async function markVisitorJoined(sb: ReturnType<typeof getServiceClient>, callId: string): Promise<void> {
  try {
    const { data } = await sb.from('call_sessions')
      .update({ connected_at: new Date().toISOString() })
      .eq('id', callId)
      .is('connected_at', null)
      .select('id');
    if (Array.isArray(data) && data.length > 0) {
      await sb.from('call_events').insert({
        call_session_id: callId, event_type: 'visitor_joined', actor_type: 'visitor', actor_id: null, payload: {},
      });
    }
  } catch { /* best effort */ }
}

// ── Callback request ──────────────────────────────────────────────────────
/** A requested time this far in the past is still taken (the visitor was slow to submit). */
const CALLBACK_PAST_GRACE_MS = 2 * 60_000;
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
  const config = serverConfigOf(req);
  const guard = requireWidgetSession(req, config);
  if (!guard.ok) return res.status(guard.status).json({ error: guard.error });
  const session = guard.session;
  const ws = await getOrCreateWorkspaceSettings(config, session.workspace_id);
  if (!(await callOriginAllowed(config, ws, getOrigin(req)))) {
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
  // As for a call: only a page on the site the widget runs on.
  const pageUrl = visitorPageUrl(parsed.data.page_url, getOrigin(req))?.href ?? null;
  // ── Anti-spam enforcement ──────────────────────────────────────────────
  // 1) Honeypot — bots fill hidden fields. Silently 200 to avoid signal.
  if (platform.callback_honeypot_enabled && parsed.data.hp_company && parsed.data.hp_company.trim() !== '') {
    return res.json({
      ok: true,
      callback_id: 'hp_' + crypto.randomBytes(6).toString('hex'),
      scheduled_for: parsed.data.scheduled_for || null,
      channel: parsed.data.channel === 'video' ? 'video' : 'audio',
    });
  }
  // The callback's time: not in the past (two minutes for a slow submit) and
  // at most 30 days ahead.
  const nowMs = Date.now();
  const scheduledFor = parsed.data.scheduled_for || null;
  if (scheduledFor) {
    const at = Date.parse(scheduledFor);
    if (!Number.isFinite(at) || at < nowMs - CALLBACK_PAST_GRACE_MS || at > nowMs + CALLBACK_BOOKING_MAX_AHEAD_MS) {
      return res.status(400).json({ error: 'invalid_scheduled_for' });
    }
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
  const clientIp = getClientIp(req as ExpressRequest);
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
      const cookieVid = readVisitorCookie(req as ExpressRequest);
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
        const ageMs = Date.now() - new Date(recent.created_at).getTime();
        const retryAfter = Math.max(1, Math.ceil((cooldownSec * 1000 - ageMs) / 1000));
        return res.status(429).json({ error: 'cooldown_active', retry_after: retryAfter });
      }
    }
  }
  // While the workspace's slots are on, a time must be one of them, still
  // available now (the capacity is a soft limit: two visitors booking its
  // last place at the same instant may both get it).
  if (scheduledFor) {
    const design = callWidgetDesignSettings(ws);
    if (callbackSlotHours(design.callback_slots_enabled, ws.business_hours)) {
      const slots = await loadCallbackSlots(config, ws, design, await getPlatformEditionOrNull(config), nowMs);
      if (!slots || !isBookableSlot(slots, scheduledFor)) {
        return res.status(409).json({ error: 'slot_unavailable' });
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
    if (!dept.cc_callback_enabled) {
      return res.status(400).json({ error: 'department_channel_disabled' });
    }
  } else {
    const defId = ws.default_department_id as string | null;
    if (defId) {
      const { data: dept } = await sb
        .from('workspace_departments')
        .select('id, cc_callback_enabled')
        .eq('workspace_id', ws.workspace_id)
        .eq('id', defId)
        .maybeSingle();
      if (dept && dept.cc_callback_enabled) cbDepartmentId = defId;
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
        page_url: pageUrl,
      },
    );
    cbIdentity = {
      visitorId: identity.visitorId,
      visitorSessionId: identity.visitorSessionId,
      contactId: identity.contactId,
    };
  } catch (e) {
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
    scheduled_for: scheduledFor,
    metadata: {
      source: 'call_widget',
      name: parsed.data.name || null,
      subject: parsed.data.subject || null,
      message: parsed.data.message || null,
      urgency: parsed.data.urgency || 'normal',
      page_url: pageUrl,
      department_id: cbDepartmentId,
      visitor_id: cbIdentity?.visitorId ?? null,
      contact_id: cbIdentity?.contactId ?? null,
      ip_hash: ipHash,
    },
  }).select('*').maybeSingle();
  if (error) return res.status(500).json({ error: 'callback_create_failed', message: error.message });
  await publishQueueEvent(config, ws.workspace_id, 'callback_requested', { callback_id: data!.id });
  void notifyCallbackRequest(config, {
    workspaceId: ws.workspace_id,
    callbackId: data!.id,
    visitorName: parsed.data.name || null,
  });
  // The time and channel as stored: the widget keeps them for the booked
  // callback's launcher.
  const storedAt = data!.scheduled_for ? Date.parse(String(data!.scheduled_for)) : NaN;
  res.json({
    ok: true,
    callback_id: data!.id,
    scheduled_for: Number.isFinite(storedAt) ? new Date(storedAt).toISOString() : (data!.scheduled_for ?? null),
    channel: data!.channel ?? (parsed.data.channel === 'video' ? 'video' : 'audio'),
  });
});

// ── Post-call rating submitted by the visitor (1–5 stars + optional comment)
const ratingSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(1000).optional().nullable(),
});
callWidgetRouter.post('/calls/:id/rate', async (req, res) => {
  const config = serverConfigOf(req);
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
      workspace_id: call.workspace_id,
      rating: parsed.data.rating,
      comment: parsed.data.comment || null,
    }, { onConflict: 'call_session_id' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'rating_failed', message: String(e?.message || e) });
  }
});
