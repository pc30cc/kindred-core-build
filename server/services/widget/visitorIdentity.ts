/**
 * Visitor Identity Service
 * 
 * Production-grade visitor identification using HttpOnly signed cookies.
 * - Cookie name: `dvsid` (Device Visitor Session ID)
 * - HMAC-SHA256 signed payload (visitor_id + workspace_id + iat + exp)
 * - HttpOnly + Secure + SameSite=None (cross-site embed)
 * - No storage of the cookie's value anywhere a script can read it (the
 *   visitor credential below is a separate, separately signed value)
 * - Constant-time signature verification
 * - Automatic rotation on near-expiry
 * 
 * SECURITY:
 * - Server is the ONLY source of truth for visitor identity
 * - Cookie payload is signed; tampering is rejected
 * - Falls back to creating a new identity if cookie is missing/invalid
 *
 * Visitor credential (the fallback for browsers that drop the cookie):
 * Safari on iOS/macOS, Brave and "block all cookies" settings never send a
 * third-party cookie, Partitioned or not, so without a fallback every
 * request of such a visitor looked like a new visitor (a new conversation
 * per message, operator replies never reaching them, a reload losing the
 * thread). The bootstrap therefore also returns a *visitor credential*: the
 * SAME signed payload as the cookie (visitor id, workspace id, iat, exp —
 * same lifetime, same rotation), HMAC'd under its own derived key so a
 * credential and a cookie value are never interchangeable. The widget keeps
 * it in memory and, only while the server reports that the cookie did not
 * arrive, in the host page's own (first-party) localStorage, and sends it in
 * the `X-Widget-Visitor` header (or the `visitor_credential` field of the
 * CORS-simple bootstrap / track / presence bodies).
 *
 * Why this is safe:
 * - The cookie stays the primary identity: the credential is consulted ONLY
 *   when the request carries no dvsid cookie that identifies a visitor of
 *   this workspace. A browser that keeps the cookie is never steered by a
 *   header.
 * - It proves exactly what the cookie proves, nothing more: it is verified
 *   in constant time, rejected when expired or tampered, and bound to one
 *   workspace (a credential of workspace A is no identity in B).
 * - It is readable by scripts on the customer's page, unlike the HttpOnly
 *   cookie. That page already runs the widget and can read everything the
 *   widget shows (the conversation of this visitor in this workspace), so
 *   holding the credential grants it nothing new. It travels only to the
 *   widget API, in a header or a request body: never in a URL, a query
 *   string or a log line.
 * - A request that clears the identity (a new signed-in person on this
 *   browser, `forceNew`) also stops honouring the credential for the rest of
 *   that request, and the widget drops its stored copy before it asks.
 */

import { Request, Response } from 'express';
import crypto from 'crypto';
import { platformSigningSecret } from '../../lib/platformSecret.js';
import { isTextJsonPath } from '../../middleware/bodyParsers.js';

const COOKIE_NAME = 'dvsid';
/** The header the widget sends its visitor credential in (see the header comment). */
export const VISITOR_CREDENTIAL_HEADER = 'x-widget-visitor';
/**
 * The body field that carries it on the CORS-simple calls (bootstrap, /track,
 * /visitor-presence), which send no custom header so the browser sends no
 * preflight (server/middleware/bodyParsers.ts).
 */
export const VISITOR_CREDENTIAL_FIELD = 'visitor_credential';
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
    platformSigningSecret() ||
    '';
  if (!base) throw new Error('Missing WIDGET_VISITOR_SECRET');
  return crypto.createHash('sha256').update('visitor-cookie:' + base).digest();
}

/** The credential's own key: derived from the same secret, never equal to the cookie's. */
function getCredentialSecret(): Buffer {
  return crypto.createHash('sha256').update('visitor-credential:').update(getVisitorSecret()).digest();
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
  /** The visitor credential for this identity (same payload and lifetime as the cookie). */
  credential: string;
  /**
   * True when the request itself carried a dvsid cookie for this visitor of
   * this workspace: the browser keeps the cookie, so the widget need not
   * store the credential.
   */
  fromCookie: boolean;
}

function sign(payloadB64: string, key: Buffer = getVisitorSecret()): string {
  return crypto
    .createHmac('sha256', key)
    .update(payloadB64)
    .digest('base64url');
}

function encodeCookie(payload: VisitorPayload, key?: Buffer): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = sign(payloadB64, key);
  return `${payloadB64}.${sig}`;
}

