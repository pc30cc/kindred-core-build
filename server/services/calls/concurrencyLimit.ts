/**
 * ============================================================
 * PLAN-LEVEL CONCURRENCY CEILING — Dual-Knob Activation
 * ------------------------------------------------------------
 * Canonical enforcement helper for the plan capability key
 * `max_concurrent_calls`. Workspace-wide ceiling on simultaneously-
 * active `call_sessions` (state ∈ {pending, ringing, connecting,
 * active}, ALL `entry_source` values).
 *
 * Dual-knob policy (locked in `docs/CALL_NUMERIC_LIMITS.md`):
 *   - This helper enforces ONLY the plan-level ceiling.
 *   - The existing widget-scoped platform-admin knob
 *     (`platform_call_center_settings.max_concurrent_calls_per_workspace`,
 *      enforced inline in `server/routes/callWidget.ts`) is
 *     INDEPENDENT and remains unchanged. Both ceilings may deny
 *     new work at the create boundary; first denial wins.
 *
 * Why this helper instead of `requireLimit` middleware:
 *   The operator route (`POST /api/calls/create`) and the visitor
 *   widget route (`POST /api/widget/calls/request`) both have
 *   bespoke auth/guard sequences that run inside the handler.
 *   Wiring `requireLimit` as Express middleware would either skip
 *   guards or duplicate the workspace-id extraction. This helper
 *   reuses the same primitives (`checkEntitlementFromDB` for the
 *   plan limit lookup, `resolveUsage('max_concurrent_calls')` for
 *   the canonical count) so there is exactly ONE plan-side
 *   counting model.
 *
 * Denial contract:
 *   { allowed: false, reason: 'plan_limit_reached',
 *     limit, used, plan }                       — at-or-over limit
 *   { allowed: false, reason: 'plan_forbidden' } — plan does not
 *                                                  include the key
 *                                                  (fail-closed; the
 *                                                  activation migration
 *                                                  seeds -1 for every
 *                                                  existing plan so
 *                                                  this is only hit
 *                                                  for malformed plans)
 *   { allowed: false, reason: 'usage_unavailable' } — count failed
 *
 * Allow paths:
 *   { allowed: true, limit: -1 }              — unlimited
 *   { allowed: true, limit, used }            — under the ceiling
 * ============================================================
 */

import type { ServerConfig } from '../../config.js';
import { checkEntitlementFromDB } from '../../middleware/featureGating.js';
import { resolveUsage } from '../billing/usageResolvers.js';

export type PlanConcurrencyDenialReason =
  | 'plan_forbidden'
  | 'plan_limit_reached'
  | 'usage_unavailable';

export interface PlanConcurrencyDecision {
  allowed: boolean;
  reason?: PlanConcurrencyDenialReason;
  limit?: number;
  used?: number;
  plan?: string;
  detail?: string;
}

/**
 * Check whether starting one more concurrent call would breach the
 * plan-level `max_concurrent_calls` ceiling for this workspace.
 * Pure read; never inserts or mutates anything.
 */
export async function checkPlanConcurrencyCeiling(
  config: ServerConfig,
  workspaceId: string,
): Promise<PlanConcurrencyDecision> {
  let ent;
  try {
    ent = await checkEntitlementFromDB(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      workspaceId,
      'max_concurrent_calls',
    );
  } catch (err: any) {
    return { allowed: false, reason: 'usage_unavailable', detail: `entitlement_lookup_failed:${err?.message || 'unknown'}` };
  }

  if (!ent.allowed) {
    return { allowed: false, reason: 'plan_forbidden', plan: ent.plan, detail: ent.reason };
  }

  const limit = typeof ent.limit === 'number' ? ent.limit : -1;
  // -1 (or any negative value) = unlimited by registry-wide convention.
  if (limit < 0) return { allowed: true, limit, plan: ent.plan };

  const usage = await resolveUsage(config, workspaceId, 'max_concurrent_calls');
  if (!usage.supported) {
    return { allowed: false, reason: 'usage_unavailable', limit, plan: ent.plan, detail: usage.reasonIfUnsupported };
  }

  if (usage.value >= limit) {
    return { allowed: false, reason: 'plan_limit_reached', limit, used: usage.value, plan: ent.plan };
  }
  return { allowed: true, limit, used: usage.value, plan: ent.plan };
}

/**
 * Stable denial body shape for HTTP responses. Distinct from the
 * widget-knob denial (`{ error: 'limit_reached', kind: 'concurrent' }`,
 * HTTP 429) so callers can distinguish "platform-admin widget knob"
 * from "plan ceiling" without parsing free-form messages.
 */
export function planConcurrencyDenialBody(decision: PlanConcurrencyDecision) {
  return {
    error: decision.reason,
    capability: 'max_concurrent_calls',
    limit: decision.limit,
    used: decision.used,
    plan: decision.plan,
    upgrade_required: decision.reason === 'plan_limit_reached' || decision.reason === 'plan_forbidden',
  };
}