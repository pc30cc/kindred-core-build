/**
 * AI Knowledge Base Builder routes.
 *
 * Self-host, no edge functions. All work runs in this Express server, with
 * the actual crawling/AI generation handled by a separate worker process
 * that polls ai_kb_jobs (see worker/intelligence/*).
 *
 * Product rules enforced here:
 *   1. Operators NEVER provide a free-form URL. Source domain is resolved
 *      server-side from workspace_domains (preferred) or profile.website_domain.
 *   2. Module gating: knowledge_base + ai_kb_builder must both be enabled.
 *   3. Plan snapshot (limits) is captured at job creation so the worker
 *      cannot exceed limits even if the plan changes mid-job.
 *   4. Generated articles are drafts only — accepting creates a draft KB
 *      article in the existing knowledge_base_articles table; publish
 *      flips its status to 'published'.
 */

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { requireLimit } from '../middleware/featureGating.js';
import { usageFnForLimit } from '../services/billing/usageResolvers.js';
import { isGlobalAdmin } from '../middleware/adminBypass.js';
import {
  checkAiKbAccess,
  readAiKbCapabilities,
  isAiKbPlanDenial,
  type AiKbAccessResult,
} from '../services/ai-kb/access.js';
import type { KnowledgeBasePermission } from '../services/knowledge-base/access.js';
import { resolveSourceDomainDetailed } from '../services/ai-kb/sourceDomain.js';
import { resolveAiKbLimitsDetailed, countJobsThisMonthDetailed } from '../services/ai-kb/limits.js';
import { readAiCreditStateDetailed, logAiKbUsage } from '../services/ai-kb/credits.js';
import { firstReadFailure } from '../services/ai-kb/readResult.js';
import { slugifyTitle, type PlanSnapshot } from '../services/ai-kb/types.js';
import { normalizeArticleHtml } from '../services/ai-kb/htmlNormalize.js';
import {
  AI_KB_JOB_COLUMNS,
  AI_KB_PAGE_COLUMNS,
  AI_KB_GENERATED_COLUMNS,
  AI_KB_GENERATED_INTERNAL_COLUMNS,
  AI_KB_EVENT_COLUMNS,
  toPublicAiKbJob,
  toPublicAiKbPage,
  toPublicAiKbGenerated,
  toPublicAiKbJobEvent,
  toPublicErrorCode,
  type AiKbJobRowLike,
  toPublicAiKbVisibility,
  type AiKbLinkedArticle,
} from '../services/ai-kb/dto.js';

export const aiKbRouter: Router = express.Router();

/**
 * Sanitized server-side logging. Internal error text never reaches the client:
 * routes respond with a stable code only (see docs/ENTITLEMENT_ARCHITECTURE.md).
 */
