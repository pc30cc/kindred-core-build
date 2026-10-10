/**
 * What a saved card's Paddle subscription should look like
 * (server/services/billing/account/cardState.ts, phase 3b): a table of
 * situations, one per rule of desiredCardState (the first rule that matches
 * wins), the end of the last paid period, when Paddle should charge (and
 * whether that is still in time), and the freeze around Paddle's charge.
 */
import { describe, expect, it } from 'vitest';
import {
  cardFreeze,
  chargeDateFor,
  desiredCardState,
  lastPaidEnd,
  periodEndOf,
  type CardStateInput,
} from '../../../../server/services/billing/account/cardState';
import {
  CARD_FREEZE_BEFORE_MS,
  CARD_FREEZE_MAX_AFTER_MS,
  CARD_LATEST_BEFORE_END_MS,
  CARD_MIN_LEAD_FROM_NOW_MS,
  CARD_RENEWAL_LEAD_MS,
  CARD_SETUP_HOLD_MS,
} from '../../../../shared/simpleBilling';

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const iso = (ms: number) => new Date(ms).toISOString();
const PRO = '11111111-1111-4111-8111-111111111111';
const TEAM = '22222222-2222-4222-8222-222222222222';
const E = NOW + 10 * D;

/** A live card on a running Pro (monthly, $29) period with auto-renew on. */
function input(over: Partial<CardStateInput> = {}): CardStateInput {
  return {
    now: NOW,
    card: { status: 'active', created_at: iso(NOW - 20 * D), currency: 'USD' },
    workspaceExists: true,
    setupPayment: { status: 'succeeded', created_at: iso(NOW - 20 * D) },
    autoRenew: true,
    paid: { plan_id: PRO, billing_interval: 'monthly', current_period_end: iso(E) },
    prepaidNextEnd: null,
    v2NextEnd: null,
    target: { plan_id: PRO, is_free: false, interval: 'monthly', price_minor: 2900 },
    vatPercent: null,
    ...over,
  };
}

