/**
 * SIGNUP EMAIL OTP — the self-hosted, code-based alternative to the emailed
 * verification LINK.
 *
 * This is a thin, auth-specific consumer of the EXISTING self-hosted
 * Generic Verification Core (server/services/verification/*, migration
 * 098): challenge issuance, OTP derivation/digesting, resend cooldowns,
 * per-destination rate limiting, attempt counting, atomic verification and
 * single-use proofs all live there and are NOT reimplemented here. This
 * module only:
 *
 *   1. binds the `signup_email` purpose to the signed-in identity,
 *   2. sends through the platform's own email provider (the core does that
 *      itself, synchronously, in Express — no queue, no edge function),
 *   3. and, on a successful verification, performs the one business
 *      mutation the core deliberately does not know about: writing
 *      `user_credentials.email_verified_at`.
 *
 * The email address the flag is written for comes from the CONSUMED PROOF
 * (`destinationNormalized`), never from client input and never re-read from
 * the profile after the fact — a proof for address A can therefore never
 * mark address B verified.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import {
  requestVerificationChallenge,
  resendVerificationChallenge,
  verifyVerificationChallenge,
  consumeVerificationProof,
  VerificationRateLimitedError,
  VerificationAlreadyInFlightError,
  VerificationIdempotencyConflictError,
} from '../verification/service.js';
import { hasVerificationPepper } from '../verification/crypto.js';
import type { VerificationLocale } from '../verification/types.js';

const PURPOSE = 'signup_email' as const;
const CHANNEL = 'email' as const;

export class EmailOtpUnavailableError extends Error {
  constructor() {
    super('Email OTP is not available — GENERIC_VERIFICATION_PEPPER is not configured on this deployment');
    this.name = 'EmailOtpUnavailableError';
  }
}

export class EmailOtpRateLimitedError extends Error {
  constructor() {
    super('Too many verification requests — try again later');
    this.name = 'EmailOtpRateLimitedError';
  }
}

export interface EmailOtpChallenge {
  handle: string;
  expiresAt: string;
  resendAvailableAt: string;
  delivered: boolean;
}

function toLocale(value: string | null | undefined): VerificationLocale | undefined {
  if (value === 'fa' || value === 'tr' || value === 'en') return value;
  return undefined;
}

function assertAvailable(): void {
  if (!hasVerificationPepper()) throw new EmailOtpUnavailableError();
}

function mapCoreError(err: unknown): never {
  if (
    err instanceof VerificationRateLimitedError ||
    err instanceof VerificationAlreadyInFlightError ||
    err instanceof VerificationIdempotencyConflictError
  ) {
    throw new EmailOtpRateLimitedError();
  }
  throw err;
}

/** Issue (or re-issue) a signup email OTP for the CALLER's own identity. */
export async function startEmailVerificationOtp(
  config: ServerConfig,
  input: {
    userId: string;
    email: string;
    locale?: string | null;
    ipAddress: string | null;
    idempotencyKey: string;
  },
): Promise<EmailOtpChallenge> {
  assertAvailable();
  try {
    const result = await requestVerificationChallenge(config, {
      purpose: PURPOSE,
      channel: CHANNEL,
      destination: input.email,
      subjectKind: 'user',
      subjectRef: input.userId,
      locale: toLocale(input.locale),
      idempotencyKey: input.idempotencyKey,
      requester: { ipAddress: input.ipAddress, authenticatedUserId: input.userId },
    });
    return {
      handle: result.handle,
      expiresAt: result.expiresAt,
      resendAvailableAt: result.resendAvailableAt,
      delivered: result.deliveryOutcome === 'provider_accepted',
    };
  } catch (err) {
    return mapCoreError(err);
  }
}

/** Resend the code for ONE specific, already-issued challenge. */
export async function resendEmailVerificationOtp(
  config: ServerConfig,
  input: {
    userId: string;
    handle: string;
    locale?: string | null;
    ipAddress: string | null;
    idempotencyKey: string;
  },
): Promise<EmailOtpChallenge> {
  assertAvailable();
  try {
    const result = await resendVerificationChallenge(config, {
      handle: input.handle,
      purpose: PURPOSE,
      channel: CHANNEL,
      subjectKind: 'user',
      subjectRef: input.userId,
      locale: toLocale(input.locale),
      idempotencyKey: input.idempotencyKey,
      requester: { ipAddress: input.ipAddress, authenticatedUserId: input.userId },
    });
    return {
      handle: result.handle,
      expiresAt: result.expiresAt,
      resendAvailableAt: result.resendAvailableAt,
      delivered: result.deliveryOutcome === 'provider_accepted',
    };
  } catch (err) {
    return mapCoreError(err);
  }
}

export interface ConfirmEmailOtpResult {
  ok: boolean;
  /** Present only on failure — a coarse, non-enumerating reason for the UI. */
  reason?: string;
  verifiedEmail?: string;
}

/**
 * Verify a submitted code and, only on success, mark the email verified.
 *
 * The verify → consume-proof → write sequence is deliberate: the proof is
 * the single-use artefact that authorizes the business mutation, so a
 * replayed request cannot flip the flag twice, and a verified code that is
 * never consumed never changes account state.
 */
export async function confirmEmailVerificationOtp(
  config: ServerConfig,
  input: {
    userId: string;
    handle: string;
    code: string;
    requestId: string;
    ipAddress: string | null;
  },
): Promise<ConfirmEmailOtpResult> {
  assertAvailable();

  let verified;
  try {
    verified = await verifyVerificationChallenge(config, {
      handle: input.handle,
      code: input.code,
      purpose: PURPOSE,
      channel: CHANNEL,
      subjectRef: input.userId,
      requestId: input.requestId,
      requester: { ipAddress: input.ipAddress, authenticatedUserId: input.userId },
    });
  } catch (err) {
    return mapCoreError(err);
  }

  if (!verified.ok || !verified.proofToken) {
    return { ok: false, reason: verified.reason || 'invalid_code' };
  }

  const consumed = await consumeVerificationProof(config, {
    proofToken: verified.proofToken,
    purpose: PURPOSE,
    channel: CHANNEL,
    subjectRef: input.userId,
    authenticatedUserId: input.userId,
    consumedByContext: 'auth.signup_email_verification',
  });
  if (!consumed.ok || !consumed.destinationNormalized) {
    return { ok: false, reason: consumed.reason || 'proof_unusable' };
  }

  const verifiedEmail = consumed.destinationNormalized;
  const sb = getServiceClient(config);

  // Defence in depth: the proof already binds subject + destination, but the
  // write itself is still scoped to BOTH the caller's own id and the exact
  // address currently on that profile. A proof for an address the account no
  // longer uses can never mark the current address verified.
  const { data: profile } = await sb.from('profiles').select('email').eq('id', input.userId).maybeSingle();
  if (!profile?.email || String(profile.email).trim().toLowerCase() !== verifiedEmail) {
    return { ok: false, reason: 'destination_mismatch' };
  }

  const { error } = await sb
    .from('user_credentials')
    .update({ email_verified_at: new Date().toISOString() })
    .eq('user_id', input.userId)
    .is('email_verified_at', null);
  if (error) {
    console.error('[auth.emailOtp] Failed to persist email_verified_at:', error);
    return { ok: false, reason: 'persist_failed' };
  }

  return { ok: true, verifiedEmail };
}
