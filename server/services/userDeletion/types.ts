export type { ScopeCleanupState as StorageScopesState } from '../storage/scopeCleanupEngine.js';

export type UserDeletionJobStatus =
  | 'collecting_workspaces'
  | 'awaiting_workspace_deletions'
  | 'purging_user'
  | 'completed'
  | 'failed';

export interface UserDeletionJobRow {
  id: string;
  user_id: string;
  user_email: string | null;
  requested_by: string;
  status: UserDeletionJobStatus;
  workspace_ids: string[];
  /** Per-physical-scope progress for the users/<id>/ prefix — see 186_user_deletion_multi_provider.sql. */
  storage_scopes: import('../storage/scopeCleanupEngine.js').ScopeCleanupState;
  /** Legacy single-scope flag from 183 — no longer written by new code (superseded by storage_scopes), kept because forward-only migrations never drop a shipped column. */
  avatar_cleanup_done: boolean;
  purge_result: Record<string, unknown> | null;
  attempt_count: number;
  next_retry_at: string | null;
  locked_by: string | null;
  /** Fencing token — 185_deletion_lease_fencing.sql. Every progress/status write must be conditioned on this exact value matching the row's current one. */
  lease_token: string | null;
  lease_expires_at: string | null;
  error_message: string | null;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  retried_by: string | null;
  retried_at: string | null;
}
