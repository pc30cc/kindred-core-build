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
import type { Request } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { insertAuditLogRows } from '../services/auditLog.js';
import { getServiceClient } from '../supabase.js';
import { requirePlatformAdmin } from '../lib/workspaceAuth.js';
import { parseWorkspaceDomainInput, type DomainInputResult } from '../utils/workspaceDomainInput.js';
import { invalidateOriginHostCache, invalidateWorkspaceOriginCache } from '../services/widget/public.js';
import { invalidateSignupPolicyCache } from '../services/auth/signupPolicy.js';
import { invalidateSignupPlanCache } from '../services/billing/signupPlan.js';


export const adminManagementRouter = Router();

type ReqWithConfig = Request & { serverConfig: ServerConfig };

function serverConfigOf(req: Request): ServerConfig {
  return (req as unknown as ReqWithConfig).serverConfig;
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
 * Deletion is asynchronous and storage-aware (docs/STORAGE_ARCHITECTURE_AUDIT.md,
 * database/migrations/183_user_deletion_lifecycle.sql): this route only
 * atomically enqueues a user_deletion_jobs row (enqueue_user_deletion RPC —
 * idempotent, one active job per user via a partial unique index).
 * server/services/userDeletion/worker.ts does the actual work: enqueues a
 * workspace_deletion_jobs row for every workspace the user owns (reusing
 * the full multi-provider storage-aware machinery workspace deletion
 * already has — no separate, narrower storage sweep), waits for all of
 * them to fully complete (storage AND DB), cleans up the user's own
 * global users/<id>/ storage (e.g. the account avatar), and only then
 * calls admin_delete_user for the final DB purge. DB ownership rows are
 * never purged before storage cleanup completes.
 *
 * Returns 202 with the job id rather than a synchronous result — the
 * caller polls GET .../deletion-status, exactly like workspace deletion.
 */
adminManagementRouter.delete('/users/:userId', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  const userId = req.params.userId;
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);

  const { data, error } = await sb.rpc('enqueue_user_deletion', {
    _user_id: userId,
    _actor_user_id: actorId,
  });
  if (error) return res.status(500).json({ error: error.message });

  if (!data?.ok) {
    if (data?.error === 'user_not_found') return res.status(404).json({ error: 'User not found' });
    if (data?.error === 'cannot_delete_self') return res.status(400).json({ error: 'Cannot delete your own account' });
    return res.status(409).json({ error: data?.error ?? 'enqueue_failed' });
  }

  if (data.started) {
    await insertAuditLogRows(config, sb, {
      workspace_id: null,
      user_id: actorId,
      action: 'admin.user.deletion_requested',
      entity_type: 'user',
      entity_id: userId,
      new_value: { job_id: data.job?.id },
    });
  }

  return res.status(202).json({ started: data.started, job: data.job });
});

adminManagementRouter.get('/users/:userId/deletion-status', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  const { data: job, error } = await sb
    .from('user_deletion_jobs')
    .select('*')
    .eq('user_id', req.params.userId)
    .order('requested_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ job });
});

/**
 * Manual retry for a terminally-failed account deletion job (automatic
 * retries with backoff are exhausted). Resumes from wherever it left off —
 * never re-enqueues a workspace deletion job already completed, never
 * re-runs avatar cleanup once avatar_cleanup_done is true.
 */
