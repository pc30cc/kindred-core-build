/**
 * Public contract of the reusable phone-verification feature.
 * Nothing here is provider aware — the UI never learns which SMS vendor the
 * platform uses.
 */
export type { PhoneVerificationPurpose, PhoneVerificationStatus } from '@/lib/api';

export type PhoneVerificationMode = 'full_page' | 'inline' | 'dialog';

export interface PhoneVerificationContextProps {
  workspaceId?: string;
  workspaceSlug?: string;
}