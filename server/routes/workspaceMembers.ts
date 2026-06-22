/**
 * WORKSPACE MEMBERS ROUTES — canonical server-owned seat-creation
 * boundary.
 *
 * Phase: "Workspace Member Write Boundary — Strict Seat-Creation
 * Canonicalization Pass."
 *
 * Why this exists:
 *   The actual `workspace_members` INSERT happens inside the SQL
 *   `accept_workspace_invitation(_token)` SECURITY DEFINER RPC. Until
 *   this router shipped, that RPC was called directly from the
 *   browser (`src/pages/auth/InvitePage.tsx`) via the Supabase JS
 *   client, so the canonical seat-creation moment had no Express
 *   surface that `featureGating.ts` could attach to. This router
 *   provides exactly that one surface — narrow, additive, and
 *   forwarding the user's JWT so the RPC's `auth.uid()` semantics
 *   stay identical.
 *
 * Scope discipline:
 *   - Seat creation only. No member listing, no role mutation, no
 *     deletion. Existing read/update/delete paths under TeamPage /
 *     StaffAccessPage / TeamDepartmentsPage are intentionally
 *     untouched.
 *   - No `requireLimit('max_agents', ...)` is mounted yet. The
 *     existing RPC remains callable directly by `authenticated` JWTs
 *     under RLS; gating only this route would be circumventable.
 *     See `docs/MAX_AGENTS_POLICY.md` for the remaining unblock
 *     criterion (revoke RPC EXECUTE from `authenticated`).
 */

import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';

export const workspaceMembersRouter = Router();

// ── Auth middleware (mirrors the proven pattern in account.ts) ───
async function requireUser(req: any, res: any, next: any) {
  const config: ServerConfig = req.serverConfig;
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization' });
  }
  const token = authHeader.slice(7);
  const sb = getServiceClient(config);
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  req.authUser = data.user;
  req.authToken = token;
  next();
}

const acceptSchema = z.object({
  token: z.string().trim().min(1).max(512),
});

// ──────────────────────────────────────────────────────────────────
// POST /api/workspace-members/accept-invitation
// Canonical server-owned seat-creation boundary.
// Body: { token: string }
// Auth: Bearer access token (Supabase user JWT).
// ──────────────────────────────────────────────────────────────────
workspaceMembersRouter.post('/accept-invitation', requireUser, async (req: any, res) => {
  const config: ServerConfig = req.serverConfig;
  const parsed = acceptSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body' });
  }

  // Forward the user's JWT into a scoped Supabase client so the
  // SECURITY DEFINER RPC continues to see the correct `auth.uid()`.
  // Service role MUST NOT be used here — the RPC enforces the
  // invite-email match against the calling user's profile.
  const { createClient } = await import('@supabase/supabase-js');
  const userClient = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${req.authToken}` } },
  });

  const { data, error } = await userClient.rpc('accept_workspace_invitation', {
    _token: parsed.data.token,
  });

  if (error) {
    // Map well-known RPC errors to HTTP semantics; keep the original
    // message in the body so the existing UI text path is unchanged.
    const msg = error.message || 'invitation_failed';
    const lower = msg.toLowerCase();
    if (lower.includes('not authenticated')) {
      return res.status(401).json({ error: msg });
    }
    if (
      lower.includes('invalid invitation') ||
      lower.includes('expired') ||
      lower.includes('revoked') ||
      lower.includes('different email')
    ) {
      return res.status(400).json({ error: msg });
    }
    return res.status(500).json({ error: msg });
  }

  return res.json(data);
});