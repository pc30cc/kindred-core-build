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
import { withoutWidgetShimKeys } from './widgetBody.js';

export const commerceIdentityRouter = Router();

function serverConfigOf(req: any): ServerConfig {
  return req.serverConfig as ServerConfig;
}

const limiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });

// `connectionId` is optional: a store paired before the plugin stored its own
// connection id cannot send one, and it never carried authority anyway — the
// assertion names its installation and only that installation's secret can
// sign it. Given, it is an extra cross-check; omitted, the server resolves the
// workspace's active connection itself. See identityBridge.resolveConnection.
const schema = z.object({
  workspaceId: z.string().uuid(),
  connectionId: z.string().uuid().nullish(),
  assertion: z.string().min(10).max(2000),
}).strict();

commerceIdentityRouter.post('/', limiter, async (req, res) => {
  const parsed = schema.safeParse(withoutWidgetShimKeys(req.body));
  if (!parsed.success) return res.status(400).json({ error: 'invalid_request' });

  const identity = resolveVisitorIdentity(req, res, parsed.data.workspaceId);

  try {
    const result = await verifyAndBindCustomerContext(
      serverConfigOf(req), parsed.data.workspaceId, parsed.data.connectionId ?? null, identity.visitorId, parsed.data.assertion,
    );
    res.json({ ok: true, linked: true, externalCustomerId: result.externalCustomerId });
  } catch (err) {
    if (err instanceof CommerceError) return res.status(400).json({ error: err.code });
    console.error('[commerce.identity] bind failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});
