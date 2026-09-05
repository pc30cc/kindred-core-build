/**
 * First-party session service — backs the opaque, HttpOnly-cookie session
 * model (auth migration Phase 7). Uses `public.auth_sessions`
 * (database/migrations/025_first_party_auth_tables.sql /
 * supabase/migrations/20260414134600_baseline_remote_only_tables.sql +
 * 20260819120100_auth_sessions_revoke_reason.sql), which already existed —
 * unused — before this migration; this module is what finally writes to it.
 *
 * Design notes:
 *  - The session TOKEN (what the browser holds, in an HttpOnly cookie) is
 *    32 random bytes (256 bits) — never stored raw. Only its SHA-256 hash
 *    is persisted, mirroring the existing auth_verify_tokens/
 *    auth_reset_tokens convention (see server/services/auth-email.ts)
 *    exactly, so a stolen database row can never be replayed as a session.
 *  - Fixed absolute TTL, not sliding-on-every-request: validateSessionToken
 *    is a pure read with no side-effecting write, so it stays cheap and
 *    race-free on the hot path of every authenticated API call. A session
 *    lives 30 days from creation; logging in again (or explicit "remember
 *    me" extension, if ever added) is how a session gets renewed. This is a
 *    deliberate simplification versus a sliding/absolute dual-expiry model —
 *    documented here rather than silently decided.
 *  - `revoked_at` + `revoke_reason` is the only revocation mechanism: no
 *    session is ever deleted, so "was this session valid and then revoked,
 *    and why" stays answerable for auditing (Phase 29) without a separate
 *    audit table.
 */
import crypto from 'crypto';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { readSessionToken } from '../../lib/sessionTransport.js';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const SESSION_COOKIE_NAME = 'gs_session';

/**
 * `SameSite` policy for the session cookie. Defaults to `lax`, matching
 * this project's documented reverse-proxy deployment topology
 * (SELF_HOST_GUIDE.md routes `/api/*` to the backend under the SAME
 * domain as the frontend — same-site by construction) and local dev
 * (Vite :5173 / Express :3001 are different ports but the same "site" —
 * both `localhost` — so Lax cookies flow between them once the frontend
 * sends `credentials: 'include'`/`'same-origin'`).
 *
 * `Lax` is also this app's PRIMARY CSRF defense: browsers withhold a Lax
 * cookie from cross-site non-GET requests entirely (fetch/XHR/form POST),
 * so a malicious third-party page cannot ride a logged-in user's session
 * to call a mutating endpoint, regardless of what that endpoint does.
 * `verifyOriginForMutation` (below) is the explicit defense-in-depth layer
 * on top of that, per this migration's own instruction not to rely on
 * SameSite/CORS alone.
 *
 * Only override to `none` (which forces `Secure` and genuinely needs the
 * extra Origin check to matter) if the deployment puts the frontend and
 * backend on genuinely different sites — not just different subdomains or
 * ports of the same registrable domain.
 */
const SESSION_COOKIE_SAMESITE = (process.env.SESSION_COOKIE_SAMESITE || 'lax') as 'lax' | 'strict' | 'none';

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

export interface CookieResponse {
  cookie(name: string, value: string, options: Record<string, unknown>): unknown;
  clearCookie(name: string, options?: Record<string, unknown>): unknown;
}

function cookieOptions(maxAgeMs?: number) {
  return {
    httpOnly: true,
    secure: isProduction() || SESSION_COOKIE_SAMESITE === 'none',
    sameSite: SESSION_COOKIE_SAMESITE,
    path: '/',
    ...(maxAgeMs !== undefined ? { maxAge: maxAgeMs } : {}),
  };
}

/** Sets the session cookie. Never call with a raw token you didn't just mint via createSession. */
export function setSessionCookie(res: CookieResponse, token: string, expiresAt: Date): void {
  res.cookie(SESSION_COOKIE_NAME, token, cookieOptions(expiresAt.getTime() - Date.now()));
}

