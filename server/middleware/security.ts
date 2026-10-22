/**
 * Server-side security middleware
 * Rate limiting, brute force protection, IP blocking, abuse detection
 */

import { Request, Response, NextFunction } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { readWidgetToken, verifySessionToken, verifyTokenForRefresh } from '../services/widget/security.js';
import { verifyWidgetSession } from '../services/callCenter/widgetSession.js';
import { readSessionToken } from '../lib/sessionTransport.js';
import { onInvalidate } from '../lib/cacheBus.js';
import { applyWidgetCorsHeaders } from './widgetCors.js';

/**
 * What earlier middleware — and express-rate-limit — attach to a request,
 * read through one typed view instead of `any`. Every field is optional:
 * none of them is guaranteed at every layer.
 */
interface SecurityRequestView {
  originalUrl?: string;
  path?: string;
  serverConfig?: ServerConfig;
  rateLimit?: { used?: number; current?: number; limit?: number };
  _rateLimitWorkspaceId?: string;
  _widgetWorkspaceId?: unknown;
  _widgetRateLimitTrust?: unknown;
}

function view(req: Request): SecurityRequestView {
  return req as unknown as SecurityRequestView;
}

/** Request path without query string (mount prefix included). */
function requestPath(req: Request): string {
  const raw = view(req).originalUrl || req.url || view(req).path || '';
  return String(raw).split('?')[0];
}

/**
 * Normalized per-IP bucket suffix (IPv6-safe via express-rate-limit helper).
 *
 * `req.ip` is utils/clientIp.ts getClientIp (installClientIpGetter in
 * server/index.ts): the visitor behind Cloudflare, the hop Traefik saw
 * otherwise, never a cf-connecting-ip sent by a client that reached the
 * origin directly. The same identity as the widget limits and the blocklist.
 */
function ipBucket(req: Request): string {
  return req.ip ? ipKeyGenerator(req.ip) : 'unknown';
}

/**
 * A positive integer from the environment, else `fallback`. Read on every
 * call (a few env lookups per request), so a test or an operator's restart
 * with a new value takes effect without other plumbing.
 */
function limitFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Whole seconds until express-rate-limit's window for this request resets (>= 1). */
function retryAfterSeconds(req: Request, windowMs = 60_000): number {
  const reset = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime;
  const ms = reset instanceof Date ? reset.getTime() - Date.now() : windowMs;
  return Math.max(1, Math.ceil(ms / 1000));
}

// ─── IP Blocking Middleware ───────────────────────────────────────
//
// The blocklist is held as ONE per-process snapshot of the active rows of
// ip_blocklist (same predicate as the is_ip_blocked() SQL function:
// blocked_until IS NULL OR blocked_until > now()), so a visitor's request
// costs no query. It used to be one is_ip_blocked RPC per new client address
// per minute per process, on the critical path of that visitor's first
// request (the CORS preflight included).
//
//   - Refreshed at most every 30 s, single flight; past that the current
//     list still answers while one background reload runs.
//   - Fails closed (503 IP_CHECK_UNAVAILABLE, as before) only when there is
//     no list to answer from: never loaded, or the last good load is older
//     than 5 min, and the reload fails. A failed load is not retried for 2 s
//     (those requests get the same 503 without a query).
//   - The admin routes (server/routes/adminSecurity.ts) publish the
//     `ipblock` scope on the cache bus after a block or unblock: every
//     process reloads before answering its next request (falling back to
//     the list it has if that reload fails).
//   - The key is exactly what the RPC was given — `req.ip`, else the socket
//     address — compared as text with ip_address, like the SQL function.
//     `blocked_until` is re-checked per request, so a block ends on time.
const IPBLOCK_REFRESH_MS = 30_000;
const IPBLOCK_MAX_STALE_MS = 5 * 60_000;
const IPBLOCK_RETRY_MS = 2_000;
const IPBLOCK_PAGE = 1000;

interface IpBlocklistSnapshot {
  /** ip_address → blocked_until (ms), null = no end. */
  entries: Map<string, number | null>;
  loadedAt: number;
}

let ipBlocklist: IpBlocklistSnapshot | null = null;
let ipBlocklistFlight: Promise<IpBlocklistSnapshot> | null = null;
let ipBlocklistGen = 0;
let ipBlocklistStale = false;
let ipBlocklistFailedAt = 0;

async function readIpBlocklist(config: ServerConfig): Promise<IpBlocklistSnapshot> {
  const sb = getServiceClient(config);
  const nowIso = new Date().toISOString();
  const entries = new Map<string, number | null>();
  // Paged: DATABASE_MAX_ROWS (1000 by default) would otherwise cut a long
  // list short, silently unblocking whatever did not fit. The database may
  // return FEWER rows than asked for (a lower DATABASE_MAX_ROWS, PostgREST's
  // max-rows), so the next page starts after the rows actually read, and a
  // short page is not the end: only an empty page, or reaching the count.
  for (let from = 0; ; ) {
    const { data, error, count } = await sb
      .from('ip_blocklist')
      .select('ip_address, blocked_until', { count: 'exact' })
      .or(`blocked_until.is.null,blocked_until.gt."${nowIso}"`)
      .order('id', { ascending: true })
      .range(from, from + IPBLOCK_PAGE - 1);
    // PostgREST reports failures via `error` rather than throwing.
    if (error) throw error;
    const rows = (data ?? []) as Array<{ ip_address?: unknown; blocked_until?: unknown }>;
    for (const row of rows) {
      if (typeof row.ip_address !== 'string' || !row.ip_address) continue;
      const until = row.blocked_until ? Date.parse(String(row.blocked_until)) : null;
      // An unparseable end is read as "no end": fail closed.
      const end = until === null || Number.isNaN(until) ? null : until;
      const prev = entries.get(row.ip_address);
      entries.set(row.ip_address, prev === null || end === null ? null : Math.max(prev ?? end, end));
    }
    if (rows.length === 0) break;
    from += rows.length;
    if (typeof count === 'number' && from >= count) break;
  }
  return { entries, loadedAt: Date.now() };
}

