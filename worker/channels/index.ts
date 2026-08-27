/**
 * CHANNELS WORKER (WORKER_KIND=channels).
 *
 * Claims `channel_jobs` with an expiring lease and executes them:
 *   inbound  → hands the raw update to Core's internal processing endpoint
 *   outbound → decrypts the integration credential, calls the provider, then
 *              reports the outcome BACK TO CORE
 *
 * LOCKED BOUNDARY — the worker MUST NOT write canonical business tables
 * (contacts, conversations, conversation_messages, inbox/AI state). Core owns
 * every canonical write; the worker only touches dedicated channel runtime
 * tables (channel_jobs, channel_delivery_attempts, channel_worker_heartbeats)
 * plus read-only credential resolution.
 *
 * Crash-safe: a lost lease expires and the job is re-claimed. Every attempt is
 * recorded in `channel_delivery_attempts`. Bot tokens are never logged and
 * never placed in job payloads.
 */

import { createHash } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  claimChannelJobs,
  completeChannelJob,
  failChannelJob,
  releaseChannelJob,

  isChannelJobType,
  recordAttempt,
  type ChannelJob,
} from '../../server/services/channels/jobs.js';
import { decryptPluginSecret } from '../../server/lib/pluginCrypto.js';
import {
  TelegramApiError,
  redactToken,
  sendChatAction,
  sendMedia,
  sendMessage,
} from '../../server/services/channels/telegram/client.js';


const WORKER_ID = `channels-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const POLL_INTERVAL_MS = parseInt(process.env.CHANNELS_POLL_INTERVAL_MS || '1500', 10);
const BATCH_SIZE = parseInt(process.env.CHANNELS_BATCH_SIZE || '10', 10);
const LEASE_SECONDS = parseInt(process.env.CHANNELS_LEASE_SECONDS || '120', 10);
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.CHANNELS_HEARTBEAT_MS || '15000', 10);
const CORE_AUTH_RECHECK_MS = parseInt(process.env.CHANNELS_CORE_AUTH_RECHECK_MS || '15000', 10);
const CODE_VERSION = process.env.APP_VERSION || process.env.GIT_SHA || null;

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
let coreAuthReady = false;
let lastCoreAuthCheckAt = 0;

/** Non-reversible fingerprint — mirrors server/lib/internalAuth.ts exactly. */
function secretFingerprint(secret: string): string {
  return createHash('sha256').update(`core-internal-secret:${secret}`).digest('hex').slice(0, 12);
}

/**
 * Credential headers for every Core call.
 *
 * The SAME value is sent twice on purpose: reverse proxies in front of Core
 * (Traefik/Coolify and friends) frequently consume or rewrite `Authorization`,
 * which made a perfectly matching secret look like a mismatch. The dedicated
 * header survives those hops.
 */
function coreAuthHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${coreSecret}`,
    'X-Core-Internal-Secret': coreSecret,
  };
}

/**
 * Ask Core's unauthenticated diagnostic endpoint WHY authentication failed,
 * so the operator is told the actual cause instead of a guess.
 */
