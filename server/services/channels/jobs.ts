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
import { envFlagEnabled } from '../../config.js';

export const CHANNEL_JOB_TYPES = [
  'telegram_inbound_event',
  'telegram_inbound_media',
  'telegram_outbound_message',
  'telegram_outbound_media',
  'telegram_profile_sync',
  'telegram_webhook_repair',
  // Bale (بله) mirrors the Telegram job surface — same worker handlers, a
  // different API root. See `shared/channels/botProviders.ts`.
  'bale_inbound_event',
  'bale_inbound_media',
  'bale_outbound_message',
  'bale_outbound_media',
  'bale_profile_sync',
  'bale_webhook_repair',
  // WhatsApp Cloud (Meta Graph API). Same job surface, different dialect —
  // the Worker owns the protocol translation.
  'whatsapp_inbound_event',
  'whatsapp_inbound_media',
  'whatsapp_outbound_message',
  'whatsapp_outbound_media',
  'whatsapp_profile_sync',
  'whatsapp_webhook_repair',
  // Instagram Messaging (Meta Messenger Platform). Same job surface again.
  'instagram_inbound_event',
  'instagram_inbound_media',
  'instagram_outbound_message',
  'instagram_outbound_media',
  'instagram_profile_sync',
  'instagram_webhook_repair',
  // X (Twitter) Direct Messages. No webhook/profile-sync surface (see
  // `shared/channels/botProviders.ts`) — inbound is a self-rescheduling poll
  // loop (`x_poll_dm_events`) instead of a pushed `_inbound_event`.
  'x_poll_dm_events',
  'x_outbound_message',
  'x_outbound_media',
  // Gmail (Email Inbox). Inbound has no poll loop: Google's Pub/Sub push
  // (server/routes/gmailPush.ts) lands on a Core route which enqueues
  // `gmail_sync_inbox` directly — the job only ever carries a `historyId`,
  // never a credential. Outbound is a reply composed in the Email Inbox UI.
  'gmail_sync_inbox',
  'gmail_outbound_message',
  // Yahoo Mail (Email Inbox, phase 2). Yahoo has no push webhook for
  // third-party IMAP apps, so inbound is a self-rescheduling poll loop
  // exactly like `x_poll_dm_events` — see worker/channels/index.ts.
  'yahoo_poll_inbox',
  'yahoo_outbound_message',
  // Provider-network-isolated work. Everything that must touch a provider
  // socket runs through these, executed exclusively by the Channels Worker.
  'provider_operation',
  'provider_outbound_action',
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

/**
 * Job type for a bot provider. Job names are provider-prefixed so a stuck
 * provider can be drained or paused independently.
 */
export function botJobType(
  provider: string,
  kind: 'inbound_event' | 'inbound_media' | 'outbound_message' | 'outbound_media' | 'profile_sync' | 'webhook_repair',
): ChannelJobType {
  const jobType = `${provider}_${kind}`;
  if (!isChannelJobType(jobType)) throw new Error(`unsupported bot job type: ${jobType}`);
  return jobType;
}

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

/** Job types that form a poll loop: every run asks Core to enqueue the next. */
export type PollLoopJobType = Extract<ChannelJobType, 'x_poll_dm_events' | 'yahoo_poll_inbox'>;

type PollLoopJobInput = Parameters<typeof enqueueChannelJob>[1] & { jobType: PollLoopJobType; integrationId: string };

/**
 * Enqueues the next run of a poll loop, unless a run is already waiting.
 *
 * X DMs and Yahoo IMAP have no push, so each poll run asks Core for the next
 * one — and nothing stopped two runs from each getting one. A worker that died
 * after enqueueing its successor but before completing its own job ran that
 * job again, and the loop forked. Each fork polled the provider and wrote job
 * rows forever, and on X they shared one DM rate limit. A fork now finds the
 * other loop's waiting run and ends there, so forks merge back into one.
 *
 * Fails open: if the check cannot be read, the run is enqueued as before.
 */
export async function enqueueNextPoll(sb: SupabaseClient, input: PollLoopJobInput): Promise<{ enqueued: boolean }> {
  const { data, error } = await sb
    .from('channel_jobs')
    .select('id')
    .eq('integration_id', input.integrationId)
    .eq('job_type', input.jobType)
    .eq('status', 'pending')
    .limit(1);
  if (!error && (data ?? []).length > 0) return { enqueued: false };
  await enqueueChannelJob(sb, input);
  return { enqueued: true };
}

/**
 * Starts a poll loop afresh for a (re)connected integration: runs still
 * waiting from an earlier connection are cancelled, then the first run is
 * seeded. A reconnect used to seed a second loop beside the old one, which
 * kept polling forever with the previous account's address or bot id in its
 * payload. An old run that is mid-flight right now finds the new seed waiting
 * when it asks for its successor (enqueueNextPoll), and ends.
 */
export async function seedPollLoop(sb: SupabaseClient, input: PollLoopJobInput): Promise<string> {
  await sb
    .from('channel_jobs')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('integration_id', input.integrationId)
    .eq('job_type', input.jobType)
    .eq('status', 'pending');
  return enqueueChannelJob(sb, input);
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

/**
 * The single writer of `channel_delivery_attempts` — the per-attempt error
 * code, latency and attempt number behind its three callers in the channels
 * worker.
 *
 * DELIVERY_DIAGNOSTICS_LOGGING is read straight from the environment here,
 * not from a ServerConfig: every caller is the channels WORKER
 * (worker/channels/index.ts), which never builds one — it reads its own env
 * the same way for CHANNELS_HEARTBEAT_MS. envFlagEnabled() keeps the parsing
 * rule identical to the config-backed flags: only the literal `off` disables.
 *
 * Nothing in the product reads this table back, and retry state lives on
 * `channel_jobs`, so suppressing it changes delivery and retry not at all —
 * only what an operator can see afterwards about a failed send.
 */
export async function recordAttempt(
  sb: SupabaseClient,
  jobId: string,
  attempt: number,
  status: 'succeeded' | 'failed' | 'retrying',
  detail: { errorCode?: string | null; errorMessage?: string | null; latencyMs?: number | null } = {},
): Promise<void> {
  if (!envFlagEnabled('DELIVERY_DIAGNOSTICS_LOGGING')) return;
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
 * Put a claimed job back on the queue WITHOUT consuming a retry.
 *
 * Used only for failures that are provably not the job's fault — Core
 * unreachable, Core rejecting the internal credential, or Core missing the
 * route entirely (stale deployment). Burning `attempt_count` on those would
 * permanently fail perfectly valid inbound messages while an operator is
 * still fixing the deployment.
 */
export async function releaseChannelJob(
  sb: SupabaseClient,
  job: ChannelJob,
  errorMessage: string,
  delaySeconds = 30,
): Promise<'released'> {
  const { error } = await sb
    .from('channel_jobs')
    .update({
      status: 'pending',
      attempt_count: Math.max(0, job.attempt_count - 1),
      available_at: new Date(Date.now() + delaySeconds * 1000).toISOString(),
      claim_token: null,
      claim_expires_at: null,
      last_error: errorMessage.slice(0, 1000),
      updated_at: new Date().toISOString(),
    })
    .eq('id', job.id)
    .eq('claim_token', job.claim_token);
  if (error) throw new Error(`channel job release failed: ${error.message}`);
  return 'released';
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
      ? Math.round((Date.now() - new Date((oldest as { created_at: string }).created_at).getTime()) / 1000)
      : null,
  };
}
