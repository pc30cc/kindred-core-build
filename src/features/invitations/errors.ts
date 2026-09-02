/**
 * Workspace Invitations v5.1 — language-neutral API error codes mapped to
 * localized UI strings.
 *
 * The server NEVER returns human text: it returns a stable machine code
 * (`SEAT_LIMIT_REACHED`, `OTP_INVALID`, …). The frontend owns every user
 * facing sentence, in en / fa / tr, through the existing i18n namespace.
 */
import type { TranslationKey } from '@/i18n';

export const INVITATION_ERROR_CODES = [
  'INVITATION_DUPLICATE',
  'INVITATION_NOT_PENDING',
  'INVITATION_NOT_FOUND',
  'ACCOUNT_EXISTS_LOGIN_REQUIRED',
  'ACCOUNT_DISABLED',
  'EMAIL_PROOF_REQUIRED',
  'OTP_INVALID',
  'OTP_RATE_LIMITED',
  'CONSENT_REQUIRED',
  'SEAT_LIMIT_REACHED',
  'ENTITLEMENT_UNAVAILABLE',
  'FORBIDDEN_ROLE_ESCALATION',
  'WORKSPACE_NOT_FOUND',
  'WRONG_ACCOUNT',
  'SESSION_REQUIRED',
  'PASSWORD_REQUIRED',
  'INVALID_MEMBER_TYPE',
  'STAFF_INVITATION_MUST_HAVE_NO_DEPARTMENT',
  'CUSTOMER_FACING_INVITATION_REQUIRES_DEPARTMENT',
  'REVOKE_REASON_REQUIRED',
  'JOB_CLAIM_LOST',
  'OWNER_PROTECTED',
  'IDEMPOTENCY_KEY_REUSED',
  'IDEMPOTENCY_CONFLICT',
  'IDEMPOTENCY_IN_PROGRESS',
  'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_FINGERPRINT_REQUIRED',
  'IDEMPOTENCY_OPERATION_UNKNOWN',
  'OPERATION_COMMITTED_LINK_NOT_REPLAYABLE',
  'REQUEST_ID_REQUIRED',
  'FORBIDDEN',
  'INTERNAL_ERROR',
  'NETWORK_ERROR',
  'invalid_body',
  'invalid_workspace',
] as const;

export type InvitationErrorCode = (typeof INVITATION_ERROR_CODES)[number];

/** Normalizes any thrown/returned error into a stable code. */
export function invitationErrorCode(input: unknown): string {
  const raw =
    typeof input === 'string'
      ? input
      : input instanceof Error
        ? input.message
        : typeof (input as any)?.error === 'string'
          ? (input as any).error
          : '';
  const code = raw.trim();
  if (!code) return 'INTERNAL_ERROR';
  return (INVITATION_ERROR_CODES as readonly string[]).includes(code) ? code : 'INTERNAL_ERROR';
}

/** Localized message for an API error code — never raw English from the API. */
export function invitationErrorKey(input: unknown): TranslationKey {
  return `invitations.errors.${invitationErrorCode(input)}` as TranslationKey;
}
