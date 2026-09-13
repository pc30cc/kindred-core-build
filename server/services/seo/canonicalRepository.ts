/**
 * THE canonical SEO storage boundary.
 *
 * Every SEO write and every SEO read that concerns pages and links goes
 * through this module. Controllers, the rules engine, the performance auditor
 * and the report services must not query `seo_urls`, `seo_crawl_observations`,
 * `seo_crawl_url_membership`, `seo_link_edges`, `seo_pages` or `seo_links`
 * directly — the legacy fallback lives here and nowhere else.
 *
 * Write pipeline (authoritative, migration 174+):
 *   raw crawl result
 *     -> URL normalization (urlRules.canonicalize, upstream)
 *     -> canonical URL upsert            (seo_urls)
 *     -> deterministic observation hash   (urlRepository.computeObservationHash)
 *     -> classify vs previous effective observation
 *     -> full observation ONLY when the state changed
 *     -> compact crawl membership
 *     -> current-state pointer            (seo_urls.current_observation_id)
 *     -> canonical link edges             (seo_link_edges, one row per edge, reused)
 *     -> compact crawl summary            (seo_crawl_summaries)
 *
 * Legacy `seo_pages` / `seo_links` full writes are OFF by default. They can be
 * re-enabled for one release with SEO_LEGACY_WRITES=true purely as a rollback
 * lever; when enabled they duplicate storage, which is exactly what this model
 * removes. Nothing else in the codebase may write those two tables.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { recordObservation, type RecordObservationResult } from './urlRepository.js';

const CHUNK = 500;
const FETCH_CHUNK = 1000;

/** Legacy duplicate writes are disabled unless explicitly switched back on. */
export function legacyWritesEnabled(): boolean {
  return process.env.SEO_LEGACY_WRITES === 'true';
}

export interface LinkEdgeInput {
  targetUrl: string;
  targetNormalizedUrl: string | null;
  isExternal: boolean;
  anchorText: string | null;
  rel: string | null;
}

export interface PersistPageArgs {
  config: ServerConfig;
  crawlId: string;
  workspaceId: string;
  siteId: string;
  normalizedUrl: string;
  finalUrl: string | null;
  /** Full legacy-shaped page record; stored verbatim as the observation payload. */
  page: Record<string, unknown>;
  links: LinkEdgeInput[];
}

export interface PersistPageResult extends RecordObservationResult {
  legacyPageId: string | null;
  linkEdgesWritten: number;
}

function edgeKey(link: LinkEdgeInput): string {
  return `${link.isExternal ? 'e' : 'i'}|${link.targetNormalizedUrl || link.targetUrl}`;
}

/**
 * Persists ONE crawled page: canonical identity, delta observation, membership,
 * current state and its outgoing link edges. Never requires a legacy page row.
 */
