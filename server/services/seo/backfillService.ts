/**
 * Chronological, bounded, resumable, idempotent backfill of the canonical SEO
 * model from legacy `seo_pages` / `seo_links`.
 *
 * Per crawl (oldest first), in this order:
 *   1. canonical URL identity + delta observation + membership  (recordObservation)
 *   2. canonical link edges from the legacy edges of that crawl (persistLinkEdges)
 *   3. issue references          (seo_issue_pages.url_id)
 *   4. performance references    (seo_performance_results.url_id)
 *   5. compact crawl summary     (seo_crawl_summaries)
 *
 * Progress lives in `seo_backfill_state` (one row per crawl) with a page
 * cursor, so an interrupted pass resumes where it stopped and a rerun over an
 * already-migrated crawl writes no duplicate rows: identities are upserted on
 * their natural keys, observations are keyed (crawl_id, url_id) and the delta
 * hash keeps unchanged pages from producing a second full observation.
 *
 * NOTHING is deleted: legacy rows are read-only inputs here.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { recordObservation } from './urlRepository.js';
import { persistLinkEdges, persistCrawlSummary, type LinkEdgeInput } from './canonicalRepository.js';

const PAGE_BATCH = 200;

export interface BackfillCrawlResult {
  crawlId: string;
  status: 'completed' | 'failed' | 'partial';
  pagesProcessed: number;
  observationsCreated: number;
  membershipsCreated: number;
  linkEdgesCreated: number;
  issueRefsLinked: number;
  performanceRefsLinked: number;
  duplicatesAvoided: number;
  error?: string;
}

export interface BackfillRunResult {
  crawlsProcessed: number;
  crawlsRemaining: number;
  results: BackfillCrawlResult[];
}

interface CrawlRow {
  id: string;
  workspace_id: string;
  website_id: string;
  status: string;
  created_at: string;
  pages_discovered: number | null;
  pages_crawled: number | null;
  pages_failed: number | null;
}

async function pendingCrawls(config: ServerConfig, limit: number): Promise<CrawlRow[]> {
  const sb = getServiceClient(config);
  const { data: done } = await sb.from('seo_backfill_state').select('crawl_id').eq('status', 'completed');
  const skip = new Set(((done || []) as { crawl_id: string }[]).map((r) => r.crawl_id));

  const { data } = await sb
    .from('seo_crawls')
    .select('id, workspace_id, website_id, status, created_at, pages_discovered, pages_crawled, pages_failed')
    .order('created_at', { ascending: true });

  return ((data || []) as CrawlRow[]).filter((c) => !skip.has(c.id)).slice(0, limit);
}

async function legacyPageBatch(config: ServerConfig, crawlId: string, offset: number): Promise<Record<string, unknown>[]> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('seo_pages')
    .select('*')
    .eq('crawl_id', crawlId)
    .order('id', { ascending: true })
    .range(offset, offset + PAGE_BATCH - 1);
  return (data || []) as Record<string, unknown>[];
}

async function legacyLinksForPage(config: ServerConfig, pageId: string): Promise<LinkEdgeInput[]> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('seo_links')
    .select('target_url, target_normalized_url, is_external, anchor_text, rel')
    .eq('source_page_id', pageId);
  return ((data || []) as Record<string, unknown>[]).map((l) => ({
    targetUrl: l.target_url as string,
    targetNormalizedUrl: (l.target_normalized_url as string | null) ?? null,
    isExternal: l.is_external === true,
    anchorText: (l.anchor_text as string | null) ?? null,
    rel: (l.rel as string | null) ?? null,
  }));
}

/** Points legacy-keyed issue/performance rows at the canonical URL identity. */
async function linkLegacyReferences(
  config: ServerConfig,
  table: 'seo_issue_pages' | 'seo_performance_results',
  legacyPageId: string,
  urlId: string,
): Promise<number> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from(table)
    .update({ url_id: urlId })
    .eq('page_id', legacyPageId)
    .is('url_id', null)
    .select('id');
  return ((data || []) as unknown[]).length;
}