describe('desiredCardState: the first matching rule wins', () => {
  const noPaid = { paid: null, target: null } as const;
  const cases: Array<[string, Partial<CardStateInput>, string, string?]> = [
    // 1. On its way out, or no workspace.
    ['a canceling card is cancelled now', { card: { status: 'canceling', created_at: iso(NOW - D), currency: 'USD' } }, 'cancel_now', 'card_canceling'],
    ['a canceled card stays cancelled', { card: { status: 'canceled', created_at: iso(NOW - D), currency: 'USD' } }, 'cancel_now', 'card_canceling'],
    ['a deleted workspace cancels a live card', { workspaceExists: false }, 'cancel_now', 'workspace_deleted'],
    ['canceling wins over a deleted workspace', {
      workspaceExists: false, card: { status: 'canceling', created_at: iso(NOW - D), currency: 'USD' },
    }, 'cancel_now', 'card_canceling'],
    ['a past_due card whose workspace is gone is cancelled', {
      workspaceExists: false, card: { status: 'past_due', created_at: iso(NOW - D), currency: 'USD' },
    }, 'cancel_now', 'workspace_deleted'],
    // 2./3. No paid period yet: the setup payment may still settle.
    ['setup payment pending 30 minutes: hold', { ...noPaid, setupPayment: { status: 'pending', created_at: iso(NOW - 30 * MIN) } }, 'hold', 'setup_pending'],
    ['setup payment succeeded but its period not seen yet: hold', { ...noPaid, setupPayment: { status: 'succeeded', created_at: iso(NOW - H) } }, 'hold'],
    ['setup payment just under the hold: hold', { ...noPaid, setupPayment: { status: 'pending', created_at: iso(NOW - CARD_SETUP_HOLD_MS + 1) } }, 'hold'],
    ['setup payment exactly at the hold: cancel', { ...noPaid, setupPayment: { status: 'pending', created_at: iso(NOW - CARD_SETUP_HOLD_MS) } }, 'cancel_now', 'no_paid_plan'],
    ['setup payment older than the hold: cancel', { ...noPaid, setupPayment: { status: 'succeeded', created_at: iso(NOW - 3 * H) } }, 'cancel_now', 'no_paid_plan'],
    ['setup payment failed: cancel at once', { ...noPaid, setupPayment: { status: 'failed', created_at: iso(NOW - MIN) } }, 'cancel_now', 'no_paid_plan'],
    ['setup payment canceled: cancel at once', { ...noPaid, setupPayment: { status: 'canceled', created_at: iso(NOW - MIN) } }, 'cancel_now'],
    ['setup payment expired: cancel at once', { ...noPaid, setupPayment: { status: 'expired', created_at: iso(NOW - MIN) } }, 'cancel_now'],
    ['no setup payment (deleted) and no period: cancel', { ...noPaid, setupPayment: null }, 'cancel_now', 'no_paid_plan'],
    ['a setup payment with no readable date: cancel', { ...noPaid, setupPayment: { status: 'pending', created_at: 'not a date' } }, 'cancel_now'],
    // 4./5. Nothing more to charge.
    ['auto-renew off: stop at the period end', { autoRenew: false }, 'stop_at_period_end', 'auto_renew_off'],
    ['auto-renew off wins over a free target', {
      autoRenew: false, target: { plan_id: PRO, is_free: true, interval: 'monthly', price_minor: 0 },
    }, 'stop_at_period_end', 'auto_renew_off'],
    ['a change to Free at the period end: stop', { target: { plan_id: PRO, is_free: true, interval: 'monthly', price_minor: 0 } }, 'stop_at_period_end', 'renewal_to_free'],
    ['no target plan (deleted): stop', { target: null }, 'stop_at_period_end', 'renewal_to_free'],
    ['the target is not sold in this currency/interval: stop', { target: { plan_id: TEAM, is_free: false, interval: 'yearly', price_minor: null } }, 'stop_at_period_end', 'price_unavailable'],
    ['a zero price is not a price: stop', { target: { plan_id: TEAM, is_free: false, interval: 'monthly', price_minor: 0 } }, 'stop_at_period_end', 'price_unavailable'],
    // 6. Renew.
    ['a running paid period with auto-renew: renew', {}, 'renew'],
    ['a past_due card still renews (Paddle retries it)', { card: { status: 'past_due', created_at: iso(NOW - D), currency: 'USD' } }, 'renew'],
    ['a paid period wins over a setup that failed', { setupPayment: { status: 'failed', created_at: iso(NOW - MIN) } }, 'renew'],
  ];
  it.each(cases)('%s', (_name, over, kind, reason) => {
    const state = desiredCardState(input(over));
    expect(state.kind).toBe(kind);
    if (reason) expect((state as { reason?: string }).reason).toBe(reason);
  });

  it('renews the next period at the target price, 24 h before the period ends', () => {
    expect(desiredCardState(input())).toEqual({
      kind: 'renew',
      nextBilledAt: iso(E - CARD_RENEWAL_LEAD_MS),
      feasible: true,
      item: { planId: PRO, interval: 'monthly', currency: 'USD', netMinor: 2900, taxMinor: 0, amountMinor: 2900 },
    });
  });

  it('adds VAT on top of the price (chargeFor)', () => {
    const state = desiredCardState(input({ vatPercent: 20 }));
    expect(state.kind === 'renew' && state.item).toEqual({
      planId: PRO, interval: 'monthly', currency: 'USD', netMinor: 2900, taxMinor: 580, amountMinor: 3480,
    });
  });

  it("renews a scheduled change's plan and interval, in the card's currency", () => {
    const state = desiredCardState(input({
      card: { status: 'active', created_at: iso(NOW - D), currency: 'USD' },
      target: { plan_id: TEAM, is_free: false, interval: 'yearly', price_minor: 99_000 },
    }));
    expect(state.kind === 'renew' && state.item).toMatchObject({ planId: TEAM, interval: 'yearly', amountMinor: 99_000, currency: 'USD' });
  });

  it('with a prepaid next period, charges for the period after it', () => {
    const prepaidEnd = E + 31 * D;
    const state = desiredCardState(input({ prepaidNextEnd: iso(prepaidEnd) }));
    expect(state.kind === 'renew' && state.nextBilledAt).toBe(iso(prepaidEnd - CARD_RENEWAL_LEAD_MS));
  });

  it('with a billing v2 next period, charges for the period after it', () => {
    const v2End = E + 30 * D;
    const state = desiredCardState(input({ v2NextEnd: iso(v2End) }));
    expect(state.kind === 'renew' && state.nextBilledAt).toBe(iso(v2End - CARD_RENEWAL_LEAD_MS));
  });

  it('a period that ended before the due step ran cannot be renewed in time', () => {
    const state = desiredCardState(input({ paid: { plan_id: PRO, billing_interval: 'monthly', current_period_end: iso(NOW - 5 * MIN) } }));
    expect(state).toMatchObject({ kind: 'renew', feasible: false, nextBilledAt: iso(NOW + CARD_MIN_LEAD_FROM_NOW_MS) });
  });

  it('a short period (Super Admin grant) ending in 50 minutes is not feasible; in 2 hours it is, never sooner than now + 45 min', () => {
    const at = (end: number) => desiredCardState(input({ paid: { plan_id: PRO, billing_interval: 'monthly', current_period_end: iso(end) } }));
    expect(at(NOW + 50 * MIN)).toMatchObject({ kind: 'renew', feasible: false });
    expect(at(NOW + 2 * H)).toMatchObject({ kind: 'renew', feasible: true, nextBilledAt: iso(NOW + CARD_MIN_LEAD_FROM_NOW_MS) });
  });
});

