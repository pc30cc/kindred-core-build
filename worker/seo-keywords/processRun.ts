/**
 * SEO keyword research processing — calls the pluggable keyword-data
 * provider (server/services/seo/keywords/) for a run's seed keywords,
 * normalizes the result into `seo_keyword_results`, and finalizes the
 * `seo_keyword_research_runs` row. Mirrors
 * worker/seo-backlinks/processScan.ts's shape exactly: pure processing
 * logic, no polling loop — dispatched from the SAME unified worker process
 * as the SEO crawler (worker/seo-crawler/index.ts).
 */
import type { loadConfig } from '../../server/config.js';
import { heartbeatJob, completeJob, acknowledgeJobCancel } from '../../server/services/jobs/queue.js';
import { getServiceClient } from '../../server/supabase.js';
import { fetchKeywordDataForSeeds } from '../../server/services/seo/keywords/index.js';
import { isKeywordsError } from '../../server/services/seo/keywords/types.js';
import type { SeoKeywordResearchRunRow } from '../../server/services/seo/keywordResearchService.js';

const INSERT_CHUNK = 500;

function log(event: string, data: Record<string, unknown> = {}) {
  try { console.log(`[seo-keywords] ${event}`, JSON.stringify(data)); }
  catch { console.log(`[seo-keywords] ${event}`); }
}

export function classifyKeywordRunError(err: unknown): { category: string; message: string; retryable: boolean } {
  const message = (err as Error)?.message || String(err) || 'unknown_error';
  if (isKeywordsError(err)) {
    const retryable = err.code === 'keywords_timeout' || err.code === 'keywords_network_error' || err.code === 'keywords_rate_limited';
    return { category: err.code, message, retryable };
  }
  return { category: 'internal_error', message, retryable: true };
}

export async function processKeywordResearchRun(
  config: ReturnType<typeof loadConfig>,
  jobId: string,
  run: SeoKeywordResearchRunRow,
  workerId: string,
  lockTtlSeconds: number,
): Promise<void> {
  const sb = getServiceClient(config);
  await sb.from('seo_keyword_research_runs').update({ status: 'running', started_at: new Date().toISOString(), progress_stage: 'fetching' }).eq('id', run.id);

  const hb = await heartbeatJob(config, { jobId, workerId, lockTtlSeconds, progress: 20, progressStage: 'fetching', status: 'processing' });
  if (hb.cancelRequested) {
    await sb.from('seo_keyword_research_runs').update({ status: 'cancelled', finished_at: new Date().toISOString(), progress_stage: 'cancelled' }).eq('id', run.id);
    await acknowledgeJobCancel(config, jobId);
    log('run cancelled', { runId: run.id, jobId });
    return;
  }

  const { result } = await fetchKeywordDataForSeeds(config, run.seed_keywords);

  await heartbeatJob(config, { jobId, workerId, lockTtlSeconds, progress: 80, progressStage: 'saving', status: 'processing' });

  const seedSet = new Set(run.seed_keywords.map((k) => k.toLowerCase()));
  const rows = result.items.map((item) => ({
    run_id: run.id,
    workspace_id: run.workspace_id,
    website_id: run.website_id,
    keyword: item.keyword,
    search_volume: item.searchVolume,
    cpc: item.cpc,
    competition: item.competition,
    competition_level: item.competitionLevel,
    is_seed: seedSet.has(item.keyword.toLowerCase()),
  }));
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await sb.from('seo_keyword_results').insert(rows.slice(i, i + INSERT_CHUNK));
  }

  await sb.from('seo_keyword_research_runs').update({
    status: 'completed',
    progress: 100,
    progress_stage: 'completed',
    total_keywords: result.items.length,
    finished_at: new Date().toISOString(),
  }).eq('id', run.id);

  await completeJob(config, { jobId });
  log('run completed', { runId: run.id, jobId, totalKeywords: result.items.length });
}