adminManagementRouter.post('/users/:userId/deletion-retry', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);

  const { data: job, error: jobLookupError } = await sb
    .from('user_deletion_jobs')
    .select('id')
    .eq('user_id', req.params.userId)
    .eq('status', 'failed')
    .order('requested_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (jobLookupError) return res.status(500).json({ error: jobLookupError.message });
  if (!job) return res.status(404).json({ error: 'No failed deletion job found for this user' });

  const { data, error } = await sb.rpc('retry_user_deletion_job', {
    _job_id: job.id,
    _actor_user_id: actorId,
  });
  if (error) return res.status(500).json({ error: error.message });
  if (!data?.ok) return res.status(409).json({ error: data?.error ?? 'retry_failed' });

  return res.json({ retried: true, job_id: job.id });
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

/**
 * Deletion is asynchronous and storage-aware (docs/STORAGE_ARCHITECTURE_AUDIT.md):
 * this route only atomically flips the workspace to 'deleting' and
 * enqueues a workspace_deletion_jobs row (via the enqueue_workspace_deletion
 * RPC — one transaction, so a job-creation failure can never leave the
 * workspace stuck 'deleting' with no job, and a DB-level partial unique
 * index guarantees at most one active job per workspace even under
 * concurrent requests); server/services/workspaceDeletion/worker.ts does
 * the actual work (walk + delete every physical storage scope that can
 * hold workspace/<id>/ objects, then run the existing admin_delete_workspace
 * DB purge). Returns 202 with the job id rather than 200 with a
 * synchronous result — the caller polls GET .../deletion-status.
 *
 * Never returns 202 with job: null — a workspace stuck 'deleting' with no
 * active job (every prior attempt exhausted its automatic retries) is a
 * distinct 409, pointing at POST .../deletion-retry.
 */
adminManagementRouter.delete('/workspaces/:workspaceId', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  const workspaceId = req.params.workspaceId;

  const { data, error } = await sb.rpc('enqueue_workspace_deletion', {
    _workspace_id: workspaceId,
    _actor_user_id: actorId,
  });
  if (error) return res.status(500).json({ error: error.message });

  if (!data?.ok) {
    if (data?.error === 'workspace_not_found') return res.status(404).json({ error: 'Workspace not found' });
    if (data?.error === 'workspace_stuck_no_active_job') {
      return res.status(409).json({
        error: 'Workspace is in a deleting state with no active job — every previous attempt exhausted its retries',
        retry_endpoint: `/api/admin/management/workspaces/${workspaceId}/deletion-retry`,
      });
    }
    return res.status(409).json({ error: data?.error ?? 'enqueue_failed', status: data?.status });
  }

  return res.status(202).json({ started: data.started, job: data.job });
});

adminManagementRouter.get('/workspaces/:workspaceId/deletion-status', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  const { data: job, error } = await sb
    .from('workspace_deletion_jobs')
    .select('*')
    .eq('workspace_id', req.params.workspaceId)
    .order('requested_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ job });
});

/**
 * Manual retry for a terminally-failed deletion job (automatic retries
 * with backoff are exhausted — server/services/workspaceDeletion/worker.ts's
 * MAX_JOB_ATTEMPTS). Resumes from wherever storage_scopes progress left
 * off; never restarts a scope already marked done.
 */
