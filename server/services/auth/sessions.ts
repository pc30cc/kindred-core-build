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
  if (corsOrigins.length === 1 && corsOrigins[0] === '*') return true; // operator explicitly opted into any origin
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

export interface CreateSessionInput {
  userId: string;
  email: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface CreatedSession {
  token: string;
  sessionId: string;
  expiresAt: Date;
}

export async function createSession(config: ServerConfig, input: CreateSessionInput): Promise<CreatedSession> {
  const sb = getServiceClient(config);
  const token = generateSessionToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  const { data, error } = await sb
    .from('auth_sessions')
    .insert({
      user_id: input.userId,
      email: input.email,
      token_hash: tokenHash,
      ip_address: input.ipAddress ?? null,
      user_agent: input.userAgent ?? null,
      expires_at: expiresAt.toISOString(),
    })
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(`Failed to create session: ${error?.message ?? 'unknown error'}`);
  }

  return { token, sessionId: data.id as string, expiresAt };
}

export interface ValidatedSession {
  sessionId: string;
  userId: string;
  email: string;
}

/**
 * Pure read: looks up the session by token hash, returns null for
 * anything other than "exists, not revoked, not expired". Never throws for
 * a missing/invalid token — callers treat null as "not authenticated".
 */
export async function validateSessionToken(config: ServerConfig, token: string | null | undefined): Promise<ValidatedSession | null> {
  if (!token || typeof token !== 'string') return null;
  const sb = getServiceClient(config);
  const tokenHash = hashToken(token);

  const { data, error } = await sb
    .from('auth_sessions')
    .select('id, user_id, email, expires_at, revoked_at')
    .eq('token_hash', tokenHash)
    .is('revoked_at', null)
    .maybeSingle();

  if (error || !data) return null;
  if (new Date(data.expires_at).getTime() < Date.now()) return null;

  return { sessionId: data.id as string, userId: data.user_id as string, email: data.email as string };
}

/** Revoke exactly one session (e.g. logout from this device). Idempotent — revoking an already-revoked session is a no-op. */
export async function revokeSession(config: ServerConfig, sessionId: string, reason: RevokeReason): Promise<void> {
  const sb = getServiceClient(config);
  await sb
    .from('auth_sessions')
    .update({ revoked_at: new Date().toISOString(), revoke_reason: reason })
    .eq('id', sessionId)
    .is('revoked_at', null);
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
