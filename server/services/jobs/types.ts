// ============================================
// GENERIC BACKGROUND JOB TYPES
//
// `background_jobs` is deliberately domain-agnostic: it knows nothing about
// SEO crawling, DNS checks, SSL checks, or any other future worker kind.
// Domain-specific business objects (e.g. seo_crawls) reference a job by id
// and read their own state from their own table — never from `payload`.
// ============================================

export type JobStatus = 'queued' | 'running' | 'processing' | 'completed' | 'failed' | 'cancelled';

export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set(['completed', 'failed', 'cancelled']);

export interface BackgroundJob {
  id: string;
  workspace_id: string;
  job_type: string;
  subject_type: string;
  subject_id: string;
  status: JobStatus;
  priority: number;
  locked_by: string | null;
  locked_at: string | null;
  lock_expires_at: string | null;
  attempts: number;
  max_attempts: number;
  progress: number;
  progress_stage: string | null;
  cancel_requested: boolean;
  error_message: string | null;
  error_category: string | null;
  payload: Record<string, unknown>;
  created_by: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}
