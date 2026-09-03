/**
 * DURABLE SUBSCRIPTION APPLICATION IDEMPOTENCY
 *
 * The interleaving this suite exists for (it was previously possible):
 *
 *   intent A verified -> period applied -> CRASH before the payment row
 *   intent B verified -> period applied -> metadata.last_payment_intent_id = B
 *   intent A recovered -> the old marker no longer mentions A -> A applied AGAIN
 *
 * Two real payments would have produced three subscription periods.
 *
 * Idempotency now lives in `billing_subscription_applications`
 * (UNIQUE payment_intent_id), written in the SAME transaction as the
 * subscription mutation by the `billing_apply_subscription_payment` RPC
 * (migration 106). The in-memory RPC below mirrors that SQL exactly —
 * replay guard first, row lock, calendar-safe window, stacked renewal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface ApplicationRow {
  payment_intent_id: string;
  workspace_id: string;
  plan_id: string;
  action_type: string;
  billing_interval: string;
  period_start: string;
  period_end: string;
  stacked: boolean;
}

const WS = 'ws_1';

let applications: ApplicationRow[] = [];
let payments: Array<Record<string, unknown>> = [];
let subscription: {
  plan_id: string | null;
  status: string;
  current_period_start: string | null;
  current_period_end: string | null;
  metadata: Record<string, unknown>;
} | null = null;

const PLANS: Record<string, { name: string; sort_order: number }> = {
  pro: { name: 'Pro', sort_order: 2 },
  business: { name: 'Business', sort_order: 3 },
};

/** Calendar-safe month/year addition, same semantics as Postgres intervals. */
function addInterval(fromIso: string, interval: string): string {
  const d = new Date(fromIso);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const targetMonth = interval === 'yearly' ? m : m + 1;
  const targetYear = interval === 'yearly' ? y + 1 : y;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const clamped = Math.min(day, lastDay);
  const out = new Date(d);
  out.setUTCFullYear(targetYear, targetMonth, clamped);
  return out.toISOString();
}

function rpcApply(args: Record<string, string>) {
  const intentId = args.p_payment_intent_id;
  const now = args.p_now;

  // 1) durable replay guard
  const existing = applications.find((a) => a.payment_intent_id === intentId);
  if (existing) {
    return {
      alreadyApplied: true,
      actionType: existing.action_type,
      planId: existing.plan_id,
      planName: PLANS[existing.plan_id]?.name ?? null,
      interval: existing.billing_interval,
      periodStart: existing.period_start,
      periodEnd: existing.period_end,
      stacked: existing.stacked,
    };
  }

  // 2) classify against the locked subscription row
  const currentPlan = subscription?.plan_id ?? null;
  let action: string;
  if (!currentPlan) action = 'plan_new';
  else if (currentPlan === args.p_plan_id) {
    action = subscription!.status === 'active' || subscription!.status === 'trialing' ? 'plan_renewal' : 'plan_new';
  } else {
    const cur = PLANS[currentPlan]?.sort_order ?? 0;
    const next = PLANS[args.p_plan_id]?.sort_order ?? 0;
    action = next > cur ? 'plan_upgrade' : next < cur ? 'plan_downgrade' : 'plan_new';
  }

  // 3) stacked renewal window
  let start = now;
  let stacked = false;
  if (
    action === 'plan_renewal' &&
    subscription?.current_period_end &&
    new Date(subscription.current_period_end).getTime() > new Date(now).getTime()
  ) {
    start = subscription.current_period_end;
    stacked = true;
  }
  const end = addInterval(start, args.p_interval);

  // 4) marker + subscription commit together
  applications.push({
    payment_intent_id: intentId,
    workspace_id: args.p_workspace_id,
    plan_id: args.p_plan_id,
    action_type: action,
    billing_interval: args.p_interval,
    period_start: start,
    period_end: end,
    stacked,
  });
  subscription = {
    plan_id: args.p_plan_id,
    status: 'active',
    current_period_start: start,
    current_period_end: end,
    metadata: { last_payment_intent_id: intentId, last_action_type: action },
  };

  return {
    alreadyApplied: false,
    actionType: action,
    planId: args.p_plan_id,
    planName: PLANS[args.p_plan_id]?.name ?? null,
    interval: args.p_interval,
    periodStart: start,
    periodEnd: end,
    stacked,
  };
}

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    rpc: async (fn: string, args: Record<string, string>) => {
      if (fn !== 'billing_apply_subscription_payment') throw new Error(`unexpected rpc ${fn}`);
      return { data: rpcApply(args), error: null };
    },
    from(table: string) {
      if (table !== 'billing_payments') throw new Error(`unexpected table ${table}`);
      return {
        insert(row: Record<string, unknown>) {
          const duplicate = payments.some((p) => p.payment_intent_id === row.payment_intent_id);
          return {
            select: () => ({
              maybeSingle: async () => {
                if (duplicate) return { data: null, error: { code: '23505', message: 'duplicate key value' } };
                payments.push(row);
                return { data: { id: `pay_${payments.length}` }, error: null };
              },
            }),
          };
        },
      };
    },
  }),
}));

vi.mock('../../../server/services/billing/entitlementChange.js', () => ({
  handleWorkspaceEntitlementChanged: async () => {},
}));

