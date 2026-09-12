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
import { requireModule } from '../middleware/featureGating.js';
import { listWorkspaceSites } from '../services/seo/siteResolver.js';
import { resolveSeoLimits } from '../services/seo/limits.js';
import { resolveBacklinksLimits } from '../services/seo/backlinksLimits.js';
import { resolveKeywordsLimits } from '../services/seo/keywordsLimits.js';
import { resolveRankTrackingLimits } from '../services/seo/rankTrackingLimits.js';
import { resolvePerformanceLimits } from '../services/seo/performanceLimits.js';
import { resolveGscLimits } from '../services/seo/gscLimits.js';
import {
  isGscPlatformConfigured,
  startGscOAuth,
  handleGscOAuthCallback,
  getConnectionInfo as getGscConnectionInfo,
  disconnectGsc,
  listProperties as listGscProperties,
  discoverAvailableSites,
  linkProperty as linkGscProperty,
  unlinkProperty as unlinkGscProperty,
  setPrimaryProperty as setPrimaryGscProperty,
  querySearchAnalytics,
} from '../services/seo/gsc/index.js';
import { isGscError, type GscDimension } from '../services/seo/gsc/types.js';
import { resolveAppBaseUrl } from '../services/invitations/tokens.js';
import { getServiceClient } from '../supabase.js';
import { resolveExplorerLimits } from '../services/seo/explorerLimits.js';
import {
  createExplorerBacklinkScan, getExplorerBacklinkScan, getLatestExplorerBacklinkScanForDomain,
  listExplorerBacklinks, requestExplorerBacklinkScanCancel,
  listExplorerReferringDomains, listExplorerTopPages,
  createExplorerKeywordScan, getExplorerKeywordScan, getLatestExplorerKeywordScanForDomain,
  listExplorerKeywords, requestExplorerKeywordScanCancel,
  createExplorerCompetitorScan, getExplorerCompetitorScan, getLatestExplorerCompetitorScanForDomain,
  listExplorerCompetitors, requestExplorerCompetitorScanCancel,
  listExplorerHistory, ExplorerScanLimitError,
} from '../services/seo/siteExplorerService.js';
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
import {
  createBacklinkScan,
  getBacklinkScan,
  getLatestBacklinkScanForSite,
  listBacklinkScansForSite,
  listBacklinks,
  requestBacklinkScanCancel,
  BacklinkScanLimitError,
} from '../services/seo/backlinkService.js';
import {
  createKeywordResearchRun,
  getKeywordResearchRun,
  getLatestKeywordResearchRunForSite,
  listKeywordResearchRunsForSite,
  listKeywordResults,
  requestKeywordRunCancel,
  KeywordRunLimitError,
} from '../services/seo/keywordResearchService.js';
import {
  addTrackedKeyword,
  removeTrackedKeyword,
  listTrackedKeywordsForSite,
  listRankChecksForKeyword,
  getRankTrackingOverview,
  getRankTrackingLandscape,
  getRankTrackingCompetitors,
  TrackedKeywordLimitError,
} from '../services/seo/rankTrackingService.js';
import {
  createPerformanceAudit,
  getPerformanceAudit,
  getLatestPerformanceAuditForCrawl,
  listPerformanceResults,
  requestPerformanceAuditCancel,
  PerformanceAuditLimitError,
} from '../services/seo/performanceAuditService.js';
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

// ─────────────────────────────────────────────────────────────────────────
// SEO Backlinks — same authorization contract as the crawl routes above:
// authorizeWorkspaceAccess first on every route, {manage:true} for anything
// that consumes quota, every resource re-scoped by workspace_id in the query.
// requireModule('seo_backlinks') additionally gates scan creation/reads on
// the plan's module flag (the always-on crawl module has no such gate today).
// ─────────────────────────────────────────────────────────────────────────

// ─── GET /:workspaceId/backlinks/limits ───
seoRouter.get('/:workspaceId/backlinks/limits', async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const resolved = await resolveBacklinksLimits(configOf(req), workspaceId);
  res.json(resolved);
});

// ─── GET /:workspaceId/sites/:siteId/backlink-scans/latest ───
seoRouter.get('/:workspaceId/sites/:siteId/backlink-scans/latest', requireModule('seo_backlinks'), async (req, res) => {
  const { workspaceId, siteId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!isUuid(siteId)) return res.status(400).json({ error: 'invalid_site_id' });
  const scan = await getLatestBacklinkScanForSite(configOf(req), workspaceId, siteId);
  res.json({ scan });
});

