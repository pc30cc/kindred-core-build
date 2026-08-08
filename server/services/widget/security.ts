/**
 * Widget Security — HMAC Session Tokens, Rate Limiting, Origin Enforcement
 *
 * - HMAC session tokens with nonce (short-lived, origin-bound)
 * - Single auth header: x-widget-token
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

// ─── Session Token Config ───
const SESSION_TOKEN_TTL_SECONDS = 900; // 15 minutes
const SESSION_TOKEN_PREFIX = 'wss_';
const REFRESH_GRACE_PERIOD_SECONDS = 5 * 60; // 5 min grace for expired tokens

function getSigningSecret(): Buffer {
  const base = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.WIDGET_SIGNING_SECRET || '';
  return crypto.createHash('sha256').update('widget-session:' + base).digest();
}

export interface TokenResult {
  valid: boolean;
  reason?: string;
  workspaceId?: string;
  origin?: string;
  nonce?: string;
  issuedAt?: number;
  expiresAt?: number;
  wasExpired?: boolean;
}

/**
 * Create a short-lived HMAC session token with unique nonce.
 */
export function createSessionToken(workspaceId: string, origin: string): string {
  const now = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(8).toString('hex');
  const payload = {
    w: workspaceId,
    o: origin || '',
    n: nonce,
    iat: now,
    exp: now + SESSION_TOKEN_TTL_SECONDS,
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

  let payload: any;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
  } catch {
    return { valid: false, reason: 'invalid_payload' };
  }

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
    };
  }

  return {
    valid: true,
    workspaceId: payload.w,
    origin: payload.o,
    nonce: payload.n,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
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
const RATE_LIMITS: Record<string, { window: number; max: number }> = {
  bootstrap: { window: 60, max: 30 },
  poll:      { window: 60, max: 60 },
  message:   { window: 60, max: 15 },
  upload:    { window: 60, max: 10 },
  refresh:   { window: 60, max: 20 },
  default:   { window: 60, max: 30 },
};

const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

// Cleanup expired entries every 30s
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of rateLimitStore) {
    if (now > val.resetAt) rateLimitStore.delete(key);
  }
}, 30_000);

function checkRateLimit(key: string, category: string = 'default'): boolean {
  const limit = RATE_LIMITS[category] || RATE_LIMITS.default;
  const now = Date.now();
  const entry = rateLimitStore.get(key);

  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(key, { count: 1, resetAt: now + limit.window * 1000 });
    return true;
  }

  if (entry.count >= limit.max) return false;
  entry.count++;
  return true;
}

/**
 * Canonical client IP resolver — re-exported so widget routes have a single
 * implementation. Previously this file had its own extractor that trusted
 * `x-forwarded-for` / `cf-connecting-ip` unconditionally, which let a direct
 * caller rotate its rate-limit bucket by sending a forged header.
 */
export { getClientIp } from '../../utils/clientIp.js';

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

// ─── Middleware: Session token enforcement ───
export function enforceWidgetToken(req: Request, res: Response, next: NextFunction) {
  const token = req.headers['x-widget-token'] as string;
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

  (req as any)._widgetWorkspaceId = result.workspaceId;
  (req as any)._widgetSessionOrigin = result.origin;
  (req as any)._widgetToken = token;
  next();
}

// ─── Middleware: Origin enforcement (FAIL CLOSED) ───
export function enforceOrigin(req: Request, res: Response, next: NextFunction) {
  const workspaceId = (req as any)._widgetWorkspaceId;
  if (!workspaceId) return next();

  const requestOrigin = getRequestOrigin(req);
  const sessionOrigin = (req as any)._widgetSessionOrigin;

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

  if (requestOrigin) {
    res.header('Access-Control-Allow-Origin', requestOrigin);
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Vary', 'Origin');
  }

  next();
}

// ─── Middleware: Rate limiting ───
export function widgetRateLimit(category: string = 'default') {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = rateLimitIpKey(req);
    const workspaceId = (req as any)._widgetWorkspaceId || req.body?.workspace_id || 'unknown';
    const key = `${category}:${ip}:${workspaceId}`;

    if (!checkRateLimit(key, category)) {
      return res.status(429).json({
        error: 'Too many requests — please slow down',
        code: 'RATE_LIMITED',
        retry_after: RATE_LIMITS[category]?.window || 60,
      });
    }
    next();
  };
}

// ─── Dynamic CORS middleware ───
export function widgetSecurityCors(req: Request, res: Response, next: NextFunction) {
  const origin = getRequestOrigin(req);

  if (req.method === 'OPTIONS') {
    if (origin) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Access-Control-Allow-Credentials', 'true');
      res.header('Vary', 'Origin');
    }
    res.header('Access-Control-Allow-Headers', 'Content-Type, x-widget-token');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.header('Access-Control-Max-Age', '3600');
    return res.sendStatus(204);
  }

  // Set CORS headers for actual requests too (so cookie is honored)
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Vary', 'Origin');
  }

  next();
}

// ─── Workspace resolution ───
export function resolveWorkspaceId(req: Request, res: Response, candidateWorkspaceId?: string): string | null {
  const tokenWorkspaceId = (req as any)._widgetWorkspaceId || null;
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
): Promise<{ valid: boolean; conversation: any | null }> {
  if (!conversationId) return { valid: false, conversation: null };

  const supabase = getServiceClient(config);

  const { data: conv } = await supabase
    .from('conversations')
    .select('id, status, assigned_to, updated_at, contact_id, visitor_session_id, workspace_id')
    .eq('id', conversationId)
    .maybeSingle();

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

  // Match by contact metadata.visitor_id
  if (candidateVisitorIds.size > 0 && conv.contact_id) {
    const { data: contact } = await supabase
      .from('contacts')
      .select('id, metadata')
      .eq('id', conv.contact_id)
      .maybeSingle();

    if (contact) {
      const meta = (contact.metadata as any) || {};
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
