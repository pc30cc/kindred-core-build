export type WorkspaceDeletionJobStatus = 'pending' | 'storage_cleanup' | 'db_cleanup' | 'completed' | 'failed';

export interface WorkspaceDeletionJobRow {
  id: string;
  workspace_id: string;
  workspace_slug: string;
  workspace_name: string;
  requested_by: string;
  status: WorkspaceDeletionJobStatus;
  storage_objects_found: number | null;
  storage_objects_deleted: number;
  storage_cursor: string | null;
  storage_cleanup_error: string | null;
  db_cleanup_completed_at: string | null;
  error_message: string | null;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
}
