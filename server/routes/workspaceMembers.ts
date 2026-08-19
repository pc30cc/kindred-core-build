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
 *   - Seat creation via the invitation-acceptance RPC is unchanged.
 *   - Member listing/role/deletion and invitation CRUD (below) were
 *     added to move TeamPage / StaffAccessPage / TeamDepartmentsPage
 *     off direct `supabase.from()` calls (see the block comment
 *     further down this file for why).
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
import { requireUser as requireSessionUser, authorizeWorkspaceAccess } from '../lib/workspaceAuth.js';

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

// ──────────────────────────────────────────────────────────────────
// Team management — members, roles, invitations.
//
// These replace direct `supabase.from('workspace_members'/
// 'workspace_invitations')` calls from TeamPage.tsx / StaffAccessPage.tsx
// / TeamDepartmentsPage.tsx, which relied on RLS scoped to auth.uid() and
// silently returned/wrote nothing once the frontend stopped carrying a
// Supabase Auth session (see the class of bug this migration exists to
// close). Reads are any-member (authorizeWorkspaceAccess); writes/deletes
// require owner/admin (manage: true), matching the RLS policies these
// routes replace (ws_admins_manage_invitations, and workspace_members'
// own owner/admin-only write policy).
// ──────────────────────────────────────────────────────────────────

const workspaceIdQuerySchema = z.object({ workspaceId: z.string().uuid() });

// Mirrors the DB `workspace_role` enum (see supabase/migrations). Keep in
// sync — TeamPage.tsx's `assignableRoles` / `allRolesWithOwner` assumes the
// backend accepts every one of these, not just owner/admin/agent.
const workspaceRoleSchema = z.enum([
  'owner', 'admin', 'agent', 'viewer', 'team_lead', 'sales_agent',
  'support_agent', 'marketing_manager', 'seo_manager', 'analyst',
  'developer', 'billing',
]);

// GET /api/workspace-members?workspaceId=... — members with profile + department names.
workspaceMembersRouter.get('/', async (req, res) => {
  const parsedQuery = workspaceIdQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) return res.status(400).json({ error: 'workspaceId is required' });
  const { workspaceId } = parsedQuery.data;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;

  const config: ServerConfig = (req as any).serverConfig;
  const sb = getServiceClient(config);
  const { data: members, error: memberErr } = await sb
    .from('workspace_members')
    .select('id, role, created_at, user_id')
    .eq('workspace_id', workspaceId);
  if (memberErr) return res.status(500).json({ error: memberErr.message });

  const userIds = (members || []).map((m: any) => m.user_id);
  const [{ data: profiles }, { data: deptMembers }, { data: depts }] = await Promise.all([
    userIds.length
      ? sb.from('profiles').select('id, full_name, email, avatar_url').in('id', userIds)
      : Promise.resolve({ data: [] as any[] }),
    sb.from('workspace_department_members').select('user_id, department_id').eq('workspace_id', workspaceId),
    sb.from('workspace_departments').select('id, name').eq('workspace_id', workspaceId),
  ]);
  const deptNameById = new Map((depts || []).map((d: any) => [d.id, d.name]));
  const deptsByUser = new Map<string, string[]>();
  for (const dm of deptMembers || []) {
    const name = deptNameById.get(dm.department_id);
    if (!name) continue;
    const list = deptsByUser.get(dm.user_id) || [];
    list.push(name);
    deptsByUser.set(dm.user_id, list);
  }

  const result = (members || []).map((m: any) => ({
    ...m,
    profile: (profiles || []).find((p: any) => p.id === m.user_id) || null,
    department_names: deptsByUser.get(m.user_id) || [],
  }));
  return res.json({ members: result });
});

const updateRoleSchema = z.object({ role: workspaceRoleSchema });

// PATCH /api/workspace-members/:memberId?workspaceId=... — update a member's role.
workspaceMembersRouter.patch('/:memberId', async (req, res) => {
  const parsedQuery = workspaceIdQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) return res.status(400).json({ error: 'workspaceId is required' });
  const parsedBody = updateRoleSchema.safeParse(req.body);
  if (!parsedBody.success) return res.status(400).json({ error: 'invalid_role' });
  const { workspaceId } = parsedQuery.data;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;

  const config: ServerConfig = (req as any).serverConfig;
  const sb = getServiceClient(config);
  const { error } = await sb
    .from('workspace_members')
    .update({ role: parsedBody.data.role })
    .eq('id', req.params.memberId)
    .eq('workspace_id', workspaceId);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
});