function logInternal(scope: string, error: unknown, context: Record<string, unknown> = {}): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ai-kb] ${scope}`, JSON.stringify({ ...context, message: message.slice(0, 300) }));
}

// ─── Auth helpers (operator JWT + workspace membership) ────────

export interface AiKbAuth { userId: string; isAdmin: boolean }

/** Authenticate only. Writes 401 and returns null when the JWT is invalid. */
async function authenticate(
  req: Request,
  res: Response,
  config: ServerConfig,
): Promise<AiKbAuth | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing authorization' });
    return null;
  }
  const token = authHeader.replace('Bearer ', '');
  const sb = getServiceClient(config);
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) {
    res.status(401).json({ error: 'Invalid token' });
    return null;
  }
  return { userId: user.id, isAdmin: await isGlobalAdmin(config, user.id) };
}

/**
 * Silent membership probe used by resource-scoped routes so an unauthorized
 * cross-workspace request cannot distinguish "not found" from "forbidden".
 */
async function isAuthorizedForWorkspace(
  config: ServerConfig,
  auth: AiKbAuth,
  workspaceId: string,
): Promise<boolean> {
  if (auth.isAdmin) return true;
  const { data, error } = await getServiceClient(config).rpc('is_workspace_member', {
    _workspace_id: workspaceId,
    _user_id: auth.userId,
  });
  return !error && data === true;
}

async function authorizeMember(
  req: Request,
  res: Response,
  config: ServerConfig,
  workspaceId: string,
): Promise<{ userId: string; isAdmin: boolean } | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing authorization' });
    return null;
  }
  const token = authHeader.replace('Bearer ', '');
  const sb = getServiceClient(config);
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) {
    res.status(401).json({ error: 'Invalid token' });
    return null;
  }
  const isAdmin = await isGlobalAdmin(config, user.id);
  if (!isAdmin) {
    const { data: isMember, error: memErr } = await sb.rpc('is_workspace_member', {
      _workspace_id: workspaceId,
      _user_id: user.id,
    });
    if (memErr) {
      res.status(500).json({ error: 'Membership check failed' });
      return null;
    }
    if (!isMember) {
      res.status(403).json({ error: 'Not a workspace member' });
      return null;
    }
  }
  return { userId: user.id, isAdmin };
}

/**
 * Full AI KB Builder gate: granular KB permission → knowledge_base module →
 * ai_assistant module → ai_kb_builder FEATURE → platform AI switch.
 *
 * Writes the canonical denial response and returns false when blocked, so no
 * provider call, job creation, KB write or credit deduction can follow.
 */
async function gateAiKb(
  res: Response,
  config: ServerConfig,
  workspaceId: string,
  auth: { userId: string; isAdmin: boolean },
  opts: { permissions?: KnowledgeBasePermission[]; route: string; customerFacing?: boolean },
): Promise<boolean> {
  const result: AiKbAccessResult = await checkAiKbAccess(config, workspaceId, {
    permissions: opts.permissions,
    isAdmin: auth.isAdmin,
    userId: auth.userId,
    route: opts.route,
    // Phase 6-S5-R4 — every /api/ai-kb route is a CUSTOMER-facing surface by
    // default, so the platform customer-visibility flag applies unless a route
    // explicitly opts out. Global admins are exempted inside the guard.
    customerFacing: opts.customerFacing ?? true,
  });
  if (result.ok) return true;
  const denial = result.denial!;
  res.status(denial.status).json(denial.body);
  return false;
}

// ──────────────────────────────────────────────────────────────
//  GET /api/ai-kb/source — resolved scan source
// ──────────────────────────────────────────────────────────────
aiKbRouter.get('/source', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = String(req.query.workspaceId || req.query.workspace_id || '');
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });

  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;

  const requestedDomainId = (req.query.domain_id as string) || undefined;

  // This is the designated upgrade-discovery surface: when the workspace is
  // not fully entitled it returns a REDACTED capability snapshot only — no
  // private source, credit or job data.
  // Phase 6-S5-R7.3 §1 — the snapshot must be computed with the SAME customer
  // context as the gate, or the UI would advertise a surface the platform has
  // hidden from customers.
  const capabilities = await readAiKbCapabilities(config, workspaceId, {
    customerFacing: !auth.isAdmin,
  });
  const entitled = await checkAiKbAccess(config, workspaceId, {
    isAdmin: auth.isAdmin,
    userId: auth.userId,
    route: 'GET /api/ai-kb/source',
    customerFacing: true,
  });
  if (!entitled.ok) {
    const denial = entitled.denial!;
    // R7.2 — the upgrade-discovery payload is only truthful when the denial is
    // AUTHORITATIVE. A 503 denial means the entitlement could not be read, and
    // rendering "upgrade required" for it would push the customer to pay for
    // something they may already own.
    if ((denial.status ?? 403) >= 500) {
      return res
        .status(denial.status)
        .json({ error: denial.body.error, retryable: true });
    }
    // Phase 6-S5-R7.3 §2 — only a PLAN denial is an upgrade path. A platform
    // kill switch, a hidden-from-customers switch or a per-workspace disable
    // cannot be resolved by buying a bigger plan, so those are returned as a
    // plain 403 with their own code and never as `upgrade_required`.
    if (!isAiKbPlanDenial(denial.body.error)) {
      return res.status(denial.status).json({
        ...denial.body,
        upgrade_required: false,
        modules: capabilities,
        is_global_admin: auth.isAdmin,
      });
    }
    return res.json({
      source: {
        domain: null, kind: null, workspace_domain_id: null,
        verified: false, is_primary: false, can_scan: false,
        reason_if_blocked: denial.body.error,
        available_domains: [],
      },
      plan: {
        slug: null,
        limits: { maxPages: 0, maxDepth: 0, jobsPerMonth: 0, maxArticles: 0, maxChars: 0, monthlyCredits: 0 },
        jobs_used_this_month: 0,
        can_start_job: false,
      },
      credits: { used: 0, limit: 0, remaining: 0, period: '' },
      modules: capabilities,
      upgrade_required: true,
      denial: denial.body,
      is_global_admin: auth.isAdmin,
    });
  }

  // Phase 6-S5-R7.3 §3 — every business-state read is fail-closed. A failed
  // read is reported as a retryable 503, never as "no domain", "Free plan",
  // "0 jobs used" or "0 credits left", all of which the customer would act on.
  const [sourceRead, limitsRead, creditsRead, jobsRead] = await Promise.all([
    resolveSourceDomainDetailed(config, workspaceId, requestedDomainId),
    resolveAiKbLimitsDetailed(config, workspaceId),
    readAiCreditStateDetailed(config, workspaceId),
    countJobsThisMonthDetailed(config, workspaceId),
  ]);
  const readFailure = firstReadFailure([sourceRead, limitsRead, creditsRead, jobsRead]);
  if (readFailure) {
    return res.status(503).json({ error: readFailure.errorCode, retryable: true });
  }
  const source = sourceRead.ok ? sourceRead.value : null!;
  const limitsInfo = limitsRead.ok ? limitsRead.value : null!;
  const credits = creditsRead.ok ? creditsRead.value : null!;
  const jobsThisMonth = jobsRead.ok ? jobsRead.value : 0;

  return res.json({
    source,
    plan: {
      slug: limitsInfo.planSlug,
      limits: limitsInfo.limits,
      jobs_used_this_month: jobsThisMonth,
      can_start_job: auth.isAdmin || jobsThisMonth < limitsInfo.limits.jobsPerMonth,
    },
    credits,
    modules: capabilities,
    is_global_admin: auth.isAdmin,
  });
});

// ──────────────────────────────────────────────────────────────
//  POST /api/ai-kb/jobs — create queued job (no inline crawl)
// ──────────────────────────────────────────────────────────────
const createJobSchema = z.object({
  workspaceId: z.string().uuid(),
  domain_id: z.string().uuid().optional(),
  locale: z.enum(['en', 'fa', 'tr']).optional(),
});

aiKbRouter.post('/jobs', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = createJobSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_params', details: parsed.error.flatten().fieldErrors });
  }
  const { workspaceId, domain_id, locale } = parsed.data;

  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;

  if (!(await gateAiKb(res, config, workspaceId, auth, {
    permissions: ['can_manage_knowledge_base'],
    route: 'POST /api/ai-kb/jobs',
  }))) return;

  const sourceRead = await resolveSourceDomainDetailed(config, workspaceId, domain_id);
  if (!sourceRead.ok) {
    // Starting a scan on an unread domain state could target the wrong site.
    return res.status(503).json({ error: sourceRead.errorCode, retryable: true });
  }
  const source = sourceRead.value;
  if (!source.can_scan || !source.domain) {
    return res.status(409).json({
      error: 'no_scannable_domain',
      reason: source.reason_if_blocked || 'missing_domain',
      message: 'No verified workspace domain available for scanning. Add and verify a domain in Settings → Domains.',
    });
  }

  const limitsRead = await resolveAiKbLimitsDetailed(config, workspaceId);
  if (!limitsRead.ok) {
    // Snapshotting fallback limits onto a real job would let the worker run
    // with limits the customer never bought.
    return res.status(503).json({ error: limitsRead.errorCode, retryable: true });
  }
  const limitsInfo = limitsRead.value;

  // ── Monthly job cap enforcement ────────────────────────────
  // Route-local Super Admin bypass + shared requireLimit/usageFnForLimit.
  // The bypass is kept explicit and local (per docs/PLAN_LIMIT_ALIGNMENT.md)
  // — we do NOT add a global admin short-circuit to requireLimit.
  if (!auth.isAdmin) {
    const limitMw = requireLimit(
      'ai_kb_jobs_per_month',
      usageFnForLimit('ai_kb_jobs_per_month'),
    );
    let proceeded = false;
    await limitMw(req, res, () => {
      proceeded = true;
    });
    if (!proceeded) {
      // Middleware already wrote a 403 response.
      return;
    }
  }

  const planSnapshot: PlanSnapshot = {
    planSlug: limitsInfo.planSlug,
    ...limitsInfo.limits,
    admin_override: auth.isAdmin || undefined,
    source: {
      kind: source.kind,
      domain: source.domain,
      verified: source.verified,
      workspace_domain_id: source.workspace_domain_id,
    },
  };

  const sb = getServiceClient(config);
  const { data: job, error } = await sb
    .from('ai_kb_jobs')
    .insert({
      workspace_id: workspaceId,
      requested_by: auth.userId,
      source_kind: source.kind,
      source_domain: source.domain,
      source_workspace_domain_id: source.workspace_domain_id,
      source_verified: source.verified,
      locale: locale || 'en',
      status: 'queued',
      plan_snapshot: planSnapshot,
      admin_override: auth.isAdmin,
      created_by_global_admin: auth.isAdmin ? auth.userId : null,
    })
    .select(AI_KB_JOB_COLUMNS)
    .single<AiKbJobRowLike>();

  if (error || !job) {
    logInternal('job_create_failed', error, { workspaceId });
    return res.status(500).json({ error: 'job_create_failed' });
  }

  await logAiKbUsage(config, workspaceId, 'job_created', { jobId: job.id, metadata: { domain: source.domain } });

  return res.status(201).json({ job: toPublicAiKbJob(job as any) });
});

// ──────────────────────────────────────────────────────────────
//  GET /api/ai-kb/jobs — list jobs for workspace
// ──────────────────────────────────────────────────────────────
aiKbRouter.get('/jobs', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = String(req.query.workspaceId || req.query.workspace_id || '');
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });

  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;

  if (!(await gateAiKb(res, config, workspaceId, auth, { route: 'GET /api/ai-kb/jobs' }))) return;

  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('ai_kb_jobs')
    .select(AI_KB_JOB_COLUMNS)
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    logInternal('list_failed', error, { workspaceId });
    return res.status(500).json({ error: 'list_failed' });
  }
  return res.json({ jobs: (data || []).map((r) => toPublicAiKbJob(r as any)) });
});

// ──────────────────────────────────────────────────────────────
//  GET /api/ai-kb/jobs/:id — job + pages + generated drafts
// ──────────────────────────────────────────────────────────────
aiKbRouter.get('/jobs/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);

  const auth = await authenticate(req, res, config);
  if (!auth) return;

  // Phase 6-S5-R7 — a lookup FAILURE is not a 404. Collapsing it into
  // "job_not_found" tells the operator their job disappeared while the real
  // cause is a transient backend fault.
  const { data: job, error: jobError } = await sb
    .from('ai_kb_jobs')
    .select(AI_KB_JOB_COLUMNS)
    .eq('id', req.params.id)
    .maybeSingle<AiKbJobRowLike>();
  if (jobError) {
    console.error('[ai-kb] job lookup failed', JSON.stringify({ code: jobError.code }));
    return res.status(503).json({ error: 'ai_kb_status_unavailable' });
  }

  // Canonical 404 for both "missing" and "not yours" — no existence leak.
  if (!job || !(await isAuthorizedForWorkspace(config, auth, job.workspace_id))) {
    return res.status(404).json({ error: 'job_not_found' });
  }
  if (!(await gateAiKb(res, config, job.workspace_id, auth, { route: 'GET /api/ai-kb/jobs/:id' }))) return;

  const [pagesRes, generatedRes, eventsRes] = await Promise.all([
    sb.from('ai_kb_job_pages').select(AI_KB_PAGE_COLUMNS).eq('job_id', job.id).order('created_at', { ascending: true }).limit(500),
    sb.from('ai_kb_generated_articles').select(AI_KB_GENERATED_COLUMNS).eq('job_id', job.id).order('created_at', { ascending: true }),
    sb.from('ai_kb_job_events').select(AI_KB_EVENT_COLUMNS).eq('job_id', job.id).order('created_at', { ascending: false }).limit(50),
  ]);

  // A failed sub-query must never be rendered as an empty list: the operator
  // would read "0 generated drafts" as an authoritative result and re-run a
  // job that already produced content.
  const subError = pagesRes.error || generatedRes.error || eventsRes.error;
  if (subError) {
    console.error('[ai-kb] job detail subquery failed', JSON.stringify({ code: subError.code }));
    return res.status(503).json({ error: 'ai_kb_status_unavailable' });
  }
  const { data: pages } = pagesRes;
  const { data: generated } = generatedRes;
  const { data: events } = eventsRes;

  // Phase 6-S5-R7.3 §6 — resolve the AUTHORITATIVE published identity for
  // every draft that is linked to a KB article. The draft's own `slug` is a
  // suggestion the database may have de-duplicated during publish, so a link
  // built from it can 404. The lookup is scoped to this job's workspace.
  const linkedIds = (generated || [])
    .map((g: any) => g.kb_article_id)
    .filter((id: unknown): id is string => typeof id === 'string' && !!id);
  const articleById = new Map<string, AiKbLinkedArticle>();
  if (linkedIds.length) {
    const { data: articles, error: articlesError } = await sb
      .from('knowledge_base_articles')
      .select('id, slug, locale, status')
      .eq('workspace_id', job.workspace_id)
      .in('id', linkedIds);
    if (articlesError) {
      // Rendering "not published" for an unread article would tell the
      // operator to republish content that is already live.
      console.error('[ai-kb] linked article lookup failed', JSON.stringify({ code: articlesError.code }));
      return res.status(503).json({ error: 'ai_kb_status_unavailable' });
    }
    for (const a of articles || []) {
      articleById.set((a as any).id, {
        slug: (a as any).slug ?? null,
        locale: (a as any).locale ?? null,
        status: (a as any).status ?? null,
      });
    }
  }

  return res.json({
    job: toPublicAiKbJob(job as any),
    pages: (pages || []).map((r) => toPublicAiKbPage(r as any)),
    generated: (generated || []).map((r) =>
      toPublicAiKbGenerated(r as any, articleById.get((r as any).kb_article_id) ?? null),
    ),
    events: (events || []).map((r) => toPublicAiKbJobEvent(r as any)),
  });
});

// ──────────────────────────────────────────────────────────────
//  POST /api/ai-kb/generated/:id/(accept|reject|publish)
// ──────────────────────────────────────────────────────────────
async function loadGenerated(
  req: Request,
  res: Response,
  config: ServerConfig,
  permissions: KnowledgeBasePermission[],
) {
  const auth = await authenticate(req, res, config);
  if (!auth) return null;

  const sb = getServiceClient(config);
  const { data: gen, error: genError } = await sb
    .from('ai_kb_generated_articles')
    .select(AI_KB_GENERATED_INTERNAL_COLUMNS)
    .eq('id', req.params.id)
    .maybeSingle();
  if (genError) {
    console.error('[ai-kb] generated lookup failed', JSON.stringify({ code: genError.code }));
    res.status(503).json({ error: 'ai_kb_status_unavailable' });
    return null;
  }

  // Canonical 404 for missing OR cross-workspace — no existence leak.
  if (!gen || !(await isAuthorizedForWorkspace(config, auth, gen.workspace_id))) {
    res.status(404).json({ error: 'not_found' });
    return null;
  }

  const ok = await gateAiKb(res, config, gen.workspace_id, auth, {
    permissions,
    route: `${req.method} ${req.baseUrl}${req.path}`,
  });
  if (!ok) return null;
  return { gen, sb, userId: auth.userId };
}

aiKbRouter.post('/generated/:id/reject', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const ctx = await loadGenerated(req, res, config, ['can_manage_knowledge_base']);
  if (!ctx) return;
  const { gen, sb, userId } = ctx;

  // R7.1 §11 — a mutation whose result is never inspected reports success
  // for a write that did not happen.
  const { data, error } = await sb.rpc('reject_ai_kb_generated_article', {
    _generated_id: gen.id,
    _workspace_id: gen.workspace_id,
    _reviewer: userId,
  });
  if (error) {
    logInternal('reject_failed', error, { generatedId: gen.id });
    return res.status(503).json({ error: 'ai_kb_status_unavailable' });
  }
  const result = (data || {}) as { ok?: boolean; error?: string };
  if (!result.ok) {
    if (result.error === 'not_found') return res.status(404).json({ error: 'not_found' });
    // R7.2 §B — an illegal transition (e.g. rejecting an already published
    // draft) is a client-visible conflict, not a server fault. Returning 500
    // here made a deterministic refusal look like an outage worth retrying.
    if (result.error === 'invalid_state') {
      return res.status(409).json({
        error: 'invalid_state',
        current_status: (data as any)?.current_status ?? null,
      });
    }
    return res.status(500).json({ error: 'reject_failed' });
  }
  return res.json({ ok: true });
});

/**
 * R7.1 §12 — accept / publish are ONE transaction.
 *
 * Previously the KB article was written first and the generated row was
 * linked afterwards; a failure between the two orphaned the article and the
 * next retry produced a duplicate. `accept_ai_kb_generated_article` /
 * `publish_ai_kb_generated_article` perform the upsert, the slug
 * de-duplication and the back-link atomically, keyed on
 * (generated_id, workspace_id) so a cross-workspace write is impossible.
 *
 * HTML normalization stays in the application layer and is passed in.
 */
interface ApplyGeneratedResult {
  ok: boolean;
  error?: string;
  current_status?: string;
  kb_article_id?: string;
  status?: string;
  slug?: string;
  locale?: string;
}

async function applyGeneratedDraft(
  sb: any,
  gen: any,
  userId: string,
  mode: 'accept' | 'publish',
): Promise<{ result?: ApplyGeneratedResult; transportError?: unknown }> {
  // R7.2 §C — the title-derived slug is a SEED handed to the transaction, not
  // a local mutation of `gen`. Assigning `gen.slug` only changed an in-memory
  // copy the RPC never saw, so a draft without a stored slug always fell back
  // to the generic `article-<id>` slug inside the database.
  const { data, error } = await sb.rpc(
    mode === 'accept' ? 'accept_ai_kb_generated_article' : 'publish_ai_kb_generated_article',
    {
      _generated_id: gen.id,
      _workspace_id: gen.workspace_id,
      _reviewer: userId,
      _content: normalizeArticleHtml(gen.content_md),
      _slug_seed: gen.slug || slugifyTitle(gen.title),
    },
  );
  if (error) return { transportError: error };
  return { result: (data || { ok: false }) as ApplyGeneratedResult };
}

/** Shared terminal handling for an unsuccessful accept/publish transaction. */
function respondApplyFailure(
  res: Response,
  result: ApplyGeneratedResult | undefined,
  fallback: 'accept_failed' | 'publish_failed',
  generatedId: string,
): Response {
  if (result?.error === 'not_found') return res.status(404).json({ error: 'not_found' });
  if (result?.error === 'invalid_state') {
    return res.status(409).json({
      error: 'invalid_state',
      current_status: result.current_status ?? null,
    });
  }
  logInternal(fallback, new Error(result?.error || 'unknown'), { generatedId });
  return res.status(500).json({ error: fallback });
}

aiKbRouter.post('/generated/:id/accept', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const ctx = await loadGenerated(req, res, config, ['can_manage_knowledge_base']);
  if (!ctx) return;
  const { gen, sb, userId } = ctx;

  const { result, transportError } = await applyGeneratedDraft(sb, gen, userId, 'accept');
  if (transportError) {
    logInternal('accept_transport_failed', transportError, { generatedId: gen.id });
    return res.status(503).json({ error: 'ai_kb_status_unavailable' });
  }
  if (!result?.ok) {
    return respondApplyFailure(res, result, 'accept_failed', gen.id);
  }
  return res.json({ ok: true, kb_article_id: result.kb_article_id });
});

aiKbRouter.post('/generated/:id/publish', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const ctx = await loadGenerated(req, res, config, [
    'can_manage_knowledge_base',
    'can_publish_knowledge_base',
  ]);
  if (!ctx) return;
  const { gen, sb, userId } = ctx;

  const { result, transportError } = await applyGeneratedDraft(sb, gen, userId, 'publish');
  if (transportError) {
    logInternal('publish_transport_failed', transportError, { generatedId: gen.id });
    return res.status(503).json({ error: 'ai_kb_status_unavailable' });
  }
  if (!result?.ok) {
    return respondApplyFailure(res, result, 'publish_failed', gen.id);
  }
  // The transaction itself is the proof of publication: the article row was
  // written with status='published' in the same statement that linked it.
  if (result.status !== 'published') {
    return res.status(500).json({
      error: 'publish_verification_failed',
      kb_article_id: result.kb_article_id,
    });
  }
  return res.json({
    ok: true,
    kb_article_id: result.kb_article_id,
    status: 'published',
    slug: result.slug,
    locale: result.locale,
  });
});

// ──────────────────────────────────────────────────────────────
//  POST /api/ai-kb/jobs/:jobId/publish-all
//  Bulk publish all pending/accepted generated drafts for a job.
// ──────────────────────────────────────────────────────────────
aiKbRouter.post('/jobs/:jobId/publish-all', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);

  const auth = await authenticate(req, res, config);
  if (!auth) return;

  const { data: job, error: jobError } = await sb
    .from('ai_kb_jobs')
    .select('id, workspace_id')
    .eq('id', req.params.jobId)
    .maybeSingle();
  if (jobError) {
    // R7.1 §10 — an unreadable job is NOT a missing job.
    console.error('[ai-kb] publish-all job lookup failed', JSON.stringify({ code: jobError.code }));
    return res.status(503).json({ error: 'ai_kb_status_unavailable' });
  }
  if (!job || !(await isAuthorizedForWorkspace(config, auth, job.workspace_id))) {
    return res.status(404).json({ error: 'job_not_found' });
  }

  if (!(await gateAiKb(res, config, job.workspace_id, auth, {
    permissions: ['can_manage_knowledge_base', 'can_publish_knowledge_base'],
    route: 'POST /api/ai-kb/jobs/:jobId/publish-all',
  }))) return;

  const { data: drafts, error: draftsError } = await sb
    .from('ai_kb_generated_articles')
    .select(AI_KB_GENERATED_INTERNAL_COLUMNS)
    .eq('job_id', job.id)
    .eq('workspace_id', job.workspace_id)
    .in('status', ['pending', 'accepted']);
  if (draftsError) {
    // Never report "0 published" on an unread draft set.
    console.error('[ai-kb] publish-all draft lookup failed', JSON.stringify({ code: draftsError.code }));
    return res.status(503).json({ error: 'ai_kb_status_unavailable' });
  }

  const published: Array<{ generated_id: string; kb_article_id: string }> = [];
  const failed: Array<{
    generated_id: string;
    error: 'publish_failed' | 'invalid_state';
    current_status?: string | null;
  }> = [];
  for (const gen of drafts || []) {
    const { result, transportError } = await applyGeneratedDraft(sb, gen, auth.userId, 'publish');
    if (transportError || !result?.ok || !result.kb_article_id) {
      // A draft another operator already rejected is reported as a conflict,
      // not as an anonymous failure the caller cannot interpret.
      if (!transportError && result?.error === 'invalid_state') {
        failed.push({
          generated_id: gen.id,
          error: 'invalid_state',
          current_status: result.current_status ?? null,
        });
        continue;
      }
      logInternal(
        'bulk_publish_failed',
        transportError ?? new Error(result?.error || 'unknown'),
        { generatedId: gen.id },
      );
      failed.push({ generated_id: gen.id, error: 'publish_failed' });
      continue;
    }
    published.push({ generated_id: gen.id, kb_article_id: result.kb_article_id });
  }
  return res.json({ ok: true, published_count: published.length, failed_count: failed.length, published, failed });
});

// ──────────────────────────────────────────────────────────────
//  GET /api/ai-kb/generated/:id/visibility — diagnostics
// ──────────────────────────────────────────────────────────────
aiKbRouter.get('/generated/:id/visibility', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const ctx = await loadGenerated(req, res, config, []);
  if (!ctx) return;
  const { gen, sb } = ctx;

  const base = { generatedStatus: gen.status, kbArticleId: gen.kb_article_id || null };

  if (!gen.kb_article_id) {
    return res.json(toPublicAiKbVisibility({
      ...base, article: null, widgetVisible: false, reason: 'no_kb_article',
    }));
  }

  const { data: art, error: artError } = await sb
    .from('knowledge_base_articles')
    .select('id, status, locale, slug, workspace_id')
    .eq('id', gen.kb_article_id)
    .maybeSingle();
  if (artError) {
    // R7.1 §10 — an unreadable article must never be reported as "missing".
    console.error('[ai-kb] visibility article lookup failed', JSON.stringify({ code: artError.code }));
    return res.status(503).json({ error: 'ai_kb_status_unavailable' });
  }
  if (!art) {
    return res.json(toPublicAiKbVisibility({
      ...base, article: null, widgetVisible: false, reason: 'article_missing',
    }));
  }
  // The workspace id itself is internal — only the VERDICT is exposed.
  if (art.workspace_id !== gen.workspace_id) {
    return res.json(toPublicAiKbVisibility({
      ...base, article: null, widgetVisible: false, reason: 'workspace_mismatch',
    }));
  }
  if (art.status !== 'published') {
    return res.json(toPublicAiKbVisibility({
      ...base, article: art, widgetVisible: false, reason: 'not_published',
    }));
  }
  // Not fatal — the widget falls back across locales — but still reported.
  const localeMismatch = art.locale !== gen.locale;
  return res.json(toPublicAiKbVisibility({
    ...base,
    article: art,
    widgetVisible: true,
    reason: localeMismatch ? 'locale_mismatch' : null,
  }));
});

// ──────────────────────────────────────────────────────────────
//  GET /api/ai-kb/worker/diagnostics — observability for AI Builder
// ──────────────────────────────────────────────────────────────
aiKbRouter.get('/worker/diagnostics', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = String(req.query.workspaceId || req.query.workspace_id || '');
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });

  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;

  if (!(await gateAiKb(res, config, workspaceId, auth, {
    route: 'GET /api/ai-kb/worker/diagnostics',
  }))) return;

  const sb = getServiceClient(config);

  const [
    queuedRes,
    runningRes,
    failedRes,
    latestRes,
    sourceRead,
    limitsRead,
    creditsRead,
    jobsRead,
  ] = await Promise.all([
    sb.from('ai_kb_jobs').select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId).eq('status', 'queued'),
    sb.from('ai_kb_jobs').select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId).in('status', ['running', 'crawling', 'generating']),
    sb.from('ai_kb_jobs').select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId).eq('status', 'failed'),
    sb.from('ai_kb_jobs').select(AI_KB_JOB_COLUMNS)
      .eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(1).maybeSingle<AiKbJobRowLike>(),
    resolveSourceDomainDetailed(config, workspaceId),
    resolveAiKbLimitsDetailed(config, workspaceId),
    readAiCreditStateDetailed(config, workspaceId),
    countJobsThisMonthDetailed(config, workspaceId),
  ]);

  const capabilities = await readAiKbCapabilities(config, workspaceId, {
    customerFacing: !auth.isAdmin,
  });

  // R7.2 — diagnostics that silently report "0 queued, 0 running, 0 failed"
  // on an unreadable table are worse than no diagnostics: an operator uses
  // this page to decide whether the worker is stuck.
  const countError =
    (queuedRes as any).error || (runningRes as any).error ||
    (failedRes as any).error || (latestRes as any).error;
  if (countError) {
    console.error('[ai-kb] diagnostics lookup failed', JSON.stringify({ code: countError.code }));
    return res.status(503).json({ error: 'ai_kb_status_unavailable' });
  }
  if (capabilities.platform_status_unavailable) {
    return res.status(503).json({ error: 'ai_platform_status_unavailable' });
  }
  const readFailure = firstReadFailure([sourceRead, limitsRead, creditsRead, jobsRead]);
  if (readFailure) {
    return res.status(503).json({ error: readFailure.errorCode, retryable: true });
  }
  const source = sourceRead.ok ? sourceRead.value : null!;
  const limitsInfo = limitsRead.ok ? limitsRead.value : null!;
  const credits = creditsRead.ok ? creditsRead.value : null!;
  const jobsThisMonth = jobsRead.ok ? jobsRead.value : 0;

  const latest: any = (latestRes as any).data || null;

  return res.json({
    counts: {
      queued_jobs_count: queuedRes.count || 0,
      running_jobs_count: runningRes.count || 0,
      failed_jobs_count: failedRes.count || 0,
    },
    latest_job: latest ? toPublicAiKbJob(latest) : null,
    latest_job_status: latest?.status || null,
    latest_heartbeat_at: latest?.updated_at || null,
    latest_error_code: latest
      ? toPublicErrorCode({ status: latest.status, errorMessage: latest.error_message })
      : null,
    source_domain_status: {
      domain: source.domain,
      kind: source.kind,
      verified: source.verified,
      can_scan: source.can_scan,
      reason_if_blocked: source.reason_if_blocked,
    },
    modules: capabilities,
    plan: {
      slug: limitsInfo.planSlug,
      limits: limitsInfo.limits,
      jobs_used_this_month: jobsThisMonth,
    },
    credits,
    is_global_admin: auth.isAdmin,
  });
});

// ──────────────────────────────────────────────────────────────
//  POST /api/ai-kb/jobs/test — admin-only dry-run job
//  Creates a tiny queued job (maxPages=1, maxArticles configurable)
//  to verify the worker claim & crawl path without burning credits.
// ──────────────────────────────────────────────────────────────
const testJobSchema = z.object({
  workspaceId: z.string().uuid(),
  generate: z.boolean().optional(),
});

aiKbRouter.post('/jobs/test', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = testJobSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_params', details: parsed.error.flatten().fieldErrors });
  }
  const { workspaceId, generate } = parsed.data;

  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;

  // Require workspace owner/admin role for this admin-only debug path.
  const sb = getServiceClient(config);
  if (!auth.isAdmin) {
    const { data: roleRow } = await sb
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', auth.userId)
      .maybeSingle();
    const role = (roleRow as any)?.role;
    if (role !== 'owner' && role !== 'admin') {
      return res.status(403).json({ error: 'admin_required' });
    }
  }

  if (!(await gateAiKb(res, config, workspaceId, auth, {
    permissions: ['can_manage_knowledge_base'],
    route: 'POST /api/ai-kb/jobs/test',
  }))) return;

  const testSourceRead = await resolveSourceDomainDetailed(config, workspaceId);
  if (!testSourceRead.ok) {
    return res.status(503).json({ error: testSourceRead.errorCode, retryable: true });
  }
  const source = testSourceRead.value;
  if (!source.can_scan || !source.domain) {
    return res.status(409).json({
      error: 'no_scannable_domain',
      reason: source.reason_if_blocked || 'missing_domain',
    });
  }

  const testLimitsRead = await resolveAiKbLimitsDetailed(config, workspaceId);
  if (!testLimitsRead.ok) {
    return res.status(503).json({ error: testLimitsRead.errorCode, retryable: true });
  }
  const limitsInfo = testLimitsRead.value;
  const planSnapshot: PlanSnapshot = {
    planSlug: limitsInfo.planSlug,
    ...limitsInfo.limits,
    // Force minimal scope for the dry-run.
    maxPages: 1,
    maxDepth: 0,
    maxArticles: generate ? 1 : 0,
    admin_override: auth.isAdmin || undefined,
    source: {
      kind: source.kind,
      domain: source.domain,
      verified: source.verified,
      workspace_domain_id: source.workspace_domain_id,
    },
  };

  const { data: job, error } = await sb
    .from('ai_kb_jobs')
    .insert({
      workspace_id: workspaceId,
      requested_by: auth.userId,
      source_kind: source.kind,
      source_domain: source.domain,
      source_workspace_domain_id: source.workspace_domain_id,
      source_verified: source.verified,
      locale: 'en',
      status: 'queued',
      plan_snapshot: planSnapshot,
      admin_override: auth.isAdmin,
      created_by_global_admin: auth.isAdmin ? auth.userId : null,
    })
    .select(AI_KB_JOB_COLUMNS)
    .single<AiKbJobRowLike>();

  if (error || !job) {
    logInternal('test_job_create_failed', error, { workspaceId });
    return res.status(500).json({ error: 'job_create_failed' });
  }

  await logAiKbUsage(config, workspaceId, 'job_created', {
    jobId: job.id,
    metadata: { domain: source.domain, test: true, generate: !!generate },
  });

  return res.status(201).json({ job: toPublicAiKbJob(job as any), test: true });
});