export async function persistPage(args: PersistPageArgs): Promise<PersistPageResult> {
  const sb = getServiceClient(args.config);
  const observedAt = new Date().toISOString();

  const observation = await recordObservation({
    config: args.config,
    crawlId: args.crawlId,
    workspaceId: args.workspaceId,
    siteId: args.siteId,
    normalizedUrl: args.normalizedUrl,
    observedAt,
    payload: args.page,
    fields: {
      statusCode: (args.page.http_status as number | null) ?? null,
      title: (args.page.title as string | null) ?? null,
      metaDescription: (args.page.meta_description as string | null) ?? null,
      canonicalStatus: (args.page.canonical_status as string | null) ?? null,
      isIndexable: args.page.is_indexable !== false,
      internalLinksCount: (args.page.internal_links_count as number) ?? 0,
      externalLinksCount: (args.page.external_links_count as number) ?? 0,
      issueFlags: {
        fetchError: (args.page.fetch_error as string | null) ?? null,
        hasMixedContent: args.page.has_mixed_content === true,
        h1Count: (args.page.h1_count as number) ?? 0,
      },
    },
  });

  if (!observation) throw new Error('seo_canonical_write_failed: observation not recorded');

  const linkEdgesWritten = args.links.length
    ? await persistLinkEdges({
        config: args.config,
        crawlId: args.crawlId,
        workspaceId: args.workspaceId,
        siteId: args.siteId,
        sourceUrlId: observation.urlId,
        links: args.links,
        observedAt,
      })
    : 0;

  let legacyPageId: string | null = null;
  if (legacyWritesEnabled()) {
    const { data } = await sb
      .from('seo_pages')
      .upsert(
        {
          crawl_id: args.crawlId,
          workspace_id: args.workspaceId,
          url: args.normalizedUrl,
          normalized_url: args.normalizedUrl,
          final_url: args.finalUrl,
          ...args.page,
        },
        { onConflict: 'crawl_id,normalized_url' },
      )
      .select('id')
      .maybeSingle();
    legacyPageId = (data as { id: string } | null)?.id ?? null;
    if (legacyPageId && args.links.length) {
      const rows = args.links.map((l) => ({
        crawl_id: args.crawlId,
        workspace_id: args.workspaceId,
        source_page_id: legacyPageId,
        source_url_id: observation.urlId,
        target_url: l.targetUrl,
        target_normalized_url: l.targetNormalizedUrl,
        is_external: l.isExternal,
        anchor_text: l.anchorText,
        rel: l.rel,
      }));
      for (let i = 0; i < rows.length; i += CHUNK) await sb.from('seo_links').insert(rows.slice(i, i + CHUNK));
    }
  }

  return { ...observation, legacyPageId, linkEdgesWritten };
}

/**
 * Upserts the outgoing edge set of one source URL into the compact CURRENT
 * link graph. An unchanged crawl re-touches the same rows (last_seen_crawl_id)
 * instead of inserting a duplicate copy of the whole graph.
 */
export async function persistLinkEdges(args: {
  config: ServerConfig;
  crawlId: string;
  workspaceId: string;
  siteId: string;
  sourceUrlId: string;
  links: LinkEdgeInput[];
  observedAt?: string;
}): Promise<number> {
  const sb = getServiceClient(args.config);
  const seenAt = args.observedAt || new Date().toISOString();
  const byKey = new Map<string, LinkEdgeInput>();
  for (const link of args.links) byKey.set(edgeKey(link), link);

  const rows = Array.from(byKey.entries()).map(([key, link]) => ({
    workspace_id: args.workspaceId,
    site_id: args.siteId,
    source_url_id: args.sourceUrlId,
    target_key: key,
    target_url: link.targetUrl,
    target_normalized_url: link.targetNormalizedUrl,
    is_external: link.isExternal,
    anchor_text: link.anchorText,
    rel: link.rel,
    is_active: true,
    first_seen_crawl_id: args.crawlId,
    last_seen_crawl_id: args.crawlId,
    first_seen_at: seenAt,
    last_seen_at: seenAt,
  }));

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await sb
      .from('seo_link_edges')
      .upsert(chunk, { onConflict: 'workspace_id,site_id,source_url_id,target_key', ignoreDuplicates: false });
    if (error) throw new Error(`seo_link_edge_write_failed: ${error.message}`);
  }
  return rows.length;
}

/**
 * Post-crawl: resolve internal edge targets to canonical URL ids, mark broken
 * internal links and write each URL's incoming-link count onto its current
 * observation. Uses canonical identities only — no legacy page rows involved.
 */