function decodeCookie(raw: string, key?: Buffer): VisitorPayload | null {
  if (!raw || typeof raw !== 'string') return null;
  const dotIdx = raw.lastIndexOf('.');
  if (dotIdx < 1) return null;

  const payloadB64 = raw.slice(0, dotIdx);
  const sig = raw.slice(dotIdx + 1);
  const expectedSig = sign(payloadB64, key);

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

  // A new visitor must not inherit the previous contact through dvcid.
  // Clearing only dvsid lets /identity/me restore and re-pin that contact,
  // after which history exposes the previous signed-in conversation.
  if (opts.forceNew) clearVisitorCookie(res, req);
  let payload = raw && !opts.forceNew ? decodeCookie(raw) : null;
  let isNew = false;
  let needsRotation = false;

  // Reject if expired or workspace mismatch
  if (payload && (payload.exp < now || payload.w !== workspaceId)) {
    payload = null;
  }
  const fromCookie = !!payload;

  // No cookie identifies a visitor of this workspace: the visitor credential
  // the widget kept may (see the header comment). Never under forceNew.
  if (!payload && !opts.forceNew) payload = readVisitorCredential(req, workspaceId);

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
    credential: issueVisitorCredential(payload),
    fromCookie,
  };
}

/** The visitor credential for `payload`: the cookie's payload, signed under the credential key. */
export function issueVisitorCredential(payload: VisitorPayload): string {
  return encodeCookie({ v: payload.v, w: payload.w, iat: payload.iat, exp: payload.exp }, getCredentialSecret());
}

/** Set on a request whose identity was cleared, so no later read in it restores the credential's. */
const IDENTITY_CLEARED = Symbol('visitorIdentityCleared');

/** True when the request carries a dvsid cookie that identifies a visitor of `workspaceId`. */
function hasWorkspaceCookie(req: Request, workspaceId: string): boolean {
  const raw = (req as Request & { cookies?: Record<string, string> }).cookies?.[COOKIE_NAME];
  if (!raw) return false;
  const payload = decodeCookie(raw);
  return !!payload && payload.exp >= Math.floor(Date.now() / 1000) && payload.w === workspaceId;
}

/** The raw credential a request presents: the header, else the body field of a CORS-simple POST. */
function presentedCredential(req: Request): string | null {
  const raw = req.headers?.[VISITOR_CREDENTIAL_HEADER];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header === 'string' && header) return header;
  if (req.method !== 'POST') return null;
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  if (!isTextJsonPath(path)) return null;
  const fromBody = (req.body as Record<string, unknown> | undefined)?.[VISITOR_CREDENTIAL_FIELD];
  return typeof fromBody === 'string' && fromBody ? fromBody : null;
}

/**
 * The visitor a request's credential names, or null. Consulted only when no
 * dvsid cookie identifies a visitor of `workspaceId` (the cookie always
 * wins), and only for that workspace: a credential that fails its HMAC, has
 * expired or names another workspace is no identity.
 */
export function readVisitorCredential(req: Request, workspaceId: string): VisitorPayload | null {
  if (!workspaceId || (req as Request & { [IDENTITY_CLEARED]?: boolean })[IDENTITY_CLEARED]) return null;
  if (hasWorkspaceCookie(req, workspaceId)) return null;
  const raw = presentedCredential(req);
  if (!raw || raw.length > 1024) return null;
  const payload = decodeCookie(raw, getCredentialSecret());
  if (!payload || payload.exp < Math.floor(Date.now() / 1000) || payload.w !== workspaceId) return null;
  return payload;
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
  // Match the path, Secure and CHIPS attributes used by both setters.
  for (const name of [COOKIE_NAME, 'dvcid']) {
    const attrs = [
      `${name}=`, 'Path=/api', 'HttpOnly', 'Max-Age=0',
      `SameSite=${secure ? 'None' : 'Lax'}`,
    ];
    if (secure) attrs.push('Secure', 'Partitioned');
    res.append('Set-Cookie', attrs.join('; '));
    // Also prevent restoration by a later resolver in this request.
    if (req?.cookies) delete req.cookies[name];
  }
  // ...including through the visitor credential the request may carry.
  if (req) (req as Request & { [IDENTITY_CLEARED]?: boolean })[IDENTITY_CLEARED] = true;
}

/**
 * Read-only: the request's verified visitor, without creating one. Returns
 * null if missing/invalid/expired.
 *
 * The dvsid cookie first; when it does not identify a visitor of
 * `expectedWorkspaceId`, the visitor credential (see the header comment and
 * readVisitorCredential). Without an expected workspace only the cookie is
 * read: a credential is honoured only where a workspace is checked.
 */
export function readVisitorCookie(req: Request, expectedWorkspaceId?: string): VisitorPayload | null {
  const raw = (req as Request & { cookies?: Record<string, string> }).cookies?.[COOKIE_NAME];
  const payload = raw ? decodeCookie(raw) : null;
  if (payload && payload.exp >= Math.floor(Date.now() / 1000) && (!expectedWorkspaceId || payload.w === expectedWorkspaceId)) {
    return payload;
  }
  return expectedWorkspaceId ? readVisitorCredential(req, expectedWorkspaceId) : null;
}
