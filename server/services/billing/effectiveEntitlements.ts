/**
 * The effective entitlement snapshot — what GET /api/plans/workspace/:id/effective
 * returns and every client (web, mobile, desktop) renders its sections from.
 *
 * Each capability resolves exactly as server-side enforcement resolves it
 * (featureGating.ts over the check_* RPCs):
 *
 *   module / channel   workspace override ?? plan ?? registry default
 *   feature            plan ?? registry default
 *   limit              workspace override ?? plan ?? registry default
 *
 * with the plan chosen by planSelection.ts. Pure: the caller reads the rows.
 */
import { CAPABILITY_REGISTRY } from './capabilityRegistry.js';
import type { BillingPlanRow, WorkspacePlanInfo, WorkspaceSubscriptionRow } from '../../middleware/featureGating.js';

export type EffectiveSource = 'override' | 'plan' | 'default';

export interface EffectiveFlag {
  value: boolean;
  source: EffectiveSource;
  note?: string | null;
}

export interface EffectiveLimit {
  value: number | null;
  source: EffectiveSource;
  unit?: string;
  note?: string | null;
}

export interface EffectiveEntitlements {
  features: Record<string, EffectiveFlag>;
  modules: Record<string, EffectiveFlag>;
  channels: Record<string, EffectiveFlag>;
  limits: Record<string, EffectiveLimit>;
}

export interface FlagOverrideRow {
  module_key?: string | null;
  channel_key?: string | null;
  enabled: boolean;
  admin_notes?: string | null;
}

/**
 * The boolean a plan JSON value stands for, read the way Postgres reads it
 * (`(entitlements->>key)::boolean` in check_workspace_entitlement): the JSON
 * string "false" is false, not a truthy string.
 */
export function planFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return ['t', 'true', 'y', 'yes', 'on', '1'].includes(value.trim().toLowerCase());
  return false;
}

function overrideMap(rows: FlagOverrideRow[] | null | undefined, keyOf: (row: FlagOverrideRow) => string | null | undefined) {
  const map = new Map<string, FlagOverrideRow>();
  for (const row of rows || []) {
    const key = keyOf(row);
    if (key) map.set(key, row);
  }
  return map;
}

/**
 * Legacy plan keys enforcement still reads when the canonical key is absent
 * (kbArticleQuota.ts), so the snapshot reads them the same way.
 */
const LEGACY_LIMIT_ALIASES: Record<string, readonly string[]> = {
  max_kb_articles: ['ai_kb_max_articles', 'kb_articles'],
};

function finiteNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function resolveEffectiveEntitlements(
  info: Pick<WorkspacePlanInfo, 'entitlements' | 'planLimits' | 'limitOverrides'>,
  moduleOverrides: FlagOverrideRow[] | null | undefined,
  channelOverrides: FlagOverrideRow[] | null | undefined,
): EffectiveEntitlements {
  const planEntitlements: Record<string, unknown> = info.entitlements || {};
  const planLimits: Record<string, unknown> = info.planLimits || {};
  const modules = overrideMap(moduleOverrides, (r) => r.module_key);
  const channels = overrideMap(channelOverrides, (r) => r.channel_key);
  const out: EffectiveEntitlements = { features: {}, modules: {}, channels: {}, limits: {} };

  const flag = (key: string, fallback: unknown, override?: FlagOverrideRow): EffectiveFlag => {
    if (override) return { value: override.enabled === true, source: 'override', note: override.admin_notes ?? null };
    if (key in planEntitlements) return { value: planFlag(planEntitlements[key]), source: 'plan' };
    return { value: fallback === true, source: 'default' };
  };

  for (const cap of CAPABILITY_REGISTRY) {
    switch (cap.type) {
      case 'feature':
        out.features[cap.key] = flag(cap.key, cap.defaultValue);
        break;
      case 'module':
        out.modules[cap.key] = flag(cap.key, cap.defaultValue, modules.get(cap.key));
        break;
      case 'channel':
        out.channels[cap.key] = flag(cap.key, cap.defaultValue, channels.get(cap.key));
        break;
      case 'limit': {
        const override = info.limitOverrides?.[cap.key];
        const planValue = [cap.key, ...(LEGACY_LIMIT_ALIASES[cap.key] ?? [])]
          .map((key) => finiteNumber(planLimits[key]))
          .find((value): value is number => value !== null);
        if (override) {
          out.limits[cap.key] = { value: override.value, source: 'override', unit: cap.unit, note: override.note };
        } else if (planValue !== undefined) {
          out.limits[cap.key] = { value: planValue, source: 'plan', unit: cap.unit };
        } else {
          out.limits[cap.key] = { value: typeof cap.defaultValue === 'number' ? cap.defaultValue : null, source: 'default', unit: cap.unit };
        }
        break;
      }
    }
  }
  return out;
}

/** The plan fields a workspace member may see (no provider price ids, no metadata). */
export function publicPlan(plan: BillingPlanRow) {
  return {
    id: plan.id,
    name: plan.name,
    slug: plan.slug,
    description: plan.description ?? null,
    is_free: plan.is_free ?? null,
    localized: plan.localized ?? null,
  };
}

/** The subscription fields a workspace member may see (no provider ids, no metadata). */
export function publicSubscription(sub: WorkspaceSubscriptionRow | null) {
  if (!sub) return null;
  return {
    status: sub.status ?? null,
    plan_id: sub.plan_id ?? null,
    billing_interval: sub.billing_interval ?? null,
    trial_end: sub.trial_end ?? null,
    current_period_end: sub.current_period_end ?? null,
    cancel_at_period_end: sub.cancel_at_period_end ?? null,
    past_due_since: sub.past_due_since ?? null,
    grace_period_ends_at: sub.grace_period_ends_at ?? null,
    free_fallback_at: sub.free_fallback_at ?? null,
  };
}

/**
 * The snapshot of a self-host install without the billing subsystem, where
 * enforcement allows everything: every capability on, every limit unlimited.
 */
export function unlimitedEntitlements() {
  const out: EffectiveEntitlements = { features: {}, modules: {}, channels: {}, limits: {} };
  for (const cap of CAPABILITY_REGISTRY) {
    if (cap.type === 'feature') out.features[cap.key] = { value: true, source: 'default' };
    else if (cap.type === 'module') out.modules[cap.key] = { value: true, source: 'default' };
    else if (cap.type === 'channel') out.channels[cap.key] = { value: true, source: 'default' };
    else out.limits[cap.key] = { value: -1, source: 'default', unit: cap.unit };
  }
  return {
    plan: { id: 'self-host-unlimited', name: 'Unlimited', slug: 'self-host-unlimited', description: null, is_free: false, localized: null },
    subscription: null,
    ...out,
    usage: null,
    raw: { entitlements: {}, limits: {} },
    billing: 'unlimited' as const,
  };
}