/**
 * One load at a time. A load running when the list is invalidated still
 * answers the requests waiting on it but is not kept (it may predate the
 * admin's write); the next request starts a fresh one.
 */
function loadIpBlocklist(config: ServerConfig): Promise<IpBlocklistSnapshot> {
  if (ipBlocklistFlight) return ipBlocklistFlight;
  const gen = ipBlocklistGen;
  const flight: Promise<IpBlocklistSnapshot> = readIpBlocklist(config).then(
    (list) => {
      if (gen === ipBlocklistGen) {
        ipBlocklist = list;
        ipBlocklistStale = false;
      }
      ipBlocklistFailedAt = 0;
      return list;
    },
    (err) => {
      ipBlocklistFailedAt = Date.now();
      throw err;
    },
  );
  ipBlocklistFlight = flight;
  void flight.then(
    () => { if (ipBlocklistFlight === flight) ipBlocklistFlight = null; },
    () => { if (ipBlocklistFlight === flight) ipBlocklistFlight = null; },
  );
  return flight;
}

onInvalidate('ipblock', (_key, { resync }) => {
  if (resync) {
    // The bus reconnected (nothing known changed): reload soon, but keep
    // answering from the current list meanwhile instead of making every
    // request wait for the reload. A reload already running may have read
    // the rows before a block whose notification was lost: it is not kept.
    if (ipBlocklist) ipBlocklist = { ...ipBlocklist, loadedAt: Math.min(ipBlocklist.loadedAt, Date.now() - IPBLOCK_REFRESH_MS) };
    if (ipBlocklistFlight) {
      ipBlocklistGen++;
      ipBlocklistFlight = null;
    }
    return;
  }
  ipBlocklistGen++;
  ipBlocklistStale = true;
  ipBlocklistFlight = null;
});

function isIpBlocked(list: IpBlocklistSnapshot, ip: string, now: number): boolean {
  if (!list.entries.has(ip)) return false;
  const until = list.entries.get(ip);
  return until === null || until === undefined || until > now;
}

/** Test-only: forget the list and any load in flight. */
export function __resetIpBlocklistForTests(): void {
  ipBlocklist = null;
  ipBlocklistFlight = null;
  ipBlocklistGen++;
  ipBlocklistStale = false;
  ipBlocklistFailedAt = 0;
}

/** Test-only: pretend the current list was loaded `ageMs` ago. */
export function __ageIpBlocklistForTests(ageMs: number): void {
  if (ipBlocklist) ipBlocklist = { ...ipBlocklist, loadedAt: Date.now() - ageMs };
}

function ipCheckUnavailable(res: Response, err: unknown): void {
  // Fail closed: we cannot prove this IP is not blocked, so we refuse the
  // request instead of letting a database outage disable IP blocking.
  // 503 (not 403) so legitimate clients can retry once the DB recovers.
  if (err) console.error('[security] IP blocklist load failed:', err);
  res.status(503).json({ error: 'Security check unavailable', code: 'IP_CHECK_UNAVAILABLE' });
}

export function ipBlockMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const config = view(req).serverConfig;
    if (!config) return next();

    const now = Date.now();
    let list = ipBlocklist;
    const usable = !!list && now - list.loadedAt <= IPBLOCK_MAX_STALE_MS;
    const invalidated = ipBlocklistStale;
    const due = !list || invalidated || now - list.loadedAt >= IPBLOCK_REFRESH_MS;
    const coolingDown = ipBlocklistFailedAt > 0 && now - ipBlocklistFailedAt < IPBLOCK_RETRY_MS && !ipBlocklistFlight;

    if (due && !coolingDown) {
      const flight = loadIpBlocklist(config);
      if (usable && !invalidated) {
        // Just old: answer from the current list, reload in the background.
        flight.catch((err) => console.warn('[security] IP blocklist refresh failed:', err instanceof Error ? err.message : err));
      } else {
        // Nothing to answer from, or an admin just changed the list (wait
        // for it, so a block or an unblock holds from the next request).
        try {
          list = await flight;
        } catch (err) {
          if (!usable) return ipCheckUnavailable(res, err);
          console.warn('[security] IP blocklist reload failed:', err instanceof Error ? err.message : err);
        }
      }
    } else if (!usable) {
      // Nothing to answer from and the last load failed moments ago.
      return ipCheckUnavailable(res, null);
    }

    if (list && isIpBlocked(list, ip, Date.now())) return ipBlocked(req, res);
    next();
  };
}

/**
 * The visitor-facing paths a customer's page calls cross-origin. Their CORS
 * headers come from widgetCorsMiddleware, which runs after this block: a
 * blocked visitor's browser saw a CORS failure (a network error) instead of
 * the answer, retried, and showed a broken launcher.
 */
