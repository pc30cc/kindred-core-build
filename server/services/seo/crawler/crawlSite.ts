/**
 * SEO crawl orchestrator — BFS over ONE registered site, same-domain only.
 *
 * Authorization boundary (defense in depth — the caller already resolved
 * `canonicalUrl`/`canonicalHost` server-side via siteResolver.ts, but this
 * function re-checks on every single URL before ever fetching it):
 *   - `isSameDomain(url, canonicalHost)` gates every page fetch AND every
 *     enqueue. `admin.example.com` is NOT the same host as `example.com`
 *     (see urlRules.ts's exact-host-after-www-strip semantics) — a
 *     registered root domain never authorizes crawling a subdomain.
 *   - External links (a different host entirely) are recorded into
 *     `seo_links` with `is_external = true` for reporting and are NEVER
 *     fetched.
 *   - Every fetch goes through `seoFetch`, which re-validates scheme/host/
 *     DNS/IP on every redirect hop (SSRF + DNS-rebinding protection) — see
 *     seoFetch.ts's header comment for the full guarantee list.
 *
 * Limits (`SeoCrawlLimits`, plan-resolved, never trusted from the client)
 * bound pages, depth, wall-clock duration, per-response bytes, total bytes,
 * per-request timeout and inter-request delay — no single site can occupy a
 * worker indefinitely.
 */
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import type { SeoCrawlLimits } from '../limits.js';
import { seoFetch } from './seoFetch.js';
import { parseHtml } from './htmlParse.js';
import { fetchRobotsInfo, type RobotsInfo } from './robotsInfo.js';
import { discoverAndFetchSitemaps, type SitemapResult } from './sitemap.js';
import { getRobotsRules, isPathAllowedByRobots } from '../../ai-agent/crawler/robots.js';
import { canonicalize, isSameDomain, normalizeHost } from '../../ai-agent/crawler/urlRules.js';
import { heartbeatJob } from '../../jobs/queue.js';

type DiscoveredVia = 'start' | 'link' | 'sitemap';

export interface CrawlSiteArgs {
  config: ServerConfig;
  crawlId: string;
  workspaceId: string;
  canonicalUrl: string;
  userAgent: string;
  respectRobots: boolean;
  limits: SeoCrawlLimits;
  jobId: string;
  workerId: string;
}

export type TruncationReason = 'max_pages' | 'max_duration' | 'max_total_bytes' | null;

export interface SitemapCoverage {
  sitemapCount: number;
  validSitemapCount: number;
  invalidSitemapCount: number;
  totalSitemapUrls: number;
  crawledButMissingFromSitemap: number;
  sitemapUrlsNotCrawled: number;
  /** Bounded sample of sitemap-declared URLs, persisted for the rules engine's sitemap-quality checks. */
  sampleUrls: string[];
}

const SITEMAP_SAMPLE_CAP = 5000;

export interface CrawlSiteResult {
  pagesDiscovered: number;
  pagesCrawled: number;
  pagesFailed: number;
  pagesSkipped: number;
  robotsSummary: RobotsInfo;
  sitemapSummary: SitemapCoverage;
  cancelled: boolean;
  truncatedBy: TruncationReason;
}

