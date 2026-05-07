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
import {
  claimNextSourceSyncJob, completeSourceSyncJob, failSourceSyncJob, type SourceSyncJob,
} from './sourceJobs.js';
import { resolveAiAgentDataLimits } from './limits.js';
import { crawlWebsiteSource } from './crawler/crawlWebsiteSource.js';
import { normalizeHost, DEFAULT_INCLUDE, DEFAULT_EXCLUDE } from './crawler/urlRules.js';

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
  if (process.env.AI_KB_WORKER_INPROC !== '1') return;
  started = true;
  console.log('[ai-kb worker] started in-process', { workerId: WORKER_ID, pollMs: POLL_INTERVAL_MS, lockTtl: LOCK_TTL_SECONDS });
  const tick = async () => {
    if (stopping) return;
    try { await processOne(config); } catch (e: any) {
      console.warn('[ai-kb worker] tick error:', e?.message);
    } finally {
      setTimeout(tick, POLL_INTERVAL_MS).unref?.();
    }
  };
  setTimeout(tick, 1500).unref?.();
}

export function stopInProcessSourceWorker(): void { stopping = true; }

/** Public: try to process one job; safe to call from anywhere (route, worker). */
export async function processOne(config: ServerConfig): Promise<{ processed: boolean }> {
  const job = await claimNextSourceSyncJob(config, { workerId: WORKER_ID, lockTtlSeconds: LOCK_TTL_SECONDS });
  if (!job) return { processed: false };
  console.log('[ai-kb worker] source job claimed', { workerId: WORKER_ID, jobId: job.id, workspaceId: job.workspace_id, sourceId: job.source_id });
  try {
    await runJob(config, job);
    return { processed: true };
  } catch (e: any) {
    const msg = e?.message || 'worker_error';
    console.warn('[ai-kb worker] source job failed', { jobId: job.id, error: msg });
    await failSourceSyncJob(config, { jobId: job.id, error: msg, retryable: true });
    return { processed: true };
  }
}

async function runJob(config: ServerConfig, job: SourceSyncJob): Promise<void> {
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
  await sb.from('ai_source_sync_logs').insert({
    workspace_id: job.workspace_id,
    source_id: source.id,
    status: 'started',
    message: 'Worker started',
    metadata: { worker_id: WORKER_ID, job_id: job.id, max_pages: maxPages, max_depth: maxDepth },
  });

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

  await sb.from('ai_source_sync_logs').insert({
    workspace_id: job.workspace_id,
    source_id: source.id,
    status: fatal ? 'failed' : 'completed',
    message: fatal ? `Crawl failed: ${summary.errors[0] || 'unknown'}` : 'Sync completed',
    pages_found: summary.pages_seen,
    chunks_created: summary.chunks_created,
    embedded_chunks: summary.embedded_chunks,
    errors: summary.pages_failed,
    metadata: {
      worker_id: WORKER_ID, job_id: job.id,
      truncated: summary.truncated,
      warnings: summary.warnings.slice(0, 20),
      pages_fetched: summary.pages_fetched,
      pages_skipped: summary.pages_skipped,
      pages_failed: summary.pages_failed,
    },
  });

  await completeSourceSyncJob(config, {
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

  console.log('[ai-kb worker] source job completed', {
    workerId: WORKER_ID, jobId: job.id, sourceId: source.id,
    pages_fetched: summary.pages_fetched, chunks_created: summary.chunks_created,
    embeddings_generated: summary.embeddings_generated,
  });
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