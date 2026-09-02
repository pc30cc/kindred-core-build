/**
 * WORKSPACE INVITATIONS v5.1 — durable outbox worker (Express, self-hosted).
 *
 * Lifecycle per job (v5.1 §9):
 *   claim (short tx, FOR UPDATE SKIP LOCKED, lease + claim_token)
 *     -> prepare (ws -> invitation -> job locks; persists the derived email
 *        token hash; COMMITS before any provider call)
 *     -> read-only preflight
 *     -> provider submission OUTSIDE any transaction/lock
 *     -> completion (claim-token guarded, append-only delivery row)
 *
 * Provider acceptance is never labelled "delivered". A stub/unconfigured
 * provider is never success. Delivery failure never revokes the invitation.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { sendEmail } from '../email/index.js';
import { sendSms } from '../sms/index.js';
import {
  deriveEmailToken,
  currentKeyVersion,
  hasDerivationKey,
  sha256Hex,
  tokenPrefix,
  resolveAppBaseUrl,
  buildInviteUrl,
  EMAIL_TOKEN_TTL_MS,
  DerivationKeyUnavailable,
  deriveOtpCode,
  hasOtpKey,
} from './tokens.js';

const WORKER_ID = `invitations-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const POLL_MS = 5_000;
const LEASE_SECONDS = 120;
const BATCH = 5;
const MAX_BATCHES_PER_TICK = 20;
const TICK_BUDGET_MS = 20_000;

let timer: NodeJS.Timeout | null = null;
let running = false;

function backoffSeconds(attempt: number): number {
  return Math.min(3600, Math.round(30 * Math.pow(2, Math.max(0, attempt - 1))));
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char] || char);
}

async function complete(
  config: ServerConfig,
  jobId: string,
  claimToken: string,
  outcome: 'provider_accepted' | 'retry' | 'permanently_failed' | 'unconfigured' | 'derivation_key_unavailable',
  extra: { provider?: string; messageId?: string; errorCode?: string; message?: string; retryIn?: number } = {},
): Promise<void> {
  const { data, error } = await getServiceClient(config).rpc('wi_complete_invitation_job', {
    _job_id: jobId,
    _claim_token: claimToken,
    _outcome: outcome,
    _provider_name: extra.provider ?? null,
    _provider_message_id: extra.messageId ?? null,
    _error_code: extra.errorCode ?? null,
    _safe_error_message: extra.message ? String(extra.message).slice(0, 300) : null,
    _retry_in_seconds: extra.retryIn ?? 60,
  });
  if (error || !(data as any)?.applied) {
    throw new Error(error?.message || 'JOB_CLAIM_LOST');
  }
}

/**
 * Phase 0.2 — terminal OTP failure in ONE transaction: the still-live OTP is
 * revoked, the delivery row written, the claim cleared and the job marked
 * terminal together, under a claim-token + worker-identity + lease guard.
 */
async function failOtpAtomically(
  config: ServerConfig,
  job: any,
  claimToken: string,
  outcome: 'permanently_failed' | 'unconfigured' | 'derivation_key_unavailable',
  extra: { provider?: string; errorCode?: string; message?: string } = {},
): Promise<void> {
  const { data, error } = await getServiceClient(config).rpc('wi_fail_otp_job_atomic', {
    _job_id: job.id,
    _claim_token: claimToken,
    _worker_id: WORKER_ID,
    _outcome: outcome,
    _provider_name: extra.provider ?? null,
    _error_code: extra.errorCode ?? null,
    _safe_error_message: extra.message ? String(extra.message).slice(0, 300) : null,
  });
  if (error || !(data as any)?.applied) {
    throw new Error(error?.message || 'JOB_CLAIM_LOST');
  }
}

