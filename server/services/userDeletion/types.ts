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
  avatar_cleanup_done: boolean;
  purge_result: Record<string, unknown> | null;
  attempt_count: number;
  next_retry_at: string | null;
  locked_by: string | null;
  lease_expires_at: string | null;
  error_message: string | null;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  retried_by: string | null;
  retried_at: string | null;
}
