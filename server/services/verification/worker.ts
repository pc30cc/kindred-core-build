/**
 * Generic Verification Core v1 — delivery worker.
 *
 * Mirrors the proven Workspace Invitations v5.1 worker
 * (server/services/invitations/worker.ts) shape: claim (lease/claim-token,
 * SELECT FOR UPDATE SKIP LOCKED), heartbeat, complete (terminal outcomes,
 * claim-token re-validated), reclaim expired leases.
 *
 * NOT registered in worker/index.ts's WORKER_KIND dispatcher — there is no
 * `WORKER_KIND=verification` option, so no running container ever starts
 * this loop in production. It exists as fully-implemented, directly
 * testable code (src/test/integration/verificationWorker.pg.test.ts calls
 * `drainVerificationJobs` explicitly), reachable only by an explicit test
 * or future manual wiring — never by a default deployment. Even if
 * imported and started, every purpose is disabled (server/services/
 * verification/types.ts), so zero jobs are ever created for it to claim.
 */
import os from 'node:os';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { sendEmail } from '../email/index.js';
import { sendSms } from '../sms/index.js';
import { deriveOtpCode, currentVerificationKeyVersion } from './crypto.js';
import { renderOtpEmail, renderOtpSms } from './templates.js';
import { getPurposePolicy, type VerificationLocale } from './types.js';

export interface VerificationDeliveryJob {
  id: string;
  challenge_id: string;
  channel: 'email' | 'sms';
  destination_normalized: string;
  purpose: string;
  locale: VerificationLocale;
  generation: number;
  attempt_count: number;
  max_attempts: number;
  claim_token: string;
}

const DEFAULT_LEASE_SECONDS = 60;
const DEFAULT_BATCH_LIMIT = 20;

export async function claimVerificationJobs(
  config: ServerConfig,
  workerId: string,
  opts: { limit?: number; leaseSeconds?: number; channels?: Array<'email' | 'sms'> } = {},
): Promise<VerificationDeliveryJob[]> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('gv_claim_verification_jobs', {
    _worker_id: workerId,
    _limit: opts.limit ?? DEFAULT_BATCH_LIMIT,
    _lease_seconds: opts.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
    _channels: opts.channels ?? ['email', 'sms'],
  });
  if (error) throw new Error(error.message);
  return (data as VerificationDeliveryJob[]) ?? [];
}

export async function heartbeatVerificationJob(
  config: ServerConfig,
  jobId: string,
  claimToken: string,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
): Promise<boolean> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('gv_heartbeat_verification_job', {
    _job_id: jobId,
    _claim_token: claimToken,
    _lease_seconds: leaseSeconds,
  });
  if (error) throw new Error(error.message);
  return Boolean(data);
}

export type DeliveryOutcome = 'provider_accepted' | 'retry' | 'permanently_failed' | 'unconfigured' | 'derivation_key_unavailable';

export async function completeVerificationJob(
  config: ServerConfig,
  jobId: string,
  claimToken: string,
  outcome: DeliveryOutcome,
  detail: { providerName?: string; providerMessageId?: string; errorCode?: string; errorMessage?: string; retryInSeconds?: number } = {},
): Promise<{ applied: boolean; status?: string }> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('gv_complete_verification_job', {
    _job_id: jobId,
    _claim_token: claimToken,
    _outcome: outcome,
    _provider_name: detail.providerName ?? null,
    _provider_message_id: detail.providerMessageId ?? null,
    _error_code: detail.errorCode ?? null,
    _error_message: detail.errorMessage ?? null,
    _retry_in_seconds: detail.retryInSeconds ?? backoffSeconds(1),
  });
  if (error) throw new Error(error.message);
  return data as { applied: boolean; status?: string };
}

export async function reclaimExpiredVerificationJobs(config: ServerConfig): Promise<number> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('gv_reclaim_expired_verification_jobs', {});
  if (error) throw new Error(error.message);
  return Number(data ?? 0);
}

function backoffSeconds(attempt: number): number {
  return Math.min(3600, Math.round(30 * 2 ** (attempt - 1)));
}

/**
 * Processes one claimed job to completion (single attempt — the caller
 * loop, or a test, decides whether/when to retry). Re-derives the OTP code
 * deterministically (never reads a stored code — none exists) using the
 * challenge's own recorded key_version/destination_hash, exactly mirroring
 * the crash-safety property already proven in the Workspace Invitations
 * v5.1 worker.
 */
