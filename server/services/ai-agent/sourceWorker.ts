/**
 * Data Hub source-sync worker.
 *
 * Two execution modes (DB-backed jobs are the source of truth in BOTH):
 *   1. In-process polling (AI_KB_WORKER_INPROC=1) — convenient for dev/Coolify
 *      single-container setups. Started from server/index.ts.
 *   2. Standalone (future) — same code can run from a worker container; no
 *      frontend or HTTP dependency.
 *
 * Worker only triggers internal crawler/indexer flows. No MCP/webhook/external
 * tool execution.
 */

import os from 'node:os';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { recordSourceSyncLog } from './sourceSyncLog.js';
import {
  claimNextSourceSyncJob, completeSourceSyncJob, failSourceSyncJob,
  cancelSourceSyncJob, type SourceSyncJob,
} from './sourceJobs.js';
import { resolveAiAgentDataLimits } from './limits.js';
import { crawlWebsiteSource } from './crawler/crawlWebsiteSource.js';
import { normalizeHost, DEFAULT_INCLUDE, DEFAULT_EXCLUDE } from './crawler/urlRules.js';
import { runFileIngestJob, IngestError, logFileEvent } from './files/fileIngestion.js';

const WORKER_ID =
  process.env.AI_KB_WORKER_ID ||
  `${os.hostname?.() || 'host'}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
const POLL_INTERVAL_MS = clampInt(process.env.AI_KB_WORKER_INTERVAL_MS, 5000, 1000, 60_000);
const LOCK_TTL_SECONDS = clampInt(process.env.AI_KB_WORKER_LOCK_TTL_SECONDS, 180, 30, 1800);

function clampInt(v: string | undefined, def: number, min: number, max: number): number {
  const n = parseInt(v || '', 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

let started = false;
let stopping = false;

export function startInProcessSourceWorker(config: ServerConfig): void {
  if (started) return;
  const legacy = process.env.AI_KB_WORKER_INPROC === '1';
  const websiteInproc = process.env.AI_SOURCE_SYNC_WORKER_INPROC === '1';
  const fileInproc = process.env.AI_FILE_INGEST_WORKER_INPROC === '1';
  if (!legacy && !websiteInproc && !fileInproc) return;
  started = true;

  // Resolve job-type filter. Explicit env override wins.
  let jobTypes: string[] | undefined;
  const envOverride = (process.env.AI_SOURCE_JOB_TYPES || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (envOverride.length > 0 && !envOverride.includes('all')) {
    jobTypes = envOverride;
  } else if (envOverride.includes('all')) {
    jobTypes = undefined;
  } else if (websiteInproc && fileInproc) {
    jobTypes = ['website_sync', 'website_rebuild', 'file_ingest'];
  } else if (fileInproc) {
    jobTypes = ['file_ingest'];
  } else if (websiteInproc) {
    jobTypes = ['website_sync', 'website_rebuild'];
  } else if (legacy) {
    // Legacy AI_KB_WORKER_INPROC: do NOT silently claim file_ingest in
    // production. Default to website jobs only and warn loudly.
    console.warn('[ai-kb worker] AI_KB_WORKER_INPROC=1 is legacy. Defaulting to website jobs only. Set AI_SOURCE_JOB_TYPES=file_ingest or AI_FILE_INGEST_WORKER_INPROC=1 to also process file ingestion in-process (NOT recommended in production).');
    jobTypes = ['website_sync', 'website_rebuild'];
  }

  console.log('[ai-kb worker] started in-process', {
    workerId: WORKER_ID, pollMs: POLL_INTERVAL_MS, lockTtl: LOCK_TTL_SECONDS,
    jobTypes: jobTypes || 'all',
  });
  const tick = async () => {
    if (stopping) return;
    try { await processOne(config, { jobTypes }); } catch (e: any) {
      console.warn('[ai-kb worker] tick error:', e?.message);
    } finally {
      setTimeout(tick, POLL_INTERVAL_MS).unref?.();
    }
  };
  setTimeout(tick, 1500).unref?.();
}

export function stopInProcessSourceWorker(): void { stopping = true; }

/** Public: try to process one job; safe to call from anywhere (route, worker). */
export async function processOne(
  config: ServerConfig,
  opts: { jobTypes?: string[] } = {},
): Promise<{ processed: boolean }> {
  const job = await claimNextSourceSyncJob(config, {
    workerId: WORKER_ID, lockTtlSeconds: LOCK_TTL_SECONDS, jobTypes: opts.jobTypes,
  });
  if (!job) return { processed: false };
  console.log('[ai-kb worker] source job claimed', { workerId: WORKER_ID, jobId: job.id, workspaceId: job.workspace_id, sourceId: job.source_id });
  try {
    await runJob(config, job);
    return { processed: true };
  } catch (e: any) {
    const msg = e?.message || 'worker_error';
    console.warn('[ai-kb worker] source job failed', { jobId: job.id, error: msg });
    const r = await failSourceSyncJob(config, { jobId: job.id, error: msg, retryable: true });
    if (!r.updated) {
      console.warn('[ai-kb worker] failSourceSyncJob skipped (terminal state)', {
        jobId: job.id, finalStatus: r.finalStatus,
      });
    }
    return { processed: true };
  }
}

async function runJob(config: ServerConfig, job: SourceSyncJob): Promise<void> {
  // Dispatch by job_type. file_ingest jobs do parse+index; legacy jobs crawl.
  if (job.job_type === 'file_ingest') {
    return runFileIngestJobWrapper(config, job);
  }
  const sb = getServiceClient(config);

  // Load source.
  const { data: source } = await sb
    .from('ai_data_sources')
    .select('*')
    .eq('id', job.source_id)
    .maybeSingle();
  if (!source) throw new Error('source_not_found');
  if (source.status === 'deleted') throw new Error('source_deleted');
  if (source.workspace_id !== job.workspace_id) throw new Error('workspace_mismatch');

  // Resolve workspace registered domain (must exist for any website crawl).
  const { data: domainRow } = await sb
    .from('workspace_domains')
    .select('domain')
    .eq('workspace_id', job.workspace_id)
    .order('is_primary', { ascending: false })
    .limit(1)
    .maybeSingle();
  const registeredHost = domainRow?.domain
    ? normalizeHost(String(domainRow.domain).replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    : null;
  if (!registeredHost) throw new Error('no_workspace_domain');

  // Resolve plan limits and cap source config.
  const { limits } = await resolveAiAgentDataLimits(config, job.workspace_id);
  const maxPages = Math.max(1, Math.min(source.max_pages || 50, limits.ai_kb_max_pages));
  const maxDepth = Math.max(1, Math.min(source.crawl_depth || 2, limits.ai_kb_max_depth));

  await sb.from('ai_data_sources').update({ status: 'syncing', last_error: null }).eq('id', source.id);
  await recordSourceSyncLog(config, {
    workspaceId: job.workspace_id,
    sourceId: source.id,
    status: 'started',
    message: 'Worker started',
    metadata: { worker_id: WORKER_ID, job_id: job.id, max_pages: maxPages, max_depth: maxDepth },
  }, sb);

  const include = (source.include_rules?.length ? source.include_rules : DEFAULT_INCLUDE) as string[];
  const exclude = ([...(source.exclude_rules || []), ...DEFAULT_EXCLUDE].filter(Boolean)) as string[];

  const summary = await crawlWebsiteSource(config, {
    workspaceId: job.workspace_id,
    sourceId: source.id,
    baseUrl: source.base_url,
    rootHost: registeredHost,
    include,
    exclude,
    maxPages,
    maxDepth,
    workerId: WORKER_ID,
    jobId: job.id,
  });

  const fatal = summary.pages_fetched === 0 && summary.errors.length > 0;
  const newStatus = fatal ? 'failed' : 'active';
  await sb.from('ai_data_sources').update({
    status: newStatus,
    last_synced_at: new Date().toISOString(),
    pages_found: summary.pages_seen,
    chunks_created: summary.chunks_created,
    embedded_chunks: summary.embedded_chunks,
    last_warning: summary.warnings[0] || null,
    last_error: fatal ? (summary.errors[0] || 'crawl_failed') : null,
  }).eq('id', source.id);

  await recordSourceSyncLog(config, {
    workspaceId: job.workspace_id,
    sourceId: source.id,
    status: fatal ? 'failed' : 'completed',
    message: fatal ? `Crawl failed: ${summary.errors[0] || 'unknown'}` : 'Sync completed',
    pagesFound: summary.pages_seen,
    chunksCreated: summary.chunks_created,
    embeddedChunks: summary.embedded_chunks,
    errors: summary.pages_failed,
    metadata: {
      worker_id: WORKER_ID, job_id: job.id,
      truncated: summary.truncated,
      warnings: summary.warnings.slice(0, 20),
      pages_fetched: summary.pages_fetched,
      pages_skipped: summary.pages_skipped,
      pages_failed: summary.pages_failed,
    },
  }, sb);

  const compRes = await completeSourceSyncJob(config, {
    jobId: job.id,
    summary: {
      pages_seen: summary.pages_seen,
      pages_fetched: summary.pages_fetched,
      pages_failed: summary.pages_failed,
      chunks_created: summary.chunks_created,
      embedded_chunks: summary.embedded_chunks,
      truncated: summary.truncated,
    },
  });
  if (!compRes.updated) {
    console.warn('[ai-kb worker] completeSourceSyncJob skipped (job not running)', {
      jobId: job.id, finalStatus: compRes.finalStatus,
    });
  }

  console.log('[ai-kb worker] source job completed', {
    workerId: WORKER_ID, jobId: job.id, sourceId: source.id,
    pages_fetched: summary.pages_fetched, chunks_created: summary.chunks_created,
    embeddings_generated: summary.embeddings_generated,
  });
}

async function runFileIngestJobWrapper(config: ServerConfig, job: SourceSyncJob): Promise<void> {
  try {
    const result = await runFileIngestJob(config, {
      workspaceId: job.workspace_id, sourceId: job.source_id,
      jobId: job.id, workerId: WORKER_ID,
    });
    // Race-safe pre-completion guards. Admin may have paused/deleted/cancelled
    // between finalizeIndex returning and our complete call.
    const sb = getServiceClient(config);
    const { data: jobRow } = await sb
      .from('ai_source_sync_jobs').select('status').eq('id', job.id).maybeSingle();
    const jobStatus = (jobRow as any)?.status;
    if (jobStatus !== 'running') {
      await logFileEvent(config, {
        workspaceId: job.workspace_id, sourceId: job.source_id,
        status: 'file_ingest_completion_skipped_job_cancelled',
        message: `job_status=${jobStatus || 'missing'}`,
        metadata: { job_id: job.id, worker_id: WORKER_ID, job_status: jobStatus || null },
      });
      console.warn('[ai-kb worker] file_ingest completion skipped — job not running', {
        jobId: job.id, jobStatus,
      });
      return;
    }
    const { data: srcRow } = await sb
      .from('ai_data_sources').select('status').eq('id', job.source_id).maybeSingle();
    const srcStatus = (srcRow as any)?.status;
    if (srcStatus !== 'active') {
      const evt = srcStatus === 'deleted' ? 'file_ingest_completion_skipped_source_deleted'
               : srcStatus === 'paused'  ? 'file_ingest_completion_skipped_source_paused'
               : 'file_ingest_completion_skipped_source_not_active';
      await cancelSourceSyncJob(config, { jobId: job.id });
      await logFileEvent(config, {
        workspaceId: job.workspace_id, sourceId: job.source_id,
        status: evt,
        message: `source_status=${srcStatus || 'missing'}`,
        metadata: {
          job_id: job.id, worker_id: WORKER_ID,
          source_status: srcStatus || null, job_status: jobStatus,
        },
      });
      console.warn('[ai-kb worker] file_ingest completion skipped — source not active', {
        jobId: job.id, sourceId: job.source_id, srcStatus,
      });
      return;
    }
    const compRes = await completeSourceSyncJob(config, {
      jobId: job.id,
      summary: {
        chunks_created: result.chunks_created,
        embedded_chunks: result.embedded_chunks,
        parser: result.parser,
        page_count: result.page_count ?? null,
        warnings: result.warnings.slice(0, 10),
      },
    });
    if (!compRes.updated) {
      await logFileEvent(config, {
        workspaceId: job.workspace_id, sourceId: job.source_id,
        status: 'file_ingest_completion_skipped_job_cancelled',
        message: `complete_lost_race:${compRes.finalStatus || 'unknown'}`,
        metadata: { job_id: job.id, worker_id: WORKER_ID, job_status: compRes.finalStatus || null },
      });
      console.warn('[ai-kb worker] file_ingest complete lost race', {
        jobId: job.id, finalStatus: compRes.finalStatus,
      });
      return;
    }
    console.log('[ai-kb worker] file_ingest job completed', {
      workerId: WORKER_ID, jobId: job.id, sourceId: job.source_id,
      chunks_created: result.chunks_created,
    });
  } catch (e: any) {
    const code = e instanceof IngestError ? e.code : (e?.message || 'file_ingest_failed');
    // Cancellation codes — pause/delete/race. NOT a worker failure.
    const cancelled = new Set(['source_paused', 'source_deleted', 'source_cancelled', 'job_cancelled']);
    // Transient errors that may succeed on retry.
    const transient = new Set(['download_failed', 'storage_temporary_failure', 'embedder_temporary_failure']);
    if (cancelled.has(code)) {
      await cancelSourceSyncJob(config, { jobId: job.id });
      const evt = code === 'source_deleted' ? 'file_ingest_skipped_source_deleted'
               : code === 'source_paused'  ? 'file_ingest_skipped_source_paused'
               : 'file_ingest_skipped_job_cancelled';
      await logFileEvent(config, {
        workspaceId: job.workspace_id, sourceId: job.source_id,
        status: evt, message: code, metadata: { job_id: job.id, worker_id: WORKER_ID },
      });
      console.log('[ai-kb worker] file_ingest job cancelled', { jobId: job.id, sourceId: job.source_id, reason: code });
      return;
    }
    const retryable = transient.has(code);
    const failRes = await failSourceSyncJob(config, { jobId: job.id, error: code, retryable });
    if (!failRes.updated) {
      await logFileEvent(config, {
        workspaceId: job.workspace_id, sourceId: job.source_id,
        status: 'file_ingest_completion_skipped_job_cancelled',
        message: `fail_lost_race:${failRes.finalStatus || 'unknown'}`,
        metadata: { job_id: job.id, worker_id: WORKER_ID, job_status: failRes.finalStatus || null },
      });
      console.warn('[ai-kb worker] file_ingest fail skipped (terminal state)', {
        jobId: job.id, finalStatus: failRes.finalStatus, error: code,
      });
      return;
    }
    await logFileEvent(config, {
      workspaceId: job.workspace_id, sourceId: job.source_id,
      status: retryable ? 'file_job_retry_queued' : 'file_job_failed_non_retryable',
      message: code, errors: 1, metadata: { job_id: job.id, worker_id: WORKER_ID, retryable },
    });
    console.warn('[ai-kb worker] file_ingest job failed', {
      jobId: job.id, sourceId: job.source_id, error: code, retryable,
    });
  }
}

export function getWorkerInfo() {
  return {
    workerId: WORKER_ID,
    inProcess: process.env.AI_KB_WORKER_INPROC === '1',
    pollIntervalMs: POLL_INTERVAL_MS,
    lockTtlSeconds: LOCK_TTL_SECONDS,
    started,
  };
}