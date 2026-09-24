/**
 * Visitor Identity Service
 * 
 * Production-grade visitor identification using HttpOnly signed cookies.
 * - Cookie name: `dvsid` (Device Visitor Session ID)
 * - HMAC-SHA256 signed payload (visitor_id + workspace_id + iat + exp)
 * - HttpOnly + Secure + SameSite=None (cross-site embed)
 * - NO localStorage usage
 * - Constant-time signature verification
 * - Automatic rotation on near-expiry
 * 
 * SECURITY:
 * - Server is the ONLY source of truth for visitor identity
 * - Cookie payload is signed; tampering is rejected
 * - Falls back to creating a new identity if cookie is missing/invalid
 */

import { Request, Response } from 'express';
import crypto from 'crypto';

const COOKIE_NAME = 'dvsid';
const COOKIE_TTL_DAYS = 365;
const COOKIE_TTL_SECONDS = COOKIE_TTL_DAYS * 24 * 60 * 60;
const ROTATION_THRESHOLD_DAYS = 30; // rotate if <30 days remain

/**
 * Cookies for an embedded widget MUST be sent on cross-site requests.
 * That requires `SameSite=None; Secure`. Browsers reject `SameSite=None`
 * without `Secure`, and reject `Secure` on plain http (except http://localhost).
 *
 * We detect "effectively HTTPS" via:
 *   - req.secure (works only when express trust-proxy includes the LB), OR
 *   - X-Forwarded-Proto header (Cloudflare / Lovable / Coolify edge), OR
 *   - NODE_ENV === 'production' as a final fallback.
 *
 * On plain http://localhost dev we fall back to SameSite=Lax (no Secure) so
 * same-origin testing still works without a TLS proxy.
 */
export function isSecureRequest(req: Request | null): boolean {
  if (process.env.NODE_ENV === 'production') return true;
  if (!req) return false;
  if ((req as Request & { secure?: boolean }).secure) return true;
  const xfp = (req.headers['x-forwarded-proto'] as string | undefined) || '';
  if (xfp.split(',')[0]?.trim().toLowerCase() === 'https') return true;
  const origin = (req.headers.origin as string | undefined) || '';
  const referer = (req.headers.referer as string | undefined) || '';
  if (/^https:\/\//i.test(origin) || /^https:\/\//i.test(referer)) return true;
  const host = (req.headers.host as string | undefined) || '';
  // Lovable preview / Coolify / Vercel domains are always TLS-terminated.
  if (/\.lovable\.(app|dev)$/i.test(host) || /\.(vercel\.app|netlify\.app)$/i.test(host)) return true;
  return false;
}

function getVisitorSecret(): Buffer {
  const base =
    process.env.WIDGET_VISITOR_SECRET ||
    process.env.WIDGET_SIGNING_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    '';
  if (!base) throw new Error('Missing WIDGET_VISITOR_SECRET');
  return crypto.createHash('sha256').update('visitor-cookie:' + base).digest();
}

export interface VisitorPayload {
  v: string; // visitor_id (UUID)
  w: string; // workspace_id
  iat: number;
  exp: number;
}

export interface VisitorCookieResult {
  visitorId: string;
  workspaceId: string;
  isNew: boolean;
  needsRotation: boolean;
}

function sign(payloadB64: string): string {
  return crypto
    .createHmac('sha256', getVisitorSecret())
    .update(payloadB64)
    .digest('base64url');
}

function encodeCookie(payload: VisitorPayload): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = sign(payloadB64);
  return `${payloadB64}.${sig}`;
}

