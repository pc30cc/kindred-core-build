/**
 * Shared user + workspace authorization helpers for HTTP routes.
 *
 * The publishable (anon) key is NOT an identity: it is embedded in the
 * frontend bundle and readable by anyone. Routes that act on workspace data
 * or spend workspace resources must derive identity from a real Supabase user
 * JWT and verify workspace membership server-side before any service-role
 * (RLS-bypassing) access happens.
 */

import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { isGlobalAdmin } from '../middleware/adminBypass.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type WorkspaceAuth = { userId: string; isAdmin: boolean; role: string | null };

export function serverConfigOf(req: any): ServerConfig {
  return (req as any).serverConfig as ServerConfig;
}

/** Resolves the caller from the Bearer JWT. Writes 401 and returns null on failure. */
export async function requireUser(req: any, res: any): Promise<string | null> {
  const config = serverConfigOf(req);
  const authHeader = req.headers?.authorization;
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing authorization' });
    return null;
  }
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token || token === config.supabaseAnonKey || token === config.supabaseServiceRoleKey) {
    res.status(401).json({ error: 'Invalid token' });
    return null;
  }
  try {
    const { data, error } = await getServiceClient(config).auth.getUser(token);
    if (error || !data?.user) {
      res.status(401).json({ error: 'Invalid token' });
      return null;
    }
    return data.user.id;
  } catch {
    res.status(401).json({ error: 'Invalid token' });
    return null;
  }
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
  const { data: isMember } = await sb.rpc('is_workspace_member', {
    _workspace_id: workspaceId,
    _user_id: userId,
  });
  if (!isMember) {
    res.status(403).json({ error: 'Not a workspace member' });
    return null;
  }

  const { data: member } = await sb
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle();
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
  /^(localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i;

function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export function isSafeOutboundUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return false;
  if (PRIVATE_HOST_RE.test(host)) return false;
  if (isPrivateIpv4(host)) return false;
  // IPv6 loopback / unique-local / link-local
  if (host === '::1' || /^f[cd][0-9a-f]{2}:/i.test(host) || /^fe80:/i.test(host)) return false;
  return true;
}