adminManagementRouter.post('/workspaces/:workspaceId/deletion-retry', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);

  const { data: job, error: jobLookupError } = await sb
    .from('workspace_deletion_jobs')
    .select('id')
    .eq('workspace_id', req.params.workspaceId)
    .eq('status', 'failed')
    .order('requested_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (jobLookupError) return res.status(500).json({ error: jobLookupError.message });
  if (!job) return res.status(404).json({ error: 'No failed deletion job found for this workspace' });

  const { data, error } = await sb.rpc('retry_workspace_deletion_job', {
    _job_id: job.id,
    _actor_user_id: actorId,
  });
  if (error) return res.status(500).json({ error: error.message });
  if (!data?.ok) return res.status(409).json({ error: data?.error ?? 'retry_failed' });

  return res.json({ retried: true, job_id: job.id });
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
// Filterable, paginated, and enriched with the actor's identity and the
// workspace name so the operator never has to read raw UUIDs.
const auditLogsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  search: z.string().trim().max(200).optional().default(''),
  action: z.string().trim().max(120).optional().default(''),
  entityType: z.string().trim().max(120).optional().default(''),
  userId: z.string().uuid().optional(),
  workspaceId: z.string().uuid().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

adminManagementRouter.get('/audit-logs', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const parsed = auditLogsQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const q = parsed.data;
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);

  let query = sb.from('audit_logs').select('*', { count: 'exact' });
  if (q.action) query = query.eq('action', q.action);
  if (q.entityType) query = query.eq('entity_type', q.entityType);
  if (q.userId) query = query.eq('user_id', q.userId);
  if (q.workspaceId) query = query.eq('workspace_id', q.workspaceId);
  if (q.from) query = query.gte('created_at', new Date(q.from).toISOString());
  if (q.to) query = query.lte('created_at', new Date(q.to).toISOString());
  if (q.search) {
    const s = q.search.replace(/[%,]/g, ' ');
    query = query.or(`action.ilike.%${s}%,entity_type.ilike.%${s}%,ip_address.ilike.%${s}%`);
  }

  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(q.offset, q.offset + q.limit - 1);
  if (error) return res.status(500).json({ error: error.message });

  const logs = data || [];
  const userIds = [...new Set(logs.map((l) => l.user_id).filter(Boolean))];
  const workspaceIds = [...new Set(logs.map((l) => l.workspace_id).filter(Boolean))];

  const [profiles, workspaces, facets] = await Promise.all([
    userIds.length
      ? sb.from('profiles').select('id, email, full_name').in('id', userIds)
      : Promise.resolve({ data: [] as { id: string; email: string; full_name: string }[] }),
    workspaceIds.length
      ? sb.from('workspaces').select('id, name, slug').in('id', workspaceIds)
      : Promise.resolve({ data: [] as { id: string; name: string; slug: string }[] }),
    sb.from('audit_logs').select('action, entity_type').order('created_at', { ascending: false }).limit(1000),
  ]);

  const profileById = new Map((profiles.data || []).map((p) => [p.id, p]));
  const workspaceById = new Map((workspaces.data || []).map((w) => [w.id, w]));

  const enriched = logs.map((l) => ({
    ...l,
    actor_email: profileById.get(l.user_id)?.email ?? null,
    actor_name: profileById.get(l.user_id)?.full_name ?? null,
    workspace_name: workspaceById.get(l.workspace_id)?.name ?? null,
  }));

  return res.json({
    logs: enriched,
    total: count ?? enriched.length,
    facets: {
      actions: [...new Set((facets.data || []).map((r) => r.action).filter(Boolean))].sort(),
      entityTypes: [...new Set((facets.data || []).map((r) => r.entity_type).filter(Boolean))].sort(),
    },
  });
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

// ═══════════════════════════════════════════════════════════════════════
// GOTRUE CUTOVER: dashboard operations that previously ran browser-direct
// against Supabase and depended on `authenticated`/auth.uid() RLS. They
// now run here behind requirePlatformAdmin + service_role.
// ═══════════════════════════════════════════════════════════════════════

// ── Platform settings (single row) ─────────────────────────────────────
adminManagementRouter.get('/platform-settings', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const sb = getServiceClient(serverConfigOf(req));
  const { data, error } = await sb
    .from('platform_settings')
    .select('*')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ settings: data });
});

const platformSettingsSchema = z.object({
  default_locale: z.string().min(2).max(10).optional(),
  active_locales: z.array(z.string().min(2).max(10)).min(1).optional(),
  timezone: z.string().min(1).max(100).optional(),
  site_mode: z.string().min(1).max(50).optional(),
  region_mode: z.string().min(1).max(50).optional(),
  region_currency: z.string().max(20).nullable().optional(),
  maintenance_mode: z.boolean().optional(),
  maintenance_message: z.string().max(2000).nullable().optional(),
  locale_billing_providers: z.record(z.string()).optional(),
  // Signup verification policy — see server/services/auth/signupPolicy.ts.
  signup_verification_method: z.enum(['link', 'otp']).optional(),
  signup_verification_gate: z.enum(['before', 'after']).optional(),
  // Default plan for NEW signups — see server/services/billing/signupPlan.ts.
  signup_default_plan_mode: z.enum(['free', 'trial']).optional(),
});


adminManagementRouter.put('/platform-settings', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const parsed = platformSettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const sb = getServiceClient(serverConfigOf(req));
  const payload = { ...parsed.data, updated_at: new Date().toISOString() };
  const { data: existing, error: lookupError } = await sb
    .from('platform_settings')
    .select('id')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (lookupError) return res.status(500).json({ error: lookupError.message });
  const q = existing
    ? sb.from('platform_settings').update(payload).eq('id', (existing as { id: string }).id).select('*').single()
    : sb.from('platform_settings').insert(payload).select('*').single();
  const { data: savedSettings, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  // The signup policy is memoised for 30s in the auth path — drop it now so
  // an operator's change takes effect on the very next signup.
  invalidateSignupPolicyCache();
  invalidateSignupPlanCache();
  return res.json({ success: true, settings: savedSettings });
});


