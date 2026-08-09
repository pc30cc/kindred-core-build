/**
 * Server-side security middleware
 * Rate limiting, brute force protection, IP blocking, abuse detection
 */

import { Request, Response, NextFunction } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { verifySessionToken, verifyTokenForRefresh } from '../services/widget/security.js';
import { verifyWidgetSession } from '../services/callCenter/widgetSession.js';

// ─── IP Blocking Middleware ───────────────────────────────────────
const blockedIPCache = new Map<string, { blocked: boolean; until: number | null; checkedAt: number }>();
const IP_CACHE_TTL = 60_000; // 1 min

export function ipBlockMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const config: ServerConfig = (req as any).serverConfig;
    if (!config) return next();

    const cached = blockedIPCache.get(ip);
    if (cached && Date.now() - cached.checkedAt < IP_CACHE_TTL) {
      if (cached.blocked) {
        return res.status(403).json({ error: 'IP blocked', reason: 'Your IP has been blocked due to suspicious activity.' });
      }
      return next();
    }

    try {
      const sb = getServiceClient(config);
      const { data, error } = await sb.rpc('is_ip_blocked', { _ip: ip });
      // PostgREST reports failures via `error` rather than throwing.
      if (error) throw error;
      blockedIPCache.set(ip, { blocked: !!data, until: null, checkedAt: Date.now() });
      if (data) {
        return res.status(403).json({ error: 'IP blocked' });
      }
    } catch (err) {
      // Fail closed: we cannot prove this IP is not blocked, so we refuse the
      // request instead of letting a database outage disable IP blocking.
      // 503 (not 403) so legitimate clients can retry once the DB recovers.
      console.error('[security] IP block lookup failed:', err);
      return res.status(503).json({ error: 'Security check unavailable', code: 'IP_CHECK_UNAVAILABLE' });
    }
    next();
  };
}

// ─── Rate Limiters by Endpoint Type ──────────────────────────────

// Auth: 5 attempts per minute per IP
export const authRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || 'unknown',
  handler: async (req, res) => {
    await logSecurityEvent(req, 'rate_limited', 'warn', { endpoint: req.originalUrl, limit: '5/min' });
    res.status(429).json({ error: 'Too many attempts. Please try again later.', retryAfter: 60 });
  },
});

// Email: 10 per minute per workspace
export const emailRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `email:${req.body?.workspaceId || req.ip}`,
  handler: async (req, res) => {
    await logSecurityEvent(req, 'rate_limited', 'warn', { endpoint: '/api/email', limit: '10/min' });
    res.status(429).json({ error: 'Email rate limit exceeded.' });
  },
});

// Widget: 300 per minute per IP (high traffic expected)
export const widgetRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || 'unknown',
  handler: async (req, res) => {
    await logSecurityEvent(req, 'rate_limited', 'info', { endpoint: '/api/widget', limit: '300/min' });
    res.status(429).json({ error: 'Widget rate limit exceeded.' });
  },
});

// ─── Per-workspace widget limiter (IP-rotation resistant) ────────

/**
 * Pre-auth (public) endpoints where `workspace_id` is legitimately part of the
 * request protocol because no token exists yet. Verified against the real
 * route table in server/index.ts + the routers themselves:
 *
 *   POST /api/widget/bootstrap        — issues the widget session token
 *   GET  /api/widget/kb/*             — public KB reads, keyed by workspace_id
 *   POST /api/visitors/{track,heartbeat,disconnect} — pre-token visitor pings
 *   GET  /api/call-widget/bootstrap   — issues the call-widget session
 *
 * Everything else under /api/widget and /api/call-widget sits behind
 * `enforceWidgetToken` / `requireWidgetSession`, so a workspace identity there
 * MUST come from a verified signature.
 */
const PREAUTH_WORKSPACE_HINT_PATHS: RegExp[] = [
  /^\/api\/widget\/bootstrap\/?$/,
  /^\/api\/widget\/kb(\/|$)/,
  /^\/api\/visitors\/(track|heartbeat|disconnect)\/?$/,
  /^\/api\/call-widget\/bootstrap\/?$/,
];

