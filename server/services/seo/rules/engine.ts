/**
 * Rules engine driver — loads normalized crawl data through the canonical SEO
 * repository (never straight off `seo_pages`/`seo_links`), builds the pure
 * `RuleContext`, runs every rule in checks.ts, and persists the resulting
 * `seo_issues`/`seo_issue_pages` rows. This is the ONLY place that writes to
 * those tables, and issue rows now carry the canonical `url_id`; the legacy
 * `page_id` column stays nullable for pre-cutover history only.
 */
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { getCrawlLinks, getCrawlPages } from '../canonicalRepository.js';
import { runAllRules } from './checks.js';
import type { RawIssue, RuleContext, SeoLinkForRules, SeoPageForRules, SeoSitemapForRules } from './types.js';

/** The snake_case page record shape the observation payload preserves. */
type LegacyPageRecord = {
  [K in keyof SeoPageForRules]: SeoPageForRules[K];
} & {
  id: string;
  url_id: string;
  normalized_url: string;
  http_status: number;
  redirect_chain: { url: string; status: number }[] | null;
  title_length: number;
  meta_description: string;
  meta_description_length: number;
  canonical_url: string;
  canonical_status: SeoPageForRules['canonicalStatus'];
  meta_robots: string;
  is_indexable: boolean;
  h1_count: number;
  h2_count: number;
  word_count: number;
  images_count: number;
  images_missing_alt_count: number;
  has_structured_data: boolean;
  structured_data_errors: string[] | null;
  has_open_graph: boolean;
  has_twitter_card: boolean;
  is_https: boolean;
  has_mixed_content: boolean;
  is_nofollow: boolean;
  discovered_via: string;
  incoming_internal_links_count: number;
  fetch_error: string;
  response_time_ms: number;
};

const ISSUE_PAGE_INSERT_CHUNK = 500;
const MAX_AFFECTED_URLS_STORED = 5000;

async function fetchAllPages(config: ServerConfig, crawlId: string): Promise<(SeoPageForRules & { urlId: string })[]> {
  const out: (SeoPageForRules & { urlId: string })[] = [];
  const canonical = await getCrawlPages(config, crawlId);
  {
    const data = canonical.map((entry) => ({ ...entry.page, id: entry.legacyPageId, url_id: entry.urlId, url: entry.url, normalized_url: entry.normalizedUrl }));
    for (const row of data as unknown as LegacyPageRecord[]) {
      out.push({
        urlId: row.url_id || '',
        id: row.id,
        url: row.url,
        normalizedUrl: row.normalized_url,
        httpStatus: row.http_status,
        redirectChain: row.redirect_chain || [],
        title: row.title,
        titleLength: row.title_length,
        metaDescription: row.meta_description,
        metaDescriptionLength: row.meta_description_length,
        canonicalUrl: row.canonical_url,
        canonicalStatus: row.canonical_status,
        metaRobots: row.meta_robots,
        isIndexable: row.is_indexable,
        h1: row.h1,
        h1Count: row.h1_count,
        h2Count: row.h2_count,
        lang: row.lang,
        wordCount: row.word_count,
        imagesCount: row.images_count,
        imagesMissingAltCount: row.images_missing_alt_count,
        hasStructuredData: row.has_structured_data,
        structuredDataErrors: row.structured_data_errors || [],
        hasOpenGraph: row.has_open_graph,
        hasTwitterCard: row.has_twitter_card,
        isHttps: row.is_https,
        hasMixedContent: row.has_mixed_content,
        isNofollow: row.is_nofollow,
        discoveredVia: row.discovered_via,
        incomingInternalLinksCount: row.incoming_internal_links_count,
        fetchError: row.fetch_error,
        responseTimeMs: row.response_time_ms,
      });
    }
  }
  return out;
}

async function fetchAllLinks(
  config: ServerConfig,
  args: { crawlId: string; workspaceId: string; siteId: string },
): Promise<SeoLinkForRules[]> {
  const edges = await getCrawlLinks(config, args);
  return edges.map((e) => ({
    sourceUrl: e.sourceUrl,
    targetUrl: e.targetUrl,
    isExternal: e.isExternal,
    isBroken: e.isBroken,
    httpStatus: e.httpStatus,
  }));
}

