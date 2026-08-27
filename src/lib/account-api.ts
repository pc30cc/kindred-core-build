import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';
/**
 * Account API — self-service profile, avatar, and password for the
 * currently authenticated user. Auth is the first-party gs_session
 * HttpOnly cookie (credentials: 'include').
 */
const API_BASE = RESOLVED_API_BASE;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init?.headers as Record<string, string>) || {}),
  };
  const res = await fetch(`${API_BASE}${path}`, { credentials: 'include', ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as any)?.error || `Request failed: ${res.status}`);
  return body as T;
}

export interface AccountMe {
  id: string;
  email: string | null;
  email_confirmed_at: string | null;
  phone: string | null;
  created_at: string;
  profile: {
    id: string;
    email: string;
    full_name: string | null;
    avatar_url: string | null;
    preferred_locale: string | null;
    company_name: string | null;
    website_domain: string | null;
    [k: string]: unknown;
  } | null;
}

export function fetchAccountMe() {
  return request<AccountMe>('/api/account/me');
}

export interface AccountUpdate {
  full_name?: string | null;
  first_name?: string;
  last_name?: string;
  preferred_locale?: string | null;
  company_name?: string | null;
  website_domain?: string | null;
  phone?: string | null;
}

export function updateAccount(updates: AccountUpdate) {
  return request<{ success: boolean; profile: AccountMe['profile'] }>('/api/account/me', {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

/** Read a File as a base64 string (no data: prefix). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

export async function uploadAccountAvatar(file: File) {
  if (file.size > 10 * 1024 * 1024) {
    throw new Error('Avatar must be smaller than 10 MB');
  }
  const data = await fileToBase64(file);
  return request<{ success: boolean; url: string; fileKey: string }>('/api/account/avatar', {
    method: 'POST',
    body: JSON.stringify({
      data,
      contentType: file.type || 'image/jpeg',
      fileName: file.name,
    }),
  });
}

export function removeAccountAvatar() {
  return request<{ success: boolean }>('/api/account/avatar', { method: 'DELETE' });
}

export function changeAccountPassword(currentPassword: string, newPassword: string) {
  return request<{ success: boolean }>('/api/account/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

// ── Security ───────────────────────────────────────────────────

export interface AccountSecuritySession {
  id: string;
  is_current: boolean;
  created_at: string | null;
  last_active_at: string | null;
  not_after: string | null;
  user_agent_raw: string | null;
  browser: string;
  os: string;
  device: string;
  ip: string;
  country: string | null;
  country_code: string | null;
  city: string | null;
  region: string | null;
}

export interface AccountLoginHistoryEntry {
  id: string;
  created_at: string;
  success: boolean;
  ip: string;
  country: string | null;
  country_code: string | null;
  city: string | null;
  region: string | null;
}

export function fetchSecuritySessions() {
  return request<{ sessions: AccountSecuritySession[]; current_session_id: string | null }>(
    '/api/account/security/sessions'
  );
}

export function revokeSecuritySession(id: string) {
  return request<{ success: boolean }>(`/api/account/security/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export function revokeAllOtherSessions() {
  return request<{ success: boolean }>(`/api/account/security/sessions/all?all=1`, {
    method: 'DELETE',
  });
}

export function fetchSecurityLoginHistory(limit = 25) {
  return request<{ entries: AccountLoginHistoryEntry[] }>(
    `/api/account/security/login-history?limit=${limit}`
  );
}

// ── Workspace icon ─────────────────────────────────────────────

export async function uploadWorkspaceIcon(workspaceId: string, file: File) {
  if (file.size > 5 * 1024 * 1024) {
    throw new Error('Icon must be smaller than 5 MB');
  }
  const data = await fileToBase64(file);
  return request<{ success: boolean; url: string; fileKey: string }>(
    '/api/account/workspace-icon',
    {
      method: 'POST',
      body: JSON.stringify({
        workspaceId,
        data,
        contentType: file.type || 'image/png',
        fileName: file.name,
      }),
    },
  );
}

export function removeWorkspaceIcon(workspaceId: string) {
  return request<{ success: boolean }>(
    `/api/account/workspace-icon?workspaceId=${encodeURIComponent(workspaceId)}`,
    { method: 'DELETE' },
  );
}