// ─── GET /:workspaceId/sites/:siteId/backlink-scans — scan history ───
seoRouter.get('/:workspaceId/sites/:siteId/backlink-scans', requireModule('seo_backlinks'), async (req, res) => {
  const { workspaceId, siteId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!isUuid(siteId)) return res.status(400).json({ error: 'invalid_site_id' });
  const limit = Math.min(parseInt(String(req.query.limit || '20'), 10) || 20, 100);
  const offset = Math.max(parseInt(String(req.query.offset || '0'), 10) || 0, 0);
  const result = await listBacklinkScansForSite(configOf(req), workspaceId, siteId, { limit, offset });
  res.json(result);
});

// ─── POST /:workspaceId/backlink-scans — start a new scan. Body: { siteId } ONLY. ───
const createBacklinkScanSchema = z.object({ siteId: z.string().uuid() });

seoRouter.post('/:workspaceId/backlink-scans', requireModule('seo_backlinks'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;
  const parsed = createBacklinkScanSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input', detail: parsed.error.flatten() });

  try {
    const scan = await createBacklinkScan(configOf(req), { workspaceId, siteId: parsed.data.siteId, userId: auth.userId });
    res.status(201).json({ scan });
  } catch (err) {
    if (err instanceof SiteResolutionError) return res.status(404).json({ error: err.code });
    if (err instanceof BacklinkScanLimitError) {
      return res.status(429).json({ error: err.reason, retryAfterSeconds: err.retryAfterSeconds, message: err.message });
    }
    res.status(500).json({ error: 'create_backlink_scan_failed', detail: (err as Error)?.message });
  }
});

// ─── GET /:workspaceId/backlink-scans/:scanId ───
seoRouter.get('/:workspaceId/backlink-scans/:scanId', requireModule('seo_backlinks'), async (req, res) => {
  const { workspaceId, scanId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!isUuid(scanId)) return res.status(400).json({ error: 'invalid_scan_id' });
  const scan = await getBacklinkScan(configOf(req), workspaceId, scanId);
  if (!scan) return res.status(404).json({ error: 'scan_not_found' });
  res.json({ scan });
});

// ─── POST /:workspaceId/backlink-scans/:scanId/cancel ───
seoRouter.post('/:workspaceId/backlink-scans/:scanId/cancel', requireModule('seo_backlinks'), async (req, res) => {
  const { workspaceId, scanId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;
  if (!isUuid(scanId)) return res.status(400).json({ error: 'invalid_scan_id' });
  const scan = await getBacklinkScan(configOf(req), workspaceId, scanId);
  if (!scan) return res.status(404).json({ error: 'scan_not_found' });
  const result = await requestBacklinkScanCancel(configOf(req), workspaceId, scanId);
  res.json(result);
});

// ─── GET /:workspaceId/backlink-scans/:scanId/backlinks ───
seoRouter.get('/:workspaceId/backlink-scans/:scanId/backlinks', requireModule('seo_backlinks'), async (req, res) => {
  const { workspaceId, scanId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!isUuid(scanId)) return res.status(400).json({ error: 'invalid_scan_id' });
  const scan = await getBacklinkScan(configOf(req), workspaceId, scanId);
  if (!scan) return res.status(404).json({ error: 'scan_not_found' });
  const { dofollow, isNew, search } = req.query;
  const result = await listBacklinks(configOf(req), workspaceId, scanId, {
    dofollowOnly: dofollow === 'true',
    isNew: isNew === 'true' ? true : isNew === 'false' ? false : undefined,
    search: search ? String(search).slice(0, 200) : undefined,
    limit: parseInt(String(req.query.limit || '50'), 10),
    offset: parseInt(String(req.query.offset || '0'), 10),
  });
  res.json(result);
});

// ─────────────────────────────────────────────────────────────────────────
// SEO Keyword Research — same authorization contract as Backlinks above.
// ─────────────────────────────────────────────────────────────────────────

seoRouter.get('/:workspaceId/keywords/limits', async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const resolved = await resolveKeywordsLimits(configOf(req), workspaceId);
  res.json(resolved);
});

seoRouter.get('/:workspaceId/sites/:siteId/keyword-runs/latest', requireModule('seo_keywords'), async (req, res) => {
  const { workspaceId, siteId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!isUuid(siteId)) return res.status(400).json({ error: 'invalid_site_id' });
  const run = await getLatestKeywordResearchRunForSite(configOf(req), workspaceId, siteId);
  res.json({ run });
});

seoRouter.get('/:workspaceId/sites/:siteId/keyword-runs', requireModule('seo_keywords'), async (req, res) => {
  const { workspaceId, siteId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!isUuid(siteId)) return res.status(400).json({ error: 'invalid_site_id' });
  const limit = Math.min(parseInt(String(req.query.limit || '20'), 10) || 20, 100);
  const offset = Math.max(parseInt(String(req.query.offset || '0'), 10) || 0, 0);
  const result = await listKeywordResearchRunsForSite(configOf(req), workspaceId, siteId, { limit, offset });
  res.json(result);
});

