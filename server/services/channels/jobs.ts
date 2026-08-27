/**
 * Durable Postgres-backed channel job queue.
 *
 * ONE queue covers the whole channel lifecycle — inbound and outbound. It is
 * shared by Core (enqueue) and the Channels Worker (claim / complete), and
 * mirrors the existing `entitlement_fanout_jobs` claim pattern
 * (SECURITY DEFINER + FOR UPDATE SKIP LOCKED + expiring lease).
 *
 * PAYLOADS NEVER CONTAIN SECRETS. The worker resolves credentials by
 * integration id, server-side.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const CHANNEL_JOB_TYPES = [
  'telegram_inbound_event',
  'telegram_inbound_media',
  'telegram_outbound_message',
  'telegram_outbound_media',
  'telegram_profile_sync',
  'telegram_webhook_repair',
] as const;

export type ChannelJobType = (typeof CHANNEL_JOB_TYPES)[number];

export type ChannelJob = {
  id: string;
  provider: string;
  job_type: ChannelJobType;
  workspace_id: string;
  integration_id: string | null;
  payload: Record<string, unknown>;
  attempt_count: number;
  max_attempts: number;
  claim_token: string;
  claim_expires_at: string;
};

export function isChannelJobType(value: unknown): value is ChannelJobType {
  return typeof value === 'string' && (CHANNEL_JOB_TYPES as readonly string[]).includes(value);
}

export async function enqueueChannelJob(
  sb: SupabaseClient,
  input: {
    provider: string;
    jobType: ChannelJobType;
    workspaceId: string;
    integrationId: string | null;
    payload?: Record<string, unknown>;
    availableAt?: Date;
    maxAttempts?: number;
  },
): Promise<string> {
  const { data, error } = await sb
    .from('channel_jobs')
    .insert({
      provider: input.provider,
      job_type: input.jobType,
      workspace_id: input.workspaceId,
      integration_id: input.integrationId,
      payload: input.payload ?? {},
      available_at: (input.availableAt ?? new Date()).toISOString(),
      max_attempts: input.maxAttempts ?? 8,
    })
    .select('id')
    .single();
  if (error) throw new Error(`channel job enqueue failed: ${error.message}`);
  return (data as { id: string }).id;
}

export async function claimChannelJobs(
  sb: SupabaseClient,
  workerId: string,
  limit: number,
  leaseSeconds: number,
  jobTypes: ChannelJobType[] | null,
): Promise<ChannelJob[]> {
  const { data, error } = await sb.rpc('claim_channel_jobs', {
    _worker_id: workerId,
    _limit: limit,
    _lease_seconds: leaseSeconds,
    _job_types: jobTypes,
  });
  if (error) throw new Error(`channel job claim failed: ${error.message}`);
  return (data ?? []) as ChannelJob[];
}

/** Exponential backoff with jitter, capped at 15 minutes. */
export function backoffSeconds(attempt: number): number {
  const base = Math.min(2 ** Math.max(attempt - 1, 0) * 5, 900);
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

export async function recordAttempt(
  sb: SupabaseClient,
  jobId: string,
  attempt: number,
  status: 'succeeded' | 'failed' | 'retrying',
  detail: { errorCode?: string | null; errorMessage?: string | null; latencyMs?: number | null } = {},
): Promise<void> {
  await sb.from('channel_delivery_attempts').insert({
    job_id: jobId,
    attempt,
    status,
    error_code: detail.errorCode ?? null,
    error_message: detail.errorMessage ? detail.errorMessage.slice(0, 1000) : null,
    latency_ms: detail.latencyMs ?? null,
  });
}

export async function completeChannelJob(sb: SupabaseClient, job: ChannelJob): Promise<void> {
  const { error } = await sb
    .from('channel_jobs')
    .update({
      status: 'succeeded',
      claim_token: null,
      claim_expires_at: null,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', job.id)
    .eq('claim_token', job.claim_token);
  if (error) throw new Error(`channel job completion failed: ${error.message}`);
}

/**
 * Retry or permanently fail. Honours an explicit `retryAfterSeconds`
 * (Telegram 429) over the computed backoff.
 */
export async function failChannelJob(
  sb: SupabaseClient,
  job: ChannelJob,
  errorMessage: string,
  retryAfterSeconds?: number | null,
): Promise<'retrying' | 'failed'> {
  const exhausted = job.attempt_count >= job.max_attempts;
  const delay = retryAfterSeconds && retryAfterSeconds > 0
    ? retryAfterSeconds
    : backoffSeconds(job.attempt_count);

  const { error } = await sb
    .from('channel_jobs')
    .update({
      status: exhausted ? 'failed' : 'pending',
      available_at: new Date(Date.now() + delay * 1000).toISOString(),
      claim_token: null,
      claim_expires_at: null,
      last_error: errorMessage.slice(0, 1000),
      updated_at: new Date().toISOString(),
    })
    .eq('id', job.id)
    .eq('claim_token', job.claim_token);
  if (error) throw new Error(`channel job failure update failed: ${error.message}`);
  return exhausted ? 'failed' : 'retrying';
}

export type ChannelQueueMetrics = {
  pending: number;
  running: number;
  failed: number;
  oldestPendingAgeSeconds: number | null;
};

export async function queueMetrics(sb: SupabaseClient): Promise<ChannelQueueMetrics> {
  const counts = await Promise.all(
    (['pending', 'running', 'failed'] as const).map(async (status) => {
      const { count } = await sb
        .from('channel_jobs')
        .select('id', { count: 'exact', head: true })
        .eq('status', status);
      return [status, count ?? 0] as const;
    }),
  );
  const map = Object.fromEntries(counts) as Record<'pending' | 'running' | 'failed', number>;

  const { data: oldest } = await sb
    .from('channel_jobs')
    .select('created_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  return {
    pending: map.pending,
    running: map.running,
    failed: map.failed,
    oldestPendingAgeSeconds: oldest
      ? Math.round((Date.now() - new Date((oldest as any).created_at).getTime()) / 1000)
      : null,
  };
}
