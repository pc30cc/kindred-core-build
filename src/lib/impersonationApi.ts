/**
 * Super Admin "Login as User" — the panel side of POST /api/auth/impersonate,
 * POST /api/auth/impersonate/stop and the `impersonator` field of
 * GET /api/auth/session (server/routes/auth.ts). Every call goes to the API
 * host, so the cookies it sets are the ones the panel sends.
 */
import { API_BASE } from './apiBase';
import { authFetch } from './authFetch';

export interface Impersonator {
  id: string;
  email: string;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await authFetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error || `API error: ${res.status}`);
  return json;
}

/** Redeems a "login as user" token (the /impersonate page). */
export function redeemImpersonationToken(token: string) {
  return postJson<{ success: boolean; redirect: string }>('/api/auth/impersonate', { token });
}

/** "Back to Super Admin": ends the impersonation and restores the admin's session. */
export function stopImpersonation() {
  return postJson<{ success: boolean; restored: boolean; redirect: string }>('/api/auth/impersonate/stop', {});
}

/** The Super Admin behind the current session, or null when nobody is impersonating. */
export async function fetchImpersonator(): Promise<Impersonator | null> {
  try {
    const res = await authFetch(`${API_BASE}/api/auth/session`, { cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json()) as { impersonator?: Partial<Impersonator> | null };
    const imp = body.impersonator;
    return imp?.id ? { id: imp.id, email: imp.email ?? '' } : null;
  } catch {
    return null;
  }
}
