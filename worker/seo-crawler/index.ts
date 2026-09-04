/**
 * SEO crawl worker — polls `background_jobs` for `job_type = 'seo_crawl'`,
 * runs the crawl, normalizes results, evaluates SEO rules, computes the
 * score, and finalizes the `seo_crawls` row.
 *
 * Deployment: one Coolify service built from the SAME shared Dockerfile.worker
 * image as every other worker kind, with WORKER_KIND=seo-crawler. No public
 * port, no HTTP healthcheck — see docs/SEO_AUDIT.md for the full deployment
 * contract (env vars, resource limits, graceful shutdown).
 *
 * SECRETS: this process only ever needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 * (same as every other worker) — it never receives platform secrets it
 * doesn't use. Core (the Express API) remains the actual authorization
 * boundary; this worker trusts the `seo_crawls` row it claims because Core
 * is the only thing that ever creates one.
 */
import { loadConfig } from '../../server/config.js';
import { claimNextJob, heartbeatJob, completeJob, failJob, acknowledgeJobCancel } from '../../server/services/jobs/queue.js';
import { getServiceClient } from '../../server/supabase.js';
import { crawlSite } from '../../server/services/seo/crawler/crawlSite.js';
import { finalizeLinkGraph } from '../../server/services/seo/crawler/linkGraph.js';
import { evaluateAndPersistIssues } from '../../server/services/seo/rules/engine.js';
import { computeSeoScore } from '../../server/services/seo/scoring/score.js';
import type { SeoCrawlLimits } from '../../server/services/seo/limits.js';
import type { SeoCrawlRow } from '../../server/services/seo/crawlService.js';

