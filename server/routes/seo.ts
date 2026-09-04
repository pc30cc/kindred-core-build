/**
 * SEO / Website Audit — workspace-scoped API.
 *
 * SECURITY CONTRACT (do not weaken):
 *   - Every route calls `authorizeWorkspaceAccess` first. Crawl creation and
 *     cancellation additionally require `{ manage: true }` (owner/admin),
 *     matching the billing-router convention for actions that consume quota.
 *   - The client NEVER supplies a URL. `POST /crawls` takes only `siteId`;
 *     the canonical URL is resolved server-side from `workspace_domains`
 *     (see server/services/seo/siteResolver.ts) — there is no endpoint
 *     anywhere in this file that accepts an arbitrary URL.
 *   - Every resource read (crawl/page/issue/link/sitemap) is re-scoped by
 *     `workspace_id` IN THE QUERY, not just checked once at the top of the
 *     handler — a `crawlId` belonging to another workspace resolves to 404,
 *     never to that workspace's data, even if the caller is a legitimate
 *     member of some OTHER workspace.
 */
import { Router } from 'express';
import { z } from 'zod';
import { authorizeWorkspaceAccess } from '../lib/workspaceAuth.js';
import type { ServerConfig } from '../config.js';
import { listWorkspaceSites } from '../services/seo/siteResolver.js';
import { resolveSeoLimits } from '../services/seo/limits.js';
import {
  createCrawl,
  getCrawl,
  getLatestCrawlForSite,
  listCrawlsForSite,
  requestCrawlCancel,
  listCrawlPages,
  listCrawlIssues,
  getIssueAffectedUrls,
  listCrawlLinks,
  listCrawlSitemaps,
  compareWithPreviousCrawl,
  CrawlLimitError,
} from '../services/seo/crawlService.js';
import { SiteResolutionError } from '../services/seo/siteResolver.js';

export const seoRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

function configOf(req: any): ServerConfig {
  return (req as any).serverConfig as ServerConfig;
}

// ─── GET /:workspaceId/sites — workspace's own registered websites only ───
seoRouter.get('/:workspaceId/sites', async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  try {
    const sites = await listWorkspaceSites(configOf(req), workspaceId);
    res.json({ sites });
  } catch (err: any) {
    res.status(500).json({ error: 'sites_lookup_failed', detail: err?.message });
  }
});

// ─── GET /:workspaceId/limits — plan-resolved crawl limits (UI never hardcodes) ───
seoRouter.get('/:workspaceId/limits', async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const resolved = await resolveSeoLimits(configOf(req), workspaceId);
  res.json(resolved);
});

// ─── GET /:workspaceId/sites/:siteId/latest-crawl ───
seoRouter.get('/:workspaceId/sites/:siteId/latest-crawl', async (req, res) => {
  const { workspaceId, siteId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!isUuid(siteId)) return res.status(400).json({ error: 'invalid_site_id' });
  const crawl = await getLatestCrawlForSite(configOf(req), workspaceId, siteId);
  res.json({ crawl });
});

// ─── GET /:workspaceId/sites/:siteId/crawls — crawl history ───
seoRouter.get('/:workspaceId/sites/:siteId/crawls', async (req, res) => {
  const { workspaceId, siteId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!isUuid(siteId)) return res.status(400).json({ error: 'invalid_site_id' });
  const limit = Math.min(parseInt(String(req.query.limit || '20'), 10) || 20, 100);
  const offset = Math.max(parseInt(String(req.query.offset || '0'), 10) || 0, 0);
  const result = await listCrawlsForSite(configOf(req), workspaceId, siteId, { limit, offset });
  res.json(result);
});

// ─── POST /:workspaceId/crawls — start a new audit. Body: { siteId } ONLY. ───
const createCrawlSchema = z.object({ siteId: z.string().uuid() });

seoRouter.post('/:workspaceId/crawls', async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;
  const parsed = createCrawlSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input', detail: parsed.error.flatten() });

  try {
    const crawl = await createCrawl(configOf(req), {
      workspaceId,
      siteId: parsed.data.siteId,
      userId: auth.userId,
    });
    res.status(201).json({ crawl });
  } catch (err) {
    if (err instanceof SiteResolutionError) {
      return res.status(404).json({ error: err.code });
    }
    if (err instanceof CrawlLimitError) {
      return res.status(429).json({ error: err.reason, retryAfterSeconds: err.retryAfterSeconds, message: err.message });
    }
    res.status(500).json({ error: 'create_crawl_failed', detail: (err as Error)?.message });
  }
});

// ─── GET /:workspaceId/crawls/:crawlId ───
seoRouter.get('/:workspaceId/crawls/:crawlId', async (req, res) => {
  const { workspaceId, crawlId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!isUuid(crawlId)) return res.status(400).json({ error: 'invalid_crawl_id' });
  const crawl = await getCrawl(configOf(req), workspaceId, crawlId);
  if (!crawl) return res.status(404).json({ error: 'crawl_not_found' });
  res.json({ crawl });
});

