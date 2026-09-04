// ============================================================
// ADMIN PLAN GRANT — the only V2-legal way a platform admin can put a
// workspace on a plan without money moving.
//
// Under Billing V2 the workspace_subscriptions row is a projection of the
// ACTIVE service period: a direct upsert is rejected by
// billing_v2_block_direct_subscription_mutation. So an admin grant creates a
// comped period (source = 'admin', no invoice) and activates it through the
// canonical billing_activate_period RPC, which also grants the plan AI
// allowance exactly once, bound to that period.
// ============================================================

import { createClient } from '@supabase/supabase-js';
import type { ServerConfig } from '../../config.js';

type Interval = 'monthly' | 'yearly';

function allowanceIrr(plan: any, interval: Interval): number {
  const monthly = Number(plan?.limits?.included_ai_allowance_irr ?? plan?.limits?.ai_credits_per_month ?? 0);
  if (!Number.isFinite(monthly) || monthly <= 0) return 0;
  return Math.round(interval === 'yearly' ? monthly * 12 : monthly);
}

export async function adminGrantPlanV2(
  config: ServerConfig,
  input: { workspaceId: string; planId: string; expiresAt?: string | null; interval?: Interval },
) {
  const sb = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);

  const { data: plan, error: planError } = await sb
    .from('billing_plans')
    .select('*')
    .eq('id', input.planId)
    .maybeSingle();
  if (planError || !plan) throw new Error('unknown_plan');

  const interval: Interval = input.interval ?? 'monthly';
  const start = new Date();
  const end = input.expiresAt
    ? new Date(input.expiresAt)
    : new Date(
        Date.UTC(
          start.getUTCFullYear() + (interval === 'yearly' ? 1 : 0),
          start.getUTCMonth() + (interval === 'yearly' ? 0 : 1),
          start.getUTCDate(),
          start.getUTCHours(),
          start.getUTCMinutes(),
          start.getUTCSeconds(),
        ),
      );
  if (!(end.getTime() > start.getTime())) throw new Error('invalid_period_end');

  const { data: sub } = await sb
    .from('workspace_subscriptions')
    .select('id')
    .eq('workspace_id', input.workspaceId)
    .maybeSingle();

  const { data: period, error: periodError } = await sb
    .from('billing_subscription_periods')
    .insert({
      workspace_id: input.workspaceId,
      subscription_id: (sub as any)?.id ?? null,
      plan_id: input.planId,
      invoice_id: null,
      billing_interval: interval,
      period_start: start.toISOString(),
      period_end: end.toISOString(),
      status: 'scheduled',
      source: 'admin',
      plan_snapshot: plan,
      limits_snapshot: (plan as any).limits ?? {},
      ai_allowance_irr: allowanceIrr(plan, interval),
    })
    .select()
    .single();
  if (periodError || !period) throw new Error(periodError?.message || 'period_insert_failed');

  const { error: activateError } = await sb.rpc('billing_activate_period', {
    p_period_id: (period as any).id,
  });
  if (activateError) throw new Error(activateError.message);

  const { data: updated } = await sb
    .from('workspace_subscriptions')
    .select('*')
    .eq('workspace_id', input.workspaceId)
    .maybeSingle();

  return updated;
}
