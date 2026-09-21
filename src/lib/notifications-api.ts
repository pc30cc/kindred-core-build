import { API_BASE as RESOLVED_API_BASE } from '@/lib/apiBase';
/**
 * Notification preferences API — self-hosted Express endpoint.
 * Auth is the first-party gs_session HttpOnly cookie (credentials: 'include').
 *
 * These are the BROWSER's preferences. The phone app keeps its own set under
 * its own surface, and every request here says so: they were one row, so an
 * operator who silenced their phone at midnight silenced this too.
 */
const API_BASE = RESOLVED_API_BASE;

/** The surface this client speaks for. */
export const PLATFORM = 'web';

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

/** Which conversations are worth telling this operator about. */
export type NotificationScope = 'all' | 'assigned' | 'mentions' | 'none';

/**
 * Only what something actually enforces.
 *
 * Six email switches and a "visitor browsing" one used to be here. Nothing in
 * the codebase read any of them — there is no unread digest, no operator
 * transcript mail, billing mail goes to the workspace's billing contact, and
 * nothing emits a browsing event — so they saved, answered 200, and changed
 * nothing. Each of these is read: by `services/push/recipients.ts` before the
 * server sends to a phone, and by this app before it draws a banner or plays
 * the chime.
 */
export interface NotificationPrefs {
  disable_all: boolean;
  push_scope: NotificationScope;
  push_preview: boolean;
  push_internal_notes: boolean;
  push_when_online: boolean;
  push_when_offline: boolean;
  play_sound: boolean;
  quiet_hours_enabled: boolean;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  quiet_hours_timezone: string | null;
}

export function fetchNotificationPrefs() {
  return request<{ platform: string; prefs: NotificationPrefs }>(
    `/api/notifications/prefs?platform=${PLATFORM}`,
  );
}

export function updateNotificationPrefs(updates: Partial<NotificationPrefs>) {
  return request<{ platform: string; prefs: NotificationPrefs }>('/api/notifications/prefs', {
    method: 'PATCH',
    body: JSON.stringify({ ...updates, platform: PLATFORM }),
  });
}
