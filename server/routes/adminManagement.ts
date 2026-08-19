/**
 * Platform-admin user/workspace/role/feature-flag/audit-log/runtime-config
 * management. Mounted under adminRouter (server/routes/admin.ts), which
 * already gates every route here behind `requirePlatformAdmin`.
 *
 * Replaces useAdmin.ts's direct `supabase.rpc('admin_*')`/`supabase.from(...)`
 * calls. The admin_* RPCs this file calls had an internal
 * `has_role(auth.uid(), 'admin')` check that silently fails under
 * service_role (auth.uid() is NULL there) — 20260819170000_admin_rpcs_
 * actor_param.sql swapped that for an explicit `_actor_user_id` parameter,
 * the same pattern already used by create_workspace_atomic. This route
 * passes the Express-verified admin's own userId as that parameter — the
 * RPC's internal check is real defense-in-depth, not a rubber stamp.
 *
 * bootstrap_admin is intentionally NOT behind requirePlatformAdmin (see
 * the dedicated route below) — its own internal guard (auto-assign admin
 * only when zero admins exist platform-wide) is the correct trust model
 * for a first-run bootstrap, and requiring an existing admin to call it
 * would make it uncallable by definition.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { requirePlatformAdmin } from '../lib/workspaceAuth.js';

export const adminManagementRouter = Router();

function serverConfigOf(req: any): ServerConfig {
  return req.serverConfig as ServerConfig;
}

// NOTE: "am I a platform admin" and "bootstrap the first admin" are NOT
// routes on this router — this whole router is mounted under adminRouter
// (server/routes/admin.ts), whose `adminRouter.use(requireAdmin)` gates
// the entire /api/admin/* prefix. A route that must be reachable by a
// non-admin (to learn "you're not one") or by the very first user on a
// fresh install (before any admin exists to pass that gate) cannot live
// here — see server/routes/adminBootstrap.ts, mounted separately and
// ungated in server/index.ts.

// ── Users ───────────────────────────────────────────────────────────────
const listProfilesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  search: z.string().max(200).default(''),
  sort: z.enum(['newest', 'oldest', 'name_asc']).default('newest'),
  phoneStatus: z.enum(['all', 'verified', 'unverified', 'no_phone']).default('all'),
});

adminManagementRouter.get('/users', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  const parsed = listProfilesQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('admin_list_profiles', {
    _actor_user_id: actorId,
    _limit: parsed.data.limit,
    _offset: parsed.data.offset,
    _search: parsed.data.search,
    _sort: parsed.data.sort,
    _phone_status: parsed.data.phoneStatus,
  });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ profiles: data ?? [] });
});

adminManagementRouter.get('/users/count', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  const search = typeof req.query.search === 'string' ? req.query.search : '';
  const phoneStatus = typeof req.query.phoneStatus === 'string' ? req.query.phoneStatus : 'all';
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('admin_count_profiles', {
    _actor_user_id: actorId,
    _search: search,
    _phone_status: phoneStatus,
  });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ count: data as number });
});

adminManagementRouter.get('/users/:userId', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('admin_get_user_detail', {
    _actor_user_id: actorId,
    _user_id: req.params.userId,
  });
  if (error) return res.status(500).json({ error: error.message });
  return res.json(data);
});

adminManagementRouter.get('/users/:userId/roles', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  const { data, error } = await sb.from('user_roles').select('*').eq('user_id', req.params.userId);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ roles: data });
});

const roleSchema = z.object({ role: z.enum(['admin', 'moderator', 'user']) });

adminManagementRouter.post('/users/:userId/roles', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const parsed = roleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  const { error } = await sb
    .from('user_roles')
    .upsert({ user_id: req.params.userId, role: parsed.data.role }, { onConflict: 'user_id,role' });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true });
});

adminManagementRouter.delete('/users/:userId/roles/:role', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  const { error } = await sb
    .from('user_roles')
    .delete()
    .eq('user_id', req.params.userId)
    .eq('role', req.params.role);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true });
});

// ── Workspaces ──────────────────────────────────────────────────────────
const listWorkspacesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  search: z.string().max(200).default(''),
  sort: z.enum(['newest', 'oldest', 'name_asc']).default('newest'),
  phoneStatus: z.enum(['all', 'verified', 'unverified', 'no_phone']).default('all'),
});

adminManagementRouter.get('/workspaces', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  const parsed = listWorkspacesQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('admin_list_workspaces', {
    _actor_user_id: actorId,
    _limit: parsed.data.limit,
    _offset: parsed.data.offset,
    _search: parsed.data.search,
    _sort: parsed.data.sort,
    _phone_status: parsed.data.phoneStatus,
  });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ workspaces: data ?? [] });
});

adminManagementRouter.get('/workspaces/count', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  const search = typeof req.query.search === 'string' ? req.query.search : '';
  const phoneStatus = typeof req.query.phoneStatus === 'string' ? req.query.phoneStatus : 'all';
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('admin_count_workspaces', {
    _actor_user_id: actorId,
    _search: search,
    _phone_status: phoneStatus,
  });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ count: data as number });
});

adminManagementRouter.get('/workspaces/:workspaceId', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('admin_get_workspace_detail', {
    _actor_user_id: actorId,
    _workspace_id: req.params.workspaceId,
  });
  if (error) return res.status(500).json({ error: error.message });
  return res.json(data);
});

adminManagementRouter.delete('/workspaces/:workspaceId', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('admin_delete_workspace', {
    _actor_user_id: actorId,
    _workspace_id: req.params.workspaceId,
  });
  if (error) return res.status(400).json({ error: error.message });
  return res.json({ success: data as boolean });
});

// ── Feature flags (platform-wide, workspace_id IS NULL) ────────────────
adminManagementRouter.get('/feature-flags', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  const { data, error } = await sb.from('feature_flags').select('*').is('workspace_id', null).order('key');
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ flags: data });
});

// ── Audit logs (platform-wide, read-only) ───────────────────────────────
const auditLogsQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) });

adminManagementRouter.get('/audit-logs', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const parsed = auditLogsQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('audit_logs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(parsed.data.limit);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ logs: data });
});

// ── Provider configs (platform-wide, read-only from this surface — writes
// go through the existing dedicated provider-config routes) ────────────
adminManagementRouter.get('/provider-configs', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  const { data, error } = await sb.from('provider_configs').select('*').order('provider_type');
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ configs: data });
});

// ── Runtime config (platform-wide, read-only from this surface) ────────
adminManagementRouter.get('/runtime-config', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  const { data, error } = await sb.from('app_runtime_config').select('*').order('key');
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ config: data });
});
