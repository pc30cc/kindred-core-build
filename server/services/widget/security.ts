/**
 * Widget Security — HMAC Session Tokens, Rate Limiting, Origin Enforcement
 *
 * - HMAC session tokens with nonce (short-lived, origin-bound)
 * - Single auth header: x-widget-token (the same token may ride in the body
 *   of /track and /visitor-presence only — see readWidgetToken)
 * - Fail-closed origin validation
 * - In-memory rate limiting (production-safe)
 * - Strict conversation ownership verification
 */

import { Request, Response, NextFunction } from 'express';
import { getClientIp as resolveClientIp } from '../../utils/clientIp.js';
import crypto from 'crypto';
import { getServiceClient } from '../../supabase.js';
import type { ServerConfig } from '../../config.js';
import { readVisitorCookie } from './visitorIdentity.js';
import { platformSigningSecret } from '../../lib/platformSecret.js';

/** What requireWidgetSession() leaves on the request for later middleware. */
interface WidgetSessionRequest extends Request {
  _widgetWorkspaceId?: string;
  _widgetSessionOrigin?: string;
  _widgetToken?: string;
  _widgetNonce?: string;
  _widgetRateLimitTrust?: WidgetRateLimitTrust;
}

// ─── Session Token Config ───
const SESSION_TOKEN_TTL_SECONDS = 900; // 15 minutes
const SESSION_TOKEN_PREFIX = 'wss_';
const REFRESH_GRACE_PERIOD_SECONDS = 5 * 60; // 5 min grace for expired tokens

function getSigningSecret(): Buffer {
  const base = platformSigningSecret() || process.env.WIDGET_SIGNING_SECRET || '';
  return crypto.createHash('sha256').update('widget-session:' + base).digest();
}

/**
 * Rate-limit trust class — orthogonal to cryptographic validity.
 *
 * A valid HMAC on a session token proves only "our server issued this token
 * at some point for workspace X". It does NOT prove the caller who obtained
 * it was a legitimate browser visitor, because bootstrap's own inputs
 * (workspace_id, Origin/Referer) are ordinary request data a non-browser
 * attacker can set to any value, including a real victim's own domain. See
 * createSessionToken()'s doc comment.
 *
 *   'public'    — issued from bootstrap's own (spoofable) proof. Good enough
 *                 for normal per-IP / per-session functional rate limits,
 *                 but must NEVER be treated as sufficient to select the
 *                 shared per-workspace hard-blocking bucket
 *                 (`resolveTrustedRateLimitWorkspaceId` in
 *                 server/middleware/security.ts) — a workspace UUID is
 *                 public/guessable, so that bucket must only be reachable by
 *                 proof an attacker cannot fabricate.
 *   'workspace' — reserved for a future stronger-proof escalation path
 *                 (e.g. a challenge). Nothing in this codebase issues
 *                 'workspace' today — bootstrap always signs 'public'. The
 *                 claim exists now so escalation has an explicit,
 *                 server-signed home instead of being inferred from "HMAC
 *                 verified" alone.
 */
export type WidgetRateLimitTrust = 'public' | 'workspace';

export interface TokenResult {
  valid: boolean;
  reason?: string;
  workspaceId?: string;
  origin?: string;
  nonce?: string;
  issuedAt?: number;
  expiresAt?: number;
  wasExpired?: boolean;
  rateLimitTrust?: WidgetRateLimitTrust;
}

/**
 * Create a short-lived HMAC session token with unique nonce.
 *
 * This is the ONLY chat-widget session signer, and it always signs
 * `rl: 'public'` — hard-coded, not a parameter. There is deliberately no way
 * for a production caller to request a stronger trust class: until a real
 * stronger-proof flow exists (see WidgetRateLimitTrust's doc comment), no
 * code path in this codebase may mint a 'workspace'-trusted token, and that
 * must hold even if a future call site is written carelessly. If a genuine
 * escalation path is ever built, give it its own explicitly-named signer
 * rather than widening this one. The signature proves "server-issued", not
 * "legitimate browser visitor"; `origin` is whatever Origin/Referer the
 * caller sent and is preserved for cross-origin replay binding, not as
 * identity proof.
 *
 * `options.sessionNonce` is INTERNAL — only /session/refresh
 * (server/routes/widget.ts) passes it, threading through the nonce it
 * already extracted via verifyTokenForRefresh() on the CALLER'S OWN current
 * token. This makes `n` a stable "session lineage" id across refreshes (one
 * logical widget session → one rate-limit identity, per
 * widgetSessionRateLimiter in server/middleware/security.ts) instead of a
 * new, unrelated identity on every refresh. Never source this value from
 * request body/query/headers directly — it must only ever be a value THIS
 * module already verified. Bootstrap never passes it, so every new logical
 * session still starts with a fresh random nonce. (Wrapped in an options
 * object, not a bare positional string, specifically so a stale call site
 * from before this signature change fails to compile instead of silently
 * being reinterpreted with different semantics.)
 */
