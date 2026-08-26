/**
 * Notification preferences API — self-hosted Express endpoint.
 * Auth is the first-party gs_session HttpOnly cookie (credentials: 'include').
 */
const API_BASE = import.meta.env.VITE_API_BASE_URL;

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

export interface NotificationPrefs {
  disable_all: boolean;
  push_when_online: boolean;
  push_when_offline: boolean;
  push_visitor_browsing: boolean;
  play_sound: boolean;
  email_unread_messages: boolean;
  email_transcripts: boolean;
  email_user_ratings: boolean;
  email_paid_invoices: boolean;
  email_weekly_summary: boolean;
  email_product_updates: boolean;
  quiet_hours_enabled: boolean;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  quiet_hours_timezone: string | null;
}

export function fetchNotificationPrefs() {
  return request<{ prefs: NotificationPrefs }>('/api/notifications/prefs');
}

export function updateNotificationPrefs(updates: Partial<NotificationPrefs>) {
  return request<{ prefs: NotificationPrefs }>('/api/notifications/prefs', {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}
