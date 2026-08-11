/**
 * AI Agent router — shared route infrastructure.
 *
 * Genuinely shared auth helpers used by multiple domain subrouters.
 * Extracted verbatim from the original server/routes/aiAgent.ts as part of
 * the Phase 3 mechanical router split. No behavior change.
 */
import type { Request, Response } from 'express';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { isGlobalAdmin } from '../../middleware/adminBypass.js';

// ─── Shared auth resolution ───
// Resolves the current user from either the standard `Authorization: Bearer`
// header used by the SPA, or the `sb-access-token` HTTP-only cookie fallback.
// Mirrors the auth pattern used elsewhere in the AI Agent router so that
// middleware (advanced-tools guard, kill switch) and per-route handlers
// authenticate the same way.
export async function resolveCurrentUserId(
  req: Request,
  config: ServerConfig,
): Promise<{ userId: string | null; reason?: 'missing' | 'invalid' }> {
  let token: string | null = null;
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.replace('Bearer ', '').trim() || null;
  }
  if (!token) {
    const cookieToken =
      (req as any).cookies?.['sb-access-token'] ||
      (req as any).cookies?.['sb:token'] ||
      null;
    if (cookieToken && typeof cookieToken === 'string') token = cookieToken;
  }
  if (!token) return { userId: null, reason: 'missing' };
  try {
    const sb = getServiceClient(config);
    const { data: { user }, error } = await sb.auth.getUser(token);
    if (error || !user) return { userId: null, reason: 'invalid' };
    return { userId: user.id };
  } catch {
    return { userId: null, reason: 'invalid' };
  }
}

// ─── Auth: workspace member (or global admin) ───
export async function authorizeMember(
  req: Request,
  res: Response,
  config: ServerConfig,
  workspaceId: string,
): Promise<{ userId: string; isAdmin: boolean; role: string | null } | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing authorization' });
    return null;
  }
  const token = authHeader.replace('Bearer ', '');
  const sb = getServiceClient(config);
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) {
    res.status(401).json({ error: 'Invalid token' });
    return null;
  }
  const isAdmin = await isGlobalAdmin(config, user.id);
  let role: string | null = null;
  if (!isAdmin) {
    const { data: isMember } = await sb.rpc('is_workspace_member', {
      _workspace_id: workspaceId,
      _user_id: user.id,
    });
    if (!isMember) {
      res.status(403).json({ error: 'Not a workspace member' });
      return null;
    }
    const { data: member } = await sb
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', user.id)
      .maybeSingle();
    role = (member?.role as string) || null;
  }
  return { userId: user.id, isAdmin, role };
}

export function isOwnerOrAdmin(role: string | null, isGlobalAdmin: boolean): boolean {
  if (isGlobalAdmin) return true;
  return role === 'owner' || role === 'admin';
}

export function requireWorkspace(req: Request): string | null {
  return String(
    req.query.workspaceId || req.query.workspace_id || (req.body && req.body.workspaceId) || '',
  ) || null;
}

// ─── E5 — shared redaction helper ───
// Strips storage paths, signed URLs, credentials, tokens. Used by both the
// Answer Inspector (GET /runs/:id/inspect, activity domain) and the
// Retrieval Debugger (POST /debug/retrieval, internal-qa domain).
export const SENSITIVE_KEY_PATTERNS = [
  'storage_path','storage_url','signed_url','signedurl','signature','token','secret',
  'password','credential','access_key','accesskey','api_key','apikey','authorization',
];
export function redactDeep(obj: any, depth = 0): any {
  if (obj == null || depth > 6) return obj;
  if (Array.isArray(obj)) return obj.map((v) => redactDeep(v, depth + 1));
  if (typeof obj === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) {
      const lk = k.toLowerCase();
      if (SENSITIVE_KEY_PATTERNS.some((p) => lk.includes(p))) continue;
      out[k] = redactDeep(v, depth + 1);
    }
    return out;
  }
  return obj;
}
