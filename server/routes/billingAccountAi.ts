// ============================================================================
// SIMPLE BILLING — AI credit packs (phase 5; docs/billing/SIMPLE_BILLING.md,
// services/billing/account/aiPacks.ts).
//
//   GET  /api/billing/account/:ws/ai        the AI wallet in the account currency, and the packs on offer
//   POST /api/billing/account/:ws/ai-pack   buy a pack from the balance
//
// Paying online for a pack is the account checkout (billingAccount.ts,
// purpose 'ai_pack'). The GET is read-only; buying needs MANAGE permission.
// The price comes from Super Admin's packs, never from the browser: the page
// sends the price it showed, and another price now answers QUOTE_CHANGED.
// ============================================================================

import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { authorizeWorkspaceAccess, serverConfigOf } from '../lib/workspaceAuth.js';
import { AccountBillingError } from '../services/billing/account/index.js';
import { aiSection, buyAiPack } from '../services/billing/account/aiPacks.js';
import { AI_PACK_LIMITS } from '../../shared/aiPacks.js';
import { canManage, fail } from './billingAccount.js';

export const billingAccountAiRouter = Router();

billingAccountAiRouter.get('/account/:workspaceId/ai', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId);
  if (!auth) return;
  try {
    res.json({ ...(await aiSection(serverConfigOf(req), req.params.workspaceId)), can_manage: canManage(auth) });
  } catch (e) {
    fail(res, e);
  }
});

const buyPackSchema = z.object({
  packId: z.string().regex(AI_PACK_LIMITS.idPattern),
  /** The price the page showed; another price now answers QUOTE_CHANGED. */
  expectedPriceMinor: z.number().int().positive(),
  /** The browser's key for this purchase: a retried request buys once. */
  key: z.string().min(8).max(100).optional(),
});

/** Errors after which the page redraws the AI card: they carry it as it is now (details.section). */
const REDRAW = new Set(['QUOTE_CHANGED', 'AI_PACK_NOT_AVAILABLE']);

billingAccountAiRouter.post('/account/:workspaceId/ai-pack', async (req, res) => {
  const auth = await authorizeWorkspaceAccess(req, res, req.params.workspaceId, { manage: true });
  if (!auth) return;
  const parsed = buyPackSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
  const cfg = serverConfigOf(req);
  const workspaceId = req.params.workspaceId;
  try {
    res.json(await buyAiPack(cfg, workspaceId, {
      packId: parsed.data.packId,
      expectedPriceMinor: parsed.data.expectedPriceMinor,
      key: `${workspaceId}:${parsed.data.key ?? crypto.randomUUID()}`,
      actorId: auth.userId,
    }));
  } catch (e) {
    if (e instanceof AccountBillingError && REDRAW.has(e.code)) {
      const section = await aiSection(cfg, workspaceId).catch(() => null);
      return res.status(e.status).json({ error: e.code, details: { ...(e.details ?? {}), section } });
    }
    fail(res, e);
  }
});