export async function finalizeCanonicalLinkGraph(
  config: ServerConfig,
  args: { crawlId: string; workspaceId: string; siteId: string },
): Promise<{ resolved: number; broken: number }> {
  const sb = getServiceClient(config);

  const statusByUrlId = new Map<string, number | null>();
  const idByNormalized = new Map<string, string>();
  for (let from = 0; ; from += FETCH_CHUNK) {
    const { data, error } = await sb
      .from('seo_crawl_url_membership')
      .select('url_id, status_code')
      .eq('crawl_id', args.crawlId)
      .range(from, from + FETCH_CHUNK - 1);
    if (error || !data || data.length === 0) break;
    for (const row of data as { url_id: string; status_code: number | null }[]) statusByUrlId.set(row.url_id, row.status_code);
    if (data.length < FETCH_CHUNK) break;
  }

  const urlIds = Array.from(statusByUrlId.keys());
  for (let i = 0; i < urlIds.length; i += CHUNK) {
    const { data } = await sb.from('seo_urls').select('id, normalized_url').in('id', urlIds.slice(i, i + CHUNK));
    for (const row of ((data || []) as { id: string; normalized_url: string }[])) idByNormalized.set(row.normalized_url, row.id);
  }

  const incoming = new Map<string, number>();
  let resolved = 0;
  let broken = 0;

  for (let from = 0; ; from += FETCH_CHUNK) {
    const { data, error } = await sb
      .from('seo_link_edges')
      .select('id, target_normalized_url, target_url_id, is_broken')
      .eq('workspace_id', args.workspaceId)
      .eq('site_id', args.siteId)
      .eq('is_external', false)
      .eq('last_seen_crawl_id', args.crawlId)
      .range(from, from + FETCH_CHUNK - 1);
    if (error || !data || data.length === 0) break;
    const rows = data as { id: string; target_normalized_url: string | null; target_url_id: string | null; is_broken: boolean }[];
    for (const row of rows) {
      const targetId = row.target_normalized_url ? idByNormalized.get(row.target_normalized_url) : undefined;
      if (!targetId) continue;
      incoming.set(targetId, (incoming.get(targetId) || 0) + 1);
      const status = statusByUrlId.get(targetId) ?? null;
      const isBroken = status === null || status >= 400;
      if (isBroken) broken++;
      resolved++;
      if (row.target_url_id !== targetId || row.is_broken !== isBroken) {
        await sb.from('seo_link_edges').update({ target_url_id: targetId, http_status: status, is_broken: isBroken }).eq('id', row.id);
      }
    }
    if (rows.length < FETCH_CHUNK) break;
  }

  for (const [urlId, count] of incoming) {
    await sb
      .from('seo_crawl_observations')
      .update({ incoming_internal_links_count: count })
      .eq('crawl_id', args.crawlId)
      .eq('url_id', urlId);
  }

  return { resolved, broken };
}

export interface CanonicalPageRow {
  urlId: string;
  legacyPageId: string | null;
  url: string;
  normalizedUrl: string;
  changeType: string;
  page: Record<string, unknown>;
}

/** Every URL observed in a crawl, with its EFFECTIVE (possibly reused) payload. */
export async function getCrawlPages(config: ServerConfig, crawlId: string): Promise<CanonicalPageRow[]> {
  const sb = getServiceClient(config);
  const memberships: { url_id: string; state: string; effective_observation_id: string | null; status_code: number | null }[] = [];
  for (let from = 0; ; from += FETCH_CHUNK) {
    const { data, error } = await sb
      .from('seo_crawl_url_membership')
      .select('url_id, state, effective_observation_id, status_code')
      .eq('crawl_id', crawlId)
      .range(from, from + FETCH_CHUNK - 1);
    if (error || !data || data.length === 0) break;
    memberships.push(...(data as typeof memberships));
    if (data.length < FETCH_CHUNK) break;
  }
  if (memberships.length === 0) return getLegacyCrawlPages(config, crawlId);

  const obsIds = Array.from(new Set(memberships.map((m) => m.effective_observation_id).filter(Boolean))) as string[];
  const payloadByObs = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < obsIds.length; i += CHUNK) {
    const { data } = await sb.from('seo_crawl_observations').select('id, payload').in('id', obsIds.slice(i, i + CHUNK));
    for (const row of ((data || []) as { id: string; payload: Record<string, unknown> }[])) payloadByObs.set(row.id, row.payload || {});
  }

  const urlIds = memberships.map((m) => m.url_id);
  const urlById = new Map<string, string>();
  for (let i = 0; i < urlIds.length; i += CHUNK) {
    const { data } = await sb.from('seo_urls').select('id, normalized_url').in('id', urlIds.slice(i, i + CHUNK));
    for (const row of ((data || []) as { id: string; normalized_url: string }[])) urlById.set(row.id, row.normalized_url);
  }

  return memberships
    .filter((m) => m.state !== 'removed')
    .map((m) => {
      const normalizedUrl = urlById.get(m.url_id) || '';
      const payload = (m.effective_observation_id ? payloadByObs.get(m.effective_observation_id) : undefined) || {};
      return {
        urlId: m.url_id,
        legacyPageId: null,
        url: (payload.url as string) || normalizedUrl,
        normalizedUrl,
        changeType: m.state,
        page: { ...payload, http_status: payload.http_status ?? m.status_code },
      };
    });
}

