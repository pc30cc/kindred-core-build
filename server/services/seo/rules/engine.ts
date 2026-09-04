/**
 * Rules engine driver — loads normalized crawl data from the database,
 * builds the pure `RuleContext`, runs every rule in checks.ts, and persists
 * the resulting `seo_issues`/`seo_issue_pages` rows. This is the ONLY place
 * that writes to those tables.
 */
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { runAllRules } from './checks.js';
import type { RawIssue, RuleContext, SeoLinkForRules, SeoPageForRules, SeoSitemapForRules } from './types.js';

const FETCH_CHUNK = 1000;
const ISSUE_PAGE_INSERT_CHUNK = 500;
const MAX_AFFECTED_URLS_STORED = 5000;

async function fetchAllPages(sb: ReturnType<typeof getServiceClient>, crawlId: string): Promise<SeoPageForRules[]> {
  const out: SeoPageForRules[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await sb
      .from('seo_pages')
      .select('id, url, normalized_url, http_status, redirect_chain, title, title_length, meta_description, meta_description_length, canonical_url, canonical_status, meta_robots, is_indexable, h1_count, h2_count, lang, word_count, images_count, images_missing_alt_count, has_structured_data, structured_data_errors, is_https, has_mixed_content, fetch_error, response_time_ms')
      .eq('crawl_id', crawlId)
      .range(from, from + FETCH_CHUNK - 1);
    if (error || !data || data.length === 0) break;
    for (const row of data as any[]) {
      out.push({
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
        h1Count: row.h1_count,
        h2Count: row.h2_count,
        lang: row.lang,
        wordCount: row.word_count,
        imagesCount: row.images_count,
        imagesMissingAltCount: row.images_missing_alt_count,
        hasStructuredData: row.has_structured_data,
        structuredDataErrors: row.structured_data_errors || [],
        isHttps: row.is_https,
        hasMixedContent: row.has_mixed_content,
        fetchError: row.fetch_error,
        responseTimeMs: row.response_time_ms,
      });
    }
    if (data.length < FETCH_CHUNK) break;
    from += FETCH_CHUNK;
  }
  return out;
}

async function fetchAllLinks(sb: ReturnType<typeof getServiceClient>, crawlId: string): Promise<SeoLinkForRules[]> {
  const out: SeoLinkForRules[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await sb
      .from('seo_links')
      .select('target_url, is_external, is_broken, http_status, source_page:source_page_id(url)')
      .eq('crawl_id', crawlId)
      .range(from, from + FETCH_CHUNK - 1);
    if (error || !data || data.length === 0) break;
    for (const row of data as any[]) {
      out.push({
        sourceUrl: row.source_page?.url || '',
        targetUrl: row.target_url,
        isExternal: row.is_external,
        isBroken: row.is_broken,
        httpStatus: row.http_status,
      });
    }
    if (data.length < FETCH_CHUNK) break;
    from += FETCH_CHUNK;
  }
  return out;
}

async function fetchSitemaps(sb: ReturnType<typeof getServiceClient>, crawlId: string): Promise<SeoSitemapForRules[]> {
  const { data } = await sb.from('seo_sitemaps').select('url, status, error_message').eq('crawl_id', crawlId);
  return ((data || []) as any[]).map((r) => ({ url: r.url, status: r.status, errorMessage: r.error_message }));
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
    fetchAllPages(sb, args.crawlId),
    fetchAllLinks(sb, args.crawlId),
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

    const pageByUrl = new Map(pages.map((p) => [p.url, p.id]));
    const urlRows = raw.affectedUrls.slice(0, MAX_AFFECTED_URLS_STORED).map((url) => ({
      issue_id: issueId,
      page_id: pageByUrl.get(url) || null,
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
