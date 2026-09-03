/**
 * Generic background-job queue — poll + conditional-claim, matching the
 * proven `ai_source_sync_jobs` pattern (server/services/ai-agent/sourceJobs.ts)
 * exactly, but generalized so ANY future worker kind (SEO crawl, DNS check,
 * SSL check, uptime, performance audit, ...) can share one table and one
 * claim/heartbeat/retry contract instead of every worker inventing its own.
 *
 * No in-memory queue, no external queue library (this repo has none — every
 * background worker here polls Postgres with an atomic conditional UPDATE).
 * Single source of truth: `background_jobs`.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import type { BackgroundJob, JobStatus } from './types.js';

export async function enqueueJob(
  config: ServerConfig,
  args: {
    workspaceId: string;
    jobType: string;
    subjectType: string;
    subjectId: string;
    priority?: number;
    maxAttempts?: number;
    payload?: Record<string, unknown>;
    createdBy?: string | null;
  },
): Promise<BackgroundJob> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('background_jobs')
    .insert({
      workspace_id: args.workspaceId,
      job_type: args.jobType,
      subject_type: args.subjectType,
      subject_id: args.subjectId,
      priority: args.priority ?? 100,
      max_attempts: args.maxAttempts ?? 2,
      payload: args.payload || {},
      created_by: args.createdBy ?? null,
    })
    .select('*')
    .single();
  if (error || !data) throw new Error(`enqueue_job_failed: ${error?.message}`);
  return data as BackgroundJob;
}

/**
 * Atomic claim. Eligible rows:
 *   - status='queued', or
 *   - status='running'/'processing' AND lock_expires_at < now (crashed worker)
 * The candidate lookup and the conditional UPDATE race on (id, current
 * status), so two workers polling concurrently can never claim the same row.
 */
export async function claimNextJob(
  config: ServerConfig,
  args: { jobTypes: string[]; workerId: string; lockTtlSeconds: number },
): Promise<BackgroundJob | null> {
  const sb = getServiceClient(config);
  const nowIso = new Date().toISOString();

  const { data: cand } = await sb
    .from('background_jobs')
    .select('id, status, attempts, max_attempts')
    .in('job_type', args.jobTypes)
    .or(`status.eq.queued,and(status.in.(running,processing),lock_expires_at.lt.${nowIso})`)
    .order('priority', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!cand) return null;

  const candRow = cand as { id: string; status: JobStatus; attempts: number; max_attempts: number };
  if (candRow.attempts >= candRow.max_attempts) {
    await sb
      .from('background_jobs')
      .update({ status: 'failed', finished_at: nowIso, error_category: 'limit_exceeded', error_message: 'max_attempts_exceeded' })
      .eq('id', candRow.id)
      .in('status', ['queued', 'running', 'processing']);
    return null;
  }

  const lockExpires = new Date(Date.now() + args.lockTtlSeconds * 1000).toISOString();
  const { data: claimed } = await sb
    .from('background_jobs')
    .update({
      status: 'running',
      locked_by: args.workerId,
      locked_at: nowIso,
      lock_expires_at: lockExpires,
      attempts: candRow.attempts + 1,
      started_at: nowIso,
      progress: 0,
      progress_stage: null,
      error_message: null,
      error_category: null,
    })
    .eq('id', candRow.id)
    .eq('status', candRow.status)
    .select('*')
    .maybeSingle();
  return (claimed as BackgroundJob) || null;
}

