// ============================================================================
// SIMPLE BILLING — what a saved card's Paddle subscription should look like
// (phase 3b, docs/billing/SIMPLE_BILLING.md; migration 262).
//
// Pure: no I/O. The reconciler (card.ts syncCard) reads the workspace's
// billing state, asks desiredCardState() what Paddle should show, and moves
// Paddle there with calls that never bill. Paddle's clock does the charging;
// we only set its date (the end of the last paid period − a lead) and its
// price (the next period's plan, interval and price with VAT).
// ============================================================================

import {
  CARD_FREEZE_BEFORE_MS,
  CARD_FREEZE_MAX_AFTER_MS,
  CARD_LATEST_BEFORE_END_MS,
  CARD_MIN_LEAD_FROM_NOW_MS,
  CARD_RENEWAL_LEAD_MS,
  CARD_SETUP_HOLD_MS,
  chargeFor,
  type CardStatus,
} from '../../../../shared/simpleBilling.js';

export type DesiredCardState =
  /** Cancel the Paddle subscription now (the card is being removed, or nothing is left for it to pay). */
  | { kind: 'cancel_now'; reason: string }
  /** Change nothing yet: the checkout that saved the card has not paid its period yet. */
  | { kind: 'hold'; reason: string }
  /** Let it end with Paddle's current period: no further charge. */
  | { kind: 'stop_at_period_end'; reason: string }
  /** Charge the next period at `nextBilledAt` (`feasible` = early enough to renew before the period ends). */
  | {
      kind: 'renew';
      nextBilledAt: string;
      feasible: boolean;
      item: { planId: string; interval: 'monthly' | 'yearly'; currency: string; netMinor: number; taxMinor: number; amountMinor: number };
    };

export interface CardStateInput {
  now: number;
  card: { status: CardStatus; created_at: string; currency: string };
  workspaceExists: boolean;
  setupPayment: { status: string; created_at: string } | null;
  autoRenew: boolean;
  /** The running paid period (its end may be past while the due step has not run). */
  paid: { plan_id: string; billing_interval: 'monthly' | 'yearly'; current_period_end: string } | null;
  /** A live prepaid next period's end (period_end(E, target interval)), or null. */
  prepaidNextEnd: string | null;
  /** A billing v2 scheduled next period's end, or null. */
  v2NextEnd: string | null;
  /** The plan of the next unpaid period: scheduled plan/interval, else the current ones. */
  target: { plan_id: string; is_free: boolean; interval: 'monthly' | 'yearly'; price_minor: number | null } | null;
  vatPercent: number | null;
}

/** A setup payment in one of these states will never pay the card's first period. */
const SETUP_ENDED = new Set(['failed', 'canceled', 'expired']);

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : Number.NaN);

/**
 * The end of the last period already paid for: a prepaid next period's, else
 * a billing v2 scheduled period's, else the running period's. The card pays
 * the period after it.
 */
export function lastPaidEnd(input: Pick<CardStateInput, 'paid' | 'prepaidNextEnd' | 'v2NextEnd'>): string | null {
  for (const candidate of [input.prepaidNextEnd, input.v2NextEnd, input.paid?.current_period_end ?? null]) {
    if (candidate && Number.isFinite(ms(candidate))) return candidate;
  }
  return null;
}

/**
 * When Paddle should charge for the period after `lastPaidEndMs`: a lead
 * before it, but never sooner than a little after now (Paddle needs time,
 * and refuses changes in the 30 minutes before a charge). A date that late
 * is not `feasible`: Paddle could not charge before the period ends (a short
 * period granted by the Super Admin), so that period expires as usual.
 */
export function chargeDateFor(lastPaidEndMs: number, now: number): { at: number; feasible: boolean } {
  const at = Math.max(lastPaidEndMs - CARD_RENEWAL_LEAD_MS, now + CARD_MIN_LEAD_FROM_NOW_MS);
  return { at, feasible: at < lastPaidEndMs - CARD_LATEST_BEFORE_END_MS };
}

/**
 * Plan changes on a live card are frozen around Paddle's charge (its mirrored
 * next_billed_at N): from N − 2 h until Paddle moves N on, at most N + 6 h. A
 * change in that window could race the renewal Paddle is making.
 */
export function cardFreeze(
  card: { paddle_next_billed_at: string | null; status: CardStatus },
  now: number,
): { frozen: boolean; until: string | null } {
  const n = ms(card.paddle_next_billed_at);
  const live = card.status === 'active' || card.status === 'past_due';
  if (!live || !Number.isFinite(n)) return { frozen: false, until: null };
  const frozen = n - CARD_FREEZE_BEFORE_MS <= now && now < n + CARD_FREEZE_MAX_AFTER_MS;
  return frozen ? { frozen: true, until: new Date(n + CARD_FREEZE_MAX_AFTER_MS).toISOString() } : { frozen: false, until: null };
}

/**
 * `start` plus one month or one year, in UTC, the way billing_period_end does
 * it in SQL (PostgreSQL's month arithmetic: Jan 31 + 1 month = Feb 28/29).
 */
export function periodEndOf(start: string, interval: 'monthly' | 'yearly'): string | null {
  const at = ms(start);
  if (!Number.isFinite(at)) return null;
  const d = new Date(at);
  const months = d.getUTCMonth() + (interval === 'yearly' ? 12 : 1);
  const year = d.getUTCFullYear() + Math.floor(months / 12);
  const month = months % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    year, month, Math.min(d.getUTCDate(), lastDay),
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds(),
  )).toISOString();
}

/** What Paddle should show for this card now. The first rule that matches wins. */
export function desiredCardState(input: CardStateInput): DesiredCardState {
  // 1. A card on its way out, or whose workspace is gone, is cancelled now.
  if (input.card.status === 'canceling' || input.card.status === 'canceled') {
    return { kind: 'cancel_now', reason: 'card_canceling' };
  }
  if (!input.workspaceExists) return { kind: 'cancel_now', reason: 'workspace_deleted' };

  // 2./3. No paid period: its setup checkout may still be settling (events
  // arrive in any order); otherwise the card has nothing to renew.
  if (!input.paid) {
    const setup = input.setupPayment;
    const age = setup ? input.now - ms(setup.created_at) : Number.NaN;
    if (setup && !SETUP_ENDED.has(setup.status) && Number.isFinite(age) && age < CARD_SETUP_HOLD_MS) {
      return { kind: 'hold', reason: 'setup_pending' };
    }
    return { kind: 'cancel_now', reason: 'no_paid_plan' };
  }

  // 4./5. Nothing more to charge: the plan ends with the period.
  if (!input.autoRenew) return { kind: 'stop_at_period_end', reason: 'auto_renew_off' };
  const target = input.target;
  if (!target || target.is_free) return { kind: 'stop_at_period_end', reason: 'renewal_to_free' };
  if (target.price_minor === null || !Number.isSafeInteger(target.price_minor) || target.price_minor <= 0) {
    return { kind: 'stop_at_period_end', reason: 'price_unavailable' };
  }

  // 6. Renew: the period after the last paid one, at its full price with VAT.
  const end = ms(lastPaidEnd(input));
  const { at, feasible } = chargeDateFor(Number.isFinite(end) ? end : input.now, input.now);
  const charge = chargeFor(target.price_minor, input.vatPercent);
  return {
    kind: 'renew',
    nextBilledAt: new Date(at).toISOString(),
    feasible: Number.isFinite(end) && feasible,
    item: {
      planId: target.plan_id,
      interval: target.interval,
      currency: input.card.currency,
      netMinor: charge.net,
      taxMinor: charge.tax,
      amountMinor: charge.total,
    },
  };
}
