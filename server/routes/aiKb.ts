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
import { checkModuleAccess } from '../middleware/featureGating.js';
import { resolveSourceDomain } from '../services/ai-kb/sourceDomain.js';
import { resolveAiKbLimits, countJobsThisMonth } from '../services/ai-kb/limits.js';
import { readAiCreditState, logAiKbUsage } from '../services/ai-kb/credits.js';
import { slugifyTitle, type PlanSnapshot } from '../services/ai-kb/types.js';

export const aiKbRouter: Router = express.Router();

// ─── Auth helper (operator JWT + workspace membership) ─────────
async function authorizeMember(
  req: Request,
  res: Response,
  config: ServerConfig,
  workspaceId: string,
): Promise<{ userId: string } | null> {
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
  return { userId: user.id };
}

async function ensureModulesEnabled(
  config: ServerConfig,
  workspaceId: string,
): Promise<{ ok: true } | { ok: false; status: number; body: any }> {
  for (const moduleKey of ['knowledge_base', 'ai_kb_builder']) {
    const r = await checkModuleAccess(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      workspaceId,
      moduleKey,
    );
    if (!r.allowed) {
      return {
        ok: false,
        status: 403,
        body: {
          error: `Module '${moduleKey}' is not enabled for this workspace`,
          module: moduleKey,
          plan: r.plan,
          upgrade_required: true,
        },
      };
    }
  }
  return { ok: true };
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

  const [source, limitsInfo, credits, jobsThisMonth] = await Promise.all([
    resolveSourceDomain(config, workspaceId, requestedDomainId),
    resolveAiKbLimits(config, workspaceId),
    readAiCreditState(config, workspaceId),
    countJobsThisMonth(config, workspaceId),
  ]);

  const modules = await Promise.all([
    checkModuleAccess(config.supabaseUrl, config.supabaseServiceRoleKey, workspaceId, 'knowledge_base'),
    checkModuleAccess(config.supabaseUrl, config.supabaseServiceRoleKey, workspaceId, 'ai_kb_builder'),
  ]);

  return res.json({
    source,
    plan: {
      slug: limitsInfo.planSlug,
      limits: limitsInfo.limits,
      jobs_used_this_month: jobsThisMonth,
      can_start_job: jobsThisMonth < limitsInfo.limits.jobsPerMonth,
    },
    credits,
    modules: {
      knowledge_base: modules[0].allowed,
      ai_kb_builder: modules[1].allowed,
    },
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

  const gate = await ensureModulesEnabled(config, workspaceId);
  if (!gate.ok) return res.status(gate.status).json(gate.body);

  const source = await resolveSourceDomain(config, workspaceId, domain_id);
  if (!source.can_scan || !source.domain) {
    return res.status(409).json({
      error: 'no_scannable_domain',
      reason: source.reason_if_blocked || 'missing_domain',
      message: 'No verified workspace domain available for scanning. Add and verify a domain in Settings → Domains.',
    });
  }

  const limitsInfo = await resolveAiKbLimits(config, workspaceId);
  const jobsUsed = await countJobsThisMonth(config, workspaceId);
  if (jobsUsed >= limitsInfo.limits.jobsPerMonth) {
    return res.status(403).json({
      error: 'monthly_job_limit_reached',
      plan: limitsInfo.planSlug,
      jobs_used_this_month: jobsUsed,
      limit: limitsInfo.limits.jobsPerMonth,
      upgrade_required: true,
    });
  }

  const planSnapshot: PlanSnapshot = {
    planSlug: limitsInfo.planSlug,
    ...limitsInfo.limits,
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

  const [{ data: pages }, { data: generated }] = await Promise.all([
    sb.from('ai_kb_job_pages').select('*').eq('job_id', job.id).order('created_at', { ascending: true }).limit(500),
    sb.from('ai_kb_generated_articles').select('*').eq('job_id', job.id).order('created_at', { ascending: true }),
  ]);

  return res.json({ job, pages: pages || [], generated: generated || [] });
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
    const { data, error } = await sb
      .from('knowledge_base_articles')
      .update({
        title: gen.title,
        content: gen.content_md,
        excerpt: gen.excerpt,
        locale: gen.locale,
        status,
      })
      .eq('id', gen.kb_article_id)
      .select('*')
      .maybeSingle();
    if (error) throw error;
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
      content: gen.content_md,
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
    return res.json({ ok: true, kb_article_id: article.id });
  } catch (err: any) {
    return res.status(500).json({ error: 'publish_failed', details: err?.message });
  }
});
