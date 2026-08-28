/**
 * Core ↔ Channels internal API.
 *
 * Callers: the Channels Gateway (ingest) and the Channels Worker (process,
 * credential-free job context, delivery-result callbacks). Never reachable
 * from a browser: every route requires the shared `CORE_INTERNAL_SECRET` and
 * the router is mounted outside the public /api CORS surface.
 *
 * CORE OWNS EVERY CANONICAL WRITE. The worker calls these endpoints instead
 * of touching contacts / conversations / conversation_messages itself.
 */

import { Router, raw } from 'express';
import { z } from 'zod';
import {
  INTERNAL_SECRET_HEADER,
  internalSecretFingerprint,
  requireInternalService,
} from '../lib/internalAuth.js';
import { serverConfigOf } from '../lib/workspaceAuth.js';
import { getServiceClient } from '../supabase.js';
import {
  getIntegrationById,
  getIntegrationByPublicId,
  updateIntegration,
} from '../services/channels/integrations.js';
import {
  applyConnectFailure,
  applyConnectSuccess,
  applyDiagnosticsResult,
  applyDisconnectResult,
  applyProfileSyncResult,
  applyWebhookRepairResult,
  connectPreflight,
  providerWebhookContract,
  TelegramConnectError,
} from '../services/channels/telegram/setup.js';
import {
  CORE_INTERNAL_SERVICE_NAME,
  INTERNAL_CHANNEL_ROUTES,
} from '../../shared/channels/internalRoutes.js';
import {
  completeOperation,
  getOperation,
  markOperationRunning,
  type ProviderOperation,
} from '../services/channels/operations.js';
import {
  persistContactAvatar,
  persistInboundAttachment,
  recordMediaOutcomes,
} from '../services/channels/telegram/mediaIngest.js';
import { markAvatarChecked } from '../services/channels/telegram/avatarSync.js';
import { enqueueChannelJob, queueMetrics } from '../services/channels/jobs.js';
import { processInboundMessage } from '../services/channels/inboundProcessing.js';
import { normalizeTelegramUpdate } from '../services/channels/telegram/normalize.js';
import { handleTelegramCallbackQuery } from '../services/channels/telegram/runtime.js';

export const internalChannelsRouter = Router();

/**
 * GET /auth-diagnostic — deliberately UNAUTHENTICATED, mounted before the
 * guard below.
 *
 * When the Gateway or Worker cannot authenticate, the 401 alone cannot tell
 * an operator whether the secret differs or a reverse proxy swallowed the
 * credential. This endpoint answers exactly that, and nothing else:
 *   - whether Core has a secret configured at all,
 *   - which credential headers actually survived the proxy hop,
 *   - whether the caller's NON-REVERSIBLE fingerprint matches Core's.
 *
 * No secret, and no part of one, is ever returned: the caller sends a
 * truncated salted SHA-256 and receives a boolean.
 */
internalChannelsRouter.get('/auth-diagnostic', (req: any, res) => {
  const expected = serverConfigOf(req)?.coreInternalSecret;
  const presentedFingerprint =
    typeof req.query?.fingerprint === 'string' ? req.query.fingerprint.trim() : '';

  res.json({
    configured: !!expected,
    saw_authorization_header: typeof req.headers?.authorization === 'string',
    saw_internal_secret_header: typeof req.headers?.[INTERNAL_SECRET_HEADER] === 'string',
    fingerprint_matches: expected && presentedFingerprint
      ? internalSecretFingerprint(expected) === presentedFingerprint
      : null,
    // Proves which Core build answered, so a 404 on an existing route can be
    // attributed to a stale deployment rather than a code defect.
    service: CORE_INTERNAL_SERVICE_NAME,
    build: CORE_BUILD,
    routes: INTERNAL_CHANNEL_ROUTES,
  });

});

internalChannelsRouter.use((req, res, next) => {
  if (!requireInternalService(req, res)) return;
  next();
});


/**
 * POST /ingest — durable capture of a verified provider webhook.
 *
 * The Gateway has already verified the webhook secret; it has NO database
 * access, so Core resolves the integration, persists the raw envelope and
 * enqueues a job. Returns quickly so the provider is not kept waiting.
 */
