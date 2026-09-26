/**
 * Contacts limit enforcement helper — canonical TS-first chokepoint.
 *
 * `max_contacts` is composed by the existing TypeScript entitlement
 * stack (`requireLimit` + `usageFnForLimit('max_contacts')`). This
 * helper is the ONLY import seam between the contacts route and the
 * cap, so a single canonical check governs both single-create and
 * bulk-import flows.
 *
 * Two surfaces:
 *   - `enforceMaxContactsCreate(req, res)` wraps `requireLimit(...)` for
 *     the single-row create branch. Returns `true` when the caller may
 *     proceed, `false` when the middleware has already written its 403.
 *   - `assertContactsBatchFits(req, res, batchSize)` is the bulk-import
 *     equivalent. It enforces all-or-nothing semantics: if the
 *     post-insert count would exceed the effective limit, the batch
 *     is rejected with a structured 403 and zero rows are inserted.
 *
 * Both surfaces use the same composer (`checkEntitlementFromDB`) and
 * the same usage resolver (`usageFnForLimit('max_contacts')`). No
 * SQL-side limit composer is introduced.
 */

import type { Request, Response } from 'express';
import { requireLimit, checkEntitlementFromDB } from '../../middleware/featureGating.js';
import { setTrustedGateWorkspaceId } from '../../middleware/gateWorkspace.js';
import { usageFnForLimit } from './usageResolvers.js';
import type { ServerConfig } from '../../config.js';

const singleCreateMiddleware = requireLimit(
  'max_contacts',
  usageFnForLimit('max_contacts'),
);

/**
 * Single-contact create branch. Caller must `return` immediately when
 * this returns `false` (the middleware has already written a 4xx).
 */
export async function enforceMaxContactsCreate(
  req: Request,
  res: Response,
  workspaceId: string,
): Promise<boolean> {
  if (!workspaceId) {
    res.status(400).json({ error: 'Missing workspaceId for limit check' });
    return false;
  }
  // Evaluate the cap on the authorized workspace, never on raw body fields.
  setTrustedGateWorkspaceId(req, workspaceId);
  let proceeded = false;
  await singleCreateMiddleware(req, res, () => {
    proceeded = true;
  });
  return proceeded;
}

/**
 * Bulk-import branch. All-or-nothing: if `currentUsage + batchSize`
 * would exceed the effective limit, the entire batch is rejected and
 * a structured 403 is written. No rows are inserted.
 */
export async function assertContactsBatchFits(
  req: Request,
  res: Response,
  workspaceId: string,
  batchSize: number,
): Promise<boolean> {
  if (batchSize <= 0) return true;
  const config = (req as Request & { serverConfig?: ServerConfig }).serverConfig;
  if (!config) {
    res.status(500).json({ error: 'serverConfig_missing' });
    return false;
  }
  const ent = await checkEntitlementFromDB(
    config.supabaseUrl,
    config.supabaseServiceRoleKey,
    workspaceId,
    'max_contacts',
  );
  if (!ent.allowed) {
    res.status(403).json({
      error: 'Feature not available on your current plan',
      feature: 'max_contacts',
      plan: ent.plan,
      upgrade_required: true,
    });
    return false;
  }
  // Unlimited (-1) or unspecified limit → allow.
  if (ent.limit === undefined || ent.limit === -1) return true;

  let current: number;
  try {
    current = await usageFnForLimit('max_contacts')(req, workspaceId);
  } catch {
    res.status(403).json({
      error: 'Could not determine current usage',
      feature: 'max_contacts',
      upgrade_required: true,
    });
    return false;
  }
  if (current + batchSize > ent.limit) {
    res.status(403).json({
      error: 'limit_exceeded',
      feature: 'max_contacts',
      plan: ent.plan,
      limit: ent.limit,
      used: current,
      requested: batchSize,
      inserted: 0,
      upgrade_required: true,
    });
    return false;
  }
  return true;
}