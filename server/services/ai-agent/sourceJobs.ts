/**
 * DB-backed sync-job queue for AI Agent Data Hub website sources.
 *
 * Single source of truth: ai_source_sync_jobs. Atomic claim uses a
 * conditional UPDATE so two workers can never claim the same job. Lock
 * expiry lets us recover crashed runners.
 *
 * No in-memory queue. No external HTTP/MCP/webhook dispatch — workers only
 * trigger internal crawler/indexer flows.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export type SourceJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface SourceSyncJob {
  id: string;
  workspace_id: string;
  source_id: string;
  job_type: string;
  status: SourceJobStatus;
  priority: number;
  locked_by: string | null;
  locked_at: string | null;
  lock_expires_at: string | null;
  attempts: number;
  max_attempts: number;
  started_at: string | null;
  finished_at: string | null;
  last_error: string | null;
  metadata: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export async function enqueueSourceSyncJob(
  config: ServerConfig,
  args: { workspaceId: string; sourceId: string; jobType?: string; createdBy?: string | null; metadata?: Record<string, unknown> },
): Promise<SourceSyncJob> {
  const sb = getServiceClient(config);
  const jobType = args.jobType || 'website_sync';
  // Coalesce: if a queued job of the SAME job_type already exists for this
  // source, reuse it. Different job_types (e.g. file_ingest vs website_sync)
  // must NOT collapse into one another.
  const { data: existing } = await sb
    .from('ai_source_sync_jobs')
    .select('*')
    .eq('source_id', args.sourceId)
    .eq('job_type', jobType)
    .eq('status', 'queued')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing) return existing as SourceSyncJob;

  const { data, error } = await sb
    .from('ai_source_sync_jobs')
    .insert({
      workspace_id: args.workspaceId,
      source_id: args.sourceId,
      job_type: jobType,
      status: 'queued',
      created_by: args.createdBy ?? null,
      metadata: args.metadata || {},
    })
    .select('*')
    .single();
  if (error) throw new Error(`enqueue_source_job_failed: ${error.message}`);
  return data as SourceSyncJob;
}

/**
 * Atomic claim. Eligible rows:
 *   - status='queued', or
 *   - status='running' AND lock_expires_at < now (crashed worker)
 * Conditional UPDATE on (id, current status) ensures exclusive ownership.
 */
export async function claimNextSourceSyncJob(
  config: ServerConfig,
  args: { workerId: string; lockTtlSeconds: number; jobTypes?: string[] },
): Promise<SourceSyncJob | null> {
  const sb = getServiceClient(config);
  const nowIso = new Date().toISOString();

  // Find candidate.
  let q = sb
    .from('ai_source_sync_jobs')
    .select('id, status, attempts, max_attempts')
    .or(`status.eq.queued,and(status.eq.running,lock_expires_at.lt.${nowIso})`)
    .order('priority', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(1);
  if (args.jobTypes && args.jobTypes.length > 0) {
    q = q.in('job_type', args.jobTypes);
  }
  const { data: candRow } = await q.maybeSingle();
  const cand = candRow as { id: string; status: string; attempts: number | null; max_attempts: number } | null;
  if (!cand) return null;
  if (cand.attempts >= cand.max_attempts) {
    // Burn the row out so we don't keep looping.
    await sb.from('ai_source_sync_jobs').update({
      status: 'failed',
      finished_at: nowIso,
      last_error: 'max_attempts_exceeded',
    }).eq('id', cand.id).in('status', ['queued', 'running']);
    return null;
  }

  const lockExpires = new Date(Date.now() + args.lockTtlSeconds * 1000).toISOString();
  const prevStatus = cand.status;
  const { data: claimed, error } = await sb
    .from('ai_source_sync_jobs')
    .update({
      status: 'running',
      locked_by: args.workerId,
      locked_at: nowIso,
      lock_expires_at: lockExpires,
      attempts: (cand.attempts || 0) + 1,
      started_at: nowIso,
    })
    .eq('id', cand.id)
    .eq('status', prevStatus)
    // Two workers re-claiming the same expired running job both match the
    // status; the attempts they read tell the first from the second.
    .eq('attempts', cand.attempts || 0)
    .select('*')
    .maybeSingle();
  if (error || !claimed) return null;
  return claimed as SourceSyncJob;
}

/**
 * Keeps a claimed job's lease alive while its worker still holds it (audit
 * ai-6): a claim locks the job for lockTtlSeconds and expired running jobs
 * are re-claimed, so without a heartbeat a crawl longer than the lease was
 * run (and its embeddings charged) twice when more than one worker polls.
 * False when the job is no longer this worker's (re-claimed, cancelled or
 * finished).
 */
export async function renewSourceSyncJobLease(
  config: ServerConfig,
  args: { jobId: string; workerId: string; lockTtlSeconds: number },
): Promise<boolean> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.from('ai_source_sync_jobs').update({
    lock_expires_at: new Date(Date.now() + args.lockTtlSeconds * 1000).toISOString(),
  }).eq('id', args.jobId).eq('status', 'running').eq('locked_by', args.workerId)
    .select('id').maybeSingle();
  return !error && !!data;
}

