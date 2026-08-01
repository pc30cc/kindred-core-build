/**
 * Single source of truth for the three real phone states used by the
 * super-admin surfaces. A user without a number is *not* "unverified".
 */
export type PhoneStatus = 'verified' | 'unverified' | 'no_phone';

export function resolvePhoneStatus(input: {
  phoneMasked?: string | null;
  phone?: string | null;
  verified?: boolean | null;
  verifiedAt?: string | null;
}): PhoneStatus {
  const hasPhone = Boolean(input.phoneMasked || input.phone);
  if (!hasPhone) return 'no_phone';
  return input.verified === true || Boolean(input.verifiedAt) ? 'verified' : 'unverified';
}

/** Semantic token classes — green / amber / neutral. */
export const PHONE_STATUS_CLASS: Record<PhoneStatus, string> = {
  verified: 'border-transparent bg-success text-success-foreground hover:bg-success/80',
  unverified: 'border-transparent bg-warning text-warning-foreground hover:bg-warning/80',
  no_phone: 'border-transparent bg-secondary text-secondary-foreground',
};

export const PHONE_STATUS_LABEL_KEY: Record<PhoneStatus, string> = {
  verified: 'phoneVerification.statusVerified',
  unverified: 'phoneVerification.statusUnverified',
  no_phone: 'phoneVerification.statusNoPhone',
};