export function createSessionToken(
  workspaceId: string,
  origin: string,
  options?: { sessionNonce?: string },
): string {
  const now = Math.floor(Date.now() / 1000);
  const nonce = options?.sessionNonce || crypto.randomBytes(8).toString('hex');
  const payload = {
    w: workspaceId,
    o: origin || '',
    n: nonce,
    iat: now,
    exp: now + SESSION_TOKEN_TTL_SECONDS,
    rl: 'public' as const,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', getSigningSecret()).update(payloadB64).digest('base64url');
  return `${SESSION_TOKEN_PREFIX}${payloadB64}.${sig}`;
}

/**
 * Verify a session token. Returns structured result.
 */
export function verifySessionToken(token: string, options?: { skipExpiry?: boolean }): TokenResult {
  const skipExpiry = options?.skipExpiry ?? false;

  if (!token || typeof token !== 'string' || !token.startsWith(SESSION_TOKEN_PREFIX)) {
    return { valid: false, reason: 'invalid_format' };
  }

  const raw = token.slice(SESSION_TOKEN_PREFIX.length);
  const dotIdx = raw.lastIndexOf('.');
  if (dotIdx < 1) return { valid: false, reason: 'invalid_structure' };

  const payloadB64 = raw.slice(0, dotIdx);
  const sig = raw.slice(dotIdx + 1);

  // Verify HMAC — timing-safe comparison
  const expectedSig = crypto.createHmac('sha256', getSigningSecret()).update(payloadB64).digest('base64url');
  if (sig.length !== expectedSig.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
    return { valid: false, reason: 'invalid_signature' };
  }

  // The claims createSessionToken() signs. `rl` stays unknown: see below.
  let payload: { w?: string; o?: string; n?: string; iat?: number; exp?: number; rl?: unknown };
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
  } catch {
    return { valid: false, reason: 'invalid_payload' };
  }

  // Backward-compat: a token signed before the `rl` claim existed (or any
  // value other than the one trust class bootstrap can ever actually issue
  // today) parses as 'public' — the safe floor. This can only ever fail to
  // LOWER trust, never escalate it: nothing downstream grants more than
  // 'public' gets, so an old/missing/malformed claim silently downgrading
  // to 'public' is a no-op today and stays that way even once a 'workspace'
  // path exists — that path must still require the claim to literally
  // equal 'workspace'.
  const rateLimitTrust: WidgetRateLimitTrust = payload.rl === 'workspace' ? 'workspace' : 'public';

  const now = Math.floor(Date.now() / 1000);
  if (!skipExpiry && (!payload.exp || payload.exp < now)) {
    return {
      valid: false,
      reason: 'expired',
      workspaceId: payload.w,
      origin: payload.o,
      nonce: payload.n,
      issuedAt: payload.iat,
      expiresAt: payload.exp,
      rateLimitTrust,
    };
  }

  return {
    valid: true,
    workspaceId: payload.w,
    origin: payload.o,
    nonce: payload.n,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
    rateLimitTrust,
  };
}

/**
 * Verify a token for refresh purposes.
 * Allows recently-expired tokens within the grace period.
 */
export function verifyTokenForRefresh(token: string): TokenResult {
  const result = verifySessionToken(token);
  if (result.valid) return result;

  if (result.reason === 'expired' && result.expiresAt) {
    const now = Math.floor(Date.now() / 1000);
    if ((now - result.expiresAt) <= REFRESH_GRACE_PERIOD_SECONDS) {
      const sigCheck = verifySessionToken(token, { skipExpiry: true });
      if (sigCheck.valid) {
        return { ...sigCheck, wasExpired: true };
      }
    }
    return { valid: false, reason: 'expired_beyond_grace' };
  }

  return { valid: false, reason: result.reason || 'invalid' };
}