// DELETE /api/workspace-members/:memberId?workspaceId=... — remove a member.
workspaceMembersRouter.delete('/:memberId', async (req, res) => {
  const parsedQuery = workspaceIdQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) return res.status(400).json({ error: 'workspaceId is required' });
  const { workspaceId } = parsedQuery.data;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;

  const config: ServerConfig = (req as any).serverConfig;
  const sb = getServiceClient(config);
  const { error } = await sb
    .from('workspace_members')
    .delete()
    .eq('id', req.params.memberId)
    .eq('workspace_id', workspaceId);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
});

// GET /api/workspace-members/user/:userId/departments?workspaceId=... — department ids
// assigned to a member, keyed by user id (not the workspace_members row id — a member
// can only belong to one workspace_members row per workspace, but department
// assignments in workspace_department_members are keyed by user_id).
workspaceMembersRouter.get('/user/:userId/departments', async (req, res) => {
  const parsedQuery = workspaceIdQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) return res.status(400).json({ error: 'workspaceId is required' });
  const { workspaceId } = parsedQuery.data;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;

  const config: ServerConfig = (req as any).serverConfig;
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('workspace_department_members')
    .select('department_id')
    .eq('workspace_id', workspaceId)
    .eq('user_id', req.params.userId);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ department_ids: (data || []).map((r: any) => r.department_id) });
});

const setMemberDeptsSchema = z.object({ department_ids: z.array(z.string().uuid()) });

// PUT /api/workspace-members/user/:userId/departments?workspaceId=... — replace a
// member's full department assignment set.
workspaceMembersRouter.put('/user/:userId/departments', async (req, res) => {
  const parsedQuery = workspaceIdQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) return res.status(400).json({ error: 'workspaceId is required' });
  const parsedBody = setMemberDeptsSchema.safeParse(req.body);
  if (!parsedBody.success) return res.status(400).json({ error: 'invalid_body' });
  const { workspaceId } = parsedQuery.data;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;

  const config: ServerConfig = (req as any).serverConfig;
  const sb = getServiceClient(config);
  const userId = req.params.userId;
  const { department_ids } = parsedBody.data;

  const { error: delErr } = await sb
    .from('workspace_department_members')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId);
  if (delErr) return res.status(500).json({ error: delErr.message });

  if (department_ids.length > 0) {
    const rows = department_ids.map((department_id) => ({ workspace_id: workspaceId, user_id: userId, department_id }));
    const { error: insErr } = await sb.from('workspace_department_members').insert(rows);
    if (insErr) return res.status(500).json({ error: insErr.message });
  }
  return res.json({ ok: true });
});

// GET /api/workspace-members/invitations?workspaceId=... — pending/past invitations.
workspaceMembersRouter.get('/invitations', async (req, res) => {
  const parsedQuery = workspaceIdQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) return res.status(400).json({ error: 'workspaceId is required' });
  const { workspaceId } = parsedQuery.data;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;

  const config: ServerConfig = (req as any).serverConfig;
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('workspace_invitations')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ invitations: data || [] });
});

const createInvitationSchema = z.object({
  workspaceId: z.string().uuid(),
  role: workspaceRoleSchema,
  invitedEmail: z.string().email().nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});

// POST /api/workspace-members/invitations — create an invitation.
workspaceMembersRouter.post('/invitations', async (req, res) => {
  const parsed = createInvitationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten().fieldErrors });
  const { workspaceId, role, invitedEmail, expiresAt } = parsed.data;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;

  const config: ServerConfig = (req as any).serverConfig;
  const sb = getServiceClient(config);
  const insertData: Record<string, unknown> = {
    workspace_id: workspaceId,
    role,
    created_by: auth.userId,
    max_uses: 0,
    invited_email: invitedEmail || null,
  };
  if (expiresAt) insertData.expires_at = expiresAt;

  const { data, error } = await sb.from('workspace_invitations').insert(insertData).select().single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ invitation: data });
});

// PATCH /api/workspace-members/invitations/:id?workspaceId=... — revoke an invitation.
workspaceMembersRouter.patch('/invitations/:id', async (req, res) => {
  const parsedQuery = workspaceIdQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) return res.status(400).json({ error: 'workspaceId is required' });
  const { workspaceId } = parsedQuery.data;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;

  const config: ServerConfig = (req as any).serverConfig;
  const sb = getServiceClient(config);
  const { error } = await sb
    .from('workspace_invitations')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('workspace_id', workspaceId);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
});

// DELETE /api/workspace-members/invitations/:id?workspaceId=... — delete an invitation.
workspaceMembersRouter.delete('/invitations/:id', async (req, res) => {
  const parsedQuery = workspaceIdQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) return res.status(400).json({ error: 'workspaceId is required' });
  const { workspaceId } = parsedQuery.data;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;

  const config: ServerConfig = (req as any).serverConfig;
  const sb = getServiceClient(config);
  const { error } = await sb
    .from('workspace_invitations')
    .delete()
    .eq('id', req.params.id)
    .eq('workspace_id', workspaceId);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
});