/**
 * Plan limits for a service that enforces them itself (SEO, Web/Bot
 * Analytics, Brand Radar, AI Agent data sources, AI KB Builder).
 *
 * A limit the capability registry defines resolves exactly as
 * GET /api/plans/workspace/:id/effective shows it —
 * `override ?? plan (legacy aliases included) ?? registry default`
 * (effectiveEntitlements.ts) — so a service never enforces a number the
 * workspace is not shown. These services used to fill a key missing from the
 * plan JSON from their own per-plan-slug tables instead, so a Pro plan without
 * the key was shown the registry default and enforced another number.
 *
 * Keys the registry does not define (crawler tuning knobs, legacy AI KB
 * Builder keys) are not plan capabilities and are shown nowhere; they keep a
 * per-plan fallback of their own through {@link unregisteredLimits}.
 */
import type { ServerConfig } from '../../config.js';
import { getWorkspacePlanInfo, type WorkspacePlanInfo } from '../../middleware/featureGating.js';
import { resolveEffectiveLimit } from './effectiveEntitlements.js';

export type PlanLimitSource = Pick<WorkspacePlanInfo, 'plan' | 'limits' | 'planLimits' | 'limitOverrides'>;

/**
 * The plan in force (planSelection.ts), or null when it cannot be read — for
 * instance on a self-host install without billing plans. A null plan
 * resolves every registry limit to its registry default, as a plan that sets
 * nothing would.
 */
export async function readServicePlanInfo(config: ServerConfig, workspaceId: string): Promise<WorkspacePlanInfo | null> {
  try {
    return await getWorkspacePlanInfo(config.supabaseUrl, config.supabaseServiceRoleKey, workspaceId);
  } catch {
    return null;
  }
}

/** The plan's slug ('free' when unreadable) and name, as the services report them. */
export function servicePlanIdentity(info: PlanLimitSource | null | undefined): { planSlug: string; planName: string | null } {
  return { planSlug: info?.plan?.slug || 'free', planName: info?.plan?.name || null };
}

/**
 * Registry limits by key, each `override ?? plan ?? registry default`. A key
 * without a numeric registry default resolves to 0 (fail-closed); the
 * services' key lists are pinned against the registry by tests.
 */
export function registryLimits<K extends string>(info: PlanLimitSource | null | undefined, keys: readonly K[]): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const key of keys) out[key] = resolveEffectiveLimit(info, key) ?? 0;
  return out;
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Limits the registry does not define: the plan's value (workspace override
 * applied) or the service's own fallback for the plan's slug (Free's for an
 * unknown slug or an unreadable plan).
 */
export function unregisteredLimits<K extends string>(
  info: PlanLimitSource | null | undefined,
  fallbacks: Readonly<Record<string, Readonly<Record<K, number>>>> & { free: Readonly<Record<K, number>> },
): Record<K, number> {
  const fallback = fallbacks[servicePlanIdentity(info).planSlug] || fallbacks.free;
  const values: Record<string, unknown> = info?.limits || {};
  const out = {} as Record<K, number>;
  for (const key of Object.keys(fallback) as K[]) out[key] = finiteNumber(values[key]) ?? fallback[key];
  return out;
}