export async function processVerificationJob(config: ServerConfig, job: VerificationDeliveryJob): Promise<{ outcome: DeliveryOutcome; detail: Record<string, unknown> }> {
  const sb = getServiceClient(config);
  const { data: chal, error } = await sb
    .from('verification_challenges')
    .select('id, workspace_id, destination_hash, key_version, expires_at')
    .eq('id', job.challenge_id)
    .maybeSingle();

  if (error || !chal) {
    return { outcome: 'permanently_failed', detail: { errorCode: 'challenge_missing' } };
  }

  let policy;
  try {
    policy = getPurposePolicy(job.purpose);
  } catch {
    return { outcome: 'permanently_failed', detail: { errorCode: 'unknown_purpose' } };
  }

  let code: string;
  try {
    code = deriveOtpCode(
      { purpose: job.purpose, channel: job.channel, challengeHandle: job.challenge_id, generation: job.generation, destinationHash: chal.destination_hash },
      chal.key_version,
      policy.otpLength,
    );
  } catch {
    return { outcome: 'derivation_key_unavailable', detail: { errorCode: 'derivation_key_unavailable' } };
  }

  const ttlSeconds = Math.max(1, Math.round((new Date(chal.expires_at).getTime() - Date.now()) / 1000));

  if (job.channel === 'sms') {
    const rendered = renderOtpSms(job.locale, code, ttlSeconds);
    const result = await sendSms(config, { to: job.destination_normalized, body: rendered.text });
    if (result.success) return { outcome: 'provider_accepted', detail: { providerName: result.provider, providerMessageId: result.messageId } };
    return { outcome: 'retry', detail: { providerName: result.provider, errorCode: result.errorCode, errorMessage: result.errorCode } };
  }

  // Email requires a workspace-bound provider config to resolve — see
  // docs/GENERIC_VERIFICATION_CORE.md's documented limitation: a
  // workspace-less (pre-account) email purpose has no platform-level email
  // provider fallback in this codebase today (unlike SMS, which already has
  // one via server/services/sms/index.ts's platform_sms_provider_config).
  // Enabling any pre-account email purpose in the future requires adding
  // that fallback first — this worker correctly reports "unconfigured"
  // rather than silently failing or guessing a provider.
  if (!chal.workspace_id) {
    return { outcome: 'unconfigured', detail: { errorCode: 'no_workspace_bound_email_provider' } };
  }

  const rendered = renderOtpEmail(job.locale, code, ttlSeconds);
  const result = await sendEmail(config, {
    workspaceId: chal.workspace_id,
    to: job.destination_normalized,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });
  if (result.success && result.provider !== 'stub') {
    return { outcome: 'provider_accepted', detail: { providerName: result.provider, providerMessageId: result.id } };
  }
  if (result.provider === 'stub') {
    return { outcome: 'unconfigured', detail: { providerName: result.provider, errorCode: 'no_email_provider_configured' } };
  }
  return { outcome: 'retry', detail: { providerName: result.provider, errorMessage: result.error } };
}

/**
 * Drains up to `opts.limit` claimable jobs once (claim → process →
 * complete). NOT a long-running loop by itself — a real deployment (were
 * this ever wired up) would call this on an interval, exactly like
 * server/services/invitations/worker.ts's `drainInvitationJobs`. Kept as a
 * single-pass function so tests can call it deterministically without
 * timers.
 */
export async function drainVerificationJobs(config: ServerConfig, opts: { workerId?: string; limit?: number } = {}): Promise<number> {
  const workerId = opts.workerId ?? `${os.hostname?.() || 'host'}-${process.pid}-verification`;
  await reclaimExpiredVerificationJobs(config);
  const jobs = await claimVerificationJobs(config, workerId, { limit: opts.limit });
  for (const job of jobs) {
    const { outcome, detail } = await processVerificationJob(config, job);
    const retryInSeconds = outcome === 'retry' ? backoffSeconds(job.attempt_count) : undefined;
    await completeVerificationJob(config, job.id, job.claim_token, outcome, { ...detail, retryInSeconds });
  }
  return jobs.length;
}