const POLL_INTERVAL_MS = parseInt(process.env.SEO_WORKER_INTERVAL_MS || process.env.WORKER_INTERVAL_MS || '5000', 10);
const LOCK_TTL_SECONDS = parseInt(process.env.SEO_WORKER_LOCK_TTL_SECONDS || '120', 10);
const WORKER_ID = process.env.WORKER_ID || `seo-crawler-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

function log(event: string, data: Record<string, unknown> = {}) {
  try { console.log(`[seo-crawler-worker] ${event}`, JSON.stringify(data)); }
  catch { console.log(`[seo-crawler-worker] ${event}`); }
}

/** Normalizes any thrown/returned failure into the fixed observability categories. */
function classifyError(err: unknown): { category: string; message: string; retryable: boolean } {
  const message = (err as Error)?.message || String(err) || 'unknown_error';
  if (message.includes('site_not_found') || message.includes('invalid_site_domain')) {
    return { category: 'invalid_target', message, retryable: false };
  }
  if (message.includes('blocked_host') || message.includes('unsafe_url')) {
    return { category: 'blocked_target', message, retryable: false };
  }
  if (message.includes('dns_failure')) return { category: 'dns_failure', message, retryable: true };
  if (message.includes('timeout')) return { category: 'timeout', message, retryable: true };
  if (message.includes('ECONNREFUSED') || message.includes('fetch_error')) return { category: 'connection_failure', message, retryable: true };
  return { category: 'internal_error', message, retryable: true };
}

export async function processCrawl(config: ReturnType<typeof loadConfig>, jobId: string, crawl: SeoCrawlRow): Promise<void> {
  const sb = getServiceClient(config);
  await sb.from('seo_crawls').update({ status: 'running', started_at: new Date().toISOString(), progress_stage: 'preparing' }).eq('id', crawl.id);

  const limits = crawl.limits as unknown as SeoCrawlLimits;
  const result = await crawlSite({
    config,
    crawlId: crawl.id,
    workspaceId: crawl.workspace_id,
    canonicalUrl: crawl.canonical_url,
    userAgent: crawl.user_agent,
    respectRobots: crawl.respect_robots,
    limits,
    jobId,
    workerId: WORKER_ID,
  });

  await sb.from('seo_crawls').update({
    pages_discovered: result.pagesDiscovered,
    pages_crawled: result.pagesCrawled,
    pages_failed: result.pagesFailed,
    pages_skipped: result.pagesSkipped,
    robots_summary: result.robotsSummary,
    sitemap_summary: result.sitemapSummary,
  }).eq('id', crawl.id);

  if (result.cancelled) {
    await sb.from('seo_crawls').update({ status: 'cancelled', finished_at: new Date().toISOString(), progress_stage: 'cancelled' }).eq('id', crawl.id);
    await acknowledgeJobCancel(config, jobId);
    log('crawl cancelled', { crawlId: crawl.id, jobId });
    return;
  }

  await heartbeatJob(config, { jobId, workerId: WORKER_ID, lockTtlSeconds: LOCK_TTL_SECONDS, progress: 92, progressStage: 'analyzing', status: 'processing' });
  await finalizeLinkGraph(config, crawl.id);

  await heartbeatJob(config, { jobId, workerId: WORKER_ID, lockTtlSeconds: LOCK_TTL_SECONDS, progress: 95, progressStage: 'calculating_score', status: 'processing' });
  const evalResult = await evaluateAndPersistIssues(config, {
    crawlId: crawl.id,
    workspaceId: crawl.workspace_id,
    websiteId: crawl.website_id,
    crawlCreatedAt: crawl.created_at,
    sitemapSampleUrls: (result.sitemapSummary as any).sampleUrls || [],
    crawledButMissingFromSitemapCount: result.sitemapSummary.crawledButMissingFromSitemap,
    sitemapUrlsNotCrawledCount: result.sitemapSummary.sitemapUrlsNotCrawled,
  });

  const scoreResult = computeSeoScore(evalResult.scoreInputIssues as any, evalResult.totalPages);

  await heartbeatJob(config, { jobId, workerId: WORKER_ID, lockTtlSeconds: LOCK_TTL_SECONDS, progress: 99, progressStage: 'saving', status: 'processing' });
  await sb.from('seo_crawls').update({
    status: 'completed',
    progress: 100,
    progress_stage: 'completed',
    score: scoreResult.score,
    score_version: scoreResult.scoreVersion,
    score_breakdown: { totalPenalty: scoreResult.totalPenalty, entries: scoreResult.breakdown },
    finished_at: new Date().toISOString(),
  }).eq('id', crawl.id);

  await completeJob(config, { jobId });
  log('crawl completed', { crawlId: crawl.id, jobId, score: scoreResult.score, pagesCrawled: result.pagesCrawled, issues: evalResult.issueCount });
}

let shuttingDown = false;
let inFlight = 0;

async function tick(config: ReturnType<typeof loadConfig>): Promise<void> {
  if (shuttingDown) return;
  const job = await claimNextJob(config, { jobTypes: ['seo_crawl'], workerId: WORKER_ID, lockTtlSeconds: LOCK_TTL_SECONDS });
  if (!job) return;

  inFlight++;
  const sb = getServiceClient(config);
  try {
    const { data: crawl } = await sb.from('seo_crawls').select('*').eq('job_id', job.id).maybeSingle();
    if (!crawl) {
      await failJob(config, { jobId: job.id, errorMessage: 'seo_crawls_row_missing', errorCategory: 'internal_error', retryable: false });
      return;
    }
    await processCrawl(config, job.id, crawl as SeoCrawlRow);
  } catch (err) {
    const { category, message, retryable } = classifyError(err);
    log('crawl failed', { jobId: job.id, category, message });
    await failJob(config, { jobId: job.id, errorMessage: message, errorCategory: category, retryable });
    await sb.from('seo_crawls').update({ status: 'failed', error_message: message.slice(0, 1000), error_category: category, finished_at: new Date().toISOString() }).eq('job_id', job.id).in('status', ['queued', 'running', 'processing']);
  } finally {
    inFlight--;
  }
}

let started = false;
let timer: NodeJS.Timeout | null = null;

export function startSeoCrawlerWorker(): void {
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
if (isMain) startSeoCrawlerWorker();
