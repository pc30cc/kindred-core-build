/**
 * SEO crawl worker — polls `background_jobs` for SEVEN job types and
 * dispatches each to its own processor, all in one poller/one process:
 *   - `seo_crawl` — runs the crawl, normalizes results, evaluates SEO
 *     rules, computes the score, finalizes `seo_crawls`.
 *   - `seo_backlink_scan` — calls the pluggable backlinks provider,
 *     finalizes `seo_backlink_scans` (worker/seo-backlinks/processScan.ts).
 *   - `seo_keyword_research` — calls the pluggable keyword-data provider,
 *     finalizes `seo_keyword_research_runs` (worker/seo-keywords/processRun.ts).
 *   - `seo_performance_audit` — calls the pluggable performance provider once
 *     per selected page, finalizes `seo_performance_audits`
 *     (worker/seo-performance/processAudit.ts).
 *   - `seo_explorer_backlink_scan` / `seo_explorer_keyword_scan` /
 *     `seo_explorer_competitor_scan` — Site Explorer's arbitrary-domain
 *     lookups (worker/seo-explorer/process{BacklinkScan,KeywordScan,CompetitorScan}.ts).
 * Backlink scans and keyword lookups are a single vendor HTTP call, and a
 * performance audit is a small bounded batch of them — all far lighter than
 * a multi-page crawl, so they share this worker rather than needing their
 * own container. (Rank Tracking has no job type at all — it's a ticker, see
 * server/services/seo/rankTrackingTicker.ts.)
 *
 * Deployment: one Coolify service built from the SAME shared Dockerfile.worker
 * image as every other worker kind, with WORKER_KIND=seo-crawler. No public
 * port, no HTTP healthcheck — see docs/SEO_AUDIT.md for the full deployment
 * contract (env vars, resource limits, graceful shutdown).
 *
 * SECRETS: this process only ever needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 * (same as every other worker) — it never receives platform secrets it
 * doesn't use. Core (the Express API) remains the actual authorization
 * boundary; this worker trusts the `seo_crawls`/`seo_backlink_scans` row it
 * claims because Core is the only thing that ever creates one.
 */
import { loadConfig } from '../../server/config.js';
import { claimNextJob, heartbeatJob, completeJob, failJob, acknowledgeJobCancel } from '../../server/services/jobs/queue.js';
import { getServiceClient } from '../../server/supabase.js';
import { crawlSite } from '../../server/services/seo/crawler/crawlSite.js';
import { finalizeLinkGraph } from '../../server/services/seo/crawler/linkGraph.js';
import { finalizeCrawlUrlModel } from '../../server/services/seo/urlRepository.js';
import { finalizeCanonicalLinkGraph, persistCrawlSummary, getCrawlLinks, legacyWritesEnabled } from '../../server/services/seo/canonicalRepository.js';
import { evaluateAndPersistIssues } from '../../server/services/seo/rules/engine.js';
import { computeSeoScore } from '../../server/services/seo/scoring/score.js';
import type { SeoCrawlLimits } from '../../server/services/seo/limits.js';
import type { SeoCrawlRow } from '../../server/services/seo/crawlService.js';
import { processBacklinkScan, classifyBacklinkScanError } from '../seo-backlinks/processScan.js';
import type { SeoBacklinkScanRow } from '../../server/services/seo/backlinkService.js';
import { processKeywordResearchRun, classifyKeywordRunError } from '../seo-keywords/processRun.js';
import type { SeoKeywordResearchRunRow } from '../../server/services/seo/keywordResearchService.js';
import { processPerformanceAudit, classifyPerformanceAuditError } from '../seo-performance/processAudit.js';
import type { SeoPerformanceAuditRow } from '../../server/services/seo/performanceAuditService.js';
import { processExplorerBacklinkScan, classifyExplorerBacklinkScanError } from '../seo-explorer/processBacklinkScan.js';
import { processExplorerKeywordScan, classifyExplorerKeywordScanError } from '../seo-explorer/processKeywordScan.js';
import { processExplorerCompetitorScan, classifyExplorerCompetitorScanError } from '../seo-explorer/processCompetitorScan.js';
import type { SeoExplorerBacklinkScanRow, SeoExplorerKeywordScanRow, SeoExplorerCompetitorScanRow } from '../../server/services/seo/siteExplorerService.js';
import { IdleBackoff, IdleIntervalSkipper, intFromEnv } from '../../server/services/jobs/idleBackoff.js';