const createKeywordRunSchema = z.object({ siteId: z.string().uuid(), seedKeywords: z.array(z.string().min(1).max(200)).min(1).max(1000) });

seoRouter.post('/:workspaceId/keyword-runs', requireModule('seo_keywords'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;
  const parsed = createKeywordRunSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input', detail: parsed.error.flatten() });

  try {
    const run = await createKeywordResearchRun(configOf(req), {
      workspaceId, siteId: parsed.data.siteId, userId: auth.userId, seedKeywords: parsed.data.seedKeywords,
    });
    res.status(201).json({ run });
  } catch (err) {
    if (err instanceof SiteResolutionError) return res.status(404).json({ error: err.code });
    if (err instanceof KeywordRunLimitError) {
      return res.status(429).json({ error: err.reason, retryAfterSeconds: err.retryAfterSeconds, message: err.message });
    }
    res.status(500).json({ error: 'create_keyword_run_failed', detail: (err as Error)?.message });
  }
});

seoRouter.get('/:workspaceId/keyword-runs/:runId', requireModule('seo_keywords'), async (req, res) => {
  const { workspaceId, runId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!isUuid(runId)) return res.status(400).json({ error: 'invalid_run_id' });
  const run = await getKeywordResearchRun(configOf(req), workspaceId, runId);
  if (!run) return res.status(404).json({ error: 'run_not_found' });
  res.json({ run });
});

seoRouter.post('/:workspaceId/keyword-runs/:runId/cancel', requireModule('seo_keywords'), async (req, res) => {
  const { workspaceId, runId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;
  if (!isUuid(runId)) return res.status(400).json({ error: 'invalid_run_id' });
  const run = await getKeywordResearchRun(configOf(req), workspaceId, runId);
  if (!run) return res.status(404).json({ error: 'run_not_found' });
  const result = await requestKeywordRunCancel(configOf(req), workspaceId, runId);
  res.json(result);
});

seoRouter.get('/:workspaceId/keyword-runs/:runId/results', requireModule('seo_keywords'), async (req, res) => {
  const { workspaceId, runId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!isUuid(runId)) return res.status(400).json({ error: 'invalid_run_id' });
  const run = await getKeywordResearchRun(configOf(req), workspaceId, runId);
  if (!run) return res.status(404).json({ error: 'run_not_found' });
  const { search, seedOnly } = req.query;
  const result = await listKeywordResults(configOf(req), workspaceId, runId, {
    search: search ? String(search).slice(0, 200) : undefined,
    seedOnly: seedOnly === 'true',
    limit: parseInt(String(req.query.limit || '100'), 10),
    offset: parseInt(String(req.query.offset || '0'), 10),
  });
  res.json(result);
});

// ─────────────────────────────────────────────────────────────────────────
// SEO Rank Tracking — same authorization contract as Backlinks above.
// No job/scan concept: keywords are a persistent watchlist, refreshed by
// server/services/seo/rankTrackingTicker.ts on a schedule.
// ─────────────────────────────────────────────────────────────────────────

seoRouter.get('/:workspaceId/rank-tracking/limits', async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const resolved = await resolveRankTrackingLimits(configOf(req), workspaceId);
  res.json(resolved);
});

seoRouter.get('/:workspaceId/sites/:siteId/tracked-keywords', requireModule('seo_rank_tracking'), async (req, res) => {
  const { workspaceId, siteId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!isUuid(siteId)) return res.status(400).json({ error: 'invalid_site_id' });
  const limit = Math.min(parseInt(String(req.query.limit || '100'), 10) || 100, 500);
  const offset = Math.max(parseInt(String(req.query.offset || '0'), 10) || 0, 0);
  const result = await listTrackedKeywordsForSite(configOf(req), workspaceId, siteId, { limit, offset });
  res.json(result);
});

const addTrackedKeywordSchema = z.object({ siteId: z.string().uuid(), keyword: z.string().min(1).max(200), device: z.enum(['desktop', 'mobile']).optional() });

seoRouter.post('/:workspaceId/tracked-keywords', requireModule('seo_rank_tracking'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;
  const parsed = addTrackedKeywordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input', detail: parsed.error.flatten() });

  try {
    const keyword = await addTrackedKeyword(configOf(req), {
      workspaceId, siteId: parsed.data.siteId, userId: auth.userId, keyword: parsed.data.keyword, device: parsed.data.device,
    });
    res.status(201).json({ keyword });
  } catch (err) {
    if (err instanceof SiteResolutionError) return res.status(404).json({ error: err.code });
    if (err instanceof TrackedKeywordLimitError) {
      return res.status(429).json({ error: err.reason, message: err.message });
    }
    res.status(500).json({ error: 'add_tracked_keyword_failed', detail: (err as Error)?.message });
  }
});

