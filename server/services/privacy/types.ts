/**
 * Privacy module — shared types.
 *
 * Subject resolution comes from the SQL function `resolve_privacy_subject`
 * (see migration). The worker uses this set as the canonical filter for
 * every export and delete query — never the raw subject_id.
 */

export type PrivacyAction = 'export' | 'delete';
export type PrivacySubjectType = 'contact' | 'visitor' | 'user';
export type PrivacyJobStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ResolvedSubject {
  contact_ids: string[];
  visitor_ids: string[];
  emails: string[];
}

export interface PrivacyJobRow {
  id: string;
  workspace_id: string | null;
  actor_user_id: string;
  subject_type: PrivacySubjectType;
  subject_id: string;
  subject_email_hash: string | null;
  resolved_identity: ResolvedSubject;
  action: PrivacyAction;
  status: PrivacyJobStatus;
  scope: Record<string, unknown>;
  artifact_path: string | null;
  artifact_hash: string | null;
  artifact_size_bytes: number | null;
  download_count: number;
  download_token_hash: string | null;
  expires_at: string | null;
  error_message: string | null;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
}

export interface PrivacyJobScope {
  /** Include internal-only conversation_notes in export. Default false. */
  include_notes?: boolean;
}