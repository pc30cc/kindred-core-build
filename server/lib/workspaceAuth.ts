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
import { lookup } from 'node:dns/promises';

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

/**
 * SSRF guard for operator-supplied provider base URLs.
 * Only https (or http on an explicitly allow-listed host) to a public host is
 * permitted; private/loopback/link-local/metadata targets are rejected.
 */
const PRIVATE_HOST_RE =
  /^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata|metadata\.google\.internal)$/i;

/** Lowercases and strips a trailing FQDN dot so `evil.internal.` cannot bypass the host rules. */
export function normalizeHostname(host: string): string {
  return host.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();
}

/** True when the hostname itself is a forbidden internal/metadata name. */
export function isBlockedHostname(host: string): boolean {
  return PRIVATE_HOST_RE.test(normalizeHostname(host));
}

function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  return false;
}

/** Extracts a dotted IPv4 from an IPv4-mapped IPv6 literal, hex or dotted form. */
/**
 * Reads the first 16-bit group of an IPv6 address, supporting the compressed
 * `::` form. Returns null for malformed input (callers must fail closed).
 */
export function ipv6First16Bits(addr: string): number | null {
  const host = addr.toLowerCase().replace(/%.*$/, '').replace(/^\[|\]$/g, '');
  if (!host.includes(':')) return null;
  const doubleColons = host.split('::').length - 1;
  if (doubleColons > 1) return null;
  const head = host.split('::')[0];
  // `::xxxx` (leading compression) means the first group is zero.
  if (head === '') return 0;
  const first = head.split(':')[0];
  if (!/^[0-9a-f]{1,4}$/.test(first)) return null;
  return parseInt(first, 16);
}

/** True for fe80::/10 (link-local), covering fe80 … febf. */
export function isIpv6LinkLocal(addr: string): boolean {
  const first = ipv6First16Bits(addr);
  if (first === null) return false;
  return (first & 0xffc0) === 0xfe80;
}

function mappedIpv4(host: string): string | null {
  const dotted = host.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (dotted) return dotted[1];
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return null;
}

export function isSafeOutboundUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  if (u.port && !(Number(u.port) > 0 && Number(u.port) <= 65535)) return false;
  const host = normalizeHostname(u.hostname);
  if (!host) return false;
  if (isBlockedHostname(host)) return false;
  if (isPrivateIpv4(host)) return false;
  // IPv4-mapped / IPv4-compatible IPv6 literals (e.g. ::ffff:127.0.0.1)
  const mapped = mappedIpv4(host);
  if (mapped && isPrivateIpv4(mapped)) return false;
  // IPv6 loopback / unique-local / link-local
  if (host === '::1' || host === '::' || /^f[cd][0-9a-f]{2}:/i.test(host) || isIpv6LinkLocal(host)) return false;
  if (/^ff[0-9a-f]{2}:/i.test(host)) return false; // IPv6 multicast
  return true;
}

/** True when an IPv4 literal is reserved/multicast/broadcast-sensitive. */
function isBlockedIpv4(host: string): boolean {
  if (isPrivateIpv4(host)) return true;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isBlockedIpv6(addr: string): boolean {
  const host = addr.toLowerCase().replace(/%.*$/, '');
  if (host === '::1' || host === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // unique-local
  if (isIpv6LinkLocal(host)) return true; // fe80::/10
  if (/^ff[0-9a-f]{2}:/.test(host)) return true; // multicast
  const mapped = mappedIpv4(host);
  if (mapped) return isBlockedIpv4(mapped);
  return false;
}

/** Shared address gate: true when this resolved address must never be connected to. */
export function isBlockedIpAddress(address: string, family: number): boolean {
  return family === 6 || address.includes(':')
    ? isBlockedIpv6(address)
    : isBlockedIpv4(address);
}

export type OutboundUrlCheck = { ok: true } | { ok: false; reason: string };

/**
 * Full SSRF pre-flight: syntactic checks plus DNS resolution of every answer.
 * Fail-closed — DNS errors and any private/loopback/link-local/metadata answer
 * reject the URL.
 */
export async function checkOutboundUrl(raw: string): Promise<OutboundUrlCheck> {
  if (!isSafeOutboundUrl(raw)) return { ok: false, reason: 'unsafe_url' };
  const host = normalizeHostname(new URL(raw).hostname);

  // IP literals are already validated syntactically above.
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return isBlockedIpv4(host) ? { ok: false, reason: 'private_ip' } : { ok: true };
  }
  if (host.includes(':')) {
    return isBlockedIpv6(host) ? { ok: false, reason: 'private_ip' } : { ok: true };
  }

  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await lookup(host, { all: true });
  } catch {
    return { ok: false, reason: 'dns_failure' };
  }
  if (!answers || answers.length === 0) return { ok: false, reason: 'dns_failure' };
  for (const a of answers) {
    const blocked = a.family === 6 ? isBlockedIpv6(a.address) : isBlockedIpv4(a.address);
    if (blocked) return { ok: false, reason: 'private_ip' };
  }
  return { ok: true };
}