async function explainAuthFailure(reason: string | null): Promise<string> {
  if (reason === 'not_configured') {
    return 'Core has no CORE_INTERNAL_SECRET configured — set it on the Core service and redeploy it';
  }

  try {
    const url = `${coreBaseUrl}/internal/channels/auth-diagnostic?fingerprint=${secretFingerprint(coreSecret)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      return `Core rejected the internal credential (diagnostic unavailable, HTTP ${response.status})`;
    }
    const info = (await response.json()) as {
      configured?: boolean;
      saw_authorization_header?: boolean;
      saw_internal_secret_header?: boolean;
      fingerprint_matches?: boolean | null;
    };

    if (info.configured === false) {
      return 'Core has no CORE_INTERNAL_SECRET configured — set it on the Core service and redeploy it';
    }
    if (info.fingerprint_matches === true) {
      // Values are identical, so the credential is being lost in transit.
      return info.saw_authorization_header === false && info.saw_internal_secret_header === false
        ? 'CORE_INTERNAL_SECRET matches Core, but the proxy in front of Core strips BOTH credential headers — allow Authorization and X-Core-Internal-Secret through, or point CORE_INTERNAL_BASE_URL at Core directly'
        : 'CORE_INTERNAL_SECRET matches Core, but the request is still rejected — check that CORE_INTERNAL_BASE_URL points at Core itself and not another service';
    }
    if (info.fingerprint_matches === false) {
      return 'CORE_INTERNAL_SECRET differs from the value configured on Core — copy Core\'s exact value into the Worker and redeploy';
    }
    return 'Core rejected the internal credential and returned no fingerprint verdict';
  } catch {
    return 'Core rejected the internal credential and its diagnostic endpoint is unreachable';
  }
}

/**
 * Validate the Worker → Core trust boundary before claiming queue jobs.
 * This prevents a mismatched deployment secret from exhausting retries and
 * permanently failing otherwise healthy inbound messages.
 */
async function ensureCoreAuthReady(): Promise<boolean> {
  const now = Date.now();
  if (coreAuthReady && now - lastCoreAuthCheckAt < CORE_AUTH_RECHECK_MS) return true;
  if (!coreAuthReady && now - lastCoreAuthCheckAt < CORE_AUTH_RECHECK_MS) return false;
  lastCoreAuthCheckAt = now;

  try {
    const response = await fetch(`${coreBaseUrl}/internal/channels/ready`, {
      headers: coreAuthHeaders(),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      coreAuthReady = false;
      let reason: string;
      if (response.status === 401 || response.status === 503) {
        const body = (await response.json().catch(() => ({}))) as { reason?: string };
        reason = await explainAuthFailure(body?.reason ?? null);
      } else if (response.status === 404) {
        reason = `Core at ${coreBaseUrl} has no /internal/channels/ready route — it is a stale deployment or not Core (${await describeCore()})`;
      } else {
        reason = `Core readiness returned HTTP ${response.status}`;
      }
      console.error(`[channels-worker] paused before claiming jobs: ${reason}`);
      return false;
    }
    const info = (await response.json().catch(() => ({}))) as {
      service?: string;
      build?: string | null;
      routes?: string[];
    };
    const routes = Array.isArray(info.routes) ? info.routes : [];
    const requiredRoutes = [
      'POST /process-inbound',
      'POST /outbound-result',
      'POST /heartbeat',
      'POST /profile-sync',
      'POST /webhook-repair',
    ];
    const missingRoutes = requiredRoutes.filter((route) => !routes.includes(route));

    // Authentication alone is not readiness. An older Core can expose
    // /ready while lacking the handlers this worker needs. Fail closed before
    // claiming anything so valid jobs never consume retries against a stale
    // or incorrectly routed Core deployment.
    if (info.service !== 'core-internal-channels' || missingRoutes.length > 0) {
      coreAuthReady = false;
      const reason = info.service !== 'core-internal-channels'
        ? `CORE_INTERNAL_BASE_URL does not point at the Channels Core service (service=${info.service ?? 'unknown'})`
        : routes.length === 0
          ? 'Core readiness response has no route contract; redeploy Core with the current build'
          : `Core is missing required routes: ${missingRoutes.join(', ')}; redeploy Core with the current build`;
      console.error(`[channels-worker] paused before claiming jobs: ${reason} (build=${info.build ?? 'unknown'})`);
      return false;
    }

    if (!coreAuthReady) {
      console.log(
        `[channels-worker] Core authentication and route contract verified; queue processing enabled (build=${info.build ?? 'unknown'})`,
      );
    }
    coreAuthReady = true;
    return true;

  } catch {
    coreAuthReady = false;
    console.error('[channels-worker] paused before claiming jobs: Core is unreachable');
    return false;
  }
}

/**
 * Marks failures that are the DEPLOYMENT's fault, not the job's: Core missing
 * the route (stale build / wrong service) or rejecting the credential. These
 * must never consume a job's retry budget.
 */
type InfrastructureError = Error & { infrastructure: true };

function isInfrastructureError(err: unknown): err is InfrastructureError {
  return !!err && (err as any).infrastructure === true;
}

/** Asks Core which build answered and which internal routes it serves. */
async function describeCore(): Promise<string> {
  try {
    const response = await fetch(`${coreBaseUrl}/internal/channels/auth-diagnostic`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return `diagnostic HTTP ${response.status}`;
    const info = (await response.json()) as { service?: string; build?: string | null; routes?: string[] };
    if (info?.service !== 'core-internal-channels') {
      return 'the URL does not point at Core — another service answered';
    }
    return `Core build=${info.build ?? 'unknown'} serves ${Array.isArray(info.routes) ? info.routes.length : 0} internal routes`;
  } catch {
    return 'diagnostic endpoint unreachable';
  }
}

async function coreCall(path: string, body: unknown): Promise<any> {
  const response = await fetch(`${coreBaseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...coreAuthHeaders() },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);

    // 404 on a route this worker knows exists in the codebase means the Core
    // it is talking to is an OLDER deployment (or not Core at all). 401/503
    // mean the trust boundary broke mid-flight. Both are deployment problems.
    if (response.status === 404 || response.status === 401 || response.status === 503) {
      coreAuthReady = false;
      const explanation =
        response.status === 404
          ? `Core at ${coreBaseUrl} does not expose ${path} — redeploy Core with the current build, or point CORE_INTERNAL_BASE_URL at the Core service (${await describeCore()})`
          : `Core rejected the internal credential on ${path} (HTTP ${response.status})`;
      throw Object.assign(new Error(explanation), { infrastructure: true } as const);
    }

    throw new Error(`core ${path} failed [${response.status}]: ${detail}`);
  }
  return response.json();
}



