/**
 * Widget-facing customer identity bridge endpoint. Called by the widget
 * runtime after it reads the plugin-injected assertion out of the page
 * bootstrap config (never trusts a raw customer_id from the browser).
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { ServerConfig } from '../../config.js';
import { CommerceError } from '../../../shared/commerce/types.js';
import { resolveVisitorIdentity } from '../../services/widget/visitorIdentity.js';
import { verifyAndBindCustomerContext } from '../../services/commerce/identityBridge.js';

export const commerceIdentityRouter = Router();

function serverConfigOf(req: any): ServerConfig {
  return req.serverConfig as ServerConfig;
}

const limiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });

const schema = z.object({
  workspaceId: z.string().uuid(),
  connectionId: z.string().uuid(),
  assertion: z.string().min(10).max(2000),
}).strict();

commerceIdentityRouter.post('/', limiter, async (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_request' });

  const identity = resolveVisitorIdentity(req, res, parsed.data.workspaceId);

  try {
    const result = await verifyAndBindCustomerContext(
      serverConfigOf(req), parsed.data.workspaceId, parsed.data.connectionId, identity.visitorId, parsed.data.assertion,
    );
    res.json({ ok: true, linked: true, externalCustomerId: result.externalCustomerId });
  } catch (err) {
    if (err instanceof CommerceError) return res.status(400).json({ error: err.code });
    console.error('[commerce.identity] bind failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});