// ─── POST /:workspaceId/crawls/:crawlId/cancel ───
seoRouter.post('/:workspaceId/crawls/:crawlId/cancel', async (req, res) => {
  const { workspaceId, crawlId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;
  if (!isUuid(crawlId)) return res.status(400).json({ error: 'invalid_crawl_id' });
  const crawl = await getCrawl(configOf(req), workspaceId, crawlId);
  if (!crawl) return res.status(404).json({ error: 'crawl_not_found' });
  const result = await requestCrawlCancel(configOf(req), workspaceId, crawlId);
  res.json(result);
});

async function requireCrawlInWorkspace(req: any, res: any, workspaceId: string, crawlId: string) {
  if (!isUuid(crawlId)) {
    res.status(400).json({ error: 'invalid_crawl_id' });
    return null;
  }
  const crawl = await getCrawl(configOf(req), workspaceId, crawlId);
  if (!crawl) {
    res.status(404).json({ error: 'crawl_not_found' });
    return null;
  }
  return crawl;
}

// ─── GET /:workspaceId/crawls/:crawlId/pages ───
seoRouter.get('/:workspaceId/crawls/:crawlId/pages', async (req, res) => {
  const { workspaceId, crawlId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!(await requireCrawlInWorkspace(req, res, workspaceId, crawlId))) return;
  const { httpStatusClass, indexable, search } = req.query;
  const result = await listCrawlPages(configOf(req), workspaceId, crawlId, {
    httpStatusClass: httpStatusClass as any,
    indexable: indexable === 'true' ? true : indexable === 'false' ? false : undefined,
    search: search ? String(search).slice(0, 200) : undefined,
    limit: parseInt(String(req.query.limit || '50'), 10),
    offset: parseInt(String(req.query.offset || '0'), 10),
  });
  res.json(result);
});

// ─── GET /:workspaceId/crawls/:crawlId/issues ───
seoRouter.get('/:workspaceId/crawls/:crawlId/issues', async (req, res) => {
  const { workspaceId, crawlId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!(await requireCrawlInWorkspace(req, res, workspaceId, crawlId))) return;
  const result = await listCrawlIssues(configOf(req), workspaceId, crawlId, {
    severity: req.query.severity ? String(req.query.severity) : undefined,
    category: req.query.category ? String(req.query.category) : undefined,
    status: req.query.status ? String(req.query.status) : undefined,
    limit: parseInt(String(req.query.limit || '50'), 10),
    offset: parseInt(String(req.query.offset || '0'), 10),
  });
  res.json(result);
});

// ─── GET /:workspaceId/crawls/:crawlId/issues/:issueId/pages ───
seoRouter.get('/:workspaceId/crawls/:crawlId/issues/:issueId/pages', async (req, res) => {
  const { workspaceId, crawlId, issueId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!(await requireCrawlInWorkspace(req, res, workspaceId, crawlId))) return;
  if (!isUuid(issueId)) return res.status(400).json({ error: 'invalid_issue_id' });
  const result = await getIssueAffectedUrls(configOf(req), workspaceId, crawlId, issueId, {
    limit: parseInt(String(req.query.limit || '50'), 10),
    offset: parseInt(String(req.query.offset || '0'), 10),
  });
  res.json(result);
});

// ─── GET /:workspaceId/crawls/:crawlId/links ───
seoRouter.get('/:workspaceId/crawls/:crawlId/links', async (req, res) => {
  const { workspaceId, crawlId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!(await requireCrawlInWorkspace(req, res, workspaceId, crawlId))) return;
  const { external, broken } = req.query;
  const result = await listCrawlLinks(configOf(req), workspaceId, crawlId, {
    external: external === 'true' ? true : external === 'false' ? false : undefined,
    brokenOnly: broken === 'true',
    limit: parseInt(String(req.query.limit || '50'), 10),
    offset: parseInt(String(req.query.offset || '0'), 10),
  });
  res.json(result);
});

// ─── GET /:workspaceId/crawls/:crawlId/sitemaps ───
seoRouter.get('/:workspaceId/crawls/:crawlId/sitemaps', async (req, res) => {
  const { workspaceId, crawlId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!(await requireCrawlInWorkspace(req, res, workspaceId, crawlId))) return;
  const sitemaps = await listCrawlSitemaps(configOf(req), workspaceId, crawlId);
  res.json({ sitemaps });
});

// ─── GET /:workspaceId/crawls/:crawlId/compare — vs. previous completed crawl ───
seoRouter.get('/:workspaceId/crawls/:crawlId/compare', async (req, res) => {
  const { workspaceId, crawlId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!(await requireCrawlInWorkspace(req, res, workspaceId, crawlId))) return;
  const comparison = await compareWithPreviousCrawl(configOf(req), workspaceId, crawlId);
  res.json(comparison);
});
