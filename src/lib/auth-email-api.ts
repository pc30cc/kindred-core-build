/**
 * Auth Email API — sends auth emails through configured provider
 * instead of Supabase's built-in emails.
 */

const API_BASE = import.meta.env.VITE_API_BASE_URL;

if (!API_BASE && import.meta.env.PROD) {
  console.error('[auth-email-api] VITE_API_BASE_URL is not set. Auth API calls will fail.');
}


async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {credentials: 'include', 
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `API error: ${res.status}`);
  return data;
}

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