// ── Platform domains / branding ────────────────────────────────────────
// RLS on these tables requires a Supabase-auth admin JWT (auth.uid()), which
// this first-party-session app never has in the browser — writes silently
// matched zero rows there. Writes must go through this admin-gated route.
const platformDomainsSchema = z.object({
  primary_domain: z.string().max(255).nullable().optional(),
  canonical_base_url: z.string().max(2000).nullable().optional(),
  app_base_url: z.string().max(2000).nullable().optional(),
  api_base_url: z.string().max(2000).nullable().optional(),
  // `widget_base_url` and `asset_base_url` are NOT here, and their absence is
  // the point. Widget deployment URLs live in `widget_platform_settings`
  // (Super Admin → Widget → Deployment URLs) and nothing reads these two —
  // migration 20260419082857 moved them and marked the columns DEPRECATED,
  // kept only so a rollback has somewhere to land. A zod object strips keys it
  // does not declare, so a client that still sends them is simply ignored
  // rather than writing a second, competing answer for the same URL.
  public_base_url: z.string().max(2000).nullable().optional(),
  help_center_base_url: z.string().max(2000).nullable().optional(),
  email_base_url: z.string().max(2000).nullable().optional(),
});

adminManagementRouter.put('/platform-domains', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const parsed = platformDomainsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const sb = getServiceClient(serverConfigOf(req));
  const payload = { ...parsed.data, updated_at: new Date().toISOString() };
  const { data: existing } = await sb.from('platform_domains').select('id').limit(1).maybeSingle();
  const { data, error } = existing
    ? await sb
        .from('platform_domains')
        .update(payload)
        .eq('id', (existing as { id: string }).id)
        .select()
        .maybeSingle()
    : await sb.from('platform_domains').insert(payload).select().maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ domains: data });
});

const platformBrandingSchema = z.object({
  logo_url: z.string().max(2000).nullable().optional(),
  favicon_url: z.string().max(2000).nullable().optional(),
  primary_color: z.string().max(50).nullable().optional(),
  secondary_color: z.string().max(50).nullable().optional(),
  pwa_icon_url: z.string().max(2000).nullable().optional(),
  pwa_enabled: z.boolean().optional(),
  pwa_short_name: z.string().max(30).nullable().optional(),
  pwa_background_color: z.string().max(50).nullable().optional(),
});

adminManagementRouter.put('/platform-branding', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const parsed = platformBrandingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const sb = getServiceClient(serverConfigOf(req));
  const payload = { ...parsed.data, updated_at: new Date().toISOString() };
  const { data: existing } = await sb.from('platform_branding').select('id').limit(1).maybeSingle();
  const { data, error } = existing
    ? await sb
        .from('platform_branding')
        .update(payload)
        .eq('id', (existing as { id: string }).id)
        .select()
        .maybeSingle()
    : await sb.from('platform_branding').insert(payload).select().maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ branding: data });
});

const platformBrandingLocalizedSchema = z
  .object({
    locale: z.string().min(2).max(10),
    platform_name: z.string().max(255).optional(),
    meta_title: z.string().max(500).nullable().optional(),
    meta_description: z.string().max(2000).nullable().optional(),
    social_share_title: z.string().max(500).nullable().optional(),
    social_share_description: z.string().max(2000).nullable().optional(),
    browser_title_format: z.string().max(255).nullable().optional(),
    public_site_title: z.string().max(255).nullable().optional(),
    widget_display_name: z.string().max(255).nullable().optional(),
    knowledge_base_title: z.string().max(255).nullable().optional(),
    legal_company_display_name: z.string().max(255).nullable().optional(),
    footer_company_text: z.string().max(1000).nullable().optional(),
    support_label: z.string().max(255).nullable().optional(),
  })
  .strip();