interface QueueItem {
  url: string;
  depth: number;
  discoveredVia: DiscoveredVia;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function crawlSite(args: CrawlSiteArgs): Promise<CrawlSiteResult> {
  const sb = getServiceClient(args.config);
  const limits = args.limits;
  const canonicalHost = normalizeHost(new URL(args.canonicalUrl).hostname);
  const deadline = Date.now() + limits.seo_max_duration_seconds * 1000;

  const robotsSummary = await fetchRobotsInfo(args.canonicalUrl, args.userAgent);
  const robotsRules = args.respectRobots
    ? await getRobotsRules(args.canonicalUrl, args.userAgent)
    : { allow: [], disallow: [] };

  const sitemapResults = await discoverAndFetchSitemaps({
    canonicalHost,
    canonicalUrl: args.canonicalUrl,
    userAgent: args.userAgent,
    robotsDeclaredSitemaps: robotsSummary.sitemaps,
  });
  if (sitemapResults.length) {
    await sb.from('seo_sitemaps').insert(
      sitemapResults.map((sm) => ({
        crawl_id: args.crawlId,
        workspace_id: args.workspaceId,
        url: sm.url,
        discovered_via: sm.discoveredVia,
        status: sm.status,
        http_status: sm.httpStatus,
        url_count: sm.urlCount,
        error_message: sm.errorMessage,
      })),
    );
  }

  const sitemapUrls = new Set<string>();
  for (const sm of sitemapResults) {
    for (const raw of sm.urls) {
      const c = canonicalize(raw);
      if (c.ok && c.url && isSameDomain(c.url, canonicalHost)) sitemapUrls.add(c.url);
    }
  }

  const seen = new Set<string>();
  const queue: QueueItem[] = [];
  const rootCanon = canonicalize(args.canonicalUrl);
  const rootUrl = rootCanon.ok && rootCanon.url ? rootCanon.url : args.canonicalUrl;
  seen.add(rootUrl);
  queue.push({ url: rootUrl, depth: 0, discoveredVia: 'start' });

  // Seed additional sitemap-declared URLs so pages with no internal inlink
  // (orphans from a link-graph perspective) still get audited.
  const sitemapSeedBudget = Math.max(0, limits.seo_max_pages_per_crawl - queue.length);
  let seeded = 0;
  for (const u of sitemapUrls) {
    if (seeded >= sitemapSeedBudget) break;
    if (seen.has(u)) continue;
    seen.add(u);
    queue.push({ url: u, depth: 0, discoveredVia: 'sitemap' });
    seeded++;
  }

  const crawledNormalizedUrls = new Set<string>();
  let pagesCrawled = 0;
  let pagesFailed = 0;
  let pagesSkipped = 0;
  let totalBytes = 0;
  let cancelled = false;
  let truncatedBy: TruncationReason = null;

  while (queue.length && pagesCrawled < limits.seo_max_pages_per_crawl) {
    if (Date.now() > deadline) { truncatedBy = 'max_duration'; break; }
    if (totalBytes > limits.seo_max_total_bytes) { truncatedBy = 'max_total_bytes'; break; }

    const hb = await heartbeatJob(args.config, {
      jobId: args.jobId,
      workerId: args.workerId,
      lockTtlSeconds: 120,
      progress: Math.min(90, Math.round((pagesCrawled / Math.max(1, limits.seo_max_pages_per_crawl)) * 90)),
      progressStage: `crawling:${pagesCrawled}/${limits.seo_max_pages_per_crawl}`,
      status: 'processing',
    });
    if (hb.cancelRequested) { cancelled = true; break; }

    const batchSize = Math.max(1, Math.min(limits.seo_crawl_concurrency, limits.seo_max_pages_per_crawl - pagesCrawled));
    const batch = queue.splice(0, batchSize);

    const outcomes = await Promise.all(batch.map((item) => processPage(args, item, canonicalHost, robotsRules)));

    for (let i = 0; i < outcomes.length; i++) {
      const outcome = outcomes[i];
      const item = batch[i];
      if (outcome.status === 'skipped') { pagesSkipped++; continue; }
      if (outcome.status === 'failed') { pagesFailed++; continue; }

      pagesCrawled++;
      totalBytes += outcome.responseBytes;
      crawledNormalizedUrls.add(outcome.normalizedUrl);

      if (item.depth < limits.seo_max_depth) {
        for (const link of outcome.internalLinks) {
          if (seen.has(link)) continue;
          if (pagesCrawled + queue.length >= limits.seo_max_pages_per_crawl) break;
          seen.add(link);
          queue.push({ url: link, depth: item.depth + 1, discoveredVia: 'link' });
        }
      }
    }

    if (limits.seo_crawl_delay_ms > 0 && queue.length) await sleep(limits.seo_crawl_delay_ms);
  }

  if (!cancelled && truncatedBy === null && queue.length > 0) truncatedBy = 'max_pages';

  const validSitemaps = sitemapResults.filter((s) => s.status === 'valid');
  const sitemapSummary: SitemapCoverage = {
    sitemapCount: sitemapResults.length,
    validSitemapCount: validSitemaps.length,
    invalidSitemapCount: sitemapResults.length - validSitemaps.length,
    totalSitemapUrls: sitemapUrls.size,
    crawledButMissingFromSitemap: Array.from(crawledNormalizedUrls).filter((u) => !sitemapUrls.has(u)).length,
    sitemapUrlsNotCrawled: Array.from(sitemapUrls).filter((u) => !crawledNormalizedUrls.has(u)).length,
    sampleUrls: Array.from(sitemapUrls).slice(0, SITEMAP_SAMPLE_CAP),
  };

  return {
    pagesDiscovered: seen.size,
    pagesCrawled,
    pagesFailed,
    pagesSkipped,
    robotsSummary,
    sitemapSummary,
    cancelled,
    truncatedBy,
  };
}

interface PageOutcome {
  status: 'crawled' | 'failed' | 'skipped';
  normalizedUrl: string;
  responseBytes: number;
  internalLinks: string[];
}

async function processPage(
  args: CrawlSiteArgs,
  item: QueueItem,
  canonicalHost: string,
  robotsRules: { allow: string[]; disallow: string[] },
): Promise<PageOutcome> {
  const sb = getServiceClient(args.config);
  const limits = args.limits;
  const normalizedForDefense = canonicalize(item.url);
  const url = normalizedForDefense.ok && normalizedForDefense.url ? normalizedForDefense.url : item.url;

  // Defense in depth: re-check same-domain even though callers only ever
  // enqueue same-domain URLs.
  if (!isSameDomain(url, canonicalHost)) {
    return { status: 'skipped', normalizedUrl: url, responseBytes: 0, internalLinks: [] };
  }

  let path = '/';
  try { path = new URL(url).pathname || '/'; } catch { /* keep default */ }
  if (!isPathAllowedByRobots(path, robotsRules)) {
    await upsertPage(sb, args, url, url, { discovered_via: item.discoveredVia, depth: item.depth, fetch_error: 'robots_blocked', is_indexable: false });
    return { status: 'skipped', normalizedUrl: url, responseBytes: 0, internalLinks: [] };
  }

  const res = await seoFetch(url, {
    userAgent: args.userAgent,
    timeoutMs: limits.seo_request_timeout_ms,
    maxBytes: limits.seo_max_response_bytes,
    isUrlAllowed: (candidate) => isSameDomain(candidate, canonicalHost),
  });

  if (!res.ok || !res.html) {
    await upsertPage(sb, args, url, res.finalUrl || url, {
      discovered_via: item.discoveredVia,
      depth: item.depth,
      http_status: res.status ?? null,
      response_time_ms: res.responseTimeMs,
      redirect_chain: res.redirectChain,
      fetch_error: res.error || 'fetch_failed',
    });
    return { status: 'failed', normalizedUrl: url, responseBytes: res.contentLength || 0, internalLinks: [] };
  }

  const parsed = parseHtml(res.html, res.finalUrl || url);
  const isHttps = new URL(res.finalUrl || url).protocol === 'https:';
  const hasMixedContent = isHttps && /\s(?:src|href)\s*=\s*["']http:\/\//i.test(res.html);
  const metaRobotsLower = (parsed.metaRobots || '').toLowerCase();
  const xRobotsTag = (res.headers?.['x-robots-tag'] || '').toLowerCase();
  const isNoindex = metaRobotsLower.includes('noindex') || xRobotsTag.includes('noindex');
  const isNofollow = metaRobotsLower.includes('nofollow') || xRobotsTag.includes('nofollow');

  let canonicalStatus: 'missing' | 'self' | 'points_elsewhere' | 'invalid' = 'missing';
  if (parsed.canonicalUrl) {
    const canon = canonicalize(parsed.canonicalUrl);
    if (!canon.ok || !canon.url) canonicalStatus = 'invalid';
    else canonicalStatus = canon.url === url ? 'self' : 'points_elsewhere';
  }

  const internalLinks: string[] = [];
  const linkRows: Record<string, unknown>[] = [];
  const seenTargets = new Set<string>();
  for (const link of parsed.links) {
    const c = canonicalize(link.href);
    if (!c.ok || !c.url) continue;
    const isExternal = !isSameDomain(c.url, canonicalHost);
    const dedupeKey = `${c.url}|${isExternal}`;
    if (seenTargets.has(dedupeKey)) continue;
    seenTargets.add(dedupeKey);
    if (!isExternal) internalLinks.push(c.url);
    linkRows.push({
      target_url: link.href,
      target_normalized_url: c.url,
      is_external: isExternal,
      anchor_text: link.anchorText || null,
      rel: link.rel,
    });
  }

  const pageId = await upsertPage(sb, args, url, res.finalUrl || url, {
    discovered_via: item.discoveredVia,
    depth: item.depth,
    http_status: res.status ?? null,
    content_type: res.contentType || null,
    response_time_ms: res.responseTimeMs,
    response_bytes: res.contentLength || null,
    redirect_chain: res.redirectChain,
    title: parsed.title,
    title_length: parsed.title?.length ?? null,
    meta_description: parsed.metaDescription,
    meta_description_length: parsed.metaDescription?.length ?? null,
    canonical_url: parsed.canonicalUrl,
    canonical_status: canonicalStatus,
    meta_robots: parsed.metaRobots,
    is_indexable: !isNoindex,
    is_nofollow: isNofollow,
    h1: parsed.h1,
    h1_count: parsed.h1Count,
    h2_count: parsed.h2Count,
    lang: parsed.lang,
    charset: parsed.charset,
    word_count: parsed.wordCount,
    internal_links_count: linkRows.filter((l) => !l.is_external).length,
    external_links_count: linkRows.filter((l) => l.is_external).length,
    images_count: parsed.images.length,
    images_missing_alt_count: parsed.images.filter((i) => !i.hasAlt).length,
    has_open_graph: parsed.hasOpenGraph,
    has_twitter_card: parsed.hasTwitterCard,
    has_structured_data: parsed.structuredData.has,
    structured_data_types: parsed.structuredData.types,
    structured_data_errors: parsed.structuredData.errors,
    html_size_bytes: parsed.htmlSizeBytes,
    is_https: isHttps,
    has_mixed_content: hasMixedContent,
    crawled_at: new Date().toISOString(),
  });

  if (pageId && linkRows.length) {
    const rows = linkRows.map((r) => ({ ...r, crawl_id: args.crawlId, workspace_id: args.workspaceId, source_page_id: pageId }));
    for (let i = 0; i < rows.length; i += 500) {
      await sb.from('seo_links').insert(rows.slice(i, i + 500));
    }
  }

  return { status: 'crawled', normalizedUrl: url, responseBytes: res.contentLength || 0, internalLinks };
}

async function upsertPage(
  sb: ReturnType<typeof getServiceClient>,
  args: CrawlSiteArgs,
  url: string,
  finalUrl: string,
  patch: Record<string, unknown>,
): Promise<string | null> {
  const { data, error } = await sb
    .from('seo_pages')
    .upsert(
      {
        crawl_id: args.crawlId,
        workspace_id: args.workspaceId,
        url,
        normalized_url: url,
        final_url: finalUrl !== url ? finalUrl : null,
        ...patch,
      },
      { onConflict: 'crawl_id,normalized_url' },
    )
    .select('id')
    .maybeSingle();
  if (error) return null;
  return (data as { id: string } | null)?.id ?? null;
}
