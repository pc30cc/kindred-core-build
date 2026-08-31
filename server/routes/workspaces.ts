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
 *
 * ROUTE ORDERING: every STATIC path (`/`, `/account`, `/provision-account`)
 * is registered before any `/:workspaceId`-shaped route. Express matches
 * routes in registration order, so a dynamic param registered first would
 * "shadow" a static route with the same segment count — `GET /account`
 * would never be reached, captured instead by `GET /:workspaceId` with
 * workspaceId="account" (this happened; see the fix commit). The
 * workspaceId param itself is ALSO constrained to a UUID shape via an
 * inline path-to-regexp pattern (not just checked inside the handler via
 * authorizeWorkspaceAccess's own UUID_RE, which still runs too, as
 * defense-in-depth) — this is what makes the ordering fix structural
 * rather than incidental: even a future static route added in the wrong
 * position could not be captured by `:workspaceId`, because a non-UUID
 * segment can never match that param pattern in the first place.
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { requireUser, authorizeWorkspaceAccess } from '../lib/workspaceAuth.js';
import { assertPhoneVerificationSatisfied } from '../services/phoneVerification/index.js';
import { PhoneVerificationError } from '../services/phoneVerification/types.js';
import { isEmailVerified } from '../services/auth/identity.js';
import { checkEntitlementFromDB } from '../middleware/featureGating.js';
import { getCapability } from '../services/billing/capabilityRegistry.js';

export const workspacesRouter = Router();

// Matches server/lib/workspaceAuth.ts's own UUID_RE shape (case-insensitive
// by allowing both cases directly in the character class, since Express's
// route regex matching does not honor a separate `i` flag here).
// Explicitly widened to `string` (not a preserved literal type) — Express's
// route-param type inference otherwise tries to parse a param NAME out of
// this literal at the type level and chokes on the parenthesized regex,
// inferring a bogus property like `workspaceId([0`. Widening makes every
// route below fall back to the generic (index-signature) params type,
// where `req.params.workspaceId: string` is valid and correct.
const WORKSPACE_ID_PARAM: string = ':workspaceId([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})';

// Because the param pattern above is a computed (non-literal-preserving)
// string, Express's type-level route-param parser can't infer `req.params`
// from the path text the way it does for a plain `:workspaceId` literal —
// these two request types spell it out explicitly for the handlers below.
type WorkspaceIdRequest = Request<{ workspaceId: string }>;
type WorkspaceDomainRequest = Request<{ workspaceId: string; domainId: string }>;

// ═══════════════════ STATIC ROUTES (no :workspaceId) ═══════════════════

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

  // Same NEW-signup policy as POST / above: provisioning the first-run
  // account/workspace makes this user its owner, so it must not be
  // reachable as a verification bypass for that same policy.
  if (!(await isEmailVerified(config, userId))) {
    return res.status(403).json({ error: 'email_verification_required' });
  }

  const sb = getServiceClient(config);
  const { error } = await sb.rpc('provision_account_on_signup', { _user_id: userId });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
});

// ── Workspace capacity (max_workspaces) ──────────────────────────────────
// `max_workspaces` is an ACCOUNT-level cap (see usageResolvers.ts's
// KNOWN_UNSUPPORTED note): it is enforced at workspace creation, not as a
// per-workspace usage counter. The effective cap for an account is the
// most generous cap among its workspaces' plans, so a single upgraded
// workspace lifts the account.
interface WorkspaceCapacity {
  used: number;
  limit: number | null; // null = unlimited
  canCreate: boolean;
  plan: string | null;
}

async function resolveWorkspaceCapacity(
  config: ServerConfig,
  accountId: string,
): Promise<WorkspaceCapacity> {
  const sb = getServiceClient(config);
  const { data: rows } = await sb
    .from('workspaces')
    .select('id')
    .eq('account_id', accountId);
  const ids = (rows || []).map((r: any) => r.id as string);
  const used = ids.length;

  const registryDefault = getCapability('max_workspaces')?.defaultValue;
  let limit: number | null = typeof registryDefault === 'number' ? registryDefault : 1;
  let plan: string | null = null;
  let unlimited = false;

  for (const id of ids) {
    const ent = await checkEntitlementFromDB(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      id,
      'max_workspaces',
      { numeric: true, selfHostBillingUnlimited: (config as any).selfHostBillingUnlimited },
    );
    if (ent.plan && !plan) plan = ent.plan;
    if (!ent.limitValid || typeof ent.limit !== 'number') continue;
    if (ent.limit < 0) { unlimited = true; break; }
    if (limit !== null && ent.limit > limit) limit = ent.limit;
  }

  if (unlimited) return { used, limit: null, canCreate: true, plan };
  return { used, limit, canCreate: limit === null || used < limit, plan };
}

