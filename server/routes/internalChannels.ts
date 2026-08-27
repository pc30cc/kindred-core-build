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

import { Router } from 'express';
import { z } from 'zod';
import { requireInternalService } from '../lib/internalAuth.js';
import { serverConfigOf } from '../lib/workspaceAuth.js';
import { getServiceClient } from '../supabase.js';
import {
  getIntegrationById,
  getIntegrationByPublicId,
  updateIntegration,
} from '../services/channels/integrations.js';
import {
  applyTelegramProfile,
  repairTelegramWebhook,
} from '../services/channels/telegram/setup.js';
import { enqueueChannelJob, queueMetrics } from '../services/channels/jobs.js';
import { processInboundMessage } from '../services/channels/inboundProcessing.js';
import { normalizeTelegramUpdate } from '../services/channels/telegram/normalize.js';

export const internalChannelsRouter = Router();

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

/** GET /ready — used by the Gateway's readiness probe. No secrets. */
internalChannelsRouter.get('/ready', (_req, res) => {
  res.json({ ok: true, service: 'core-internal-channels' });
});

/**
 * POST /profile-sync — the Worker asks Core to push bot branding to the
 * provider. Core holds the credential; the worker never decrypts it here.
 */
const profileSyncSchema = z.object({
  provider: z.literal('telegram'),
  integration_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  profile: z.record(z.unknown()).optional(),
});

internalChannelsRouter.post('/profile-sync', async (req: any, res) => {
  const parsed = profileSyncSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_payload' });

  try {
    const config = serverConfigOf(req);
    const integration = await getIntegrationById(config, parsed.data.integration_id);
    if (!integration) return res.status(404).json({ error: 'unknown_integration' });

    const profile = (parsed.data.profile ?? {}) as any;
    const result = await applyTelegramProfile(config, integration.installation_id, {
      name: typeof profile.name === 'string' ? profile.name : undefined,
      shortDescription: typeof profile.short_description === 'string' ? profile.short_description : undefined,
      description: typeof profile.description === 'string' ? profile.description : undefined,
      commands: Array.isArray(profile.commands) ? profile.commands : undefined,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[internal-channels] profile-sync failed:', err);
    res.status(500).json({ error: 'profile_sync_failed' });
  }
});

/** POST /webhook-repair — re-register + re-verify a drifted webhook. */
const webhookRepairSchema = z.object({
  provider: z.literal('telegram'),
  integration_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
});

internalChannelsRouter.post('/webhook-repair', async (req: any, res) => {
  const parsed = webhookRepairSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_payload' });

  try {
    const config = serverConfigOf(req);
    const integration = await getIntegrationById(config, parsed.data.integration_id);
    if (!integration) return res.status(404).json({ error: 'unknown_integration' });
    const result = await repairTelegramWebhook(config, integration.installation_id);
    if (!result.repaired) return res.status(502).json({ error: 'repair_failed', reason: result.reason });
    res.json({ ok: true });
  } catch (err) {
    console.error('[internal-channels] webhook-repair failed:', err);
    res.status(500).json({ error: 'webhook_repair_failed' });
  }
});