/** Resolves a provider credential for an integration. Read-only, server-side. */
async function resolveIntegrationToken(integrationId: string, secretKey: string): Promise<string> {
  const { data: integration, error } = await sb
    .from('channel_integrations')
    .select('installation_id,status')
    .eq('id', integrationId)
    .maybeSingle();
  if (error) throw new Error(`integration lookup failed: ${error.message}`);
  if (!integration) throw Object.assign(new Error('integration not found'), { permanent: true });
  if ((integration as any).status === 'disconnected') {
    throw Object.assign(new Error('integration disconnected'), { permanent: true });
  }

  const { data: secret, error: secretError } = await sb
    .from('plugin_secrets')
    .select('algorithm,nonce,ciphertext,auth_tag')
    .eq('installation_id', (integration as any).installation_id)
    .eq('secret_key', secretKey)
    .maybeSingle();
  if (secretError) throw new Error(`credential lookup failed: ${secretError.message}`);
  if (!secret) throw Object.assign(new Error('credential missing'), { permanent: true });

  return decryptPluginSecret(secret as any, masterKey);
}

/** Reports a delivery outcome to Core, which owns the canonical message row. */
async function reportOutbound(
  job: ChannelJob,
  messageId: string | null,
  outcome: 'sent' | 'failed',
  externalMessageId: number | string | null,
  errorCode: string | null,
): Promise<void> {
  if (!messageId || !job.integration_id) return;
  await coreCall('/internal/channels/outbound-result', {
    provider: 'telegram',
    integration_id: job.integration_id,
    workspace_id: job.workspace_id,
    message_id: messageId,
    outcome,
    external_message_id: externalMessageId,
    error_code: errorCode,
  });
}