async function fetchSitemaps(sb: ReturnType<typeof getServiceClient>, crawlId: string): Promise<SeoSitemapForRules[]> {
  const { data } = await sb.from('seo_sitemaps').select('url, status, error_message').eq('crawl_id', crawlId);
  return ((data || []) as Record<string, unknown>[]).map((r) => ({ url: r.url as string, status: r.status as string, errorMessage: (r.error_message as string | null) ?? null }));
}

async function previousIssueTypes(sb: ReturnType<typeof getServiceClient>, workspaceId: string, websiteId: string, crawlId: string, crawlCreatedAt: string): Promise<Set<string>> {
  const { data: prev } = await sb
    .from('seo_crawls')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('website_id', websiteId)
    .eq('status', 'completed')
    .lt('created_at', crawlCreatedAt)
    .neq('id', crawlId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!prev) return new Set();
  const { data: issues } = await sb.from('seo_issues').select('issue_type').eq('crawl_id', (prev as { id: string }).id);
  return new Set(((issues || []) as { issue_type: string }[]).map((i) => i.issue_type));
}

export interface EvaluateResult {
  issueCount: number;
  totalPages: number;
  scoreInputIssues: { issueType: string; category: string; severity: string; title: string; affectedCount: number }[];
}

export async function evaluateAndPersistIssues(
  config: ServerConfig,
  args: { crawlId: string; workspaceId: string; websiteId: string; crawlCreatedAt: string; sitemapSampleUrls: string[]; crawledButMissingFromSitemapCount: number; sitemapUrlsNotCrawledCount: number },
): Promise<EvaluateResult> {
  const sb = getServiceClient(config);

  const [pages, links, sitemaps, prevTypes] = await Promise.all([
    fetchAllPages(config, args.crawlId),
    fetchAllLinks(config, { crawlId: args.crawlId, workspaceId: args.workspaceId, siteId: args.websiteId }),
    fetchSitemaps(sb, args.crawlId),
    previousIssueTypes(sb, args.workspaceId, args.websiteId, args.crawlId, args.crawlCreatedAt),
  ]);

  const ctx: RuleContext = {
    pages,
    links,
    sitemaps,
    sitemapUrls: args.sitemapSampleUrls,
    crawledButMissingFromSitemapCount: args.crawledButMissingFromSitemapCount,
    sitemapUrlsNotCrawledCount: args.sitemapUrlsNotCrawledCount,
  };

  const rawIssues: RawIssue[] = runAllRules(ctx);
  const now = new Date().toISOString();

  for (const raw of rawIssues) {
    const status = prevTypes.has(raw.issueType) ? 'persistent' : 'new';
    const { data: inserted, error } = await sb
      .from('seo_issues')
      .insert({
        crawl_id: args.crawlId,
        workspace_id: args.workspaceId,
        website_id: args.websiteId,
        issue_type: raw.issueType,
        category: raw.category,
        severity: raw.severity,
        title: raw.title,
        description: raw.description,
        recommendation: raw.recommendation,
        affected_count: raw.affectedUrls.length,
        status,
        first_detected_at: now,
        last_detected_at: now,
      })
      .select('id')
      .single();
    if (error || !inserted) continue;
    const issueId = (inserted as { id: string }).id;

    // Canonical identity is authoritative; legacy page_id only survives when a
    // legacy row still exists (pre-cutover crawls / SEO_LEGACY_WRITES=true).
    const byUrl = new Map(pages.map((p) => [p.url, p]));
    const urlRows = raw.affectedUrls.slice(0, MAX_AFFECTED_URLS_STORED).map((url) => ({
      issue_id: issueId,
      page_id: byUrl.get(url)?.id || null,
      url_id: byUrl.get(url)?.urlId || null,
      url,
    }));
    for (let i = 0; i < urlRows.length; i += ISSUE_PAGE_INSERT_CHUNK) {
      await sb.from('seo_issue_pages').insert(urlRows.slice(i, i + ISSUE_PAGE_INSERT_CHUNK));
    }
  }

  return {
    issueCount: rawIssues.length,
    totalPages: pages.length,
    scoreInputIssues: rawIssues.map((i) => ({ issueType: i.issueType, category: i.category, severity: i.severity, title: i.title, affectedCount: i.affectedUrls.length })),
  };
}
