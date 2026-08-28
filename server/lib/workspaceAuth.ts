/**
 * Shared user + workspace authorization helpers for HTTP routes.
 *
 * AUTHENTICATION (this file's `requireUser`) is first-party as of the auth
 * migration: identity is derived from the `gs_session` HttpOnly cookie
 * (server/services/auth/sessions.ts, backed by `public.auth_sessions`), not
 * from a Supabase Auth JWT. `sb.auth.getUser()` / GoTrue is no longer this
 * codebase's root of trust for dashboard/application authentication —
 * Supabase/PostgreSQL remains only as database infrastructure.
 *
 * AUTHORIZATION (`authorizeWorkspaceAccess` below) is unchanged: workspace
 * membership and role are still verified server-side via the same
 * `is_workspace_member`/`workspace_members` checks, using service_role
 * (which bypasses RLS) — the anon key was never treated as an identity, and
 * still isn't.
 */

import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { isGlobalAdmin } from '../middleware/adminBypass.js';
import { validateSessionToken, verifyOriginForMutation, SESSION_COOKIE_NAME } from '../services/auth/sessions.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export type WorkspaceAuth = { userId: string; isAdmin: boolean; role: string | null };

export function serverConfigOf(req: any): ServerConfig {
  return (req as any).serverConfig as ServerConfig;
}

/**
 * Resolves the caller from the first-party session cookie. Writes 401 and
 * returns null on failure — missing cookie, unknown/expired/revoked
 * session, all indistinguishable to the caller (no information about
 * *why* auth failed is ever leaked here).
 *
 * CSRF: for state-changing methods, also requires `verifyOriginForMutation`
 * to pass. This is the single choke point essentially every authenticated
 * dashboard route already goes through (directly, or via
 * `authorizeWorkspaceAccess`/`requirePlatformAdmin` below, which both call
 * this), so wiring the check here — rather than per-route — is what
 * actually makes it apply everywhere instead of existing only as unit-
 * tested, never-called dead code. SameSite=Lax (sessions.ts) is the primary
 * defense; this is the explicit defense-in-depth layer for SameSite=None
 * deployments and non-preflighted request shapes.
 *
 * DISABLED-ACCOUNT ENFORCEMENT — DELIBERATELY NOT CHECKED HERE. This
 * function validates the SESSION (exists, unrevoked, unexpired) but does
 * not independently re-check user_credentials.status on every request.
 * That is a conscious choice, not an oversight:
 *   - POST /api/admin/block-user revokes every active session for the
 *     target atomically WITH the status flip (admin_set_user_block_status,
 *     database/migrations/034) — a session that existed at block time is
 *     provably gone by the time that call returns, via the exact same
 *     `revoked_at IS NULL` check this function already performs
 *     (validateSessionToken, services/auth/sessions.ts). No separate
 *     status lookup is needed to catch that case.
 *   - POST /api/auth/login independently checks `identity.status ===
 *     'disabled'` before ever minting a session, so a disabled account
 *     cannot acquire a NEW valid session through the normal login path.
 *   - The one session-creation path that bypasses login — admin
 *     impersonation (GET /api/auth/impersonate) — is separately gated: it
 *     rejects a disabled target before calling createSession() (see that
 *     route's own comment).
 * Given those three, the only remaining gap is a session minted by some
 * FUTURE code path that neither goes through login nor gets swept by a
 * block — and closing that hypothetical by joining user_credentials.status
 * into this function would add a query to literally every authenticated
 * request in the app for a case that does not currently exist. That cost
 * was judged not worth paying here; if a new session-issuing path is ever
 * added, it must perform its own status check the way impersonation now
 * does, rather than relying on this function to catch it.
 */
export async function requireUser(req: any, res: any): Promise<string | null> {
  const config = serverConfigOf(req);
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  const session = await validateSessionToken(config, token);
  if (!session) {
    res.status(401).json({ error: 'Not authenticated' });
    return null;
  }
  if (MUTATING_METHODS.has(req.method) && !verifyOriginForMutation(req, config.corsOrigins)) {
    res.status(403).json({ error: 'Origin not allowed' });
    return null;
  }
  return session.userId;
}

/**
 * Authenticates the caller and verifies they may act on `workspaceId`.
 * `manage: true` additionally requires workspace owner/admin.
 */
export async function authorizeWorkspaceAccess(
  req: any,
  res: any,
  workspaceId: unknown,
  opts: { manage?: boolean } = {},
): Promise<WorkspaceAuth | null> {
  const userId = await requireUser(req, res);
  if (!userId) return null;

  if (typeof workspaceId !== 'string' || !UUID_RE.test(workspaceId)) {
    res.status(400).json({ error: 'Invalid workspaceId' });
    return null;
  }

  const config = serverConfigOf(req);
  if (await isGlobalAdmin(config, userId)) return { userId, isAdmin: true, role: null };

  const sb = getServiceClient(config);
  const { data: isMember, error: memberError } = await sb.rpc('is_workspace_member', {
    _workspace_id: workspaceId,
    _user_id: userId,
  });
  // A backend failure is NOT a negative membership answer: fail with 500 so we
  // never turn an outage into a silent (and misleading) authorization verdict.
  if (memberError) {
    res.status(500).json({ error: 'Authorization check failed' });
    return null;
  }
  if (!isMember) {
    res.status(403).json({ error: 'Not a workspace member' });
    return null;
  }

  const { data: member, error: roleError } = await sb
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle();
  if (roleError) {
    res.status(500).json({ error: 'Authorization check failed' });
    return null;
  }
  const role = ((member as { role?: string } | null)?.role) ?? null;

  if (opts.manage && role !== 'owner' && role !== 'admin') {
    res.status(403).json({ error: 'Insufficient workspace permissions' });
    return null;
  }
  return { userId, isAdmin: false, role };
}

/** Platform super-admin gate (`has_role(uid,'admin')`). */
export async function requirePlatformAdmin(req: any, res: any): Promise<string | null> {
  const userId = await requireUser(req, res);
  if (!userId) return null;
  if (!(await isGlobalAdmin(serverConfigOf(req), userId))) {
    res.status(403).json({ error: 'Not authorized' });
    return null;
  }
  return userId;
}

// SSRF guards moved to shared/net/hostGuard.ts so the AI Runtime and Channels
// Worker (separate deployables) can enforce the exact same policy. Re-exported
// here so existing Core imports keep working.
export {
  normalizeHostname,
  isBlockedHostname,
  ipv6First16Bits,
  isIpv6LinkLocal,
  isSafeOutboundUrl,
  isBlockedIpAddress,
  checkOutboundUrl,
} from '../../shared/net/hostGuard.js';
export type { OutboundUrlCheck } from '../../shared/net/hostGuard.js';
