/**
 * Commerce pairing routes — authorization-code + PKCE (docs/commerce/SECURITY.md).
 *
 * /register and /exchange are called SERVER-TO-SERVER by the WordPress
 * plugin, before any installation credential exists — they are protected by
 * state/PKCE + SSRF validation + rate limiting, never by request signing
 * (there is nothing to sign with yet). /:state and /:state/approve are
 * called from the authenticated Web Yar frontend (the "authorize" page).
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { ServerConfig } from '../../config.js';
import { authorizeWorkspaceAccess } from '../../lib/workspaceAuth.js';
import {
  approvePairingRequest,
  exchangePairingCode,
  getPairingRequest,
  PairingError,
  registerPairingRequest,
  runCapabilityHandshake,
} from '../../services/commerce/pairing.js';
import { enqueueSyncJob } from '../../services/commerce/sync.js';

export const commercePairingRouter = Router();

function serverConfigOf(req: any): ServerConfig {
  return req.serverConfig as ServerConfig;
}

// Pairing is a low-volume, security-sensitive flow — bound attempts hard.
const pairingLimiter = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false });

const registerSchema = z.object({
  state: z.string().min(16).max(200),
  codeChallenge: z.string().min(32).max(200),
  redirectUri: z.string().url(),
  storeOrigin: z.string().url(),
}).strict();

commercePairingRouter.post('/register', pairingLimiter, async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_request' });
  try {
    // Destructured into a fresh object literal (not `parsed.data` directly):
    // with this repo's strictNullChecks:false, zod's inferred object type
    // marks every field optional (a known zod/TS interaction), which fails
    // assignability against registerPairingRequest's required-field
    // signature even though every field is validated non-empty above.
    const { state, codeChallenge, redirectUri, storeOrigin } = parsed.data;
    const result = await registerPairingRequest(serverConfigOf(req), { state, codeChallenge, redirectUri, storeOrigin });
    res.json({ ok: true, expiresAt: result.expiresAt });
  } catch (err) {
    if (err instanceof PairingError) return res.status(400).json({ error: err.code, message: err.message });
    console.error('[commerce.pairing] register failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

commercePairingRouter.get('/:state', pairingLimiter, async (req, res) => {
  try {
    const view = await getPairingRequest(serverConfigOf(req), req.params.state);
    if (!view) return res.status(404).json({ error: 'not_found' });
    // code_challenge is intentionally never returned to the browser.
    res.json({
      redirectUri: view.redirectUri,
      requestedOrigin: view.requestedOrigin,
      providerType: view.providerType,
      expired: view.expired,
      alreadyAuthorized: view.alreadyAuthorized,
    });
  } catch (err) {
    console.error('[commerce.pairing] lookup failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

const approveSchema = z.object({
  workspaceId: z.string().uuid(),
  permissions: z.record(z.boolean()).default({}),
}).strict();

/** Called by the authenticated Web Yar "authorize this store" page. */
commercePairingRouter.post('/:state/approve', pairingLimiter, async (req, res) => {
  const config = serverConfigOf(req);
  const parsed = approveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_request' });

  // Only a workspace member with integration-management permission may
  // authorize a store (spec §79) — reuses canonical workspace RBAC
  // (authorizeWorkspaceAccess also fails closed with 500 on an RPC error),
  // never a bespoke check.
  const auth = await authorizeWorkspaceAccess(req, res, parsed.data.workspaceId, { manage: true });
  if (!auth) return; // response already sent

  try {
    const result = await approvePairingRequest(config, {
      state: req.params.state,
      workspaceId: parsed.data.workspaceId,
      userId: auth.userId,
      permissions: parsed.data.permissions,
    });
    res.json({ redirectUrl: result.redirectUrl });
  } catch (err) {
    if (err instanceof PairingError) return res.status(400).json({ error: err.code, message: err.message });
    console.error('[commerce.pairing] approve failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

const exchangeSchema = z.object({
  state: z.string().min(16).max(200),
  code: z.string().min(16).max(400),
  codeVerifier: z.string().min(32).max(400),
}).strict();

commercePairingRouter.post('/exchange', pairingLimiter, async (req, res) => {
  const parsed = exchangeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_request' });

  const config = serverConfigOf(req);
  try {
    const { state, code, codeVerifier } = parsed.data;
    const result = await exchangePairingCode(config, { state, code, codeVerifier });
    // Fire-and-forget: the handshake determines capabilities/versions and
    // moves health to 'connected', then the bounded initial sync begins.
    // Neither blocks the plugin's activation request on a network round trip
    // (spec §64 — pairing → handshake → initial sync → catalog_ready).
    void runCapabilityHandshake(config, result.connectionId)
      .then(() => enqueueSyncJob(config, result.workspaceId, result.connectionId, 'initial_sync'))
      .catch(() => {});
    res.json({
      installationId: result.installationId,
      installationSecret: result.installationSecret, // returned exactly once
      workspaceId: result.workspaceId,
      // The connection row id, distinct from the installation id. The plugin
      // needs it to name its own connection in dashboard-shaped URLs; without
      // it, it could only send the installation id, which those routes do not
      // match.
      connectionId: result.connectionId,
      storeId: result.storeId,
      protocolVersion: result.protocolVersion,
    });
  } catch (err) {
    if (err instanceof PairingError) return res.status(400).json({ error: err.code, message: err.message });
    console.error('[commerce.pairing] exchange failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});