/** Refresh endpoint uses grace-period token semantics, not plain verification. */
const REFRESH_PATH = /^\/api\/widget\/session\/refresh\/?$/;

function requestPath(req: Request): string {
  const raw = (req as any).originalUrl || req.url || (req as any).path || '';
  return String(raw).split('?')[0];
}

function hasAnyWidgetTokenHeader(req: Request): boolean {
  const a = req.headers?.['x-widget-token'];
  const b = req.headers?.['x-cc-session'];
  return Boolean((Array.isArray(a) ? a[0] : a) || (Array.isArray(b) ? b[0] : b));
}

/**
 * Resolve the rate-limit bucket for a public widget/visitor request.
 *
 * Trust model:
 *   1. Cryptographically proven workspace (see resolveTrustedRateLimitWorkspaceId).
 *   2. Raw `workspace_id` from query/body — ONLY on pre-auth endpoints AND only
 *      when the caller presented no widget/call token at all. A request that
 *      carries a token which fails verification is treated as untrusted and
 *      falls straight through to the IP bucket; it can never select another
 *      workspace's bucket.
 *   3. Normalized IP fallback.
 */
export function resolveRateLimitWorkspaceKey(req: Request): string {
  const trusted = resolveTrustedRateLimitWorkspaceId(req);
  if (trusted) return `ws:${trusted}`;

  const ipBucket = `ip:${req.ip ? ipKeyGenerator(req.ip) : 'unknown'}`;

  // A presented-but-unverifiable token means "untrusted caller" — never honour
  // an attacker-supplied workspace hint after a failed verification.
  if (hasAnyWidgetTokenHeader(req)) return ipBucket;

  if (!PREAUTH_WORKSPACE_HINT_PATHS.some((re) => re.test(requestPath(req)))) return ipBucket;

  const raw =
    (req.query?.workspace_id as string) ||
    (req.body?.workspace_id as string) ||
    (req.body?.workspaceId as string) ||
    null;
  if (raw && typeof raw === 'string' && raw.trim()) return `ws:${raw.trim()}`;
  return ipBucket;
}

/**
 * Workspace id proven by an already-verified signature / upstream middleware.
 * Returns null when nothing trustworthy is present.
 *
 * NOTE on ordering: this limiter is mounted in server/index.ts BEFORE the
 * widget router, so `_widgetWorkspaceId` (set later by `enforceWidgetToken`)
 * is normally absent here. In practice the primary trusted source at this
 * layer is the verified `x-widget-token` / `x-cc-session` header; the
 * `_widgetWorkspaceId` branch only applies when the limiter is reused
 * downstream of the token gate.
 */
export function resolveTrustedRateLimitWorkspaceId(req: Request): string | null {
  const cached = (req as any)._rateLimitWorkspaceId;
  if (typeof cached === 'string') return cached || null;

  const resolved = computeTrustedRateLimitWorkspaceId(req);
  try { (req as any)._rateLimitWorkspaceId = resolved || ''; } catch { /* frozen req in tests */ }
  return resolved;
}

function computeTrustedRateLimitWorkspaceId(req: Request): string | null {
  const already = (req as any)._widgetWorkspaceId;
  if (typeof already === 'string' && already.trim()) return already.trim();

  const widgetToken = req.headers?.['x-widget-token'];
  const widgetTokenStr = Array.isArray(widgetToken) ? widgetToken[0] : widgetToken;
  if (typeof widgetTokenStr === 'string' && widgetTokenStr) {
    try {
      // /session/refresh accepts recently-expired tokens (inside the refresh
      // grace window), so the limiter must use the SAME verifier the route
      // uses — otherwise refresh traffic silently degrades to an IP bucket.
      // Grace semantics are scoped to that single path; every other route uses
      // strict expiry checking.
      const result = REFRESH_PATH.test(requestPath(req))
        ? verifyTokenForRefresh(widgetTokenStr)
        : verifySessionToken(widgetTokenStr);
      if (result.valid && result.workspaceId) return result.workspaceId;
    } catch { /* never let token parsing break the limiter */ }
  }

  const ccToken = req.headers?.['x-cc-session'];
  const ccTokenStr = Array.isArray(ccToken) ? ccToken[0] : ccToken;
  const config = (req as any).serverConfig as ServerConfig | undefined;
  if (typeof ccTokenStr === 'string' && ccTokenStr && config) {
    try {
      const payload = verifyWidgetSession(config, ccTokenStr);
      if (payload?.workspace_id) return payload.workspace_id;
    } catch { /* ignore */ }
  }

  return null;
}

