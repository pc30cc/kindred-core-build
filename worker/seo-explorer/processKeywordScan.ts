/**
 * SEO Site Explorer keyword-scan processing — calls
 * fetchRankedKeywordsForTarget (DataForSEO Labs Ranked Keywords, the real
 * "what does this domain rank for" report), normalizes the result into
 * `seo_explorer_keywords`, and finalizes `seo_explorer_keyword_scans`.
 * Mirrors worker/seo-keywords/processRun.ts's shape.
 */
import type { loadConfig } from '../../server/config.js';
import { heartbeatJob, completeJob, acknowledgeJobCancel } from '../../server/services/jobs/queue.js';
import { getServiceClient } from '../../server/supabase.js';
import { fetchRankedKeywordsForTarget } from '../../server/services/seo/keywords/index.js';
import { isKeywordsError } from '../../server/services/seo/keywords/types.js';
import type { SeoExplorerKeywordScanRow } from '../../server/services/seo/siteExplorerService.js';

const INSERT_CHUNK = 500;

function log(event: string, data: Record<string, unknown> = {}) {
  try { console.log(`[seo-explorer-keywords] ${event}`, JSON.stringify(data)); }
  catch { console.log(`[seo-explorer-keywords] ${event}`); }
}

export function classifyExplorerKeywordScanError(err: unknown): { category: string; message: string; retryable: boolean } {
  const message = (err as Error)?.message || String(err) || 'unknown_error';
  if (isKeywordsError(err)) {
    const retryable = err.code === 'keywords_timeout' || err.code === 'keywords_network_error' || err.code === 'keywords_rate_limited';
    return { category: err.code, message, retryable };
  }
  return { category: 'internal_error', message, retryable: true };
}

export async function processExplorerKeywordScan(
  config: ReturnType<typeof loadConfig>,
  jobId: string,
  scan: SeoExplorerKeywordScanRow,
  workerId: string,
  lockTtlSeconds: number,
): Promise<void> {
  const sb = getServiceClient(config);
  await sb.from('seo_explorer_keyword_scans').update({ status: 'running', started_at: new Date().toISOString(), progress_stage: 'fetching' }).eq('id', scan.id);

  const hb = await heartbeatJob(config, { jobId, workerId, lockTtlSeconds, progress: 20, progressStage: 'fetching', status: 'processing' });
  if (hb.cancelRequested) {
    await sb.from('seo_explorer_keyword_scans').update({ status: 'cancelled', finished_at: new Date().toISOString(), progress_stage: 'cancelled' }).eq('id', scan.id);
    await acknowledgeJobCancel(config, jobId);
    log('scan cancelled', { scanId: scan.id, jobId });
    return;
  }

  const { result } = await fetchRankedKeywordsForTarget(config, scan.target_domain, scan.max_keywords);

  await heartbeatJob(config, { jobId, workerId, lockTtlSeconds, progress: 80, progressStage: 'saving', status: 'processing' });

  const rows = result.items.map((item) => ({
    scan_id: scan.id,
    workspace_id: scan.workspace_id,
    keyword: item.keyword,
    search_volume: item.searchVolume,
    cpc: item.cpc,
    competition: item.competition,
    position: item.position,
    ranking_url: item.rankingUrl,
    traffic_estimate: item.trafficEstimate,
  }));
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await sb.from('seo_explorer_keywords').insert(rows.slice(i, i + INSERT_CHUNK));
  }

  const totalTrafficEstimate = rows.reduce((sum, r) => sum + (r.traffic_estimate || 0), 0);

  await sb.from('seo_explorer_keyword_scans').update({
    status: 'completed',
    progress: 100,
    progress_stage: 'completed',
    total_keywords: result.items.length,
    total_traffic_estimate: totalTrafficEstimate,
    finished_at: new Date().toISOString(),
  }).eq('id', scan.id);

  await completeJob(config, { jobId });
  log('scan completed', { scanId: scan.id, jobId, totalKeywords: result.items.length });
}
