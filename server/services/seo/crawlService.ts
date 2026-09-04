/**
 * SEO crawl — business logic. Owns `seo_crawls` and every table that hangs
 * off it; the generic `background_jobs` row (server/services/jobs/queue.ts)
 * only ever carries `{ siteId }` in its payload — everything else the SEO
 * worker needs lives in the `seo_crawls` row this module creates.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { enqueueJob, requestJobCancel, cancelQueuedJob, getJob } from '../jobs/queue.js';
import { resolveWorkspaceSite, SiteResolutionError } from './siteResolver.js';
import {
  resolveSeoLimits,
  countActiveWorkspaceCrawls,
  countActiveSiteCrawls,
  getMostRecentCrawlStart,
} from './limits.js';

export const SEO_CRAWLER_USER_AGENT = process.env.SEO_CRAWLER_USER_AGENT || 'KindredSeoBot/1.0 (+self-hosted)';

export type CrawlLimitReason = 'workspace_concurrency_limit' | 'site_concurrency_limit' | 'frequency_limit';

export class CrawlLimitError extends Error {
  reason: CrawlLimitReason;
  retryAfterSeconds?: number;
  constructor(reason: CrawlLimitReason, message: string, retryAfterSeconds?: number) {
    super(message);
    this.reason = reason;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface SeoCrawlRow {
  id: string;
  job_id: string;
  workspace_id: string;
  website_id: string;
  canonical_url: string;
  user_agent: string;
  respect_robots: boolean;
  limits: Record<string, unknown>;
  status: string;
  progress: number;
  progress_stage: string | null;
  pages_discovered: number;
  pages_crawled: number;
  pages_failed: number;
  pages_skipped: number;
  score: number | null;
  score_version: string | null;
  score_breakdown: unknown;
  robots_summary: unknown;
  sitemap_summary: unknown;
  cancel_requested: boolean;
  error_message: string | null;
  error_category: string | null;
  created_by: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Creates a new SEO crawl. Every authorization-relevant fact — that the site
 * belongs to this workspace, and the canonical URL to crawl — is derived
 * server-side via `resolveWorkspaceSite`; the caller supplies only
 * `siteId`, never a URL.
 */
export async function createCrawl(
  config: ServerConfig,
  args: { workspaceId: string; siteId: string; userId: string },
): Promise<SeoCrawlRow> {
  const site = await resolveWorkspaceSite(config, args.workspaceId, args.siteId);
  const { limits } = await resolveSeoLimits(config, args.workspaceId);

  const [workspaceActive, siteActive] = await Promise.all([
    countActiveWorkspaceCrawls(config, args.workspaceId),
    countActiveSiteCrawls(config, site.id),
  ]);
  if (workspaceActive >= limits.seo_workspace_concurrent_jobs) {
    throw new CrawlLimitError('workspace_concurrency_limit', 'Workspace has reached its concurrent SEO crawl limit');
  }
  if (siteActive >= limits.seo_site_concurrent_jobs) {
    throw new CrawlLimitError('site_concurrency_limit', 'This site already has a crawl in progress');
  }

  const lastStart = await getMostRecentCrawlStart(config, site.id);
  if (lastStart) {
    const elapsedHours = (Date.now() - new Date(lastStart).getTime()) / 3_600_000;
    if (elapsedHours < limits.seo_crawl_frequency_hours) {
      const retryAfterSeconds = Math.max(0, Math.round((limits.seo_crawl_frequency_hours - elapsedHours) * 3600));
      throw new CrawlLimitError('frequency_limit', 'This site was audited too recently', retryAfterSeconds);
    }
  }

  const job = await enqueueJob(config, {
    workspaceId: args.workspaceId,
    jobType: 'seo_crawl',
    subjectType: 'seo_site',
    subjectId: site.id,
    createdBy: args.userId,
    payload: { siteId: site.id },
  });

  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('seo_crawls')
    .insert({
      job_id: job.id,
      workspace_id: args.workspaceId,
      website_id: site.id,
      canonical_url: site.canonicalUrl,
      user_agent: SEO_CRAWLER_USER_AGENT,
      respect_robots: true,
      limits,
      created_by: args.userId,
    })
    .select('*')
    .single();
  if (error || !data) throw new Error(`create_crawl_failed: ${error?.message}`);
  return data as SeoCrawlRow;
}

