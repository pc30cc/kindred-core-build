// ============================================
// FEATURE GATING MIDDLEWARE — Backend enforcement of plan limits,
// modules, channels, AI credits. Strictly fail-closed.
// ============================================

import { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';
import type { ServerConfig } from '../config.js';
import {
  parseEntitlementResponse,
  parseNumericEntitlementResponse,
  isUnreadableEntitlementReason,
  isCheckWorkspaceEntitlementFunctionMissing,
  isRelationMissing,
} from '../services/billing/entitlementParse.js';
import { getCapability } from '../services/billing/capabilityRegistry.js';
import { assignedPlanApplies, type SubscriptionPlanState } from '../services/billing/planSelection.js';

interface EntitlementResult {
  allowed: boolean;
  limit?: number;
  plan?: string;
  reason?: string;
  /** True when a numeric `limit` was actually readable on the RPC payload. */
  limitValid?: boolean;
}

// ─── Cache ───
const cache = new Map<string, { result: EntitlementResult; expiresAt: number }>();
const CACHE_TTL = 60_000;
/** Bound: expired entries were never evicted, so the map grew with every
 *  workspace×feature pair ever seen. Swept on write. */
const CACHE_MAX_ENTRIES = 2000;

function boundEntitlementCache(): void {
  if (cache.size <= CACHE_MAX_ENTRIES) return;
  const now = Date.now();
  for (const [key, value] of cache) {
    if (value.expiresAt <= now) cache.delete(key);
  }
  let excess = cache.size - CACHE_MAX_ENTRIES;
  for (const key of cache.keys()) {
    if (excess-- <= 0) break;
    cache.delete(key);
  }
}

function cacheKey(workspaceId: string, feature: string): string {
  return `${workspaceId}:${feature}`;
}

export function clearEntitlementCache(workspaceId?: string): void {
  if (!workspaceId) { cache.clear(); return; }
  for (const key of cache.keys()) {
    if (key.startsWith(workspaceId)) cache.delete(key);
  }
}

/** Express request as the server hands it to route middleware. */
type GatedRequest = Request & {
  serverConfig?: ServerConfig;
  entitlement?: EntitlementResult;
  aiCredits?: Awaited<ReturnType<typeof deductAICredits>>;
};

function extractWorkspaceId(req: Request): string | undefined {
  const pick = (bag: unknown, key: string): string | undefined => {
    const value = bag && typeof bag === 'object' ? (bag as Record<string, unknown>)[key] : undefined;
    return typeof value === 'string' && value ? value : undefined;
  };
  return pick(req.body, 'workspaceId')
    || pick(req.body, 'workspace_id')
    || pick(req.query, 'workspaceId')
    || pick(req.query, 'workspace_id')
    || pick(req.params, 'workspaceId');
}

function getSupabaseClient(req: Request) {
  const config = (req as GatedRequest).serverConfig;
  if (!config?.supabaseUrl || !config?.supabaseServiceRoleKey) return null;
  return { client: createClient(config.supabaseUrl, config.supabaseServiceRoleKey), config };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Reason stamped on an answer that came from the registry default. */
export const REGISTRY_DEFAULT = 'registry_default';

/** Reason stamped on every answer of a self-host install without billing. */
export const SELF_HOST_UNLIMITED = 'self_host_billing_schema_absent';

/**
 * A key the plan JSON never mentions takes its registry default —
 * `override ?? plan ?? registry default` (docs/ENTITLEMENT_ARCHITECTURE.md §6),
 * which is also what GET /api/plans/workspace/:id/effective shows every app.
 * `check_workspace_entitlement` answers `feature_not_in_plan` for such a key,
 * so the default is applied here, once, for every caller. Keys the registry
 * does not know (legacy aliases) stay denied.
 */
function registryDefault(feature: string, plan: string | undefined): EntitlementResult | null {
  const cap = getCapability(feature);
  if (!cap || cap.deprecated) return null;
  if (cap.type === 'limit') {
    if (typeof cap.defaultValue !== 'number' || !Number.isFinite(cap.defaultValue)) return null;
    return { allowed: true, limit: cap.defaultValue, limitValid: true, plan, reason: REGISTRY_DEFAULT };
  }
  return { allowed: cap.defaultValue === true, plan, reason: REGISTRY_DEFAULT };
}

// ─── Core entitlement check ───
export async function checkEntitlementFromDB(
  supabaseUrl: string,
  serviceRoleKey: string,
  workspaceId: string,
  feature: string,
  opts: { numeric?: boolean; selfHostBillingUnlimited?: boolean } = {}
): Promise<EntitlementResult> {
  const key = `${cacheKey(workspaceId, feature)}:${opts.numeric ? 'num' : 'bool'}:${opts.selfHostBillingUnlimited ? 'shu' : 'std'}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  try {
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const { data, error } = await supabase.rpc('check_workspace_entitlement', {
      _workspace_id: workspaceId,
      _feature: feature,
    });

    // Self-host-billing-unlimited is a TWO-part condition, both required:
    //   1. `opts.selfHostBillingUnlimited` — an explicit, server-only,
    //      request-uncontrollable deployment-policy flag
    //      (ServerConfig.selfHostBillingUnlimited, SELF_HOST_BILLING_MODE=
    //      unlimited, defaults false/fail-closed when unset — see
    //      server/config.ts's own doc comment).
    //   2. The RPC error precisely names check_workspace_entitlement as
    //      absent (isCheckWorkspaceEntitlementFunctionMissing).
    // Neither alone is sufficient. In particular, PostgREST PGRST202 can
    // also mean a stale schema-cache entry on a deployment where the
    // function DOES exist (per PostgREST's own docs) — condition 2 alone
    // would let a transient hosted schema-cache hiccup silently bypass
    // billing. Requiring the operator to have ALSO explicitly declared
    // "this deployment intentionally has no billing subsystem" closes that:
    // no hosted deployment sets SELF_HOST_BILLING_MODE=unlimited, so this
    // branch is structurally unreachable there regardless of what error
    // PostgREST returns. Every other RPC failure — including PGRST202/42883
    // on a deployment WITHOUT the flag set — falls through to the existing
    // fail-closed "unavailable" path below, unchanged.
    if (error && opts.selfHostBillingUnlimited && isCheckWorkspaceEntitlementFunctionMissing(error)) {
      const result: EntitlementResult = {
        allowed: true,
        limit: -1,
        limitValid: true,
        plan: 'self-host-unlimited',
        reason: SELF_HOST_UNLIMITED,
      };
      cache.set(key, { result, expiresAt: Date.now() + CACHE_TTL });
    boundEntitlementCache();
      return result;
    }

    const parsed = opts.numeric
      ? parseNumericEntitlementResponse(data, error)
      : parseEntitlementResponse(data, error);

    // Phase 6-S5-R7.3 §4 — an unreadable answer is NOT a denial and must
    // never enter the cache, or one transient blip would deny the workspace
    // for a full TTL.
    if (parsed.outcome === 'unavailable') {
      console.error('[FeatureGating] Unreadable entitlement result:', parsed.reason, error?.message);
      return { allowed: false, plan: 'error', reason: parsed.reason };
    }

    const result: EntitlementResult =
      (parsed.allowed === false && parsed.reason === 'feature_not_in_plan' && registryDefault(feature, parsed.plan)) || {
        allowed: parsed.allowed === true,
        limit: parsed.limit,
        limitValid: parsed.limitValid === true,
        plan: parsed.plan,
        reason: parsed.reason,
      };

    cache.set(key, { result, expiresAt: Date.now() + CACHE_TTL });
    boundEntitlementCache();
    return result;
  } catch (err) {
    console.error('[FeatureGating] Exception:', errorMessage(err));
    return { allowed: false, plan: 'error', reason: 'exception' };
  }
}

/**
 * A self-host install without the billing subsystem, detected exactly as
 * checkEntitlementFromDB detects it (the explicit SELF_HOST_BILLING_MODE flag
 * AND check_workspace_entitlement absent): everything is allowed. The
 * module/channel RPCs belong to that same missing subsystem, so without this
 * every module check answered 503 there. Hosted deployments never set the
 * flag and never reach it.
 */
async function selfHostUnlimited(
  supabaseUrl: string,
  serviceRoleKey: string,
  workspaceId: string,
  key: string,
): Promise<EntitlementResult | null> {
  const probe = await checkEntitlementFromDB(supabaseUrl, serviceRoleKey, workspaceId, key, { selfHostBillingUnlimited: true });
  return probe.reason === SELF_HOST_UNLIMITED ? probe : null;
}

/**
 * The module/channel RPCs report a plan denial without saying whether the
 * plan said no or never mentioned the key; the entitlement RPC does, and the
 * registry default decides the second case.
 */
async function planDenialOrDefault(
  supabaseUrl: string,
  serviceRoleKey: string,
  workspaceId: string,
  key: string,
  denial: EntitlementResult,
): Promise<EntitlementResult> {
  const plan = await checkEntitlementFromDB(supabaseUrl, serviceRoleKey, workspaceId, key);
  return plan.reason === REGISTRY_DEFAULT ? plan : denial;
}

// ─── Module access (plan + override) ───
export async function checkModuleAccess(
  supabaseUrl: string,
  serviceRoleKey: string,
  workspaceId: string,
  moduleKey: string,
  opts: { selfHostBillingUnlimited?: boolean } = {},
): Promise<EntitlementResult> {
  if (opts.selfHostBillingUnlimited) {
    const unlimited = await selfHostUnlimited(supabaseUrl, serviceRoleKey, workspaceId, moduleKey);
    if (unlimited) return unlimited;
  }
  try {
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const { data, error } = await supabase.rpc('check_module_access', {
      _workspace_id: workspaceId,
      _module_key: moduleKey,
    });
    const parsed = parseEntitlementResponse(data, error);
    if (parsed.outcome === 'unavailable') {
      console.error('[ModuleGating] Unreadable module result:', parsed.reason, error?.message);
      return { allowed: false, reason: parsed.reason };
    }
    const result: EntitlementResult = { allowed: parsed.allowed === true, plan: parsed.plan, reason: parsed.reason };
    if (!result.allowed && parsed.reason === 'plan') {
      return await planDenialOrDefault(supabaseUrl, serviceRoleKey, workspaceId, moduleKey, result);
    }
    return result;
  } catch {
    return { allowed: false, reason: 'exception' };
  }
}

// ─── Channel access (plan + override) ───
export async function checkChannelAccess(
  supabaseUrl: string,
  serviceRoleKey: string,
  workspaceId: string,
  channelKey: string,
  opts: { selfHostBillingUnlimited?: boolean } = {},
): Promise<EntitlementResult> {
  if (opts.selfHostBillingUnlimited) {
    const unlimited = await selfHostUnlimited(supabaseUrl, serviceRoleKey, workspaceId, channelKey);
    if (unlimited) return unlimited;
  }
  try {
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const { data, error } = await supabase.rpc('check_channel_access', {
      _workspace_id: workspaceId,
      _channel_key: channelKey,
    });
    if (error) {
      console.error('[ChannelGating] RPC error:', error.message);
      return { allowed: false, reason: 'rpc_error' };
    }
    const row = (data && typeof data === 'object' ? data : {}) as { allowed?: unknown; plan?: unknown; source?: unknown };
    const result: EntitlementResult = {
      allowed: row.allowed === true,
      plan: typeof row.plan === 'string' ? row.plan : undefined,
      reason: typeof row.source === 'string' ? row.source : undefined,
    };
    if (!result.allowed && result.reason === 'plan') {
      return await planDenialOrDefault(supabaseUrl, serviceRoleKey, workspaceId, channelKey, result);
    }
    return result;
  } catch {
    return { allowed: false, reason: 'exception' };
  }
}

// ─── AI credit deduction (atomic) ───
export async function deductAICredits(
  supabaseUrl: string,
  serviceRoleKey: string,
  workspaceId: string,
  credits: number = 1
): Promise<{ success: boolean; credits_used?: number; credits_limit?: number; credits_remaining?: number; reason?: string }> {
  try {
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const { data, error } = await supabase.rpc('deduct_ai_credits', {
      _workspace_id: workspaceId,
      _credits: credits,
    });
    if (error) {
      console.error('[AICredits] RPC error:', error.message);
      return { success: false, reason: 'rpc_error' };
    }
    return data || { success: false, reason: 'no_response' };
  } catch {
    return { success: false, reason: 'exception' };
  }
}

// ─── Increment usage counter ───
export async function incrementUsage(
  supabaseUrl: string,
  serviceRoleKey: string,
  workspaceId: string,
  counter: string,
  amount: number = 1
): Promise<void> {
  try {
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    await supabase.rpc('increment_usage_counter', {
      _workspace_id: workspaceId,
      _counter_name: counter,
      _amount: amount,
    });
  } catch (err) {
    console.error('[UsageTracking] Error:', errorMessage(err));
  }
}

// ═══════════════════════════════════════════════════════════
// Express Middleware Factories
// ═══════════════════════════════════════════════════════════

/**
 * Require a feature entitlement from the plan.
 */
export function requireFeature(feature: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const sb = getSupabaseClient(req);
    if (!sb) return next();

    const workspaceId = extractWorkspaceId(req);
    if (!workspaceId) {
      return res.status(400).json({ error: 'Missing workspaceId for feature check' });
    }

    const result = await checkEntitlementFromDB(sb.config.supabaseUrl, sb.config.supabaseServiceRoleKey, workspaceId, feature, {
      selfHostBillingUnlimited: sb.config.selfHostBillingUnlimited === true,
    });

    // Phase 6-S5-R7.3 §2 — an UNREADABLE entitlement is a retryable outage,
    // not a plan denial. Answering 403 "upgrade required" sends the customer
    // to a checkout page that cannot fix anything.
    if (isUnreadableEntitlementReason(result.reason)) {
      return res.status(503).json({ error: 'entitlement_status_unavailable', retryable: true });
    }

    if (!result.allowed) {
      return res.status(403).json({
        error: 'Feature not available on your current plan',
        feature, plan: result.plan, reason: result.reason, upgrade_required: true,
      });
    }

    (req as GatedRequest).entitlement = result;
    next();
  };
}

/**
 * Require a module to be enabled (plan + admin override).
 */
export function requireModule(moduleKey: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const sb = getSupabaseClient(req);
    if (!sb) return next();

    const workspaceId = extractWorkspaceId(req);
    if (!workspaceId) {
      return res.status(400).json({ error: 'Missing workspaceId for module check' });
    }

    if (await enforceModule(req, res, workspaceId, moduleKey)) next();
  };
}

/**
 * The module check behind {@link requireModule}, for a handler that has to
 * authorize the caller first. Writes the 403/503 itself and returns false
 * when the caller must stop.
 */
export async function enforceModule(req: Request, res: Response, workspaceId: string, moduleKey: string): Promise<boolean> {
  const sb = getSupabaseClient(req);
  if (!sb) return true;
  const result = await checkModuleAccess(sb.config.supabaseUrl, sb.config.supabaseServiceRoleKey, workspaceId, moduleKey, {
    selfHostBillingUnlimited: sb.config.selfHostBillingUnlimited === true,
  });

  // R7.4 §7 — an unreadable module RPC is an outage, not a plan denial.
  if (isUnreadableEntitlementReason(result.reason)) {
    res.status(503).json({
      error: 'module_status_unavailable',
      module: moduleKey,
      retryable: true,
    });
    return false;
  }

  if (!result.allowed) {
    res.status(403).json({
      error: `Module '${moduleKey}' is not enabled`,
      module: moduleKey, plan: result.plan, upgrade_required: true,
    });
    return false;
  }
  return true;
}

/**
 * Require a channel to be enabled (plan + admin override).
 */
export function requireChannel(channelKey: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const sb = getSupabaseClient(req);
    if (!sb) return next();

    const workspaceId = extractWorkspaceId(req);
    if (!workspaceId) {
      return res.status(400).json({ error: 'Missing workspaceId for channel check' });
    }

    const result = await checkChannelAccess(sb.config.supabaseUrl, sb.config.supabaseServiceRoleKey, workspaceId, channelKey, {
      selfHostBillingUnlimited: sb.config.selfHostBillingUnlimited === true,
    });

    if (!result.allowed) {
      return res.status(403).json({
        error: `Channel '${channelKey}' is not available on your plan`,
        channel: channelKey, upgrade_required: true,
      });
    }

    next();
  };
}

/**
 * Require AI credits before allowing AI request. Deducts atomically.
 */
export function requireAICredits(credits: number = 1) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const sb = getSupabaseClient(req);
    if (!sb) return next();

    const workspaceId = extractWorkspaceId(req);
    if (!workspaceId) {
      return res.status(400).json({ error: 'Missing workspaceId for AI credit check' });
    }

    const result = await deductAICredits(sb.config.supabaseUrl, sb.config.supabaseServiceRoleKey, workspaceId, credits);

    // R7.4 §7 — the credit RPC could not be evaluated. That is NOT credit
    // exhaustion, so it must never render as "upgrade required".
    if (!result.success && (result.reason === 'rpc_error' || result.reason === 'exception' || result.reason === 'no_response')) {
      return res.status(503).json({
        error: 'ai_credit_status_unavailable',
        retryable: true,
      });
    }

    if (!result.success) {
      return res.status(403).json({
        error: 'AI credits exhausted or AI not available on your plan',
        reason: result.reason,
        credits_used: result.credits_used,
        credits_limit: result.credits_limit,
        upgrade_required: true,
      });
    }

    (req as GatedRequest).aiCredits = result;
    next();
  };
}

/**
 * Check a numeric limit (e.g., max agents) against current usage.
 */
export function requireLimit(
  feature: string,
  currentUsageFn: (req: Request, workspaceId: string) => Promise<number>
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const sb = getSupabaseClient(req);
    if (!sb) return next();

    const workspaceId = extractWorkspaceId(req);
    if (!workspaceId) {
      return res.status(400).json({ error: 'Missing workspaceId for limit check' });
    }

    // R7.4 §6/§8 — numeric mode: `allowed:true` without a usable numeric
    // limit is UNREADABLE, never "limit zero".
    const result = await checkEntitlementFromDB(
      sb.config.supabaseUrl,
      sb.config.supabaseServiceRoleKey,
      workspaceId,
      feature,
      { numeric: true, selfHostBillingUnlimited: sb.config.selfHostBillingUnlimited === true },
    );

    if (isUnreadableEntitlementReason(result.reason)) {
      return res.status(503).json({
        error: 'entitlement_status_unavailable',
        feature,
        retryable: true,
      });
    }

    if (!result.allowed) {
      return res.status(403).json({
        error: 'Feature not available on your current plan',
        feature, plan: result.plan, upgrade_required: true,
      });
    }

    if (result.limit !== -1) {
      let currentUsage: number;
      try {
        currentUsage = await currentUsageFn(req, workspaceId);
      } catch {
        // FAIL-CLOSED: if we cannot determine usage we deny the operation,
        // but as a retryable 503 — the customer's plan is not the problem.
        return res.status(503).json({
          error: 'usage_status_unavailable',
          feature,
          retryable: true,
        });
      }
      if (currentUsage >= result.limit) {
        return res.status(403).json({
          error: `Limit reached: ${feature}`,
          feature, plan: result.plan, limit: result.limit, used: currentUsage,
          upgrade_required: true,
        });
      }
    }

    (req as GatedRequest).entitlement = result;
    next();
  };
}

/** A `billing_plans` row as the plan lookups read it (select *). */
export interface BillingPlanRow {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  is_free?: boolean | null;
  localized?: Record<string, { name?: string | null; description?: string | null } | null | undefined> | null;
  entitlements?: Record<string, unknown> | null;
  limits?: Record<string, unknown> | null;
}

/** A `workspace_subscriptions` row as the plan lookups read it (select *). */
export interface WorkspaceSubscriptionRow extends SubscriptionPlanState {
  workspace_id?: string;
  billing_interval?: string | null;
  past_due_since?: string | null;
  grace_period_ends_at?: string | null;
}

export interface WorkspacePlanInfo {
  /** The plan in force — the assigned one, or Free (planSelection.ts decides). */
  plan: BillingPlanRow;
  subscription: WorkspaceSubscriptionRow | null;
  entitlements: Record<string, boolean>;
  /** The plan's limits with the workspace's limit overrides applied. */
  limits: Record<string, number>;
  /** The plan's own limits, before overrides. */
  planLimits: Record<string, number>;
  /** Super Admin's per-workspace limit overrides (limit key → value). */
  limitOverrides: Record<string, { value: number; note: string | null }>;
}

/**
 * The plan a workspace is on, as every client is shown it and as
 * `check_workspace_entitlement` enforces it (see planSelection.ts).
 * Throws when any of it cannot be read; callers choose how to fail.
 */
export async function getWorkspacePlanInfo(
  supabaseUrl: string,
  serviceRoleKey: string,
  workspaceId: string
): Promise<WorkspacePlanInfo> {
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const [{ data: subRow, error: subError }, { data: overrideRows, error: overrideError }] = await Promise.all([
    supabase.from('workspace_subscriptions').select('*').eq('workspace_id', workspaceId).maybeSingle(),
    supabase.from('workspace_limit_overrides').select('limit_key, limit_value, admin_notes').eq('workspace_id', workspaceId),
  ]);
  if (subError) throw new Error(`workspace_subscription_read_failed:${subError.message}`);
  // Self-host ships without the override tables: absent means none.
  if (overrideError && !isRelationMissing(overrideError, 'workspace_limit_overrides')) {
    throw new Error(`workspace_limit_overrides_read_failed:${overrideError.message}`);
  }
  const sub = (subRow as WorkspaceSubscriptionRow | null) ?? null;

  let plan: BillingPlanRow | null = null;
  if (sub?.plan_id && assignedPlanApplies(sub)) {
    const { data: assignedPlan, error: planError } = await supabase
      .from('billing_plans')
      .select('*')
      .eq('id', sub.plan_id)
      .maybeSingle();
    if (planError) throw new Error(`workspace_plan_read_failed:${planError.message}`);
    plan = (assignedPlan as BillingPlanRow | null) ?? null;
  }

  // No subscription, a subscription that no longer grants its plan, or a plan
  // row that is gone: the Free plan applies.
  if (!plan) {
    const { data: freePlan, error: freeError } = await supabase
      .from('billing_plans')
      .select('*')
      .eq('slug', 'free')
      .eq('is_active', true)
      .maybeSingle();
    if (freeError) throw new Error(`free_plan_read_failed:${freeError.message}`);
    if (!freePlan) throw new Error('free_plan_not_found');
    plan = freePlan as BillingPlanRow;
  }

  if (typeof plan.slug !== 'string' || !plan.slug.trim()) {
    throw new Error('resolved_plan_has_no_valid_slug');
  }

  const planLimits = (plan.limits as Record<string, number> | null | undefined) || {};
  const limitOverrides: WorkspacePlanInfo['limitOverrides'] = {};
  for (const row of (overrideRows || []) as Array<{ limit_key: string; limit_value: number; admin_notes?: string | null }>) {
    if (typeof row.limit_key === 'string' && typeof row.limit_value === 'number' && Number.isFinite(row.limit_value)) {
      limitOverrides[row.limit_key] = { value: row.limit_value, note: row.admin_notes ?? null };
    }
  }
  const limits: Record<string, number> = { ...planLimits };
  for (const [limitKey, override] of Object.entries(limitOverrides)) limits[limitKey] = override.value;

  return {
    plan,
    subscription: sub,
    entitlements: (plan.entitlements as Record<string, boolean> | null | undefined) || {},
    limits,
    planLimits,
    limitOverrides,
  };
}

/**
 * Phase 6-S5-R7.3 §3 — fail-closed variant of {@link getWorkspacePlanInfo}.
 *
 * The legacy helper swallows query errors, so an unreachable
 * `workspace_subscriptions` table silently degrades every workspace to the
 * Free plan and the customer sees limits that are not theirs. This variant
 * reports the failure instead.
 */
export async function getWorkspacePlanInfoDetailed(
  supabaseUrl: string,
  serviceRoleKey: string,
  workspaceId: string
): Promise<
  | { ok: true; value: WorkspacePlanInfo }
  | { ok: false; errorCode: 'plan_status_unavailable'; retryable: true }
> {
  try {
    return { ok: true, value: await getWorkspacePlanInfo(supabaseUrl, serviceRoleKey, workspaceId) };
  } catch (err) {
    console.error('[FeatureGating] plan info exception:', errorMessage(err));
    return { ok: false, errorCode: 'plan_status_unavailable', retryable: true };
  }
}