const ingestSchema = z.object({
  provider: z.literal('telegram'),
  public_integration_id: z.string().min(10).max(128),
  update: z.record(z.unknown()),
  received_at: z.string().optional(),
});

internalChannelsRouter.post('/ingest', async (req: any, res) => {
  const parsed = ingestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_payload' });

  try {
    const config = serverConfigOf(req);
    const integration = await getIntegrationByPublicId(config, parsed.data.public_integration_id);
    if (!integration) return res.status(404).json({ error: 'unknown_integration' });
    if (integration.status === 'disconnected') return res.status(410).json({ error: 'integration_disconnected' });

    const sb = getServiceClient(config);
    await enqueueChannelJob(sb, {
      provider: 'telegram',
      jobType: 'telegram_inbound_event',
      workspaceId: integration.workspace_id,
      integrationId: integration.id,
      payload: {
        update: parsed.data.update,
        received_at: parsed.data.received_at ?? new Date().toISOString(),
      },
    });

    await updateIntegration(config, integration.id, { last_inbound_at: new Date().toISOString() });

    res.status(202).json({ status: 'queued' });
  } catch (err) {
    console.error('[internal-channels] ingest failed:', err);
    res.status(500).json({ error: 'ingest_failed' });
  }
});

/**
 * POST /process-inbound — the Worker asks Core to turn a queued provider
 * update into canonical business data. Core owns all writes.
 */
const processSchema = z.object({
  provider: z.literal('telegram'),
  integration_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  update: z.record(z.unknown()),
});

internalChannelsRouter.post('/process-inbound', async (req: any, res) => {
  const parsed = processSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_payload' });

  try {
    const config = serverConfigOf(req);

    // Inline menu taps never become conversation messages: they are UI
    // navigation, handled and acknowledged here.
    if (parsed.data.update?.callback_query) {
      await handleTelegramCallbackQuery(config, {
        workspaceId: parsed.data.workspace_id,
        update: parsed.data.update as Record<string, any>,
      });
      return res.json({ status: 'menu_handled' });
    }

    const normalized = normalizeTelegramUpdate(parsed.data.update, {
      workspaceId: parsed.data.workspace_id,
      integrationId: parsed.data.integration_id,
    });
    if (!normalized) return res.json({ status: 'ignored' });

    const result = await processInboundMessage(config, normalized);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    console.error('[internal-channels] process failed:', message);
    res.status(500).json({ error: 'processing_failed', details: message });
  }
});

/**
 * POST /outbound-result — the ONLY way a delivery outcome reaches canonical
 * data. The Worker never updates conversation_messages itself.
 */
const outboundResultSchema = z.object({
  provider: z.literal('telegram'),
  integration_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  message_id: z.string().uuid(),
  outcome: z.enum(['sent', 'failed']),
  external_message_id: z.union([z.string(), z.number()]).nullable().optional(),
  error_code: z.string().max(120).nullable().optional(),
});

