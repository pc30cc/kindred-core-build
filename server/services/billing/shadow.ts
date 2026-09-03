// ============================================================
// SHADOW COMPARATOR — V2 computes, V1 still decides.
//
// HARD RULE: nothing in this module writes a financial row. No invoice is
// settled, no wallet is debited, no period is activated, no AI allowance is
// granted. Shadow mode exists to prove V2 would produce the same answer as V1
// BEFORE any workspace is trusted to it; a shadow run with a financial side
// effect would defeat its entire purpose.
//
// The only writes here are audit/metric rows.
// ============================================================

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { auditV2, bumpMetric, getRolloutState } from './rollout.js';
import { computeSubscriptionWindow, type BillingInterval } from './periods.js';
import { INVOICE_LEAD_TIME_DAYS } from './readModel.js';

export interface ShadowComparison {
  workspaceId: string;
  state: string;
  compared: boolean;
  mismatches: Array<{ field: string; v1: unknown; v2: unknown }>;
  expected: {
    periodStart: string | null;
    periodEnd: string | null;
    planId: string | null;
    aiAllowanceIrr: number;
    nextInvoiceAt: string | null;
    renewalInvoiceEligible: boolean;
  };
}

/**
 * Compares the V1 subscription contract with what V2 would compute for the
 * same workspace, and records drift. Safe to call on any workspace in any
 * state — it never mutates financial state.
 */
export async function compareShadow(
  config: ServerConfig,
  workspaceId: string,
): Promise<ShadowComparison> {
  const sb = getServiceClient(config);
  const state = await getRolloutState(config, workspaceId);

  const { data: sub } = await sb
    .from('workspace_subscriptions')
    .select('plan_id, status, billing_interval, current_period_start, current_period_end')
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (!sub) {
    return {
      workspaceId,
      state,
      compared: false,
      mismatches: [],
      expected: {
        periodStart: null,
        periodEnd: null,
        planId: null,
        aiAllowanceIrr: 0,
        nextInvoiceAt: null,
        renewalInvoiceEligible: false,
      },
    };
  }

  const { data: period } = await sb
    .from('billing_subscription_periods')
    .select('plan_id, period_start, period_end, ai_allowance_irr')
    .eq('workspace_id', workspaceId)
    .eq('status', 'active')
    .maybeSingle();

  const plan = sub.plan_id
    ? (await sb.from('billing_plans').select('id, limits').eq('id', sub.plan_id).maybeSingle()).data
    : null;

  const planAllowance = Number(
    (plan as any)?.limits?.included_ai_allowance_irr ?? (plan as any)?.limits?.ai_credits_per_month ?? 0,
  );

  const interval = ((sub.billing_interval as string) || 'monthly') as BillingInterval;
  const window = computeSubscriptionWindow({
    action: 'plan_renewal',
    interval,
    now: new Date(),
    currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end as string) : null,
  });

  const mismatches: ShadowComparison['mismatches'] = [];
  if (period) {
    if (String(period.period_end) !== String(sub.current_period_end)) {
      mismatches.push({ field: 'period_end', v1: sub.current_period_end, v2: period.period_end });
      bumpMetric('billing_v2_shadow_period_mismatch');
    }
    if ((period.plan_id ?? null) !== (sub.plan_id ?? null)) {
      mismatches.push({ field: 'plan_id', v1: sub.plan_id, v2: period.plan_id });
      bumpMetric('billing_v2_shadow_plan_mismatch');
    }
    if (Number(period.ai_allowance_irr ?? 0) !== planAllowance) {
      mismatches.push({
        field: 'ai_allowance_irr',
        v1: planAllowance,
        v2: Number(period.ai_allowance_irr ?? 0),
      });
      bumpMetric('billing_v2_shadow_allowance_mismatch');
    }
  }

  const periodEnd = (period?.period_end as string | undefined) || (sub.current_period_end as string | undefined) || null;
  const renewalInvoiceEligible = periodEnd
    ? new Date(periodEnd).getTime() - Date.now() <= INVOICE_LEAD_TIME_DAYS * 86_400_000
    : false;

  const comparison: ShadowComparison = {
    workspaceId,
    state,
    compared: true,
    mismatches,
    expected: {
      periodStart: (period?.period_start as string | undefined) ?? window.start.toISOString(),
      periodEnd: (period?.period_end as string | undefined) ?? window.end.toISOString(),
      planId: (sub.plan_id as string | null) ?? null,
      aiAllowanceIrr: planAllowance,
      nextInvoiceAt: periodEnd,
      renewalInvoiceEligible,
    },
  };

  if (mismatches.length > 0) {
    await auditV2(config, {
      workspaceId,
      event: 'billing_v2_shadow_mismatch',
      details: { mismatches, state },
    });
  }

  return comparison;
}