/** Extends the lock and reports progress. Also the point where a worker learns cancellation was requested. */
export async function heartbeatJob(
  config: ServerConfig,
  args: { jobId: string; workerId: string; lockTtlSeconds: number; progress?: number; progressStage?: string; status?: 'running' | 'processing' },
): Promise<{ ok: boolean; cancelRequested: boolean }> {
  const sb = getServiceClient(config);
  const update: Record<string, unknown> = {
    lock_expires_at: new Date(Date.now() + args.lockTtlSeconds * 1000).toISOString(),
  };
  if (typeof args.progress === 'number') update.progress = Math.max(0, Math.min(100, Math.round(args.progress)));
  if (args.progressStage) update.progress_stage = args.progressStage;
  if (args.status) update.status = args.status;

  const { data } = await sb
    .from('background_jobs')
    .update(update)
    .eq('id', args.jobId)
    .eq('locked_by', args.workerId)
    .select('cancel_requested')
    .maybeSingle();
  if (!data) return { ok: false, cancelRequested: false };
  return { ok: true, cancelRequested: !!(data as { cancel_requested: boolean }).cancel_requested };
}

export async function completeJob(
  config: ServerConfig,
  args: { jobId: string },
): Promise<{ updated: boolean }> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('background_jobs')
    .update({ status: 'completed', progress: 100, finished_at: new Date().toISOString(), error_message: null, error_category: null })
    .eq('id', args.jobId)
    .in('status', ['running', 'processing'])
    .select('id')
    .maybeSingle();
  return { updated: !!data };
}

/** Terminal error categories that must never be retried (validation/security failures). */
const NON_RETRYABLE_CATEGORIES = new Set(['invalid_target', 'blocked_target', 'cancelled', 'limit_exceeded']);

export async function failJob(
  config: ServerConfig,
  args: { jobId: string; errorMessage: string; errorCategory: string; retryable?: boolean },
): Promise<{ updated: boolean; finalStatus?: JobStatus }> {
  const sb = getServiceClient(config);
  const { data: row } = await sb
    .from('background_jobs')
    .select('attempts, max_attempts, status')
    .eq('id', args.jobId)
    .maybeSingle();
  if (!row) return { updated: false };
  const cur = row as { attempts: number; max_attempts: number; status: JobStatus };
  if (cur.status === 'cancelled' || cur.status === 'completed' || cur.status === 'failed') {
    return { updated: false, finalStatus: cur.status };
  }
  const retryable = !!args.retryable && !NON_RETRYABLE_CATEGORIES.has(args.errorCategory) && cur.attempts < cur.max_attempts;
  const { data: updated } = await sb
    .from('background_jobs')
    .update({
      status: retryable ? 'queued' : 'failed',
      error_message: (args.errorMessage || 'unknown_error').slice(0, 1000),
      error_category: args.errorCategory,
      finished_at: retryable ? null : new Date().toISOString(),
      locked_by: null,
      locked_at: null,
      lock_expires_at: null,
    })
    .eq('id', args.jobId)
    .in('status', ['running', 'processing', 'queued'])
    .select('status')
    .maybeSingle();
  return { updated: !!updated, finalStatus: (updated as { status: JobStatus } | null)?.status };
}

/** Cooperative cancel: sets a flag the worker observes at its next heartbeat/page boundary. */
export async function requestJobCancel(config: ServerConfig, jobId: string): Promise<void> {
  const sb = getServiceClient(config);
  await sb.from('background_jobs').update({ cancel_requested: true }).eq('id', jobId).in('status', ['queued', 'running', 'processing']);
}

/** Worker-side acknowledgement: the worker itself observed cancel_requested and stopped mid-run. */
export async function acknowledgeJobCancel(config: ServerConfig, jobId: string): Promise<void> {
  const sb = getServiceClient(config);
  await sb
    .from('background_jobs')
    .update({ status: 'cancelled', finished_at: new Date().toISOString() })
    .eq('id', jobId)
    .in('status', ['running', 'processing']);
}

export async function cancelQueuedJob(config: ServerConfig, jobId: string): Promise<void> {
  const sb = getServiceClient(config);
  await sb
    .from('background_jobs')
    .update({ status: 'cancelled', finished_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('status', 'queued');
}

export async function getJob(config: ServerConfig, jobId: string): Promise<BackgroundJob | null> {
  const sb = getServiceClient(config);
  const { data } = await sb.from('background_jobs').select('*').eq('id', jobId).maybeSingle();
  return (data as BackgroundJob | null) ?? null;
}