const WIDGET_PATH = /^\/api\/(widget|visitors)(\/|$)|^\/api\/realtime\/visitor-presence$/;
const WIDGET_BOOTSTRAP_PATH = /^\/api\/widget\/boot(strap)?$/;

/**
 * A blocked address. On a widget path the answer is readable by the page
 * (CORS, preflight included: the body is the same for everyone and sets no
 * cookie), and the bootstrap says the widget is off, so the loader takes the
 * launcher away instead of drawing a widget that cannot work.
 */
function ipBlocked(req: Request, res: Response): void {
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  const origin = typeof req.headers?.origin === 'string' ? req.headers.origin : '';
  if (WIDGET_PATH.test(path)) {
    if (origin) applyWidgetCorsHeaders(res, origin);
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    // `protocol`: routes/widget.ts BOOTSTRAP_PROTOCOL, so the loader takes
    // the answer as final on its first (CORS-simple) request.
    if (WIDGET_BOOTSTRAP_PATH.test(path)) { res.json({ disabled: true, blocked: true, protocol: 3 }); return; }
  }
  res.status(403).json({ error: 'IP blocked', code: 'IP_BLOCKED', reason: 'Your IP has been blocked due to suspicious activity.' });
}

// ─── Rate Limiters by Endpoint Type ──────────────────────────────

// Auth: 5 attempts per minute per client address (login, signup, captcha,
// brute-force check). Since req.ip is the visitor (utils/clientIp.ts) and no
// longer the Cloudflare edge, this is one person's (or one NAT's) budget.
export const authRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipBucket(req),
  handler: async (req, res) => {
    logRateLimited(req, 'warn', { endpoint: req.originalUrl, limit: '5/min' });
    res.status(429).json({ error: 'Too many attempts. Please try again later.', retryAfter: 60 });
  },
});

/**
 * Bucket for emailRateLimiter: the workspace on /api/email, the IP elsewhere.
 *
 * The workspace key is only honest where the route then proves access to
 * that workspace (/api/email). On the unauthenticated /api/auth-email routes
 * it let a caller pick a fresh bucket per request just by sending any
 * `workspaceId`: unlimited reset and verification emails, and token or code
 * guesses, from a single IP.
 */
export function emailRateLimitKey(req: Request): string {
  const workspaceId = req.baseUrl === '/api/email' ? req.body?.workspaceId : undefined;
  return `email:${workspaceId || ipBucket(req)}`;
}

// Email: 10 per minute per workspace on /api/email, per IP everywhere else.
export const emailRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: emailRateLimitKey,
  handler: async (req, res) => {
    logRateLimited(req, 'warn', { endpoint: '/api/email', limit: '10/min' });
    res.status(429).json({ error: 'Email rate limit exceeded.' });
  },
});

/**
 * Every /api/widget and /api/call-widget request per IP per minute
 * (WIDGET_PER_IP_PER_MIN, default 1200; it was 300). It is the outer bound of
 * one address, so it is what a carrier-grade NAT or an office runs into: one
 * page view is 1-3 calls (bootstrap, track, the presence handshake), an open
 * chat polls. The per-visitor and per-session layers below it are tighter.
 */
export function widgetPerIpPerMin(): number {
  return limitFromEnv('WIDGET_PER_IP_PER_MIN', 1200);
}

export const widgetRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: () => widgetPerIpPerMin(),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipBucket(req),
  handler: async (req, res) => {
    logRateLimited(req, 'info', { endpoint: '/api/widget', limit: `${widgetPerIpPerMin()}/min` });
    res.status(429).json({ error: 'Widget rate limit exceeded.', code: 'RATE_LIMITED', retry_after: retryAfterSeconds(req) });
  },
});

// ─── Per-workspace widget limiter (IP-rotation resistant) ────────

/** Refresh endpoint uses grace-period token semantics, not plain verification. */
const REFRESH_PATH = /^\/api\/widget\/session\/refresh\/?$/;

/**
 * Resolve the rate-limit bucket for a public widget/visitor request.
 *
 * TRUST BOUNDARY (non-negotiable): a `ws:<workspace>` bucket may be produced
 * ONLY from a credential that is BOTH:
 *
 *   1. cryptographically valid (HMAC verifies), AND
 *   2. carries the `rl:'workspace'` rate-limit trust claim.
 *
 * A valid HMAC alone is NOT enough. It only proves "our server issued this
 * token at some point for workspace X" — it does not prove the caller who
 * obtained it was a legitimate browser visitor, because bootstrap's own
 * inputs (workspace_id/publicKey, Origin/Referer) are ordinary request data
 * a non-browser attacker can set to any value, including a real victim's
 * own domain. Every bootstrap path in this codebase signs `rl:'public'`
 * today — see WidgetRateLimitTrust in server/services/widget/security.ts —
 * so as things stand NOTHING can select a `ws:<workspace>` bucket; that is
 * intentional, not a bug, until a genuinely unforgeable proof exists to
 * justify issuing `rl:'workspace'`.
 *
 * Spoofable/public client input — `workspace_id`, `workspaceId`, `publicKey`,
 * `Origin`, `Referer`, `Host`, `X-Forwarded-*`, `visitor_id`, `contact_id`,
 * domain allow-list matches — can NEVER select a workspace bucket. Those are
 * authorization signals for the handlers (CORS/domain policy), not identity
 * proof against a non-browser attacker who forges arbitrary headers.
 *
 * Everything unproven falls back to the per-IP bucket; pre-auth endpoints are
 * additionally protected by the dedicated pre-auth limiters below, and a
 * verified-but-`public`-trust credential still gets its own per-session
 * nonce cap (widgetRateLimit in services/widget/security.ts;
 * callWidgetSessionRateLimiter below) so it isn't left unbounded either.
 */
