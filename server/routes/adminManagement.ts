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
import { deleteFile } from '../services/storage/index.js';

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

/**
 * Hard-delete a user: every workspace they own (with all its data), every
 * row across the schema that points at them, their stored files, and the
 * profile itself. Storage objects are removed first (best-effort) because
 * the DB purge destroys the rows that carry the object keys.
 */
adminManagementRouter.delete('/users/:userId', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  const userId = req.params.userId;
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);

  if (userId === actorId) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }

  // 1. Collect storage objects belonging to the user's owned workspaces.
  const storageFailures: string[] = [];
  try {
    const { data: owned } = await sb.from('workspaces').select('id').eq('owner_id', userId);
    const workspaceIds = (owned ?? []).map((w: any) => w.id as string);
    if (workspaceIds.length > 0) {
      const keyed: Array<{ workspaceId: string; key: string }> = [];
      const collect = async (table: string, column: string) => {
        const { data } = await sb.from(table).select(`workspace_id, ${column}`).in('workspace_id', workspaceIds).limit(5000);
        for (const row of (data ?? []) as any[]) {
          const key = row?.[column];
          if (typeof key === 'string' && key) keyed.push({ workspaceId: row.workspace_id, key });
        }
      };
      await collect('conversation_attachments', 'storage_path');
      await collect('call_recordings', 'storage_path');
      await collect('privacy_jobs', 'artifact_storage_key');

      for (const item of keyed) {
        try {
          const result = await deleteFile(config, item.workspaceId, item.key);
          if (!result.success) storageFailures.push(item.key);
        } catch {
          storageFailures.push(item.key);
        }
      }
    }
  } catch (err: any) {
    console.error('[admin] storage purge failed for user', userId, err?.message);
  }

  // 2. Purge the database.
  const { data, error } = await sb.rpc('admin_delete_user', {
    _actor_user_id: actorId,
    _user_id: userId,
  });
  if (error) return res.status(400).json({ error: error.message });

  await sb.from('audit_logs').insert({
    workspace_id: null,
    user_id: actorId,
    action: 'admin.user.deleted',
    entity_type: 'user',
    entity_id: userId,
    new_value: { summary: data, storage_failures: storageFailures.length },
  } as any);

  return res.json({ success: true, summary: data, storageFailures: storageFailures.length });
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

// ── Global default email templates (platform-wide, workspace_id IS NULL).
// These are the platform's default transactional emails, not any single
// workspace's overrides — RLS never covered this case (get_workspace_role
// on a NULL workspace_id doesn't resolve to owner/admin for anyone), so
// this was effectively unreachable/unsafe pre-migration. Gated the same
// as every other route here: requirePlatformAdmin only. ─────────────────
adminManagementRouter.get('/email-templates', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('email_templates')
    .select('*')
    .is('workspace_id', null)
    .order('slug');
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ templates: data });
});

const emailTemplateSchema = z.object({
  slug: z.string().min(1).max(100),
  locale: z.string().min(1).max(10),
  subject: z.string().min(1),
  html_body: z.string().min(1),
  text_body: z.string().nullable().optional(),
  is_active: z.boolean().default(true),
});

adminManagementRouter.post('/email-templates', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const parsed = emailTemplateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('email_templates')
    .insert({ ...parsed.data, workspace_id: null })
    .select('*')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ template: data });
});

const emailTemplateUpdateSchema = z.object({
  subject: z.string().min(1),
  html_body: z.string().min(1),
  text_body: z.string().nullable().optional(),
  is_active: z.boolean(),
});

adminManagementRouter.put('/email-templates/:id', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const parsed = emailTemplateUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('email_templates')
    .update(parsed.data)
    .eq('id', req.params.id)
    .is('workspace_id', null)
    .select('*')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ template: data });
});

adminManagementRouter.delete('/email-templates/:id', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  const { error } = await sb
    .from('email_templates')
    .delete()
    .eq('id', req.params.id)
    .is('workspace_id', null);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true });
});