/**
 * Per-workspace ceiling applied IN ADDITION to the per-IP limiter above.
 * Stops an attacker who rotates source IPs from flooding a single workspace,
 * and stops one workspace from exhausting shared capacity.
 */
export const widgetWorkspaceRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 1200,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: resolveRateLimitWorkspaceKey,
  handler: async (req, res) => {
    await logSecurityEvent(req, 'rate_limited', 'warn', {
      endpoint: req.originalUrl,
      limit: '1200/min/workspace',
      workspaceId: resolveRateLimitWorkspaceKey(req).startsWith('ws:')
        ? resolveRateLimitWorkspaceKey(req).slice(3)
        : null,
    });
    res.status(429).json({ error: 'Workspace rate limit exceeded.' });
  },
});

// Visitor tracking: 200 per minute per IP
export const visitorRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || 'unknown',
  handler: async (req, res) => {
    await logSecurityEvent(req, 'rate_limited', 'info', { endpoint: '/api/visitors', limit: '200/min' });
    res.status(429).json({ error: 'Visitor tracking rate limit exceeded.' });
  },
});

// Admin: 30 per minute per IP
export const adminRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || 'unknown',
  handler: async (req, res) => {
    await logSecurityEvent(req, 'rate_limited', 'warn', { endpoint: '/admin', limit: '30/min' });
    res.status(429).json({ error: 'Admin rate limit exceeded.' });
  },
});

// ─── Brute Force Protection ─────────────────────────────────────

const loginAttemptTracker = new Map<string, { count: number; firstAttempt: number; lockedUntil?: number }>();
const BRUTE_FORCE_WINDOW = 15 * 60_000; // 15 min
const MAX_FAILURES = 5;
const LOCK_DURATION_BASE = 5 * 60_000; // 5 min base, doubles each lock

export async function checkBruteForce(req: Request, email: string): Promise<{ blocked: boolean; retryAfter?: number; failCount?: number }> {
  const ip = req.ip || 'unknown';
  const key = `${ip}:${email}`;
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
  const ip = req.ip || 'unknown';
  const key = `${ip}:${email}`;
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

const requestCounters = new Map<string, { count: number; windowStart: number }>();
const ABUSE_WINDOW = 5 * 60_000; // 5 min
const ABUSE_THRESHOLD = 500; // requests per 5 min from single IP

export function checkAbusePattern(req: Request): { suspicious: boolean; reason?: string } {
  const ip = req.ip || 'unknown';
  const now = Date.now();

  const counter = requestCounters.get(ip);
  if (counter) {
    if (now - counter.windowStart > ABUSE_WINDOW) {
      requestCounters.set(ip, { count: 1, windowStart: now });
      return { suspicious: false };
    }
    counter.count++;
    if (counter.count > ABUSE_THRESHOLD) {
      return { suspicious: true, reason: `${counter.count} requests in ${Math.ceil((now - counter.windowStart) / 1000)}s` };
    }
  } else {
    requestCounters.set(ip, { count: 1, windowStart: now });
  }

  return { suspicious: false };
}

// ─── Request Logging / Security Event Logger ────────────────────

export async function logSecurityEvent(
  req: Request,
  eventType: string,
  severity: 'info' | 'warn' | 'error' | 'critical',
  metadata: Record<string, any> = {}
) {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    if (!config) return;

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
    if (abuse.suspicious) {
      await logSecurityEvent(req, 'abuse_detected', 'error', {
        reason: abuse.reason,
        userAgent: req.headers['user-agent'],
      });
      // Don't block yet — just log and flag. Block after repeated abuse.
    }
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
  // Clean IP cache
  for (const [key, val] of blockedIPCache) {
    if (now - val.checkedAt > IP_CACHE_TTL * 5) {
      blockedIPCache.delete(key);
    }
  }
}, 5 * 60_000);