async function handleJob(job: ChannelJob): Promise<void> {
  const payload = (job.payload ?? {}) as any;

  switch (job.job_type) {
    // ── Inbound ───────────────────────────────────────────────────────
    case 'telegram_inbound_event':
    case 'telegram_inbound_media': {
      // Media arrives inside the same update envelope; Core normalizes both
      // and owns attachment persistence, so the worker only forwards.
      await coreCall('/internal/channels/process-inbound', {
        provider: 'telegram',
        integration_id: job.integration_id,
        workspace_id: job.workspace_id,
        update: payload.update ?? {},
      });
      return;
    }

    // ── Outbound text ─────────────────────────────────────────────────
    case 'telegram_outbound_message': {
      if (!job.integration_id) throw Object.assign(new Error('outbound job without integration'), { permanent: true });
      const chatId = payload.chat_id;
      const text = String(payload.text ?? '').slice(0, 4096);
      const messageId: string | null = payload.message_id ?? null;
      if (!chatId || !text.trim()) return; // nothing deliverable

      const token = await resolveIntegrationToken(job.integration_id, 'telegram_bot_token');
      // Native "typing…" bubble right before the reply lands. Best-effort:
      // a failure here must never block or retry the actual delivery.
      await sendChatAction(token, chatId, 'typing').catch(() => undefined);
      try {
        const sent = await sendMessage(token, { chatId, text });

        await reportOutbound(job, messageId, 'sent', sent.message_id, null);
      } catch (err) {
        if (err instanceof TelegramApiError && !err.retryable) {
          await reportOutbound(job, messageId, 'failed', null, `telegram_${err.httpStatus}`);
        }
        throw err;
      }
      return;
    }

    // ── Outbound media ────────────────────────────────────────────────
    case 'telegram_outbound_media': {
      if (!job.integration_id) throw Object.assign(new Error('outbound job without integration'), { permanent: true });
      const chatId = payload.chat_id;
      const messageId: string | null = payload.message_id ?? null;
      const attachments: any[] = Array.isArray(payload.attachments) ? payload.attachments : [];
      if (!chatId || attachments.length === 0) return;

      const token = await resolveIntegrationToken(job.integration_id, 'telegram_bot_token');
      try {
        let last: { message_id: number } | null = null;
        for (const [index, attachment] of attachments.entries()) {
          const url = String(attachment?.url ?? attachment?.public_url ?? '');
          if (!/^https:\/\//i.test(url)) continue; // never send an unsafe URL
          last = await sendMedia(token, {
            chatId,
            kind: String(attachment?.kind ?? 'document'),
            url,
            caption: index === 0 ? String(payload.text ?? '') || null : null,
          });
        }
        await reportOutbound(job, messageId, 'sent', last?.message_id ?? null, null);
      } catch (err) {
        if (err instanceof TelegramApiError && !err.retryable) {
          await reportOutbound(job, messageId, 'failed', null, `telegram_${err.httpStatus}`);
        }
        throw err;
      }
      return;
    }

    // ── Maintenance jobs (Core performs the privileged work) ──────────
    case 'telegram_profile_sync': {
      await coreCall('/internal/channels/profile-sync', {
        provider: 'telegram',
        integration_id: job.integration_id,
        workspace_id: job.workspace_id,
        profile: payload.profile ?? {},
      });
      return;
    }

    case 'telegram_webhook_repair': {
      await coreCall('/internal/channels/webhook-repair', {
        provider: 'telegram',
        integration_id: job.integration_id,
        workspace_id: job.workspace_id,
      });
      return;
    }

    default: {
      // Never silently drop an APPROVED job type; only truly unknown types
      // fail permanently on the first attempt.
      const jobType = job.job_type as string;
      throw Object.assign(
        new Error(
          isChannelJobType(jobType)
            ? `approved job type has no handler: ${jobType}`
            : `unsupported job type: ${jobType}`,
        ),
        { permanent: true },
      );
    }
  }
}

async function processBatch(): Promise<number> {
  if (!(await ensureCoreAuthReady())) return 0;
  const jobs = await claimChannelJobs(sb, WORKER_ID, BATCH_SIZE, LEASE_SECONDS, null);

  for (const job of jobs) {
    const startedAt = Date.now();
    try {
      await handleJob(job);
      await completeChannelJob(sb, job);
      await recordAttempt(sb, job.id, job.attempt_count, 'succeeded', { latencyMs: Date.now() - startedAt });
    } catch (err) {
      const message = redactToken(err instanceof Error ? err.message : String(err));

      // Deployment-level failure: requeue without spending a retry and stop
      // draining the batch, so a stale Core cannot destroy the whole queue.
      if (isInfrastructureError(err)) {
        await releaseChannelJob(sb, job, message);
        await recordAttempt(sb, job.id, job.attempt_count, 'retrying', {
          errorMessage: message,
          latencyMs: Date.now() - startedAt,
        });
        console.error(`[channels-worker] job ${job.id} (${job.job_type}) requeued without penalty: ${message}`);
        break;
      }

      const telegramError = err instanceof TelegramApiError ? err : null;
      const permanent =
        (err as any)?.permanent === true || (telegramError ? !telegramError.retryable : false);

      const outcome = permanent
        ? await failChannelJob(sb, { ...job, attempt_count: job.max_attempts }, message, null)
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

/** Liveness for the Super Admin runtime health panel. */
async function writeHeartbeat(): Promise<void> {
  const { error } = await sb.from('channel_worker_heartbeats').upsert(
    {
      worker_id: WORKER_ID,
      worker_kind: 'channels',
      last_seen_at: new Date().toISOString(),
      code_version: CODE_VERSION,
      metadata: { batch: BATCH_SIZE, poll_ms: POLL_INTERVAL_MS },
    },
    { onConflict: 'worker_id' },
  );
  if (error) console.warn('[channels-worker] heartbeat failed:', error.message);
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

  void writeHeartbeat();
  const heartbeat = setInterval(() => {
    if (!stopping) void writeHeartbeat();
  }, Math.max(HEARTBEAT_INTERVAL_MS, 5000));

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
    clearInterval(heartbeat);
    console.log('[channels-worker] shutting down');
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  void loop();
}