export function resolveRateLimitWorkspaceKey(req: Request): string {
  const trusted = resolveTrustedRateLimitWorkspaceId(req);
  if (trusted) return `ws:${trusted}`;
  return `ip:${ipBucket(req)}`;
}

/**
 * Workspace id proven by an already-verified signature carrying the
 * `rl:'workspace'` trust claim, validated pre-auth context, or upstream
 * middleware. Returns null when nothing sufficiently trustworthy is present
 * — which today means it returns null for every credential in this
 * codebase, since nothing issues `rl:'workspace'` yet (see the doc comment
 * on resolveRateLimitWorkspaceKey above). That is the intended, safe state.
 *
 * NOTE on ordering: this limiter is mounted in server/index.ts BEFORE the
 * widget router, so `_widgetWorkspaceId` (set later by `enforceWidgetToken`)
 * is normally absent here. At this layer the real trusted sources are the
 * verified `x-widget-token` / `x-cc-session` headers and the validated
 * pre-auth context; the `_widgetWorkspaceId` branch only applies when the
 * limiter is reused downstream of the token gate — even there it requires
 * the matching `_widgetRateLimitTrust === 'workspace'` flag that
 * `enforceWidgetToken` sets alongside it, so a downstream reuse can't
 * silently regain trust that the token never earned.
 */
export function resolveTrustedRateLimitWorkspaceId(req: Request): string | null {
  const cached = view(req)._rateLimitWorkspaceId;
  if (typeof cached === 'string') return cached || null;

  const resolved = computeTrustedRateLimitWorkspaceId(req);
  try { view(req)._rateLimitWorkspaceId = resolved || ''; } catch { /* frozen req in tests */ }
  return resolved;
}

function computeTrustedRateLimitWorkspaceId(req: Request): string | null {
  const already = view(req)._widgetWorkspaceId;
  const alreadyTrust = view(req)._widgetRateLimitTrust;
  if (typeof already === 'string' && already.trim() && alreadyTrust === 'workspace') {
    return already.trim();
  }

  const widgetTokenStr = readWidgetToken(req);
  if (widgetTokenStr) {
    try {
      // /session/refresh accepts recently-expired tokens (inside the refresh
      // grace window), so the limiter must use the SAME verifier the route
      // uses — otherwise refresh traffic silently degrades to an IP bucket.
      // Grace semantics are scoped to that single path; every other route uses
      // strict expiry checking.
      const result = REFRESH_PATH.test(requestPath(req))
        ? verifyTokenForRefresh(widgetTokenStr)
        : verifySessionToken(widgetTokenStr);
      // Valid HMAC is necessary but not sufficient — see the trust-boundary
      // doc comment above. Only a token that was itself signed with
      // rl:'workspace' may select the shared workspace bucket.
      if (result.valid && result.workspaceId && result.rateLimitTrust === 'workspace') {
        return result.workspaceId;
      }
    } catch { /* never let token parsing break the limiter */ }
    // A presented token — verified-but-public-trust, or unverifiable —
    // means "no workspace-bucket entitlement": stop here so no weaker
    // source can be used behind it.
    return null;
  }

  const ccToken = req.headers?.['x-cc-session'];
  const ccTokenStr = Array.isArray(ccToken) ? ccToken[0] : ccToken;
  const config = view(req).serverConfig;
  if (typeof ccTokenStr === 'string' && ccTokenStr) {
    if (config) {
      try {
        const payload = verifyWidgetSession(config, ccTokenStr);
        if (payload?.workspace_id && (payload as unknown as { rl?: unknown }).rl === 'workspace') return payload.workspace_id;
      } catch { /* ignore */ }
    }
    return null;
  }

  return null;
}

/**
 * Per-workspace ceiling applied IN ADDITION to the per-IP limiter above.
 * Stops an attacker who rotates source IPs from flooding a single workspace,
 * and stops one workspace from exhausting shared capacity.
 */
//
// Its `ip:` fallback (every credential today, see above) is one more per-IP
// bucket; it follows WIDGET_PER_IP_PER_MIN so that one setting decides what
// an address may send, instead of a second, fixed per-IP cap behind it.
const WORKSPACE_BUCKET_PER_MIN = 1200;

export const widgetWorkspaceRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: (req) => (resolveRateLimitWorkspaceKey(req).startsWith('ws:') ? WORKSPACE_BUCKET_PER_MIN : widgetPerIpPerMin()),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: resolveRateLimitWorkspaceKey,
  handler: async (req, res) => {
    const key = resolveRateLimitWorkspaceKey(req);
    logRateLimited(req, 'warn', {
      endpoint: req.originalUrl,
      limit: key.startsWith('ws:') ? `${WORKSPACE_BUCKET_PER_MIN}/min/workspace` : `${widgetPerIpPerMin()}/min/ip`,
      workspaceId: key.startsWith('ws:') ? key.slice(3) : null,
    });
    res.status(429).json({ error: 'Workspace rate limit exceeded.', code: 'RATE_LIMITED', retry_after: retryAfterSeconds(req) });
  },
});

