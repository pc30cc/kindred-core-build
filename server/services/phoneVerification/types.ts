/**
 * PHONE VERIFICATION — shared types and the sanitized error union.
 *
 * Nothing provider-specific ever crosses this boundary: the SMS vendor name,
 * template, sender/line number, provider message id and raw provider errors
 * stay inside the SMS service and the internal audit trail.
 */

export const PHONE_VERIFICATION_ERRORS = [
  'phone_verification_required',
  'phone_verification_not_allowed',
  'phone_invalid',
  'phone_country_not_supported',
  'phone_rate_limited',
  'phone_resend_too_soon',
  'phone_code_invalid',
  'phone_code_expired',
  'phone_attempts_exceeded',
  'phone_challenge_not_found',
  'phone_already_verified',
  'phone_verification_unavailable',
] as const;

export type PhoneVerificationErrorCode = (typeof PHONE_VERIFICATION_ERRORS)[number];

export class PhoneVerificationError extends Error {
  readonly code: PhoneVerificationErrorCode;
  readonly status: number;
  readonly retryAfterSeconds?: number;

  constructor(code: PhoneVerificationErrorCode, status = 400, retryAfterSeconds?: number) {
    super(code);
    this.name = 'PhoneVerificationError';
    this.code = code;
    this.status = status;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function isPhoneVerificationErrorCode(value: unknown): value is PhoneVerificationErrorCode {
  return typeof value === 'string' && (PHONE_VERIFICATION_ERRORS as readonly string[]).includes(value);
}

/** Verification lifetimes and abuse limits (shared with the DB rate rules). */
export const CHALLENGE_TTL_SECONDS = 300;
export const RESEND_COOLDOWN_SECONDS = 60;
export const MAX_ATTEMPTS = 5;

export type VerificationMethod = 'sms_otp' | 'admin_manual';

/** Server-internal state of a user's phone. `phone` is admin-only. */
export interface PhoneVerificationState {
  userId: string;
  phone: string | null;
  phoneMasked: string | null;
  country: string | null;
  verified: boolean;
  verifiedAt: string | null;
  verificationMethod: VerificationMethod | null;
  verifiedByAdminId: string | null;
  manualVerificationReason: string | null;
  hasActiveChallenge: boolean;
  activeChallengeId: string | null;
  challengeExpiresInSeconds: number | null;
  lastSentAt: string | null;
  lastCreatedAt: string | null;
  remainingAttempts: number | null;
}

/** User-facing status. Never carries another user's phone. */
export interface PhoneVerificationStatusResponse {
  required: boolean;
  satisfied: boolean;
  canVerify: boolean;
  phoneSet?: boolean;
  phoneMasked?: string | null;
  allowedCountries?: string[];
  resendAfterSeconds?: number;
  verifiedAt?: string | null;
  /** Resume support — only ever returned to the verification subject. */
  hasActiveChallenge?: boolean;
  activeChallengeId?: string | null;
  challengeExpiresInSeconds?: number | null;
  remainingAttempts?: number | null;
}

export interface PhoneChallengeResponse {
  success: true;
  challengeId: string;
  phoneMasked: string;
  expiresInSeconds: number;
  resendAfterSeconds: number;
}