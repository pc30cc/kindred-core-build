// ============================================
// FEATURE GATING MIDDLEWARE — Backend enforcement of plan limits,
// modules, channels, AI credits. Strictly fail-closed.
// ============================================

import { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';
import {
  parseEntitlementResponse,
  parseNumericEntitlementResponse,
  isUnreadableEntitlementReason,
  isCheckWorkspaceEntitlementFunctionMissing,
} from '../services/billing/entitlementParse.js';

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

function cacheKey(workspaceId: string, feature: string): string {
  return `${workspaceId}:${feature}`;
}

export function clearEntitlementCache(workspaceId?: string): void {
  if (!workspaceId) { cache.clear(); return; }
  for (const key of cache.keys()) {
    if (key.startsWith(workspaceId)) cache.delete(key);
  }
}

function extractWorkspaceId(req: Request): string | undefined {
  return (req.body as any)?.workspaceId
    || (req.body as any)?.workspace_id
    || (req.query as any)?.workspaceId
    || (req.query as any)?.workspace_id
    || (req.params as any)?.workspaceId;
}

function getSupabaseClient(req: Request) {
  const config = (req as any).serverConfig;
  if (!config?.supabaseUrl || !config?.supabaseServiceRoleKey) return null;
  return { client: createClient(config.supabaseUrl, config.supabaseServiceRoleKey), config };
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
        reason: 'self_host_billing_schema_absent',
      };
      cache.set(key, { result, expiresAt: Date.now() + CACHE_TTL });
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

    const result: EntitlementResult = {
      allowed: parsed.allowed === true,
      limit: parsed.limit,
      limitValid: parsed.limitValid === true,
      plan: parsed.plan,
      reason: parsed.reason,
    };

    cache.set(key, { result, expiresAt: Date.now() + CACHE_TTL });
    return result;
  } catch (err: any) {
    console.error('[FeatureGating] Exception:', err.message);
    return { allowed: false, plan: 'error', reason: 'exception' };
  }
}

// ─── Module access (plan + override) ───
export async function checkModuleAccess(
  supabaseUrl: string,
  serviceRoleKey: string,
  workspaceId: string,
  moduleKey: string
): Promise<EntitlementResult> {
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
    return { allowed: parsed.allowed === true, plan: parsed.plan, reason: parsed.reason };
  } catch {
    return { allowed: false, reason: 'exception' };
  }
}

// ─── Channel access (plan + override) ───
export async function checkChannelAccess(
  supabaseUrl: string,
  serviceRoleKey: string,
  workspaceId: string,
  channelKey: string
): Promise<EntitlementResult> {
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
    return { allowed: data?.allowed ?? false, plan: data?.plan, reason: data?.source };
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
  } catch (err: any) {
    console.error('[UsageTracking] Error:', err.message);
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

    (req as any).entitlement = result;
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

    const result = await checkModuleAccess(sb.config.supabaseUrl, sb.config.supabaseServiceRoleKey, workspaceId, moduleKey);

    // R7.4 §7 — an unreadable module RPC is an outage, not a plan denial.
    if (isUnreadableEntitlementReason(result.reason)) {
      return res.status(503).json({
        error: 'module_status_unavailable',
        module: moduleKey,
        retryable: true,
      });
    }

    if (!result.allowed) {
      return res.status(403).json({
        error: `Module '${moduleKey}' is not enabled`,
        module: moduleKey, plan: result.plan, upgrade_required: true,
      });
    }

    next();
  };
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

    const result = await checkChannelAccess(sb.config.supabaseUrl, sb.config.supabaseServiceRoleKey, workspaceId, channelKey);

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

    (req as any).aiCredits = result;
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

    (req as any).entitlement = result;
    next();
  };
}

/**
 * Get full workspace plan info (for frontend).
 */
export async function getWorkspacePlanInfo(
  supabaseUrl: string,
  serviceRoleKey: string,
  workspaceId: string
): Promise<{
  plan: any;
  subscription: any;
  entitlements: Record<string, boolean>;
  limits: Record<string, number>;
}> {
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const { data: sub } = await supabase
    .from('workspace_subscriptions')
    .select('*, billing_plans!workspace_subscriptions_plan_id_fkey(*)')
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  let plan = sub?.billing_plans;

  if (!plan || !sub || !['active', 'trialing'].includes(sub.status)) {
    const { data: freePlan } = await supabase
      .from('billing_plans')
      .select('*')
      .eq('slug', 'free')
      .eq('is_active', true)
      .maybeSingle();
    plan = freePlan;
  }

  return {
    plan: plan || null,
    subscription: sub ? { ...sub, billing_plans: undefined } : null,
    entitlements: (plan?.entitlements as Record<string, boolean>) || {},
    limits: (plan?.limits as Record<string, number>) || {},
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
  | { ok: true; value: { plan: any; subscription: any; entitlements: Record<string, boolean>; limits: Record<string, number> } }
  | { ok: false; errorCode: 'plan_status_unavailable'; retryable: true }
> {
  try {
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const { data: sub, error: subError } = await supabase
      .from('workspace_subscriptions')
      .select('*, billing_plans!workspace_subscriptions_plan_id_fkey(*)')
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    if (subError) {
      console.error('[FeatureGating] subscription read failed:', subError.message);
      return { ok: false, errorCode: 'plan_status_unavailable', retryable: true };
    }

    let plan = (sub as any)?.billing_plans;

    if (!plan || !sub || !['active', 'trialing'].includes((sub as any).status)) {
      const { data: freePlan, error: freeError } = await supabase
        .from('billing_plans')
        .select('*')
        .eq('slug', 'free')
        .eq('is_active', true)
        .maybeSingle();
      if (freeError) {
        console.error('[FeatureGating] free plan read failed:', freeError.message);
        return { ok: false, errorCode: 'plan_status_unavailable', retryable: true };
      }
      // R7.4 §9 — "no active Free plan row" is a BROKEN catalogue, not a
      // valid Free entitlement. Synthesising Free limits here would hand out
      // an allowance the operator never configured.
      if (!freePlan) {
        console.error('[FeatureGating] no active free plan row found');
        return { ok: false, errorCode: 'plan_status_unavailable', retryable: true };
      }
      plan = freePlan;
    }

    // R7.4 §9 — a plan row without a usable slug cannot drive limits.
    if (!plan || typeof (plan as any).slug !== 'string' || !(plan as any).slug.trim()) {
      console.error('[FeatureGating] resolved plan row has no valid slug');
      return { ok: false, errorCode: 'plan_status_unavailable', retryable: true };
    }

    return {
      ok: true,
      value: {
        plan,
        subscription: sub ? { ...(sub as any), billing_plans: undefined } : null,
        entitlements: (plan?.entitlements as Record<string, boolean>) || {},
        limits: (plan?.limits as Record<string, number>) || {},
      },
    };
  } catch (err: any) {
    console.error('[FeatureGating] plan info exception:', err?.message);
    return { ok: false, errorCode: 'plan_status_unavailable', retryable: true };
  }
}
