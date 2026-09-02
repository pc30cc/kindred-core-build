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
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import {
  assertChannelAllowed,
  assertPurposeEnabled,
  type ConsumeProofInput,
  type ConsumeProofResult,
  type RequestChallengeInput,
  type RequestChallengeResult,
  type SafeVerificationStatus,
  type VerifyChallengeInput,
  type VerifyChallengeResult,
} from './types.js';
import { normalizeDestination } from './destination.js';
import { resolveEffectiveLocale } from './locale.js';
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

export class VerificationIdempotencyConflictError extends Error {
  constructor(reason: string) {
    super(`Idempotency conflict: ${reason}`);
    this.name = 'VerificationIdempotencyConflictError';
  }
}

async function callIdempotent(
  config: ServerConfig,
  args: {
    key: string; scopeKind: string; operation: 'request' | 'resend' | 'revoke';
    requestFingerprint: string; purpose: string; workspaceId?: string; actorRefHash?: string;
    rpcArgs: Record<string, unknown>;
  },
): Promise<Record<string, unknown>> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('gv_execute_idempotent', {
    _key: args.key,
    _scope_kind: args.scopeKind,
    _operation: args.operation,
    _request_fingerprint: args.requestFingerprint,
    _purpose: args.purpose,
    _workspace_id: args.workspaceId ?? null,
    _actor_ref_hash: args.actorRefHash ?? null,
    _args: args.rpcArgs,
  });
  if (error) {
    if (String(error.message || '').includes('IDEMPOTENCY_RATE_LIMITED') || String(error.message || '').includes('VERIFICATION_RATE_LIMITED')) {
      throw new VerificationRateLimitedError();
    }
    if (String(error.message || '').includes('IDEMPOTENCY_KEY_REUSED') || String(error.message || '').includes('IDEMPOTENCY_KEY_FAILED_PREVIOUSLY')) {
      throw new VerificationIdempotencyConflictError(error.message);
    }
    throw new Error(error.message);
  }
  return (data as { result: Record<string, unknown> }).result;
}

/**
 * Shared implementation for both `request` and `resend` — a resend IS a new
 * generation of the same logical challenge (see
 * docs/GENERIC_VERIFICATION_CORE.md §Lifecycle); the only difference is the
 * idempotency operation label, so "resend" and "request" retries can never
 * be confused as replay targets of each other even with the same
 * caller-supplied `idempotencyKey`.
 */
async function requestOrResend(
  config: ServerConfig,
  input: RequestChallengeInput,
  operation: 'request' | 'resend',
): Promise<RequestChallengeResult> {
  const policy = assertChannelAllowed(input.purpose, input.channel);

  const normalized = normalizeDestination(input.channel, input.destination);
  if (!normalized.ok || !normalized.normalized) {
    throw new Error(`invalid_destination:${normalized.reason ?? 'unknown'}`);
  }

  const locale = await resolveEffectiveLocale(config, input.locale, input.workspaceId);
  const destinationHash = hashDestination(normalized.normalized);
  const subjectRefHash = input.subjectRef ? hashSubjectRef(input.subjectRef) : undefined;
  const handle = generateChallengeHandle();
  const keyVersion = currentVerificationKeyVersion();
  const code = deriveOtpCode(
    { purpose: input.purpose, channel: input.channel, challengeHandle: handle, generation: 1, destinationHash },
    keyVersion,
    policy.otpLength,
  );
  const codeDigest = digestOtpCode(
    { purpose: input.purpose, channel: input.channel, challengeHandle: handle, generation: 1, destinationHash },
    code,
    keyVersion,
  );
  void code; // never returned, never logged — computed only so its digest can be stored; the worker re-derives it independently at send time.

  const requestIpHash = input.requester.ipAddress ? hashIpForRateLimit(input.requester.ipAddress) : undefined;
  const idempotencyKey = deriveIdempotencyKey(
    { operation, scopeKind: input.purpose, actorRef: input.requester.authenticatedUserId ?? 'anonymous', requestId: input.idempotencyKey },
  );
  const fingerprint = deriveRequestFingerprint({
    purpose: input.purpose, channel: input.channel, destinationHash, subjectRefHash: subjectRefHash ?? null, workspaceId: input.workspaceId ?? null,
  });
  const jobIdempotencyKey = deriveIdempotencyKey(
    { operation: 'deliver', scopeKind: input.purpose, actorRef: handle, requestId: `${handle}:${operation}` },
  );

  const result = await callIdempotent(config, {
    key: idempotencyKey,
    scopeKind: input.purpose,
    operation,
    requestFingerprint: fingerprint,
    purpose: input.purpose,
    workspaceId: input.workspaceId,
    actorRefHash: subjectRefHash,
    rpcArgs: {
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
      jobIdempotencyKey,
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

  return {
    handle: String(result.handle),
    generation: Number(result.generation),
    expiresAt: String(result.expiresAt),
    resendAvailableAt: String(result.resendAvailableAt),
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
    { purpose: input.purpose, channel: input.channel, challengeHandle: input.handle, generation: chal.generation, destinationHash: chal.destination_hash },
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
  const idempotencyKey = deriveIdempotencyKey({ operation: 'revoke', scopeKind: input.purpose, actorRef: 'system', requestId: input.idempotencyKey });
  const fingerprint = deriveRequestFingerprint({ handle: input.handle, reason: input.reason });
  const result = await callIdempotent(config, {
    key: idempotencyKey, scopeKind: input.purpose, operation: 'revoke', requestFingerprint: fingerprint, purpose: input.purpose,
    rpcArgs: { handle: input.handle, reason: input.reason },
  });
  return { ok: Boolean(result.ok) };
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