export async function getCrawl(config: ServerConfig, workspaceId: string, crawlId: string): Promise<SeoCrawlRow | null> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('seo_crawls')
    .select('*')
    .eq('id', crawlId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  return (data as SeoCrawlRow | null) ?? null;
}

export async function getLatestCrawlForSite(config: ServerConfig, workspaceId: string, siteId: string): Promise<SeoCrawlRow | null> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('seo_crawls')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('website_id', siteId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as SeoCrawlRow | null) ?? null;
}

export async function listCrawlsForSite(
  config: ServerConfig,
  workspaceId: string,
  siteId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ crawls: SeoCrawlRow[]; total: number }> {
  const sb = getServiceClient(config);
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const { data, count, error } = await sb
    .from('seo_crawls')
    .select('*', { count: 'exact' })
    .eq('workspace_id', workspaceId)
    .eq('website_id', siteId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw new Error(`list_crawls_failed: ${error.message}`);
  return { crawls: (data || []) as SeoCrawlRow[], total: count || 0 };
}

/** Cooperative cancel: flags both the seo_crawls row and its underlying job. */
export async function requestCrawlCancel(config: ServerConfig, workspaceId: string, crawlId: string): Promise<{ ok: boolean }> {
  const crawl = await getCrawl(config, workspaceId, crawlId);
  if (!crawl) return { ok: false };
  const sb = getServiceClient(config);
  await sb.from('seo_crawls').update({ cancel_requested: true }).eq('id', crawlId).in('status', ['queued', 'running', 'processing']);
  await requestJobCancel(config, crawl.job_id);
  await cancelQueuedJob(config, crawl.job_id);
  const job = await getJob(config, crawl.job_id);
  if (job && job.status === 'cancelled') {
    await sb
      .from('seo_crawls')
      .update({ status: 'cancelled', finished_at: new Date().toISOString() })
      .eq('id', crawlId)
      .in('status', ['queued', 'running', 'processing']);
  }
  return { ok: true };
}

export interface PageListFilters {
  httpStatusClass?: '2xx' | '3xx' | '4xx' | '5xx';
  indexable?: boolean;
  hasIssues?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

export async function listCrawlPages(config: ServerConfig, workspaceId: string, crawlId: string, filters: PageListFilters = {}) {
  const sb = getServiceClient(config);
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);
  let query = sb
    .from('seo_pages')
    .select('*', { count: 'exact' })
    .eq('workspace_id', workspaceId)
    .eq('crawl_id', crawlId);

  if (filters.httpStatusClass) {
    const base = { '2xx': 200, '3xx': 300, '4xx': 400, '5xx': 500 }[filters.httpStatusClass];
    query = query.gte('http_status', base).lt('http_status', base + 100);
  }
  if (typeof filters.indexable === 'boolean') query = query.eq('is_indexable', filters.indexable);
  if (filters.search) query = query.ilike('url', `%${filters.search}%`);

  const { data, count, error } = await query.order('depth', { ascending: true }).range(offset, offset + limit - 1);
  if (error) throw new Error(`list_pages_failed: ${error.message}`);
  return { pages: data || [], total: count || 0 };
}

export interface IssueListFilters {
  severity?: string;
  category?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export async function listCrawlIssues(config: ServerConfig, workspaceId: string, crawlId: string, filters: IssueListFilters = {}) {
  const sb = getServiceClient(config);
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);
  let query = sb
    .from('seo_issues')
    .select('*', { count: 'exact' })
    .eq('workspace_id', workspaceId)
    .eq('crawl_id', crawlId);
  if (filters.severity) query = query.eq('severity', filters.severity);
  if (filters.category) query = query.eq('category', filters.category);
  if (filters.status) query = query.eq('status', filters.status);

  const { data, count, error } = await query.order('severity', { ascending: true }).order('affected_count', { ascending: false }).range(offset, offset + limit - 1);
  if (error) throw new Error(`list_issues_failed: ${error.message}`);
  return { issues: data || [], total: count || 0 };
}

export async function getIssueAffectedUrls(config: ServerConfig, workspaceId: string, crawlId: string, issueId: string, opts: { limit?: number; offset?: number } = {}) {
  const sb = getServiceClient(config);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const { data: issue } = await sb.from('seo_issues').select('id').eq('id', issueId).eq('crawl_id', crawlId).eq('workspace_id', workspaceId).maybeSingle();
  if (!issue) return { urls: [], total: 0 };
  const { data, count, error } = await sb
    .from('seo_issue_pages')
    .select('url, page_id', { count: 'exact' })
    .eq('issue_id', issueId)
    .range(offset, offset + limit - 1);
  if (error) throw new Error(`list_issue_pages_failed: ${error.message}`);
  return { urls: data || [], total: count || 0 };
}

export async function listCrawlLinks(config: ServerConfig, workspaceId: string, crawlId: string, opts: { external?: boolean; brokenOnly?: boolean; limit?: number; offset?: number } = {}) {
  const sb = getServiceClient(config);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  let query = sb
    .from('seo_links')
    .select('*, source_page:source_page_id(url)', { count: 'exact' })
    .eq('workspace_id', workspaceId)
    .eq('crawl_id', crawlId);
  if (typeof opts.external === 'boolean') query = query.eq('is_external', opts.external);
  if (opts.brokenOnly) query = query.eq('is_broken', true);
  const { data, count, error } = await query.range(offset, offset + limit - 1);
  if (error) throw new Error(`list_links_failed: ${error.message}`);
  return { links: data || [], total: count || 0 };
}

export async function listCrawlSitemaps(config: ServerConfig, workspaceId: string, crawlId: string) {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('seo_sitemaps')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('crawl_id', crawlId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`list_sitemaps_failed: ${error.message}`);
  return data || [];
}

/**
 * Compares this crawl's issues against the immediately previous COMPLETED
 * crawl for the same site: new issues (not seen last time), resolved issues
 * (seen last time, absent now), and persistent issues (seen both times).
 */
export async function compareWithPreviousCrawl(config: ServerConfig, workspaceId: string, crawlId: string) {
  const sb = getServiceClient(config);
  const { data: crawl } = await sb.from('seo_crawls').select('id, website_id, created_at').eq('id', crawlId).eq('workspace_id', workspaceId).maybeSingle();
  if (!crawl) return null;
  const current = crawl as { id: string; website_id: string; created_at: string };

  const { data: prevCrawl } = await sb
    .from('seo_crawls')
    .select('id, created_at, score')
    .eq('workspace_id', workspaceId)
    .eq('website_id', current.website_id)
    .eq('status', 'completed')
    .lt('created_at', current.created_at)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!prevCrawl) return { hasPrevious: false, newIssues: [], resolvedIssues: [], persistentIssues: [] };
  const prev = prevCrawl as { id: string; created_at: string; score: number | null };

  const [{ data: currentIssues }, { data: prevIssues }] = await Promise.all([
    sb.from('seo_issues').select('issue_type, category, severity, title, affected_count').eq('crawl_id', crawlId),
    sb.from('seo_issues').select('issue_type, category, severity, title, affected_count').eq('crawl_id', prev.id),
  ]);

  const currentTypes = new Set((currentIssues || []).map((i: any) => i.issue_type));
  const prevTypes = new Set((prevIssues || []).map((i: any) => i.issue_type));

  const newIssues = (currentIssues || []).filter((i: any) => !prevTypes.has(i.issue_type));
  const resolvedIssues = (prevIssues || []).filter((i: any) => !currentTypes.has(i.issue_type));
  const persistentIssues = (currentIssues || []).filter((i: any) => prevTypes.has(i.issue_type));

  return {
    hasPrevious: true,
    previousCrawlId: prev.id,
    previousCrawledAt: prev.created_at,
    previousScore: prev.score,
    newIssues,
    resolvedIssues,
    persistentIssues,
  };
}

export { SiteResolutionError };
