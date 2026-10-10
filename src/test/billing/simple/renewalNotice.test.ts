/**
 * renewalDueNotice (server/services/billing/account/renewalNotice.ts): the
 * paid period the panel's banner and the alerts bell warn of — the rule of
 * billing_account_reminder_candidates (migration 261), plus a change to Free.
 *
 *   - an active paid period ending within 7 days, auto-renew off → due;
 *   - more than 7 days left, already ended, a trial or a free plan → nothing;
 *   - a next period prepaid for this period → nothing; one prepaid for a
 *     replaced period does not count;
 *   - auto-renew with a balance that pays the next period's price (its
 *     scheduled plan and interval, in the account's currency) → nothing;
 *     a balance short of it, or a plan with no price there → due;
 *   - a change scheduled to Free → due, ending on Free.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-10T12:00:00Z');
const at = (days: number) => new Date(NOW + days * DAY).toISOString();

let rows: {
  sub: Record<string, unknown> | null;
  account: Record<string, unknown> | null;
  plans: Record<string, Record<string, unknown>>;
};

vi.mock('../../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (col: string, value: unknown) => {
        filters[col] = value;
        return b;
      };
      b.maybeSingle = async () => {
        if (table === 'workspace_subscriptions') return { data: rows.sub, error: null };
        if (table === 'billing_accounts') return { data: rows.account, error: null };
        if (table === 'billing_plans') return { data: rows.plans[String(filters.id)] ?? null, error: null };
        return { data: null, error: null };
      };
      return b;
    },
  }),
}));

const { renewalDueNotice } = await import('../../../../server/services/billing/account/renewalNotice.js');

const PRO = { id: 'pro', is_free: false, prices: { USD: { monthly: 2900, yearly: 29000 } } };
const LITE = { id: 'lite', is_free: false, prices: { USD: { monthly: 900 } } };
const FREE = { id: 'free', is_free: true, prices: {} };

function account(over: Record<string, unknown> = {}) {
  return {
    currency: 'USD', balance_minor: 0, auto_renew: false, scheduled_plan_id: null, scheduled_interval: null,
    next_period_prepaid_minor: null, next_period_start: null, ...over,
  };
}

const notice = (config = {} as never) => renewalDueNotice(config, 'w1', NOW);

beforeEach(() => {
  rows = {
    sub: { plan_id: 'pro', status: 'active', billing_interval: 'monthly', current_period_end: at(3) },
    account: account(),
    plans: { pro: PRO, lite: LITE, free: FREE },
  };
});

describe('renewalDueNotice', () => {
  it('a paid period ending within 7 days with auto-renew off is due', async () => {
    expect(await notice()).toEqual({ days_left: 3, period_end: at(3), plan_id: 'pro', ends_on_free: false });
  });

  it('counts the days up, never below 1 while the period runs', async () => {
    rows.sub!.current_period_end = at(0.25);
    expect((await notice())?.days_left).toBe(1);
    rows.sub!.current_period_end = at(6.5);
    expect((await notice())?.days_left).toBe(7);
  });

  it('a workspace with no billing account yet is due (nothing renews it)', async () => {
    rows.account = null;
    expect(await notice()).toMatchObject({ ends_on_free: false });
  });

  it('nothing more than 7 days before, after the due moment, on a trial or on Free', async () => {
    rows.sub!.current_period_end = at(7.5);
    expect(await notice()).toBeNull();
    rows.sub!.current_period_end = at(-0.1);
    expect(await notice()).toBeNull();
    rows.sub = { plan_id: 'pro', status: 'trialing', billing_interval: 'monthly', current_period_end: at(3) };
    expect(await notice()).toBeNull();
    rows.sub = { plan_id: 'free', status: 'active', billing_interval: 'monthly', current_period_end: at(3) };
    expect(await notice()).toBeNull();
    rows.sub = null;
    expect(await notice()).toBeNull();
  });

  it('a next period prepaid for this period is not due; one prepaid for a replaced period is', async () => {
    rows.account = account({ next_period_prepaid_minor: 2900, next_period_start: at(3) });
    expect(await notice()).toBeNull();
    rows.account = account({ next_period_prepaid_minor: 2900, next_period_start: at(-27) });
    expect(await notice()).toMatchObject({ ends_on_free: false });
  });

  it('auto-renew with a balance that pays the next period is not due', async () => {
    rows.account = account({ auto_renew: true, balance_minor: 2900 });
    expect(await notice()).toBeNull();
  });

  it('auto-renew with a balance short of the price is due', async () => {
    rows.account = account({ auto_renew: true, balance_minor: 2899 });
    expect(await notice()).toMatchObject({ days_left: 3, ends_on_free: false });
  });

  it('prices the next period by its scheduled plan and interval', async () => {
    // Scheduled down to Lite: 900 pays it.
    rows.account = account({ auto_renew: true, balance_minor: 900, scheduled_plan_id: 'lite' });
    expect(await notice()).toBeNull();
    // Scheduled to yearly: 2900 does not pay 29000.
    rows.account = account({ auto_renew: true, balance_minor: 2900, scheduled_interval: 'yearly' });
    expect(await notice()).toMatchObject({ ends_on_free: false });
  });

  it('a plan with no price in the account currency cannot be paid: due', async () => {
    rows.account = account({ auto_renew: true, balance_minor: 10_000_000, currency: 'TRY' });
    expect(await notice()).toMatchObject({ ends_on_free: false });
    rows.account = account({ auto_renew: true, balance_minor: 10_000, scheduled_plan_id: 'lite', scheduled_interval: 'yearly' });
    expect(await notice()).toMatchObject({ ends_on_free: false });
  });

  it('a change scheduled to Free is due and ends on Free, whatever the balance', async () => {
    rows.account = account({ auto_renew: true, balance_minor: 1_000_000, scheduled_plan_id: 'free' });
    expect(await notice()).toEqual({ days_left: 3, period_end: at(3), plan_id: 'pro', ends_on_free: true });
    // A prepayment does not start a free period either: it returns to the balance.
    rows.account = account({ scheduled_plan_id: 'free', next_period_prepaid_minor: 2900, next_period_start: at(3) });
    expect(await notice()).toMatchObject({ ends_on_free: true });
  });
});