adminManagementRouter.put('/platform-branding-localized', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const parsed = platformBrandingLocalizedSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const sb = getServiceClient(serverConfigOf(req));
  const payload = { ...parsed.data, updated_at: new Date().toISOString() };
  const { data: existing } = await sb
    .from('platform_branding_localized')
    .select('id')
    .eq('locale', parsed.data.locale)
    .maybeSingle();
  const { data, error } = existing
    ? await sb
        .from('platform_branding_localized')
        .update(payload)
        .eq('id', (existing as { id: string }).id)
        .select()
        .maybeSingle()
    : await sb.from('platform_branding_localized').insert(payload).select().maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ branding: data });
});


// ── Global email settings (workspace_id IS NULL) ───────────────────────
adminManagementRouter.get('/email-settings', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const sb = getServiceClient(serverConfigOf(req));
  const { data, error } = await sb.from('email_settings').select('*').is('workspace_id', null).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ settings: data });
});

/**
 * Platform email settings — ONE field.
 *
 * `reply_to_email` is the only thing here the runtime reads:
 * server/routes/widget.ts uses it as the recipient for an offline visitor
 * message when no operator has an address.
 *
 * Everything else that used to live on this route is gone, because nothing
 * ever read any of it:
 *
 *   sender_email  — a second place to answer "who is this mail from". The
 *     From header is built entirely from the platform email provider's
 *     `from_email` / `from_name` (Super Admin → Providers → Email); see
 *     `resolveFromAddress` in server/services/email/index.ts.
 *   email_logo_url, email_footer_text — email branding no template can
 *     express: of the 84 stored templates not one references a logo or footer
 *     placeholder and not one contains an <img> tag. `{brand}` is the only
 *     branding hook and it resolves from platform_branding_localized.
 *
 * The whole `/email-settings-localized` pair went with them. That table has no
 * runtime consumer at all — its three columns (sender_name, footer_text,
 * support_contact_label) were read by nothing — so the routes were a way to
 * write a row nobody would ever look at.
 *
 * A zod object strips undeclared keys, so an older client still posting
 * `sender_email` is ignored rather than rejected. The COLUMNS stay: dropping
 * them is a separate decision with rollback consequences, and leaving them is
 * harmless once nothing writes them.
 */
const emailSettingsSchema = z.object({
  reply_to_email: z.string().max(255).default(''),
});

adminManagementRouter.put('/email-settings', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const parsed = emailSettingsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const sb = getServiceClient(serverConfigOf(req));
  const { data: existing } = await sb.from('email_settings').select('id').is('workspace_id', null).maybeSingle();
  const { error } = existing
    ? await sb
        .from('email_settings')
        .update({ ...parsed.data, updated_at: new Date().toISOString() })
        .eq('id', (existing as { id: string }).id)
    : await sb.from('email_settings').insert({ ...parsed.data, workspace_id: null });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true });
});


const featureFlagUpdateSchema = z.object({ enabled: z.boolean() });

adminManagementRouter.patch('/feature-flags/:id', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const parsed = featureFlagUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const sb = getServiceClient(serverConfigOf(req));
  const { data, error } = await sb
    .from('feature_flags')
    .update({ enabled: parsed.data.enabled })
    .eq('id', req.params.id)
    .is('workspace_id', null)
    .select('*')
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Flag not found' });
  return res.json({ flag: data });
});

// ── All workspace domains (platform-wide directory) ────────────────────
adminManagementRouter.get('/domains', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const sb = getServiceClient(serverConfigOf(req));
  const { data, error } = await sb
    .from('workspace_domains')
    .select('*, workspaces(name)')
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ domains: data ?? [] });
});

// ── Edit a workspace's own domain (platform admin override) ────────────
// The workspace owner manages these in Settings → Domains. A platform admin
// may correct/replace the value or move the "primary" flag without being a
// member of that workspace. Same canonical-input contract as the workspace
// route, and the same origin cache invalidation so the change is live at once.
const adminDomainPatchSchema = z.object({
  domain: z.string().min(1).max(300).optional(),
  is_primary: z.boolean().optional(),
});