/** Clears the session cookie client-side (logout). Does NOT revoke the session row — call revokeSession first. */
export function clearSessionCookie(res: CookieResponse): void {
  res.clearCookie(SESSION_COOKIE_NAME, cookieOptions());
}

/**
 * Defense-in-depth CSRF check for state-changing requests, independent of
 * SameSite (see the cookie policy comment above — this is the explicit
 * "do not rely on SameSite/CORS alone" layer). When the browser sends an
 * `Origin` header (it does on every cross-origin fetch, and on most
 * same-origin ones too), it must match an allowed origin. Requests with no
 * Origin header at all (some same-origin browser navigations, non-browser
 * API clients using a Bearer token elsewhere, curl) are not rejected here —
 * this check only ever tightens, never substitutes for, the cookie itself
 * being unforgeable and SameSite already blocking cross-site delivery.
 */
export function verifyOriginForMutation(req: { headers: Record<string, unknown> }, corsOrigins: string[]): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !origin) return true; // nothing to check against
  // `corsOrigins === ['*']` means CORS_ORIGINS is unconfigured (or
  // explicitly wildcarded) — there is no real allow-list to check the
  // Origin against, so a mutation that DOES present one must be treated as
  // untrusted rather than approved. Approving here would make the (very
  // common, previously-documented-as-default) wildcard config a total CSRF
  // bypass for every authenticated mutation — exactly the failure mode this
  // function exists to prevent. A genuinely same-origin request either
  // sends no Origin header at all (caught by the branch above) or is
  // already covered by an explicitly configured corsOrigins list.
  if (corsOrigins.length === 1 && corsOrigins[0] === '*') return false;
  return corsOrigins.includes(origin);
}

export type RevokeReason =
  | 'logout'
  | 'logout_all'
  | 'password_reset'
  | 'password_changed'
  | 'account_disabled'
  | 'account_deleted'
  | 'admin_action';

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Which client family a session was minted for.
 *
 *  - `web`    — the classic HttpOnly `gs_session` cookie session. Fixed
 *               30-day absolute lifetime, unchanged by this feature.
 *  - `mobile` — Capacitor/native session. The SAME opaque 256-bit token
 *               and the SAME `auth_sessions` row shape (hash-only storage,
 *               same revocation semantics); only the lifetime policy and
 *               the transport differ: it travels as
 *               `Authorization: Bearer <token>` and is stored in the iOS
 *               Keychain, never in a cookie and never in web storage.
 */
export type SessionClientType = 'web' | 'mobile';

/**
 * Mobile session lifetime policy (deliberately NOT the web 30-day fixed
 * lifetime — a native app that logs you out monthly is a broken UX):
 *  - idle lifetime: the session stays valid for 60 days after the last
 *    renewal; genuine use keeps pushing that window forward.
 *  - absolute lifetime: no mobile session outlives 365 days from creation,
 *    regardless of activity. Re-authentication is then required.
 *  - renewal throttle: the sliding window is only written back to the
 *    database at most once per 24h per session, so the hot path of every
 *    authenticated API call stays a pure read (no per-request write, no
 *    row contention).
 */
export const MOBILE_SESSION_IDLE_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
export const MOBILE_SESSION_ABSOLUTE_MS = 365 * 24 * 60 * 60 * 1000; // 365 days
export const MOBILE_SESSION_RENEW_THROTTLE_MS = 24 * 60 * 60 * 1000; // 1 day

export interface CreateSessionInput {
  userId: string;
  email: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  clientType?: SessionClientType;
}

export interface CreatedSession {
  token: string;
  sessionId: string;
  expiresAt: Date;
  clientType: SessionClientType;
}

/**
 * Deployment tolerance: migration 135 (client_type / absolute_expires_at /
 * last_renewed_at on auth_sessions) may not have been applied yet on a
 * running installation. Without this guard, EVERY login would fail with a
 * 500 ("Could not find the 'client_type' column") and every existing
 * session would stop validating. So both the insert and the read fall back
 * to the pre-135 column set once, and remember the outcome for the process.
 * Mobile sessions still require the columns (their policy is stored there),
 * so only web sessions degrade — mobile login reports the missing migration.
 */