function decodeCookie(raw: string): VisitorPayload | null {
  if (!raw || typeof raw !== 'string') return null;
  const dotIdx = raw.lastIndexOf('.');
  if (dotIdx < 1) return null;

  const payloadB64 = raw.slice(0, dotIdx);
  const sig = raw.slice(dotIdx + 1);
  const expectedSig = sign(payloadB64);

  if (sig.length !== expectedSig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString()) as VisitorPayload;
    if (!payload.v || !payload.w || !payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Read or create a visitor identity from the dvsid cookie.
 * Always sets the cookie on the response (rotates if near expiry, creates if missing).
 */
export function resolveVisitorIdentity(
  req: Request,
  res: Response,
  workspaceId: string,
  /**
   * `forceNew` starts a brand-new visitor even when a valid cookie exists —
   * exactly what clearing the cookie would do, so it grants the caller
   * nothing. The widget asks for it when the page reports that a DIFFERENT
   * signed-in person is now using this browser (a store/billing plugin's
   * `data-commerce-subject`), so the previous person's conversation is not
   * shown to them.
   */
  opts: { forceNew?: boolean } = {},
): VisitorCookieResult {
  const raw = (req as Request & { cookies?: Record<string, string> }).cookies?.[COOKIE_NAME];
  const now = Math.floor(Date.now() / 1000);

  let payload = raw && !opts.forceNew ? decodeCookie(raw) : null;
  let isNew = false;
  let needsRotation = false;

  // Reject if expired or workspace mismatch
  if (payload && (payload.exp < now || payload.w !== workspaceId)) {
    payload = null;
  }

  if (!payload) {
    payload = {
      v: crypto.randomUUID(),
      w: workspaceId,
      iat: now,
      exp: now + COOKIE_TTL_SECONDS,
    };
    isNew = true;
  } else {
    // Rotate if close to expiry
    const remaining = payload.exp - now;
    if (remaining < ROTATION_THRESHOLD_DAYS * 24 * 60 * 60) {
      payload = { ...payload, iat: now, exp: now + COOKIE_TTL_SECONDS };
      needsRotation = true;
    }
  }

  // Always (re)set cookie to refresh attributes
  setVisitorCookie(res, payload, req);

  return {
    visitorId: payload.v,
    workspaceId: payload.w,
    isNew,
    needsRotation,
  };
}

export function setVisitorCookie(res: Response, payload: VisitorPayload, req?: Request | null): void {
  const value = encodeCookie(payload);
  const secure = isSecureRequest(req ?? null);
  // Cross-site embed requires SameSite=None + Secure
  const attrs = [
    `${COOKIE_NAME}=${value}`,
    'Path=/api',
    'HttpOnly',
    `Max-Age=${COOKIE_TTL_SECONDS}`,
    `SameSite=${secure ? 'None' : 'Lax'}`,
  ];
  if (secure) {
    attrs.push('Secure');
    // CHIPS (Partitioned cookies) — required so the visitor cookie keeps
    // working in Chrome/Edge when third-party cookies are blocked (the new
    // default for embedded widgets on customer domains). Older browsers
    // simply ignore the attribute, so this is safe.
    attrs.push('Partitioned');
  }
  res.append('Set-Cookie', attrs.join('; '));
}

export function clearVisitorCookie(res: Response, req?: Request | null): void {
  const secure = isSecureRequest(req ?? null);
  const attrs = [
    `${COOKIE_NAME}=`,
    'Path=/api',
    'HttpOnly',
    'Max-Age=0',
    `SameSite=${secure ? 'None' : 'Lax'}`,
  ];
  if (secure) {
    attrs.push('Secure');
    attrs.push('Partitioned');
  }
  res.append('Set-Cookie', attrs.join('; '));
}

/**
 * Read-only: parse visitor cookie without creating one.
 * Returns null if missing/invalid/expired.
 */
export function readVisitorCookie(req: Request, expectedWorkspaceId?: string): VisitorPayload | null {
  const raw = (req as Request & { cookies?: Record<string, string> }).cookies?.[COOKIE_NAME];
  if (!raw) return null;
  const payload = decodeCookie(raw);
  if (!payload) return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (expectedWorkspaceId && payload.w !== expectedWorkspaceId) return null;
  return payload;
}