/**
 * Canonical per-chat-widget-session ceiling — structural, single source of
 * truth for "does this credential get bounded session-scoped protection".
 * Mounted on the whole /api/widget prefix in server/index.ts (same layer as
 * widgetWorkspaceRateLimiter, BEFORE widgetRouter and every sub-router run),
 * so it covers /config, /poll, /message, /session/refresh, and every
 * early-mounted sub-router (/identity, /attachments, /callback,
 * /departments, /call-invitations) without depending on each route author
 * remembering to opt in. Route-category limiters (widgetRateLimit() in
 * server/services/widget/security.ts) still apply their own per-(IP,
 * category, workspace) caps — this is the ONE session-scoped layer; it must
 * not be duplicated inside individual routes (see widgetRateLimit's doc
 * comment).
 *
 * Keyed by the token's nonce, which is now a STABLE session-lineage id
 * across /session/refresh (see createSessionToken's doc comment in
 * services/widget/security.ts) — so an attacker cannot reset this quota by
 * refreshing. /session/refresh itself is verified via verifyTokenForRefresh
 * (grace-period semantics) so the refresh flow isn't penalized for using an
 * about-to-expire token; every other path uses strict verifySessionToken.
 * Skipped entirely when no verifiable token is present (bootstrap, forged
 * tokens, /kb) — that traffic is covered by the pre-auth/per-IP limiters.
 */
function resolveWidgetSessionNonceKey(req: Request): string | null {
  // Header, or the body field on /track and /visitor-presence (the same
  // reader enforceWidgetToken uses): a CORS-simple call is counted in the
  // same session bucket as one carrying the header.
  const tokenStr = readWidgetToken(req);
  if (!tokenStr) return null;
  try {
    const result = REFRESH_PATH.test(requestPath(req))
      ? verifyTokenForRefresh(tokenStr)
      : verifySessionToken(tokenStr);
    if (result.valid && result.nonce) return result.nonce;
  } catch { /* never let token parsing break the limiter */ }
  return null;
}

export const widgetSessionRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 300, // generous flat cap spanning every category combined — see doc comment above
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'OPTIONS' || resolveWidgetSessionNonceKey(req) === null,
  keyGenerator: (req) => `widget-session:${resolveWidgetSessionNonceKey(req)}`,
  handler: async (req, res) => {
    logRateLimited(req, 'info', {
      endpoint: req.originalUrl,
      limit: '300/min/session',
    });
    res.status(429).json({ error: 'Too many requests for this session — please slow down.', code: 'SESSION_RATE_LIMITED', retry_after: retryAfterSeconds(req) });
  },
});

/**
 * Per-call-widget-session ceiling — additive to the per-IP `widgetRateLimiter`
 * and the `ws:<workspace>` bucket above (which, per the trust-boundary
 * comment on resolveRateLimitWorkspaceKey, is unreachable by any credential
 * this codebase issues today). Keyed by the session's own HMAC-verified
 * nonce (server/services/callCenter/widgetSession.ts) so ONE credential's
 * usage is capped even when replayed from rotating source IPs — no DB
 * lookup required. Skipped entirely when no verifiable session is present
 * (bootstrap, forged tokens); that traffic is already covered by the
 * pre-auth / per-IP limiters.
 */
function resolveCcSessionNonceKey(req: Request): string | null {
  const ccToken = req.headers?.['x-cc-session'];
  const ccTokenStr = Array.isArray(ccToken) ? ccToken[0] : ccToken;
  const config = view(req).serverConfig;
  if (typeof ccTokenStr !== 'string' || !ccTokenStr || !config) return null;
  try {
    const payload = verifyWidgetSession(config, ccTokenStr);
    if (payload?.nonce) return payload.nonce;
  } catch { /* ignore */ }
  return null;
}

export const callWidgetSessionRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'OPTIONS' || resolveCcSessionNonceKey(req) === null,
  keyGenerator: (req) => `cc-session:${resolveCcSessionNonceKey(req)}`,
  handler: async (req, res) => {
    logRateLimited(req, 'info', {
      endpoint: req.originalUrl,
      limit: '120/min/session',
    });
    res.status(429).json({ error: 'Too many requests for this session — please slow down.', retry_after: retryAfterSeconds(req) });
  },
});

// Visitor tracking: 200 per minute per IP
export const visitorRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipBucket(req),
  handler: async (req, res) => {
    logRateLimited(req, 'info', { endpoint: '/api/visitors', limit: '200/min' });
    res.status(429).json({ error: 'Visitor tracking rate limit exceeded.' });
  },
});

// ─── Pre-auth (anonymous) limiters ───────────────────────────────
//
// These protect endpoints that run BEFORE any signed credential exists.
// They must never key on an attacker-selectable workspace identifier, so an
// attacker who knows a victim's workspace UUID / allowed domain / public
// widget key cannot drain that victim's authenticated shared quota.
//
// Keys are per-IP + route scope. Because IPs can be rotated, each pre-auth
// route also passes through a bounded process-global ceiling (below).

/**
 * Per-process global ceiling — deliberately generous vs. real traffic. It is
 * per PROCESS: with N API processes (replicas, regions) the platform-wide
 * figure is N times `max()`.
 */
