/**
 * Post-crawl link-graph finalization: resolves `seo_links.target_page_id`
 * for internal links against the pages actually crawled in THIS crawl, marks
 * broken internal links, and backfills each page's
 * `incoming_internal_links_count`. External links are left exactly as
 * recorded (never fetched, never validated) — this pass only ever touches
 * `is_external = false` rows.
 */
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';

const PAGE_FETCH_CHUNK = 1000;
const UPDATE_CHUNK = 500;

export async function finalizeLinkGraph(config: ServerConfig, crawlId: string): Promise<void> {
  const sb = getServiceClient(config);

  const pageByUrl = new Map<string, { id: string; httpStatus: number | null }>();
  let from = 0;
  for (;;) {
    const { data, error } = await sb
      .from('seo_pages')
      .select('id, normalized_url, http_status')
      .eq('crawl_id', crawlId)
      .range(from, from + PAGE_FETCH_CHUNK - 1);
    if (error || !data || data.length === 0) break;
    for (const row of data as { id: string; normalized_url: string; http_status: number | null }[]) {
      pageByUrl.set(row.normalized_url, { id: row.id, httpStatus: row.http_status });
    }
    if (data.length < PAGE_FETCH_CHUNK) break;
    from += PAGE_FETCH_CHUNK;
  }

  const incomingCounts = new Map<string, number>();
  const linkUpdates: { id: string; target_page_id: string | null; http_status: number | null; is_broken: boolean }[] = [];

  from = 0;
  for (;;) {
    const { data, error } = await sb
      .from('seo_links')
      .select('id, target_normalized_url')
      .eq('crawl_id', crawlId)
      .eq('is_external', false)
      .range(from, from + PAGE_FETCH_CHUNK - 1);
    if (error || !data || data.length === 0) break;
    for (const row of data as { id: string; target_normalized_url: string | null }[]) {
      const target = row.target_normalized_url ? pageByUrl.get(row.target_normalized_url) : undefined;
      if (target) {
        incomingCounts.set(target.id, (incomingCounts.get(target.id) || 0) + 1);
        const isBroken = target.httpStatus === null || target.httpStatus >= 400;
        linkUpdates.push({ id: row.id, target_page_id: target.id, http_status: target.httpStatus, is_broken: isBroken });
      }
    }
    if (data.length < PAGE_FETCH_CHUNK) break;
    from += PAGE_FETCH_CHUNK;
  }

  for (let i = 0; i < linkUpdates.length; i += UPDATE_CHUNK) {
    const chunk = linkUpdates.slice(i, i + UPDATE_CHUNK);
    await Promise.all(
      chunk.map((u) =>
        sb.from('seo_links').update({ target_page_id: u.target_page_id, http_status: u.http_status, is_broken: u.is_broken }).eq('id', u.id),
      ),
    );
  }

  const pageIds = Array.from(incomingCounts.keys());
  for (let i = 0; i < pageIds.length; i += UPDATE_CHUNK) {
    const chunk = pageIds.slice(i, i + UPDATE_CHUNK);
    await Promise.all(
      chunk.map((id) => sb.from('seo_pages').update({ incoming_internal_links_count: incomingCounts.get(id) || 0 }).eq('id', id)),
    );
  }
}