// ─── In-memory Rate Limiting ───
/**
 * Per-category caps, requests per `window` seconds, each counted in its own
 * bucket (see widgetRateLimit below for how a request picks its buckets):
 *
 *   visitor    one verified visitor (HMAC-signed, workspace-bound dvsid
 *              cookie): what a single browser may do.
 *   anonymous  one (IP, workspace) for requests WITHOUT such a cookie: first
 *              visits, browsers that block third-party cookies (Safari), and
 *              anything that is not a browser. It also bounds how many new
 *              cookies one address can mint per workspace (bootstrap).
 *   shared     one (IP, workspace) for every cookie-identified request
 *              together: room for a whole carrier-grade NAT of real
 *              visitors, and a ceiling on what cookies minted earlier from
 *              that address can buy. `message` and `upload` (AI and storage
 *              cost, OTP mail) get 4x their anonymous cap, the rest 10x.
 *
 * `config` (GET /config, /manifest, /call-channels) is separate from
 * `bootstrap` (POST /bootstrap only): an older loader asked both on every
 * page view and drained one bucket twice.
 */
interface RateLimitCaps { window: number; visitor: number; anonymous: number; shared: number }
const RATE_LIMITS: Record<string, RateLimitCaps> = {
  bootstrap: { window: 60, visitor: 30, anonymous: 300, shared: 3000 },
  config:    { window: 60, visitor: 20, anonymous: 600, shared: 6000 },
  poll:      { window: 60, visitor: 60, anonymous: 600, shared: 6000 },
  message:   { window: 60, visitor: 15, anonymous: 60,  shared: 240 },
  upload:    { window: 60, visitor: 10, anonymous: 40,  shared: 160 },
  refresh:   { window: 60, visitor: 20, anonymous: 200, shared: 2000 },
  default:   { window: 60, visitor: 30, anonymous: 300, shared: 3000 },
};

const rateLimitStore = new Map<string, { count: number; resetAt: number }>();
/** Bound of the store: past it, expired buckets go first, then the oldest. */
const RATE_LIMIT_STORE_MAX = 200_000;

// Cleanup expired entries every 30s
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of rateLimitStore) {
    if (now > val.resetAt) rateLimitStore.delete(key);
  }
}, 30_000).unref?.();

function boundRateLimitStore(now: number): void {
  if (rateLimitStore.size < RATE_LIMIT_STORE_MAX) return;
  for (const [key, val] of rateLimitStore) {
    if (now > val.resetAt) rateLimitStore.delete(key);
  }
  // Map order is insertion order: the oldest windows are dropped first.
  for (const key of rateLimitStore.keys()) {
    if (rateLimitStore.size < RATE_LIMIT_STORE_MAX * 0.9) break;
    rateLimitStore.delete(key);
  }
}

interface RateLimitBucket { key: string; max: number }

/**
 * Take one request from every bucket, or from none: a request refused by one
 * bucket is not counted in the others. Returns the seconds until the fullest
 * refusing bucket resets (>= 1), or 0 when the request may pass.
 */
function takeRateLimit(buckets: RateLimitBucket[], windowSeconds: number): number {
  const now = Date.now();
  let retryAfterMs = 0;
  for (const b of buckets) {
    const entry = rateLimitStore.get(b.key);
    if (entry && now <= entry.resetAt && entry.count >= b.max) {
      retryAfterMs = Math.max(retryAfterMs, entry.resetAt - now);
    }
  }
  if (retryAfterMs > 0) return Math.max(1, Math.ceil(retryAfterMs / 1000));
  for (const b of buckets) {
    const entry = rateLimitStore.get(b.key);
    if (!entry || now > entry.resetAt) {
      boundRateLimitStore(now);
      rateLimitStore.set(b.key, { count: 1, resetAt: now + windowSeconds * 1000 });
    } else {
      entry.count++;
    }
  }
  return 0;
}

/** Test-only: forget every bucket. */
export function __resetWidgetRateLimitsForTests(): void {
  rateLimitStore.clear();
}

/**
 * Canonical client IP resolver — re-exported so widget routes have a single
 * implementation. Previously this file had its own extractor that trusted
 * `x-forwarded-for` / `cf-connecting-ip` unconditionally, which let a direct
 * caller rotate its rate-limit bucket by sending a forged header.
 */
export { getClientIp } from '../../utils/clientIp.js';