import {
  applySubscriptionPayment,
  recordCustomerPayment,
} from '../../../server/services/billing/applyPayment';

const CFG = { supabaseUrl: 'http://stub', supabaseServiceRoleKey: 'key' } as any;

async function finalize(intentId: string, opts: { planId?: string; now: string; withPayment?: boolean }) {
  const applied = await applySubscriptionPayment(CFG, {
    workspaceId: WS,
    planId: opts.planId ?? 'pro',
    interval: 'monthly',
    providerName: 'zarinpal',
    paymentIntentId: intentId,
    now: new Date(opts.now),
  });
  if (opts.withPayment !== false) {
    await recordCustomerPayment(CFG, {
      workspaceId: WS,
      providerName: 'zarinpal',
      paymentIntentId: intentId,
      amount: 15_000_000,
      currency: 'IRR',
      purchaseType: 'subscription',
      actionType: applied.actionType,
      planId: applied.planId,
    });
  }
  return applied;
}

describe('durable subscription application idempotency', () => {
  beforeEach(() => {
    applications = [];
    payments = [];
    subscription = null;
  });

  it('A crashes before its payment row, B applies, A recovers — only two periods exist', async () => {
    // A: subscription applied, then the process dies before recordCustomerPayment.
    const a = await finalize('intent_A', { now: '2026-01-10T00:00:00.000Z', withPayment: false });
    expect(a.alreadyApplied).toBe(false);
    expect(a.actionType).toBe('plan_new');
    expect(a.periodEnd).toBe('2026-02-10T00:00:00.000Z');

    // B: a later payment fully applies and overwrites last_payment_intent_id.
    const b = await finalize('intent_B', { now: '2026-01-20T00:00:00.000Z' });
    expect(b.alreadyApplied).toBe(false);
    expect(b.actionType).toBe('plan_renewal');
    expect(b.stacked).toBe(true);
    expect(b.periodStart).toBe('2026-02-10T00:00:00.000Z');
    expect(b.periodEnd).toBe('2026-03-10T00:00:00.000Z');

    // A recovery: must NOT create a third period.
    const aRecovered = await finalize('intent_A', { now: '2026-01-25T00:00:00.000Z' });
    expect(aRecovered.alreadyApplied).toBe(true);
    expect(aRecovered.periodEnd).toBe('2026-02-10T00:00:00.000Z');

    // Exactly two applications, two payments, and the period reflects TWO payments.
    expect(applications.map((x) => x.payment_intent_id)).toEqual(['intent_A', 'intent_B']);
    expect(payments).toHaveLength(2);
    expect(subscription?.current_period_end).toBe('2026-03-10T00:00:00.000Z');
  });

  it('concurrent retries of the same intent apply exactly once', async () => {
    const [first, second, third] = await Promise.all([
      finalize('intent_A', { now: '2026-01-10T00:00:00.000Z' }),
      finalize('intent_A', { now: '2026-01-10T00:00:00.000Z' }),
      finalize('intent_A', { now: '2026-01-10T00:00:00.000Z' }),
    ]);
    const applied = [first, second, third].filter((r) => !r.alreadyApplied);
    expect(applied).toHaveLength(1);
    expect(applications).toHaveLength(1);
    expect(payments).toHaveLength(1); // unique index rejected the replays
    expect(subscription?.current_period_end).toBe('2026-02-10T00:00:00.000Z');
  });

  it('an old intent replayed after several renewals never extends the period', async () => {
    await finalize('intent_1', { now: '2026-01-31T00:00:00.000Z' });
    await finalize('intent_2', { now: '2026-02-05T00:00:00.000Z' });
    await finalize('intent_3', { now: '2026-03-01T00:00:00.000Z' });
    const endAfterThree = subscription?.current_period_end;

    const replay = await finalize('intent_1', { now: '2026-03-10T00:00:00.000Z' });
    expect(replay.alreadyApplied).toBe(true);
    expect(subscription?.current_period_end).toBe(endAfterThree);
    expect(applications).toHaveLength(3);
    expect(payments).toHaveLength(3);
  });

  it('calendar-safe month end: 31 Jan renewal lands on 28 Feb, not 3 March', async () => {
    const first = await finalize('intent_1', { now: '2026-01-31T00:00:00.000Z' });
    expect(first.periodEnd).toBe('2026-02-28T00:00:00.000Z');
  });

  it('an upgrade starts now instead of stacking', async () => {
    await finalize('intent_1', { now: '2026-01-10T00:00:00.000Z' });
    const upgrade = await finalize('intent_2', { planId: 'business', now: '2026-01-15T00:00:00.000Z' });
    expect(upgrade.actionType).toBe('plan_upgrade');
    expect(upgrade.stacked).toBe(false);
    expect(upgrade.periodStart).toBe('2026-01-15T00:00:00.000Z');
  });

  it('refuses to apply without a payment intent id (no un-keyed periods)', async () => {
    await expect(
      applySubscriptionPayment(CFG, {
        workspaceId: WS,
        planId: 'pro',
        interval: 'monthly',
        providerName: 'zarinpal',
        paymentIntentId: '',
      }),
    ).rejects.toThrow(/missing_payment_intent_id/);
  });
});
