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
 * Every mutating function's FIRST actions are `assertChannelAllowed`
 * (dormancy gate) and `assertPolicyBindings` (auth/subject/tenant
 * enforcement) — both purely in-process, before any database call. A
 * disabled purpose or a binding violation therefore creates zero challenge
 * rows, zero delivery attempts, and sends nothing, by construction. The
 * database independently re-enforces both — `gv_is_purpose_enabled` before
 * any write, and strict null-safe scope checks inside `_gv_do_verify` /
 * `_gv_do_resend` / `gv_consume_verification_proof` — so a bug in this
 * file's own gate can never be the ONLY thing standing between a caller and
 * a bound challenge.
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
 * concurrent identical requests, mismatched-payload same-key rejection,
 * and the delivery-attempt ownership token described below).
 *
 * OWNERSHIP TOKEN — `gv_prepare_verification_delivery` returns a fresh
 * `attemptToken` on every 'fresh' or 'resume' response (rotated each time).
 * `gv_finalize_verification_delivery` requires the SAME token and rejects
 * (softly — `{applied: false, reason: 'stale_attempt_token'}`, never an
 * exception) a token that has since been superseded by a later resume. This
 * is what makes resuming a stale-looking in-flight attempt safe: the
 * heuristic (`prepared_at` older than 30s) can guess wrong and resume an
 * attempt whose provider call is merely slow, not dead — accepting a
 * genuine at-least-once provider submission in that case — but it can
 * NEVER let that stale attempt's eventual finalize call overwrite whatever
 * the resumed (or a still-later) attempt already recorded.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { sendEmail, sendPlatformEmail } from '../email/index.js';
