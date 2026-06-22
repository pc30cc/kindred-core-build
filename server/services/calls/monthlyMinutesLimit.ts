/**
 * ============================================================
 * PLAN-LEVEL MONTHLY CALL-MINUTES CEILING
 * ------------------------------------------------------------
 * Canonical enforcement helper for the plan capability key
 * `max_call_minutes_per_month`. Workspace-wide UTC-month cap on
 * billable call minutes consumed by ended calls.
 *
 * Single source of truth:
 *   - Counter column: workspace_usage_counters.call_minutes_used
 *   - Sole writer:    DB trigger tg_call_sessions_bill_minutes
 *   - Resolver:       resolveMaxCallMinutesPerMonth
 *   - Billable policy (locked in docs/CALL_NUMERIC_LIMITS.md):
 *       connected_at IS NOT NULL AND state='ended';
 *       minutes = CEIL((ended_at - connected_at) / 60); UTC month bucket.
 *
 * Why a dedicated helper (mirrors concurrencyLimit.ts):
 *   Create-time call routes (`POST /api/calls/create`, widget
 *   `POST /api/widget/calls/request`) have bespoke auth/identity
 *   resolution that runs inside the handler. Reusing `requireLimit`
 *   middleware would either bypass those guards or duplicate
 *   workspace-id extraction. This helper composes the two existing
 *   primitives (`checkEntitlementFromDB` + `resolveUsage`) so there
 *   is exactly one read path, matching the concurrency helper.
 *
 * Near-threshold behavior (intentional):
 *   The gate is `used >= limit` at create time. A long in-flight call
 *   that ends AFTER its create gate may push the monthly total over
 *   the cap — that overshoot is bounded by the duration of the calls
 *   that were below the gate at start. No retroactive cancellation,
 *   no mid-call termination. The next create attempt is denied.
 * ============================================================
 */

import type { ServerConfig } from '../../config.js';
import { checkEntitlementFromDB } from '../../middleware/featureGating.js';
import { resolveUsage } from '../billing/usageResolvers.js';

export type PlanMinutesDenialReason =
  | 'plan_forbidden'
  | 'plan_limit_reached'
  | 'usage_unavailable';

export interface PlanMinutesDecision {
  allowed: boolean;
  reason?: PlanMinutesDenialReason;
  limit?: number;
  used?: number;
  plan?: string;
  detail?: string;
}

export async function checkPlanMonthlyMinutesCeiling(
  config: ServerConfig,
  workspaceId: string,
): Promise<PlanMinutesDecision> {
  let ent;
  try {
    ent = await checkEntitlementFromDB(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      workspaceId,
      'max_call_minutes_per_month',
    );
  } catch (err: any) {
    return { allowed: false, reason: 'usage_unavailable', detail: `entitlement_lookup_failed:${err?.message || 'unknown'}` };
  }

  if (!ent.allowed) {
    return { allowed: false, reason: 'plan_forbidden', plan: ent.plan, detail: ent.reason };
  }

  const limit = typeof ent.limit === 'number' ? ent.limit : -1;
  if (limit < 0) return { allowed: true, limit, plan: ent.plan };

  const usage = await resolveUsage(config, workspaceId, 'max_call_minutes_per_month');
  if (!usage.supported) {
    return { allowed: false, reason: 'usage_unavailable', limit, plan: ent.plan, detail: usage.reasonIfUnsupported };
  }
  if (usage.value >= limit) {
    return { allowed: false, reason: 'plan_limit_reached', limit, used: usage.value, plan: ent.plan };
  }
  return { allowed: true, limit, used: usage.value, plan: ent.plan };
}

export function planMinutesDenialBody(decision: PlanMinutesDecision) {
  return {
    error: decision.reason,
    capability: 'max_call_minutes_per_month',
    limit: decision.limit,
    used: decision.used,
    plan: decision.plan,
    upgrade_required: decision.reason === 'plan_limit_reached' || decision.reason === 'plan_forbidden',
  };
}