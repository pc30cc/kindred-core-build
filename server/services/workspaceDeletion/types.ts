import type { WorkspaceStorageScopeName } from '../storage/workspaceScopes.js';

export type WorkspaceDeletionJobStatus = 'pending' | 'storage_cleanup' | 'db_cleanup' | 'completed' | 'failed';

export type ScopeProgressStatus = 'pending' | 'in_progress' | 'done' | 'skipped_not_configured' | 'failed';

export interface ScopeProgress {
  status: ScopeProgressStatus;
  cursor: string | null;
  objects_found: number;
  objects_deleted: number;
  error: string | null;
  /** Set once the scope's config is resolved, even before it's fully drained — lets a later scope dedupe against it. */
  fingerprint: string | null;
  /** Set when this scope was skipped because another scope with the same fingerprint already covered it. */
  dedup_of: WorkspaceStorageScopeName | null;
}

export type StorageScopesState = Partial<Record<WorkspaceStorageScopeName, ScopeProgress>>;

export interface WorkspaceDeletionJobRow {
  id: string;
  workspace_id: string;
  workspace_slug: string;
  workspace_name: string;
  requested_by: string;
  status: WorkspaceDeletionJobStatus;
  storage_scopes: StorageScopesState;
  attempt_count: number;
  next_retry_at: string | null;
  locked_by: string | null;
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
