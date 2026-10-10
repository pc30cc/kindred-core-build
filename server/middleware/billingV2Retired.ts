// ============================================
// Billing v2's customer mutations, retired while the simple billing owns
// plans and money (shared/billingMode.ts, docs/billing/SIMPLE_BILLING.md).
//
// Put in front of exactly the routes that would change a plan or move money
// through v2 (plan change, invoice payment and checkout, the v2 wallet, the
// v2 checkout, subscription cancel/resume). They answer 410 before anything
// else runs, so nothing writes workspace_subscriptions, invoices or the v2
// wallet behind the simple billing's back. Gateway returns, callbacks and
// webhooks stay open: payments already started still land.
// ============================================

import type { NextFunction, Request, Response } from 'express';
import { LEGACY_BILLING_ENABLED } from '../../shared/billingMode.js';

export function billingV2Retired(_req: Request, res: Response, next: NextFunction) {
  if (!LEGACY_BILLING_ENABLED) return res.status(410).json({ error: 'BILLING_V2_RETIRED' });
  next();
}
