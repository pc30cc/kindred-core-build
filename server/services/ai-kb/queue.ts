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

export interface JobQueueProvider {
  /** Atomically claim the next queued job for this worker, or null if none. */
  claimNext(workerId: string): Promise<AiKbJobRow | null>;

  /** Update mutable job fields (status/progress/counters/etc). */
  updateJob(jobId: string, patch: Partial<AiKbJobRow>): Promise<void>;

  /** Mark a job as terminally failed with an error message. */
  failJob(jobId: string, errorMessage: string): Promise<void>;

  /** Append a structured event row for diagnostics. */
  recordEvent(
    jobId: string,
    workspaceId: string,
    level: 'info' | 'warn' | 'error',
    message: string,
    metadata?: Record<string, any>,
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
      .eq('id', (candidate as any).id)
      .eq('status', 'queued')
      .select('*')
      .maybeSingle();
    return (claimed as AiKbJobRow | null) || null;
  }

  async updateJob(jobId: string, patch: Partial<AiKbJobRow>): Promise<void> {
    await this.sb.from('ai_kb_jobs').update(patch as any).eq('id', jobId);
  }

  async failJob(jobId: string, errorMessage: string): Promise<void> {
    await this.sb
      .from('ai_kb_jobs')
      .update({
        status: 'failed' as AiKbJobStatus,
        error_message: errorMessage.slice(0, 1000),
        completed_at: new Date().toISOString(),
      } as any)
      .eq('id', jobId);
  }

  async recordEvent(
    jobId: string,
    workspaceId: string,
    level: 'info' | 'warn' | 'error',
    message: string,
    metadata: Record<string, any> = {},
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