export async function backfillCrawl(config: ServerConfig, crawl: CrawlRow): Promise<BackfillCrawlResult> {
  const sb = getServiceClient(config);
  const nowIso = new Date().toISOString();

  const { data: stateRow } = await sb.from('seo_backfill_state').select('*').eq('crawl_id', crawl.id).maybeSingle();
  const state = (stateRow as Record<string, number | string | null> | null) || null;
  let offset = Number(state?.cursor_offset ?? 0);

  const totals = {
    pagesProcessed: Number(state?.pages_processed ?? 0),
    urlsCreated: Number(state?.urls_created ?? 0),
    observationsCreated: Number(state?.observations_created ?? 0),
    membershipsCreated: Number(state?.memberships_created ?? 0),
    linkEdgesCreated: Number(state?.link_edges_created ?? 0),
    issueRefsLinked: Number(state?.issue_refs_linked ?? 0),
    performanceRefsLinked: Number(state?.performance_refs_linked ?? 0),
    duplicatesAvoided: Number(state?.duplicates_avoided ?? 0),
  };

  await sb.from('seo_backfill_state').upsert(
    {
      crawl_id: crawl.id,
      workspace_id: crawl.workspace_id,
      site_id: crawl.website_id,
      status: 'running',
      cursor_offset: offset,
      started_at: (state?.started_at as string | null) || nowIso,
      updated_at: nowIso,
      error: null,
    },
    { onConflict: 'crawl_id' },
  );

  try {
    for (;;) {
      const pages = await legacyPageBatch(config, crawl.id, offset);
      if (pages.length === 0) break;

      for (const page of pages) {
        const normalizedUrl = (page.normalized_url as string) || (page.url as string);
        if (!normalizedUrl) continue;

        const observation = await recordObservation({
          config,
          crawlId: crawl.id,
          workspaceId: crawl.workspace_id,
          siteId: crawl.website_id,
          normalizedUrl,
          observedAt: (page.created_at as string) || crawl.created_at,
          payload: page,
          fields: {
            statusCode: (page.http_status as number | null) ?? null,
            title: (page.title as string | null) ?? null,
            metaDescription: (page.meta_description as string | null) ?? null,
            canonicalStatus: (page.canonical_status as string | null) ?? null,
            isIndexable: page.is_indexable !== false,
            internalLinksCount: (page.internal_links_count as number) ?? 0,
            externalLinksCount: (page.external_links_count as number) ?? 0,
            incomingInternalLinksCount: (page.incoming_internal_links_count as number) ?? 0,
            issueFlags: {
              fetchError: (page.fetch_error as string | null) ?? null,
              hasMixedContent: page.has_mixed_content === true,
              h1Count: (page.h1_count as number) ?? 0,
            },
          },
        });
        if (!observation) throw new Error(`seo_backfill_observation_failed: ${normalizedUrl}`);

        totals.pagesProcessed++;
        totals.membershipsCreated++;
        if (observation.observationWritten) totals.observationsCreated++;
        else totals.duplicatesAvoided++;

        const links = await legacyLinksForPage(config, page.id as string);
        if (links.length > 0) {
          totals.linkEdgesCreated += await persistLinkEdges({
            config,
            crawlId: crawl.id,
            workspaceId: crawl.workspace_id,
            siteId: crawl.website_id,
            sourceUrlId: observation.urlId,
            links,
            observedAt: (page.created_at as string) || crawl.created_at,
          });
        }

        totals.issueRefsLinked += await linkLegacyReferences(config, 'seo_issue_pages', page.id as string, observation.urlId);
        totals.performanceRefsLinked += await linkLegacyReferences(config, 'seo_performance_results', page.id as string, observation.urlId);
      }

      offset += pages.length;
      await sb.from('seo_backfill_state').update({
        cursor_offset: offset,
        pages_processed: totals.pagesProcessed,
        urls_created: totals.urlsCreated,
        observations_created: totals.observationsCreated,
        memberships_created: totals.membershipsCreated,
        link_edges_created: totals.linkEdgesCreated,
        issue_refs_linked: totals.issueRefsLinked,
        performance_refs_linked: totals.performanceRefsLinked,
        duplicates_avoided: totals.duplicatesAvoided,
        updated_at: new Date().toISOString(),
      }).eq('crawl_id', crawl.id);

      if (pages.length < PAGE_BATCH) break;
    }

    await persistCrawlSummary(config, {
      crawlId: crawl.id,
      workspaceId: crawl.workspace_id,
      siteId: crawl.website_id,
      urlsDiscovered: crawl.pages_discovered ?? totals.pagesProcessed,
      urlsCrawled: crawl.pages_crawled ?? totals.pagesProcessed,
      urlsFailed: crawl.pages_failed ?? 0,
      internalLinks: 0,
      externalLinks: 0,
    });

    await sb.from('seo_backfill_state').update({
      status: 'completed',
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      error: null,
    }).eq('crawl_id', crawl.id);

    return {
      crawlId: crawl.id,
      status: 'completed',
      pagesProcessed: totals.pagesProcessed,
      observationsCreated: totals.observationsCreated,
      membershipsCreated: totals.membershipsCreated,
      linkEdgesCreated: totals.linkEdgesCreated,
      issueRefsLinked: totals.issueRefsLinked,
      performanceRefsLinked: totals.performanceRefsLinked,
      duplicatesAvoided: totals.duplicatesAvoided,
    };
  } catch (err) {
    const message = (err as Error)?.message || 'unknown_error';
    await sb.from('seo_backfill_state').update({
      status: 'failed',
      error: message,
      updated_at: new Date().toISOString(),
    }).eq('crawl_id', crawl.id);
    return {
      crawlId: crawl.id,
      status: 'failed',
      pagesProcessed: totals.pagesProcessed,
      observationsCreated: totals.observationsCreated,
      membershipsCreated: totals.membershipsCreated,
      linkEdgesCreated: totals.linkEdgesCreated,
      issueRefsLinked: totals.issueRefsLinked,
      performanceRefsLinked: totals.performanceRefsLinked,
      duplicatesAvoided: totals.duplicatesAvoided,
      error: message,
    };
  }
}

