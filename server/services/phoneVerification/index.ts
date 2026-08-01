/**
 * PHONE VERIFICATION SERVICE
 *
 * Reusable, purpose-driven OTP verification bound to a *user account*
 * (never to a workspace). A workspace is considered verified when its current
 * owner is verified — the status is always computed, never stored on the
 * workspace, so an ownership transfer takes effect immediately.
 *
 * Everything provider-related (vendor, template, sender, message id, raw
 * errors) stays inside the SMS service and the internal audit trail.
 */

import type { ServerConfig } from '../../config.js';
import { randomUUID } from 'node:crypto';
import { getServiceClient } from '../../supabase.js';
import { sendSmsVerification, type SmsRuntimeOptions } from '../sms/index.js';
import {
  digestCode,
  digestsMatch,
  generateOtpCode,
  hasPepper,
  hashIpForRateLimit,
  PhoneVerificationPepperMissing,
} from './crypto.js';
import { maskE164, normalizePhoneToE164, toProviderFormat } from './phone.js';
import { PHONE_VERIFICATION_PURPOSES, type PhoneVerificationPurpose } from './policies.js';
import {
  CHALLENGE_TTL_SECONDS,
  MAX_ATTEMPTS,
  PhoneVerificationError,
  RESEND_COOLDOWN_SECONDS,
  isPhoneVerificationErrorCode,
  type PhoneChallengeResponse,
  type PhoneVerificationState,
  type PhoneVerificationStatusResponse,
} from './types.js';

export * from './types.js';
export * from './phone.js';
export * from './policies.js';
export { hasPepper } from './crypto.js';

