export type { ScopeProgress, ScopeCleanupState as StorageScopesState } from '../storage/scopeCleanupEngine.js';

export type WorkspaceDeletionJobStatus = 'pending' | 'storage_cleanup' | 'db_cleanup' | 'completed' | 'failed';

export interface WorkspaceDeletionJobRow {
  id: string;
  workspace_id: string;
  workspace_slug: string;
  workspace_name: string;
  requested_by: string;
  status: WorkspaceDeletionJobStatus;
  storage_scopes: import('../storage/scopeCleanupEngine.js').ScopeCleanupState;
  attempt_count: number;
  next_retry_at: string | null;
  locked_by: string | null;
  /** Fencing token — 185_deletion_lease_fencing.sql. Every progress/status write must be conditioned on this exact value matching the row's current one. */
  lease_token: string | null;
  lease_expires_at: string | null;
  db_cleanup_completed_at: string | null;
  error_message: string | null;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  retried_by: string | null;
  retried_at: string | null;
  // Legacy columns from 180_workspace_deletion_lifecycle.sql — no longer
  // written by new code (superseded by storage_scopes), kept only because
  // forward-only migrations never drop a shipped column.
  storage_objects_found: number | null;
  storage_objects_deleted: number;
  storage_cursor: string | null;
  storage_cleanup_error: string | null;
}