/** The conversation columns verifyConversationOwnership reads and returns. */
export interface OwnedConversation {
  id: string;
  status: string;
  assigned_to: string | null;
  updated_at: string;
  contact_id: string | null;
  visitor_session_id: string | null;
  workspace_id: string;
  metadata: ({ visitor_id?: string } & Record<string, unknown>) | null;
}

/** Rate-limit bucket key: the real IP, or a shared 'unknown' bucket. */
function rateLimitIpKey(req: Request): string {
  return resolveClientIp(req) ?? 'unknown';
}

function getRequestOrigin(req: Request): string | null {
  const origin = req.headers['origin'];
  if (typeof origin === 'string' && origin.length > 0) return origin;
  const referer = req.headers['referer'];
  if (typeof referer === 'string') {
    try { return new URL(referer).origin; } catch { return null; }
  }
  return null;
}

/**
 * The two widget calls of a page view that may carry the session token in
 * their JSON body instead of the X-Widget-Token header: POST /api/widget/track
 * and POST /api/realtime/visitor-presence. With no custom header and a
 * text/plain body (server/middleware/bodyParsers.ts) they are CORS-simple, so
 * the browser sends no preflight. The loader does this only for a backend
 * whose bootstrap said `protocol` >= 3 (public/widget/loader.js tokenPost).
 */
const BODY_TOKEN_PATH = /^\/api\/(?:widget\/track|realtime\/visitor-presence)\/?$/i;

/** The body field that carries the token on those two paths. */
export const WIDGET_BODY_TOKEN_FIELD = 'widget_token';

export function acceptsBodyWidgetToken(path: string): boolean {
  return BODY_TOKEN_PATH.test(path);
}

/**
 * The widget session token a request presents: the X-Widget-Token header,
 * else — on the two paths above only, for a POST — the `widget_token` body
 * field. Every layer that reads the token (this gate, widgetCorsMiddleware,
 * the per-session and workspace rate limiters, visitor-presence) reads it
 * here, so the body form is verified by the same function, bound to the same
 * Origin and counted in the same session bucket as the header. Never from the
 * query string (URLs end up in logs).
 */
export function readWidgetToken(req: Request): string | null {
  const raw = req.headers?.['x-widget-token'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header === 'string' && header) return header;
  if (req.method !== 'POST') return null;
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  if (!acceptsBodyWidgetToken(path)) return null;
  const fromBody = (req.body as Record<string, unknown> | undefined)?.[WIDGET_BODY_TOKEN_FIELD];
  return typeof fromBody === 'string' && fromBody ? fromBody : null;
}

// ─── Middleware: Session token enforcement ───
export function enforceWidgetToken(req: Request, res: Response, next: NextFunction) {
  const token = readWidgetToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Widget authentication required', code: 'MISSING_TOKEN' });
  }

  const result = verifySessionToken(token);
  if (!result.valid) {
    return res.status(403).json({
      error: result.reason === 'expired' ? 'Session expired — please refresh' : 'Invalid session token',
      code: result.reason === 'expired' ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN',
    });
  }

  const ctx = req as WidgetSessionRequest;
  ctx._widgetWorkspaceId = result.workspaceId;
  ctx._widgetSessionOrigin = result.origin;
  ctx._widgetToken = token;
  ctx._widgetNonce = result.nonce;
  ctx._widgetRateLimitTrust = result.rateLimitTrust;
  next();
}

// ─── Middleware: Origin enforcement (FAIL CLOSED) ───
export function enforceOrigin(req: Request, res: Response, next: NextFunction) {
  const workspaceId = (req as WidgetSessionRequest)._widgetWorkspaceId;
  if (!workspaceId) return next();

  const requestOrigin = getRequestOrigin(req);
  const sessionOrigin = (req as WidgetSessionRequest)._widgetSessionOrigin;

  if (sessionOrigin && requestOrigin) {
    const tokenOrigin = sessionOrigin.toLowerCase().replace(/\/+$/, '');
    const reqOrigin = requestOrigin.toLowerCase().replace(/\/+$/, '');
    if (tokenOrigin && tokenOrigin !== reqOrigin) {
      console.warn(`[widget-security] Origin mismatch: token=${tokenOrigin}, request=${reqOrigin}`);
      return res.status(403).json({ error: 'Origin mismatch', code: 'ORIGIN_MISMATCH' });
    }
  }

  if (!requestOrigin && sessionOrigin) {
    return res.status(403).json({ error: 'Origin required', code: 'MISSING_ORIGIN' });
  }

  // NOTE: this middleware deliberately does NOT write CORS headers. All
  // Access-Control-* headers for widget routes are owned by exactly one
  // place — widgetCorsMiddleware (server/middleware/widgetCors.ts) — which
  // verifies the origin against the workspace allow-list before echoing it.
  // Writing them here as well used to overwrite that decision with an
  // unconditional echo (a fail-open widening) and, on the refresh path,
  // produced a partial contract (ACAO without Allow-Credentials) that the
  // browser rejects. Do not re-add header writes to this function.

  next();
}


