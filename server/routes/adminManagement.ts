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
import { publishCacheInvalidation } from '../lib/cacheBus.js';
import { requirePlatformAdmin } from '../lib/workspaceAuth.js';
import { invalidateGlobalAdminCache } from '../lib/globalAdminCache.js';
import { parseWorkspaceDomainInput, type DomainInputResult } from '../utils/workspaceDomainInput.js';
import { invalidateOriginHostCache, invalidateWorkspaceOriginCache } from '../services/widget/public.js';
import { invalidatePlatformHosts, isPlatformHost, isPlatformWorkspace } from '../services/platformHosts.js';
import { fixedDomainIds, isWebsiteRegistered, type DomainRowKey } from '../services/ownerWebsite.js';
import { invalidateSignupPolicyCache } from '../services/auth/signupPolicy.js';
import { invalidateSignupPlanCache } from '../services/billing/signupPlan.js';
import { isParseableDate } from '../lib/dateInput.js';
import { reviveFailedWorkspaceDeletion } from '../services/workspaceDeletion/revive.js';
import { invalidatePlatformPublicConfig } from '../services/platformPublicConfig.js';
import { getPlatformEdition, invalidatePlatformRegionCache } from '../services/platformRegion.js';
import { respondEditionUnavailable } from '../services/editionSettings.js';
import type { Edition } from '../../shared/edition.js';
import { PANEL_THEME_IDS, isValidPanelThemeOptions, resolvePanelThemeOptions } from '../../shared/panelThemes.js';
import {
  isEmailProviderKey,
  readEmailProviderForAdmin,
  writeEmailProviderConfig,
  type EmailProviderKey,
} from '../services/email/providerConfigStore.js';


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
  // `website_fixed`: the website is registered (services/ownerWebsite.ts),
  // so the profile edit offers no control to change it.
  const detail = data as { profile?: { website_domain?: string | null } | null } | null;
  if (!detail) return res.json(data);
  const website = detail.profile?.website_domain;
  const fixed = !!website?.trim() && (await isWebsiteRegistered(config, req.params.userId, website));
  return res.json({ ...detail, website_fixed: fixed });
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
  invalidateGlobalAdminCache(req.params.userId);
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
  const [{ data: job, error }, { data: profile, error: profileError }] = await Promise.all([
    sb
      .from('user_deletion_jobs')
      .select('*')
      .eq('user_id', req.params.userId)
      .order('requested_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    sb.from('profiles').select('id').eq('id', req.params.userId).maybeSingle(),
  ]);
  if (error) return res.status(500).json({ error: error.message });
  if (profileError) return res.status(500).json({ error: profileError.message });
  // The final purge sweeps every user_id-keyed table, the job row included,
  // so "no job and no profile" is what a finished deletion looks like.
  return res.json({ job, user_exists: !!profile });
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

  // The account job usually failed BECAUSE an owned workspace's deletion
  // failed; retrying only the parent would fail it again on the next tick.
  const { data: owned, error: ownedError } = await sb.from('workspaces').select('id').eq('owner_id', req.params.userId);
  if (ownedError) return res.status(500).json({ error: ownedError.message });
  for (const w of owned ?? []) {
    const { data: latest, error: latestError } = await sb
      .from('workspace_deletion_jobs')
      .select('status')
      .eq('workspace_id', w.id)
      .order('requested_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestError) return res.status(500).json({ error: latestError.message });
    if (latest?.status !== 'failed') continue;
    const revived = await reviveFailedWorkspaceDeletion(config, w.id as string, actorId);
    if (!revived.ok) return res.status(409).json({ error: `workspace ${w.id}: ${revived.error}` });
  }

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
  // Must be parseable (or empty = no bound): the handler calls
  // new Date(x).toISOString(), which throws a RangeError on garbage input.
  from: z.string().refine((v) => v === '' || isParseableDate(v)).optional(),
  to: z.string().refine((v) => v === '' || isParseableDate(v)).optional(),
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
// Every row comes back without its credentials (see redactRuntimeConfigValue
// below): the System page shows what is set, never a password or a key.
adminManagementRouter.get('/runtime-config', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  const { data, error } = await sb.from('app_runtime_config').select('*').order('key');
  if (error) return res.status(500).json({ error: error.message });
  try {
    const rows = await Promise.all(((data ?? []) as Array<{ key: string; value: unknown }>).map(async (row) => {
      const view = isEmailProviderKey(row.key)
        ? await emailProviderView(config, row.key)
        : redactRuntimeConfigValue(row.value);
      return { ...row, value: view.value, secretKeysSet: view.secretKeysSet };
    }));
    return res.json({ config: rows });
  } catch {
    return res.status(500).json({ error: 'runtime_config_unavailable' });
  }
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
  // Only the running edition's templates (migration 260): the Iranian and
  // the International edition each keep and edit their own.
  let edition: Edition;
  try {
    edition = await getPlatformEdition(config);
  } catch (e) {
    if (!respondEditionUnavailable(res, e)) res.status(500).json({ error: 'EDITION_READ_FAILED' });
    return;
  }
  const { data, error } = await sb
    .from('email_templates')
    .select('*')
    .is('workspace_id', null)
    .eq('edition', edition)
    .order('slug');
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ templates: data, edition });
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
  let edition: Edition;
  try {
    edition = await getPlatformEdition(config);
  } catch (e) {
    if (!respondEditionUnavailable(res, e)) res.status(500).json({ error: 'EDITION_READ_FAILED' });
    return;
  }
  // One platform row per (edition, slug, locale): a second save of the same
  // template updates it instead of adding a twin.
  const { data: existing } = await sb
    .from('email_templates')
    .select('id')
    .is('workspace_id', null)
    .eq('edition', edition)
    .eq('slug', parsed.data.slug)
    .eq('locale', parsed.data.locale)
    .maybeSingle();
  const { data, error } = existing
    ? await sb
        .from('email_templates')
        .update({ subject: parsed.data.subject, html_body: parsed.data.html_body, text_body: parsed.data.text_body ?? null, is_active: parsed.data.is_active })
        .eq('id', (existing as { id: string }).id)
        .select('*')
        .single()
    : await sb
        .from('email_templates')
        .insert({ ...parsed.data, workspace_id: null, edition })
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
  let edition: Edition;
  try {
    edition = await getPlatformEdition(config);
  } catch (e) {
    if (!respondEditionUnavailable(res, e)) res.status(500).json({ error: 'EDITION_READ_FAILED' });
    return;
  }
  const { data, error } = await sb
    .from('email_templates')
    .update(parsed.data)
    .eq('id', req.params.id)
    .is('workspace_id', null)
    .eq('edition', edition)
    .select('*')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ template: data });
});

