/**
 * SEO backlink scan worker — polls `background_jobs` for
 * `job_type = 'seo_backlink_scan'`, calls the pluggable backlinks provider
 * (server/services/seo/backlinks/) for the scan's target URL, normalizes the
 * result into `seo_backlinks`, and finalizes the `seo_backlink_scans` row.
 *
 * Deployment: same shared Dockerfile.worker image as every other worker
 * kind, with WORKER_KIND=seo-backlinks (or combined with seo-crawler in one
 * container — see worker/index.ts). No public port, no HTTP healthcheck.
 *
 * SECRETS: this process needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (same
 * as every other worker) to read the platform backlinks-provider credential
 * from `platform_backlinks_provider_config` via the service client — it
 * never receives the vendor credential through any other channel.
 *
 * Unlike the SEO crawler, a single backlink scan is ONE vendor HTTP call
 * (DataForSEO's "live" endpoint returns results synchronously) — no
 * multi-page crawl loop, no link graph, no rules engine.
 */
import { loadConfig } from '../../server/config.js';
import { claimNextJob, heartbeatJob, completeJob, failJob, acknowledgeJobCancel } from '../../server/services/jobs/queue.js';
import { getServiceClient } from '../../server/supabase.js';
import { fetchBacklinksForTarget } from '../../server/services/seo/backlinks/index.js';
import { isBacklinksError } from '../../server/services/seo/backlinks/types.js';
import type { SeoBacklinkScanRow } from '../../server/services/seo/backlinkService.js';

const POLL_INTERVAL_MS = parseInt(process.env.SEO_BACKLINKS_WORKER_INTERVAL_MS || process.env.WORKER_INTERVAL_MS || '5000', 10);
const LOCK_TTL_SECONDS = parseInt(process.env.SEO_BACKLINKS_WORKER_LOCK_TTL_SECONDS || '120', 10);
const WORKER_ID = process.env.WORKER_ID || `seo-backlinks-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const INSERT_CHUNK = 500;

function log(event: string, data: Record<string, unknown> = {}) {
  try { console.log(`[seo-backlinks-worker] ${event}`, JSON.stringify(data)); }
  catch { console.log(`[seo-backlinks-worker] ${event}`); }
}

function classifyError(err: unknown): { category: string; message: string; retryable: boolean } {
  const message = (err as Error)?.message || String(err) || 'unknown_error';
  if (isBacklinksError(err)) {
    const retryable = err.code === 'backlinks_timeout' || err.code === 'backlinks_network_error' || err.code === 'backlinks_rate_limited';
    return { category: err.code, message, retryable };
  }
  return { category: 'internal_error', message, retryable: true };
}

export async function processBacklinkScan(config: ReturnType<typeof loadConfig>, jobId: string, scan: SeoBacklinkScanRow): Promise<void> {
  const sb = getServiceClient(config);
  await sb.from('seo_backlink_scans').update({ status: 'running', started_at: new Date().toISOString(), progress_stage: 'fetching' }).eq('id', scan.id);

  const hb = await heartbeatJob(config, { jobId, workerId: WORKER_ID, lockTtlSeconds: LOCK_TTL_SECONDS, progress: 20, progressStage: 'fetching', status: 'processing' });
  if (hb.cancelRequested) {
    await sb.from('seo_backlink_scans').update({ status: 'cancelled', finished_at: new Date().toISOString(), progress_stage: 'cancelled' }).eq('id', scan.id);
    await acknowledgeJobCancel(config, jobId);
    log('scan cancelled', { scanId: scan.id, jobId });
    return;
  }

  const { result } = await fetchBacklinksForTarget(config, scan.target_url, scan.max_backlinks);

  await heartbeatJob(config, { jobId, workerId: WORKER_ID, lockTtlSeconds: LOCK_TTL_SECONDS, progress: 80, progressStage: 'saving', status: 'processing' });

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

let shuttingDown = false;
let inFlight = 0;

async function tick(config: ReturnType<typeof loadConfig>): Promise<void> {
  if (shuttingDown) return;
  const job = await claimNextJob(config, { jobTypes: ['seo_backlink_scan'], workerId: WORKER_ID, lockTtlSeconds: LOCK_TTL_SECONDS });
  if (!job) return;

  inFlight++;
  const sb = getServiceClient(config);
  try {
    const { data: scan } = await sb.from('seo_backlink_scans').select('*').eq('job_id', job.id).maybeSingle();
    if (!scan) {
      await failJob(config, { jobId: job.id, errorMessage: 'seo_backlink_scans_row_missing', errorCategory: 'internal_error', retryable: false });
      return;
    }
    await processBacklinkScan(config, job.id, scan as SeoBacklinkScanRow);
  } catch (err) {
    const { category, message, retryable } = classifyError(err);
    log('scan failed', { jobId: job.id, category, message });
    await failJob(config, { jobId: job.id, errorMessage: message, errorCategory: category, retryable });
    await sb.from('seo_backlink_scans').update({ status: 'failed', error_message: message.slice(0, 1000), error_category: category, finished_at: new Date().toISOString() }).eq('job_id', job.id).in('status', ['queued', 'running', 'processing']);
  } finally {
    inFlight--;
  }
}

let started = false;
let timer: NodeJS.Timeout | null = null;

export function startSeoBacklinksWorker(): void {
  if (started) return;
  started = true;
  const config = loadConfig();
  log('started', { workerId: WORKER_ID, pollIntervalMs: POLL_INTERVAL_MS });

  const run = () => tick(config).catch((e) => log('tick error', { error: (e as Error)?.message }));
  run();
  timer = setInterval(run, POLL_INTERVAL_MS);

  const shutdown = async (signal: string) => {
    log('shutdown requested', { signal, inFlight });
    shuttingDown = true;
    if (timer) clearInterval(timer);
    const deadline = Date.now() + 30_000;
    while (inFlight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
    }
    log('shutdown complete', { inFlight });
    process.exit(0);
  };
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
}

const isMain = (() => {
  try {
    const u = new URL(import.meta.url);
    return process.argv[1] && u.pathname.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() || '');
  } catch { return false; }
})();
if (isMain) startSeoBacklinksWorker();