let mobileColumnsAvailable: boolean | null = null;

function isMissingColumnError(error: { message?: string; code?: string } | null): boolean {
  if (!error) return false;
  const msg = String(error.message ?? '').toLowerCase();
  return (
    error.code === 'PGRST204' ||
    error.code === '42703' ||
    (msg.includes('column') &&
      (msg.includes('client_type') ||
        msg.includes('absolute_expires_at') ||
        msg.includes('last_renewed_at')))
  );
}

export async function createSession(config: ServerConfig, input: CreateSessionInput): Promise<CreatedSession> {
  const sb = getServiceClient(config);
  const token = generateSessionToken();
  const tokenHash = hashToken(token);
  const clientType: SessionClientType = input.clientType === 'mobile' ? 'mobile' : 'web';
  const now = Date.now();
  const expiresAt = new Date(now + (clientType === 'mobile' ? MOBILE_SESSION_IDLE_MS : SESSION_TTL_MS));
  const absoluteExpiresAt =
    clientType === 'mobile' ? new Date(now + MOBILE_SESSION_ABSOLUTE_MS) : null;

  const baseRow = {
    user_id: input.userId,
    email: input.email,
    token_hash: tokenHash,
    ip_address: input.ipAddress ?? null,
    user_agent: input.userAgent ?? null,
    expires_at: expiresAt.toISOString(),
  };
  const extendedRow = {
    ...baseRow,
    client_type: clientType,
    absolute_expires_at: absoluteExpiresAt ? absoluteExpiresAt.toISOString() : null,
    last_renewed_at: new Date(now).toISOString(),
  };

  let data: { id: string } | null = null;
  let error: { message?: string; code?: string } | null = null;

  if (mobileColumnsAvailable !== false) {
    const res = await sb.from('auth_sessions').insert(extendedRow).select('id').single();
    data = (res.data as { id: string } | null) ?? null;
    error = (res.error as { message?: string; code?: string } | null) ?? null;
    if (!error && data) mobileColumnsAvailable = true;
  }

  if (!data && (mobileColumnsAvailable === false || isMissingColumnError(error))) {
    mobileColumnsAvailable = false;
    if (clientType === 'mobile') {
      throw new Error(
        'Mobile sessions require migration 135_auth_sessions_mobile_client.sql to be applied.',
      );
    }
    console.warn(
      '[auth] auth_sessions is missing the migration 135 columns — creating a legacy web session.',
    );
    const res = await sb.from('auth_sessions').insert(baseRow).select('id').single();
    data = (res.data as { id: string } | null) ?? null;
    error = (res.error as { message?: string; code?: string } | null) ?? null;
  }

  if (error || !data) {
    throw new Error(`Failed to create session: ${error?.message ?? 'unknown error'}`);
  }

  return { token, sessionId: data.id as string, expiresAt, clientType };
}


export interface ValidatedSession {
  sessionId: string;
  userId: string;
  email: string;
  clientType: SessionClientType;
  expiresAt: Date;
  absoluteExpiresAt: Date | null;
  lastRenewedAt: Date | null;
}

/**
 * Pure read: looks up the session by token hash, returns null for
 * anything other than "exists, not revoked, not expired". Never throws for
 * a missing/invalid token — callers treat null as "not authenticated".
 *
 * Mobile sessions are additionally bounded by `absolute_expires_at`: even
 * a session whose sliding idle window is still open dies at its absolute
 * cap. Renewal of the sliding window is deliberately NOT done here (this
 * stays side-effect free); see `renewMobileSessionIfDue`.
 */