function globalCeiling(name: string, max: () => number, windowMs = 60_000) {
  let count = 0;
  let resetAt = Date.now() + windowMs;
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'OPTIONS') return next();
    const now = Date.now();
    if (now > resetAt) { count = 0; resetAt = now + windowMs; }
    count++;
    if (count > max()) {
      const retryAfter = Math.max(1, Math.ceil((resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Service is busy, please retry.', code: 'PREAUTH_GLOBAL_LIMIT', scope: name, retry_after: retryAfter });
    }
    next();
  };
}

function preAuthLimiter(scope: string, max: () => number) {
  return rateLimit({
    windowMs: 60_000,
    limit: () => max(),
    standardHeaders: true,
    legacyHeaders: false,
    // Key is built from `ipKeyGenerator` (IPv6-safe) inside `ipBucket`; the
    // library's static probe can't see through the helper.
    validate: { keyGeneratorIpFallback: false },
    // CORS preflights carry no payload and must not consume visitor quota.
    skip: (req) => req.method === 'OPTIONS',
    keyGenerator: (req) => `${scope}:${ipBucket(req)}`,
    handler: async (req, res) => {
      logRateLimited(req, 'info', { endpoint: req.originalUrl, limit: `${max()}/min/ip`, scope });
      res.status(429).json({ error: 'Too many requests. Please retry shortly.', code: 'PREAUTH_RATE_LIMITED', retry_after: retryAfterSeconds(req) });
    },
  });
}

// Bootstrap caps, chat and call widget. Every page view of a site with the
// widget bootstraps once (a reload or a new tab is a new page view), so these
// count page views, not visitors: one carrier-grade NAT or office address can
// carry hundreds of real visitors. They used to be 60/min per IP and
// 1200/min per process, i.e. the whole platform at 20 page views a second on
// one process, and a NAT of a few dozen active visitors already refused.
//
// They can be this much higher now because a bootstrap that hits the caches
// costs no database query: the chat widget's from the workspace snapshot
// (services/widget/configSnapshot.ts), whose MISSES are what reach the
// database and are bounded on their own by WIDGET_CONFIG_REBUILDS_PER_SEC; the
// call widget's from its workspace memo plus the 60 s presence ticket
// (services/callCenter/bootstrapCache.ts, presenceTicket.ts). A call widget
// visitor seen for the first time still costs its visitor queries (~5-8),
// so its global ceiling is half the chat widget's.
//
// Per-IP caps: WIDGET_BOOTSTRAP_PER_IP_PER_MIN / CALL_WIDGET_BOOTSTRAP_PER_IP_PER_MIN
// (default 600: ten page views a second from one address). Per-process
// ceilings, the rotating-IP backstop: WIDGET_BOOTSTRAP_GLOBAL_PER_MIN (12000)
// and CALL_WIDGET_BOOTSTRAP_GLOBAL_PER_MIN (6000). Inside these, widgetRateLimit
// ('bootstrap') still caps one visitor at 30/min and an address without a
// visitor cookie at 300/min per workspace.
export const widgetBootstrapRateLimiter = preAuthLimiter(
  'widget-bootstrap', () => limitFromEnv('WIDGET_BOOTSTRAP_PER_IP_PER_MIN', 600));
export const callWidgetBootstrapRateLimiter = preAuthLimiter(
  'call-widget-bootstrap', () => limitFromEnv('CALL_WIDGET_BOOTSTRAP_PER_IP_PER_MIN', 600));
export const publicKbRateLimiter = preAuthLimiter('public-kb', () => 120);
export const visitorPreAuthRateLimiter = preAuthLimiter('visitor-preauth', () => 200);

export const widgetBootstrapGlobalCeiling = globalCeiling(
  'widget-bootstrap', () => limitFromEnv('WIDGET_BOOTSTRAP_GLOBAL_PER_MIN', 12_000));
export const callWidgetBootstrapGlobalCeiling = globalCeiling(
  'call-widget-bootstrap', () => limitFromEnv('CALL_WIDGET_BOOTSTRAP_GLOBAL_PER_MIN', 6_000));
export const publicKbGlobalCeiling = globalCeiling('public-kb', () => 2400);
/**
 * GET /api/widget/kb-suggest (instant answers, server/routes/widgetKbSuggest.ts),
 * per process: WIDGET_KB_SUGGEST_GLOBAL_PER_MIN (1800). Its own counter, so the
 * help center's searches never use it up, nor it theirs. Mounted after the
 * per-visitor `kb_suggest` bucket: a request that bucket refuses costs nothing here.
 */
export const kbSuggestGlobalCeiling = globalCeiling(
  'kb-suggest', () => limitFromEnv('WIDGET_KB_SUGGEST_GLOBAL_PER_MIN', 1800));
export const visitorPreAuthGlobalCeiling = globalCeiling('visitor-preauth', () => 4000);

/**
 * Logout, logout-all and Super Admin impersonation (start / stop): signed-in
 * actions, not guesses. Their own bucket, so a Super Admin working through
 * several accounts, or a user signing out and back in, never spends the
 * 5-a-minute login budget.
 */
export const sessionActionRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `session-action:${ipBucket(req)}`,
  handler: async (req, res) => {
    logRateLimited(req, 'warn', { endpoint: req.originalUrl, limit: '30/min' });
    res.status(429).json({ error: 'Too many attempts. Please try again later.', retryAfter: 60 });
  },
});

