/**
 * Super-admin phone verification operations.
 * The caller must already be a verified platform admin (enforced by the
 * admin router). Nothing here reveals the SMS vendor to any response.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { getPhoneVerificationState, issueChallenge } from './index.js';
import type { SmsRuntimeOptions } from '../sms/index.js';
import {
  CHALLENGE_TTL_SECONDS,
  PhoneVerificationError,
  RESEND_COOLDOWN_SECONDS,
  type PhoneVerificationState,
} from './types.js';

export interface AdminPhoneVerificationView {
  userId: string;
  /** Admin-only: the full number is never exposed to a workspace user. */
  phone: string | null;
  phoneMasked: string | null;
  country: string | null;
  verified: boolean;
  verifiedAt: string | null;
  verificationMethod: 'sms_otp' | 'admin_manual' | null;
  verifiedByAdminId: string | null;
  verifiedByAdminEmail: string | null;
  manualVerificationReason: string | null;
  hasActiveChallenge: boolean;
  challengeExpiresInSeconds: number | null;
  lastSentAt: string | null;
  remainingAttempts: number | null;
}

function toView(state: PhoneVerificationState): AdminPhoneVerificationView {
  return {
    userId: state.userId,
    phone: state.phone,
    phoneMasked: state.phoneMasked,
    country: state.country,
    verified: state.verified,
    verifiedAt: state.verifiedAt,
    verificationMethod: state.verificationMethod,
    verifiedByAdminId: state.verifiedByAdminId,
    verifiedByAdminEmail: state.verifiedByAdminEmail,
    manualVerificationReason: state.manualVerificationReason,
    hasActiveChallenge: state.hasActiveChallenge,
    challengeExpiresInSeconds: state.challengeExpiresInSeconds,
    lastSentAt: state.lastSentAt,
    remainingAttempts: state.remainingAttempts,
  };
}

export async function adminGetPhoneVerification(
  config: ServerConfig,
  userId: string,
): Promise<AdminPhoneVerificationView> {
  return toView(await getPhoneVerificationState(config, userId));
}

/** Resend uses the stored canonical number — never a number from the body. */
export async function adminResendVerification(
  config: ServerConfig,
  input: { targetUserId: string; adminUserId: string; clientIp?: string | null; smsOptions?: SmsRuntimeOptions },
) {
  const state = await getPhoneVerificationState(config, input.targetUserId);
  if (!state.phone) throw new PhoneVerificationError('phone_invalid', 400);
  if (state.verified) throw new PhoneVerificationError('phone_already_verified', 409);

  const result = await issueChallenge(config, {
    purpose: 'widget_access',
    subjectUserId: input.targetUserId,
    phoneE164: state.phone,
    createdBy: 'admin',
    actorUserId: input.adminUserId,
    adminUserId: input.adminUserId,
    clientIp: input.clientIp ?? null,
    ...(input.smsOptions ? { smsOptions: input.smsOptions } : {}),
  });

  // The `phone_verification_admin_resend_requested` and the canonical
  // `phone_verification_admin_resend` audit rows are written transactionally
  // inside the resend RPCs — a success response always implies a trail.
  return {
    success: true as const,
    phoneMasked: result.phoneMasked,
    expiresInSeconds: CHALLENGE_TTL_SECONDS,
    resendAfterSeconds: RESEND_COOLDOWN_SECONDS,
  };
}

/** Marks the phone verified without any SMS. Atomic, reason mandatory. */
export async function adminManualVerify(
  config: ServerConfig,
  input: { targetUserId: string; adminUserId: string; reason: string },
) {
  const reason = String(input.reason ?? '').trim();
  if (reason.length < 5 || reason.length > 500) {
    throw new PhoneVerificationError('phone_verification_not_allowed', 400);
  }
  const before = await getPhoneVerificationState(config, input.targetUserId);
  if (!before.phone) throw new PhoneVerificationError('phone_invalid', 400);

  const client = getServiceClient(config);
  const { data, error } = await client.rpc('phone_verification_manual_verify', {
    _user_id: input.targetUserId,
    _admin_id: input.adminUserId,
    _reason: reason,
  });
  if (error) throw new PhoneVerificationError('phone_verification_unavailable', 500);
  const row = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  if (typeof row.error === 'string') {
    throw new PhoneVerificationError(
      row.error === 'phone_verification_not_allowed' ? 'phone_verification_not_allowed' : 'phone_invalid',
      400,
    );
  }
  // The audit row is written inside `phone_verification_manual_verify`, in the
  // same transaction as the state change: a success response therefore always
  // implies a persisted audit entry.

  return {
    success: true as const,
    verified: true as const,
    verificationMethod:
      row.verificationMethod === 'sms_otp' ? ('sms_otp' as const) : ('admin_manual' as const),
    verifiedAt: typeof row.verifiedAt === 'string' ? row.verifiedAt : null,
    alreadyVerified: row.alreadyVerified === true,
  };
}