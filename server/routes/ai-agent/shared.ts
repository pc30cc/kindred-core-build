/**
 * AI Agent router — shared route infrastructure.
 *
 * Genuinely shared auth helpers used by multiple domain subrouters.
 * Extracted verbatim from the original server/routes/aiAgent.ts as part of
 * the Phase 3 mechanical router split. No behavior change.
 */
import type { Request, Response } from 'express';
import type { ServerConfig } from '../../config.js';
import { validateSessionToken, SESSION_COOKIE_NAME } from '../../services/auth/sessions.js';
import { authorizeWorkspaceAccess } from '../../lib/workspaceAuth.js';

// ─── Shared auth resolution ───
// Resolves the current user from the first-party gs_session HttpOnly
// cookie (server/services/auth/sessions.ts). Mirrors the auth pattern used
// elsewhere in the AI Agent router so that middleware (advanced-tools
// guard, kill switch) and per-route handlers authenticate the same way.
export async function resolveCurrentUserId(
  req: Request,
  config: ServerConfig,
): Promise<{ userId: string | null; reason?: 'missing' | 'invalid' }> {
  const token = (req as any).cookies?.[SESSION_COOKIE_NAME];
  if (!token) return { userId: null, reason: 'missing' };
  try {
    const session = await validateSessionToken(config, token);
    if (!session) return { userId: null, reason: 'invalid' };
    return { userId: session.userId };
  } catch {
    return { userId: null, reason: 'invalid' };
  }
}

// ─── Auth: workspace member (or global admin) ───
export async function authorizeMember(
  req: Request,
  res: Response,
  _config: ServerConfig,
  workspaceId: string,
): Promise<{ userId: string; isAdmin: boolean; role: string | null } | null> {
  return authorizeWorkspaceAccess(req, res, workspaceId);
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
