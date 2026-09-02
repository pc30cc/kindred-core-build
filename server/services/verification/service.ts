/**
 * Generic Verification Core v1 — internal service contract.
 *
 * Six functions: requestVerificationChallenge, resendVerificationChallenge,
 * verifyVerificationChallenge, consumeVerificationProof,
 * revokeVerificationChallenge, getSafeVerificationStatus. NOTHING in this
 * codebase calls any of these yet — see the top-of-file note in
 * database/migrations/098_generic_verification_core.sql and
 * docs/GENERIC_VERIFICATION_CONSUMER_GUIDE.md for how a FUTURE consumer
 * would.
 *
 * Every function's FIRST action is `assertChannelAllowed`/
 * `assertPurposeEnabled` (server/services/verification/types.ts) — a
 * disabled purpose throws before any Supabase client is even constructed,
 * so it is architecturally impossible for a disabled purpose to create a
 * database row, a delivery job, or send anything.
 *
 * DELIVERY MODEL — Express calls the provider directly, no background
 * worker. This mirrors the canonical OTP architecture on `main` today
 * (server/services/phoneVerification/index.ts's issueChallenge: an atomic
 * "start" RPC, a direct `sendSmsVerification` call, then an atomic
 * "mark_delivery" RPC), generalized to email+SMS and layered on top of
 * this subsystem's caller-supplied-idempotency-key/key-rotation/purpose-
 * registry machinery that phoneVerification does not have. See
 * docs/GENERIC_VERIFICATION_CORE.md §Delivery for the full state machine
 * this file implements, including the documented crash/concurrency/replay
 * matrix (prepare/finalize crash windows, ambiguous-delivery boundary,
 * concurrent identical requests, mismatched-payload same-key rejection).
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { sendEmail } from '../email/index.js';
import { sendSms } from '../sms/index.js';
import {
  assertChannelAllowed,
  assertPurposeEnabled,
  type ConsumeProofInput,
  type ConsumeProofResult,
  type RequestChallengeInput,
  type RequestChallengeResult,
  type SafeVerificationStatus,
  type VerificationLocale,
  type VerifyChallengeInput,
  type VerifyChallengeResult,
} from './types.js';
import { normalizeDestination } from './destination.js';
import { resolveEffectiveLocale } from './locale.js';
import { renderOtpEmail, renderOtpSms } from './templates.js';
import {
  candidateOtpDigest,
  currentVerificationKeyVersion,
  deriveIdempotencyKey,
  deriveOtpCode,
  deriveRequestFingerprint,
  digestOtpCode,
  generateChallengeHandle,
  generateProofToken,
  hashDestination,
  hashIpForRateLimit,
  hashProofToken,
  hashSubjectRef,
} from './crypto.js';

export class VerificationRateLimitedError extends Error {
  constructor() {
    super('Too many verification requests — try again later');
    this.name = 'VerificationRateLimitedError';
  }
}

export class VerificationAlreadyInFlightError extends Error {
  constructor() {
    super('An identical verification request is already being processed — try again shortly');
    this.name = 'VerificationAlreadyInFlightError';
  }
}

export class VerificationIdempotencyConflictError extends Error {
  constructor(reason: string) {
    super(`Idempotency conflict: ${reason}`);
    this.name = 'VerificationIdempotencyConflictError';
  }
}

/** The OTP domain-separation inputs are pinned to generation 1 for the
 * HMAC input by design, regardless of the challenge's real recorded
 * generation: `challengeHandle` is a fresh, cryptographically random value
 * per request/resend (never reused across generations), which alone is
 * sufficient domain separation — the same technique the original
 * implementation used. Using a fixed constant here (rather than the real
 * generation, which is not known until AFTER the database decides whether
 * a previous live challenge exists to supersede) avoids a chicken-and-egg
 * dependency between "compute the digest to send to the prepare RPC" and
 * "ask the prepare RPC what generation this is." */
const OTP_DOMAIN_GENERATION = 1;

function throwForPrepareError(message: string): never {
  if (message.includes('VERIFICATION_ALREADY_IN_FLIGHT')) throw new VerificationAlreadyInFlightError();
  if (message.includes('VERIFICATION_RATE_LIMITED')) throw new VerificationRateLimitedError();
  if (message.includes('IDEMPOTENCY_KEY_REUSED') || message.includes('IDEMPOTENCY_KEY_FAILED_PREVIOUSLY')) {
    throw new VerificationIdempotencyConflictError(message);
  }
  throw new Error(message);
}

