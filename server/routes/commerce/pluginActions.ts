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
import { Router, raw } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { verifyIncomingSignature } from '../../services/commerce/signing.js';
import { readInstallationSecret } from '../../services/commerce/credentials.js';
import { enqueueSyncJob } from '../../services/commerce/sync.js';
import { runCapabilityHandshake } from '../../services/commerce/pairing.js';
import { disconnectConnection } from '../../services/commerce/lifecycle.js';
import { COMMERCE_PROTOCOL_VERSION } from '../../../shared/commerce/types.js';

export const commercePluginActionsRouter = Router();

function serverConfigOf(req: any): ServerConfig {
  return req.serverConfig as ServerConfig;
}

// A store asking for its own handshake or resync is cheap but not free —
// a sync job walks the whole catalogue, so keep it well below the event rate.
const actionLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  // Keyed by installation when there is one. The IP fallback goes through
  // ipKeyGenerator so an IPv6 caller is bucketed by prefix — keying on the
  // raw address would let one client rotate freely inside its own /64 and
  // never hit the limit.
  keyGenerator: (req) => req.header('X-WebYar-Installation') || ipKeyGenerator(req.ip ?? ''),
});

type Resolved = { installationId: string; connectionId: string; workspaceId: string };

/**
 * Verifies the signature and resolves the caller's own connection.
 * Returns null after having already answered the request.
 */
async function authenticate(req: any, res: any, canonicalPath: string): Promise<Resolved | null> {
  const config = serverConfigOf(req);
  const installationId = req.header('X-WebYar-Installation');
  const timestamp = req.header('X-WebYar-Timestamp');
  const nonce = req.header('X-WebYar-Nonce');
  const signature = req.header('X-WebYar-Signature');
  const protocolVersion = req.header('X-WebYar-Protocol');

  if (!installationId || !timestamp || !nonce || !signature || !protocolVersion) {
    res.status(400).json({ error: 'missing_signature_headers' });
    return null;
  }
  if (protocolVersion !== COMMERCE_PROTOCOL_VERSION) {
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
    .select('id, workspace_id, revoked_at')
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

  return { installationId, connectionId: connection.id, workspaceId: connection.workspace_id };
}

const rawJson = raw({ type: '*/*', limit: '8kb' });

/** Re-runs the capability handshake — Web Yar calls the store's /health. */
commercePluginActionsRouter.post('/test', rawJson, actionLimiter, async (req, res) => {
  const who = await authenticate(req, res, '/api/commerce/connection/test');
  if (!who) return;
  try {
    await runCapabilityHandshake(serverConfigOf(req), who.connectionId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[commerce.pluginActions] handshake failed:', err);
    res.status(502).json({ error: 'handshake_failed' });
  }
});

/** Queues a full catalogue resync for the calling store. */
commercePluginActionsRouter.post('/sync', rawJson, actionLimiter, async (req, res) => {
  const who = await authenticate(req, res, '/api/commerce/connection/sync');
  if (!who) return;
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
commercePluginActionsRouter.post('/disconnect', rawJson, actionLimiter, async (req, res) => {
  const who = await authenticate(req, res, '/api/commerce/connection/disconnect');
  if (!who) return;
  try {
    await disconnectConnection(serverConfigOf(req), who.workspaceId, who.connectionId, null);
    res.json({ ok: true });
  } catch (err) {
    console.error('[commerce.pluginActions] disconnect failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});