// ── GET /api/workspaces/capacity — can the caller create another one? ────
workspacesRouter.get('/capacity', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const userId = await requireUser(req, res);
  if (!userId) return;

  const sb = getServiceClient(config);
  const { data: membership } = await sb
    .from('account_members')
    .select('account_id')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle();
  if (!membership?.account_id) return res.status(404).json({ error: 'No account found' });

  const capacity = await resolveWorkspaceCapacity(config, membership.account_id);
  return res.json(capacity);
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

  // NEW-signup policy: an unverified account cannot become a workspace
  // owner. See identity.ts's isEmailVerified for why this is enforced here
  // rather than at login — legacy/migrated users are unaffected once
  // 029_backfill_legacy_email_verification.sql has run.
  if (!(await isEmailVerified(config, userId))) {
    return res.status(403).json({ error: 'email_verification_required' });
  }

  // Plan cap — enforced server-side so the UI gate can never be the only
  // thing standing between a client and an over-quota workspace.
  const capacity = await resolveWorkspaceCapacity(config, parsed.data.accountId);
  if (!capacity.canCreate) {
    return res.status(403).json({
      error: 'workspace_limit_reached',
      feature: 'max_workspaces',
      limit: capacity.limit,
      used: capacity.used,
      plan: capacity.plan,
      upgrade_required: true,
    });
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

// ═══════════════════ DYNAMIC ROUTES (/:workspaceId/...) ═══════════════════

// ── GET /api/workspaces/:workspaceId — minimal identity (id/slug/name) ───
// Backs CreateWorkspaceDialog.tsx's post-create redirect (previously a
// direct `supabase.from('workspaces').select('slug')` — same auth.uid()
// problem as everything else in this file).
workspacesRouter.get(`/${WORKSPACE_ID_PARAM}`, async (req: WorkspaceIdRequest, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('workspaces')
    .select('id, slug, name')
    .eq('id', req.params.workspaceId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Workspace not found' });
  return res.json(data);
});

const updateWorkspaceSchema = z.object({ name: z.string().trim().min(1).max(120) });

// ── PATCH /api/workspaces/:workspaceId — rename (settings/GeneralPage.tsx) ─
workspacesRouter.patch(`/${WORKSPACE_ID_PARAM}`, async (req: WorkspaceIdRequest, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const parsed = updateWorkspaceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const sb = getServiceClient(config);
  const { error } = await sb
    .from('workspaces')
    .update({ name: parsed.data.name, updated_at: new Date().toISOString() })
    .eq('id', req.params.workspaceId);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true });
});

// ── GET /api/workspaces/:workspaceId/role — the caller's own role ────────
// Backs src/hooks/useWorkspaceRole.ts, which used to query
// workspace_members directly (RLS on auth.uid(), silently empty without a
// Supabase Auth session). A platform super admin (who bypasses membership
// entirely in authorizeWorkspaceAccess) has no workspace_members row, so
// role comes back null for them — same as a non-member — which is correct:
// this endpoint answers "what workspace_members.role does this caller
// have," not "can this caller act here."
workspacesRouter.get(`/${WORKSPACE_ID_PARAM}/role`, async (req: WorkspaceIdRequest, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  return res.json({ role: auth.role });
});

// ── GET /api/workspaces/:workspaceId/primary-domain ───────────────────────
// Backs the sidebar's workspace-name subtitle. Narrow, read-only reuse of
// the "Members can view domains" read access (full domain CRUD is a
// separate, not-yet-migrated settings page — out of scope here).
workspacesRouter.get(`/${WORKSPACE_ID_PARAM}/primary-domain`, async (req: WorkspaceIdRequest, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;

  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('workspace_domains')
    .select('domain, is_primary, verified')
    .eq('workspace_id', req.params.workspaceId)
    .order('is_primary', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({
    domain: data?.domain ?? null,
    is_primary: data?.is_primary ?? null,
    verified: data?.verified ?? null,
  });
});

// ── Workspace branding (settings/GeneralPage.tsx, useBranding.ts) ─────────
workspacesRouter.get(`/${WORKSPACE_ID_PARAM}/branding`, async (req: WorkspaceIdRequest, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('workspace_branding')
    .select('*')
    .eq('workspace_id', req.params.workspaceId)
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ branding: data });
});

const brandingUpdateSchema = z.object({}).passthrough();

/**
 * Platform-owned branding columns. Workspace owners/admins must never be able
 * to write these — the widget "powered by" credit and platform identity are
 * configured exclusively by the platform admin (widget_platform_settings /
 * platform_branding). Silently stripped so older clients keep working.
 */
const PLATFORM_OWNED_BRANDING_FIELDS = ['platform_name'] as const;

workspacesRouter.patch(`/${WORKSPACE_ID_PARAM}/branding`, async (req: WorkspaceIdRequest, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const parsed = brandingUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const updates = { ...(parsed.data as Record<string, unknown>) };
  for (const field of PLATFORM_OWNED_BRANDING_FIELDS) delete updates[field];
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('workspace_branding')
    .update({ ...updates, updated_at: new Date().toISOString() })

    .eq('workspace_id', req.params.workspaceId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ branding: data });
});

// ── Domain management (settings/DomainsPage.tsx) ──────────────────────────
// Replaces direct browser supabase.from('workspace_domains') CRUD. Writes
// mirror the RLS policy being replaced exactly: workspace owner/admin AND
// `workspace_owner_phone_verified` (supabase/migrations/20260801223349_...sql,
// "Admins+ manage ws domains (phone gated)"). Reads stay member-level, same
// as the pre-existing "Authenticated users can view domains" read policy
// (scoped to this workspace here, since the old policy was USING (true)
// cross-tenant — a laxness we don't need to reproduce).