export async function completeSourceSyncJob(
  config: ServerConfig,
  args: { jobId: string; summary?: Record<string, unknown>; workerId?: string },
): Promise<{ updated: boolean; finalStatus?: string }> {
  const sb = getServiceClient(config);
  let q = sb.from('ai_source_sync_jobs').update({
    status: 'completed',
    finished_at: new Date().toISOString(),
    last_error: null,
    metadata: args.summary ? { ...args.summary } : undefined,
  }).eq('id', args.jobId).eq('status', 'running');
  // Only the worker holding the job finishes it.
  if (args.workerId) q = q.eq('locked_by', args.workerId);
  const { data } = await q.select('id, status').maybeSingle();
  if (data) return { updated: true, finalStatus: 'completed' };
  // Reload to report actual final status.
  const { data: cur } = await sb
    .from('ai_source_sync_jobs').select('status').eq('id', args.jobId).maybeSingle();
  return { updated: false, finalStatus: (cur as { status?: string } | null)?.status };
}

export async function failSourceSyncJob(
  config: ServerConfig,
  args: { jobId: string; error: string; retryable?: boolean; workerId?: string },
): Promise<{ updated: boolean; finalStatus?: string }> {
  const sb = getServiceClient(config);
  const { data: row } = await sb
    .from('ai_source_sync_jobs')
    .select('attempts, max_attempts, status')
    .eq('id', args.jobId)
    .maybeSingle();
  if (!row) return { updated: false };
  const job = row as { attempts: number; max_attempts: number; status: string };
  const curStatus = job.status;
  // Never overwrite a terminal/cancelled state.
  if (curStatus === 'cancelled' || curStatus === 'completed' || curStatus === 'failed') {
    return { updated: false, finalStatus: curStatus };
  }
  const canRetry = !!args.retryable && job.attempts < job.max_attempts;
  let q = sb.from('ai_source_sync_jobs').update({
    status: canRetry ? 'queued' : 'failed',
    last_error: (args.error || 'unknown_error').slice(0, 1000),
    finished_at: canRetry ? null : new Date().toISOString(),
    locked_by: null,
    locked_at: null,
    lock_expires_at: null,
  }).eq('id', args.jobId);
  // Only the worker holding the job fails it; a job another worker has
  // re-claimed is that worker's.
  q = args.workerId
    ? q.eq('status', 'running').eq('locked_by', args.workerId)
    : q.in('status', ['running', 'queued']);
  const { data: updated } = await q.select('id, status').maybeSingle();
  if (updated) return { updated: true, finalStatus: (updated as { status: string }).status };
  const { data: cur } = await sb
    .from('ai_source_sync_jobs').select('status').eq('id', args.jobId).maybeSingle();
  return { updated: false, finalStatus: (cur as { status?: string } | null)?.status };
}

export async function cancelSourceSyncJob(
  config: ServerConfig,
  args: { jobId: string },
): Promise<void> {
  const sb = getServiceClient(config);
  await sb.from('ai_source_sync_jobs').update({
    status: 'cancelled',
    finished_at: new Date().toISOString(),
  }).eq('id', args.jobId).in('status', ['queued', 'running']);
}