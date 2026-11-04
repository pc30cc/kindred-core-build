/**
 * AI KB Builder — Job queue provider abstraction.
 *
 * v1 implementation backs onto the public.ai_kb_jobs table (DbJobQueueProvider).
 * Future implementations (Redis/BullMQ, SQS, etc.) only need to implement the
 * JobQueueProvider interface — the worker and routes never touch raw queue
 * polling logic directly.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AiKbJobRow, AiKbJobStatus } from './types.js';

/** The statuses a job holds while a worker is on it. */
export const AI_KB_ACTIVE_STATUSES: AiKbJobStatus[] = ['running', 'crawling', 'extracting', 'generating'];

export interface JobQueueProvider {
  /** Atomically claim the next queued job for this worker, or null if none. */
  claimNext(workerId: string): Promise<AiKbJobRow | null>;

  /** Update mutable job fields (status/progress/counters/etc). */
  updateJob(jobId: string, patch: Partial<AiKbJobRow>): Promise<void>;

  /** Mark a job as terminally failed with an error message. */
  failJob(jobId: string, errorMessage: string): Promise<void>;

  /**
   * Fails the active jobs no worker has touched since `staleBefore`: a job's
   * row is written on every page and every draft, so one that has been quiet
   * that long belongs to a worker that is gone. Returns their ids.
   */
  failStaleJobs(staleBefore: Date, errorMessage: string): Promise<string[]>;

  /** Fails these jobs if they are still active (a worker shutting down mid-job). */
  failActiveJobs(jobIds: string[], errorMessage: string): Promise<void>;

  /** Append a structured event row for diagnostics. */
  recordEvent(
    jobId: string,
    workspaceId: string,
    level: 'info' | 'warn' | 'error',
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
}

/**
 * Default implementation: polls public.ai_kb_jobs and uses a conditional
 * UPDATE (status='queued' -> 'running') to atomically claim a job.
 */
export class DbJobQueueProvider implements JobQueueProvider {
  constructor(private sb: SupabaseClient) {}

  async claimNext(workerId: string): Promise<AiKbJobRow | null> {
    const { data: candidate } = await this.sb
      .from('ai_kb_jobs')
      .select('id')
      .eq('status', 'queued')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!candidate) return null;

    const now = new Date().toISOString();
    const { data: claimed } = await this.sb
      .from('ai_kb_jobs')
      .update({
        status: 'running' as AiKbJobStatus,
        worker_id: workerId,
        claimed_at: now,
        started_at: now,
      })
      .eq('id', (candidate as { id: string }).id)
      .eq('status', 'queued')
      .select('*')
      .maybeSingle();
    return (claimed as AiKbJobRow | null) || null;
  }

  async updateJob(jobId: string, patch: Partial<AiKbJobRow>): Promise<void> {
    await this.sb.from('ai_kb_jobs').update(patch as Record<string, unknown>).eq('id', jobId);
  }

  async failJob(jobId: string, errorMessage: string): Promise<void> {
    await this.sb
      .from('ai_kb_jobs')
      .update({
        status: 'failed' as AiKbJobStatus,
        error_message: errorMessage.slice(0, 1000),
        completed_at: new Date().toISOString(),
      } as Record<string, unknown>)
      .eq('id', jobId);
  }

  async failStaleJobs(staleBefore: Date, errorMessage: string): Promise<string[]> {
    const { data, error } = await this.sb
      .from('ai_kb_jobs')
      .update({
        status: 'failed' as AiKbJobStatus,
        error_message: errorMessage.slice(0, 1000),
        completed_at: new Date().toISOString(),
      } as Record<string, unknown>)
      .in('status', AI_KB_ACTIVE_STATUSES)
      .lt('updated_at', staleBefore.toISOString())
      .select('id');
    if (error) throw new Error(error.message);
    return ((data as Array<{ id: string }> | null) || []).map((r) => r.id);
  }

  async failActiveJobs(jobIds: string[], errorMessage: string): Promise<void> {
    if (jobIds.length === 0) return;
    await this.sb
      .from('ai_kb_jobs')
      .update({
        status: 'failed' as AiKbJobStatus,
        error_message: errorMessage.slice(0, 1000),
        completed_at: new Date().toISOString(),
      } as Record<string, unknown>)
      .in('id', jobIds)
      .in('status', AI_KB_ACTIVE_STATUSES);
  }

  async recordEvent(
    jobId: string,
    workspaceId: string,
    level: 'info' | 'warn' | 'error',
    message: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await this.sb.from('ai_kb_job_events').insert({
      job_id: jobId,
      workspace_id: workspaceId,
      level,
      message: message.slice(0, 500),
      metadata,
    });
  }
}
