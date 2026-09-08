/**
 * SEO backlink scan processing — calls the pluggable backlinks provider
 * (server/services/seo/backlinks/) for a scan's target URL, normalizes the
 * result into `seo_backlinks`, and finalizes the `seo_backlink_scans` row.
 *
 * Pure processing logic, no polling loop: this runs inside the SAME worker
 * process/container as the SEO crawler (worker/seo-crawler/index.ts claims
 * both `seo_crawl` and `seo_backlink_scan` jobs from one poller and
 * dispatches here) — a backlink scan is one vendor HTTP call, far lighter
 * than a multi-page crawl, so it doesn't warrant its own container.
 *
 * SECRETS: needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (same as the
 * crawler) to read the platform backlinks-provider credential from
 * `platform_backlinks_provider_config` via the service client — it never
 * receives the vendor credential through any other channel.
 */
import type { loadConfig } from '../../server/config.js';
import { heartbeatJob, completeJob, acknowledgeJobCancel } from '../../server/services/jobs/queue.js';
import { getServiceClient } from '../../server/supabase.js';
import { fetchBacklinksForTarget } from '../../server/services/seo/backlinks/index.js';
import { isBacklinksError } from '../../server/services/seo/backlinks/types.js';
import type { SeoBacklinkScanRow } from '../../server/services/seo/backlinkService.js';

const INSERT_CHUNK = 500;

function log(event: string, data: Record<string, unknown> = {}) {
  try { console.log(`[seo-backlinks] ${event}`, JSON.stringify(data)); }
  catch { console.log(`[seo-backlinks] ${event}`); }
}

export function classifyBacklinkScanError(err: unknown): { category: string; message: string; retryable: boolean } {
  const message = (err as Error)?.message || String(err) || 'unknown_error';
  if (isBacklinksError(err)) {
    const retryable = err.code === 'backlinks_timeout' || err.code === 'backlinks_network_error' || err.code === 'backlinks_rate_limited';
    return { category: err.code, message, retryable };
  }
  return { category: 'internal_error', message, retryable: true };
}

export async function processBacklinkScan(
  config: ReturnType<typeof loadConfig>,
  jobId: string,
  scan: SeoBacklinkScanRow,
  workerId: string,
  lockTtlSeconds: number,
): Promise<void> {
  const sb = getServiceClient(config);
  await sb.from('seo_backlink_scans').update({ status: 'running', started_at: new Date().toISOString(), progress_stage: 'fetching' }).eq('id', scan.id);

  const hb = await heartbeatJob(config, { jobId, workerId, lockTtlSeconds, progress: 20, progressStage: 'fetching', status: 'processing' });
  if (hb.cancelRequested) {
    await sb.from('seo_backlink_scans').update({ status: 'cancelled', finished_at: new Date().toISOString(), progress_stage: 'cancelled' }).eq('id', scan.id);
    await acknowledgeJobCancel(config, jobId);
    log('scan cancelled', { scanId: scan.id, jobId });
    return;
  }

  const { result } = await fetchBacklinksForTarget(config, scan.target_url, scan.max_backlinks);

  await heartbeatJob(config, { jobId, workerId, lockTtlSeconds, progress: 80, progressStage: 'saving', status: 'processing' });

  const rows = result.items.map((item) => ({
    scan_id: scan.id,
    workspace_id: scan.workspace_id,
    website_id: scan.website_id,
    source_url: item.sourceUrl,
    source_domain: item.sourceDomain,
    target_url: item.targetUrl,
    anchor_text: item.anchorText,
    is_dofollow: item.isDofollow,
    is_new: item.isNew,
    is_lost: item.isLost,
    page_rank: item.pageRank,
    domain_rank: item.domainRank,
    spam_score: item.spamScore,
    first_seen: item.firstSeen,
    last_seen: item.lastSeen,
  }));
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await sb.from('seo_backlinks').insert(rows.slice(i, i + INSERT_CHUNK));
  }

  await sb.from('seo_backlink_scans').update({
    status: 'completed',
    progress: 100,
    progress_stage: 'completed',
    total_backlinks: result.totalCount,
    referring_domains: result.referringDomains,
    dofollow_count: result.dofollowCount,
    nofollow_count: result.nofollowCount,
    new_backlinks: result.newCount,
    lost_backlinks: result.lostCount,
    finished_at: new Date().toISOString(),
  }).eq('id', scan.id);

  await completeJob(config, { jobId });
  log('scan completed', { scanId: scan.id, jobId, totalBacklinks: result.totalCount, referringDomains: result.referringDomains });
}
