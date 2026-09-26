/**
 * Immediate-upgrade proration must price the CURRENT period at the interval it
 * was actually paid at.
 *
 * The bug: the current plan's price was looked up at the TARGET interval
 * while the ratio used the current period window and the period end stayed
 * put — so a monthly subscriber asking for a yearly plan was credited their
 * monthly window at the YEARLY price (and charged the yearly target price for
 * a few weeks of service), and the reverse under-credited.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type Row = Record<string, unknown>;
interface SubRow {
  id: string;
  status: string;
  plan_id: string;
  billing_interval: string | null;
  current_period_start: string;
  current_period_end: string;
}
interface PeriodRow {
  id: string;
  period_start: string;
  period_end: string;
  billing_interval: string;
  plan_id: string;
}
interface FakeBuilder {
  _filters: Row;
  _insert: Row | Row[] | null;
  _update: Row | null;
  select: () => FakeBuilder;
  eq: (col: string, val: unknown) => FakeBuilder;
  gte: () => FakeBuilder;
  limit: () => FakeBuilder;
  insert: (row: Row | Row[]) => FakeBuilder | Promise<{ data: null; error: null }>;
  update: (patch: Row) => FakeBuilder;
  maybeSingle: () => Promise<{ data: unknown; error: null }>;
  single: () => Promise<{ data: unknown; error: null }>;
}

const DAY = 86_400_000;
const NOW = new Date('2026-09-16T00:00:00.000Z');

let plans: Record<string, Row> = {};
let sub: SubRow | null = null;
let period: PeriodRow | null = null;
const insertedInvoices: Row[] = [];

function fakeClient() {
  const make = (table: string) => {
    const b: FakeBuilder = {
      _filters: {},
      _insert: null,
      _update: null,
      select: () => b,
      eq: (col: string, val: unknown) => { b._filters[col] = val; return b; },
      gte: () => b,
      limit: () => b,
      insert: (row: Row | Row[]) => {
        b._insert = row;
        if (table === 'billing_invoice_lines') return Promise.resolve({ data: null, error: null });
        return b;
      },
      update: (patch: Row) => { b._update = patch; return b; },
      maybeSingle: async () => {
        if (table === 'billing_plans') return { data: plans[b._filters.id as string] ?? null, error: null };
        if (table === 'workspace_subscriptions') return { data: sub, error: null };
        if (table === 'billing_subscription_periods') return { data: period, error: null };
        return { data: null, error: null };
      },
      single: async () => {
        if (table === 'billing_invoices' && b._insert) {
          const row = { id: `inv-${insertedInvoices.length + 1}`, ...(b._insert as Row) };
          insertedInvoices.push(row);
          return { data: row, error: null };
        }
        if (table === 'billing_invoices' && b._update) {
          const row = insertedInvoices.find((r) => r.id === b._filters.id);
          return { data: { ...row, ...b._update }, error: null };
        }
        return { data: null, error: null };
      },
    };
    return b;
  };
  return {
    from: (t: string) => make(t),
    rpc: async () => ({ data: null, error: null }),
  };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));
vi.mock('../../../server/services/billing/rollout.js', () => ({ isV2Active: async () => true }));
vi.mock('../../../server/services/billing/invoiceNumber.js', () => ({
  insertWithDocumentNumber: async (fn: (n: string) => Promise<{ data: unknown; error: { message: string } | null }>) => {
    const { data, error } = await fn('WY-TEST-1');
    if (error) throw new Error(error.message);
    return data;
  },
}));

const { previewPlanChange, applyPlanChange, BillingActionError } = await import(
  '../../../server/services/billing/customer/actions.js'
);
const { issueSubscriptionInvoice } = await import('../../../server/services/billing/invoice/issue.js');

const CONFIG = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } as unknown as Parameters<typeof previewPlanChange>[0];
const WS = 'ws-1';

const plan = (id: string, monthly: number, yearly: number): Row => ({
  id,
  name: id,
  is_active: true,
  prices: { IRR: { monthly, yearly } },
  limits: {},
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  plans = {
    'basic-id': plan('basic-id', 1_000_000, 10_000_000),
    'pro-id': plan('pro-id', 3_000_000, 30_000_000),
    'free-id': plan('free-id', 0, 0),
  };
  insertedInvoices.length = 0;
});

function monthlyBasicHalfUsed() {
  // 30-day monthly window, exactly half left at NOW.
  const start = new Date(NOW.getTime() - 15 * DAY).toISOString();
  const end = new Date(NOW.getTime() + 15 * DAY).toISOString();
  sub = {
    id: 'sub-1', status: 'active', plan_id: 'basic-id', billing_interval: 'monthly',
    current_period_start: start, current_period_end: end,
  };
  period = { id: 'p-1', period_start: start, period_end: end, billing_interval: 'monthly', plan_id: 'basic-id' };
}

function yearlyBasicHalfUsed() {
  const start = new Date(NOW.getTime() - 182 * DAY).toISOString();
  const end = new Date(NOW.getTime() + 182 * DAY).toISOString();
  sub = {
    id: 'sub-1', status: 'active', plan_id: 'basic-id', billing_interval: 'yearly',
    current_period_start: start, current_period_end: end,
  };
  period = { id: 'p-1', period_start: start, period_end: end, billing_interval: 'yearly', plan_id: 'basic-id' };
}

describe('immediate upgrade at the same interval', () => {
  it('monthly: credits the unused half at the monthly price it was paid at', async () => {
    monthlyBasicHalfUsed();
    const p = await previewPlanChange(CONFIG, WS, { planId: 'pro-id', interval: 'monthly', mode: 'immediate' });
    expect(p.mode).toBe('immediate');
    // Pro monthly for half the window (1.5M) minus Basic monthly credit (0.5M).
    expect(p.amountIrr).toBe(1_000_000);
    expect(p.currentPlan.interval).toBe('monthly');
  });

  it('yearly: both sides are priced at the yearly price', async () => {
    yearlyBasicHalfUsed();
    const p = await previewPlanChange(CONFIG, WS, { planId: 'pro-id', interval: 'yearly', mode: 'immediate' });
    // (30M - 10M) * 182/364
    expect(p.amountIrr).toBe(10_000_000);
  });

  it('the issued invoice carries the same credit and keeps the current window', async () => {
    monthlyBasicHalfUsed();
    const inv = await issueSubscriptionInvoice(CONFIG, {
      workspaceId: WS, subscriptionId: 'sub-1', targetPlanId: 'pro-id', interval: 'monthly',
      action: 'plan_upgrade', currentPlanId: 'basic-id', currentInterval: 'monthly',
      currentPeriodStart: period!.period_start, currentPeriodEnd: period!.period_end, now: NOW,
    });
    expect(inv.amount_due_irr).toBe(1_000_000);
    expect(inv.period_end).toBe(period!.period_end);
    expect((inv as unknown as { effect_snapshot: { proration: { unused_credit_irr: number } } }).effect_snapshot.proration.unused_credit_irr).toBe(500_000);
  });

  it('uses the stored period interval even when the subscription row lacks one', async () => {
    monthlyBasicHalfUsed();
    sub!.billing_interval = null;
    const p = await previewPlanChange(CONFIG, WS, { planId: 'pro-id', interval: 'monthly', mode: 'immediate' });
    expect(p.amountIrr).toBe(1_000_000);
  });
});

describe('immediate upgrade that also changes the interval', () => {
  it('monthly -> yearly with paid time left is refused, not mispriced', async () => {
    monthlyBasicHalfUsed();
    // Old behaviour: credit 10M * 0.5 = 5M, charge 30M * 0.5 = 15M → 10M for
    // two weeks of service, with the period end left at the monthly end.
    const err = await previewPlanChange(CONFIG, WS, { planId: 'pro-id', interval: 'yearly', mode: 'immediate' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BillingActionError);
    expect((err as { code?: string }).code).toBe('INTERVAL_CHANGE_NOT_IMMEDIATE');
    expect((err as { status?: number }).status).toBe(409);
  });

  it('yearly -> monthly with paid time left is refused', async () => {
    yearlyBasicHalfUsed();
    const err = await previewPlanChange(CONFIG, WS, { planId: 'pro-id', interval: 'monthly', mode: 'immediate' })
      .catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('INTERVAL_CHANGE_NOT_IMMEDIATE');
  });

  it('the invoice issuer refuses a mismatched interval too (defence in depth)', async () => {
    monthlyBasicHalfUsed();
    await expect(issueSubscriptionInvoice(CONFIG, {
      workspaceId: WS, subscriptionId: 'sub-1', targetPlanId: 'pro-id', interval: 'yearly',
      action: 'plan_upgrade', currentPlanId: 'basic-id', currentInterval: 'monthly',
      currentPeriodStart: period!.period_start, currentPeriodEnd: period!.period_end, now: NOW,
    })).rejects.toThrow('upgrade_interval_change_not_supported');
  });

  it('a free plan has nothing to credit: switching to yearly is a fresh full-price purchase', async () => {
    monthlyBasicHalfUsed();
    sub!.plan_id = 'free-id';
    period!.plan_id = 'free-id';
    const p = await previewPlanChange(CONFIG, WS, { planId: 'pro-id', interval: 'yearly', mode: 'immediate' });
    expect(p.freshPurchase).toBe(true);
    expect(p.amountIrr).toBe(30_000_000);

    const res = await applyPlanChange(CONFIG, WS, {
      planId: 'pro-id', interval: 'yearly', mode: 'immediate', expectedAmountIrr: 30_000_000,
    });
    expect(res.amountIrr).toBe(30_000_000);
    const inv = insertedInvoices[insertedInvoices.length - 1];
    expect(inv.invoice_type).toBe('new_subscription');
    expect(inv.billing_interval).toBe('yearly');
    // A full year from now, not squeezed into the free month.
    expect(new Date(inv.period_end as string).getTime() - new Date(inv.period_start as string).getTime()).toBeGreaterThan(360 * DAY);
  });
});
