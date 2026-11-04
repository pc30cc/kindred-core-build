/**
 * Connection actions the PLUGIN itself triggers — inbound, HMAC-signed
 * requests from the WooCommerce plugin, same trust model as event ingestion.
 *
 * These exist because the equivalent dashboard routes in connections.ts are
 * guarded by authorizeWorkspaceAccess, i.e. a logged-in workspace member's
 * session. The plugin has no session to offer — it calls server-to-server
 * from WordPress — so its "Test connection" and "Sync now" buttons hit those
 * routes and got 401 every time, silently. A store proving possession of its
 * own installation secret is the right credential for acting on its own
 * connection, and it can reach nothing else: the connection is resolved FROM
 * the installation, never from anything the caller supplies.
 *
 * Mounted BEFORE express.json() in server/index.ts (signature verification
 * needs the exact raw bytes) with its own express.raw() parser.
 */
import { Router, raw, type NextFunction, type Request, type Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { verifyIncomingSignature } from '../../services/commerce/signing.js';
import { readInstallationSecret } from '../../services/commerce/credentials.js';
import { enqueueSyncJob } from '../../services/commerce/sync.js';
import { runCapabilityHandshake } from '../../services/commerce/pairing.js';
import { disconnectConnection } from '../../services/commerce/lifecycle.js';
import { providerProfile } from '../../services/commerce/providers.js';
import { readSignedRequestHeaders } from '../../services/commerce/pluginDialect.js';

export const commercePluginActionsRouter = Router();

function serverConfigOf(req: Request): ServerConfig {
  return (req as Request & { serverConfig?: ServerConfig }).serverConfig as ServerConfig;
}

// A store asking for its own handshake or resync is cheap but not free —
// a sync job walks the whole catalogue, so keep it well below the event rate.
// Two limits: by client address BEFORE the signature is checked (unsigned
// traffic is bounded at all; ipKeyGenerator buckets IPv6 by prefix, or one
// client could rotate inside its own /64), then by installation AFTER it.
// Keyed on the unverified header, anyone who read a store's installation id
// in its pages could spend that store's budget, and random ids escaped both.
const actionIpLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip ?? '')}`,
});

const actionLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (_req, res) => `installation:${(res.locals as { who: Resolved }).who.installationId}`,
});

type Resolved = { installationId: string; connectionId: string; workspaceId: string; providerType: string };

/**
 * Verifies the signature and resolves the caller's own connection.
 * Returns null after having already answered the request.
 */
async function authenticate(req: Request, res: Response, canonicalPath: string): Promise<Resolved | null> {
  const config = serverConfigOf(req);
  // Either plugin dialect (pluginDialect.ts), never mixed.
  const { dialect, installationId, timestamp, nonce, signature, protocolVersion } = readSignedRequestHeaders((name) => req.header(name));

  if (!installationId || !timestamp || !nonce || !signature || !protocolVersion) {
    res.status(400).json({ error: 'missing_signature_headers' });
    return null;
  }
  // The protocol of the dialect whose headers carried it: X-Platform-* names
  // platform-commerce/1, X-WebYar-* names the Iran packages' protocol.
  if (protocolVersion !== dialect.protocol) {
    res.status(400).json({ error: 'protocol_mismatch' });
    return null;
  }

  const secret = await readInstallationSecret(config, installationId).catch(() => null);
  if (!secret) {
    res.status(401).json({ error: 'unknown_installation' });
    return null;
  }

  // express.raw() leaves a Buffer; an empty body is the normal case here.
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';

  const verify = await verifyIncomingSignature(config, {
    secret,
    installationId,
    protocolVersion,
    method: 'POST',
    canonicalPath,
    timestamp,
    nonce,
    signature,
    rawBody,
    direction: 'inbound',
  });
  // `verify.ok === false` rather than `!verify.ok`: this repo compiles with
  // strictNullChecks off, where the shorthand does not narrow the union.
  if (verify.ok === false) {
    const status = verify.reason === 'body_too_large' ? 413 : verify.reason === 'protocol_mismatch' ? 400 : 401;
    res.status(status).json({ error: verify.reason });
    return null;
  }

  const sb = getServiceClient(config);
  const { data: connection, error } = await sb
    .from('commerce_connections')
    .select('id, workspace_id, revoked_at, provider_type')
    .eq('installation_id', installationId)
    .maybeSingle();
  if (error) {
    res.status(500).json({ error: 'internal_error' });
    return null;
  }
  if (!connection || connection.revoked_at) {
    res.status(403).json({ error: 'commerce_not_connected' });
    return null;
  }

  return { installationId, connectionId: connection.id, workspaceId: connection.workspace_id, providerType: connection.provider_type ?? 'woocommerce' };
}

const rawJson = raw({ type: '*/*', limit: '8kb' });

/** authenticate() as middleware: the caller's connection in res.locals.who. */
function signedBy(canonicalPath: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    authenticate(req, res, canonicalPath)
      .then((who) => {
        if (!who) return;
        res.locals.who = who;
        next();
      })
      .catch(next);
  };
}

const whoOf = (res: Response): Resolved => res.locals.who as Resolved;

/** Re-runs the capability handshake — Web Yar calls the store's /health. */
commercePluginActionsRouter.post('/test', rawJson, actionIpLimiter, signedBy('/api/commerce/connection/test'), actionLimiter, async (req, res) => {
  const who = whoOf(res);
  try {
    await runCapabilityHandshake(serverConfigOf(req), who.connectionId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[commerce.pluginActions] handshake failed:', err);
    res.status(502).json({ error: 'handshake_failed' });
  }
});

/** Queues a full catalogue resync for the calling store. */
commercePluginActionsRouter.post('/sync', rawJson, actionIpLimiter, signedBy('/api/commerce/connection/sync'), actionLimiter, async (req, res) => {
  const who = whoOf(res);
  if (!providerProfile(who.providerType).catalogSync) return res.status(400).json({ error: 'sync_not_applicable' });
  try {
    const job = await enqueueSyncJob(serverConfigOf(req), who.workspaceId, who.connectionId, 'manual_resync');
    res.json({ ok: true, jobId: job?.id ?? null });
  } catch (err) {
    res.status(409).json({ error: 'sync_already_running' });
  }
});

/**
 * The store telling Web Yar it has disconnected. The plugin deletes its own
 * credential regardless of whether this lands (local cleanup never depends on
 * the network), so this only stops Web Yar from holding a connection whose
 * store has already walked away.
 */
commercePluginActionsRouter.post('/disconnect', rawJson, actionIpLimiter, signedBy('/api/commerce/connection/disconnect'), actionLimiter, async (req, res) => {
  const who = whoOf(res);
  try {
    await disconnectConnection(serverConfigOf(req), who.workspaceId, who.connectionId, null);
    res.json({ ok: true });
  } catch (err) {
    console.error('[commerce.pluginActions] disconnect failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});
