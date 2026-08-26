/**
 * Privacy API client. Auth is the first-party gs_session HttpOnly cookie
 * (credentials: 'include').
 */
const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

export type PrivacyAction = 'export' | 'delete';
export type PrivacySubjectType = 'contact' | 'visitor' | 'user';
export type PrivacyJobStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface PrivacyJob {
  id: string;
  workspace_id: string | null;
  actor_user_id: string;
  subject_type: PrivacySubjectType;
  subject_id: string;
  subject_email_hash: string | null;
  resolved_identity: { contact_ids: string[]; visitor_ids: string[]; emails: string[] };
  action: PrivacyAction;
  status: PrivacyJobStatus;
  scope: Record<string, unknown>;
  artifact_path: string | null;
  artifact_hash: string | null;
  artifact_size_bytes: number | null;
  download_count: number;
  expires_at: string | null;
  error_message: string | null;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  const body = text ? safeJson(text) : null;
  if (!res.ok) {
    const err: any = new Error((body && (body.error as string)) || `Request failed: ${res.status}`);
    err.code = body?.code;
    err.status = res.status;
    throw err;
  }
  return body as T;
}

function safeJson(t: string): any {
  try { return JSON.parse(t); } catch { return null; }
}

// ─── Reauth ────────────────────────────────────────────────────────
export function reauthWithPassword(password: string) {
  return api<{ token: string; expiresAt: number }>('/api/privacy/reauth', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

// ─── Jobs ──────────────────────────────────────────────────────────
export function listJobs(workspaceId?: string) {
  const qs = workspaceId ? `?workspace_id=${encodeURIComponent(workspaceId)}` : '';
  return api<{ jobs: PrivacyJob[] }>(`/api/privacy/jobs${qs}`);
}

export function getJob(id: string) {
  return api<{ job: PrivacyJob }>(`/api/privacy/jobs/${id}`);
}

export interface CreateJobInput {
  subject_type: PrivacySubjectType;
  subject_id: string;
  action: PrivacyAction;
  workspace_id?: string;
  scope?: { include_notes?: boolean };
  reauth_token?: string;
}

export function createJob(input: CreateJobInput) {
  return api<{ job: PrivacyJob }>(`/api/privacy/jobs`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function cancelJob(id: string) {
  return api<{ job: PrivacyJob }>(`/api/privacy/jobs/${id}/cancel`, { method: 'POST' });
}

export function mintDownloadToken(id: string) {
  return api<{ token: string; expiresAt: string | null }>(`/api/privacy/jobs/${id}/download-token`, {
    method: 'POST',
  });
}

export function exportDownloadUrl(jobId: string, token: string): string {
  return `${API_BASE}/api/privacy/exports/${jobId}/download?token=${encodeURIComponent(token)}`;
}
