/**
 * THE canonical SEO URL repository (Phase 2).
 *
 * Every read/write of `seo_urls`, `seo_crawl_observations` and
 * `seo_crawl_url_membership` goes through this module — no direct queries to
 * those tables are allowed anywhere else, so the deduplication rules live in
 * exactly one place.
 *
 * Deduplication rules:
 *   - a URL is canonicalized ONCE (via the existing
 *     services/ai-agent/crawler/urlRules.ts `canonicalize`, never a second
 *     normalization implementation) and stored ONCE per (workspace, site).
 *   - a per-crawl OBSERVATION row is written only when the SEO-relevant state
 *     actually changed (or on first sight / removal / restore).
 *   - every crawled URL always gets a compact MEMBERSHIP row, so
 *     "was this URL in crawl X?" stays answerable without a payload copy.
 *
 * The legacy `seo_pages`/`seo_links` writes are untouched and remain
 * authoritative for existing reports; this model is written in parallel
 * (see docs/DATA_RETENTION_AND_SEO_STORAGE.md for the cutover plan).
 */
import { createHash } from 'node:crypto';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export type UrlChangeType = 'new' | 'changed' | 'unchanged' | 'removed' | 'restored';

/** The SEO-relevant fields whose change makes an observation worth storing. */
export interface ObservationFields {
  statusCode: number | null;
  title: string | null;
  metaDescription: string | null;
  canonicalStatus: string | null;
  isIndexable: boolean;
  internalLinksCount: number;
  externalLinksCount: number;
  incomingInternalLinksCount?: number;
  issueFlags?: Record<string, unknown>;
}

export function hashUrl(normalizedUrl: string): string {
  return createHash('md5').update(normalizedUrl).digest('hex');
}

/**
 * Deterministic content hash over the comparison-relevant fields only.
 * Field order is fixed here (never `JSON.stringify(object)` over an
 * arbitrarily-ordered object) so the hash is stable across releases.
 */