adminManagementRouter.delete('/email-templates/:id', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  let edition: Edition;
  try {
    edition = await getPlatformEdition(config);
  } catch (e) {
    if (!respondEditionUnavailable(res, e)) res.status(500).json({ error: 'EDITION_READ_FAILED' });
    return;
  }
  const { error } = await sb
    .from('email_templates')
    .delete()
    .eq('id', req.params.id)
    .is('workspace_id', null)
    .eq('edition', edition);
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
  // Public self-signup on/off — see server/services/auth/signupPolicy.ts.
  signup_enabled: z.boolean().optional(),
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
  // region_mode / active_locales / default_locale feed the public config.
  invalidatePlatformPublicConfig();
  // region_mode decides the allowed locales and the edition (Iran vs
  // International: currency, gateways) — the next money request must see it.
  invalidatePlatformRegionCache();
  publishCacheInvalidation(['platform']);
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

// Reads of the three rows the Branding page edits. They used to be read
// browser-direct from Supabase with the anon key, which only worked against
// hosted Supabase (the self-host chain grants anon nothing on two of them) and
// tied the dashboard to a Supabase URL. Same gate as the writes below.
adminManagementRouter.get('/platform-domains', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const sb = getServiceClient(serverConfigOf(req));
  const { data, error } = await sb.from('platform_domains').select('*').limit(1).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ domains: data });
});

adminManagementRouter.get('/platform-branding', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const sb = getServiceClient(serverConfigOf(req));
  const { data, error } = await sb.from('platform_branding').select('*').limit(1).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ branding: data });
});