/** Compatibility path: crawls recorded before the canonical cutover/backfill. */
async function getLegacyCrawlPages(config: ServerConfig, crawlId: string): Promise<CanonicalPageRow[]> {
  const sb = getServiceClient(config);
  const out: CanonicalPageRow[] = [];
  for (let from = 0; ; from += FETCH_CHUNK) {
    const { data, error } = await sb.from('seo_pages').select('*').eq('crawl_id', crawlId).range(from, from + FETCH_CHUNK - 1);
    if (error || !data || data.length === 0) break;
    for (const row of data as Record<string, unknown>[]) {
      out.push({
        urlId: '',
        legacyPageId: row.id as string,
        url: row.url as string,
        normalizedUrl: row.normalized_url as string,
        changeType: 'unchanged',
        page: row,
      });
    }
    if (data.length < FETCH_CHUNK) break;
  }
  return out;
}

export interface CanonicalLinkRow {
  sourceUrl: string;
  targetUrl: string;
  targetNormalizedUrl: string | null;
  isExternal: boolean;
  isBroken: boolean;
  httpStatus: number | null;
  anchorText: string | null;
  rel: string | null;
}

/** The link graph as observed by one crawl, from the compact edge table. */
export async function getCrawlLinks(
  config: ServerConfig,
  args: { crawlId: string; workspaceId: string; siteId: string },
): Promise<CanonicalLinkRow[]> {
  const sb = getServiceClient(config);
  const edges: {
    source_url_id: string; target_url: string; target_normalized_url: string | null;
    is_external: boolean; is_broken: boolean; http_status: number | null; anchor_text: string | null; rel: string | null;
  }[] = [];
  for (let from = 0; ; from += FETCH_CHUNK) {
    const { data, error } = await sb
      .from('seo_link_edges')
      .select('source_url_id, target_url, target_normalized_url, is_external, is_broken, http_status, anchor_text, rel')
      .eq('workspace_id', args.workspaceId)
      .eq('site_id', args.siteId)
      .eq('last_seen_crawl_id', args.crawlId)
      .range(from, from + FETCH_CHUNK - 1);
    if (error || !data || data.length === 0) break;
    edges.push(...(data as typeof edges));
    if (data.length < FETCH_CHUNK) break;
  }
  if (edges.length === 0) return getLegacyCrawlLinks(config, args.crawlId);

  const sourceIds = Array.from(new Set(edges.map((e) => e.source_url_id)));
  const urlById = new Map<string, string>();
  for (let i = 0; i < sourceIds.length; i += CHUNK) {
    const { data } = await sb.from('seo_urls').select('id, normalized_url').in('id', sourceIds.slice(i, i + CHUNK));
    for (const row of ((data || []) as { id: string; normalized_url: string }[])) urlById.set(row.id, row.normalized_url);
  }

  return edges.map((e) => ({
    sourceUrl: urlById.get(e.source_url_id) || '',
    targetUrl: e.target_url,
    targetNormalizedUrl: e.target_normalized_url,
    isExternal: e.is_external,
    isBroken: e.is_broken,
    httpStatus: e.http_status,
    anchorText: e.anchor_text,
    rel: e.rel,
  }));
}

