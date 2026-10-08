/**
 * Buying a plan in a currency other than Rial (RESPOK sells in USD).
 *
 * Every workspace is on the invoice engine, and the invoice issuer used to
 * price everything from `prices.IRR`: a USD-only plan could not be bought at
 * all (and a plan with both prices was invoiced in Rial). The invoice is now
 * issued in the currency the catalogue was shown in, at that currency's
 * price, and records it on the invoice.
 *
 * Also covered: a workspace on a Trial / Free tier buys a NEW subscription
 * (full price, a full period from now) — it used to be charged a prorated
 * slice of the free window, and an ended trial could not buy at all.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type Row = Record<string, unknown>;

const DAY = 86_400_000;
const NOW = new Date('2026-10-08T00:00:00.000Z');

let plans: Record<string, Row> = {};
let sub: Row | null = null;
let period: Row | null = null;
let invoices: Record<string, Row> = {};
const inserted: Row[] = [];
const insertedLines: Row[] = [];

function fakeClient() {
  const make = (table: string) => {
    const b: Record<string, unknown> & { _filters: Row; _insert: Row | null; _update: Row | null } = {
      _filters: {},
      _insert: null,
      _update: null,
    };
    b.select = () => b;
    b.eq = (col: string, val: unknown) => { b._filters[col] = val; return b; };
    b.gte = () => b;
    b.limit = () => b;
    b.insert = (row: Row | Row[]) => {
      if (table === 'billing_invoice_lines') {
        insertedLines.push(...(Array.isArray(row) ? row : [row]));
        return Promise.resolve({ data: null, error: null });
      }
      b._insert = row as Row;
      return b;
    };
    b.update = (patch: Row) => { b._update = patch; return b; };
    b.maybeSingle = async () => {
      if (table === 'billing_plans') return { data: plans[b._filters.id as string] ?? null, error: null };
      if (table === 'workspace_subscriptions') return { data: sub, error: null };
      if (table === 'billing_subscription_periods') return { data: period, error: null };
      if (table === 'billing_invoices') return { data: invoices[b._filters.id as string] ?? null, error: null };
      return { data: null, error: null };
    };
    b.single = async () => {
      if (table === 'billing_invoices' && b._insert) {
        const row = { id: `inv-${inserted.length + 1}`, ...b._insert };
        inserted.push(row);
        return { data: row, error: null };
      }
      if (table === 'billing_invoices' && b._update) {
        const row = inserted.find((r) => r.id === b._filters.id);
        return { data: { ...row, ...b._update }, error: null };
      }
      return { data: null, error: null };
    };
    return b;
  };
  return { from: (t: string) => make(t), rpc: async () => ({ data: null, error: null }) };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));
vi.mock('../../../server/services/billing/rollout.js', () => ({ isV2Active: async () => true }));
vi.mock('../../../server/services/billing/invoiceNumber.js', () => ({
  insertWithDocumentNumber: async (fn: (n: string) => Promise<{ data: unknown; error: { message: string } | null }>) => {
    const { data, error } = await fn('WY12345678');
    if (error) throw new Error(error.message);
    return data;
  },
}));

const { previewPlanChange, applyPlanChange, stalePreviewTolerance, BillingActionError } = await import(
  '../../../server/services/billing/customer/actions.js'
);
const { issueSubscriptionInvoice, planPriceIn } = await import('../../../server/services/billing/invoice/issue.js');
const { pickCatalogCurrency } = await import('../../../server/routes/billingCustomer.js');

const CONFIG = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } as unknown as Parameters<typeof previewPlanChange>[0];
const WS = 'ws-1';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  plans = {
    // Sold in both currencies.
    'basic-id': { id: 'basic-id', name: 'Basic', is_active: true, limits: {},
      prices: { IRR: { monthly: 1_000_000, yearly: 10_000_000 }, USD: { monthly: 900, yearly: 9000 } } },
    'pro-id': { id: 'pro-id', name: 'Pro', is_active: true, limits: {},
      prices: { IRR: { monthly: 3_000_000, yearly: 30_000_000 }, USD: { monthly: 2900, yearly: 29000 } } },
    // Sold in USD only (a RESPOK-style plan).
    'usd-only': { id: 'usd-only', name: 'Team', is_active: true, limits: {}, prices: { USD: { monthly: 4900, yearly: 49000 } } },
    // Rial only.
    'irr-only': { id: 'irr-only', name: 'Local', is_active: true, limits: {}, prices: { IRR: { monthly: 500_000, yearly: 5_000_000 } } },
    'trial-id': { id: 'trial-id', name: 'Trial', is_active: true, limits: {}, prices: { IRR: { monthly: 0, yearly: 0 } } },
  };
  sub = null;
  period = null;
  invoices = {};
  inserted.length = 0;
  insertedLines.length = 0;
});

describe('a new workspace buys in USD', () => {
  it('previews and invoices the USD price, in USD', async () => {
    const preview = await previewPlanChange(CONFIG, WS, { planId: 'usd-only', interval: 'monthly', mode: 'immediate', currency: 'usd' });
    expect(preview).toMatchObject({ mode: 'immediate', currency: 'USD', amountIrr: 4900 });
    expect(preview.targetPlan.fullPriceIrr).toBe(4900);

    const res = await applyPlanChange(CONFIG, WS, {
      planId: 'usd-only', interval: 'monthly', mode: 'immediate', expectedAmountIrr: 4900, currency: 'USD',
    });
    expect(res).toMatchObject({ mode: 'immediate', currency: 'USD', amountIrr: 4900, invoiceId: 'inv-1' });
    const inv = inserted[0];
    expect(inv).toMatchObject({
      currency: 'USD',
      invoice_type: 'new_subscription',
      subtotal_irr: 4900,
      total_irr: 4900,
      amount_due_irr: 4900,
      billing_interval: 'monthly',
    });
    // A full month from now.
    expect(new Date(inv.period_end as string).getTime() - NOW.getTime()).toBeGreaterThanOrEqual(28 * DAY);
    expect(insertedLines[0]).toMatchObject({ description: 'Team — monthly', amount_irr: 4900 });
  });

  it('a plan sold in both currencies is invoiced at its USD price, not its Rial price', async () => {
    await applyPlanChange(CONFIG, WS, { planId: 'pro-id', interval: 'yearly', mode: 'immediate', expectedAmountIrr: 29000, currency: 'USD' });
    expect(inserted[0]).toMatchObject({ currency: 'USD', amount_due_irr: 29000 });
  });

  it('a plan without a USD price cannot be bought in USD (never read as free)', async () => {
    const err = await previewPlanChange(CONFIG, WS, { planId: 'irr-only', interval: 'monthly', mode: 'immediate', currency: 'USD' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BillingActionError);
    expect((err as { code?: string }).code).toBe('PRICE_NOT_AVAILABLE');
    expect((err as { status?: number }).status).toBe(409);
    await expect(issueSubscriptionInvoice(CONFIG, {
      workspaceId: WS, targetPlanId: 'irr-only', interval: 'monthly', action: 'plan_new', currency: 'USD', now: NOW,
    })).rejects.toThrow('plan_price_unavailable');
  });

  it('without a currency, everything stays Rial as before', async () => {
    const preview = await previewPlanChange(CONFIG, WS, { planId: 'pro-id', interval: 'monthly', mode: 'immediate' });
    expect(preview).toMatchObject({ currency: 'IRR', amountIrr: 3_000_000 });
    await applyPlanChange(CONFIG, WS, { planId: 'pro-id', interval: 'monthly', mode: 'immediate', expectedAmountIrr: 3_000_000 });
    expect(inserted[0]).toMatchObject({ currency: 'IRR', amount_due_irr: 3_000_000 });
    expect(insertedLines[0].description).toBe('Pro — ماهانه');
  });
});

describe('from a trial or free tier, the first paid plan is a new subscription', () => {
  it('a running trial pays the full price for a full period from now — not a slice of the trial', async () => {
    const trialEnd = new Date(NOW.getTime() + 10 * DAY).toISOString();
    sub = {
      id: 'sub-1', status: 'trialing', plan_id: 'trial-id', billing_interval: null,
      current_period_start: new Date(NOW.getTime() - 4 * DAY).toISOString(), current_period_end: trialEnd,
    };
    const preview = await previewPlanChange(CONFIG, WS, { planId: 'pro-id', interval: 'monthly', mode: 'immediate', currency: 'USD' });
    expect(preview).toMatchObject({ mode: 'immediate', allowedModes: ['immediate'], amountIrr: 2900, freshPurchase: true });

    await applyPlanChange(CONFIG, WS, { planId: 'pro-id', interval: 'monthly', mode: 'immediate', expectedAmountIrr: 2900, currency: 'USD' });
    const inv = inserted[0];
    expect(inv.invoice_type).toBe('new_subscription');
    expect(inv.amount_due_irr).toBe(2900);
    expect(new Date(inv.period_start as string).getTime()).toBe(NOW.getTime());
    expect(inv.period_end).not.toBe(trialEnd);
  });

  it('an ended trial can still buy (it used to be offered only a next-cycle change, with nothing to pay)', async () => {
    sub = {
      id: 'sub-1', status: 'expired', plan_id: 'trial-id', billing_interval: null,
      current_period_start: new Date(NOW.getTime() - 20 * DAY).toISOString(),
      current_period_end: new Date(NOW.getTime() - 6 * DAY).toISOString(),
    };
    const preview = await previewPlanChange(CONFIG, WS, { planId: 'usd-only', interval: 'yearly', mode: 'immediate', currency: 'USD' });
    expect(preview).toMatchObject({ mode: 'immediate', amountIrr: 49000 });
  });
});

describe('a paid period is never prorated across currencies', () => {
  function paidBasicMonthly(currency: string) {
    const start = new Date(NOW.getTime() - 15 * DAY).toISOString();
    const end = new Date(NOW.getTime() + 15 * DAY).toISOString();
    sub = { id: 'sub-1', status: 'active', plan_id: 'basic-id', billing_interval: 'monthly', current_period_start: start, current_period_end: end };
    period = { id: 'p-1', period_start: start, period_end: end, billing_interval: 'monthly', plan_id: 'basic-id', invoice_id: 'inv-paid' };
    invoices = { 'inv-paid': { id: 'inv-paid', currency } };
  }

  it('a period paid in Rial cannot be upgraded immediately in USD', async () => {
    paidBasicMonthly('IRR');
    const err = await previewPlanChange(CONFIG, WS, { planId: 'pro-id', interval: 'monthly', mode: 'immediate', currency: 'USD' })
      .catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('CURRENCY_CHANGE_NOT_IMMEDIATE');
    expect((err as { details?: unknown }).details).toEqual({ currentCurrency: 'IRR', requestedCurrency: 'USD' });
  });

  it('a period paid in USD is upgraded in USD, prorated at the USD prices', async () => {
    paidBasicMonthly('USD');
    const preview = await previewPlanChange(CONFIG, WS, { planId: 'pro-id', interval: 'monthly', mode: 'immediate', currency: 'USD' });
    // (2900 - 900) for half the window.
    expect(preview).toMatchObject({ currency: 'USD', amountIrr: 1000 });
    await applyPlanChange(CONFIG, WS, { planId: 'pro-id', interval: 'monthly', mode: 'immediate', expectedAmountIrr: 1000, currency: 'USD' });
    expect(inserted[0]).toMatchObject({ currency: 'USD', invoice_type: 'plan_upgrade', amount_due_irr: 1000 });
    expect(insertedLines[0].description).toBe('Upgrade to Pro for the rest of the period');
  });
});

describe('stale-preview tolerance is per currency', () => {
  it('Rial keeps its 10,000 floor; cents get one cent, not $100', () => {
    expect(stalePreviewTolerance(0, 'IRR')).toBe(10_000);
    expect(stalePreviewTolerance(0, 'USD')).toBe(1);
    expect(stalePreviewTolerance(2900, 'USD')).toBe(15);
    expect(stalePreviewTolerance(30_000_000, 'IRR')).toBe(150_000);
  });

  it('a USD amount that grew beyond drift is refused as stale', async () => {
    await expect(applyPlanChange(CONFIG, WS, {
      planId: 'usd-only', interval: 'monthly', mode: 'immediate', expectedAmountIrr: 2900, currency: 'USD',
    })).rejects.toMatchObject({ code: 'STALE_PREVIEW' });
  });
});

describe('planPriceIn', () => {
  it('reads the price of the requested currency, IRR keeping its legacy fallback', () => {
    const plan = { id: 'x', name: 'X', limits: {}, prices: { USD: { monthly: 900 } }, price_monthly: 1_000_000 } as never;
    expect(planPriceIn(plan, 'monthly', 'USD')).toBe(900);
    expect(planPriceIn(plan, 'monthly', 'IRR')).toBe(1_000_000);
    expect(() => planPriceIn(plan, 'yearly', 'USD')).toThrow('plan_price_unavailable');
  });
});

describe('catalogue currency', () => {
  it('explicit choice, then the paid period’s currency, then the locale’s, then Rial', () => {
    const all = ['IRR', 'USD', 'EUR'];
    expect(pickCatalogCurrency(all, { requested: 'eur', subscription: 'USD', locale: 'en' })).toBe('EUR');
    expect(pickCatalogCurrency(all, { subscription: 'USD', locale: 'fa' })).toBe('USD');
    expect(pickCatalogCurrency(all, { locale: 'en' })).toBe('USD');
    expect(pickCatalogCurrency(all, { locale: 'fa' })).toBe('IRR');
    expect(pickCatalogCurrency(['IRR'], { locale: 'en' })).toBe('IRR');
    expect(pickCatalogCurrency(['USD'], { locale: 'fa' })).toBe('USD');
    // Nothing payable: the request (or Rial) is shown as before.
    expect(pickCatalogCurrency([], { requested: 'usd' })).toBe('USD');
    expect(pickCatalogCurrency([], {})).toBe('IRR');
  });
});
