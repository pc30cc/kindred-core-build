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
  const { data: cand } = await q.maybeSingle();
  if (!cand) return null;
  if ((cand as any).attempts >= (cand as any).max_attempts) {
    // Burn the row out so we don't keep looping.
    await sb.from('ai_source_sync_jobs').update({
      status: 'failed',
      finished_at: nowIso,
      last_error: 'max_attempts_exceeded',
    }).eq('id', (cand as any).id).in('status', ['queued', 'running']);
    return null;
  }

  const lockExpires = new Date(Date.now() + args.lockTtlSeconds * 1000).toISOString();
  const prevStatus = (cand as any).status;
  const { data: claimed, error } = await sb
    .from('ai_source_sync_jobs')
    .update({
      status: 'running',
      locked_by: args.workerId,
      locked_at: nowIso,
      lock_expires_at: lockExpires,
      attempts: ((cand as any).attempts || 0) + 1,
      started_at: nowIso,
    })
    .eq('id', (cand as any).id)
    .eq('status', prevStatus)
    .select('*')
    .maybeSingle();
  if (error || !claimed) return null;
  return claimed as SourceSyncJob;
}

export async function completeSourceSyncJob(
  config: ServerConfig,
  args: { jobId: string; summary?: Record<string, unknown> },
): Promise<{ updated: boolean; finalStatus?: string }> {
  const sb = getServiceClient(config);
  const { data } = await sb.from('ai_source_sync_jobs').update({
    status: 'completed',
    finished_at: new Date().toISOString(),
    last_error: null,
    metadata: args.summary ? { ...args.summary } : undefined,
  }).eq('id', args.jobId).eq('status', 'running').select('id, status').maybeSingle();
  if (data) return { updated: true, finalStatus: 'completed' };
  // Reload to report actual final status.
  const { data: cur } = await sb
    .from('ai_source_sync_jobs').select('status').eq('id', args.jobId).maybeSingle();
  return { updated: false, finalStatus: (cur as any)?.status };
}

export async function failSourceSyncJob(
  config: ServerConfig,
  args: { jobId: string; error: string; retryable?: boolean },
): Promise<{ updated: boolean; finalStatus?: string }> {
  const sb = getServiceClient(config);
  const { data: row } = await sb
    .from('ai_source_sync_jobs')
    .select('attempts, max_attempts, status')
    .eq('id', args.jobId)
    .maybeSingle();
  if (!row) return { updated: false };
  const curStatus = (row as any).status as string;
  // Never overwrite a terminal/cancelled state.
  if (curStatus === 'cancelled' || curStatus === 'completed' || curStatus === 'failed') {
    return { updated: false, finalStatus: curStatus };
  }
  const canRetry = !!args.retryable && row && (row as any).attempts < (row as any).max_attempts;
  const { data: updated } = await sb.from('ai_source_sync_jobs').update({
    status: canRetry ? 'queued' : 'failed',
    last_error: (args.error || 'unknown_error').slice(0, 1000),
    finished_at: canRetry ? null : new Date().toISOString(),
    locked_by: null,
    locked_at: null,
    lock_expires_at: null,
  }).eq('id', args.jobId).in('status', ['running', 'queued']).select('id, status').maybeSingle();
  if (updated) return { updated: true, finalStatus: (updated as any).status };
  const { data: cur } = await sb
    .from('ai_source_sync_jobs').select('status').eq('id', args.jobId).maybeSingle();
  return { updated: false, finalStatus: (cur as any)?.status };
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