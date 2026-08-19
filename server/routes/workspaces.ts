/**
 * WORKSPACE RESOLUTION ROUTES — release-critical.
 *
 * Backs `useWorkspaces()`/`useAccount()`/`useCreateWorkspace()`
 * (src/hooks/useWorkspace.ts), which used to query `workspaces`/`accounts`
 * directly from the browser and rely on RLS scoped to `auth.uid()`. Now
 * that dashboard identity comes from the first-party `gs_session` cookie
 * (server/lib/workspaceAuth.ts) instead of a Supabase Auth session,
 * `auth.uid()` is NULL for those browser-direct queries — they silently
 * returned zero rows, meaning no logged-in user could resolve a workspace
 * to enter the app at all. This router replaces those direct queries with
 * service_role-backed, session-authenticated lookups.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { requireUser, authorizeWorkspaceAccess } from '../lib/workspaceAuth.js';

export const workspacesRouter = Router();

// ── GET /api/workspaces/:workspaceId/role — the caller's own role ────────
// Backs src/hooks/useWorkspaceRole.ts, which used to query
// workspace_members directly (RLS on auth.uid(), silently empty without a
// Supabase Auth session). A platform super admin (who bypasses membership
// entirely in authorizeWorkspaceAccess) has no workspace_members row, so
// role comes back null for them — same as a non-member — which is correct:
// this endpoint answers "what workspace_members.role does this caller
// have," not "can this caller act here."
workspacesRouter.get('/:workspaceId/role', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  return res.json({ role: auth.role });
});

// ── GET /api/workspaces/:workspaceId/primary-domain ───────────────────────
// Backs the sidebar's workspace-name subtitle. Narrow, read-only reuse of
// the "Members can view domains" read access (full domain CRUD is a
// separate, not-yet-migrated settings page — out of scope here).
workspacesRouter.get('/:workspaceId/primary-domain', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;

  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('workspace_domains')
    .select('domain, is_primary')
    .eq('workspace_id', req.params.workspaceId)
    .order('is_primary', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ domain: data?.domain ?? null });
});

// ── GET /api/workspaces — every workspace the caller is a member of ──────
workspacesRouter.get('/', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const userId = await requireUser(req, res);
  if (!userId) return;

  const sb = getServiceClient(config);
  const { data: memberships, error: memberErr } = await sb
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', userId);
  if (memberErr) return res.status(500).json({ error: memberErr.message });

  const workspaceIds = (memberships || []).map((m: any) => m.workspace_id);
  if (workspaceIds.length === 0) return res.json({ workspaces: [] });

  const { data: workspaces, error: wsErr } = await sb
    .from('workspaces')
    .select('*')
    .in('id', workspaceIds);
  if (wsErr) return res.status(500).json({ error: wsErr.message });

  return res.json({ workspaces: workspaces || [] });
});

// ── GET /api/workspaces/account — the caller's account ───────────────────
// Named distinctly from the (unrelated) `accounts` business entity vs.
// `profiles`/user identity — see database/README.md's account/workspace
// hierarchy. Kept under this router rather than accountRouter (account.ts)
// because accountRouter's `/me` already means "the user's own profile",
// a different concept from the account/workspace business entity here.
workspacesRouter.get('/account', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const userId = await requireUser(req, res);
  if (!userId) return;

  const sb = getServiceClient(config);
  const { data: membership, error: memberErr } = await sb
    .from('account_members')
    .select('account_id')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle();
  if (memberErr) return res.status(500).json({ error: memberErr.message });
  if (!membership?.account_id) return res.status(404).json({ error: 'No account found' });

  const { data: account, error: accErr } = await sb
    .from('accounts')
    .select('*')
    .eq('id', membership.account_id)
    .maybeSingle();
  if (accErr) return res.status(500).json({ error: accErr.message });
  if (!account) return res.status(404).json({ error: 'No account found' });

  return res.json({ account });
});

// ── POST /api/workspaces/provision-account — first-run account+workspace ─
// Backs WorkspaceRedirect.tsx's auto-provision path, which used to call
// supabase.rpc('provision_account_on_signup', { _user_id: user.id })
// directly from the browser. That RPC is SECURITY DEFINER but — unlike
// create_workspace_atomic — takes _user_id with NO internal check that it
// matches the caller: any authenticated caller could provision a phantom
// account/workspace attributed to an ARBITRARY other user's profile id
// (their own access is unaffected, but it pollutes the target user's data
// and is unbounded resource-exhaustion griefing). Routing it through the
// session-derived userId here closes that off — the RPC is now only ever
// invoked with the caller's own id, mirroring how /api/workspaces (POST,
// above/below) already calls create_workspace_atomic.
workspacesRouter.post('/provision-account', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const userId = await requireUser(req, res);
  if (!userId) return;

  const sb = getServiceClient(config);
  const { error } = await sb.rpc('provision_account_on_signup', { _user_id: userId });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
});

// ── POST /api/workspaces — create a workspace within the caller's account ─
const createWorkspaceSchema = z.object({
  accountId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
});

workspacesRouter.post('/', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const userId = await requireUser(req, res);
  if (!userId) return;

  const parsed = createWorkspaceSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten().fieldErrors });
  }

  const sb = getServiceClient(config);
  // `create_workspace_atomic` is SECURITY DEFINER but takes `_user_id`
  // explicitly rather than reading auth.uid() — it does its own
  // is_account_member(_account_id, _user_id) check internally, so a caller
  // who isn't a member of accountId is rejected by the function itself,
  // not by anything client-supplied here.
  const { data, error } = await sb.rpc('create_workspace_atomic', {
    _account_id: parsed.data.accountId,
    _name: parsed.data.name,
    _slug: '',
    _user_id: userId,
  });
  if (error) return res.status(400).json({ error: error.message });

  return res.json({ workspaceId: data as string });
});
