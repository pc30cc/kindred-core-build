/**
 * PURPOSE REGISTRY — the server-side source of truth for *who* must verify.
 *
 * The client only ever sends a purpose plus workspace context. It can never
 * name the subject user, an owner id or a required role: those are resolved
 * here from the real workspace row.
 */

export const PHONE_VERIFICATION_PURPOSES = {
  widget_access: {
    subject: 'workspace_owner',
    scope: 'workspace',
  },
} as const;

export type PhoneVerificationPurpose = keyof typeof PHONE_VERIFICATION_PURPOSES;

export type PhoneVerificationSubject =
  (typeof PHONE_VERIFICATION_PURPOSES)[PhoneVerificationPurpose]['subject'];

export function isPhoneVerificationPurpose(value: unknown): value is PhoneVerificationPurpose {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(PHONE_VERIFICATION_PURPOSES, value)
  );
}