import { sendSms } from '../sms/index.js';
import {
  assertChannelAllowed,
  assertPolicyBindings,
  assertPurposeEnabled,
  VerificationPurposeDisabledError,
  VerificationScopeMismatchError,
  type ConsumeProofInput,
  type ConsumeProofResult,
  type PurposePolicy,
  type RequestChallengeInput,
  type RequestChallengeResult,
  type ResendChallengeInput,
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
  deriveProofToken,
  deriveRequestFingerprint,
  digestOtpCode,
  generateChallengeHandle,
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

function throwForPrepareError(message: string): never {
  if (message.includes('VERIFICATION_ALREADY_IN_FLIGHT')) throw new VerificationAlreadyInFlightError();
  if (message.includes('VERIFICATION_RATE_LIMITED')) throw new VerificationRateLimitedError();
  if (message.includes('IDEMPOTENCY_KEY_REUSED') || message.includes('IDEMPOTENCY_KEY_FAILED_PREVIOUSLY')) {
    throw new VerificationIdempotencyConflictError(message);
  }
  if (message.includes('VERIFICATION_SCOPE_MISMATCH')) {
    throw new VerificationScopeMismatchError(message);
  }
  if (message.includes('VERIFICATION_PURPOSE_DISABLED')) {
    throw new VerificationPurposeDisabledError(message);
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

    // Workspace-less (pre-account) email path — server/services/email/index.js's
    // sendPlatformEmail resolves ONLY the platform-default provider
    // (app_runtime_config.default_email_provider), no workspace lookup at
    // all. Dormant in production today (no purpose with tenantBinding:
    // 'none' is enabled — see types.ts), but exercised directly by
    // src/test/integration/genericVerificationCore.pg.test.ts to prove the
    // core can send a workspace-less email end-to-end, per
    // docs/GENERIC_VERIFICATION_CORE.md §Workspace-less email.
    if (!input.workspaceId) {
      const rendered = renderOtpEmail(input.locale, input.code, input.ttlSeconds);
      const result = await sendPlatformEmail(config, {
        to: input.destinationNormalized,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
      if (result.success && result.provider !== 'stub') {
        return { outcome: 'provider_accepted', providerName: result.provider, providerMessageId: result.id };
      }
      if (result.provider === 'stub') {
        return { outcome: 'unconfigured', providerName: result.provider, errorCode: 'no_platform_email_provider_configured' };
      }
      return { outcome: 'retryable_failure', providerName: result.provider, errorCode: result.error };
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

function shapeRequestResult(result: Record<string, unknown>): RequestChallengeResult {
  return {
    handle: String(result.handle),
    generation: Number(result.generation),
    expiresAt: String(result.expiresAt),
    resendAvailableAt: String(result.resendAvailableAt),
    // Absent on a soft `stale_attempt_token` finalize rejection (this
    // attempt was superseded before it could record what actually
    // happened) and, defensively, on any other shape that omits it —
    // 'ambiguous' is the correct default in both cases: the caller cannot
    // safely assume the code went out, but also cannot assume it didn't.
    deliveryOutcome: (result.deliveryOutcome as RequestChallengeResult['deliveryOutcome']) ?? 'ambiguous',
  };
}

interface PreparedDelivery {
  args: Record<string, unknown>;
  fingerprint: string;
  subjectRefHash: string | undefined;
}

/**
 * Builds the brand-new-challenge (generation 1) RPC args for `request`.
 */
async function prepareRequestArgs(
  config: ServerConfig,
  input: RequestChallengeInput,
  policy: PurposePolicy,
): Promise<PreparedDelivery> {
  const normalized = normalizeDestination(input.channel, input.destination);
  if (!normalized.ok || !normalized.normalized) {
    throw new Error(`invalid_destination:${'reason' in normalized ? normalized.reason : 'unknown'}`);
  }

  const locale = await resolveEffectiveLocale(config, input.locale, input.workspaceId);
  const destinationHash = hashDestination(normalized.normalized);
  const subjectRefHash = input.subjectRef ? hashSubjectRef(input.subjectRef) : undefined;
  const handle = generateChallengeHandle();
  const keyVersion = currentVerificationKeyVersion();
  const generation = 1;
  const domainInputs = { purpose: input.purpose, channel: input.channel, challengeHandle: handle, generation, destinationHash };
  const codeDigest = digestOtpCode(domainInputs, deriveOtpCode(domainInputs, keyVersion, policy.otpLength), keyVersion);

  const requestIpHash = input.requester.ipAddress ? hashIpForRateLimit(input.requester.ipAddress) : undefined;
  const fingerprint = deriveRequestFingerprint({
    purpose: input.purpose, channel: input.channel, destinationHash,
    subjectRefHash: subjectRefHash ?? null, workspaceId: input.workspaceId ?? null,
  });

  return {
    fingerprint,
    subjectRefHash,
    args: {
      handle, purpose: input.purpose, channel: input.channel, workspaceId: input.workspaceId ?? null,
      subjectKind: input.subjectKind, subjectRef: input.subjectRef ?? null, subjectRefHash: subjectRefHash ?? null,
      destinationNormalized: normalized.normalized, destinationHash, locale, keyVersion, codeDigest,
      ttlSeconds: policy.otpTtlSeconds, maxAttempts: policy.maxVerificationAttempts, maxSends: policy.maxSendsPerWindow,
      resendCooldownSeconds: policy.resendCooldownSeconds, rateWindowSeconds: policy.rateWindowSeconds,
      maxPerWindow: policy.maxSendsPerWindow, invalidatePrevious: policy.invalidatesPreviousGeneration,
      requestIpHash: requestIpHash ?? null,
    },
  };
}

/**
 * Builds the next-generation RPC args for `resend`. Requires the EXISTING
 * challenge's own handle and reads its authoritative scope
 * (purpose/channel/workspaceId/subjectRefHash/destinationHash/generation)
 * directly from the database FIRST — never trusts the caller's claimed
 * scope for anything beyond a fast-fail check here; `_gv_do_resend` is what
 * actually enforces it, under a row lock, before superseding anything.
 * Reading the real generation here (rather than a hardcoded constant) is
 * what makes the OTP domain separation explicit and correct across
 * resends — see crypto.ts's deriveOtpCode/digestOtpCode.
 */
async function prepareResendArgs(
  config: ServerConfig,
  input: ResendChallengeInput,
  policy: PurposePolicy,
): Promise<PreparedDelivery> {
  const sb = getServiceClient(config);
  const { data: existing, error } = await sb
    .from('verification_challenges')
    .select('generation, purpose, channel, workspace_id, subject_ref_hash, destination_hash')
    .eq('handle', input.handle)
    .maybeSingle();
  if (error) throw new Error(error.message);

  const subjectRefHash = input.subjectRef ? hashSubjectRef(input.subjectRef) : undefined;

  // Same generic rejection whether the handle doesn't exist or exists but
  // claims a scope that doesn't match the database's own record of it —
  // a caller probing handles can never distinguish the two. This is a
  // fast-fail; `_gv_do_resend` re-validates the identical check under a
  // row lock before superseding anything, and is the authoritative one.
  if (
    !existing ||
    existing.purpose !== input.purpose ||
    existing.channel !== input.channel ||
    (existing.workspace_id ?? null) !== (input.workspaceId ?? null) ||
    (existing.subject_ref_hash ?? null) !== (subjectRefHash ?? null)
  ) {
    throw new VerificationScopeMismatchError('resend target does not exist or does not match the claimed scope');
  }

  const newGeneration = existing.generation + 1;
  const handle = generateChallengeHandle();
  const keyVersion = currentVerificationKeyVersion();
  const domainInputs = { purpose: input.purpose, channel: input.channel, challengeHandle: handle, generation: newGeneration, destinationHash: existing.destination_hash as string };
  const codeDigest = digestOtpCode(domainInputs, deriveOtpCode(domainInputs, keyVersion, policy.otpLength), keyVersion);

  const requestIpHash = input.requester.ipAddress ? hashIpForRateLimit(input.requester.ipAddress) : undefined;
  const fingerprint = deriveRequestFingerprint({
    purpose: input.purpose, channel: input.channel, existingHandle: input.handle,
    subjectRefHash: subjectRefHash ?? null, workspaceId: input.workspaceId ?? null,
  });

  return {
    fingerprint,
    subjectRefHash,
    args: {
      existingHandle: input.handle, handle, purpose: input.purpose, channel: input.channel,
      workspaceId: input.workspaceId ?? null, subjectRefHash: subjectRefHash ?? null,
      keyVersion, codeDigest, ttlSeconds: policy.otpTtlSeconds, maxAttempts: policy.maxVerificationAttempts,
      maxSends: policy.maxSendsPerWindow, resendCooldownSeconds: policy.resendCooldownSeconds,
      rateWindowSeconds: policy.rateWindowSeconds, maxPerWindow: policy.maxSendsPerWindow,
      requestIpHash: requestIpHash ?? null,
    },
  };
}

/**
 * Shared prepare → send → finalize choreography for both `request` and
 * `resend` — a resend IS a new generation of the same logical challenge
 * (see docs/GENERIC_VERIFICATION_CORE.md §Lifecycle); the only difference
 * is the idempotency operation label (so "resend" and "request" retries
 * can never be confused as replay targets of each other even with the
 * same caller-supplied `idempotencyKey`) and how the RPC args are built
 * (prepareRequestArgs vs prepareResendArgs above).
 */
async function runDelivery(
  config: ServerConfig,
  operation: 'request' | 'resend',
  purpose: string,
  channel: 'email' | 'sms',
  workspaceId: string | null,
  callerIdempotencyKey: string,
  authenticatedUserId: string | undefined,
  prepared: PreparedDelivery,
  policy: PurposePolicy,
): Promise<RequestChallengeResult> {
  const idempotencyKey = deriveIdempotencyKey({
    operation, scopeKind: purpose, actorRef: authenticatedUserId ?? 'anonymous', requestId: callerIdempotencyKey,
  });

  const sb = getServiceClient(config);
  const { data: prepData, error: prepError } = await sb.rpc('gv_prepare_verification_delivery', {
    _key: idempotencyKey,
    _scope_kind: purpose,
    _operation: operation,
    _request_fingerprint: prepared.fingerprint,
    _purpose: purpose,
    _workspace_id: workspaceId,
    _actor_ref_hash: prepared.subjectRefHash ?? null,
    _args: prepared.args,
  });
  if (prepError) throwForPrepareError(prepError.message || '');

  const prep = prepData as { status: 'fresh' | 'resume' | 'replayed' | 'error'; result?: Record<string, unknown>; attemptToken?: string; error?: string };

  if (prep.status === 'error') {
    throw new Error(`gv_prepare_verification_delivery failed: ${prep.error ?? 'unknown'}`);
  }

  if (prep.status === 'replayed') {
    // This exact request already finished (committed) — never contact the
    // provider again for it. Return the cached result as-is.
    return shapeRequestResult(prep.result!);
  }

  // 'fresh' (the ordinary path) or 'resume' (a PRIOR attempt with this
  // exact idempotency key committed the challenge but crashed before
  // finalizing — see gv_prepare_verification_delivery's own comment).
  // Either way, `prep.result` names the ACTUAL committed challenge —
  // possibly not the candidate generated in prepareRequestArgs/
  // prepareResendArgs above, if this is a 'resume' of an earlier attempt.
  // Deterministic derivation means re-deriving from that committed
  // handle/generation/destinationHash/keyVersion reproduces the exact same
  // code that would have (or already did) go out.
  const result = prep.result!;
  const committedHandle = String(result.handle);
  const committedGeneration = Number(result.generation);
  const committedDestinationHash = String(result.destinationHash);
  const committedDestinationNormalized = String(result.destinationNormalized);
  const committedKeyVersion = Number(result.keyVersion);
  const committedLocale = result.locale as VerificationLocale;

  const code = deriveOtpCode(
    { purpose, channel, challengeHandle: committedHandle, generation: committedGeneration, destinationHash: committedDestinationHash },
    committedKeyVersion,
    policy.otpLength,
  );

  // NOTE on 'resume': if the prior attempt's provider call actually
  // succeeded and only the finalize call (or the response Express was
  // waiting for) was lost, this send is a genuine SECOND provider
  // submission for the same logical OTP — at-least-once delivery, not
  // exactly-once. Neither of this codebase's email/SMS provider
  // abstractions accept a caller-supplied idempotency key today, so this
  // is an accepted, documented boundary (docs/GENERIC_VERIFICATION_CORE.md
  // §Delivery) rather than something this function can eliminate. What IS
  // guaranteed: the code is identical both times, the attempt-token
  // rotation guarantees only ONE Express request's finalize call can ever
  // record the outcome, and the DATABASE state is never duplicated.
  const sendResult = await sendOtpDirect(config, {
    channel, workspaceId, destinationNormalized: committedDestinationNormalized,
    locale: committedLocale, code, ttlSeconds: policy.otpTtlSeconds,
  });

  const { data: finData, error: finError } = await sb.rpc('gv_finalize_verification_delivery', {
    _key: idempotencyKey,
    _attempt_token: prep.attemptToken,
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

  // `applied: false` (stale_attempt_token) means a LATER attempt already
  // superseded this one — `fin.result` is that later attempt's current
  // ledger state (with no `deliveryOutcome` yet, since this stale caller's
  // send is not what gets recorded), and shapeRequestResult's default of
  // 'ambiguous' is exactly right: this caller cannot claim the code did or
  // did not go out. Applied or not, returning `fin.result` as-is is
  // correct either way.
  const fin = finData as { applied: boolean; alreadyFinalized: boolean; reason?: string; result: Record<string, unknown> };
  return shapeRequestResult(fin.result);
}

export async function requestVerificationChallenge(
  config: ServerConfig,
  input: RequestChallengeInput,
): Promise<RequestChallengeResult> {
  const policy = assertChannelAllowed(input.purpose, input.channel);
  assertPolicyBindings(input.purpose, policy, {
    subjectKind: input.subjectKind,
    subjectRef: input.subjectRef,
    workspaceId: input.workspaceId,
    authenticatedUserId: input.requester.authenticatedUserId,
  });

  const prepared = await prepareRequestArgs(config, input, policy);
  return runDelivery(
    config, 'request', input.purpose, input.channel, input.workspaceId ?? null,
    input.idempotencyKey, input.requester.authenticatedUserId, prepared, policy,
  );
}

export async function resendVerificationChallenge(
  config: ServerConfig,
  input: ResendChallengeInput,
): Promise<RequestChallengeResult> {
  const policy = assertChannelAllowed(input.purpose, input.channel);
  assertPolicyBindings(input.purpose, policy, {
    subjectKind: input.subjectKind,
    subjectRef: input.subjectRef,
    workspaceId: input.workspaceId,
    authenticatedUserId: input.requester.authenticatedUserId,
  });

  const prepared = await prepareResendArgs(config, input, policy);
  return runDelivery(
    config, 'resend', input.purpose, input.channel, input.workspaceId ?? null,
    input.idempotencyKey, input.requester.authenticatedUserId, prepared, policy,
  );
}

/**
 * Crash-safe, idempotent-by-construction verification. `input.requestId`
 * (REQUIRED — see types.ts) derives the idempotency key: the SAME
 * requestId with the SAME code/scope always replays the identical
 * committed result (no double attempt-counting, no double proof
 * issuance); the SAME requestId with a DIFFERENT code/scope is rejected as
 * an idempotency conflict, never silently re-interpreted; a NEW requestId
 * always re-executes and counts as a genuinely new attempt, even against
 * the same challenge. Concurrency safety is the database's
 * (gv_execute_idempotent's ledger-row lock, then _gv_do_verify's own
 * challenge-row lock) — this function issues exactly one RPC call per
 * invocation and never races itself.
 *
 * The proof token is DERIVED, never randomly generated (see crypto.ts's
 * deriveProofToken) — deterministic from (handle, requestId, purpose,
 * channel, keyVersion), so a transport loss AFTER a successful commit
 * (the RPC call succeeded and issued a proof, but the response never
 * reached this function, or reached it and was lost before reaching the
 * HTTP caller) is recovered by simply calling this function again with
 * the SAME requestId: gv_execute_idempotent replays the committed
 * `proofIssued` flag, and this function re-derives the EXACT SAME raw
 * token — which still hashes to the same value already stored on the
 * `verification_proofs` row — without the raw token ever having been
 * persisted anywhere.
 */
export async function verifyVerificationChallenge(
  config: ServerConfig,
  input: VerifyChallengeInput,
): Promise<VerifyChallengeResult> {
  const policy = assertChannelAllowed(input.purpose, input.channel);
  assertPolicyBindings(input.purpose, policy, {
    subjectRef: input.subjectRef,
    workspaceId: input.workspaceId,
    authenticatedUserId: input.requester.authenticatedUserId,
  });

  const sb = getServiceClient(config);

  // Need the challenge's own recorded generation/key_version/destination_hash
  // to recompute the candidate digest with the HISTORICAL generation/key —
  // never a hardcoded/current one. This is a plain SELECT (service_role has
  // direct SELECT grant on verification_challenges), not a second RPC
  // round-trip.
  const { data: chal, error } = await sb
    .from('verification_challenges')
    .select('generation, key_version, destination_hash')
    .eq('handle', input.handle)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!chal) return { ok: false, reason: 'invalid_code' }; // uniform — never "not_found" to the caller

  const candidateDigest = candidateOtpDigest(
    { purpose: input.purpose, channel: input.channel, challengeHandle: input.handle, generation: chal.generation, destinationHash: chal.destination_hash },
    input.code,
    chal.key_version,
  );

  const subjectRefHash = input.subjectRef ? hashSubjectRef(input.subjectRef) : undefined;
  const ipHash = input.requester.ipAddress ? hashIpForRateLimit(input.requester.ipAddress) : undefined;

  const proofKeyVersion = currentVerificationKeyVersion();
  const proofToken = deriveProofToken(
    { handle: input.handle, requestId: input.requestId, purpose: input.purpose, channel: input.channel },
    proofKeyVersion,
  );
  const proofHash = hashProofToken(proofToken, proofKeyVersion);

  const idempotencyKey = deriveIdempotencyKey({
    operation: 'verify', scopeKind: input.purpose, actorRef: input.requester.authenticatedUserId ?? 'anonymous', requestId: input.requestId,
  });
  const fingerprint = deriveRequestFingerprint({
    handle: input.handle, candidateDigest, purpose: input.purpose, channel: input.channel,
    workspaceId: input.workspaceId ?? null, subjectRefHash: subjectRefHash ?? null,
  });

  const { data, error: verifyError } = await sb.rpc('gv_execute_idempotent', {
    _key: idempotencyKey,
    _scope_kind: input.purpose,
    _operation: 'verify',
    _request_fingerprint: fingerprint,
    _purpose: input.purpose,
    _workspace_id: input.workspaceId ?? null,
    _actor_ref_hash: subjectRefHash ?? null,
    _args: {
      handle: input.handle, candidateDigest, purpose: input.purpose, channel: input.channel,
      workspaceId: input.workspaceId ?? null, subjectRefHash: subjectRefHash ?? null, ipHash: ipHash ?? null,
      issuesProof: policy.issuesProof, proofHash, proofTtlSeconds: policy.proofTtlSeconds,
    },
  });
  if (verifyError) throwForPrepareError(verifyError.message || '');
  const outcome = data as { replayed: boolean; result: { ok: boolean; reason?: string; proofIssued?: boolean } };
  const result = outcome.result;

  if (!result.ok) return { ok: false, reason: String(result.reason ?? 'invalid_code') };
  // Whether this call just issued the proof (fresh) or is replaying an
  // already-committed 'verify' (same requestId retried), `proofToken` is
  // re-derived identically above — always safe to return when the
  // committed result says a proof was issued.
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
  const policy = assertChannelAllowed(input.purpose, input.channel);
  assertPolicyBindings(input.purpose, policy, {
    subjectRef: input.subjectRef,
    workspaceId: input.workspaceId,
    authenticatedUserId: input.authenticatedUserId,
  });

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