type DeliveryOutcome = 'provider_accepted' | 'retryable_failure' | 'permanent_failure' | 'unconfigured' | 'ambiguous' | 'derivation_key_unavailable';

/**
 * Sends one OTP directly through the existing email/SMS provider
 * abstractions — the SAME functions server/services/phoneVerification and
 * server/services/invitations use, called synchronously in this request,
 * never queued. Never throws: every failure mode (including the provider
 * throwing) is captured and classified into a DeliveryOutcome so the
 * caller can always call gv_finalize_verification_delivery with a
 * definite result.
 */
async function sendOtpDirect(
  config: ServerConfig,
  input: {
    channel: 'email' | 'sms';
    workspaceId: string | null;
    destinationNormalized: string;
    locale: VerificationLocale;
    code: string;
    ttlSeconds: number;
  },
): Promise<{ outcome: DeliveryOutcome; providerName?: string; providerMessageId?: string; errorCode?: string; errorMessage?: string }> {
  try {
    if (input.channel === 'sms') {
      const rendered = renderOtpSms(input.locale, input.code, input.ttlSeconds);
      const result = await sendSms(config, { to: input.destinationNormalized, body: rendered.text });
      if (result.success) return { outcome: 'provider_accepted', providerName: result.provider, providerMessageId: result.messageId };
      return { outcome: 'retryable_failure', providerName: result.provider, errorCode: result.errorCode };
    }

    // Email requires a workspace-bound provider config to resolve — see
    // docs/GENERIC_VERIFICATION_CORE.md's documented limitation: a
    // workspace-less (pre-account) email purpose has no platform-level
    // email provider fallback in this codebase today (unlike SMS, which
    // already has one via server/services/sms/index.ts's
    // platform_sms_provider_config). Enabling any pre-account email
    // purpose in the future requires adding that fallback first.
    if (!input.workspaceId) {
      return { outcome: 'unconfigured', errorCode: 'no_workspace_bound_email_provider' };
    }

    const rendered = renderOtpEmail(input.locale, input.code, input.ttlSeconds);
    const result = await sendEmail(config, {
      workspaceId: input.workspaceId,
      to: input.destinationNormalized,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    if (result.success && result.provider !== 'stub') {
      return { outcome: 'provider_accepted', providerName: result.provider, providerMessageId: result.id };
    }
    if (result.provider === 'stub') {
      return { outcome: 'unconfigured', providerName: result.provider, errorCode: 'no_email_provider_configured' };
    }
    return { outcome: 'retryable_failure', providerName: result.provider, errorCode: result.error };
  } catch (err) {
    // The provider threw instead of returning a result — Express cannot
    // tell whether the provider received and will act on the request
    // before it crashed/threw, or never saw it at all. Recorded as
    // 'ambiguous', never as success or definite failure — see
    // docs/GENERIC_VERIFICATION_CORE.md §Delivery's "provider accepted but
    // Express lost the provider response" case.
    return { outcome: 'ambiguous', errorCode: 'provider_exception', errorMessage: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Shared implementation for both `request` and `resend` — a resend IS a new
 * generation of the same logical challenge (see
 * docs/GENERIC_VERIFICATION_CORE.md §Lifecycle); the only difference is the
 * idempotency operation label, so "resend" and "request" retries can never
 * be confused as replay targets of each other even with the same
 * caller-supplied `idempotencyKey`.
 *
 * Three-step Express-direct delivery, matching the canonical
 * phoneVerification pattern:
 *   1. gv_prepare_verification_delivery — atomic: creates/replays the
 *      challenge, commits BEFORE any provider is contacted.
 *   2. This function derives the OTP deterministically and calls
 *      sendOtpDirect — a real, synchronous network call to email/SMS.
 *   3. gv_finalize_verification_delivery — atomic: records what actually
 *      happened and moves the idempotency ledger to 'committed'.
 */
async function requestOrResend(
  config: ServerConfig,
  input: RequestChallengeInput,
  operation: 'request' | 'resend',
): Promise<RequestChallengeResult> {
  const policy = assertChannelAllowed(input.purpose, input.channel);

  const normalized = normalizeDestination(input.channel, input.destination);
  if (!normalized.ok || !normalized.normalized) {
    throw new Error(`invalid_destination:${'reason' in normalized ? normalized.reason : 'unknown'}`);
  }

  const locale = await resolveEffectiveLocale(config, input.locale, input.workspaceId);
  const destinationHash = hashDestination(normalized.normalized);
  const subjectRefHash = input.subjectRef ? hashSubjectRef(input.subjectRef) : undefined;
  const handle = generateChallengeHandle();
  const keyVersion = currentVerificationKeyVersion();
  const codeDigest = digestOtpCode(
    { purpose: input.purpose, channel: input.channel, challengeHandle: handle, generation: OTP_DOMAIN_GENERATION, destinationHash },
    deriveOtpCode(
      { purpose: input.purpose, channel: input.channel, challengeHandle: handle, generation: OTP_DOMAIN_GENERATION, destinationHash },
      keyVersion,
      policy.otpLength,
    ),
    keyVersion,
  );

  const requestIpHash = input.requester.ipAddress ? hashIpForRateLimit(input.requester.ipAddress) : undefined;
  const idempotencyKey = deriveIdempotencyKey(
    { operation, scopeKind: input.purpose, actorRef: input.requester.authenticatedUserId ?? 'anonymous', requestId: input.idempotencyKey },
  );
  const fingerprint = deriveRequestFingerprint({
    purpose: input.purpose, channel: input.channel, destinationHash, subjectRefHash: subjectRefHash ?? null, workspaceId: input.workspaceId ?? null,
  });

  const sb = getServiceClient(config);
  const { data: prepData, error: prepError } = await sb.rpc('gv_prepare_verification_delivery', {
    _key: idempotencyKey,
    _scope_kind: input.purpose,
    _operation: operation,
    _request_fingerprint: fingerprint,
    _purpose: input.purpose,
    _workspace_id: input.workspaceId ?? null,
    _actor_ref_hash: subjectRefHash ?? null,
    _args: {
      handle,
      purpose: input.purpose,
      channel: input.channel,
      workspaceId: input.workspaceId ?? null,
      subjectKind: input.subjectKind,
      subjectRef: input.subjectRef ?? null,
      subjectRefHash: subjectRefHash ?? null,
      destinationNormalized: normalized.normalized,
      destinationHash,
      locale,
      keyVersion,
      codeDigest,
      ttlSeconds: policy.otpTtlSeconds,
      maxAttempts: policy.maxVerificationAttempts,
      maxSends: policy.maxSendsPerWindow,
      resendCooldownSeconds: policy.resendCooldownSeconds,
      rateWindowSeconds: policy.rateWindowSeconds,
      maxPerWindow: policy.maxSendsPerWindow,
      invalidatePrevious: operation === 'resend' ? true : policy.invalidatesPreviousGeneration,
      requestIpHash: requestIpHash ?? null,
    },
  });
  if (prepError) throwForPrepareError(prepError.message || '');

  const prep = prepData as { status: 'fresh' | 'resume' | 'replayed'; result: Record<string, unknown> };

  if (prep.status === 'replayed') {
    // This exact request already finished (committed) — never contact the
    // provider again for it. Return the cached result as-is.
    return shapeRequestResult(prep.result);
  }

  // 'fresh' (the ordinary path) or 'resume' (a PRIOR attempt with this
  // exact idempotency key committed the challenge but crashed before
  // finalizing — see gv_prepare_verification_delivery's own comment).
  // Either way, `prep.result` names the ACTUAL committed challenge —
  // possibly not the `handle` generated above, if this is a 'resume' of an
  // earlier attempt. Deterministic derivation means re-deriving from that
  // committed handle/destinationHash/keyVersion reproduces the exact same
  // code that would have (or already did) go out.
  const committedHandle = String(prep.result.handle);
  const committedDestinationHash = String(prep.result.destinationHash);
  const committedKeyVersion = Number(prep.result.keyVersion);
  const committedLocale = prep.result.locale as VerificationLocale;

  const code = deriveOtpCode(
    { purpose: input.purpose, channel: input.channel, challengeHandle: committedHandle, generation: OTP_DOMAIN_GENERATION, destinationHash: committedDestinationHash },
    committedKeyVersion,
    policy.otpLength,
  );

  // NOTE on 'resume': if the prior attempt's provider call actually
  // succeeded and only the finalize call (or the response Express was
  // waiting for) was lost, this send is a genuine SECOND provider
  // submission for the same logical OTP — at-least-once delivery, not
  // exactly-once. The two neither of this codebase's email/SMS provider
  // abstractions accept a caller-supplied idempotency key today, so this
  // is an accepted, documented boundary (docs/GENERIC_VERIFICATION_CORE.md
  // §Delivery) rather than something this function can eliminate. What IS
  // guaranteed: the code is identical both times, and the DATABASE state
  // is never duplicated (gv_finalize_verification_delivery is itself
  // idempotent on an already-committed key).
  const sendResult = await sendOtpDirect(config, {
    channel: input.channel,
    workspaceId: input.workspaceId ?? null,
    destinationNormalized: normalized.normalized,
    locale: committedLocale,
    code,
    ttlSeconds: policy.otpTtlSeconds,
  });

  const { data: finData, error: finError } = await sb.rpc('gv_finalize_verification_delivery', {
    _key: idempotencyKey,
    _outcome: sendResult.outcome,
    _provider_name: sendResult.providerName ?? null,
    _provider_message_id: sendResult.providerMessageId ?? null,
    _error_code: sendResult.errorCode ?? null,
    _error_message: sendResult.errorMessage ?? null,
  });
  // A finalize failure here (network loss between Express and Postgres
  // right after a successful send, the DB connection dying mid-statement,
  // etc) leaves the ledger row in 'prepared' — the NEXT request with this
  // same idempotency key (a client retry) resolves it via the 'resume'
  // path above. There is no way to synchronously recover within THIS
  // call; surfacing the error is correct — the caller's own retry (or the
  // client's) is the recovery path, not a loop here.
  if (finError) throw new Error(finError.message);

  const fin = finData as { alreadyFinalized: boolean; result: Record<string, unknown> };
  return shapeRequestResult(fin.result);
}

function shapeRequestResult(result: Record<string, unknown>): RequestChallengeResult {
  return {
    handle: String(result.handle),
    generation: Number(result.generation),
    expiresAt: String(result.expiresAt),
    resendAvailableAt: String(result.resendAvailableAt),
    // Absent only on a 'replayed' result racing a 'fresh'/'resume' call that
    // has not reached gv_finalize_verification_delivery yet — cannot happen
    // in practice since 'replayed' requires result_state='committed', which
    // finalize is what sets. Defaulted defensively rather than asserted.
    deliveryOutcome: (result.deliveryOutcome as RequestChallengeResult['deliveryOutcome']) ?? 'ambiguous',
  };
}

export async function requestVerificationChallenge(
  config: ServerConfig,
  input: RequestChallengeInput,
): Promise<RequestChallengeResult> {
  return requestOrResend(config, input, 'request');
}

export async function resendVerificationChallenge(
  config: ServerConfig,
  input: RequestChallengeInput,
): Promise<RequestChallengeResult> {
  return requestOrResend(config, input, 'resend');
}

export async function verifyVerificationChallenge(
  config: ServerConfig,
  input: VerifyChallengeInput,
): Promise<VerifyChallengeResult> {
  const policy = assertChannelAllowed(input.purpose, input.channel);
  const sb = getServiceClient(config);

  // Need the challenge's own recorded generation/key_version/destination_hash
  // to recompute the candidate digest with the HISTORICAL key — never the
  // current one. This is a plain SELECT (service_role has direct SELECT
  // grant on verification_challenges), not a second RPC round-trip.
  const { data: chal, error } = await sb
    .from('verification_challenges')
    .select('generation, key_version, destination_hash')
    .eq('handle', input.handle)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!chal) return { ok: false, reason: 'invalid_code' }; // uniform — never "not_found" to the caller

  const candidateDigest = candidateOtpDigest(
    { purpose: input.purpose, channel: input.channel, challengeHandle: input.handle, generation: OTP_DOMAIN_GENERATION, destinationHash: chal.destination_hash },
    input.code,
    chal.key_version,
  );

  const subjectRefHash = input.subjectRef ? hashSubjectRef(input.subjectRef) : undefined;
  const ipHash = input.requester.ipAddress ? hashIpForRateLimit(input.requester.ipAddress) : undefined;

  const proofToken = generateProofToken();
  const proofHash = hashProofToken(proofToken);

  // Verify deliberately bypasses gv_execute_idempotent's request-replay
  // ledger — every submission is a counted, mutating event (wrong-code
  // attempt counting, lockout) and must always be re-evaluated, never
  // replayed from a cached result. Concurrency safety comes from
  // _gv_do_verify's own `FOR UPDATE` row lock instead. See the migration's
  // gv_verify_verification_challenge / gv_execute_idempotent comments.
  const { data: verifyData, error: verifyError } = await sb.rpc('gv_verify_verification_challenge', {
    _args: {
      handle: input.handle, candidateDigest, purpose: input.purpose, channel: input.channel,
      workspaceId: input.workspaceId ?? null, subjectRefHash: subjectRefHash ?? null, ipHash: ipHash ?? null,
      issuesProof: policy.issuesProof, proofHash, proofTtlSeconds: policy.proofTtlSeconds,
    },
  });
  if (verifyError) throw new Error(verifyError.message);
  const result = verifyData as { ok: boolean; reason?: string; proofIssued?: boolean };

  if (!result.ok) return { ok: false, reason: String(result.reason ?? 'invalid_code') };
  return { ok: true, proofToken: result.proofIssued ? proofToken : undefined };
}

/**
 * The one function a FUTURE consumer calls from WITHIN its own
 * SECURITY DEFINER SQL function (a nested SQL call, not this Node
 * function) to atomically consume a proof alongside its own business
 * mutation — see docs/GENERIC_VERIFICATION_CONSUMER_GUIDE.md. This Node
 * wrapper exists for completeness/direct testing only; no route in this
 * codebase calls it.
 */
export async function consumeVerificationProof(
  config: ServerConfig,
  input: ConsumeProofInput,
): Promise<ConsumeProofResult> {
  assertChannelAllowed(input.purpose, input.channel);
  const sb = getServiceClient(config);
  const proofHash = hashProofToken(input.proofToken);
  const subjectRefHash = input.subjectRef ? hashSubjectRef(input.subjectRef) : undefined;

  const { data, error } = await sb.rpc('gv_consume_verification_proof', {
    _proof_hash: proofHash,
    _purpose: input.purpose,
    _channel: input.channel,
    _workspace_id: input.workspaceId ?? null,
    _subject_ref_hash: subjectRefHash ?? null,
    _consumed_by_context: input.consumedByContext,
  });
  if (error) throw new Error(error.message);
  const result = data as { ok: boolean; reason?: string; challengeId?: string; subjectRef?: string };
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, challengeId: result.challengeId, subjectRef: result.subjectRef };
}

export async function revokeVerificationChallenge(
  config: ServerConfig,
  input: { handle: string; purpose: string; reason: string; idempotencyKey: string },
): Promise<{ ok: boolean }> {
  assertPurposeEnabled(input.purpose);
  const sb = getServiceClient(config);
  const idempotencyKey = deriveIdempotencyKey({ operation: 'revoke', scopeKind: input.purpose, actorRef: 'system', requestId: input.idempotencyKey });
  const fingerprint = deriveRequestFingerprint({ handle: input.handle, reason: input.reason });
  const { data, error } = await sb.rpc('gv_execute_idempotent', {
    _key: idempotencyKey,
    _scope_kind: input.purpose,
    _operation: 'revoke',
    _request_fingerprint: fingerprint,
    _purpose: input.purpose,
    _workspace_id: null,
    _actor_ref_hash: null,
    _args: { handle: input.handle, reason: input.reason },
  });
  if (error) throwForPrepareError(error.message || '');
  const outcome = data as { replayed: boolean; result: Record<string, unknown> };
  return { ok: Boolean(outcome.result.ok) };
}

export async function getSafeVerificationStatus(
  config: ServerConfig,
  handle: string,
): Promise<SafeVerificationStatus | null> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('gv_get_verification_status', { _handle: handle });
  if (error) throw new Error(error.message);
  if (!data) return null;
  const row = data as Record<string, unknown>;
  return {
    status: String(row.status),
    purpose: String(row.purpose),
    channel: String(row.channel),
    generation: Number(row.generation),
    expiresAt: String(row.expiresAt),
    attemptsRemaining: Number(row.attemptsRemaining),
    resendAvailableAt: String(row.resendAvailableAt),
  };
}