adminManagementRouter.get('/platform-branding-localized', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const sb = getServiceClient(serverConfigOf(req));
  const { data, error } = await sb.from('platform_branding_localized').select('*').order('locale');
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ branding: data ?? [] });
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
  invalidatePlatformHosts();
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
  invalidatePlatformPublicConfig();
  publishCacheInvalidation(['platform']);
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
    legal_company_display_name: z.string().max(255).nullable().optional(),
    footer_company_text: z.string().max(1000).nullable().optional(),
    // widget_display_name, knowledge_base_title and support_label are left
    // out (stripped from a save): nothing ever drew them, so the Branding
    // page no longer offers them. Their columns stay.
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
  // platform_name is the widget's powered-by brand and platform_display_name.
  invalidatePlatformPublicConfig();
  publishCacheInvalidation(['platform']);
  return res.json({ branding: data });
});

// ── Workspace panel theme ("قالب") ─────────────────────────────────────
// Which theme every workspace panel wears, platform-wide, and that theme's
// options (Art: its layout and colour scheme), from shared/panelThemes.ts.
// Everyone reads both through the public config
// (platform_branding.workspace_panel_theme / workspace_panel_theme_options);
// only this route writes them.
//
// `options` is optional and partial: the values given are merged into the
// stored entry of `theme`, and every other theme's entry is kept, so saving
// Art's colour scheme never forgets its layout or another theme's choices.
// Without options the options column is left alone (and need not exist yet:
// a database from before migration 254 can still switch themes).
const PANEL_THEME_OPTIONS_COLUMN = 'workspace_panel_theme_options';
const panelThemeSchema = z.object({ theme: z.enum(PANEL_THEME_IDS), options: z.unknown().optional() });

type PanelThemeRow = { id: string; workspace_panel_theme?: string; workspace_panel_theme_options?: unknown };

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const PANEL_THEME_MIGRATION_REQUIRED = {
  error: 'Saving theme options needs database migration 254 (platform_branding.workspace_panel_theme_options).',
  code: 'migration_required',
} as const;

/** The write named the options column and the table has none (before 254). */
function isMissingOptionsColumn(error: { code?: string; message?: string }): boolean {
  return (
    (error.code === 'PGRST204' || error.code === '42703') &&
    String(error.message ?? '').includes(PANEL_THEME_OPTIONS_COLUMN)
  );
}

adminManagementRouter.put('/panel-theme', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  const parsed = panelThemeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const { theme } = parsed.data;
  const options = parsed.data.options;
  if (options !== undefined && !isValidPanelThemeOptions(theme, options)) {
    return res.status(400).json({ error: 'Invalid theme options' });
  }
  const setsOptions = options !== undefined && Object.keys(options).length > 0;
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  const { data: existing, error: lookupError } = await sb.from('platform_branding').select('*').limit(1).maybeSingle();
  if (lookupError) return res.status(500).json({ error: lookupError.message });
  const row = existing as PanelThemeRow | null;
  // `select('*')` returns every column the table has: no options column
  // means migration 254 is not applied yet, so options cannot be kept.
  // (Without a row there is nothing to look at: the insert below tells.)
  if (setsOptions && row && !(PANEL_THEME_OPTIONS_COLUMN in row)) {
    return res.status(409).json(PANEL_THEME_MIGRATION_REQUIRED);
  }

  const storedOptions = asObject(row?.workspace_panel_theme_options);
  const previousEntry = asObject(storedOptions[theme]);
  const nextEntry = setsOptions ? { ...previousEntry, ...(options as Record<string, string>) } : previousEntry;
  const nextOptions = { ...storedOptions, [theme]: nextEntry };
  const payload: Record<string, unknown> = { workspace_panel_theme: theme, updated_at: new Date().toISOString() };
  if (setsOptions) payload[PANEL_THEME_OPTIONS_COLUMN] = nextOptions;
  const { error } = row
    ? await sb.from('platform_branding').update(payload).eq('id', row.id).select().maybeSingle()
    : await sb.from('platform_branding').insert(payload).select().maybeSingle();
  if (error) {
    if (setsOptions && isMissingOptionsColumn(error)) return res.status(409).json(PANEL_THEME_MIGRATION_REQUIRED);
    return res.status(500).json({ error: error.message });
  }
  invalidatePlatformPublicConfig();
  publishCacheInvalidation(['platform']);
  await insertAuditLogRows(config, sb, {
    workspace_id: null,
    user_id: actorId,
    action: 'admin.panel_theme.changed',
    entity_type: 'platform_branding',
    entity_id: row?.id ?? null,
    old_value: setsOptions
      ? { theme: row?.workspace_panel_theme ?? null, options: storedOptions[theme] ?? null }
      : { theme: row?.workspace_panel_theme ?? null },
    new_value: setsOptions ? { theme, options: nextEntry } : { theme },
  });
  return res.json({ theme, options: resolvePanelThemeOptions(theme, setsOptions ? nextOptions : storedOptions) });
});


