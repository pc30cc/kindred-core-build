/**
 * Auth API client — fully backend-driven auth.
 * All auth goes through the self-hosted backend, not Supabase browser client.
 */

const API_BASE = import.meta.env.VITE_API_BASE_URL;

if (!API_BASE && import.meta.env.PROD) {
  console.error('[auth-email-api] VITE_API_BASE_URL is not set. Auth API calls will fail.');
}

/** Session token stored in memory for Bearer auth (fallback if cookies don't work cross-origin) */
let sessionToken: string | null = null;

export function getSessionToken(): string | null {
  if (sessionToken) return sessionToken;
  // Also check localStorage as fallback for cross-origin scenarios
  try {
    return localStorage.getItem('app_session_token');
  } catch {
    return null;
  }
}

export function setSessionToken(token: string | null) {
  sessionToken = token;
  try {
    if (token) {
      localStorage.setItem('app_session_token', token);
    } else {
      localStorage.removeItem('app_session_token');
    }
  } catch {
    // localStorage unavailable
  }
}

function authHeaders(): Record<string, string> {
  const token = getSessionToken();
  return token ? { 'Authorization': `Bearer ${token}` } : {};
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
    credentials: 'include', // send cookies
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `API error: ${res.status}`);
  return data;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    credentials: 'include',
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `API error: ${res.status}`);
  return data;
}

// ─── Auth endpoints ──────────────────────────────────────────────

export interface AuthUserResponse {
  id: string;
  email: string;
  emailVerified: boolean;
  metadata?: Record<string, unknown>;
  fullName?: string | null;
  createdAt?: string | null;
}

/** Sign up — creates user and issues session immediately */
export async function authSignUp(data: {
  email: string;
  password: string;
  website?: string;
  fullName?: string;
  locale?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ user: AuthUserResponse; sessionToken: string; needsEmailVerification: boolean }> {
  const result = await post<{
    user: AuthUserResponse;
    sessionToken: string;
    needsEmailVerification: boolean;
  }>('/api/auth-email/signup', data);
  setSessionToken(result.sessionToken);
  return result;
}

/** Login — validates credentials and issues session */
export async function authLogin(data: {
  email: string;
  password: string;
}): Promise<{ user: AuthUserResponse; sessionToken: string }> {
  const result = await post<{
    user: AuthUserResponse;
    sessionToken: string;
  }>('/api/auth-email/login', data);
  setSessionToken(result.sessionToken);
  return result;
}

/** Get current user from session */
export async function authGetMe(): Promise<{ user: AuthUserResponse | null }> {
  return get<{ user: AuthUserResponse | null }>('/api/auth-email/me');
}

/** Logout — revoke session */
export async function authLogout(): Promise<void> {
  await post<{ success: boolean }>('/api/auth-email/logout', {});
  setSessionToken(null);
}

// ─── Verification & reset (unchanged API) ────────────────────────

/** Send verification email via configured provider */
export function sendVerificationEmail(email: string, locale?: string) {
  return post<{ success: boolean }>('/api/auth-email/send-verification', { email, locale });
}

/** Verify email token */
export function verifyEmailToken(token: string) {
  return post<{ success: boolean; email?: string }>('/api/auth-email/verify-email', { token });
}

/** Send password reset email via configured provider */
export function sendResetEmail(email: string, locale?: string) {
  return post<{ success: boolean }>('/api/auth-email/send-reset', { email, locale });
}

/** Reset password with token */
export function resetPasswordWithToken(token: string, newPassword: string) {
  return post<{ success: boolean }>('/api/auth-email/reset-password', { token, newPassword });
}

/** Resend verification email */
export function resendVerificationEmail(email: string, locale?: string) {
  return post<{ success: boolean }>('/api/auth-email/resend-verification', { email, locale });
}
