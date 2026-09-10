/**
 * Signup email verification — client helpers.
 *
 * Two operator-selected axes, both resolved server-side and merely READ
 * here (never assumed): how the code/link is delivered (`method`) and
 * whether a workspace exists before verification (`gate`). Everything goes
 * through this app's own Express backend.
 */
import { API_BASE } from './apiBase';

export type SignupVerificationMethod = 'link' | 'otp';
export type SignupVerificationGate = 'before' | 'after';

export interface SignupVerificationPolicy {
  method: SignupVerificationMethod;
  gate: SignupVerificationGate;
}

/** Historical behaviour — also the fallback whenever the read fails. */
export const DEFAULT_SIGNUP_POLICY: SignupVerificationPolicy = { method: 'link', gate: 'before' };

export async function fetchSignupPolicy(): Promise<SignupVerificationPolicy> {
  try {
    const res = await fetch(`${API_BASE}/api/auth/signup-policy`, { credentials: 'include' });
    if (!res.ok) return DEFAULT_SIGNUP_POLICY;
    const json = await res.json();
    return {
      method: json?.method === 'otp' ? 'otp' : 'link',
      gate: json?.gate === 'after' ? 'after' : 'before',
    };
  } catch {
    return DEFAULT_SIGNUP_POLICY;
  }
}

export interface EmailOtpChallenge {
  handle: string;
  expiresAt: string;
  resendAvailableAt: string;
  delivered: boolean;
  alreadyVerified?: boolean;
}

export class EmailOtpError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.name = 'EmailOtpError';
    this.code = code;
  }
}

async function otpPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API_BASE}/api/auth-email/otp/${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new EmailOtpError(json?.error || json?.reason || 'unknown');
  return json as T;
}

/** Ask for a fresh 6-digit code for the signed-in account's own email. */
export function startEmailOtp(locale?: string) {
  return otpPost<EmailOtpChallenge>('start', { locale });
}

/** Resend the code for one specific in-flight challenge. */
export function resendEmailOtp(handle: string, locale?: string) {
  return otpPost<EmailOtpChallenge>('resend', { handle, locale });
}

/**
 * Submit a code. `requestId` is stable per submit attempt so a retried
 * network call replays the same outcome instead of burning an attempt.
 */
export function verifyEmailOtp(handle: string, code: string, requestId: string) {
  return otpPost<{ ok: boolean; email?: string; alreadyVerified?: boolean }>('verify', {
    handle,
    code,
    requestId,
  });
}