const POLL_INTERVAL_MS = intFromEnv(process.env.SEO_WORKER_INTERVAL_MS || process.env.WORKER_INTERVAL_MS, 5000, 1000, 60_000);
/** Ceiling for the idle poll: how long a new job may wait after a quiet spell. */
const MAX_IDLE_POLL_MS = intFromEnv(process.env.SEO_WORKER_MAX_IDLE_POLL_MS, 30_000, POLL_INTERVAL_MS, 300_000);
// NaN here made every claim's lock expiry an Invalid Date, which throws.
const LOCK_TTL_SECONDS = intFromEnv(process.env.SEO_WORKER_LOCK_TTL_SECONDS, 120, 30, 3600);
const WORKER_ID = process.env.WORKER_ID || `seo-crawler-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const JOB_TYPES = [
  'seo_crawl', 'seo_backlink_scan', 'seo_keyword_research', 'seo_performance_audit',
  'seo_explorer_backlink_scan', 'seo_explorer_keyword_scan', 'seo_explorer_competitor_scan',
];

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
    websiteId: crawl.website_id,
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
  // Canonical link graph is authoritative; the legacy finalizer only runs when
  // legacy duplicate writes were deliberately re-enabled as a rollback lever.
  await finalizeCanonicalLinkGraph(config, { crawlId: crawl.id, workspaceId: crawl.workspace_id, siteId: crawl.website_id });
  if (legacyWritesEnabled()) await finalizeLinkGraph(config, crawl.id);
  // Canonical URL model: flag URLs that were active for this site but absent
  // from this crawl as `removed` (never deletes the canonical seo_urls row).
  try {
    await finalizeCrawlUrlModel(config, { crawlId: crawl.id, workspaceId: crawl.workspace_id, siteId: crawl.website_id });
  } catch (err) {
    log('url model finalize failed', { crawlId: crawl.id, message: (err as Error)?.message });
  }

  await heartbeatJob(config, { jobId, workerId: WORKER_ID, lockTtlSeconds: LOCK_TTL_SECONDS, progress: 95, progressStage: 'calculating_score', status: 'processing' });
  const evalResult = await evaluateAndPersistIssues(config, {
    crawlId: crawl.id,
    workspaceId: crawl.workspace_id,
    websiteId: crawl.website_id,
    crawlCreatedAt: crawl.created_at,
    sitemapSampleUrls: (result.sitemapSummary as unknown as { sampleUrls?: string[] }).sampleUrls || [],
    crawledButMissingFromSitemapCount: result.sitemapSummary.crawledButMissingFromSitemap,
    sitemapUrlsNotCrawledCount: result.sitemapSummary.sitemapUrlsNotCrawled,
  });

  const scoreResult = computeSeoScore(evalResult.scoreInputIssues as Parameters<typeof computeSeoScore>[0], evalResult.totalPages);

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

  // Compact per-crawl summary: survives detail pruning and powers history.
  try {
    const edges = await getCrawlLinks(config, { crawlId: crawl.id, workspaceId: crawl.workspace_id, siteId: crawl.website_id });
    await persistCrawlSummary(config, {
      crawlId: crawl.id,
      workspaceId: crawl.workspace_id,
      siteId: crawl.website_id,
      urlsDiscovered: result.pagesDiscovered,
      urlsCrawled: result.pagesCrawled,
      urlsFailed: result.pagesFailed,
      internalLinks: edges.filter((e) => !e.isExternal).length,
      externalLinks: edges.filter((e) => e.isExternal).length,
      issueCounts: { total: evalResult.issueCount },
      durationMs: crawl.started_at ? Date.now() - new Date(crawl.started_at).getTime() : null,
    });
  } catch (err) {
    log('crawl summary failed', { crawlId: crawl.id, message: (err as Error)?.message });
  }

  await completeJob(config, { jobId });
  log('crawl completed', { crawlId: crawl.id, jobId, score: scoreResult.score, pagesCrawled: result.pagesCrawled, issues: evalResult.issueCount });
}

let shuttingDown = false;
let inFlight = 0;

async function tickCrawl(config: ReturnType<typeof loadConfig>, sb: ReturnType<typeof getServiceClient>, jobId: string): Promise<void> {
  const { data: crawl } = await sb.from('seo_crawls').select('*').eq('job_id', jobId).maybeSingle();
  if (!crawl) {
    await failJob(config, { jobId, errorMessage: 'seo_crawls_row_missing', errorCategory: 'internal_error', retryable: false });
    return;
  }
  try {
    await processCrawl(config, jobId, crawl as SeoCrawlRow);
  } catch (err) {
    const { category, message, retryable } = classifyError(err);
    log('crawl failed', { jobId, category, message });
    await failJob(config, { jobId, errorMessage: message, errorCategory: category, retryable });
    await sb.from('seo_crawls').update({ status: 'failed', error_message: message.slice(0, 1000), error_category: category, finished_at: new Date().toISOString() }).eq('job_id', jobId).in('status', ['queued', 'running', 'processing']);
  }
}

async function tickBacklinkScan(config: ReturnType<typeof loadConfig>, sb: ReturnType<typeof getServiceClient>, jobId: string): Promise<void> {
  const { data: scan } = await sb.from('seo_backlink_scans').select('*').eq('job_id', jobId).maybeSingle();
  if (!scan) {
    await failJob(config, { jobId, errorMessage: 'seo_backlink_scans_row_missing', errorCategory: 'internal_error', retryable: false });
    return;
  }
  try {
    await processBacklinkScan(config, jobId, scan as SeoBacklinkScanRow, WORKER_ID, LOCK_TTL_SECONDS);
  } catch (err) {
    const { category, message, retryable } = classifyBacklinkScanError(err);
    log('backlink scan failed', { jobId, category, message });
    await failJob(config, { jobId, errorMessage: message, errorCategory: category, retryable });
    await sb.from('seo_backlink_scans').update({ status: 'failed', error_message: message.slice(0, 1000), error_category: category, finished_at: new Date().toISOString() }).eq('job_id', jobId).in('status', ['queued', 'running', 'processing']);
  }
}

async function tickKeywordResearch(config: ReturnType<typeof loadConfig>, sb: ReturnType<typeof getServiceClient>, jobId: string): Promise<void> {
  const { data: run } = await sb.from('seo_keyword_research_runs').select('*').eq('job_id', jobId).maybeSingle();
  if (!run) {
    await failJob(config, { jobId, errorMessage: 'seo_keyword_research_runs_row_missing', errorCategory: 'internal_error', retryable: false });
    return;
  }
  try {
    await processKeywordResearchRun(config, jobId, run as SeoKeywordResearchRunRow, WORKER_ID, LOCK_TTL_SECONDS);
  } catch (err) {
    const { category, message, retryable } = classifyKeywordRunError(err);
    log('keyword research failed', { jobId, category, message });
    await failJob(config, { jobId, errorMessage: message, errorCategory: category, retryable });
    await sb.from('seo_keyword_research_runs').update({ status: 'failed', error_message: message.slice(0, 1000), error_category: category, finished_at: new Date().toISOString() }).eq('job_id', jobId).in('status', ['queued', 'running', 'processing']);
  }
}

async function tickPerformanceAudit(config: ReturnType<typeof loadConfig>, sb: ReturnType<typeof getServiceClient>, jobId: string): Promise<void> {
  const { data: audit } = await sb.from('seo_performance_audits').select('*').eq('job_id', jobId).maybeSingle();
  if (!audit) {
    await failJob(config, { jobId, errorMessage: 'seo_performance_audits_row_missing', errorCategory: 'internal_error', retryable: false });
    return;
  }
  try {
    await processPerformanceAudit(config, jobId, audit as SeoPerformanceAuditRow, WORKER_ID, LOCK_TTL_SECONDS);
  } catch (err) {
    const { category, message, retryable } = classifyPerformanceAuditError(err);
    log('performance audit failed', { jobId, category, message });
    await failJob(config, { jobId, errorMessage: message, errorCategory: category, retryable });
    await sb.from('seo_performance_audits').update({ status: 'failed', error_message: message.slice(0, 1000), error_category: category, finished_at: new Date().toISOString() }).eq('job_id', jobId).in('status', ['queued', 'running', 'processing']);
    await sb.from('seo_performance_results').update({ status: 'unavailable' }).eq('audit_id', (audit as SeoPerformanceAuditRow).id).eq('status', 'pending');
  }
}

async function tickExplorerBacklinkScan(config: ReturnType<typeof loadConfig>, sb: ReturnType<typeof getServiceClient>, jobId: string): Promise<void> {
  const { data: scan } = await sb.from('seo_explorer_backlink_scans').select('*').eq('job_id', jobId).maybeSingle();
  if (!scan) {
    await failJob(config, { jobId, errorMessage: 'seo_explorer_backlink_scans_row_missing', errorCategory: 'internal_error', retryable: false });
    return;
  }
  try {
    await processExplorerBacklinkScan(config, jobId, scan as SeoExplorerBacklinkScanRow, WORKER_ID, LOCK_TTL_SECONDS);
  } catch (err) {
    const { category, message, retryable } = classifyExplorerBacklinkScanError(err);
    log('explorer backlink scan failed', { jobId, category, message });
    await failJob(config, { jobId, errorMessage: message, errorCategory: category, retryable });
    await sb.from('seo_explorer_backlink_scans').update({ status: 'failed', error_message: message.slice(0, 1000), error_category: category, finished_at: new Date().toISOString() }).eq('job_id', jobId).in('status', ['queued', 'running', 'processing']);
  }
}

async function tickExplorerKeywordScan(config: ReturnType<typeof loadConfig>, sb: ReturnType<typeof getServiceClient>, jobId: string): Promise<void> {
  const { data: scan } = await sb.from('seo_explorer_keyword_scans').select('*').eq('job_id', jobId).maybeSingle();
  if (!scan) {
    await failJob(config, { jobId, errorMessage: 'seo_explorer_keyword_scans_row_missing', errorCategory: 'internal_error', retryable: false });
    return;
  }
  try {
    await processExplorerKeywordScan(config, jobId, scan as SeoExplorerKeywordScanRow, WORKER_ID, LOCK_TTL_SECONDS);
  } catch (err) {
    const { category, message, retryable } = classifyExplorerKeywordScanError(err);
    log('explorer keyword scan failed', { jobId, category, message });
    await failJob(config, { jobId, errorMessage: message, errorCategory: category, retryable });
    await sb.from('seo_explorer_keyword_scans').update({ status: 'failed', error_message: message.slice(0, 1000), error_category: category, finished_at: new Date().toISOString() }).eq('job_id', jobId).in('status', ['queued', 'running', 'processing']);
  }
}

async function tickExplorerCompetitorScan(config: ReturnType<typeof loadConfig>, sb: ReturnType<typeof getServiceClient>, jobId: string): Promise<void> {
  const { data: scan } = await sb.from('seo_explorer_competitor_scans').select('*').eq('job_id', jobId).maybeSingle();
  if (!scan) {
    await failJob(config, { jobId, errorMessage: 'seo_explorer_competitor_scans_row_missing', errorCategory: 'internal_error', retryable: false });
    return;
  }
  try {
    await processExplorerCompetitorScan(config, jobId, scan as SeoExplorerCompetitorScanRow, WORKER_ID, LOCK_TTL_SECONDS);
  } catch (err) {
    const { category, message, retryable } = classifyExplorerCompetitorScanError(err);
    log('explorer competitor scan failed', { jobId, category, message });
    await failJob(config, { jobId, errorMessage: message, errorCategory: category, retryable });
    await sb.from('seo_explorer_competitor_scans').update({ status: 'failed', error_message: message.slice(0, 1000), error_category: category, finished_at: new Date().toISOString() }).eq('job_id', jobId).in('status', ['queued', 'running', 'processing']);
  }
}

/** One poll of the SEO queue. Resolves true when a job was claimed. */
async function tick(config: ReturnType<typeof loadConfig>): Promise<boolean> {
  if (shuttingDown) return false;
  const job = await claimNextJob(config, { jobTypes: JOB_TYPES, workerId: WORKER_ID, lockTtlSeconds: LOCK_TTL_SECONDS });
  if (!job) return false;

  inFlight++;
  const sb = getServiceClient(config);
  try {
    if (job.job_type === 'seo_backlink_scan') await tickBacklinkScan(config, sb, job.id);
    else if (job.job_type === 'seo_keyword_research') await tickKeywordResearch(config, sb, job.id);
    else if (job.job_type === 'seo_performance_audit') await tickPerformanceAudit(config, sb, job.id);
    else if (job.job_type === 'seo_explorer_backlink_scan') await tickExplorerBacklinkScan(config, sb, job.id);
    else if (job.job_type === 'seo_explorer_keyword_scan') await tickExplorerKeywordScan(config, sb, job.id);
    else if (job.job_type === 'seo_explorer_competitor_scan') await tickExplorerCompetitorScan(config, sb, job.id);
    else await tickCrawl(config, sb, job.id);
  } finally {
    inFlight--;
  }
  return true;
}

let started = false;
let timer: NodeJS.Timeout | null = null;

export function startSeoCrawlerWorker(): void {
  if (started) return;
  started = true;
  const config = loadConfig();
  log('started', { workerId: WORKER_ID, pollIntervalMs: POLL_INTERVAL_MS, maxIdlePollMs: MAX_IDLE_POLL_MS });

  // setInterval, not a self-rescheduling timeout: a crawl runs for minutes
  // inside tick() while the next interval still claims the next queued job.
  // Only an idle queue eases off, skipping a growing number of intervals up
  // to MAX_IDLE_POLL_MS; any claimed job resets it.
  const idle = new IdleIntervalSkipper(
    POLL_INTERVAL_MS,
    new IdleBackoff({ busyMs: POLL_INTERVAL_MS, idleMs: POLL_INTERVAL_MS, maxIdleMs: MAX_IDLE_POLL_MS }),
  );
  const run = () => {
    if (idle.skip()) return;
    void tick(config)
      .catch((e) => {
        log('tick error', { error: (e as Error)?.message });
        return false;
      })
      .then((found) => idle.record(found));
  };
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