async function processJob(config: ServerConfig, job: any): Promise<void> {
  const sb = getServiceClient(config);
  const claimToken = job.claim_token as string;
  const heartbeat = setInterval(() => {
    void getServiceClient(config).rpc('wi_heartbeat_invitation_job', {
      _job_id: job.id, _claim_token: claimToken, _lease_seconds: LEASE_SECONDS,
    });
  }, 40_000);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  try {

  let emailToken: string | null = null;
  let keyVersion: number | null = null;

  if (job.channel === 'email') {
    try {
      keyVersion = job.derivation_key_version ?? currentKeyVersion();
      if (!hasDerivationKey(keyVersion)) throw new DerivationKeyUnavailable(keyVersion);
      emailToken = deriveEmailToken({
        invitationId: job.invitation_id,
        jobId: job.id,
        notificationGeneration: job.notification_generation,
        emailTokenGeneration: job.email_token_generation ?? 1,
        keyVersion,
      });
    } catch {
      // Fail closed: never send a link derived from a different key.
      await complete(config, job.id, claimToken, 'derivation_key_unavailable', {
        errorCode: 'DERIVATION_KEY_UNAVAILABLE',
        message: 'invitation link key unavailable',
      });
      return;
    }
  }

  const { data: prepared, error: prepareError } = await sb.rpc('wi_prepare_invitation_job', {
    _job_id: job.id,
    _claim_token: claimToken,
    _token_hash: emailToken ? sha256Hex(emailToken) : null,
    _token_prefix: emailToken ? tokenPrefix(emailToken) : null,
    _token_expires_at: emailToken ? new Date(Date.now() + EMAIL_TOKEN_TTL_MS).toISOString() : null,
    _derivation_key_version: keyVersion,
  });

  if (prepareError) {
    await complete(config, job.id, claimToken, 'retry', {
      errorCode: 'PREPARE_FAILED',
      message: prepareError.message,
      retryIn: backoffSeconds(job.attempt_count),
    });
    return;
  }
  if (!prepared || (prepared as any).cancelled) return;

  const payload = prepared as any;

  // Read-only preflight immediately before submission.
  const { data: sendable } = await sb.rpc('wi_job_still_sendable', {
    _job_id: job.id,
    _claim_token: claimToken,
  });
  if (!sendable) return;

  if (job.channel === 'otp_email') {
    // v5.1 B.5: the code was never stored — re-derive it from the OTP id and
    // the pepper of the RECORDED key version, so a crash before delivery is
    // recoverable and a pepper rotation can never e-mail an invalid code.
    const { data: state } = await sb.rpc('wi_otp_job_sendable', {
      _job_id: job.id,
      _claim_token: claimToken,
    });
    const otpState = (state || {}) as any;
    if (!otpState.sendable) {
      await failOtpAtomically(config, job, claimToken, 'permanently_failed', {
        errorCode: 'OTP_NO_LONGER_LIVE',
        message: 'otp consumed, revoked or expired',
      }).catch(() => undefined);
      return;
    }

    const otpVersion = Number(otpState.key_version ?? 1);
    if (!hasOtpKey(otpVersion)) {
      // Fail closed and atomically: revoke the OTP nobody can ever verify.
      await failOtpAtomically(config, job, claimToken, 'derivation_key_unavailable', {
        errorCode: 'DERIVATION_KEY_UNAVAILABLE',
        message: 'otp derivation key unavailable',
      });
      return;
    }

    const code = deriveOtpCode(String(otpState.invitation_id), String(otpState.otp_id), otpVersion);
    const result = await sendEmail(config, {
      workspaceId: String(otpState.workspace_id),
      to: String(otpState.email),
      subject: 'Your verification code',
      text: `Verification code: ${code}\nIt expires in 10 minutes.`,
      html: `<p>Verification code: <strong>${escapeHtml(code)}</strong></p><p>It expires in 10 minutes.</p>`,
    });

    if (result.success && result.provider !== 'stub') {
      await complete(config, job.id, claimToken, 'provider_accepted', {
        provider: result.provider, messageId: result.id,
      });
      return;
    }

    const terminal = result.provider === 'stub' || job.attempt_count + 1 >= (job.max_attempts ?? 3);
    if (terminal) {
      // No human can receive this code: revoking it and recording the terminal
      // delivery state happen in ONE claim-guarded transaction, so a crash can
      // never leave a revoked OTP behind a still-claimed job.
      await failOtpAtomically(
        config, job, claimToken,
        result.provider === 'stub' ? 'unconfigured' : 'permanently_failed',
        {
          provider: result.provider,
          errorCode: result.provider === 'stub' ? 'EMAIL_PROVIDER_UNCONFIGURED' : 'OTP_SEND_FAILED',
          message: result.error || 'otp delivery failed',
        },
      );
      return;
    }

    await complete(config, job.id, claimToken, 'retry', {
      provider: result.provider,
      errorCode: 'OTP_SEND_FAILED',
      message: result.error || 'send failed',
      retryIn: backoffSeconds(job.attempt_count),
    });
    return;
  }


  if (job.channel === 'email') {
    const appBase = await resolveAppBaseUrl(config);
    const link = buildInviteUrl(appBase, emailToken as string, 'email_claim');
    const result = await sendEmail(config, {
      workspaceId: payload.workspace_id,
      to: payload.email,
      templateSlug: 'invite_member',
      locale: payload.locale || 'en',
      templateData: {
        name: escapeHtml(payload.first_name), brand: escapeHtml(payload.workspace_name),
        workspace: escapeHtml(payload.workspace_name), inviter: '', role: escapeHtml(payload.role),
        action_url: escapeHtml(link),
      },
      subject: `You are invited to ${payload.workspace_name}`,
      text: `Hello ${payload.first_name},\n\nYou were invited to join ${payload.workspace_name}.\nOpen this link to accept:\n${link}\n`,
      html: `<p>Hello ${escapeHtml(payload.first_name)},</p><p>You were invited to join <strong>${escapeHtml(payload.workspace_name)}</strong>.</p><p><a href="${escapeHtml(link)}">Accept the invitation</a></p>`,
    });

    if (result.success && result.provider !== 'stub') {
      await complete(config, job.id, claimToken, 'provider_accepted', {
        provider: result.provider,
        messageId: result.id,
      });
    } else if (result.provider === 'stub') {
      await complete(config, job.id, claimToken, 'unconfigured', {
        provider: 'stub',
        errorCode: 'EMAIL_PROVIDER_UNCONFIGURED',
        message: 'no email provider configured',
      });
    } else {
      await complete(config, job.id, claimToken, 'retry', {
        provider: result.provider,
        errorCode: 'EMAIL_SEND_FAILED',
        message: result.error || 'send failed',
        retryIn: backoffSeconds(job.attempt_count),
      });
    }
    return;
  }

  // SMS notification carries NO token — only the fact of an invitation.
  const smsLocale = String(payload.locale || 'en');
  const smsBody = smsLocale === 'fa'
    ? `${payload.workspace_name}: برای عضویت در تیم دعوت شده‌اید. برای پذیرش، ایمیل ${payload.email} را بررسی کنید.`
    : smsLocale === 'tr'
      ? `${payload.workspace_name}: ekibe davet edildiniz. Kabul etmek için ${payload.email} e-postasını kontrol edin.`
      : `${payload.workspace_name}: you were invited to join the team. Check your email (${payload.email}) to accept.`;
  const smsResult = await sendSms(config, {
    to: payload.phone,
    body: smsBody,
  } as any);

  if (smsResult.success) {
    await complete(config, job.id, claimToken, 'provider_accepted', {
      provider: smsResult.provider,
      messageId: (smsResult as any).messageId,
    });
  } else {
    await complete(config, job.id, claimToken, 'retry', {
      provider: smsResult.provider,
      errorCode: (smsResult as any).errorCode || 'SMS_SEND_FAILED',
      message: 'sms send failed',
      retryIn: backoffSeconds(job.attempt_count),
    });
  }
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * One full outbox pass. Exported so the integration suites can drain the queue
 * deterministically instead of waiting on the interval timer; production still
 * drives it from `tick`.
 */
export async function drainInvitationJobs(config: ServerConfig): Promise<void> {
  const sb = getServiceClient(config);

  await sb.rpc('reclaim_expired_invitation_jobs');
  await sb.rpc('expire_invitations_v2', { _limit: 200 });

  const deadline = Date.now() + TICK_BUDGET_MS;
  let batches = 0;

  async function claimAndRun(channels: string[]): Promise<number> {
    const { data: jobs, error } = await sb.rpc('claim_invitation_jobs', {
      _worker_id: WORKER_ID,
      _limit: BATCH,
      _lease_seconds: LEASE_SECONDS,
      _channels: channels,
    });
    if (error) {
      console.warn('[invitationWorker] claim failed:', error.message);
      return 0;
    }
    if (!Array.isArray(jobs) || jobs.length === 0) return 0;

    for (const job of jobs) {
      try {
        await processJob(config, job);
      } catch (err: any) {
        try {
          await complete(config, job.id, job.claim_token, 'retry', {
            errorCode: 'WORKER_ERROR',
            message: err?.message || 'worker error',
            retryIn: backoffSeconds(job.attempt_count),
          });
        } catch { /* the lease reaper will requeue */ }
      }
    }
    return jobs.length;
  }

  // Phase 0.1 — bounded priority with fairness. OTP codes live for ten
  // minutes, so they are claimed FIRST in every round; invitation email/SMS
  // is then always given its own round, so an OTP flood cannot starve it
  // either. The loop is bounded by both a batch count and a time budget:
  // never unbounded.
  while (batches < MAX_BATCHES_PER_TICK && Date.now() < deadline) {
    const otp = await claimAndRun(['otp_email']);
    if (otp > 0) batches += 1;

    if (batches >= MAX_BATCHES_PER_TICK || Date.now() >= deadline) break;

    const normal = await claimAndRun(['email', 'sms']);
    if (normal > 0) batches += 1;

    if (otp === 0 && normal === 0) break; // nothing due: stop this tick
  }
}

async function tick(config: ServerConfig): Promise<void> {
  if (running) return;
  running = true;
  try {
    await drainInvitationJobs(config);
  } catch (err: any) {
    console.warn('[invitationWorker] tick failed:', err?.message || err);
  } finally {
    running = false;
  }
}

export function startInvitationWorker(config: ServerConfig): void {
  if (timer) return;
  timer = setInterval(() => { void tick(config); }, POLL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[invitationWorker] started (${WORKER_ID})`);
}

export function stopInvitationWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