async function requireDomainManage(req: any, res: any, workspaceId: string): Promise<{ userId: string } | null> {
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return null;
  try {
    await assertPhoneVerificationSatisfied((req as any).serverConfig, {
      actorUserId: auth.userId,
      purpose: 'widget_access',
      workspaceId,
    });
  } catch (err) {
    if (err instanceof PhoneVerificationError) {
      res.status(err.status).json({ error: err.code });
      return null;
    }
    throw err;
  }
  return { userId: auth.userId };
}

workspacesRouter.get(`/${WORKSPACE_ID_PARAM}/domains`, async (req: WorkspaceIdRequest, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('workspace_domains')
    .select('*')
    .eq('workspace_id', req.params.workspaceId)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ domains: data });
});

const addDomainSchema = z.object({ domain: z.string().trim().min(1).max(255) });

workspacesRouter.post(`/${WORKSPACE_ID_PARAM}/domains`, async (req: WorkspaceIdRequest, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const workspaceId = req.params.workspaceId;
  const parsed = addDomainSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  if (!(await requireDomainManage(req, res, workspaceId))) return;
  const sb = getServiceClient(config);
  const { error } = await sb.from('workspace_domains').insert({
    workspace_id: workspaceId,
    domain: parsed.data.domain,
  });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true });
});

async function loadDomainForWorkspace(sb: ReturnType<typeof getServiceClient>, workspaceId: string, domainId: string) {
  const { data } = await sb
    .from('workspace_domains')
    .select('id')
    .eq('id', domainId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  return data;
}

workspacesRouter.delete(`/${WORKSPACE_ID_PARAM}/domains/:domainId`, async (req: WorkspaceDomainRequest, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const { workspaceId, domainId } = req.params;
  if (!(await requireDomainManage(req, res, workspaceId))) return;
  const sb = getServiceClient(config);
  const existing = await loadDomainForWorkspace(sb, workspaceId, domainId);
  if (!existing) return res.status(404).json({ error: 'Domain not found' });
  const { error } = await sb.from('workspace_domains').delete().eq('id', domainId);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true });
});

workspacesRouter.patch(`/${WORKSPACE_ID_PARAM}/domains/:domainId/primary`, async (req: WorkspaceDomainRequest, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const { workspaceId, domainId } = req.params;
  if (!(await requireDomainManage(req, res, workspaceId))) return;
  const sb = getServiceClient(config);
  const existing = await loadDomainForWorkspace(sb, workspaceId, domainId);
  if (!existing) return res.status(404).json({ error: 'Domain not found' });
  await sb.from('workspace_domains').update({ is_primary: false }).eq('workspace_id', workspaceId);
  const { error } = await sb.from('workspace_domains').update({ is_primary: true }).eq('id', domainId);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true });
});

// ── Provider usage logs (workspace-scoped) ───────────────────────────────
// Replaces browser-direct reads of `ai_usage_logs`/`storage_usage_logs`
// (src/hooks/useProviderUsage.ts), which relied on `authenticated` RLS.
// Workspace isolation is enforced server-side: the caller can only read the
// workspace in the path, and only after authorizeWorkspaceAccess passes.
const usageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  since: z.string().datetime().optional(),
});

workspacesRouter.get(`/${WORKSPACE_ID_PARAM}/usage/ai`, async (req: WorkspaceIdRequest, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  const parsed = usageQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const sb = getServiceClient(config);
  let q = sb
    .from('ai_usage_logs')
    .select('*')
    .eq('workspace_id', req.params.workspaceId)
    .order('created_at', { ascending: false })
    .limit(parsed.data.limit);
  if (parsed.data.since) q = q.gte('created_at', parsed.data.since);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ logs: data ?? [] });
});

workspacesRouter.get(`/${WORKSPACE_ID_PARAM}/usage/storage`, async (req: WorkspaceIdRequest, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  const parsed = usageQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });
  const sb = getServiceClient(config);
  let q = sb
    .from('storage_usage_logs')
    .select('*')
    .eq('workspace_id', req.params.workspaceId)
    .order('created_at', { ascending: false })
    .limit(parsed.data.limit);
  if (parsed.data.since) q = q.gte('created_at', parsed.data.since);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ logs: data ?? [] });
});

// ── Non-secret provider selection metadata (workspace-scoped) ────────────
// Replaces browser-direct `provider_configs` SELECTs (src/providers/sync.ts,
// src/realtime/resolveClientRealtimeProvider.ts). Only the vendor selection
// fields are returned — the `config` column (credentials/secrets) never
// leaves the backend.
workspacesRouter.get(`/${WORKSPACE_ID_PARAM}/provider-selection`, async (req: WorkspaceIdRequest, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('provider_configs')
    .select('provider_type, provider_name, is_active')
    .eq('workspace_id', req.params.workspaceId)
    .eq('is_active', true);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ overrides: data ?? [] });
});