/**
 * The workspace a rate-limit bucket is scoped to: the token's (server-signed)
 * when the token gate already ran, else the one the body names. A bounded
 * string, so an oversized or non-string body value cannot blow up the key.
 */
function rateLimitWorkspaceKey(req: Request): string {
  const ws = (req as WidgetSessionRequest)._widgetWorkspaceId || (req.body as { workspace_id?: unknown } | undefined)?.workspace_id;
  return typeof ws === 'string' && ws && ws.length <= 64 ? ws : 'unknown';
}

/**
 * The verified visitor behind the request, or null: the dvsid cookie must
 * verify (HMAC) and be bound to `workspaceId`. A forged, expired or
 * other-workspace cookie is no identity, so that request is anonymous.
 */
function rateLimitVisitorId(req: Request, workspaceId: string): string | null {
  if (workspaceId === 'unknown') return null;
  try {
    return readVisitorCookie(req, workspaceId)?.v || null;
  } catch {
    return null;
  }
}

// ─── Middleware: Rate limiting ───
/**
 * Per-category limit (RATE_LIMITS above), in front of each widget route.
 *
 * Identity: a request carrying a verified, workspace-bound visitor cookie is
 * counted per VISITOR (plus the shared per-(IP, workspace) ceiling of all
 * such requests); a request without one is counted per (IP, workspace) at
 * the anonymous cap. So visitors behind one carrier-grade NAT address no
 * longer share one small bucket, while every identity stays one the server
 * signed: never a raw workspace id (a pre-auth limit keyed on one would let
 * anyone drain a victim's quota), never the token nonce (the one per-session
 * layer is widgetSessionRateLimiter, below). New cookies come only from
 * bootstraps without one, which the anonymous bucket bounds.
 *
 * 429: `retry_after` is the real number of seconds until that bucket resets,
 * also sent as `Retry-After` (exposed to the widget by widgetCorsMiddleware).
 */
export function widgetRateLimit(category: string = 'default') {
  const caps = RATE_LIMITS[category] || RATE_LIMITS.default;
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = rateLimitIpKey(req);
    const workspaceId = rateLimitWorkspaceKey(req);
    const visitorId = rateLimitVisitorId(req, workspaceId);
    const buckets: RateLimitBucket[] = visitorId
      ? [
          { key: `${category}:v:${workspaceId}:${visitorId}`, max: caps.visitor },
          { key: `${category}:shared:${ip}:${workspaceId}`, max: caps.shared },
        ]
      : [{ key: `${category}:${ip}:${workspaceId}`, max: caps.anonymous }];

    const retryAfter = takeRateLimit(buckets, caps.window);
    if (retryAfter > 0) {
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: 'Too many requests — please slow down',
        code: 'RATE_LIMITED',
        retry_after: retryAfter,
      });
    }

    // Per-session protection lives in ONE canonical place —
    // widgetSessionRateLimiter in server/middleware/security.ts, mounted
    // structurally on the whole /api/widget prefix so it covers every
    // token-secured sub-router without depending on each route remembering
    // to opt in here. Do not re-add a per-category session check in this
    // function — that would double-count the same logical quota.
    next();
  };
}

// ─── Dynamic CORS middleware — REMOVED ───
// There is exactly one widget CORS implementation:
//   server/middleware/widgetCors.ts → widgetCorsMiddleware() / applyWidgetCorsHeaders()
// The previous `widgetSecurityCors` here echoed ANY origin unconditionally.
// It was unused, but keeping a second, weaker implementation around invites
// a future mount that silently disables the allow-list. Do not re-add one.


