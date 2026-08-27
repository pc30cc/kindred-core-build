/**
 * CHANNELS WORKER (WORKER_KIND=channels).
 *
 * Claims `channel_jobs` with an expiring lease and executes them:
 *   inbound  → hands the raw update to Core's internal processing endpoint
 *              (Core owns every canonical write)
 *   outbound → decrypts the integration credential and calls the provider
 *
 * Crash-safe: a lost lease expires and the job is re-claimed. Every attempt is
 * recorded in `channel_delivery_attempts`, so retries are observable rather
 * than silent. Bot tokens are never logged and never placed in job payloads.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  claimChannelJobs,
  completeChannelJob,
  failChannelJob,
  recordAttempt,
  type ChannelJob,
} from '../../server/services/channels/jobs.js';
import { decryptPluginSecret } from '../../server/lib/pluginCrypto.js';
import { TelegramApiError, redactToken, sendMessage } from '../../server/services/channels/telegram/client.js';

const WORKER_ID = `channels-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const POLL_INTERVAL_MS = parseInt(process.env.CHANNELS_POLL_INTERVAL_MS || '1500', 10);
const BATCH_SIZE = parseInt(process.env.CHANNELS_BATCH_SIZE || '10', 10);
const LEASE_SECONDS = parseInt(process.env.CHANNELS_LEASE_SECONDS || '120', 10);

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`[channels-worker] missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

let sb: SupabaseClient;
let coreBaseUrl: string;
let coreSecret: string;
let masterKey: string;

async function coreCall(path: string, body: unknown): Promise<any> {
  const response = await fetch(`${coreBaseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${coreSecret}` },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`core ${path} failed [${response.status}]: ${detail}`);
  }
  return response.json();
}

/** Resolves a provider credential for an integration. Server-side only. */
async function resolveIntegrationToken(integrationId: string, secretKey: string): Promise<string> {
  const { data: integration, error } = await sb
    .from('channel_integrations')
    .select('installation_id,status')
    .eq('id', integrationId)
    .maybeSingle();
  if (error) throw new Error(`integration lookup failed: ${error.message}`);
  if (!integration) throw new Error('integration not found');
  if ((integration as any).status === 'revoked') throw new Error('integration revoked');

  const { data: secret, error: secretError } = await sb
    .from('plugin_secrets')
    .select('algorithm,nonce,ciphertext,auth_tag')
    .eq('installation_id', (integration as any).installation_id)
    .eq('secret_key', secretKey)
    .maybeSingle();
  if (secretError) throw new Error(`credential lookup failed: ${secretError.message}`);
  if (!secret) throw new Error('credential missing');

  return decryptPluginSecret(secret as any, masterKey);
}

async function handleJob(job: ChannelJob): Promise<void> {
  switch (job.job_type) {
    case 'telegram_inbound_event': {
      await coreCall('/internal/channels/process-inbound', {
        provider: 'telegram',
        integration_id: job.integration_id,
        workspace_id: job.workspace_id,
        update: (job.payload as any).update ?? {},
      });
      return;
    }

    case 'telegram_outbound_message': {
      if (!job.integration_id) throw new Error('outbound job without integration');
      const payload = job.payload as any;
      const chatId = payload.chat_id;
      const text = String(payload.text ?? '').slice(0, 4096);
      if (!chatId || !text.trim()) return; // nothing deliverable; treat as done

      const token = await resolveIntegrationToken(job.integration_id, 'telegram_bot_token');
      const sent = await sendMessage(token, { chatId, text });

      if (payload.message_id) {
        await sb
          .from('conversation_messages')
          .update({
            metadata: {
              ...(payload.metadata ?? {}),
              channel_delivery: 'sent',
              channel_message_id: sent.message_id,
            },
          })
          .eq('id', payload.message_id);
      }
      return;
    }

    default:
      // Unknown types must not spin: fail permanently on first attempt.
      throw Object.assign(new Error(`unsupported job type: ${job.job_type}`), { permanent: true });
  }
}

async function processBatch(): Promise<number> {
  const jobs = await claimChannelJobs(sb, WORKER_ID, BATCH_SIZE, LEASE_SECONDS, null);

  for (const job of jobs) {
    const startedAt = Date.now();
    try {
      await handleJob(job);
      await completeChannelJob(sb, job);
      await recordAttempt(sb, job.id, job.attempt_count, 'succeeded', { latencyMs: Date.now() - startedAt });
    } catch (err) {
      const message = redactToken(err instanceof Error ? err.message : String(err));
      const telegramError = err instanceof TelegramApiError ? err : null;
      const permanent =
        (err as any)?.permanent === true || (telegramError ? !telegramError.retryable : false);

      const outcome = permanent
        ? await failChannelJob(
            sb,
            { ...job, attempt_count: job.max_attempts },
            message,
            null,
          )
        : await failChannelJob(sb, job, message, telegramError?.retryAfterSeconds ?? null);

      await recordAttempt(sb, job.id, job.attempt_count, outcome === 'failed' ? 'failed' : 'retrying', {
        errorCode: telegramError ? String(telegramError.httpStatus) : null,
        errorMessage: message,
        latencyMs: Date.now() - startedAt,
      });
      console.error(`[channels-worker] job ${job.id} (${job.job_type}) ${outcome}: ${message}`);
    }
  }

  return jobs.length;
}

export function startChannelsWorker(): void {
  const supabaseUrl = requireEnv('SUPABASE_URL');
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  coreBaseUrl = requireEnv('CORE_INTERNAL_BASE_URL').replace(/\/+$/, '');
  coreSecret = requireEnv('CORE_INTERNAL_SECRET');
  masterKey = requireEnv('PLUGIN_SECRETS_MASTER_KEY');

  sb = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

  console.log('[channels-worker] started', { workerId: WORKER_ID, batch: BATCH_SIZE });

  let stopping = false;
  const loop = async () => {
    while (!stopping) {
      let processed = 0;
      try {
        processed = await processBatch();
      } catch (err) {
        console.error('[channels-worker] poll failed:', redactToken(String((err as Error).message)));
      }
      // Back off only when idle so bursts drain quickly.
      await new Promise((resolve) => setTimeout(resolve, processed > 0 ? 50 : POLL_INTERVAL_MS));
    }
  };

  const shutdown = () => {
    stopping = true;
    console.log('[channels-worker] shutting down');
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  void loop();
}