describe('lastPaidEnd: prepaid, else billing v2, else the running period', () => {
  const paid = { plan_id: PRO, billing_interval: 'monthly' as const, current_period_end: iso(E) };
  it.each([
    ['nothing paid', { paid: null, prepaidNextEnd: null, v2NextEnd: null }, null],
    ['the running period only', { paid, prepaidNextEnd: null, v2NextEnd: null }, iso(E)],
    ['a billing v2 next period', { paid, prepaidNextEnd: null, v2NextEnd: iso(E + 30 * D) }, iso(E + 30 * D)],
    ['a prepaid next period wins over v2', { paid, prepaidNextEnd: iso(E + 31 * D), v2NextEnd: iso(E + 30 * D) }, iso(E + 31 * D)],
    ['an unreadable prepaid end is skipped', { paid, prepaidNextEnd: 'garbage', v2NextEnd: null }, iso(E)],
    ['a prepaid end without a running period still counts', { paid: null, prepaidNextEnd: iso(E + 31 * D), v2NextEnd: null }, iso(E + 31 * D)],
  ] as const)('%s', (_name, value, expected) => {
    expect(lastPaidEnd(value)).toBe(expected);
  });
});

describe('chargeDateFor: the lead before the end, never sooner than now + 45 min, feasible only before end − 10 min', () => {
  it.each([
    ['a month away', NOW + 30 * D, NOW + 30 * D - CARD_RENEWAL_LEAD_MS, true],
    ['exactly lead + 45 min away', NOW + CARD_RENEWAL_LEAD_MS + CARD_MIN_LEAD_FROM_NOW_MS, NOW + CARD_MIN_LEAD_FROM_NOW_MS, true],
    ['a day away: now + 45 min', NOW + D, NOW + CARD_MIN_LEAD_FROM_NOW_MS, true],
    ['56 minutes away: still in time', NOW + 56 * MIN, NOW + CARD_MIN_LEAD_FROM_NOW_MS, true],
    ['55 minutes away: the charge would land at end − 10 min', NOW + CARD_MIN_LEAD_FROM_NOW_MS + CARD_LATEST_BEFORE_END_MS, NOW + CARD_MIN_LEAD_FROM_NOW_MS, false],
    ['20 minutes away', NOW + 20 * MIN, NOW + CARD_MIN_LEAD_FROM_NOW_MS, false],
    ['already past', NOW - H, NOW + CARD_MIN_LEAD_FROM_NOW_MS, false],
  ])('%s', (_name, end, at, feasible) => {
    expect(chargeDateFor(end, NOW)).toEqual({ at, feasible });
  });
});

describe('cardFreeze: from N − 2 h until N + 6 h, live cards only', () => {
  const card = (n: number | null, status: 'active' | 'past_due' | 'canceling' | 'canceled' = 'active') =>
    ({ paddle_next_billed_at: n === null ? null : iso(n), status });
  it.each([
    ['N in 3 hours: open', card(NOW + 3 * H), false],
    ['N just over 2 hours away: open', card(NOW + CARD_FREEZE_BEFORE_MS + 1), false],
    ['N exactly 2 hours away: frozen', card(NOW + CARD_FREEZE_BEFORE_MS), true],
    ['N now: frozen', card(NOW), true],
    ['N 5 hours ago (Paddle has not moved it on): frozen', card(NOW - 5 * H), true],
    ['N exactly 6 hours ago: open again', card(NOW - CARD_FREEZE_MAX_AFTER_MS), false],
    ['a past_due card in the window: frozen', card(NOW + H, 'past_due'), true],
    ['a canceling card is never frozen', card(NOW + H, 'canceling'), false],
    ['a canceled card is never frozen', card(NOW + H, 'canceled'), false],
    ['no Paddle date (a cancel is scheduled): open', card(null), false],
  ] as const)('%s', (_name, value, frozen) => {
    const result = cardFreeze(value, NOW);
    expect(result.frozen).toBe(frozen);
    if (frozen) {
      expect(result.until).toBe(iso(Date.parse(value.paddle_next_billed_at as string) + CARD_FREEZE_MAX_AFTER_MS));
    } else {
      expect(result.until).toBeNull();
    }
  });
});

describe('periodEndOf: billing_period_end in SQL (UTC months, clamped to the month end)', () => {
  it.each([
    ['Jan 31 + 1 month in a common year', '2026-01-31T10:30:00.000Z', 'monthly', '2026-02-28T10:30:00.000Z'],
    ['Jan 31 + 1 month in a leap year', '2028-01-31T10:30:00.000Z', 'monthly', '2028-02-29T10:30:00.000Z'],
    ['Mar 31 + 1 month', '2026-03-31T00:00:00.000Z', 'monthly', '2026-04-30T00:00:00.000Z'],
    ['Dec 15 + 1 month crosses the year', '2026-12-15T23:59:59.999Z', 'monthly', '2027-01-15T23:59:59.999Z'],
    ['Oct 10 + 1 year', '2026-10-10T12:00:00.000Z', 'yearly', '2027-10-10T12:00:00.000Z'],
    ['Feb 29 + 1 year', '2028-02-29T08:00:00.000Z', 'yearly', '2029-02-28T08:00:00.000Z'],
  ] as const)('%s', (_name, start, interval, end) => {
    expect(periodEndOf(start, interval)).toBe(end);
  });

  it('an unreadable start has no end', () => {
    expect(periodEndOf('nope', 'monthly')).toBeNull();
  });
});
