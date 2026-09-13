/**
 * Central data-retention domain types. Mirrors
 * database/migrations/169_data_retention.sql exactly — the DB is the source
 * of truth for the policy model, this file only types it.
 */

export type RetentionCategory =
  | 'core' | 'financial' | 'audit' | 'telemetry' | 'analytics' | 'seo' | 'ai_debug' | 'security';

export type RetentionMode = 'permanent' | 'rolling' | 'latest_n_runs' | 'archive_then_delete';

export type RetentionRunStatus = 'running' | 'completed' | 'partial' | 'failed' | 'skipped';

export interface RetentionPolicy {
  id: string;
  policy_key: string;
  table_name: string;
  timestamp_column: string;
  category: RetentionCategory;
  retention_mode: RetentionMode;
  hot_retention_days: number | null;
  keep_last_n: number | null;
  partition_column: string | null;
  archive_enabled: boolean;
  archive_after_days: number | null;
  delete_after_archive: boolean;
  workspace_overridable: boolean;
  enabled: boolean;
  batch_size: number;
  description: string | null;
  metadata: Record<string, unknown>;
  last_run_at: string | null;
  last_run_status: string | null;
  last_rows_deleted: number | null;
  last_error: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RetentionRun {
  id: string;
  policy_id: string;
  policy_key: string;
  dry_run: boolean;
  triggered_by: string;
  actor_user_id: string | null;
  started_at: string;
  finished_at: string | null;
  status: RetentionRunStatus;
  rows_matched: number;
  rows_archived: number;
  rows_deleted: number;
  bytes_archived: number | null;
  batches: number;
  error: string | null;
  metadata: Record<string, unknown>;
}

/**
 * Categories whose policies may never be switched to a deleting mode from
 * the admin UI. The database CHECK constraint already guarantees a
 * `permanent` policy cannot carry a retention window; this is the second,
 * server-side half of that guarantee (it stops the MODE itself changing).
 */
export const PROTECTED_CATEGORIES: ReadonlySet<RetentionCategory> = new Set(['financial', 'core']);

/** Fields an operator is allowed to edit through the admin UI. */
export const EDITABLE_FIELDS = [
  'enabled',
  'hot_retention_days',
  'keep_last_n',
  'archive_enabled',
  'archive_after_days',
  'delete_after_archive',
  'batch_size',
  'description',
] as const;

export type EditableField = (typeof EDITABLE_FIELDS)[number];

export function isProtected(policy: Pick<RetentionPolicy, 'category' | 'retention_mode'>): boolean {
  return PROTECTED_CATEGORIES.has(policy.category) || policy.retention_mode === 'permanent';
}
