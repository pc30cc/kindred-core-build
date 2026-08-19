/**
 * WORKSPACE MEMBERS ROUTES — canonical server-owned seat-creation
 * boundary.
 *
 * Phases:
 *   - "Workspace Member Write Boundary — Strict Seat-Creation
 *     Canonicalization Pass" (boundary introduction).
 *   - "Service-Role Companion RPC + Max Agents Activation — Strict
 *     Unblock Pass" (this file's current shape).
 *
 * Why this exists:
 *   The actual `workspace_members` INSERT happens inside the SQL
 *   `accept_workspace_invitation_as(_token, _user_id)` SECURITY
 *   DEFINER RPC, callable only by `service_role`. The original
 *   `accept_workspace_invitation(_token)` RPC has its EXECUTE
 *   revoked from `anon`/`authenticated`/`public`, closing the
 *   browser-callable bypass that previously made `requireLimit`
 *   gating circumventable.
 *
 * Scope discipline:
 *   - Seat creation only. No member listing, no role mutation, no
 *     deletion. Existing read/update/delete paths under TeamPage /
 *     StaffAccessPage / TeamDepartmentsPage are intentionally
 *     untouched.
 *   - `requireLimit('max_agents', usageFnForLimit('max_agents'))` is
 *     mounted on the seat-creation path. The bypass is closed (see
 *     companion-RPC migration), so middleware here is the canonical
 *     enforcement chokepoint.
 *   - Already-member acceptance is allowed through without consuming
 *     a new seat (idempotent re-accept of an existing membership).
 *   - Pre-flight invitation lookup uses service_role so well-formed
 *     RPC errors (Invalid/Revoked/Expired/email mismatch) keep their
 *     existing HTTP semantics even for users who would also be
 *     rejected by the limit gate.
 */

import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { requireLimit } from '../middleware/featureGating.js';
import { usageFnForLimit } from '../services/billing/usageResolvers.js';
import { requireUser as requireSessionUser } from '../lib/workspaceAuth.js';

export const workspaceMembersRouter = Router();

// ── Auth middleware — delegates to the central first-party session helper ─
async function requireUser(req: any, res: any, next: any) {
  const userId = await requireSessionUser(req, res);
  if (!userId) return;
  req.authUser = { id: userId };
  next();
}

const acceptSchema = z.object({
  token: z.string().trim().min(1).max(512),
});

// ── Pre-flight invitation context resolver ─────────────────────────
// Looks up the invitation by token via service_role, mirrors the
// original RPC's well-formed error semantics, and attaches:
//   - req.body.workspaceId         (so requireLimit can extract it)
//   - req.alreadyWorkspaceMember   (so the limit gate is skipped for
//     idempotent re-accept; existing membership consumes no new seat)
// On any RPC-equivalent precondition failure, the route responds 400
// with the same human-readable message the RPC would have raised, so
// the existing UI text path is unchanged.
async function resolveInvitationContext(req: any, res: any, next: any) {
  const config: ServerConfig = req.serverConfig;
  const parsed = acceptSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body' });
  }
  req.body.token = parsed.data.token;

  const sb = getServiceClient(config);

  const { data: inv, error: invErr } = await sb
    .from('workspace_invitations')
    .select('id, workspace_id, role, invited_email, expires_at, revoked_at')
    .eq('token', parsed.data.token)
    .maybeSingle();
  if (invErr) return res.status(500).json({ error: invErr.message });
  if (!inv) return res.status(400).json({ error: 'Invalid invitation token' });
  if (inv.revoked_at) {
    return res.status(400).json({ error: 'Invitation has been revoked' });
  }
  if (inv.expires_at && new Date(inv.expires_at).getTime() < Date.now()) {
    return res.status(400).json({ error: 'Invitation has expired' });
  }

  if (inv.invited_email) {
    const { data: profile } = await sb
      .from('profiles')
      .select('email')
      .eq('id', req.authUser.id)
      .maybeSingle();
    const userEmail = (profile?.email || '').trim().toLowerCase();
    const inviteEmail = String(inv.invited_email).trim().toLowerCase();
    if (!userEmail || userEmail !== inviteEmail) {
      return res
        .status(400)
        .json({ error: 'This invitation is for a different email address' });
    }
  }

  // Already a member? Skip the seat-limit check — re-accepting an
  // existing membership cannot consume a new seat, and gating it
  // would lock legitimate users out when their workspace is full.
  const { data: existingMember } = await sb
    .from('workspace_members')
    .select('user_id')
    .eq('workspace_id', inv.workspace_id)
    .eq('user_id', req.authUser.id)
    .maybeSingle();
  req.alreadyWorkspaceMember = !!existingMember;

  // Expose workspaceId where requireLimit's extractor looks for it.
  req.body.workspaceId = inv.workspace_id;
  req.invitationContext = { id: inv.id, workspace_id: inv.workspace_id };
  next();
}

// Wrap requireLimit so already-member acceptance bypasses the gate.
const maxAgentsLimitMw = (() => {
  const inner = requireLimit('max_agents', usageFnForLimit('max_agents'));
  return (req: any, res: any, next: any) => {
    if (req.alreadyWorkspaceMember) return next();
    return inner(req, res, next);
  };
})();

// ──────────────────────────────────────────────────────────────────
// POST /api/workspace-members/accept-invitation
// Canonical server-owned seat-creation boundary.
// Body: { token: string }
// Auth: Bearer access token (Supabase user JWT).
// ──────────────────────────────────────────────────────────────────
workspaceMembersRouter.post(
  '/accept-invitation',
  requireUser,
  resolveInvitationContext,
  maxAgentsLimitMw,
  async (req: any, res) => {
    const config: ServerConfig = req.serverConfig;
    const sb = getServiceClient(config);

    // Service-role-only companion RPC. EXECUTE is granted only to
    // service_role; the browser cannot reach this function path.
    const { data, error } = await sb.rpc('accept_workspace_invitation_as', {
      _token: req.body.token,
      _user_id: req.authUser.id,
    });

    if (error) {
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
  },
);