// ─── Workspace resolution ───
export function resolveWorkspaceId(req: Request, res: Response, candidateWorkspaceId?: string): string | null {
  const tokenWorkspaceId = (req as WidgetSessionRequest)._widgetWorkspaceId || null;
  const requestedWorkspaceId = typeof candidateWorkspaceId === 'string' && candidateWorkspaceId.trim().length > 0
    ? candidateWorkspaceId.trim() : null;

  if (requestedWorkspaceId && tokenWorkspaceId && requestedWorkspaceId !== tokenWorkspaceId) {
    res.status(403).json({ error: 'Workspace does not match session', code: 'WORKSPACE_MISMATCH' });
    return null;
  }

  return requestedWorkspaceId || tokenWorkspaceId;
}

// ─── Strict conversation ownership ───
//
// Identity sources (most → least authoritative):
//   1. HttpOnly `dvsid` visitor cookie (cannot be forged by client JS) — pass
//      `req` so the cookie is read here. Survives page refresh, cross-tab.
//   2. Caller-supplied `visitorId` (from request body) — best-effort fallback
//      for legacy callers that don't have access to the request object.
//   3. Caller-supplied `visitorSessionId` (from request body) — used to
//      match conv.visitor_session_id directly.
//
// A match on ANY of these is sufficient. This is critical for visitor
// heartbeat/typing after a page refresh, where the runtime's in-memory
// `visitorId` may not yet be re-hydrated but the HttpOnly cookie is.
export async function verifyConversationOwnership(
  config: ServerConfig,
  conversationId: string,
  workspaceId: string,
  visitorId?: string | null,
  visitorSessionId?: string | null,
  req?: Request,
): Promise<{ valid: boolean; conversation: OwnedConversation | null }> {
  if (!conversationId) return { valid: false, conversation: null };

  const supabase = getServiceClient(config);

  const { data } = await supabase
    .from('conversations')
    .select('id, status, assigned_to, updated_at, contact_id, visitor_session_id, workspace_id, metadata')
    .eq('id', conversationId)
    .maybeSingle();
  const conv = data as OwnedConversation | null;

  if (!conv) return { valid: false, conversation: null };
  if (conv.workspace_id !== workspaceId) return { valid: false, conversation: null };

  // Promote the HttpOnly visitor cookie to be tried alongside the body-supplied
  // visitorId. The cookie is set by the server on bootstrap and cannot be
  // forged by client JS, so it's the authoritative identity proof.
  let cookieVisitorId: string | null = null;
  if (req) {
    try {
      const v = readVisitorCookie(req, workspaceId);
      if (v?.v) cookieVisitorId = v.v;
    } catch { /* cookie parsing must never throw the request */ }
  }
  const candidateVisitorIds = new Set<string>();
  if (visitorId) candidateVisitorIds.add(visitorId);
  if (cookieVisitorId) candidateVisitorIds.add(cookieVisitorId);

  // Match by visitor_session_id
  if (visitorSessionId && conv.visitor_session_id === visitorSessionId) {
    return { valid: true, conversation: conv };
  }

  // Match by conversation metadata.visitor_id. Conversations created by the
  // AI intro before a visitor session exists carry no session id and no
  // contact, so this is their only ownership anchor. The cookie-derived
  // visitor id is authoritative and cannot be forged by client JS.
  if (candidateVisitorIds.size > 0) {
    const convVisitorId = (conv.metadata || {}).visitor_id;
    if (convVisitorId && candidateVisitorIds.has(convVisitorId)) {
      return { valid: true, conversation: conv };
    }
  }

  // Match by contact metadata.visitor_id
  if (candidateVisitorIds.size > 0 && conv.contact_id) {
    const { data: contact } = await supabase
      .from('contacts')
      .select('id, metadata')
      .eq('id', conv.contact_id)
      .maybeSingle();

    if (contact) {
      const meta = (contact.metadata as { visitor_id?: string } | null) || {};
      if (meta.visitor_id && candidateVisitorIds.has(meta.visitor_id)) {
        return { valid: true, conversation: conv };
      }
    }
  }

  // Fallback: if conversation has a visitor_session_id, look up the visitor_id from sessions
  if (candidateVisitorIds.size > 0 && conv.visitor_session_id) {
    const { data: session } = await supabase
      .from('visitor_sessions')
      .select('visitor_id')
      .eq('id', conv.visitor_session_id)
      .maybeSingle();

    if (session?.visitor_id && candidateVisitorIds.has(session.visitor_id)) {
      return { valid: true, conversation: conv };
    }
  }

  return { valid: false, conversation: null };
}

export { getRequestOrigin };
