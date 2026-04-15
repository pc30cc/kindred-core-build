// ============================================
// FEATURE GATING MIDDLEWARE — Backend enforcement of plan limits
// ============================================

import { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';

interface EntitlementResult {
  allowed: boolean;
  limit?: number;
  plan?: string;
}

/**
 * Cache entitlement results for 60 seconds to avoid DB hammering.
 */
const cache = new Map<string, { result: EntitlementResult; expiresAt: number }>();
const CACHE_TTL = 60_000;

function cacheKey(workspaceId: string, feature: string): string {
  return `${workspaceId}:${feature}`;
}

export function clearEntitlementCache(workspaceId?: string): void {
  if (!workspaceId) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(workspaceId)) cache.delete(key);
  }
}

/**
 * Check entitlement via the DB function.
 */
export async function checkEntitlementFromDB(
  supabaseUrl: string,
  serviceRoleKey: string,
  workspaceId: string,
  feature: string
): Promise<EntitlementResult> {
  const key = cacheKey(workspaceId, feature);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const { data, error } = await supabase.rpc('check_workspace_entitlement', {
    _workspace_id: workspaceId,
    _feature: feature,
  });

  if (error) {
    console.error('[FeatureGating] RPC error:', error.message);
    // FAIL-CLOSED: deny on error
    return { allowed: false, plan: 'error' };
  }

  const result: EntitlementResult = {
    allowed: data?.allowed ?? false,
    limit: data?.limit,
    plan: data?.plan,
  };

  cache.set(key, { result, expiresAt: Date.now() + CACHE_TTL });
  return result;
}

/**
 * Express middleware factory — blocks request if feature is not allowed.
 *
 * Usage:
 *   router.post('/ai/chat', requireFeature('ai_assistant'), handler);
 *
 * Expects `workspaceId` in req.body, req.query, or req.params.
 */
export function requireFeature(feature: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const config = (req as any).serverConfig;
    if (!config) return next(); // No server config = skip gating

    const workspaceId =
      (req.body as any)?.workspaceId ||
      (req.body as any)?.workspace_id ||
      (req.query as any)?.workspaceId ||
      (req.query as any)?.workspace_id ||
      (req.params as any)?.workspaceId;

    if (!workspaceId) {
      return res.status(400).json({ error: 'Missing workspaceId for feature check' });
    }

    const result = await checkEntitlementFromDB(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      workspaceId,
      feature
    );

    if (!result.allowed) {
      return res.status(403).json({
        error: 'Feature not available on your current plan',
        feature,
        plan: result.plan,
        upgrade_required: true,
      });
    }

    // Attach entitlement info to request for downstream use
    (req as any).entitlement = result;
    next();
  };
}

/**
 * Check a numeric limit (e.g., max agents, max AI credits).
 * `currentUsageFn` is called to get the current usage count.
 */
export function requireLimit(
  feature: string,
  currentUsageFn: (req: Request, workspaceId: string) => Promise<number>
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const config = (req as any).serverConfig;
    if (!config) return next();

    const workspaceId =
      (req.body as any)?.workspaceId ||
      (req.body as any)?.workspace_id ||
      (req.query as any)?.workspaceId ||
      (req.query as any)?.workspace_id ||
      (req.params as any)?.workspaceId;

    if (!workspaceId) {
      return res.status(400).json({ error: 'Missing workspaceId for limit check' });
    }

    const result = await checkEntitlementFromDB(
      config.supabaseUrl,
      config.supabaseServiceRoleKey,
      workspaceId,
      feature
    );

    if (!result.allowed) {
      return res.status(403).json({
        error: 'Feature not available on your current plan',
        feature,
        plan: result.plan,
        upgrade_required: true,
      });
    }

    // If there's a limit, check current usage
    if (result.limit !== undefined && result.limit !== -1) {
      const currentUsage = await currentUsageFn(req, workspaceId);
      if (currentUsage >= result.limit) {
        return res.status(403).json({
          error: `Limit reached: ${feature}`,
          feature,
          plan: result.plan,
          limit: result.limit,
          used: currentUsage,
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
    .select('*, billing_plans(*)')
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  let plan = sub?.billing_plans;

  // Fallback to free plan
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
