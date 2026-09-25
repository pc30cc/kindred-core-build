/**
 * Platform-owned "Powered by" footer resolution.
 *
 * Ownership contract:
 *  - Wording, brand label and outbound link live ONLY on the singleton
 *    `widget_platform_settings` row (platform admin). Workspace owners have
 *    no input — `workspace_branding.platform_name` is never read here.
 *  - Visibility = platform master switch AND the plan entitlement
 *    `widget_powered_by` (super admin decides which plans show it).
 *
 * Fail-open: any read error keeps the footer visible, matching the previous
 * always-on behaviour.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { assignedPlanApplies, type SubscriptionPlanState } from '../billing/planSelection.js';

export interface PoweredByConfig {
  /** Prefix text, e.g. "Powered by". Empty => widget locale default. */
  text: string;
  /** Brand label rendered after the prefix. */
  brand: string;
  /** Absolute URL opened on click, or null when not clickable. */
  url: string | null;
}

export const POWERED_BY_ENTITLEMENT_KEY = 'widget_powered_by';

/**
 * Plan gate. Returns true unless the workspace's plan explicitly sets
 * `widget_powered_by: false`. Missing key / missing plan => visible
 * (registry default for this capability is `true`).
 */
export async function isPoweredByAllowedForPlan(
  sb: Pick<SupabaseClient, 'from'>,
  workspaceId: string,
): Promise<boolean> {
  try {
    const { data } = await sb
      .from('workspace_subscriptions')
      .select('plan_id, status, trial_end, free_fallback_at, cancel_at_period_end, current_period_end')
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    const sub = data as SubscriptionPlanState | null;

    // The plan in force by the one rule (planSelection.ts) every other plan
    // reader uses.
    const planQuery = sub?.plan_id && assignedPlanApplies(sub)
      ? sb.from('billing_plans').select('entitlements').eq('id', sub.plan_id).maybeSingle()
      : sb.from('billing_plans').select('entitlements').eq('slug', 'free').maybeSingle();

    const { data: plan } = await planQuery;
    const entitlements = (plan?.entitlements || {}) as Record<string, unknown>;
    if (POWERED_BY_ENTITLEMENT_KEY in entitlements) {
      return entitlements[POWERED_BY_ENTITLEMENT_KEY] !== false;
    }
    // Legacy inverse flag stays honoured: a plan that removes the credit hides it.
    if (entitlements.remove_powered_by === true) return false;
    return true;
  } catch {
    return true;
  }
}

/**
 * Build the widget-facing footer payload. Returns null when the footer must
 * not render at all (platform switch off or plan disallows it).
 */
export function buildPoweredByConfig(
  platformWidget: Record<string, unknown> | null | undefined,
  platformBrandName: string,
  planAllows: boolean,
): PoweredByConfig | null {
  if (!planAllows) return null;
  if (platformWidget && platformWidget.powered_by_enabled === false) return null;

  const brand = String(platformWidget?.powered_by_brand_text || '').trim() || platformBrandName.trim();
  if (!brand) return null;

  const rawUrl = String(platformWidget?.powered_by_url || '').trim();
  const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : null;

  return {
    text: String(platformWidget?.powered_by_text || '').trim(),
    brand,
    url,
  };
}
