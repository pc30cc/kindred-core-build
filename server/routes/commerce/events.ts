/**
 * Commerce event ingestion — inbound, HMAC-signed requests from the
 * WooCommerce plugin. Mounted BEFORE express.json() in server/index.ts
 * (same reason as the LiveKit/billing webhooks: signature verification
 * needs the exact raw bytes) with its own express.raw() parser.
 */
import { Router, raw, type NextFunction, type Request, type Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { verifyIncomingSignature, MAX_BODY_BYTES } from '../../services/commerce/signing.js';
import { readInstallationSecret } from '../../services/commerce/credentials.js';
import { ingestCommerceEvent } from '../../services/commerce/events.js';
import { COMMERCE_PROTOCOL_VERSION } from '../../../shared/commerce/types.js';
import { readSignedRequestHeaders } from '../../services/commerce/pluginDialect.js';

export const commerceEventsRouter = Router();

function serverConfigOf(req: object): ServerConfig {
  return (req as { serverConfig?: ServerConfig }).serverConfig as ServerConfig;
}

// Two limits, in this order:
//   1. by client address, BEFORE the signature is checked, so unsigned or
//      badly signed traffic is bounded at all (these routes are mounted ahead
//      of the global IP-block and abuse middleware). Generous: several shops
//      on one shared host post from the same address. ipKeyGenerator buckets
//      an IPv6 address by its /56, or one client could cycle its own prefix.
//   2. by installation, AFTER the signature checks out. Keying it on the
//      unverified header let anyone spend a store's budget: its installation
//      id is readable in the store's pages (the customer assertion), and 120
//      bad requests a minute under it made the store's real events answer
//      429 until the plugin dead-lettered them; random ids escaped limit 1.
const eventIpLimiter = rateLimit({
  windowMs: 60_000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `ip:${req.ip ? ipKeyGenerator(req.ip) : 'unknown'}`,
});

const eventInstallationLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (_req, res) => `installation:${(res.locals as VerifiedLocals).verified.installationId}`,
});

type VerifiedEvent = { installationId: string; protocolVersion: string; rawBody: string };
type VerifiedLocals = { verified: VerifiedEvent };

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

/** Checks the signature; answers the request itself when it fails. */
async function verifyEventSignature(req: Request, res: Response, next: NextFunction): Promise<void> {
  const config = serverConfigOf(req);
  // Either plugin dialect (pluginDialect.ts): the Iran packages' X-WebYar-*
  // or the International packages' X-Platform-* headers, never mixed.
  const { dialect, installationId, timestamp, nonce, signature, protocolVersion } = readSignedRequestHeaders((name) => req.header(name));

  if (!installationId || !timestamp || !nonce || !signature || !protocolVersion) {
    res.status(400).json({ error: 'missing_signature_headers' });
    return;
  }
  if (protocolVersion !== dialect.protocol) {
    res.status(400).json({ error: 'protocol_mismatch' });
    return;
  }
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    res.status(400).json({ error: 'empty_body' });
    return;
  }
  if (req.body.length > MAX_BODY_BYTES) {
    res.status(413).json({ error: 'body_too_large' });
    return;
  }

  const rawBody = req.body.toString('utf8');

  const secret = await readInstallationSecret(config, installationId).catch(() => null);
  if (!secret) {
    res.status(401).json({ error: 'unknown_installation' });
    return;
  }

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
    res.status(verify.reason === 'clock_skew' || verify.reason === 'replay' ? 401 : 400).json({ error: verify.reason });
    return;
  }
  (res.locals as VerifiedLocals).verified = { installationId, protocolVersion, rawBody };
  next();
}

commerceEventsRouter.post('/', raw({ type: 'application/json', limit: '256kb' }), eventIpLimiter, (req, res, next) => {
  verifyEventSignature(req, res, next).catch(next);
}, eventInstallationLimiter, async (req, res) => {
  const config = serverConfigOf(req);
  const { installationId, protocolVersion, rawBody } = (res.locals as VerifiedLocals).verified;

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'invalid_json' });
  }
  const parsed = eventSchema.safeParse(parsedBody);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_event_shape' });
  // The body names the same protocol the signed header did.
  if (parsed.data.protocol_version !== protocolVersion) {
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