internalChannelsRouter.post('/outbound-result', async (req: any, res) => {
  const parsed = outboundResultSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_payload' });
  const data = parsed.data;

  try {
    const config = serverConfigOf(req);
    const sb = getServiceClient(config);

    const { data: existing, error: readError } = await sb
      .from('conversation_messages')
      .select('id, metadata')
      .eq('id', data.message_id)
      .maybeSingle();
    if (readError) throw new Error(readError.message);
    if (!existing) return res.status(404).json({ error: 'unknown_message' });

    const metadata = { ...(((existing as any).metadata ?? {}) as Record<string, unknown>) };
    metadata.channel_delivery = data.outcome;
    metadata.channel_delivery_at = new Date().toISOString();
    if (data.external_message_id != null) metadata.channel_message_id = String(data.external_message_id);
    if (data.error_code) metadata.channel_delivery_error = data.error_code.slice(0, 120);
    else delete metadata.channel_delivery_error;

    const { error: writeError } = await sb
      .from('conversation_messages')
      .update({ metadata })
      .eq('id', data.message_id);
    if (writeError) throw new Error(writeError.message);

    if (data.outcome === 'sent') {
      await updateIntegration(config, data.integration_id, {
        last_outbound_at: new Date().toISOString(),
      });
    } else if (data.error_code) {
      await updateIntegration(config, data.integration_id, {
        last_error_code: data.error_code.slice(0, 120),
        last_error_at: new Date().toISOString(),
      });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[internal-channels] outbound-result failed:', err);
    res.status(500).json({ error: 'outbound_result_failed' });
  }
});

/**
 * POST /heartbeat — WORKER_KIND=channels liveness, consumed by the Super
 * Admin runtime health panel.
 */
const heartbeatSchema = z.object({
  worker_id: z.string().min(3).max(120),
  worker_kind: z.string().min(3).max(40),
  code_version: z.string().max(80).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

internalChannelsRouter.post('/heartbeat', async (req: any, res) => {
  const parsed = heartbeatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_payload' });

  try {
    const sb = getServiceClient(serverConfigOf(req));
    const { error } = await sb.from('channel_worker_heartbeats').upsert(
      {
        worker_id: parsed.data.worker_id,
        worker_kind: parsed.data.worker_kind,
        last_seen_at: new Date().toISOString(),
        code_version: parsed.data.code_version ?? null,
        metadata: parsed.data.metadata ?? {},
      },
      { onConflict: 'worker_id' },
    );
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (err) {
    console.error('[internal-channels] heartbeat failed:', err);
    res.status(500).json({ error: 'heartbeat_failed' });
  }
});

/** GET /health — queue depth + lag for the Super Admin runtime panel. */
internalChannelsRouter.get('/health', async (req: any, res) => {
  try {
    const metrics = await queueMetrics(getServiceClient(serverConfigOf(req)));
    res.json({ ok: true, queue: metrics });
  } catch (err) {
    console.error('[internal-channels] health failed:', err);
    res.status(500).json({ ok: false });
  }
});

/**
 * The contract this Core build actually serves. Exposed on the diagnostic and
 * readiness endpoints so a caller that gets a 404 can PROVE whether it is
 * talking to a stale Core deployment (or an entirely different service)
 * instead of guessing. No secrets, no data — just handler names.
 */
export { INTERNAL_CHANNEL_ROUTES };


const CORE_BUILD =
  process.env.APP_VERSION || process.env.GIT_SHA || process.env.SOURCE_COMMIT || null;

/** GET /ready — used by the Gateway's readiness probe. No secrets. */
internalChannelsRouter.get('/ready', (_req, res) => {
  res.json({
    ok: true,
    service: CORE_INTERNAL_SERVICE_NAME,
    build: CORE_BUILD,
    routes: INTERNAL_CHANNEL_ROUTES,
  });
});


/**
 * ── PROVIDER OPERATION BOUNDARY ──────────────────────────────────────
 *
 * Core never opens a socket to a provider. The Worker fetches the operation
 * it claimed, executes the provider calls, and reports FACTS back here; Core
 * applies every canonical write.
 */

/** GET /operations/:id — the operation record for a claimed job. No secrets. */
internalChannelsRouter.get('/operations/:id', async (req: any, res) => {
  try {
    const operation = await getOperation(serverConfigOf(req), String(req.params.id));
    if (!operation) return res.status(404).json({ error: 'unknown_operation' });
    await markOperationRunning(serverConfigOf(req), operation.id);
    res.json({ operation });
  } catch (err) {
    console.error('[internal-channels] operation read failed:', err);
    res.status(500).json({ error: 'operation_read_failed' });
  }
});

/**
 * POST /connect-preflight — ownership is decided by the DATABASE, before the
 * Worker mutates anything on the provider. Returns the ingress URL and the
 * derived webhook secret for this integration (never the bot credential).
 */
const preflightSchema = z.object({
  operation_id: z.string().uuid(),
  bot_id: z.union([z.string(), z.number()]),
});

internalChannelsRouter.post('/connect-preflight', async (req: any, res) => {
  const parsed = preflightSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_payload' });

  try {
    const result = await connectPreflight(serverConfigOf(req), {
      operationId: parsed.data.operation_id,
      botId: String(parsed.data.bot_id),
    });
    res.json({ webhook_url: result.webhookUrl, secret_token: result.secretToken, has_previous_token: result.hasPreviousToken });
  } catch (err) {
    if (err instanceof TelegramConnectError) {
      const conflict = err.code === 'duplicate_bot' || err.code === 'different_bot_requires_disconnect';
      return res.status(conflict ? 409 : 400).json({ error: err.code, details: err.message });
    }
    console.error('[internal-channels] preflight failed:', err);
    res.status(500).json({ error: 'preflight_failed' });
  }
});

/**
 * POST /webhook-contract — ingress contract for an ALREADY-OWNED bot.
 *
 * Webhook repair / reconnect must not re-run the connect preflight: ownership
 * is settled, there is no staged credential, and re-claiming the account
 * would corrupt a healthy reservation. This returns only the ingress URL and
 * the derived webhook secret — never the bot credential.
 */
const webhookContractSchema = z.object({ operation_id: z.string().uuid() });

internalChannelsRouter.post('/webhook-contract', async (req: any, res) => {
  const parsed = webhookContractSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_payload' });

  try {
    const contract = await providerWebhookContract(serverConfigOf(req), {
      operationId: parsed.data.operation_id,
    });
    res.json({
      webhook_url: contract.webhookUrl,
      secret_token: contract.secretToken,
      integration_id: contract.integrationId,
    });
  } catch (err) {
    if (err instanceof TelegramConnectError) {
      return res.status(err.code === 'unknown_operation' ? 404 : 400).json({ error: err.code, details: err.message });
    }
    console.error('[internal-channels] webhook contract failed:', err);
    res.status(500).json({ error: 'webhook_contract_failed' });
  }
});


/**
 * POST /operation-result — the ONLY way a provider outcome becomes canonical
 * data. The response may carry a `rollback` instruction the Worker must
 * execute on the provider (Core cannot).
 */
const operationResultSchema = z.object({
  operation_id: z.string().uuid(),
  status: z.enum(['succeeded', 'failed']),
  error_code: z.string().max(120).optional(),
  error_message: z.string().max(1000).optional(),
  result: z.record(z.unknown()).optional(),
});

internalChannelsRouter.post('/operation-result', async (req: any, res) => {
  const parsed = operationResultSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_payload' });

  try {
    const config = serverConfigOf(req);
    const operation = await getOperation(config, parsed.data.operation_id);
    if (!operation) return res.status(404).json({ error: 'unknown_operation' });
    if (operation.status === 'succeeded' || operation.status === 'failed') {
      // Duplicate report after a lease expiry — never rewrite history.
      return res.json({ ok: true, duplicate: true });
    }

    const payload = (parsed.data.result ?? {}) as any;

    if (parsed.data.status === 'failed') {
      await applyOperationFailure(config, operation, {
        errorCode: parsed.data.error_code || 'provider_operation_failed',
        errorMessage: parsed.data.error_message,
      });
      return res.json({ ok: true });
    }

    switch (operation.operation) {
      case 'connect': {
        const outcome = await applyConnectSuccess(config, operation, {
          botId: Number(payload.bot_id),
          username: payload.username ?? null,
          firstName: payload.first_name ?? null,
          webhookUrl: String(payload.webhook_url ?? ''),
        });
        if (outcome.ok === true) return res.json({ ok: true });
        return res.json({ ok: false, rollback: true, error: (outcome as { errorCode: string }).errorCode });
      }
      case 'disconnect': {
        await applyDisconnectResult(config, operation, {
          webhookRemoved: payload.webhook_removed === true,
          errorCode: payload.error_code ?? null,
          errorMessage: payload.error_message ?? null,
        });
        return res.json({ ok: true });
      }
      case 'webhook_repair': {
        await applyWebhookRepairResult(config, operation, {
          repaired: payload.repaired === true,
          webhookUrl: payload.webhook_url ?? null,
          errorCode: payload.error_code ?? null,
          errorMessage: payload.error_message ?? null,
        });
        return res.json({ ok: true });
      }
      case 'diagnostics': {
        await applyDiagnosticsResult(config, operation, {
          webhookUrl: payload.webhook_url ?? null,
          pendingUpdateCount: Number(payload.pending_update_count ?? 0),
          lastErrorMessage: payload.last_error_message ?? null,
          lastErrorAt: payload.last_error_at ?? null,
        });
        return res.json({ ok: true });
      }
      case 'profile_sync': {
        await applyProfileSyncResult(config, operation, {
          applied: Array.isArray(payload.applied) ? payload.applied.map(String) : [],
          name: payload.name ?? null,
        });
        return res.json({ ok: true });
      }
      case 'media_fetch': {
        const messageId = String((operation.request as any)?.message_id ?? '');
        if (messageId && Array.isArray(payload.outcomes)) {
          await recordMediaOutcomes(config, messageId, payload.outcomes);
        }
        await completeOperation(config, operation.id, { status: 'succeeded', result: {} });
        return res.json({ ok: true });
      }
      case 'avatar_fetch': {
        const contactId = String((operation.request as any)?.contact_id ?? '');
        if (contactId && payload.no_photo === true) await markAvatarChecked(config, contactId);
        await completeOperation(config, operation.id, { status: 'succeeded', result: {} });
        return res.json({ ok: true });
      }
      default: {
        await completeOperation(config, operation.id, { status: 'succeeded', result: payload });
        return res.json({ ok: true });
      }
    }
  } catch (err) {
    console.error('[internal-channels] operation-result failed:', err);
    res.status(500).json({ error: 'operation_result_failed' });
  }
});

/** Applies a provider failure to canonical state, per operation kind. */
async function applyOperationFailure(
  config: any,
  operation: ProviderOperation,
  failure: { errorCode: string; errorMessage?: string },
): Promise<void> {
  switch (operation.operation) {
    case 'connect':
      await applyConnectFailure(config, operation, failure);
      return;
    case 'disconnect':
      // The credential must not outlive a disconnect even if the provider
      // webhook could not be removed — report it honestly instead.
      await applyDisconnectResult(config, operation, {
        webhookRemoved: false,
        errorCode: failure.errorCode,
        errorMessage: failure.errorMessage ?? null,
      });
      return;
    case 'webhook_repair':
      await applyWebhookRepairResult(config, operation, {
        repaired: false,
        errorCode: failure.errorCode,
        errorMessage: failure.errorMessage ?? null,
      });
      return;
    default:
      await completeOperation(config, operation.id, {
        status: 'failed',
        errorCode: failure.errorCode,
        errorMessage: failure.errorMessage,
      });
  }
}

/**
 * POST /media-ingest — raw provider bytes crossing the network boundary.
 *
 * The Worker downloaded the file (Core cannot); Core validates size/mime,
 * enforces the storage entitlement and persists it. Metadata travels in the
 * query string so the body stays a pure binary stream.
 */
internalChannelsRouter.post(
  '/media-ingest',
  raw({ type: '*/*', limit: '30mb' }),
  async (req: any, res) => {
    try {
      const config = serverConfigOf(req);
      const operationId = String(req.query.operation_id || '');
      const operation = operationId ? await getOperation(config, operationId) : null;
      if (!operation) return res.status(404).json({ error: 'unknown_operation' });

      const bytes = Buffer.isBuffer(req.body) ? (req.body as Buffer) : Buffer.alloc(0);
      if (!bytes.byteLength) return res.status(400).json({ error: 'empty_body' });

      if (String(req.query.kind || '') === 'avatar') {
        const contactId = String((operation.request as any)?.contact_id ?? '');
        if (!contactId) return res.status(400).json({ error: 'unknown_contact' });
        await persistContactAvatar(config, {
          workspaceId: operation.workspace_id,
          contactId,
          fileKeyHint: String(req.query.file_key_hint || 'photo').replace(/[^\w.\-]+/g, '_').slice(0, 120),
          bytes,
        });
        return res.json({ ok: true });
      }

      const request = (operation.request ?? {}) as any;
      const outcome = await persistInboundAttachment(config, {
        workspaceId: operation.workspace_id,
        conversationId: String(request.conversation_id ?? ''),
        messageId: String(request.message_id ?? ''),
        fileId: String(req.query.file_id || ''),
        kind: String(req.query.kind || 'document'),
        fileName: req.query.file_name ? String(req.query.file_name) : null,
        mimeType: req.query.mime_type ? String(req.query.mime_type) : null,
        filePath: req.query.file_path ? String(req.query.file_path) : null,
        bytes,
      });
      res.json({ ok: true, outcome });
    } catch (err) {
      console.error('[internal-channels] media-ingest failed:', err);
      res.status(500).json({ error: 'media_ingest_failed' });
    }
  },
);