/** One bounded pass. Safe to call repeatedly until `crawlsRemaining` is 0. */
export async function runCanonicalBackfill(config: ServerConfig, maxCrawls = 5): Promise<BackfillRunResult> {
  const crawls = await pendingCrawls(config, Math.min(Math.max(maxCrawls, 1), 25));
  const results: BackfillCrawlResult[] = [];
  for (const crawl of crawls) results.push(await backfillCrawl(config, crawl));
  const remaining = (await pendingCrawls(config, 1000)).length;
  return { crawlsProcessed: results.length, crawlsRemaining: remaining, results };
}

/** Read-only parity/validation report used before trusting canonical reads. */
export async function validateCanonicalBackfill(config: ServerConfig): Promise<Record<string, number>> {
  const sb = getServiceClient(config);
  const count = async (table: string, apply?: (q: any) => any): Promise<number> => {
    let q = sb.from(table).select('*', { count: 'exact', head: true });
    if (apply) q = apply(q);
    const { count: c } = await q;
    return c || 0;
  };
  return {
    legacyPages: await count('seo_pages'),
    legacyLinks: await count('seo_links'),
    canonicalUrls: await count('seo_urls'),
    observations: await count('seo_crawl_observations'),
    memberships: await count('seo_crawl_url_membership'),
    linkEdges: await count('seo_link_edges'),
    summaries: await count('seo_crawl_summaries'),
    issueRefsUnlinked: await count('seo_issue_pages', (q) => q.is('url_id', null).not('page_id', 'is', null)),
    performanceRefsUnlinked: await count('seo_performance_results', (q) => q.is('url_id', null).not('page_id', 'is', null)),
    backfillCompleted: await count('seo_backfill_state', (q) => q.eq('status', 'completed')),
    backfillFailed: await count('seo_backfill_state', (q) => q.eq('status', 'failed')),
  };
}