seoRouter.delete('/:workspaceId/tracked-keywords/:keywordId', requireModule('seo_rank_tracking'), async (req, res) => {
  const { workspaceId, keywordId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;
  if (!isUuid(keywordId)) return res.status(400).json({ error: 'invalid_keyword_id' });
  const result = await removeTrackedKeyword(configOf(req), workspaceId, keywordId);
  res.json(result);
});

seoRouter.get('/:workspaceId/tracked-keywords/:keywordId/checks', requireModule('seo_rank_tracking'), async (req, res) => {
  const { workspaceId, keywordId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!isUuid(keywordId)) return res.status(400).json({ error: 'invalid_keyword_id' });
  const limit = parseInt(String(req.query.limit || '90'), 10) || 90;
  const result = await listRankChecksForKeyword(configOf(req), workspaceId, keywordId, { limit });
  res.json(result);
});

seoRouter.get('/:workspaceId/sites/:siteId/rank-tracking/overview', requireModule('seo_rank_tracking'), async (req, res) => {
  const { workspaceId, siteId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!isUuid(siteId)) return res.status(400).json({ error: 'invalid_site_id' });
  const overview = await getRankTrackingOverview(configOf(req), workspaceId, siteId);
  res.json(overview);
});

seoRouter.get('/:workspaceId/sites/:siteId/rank-tracking/landscape', requireModule('seo_rank_tracking'), async (req, res) => {
  const { workspaceId, siteId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!isUuid(siteId)) return res.status(400).json({ error: 'invalid_site_id' });
  const days = parseInt(String(req.query.days || '90'), 10) || 90;
  const result = await getRankTrackingLandscape(configOf(req), workspaceId, siteId, { days });
  res.json(result);
});

seoRouter.get('/:workspaceId/sites/:siteId/rank-tracking/competitors', requireModule('seo_rank_tracking'), async (req, res) => {
  const { workspaceId, siteId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!isUuid(siteId)) return res.status(400).json({ error: 'invalid_site_id' });
  const result = await getRankTrackingCompetitors(configOf(req), workspaceId, siteId);
  res.json(result);
});

// ─────────────────────────────────────────────────────────────────────────
// SEO Performance Auditing — same authorization contract as Backlinks
// above, but every route is scoped by crawlId (via requireCrawlInWorkspace)
// rather than siteId, since an audit runs on top of one specific crawl.
// ─────────────────────────────────────────────────────────────────────────

seoRouter.get('/:workspaceId/performance/limits', async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const resolved = await resolvePerformanceLimits(configOf(req), workspaceId);
  res.json(resolved);
});

seoRouter.get('/:workspaceId/crawls/:crawlId/performance-audits/latest', requireModule('seo_performance'), async (req, res) => {
  const { workspaceId, crawlId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!(await requireCrawlInWorkspace(req, res, workspaceId, crawlId))) return;
  const audit = await getLatestPerformanceAuditForCrawl(configOf(req), workspaceId, crawlId);
  res.json({ audit });
});

