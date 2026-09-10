/**
 * SIGNUP DEFAULT PLAN — what a brand-new workspace starts on.
 *
 * The operator picks, in Super Admin → Core settings → Signup settings,
 * whether new signups start on the existing Trial plan or the existing Free
 * plan. Stored on the `platform_settings` singleton
 * (database/migrations/153_signup_default_plan.sql) and resolved here.
 *
 * Applies to NEW signups only: this module only ever INSERTS a subscription
 * for a workspace that has none, so changing the setting later never
 * retroactively touches an existing workspace.
 *
 * Express-only; no edge functions.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export type SignupPlanMode = 'free' | 'trial';

export interface SignupPlanPolicy {
  mode: SignupPlanMode;
}

/** Historical behaviour: no subscription row, free-plan fallback. */
export const DEFAULT_SIGNUP_PLAN_POLICY: SignupPlanPolicy = {
  mode: 'free',
};

const CACHE_TTL_MS = 30_000;
let cached: { value: SignupPlanPolicy; at: number } | null = null;

export function invalidateSignupPlanCache(): void {
  cached = null;
}

export async function getSignupPlanPolicy(config: ServerConfig): Promise<SignupPlanPolicy> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  try {
    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('platform_settings')
      .select('signup_default_plan_mode')
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);

    const row = (data || {}) as Record<string, unknown>;
    const value: SignupPlanPolicy = {
      mode: row.signup_default_plan_mode === 'trial' ? 'trial' : 'free',
    };
    cached = { value, at: Date.now() };
    return value;
  } catch (err) {
    console.error('[signup-plan] Falling back to free-plan default:', err);
    return DEFAULT_SIGNUP_PLAN_POLICY;
  }
}

/**
 * Gives a freshly provisioned workspace its starting subscription.
 * No-op when the policy is 'free', when the workspace already has a
 * subscription, or when no suitable paid plan exists.
 */
export async function applySignupPlanToWorkspace(
  config: ServerConfig,
  workspaceId: string,
): Promise<void> {
  const policy = await getSignupPlanPolicy(config);
  if (policy.mode !== 'trial') return;

  const sb = getServiceClient(config);

  const { data: existing } = await sb
    .from('workspace_subscriptions')
    .select('id')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (existing) return;

  const { data } = await sb
    .from('billing_plans')
    .select('id, trial_days')
    .eq('slug', 'trial')
    .eq('is_active', true)
    .eq('is_free', false)
    .maybeSingle();
  const plan = (data as { id: string; trial_days: number | null } | null) || null;
  if (!plan) return;

  // Trial length always comes from the plan's own card (Plans page).
  const days = Number(plan.trial_days);
  if (!Number.isFinite(days) || days <= 0) {
    console.error('[signup-plan] Trial plan has no valid trial_days value');
    return;
  }
  const now = new Date();
  const end = new Date(now.getTime() + days * 86_400_000);

  const { error } = await sb.from('workspace_subscriptions').insert({
    workspace_id: workspaceId,
    plan_id: plan.id,
    provider_name: 'manual',
    status: 'trialing',
    current_period_start: now.toISOString(),
    current_period_end: end.toISOString(),
    trial_end: end.toISOString(),
    metadata: { source: 'signup_default_plan', trial_days: days },
  } as any);
  if (error && !/duplicate key/i.test(error.message)) {
    console.error('[signup-plan] Failed to start trial subscription:', error.message);
  }
}