/**
 * Admin surfaces (/api/admin, /api/admin-status, /api/plugins/admin,
 * /api/admin/map-geo, /api/admin/billing/locks), one bucket per client
 * address. Every route behind it needs a Super Admin session (and
 * /api/admin-status/is-admin, which every dashboard user calls on mount and
 * focus, only reads one), so this guards against floods, not guesses. Sized
 * for ONE person: the admin dashboard opens with ~13 queries, refetches them
 * on window focus, polls, and retries failures; 30 a minute was only enough
 * while req.ip was the Cloudflare edge, which spread one admin over many
 * buckets.
 */
export const adminRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `admin:${ipBucket(req)}`,
  handler: async (req, res) => {
    logRateLimited(req, 'warn', { endpoint: '/admin', limit: '600/min' });
    res.status(429).json({ error: 'Admin rate limit exceeded.' });
  },
});

/**
 * Billing provider webhooks (/api/billing/webhook/:provider): public by
 * necessity, and checking one can cost outbound calls (PayPal's
 * verify-webhook-signature API). The ceiling is far above any provider's real
 * delivery rate from one address, and providers retry a 429, so nothing
 * genuine is lost.
 */
export function createBillingWebhookRateLimiter(max = 120) {
  return rateLimit({
    windowMs: 60_000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `billing-webhook:${ipBucket(req)}`,
    handler: async (req, res) => {
      logRateLimited(req, 'warn', { endpoint: '/api/billing/webhook', limit: `${max}/min` });
      res.status(429).json({ error: 'Webhook rate limit exceeded.' });
    },
  });
}

export const billingWebhookRateLimiter = createBillingWebhookRateLimiter();

// ─── Brute Force Protection ─────────────────────────────────────

const loginAttemptTracker = new Map<string, { count: number; firstAttempt: number; lockedUntil?: number }>();
const BRUTE_FORCE_WINDOW = 15 * 60_000; // 15 min
const MAX_FAILURES = 5;
const LOCK_DURATION_BASE = 5 * 60_000; // 5 min base, doubles each lock

/**
 * The brute-force tracker key: the client address as its rate-limit bucket
 * (an IPv6 one as its /56, so a host cannot rotate through its own /64 to
 * dodge the lock), and the email.
 */
function bruteForceKey(req: Request, email: string): string {
  return `${ipBucket(req)}:${email}`;
}

export async function checkBruteForce(req: Request, email: string): Promise<{ blocked: boolean; retryAfter?: number; failCount?: number }> {
  const key = bruteForceKey(req, email);
  const now = Date.now();

  const tracker = loginAttemptTracker.get(key);
  if (tracker) {
    // Check if locked
    if (tracker.lockedUntil && tracker.lockedUntil > now) {
      const retryAfter = Math.ceil((tracker.lockedUntil - now) / 1000);
      return { blocked: true, retryAfter, failCount: tracker.count };
    }
    // Reset if window expired
    if (now - tracker.firstAttempt > BRUTE_FORCE_WINDOW) {
      loginAttemptTracker.delete(key);
      return { blocked: false };
    }
    if (tracker.count >= MAX_FAILURES) {
      // Progressive lockout: 5min, 10min, 20min...
      const lockMultiplier = Math.pow(2, Math.floor(tracker.count / MAX_FAILURES) - 1);
      const lockDuration = LOCK_DURATION_BASE * lockMultiplier;
      tracker.lockedUntil = now + lockDuration;
      return { blocked: true, retryAfter: Math.ceil(lockDuration / 1000), failCount: tracker.count };
    }
  }

  return { blocked: false };
}

export function recordLoginAttempt(req: Request, email: string, success: boolean) {
  const key = bruteForceKey(req, email);
  const now = Date.now();

  if (success) {
    loginAttemptTracker.delete(key);
    return;
  }

  const tracker = loginAttemptTracker.get(key);
  if (tracker && now - tracker.firstAttempt < BRUTE_FORCE_WINDOW) {
    tracker.count++;
  } else {
    loginAttemptTracker.set(key, { count: 1, firstAttempt: now });
  }
}

// ─── Captcha Verification ───────────────────────────────────────

/**
 * Minimal shape of the Turnstile / reCAPTCHA siteverify response.
 * Only the `success` flag is consumed by this module.
 */
interface CaptchaVerifyResponse {
  success: boolean;
}

export function isCaptchaVerifyResponse(value: unknown): value is CaptchaVerifyResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'success' in value &&
    typeof (value as { success: unknown }).success === 'boolean'
  );
}

