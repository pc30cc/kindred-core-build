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
 *   - a change scheduled to Free → due, ending on Free;
 *   - a saved card (phase 3b) renews, never the balance: an active card with
 *     auto-renew on and a sold next period → nothing; a card whose renewal
 *     failed (past_due) → due and card_past_due, whatever the balance; an
 *     active card with auto-renew off, or nothing sold to renew → due.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-10T12:00:00Z');
const at = (days: number) => new Date(NOW + days * DAY).toISOString();

let rows: {
  sub: Record<string, unknown> | null;
  account: Record<string, unknown> | null;
  plans: Record<string, Record<string, unknown>>;
  /** The workspace's live saved card (billing_account_cards), if any. */
  card: Record<string, unknown> | null;
};
const tablesRead: string[] = [];

vi.mock('../../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      tablesRead.push(table);
      const filters: Record<string, unknown> = {};
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (col: string, value: unknown) => {
        filters[col] = value;
        return b;
      };
      b.in = (col: string, values: unknown[]) => {
        filters[col] = values;
        return b;
      };
      b.maybeSingle = async () => {
        if (table === 'workspace_subscriptions') return { data: rows.sub, error: null };
        if (table === 'billing_accounts') return { data: rows.account, error: null };
        if (table === 'billing_plans') return { data: rows.plans[String(filters.id)] ?? null, error: null };
        if (table === 'billing_account_cards') {
          // Only a live card is asked for.
          const live = (filters.status as string[] | undefined) ?? [];
          return { data: rows.card && live.includes(String(rows.card.status)) ? rows.card : null, error: null };
        }
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
    card: null,
  };
  tablesRead.length = 0;
});

describe('renewalDueNotice', () => {
  it('a paid period ending within 7 days with auto-renew off is due', async () => {
    expect(await notice()).toEqual({ days_left: 3, period_end: at(3), plan_id: 'pro', ends_on_free: false, card_past_due: false });
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
    expect(await notice()).toEqual({ days_left: 3, period_end: at(3), plan_id: 'pro', ends_on_free: true, card_past_due: false });
    // A prepayment does not start a free period either: it returns to the balance.
    rows.account = account({ scheduled_plan_id: 'free', next_period_prepaid_minor: 2900, next_period_start: at(3) });
    expect(await notice()).toMatchObject({ ends_on_free: true });
  });

  describe('with a saved card', () => {
    const card = (status: string) => ({ id: 'card-1', status });

    it('an active card with auto-renew on and a sold next period renews it: not due, whatever the balance', async () => {
      rows.card = card('active');
      rows.account = account({ auto_renew: true, balance_minor: 0 });
      expect(await notice()).toBeNull();
      // Its next period by the scheduled plan and interval.
      rows.account = account({ auto_renew: true, balance_minor: 0, scheduled_plan_id: 'lite' });
      expect(await notice()).toBeNull();
    });

    it('a card whose renewal payment failed is due and says so, even when the balance would cover it', async () => {
      rows.card = card('past_due');
      rows.account = account({ auto_renew: true, balance_minor: 1_000_000 });
      expect(await notice()).toEqual({ days_left: 3, period_end: at(3), plan_id: 'pro', ends_on_free: false, card_past_due: true });
    });

    it('the balance never renews a card account: auto-renew off with a large balance is due', async () => {
      rows.card = card('active');
      rows.account = account({ auto_renew: false, balance_minor: 1_000_000 });
      expect(await notice()).toEqual({ days_left: 3, period_end: at(3), plan_id: 'pro', ends_on_free: false, card_past_due: false });
    });

    it('a next period the card cannot charge (no price there) is due', async () => {
      rows.card = card('active');
      rows.account = account({ auto_renew: true, balance_minor: 1_000_000, scheduled_plan_id: 'lite', scheduled_interval: 'yearly' });
      expect(await notice()).toMatchObject({ ends_on_free: false, card_past_due: false });
    });

    it('a next period already paid (the card renewal settled) is not due, past_due or not', async () => {
      rows.card = card('past_due');
      rows.account = account({ auto_renew: true, next_period_prepaid_minor: 2900, next_period_start: at(3) });
      expect(await notice()).toBeNull();
    });

    it('a change to Free ends on Free (the card stops with it)', async () => {
      rows.card = card('past_due');
      rows.account = account({ auto_renew: true, scheduled_plan_id: 'free' });
      expect(await notice()).toEqual({ days_left: 3, period_end: at(3), plan_id: 'pro', ends_on_free: true, card_past_due: false });
    });

    it('a card no longer live counts as none: the balance rule applies', async () => {
      rows.card = card('canceling');
      rows.account = account({ auto_renew: true, balance_minor: 2900 });
      expect(await notice()).toBeNull();
      rows.account = account({ auto_renew: true, balance_minor: 100 });
      expect(await notice()).toMatchObject({ ends_on_free: false, card_past_due: false });
    });

    it('the cards are not read when nothing is due', async () => {
      rows.sub!.current_period_end = at(20);
      expect(await notice()).toBeNull();
      expect(tablesRead).not.toContain('billing_account_cards');
    });
  });
});
