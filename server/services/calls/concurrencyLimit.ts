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
  } catch (err) {
    return { allowed: false, reason: 'usage_unavailable', detail: `entitlement_lookup_failed:${(err as Error | null)?.message || 'unknown'}` };
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
/** The call_sessions row call_session_create wrote (every column). */
export interface CreatedCallSession {
  id: string;
  state: string;
  [column: string]: unknown;
}

export type GuardedCallInsert =
  | { verdict: 'created'; call: CreatedCallSession }
  | { verdict: 'limit_reached'; used: number; max: number }
  | { verdict: 'error'; message: string };

/**
 * Insert a call_sessions row within the plan's `max_concurrent_calls`,
 * race-free (migration 302, `call_session_create`): the workspace's live
 * calls are counted and the row is written under the per-workspace lock that
 * colleague calls take too (298), so two requests at limit − 1 can no longer
 * both pass the check above. `limit` is the decision's limit: negative or
 * missing is no limit.
 */
export async function insertCallSessionWithinCeiling(
  sb: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }> },
  row: Record<string, unknown>,
  limit: number | undefined,
): Promise<GuardedCallInsert> {
  const { data, error } = await sb.rpc('call_session_create', {
    p_row: row,
    p_max_concurrent: typeof limit === 'number' && limit >= 0 ? limit : null,
  });
  if (error) return { verdict: 'error', message: error.message || 'call_session_create_failed' };
  const out = (data ?? {}) as { verdict?: string; call?: CreatedCallSession; used?: number; max?: number };
  if (out.verdict === 'limit_reached') return { verdict: 'limit_reached', used: Number(out.used ?? 0), max: Number(out.max ?? 0) };
  if (out.verdict === 'created' && out.call) return { verdict: 'created', call: out.call };
  return { verdict: 'error', message: 'insert_returned_no_row' };
}

/** The plan denial for a guarded insert that met the limit. */
export function planConcurrencyLimitReached(
  decision: PlanConcurrencyDecision,
  hit: { used: number; max: number },
): PlanConcurrencyDecision {
  return { allowed: false, reason: 'plan_limit_reached', limit: hit.max, used: hit.used, plan: decision.plan };
}