export function computeObservationHash(f: ObservationFields, payload: Record<string, unknown> = {}): string {
  const parts = [
    f.statusCode ?? '',
    f.title ?? '',
    f.metaDescription ?? '',
    f.canonicalStatus ?? '',
    f.isIndexable ? '1' : '0',
    String(f.internalLinksCount ?? 0),
    String(f.externalLinksCount ?? 0),
    JSON.stringify(stableValue(f.issueFlags || {})),
    JSON.stringify(stableValue(Object.fromEntries(Object.entries(payload).filter(([key]) => !VOLATILE_PAGE_FIELDS.has(key))))),
  ];
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

// Timing/discovery metrics belong to the crawl, not the content identity.
const VOLATILE_PAGE_FIELDS = new Set(['id', 'crawl_id', 'workspace_id', 'created_at', 'updated_at', 'crawled_at', 'response_time_ms', 'response_bytes', 'html_size_bytes', 'depth', 'discovered_via', 'incoming_internal_links_count']);

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

export interface RecordObservationArgs {
  config: ServerConfig;
  crawlId: string;
  workspaceId: string;
  siteId: string;
  normalizedUrl: string;
  observedAt?: string;
  fields: ObservationFields;
  payload?: Record<string, unknown>;
}

export interface RecordObservationResult {
  urlId: string;
  changeType: UrlChangeType;
  observationId: string | null;
  /** true when a full observation row was written (i.e. NOT deduplicated). */
  observationWritten: boolean;
}

/** Finds-or-creates the canonical URL row for this (workspace, site, url). */
export async function upsertSeoUrl(
  config: ServerConfig,
  args: { workspaceId: string; siteId: string; normalizedUrl: string; seenAt: string },
): Promise<string | null> {
  const sb = getServiceClient(config);
  const urlHash = hashUrl(args.normalizedUrl);

  const { data: existing } = await sb
    .from('seo_urls')
    .select('id')
    .eq('workspace_id', args.workspaceId)
    .eq('site_id', args.siteId)
    .eq('url_hash', urlHash)
    .maybeSingle();

  if (existing) return (existing as { id: string }).id;

  const { data, error } = await sb
    .from('seo_urls')
    .upsert(
      {
        workspace_id: args.workspaceId,
        site_id: args.siteId,
        normalized_url: args.normalizedUrl,
        url_hash: urlHash,
        first_seen_at: args.seenAt,
        last_seen_at: args.seenAt,
      },
      { onConflict: 'workspace_id,site_id,url_hash' },
    )
    .select('id')
    .maybeSingle();
  if (error) return null;
  return (data as { id: string } | null)?.id ?? null;
}

/** Most recent observation for this URL from any EARLIER crawl. */
async function previousObservation(
  config: ServerConfig,
  urlId: string,
  crawlId: string,
): Promise<{ id: string; observation_hash: string; change_type: UrlChangeType } | null> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('seo_crawl_observations')
    .select('id, observation_hash, change_type, observed_at, crawl_id')
    .eq('url_id', urlId)
    .neq('crawl_id', crawlId)
    .order('observed_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { id: string; observation_hash: string; change_type: UrlChangeType } | null) ?? null;
}

export async function recordObservation(args: RecordObservationArgs): Promise<RecordObservationResult | null> {
  const { config, crawlId, workspaceId, siteId, normalizedUrl, fields } = args;
  const sb = getServiceClient(config);
  const observedAt = args.observedAt || new Date().toISOString();

  const urlId = await upsertSeoUrl(config, { workspaceId, siteId, normalizedUrl, seenAt: observedAt });
  if (!urlId) return null;

  const hash = computeObservationHash(fields, args.payload);
  const prev = await previousObservation(config, urlId, crawlId);

  let changeType: UrlChangeType;
  if (!prev) changeType = 'new';
  else if (prev.change_type === 'removed') changeType = 'restored';
  else if (prev.observation_hash === hash) changeType = 'unchanged';
  else changeType = 'changed';

  let observationId: string | null = null;
  const observationWritten = changeType !== 'unchanged';

  if (observationWritten) {
    const { data } = await sb
      .from('seo_crawl_observations')
      .upsert(
        {
          crawl_id: crawlId,
          url_id: urlId,
          workspace_id: workspaceId,
          site_id: siteId,
          observed_at: observedAt,
          status_code: fields.statusCode,
          title: fields.title,
          meta_description: fields.metaDescription,
          canonical_status: fields.canonicalStatus,
          is_indexable: fields.isIndexable,
          internal_links_count: fields.internalLinksCount,
          external_links_count: fields.externalLinksCount,
          incoming_internal_links_count: fields.incomingInternalLinksCount ?? 0,
          issue_flags: fields.issueFlags || {},
          observation_hash: hash,
          changed: true,
          change_type: changeType,
          payload: args.payload || {},
        },
        { onConflict: 'crawl_id,url_id' },
      )
      .select('id')
      .maybeSingle();
    observationId = (data as { id: string } | null)?.id ?? null;
  }

  await sb.from('seo_crawl_url_membership').upsert(
    {
      crawl_id: crawlId,
      url_id: urlId,
      workspace_id: workspaceId,
      site_id: siteId,
      state: changeType,
      changed: observationWritten,
      status_code: fields.statusCode,
      observation_id: observationId,
      effective_observation_id: observationId ?? prev?.id ?? null,
      observed_at: observedAt,
    },
    { onConflict: 'crawl_id,url_id' },
  );

  await sb
    .from('seo_urls')
    .update({
      last_seen_at: observedAt,
      is_active: true,
      disappeared_at: null,
      last_successful_crawl_id: crawlId,
    })
    .eq('id', urlId);

  return { urlId, changeType, observationId, observationWritten };
}

/**
 * Post-crawl pass: any URL that was active for this site but absent from this
 * crawl is recorded as `removed` exactly once. The canonical `seo_urls` row
 * is NEVER deleted — it keeps first_seen_at/last_seen_at and its last known
 * state so the history question "when did it disappear?" stays answerable.
 */
export async function finalizeCrawlUrlModel(
  config: ServerConfig,
  args: { crawlId: string; workspaceId: string; siteId: string },
): Promise<{ removed: number }> {
  const sb = getServiceClient(config);
  const observedAt = new Date().toISOString();

  const present = new Set<string>();
  const CHUNK = 1000;
  for (let from = 0; ; from += CHUNK) {
    const { data, error } = await sb
      .from('seo_crawl_url_membership')
      .select('url_id')
      .eq('crawl_id', args.crawlId)
      .range(from, from + CHUNK - 1);
    if (error || !data || data.length === 0) break;
    for (const row of data as { url_id: string }[]) present.add(row.url_id);
    if (data.length < CHUNK) break;
  }

  const { data: active } = await sb
    .from('seo_urls')
    .select('id, normalized_url')
    .eq('workspace_id', args.workspaceId)
    .eq('site_id', args.siteId)
    .eq('is_active', true);

  const gone = ((active || []) as { id: string }[]).filter((u) => !present.has(u.id));
  if (gone.length === 0) return { removed: 0 };

  for (let i = 0; i < gone.length; i += 500) {
    const chunk = gone.slice(i, i + 500);
    const { data: inserted } = await sb
      .from('seo_crawl_observations')
      .upsert(
        chunk.map((u) => ({
          crawl_id: args.crawlId,
          url_id: u.id,
          workspace_id: args.workspaceId,
          site_id: args.siteId,
          observed_at: observedAt,
          status_code: null,
          observation_hash: 'removed',
          changed: true,
          change_type: 'removed' as const,
          is_indexable: false,
        })),
        { onConflict: 'crawl_id,url_id' },
      )
      .select('id, url_id');

    const byUrl = new Map<string, string>();
    for (const row of ((inserted || []) as { id: string; url_id: string }[])) byUrl.set(row.url_id, row.id);

    await sb.from('seo_crawl_url_membership').upsert(
      chunk.map((u) => ({
        crawl_id: args.crawlId,
        url_id: u.id,
        workspace_id: args.workspaceId,
        site_id: args.siteId,
        state: 'removed' as const,
        changed: true,
        status_code: null,
        observation_id: byUrl.get(u.id) ?? null,
        effective_observation_id: byUrl.get(u.id) ?? null,
        observed_at: observedAt,
      })),
      { onConflict: 'crawl_id,url_id' },
    );

    for (const u of chunk) {
      await sb.from('seo_urls').update({ is_active: false, disappeared_at: observedAt }).eq('id', u.id);
    }
  }

  return { removed: gone.length };
}

/** Crawl-to-crawl delta, straight off the compact membership table. */
export async function compareCrawlUrlSets(
  config: ServerConfig,
  args: { workspaceId: string; crawlId: string; previousCrawlId: string },
): Promise<{ discovered: number; removed: number; changed: number; unchanged: number; total: number }> {
  const sb = getServiceClient(config);
  const [{ data: cur }, { data: prev }] = await Promise.all([
    sb.from('seo_crawl_url_membership').select('url_id, state, changed').eq('crawl_id', args.crawlId).eq('workspace_id', args.workspaceId),
    sb.from('seo_crawl_url_membership').select('url_id').eq('crawl_id', args.previousCrawlId).eq('workspace_id', args.workspaceId),
  ]);
  const current = (cur || []) as { url_id: string; state: UrlChangeType; changed: boolean }[];
  const prevIds = new Set(((prev || []) as { url_id: string }[]).map((r) => r.url_id));
  const currentIds = new Set(current.filter((r) => r.state !== 'removed').map((r) => r.url_id));

  return {
    discovered: current.filter((r) => r.state !== 'removed' && !prevIds.has(r.url_id)).length,
    removed: Array.from(prevIds).filter((id) => !currentIds.has(id)).length,
    changed: current.filter((r) => r.state === 'changed' || r.state === 'restored').length,
    unchanged: current.filter((r) => r.state === 'unchanged').length,
    total: currentIds.size,
  };
}

/** Super Admin SEO diagnostics — storage-efficiency counters. */
export async function getSeoStorageMetrics(config: ServerConfig): Promise<Record<string, unknown>> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('seo_storage_metrics');
  if (error) throw new Error(`seo_storage_metrics_failed: ${error.message}`);
  return (data as Record<string, unknown>) || {};
}

/** Bounded, idempotent backfill of the new model from legacy `seo_pages`. */
export async function backfillUrlModel(
  config: ServerConfig,
  maxCrawls = 25,
): Promise<{ crawlsProcessed: number; urlsCreated: number; membershipsCreated: number }> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('seo_backfill_url_model', { _max_crawls: maxCrawls });
  if (error) throw new Error(`seo_backfill_failed: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as
    | { crawls_processed: number; urls_created: number; memberships_created: number }
    | null;
  return {
    crawlsProcessed: Number(row?.crawls_processed || 0),
    urlsCreated: Number(row?.urls_created || 0),
    membershipsCreated: Number(row?.memberships_created || 0),
  };
}
