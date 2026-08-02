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
import { isGlobalAdmin, logGateBypass } from '../middleware/adminBypass.js';
import {
  checkAiKbAccess,
  readAiKbCapabilities,
  type AiKbAccessResult,
} from '../services/ai-kb/access.js';
import type { KnowledgeBasePermission } from '../services/knowledge-base/access.js';
import { resolveSourceDomain } from '../services/ai-kb/sourceDomain.js';
import { resolveAiKbLimits, countJobsThisMonth } from '../services/ai-kb/limits.js';
import { readAiCreditState, logAiKbUsage } from '../services/ai-kb/credits.js';
import { slugifyTitle, type PlanSnapshot } from '../services/ai-kb/types.js';
import { normalizeArticleHtml } from '../services/ai-kb/htmlNormalize.js';

export const aiKbRouter: Router = express.Router();

/**
 * Sanitized server-side logging. Internal error text never reaches the client:
 * routes respond with a stable code only (see docs/ENTITLEMENT_ARCHITECTURE.md).
 */
function logInternal(scope: string, error: unknown, context: Record<string, unknown> = {}): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ai-kb] ${scope}`, JSON.stringify({ ...context, message: message.slice(0, 300) }));
}

// ─── Auth helper (operator JWT + workspace membership) ─────────
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
    customerFacing: opts.customerFacing,
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
  const capabilities = await readAiKbCapabilities(config, workspaceId);
  const entitled = await checkAiKbAccess(config, workspaceId, {
    isAdmin: auth.isAdmin,
    userId: auth.userId,
    route: 'GET /api/ai-kb/source',
  });
  if (!entitled.ok) {
    return res.json({
      source: {
        domain: null, kind: null, workspace_domain_id: null,
        verified: false, is_primary: false, can_scan: false,
        reason_if_blocked: entitled.denial?.body.error ?? 'not_entitled',
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
      denial: entitled.denial?.body,
      is_global_admin: auth.isAdmin,
    });
  }

  const [source, limitsInfo, credits, jobsThisMonth] = await Promise.all([
    resolveSourceDomain(config, workspaceId, requestedDomainId),
    resolveAiKbLimits(config, workspaceId),
    readAiCreditState(config, workspaceId),
    countJobsThisMonth(config, workspaceId),
  ]);

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

  const gate = await ensureModulesEnabled(config, workspaceId, {
    isAdmin: auth.isAdmin,
    userId: auth.userId,
    route: 'POST /api/ai-kb/jobs',
  });
  if (!gate.ok) {
    const blocked = gate as { ok: false; status: number; body: any };
    return res.status(blocked.status).json(blocked.body);
  }

  const source = await resolveSourceDomain(config, workspaceId, domain_id);
  if (!source.can_scan || !source.domain) {
    return res.status(409).json({
      error: 'no_scannable_domain',
      reason: source.reason_if_blocked || 'missing_domain',
      message: 'No verified workspace domain available for scanning. Add and verify a domain in Settings → Domains.',
    });
  }

  const limitsInfo = await resolveAiKbLimits(config, workspaceId);

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
    .select('*')
    .single();

  if (error || !job) {
    return res.status(500).json({ error: 'job_create_failed', details: error?.message });
  }

  await logAiKbUsage(config, workspaceId, 'job_created', { jobId: job.id, metadata: { domain: source.domain } });

  return res.status(201).json({ job });
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

  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('ai_kb_jobs')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return res.status(500).json({ error: 'list_failed', details: error.message });
  return res.json({ jobs: data || [] });
});

// ──────────────────────────────────────────────────────────────
//  GET /api/ai-kb/jobs/:id — job + pages + generated drafts
// ──────────────────────────────────────────────────────────────
aiKbRouter.get('/jobs/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);

  const { data: job, error } = await sb
    .from('ai_kb_jobs')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();

  if (error || !job) return res.status(404).json({ error: 'job_not_found' });

  const auth = await authorizeMember(req, res, config, job.workspace_id);
  if (!auth) return;

  const [{ data: pages }, { data: generated }, { data: events }] = await Promise.all([
    sb.from('ai_kb_job_pages').select('*').eq('job_id', job.id).order('created_at', { ascending: true }).limit(500),
    sb.from('ai_kb_generated_articles').select('*').eq('job_id', job.id).order('created_at', { ascending: true }),
    sb.from('ai_kb_job_events').select('*').eq('job_id', job.id).order('created_at', { ascending: false }).limit(50),
  ]);

  return res.json({ job, pages: pages || [], generated: generated || [], events: events || [] });
});

// ──────────────────────────────────────────────────────────────
//  POST /api/ai-kb/generated/:id/(accept|reject|publish)
// ──────────────────────────────────────────────────────────────
async function loadGenerated(req: Request, res: Response, config: ServerConfig) {
  const sb = getServiceClient(config);
  const { data: gen } = await sb
    .from('ai_kb_generated_articles')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();
  if (!gen) {
    res.status(404).json({ error: 'not_found' });
    return null;
  }
  const auth = await authorizeMember(req, res, config, gen.workspace_id);
  if (!auth) return null;
  const gate = await ensureModulesEnabled(config, gen.workspace_id, {
    isAdmin: auth.isAdmin,
    userId: auth.userId,
    route: `${req.method} ${req.baseUrl}${req.path}`,
  });
  if (!gate.ok) {
    const blocked = gate as { ok: false; status: number; body: any };
    res.status(blocked.status).json(blocked.body);
    return null;
  }
  return { gen, sb, userId: auth.userId };
}

aiKbRouter.post('/generated/:id/reject', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const ctx = await loadGenerated(req, res, config);
  if (!ctx) return;
  const { gen, sb, userId } = ctx;

  await sb
    .from('ai_kb_generated_articles')
    .update({ status: 'rejected', reviewed_by: userId, reviewed_at: new Date().toISOString() })
    .eq('id', gen.id);

  return res.json({ ok: true });
});

/** Insert (or reuse) a knowledge_base_articles row as a DRAFT for this generated draft. */
async function upsertKbArticleFromGenerated(sb: any, gen: any, status: 'draft' | 'published') {
  // If we already linked one, just update its status; otherwise insert a fresh draft.
  if (gen.kb_article_id) {
    // Composite ownership invariant: never write across workspaces.
    const { data, error } = await sb
      .from('knowledge_base_articles')
      .update({
        title: gen.title,
        content: normalizeArticleHtml(gen.content_md),
        excerpt: gen.excerpt,
        locale: gen.locale,
        status,
      })
      .eq('id', gen.kb_article_id)
      .eq('workspace_id', gen.workspace_id)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('kb_article_workspace_mismatch');
    return data;
  }

  const baseSlug = gen.slug || slugifyTitle(gen.title);
  let slug = baseSlug;
  // de-duplicate slug per (workspace, locale)
  for (let i = 0; i < 50; i++) {
    const { data: clash } = await sb
      .from('knowledge_base_articles')
      .select('id')
      .eq('workspace_id', gen.workspace_id)
      .eq('locale', gen.locale)
      .eq('slug', slug)
      .maybeSingle();
    if (!clash) break;
    slug = `${baseSlug}-${i + 2}`;
  }

  const { data, error } = await sb
    .from('knowledge_base_articles')
    .insert({
      workspace_id: gen.workspace_id,
      slug,
      locale: gen.locale,
      title: gen.title,
      content: normalizeArticleHtml(gen.content_md),
      excerpt: gen.excerpt,
      status,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

aiKbRouter.post('/generated/:id/accept', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const ctx = await loadGenerated(req, res, config);
  if (!ctx) return;
  const { gen, sb, userId } = ctx;

  try {
    const article = await upsertKbArticleFromGenerated(sb, gen, 'draft');
    await sb
      .from('ai_kb_generated_articles')
      .update({
        status: 'accepted',
        kb_article_id: article.id,
        reviewed_by: userId,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', gen.id);
    return res.json({ ok: true, kb_article_id: article.id });
  } catch (err: any) {
    return res.status(500).json({ error: 'accept_failed', details: err?.message });
  }
});

aiKbRouter.post('/generated/:id/publish', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const ctx = await loadGenerated(req, res, config);
  if (!ctx) return;
  const { gen, sb, userId } = ctx;

  try {
    const article = await upsertKbArticleFromGenerated(sb, gen, 'published');
    await sb
      .from('ai_kb_generated_articles')
      .update({
        status: 'published',
        kb_article_id: article.id,
        reviewed_by: userId,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', gen.id);
    // Post-publish verification — confirm the article is actually visible
    // to the widget query (workspace + status='published').
    const { data: verify } = await sb
      .from('knowledge_base_articles')
      .select('id, status, locale, slug')
      .eq('id', article.id)
      .eq('workspace_id', gen.workspace_id)
      .eq('status', 'published')
      .maybeSingle();
    if (!verify) {
      return res.status(500).json({ error: 'publish_verification_failed', kb_article_id: article.id });
    }
    return res.json({
      ok: true,
      kb_article_id: article.id,
      status: 'published',
      slug: verify.slug,
      locale: verify.locale,
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'publish_failed', details: err?.message });
  }
});

// ──────────────────────────────────────────────────────────────
//  POST /api/ai-kb/jobs/:jobId/publish-all
//  Bulk publish all pending/accepted generated drafts for a job.
// ──────────────────────────────────────────────────────────────
aiKbRouter.post('/jobs/:jobId/publish-all', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);

  const { data: job } = await sb
    .from('ai_kb_jobs')
    .select('id, workspace_id')
    .eq('id', req.params.jobId)
    .maybeSingle();
  if (!job) return res.status(404).json({ error: 'job_not_found' });

  const auth = await authorizeMember(req, res, config, job.workspace_id);
  if (!auth) return;

  const gate = await ensureModulesEnabled(config, job.workspace_id, {
    isAdmin: auth.isAdmin,
    userId: auth.userId,
    route: 'POST /api/ai-kb/jobs/:jobId/publish-all',
  });
  if (!gate.ok) {
    const blocked = gate as { ok: false; status: number; body: any };
    return res.status(blocked.status).json(blocked.body);
  }

  const { data: drafts } = await sb
    .from('ai_kb_generated_articles')
    .select('*')
    .eq('job_id', job.id)
    .eq('workspace_id', job.workspace_id)
    .in('status', ['pending', 'accepted']);

  const published: any[] = [];
  const failed: any[] = [];
  for (const gen of drafts || []) {
    try {
      const article = await upsertKbArticleFromGenerated(sb, gen, 'published');
      await sb
        .from('ai_kb_generated_articles')
        .update({
          status: 'published',
          kb_article_id: article.id,
          reviewed_by: auth.userId,
          reviewed_at: new Date().toISOString(),
        })
        .eq('id', gen.id);
      published.push({ generated_id: gen.id, kb_article_id: article.id });
    } catch (err: any) {
      failed.push({ generated_id: gen.id, error: err?.message || 'unknown' });
    }
  }
  return res.json({ ok: true, published_count: published.length, failed_count: failed.length, published, failed });
});

// ──────────────────────────────────────────────────────────────
//  GET /api/ai-kb/generated/:id/visibility — diagnostics
// ──────────────────────────────────────────────────────────────
aiKbRouter.get('/generated/:id/visibility', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: gen } = await sb
    .from('ai_kb_generated_articles')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();
  if (!gen) return res.status(404).json({ error: 'not_found' });

  const auth = await authorizeMember(req, res, config, gen.workspace_id);
  if (!auth) return;

  const result: any = {
    generated_status: gen.status,
    kb_article_id: gen.kb_article_id || null,
    kb_article_status: null,
    kb_article_locale: null,
    kb_article_slug: null,
    kb_article_workspace_id: null,
    widget_visible: false,
    reason_if_not_visible: null as string | null,
  };

  if (!gen.kb_article_id) {
    result.reason_if_not_visible = 'no_kb_article';
    return res.json(result);
  }
  const { data: art } = await sb
    .from('knowledge_base_articles')
    .select('id, status, locale, slug, workspace_id')
    .eq('id', gen.kb_article_id)
    .maybeSingle();
  if (!art) {
    result.reason_if_not_visible = 'article_missing';
    return res.json(result);
  }
  result.kb_article_status = art.status;
  result.kb_article_locale = art.locale;
  result.kb_article_slug = art.slug;
  result.kb_article_workspace_id = art.workspace_id;
  if (art.workspace_id !== gen.workspace_id) {
    result.reason_if_not_visible = 'workspace_mismatch';
    return res.json(result);
  }
  if (art.status !== 'published') {
    result.reason_if_not_visible = 'not_published';
    return res.json(result);
  }
  if (art.locale !== gen.locale) {
    // Not fatal — widget falls back across locales — but report it.
    result.widget_visible = true;
    result.reason_if_not_visible = 'locale_mismatch';
    return res.json(result);
  }
  result.widget_visible = true;
  return res.json(result);
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

  const sb = getServiceClient(config);

  const [
    queuedRes,
    runningRes,
    failedRes,
    latestRes,
    source,
    limitsInfo,
    credits,
    jobsThisMonth,
  ] = await Promise.all([
    sb.from('ai_kb_jobs').select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId).eq('status', 'queued'),
    sb.from('ai_kb_jobs').select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId).in('status', ['running', 'crawling', 'generating']),
    sb.from('ai_kb_jobs').select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId).eq('status', 'failed'),
    sb.from('ai_kb_jobs').select('*')
      .eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    resolveSourceDomain(config, workspaceId),
    resolveAiKbLimits(config, workspaceId),
    readAiCreditState(config, workspaceId),
    countJobsThisMonth(config, workspaceId),
  ]);

  const modules = await Promise.all([
    checkModuleAccess(config.supabaseUrl, config.supabaseServiceRoleKey, workspaceId, 'knowledge_base'),
    checkModuleAccess(config.supabaseUrl, config.supabaseServiceRoleKey, workspaceId, 'ai_kb_builder'),
  ]);

  const latest: any = (latestRes as any).data || null;

  return res.json({
    counts: {
      queued_jobs_count: queuedRes.count || 0,
      running_jobs_count: runningRes.count || 0,
      failed_jobs_count: failedRes.count || 0,
    },
    latest_job: latest,
    latest_job_status: latest?.status || null,
    latest_worker_id: latest?.worker_id || null,
    latest_heartbeat_at: latest?.updated_at || null,
    latest_error: latest?.error_message || null,
    source_domain_status: {
      domain: source.domain,
      kind: source.kind,
      verified: source.verified,
      can_scan: source.can_scan,
      reason_if_blocked: source.reason_if_blocked,
    },
    modules: {
      knowledge_base: modules[0].allowed || auth.isAdmin,
      ai_kb_builder: modules[1].allowed || auth.isAdmin,
    },
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

  const gate = await ensureModulesEnabled(config, workspaceId, {
    isAdmin: auth.isAdmin,
    userId: auth.userId,
    route: 'POST /api/ai-kb/jobs/test',
  });
  if (!gate.ok) {
    const blocked = gate as { ok: false; status: number; body: any };
    return res.status(blocked.status).json(blocked.body);
  }

  const source = await resolveSourceDomain(config, workspaceId);
  if (!source.can_scan || !source.domain) {
    return res.status(409).json({
      error: 'no_scannable_domain',
      reason: source.reason_if_blocked || 'missing_domain',
    });
  }

  const limitsInfo = await resolveAiKbLimits(config, workspaceId);
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
    .select('*')
    .single();

  if (error || !job) {
    return res.status(500).json({ error: 'job_create_failed', details: error?.message });
  }

  await logAiKbUsage(config, workspaceId, 'job_created', {
    jobId: job.id,
    metadata: { domain: source.domain, test: true, generate: !!generate },
  });

  return res.status(201).json({ job, test: true });
});