export async function validateSessionToken(config: ServerConfig, token: string | null | undefined): Promise<ValidatedSession | null> {
  if (!token || typeof token !== 'string') return null;
  const sb = getServiceClient(config);
  const tokenHash = hashToken(token);

  const EXTENDED = 'id, user_id, email, expires_at, revoked_at, client_type, absolute_expires_at, last_renewed_at';
  const BASE = 'id, user_id, email, expires_at, revoked_at';

  const read = async (columns: string) =>
    sb
      .from('auth_sessions')
      .select(columns)
      .eq('token_hash', tokenHash)
      .is('revoked_at', null)
      .maybeSingle();

  let res = mobileColumnsAvailable === false ? await read(BASE) : await read(EXTENDED);
  if (res.error && isMissingColumnError(res.error as { message?: string; code?: string })) {
    // Pre-migration-135 database — validate against the columns it has,
    // rather than logging every existing user out.
    mobileColumnsAvailable = false;
    res = await read(BASE);
  }

  const data = res.data as Record<string, unknown> | null;
  if (res.error || !data) return null;

  const now = Date.now();
  if (new Date(data.expires_at as string).getTime() < now) return null;

  const absoluteExpiresAt = data.absolute_expires_at ? new Date(data.absolute_expires_at as string) : null;
  if (absoluteExpiresAt && absoluteExpiresAt.getTime() < now) return null;


  return {
    sessionId: data.id as string,
    userId: data.user_id as string,
    email: data.email as string,
    clientType: (data.client_type as SessionClientType | undefined) === 'mobile' ? 'mobile' : 'web',
    expiresAt: new Date(data.expires_at),
    absoluteExpiresAt,
    lastRenewedAt: data.last_renewed_at ? new Date(data.last_renewed_at as string) : null,
  };
}

/**
 * Server-controlled sliding renewal for MOBILE sessions only.
 *
 * Called after a successful validation on an authenticated request. It
 * writes at most once per `MOBILE_SESSION_RENEW_THROTTLE_MS` per session
 * (so normal app usage costs no extra database write), never extends past
 * the absolute cap, never rotates the token (rotation would race with the
 * app's concurrent in-flight requests and could strand a legitimate
 * client), and never resurrects a revoked session — the update is scoped
 * to `revoked_at IS NULL`.
 *
 * Failures here are non-fatal: a renewal that could not be written just
 * means the window gets pushed on the next request. A transient database
 * or network error must never be turned into a logout.
 */
const renewalsInFlight = new Set<string>();

export async function renewMobileSessionIfDue(
  config: ServerConfig,
  session: ValidatedSession,
): Promise<void> {
  if (session.clientType !== 'mobile') return;
  const now = Date.now();
  const lastRenewed = session.lastRenewedAt?.getTime() ?? 0;
  if (now - lastRenewed < MOBILE_SESSION_RENEW_THROTTLE_MS) return;

  const cap = session.absoluteExpiresAt?.getTime() ?? now + MOBILE_SESSION_ABSOLUTE_MS;
  const nextExpiry = Math.min(now + MOBILE_SESSION_IDLE_MS, cap);
  if (nextExpiry <= session.expiresAt.getTime()) return;

  // Concurrency guard #1 (per process): a burst of simultaneous requests all
  // read the same stale `last_renewed_at`, so without this every one of them
  // would issue its own UPDATE. Only the first request per session gets to
  // write; the rest return immediately (their renewal is redundant by
  // definition — it would write the same window).
  if (renewalsInFlight.has(session.sessionId)) return;
  renewalsInFlight.add(session.sessionId);

  try {
    const sb = getServiceClient(config);
    // Concurrency guard #2 (across processes/nodes): compare-and-set. The
    // UPDATE only matches while `last_renewed_at` is still older than the
    // throttle window, so a second node racing on the same session writes
    // zero rows instead of a duplicate touch. Combined with the guard above
    // this preserves "at most one renewal write per session per 24h".
    const staleBefore = new Date(now - MOBILE_SESSION_RENEW_THROTTLE_MS).toISOString();
    await sb
      .from('auth_sessions')
      .update({
        expires_at: new Date(nextExpiry).toISOString(),
        last_renewed_at: new Date(now).toISOString(),
      })
      .eq('id', session.sessionId)
      .is('revoked_at', null)
      .lt('last_renewed_at', staleBefore);
  } catch (err) {
    console.warn('[auth] Mobile session renewal failed (non-fatal):', err);
  } finally {
    renewalsInFlight.delete(session.sessionId);
  }
}