adminManagementRouter.patch('/domains/:id', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const parsed = adminDomainPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  if (parsed.data.domain === undefined && parsed.data.is_primary === undefined) {
    return res.status(400).json({ error: 'Nothing to update' });
  }

  const sb = getServiceClient(serverConfigOf(req));
  const { data: existing } = await sb
    .from('workspace_domains')
    .select('id, domain, workspace_id')
    .eq('id', req.params.id)
    .maybeSingle();
  if (!existing) return res.status(404).json({ error: 'Domain not found' });
  const existingDomain = existing as { id: string; domain: string; workspace_id: string };

  const update: Record<string, unknown> = {};
  let nextDomain: string | null = null;
  if (parsed.data.domain !== undefined) {
    const input = parseWorkspaceDomainInput(parsed.data.domain);
    if (!input.ok) {
      const failure = input as Extract<DomainInputResult, { ok: false }>;
      return res.status(400).json({ error: failure.message, code: failure.code });
    }
    nextDomain = input.domain;
    update.domain = input.domain;
  }
  if (parsed.data.is_primary !== undefined) update.is_primary = parsed.data.is_primary;

  if (parsed.data.is_primary === true) {
    await sb
      .from('workspace_domains')
      .update({ is_primary: false })
      .eq('workspace_id', existingDomain.workspace_id);
  }

  const { data, error } = await sb
    .from('workspace_domains')
    .update(update)
    .eq('id', req.params.id)
    .select('*, workspaces(name)')
    .maybeSingle();
  if (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'This domain is already registered.', code: 'DOMAIN_TAKEN' });
    }
    return res.status(500).json({ error: error.message });
  }

  invalidateWorkspaceOriginCache(existingDomain.workspace_id);
  if (existingDomain.domain) invalidateOriginHostCache(existingDomain.domain);
  if (nextDomain) invalidateOriginHostCache(nextDomain);
  return res.json({ domain: data });
});


// ── Login attempts for an email (security forensics) ───────────────────
const loginAttemptsSchema = z.object({
  email: z.string().min(3).max(320),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

adminManagementRouter.get('/login-attempts', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const parsed = loginAttemptsSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const sb = getServiceClient(serverConfigOf(req));
  const { data, error } = await sb
    .from('login_attempts')
    .select('*')
    .ilike('email', parsed.data.email)
    .order('created_at', { ascending: false })
    .limit(parsed.data.limit);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ attempts: data ?? [] });
});

// ── Runtime config writes (admin-only keys) ────────────────────────────
const RUNTIME_CONFIG_KEY_RE = /^[a-z0-9_]{3,80}$/;

adminManagementRouter.get('/runtime-config/:key', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  if (!RUNTIME_CONFIG_KEY_RE.test(req.params.key)) return res.status(400).json({ error: 'Invalid key' });
  const sb = getServiceClient(serverConfigOf(req));
  const { data, error } = await sb
    .from('app_runtime_config')
    .select('key, value')
    .eq('key', req.params.key)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ value: (data as { value?: unknown } | null)?.value ?? null });
});

adminManagementRouter.put('/runtime-config/:key', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  if (!RUNTIME_CONFIG_KEY_RE.test(req.params.key)) return res.status(400).json({ error: 'Invalid key' });
  const body = req.body as { value?: unknown };
  if (body?.value === undefined || body.value === null || typeof body.value !== 'object') {
    return res.status(400).json({ error: 'Invalid input' });
  }
  // The auth provider is never DB-switchable — first-party gs_session auth
  // is the sole identity system (see src/providers/sync.ts).
  if (req.params.key === 'default_auth_provider') {
    return res.status(400).json({ error: 'The auth provider cannot be changed at runtime.' });
  }
  const sb = getServiceClient(serverConfigOf(req));
  const { error } = await sb
    .from('app_runtime_config')
    .upsert(
      { key: req.params.key, value: body.value, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    );
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true });
});

adminManagementRouter.delete('/runtime-config/:key', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  if (!RUNTIME_CONFIG_KEY_RE.test(req.params.key)) return res.status(400).json({ error: 'Invalid key' });
  const sb = getServiceClient(serverConfigOf(req));
  const { error } = await sb.from('app_runtime_config').delete().eq('key', req.params.key);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true });
});