function sb(config: ServerConfig) {
  return getServiceClient(config);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Reads `phone_verification_state` and shapes it into the internal state. */
export async function getPhoneVerificationState(
  config: ServerConfig,
  userId: string,
): Promise<PhoneVerificationState> {
  const { data, error } = await sb(config).rpc('phone_verification_state', { _user_id: userId });
  if (error) throw new PhoneVerificationError('phone_verification_unavailable', 500);
  const raw = asRecord(data);
  const method = str(raw.verificationMethod);
  return {
    userId,
    phone: str(raw.phone),
    phoneMasked: str(raw.phoneMasked),
    country: str(raw.country),
    verified: raw.verified === true,
    verifiedAt: str(raw.verifiedAt),
    verificationMethod: method === 'sms_otp' || method === 'admin_manual' ? method : null,
    verifiedByAdminId: str(raw.verifiedByAdminId),
    verifiedByAdminEmail: str(raw.verifiedByAdminEmail),
    manualVerificationReason: str(raw.manualVerificationReason),
    hasActiveChallenge: raw.hasActiveChallenge === true,
    activeChallengeId: str(raw.activeChallengeId),
    challengeExpiresInSeconds:
      typeof raw.challengeExpiresInSeconds === 'number' ? raw.challengeExpiresInSeconds : null,
    lastSentAt: str(raw.lastSentAt),
    lastCreatedAt: str(raw.lastCreatedAt),
    remainingAttempts: typeof raw.remainingAttempts === 'number' ? raw.remainingAttempts : null,
  };
}

export interface PurposeContext {
  workspaceId: string;
  /** Resolved from the workspace row — never from client input. */
  subjectUserId: string;
  /** True when the caller is the subject and may run the verification flow. */
  actorIsSubject: boolean;
  actorIsMember: boolean;
}

/**
 * Resolves the verification subject for a purpose from real workspace data.
 * Throws `phone_verification_not_allowed` when the actor is not a member.
 */
export async function resolvePurposeContext(
  config: ServerConfig,
  input: {
    purpose: PhoneVerificationPurpose;
    actorUserId: string;
    workspaceId?: string | null;
    workspaceSlug?: string | null;
  },
): Promise<PurposeContext> {
  const spec = PHONE_VERIFICATION_PURPOSES[input.purpose];
  if (spec.scope !== 'workspace') throw new PhoneVerificationError('phone_verification_not_allowed', 403);

  const client = sb(config);
  const query = client.from('workspaces').select('id, owner_id');
  const { data: workspace, error } = input.workspaceId
    ? await query.eq('id', input.workspaceId).maybeSingle()
    : await query.eq('slug', String(input.workspaceSlug ?? '')).maybeSingle();
  if (error) throw new PhoneVerificationError('phone_verification_unavailable', 500);
  if (!workspace) throw new PhoneVerificationError('phone_verification_not_allowed', 403);

  const workspaceId = String((workspace as { id: string }).id);
  const ownerId = String((workspace as { owner_id: string }).owner_id ?? '');

  const { data: isMember, error: memberError } = await client.rpc('is_workspace_member', {
    _workspace_id: workspaceId,
    _user_id: input.actorUserId,
  });
  if (memberError) throw new PhoneVerificationError('phone_verification_unavailable', 500);
  if (isMember !== true) throw new PhoneVerificationError('phone_verification_not_allowed', 403);

  return {
    workspaceId,
    subjectUserId: ownerId,
    actorIsSubject: ownerId !== '' && ownerId === input.actorUserId,
    actorIsMember: true,
  };
}

function resendAfterSeconds(lastCreatedAt: string | null): number {
  if (!lastCreatedAt) return 0;
  const elapsed = (Date.now() - new Date(lastCreatedAt).getTime()) / 1000;
  return Math.max(0, Math.ceil(RESEND_COOLDOWN_SECONDS - elapsed));
}

/** User-facing status. A non-owner never sees the owner's phone. */
export async function getStatusForActor(
  config: ServerConfig,
  input: { purpose: PhoneVerificationPurpose; actorUserId: string; workspaceId?: string; workspaceSlug?: string },
): Promise<PhoneVerificationStatusResponse & { workspaceId: string }> {
  const ctx = await resolvePurposeContext(config, input);
  const state = await getPhoneVerificationState(config, ctx.subjectUserId);

  if (!ctx.actorIsSubject) {
    return {
      workspaceId: ctx.workspaceId,
      required: true,
      satisfied: state.verified,
      canVerify: false,
      phoneSet: false,
    };
  }
  if (state.verified) {
    return {
      workspaceId: ctx.workspaceId,
      required: true,
      satisfied: true,
      canVerify: false,
      verifiedAt: state.verifiedAt,
    };
  }
  return {
    workspaceId: ctx.workspaceId,
    required: true,
    satisfied: false,
    canVerify: true,
    phoneSet: state.phone !== null,
    phoneMasked: state.phoneMasked,
    allowedCountries: ['IR'],
    resendAfterSeconds: resendAfterSeconds(state.lastCreatedAt),
    // Resume: the OTP survives a page reload because the active challenge is
    // rehydrated from the database, never from client storage.
    hasActiveChallenge: state.hasActiveChallenge,
    activeChallengeId: state.hasActiveChallenge ? state.activeChallengeId : null,
    challengeExpiresInSeconds: state.hasActiveChallenge ? state.challengeExpiresInSeconds : null,
    remainingAttempts: state.hasActiveChallenge ? state.remainingAttempts : null,
  };
}

async function audit(
  config: ServerConfig,
  entry: {
    action: string;
    userId: string | null;
    targetUserId: string;
    workspaceId?: string | null;
    details: Record<string, unknown>;
  },
): Promise<boolean> {
  // Audit rows are internal. They never carry a raw code, a digest, a full
  // phone number or a provider credential.
  const { error } = await sb(config)
    .from('audit_logs')
    .insert({
      action: entry.action,
      entity_type: 'user_phone_verification',
      entity_id: entry.targetUserId,
      user_id: entry.userId,
      workspace_id: entry.workspaceId ?? null,
      new_value: entry.details as any,
    } as any);
  if (error) {
    // Sanitized server-side log only: no phone, no code, no provider payload.
    console.error('[phoneVerification] audit insert failed', {
      action: entry.action,
      targetUserId: entry.targetUserId,
    });
    return false;
  }
  return true;
}

export interface IssueChallengeInput {
  purpose: PhoneVerificationPurpose;
  subjectUserId: string;
  phoneE164: string;
  createdBy: 'user' | 'admin';
  actorUserId: string | null;
  adminUserId?: string | null;
  clientIp?: string | null;
  workspaceId?: string | null;
  smsOptions?: SmsRuntimeOptions;
}

/**
 * Atomically replaces any active challenge, then sends the code through the
 * *currently active* platform provider. A failed send leaves no usable
 * challenge behind.
 */
export async function issueChallenge(
  config: ServerConfig,
  input: IssueChallengeInput,
): Promise<PhoneChallengeResponse> {
  if (!hasPepper()) throw new PhoneVerificationError('phone_verification_unavailable', 503);

  const client = sb(config);
  let ipHash: string | null = null;
  try {
    ipHash = hashIpForRateLimit(input.clientIp ?? null);
  } catch (err) {
    if (err instanceof PhoneVerificationPepperMissing) {
      throw new PhoneVerificationError('phone_verification_unavailable', 503);
    }
    throw err;
  }

  // The challenge id and the final digest are computed *before* the insert, so
  // a challenge is never persisted with a guessable or placeholder digest.
  const challengeId = randomUUID();
  const code = generateOtpCode();
  const codeDigest = digestCode({
    challengeId,
    userId: input.subjectUserId,
    phoneE164: input.phoneE164,
    code,
  });

  const { data, error } = await client.rpc('phone_verification_start', {
    _challenge_id: challengeId,
    _user_id: input.subjectUserId,
    _phone: input.phoneE164,
    _purpose: input.purpose,
    _code_digest: codeDigest,
    _ttl_seconds: CHALLENGE_TTL_SECONDS,
    _created_by: input.createdBy,
    _created_by_admin_id: input.adminUserId ?? null,
    _created_ip_hash: ipHash,
    _max_attempts: MAX_ATTEMPTS,
  });
  if (error) throw new PhoneVerificationError('phone_verification_unavailable', 500);

  const result = asRecord(data);
  const errCode = str(result.error);
  if (errCode) {
    const code2 = isPhoneVerificationErrorCode(errCode) ? errCode : 'phone_rate_limited';
    const retry = typeof result.retryAfterSeconds === 'number' ? result.retryAfterSeconds : undefined;
    const status =
      code2 === 'phone_already_verified' ? 409
      : code2 === 'phone_verification_unavailable' ? 503
      : 429;
    throw new PhoneVerificationError(code2, status, retry);
  }
  if (str(result.challengeId) !== challengeId) {
    throw new PhoneVerificationError('phone_verification_unavailable', 500);
  }

  await audit(config, {
    action: 'phone_verification_started',
    userId: input.actorUserId,
    targetUserId: input.subjectUserId,
    workspaceId: input.workspaceId,
    details: {
      purpose: input.purpose,
      created_by: input.createdBy,
      phone_masked: maskE164(input.phoneE164),
    },
  });

  const sent = await sendSmsVerification(
    config,
    { to: toProviderFormat(input.phoneE164), code },
    input.smsOptions ?? {},
  );

  const { data: markData, error: markError } = await client.rpc('phone_verification_mark_delivery', {
    _challenge_id: challengeId,
    _sent: sent.success,
    _provider_name: sent.provider,
    _provider_message_id: sent.messageId ?? null,
  });
  const markOk = !markError && asRecord(markData).ok === true;

  await audit(config, {
    action: sent.success ? 'phone_verification_sent' : 'phone_verification_delivery_failed',
    userId: input.actorUserId,
    targetUserId: input.subjectUserId,
    workspaceId: input.workspaceId,
    details: {
      purpose: input.purpose,
      phone_masked: maskE164(input.phoneE164),
      delivery_state_recorded: markOk,
      // Internal-only fields; never surfaced in any user or admin response.
      provider: sent.provider,
      error_code: sent.errorCode ?? null,
    },
  });

  if (!sent.success) throw new PhoneVerificationError('phone_verification_unavailable', 502);

  // Provider accepted the message but we could not record it: the OTP must not
  // stay usable, and the caller must not be told the send succeeded.
  if (!markOk) {
    console.error('[phoneVerification] delivery bookkeeping failed; challenge invalidated', {
      targetUserId: input.subjectUserId,
    });
    await client.rpc('phone_verification_invalidate', { _challenge_id: challengeId });
    await audit(config, {
      action: 'phone_verification_delivery_state_failed',
      userId: input.actorUserId,
      targetUserId: input.subjectUserId,
      workspaceId: input.workspaceId,
      details: { purpose: input.purpose, phone_masked: maskE164(input.phoneE164) },
    });
    throw new PhoneVerificationError('phone_verification_unavailable', 500);
  }

  return {
    success: true,
    challengeId,
    phoneMasked: maskE164(input.phoneE164) ?? '',
    expiresInSeconds: CHALLENGE_TTL_SECONDS,
    resendAfterSeconds: RESEND_COOLDOWN_SECONDS,
  };
}

/** Validates and normalizes the phone, then issues a challenge. */
export async function startVerification(
  config: ServerConfig,
  input: {
    purpose: PhoneVerificationPurpose;
    actorUserId: string;
    workspaceId?: string;
    workspaceSlug?: string;
    phone: unknown;
    country: unknown;
    clientIp?: string | null;
    smsOptions?: SmsRuntimeOptions;
  },
): Promise<PhoneChallengeResponse> {
  const ctx = await resolvePurposeContext(config, input);
  if (!ctx.actorIsSubject) throw new PhoneVerificationError('phone_verification_not_allowed', 403);

  const state = await getPhoneVerificationState(config, ctx.subjectUserId);
  if (state.verified) throw new PhoneVerificationError('phone_already_verified', 409);

  const normalized = normalizePhoneToE164(input.phone, input.country);
  if (normalized.ok !== true) throw new PhoneVerificationError(normalized.reason, 400);

  return issueChallenge(config, {
    purpose: input.purpose,
    subjectUserId: ctx.subjectUserId,
    phoneE164: normalized.e164,
    createdBy: 'user',
    actorUserId: input.actorUserId,
    clientIp: input.clientIp ?? null,
    workspaceId: ctx.workspaceId,
    ...(input.smsOptions ? { smsOptions: input.smsOptions } : {}),
  });
}

/** Resend always mints a fresh code and invalidates the previous challenge. */
export async function resendVerification(
  config: ServerConfig,
  input: {
    purpose: PhoneVerificationPurpose;
    actorUserId: string;
    workspaceId?: string;
    workspaceSlug?: string;
    clientIp?: string | null;
    smsOptions?: SmsRuntimeOptions;
  },
): Promise<PhoneChallengeResponse> {
  const ctx = await resolvePurposeContext(config, input);
  if (!ctx.actorIsSubject) throw new PhoneVerificationError('phone_verification_not_allowed', 403);

  const state = await getPhoneVerificationState(config, ctx.subjectUserId);
  if (state.verified) throw new PhoneVerificationError('phone_already_verified', 409);
  if (!state.phone) throw new PhoneVerificationError('phone_invalid', 400);

  return issueChallenge(config, {
    purpose: input.purpose,
    subjectUserId: ctx.subjectUserId,
    phoneE164: state.phone,
    createdBy: 'user',
    actorUserId: input.actorUserId,
    clientIp: input.clientIp ?? null,
    workspaceId: ctx.workspaceId,
    ...(input.smsOptions ? { smsOptions: input.smsOptions } : {}),
  });
}

export interface CheckResult {
  success: true;
  verified: true;
  phoneMasked: string | null;
  verifiedAt: string | null;
}

/**
 * Claims one attempt atomically, compares in constant time and — only on a
 * match — consumes the challenge and flips the account to verified.
 */
export async function checkVerification(
  config: ServerConfig,
  input: {
    purpose: PhoneVerificationPurpose;
    actorUserId: string;
    workspaceId?: string;
    workspaceSlug?: string;
    challengeId: string;
    code: string;
  },
): Promise<CheckResult> {
  if (!hasPepper()) throw new PhoneVerificationError('phone_verification_unavailable', 503);
  const ctx = await resolvePurposeContext(config, input);
  if (!ctx.actorIsSubject) throw new PhoneVerificationError('phone_verification_not_allowed', 403);

  const client = sb(config);
  const { data, error } = await client.rpc('phone_verification_claim_attempt', {
    _challenge_id: input.challengeId,
    _user_id: ctx.subjectUserId,
  });
  if (error) throw new PhoneVerificationError('phone_verification_unavailable', 500);

  const claim = asRecord(data);
  const claimError = str(claim.error);
  if (claimError) {
    throw new PhoneVerificationError(
      isPhoneVerificationErrorCode(claimError) ? claimError : 'phone_challenge_not_found',
      400,
    );
  }

  const storedDigest = str(claim.codeDigest) ?? '';
  const phone = str(claim.phone) ?? '';
  const candidate = digestCode({
    challengeId: input.challengeId,
    userId: ctx.subjectUserId,
    phoneE164: phone,
    code: String(input.code ?? ''),
  });

  if (!digestsMatch(storedDigest, candidate)) {
    const attemptsLeft =
      typeof claim.maxAttempts === 'number' && typeof claim.attemptCount === 'number'
        ? Math.max(0, claim.maxAttempts - claim.attemptCount)
        : null;
    await audit(config, {
      action: 'phone_verification_code_failed',
      userId: input.actorUserId,
      targetUserId: ctx.subjectUserId,
      workspaceId: ctx.workspaceId,
      details: { purpose: input.purpose, phone_masked: maskE164(phone), attempts_left: attemptsLeft },
    });
    throw new PhoneVerificationError(
      attemptsLeft === 0 ? 'phone_attempts_exceeded' : 'phone_code_invalid',
      400,
    );
  }

  const { data: consumed, error: consumeError } = await client.rpc('phone_verification_consume', {
    _challenge_id: input.challengeId,
    _user_id: ctx.subjectUserId,
  });
  if (consumeError) throw new PhoneVerificationError('phone_verification_unavailable', 500);
  const consumedRow = asRecord(consumed);
  const consumeErrCode = str(consumedRow.error);
  if (consumeErrCode) throw new PhoneVerificationError('phone_challenge_not_found', 400);

  await audit(config, {
    action: 'phone_verification_succeeded',
    userId: input.actorUserId,
    targetUserId: ctx.subjectUserId,
    workspaceId: ctx.workspaceId,
    details: { purpose: input.purpose, phone_masked: maskE164(phone), method: 'sms_otp' },
  });

  return {
    success: true,
    verified: true,
    phoneMasked: str(consumedRow.phoneMasked) ?? maskE164(phone),
    verifiedAt: str(consumedRow.verifiedAt),
  };
}

/** True when the purpose requirement is satisfied for this workspace. */
export async function cancelVerification(
  config: ServerConfig,
  input: {
    purpose: PhoneVerificationPurpose;
    actorUserId: string;
    workspaceId?: string;
    workspaceSlug?: string;
    challengeId?: string | null;
  },
): Promise<{ success: true; cancelled: number }> {
  const ctx = await resolvePurposeContext(config, input);
  if (!ctx.actorIsSubject) throw new PhoneVerificationError('phone_verification_not_allowed', 403);

  const state = await getPhoneVerificationState(config, ctx.subjectUserId);
  if (state.verified) throw new PhoneVerificationError('phone_already_verified', 409);

  const { data, error } = await sb(config).rpc('phone_verification_cancel', {
    _user_id: ctx.subjectUserId,
    _challenge_id: input.challengeId ?? null,
  });
  if (error) throw new PhoneVerificationError('phone_verification_unavailable', 500);

  const row = asRecord(data);
  const cancelled = typeof row.cancelled === 'number' ? row.cancelled : 0;

  if (cancelled > 0) {
    await audit(config, {
      action: 'phone_verification_cancelled',
      userId: input.actorUserId,
      targetUserId: ctx.subjectUserId,
      workspaceId: ctx.workspaceId,
      details: { purpose: input.purpose, cancelled },
    });
  }

  return { success: true, cancelled };
}

/** True when the purpose requirement is satisfied for this workspace. */
export async function isPhoneVerificationSatisfied(
  config: ServerConfig,
  input: { purpose: PhoneVerificationPurpose; workspaceId: string },
): Promise<boolean> {
  const { data, error } = await sb(config).rpc('workspace_owner_phone_verified', {
    _workspace_id: input.workspaceId,
  });
  if (error) return false; // fail closed
  return data === true;
}

/**
 * Reusable backend guard. Throws `phone_verification_required` when the
 * workspace owner has not verified their phone.
 */
export async function assertPhoneVerificationSatisfied(
  config: ServerConfig,
  input: { actorUserId: string; purpose: PhoneVerificationPurpose; workspaceId: string },
): Promise<void> {
  const ok = await isPhoneVerificationSatisfied(config, input);
  if (!ok) throw new PhoneVerificationError('phone_verification_required', 403);
}