/**
 * Extracts the session token from a request, supporting BOTH transports:
 *  - `cookie` — the browser's HttpOnly `gs_session` cookie (web, unchanged)
 *  - `bearer` — `Authorization: Bearer <opaque session token>` (Capacitor
 *    native, which has no usable cookie jar against a cross-origin API)
 *
 * The token itself is identical in both cases — the same opaque 256-bit
 * value validated by `validateSessionToken`, subject to the same
 * revocation and expiry rules. Only the transport differs, and the
 * transport is reported so callers can apply browser-only CSRF reasoning
 * to cookie requests only (a Bearer credential is never attached
 * automatically by a browser, so cross-site request forgery does not
 * apply to it).
 */
export type SessionTransport = 'cookie' | 'bearer';

export function getRequestSessionToken(req: {
  headers?: Record<string, unknown>;
  cookies?: Record<string, unknown>;
}): { token: string | null; transport: SessionTransport } {
  // Single implementation, shared with the central resolver
  // (server/lib/workspaceAuth.ts) and every route that reads the token
  // directly, so cookie/Bearer handling can never drift between them.
  return readSessionToken(req);
}

export interface ResolvedRequestSession extends ValidatedSession {
  transport: SessionTransport;
}

/**
 * Single entry point used by the central authentication resolver: pick the
 * token off whichever transport the caller used, validate it through the
 * one existing `validateSessionToken`, and (for mobile) let the server
 * slide the idle window forward.
 */
export async function resolveRequestSession(
  config: ServerConfig,
  req: { headers?: Record<string, unknown>; cookies?: Record<string, unknown> },
): Promise<ResolvedRequestSession | null> {
  const { token, transport } = getRequestSessionToken(req);
  const session = await validateSessionToken(config, token);
  if (!session) return null;
  await renewMobileSessionIfDue(config, session);
  return { ...session, transport };
}


/**
 * Revoke exactly one session (e.g. logout from this device). Idempotent —
 * revoking an already-revoked (or nonexistent) session is a no-op, but a
 * genuine database failure on the write itself MUST surface: this is a
 * security-critical mutation (callers like POST /api/auth/logout decide
 * whether the browser may be told "you're safely logged out" based on
 * this succeeding), so — unlike validateSessionToken's deliberate "errors
 * mean not-authenticated" contract — an `{ error }` here is never silently
 * swallowed. PostgREST/Supabase database failures are returned as
 * `{ error }`, not thrown, so this must be checked explicitly.
 */
export async function revokeSession(config: ServerConfig, sessionId: string, reason: RevokeReason): Promise<void> {
  const sb = getServiceClient(config);
  const { error } = await sb
    .from('auth_sessions')
    .update({ revoked_at: new Date().toISOString(), revoke_reason: reason })
    .eq('id', sessionId)
    .is('revoked_at', null);
  if (error) {
    throw new Error(`Failed to revoke session: ${error.message}`);
  }
}

/** Revoke every active session for a user (logout-all / password reset / account disabled). Returns the count actually revoked. */
export async function revokeAllSessions(
  config: ServerConfig,
  userId: string,
  reason: RevokeReason,
  exceptSessionId?: string,
): Promise<number> {
  const sb = getServiceClient(config);
  let query = sb
    .from('auth_sessions')
    .update({ revoked_at: new Date().toISOString(), revoke_reason: reason })
    .eq('user_id', userId)
    .is('revoked_at', null);

  if (exceptSessionId) {
    query = query.neq('id', exceptSessionId);
  }

  const { data, error } = await query.select('id');
  if (error) {
    throw new Error(`Failed to revoke sessions: ${error.message}`);
  }
  return data?.length ?? 0;
}

/** List active (non-revoked, non-expired) sessions for a user — for a future "active sessions" settings UI. */
export async function listActiveSessions(config: ServerConfig, userId: string) {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('auth_sessions')
    .select('id, created_at, expires_at, ip_address, user_agent')
    .eq('user_id', userId)
    .is('revoked_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Failed to list sessions: ${error.message}`);
  return data ?? [];
}
