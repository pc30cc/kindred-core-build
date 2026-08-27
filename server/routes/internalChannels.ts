/**
 * Core ↔ Channels internal API.
 *
 * Callers: the Channels Gateway (ingest) and the Channels Worker (process,
 * credential-free job context, status callbacks). Never reachable from a
 * browser: every route requires the shared `CORE_INTERNAL_SECRET` and the
 * router is mounted outside the public /api CORS surface.
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireInternalService } from '../lib/internalAuth.js';
import { serverConfigOf } from '../lib/workspaceAuth.js';
import { getServiceClient } from '../supabase.js';
import { getIntegrationByPublicId, updateIntegration } from '../services/channels/integrations.js';
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
  if (!parsed.success) return res.status(400).json({ error: 'Invalid ingest payload' });

  try {
    const config = serverConfigOf(req);
    const integration = await getIntegrationByPublicId(config, parsed.data.public_integration_id);
    if (!integration) return res.status(404).json({ error: 'Unknown integration' });
    if (integration.status === 'revoked') return res.status(410).json({ error: 'Integration revoked' });
    if (integration.status === 'paused') return res.status(202).json({ status: 'paused' });

    const sb = getServiceClient(config);
    await enqueueChannelJob(sb, {
      provider: 'telegram',
      jobType: 'telegram_inbound_event',
      workspaceId: integration.workspace_id,
      integrationId: integration.id,
      payload: { update: parsed.data.update, received_at: parsed.data.received_at ?? new Date().toISOString() },
    });

    await updateIntegration(config, integration.id, {} as any).catch(() => {});
    await sb
      .from('channel_integrations')
      .update({ last_inbound_at: new Date().toISOString() })
      .eq('id', integration.id);

    res.status(202).json({ status: 'queued' });
  } catch (err) {
    console.error('[internal-channels] ingest failed:', err);
    res.status(500).json({ error: 'Ingest failed' });
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
  if (!parsed.success) return res.status(400).json({ error: 'Invalid processing payload' });

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
    res.status(500).json({ error: 'Processing failed', details: message });
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