seoRouter.post('/:workspaceId/crawls/:crawlId/performance-audits', requireModule('seo_performance'), async (req, res) => {
  const { workspaceId, crawlId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;
  if (!(await requireCrawlInWorkspace(req, res, workspaceId, crawlId))) return;

  try {
    const audit = await createPerformanceAudit(configOf(req), { workspaceId, crawlId, userId: auth.userId });
    res.status(201).json({ audit });
  } catch (err) {
    if (err instanceof PerformanceAuditLimitError) {
      const status = err.reason === 'crawl_not_found' ? 404 : 429;
      return res.status(status).json({ error: err.reason, retryAfterSeconds: err.retryAfterSeconds, message: err.message });
    }
    res.status(500).json({ error: 'create_performance_audit_failed', detail: (err as Error)?.message });
  }
});

seoRouter.get('/:workspaceId/performance-audits/:auditId', requireModule('seo_performance'), async (req, res) => {
  const { workspaceId, auditId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!isUuid(auditId)) return res.status(400).json({ error: 'invalid_audit_id' });
  const audit = await getPerformanceAudit(configOf(req), workspaceId, auditId);
  if (!audit) return res.status(404).json({ error: 'audit_not_found' });
  res.json({ audit });
});

seoRouter.post('/:workspaceId/performance-audits/:auditId/cancel', requireModule('seo_performance'), async (req, res) => {
  const { workspaceId, auditId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;
  if (!isUuid(auditId)) return res.status(400).json({ error: 'invalid_audit_id' });
  const audit = await getPerformanceAudit(configOf(req), workspaceId, auditId);
  if (!audit) return res.status(404).json({ error: 'audit_not_found' });
  const result = await requestPerformanceAuditCancel(configOf(req), workspaceId, auditId);
  res.json(result);
});

seoRouter.get('/:workspaceId/performance-audits/:auditId/results', requireModule('seo_performance'), async (req, res) => {
  const { workspaceId, auditId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!isUuid(auditId)) return res.status(400).json({ error: 'invalid_audit_id' });
  const audit = await getPerformanceAudit(configOf(req), workspaceId, auditId);
  if (!audit) return res.status(404).json({ error: 'audit_not_found' });
  const results = await listPerformanceResults(configOf(req), workspaceId, auditId);
  res.json({ results });
});

// ─────────────────────────────────────────────────────────────────────────
// SEO GSC Insights — the one SEO module with no platform-level vendor
// credential: each workspace authorizes its OWN Google account via OAuth
// (server/services/seo/gsc). The consent-callback route below is the ONLY
// route in this router that is NOT workspace-scoped in its path — Google
// requires one fixed, pre-registered redirect_uri, so the workspace travels
// instead inside the signed, single-use `state` token minted by the
// /gsc/oauth/start route and verified server-side in handleGscOAuthCallback.
// ─────────────────────────────────────────────────────────────────────────

const GSC_DIMENSIONS = ['query', 'page', 'device', 'country', 'date', 'searchAppearance'] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function gscErrorStatus(code: string): number {
  switch (code) {
    case 'gsc_not_configured':
    case 'gsc_not_connected':
    case 'gsc_no_property_linked':
      return 409;
    case 'gsc_property_not_found':
      return 404;
    case 'gsc_invalid_state':
    case 'gsc_auth_failed':
    case 'gsc_token_revoked':
    case 'gsc_insufficient_scope':
      return 401;
    case 'gsc_rate_limited':
      return 429;
    case 'gsc_limit_reached':
      return 403;
    case 'gsc_timeout':
    case 'gsc_network_error':
      return 502;
    default:
      return 500;
  }
}

function sendGscError(res: any, err: unknown) {
  if (isGscError(err)) {
    return res.status(gscErrorStatus(err.code)).json({
      error: err.code,
      message: err.message,
      detail: err.detail,
      upgrade_required: err.code === 'gsc_limit_reached',
    });
  }
  res.status(500).json({ error: 'gsc_unexpected_error', detail: (err as Error)?.message });
}


seoRouter.get('/:workspaceId/gsc/limits', async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const resolved = await resolveGscLimits(configOf(req), workspaceId);
  res.json({ ...resolved, platformConfigured: isGscPlatformConfigured() });
});

seoRouter.get('/:workspaceId/gsc/connection', requireModule('seo_gsc_insights'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  try {
    const connection = await getGscConnectionInfo(configOf(req), workspaceId);
    res.json({ connection, platformConfigured: isGscPlatformConfigured() });
  } catch (err) {
    sendGscError(res, err);
  }
});

seoRouter.post('/:workspaceId/gsc/oauth/start', requireModule('seo_gsc_insights'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;
  try {
    const result = await startGscOAuth(configOf(req), workspaceId, auth.userId);
    res.json(result);
  } catch (err) {
    sendGscError(res, err);
  }
});

// NOT workspace-scoped — see file header. Never accepts a client-supplied
// workspaceId; the only source of truth is the signed `state` row.
seoRouter.get('/gsc/oauth/callback', async (req, res) => {
  const config = configOf(req);
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const appBaseUrl = await resolveAppBaseUrl(config);

  if (!code || !state) {
    return res.redirect(`${appBaseUrl}/app/seo/gsc-insights/overview?gsc=error&reason=missing_params`);
  }
  try {
    const { workspaceId } = await handleGscOAuthCallback(config, code, state);
    const sb = getServiceClient(config);
    const { data: ws } = await sb.from('workspaces').select('slug').eq('id', workspaceId).maybeSingle();
    const slug = (ws as { slug?: string } | null)?.slug;
    const base = slug ? `${appBaseUrl}/${slug}` : `${appBaseUrl}/app`;
    return res.redirect(`${base}/seo/gsc-insights/overview?gsc=connected`);
  } catch (err) {
    const code2 = isGscError(err) ? err.code : 'gsc_unexpected_error';
    // The redirect only ever carries the normalized code (never a credential
    // or raw provider payload — see google.ts's file header), so this is the
    // ONLY place an operator can see WHY a connection attempt failed instead
    // of the user's generic, localized "authentication failed" toast.
    console.error(`[gsc] oauth callback failed: ${code2}${isGscError(err) ? '' : ` (${(err as Error)?.message || 'no message'})`}`);
    return res.redirect(`${appBaseUrl}/app/seo/gsc-insights/overview?gsc=error&reason=${encodeURIComponent(code2)}`);
  }
});

seoRouter.post('/:workspaceId/gsc/disconnect', requireModule('seo_gsc_insights'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;
  try {
    await disconnectGsc(configOf(req), workspaceId);
    res.json({ ok: true });
  } catch (err) {
    sendGscError(res, err);
  }
});

seoRouter.get('/:workspaceId/gsc/properties', requireModule('seo_gsc_insights'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  try {
    const properties = await listGscProperties(configOf(req), workspaceId);
    res.json({ properties });
  } catch (err) {
    sendGscError(res, err);
  }
});

seoRouter.get('/:workspaceId/gsc/available-sites', requireModule('seo_gsc_insights'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  try {
    const sites = await discoverAvailableSites(configOf(req), workspaceId);
    res.json({ sites });
  } catch (err) {
    sendGscError(res, err);
  }
});

seoRouter.post('/:workspaceId/gsc/properties', requireModule('seo_gsc_insights'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;
  const siteUrl = typeof req.body?.siteUrl === 'string' ? req.body.siteUrl.trim() : '';
  const websiteId = isUuid(req.body?.websiteId) ? req.body.websiteId : null;
  if (!siteUrl) return res.status(400).json({ error: 'invalid_site_url' });
  try {
    const property = await linkGscProperty(configOf(req), workspaceId, siteUrl, websiteId);
    res.status(201).json({ property });
  } catch (err) {
    sendGscError(res, err);
  }
});

seoRouter.delete('/:workspaceId/gsc/properties/:propertyId', requireModule('seo_gsc_insights'), async (req, res) => {
  const { workspaceId, propertyId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;
  if (!isUuid(propertyId)) return res.status(400).json({ error: 'invalid_property_id' });
  try {
    await unlinkGscProperty(configOf(req), workspaceId, propertyId);
    res.json({ ok: true });
  } catch (err) {
    sendGscError(res, err);
  }
});

seoRouter.post('/:workspaceId/gsc/properties/:propertyId/primary', requireModule('seo_gsc_insights'), async (req, res) => {
  const { workspaceId, propertyId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;
  if (!isUuid(propertyId)) return res.status(400).json({ error: 'invalid_property_id' });
  try {
    await setPrimaryGscProperty(configOf(req), workspaceId, propertyId);
    res.json({ ok: true });
  } catch (err) {
    sendGscError(res, err);
  }
});

seoRouter.post('/:workspaceId/gsc/properties/:propertyId/search-analytics', requireModule('seo_gsc_insights'), async (req, res) => {
  const { workspaceId, propertyId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!isUuid(propertyId)) return res.status(400).json({ error: 'invalid_property_id' });

  const startDate = typeof req.body?.startDate === 'string' ? req.body.startDate : '';
  const endDate = typeof req.body?.endDate === 'string' ? req.body.endDate : '';
  const dimensionsRaw = Array.isArray(req.body?.dimensions) ? req.body.dimensions : [];
  const dimensions = dimensionsRaw.filter((d: unknown): d is GscDimension => (GSC_DIMENSIONS as readonly string[]).includes(d as string));
  const rowLimit = Number.isFinite(req.body?.rowLimit) ? Math.min(Math.max(Number(req.body.rowLimit), 1), 5000) : undefined;
  const forceRefresh = req.body?.forceRefresh === true;

  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate) || dimensions.length === 0) {
    return res.status(400).json({ error: 'invalid_query_params' });
  }

  try {
    const result = await querySearchAnalytics(configOf(req), workspaceId, propertyId, { startDate, endDate, dimensions, rowLimit }, { forceRefresh });
    res.json(result);
  } catch (err) {
    sendGscError(res, err);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// SEO Site Explorer — arbitrary/competitor-domain lookups. Deliberately
// NOT scoped by siteId: every route below takes a raw `domain` string
// (query param on reads, body field on writes) instead of resolving a
// workspace_domains row, since the whole point is to work on domains the
// workspace never registered.
// ─────────────────────────────────────────────────────────────────────────

function sendExplorerScanError(res: any, err: unknown) {
  if (err instanceof ExplorerScanLimitError) {
    const status = err.reason === 'invalid_domain' ? 400 : err.reason === 'module_not_available' ? 403 : 429;
    return res.status(status).json({
      error: err.reason,
      message: err.message,
      retryAfterSeconds: err.retryAfterSeconds,
      upgrade_required: err.reason === 'module_not_available',
    });
  }
  res.status(500).json({ error: 'explorer_scan_failed', detail: (err as Error)?.message });
}

seoRouter.get('/:workspaceId/explorer/limits', async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const resolved = await resolveExplorerLimits(configOf(req), workspaceId);
  res.json(resolved);
});

seoRouter.get('/:workspaceId/explorer/history', requireModule('seo_site_explorer'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const history = await listExplorerHistory(configOf(req), workspaceId);
  res.json({ history });
});

// ── Backlinks by domain ──
seoRouter.get('/:workspaceId/explorer/backlink-scans/latest', requireModule('seo_site_explorer'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const domain = typeof req.query.domain === 'string' ? req.query.domain : '';
  if (!domain) return res.status(400).json({ error: 'missing_domain' });
  const scan = await getLatestExplorerBacklinkScanForDomain(configOf(req), workspaceId, domain);
  res.json({ scan });
});

seoRouter.post('/:workspaceId/explorer/backlink-scans', requireModule('seo_site_explorer'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;
  const domain = typeof req.body?.domain === 'string' ? req.body.domain.trim() : '';
  if (!domain) return res.status(400).json({ error: 'missing_domain' });
  try {
    const scan = await createExplorerBacklinkScan(configOf(req), { workspaceId, domain, userId: auth.userId });
    res.status(201).json({ scan });
  } catch (err) {
    sendExplorerScanError(res, err);
  }
});

seoRouter.get('/:workspaceId/explorer/backlink-scans/:scanId', requireModule('seo_site_explorer'), async (req, res) => {
  const { workspaceId, scanId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!isUuid(scanId)) return res.status(400).json({ error: 'invalid_scan_id' });
  const scan = await getExplorerBacklinkScan(configOf(req), workspaceId, scanId);
  if (!scan) return res.status(404).json({ error: 'scan_not_found' });
  res.json({ scan });
});

seoRouter.post('/:workspaceId/explorer/backlink-scans/:scanId/cancel', requireModule('seo_site_explorer'), async (req, res) => {
  const { workspaceId, scanId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;
  if (!isUuid(scanId)) return res.status(400).json({ error: 'invalid_scan_id' });
  const scan = await getExplorerBacklinkScan(configOf(req), workspaceId, scanId);
  if (!scan) return res.status(404).json({ error: 'scan_not_found' });
  const result = await requestExplorerBacklinkScanCancel(configOf(req), workspaceId, scanId);
  res.json(result);
});

seoRouter.get('/:workspaceId/explorer/backlink-scans/:scanId/backlinks', requireModule('seo_site_explorer'), async (req, res) => {
  const { workspaceId, scanId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!isUuid(scanId)) return res.status(400).json({ error: 'invalid_scan_id' });
  const scan = await getExplorerBacklinkScan(configOf(req), workspaceId, scanId);
  if (!scan) return res.status(404).json({ error: 'scan_not_found' });
  const { dofollowOnly, isNew, search, limit, offset } = req.query as Record<string, string | undefined>;
  const result = await listExplorerBacklinks(configOf(req), workspaceId, scanId, {
    dofollowOnly: dofollowOnly === 'true',
    isNew: isNew === undefined ? undefined : isNew === 'true',
    search,
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined,
  });
  res.json(result);
});

seoRouter.get('/:workspaceId/explorer/backlink-scans/:scanId/referring-domains', requireModule('seo_site_explorer'), async (req, res) => {
  const { workspaceId, scanId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!isUuid(scanId)) return res.status(400).json({ error: 'invalid_scan_id' });
  const scan = await getExplorerBacklinkScan(configOf(req), workspaceId, scanId);
  if (!scan) return res.status(404).json({ error: 'scan_not_found' });
  const { limit, offset } = req.query as Record<string, string | undefined>;
  const result = await listExplorerReferringDomains(configOf(req), workspaceId, scanId, {
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined,
  });
  res.json(result);
});

seoRouter.get('/:workspaceId/explorer/backlink-scans/:scanId/top-pages', requireModule('seo_site_explorer'), async (req, res) => {
  const { workspaceId, scanId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!isUuid(scanId)) return res.status(400).json({ error: 'invalid_scan_id' });
  const scan = await getExplorerBacklinkScan(configOf(req), workspaceId, scanId);
  if (!scan) return res.status(404).json({ error: 'scan_not_found' });
  const { limit, offset } = req.query as Record<string, string | undefined>;
  const result = await listExplorerTopPages(configOf(req), workspaceId, scanId, {
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined,
  });
  res.json(result);
});

// ── Organic keywords by domain ──
seoRouter.get('/:workspaceId/explorer/keyword-scans/latest', requireModule('seo_site_explorer'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const domain = typeof req.query.domain === 'string' ? req.query.domain : '';
  if (!domain) return res.status(400).json({ error: 'missing_domain' });
  const scan = await getLatestExplorerKeywordScanForDomain(configOf(req), workspaceId, domain);
  res.json({ scan });
});

seoRouter.post('/:workspaceId/explorer/keyword-scans', requireModule('seo_site_explorer'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;
  const domain = typeof req.body?.domain === 'string' ? req.body.domain.trim() : '';
  if (!domain) return res.status(400).json({ error: 'missing_domain' });
  try {
    const scan = await createExplorerKeywordScan(configOf(req), { workspaceId, domain, userId: auth.userId });
    res.status(201).json({ scan });
  } catch (err) {
    sendExplorerScanError(res, err);
  }
});

seoRouter.get('/:workspaceId/explorer/keyword-scans/:scanId', requireModule('seo_site_explorer'), async (req, res) => {
  const { workspaceId, scanId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!isUuid(scanId)) return res.status(400).json({ error: 'invalid_scan_id' });
  const scan = await getExplorerKeywordScan(configOf(req), workspaceId, scanId);
  if (!scan) return res.status(404).json({ error: 'scan_not_found' });
  res.json({ scan });
});

seoRouter.post('/:workspaceId/explorer/keyword-scans/:scanId/cancel', requireModule('seo_site_explorer'), async (req, res) => {
  const { workspaceId, scanId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;
  if (!isUuid(scanId)) return res.status(400).json({ error: 'invalid_scan_id' });
  const scan = await getExplorerKeywordScan(configOf(req), workspaceId, scanId);
  if (!scan) return res.status(404).json({ error: 'scan_not_found' });
  const result = await requestExplorerKeywordScanCancel(configOf(req), workspaceId, scanId);
  res.json(result);
});

seoRouter.get('/:workspaceId/explorer/keyword-scans/:scanId/keywords', requireModule('seo_site_explorer'), async (req, res) => {
  const { workspaceId, scanId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!isUuid(scanId)) return res.status(400).json({ error: 'invalid_scan_id' });
  const scan = await getExplorerKeywordScan(configOf(req), workspaceId, scanId);
  if (!scan) return res.status(404).json({ error: 'scan_not_found' });
  const { search, limit, offset } = req.query as Record<string, string | undefined>;
  const result = await listExplorerKeywords(configOf(req), workspaceId, scanId, {
    search,
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined,
  });
  res.json(result);
});

// ── Competing domains ──
seoRouter.get('/:workspaceId/explorer/competitor-scans/latest', requireModule('seo_site_explorer'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  const domain = typeof req.query.domain === 'string' ? req.query.domain : '';
  if (!domain) return res.status(400).json({ error: 'missing_domain' });
  const scan = await getLatestExplorerCompetitorScanForDomain(configOf(req), workspaceId, domain);
  res.json({ scan });
});

seoRouter.post('/:workspaceId/explorer/competitor-scans', requireModule('seo_site_explorer'), async (req, res) => {
  const { workspaceId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;
  const domain = typeof req.body?.domain === 'string' ? req.body.domain.trim() : '';
  if (!domain) return res.status(400).json({ error: 'missing_domain' });
  try {
    const scan = await createExplorerCompetitorScan(configOf(req), { workspaceId, domain, userId: auth.userId });
    res.status(201).json({ scan });
  } catch (err) {
    sendExplorerScanError(res, err);
  }
});

seoRouter.get('/:workspaceId/explorer/competitor-scans/:scanId', requireModule('seo_site_explorer'), async (req, res) => {
  const { workspaceId, scanId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!isUuid(scanId)) return res.status(400).json({ error: 'invalid_scan_id' });
  const scan = await getExplorerCompetitorScan(configOf(req), workspaceId, scanId);
  if (!scan) return res.status(404).json({ error: 'scan_not_found' });
  res.json({ scan });
});

seoRouter.post('/:workspaceId/explorer/competitor-scans/:scanId/cancel', requireModule('seo_site_explorer'), async (req, res) => {
  const { workspaceId, scanId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;
  if (!isUuid(scanId)) return res.status(400).json({ error: 'invalid_scan_id' });
  const scan = await getExplorerCompetitorScan(configOf(req), workspaceId, scanId);
  if (!scan) return res.status(404).json({ error: 'scan_not_found' });
  const result = await requestExplorerCompetitorScanCancel(configOf(req), workspaceId, scanId);
  res.json(result);
});

seoRouter.get('/:workspaceId/explorer/competitor-scans/:scanId/competitors', requireModule('seo_site_explorer'), async (req, res) => {
  const { workspaceId, scanId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;
  if (!isUuid(scanId)) return res.status(400).json({ error: 'invalid_scan_id' });
  const scan = await getExplorerCompetitorScan(configOf(req), workspaceId, scanId);
  if (!scan) return res.status(404).json({ error: 'scan_not_found' });
  const { limit, offset } = req.query as Record<string, string | undefined>;
  const result = await listExplorerCompetitors(configOf(req), workspaceId, scanId, {
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined,
  });
  res.json(result);
});