export async function verifyCaptcha(
  token: string,
  provider: 'turnstile' | 'recaptcha',
  secret: string,
  ip?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const url = provider === 'turnstile'
      ? 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
      : 'https://www.google.com/recaptcha/api/siteverify';

    const body = new URLSearchParams({
      secret,
      response: token,
      ...(ip ? { remoteip: ip } : {}),
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const data: unknown = await res.json();
    const ok = isCaptchaVerifyResponse(data) && data.success === true;
    return { success: ok, error: ok ? undefined : 'Captcha verification failed' };
  } catch (err) {
    return { success: false, error: 'Captcha service unavailable' };
  }
}

// ─── Abuse Detection ────────────────────────────────────────────

const requestCounters = new Map<string, { count: number; windowStart: number; reported?: boolean }>();
const ABUSE_WINDOW = 5 * 60_000; // 5 min
const ABUSE_THRESHOLD = 500; // anonymous requests per 5 min from single IP
// Requests that carry a session credential (gs_session cookie or Bearer) are
// counted in their own per-IP bucket with a larger budget: one signed-in
// dashboard polls presence, visitors, contacts and both inbox counters on
// timers and refetches on every realtime event (~1-3 req/s per operator),
// so a team behind one office NAT crossed 500/5 min in about a minute.
// The bucket stays keyed by IP — never by the unverified token — so rotating
// fake tokens buys at most this bounded budget, not an unlimited one.
const ABUSE_THRESHOLD_CREDENTIALED = 5000;

/**
 * `report` is true only for the request that first crosses the threshold in
 * a window. Every request past it is still `suspicious`, but logging each one
 * meant an awaited security_events INSERT per request for the rest of the
 * window — hundreds of identical rows per busy IP (an office behind one NAT,
 * a CDN edge when trust proxy is not configured), which grew the table and
 * slowed every one of those requests down.
 */
export function checkAbusePattern(req: Request): { suspicious: boolean; report: boolean; reason?: string } {
  const credentialed = !!readSessionToken(req).token;
  const ip = ipBucket(req);
  const key = credentialed ? `${ip}|session` : ip;
  const threshold = credentialed ? ABUSE_THRESHOLD_CREDENTIALED : ABUSE_THRESHOLD;
  const now = Date.now();

  const counter = requestCounters.get(key);
  if (counter) {
    if (now - counter.windowStart > ABUSE_WINDOW) {
      requestCounters.set(key, { count: 1, windowStart: now });
      return { suspicious: false, report: false };
    }
    counter.count++;
    if (counter.count > threshold) {
      const report = !counter.reported;
      counter.reported = true;
      return {
        suspicious: true,
        report,
        reason: `${counter.count} requests in ${Math.ceil((now - counter.windowStart) / 1000)}s`,
      };
    }
  } else {
    requestCounters.set(key, { count: 1, windowStart: now });
  }

  return { suspicious: false, report: false };
}

// ─── Request Logging / Security Event Logger ────────────────────

export async function logSecurityEvent(
  req: Request,
  eventType: string,
  severity: 'info' | 'warn' | 'error' | 'critical',
  metadata: Record<string, unknown> = {}
) {
  try {
    const config = view(req).serverConfig;
    if (!config) return;
    // COMPLIANCE_AUDIT_LOGGING — the single helper behind all 24 callers and
    // therefore the only writer of security_events. With it off there is no
    // forensic trail for a probe, a brute-force run or a captcha failure on a
    // publicly reachable install, and the admin security panel goes blank.
    if (config.complianceAuditLoggingEnabled === false) return;

    const sb = getServiceClient(config);
    await sb.from('security_events').insert({
      event_type: eventType,
      severity,
      ip_address: req.ip || req.socket.remoteAddress,
      endpoint: req.originalUrl,
      metadata,
      user_email: metadata.email || null,
      user_id: metadata.userId || null,
      workspace_id: metadata.workspaceId || null,
    });
  } catch (err) {
    console.error('[security] Failed to log event:', err);
  }
}

/**
 * A 429 is logged once per limiter key per window — the FIRST rejection —
 * not once per rejected request.
 *
 * Every 429 used to be an awaited INSERT into security_events, so the harder
 * a client hammered after being refused (a retry loop, a misbehaving widget
 * behind a shared IP, an attacker), the more it wrote to the database: the
 * limiter was a write amplifier for exactly the traffic it exists to shed.
 * The first rejection still records who was limited, where and at what cap;
 * the rest are identical copies.
 *
 * express-rate-limit exposes the window's hit count as `req.rateLimit.used`
 * (`current` on older versions); the first rejected hit is limit + 1. If that
 * information is ever missing the event is logged, as before. Not awaited:
 * logSecurityEvent() never rejects, and a refused client should not wait on
 * a database round trip to be told so.
 */
function logRateLimited(
  req: Request,
  severity: 'info' | 'warn' | 'error' | 'critical',
  metadata: Record<string, unknown>,
): void {
  const info = view(req).rateLimit;
  const used = info?.used ?? info?.current;
  const limit = info?.limit;
  if (typeof used === 'number' && typeof limit === 'number' && used > limit + 1) return;
  void logSecurityEvent(req, 'rate_limited', severity, metadata);
}

// ─── Input Validation Middleware ─────────────────────────────────

export function validateJsonBody(maxSize: number = 1024 * 100) {
  return (req: Request, res: Response, next: NextFunction) => {
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);
    if (contentLength > maxSize) {
      return res.status(413).json({ error: 'Request body too large' });
    }
    next();
  };
}

// ─── Abuse Detection Middleware ──────────────────────────────────

export function abuseDetectionMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const abuse = checkAbusePattern(req);
    if (abuse.report) {
      // Once per IP per window, and not awaited: logSecurityEvent() never
      // rejects, and the request it describes should not wait on it.
      void logSecurityEvent(req, 'abuse_detected', 'error', {
        reason: abuse.reason,
        userAgent: req.headers['user-agent'],
      });
    }
    // Don't block yet — just log and flag. Block after repeated abuse.
    next();
  };
}

// ─── Cleanup stale tracking data periodically ───────────────────

setInterval(() => {
  const now = Date.now();
  // Clean login attempt tracker
  for (const [key, val] of loginAttemptTracker) {
    if (now - val.firstAttempt > BRUTE_FORCE_WINDOW * 2) {
      loginAttemptTracker.delete(key);
    }
  }
  // Clean abuse counters
  for (const [key, val] of requestCounters) {
    if (now - val.windowStart > ABUSE_WINDOW * 2) {
      requestCounters.delete(key);
    }
  }
}, 5 * 60_000);