async function getLegacyCrawlLinks(config: ServerConfig, crawlId: string): Promise<CanonicalLinkRow[]> {
  const sb = getServiceClient(config);
  const out: CanonicalLinkRow[] = [];
  for (let from = 0; ; from += FETCH_CHUNK) {
    const { data, error } = await sb
      .from('seo_links')
      .select('target_url, target_normalized_url, is_external, is_broken, http_status, anchor_text, rel, source_page:source_page_id(url)')
      .eq('crawl_id', crawlId)
      .range(from, from + FETCH_CHUNK - 1);
    if (error || !data || data.length === 0) break;
    for (const row of data as Record<string, unknown>[]) {
      out.push({
        sourceUrl: ((row.source_page as { url?: string } | null)?.url) || '',
        targetUrl: row.target_url as string,
        targetNormalizedUrl: (row.target_normalized_url as string | null) ?? null,
        isExternal: row.is_external === true,
        isBroken: row.is_broken === true,
        httpStatus: (row.http_status as number | null) ?? null,
        anchorText: (row.anchor_text as string | null) ?? null,
        rel: (row.rel as string | null) ?? null,
      });
    }
    if (data.length < FETCH_CHUNK) break;
  }
  return out;
}

/** Compact per-crawl summary — survives detail pruning, powers history charts. */
export async function persistCrawlSummary(
  config: ServerConfig,
  args: {
    crawlId: string; workspaceId: string; siteId: string;
    urlsDiscovered: number; urlsCrawled: number; urlsFailed: number;
    internalLinks: number; externalLinks: number;
    issueCounts?: Record<string, unknown>; durationMs?: number | null;
  },
): Promise<void> {
  const sb = getServiceClient(config);
  const pages = await getCrawlPages(config, args.crawlId);

  const counts = { new: 0, changed: 0, unchanged: 0, removed: 0, restored: 0 } as Record<string, number>;
  const statusDistribution: Record<string, number> = {};
  let indexable = 0;
  let nonIndexable = 0;

  const { data: memberships } = await sb.from('seo_crawl_url_membership').select('state').eq('crawl_id', args.crawlId);
  for (const row of ((memberships || []) as { state: string }[])) counts[row.state] = (counts[row.state] || 0) + 1;

  for (const page of pages) {
    const status = page.page.http_status as number | null;
    const bucket = status === null || status === undefined ? 'unknown' : `${Math.floor(status / 100)}xx`;
    statusDistribution[bucket] = (statusDistribution[bucket] || 0) + 1;
    if (page.page.is_indexable === false) nonIndexable++; else indexable++;
  }

  await sb.from('seo_crawl_summaries').upsert(
    {
      crawl_id: args.crawlId,
      workspace_id: args.workspaceId,
      site_id: args.siteId,
      urls_discovered: args.urlsDiscovered,
      urls_crawled: args.urlsCrawled,
      urls_failed: args.urlsFailed,
      urls_new: counts.new || 0,
      urls_changed: counts.changed || 0,
      urls_unchanged: counts.unchanged || 0,
      urls_removed: counts.removed || 0,
      urls_restored: counts.restored || 0,
      internal_links: args.internalLinks,
      external_links: args.externalLinks,
      status_distribution: statusDistribution,
      indexability: { indexable, non_indexable: nonIndexable },
      issue_counts: args.issueCounts || {},
      duration_ms: args.durationMs ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'crawl_id' },
  );
}

export async function getCrawlSummary(config: ServerConfig, crawlId: string): Promise<Record<string, unknown> | null> {
  const sb = getServiceClient(config);
  const { data } = await sb.from('seo_crawl_summaries').select('*').eq('crawl_id', crawlId).maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}

/** Canonical URL id for a URL already known to this site (no insert). */
export async function findUrlId(
  config: ServerConfig,
  args: { workspaceId: string; siteId: string; urlHash: string },
): Promise<string | null> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('seo_urls')
    .select('id')
    .eq('workspace_id', args.workspaceId)
    .eq('site_id', args.siteId)
    .eq('url_hash', args.urlHash)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}