// ── Global email settings: gone ────────────────────────────────────────
//
// `email_settings` (workspace_id IS NULL) held one field the Super Admin
// could still set, `reply_to_email`, under Branding → Email settings. It was
// read by nothing: the offline-message fallback in server/routes/widget.ts
// reads the WORKSPACE's row, never this one, and no message ever carried it
// as a Reply-To. Reply-To is transport identity, like From, so it belongs to
// the email provider and nowhere else: it is the provider's `reply_to`
// (Super Admin → Providers → Email), which every message carries when set.
// A second place for it would be the same mistake as the old sender_email
// was, so the routes went with the field. The page offers a value stored
// here while the provider has none (server/routes/adminEmailProviders.ts),
// and the columns stay for rollback.


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
  // `fixed`: a workspace's registered website (services/ownerWebsite.ts).
  const rows = (data ?? []) as Array<DomainRowKey & Record<string, unknown>>;
  const fixed = await fixedDomainIds(serverConfigOf(req), rows);
  return res.json({ domains: rows.map((d) => ({ ...d, fixed: fixed.has(d.id) })) });
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
    .select('id, domain, workspace_id, is_primary, verified, normalized_domain')
    .eq('id', req.params.id)
    .maybeSingle();
  if (!existing) return res.status(404).json({ error: 'Domain not found' });
  const existingDomain = existing as DomainRowKey & { domain: string; is_primary: boolean | null };

  // The registered website (the row holding the account owner's website,
  // verified) is fixed for good (owner, 2026-10-28; services/ownerWebsite.ts),
  // for Super Admin too: it keeps its value and its flag, and while it is
  // the primary no other row takes the flag. Other rows edit as before.
  const fixed = { error: 'The primary domain cannot be changed.', code: 'PRIMARY_DOMAIN_FIXED' };
  const isFixed = (await fixedDomainIds(serverConfigOf(req), [existingDomain])).size > 0;
  if (isFixed && existingDomain.is_primary && parsed.data.is_primary === false) return res.status(403).json(fixed);
  if (!existingDomain.is_primary && parsed.data.is_primary === true) {
    const { data: primary, error: primaryError } = await sb
      .from('workspace_domains')
      .select('id, workspace_id, verified, normalized_domain')
      .eq('workspace_id', existingDomain.workspace_id)
      .eq('is_primary', true);
    if (primaryError) return res.status(500).json({ error: primaryError.message });
    if ((await fixedDomainIds(serverConfigOf(req), (primary ?? []) as DomainRowKey[])).size) return res.status(403).json(fixed);
  }

  const update: Record<string, unknown> = {};
  let nextDomain: string | null = null;
  if (parsed.data.domain !== undefined) {
    const input = parseWorkspaceDomainInput(parsed.data.domain);
    if (!input.ok) {
      const failure = input as Extract<DomainInputResult, { ok: false }>;
      return res.status(400).json({ error: failure.message, code: failure.code });
    }
    if (isFixed && input.domain !== existingDomain.domain) return res.status(403).json(fixed);
    // The row keeps its `verified` flag, so a platform host
    // (services/platformHosts.ts) would become a verified claim on it: only
    // the platform's own workspace may hold one.
    if ((await isPlatformHost(serverConfigOf(req), input.domain))
      && !(await isPlatformWorkspace(serverConfigOf(req), existingDomain.workspace_id))) {
      return res.status(409).json({ error: 'This domain belongs to the platform.', code: 'PLATFORM_DOMAIN' });
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
  publishCacheInvalidation([
    `widget:${existingDomain.workspace_id}`,
    `origin:${existingDomain.workspace_id}`,
    ...(existingDomain.domain ? [`host:${existingDomain.domain}`] : []),
    ...(nextDomain ? [`host:${nextDomain}`] : []),
  ]);
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
/**
 * Keys the cached widget config is derived from (storage URLs, the AI
 * provider check, the legacy pre-chat policy, call channels): a write
 * flushes every cache on every node.
 */
const WIDGET_INPUT_RUNTIME_KEYS = new Set([
  'default_storage_provider',
  'default_ai_provider',
  'widget_prechat_fields',
  'call_control_plane',
]);

/**
 * A field whose value is a credential. Broad on purpose, as in the storage
 * pool's route: one field too many costs the Super Admin a blank input, one
 * too few a leaked password. A bare `key` (a pre-chat field's own key) is
 * not one; `api_key` and `access_key_id` are, and so are the connection
 * strings that carry a password (`database_url`, `connection_string`) and
 * Telegram's `api_hash`.
 */
const SECRET_FIELD = /pass(word|wd)?|secret|token|credential|private|merchant|service_account|apikey|api_hash|database_url|connection_string|.+_key(_|$)/i;

/**
 * Names the pattern above catches that are not credentials, in the provider
 * forms (src/features/providers/schemas.ts) as ordinary inputs: a number of
 * tokens or seconds, and the keys a vendor makes public by design (a
 * publishable or anon key, a captcha site key, a search-only key, a webhook's
 * public key), which sit in the page or the browser bundle anyway. Hidden,
 * they showed as saved with an empty input that could never be cleared.
 */
const NOT_SECRET_FIELD = /^(max_tokens|token_ttl_seconds|site_key|search_key|supabase_anon_key|anon_key)$|(^|_)public(_|$)|publishable/i;

/**
 * A URL with a password in it (`redis://user:pass@host`), whatever the field
 * is called: the Redis and Dragonfly forms take their password that way.
 */
const URL_WITH_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^/?#\s@:]*:[^/?#\s@]+@/i;

function isSecretField(field: string, value: unknown): boolean {
  if (typeof value === 'string' && URL_WITH_PASSWORD.test(value.trim())) return true;
  return SECRET_FIELD.test(field) && !NOT_SECRET_FIELD.test(field);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** A value worth hiding: text, a number, or a filled object (an encrypted envelope, a key file). */
function holdsValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== '';
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return false;
}

/**
 * A runtime-config value as the browser may see it: every credential-looking
 * field at any depth left out, and its path (`config.api_key`) listed in
 * `secretKeysSet` so a form can show it as saved. These rows used to come
 * back whole, the relay's password and the old Resend key included.
 */
export function redactRuntimeConfigValue(value: unknown): { value: unknown; secretKeysSet: string[] } {
  const secretKeysSet: string[] = [];
  const walk = (node: unknown, path: string[]): unknown => {
    if (Array.isArray(node)) return node.map((item, i) => walk(item, [...path, String(i)]));
    if (!isPlainObject(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [field, child] of Object.entries(node)) {
      if (isSecretField(field, child) && holdsValue(child)) {
        secretKeysSet.push([...path, field].join('.'));
        continue;
      }
      out[field] = walk(child, [...path, field]);
    }
    return out;
  };
  return { value: walk(value, []), secretKeysSet };
}

function providerIdentity(value: Record<string, unknown>): string {
  return String(value.provider_name ?? value.provider ?? '').trim().toLowerCase();
}

/**
 * The value to store for a save from a form that never received the
 * credentials: a credential the save leaves blank or out keeps the stored
 * one, at any depth of nested objects, but only while the provider is the
 * same (two vendors may both call theirs `api_key`, and one's key must never
 * be sent to the other). Arrays are taken as sent. Everything else is the
 * save's own.
 */
export function keepStoredRuntimeSecrets(stored: unknown, incoming: unknown): unknown {
  if (!isPlainObject(stored) || !isPlainObject(incoming)) return incoming;
  if (providerIdentity(stored) !== providerIdentity(incoming)) return incoming;
  const out: Record<string, unknown> = { ...incoming };
  for (const [field, kept] of Object.entries(stored)) {
    if (isSecretField(field, kept)) {
      if (holdsValue(kept) && !holdsValue(incoming[field])) out[field] = kept;
    } else if (isPlainObject(kept) && isPlainObject(incoming[field])) {
      out[field] = keepStoredRuntimeSecrets(kept, incoming[field]);
    }
  }
  return out;
}

/**
 * The email provider rows go through their own store (server/services/
 * email/providerConfigStore.ts), here as on Super Admin → Providers → Email:
 * the read never carries a secret, encrypted or not, and a write is
 * validated against the provider registry, keeps a blank secret, encrypts
 * and is audited. This generic route used to read and write them raw.
 */
async function emailProviderView(config: ServerConfig, key: EmailProviderKey): Promise<{ value: unknown; secretKeysSet: string[] }> {
  const view = await readEmailProviderForAdmin(config, key);
  return {
    value: view.provider_name ? { provider_name: view.provider_name, config: view.config } : null,
    secretKeysSet: view.secretKeysSet.map((field) => `config.${field}`),
  };
}

adminManagementRouter.get('/runtime-config/:key', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  if (!RUNTIME_CONFIG_KEY_RE.test(req.params.key)) return res.status(400).json({ error: 'Invalid key' });
  const config = serverConfigOf(req);
  if (isEmailProviderKey(req.params.key)) {
    try {
      return res.json(await emailProviderView(config, req.params.key));
    } catch {
      return res.status(500).json({ error: 'email_provider_unavailable' });
    }
  }
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('app_runtime_config')
    .select('key, value')
    .eq('key', req.params.key)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  return res.json(redactRuntimeConfigValue((data as { value?: unknown } | null)?.value ?? null));
});

adminManagementRouter.put('/runtime-config/:key', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
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
  const config = serverConfigOf(req);
  if (isEmailProviderKey(req.params.key)) {
    const value = body.value as { provider_name?: unknown; config?: unknown };
    try {
      const result = await writeEmailProviderConfig(config, req.params.key, {
        provider_name: String(value.provider_name ?? ''),
        config: isPlainObject(value.config) ? value.config : {},
      }, { userId: actorId });
      if ('error' in result) {
        return res.status(result.error === 'storage_error' ? 500 : 400)
          .json({ error: result.error, ...(result.field ? { field: result.field } : {}) });
      }
      return res.json({ success: true });
    } catch {
      return res.status(500).json({ error: 'storage_error' });
    }
  }
  const sb = getServiceClient(config);
  const { data: stored, error: readError } = await sb
    .from('app_runtime_config')
    .select('value')
    .eq('key', req.params.key)
    .maybeSingle();
  if (readError) return res.status(500).json({ error: readError.message });
  const value = keepStoredRuntimeSecrets((stored as { value?: unknown } | null)?.value ?? null, body.value);
  const { error } = await sb
    .from('app_runtime_config')
    .upsert(
      { key: req.params.key, value, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    );
  if (error) return res.status(500).json({ error: error.message });
  if (WIDGET_INPUT_RUNTIME_KEYS.has(req.params.key)) publishCacheInvalidation(['all']);
  return res.json({ success: true });
});

adminManagementRouter.delete('/runtime-config/:key', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  if (!RUNTIME_CONFIG_KEY_RE.test(req.params.key)) return res.status(400).json({ error: 'Invalid key' });
  const config = serverConfigOf(req);
  if (isEmailProviderKey(req.params.key)) {
    // Through the store, so removing the platform's mail transport is
    // audited like every other change to it.
    try {
      const result = await writeEmailProviderConfig(config, req.params.key, { provider_name: 'disabled', config: {} }, { userId: actorId });
      if ('error' in result) return res.status(500).json({ error: result.error });
      return res.json({ success: true });
    } catch {
      return res.status(500).json({ error: 'storage_error' });
    }
  }
  const sb = getServiceClient(config);
  const { error } = await sb.from('app_runtime_config').delete().eq('key', req.params.key);
  if (error) return res.status(500).json({ error: error.message });
  if (WIDGET_INPUT_RUNTIME_KEYS.has(req.params.key)) publishCacheInvalidation(['all']);
  return res.json({ success: true });
});
