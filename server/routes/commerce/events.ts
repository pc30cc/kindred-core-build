/**
 * Commerce event ingestion — inbound, HMAC-signed requests from the
 * WooCommerce plugin. Mounted BEFORE express.json() in server/index.ts
 * (same reason as the LiveKit/billing webhooks: signature verification
 * needs the exact raw bytes) with its own express.raw() parser.
 */
import { Router, raw } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { verifyIncomingSignature, MAX_BODY_BYTES } from '../../services/commerce/signing.js';
import { readInstallationSecret } from '../../services/commerce/credentials.js';
import { ingestCommerceEvent } from '../../services/commerce/events.js';
import { COMMERCE_PROTOCOL_VERSION } from '../../../shared/commerce/types.js';

export const commerceEventsRouter = Router();

function serverConfigOf(req: any): ServerConfig {
  return req.serverConfig as ServerConfig;
}

const eventIngestLimiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => String(req.header('X-WebYar-Installation') || req.ip) });

const eventSchema = z.object({
  event_id: z.string().min(1).max(200),
  type: z.enum([
    'product.created', 'product.updated', 'product.deleted',
    'variation.created', 'variation.updated', 'variation.deleted',
    'stock.changed',
    'order.created', 'order.updated', 'order.status_changed',
  ]),
  entity_id: z.string().min(1).max(200),
  entity_version: z.string().min(1).max(60),
  occurred_at: z.string().min(1).max(60),
  protocol_version: z.string(),
  payload: z.record(z.unknown()),
}).strict();

commerceEventsRouter.post('/', raw({ type: 'application/json', limit: '256kb' }), eventIngestLimiter, async (req, res) => {
  const config = serverConfigOf(req);
  const installationId = req.header('X-WebYar-Installation');
  const timestamp = req.header('X-WebYar-Timestamp');
  const nonce = req.header('X-WebYar-Nonce');
  const signature = req.header('X-WebYar-Signature');
  const protocolVersion = req.header('X-WebYar-Protocol');

  if (!installationId || !timestamp || !nonce || !signature || !protocolVersion) {
    return res.status(400).json({ error: 'missing_signature_headers' });
  }
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'empty_body' });
  if (req.body.length > MAX_BODY_BYTES) return res.status(413).json({ error: 'body_too_large' });

  const rawBody = req.body.toString('utf8');

  const secret = await readInstallationSecret(config, installationId).catch(() => null);
  if (!secret) return res.status(401).json({ error: 'unknown_installation' });

  const verify = await verifyIncomingSignature(config, {
    secret,
    installationId,
    protocolVersion,
    method: 'POST',
    canonicalPath: '/api/commerce/events',
    timestamp,
    nonce,
    signature,
    rawBody,
    direction: 'inbound',
  });
  if (verify.ok === false) {
    return res.status(verify.reason === 'clock_skew' || verify.reason === 'replay' ? 401 : 400).json({ error: verify.reason });
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'invalid_json' });
  }
  const parsed = eventSchema.safeParse(parsedBody);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_event_shape' });
  if (parsed.data.protocol_version !== COMMERCE_PROTOCOL_VERSION) {
    return res.status(400).json({ error: 'protocol_mismatch' });
  }

  // Resolve the tenant-scoped connection from the installation, never from
  // any workspace_id the request body might carry.
  const sb = getServiceClient(config);
  const { data: connection, error } = await sb
    .from('commerce_connections')
    .select('id, workspace_id, revoked_at')
    .eq('installation_id', installationId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: 'internal_error' });
  if (!connection || connection.revoked_at) return res.status(403).json({ error: 'commerce_not_connected' });

  try {
    const outcome = await ingestCommerceEvent(config, connection.workspace_id, connection.id, {
      event_id: parsed.data.event_id,
      installation_id: installationId,
      type: parsed.data.type,
      entity_id: parsed.data.entity_id,
      entity_version: parsed.data.entity_version,
      occurred_at: parsed.data.occurred_at,
      protocol_version: COMMERCE_PROTOCOL_VERSION,
      payload: parsed.data.payload,
    });
    res.json({ ok: true, status: outcome.status });
  } catch (err) {
    console.error('[commerce.events] ingest failed:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'internal_error' });
  }
});
