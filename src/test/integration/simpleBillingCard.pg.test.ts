// @vitest-environment node
/**
 * The saved card (simple billing phase 3b, docs/billing/SIMPLE_BILLING.md;
 * design §5) end to end, through the REAL routes (account and webhook), on a
 * database built by the whole chain (migration 262 included), in
 * postgres-only mode, signed in as a real workspace owner of a Multi Region
 * (USD) install whose Paddle sandbox gateway has its card switch on and is
 * open to customers.
 *
 * Paddle is the stateful fake of fakePaddle.ts: its own subscriptions,
 * transactions and clock, the notifications it would send (signed with the
 * gateway's secret, delivered in order, shuffled, duplicated or lost), and
 * its rules (renewal lock, past_due refusals, the 70-cent minimum, only
 * do_not_bill updates that change nothing billed). Time is moved per
 * workspace (`travel`): every date of the workspace in the database and at
 * Paddle moves into the past by the same amount, so what the server reads
 * as now() is that much later for it.
 *
 *   I9   the Iranian edition: no card, nothing asked of Paddle;
 *   S1   purchase with a card: the card is live, auto-renew on, Paddle's
 *        date = period end − 24 h, its item = the price;
 *   S2   Paddle renews: the prepaid next period; the due moment starts it
 *        and Paddle's date already follows;
 *   S3   declined, then the due moment: Free, the subscription cancelled,
 *        no later charge;
 *   S4   declined, then paid with a new card before the due moment;
 *   S5   a renewal whose notifications were all lost, found by the pull at
 *        the due moment;
 *   S6   a renewal carrying the checkout's intent_id (Paddle keeps merging
 *        custom_data) is a renewal, not a replay of the checkout;
 *   S7   upgrade charged to the card: the exact difference, the item
 *        swapped, the date unchanged;
 *   S8   upgrade declined; S9 upgrade whose answer was lost: never charged
 *        twice, settled once;
 *   S10  a downgrade, then an interval change: item swaps only;
 *   S11  auto-renew off, on, off again past Paddle's date;
 *   S12  remove the card: the balance is not used at the due moment, and
 *        the next card reuses the Paddle customer;
 *   S13  two tabs, two subscriptions: one is cancelled;
 *   S14  a Super Admin assignment moves Paddle's date and item;
 *   S15  a stray charge refunded; a chargeback of the renewal stops the card;
 *   S16  a renewal Paddle charged at another amount: credited for review,
 *        never charged a second time;
 *   S17  another installation's subscription (naming our workspace and
 *        payment ids): acknowledged, nothing changed, nothing cancelled;
 *   S18  workspace deleted: its card is cancelled (also when its rows go
 *        first, the card's included, as the purge deletes them);
 *   S19  cancelled in Paddle's portal: followed, mailed once, never undone;
 *   S20  renewed from the balance with a card: Paddle skips that cycle;
 *   and in any order: a card checkout's notifications, and a declined
 *        renewal paid with a new card, shuffled and duplicated (several
 *        seeds), end as if they had come in order.
 * The fake's own rules (lock, past_due, minimum, billing modes) are checked
 * first, against the fake alone.
 *
 * After every scenario the invariants of design §5 are checked: I1 balance =
 * Σ ledger ≥ 0; I2 every paid transaction of ours is one succeeded payment
 * and one credit, Σ Paddle collected = Σ credited; I3 one renewal per
 * period; I4 no balance renewal of a card account that a card payment did
 * not fund (or the customer asked for); I5 every update previewed and
 * do_not_bill, every /charge previewed, asked once for one pending row; I7
 * one subscription per workspace not cancelled, and Paddle and our cards
 * agree. I6 (nothing charged after a stop) is checked where a card stops,
 * I8 (all notifications again, shuffled and duplicated, also as new events:
 * the same state) at the end.
 *
 * E-mail is captured. Every other outbound request is refused. Driven by
 * TEST_DATABASE_URL; skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import cookieParser from 'cookie-parser';
import { createFullChainDatabase, type FullChainDatabase } from './fullChainDatabase';
import { periodEndOf } from '../../../server/services/billing/account/cardState';
import {
  FakePaddle,
  MASTERCARD_5555,
  installOutboundGuard,
  type DeliveryResult,
  type FakeSubscription,
  type OutboundGuard,
} from './fakePaddle';

const DSN = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_BILLING_DB === '1' && !DSN) {
  throw new Error('REQUIRE_BILLING_DB=1 but TEST_DATABASE_URL is not set — the saved card E2E is mandatory.');
}
const suite = DSN ? describe : describe.skip;

const captured = vi.hoisted(() => ({ emails: [] as Array<{ to: string; templateSlug?: string; data: Record<string, string> }> }));
vi.mock('../../../server/services/email/index.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const send = async (_c: unknown, req: { to: string; templateSlug?: string; templateData?: Record<string, string> }) => {
    captured.emails.push({ to: req.to, templateSlug: req.templateSlug, data: req.templateData ?? {} });
    return { success: true, provider: 'capture', id: `m-${captured.emails.length}` };
  };
  return { ...actual, sendEmail: send, sendPlatformEmail: send };
});
vi.mock('../../../server/middleware/security.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, authRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next() };
});

type Row = Record<string, unknown>;
type Interval = 'monthly' | 'yearly';

const SECRET = 'pdl_ntfset_card_e2e_secret';
const PROVIDER = 'paddle_sandbox';
const ORIGIN = 'http://127.0.0.1';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const PRICES = {
  lite: { monthly: 900, yearly: 9000 },
  pro: { monthly: 2900, yearly: 29000 },
  proPlus: { monthly: 2950, yearly: 29500 },
  biz: { monthly: 9900, yearly: 99000 },
} as const;

/** A timestamp from PostgreSQL (a Date) or JSON (a string), in ms. */
const t = (v: unknown): number => (v instanceof Date ? v.getTime() : Date.parse(String(v)));

let chainRef: FullChainDatabase | null = null;
const fake = new FakePaddle({
  webhookSecret: SECRET,
  // What our payment row looked like when Paddle was asked to charge it (I5).
  inspectCharge: async (paymentId) => {
    if (!paymentId || !chainRef) return null;
    const { rows } = await chainRef.db.query(
      `SELECT status, source, purpose, charge_requested_at, provider_ref FROM public.billing_account_payments WHERE id::text = $1`,
      [paymentId],
    );
    return (rows[0] as Row | undefined) ?? null;
  },
});
const originals = { http: http.request };
let guard: OutboundGuard | null = null;

suite('saved card, end to end with a stateful Paddle (real routes, postgres-only)', () => {
  let chain: FullChainDatabase;
  let app: http.Server;
  let base = '';
  let config: never;
  const st = { cookie: '', adminCookie: '', accountId: '', firstWs: '', lite: '', pro: '', proPlus: '', biz: '' };
  /** Each workspace's moves in time (I3/I4 put the append-only ledger's dates in today's frame). */
  const travels: Array<{ ws: string; at: number; ms: number }> = [];
  const slugs = new Map<string, string>();

  const q = async (sql: string, p: unknown[] = []) => (await chain.db.query(sql, p)).rows as Row[];
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0];

  function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, cookie = st.cookie): Promise<{ status: number; json: Row; setCookie: string[] }> {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = originals.http(`${base}${path}`, {
        method,
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(method !== 'GET' ? { origin: ORIGIN } : {}),
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      }, (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json: Row = {};
          try { json = JSON.parse(raw || '{}'); } catch { json = {}; }
          resolve({ status: res.statusCode ?? 0, json, setCookie: (res.headers['set-cookie'] as string[]) ?? [] });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  // ─── Reading what we hold ────────────────────────────────────────────────

  const view = async (ws: string) => (await call('GET', `/api/billing/account/${ws}`)).json;
  const accountOf = (ws: string) => one(`SELECT * FROM public.billing_accounts WHERE workspace_id = $1`, [ws]);
  const subOf = (ws: string) => one(`SELECT * FROM public.workspace_subscriptions WHERE workspace_id = $1`, [ws]);
  const cardRow = (id: string) => one(`SELECT * FROM public.billing_account_cards WHERE id = $1`, [id]);
  const balanceOf = async (ws: string) => Number((await accountOf(ws)).balance_minor);
  const paymentsOf = (ws: string, source?: string) => q(
    `SELECT * FROM public.billing_account_payments WHERE workspace_id = $1 AND ($2::text IS NULL OR source = $2) ORDER BY created_at`,
    [ws, source ?? null],
  );
  const periodEnd = async (ws: string) => t((await subOf(ws)).current_period_end);
  const paddleSub = (id: string): FakeSubscription => fake.subscriptions.get(id) as FakeSubscription;
  const nextBilled = (id: string) => t(paddleSub(id).next_billed_at);

  /**
   * When Paddle should next charge this workspace's card: 24 h before the end
   * of the last paid period (the prepaid next period's, else the running one),
   * read from what the database holds now.
   */
  async function expectedChargeAt(ws: string): Promise<number> {
    const [sub, acc] = await Promise.all([subOf(ws), accountOf(ws)]);
    const interval = String(acc.scheduled_interval ?? sub.billing_interval) === 'yearly' ? 'yearly' : 'monthly';
    const end = new Date(t(sub.current_period_end)).toISOString();
    const prepaid = acc.next_period_prepaid_minor !== null && acc.next_period_start && Math.abs(t(acc.next_period_start) - t(end)) < 1000;
    return t(prepaid ? periodEndOf(end, interval) : end) - DAY;
  }

  /** The billing mails about one workspace (its billing_url names its slug). */
  const mailsOf = (ws: string, slug: string) =>
    captured.emails.filter((e) => e.templateSlug === slug && (e.data.billing_url ?? '').endsWith(`/${slugs.get(ws)}/billing`));
  /** Mails are sent after the money is committed: give them a moment. */
  const mailsSettle = () => new Promise((r) => setTimeout(r, 150));

  /** Calls made to Paddle from `mark` on. */
  const callsSince = (mark: number) => fake.calls.slice(mark);
  const patchesOf = (subId: string, from = 0) =>
    fake.calls.slice(from).filter((c) => c.method === 'PATCH' && c.path === `/subscriptions/${subId}`);

  // ─── Driving it ──────────────────────────────────────────────────────────

  /** Paddle's queued notifications, delivered; every one must be acknowledged. */
  async function deliver(opts: Parameters<FakePaddle['deliver']>[0] = {}): Promise<DeliveryResult[]> {
    const results = await fake.deliverAll(opts);
    expect(results.filter((r) => r.status >= 300).map((r) => `${r.queued.event.event_type} → ${r.status} ${JSON.stringify(r.body)}`)).toEqual([]);
    return results;
  }

  async function cardJob() {
    const { runSimpleBillingCard } = await import('../../../server/services/billing/account/job.js');
    const report = await runSimpleBillingCard(config);
    expect(report.skipped).toBeFalsy();
    return report;
  }

  async function dueJob() {
    const { runSimpleBillingDue } = await import('../../../server/services/billing/account/job.js');
    const report = await runSimpleBillingDue(config);
    expect(report.skipped).toBeFalsy();
    return report;
  }

  /** Notifications and the card job until nothing is left to do. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
      await deliver();
      const report = await cardJob();
      expect(report.errors).toEqual([]);
      if (!fake.outbox.length) return;
    }
    expect(fake.outbox.map((e) => e.event.event_type)).toEqual([]);
  }

  /**
   * `ms` pass for one workspace: every date it has, here and at Paddle, moves
   * that far into the past (one transaction), then Paddle's clock runs.
   */
  async function travel(ws: string, ms: number): Promise<void> {
    const secs = ms / 1000;
    const i = 'make_interval(secs => $2)';
    await q('BEGIN');
    try {
      await q(`UPDATE public.workspace_subscriptions
                  SET current_period_start = current_period_start - ${i}, current_period_end = current_period_end - ${i},
                      trial_end = trial_end - ${i}
                WHERE workspace_id = $1`, [ws, secs]);
      await q(`UPDATE public.billing_accounts SET next_period_start = next_period_start - ${i} WHERE workspace_id = $1`, [ws, secs]);
      await q(`UPDATE public.billing_account_cards
                  SET created_at = created_at - ${i}, paddle_next_billed_at = paddle_next_billed_at - ${i},
                      synced_at = synced_at - ${i}, next_sync_at = next_sync_at - ${i}, canceled_at = canceled_at - ${i},
                      paddle_scheduled_change = CASE
                        WHEN paddle_scheduled_change ->> 'effective_at' IS NULL THEN paddle_scheduled_change
                        ELSE jsonb_set(paddle_scheduled_change, '{effective_at}',
                               to_jsonb(to_char(((paddle_scheduled_change ->> 'effective_at')::timestamptz - ${i}) AT TIME ZONE 'UTC',
                                                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) END
                WHERE workspace_id = $1`, [ws, secs]);
      await q(`UPDATE public.billing_account_payments
                  SET created_at = created_at - ${i}, completed_at = completed_at - ${i}, verified_at = verified_at - ${i},
                      charge_requested_at = charge_requested_at - ${i}
                WHERE workspace_id = $1`, [ws, secs]);
      await q('COMMIT');
    } catch (e) {
      await q('ROLLBACK');
      throw e;
    }
    fake.shift(ws, ms);
    travels.push({ ws, at: Date.now(), ms });
    fake.runClock();
  }

  /** Travel to `offset` after Paddle's next charge date of `subId`. */
  const toPaddleDate = async (ws: string, subId: string, offset: number) => travel(ws, nextBilled(subId) - Date.now() + offset);
  /** Travel to `offset` after the end of the running period. */
  const toPeriodEnd = async (ws: string, offset: number) => travel(ws, (await periodEnd(ws)) - Date.now() + offset);

  async function newWorkspace(name: string): Promise<string> {
    const res = await call('POST', '/api/workspaces', { accountId: st.accountId, name });
    expect(res.status).toBe(200);
    const ws = String(res.json.workspaceId);
    slugs.set(ws, String((await one(`SELECT slug FROM public.workspaces WHERE id = $1`, [ws])).slug));
    return ws;
  }

  /** The checkout that saves a card (autoRenew), as the page starts it. */
  async function cardCheckout(ws: string, planId: string, interval: Interval, priceMinor: number, purpose: 'plan' | 'renewal' = 'plan') {
    const res = await call('POST', `/api/billing/account/${ws}/checkout`, {
      purpose, planId, interval, currency: 'USD', providerName: PROVIDER,
      callbackUrl: `${ORIGIN}/${slugs.get(ws)}/billing?card=setup`, expectedNetMinor: priceMinor, autoRenew: true,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return { paymentId: String(res.json.paymentId), txnId: String((res.json.clientCheckout as Row).transactionId), json: res.json };
  }

  /** A plan bought online with "renew automatically with this card", paid, and its notifications delivered. */
  async function buyWithCard(ws: string, plan: 'lite' | 'pro' | 'biz' = 'pro', interval: Interval = 'monthly', opts: { beforeDelivery?: (subId: string) => void } = {}) {
    const { paymentId, txnId } = await cardCheckout(ws, st[plan], interval, PRICES[plan][interval]);
    const { subscription } = fake.completeCheckout(txnId);
    if (!subscription) throw new Error('the card checkout made no subscription');
    opts.beforeDelivery?.(subscription.id);
    await deliver();
    const card = await one(`SELECT * FROM public.billing_account_cards WHERE provider = $1 AND subscription_id = $2`, [PROVIDER, subscription.id]);
    expect(card, 'the card is registered').toBeTruthy();
    return { paymentId, txnId, subId: subscription.id, cardId: String(card.id) };
  }

  // ─── Invariants (design §5) ──────────────────────────────────────────────

  /** How far a workspace travelled since `at` (a real time): what moves a ledger date into today's frame. */
  const travelledSince = (ws: string, at: number) => travels.filter((x) => x.ws === ws && x.at > at).reduce((s, x) => s + x.ms, 0);

  async function invariants(label: string): Promise<void> {
    // I1: the balance is what the ledger adds up to, and never negative.
    const i1 = await q(`
      SELECT a.workspace_id, a.balance_minor, coalesce(l.total, 0) AS ledger
        FROM public.billing_accounts a
        LEFT JOIN (SELECT workspace_id, sum(amount_minor) AS total FROM public.billing_account_ledger GROUP BY workspace_id) l
          ON l.workspace_id = a.workspace_id
       WHERE a.balance_minor < 0 OR a.balance_minor <> coalesce(l.total, 0)`);
    expect(i1, `${label} I1`).toEqual([]);

    // I2: every paid transaction of ours (amount > 0) is exactly one succeeded
    // payment with one credit; nothing is credited that Paddle did not collect.
    const workspaces = new Set((await q(`SELECT id FROM public.workspaces`)).map((r) => String(r.id)));
    const payments = await q(`
      SELECT p.id, p.workspace_id, p.status, p.amount_minor, p.provider_payment_id,
             (SELECT count(*)::int FROM public.billing_account_ledger l WHERE l.payment_id = p.id AND l.kind = 'topup' AND l.amount_minor > 0) AS credits
        FROM public.billing_account_payments p WHERE p.provider = $1 AND p.status = 'succeeded'`, [PROVIDER]);
    const byTxn = new Map<string, Row[]>();
    for (const p of payments) byTxn.set(String(p.provider_payment_id), [...(byTxn.get(String(p.provider_payment_id)) ?? []), p]);
    const problems: string[] = [];
    const collected = new Map<string, number>();
    for (const txn of fake.transactions.values()) {
      const ws = fake.transactionWorkspace(txn.id);
      if (!fake.isOurs(txn.id) || !ws || !workspaces.has(ws)) continue;
      const amount = Number(txn.details.totals.grand_total);
      if (!['paid', 'completed'].includes(txn.status) || amount <= 0) continue;
      collected.set(ws, (collected.get(ws) ?? 0) + amount);
      const rows = byTxn.get(txn.id) ?? [];
      if (rows.length !== 1) problems.push(`${txn.id} (${txn.origin}, ${amount}) has ${rows.length} succeeded payments`);
      else if (Number(rows[0].amount_minor) !== amount || Number(rows[0].credits) !== 1) {
        problems.push(`${txn.id}: payment ${rows[0].id} amount ${rows[0].amount_minor} credits ${rows[0].credits}`);
      }
    }
    const credited = new Map<string, number>();
    for (const p of payments) {
      credited.set(String(p.workspace_id), (credited.get(String(p.workspace_id)) ?? 0) + Number(p.amount_minor));
      const txn = fake.transactions.get(String(p.provider_payment_id));
      if (!txn || !['paid', 'completed'].includes(txn.status)) problems.push(`payment ${p.id} credited for ${p.provider_payment_id}, which Paddle did not collect`);
    }
    for (const ws of new Set([...collected.keys(), ...credited.keys()])) {
      if ((collected.get(ws) ?? 0) !== (credited.get(ws) ?? 0)) problems.push(`${ws}: Paddle collected ${collected.get(ws) ?? 0}, credited ${credited.get(ws) ?? 0}`);
    }
    expect(problems, `${label} I2`).toEqual([]);

    // I3: one renewal per period (a renewal given back by a prepaid return does not count).
    const ledger = await q(`SELECT id, workspace_id, kind, amount_minor, period_start, actor_id, created_at FROM public.billing_account_ledger
                             WHERE kind IN ('renewal', 'prepaid_return') AND period_start IS NOT NULL`);
    const net = new Map<string, number>();
    for (const row of ledger) {
      const ws = String(row.workspace_id);
      const start = t(row.period_start) - travelledSince(ws, t(row.created_at));
      const key = `${ws}:${Math.round(start / 1000)}`;
      const delta = row.kind === 'renewal' && Number(row.amount_minor) < 0 ? 1 : row.kind === 'prepaid_return' ? -1 : 0;
      net.set(key, (net.get(key) ?? 0) + delta);
    }
    expect([...net].filter(([, n]) => n > 1), `${label} I3`).toEqual([]);

    // I4: a renewal from the balance while a card was live was funded by a
    // card payment in the same transaction (its purpose_result names it), or
    // asked for by the customer.
    const cards = await q(`SELECT workspace_id, created_at, canceled_at FROM public.billing_account_cards`);
    const funded = new Set((await q(`SELECT purpose_result ->> 'ledger_id' AS id FROM public.billing_account_payments
                                       WHERE status = 'succeeded' AND purpose_result ->> 'ledger_id' IS NOT NULL`)).map((r) => String(r.id)));
    const i4 = ledger.filter((row) => {
      if (row.kind !== 'renewal' || row.actor_id || funded.has(String(row.id))) return false;
      const ws = String(row.workspace_id);
      const at = t(row.created_at) - travelledSince(ws, t(row.created_at));
      return cards.some((c) => String(c.workspace_id) === ws && t(c.created_at) <= at && (!c.canceled_at || t(c.canceled_at) > at));
    });
    expect(i4.map((r) => `${r.workspace_id} ${r.id}`), `${label} I4`).toEqual([]);

    // I5: every update previewed and do_not_bill; every /charge previewed and
    // asked once, for a pending card_charge row already marked as asked.
    expect(fake.billingViolations(), `${label} I5`).toEqual([]);
    const charges = fake.calls.filter((c) => c.method === 'POST' && /^\/subscriptions\/[^/]+\/charge$/.test(c.path));
    expect(charges.filter((c) => !(c.inspected && c.inspected.status === 'pending' && c.inspected.source === 'card_charge'
      && c.inspected.charge_requested_at && !c.inspected.provider_ref)).map((c) => c.seq), `${label} I5 charge rows`).toEqual([]);

    // I7: one subscription per workspace that is not cancelled, and Paddle and
    // our cards agree on which are alive.
    const liveCards = await q(`SELECT workspace_id, subscription_id, status FROM public.billing_account_cards WHERE status <> 'canceled'`);
    const i7: string[] = [];
    for (const ws of workspaces) {
      const alive = fake.subscriptionsOf(ws).filter((s) => s.status !== 'canceled');
      if (alive.length > 1) i7.push(`${ws}: ${alive.length} subscriptions alive`);
      for (const s of alive) {
        if (!liveCards.some((c) => c.subscription_id === s.id && c.status !== 'canceling')) i7.push(`${s.id} alive at Paddle, no live card`);
      }
    }
    for (const c of liveCards) {
      const s = fake.subscriptions.get(String(c.subscription_id));
      if (!s || s.status === 'canceled') i7.push(`card of ${c.subscription_id} is ${c.status}, Paddle's is ${s?.status ?? 'missing'}`);
    }
    expect(i7, `${label} I7`).toEqual([]);
    expect(fake.unexpectedCalls().map((c) => `${c.method} ${c.path}`), `${label} unexpected Paddle calls`).toEqual([]);
  }

  /** I6: after a stop, Paddle's clock running past its dates makes no transaction. */
  async function noChargeAfter(ws: string, subId: string): Promise<void> {
    const before = fake.transactionsOf(subId).length;
    await travel(ws, 40 * DAY);
    expect(fake.transactionsOf(subId).length, 'I6').toBe(before);
    expect(paddleSub(subId).status).toBe('canceled');
  }

  /**
   * What the billing state is (I8): balances, plans, cards, payments, the
   * ledger and Paddle's side, without the reconciler's bookkeeping (versions,
   * sync times) that a repeated notification may legitimately touch.
   */
  async function billingState(): Promise<unknown> {
    const rows = async (sql: string) => (await q(sql)).map((r) => JSON.parse(JSON.stringify(r)) as Row);
    return {
      accounts: await rows(`SELECT workspace_id, balance_minor, auto_renew, scheduled_plan_id, scheduled_interval, next_period_prepaid_minor,
                                   next_period_start, card_provider, card_subscription_id, card_customer_id
                              FROM public.billing_accounts ORDER BY workspace_id`),
      subscriptions: await rows(`SELECT workspace_id, plan_id, status, billing_interval, current_period_start, current_period_end
                                   FROM public.workspace_subscriptions ORDER BY workspace_id`),
      cards: await rows(`SELECT id, workspace_id, status, cancel_reason, cancel_intent, brand, last4, exp_month, exp_year, paddle_status,
                                paddle_next_billed_at, paddle_scheduled_change, paddle_item, last_failure
                           FROM public.billing_account_cards ORDER BY id`),
      payments: await rows(`SELECT id, status, purpose, source, amount_minor, net_minor, refunded_minor, provider_ref, provider_payment_id,
                                   card_id, review, failure_reason, purpose_result
                              FROM public.billing_account_payments ORDER BY id`),
      ledger: await rows(`SELECT id, workspace_id, kind, amount_minor, balance_after FROM public.billing_account_ledger ORDER BY id`),
      paddle: [...fake.subscriptions.values()].map((x) => ({
        id: x.id, status: x.status, next: x.next_billed_at, scheduled: x.scheduled_change, custom: x.custom_data,
        items: x.items.map((i) => [i.price.unit_price.amount, i.price.billing_cycle, i.price.custom_data]),
      })),
      transactions: [...fake.transactions.values()].map((x) => [x.id, x.status]),
    };
  }

  // ─── Setup ───────────────────────────────────────────────────────────────

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `simplebilling_card_${Date.now()}`);
    chainRef = chain;
    Object.assign(process.env, {
      DATABASE_URL: chain.url,
      PLATFORM_SIGNING_SECRET: 'signing-secret-for-this-test-only-0123456789',
      SUPABASE_URL: 'https://legacy-project.supabase.co',
      SUPABASE_ANON_KEY: 'legacy-anon-key-value',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-key-value-at-least-32',
      CORS_ORIGINS: ORIGIN,
      APP_BASE_URL: 'http://127.0.0.1:5173',
      INVITATION_LINK_SECRET: 'test-invitation-link-secret-value-32b!!',
      INVITATION_OTP_PEPPER: 'test-invitation-otp-pepper-value-32bytes',
    });
    delete process.env.DATABASE_MODE;
    delete process.env.SELF_HOST_BILLING_MODE;
    // The Iranian edition first (I9), then Multi Region.
    await q(`UPDATE public.platform_settings SET region_mode = 'iran', signup_default_plan_mode = 'trial'`);
    await q(`INSERT INTO public.billing_settings (edition, seller, vat_percent, receipt_prefix) VALUES
               ('iran', '{"legal_name":"وب‌یار"}', '{"IRR": 10}', 'WY'),
               ('international', '{"legal_name":"Respok Ltd"}', '{"USD": null}', 'RS')
             ON CONFLICT (edition) DO UPDATE SET vat_percent = EXCLUDED.vat_percent`);
    await q(`INSERT INTO public.platform_domains (app_base_url, api_base_url) SELECT 'http://127.0.0.1:5173', 'http://127.0.0.1:1' WHERE NOT EXISTS (SELECT 1 FROM public.platform_domains)`).catch(() => undefined);
    await q(`UPDATE public.platform_domains SET api_base_url = 'http://127.0.0.1:1'`).catch(() => undefined);
    await q(`INSERT INTO public.billing_gateways (provider_name, display_name, is_active, is_test, currencies, sort_order)
             VALUES ('paddle_sandbox', '{"en":"Paddle sandbox"}', true, true, '{USD}', 1)
             ON CONFLICT (provider_name) DO UPDATE SET is_active = true, currencies = EXCLUDED.currencies`);
    await q(`INSERT INTO public.billing_provider_credentials (provider_name, config) VALUES ('paddle_sandbox', $1::jsonb)
             ON CONFLICT (provider_name) DO UPDATE SET config = EXCLUDED.config`,
      [JSON.stringify({ api_key: 'pdl_sdbx_apikey_test', client_token: 'test_client_token', webhook_secret: SECRET, open_to_customers: true, card_auto_renew: true })]);
    const plan = async (slug: string, name: string, prices: { monthly: number; yearly: number }, order: number) => String((await one(
      `INSERT INTO public.billing_plans (name, slug, prices, limits, is_active, is_free, is_hidden, sort_order)
       VALUES ($1, $2, $3, '{}', true, false, false, $4) RETURNING id`,
      [name, slug, JSON.stringify({ USD: prices, IRR: { monthly: prices.monthly * 1000, yearly: prices.yearly * 1000 } }), order],
    )).id);
    st.lite = await plan('lite-card', 'Lite', PRICES.lite, 10);
    st.pro = await plan('pro-card', 'Pro', PRICES.pro, 11);
    st.proPlus = await plan('pro-plus-card', 'Pro Plus', PRICES.proPlus, 12);
    st.biz = await plan('biz-card', 'Biz', PRICES.biz, 13);

    guard = installOutboundGuard(fake);
    const { loadConfig } = await import('../../../server/config.js');
    config = loadConfig() as never;
    const billing = await import('../../../server/routes/billing.js');
    const server = express();
    server.use((req, _res, next) => { (req as unknown as { serverConfig: unknown }).serverConfig = config; next(); });
    server.use('/api/billing/webhook', billing.billingWebhookRouter);
    server.use(express.json({ limit: '5mb' }));
    server.use(cookieParser());
    server.use('/api/auth', (await import('../../../server/routes/auth.js')).authSecurityRouter);
    server.use('/api/auth-email', (await import('../../../server/routes/auth-email.js')).authEmailRouter);
    server.use('/api/workspaces', (await import('../../../server/routes/workspaces.js')).workspacesRouter);
    server.use('/api/plans', (await import('../../../server/routes/plans.js')).plansRouter);
    server.use('/api/billing', (await import('../../../server/routes/billingAccount.js')).billingAccountRouter);
    app = server.listen(0, '127.0.0.1');
    await new Promise<void>((r) => app.once('listening', () => r()));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    fake.connect((body, headers) => call('POST', `/api/billing/webhook/${PROVIDER}`, body, headers, ''));

    const signIn = async (email: string) => {
      expect((await call('POST', '/api/auth/signup', { email, password: 'correct horse battery 9', fullName: 'Owner' }, {}, '')).status).toBe(200);
      const link = captured.emails.find((e) => e.to === email && e.templateSlug === 'email_verify')?.data.action_url;
      expect((await call('POST', '/api/auth-email/verify-email', { token: new URL(String(link)).searchParams.get('token') }, {}, '')).status).toBe(200);
      const login = await call('POST', '/api/auth/login', { email, password: 'correct horse battery 9' }, {}, '');
      return login.setCookie.find((c) => c.startsWith('gs_session='))!.split(';')[0];
    };
    st.cookie = await signIn(`owner-${Date.now()}@example.test`);
    expect((await call('POST', '/api/workspaces/provision-account')).status).toBe(200);
    st.firstWs = ((await call('GET', '/api/workspaces')).json.workspaces as Array<{ id: string }>)[0].id;
    st.accountId = String(((await call('GET', '/api/workspaces/account')).json.account as { id: string }).id);
    slugs.set(st.firstWs, String((await one(`SELECT slug FROM public.workspaces WHERE id = $1`, [st.firstWs])).slug));
    await q(`INSERT INTO public.workspace_limit_overrides (workspace_id, limit_key, limit_value) VALUES ($1, 'max_workspaces', 60)`, [st.firstWs]);
    const adminEmail = `admin-${Date.now()}@example.test`;
    st.adminCookie = await signIn(adminEmail);
    await q(`INSERT INTO public.user_roles (user_id, role) SELECT id, 'admin' FROM public.profiles WHERE email = $1`, [adminEmail]);
  }, 600_000);

  afterAll(async () => {
    guard?.restore();
    await new Promise<void>((r) => (app ? app.close(() => r()) : r()));
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer();
    await chain?.drop();
  });

  // ─── The fake itself ─────────────────────────────────────────────────────

  it('the fake keeps Paddle\'s rules: renewal lock, past_due, minimum charge, billing modes, scheduled_change', async () => {
    const paddle = new FakePaddle({ webhookSecret: 'rules' });
    const api = (method: string, path: string, body?: unknown) =>
      paddle.handle(`${paddle.api}${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) })
        .then(async (r) => ({ status: r.status, json: (await r.json()) as Row }));
    const price = { name: 'Pro', description: 'Pro', unit_price: { amount: '2900', currency_code: 'USD' }, tax_mode: 'internal', product: { name: 'Pro', tax_category: 'standard' } };
    const checkout = await api('POST', '/transactions', { currency_code: 'USD', custom_data: { workspace_id: 'w' }, items: [{ quantity: 1, price: { ...price, billing_cycle: { interval: 'month', frequency: 1 } } }] });
    expect(checkout.status).toBe(201);
    const sub = paddle.completeCheckout(String((checkout.json.data as Row).id)).subscription!;
    expect(sub.custom_data).toEqual({ workspace_id: 'w' });
    const code = (r: { status: number; json: Row }) => [r.status, (r.json.error as Row | undefined)?.code];
    const item = { quantity: 1, price: { ...price, billing_cycle: { interval: 'month', frequency: 1 } } };
    // Items or the date need a billing mode; a mode that bills shows its immediate transaction, and bills.
    expect(code(await api('PATCH', `/subscriptions/${sub.id}`, { items: [item] }))).toEqual([400, 'invalid_field']);
    const bills = await api('PATCH', `/subscriptions/${sub.id}/preview`, { items: [{ ...item, price: { ...item.price, unit_price: { amount: '9900', currency_code: 'USD' } } }], proration_billing_mode: 'full_immediately' });
    expect((bills.json.data as Row).immediate_transaction).toMatchObject({ details: { totals: { grand_total: '9900' } } });
    const quiet = await api('PATCH', `/subscriptions/${sub.id}/preview`, { items: [item], proration_billing_mode: 'do_not_bill' });
    expect((quiet.json.data as Row).immediate_transaction).toBeNull();
    expect(code(await api('PATCH', `/subscriptions/${sub.id}`, { scheduled_change: { action: 'cancel' } }))).toEqual([400, 'invalid_field']);
    // Below 70 cents nothing is charged.
    const small = { effective_from: 'immediately', items: [{ quantity: 1, price: { ...price, unit_price: { amount: '69', currency_code: 'USD' } } }] };
    expect(code(await api('POST', `/subscriptions/${sub.id}/charge`, small))).toEqual([400, 'subscription_update_transaction_balance_less_than_charge_limit']);
    // Within 30 minutes of the renewal: locked.
    paddle.shift('w', Date.parse(sub.next_billed_at!) - Date.now() - 20 * MINUTE);
    expect(code(await api('PATCH', `/subscriptions/${sub.id}`, { custom_data: {} }))).toEqual([409, 'subscription_locked_renewal']);
    expect(code(await api('POST', `/subscriptions/${sub.id}/cancel`, { effective_from: 'next_billing_period' }))).toEqual([409, 'subscription_locked_renewal']);
    // Declined at its date: past_due, and no update until it is paid; cancelling still works.
    paddle.declineNext(sub.id, 'do_not_honor');
    paddle.shift('w', 21 * MINUTE);
    expect(paddle.runClock()).toBe(1);
    expect(paddle.subscriptions.get(sub.id)!.status).toBe('past_due');
    expect(code(await api('PATCH', `/subscriptions/${sub.id}`, { custom_data: {} }))).toEqual([400, 'subscription_update_when_past_due']);
    expect(code(await api('POST', `/subscriptions/${sub.id}/charge`, { ...small, items: [{ quantity: 1, price: { ...price } }] }))).toEqual([400, 'subscription_update_when_past_due']);
    const pastDue = await api('GET', `/subscriptions/${sub.id}/update-payment-method-transaction`);
    expect((pastDue.json.data as Row).status).toBe('past_due');
    expect((await api('POST', `/subscriptions/${sub.id}/cancel`, { effective_from: 'immediately' })).status).toBe(200);
    expect(paddle.transactions.get(String((pastDue.json.data as Row).id))!.status).toBe('canceled');
    // The evidence (I5) names the update sent without do_not_bill and without its preview.
    expect(paddle.billingViolations()).toEqual(expect.arrayContaining([
      expect.stringMatching(/changes items\/next_billed_at with proration_billing_mode undefined/),
      expect.stringMatching(/without its preview right before it/),
    ]));
  });

  // ─── I9: the Iranian edition ─────────────────────────────────────────────

  it('I9 the Iranian edition: no card is offered or acted on, and Paddle is never asked', async () => {
    const mark = fake.calls.length;
    const v = await view(st.firstWs);
    expect(v).toMatchObject({ edition: 'iran', currency: 'IRR', card: null, card_available: false, card_providers: [] });
    const ws = st.firstWs;
    const refused = [
      await call('POST', `/api/billing/account/${ws}/card/charge`, { purpose: 'upgrade', planId: st.biz, expectedNetMinor: 7000 }),
      await call('POST', `/api/billing/account/${ws}/card/update`, { callbackUrl: `${ORIGIN}/${slugs.get(ws)}/billing` }),
      await call('DELETE', `/api/billing/account/${ws}/card`),
      await call('POST', `/api/billing/account/${ws}/checkout`, {
        purpose: 'plan', planId: st.pro, interval: 'monthly', callbackUrl: `${ORIGIN}/${slugs.get(ws)}/billing`, expectedNetMinor: 2_900_000, autoRenew: true,
      }),
    ];
    for (const res of refused) expect([res.status, res.json.error]).toEqual([400, 'CARD_NOT_AVAILABLE']);
    // Iran's auto-renew answer is exactly what it was before the card existed.
    expect((await call('PUT', `/api/billing/account/${ws}/auto-renew`, { enabled: true })).json).toEqual({ auto_renew: true });
    expect((await call('PUT', `/api/billing/account/${ws}/auto-renew`, { enabled: false })).json).toEqual({ auto_renew: false });
    const report = await cardJob();
    expect(report).toMatchObject({ synced: 0, activated: 0, charges: 0, canceled: 0, pulled: 0, errors: [] });
    expect(callsSince(mark)).toEqual([]);
    expect(Number((await one(`SELECT count(*)::int AS n FROM public.billing_account_cards`)).n)).toBe(0);
    await invariants('I9');

    // From here on: Multi Region.
    await q(`UPDATE public.platform_settings SET region_mode = 'multi'`);
    const { invalidatePlatformRegionCache } = await import('../../../server/services/platformRegion.js');
    invalidatePlatformRegionCache();
    const { clearEntitlementCache } = await import('../../../server/middleware/featureGating.js');
    clearEntitlementCache();
  });

  // ─── S1 ──────────────────────────────────────────────────────────────────

  it('S1 a plan bought with a card: the card is live, auto-renew on, Paddle charges at period end − 24 h the price', async () => {
    const ws = await newWorkspace('Card S1');
    const before = await view(ws);
    expect(before).toMatchObject({ edition: 'international', currency: 'USD', card: null, card_available: true, card_providers: [PROVIDER], auto_renew: false });
    const { paymentId, txnId, subId, cardId } = await buyWithCard(ws, 'pro');

    // The checkout Paddle was asked for: a recurring price, the full price, what each renewal is for.
    const checkout = fake.transactions.get(txnId)!;
    expect(checkout.items[0].price).toMatchObject({
      unit_price: { amount: '2900', currency_code: 'USD' }, billing_cycle: { interval: 'month', frequency: 1 }, tax_mode: 'internal',
      custom_data: { plan_id: st.pro, interval: 'monthly', net_minor: 2900, tax_minor: 0 },
    });
    expect(checkout.custom_data).toEqual({ workspace_id: ws, intent_id: paymentId, card_setup: '1' });

    const card = await cardRow(cardId);
    expect(card).toMatchObject({ status: 'active', brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030, customer_id: paddleSub(subId).customer_id, setup_payment_id: paymentId, cancel_intent: null });
    expect(await accountOf(ws)).toMatchObject({ auto_renew: true, card_provider: PROVIDER, card_subscription_id: subId, card_customer_id: paddleSub(subId).customer_id });
    expect(await one(`SELECT source, status, card_id, purpose FROM public.billing_account_payments WHERE id = $1`, [paymentId]))
      .toEqual({ source: 'card_setup', status: 'succeeded', card_id: cardId, purpose: 'plan' });
    const sub = await subOf(ws);
    expect(sub).toMatchObject({ plan_id: st.pro, status: 'active', billing_interval: 'monthly' });
    const E = t(sub.current_period_end);

    // Paddle follows: 24 h before our period end, the next period's price, our custom_data only.
    const paddle = paddleSub(subId);
    expect(Math.abs(t(paddle.next_billed_at) - (E - DAY))).toBeLessThan(1000);
    expect(paddle.items).toHaveLength(1);
    expect(paddle.items[0].price).toMatchObject({ unit_price: { amount: '2900' }, billing_cycle: { interval: 'month', frequency: 1 }, custom_data: { plan_id: st.pro, interval: 'monthly', net_minor: 2900, tax_minor: 0 } });
    expect(paddle.custom_data).toEqual({ workspace_id: ws, card_id: cardId });

    const v = await view(ws);
    expect(v.auto_renew).toBe(true);
    expect(v.card).toMatchObject({
      id: cardId, provider: PROVIDER, status: 'active', brand: 'visa', last4: '4242', auto_renew: true,
      next_charge_minor: 2900, next_charge_interval: 'monthly', next_charge_plan: { plan_id: st.pro }, scheduled_cancel_at: null,
      last_failure: null, frozen_until: null, expires_before_next_charge: false,
    });
    expect(t((v.card as Row).next_charge_at)).toBe(t(paddle.next_billed_at));
    await mailsSettle();
    expect(mailsOf(ws, 'billing_plan_activated')).toHaveLength(1);
    expect(mailsOf(ws, 'billing_payment_receipt')).toHaveLength(1);
    // A second card cannot be saved while this one is live.
    const again = await call('POST', `/api/billing/account/${ws}/checkout`, {
      purpose: 'renewal', currency: 'USD', providerName: PROVIDER, callbackUrl: `${ORIGIN}/${slugs.get(ws)}/billing`, expectedNetMinor: 2900, autoRenew: true,
    });
    expect([again.status, again.json.error]).toEqual([409, 'CARD_ALREADY_SAVED']);
    // The card pays the renewal: paying it online is refused.
    const online = await call('POST', `/api/billing/account/${ws}/checkout`, { purpose: 'renewal', currency: 'USD', callbackUrl: `${ORIGIN}/${slugs.get(ws)}/billing` });
    expect([online.status, online.json.error]).toEqual([409, 'CARD_PAYS_RENEWAL']);
    await settle();

    // Change card: Paddle's zero-amount update transaction; paying it with another card refreshes ours, charging nothing.
    const update = await call('POST', `/api/billing/account/${ws}/card/update`, { callbackUrl: `${ORIGIN}/${slugs.get(ws)}/billing?card=updated` });
    expect(update.status).toBe(200);
    const change = fake.transactions.get(String(update.json.transactionId))!;
    expect(change).toMatchObject({ origin: 'subscription_payment_method_change', subscription_id: subId, details: { totals: { grand_total: '0' } } });
    fake.completeCheckout(change.id, { card: MASTERCARD_5555 });
    await settle();
    expect(await cardRow(cardId)).toMatchObject({ status: 'active', brand: 'mastercard', last4: '5555', exp_month: 6, exp_year: 2031 });
    expect(await paymentsOf(ws)).toHaveLength(1);
    await invariants('S1');
  });

  // ─── S2 ──────────────────────────────────────────────────────────────────

  it('S2 Paddle renews at its date: the prepaid next period; the due moment starts it; Paddle already follows', async () => {
    const ws = await newWorkspace('Card S2');
    const { subId, cardId } = await buyWithCard(ws, 'pro');

    // Three days before the end: no renewal reminder, the card pays.
    await toPeriodEnd(ws, -3 * DAY + HOUR);
    const { runSimpleBillingJob } = await import('../../../server/services/billing/account/job.js');
    await runSimpleBillingJob(config);
    await mailsSettle();
    expect(mailsOf(ws, 'billing_renewal_reminder')).toEqual([]);

    // Around Paddle's date plan changes wait.
    await toPaddleDate(ws, subId, -HOUR);
    const frozen = await call('POST', `/api/billing/account/${ws}/change`, { planId: st.lite, interval: 'monthly' });
    expect([frozen.status, frozen.json.error]).toEqual([409, 'CARD_RENEWAL_IN_PROGRESS']);
    expect(((await view(ws)).card as Row).frozen_until).toBeTruthy();

    // Within Paddle's own lock (30 minutes before its charge) turning auto-renew off is refused, and nothing changes here.
    await toPaddleDate(ws, subId, -20 * MINUTE);
    const locked = await call('PUT', `/api/billing/account/${ws}/auto-renew`, { enabled: false });
    expect([locked.status, locked.json.error]).toEqual([409, 'CARD_RENEWAL_IN_PROGRESS']);
    expect((await accountOf(ws)).auto_renew).toBe(true);
    expect(await cardRow(cardId)).toMatchObject({ cancel_intent: null });
    expect(paddleSub(subId).scheduled_change).toBeNull();

    // Paddle renews.
    await toPaddleDate(ws, subId, MINUTE);
    const renewal = fake.transactionsOf(subId).find((x) => x.origin === 'subscription_recurring')!;
    expect(renewal).toMatchObject({ status: 'completed', custom_data: { workspace_id: ws, card_id: cardId } });
    expect(renewal.items[0].price.custom_data).toMatchObject({ plan_id: st.pro, net_minor: 2900 });
    await settle();
    const paid = await one(`SELECT * FROM public.billing_account_payments WHERE provider_ref = $1`, [renewal.id]);
    expect(paid).toMatchObject({ source: 'card_renewal', purpose: 'renewal', status: 'succeeded', card_id: cardId, review: null });
    expect(paid.purpose_result).toMatchObject({ action: 'prepaid', card: true, amount_minor: 2900 });
    expect(await accountOf(ws)).toMatchObject({ next_period_prepaid_minor: '2900', balance_minor: '0' });
    await mailsSettle();
    // Our renewal mail is the card's own, naming the card (billing_renewed is the balance's).
    expect(mailsOf(ws, 'billing_card_renewed').map((m) => m.data.card)).toEqual(['Visa •••• 4242']);
    expect(mailsOf(ws, 'billing_renewed')).toEqual([]);
    expect(mailsOf(ws, 'billing_payment_receipt')).toHaveLength(1); // the checkout's only: Paddle's invoice is the renewal's
    // Paddle's next date is the end of the prepaid period − 24 h.
    expect(Math.abs(nextBilled(subId) - (await expectedChargeAt(ws)))).toBeLessThan(1000);

    // The due moment: the prepaid period starts, with no second mail; Paddle is not asked to change or charge anything.
    const mark = fake.calls.length;
    const end = await periodEnd(ws);
    const moved = end - Date.now() + MINUTE;
    await travel(ws, moved);
    const due = await dueJob();
    expect(due.errors).toEqual([]);
    const sub = await subOf(ws);
    expect(sub).toMatchObject({ plan_id: st.pro, status: 'active' });
    expect(t(sub.current_period_start)).toBe(end - moved);
    expect(t(sub.current_period_end)).toBe(t(periodEndOf(new Date(end - moved).toISOString(), 'monthly')));
    expect((await accountOf(ws)).next_period_prepaid_minor).toBeNull();
    await settle();
    await mailsSettle();
    expect(mailsOf(ws, 'billing_card_renewed')).toHaveLength(1);
    expect(mailsOf(ws, 'billing_renewed')).toEqual([]);
    expect(callsSince(mark).filter((c) => c.method === 'POST')).toEqual([]);
    expect(Math.abs(nextBilled(subId) - (await expectedChargeAt(ws)))).toBeLessThan(1000);
    await invariants('S2');
  });

  // ─── S3 ──────────────────────────────────────────────────────────────────

  it('S3 declined at Paddle\'s date, then the due moment: Free, the subscription cancelled at once, nothing charged later', async () => {
    const ws = await newWorkspace('Card S3');
    const { subId, cardId } = await buyWithCard(ws, 'pro');
    fake.declineNext(subId, 'expired_card');
    await toPaddleDate(ws, subId, MINUTE);
    const renewal = fake.transactionsOf(subId).find((x) => x.origin === 'subscription_recurring')!;
    expect(renewal.status).toBe('past_due');
    expect(paddleSub(subId).status).toBe('past_due');
    await settle();
    expect(await cardRow(cardId)).toMatchObject({ status: 'past_due', last_failure: { code: 'expired_card', txn: renewal.id } });
    expect(await one(`SELECT source, status, failure_reason FROM public.billing_account_payments WHERE provider_ref = $1`, [renewal.id]))
      .toEqual({ source: 'card_renewal', status: 'pending', failure_reason: 'expired_card' });
    await mailsSettle();
    const failed = mailsOf(ws, 'billing_card_payment_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].data).toMatchObject({ card: 'Visa •••• 4242', failure_reason: 'the card has expired', amount: '$29.00', plan_name: 'Pro' });
    expect((await view(ws)).card).toMatchObject({ status: 'past_due', last_failure: { code: 'expired_card' } });
    // While the card is past_due plans do not change and it is not charged.
    const change = await call('POST', `/api/billing/account/${ws}/change`, { planId: st.lite, interval: 'monthly' });
    expect([change.status, change.json.error]).toEqual([409, 'CARD_PAST_DUE']);
    const charge = await call('POST', `/api/billing/account/${ws}/card/charge`, { purpose: 'upgrade', planId: st.biz, expectedNetMinor: 7000 });
    expect([charge.status, charge.json.error]).toEqual([409, 'CARD_PAST_DUE']);

    // The due moment with nothing paid: Free at once, and Paddle stops (no dunning collects later).
    await toPeriodEnd(ws, MINUTE);
    const due = await dueJob();
    expect(due.errors).toEqual([]);
    expect(due.expired).toBeGreaterThanOrEqual(1);
    expect(await subOf(ws)).toMatchObject({ status: 'expired', plan_id: st.pro });
    expect(await cardRow(cardId)).toMatchObject({ status: 'canceled', cancel_reason: 'not_renewed' });
    expect(await accountOf(ws)).toMatchObject({ auto_renew: false, card_provider: null, card_subscription_id: null });
    expect(paddleSub(subId).status).toBe('canceled');
    expect(fake.transactions.get(renewal.id)!.status).toBe('canceled');
    await settle();
    expect(await one(`SELECT status, failure_reason FROM public.billing_account_payments WHERE provider_ref = $1`, [renewal.id]))
      .toEqual({ status: 'canceled', failure_reason: 'paddle_canceled' });
    await mailsSettle();
    expect(mailsOf(ws, 'billing_expired')).toHaveLength(1);
    expect(mailsOf(ws, 'billing_card_removed')).toEqual([]);
    expect(mailsOf(ws, 'billing_card_payment_failed')).toHaveLength(1);
    expect((await view(ws)).card).toBeNull();
    expect(await balanceOf(ws)).toBe(0);
    await noChargeAfter(ws, subId);
    await invariants('S3');
  });

  it('S3 auto-renew off on a declined card stops it at once: its renewal can no longer be collected, the plan runs to its end', async () => {
    const ws = await newWorkspace('Card S3 off');
    const { subId, cardId } = await buyWithCard(ws, 'pro');
    fake.declineNext(subId, 'expired_card');
    await toPaddleDate(ws, subId, MINUTE);
    await settle();
    expect((await cardRow(cardId)).status).toBe('past_due');
    const pastDue = fake.transactionsOf(subId).find((x) => x.status === 'past_due')!;

    const off = await call('PUT', `/api/billing/account/${ws}/auto-renew`, { enabled: false });
    expect(off.status, JSON.stringify(off.json)).toBe(200);
    expect(off.json).toMatchObject({ auto_renew: false, card: null });
    expect(paddleSub(subId).status).toBe('canceled');
    expect(fake.transactions.get(pastDue.id)!.status).toBe('canceled');
    expect(await cardRow(cardId)).toMatchObject({ status: 'canceled', cancel_reason: 'auto_renew_off' });
    expect(await accountOf(ws)).toMatchObject({ auto_renew: false, card_subscription_id: null });
    await settle();
    // "Update card and pay" is gone with the card; Paddle cannot collect the renewal any more.
    const update = await call('POST', `/api/billing/account/${ws}/card/update`, { callbackUrl: `${ORIGIN}/${slugs.get(ws)}/billing?card=updated` });
    expect(update.status).toBe(404);
    expect(await one(`SELECT status FROM public.billing_account_payments WHERE provider_ref = $1`, [pastDue.id])).toEqual({ status: 'canceled' });
    expect(await balanceOf(ws)).toBe(0);
    await mailsSettle();
    expect(mailsOf(ws, 'billing_card_removed').map((m) => m.data.reason)).toEqual(['automatic renewal was turned off']);

    // The plan runs to its end, then Free; nothing is charged later.
    expect((await view(ws)).plan).toMatchObject({ status: 'active' });
    await toPeriodEnd(ws, MINUTE);
    expect((await dueJob()).errors).toEqual([]);
    expect(await subOf(ws)).toMatchObject({ status: 'expired' });
    await noChargeAfter(ws, subId);
    await invariants('S3 auto-renew off');
  });

  // ─── S4 ──────────────────────────────────────────────────────────────────

  it('S4 declined, then paid with a new card before the due moment: the renewal counts and the card is active again', async () => {
    const ws = await newWorkspace('Card S4');
    const { subId, cardId } = await buyWithCard(ws, 'pro');
    fake.declineNext(subId, 'insufficient_funds');
    await toPaddleDate(ws, subId, MINUTE);
    await settle();
    expect((await cardRow(cardId)).status).toBe('past_due');
    // "Update card and pay": Paddle's past_due renewal itself, opened in Paddle.js.
    const pastDue = fake.transactionsOf(subId).find((x) => x.status === 'past_due')!;
    const update = await call('POST', `/api/billing/account/${ws}/card/update`, { callbackUrl: `${ORIGIN}/${slugs.get(ws)}/billing?card=updated` });
    expect(update.status).toBe(200);
    expect(update.json).toMatchObject({
      transactionId: pastDue.id,
      clientCheckout: { transactionId: pastDue.id, provider: PROVIDER, environment: 'sandbox', successUrl: `${ORIGIN}/${slugs.get(ws)}/billing?card=updated` },
    });
    fake.completeCheckout(pastDue.id, { card: MASTERCARD_5555 });
    await settle();
    expect(await cardRow(cardId)).toMatchObject({ status: 'active', brand: 'mastercard', last4: '5555', exp_month: 6, exp_year: 2031, last_failure: null });
    const paid = await one(`SELECT * FROM public.billing_account_payments WHERE provider_ref = $1`, [pastDue.id]);
    expect(paid).toMatchObject({ source: 'card_renewal', status: 'succeeded' });
    expect(paid.purpose_result).toMatchObject({ action: 'prepaid', card: true });
    expect((await accountOf(ws)).next_period_prepaid_minor).toBe('2900');
    await mailsSettle();
    expect(mailsOf(ws, 'billing_card_renewed').map((m) => m.data.card)).toEqual(['Mastercard •••• 5555']);
    expect(mailsOf(ws, 'billing_card_payment_failed')).toHaveLength(1);

    // The due moment: the period it paid starts; the card goes on.
    await toPeriodEnd(ws, MINUTE);
    expect((await dueJob()).errors).toEqual([]);
    expect(await subOf(ws)).toMatchObject({ status: 'active', plan_id: st.pro });
    await settle();
    expect(Math.abs(nextBilled(subId) - (await expectedChargeAt(ws)))).toBeLessThan(1000);
    expect((await view(ws)).card).toMatchObject({ status: 'active', brand: 'mastercard', last4: '5555', last_failure: null });
    await invariants('S4');
  });

  // ─── S5 ──────────────────────────────────────────────────────────────────

  it('S5 a renewal whose notifications were all lost is found by the pull at the due moment', async () => {
    const ws = await newWorkspace('Card S5');
    const { subId } = await buyWithCard(ws, 'pro');
    await toPaddleDate(ws, subId, MINUTE);
    const renewal = fake.transactionsOf(subId).find((x) => x.origin === 'subscription_recurring')!;
    expect(renewal.status).toBe('completed');
    expect(await fake.deliver({ drop: (e) => e.subscriptionId === subId })).toEqual([]);
    expect(Number((await one(`SELECT count(*)::int AS n FROM public.billing_account_payments WHERE provider_ref = $1`, [renewal.id])).n)).toBe(0);

    // The period ends; the page is opened before the job ran: the renewal is found and the plan goes on.
    const end = await periodEnd(ws);
    const moved = end - Date.now() + MINUTE;
    await travel(ws, moved);
    const v = await view(ws);
    expect(v.plan).toMatchObject({ slug: 'pro-card', status: 'active' });
    const sub = await subOf(ws);
    expect(t(sub.current_period_start)).toBe(end - moved);
    const paid = await one(`SELECT * FROM public.billing_account_payments WHERE provider_ref = $1`, [renewal.id]);
    expect(paid).toMatchObject({ source: 'card_renewal', status: 'succeeded' });
    expect(paid.purpose_result).toMatchObject({ action: 'renewed', card: true });
    await settle();
    await mailsSettle();
    expect(mailsOf(ws, 'billing_card_renewed').map((m) => m.data.card)).toEqual(['Visa •••• 4242']);
    expect(mailsOf(ws, 'billing_expired')).toEqual([]);
    expect(Math.abs(nextBilled(subId) - (await expectedChargeAt(ws)))).toBeLessThan(1000);
    await invariants('S5');
  });

  // ─── S6 ──────────────────────────────────────────────────────────────────

  it('S6 a renewal carrying the checkout\'s intent_id (Paddle merging custom_data) is a renewal, not a replay of the checkout', async () => {
    const ws = await newWorkspace('Card S6');
    const mark = fake.calls.length;
    const { subId, cardId, paymentId } = await buyWithCard(ws, 'pro', 'monthly', { beforeDelivery: (id) => fake.mergeCustomData(id) });
    await settle();
    // Paddle keeps what it merged; our keys are written once, not again on every notification that causes.
    expect(paddleSub(subId).custom_data).toEqual({ workspace_id: ws, intent_id: paymentId, card_setup: '1', card_id: cardId });
    expect(patchesOf(subId, mark).filter((c) => c.body && 'custom_data' in c.body)).toHaveLength(1);
    const balance = await balanceOf(ws);

    await toPaddleDate(ws, subId, MINUTE);
    const renewal = fake.transactionsOf(subId).find((x) => x.origin === 'subscription_recurring')!;
    expect(renewal.custom_data).toMatchObject({ intent_id: paymentId, workspace_id: ws });
    const results = await deliver();
    expect(results.filter((r) => r.queued.transactionId === renewal.id).map((r) => r.body)).toEqual(
      results.filter((r) => r.queued.transactionId === renewal.id).map(() => ({ received: true })),
    );
    await settle();
    const paid = await one(`SELECT * FROM public.billing_account_payments WHERE provider_ref = $1`, [renewal.id]);
    expect(paid).toMatchObject({ source: 'card_renewal', purpose: 'renewal', status: 'succeeded' });
    expect(paid.purpose_result).toMatchObject({ action: 'prepaid' });
    // The checkout's payment: still one credit, untouched.
    expect(Number((await one(`SELECT count(*)::int AS n FROM public.billing_account_ledger WHERE payment_id = $1`, [paymentId])).n)).toBe(1);
    expect(await balanceOf(ws)).toBe(balance);
    await invariants('S6');
  });

  // ─── S7 ──────────────────────────────────────────────────────────────────

  it('S7 an upgrade charged to the card: the exact difference, once; then the item is swapped and the date stays', async () => {
    const ws = await newWorkspace('Card S7');
    const { subId, cardId } = await buyWithCard(ws, 'pro');
    const nBefore = nextBilled(subId);
    const quote = (await call('GET', `/api/billing/account/${ws}/quote?planId=${st.biz}&interval=monthly`)).json;
    expect(quote).toMatchObject({ kind: 'upgrade', amount_minor: 7000, returned_minor: 0 });
    // An amount the page did not show is refused before Paddle is asked.
    const mark = fake.calls.length;
    const stale = await call('POST', `/api/billing/account/${ws}/card/charge`, { purpose: 'upgrade', planId: st.biz, expectedNetMinor: 6999 });
    expect([stale.status, stale.json.error]).toEqual([409, 'QUOTE_CHANGED']);
    expect(callsSince(mark)).toEqual([]);

    // An upgrade of less than Paddle's minimum charge is not offered on the card.
    const tiny = await call('POST', `/api/billing/account/${ws}/card/charge`, { purpose: 'upgrade', planId: st.proPlus, expectedNetMinor: 50 });
    expect([tiny.status, tiny.json.error, tiny.json.details]).toEqual([400, 'CARD_CHARGE_BELOW_MINIMUM', { minimum_minor: 70, amount_minor: 50 }]);
    expect(callsSince(mark)).toEqual([]);

    const res = await call('POST', `/api/billing/account/${ws}/card/charge`, { purpose: 'upgrade', planId: st.biz, expectedNetMinor: 7000 });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toMatchObject({ status: 'succeeded', purpose_result: { action: 'upgraded' } });
    const paymentId = String(res.json.paymentId);
    const charges = callsSince(mark).filter((c) => c.method === 'POST' && c.path === `/subscriptions/${subId}/charge`);
    expect(charges).toHaveLength(1);
    expect(charges[0].body).toMatchObject({
      effective_from: 'immediately', on_payment_failure: 'prevent_change',
      items: [{ quantity: 1, price: { unit_price: { amount: '7000', currency_code: 'USD' }, tax_mode: 'internal', custom_data: { payment_id: paymentId, workspace_id: ws } } }],
    });
    const chargeTxn = fake.transactionsOf(subId).find((x) => x.origin === 'subscription_charge')!;
    expect(await one(`SELECT source, purpose, status, provider_ref, card_id, amount_minor FROM public.billing_account_payments WHERE id = $1`, [paymentId]))
      .toEqual({ source: 'card_charge', purpose: 'upgrade', status: 'succeeded', provider_ref: chargeTxn.id, card_id: cardId, amount_minor: '7000' });
    expect(await subOf(ws)).toMatchObject({ plan_id: st.biz, status: 'active' });
    // The next renewal is the new plan's price; Paddle's date did not move.
    expect(paddleSub(subId).items[0].price).toMatchObject({ unit_price: { amount: '9900' }, custom_data: { plan_id: st.biz, net_minor: 9900 } });
    expect(nextBilled(subId)).toBe(nBefore);
    // Paddle's own notifications of that charge settle nothing more.
    await settle();
    expect(await balanceOf(ws)).toBe(0);
    expect((await q(`SELECT kind, amount_minor FROM public.billing_account_ledger WHERE workspace_id = $1 ORDER BY created_at`, [ws])).map((r) => [r.kind, Number(r.amount_minor)]))
      .toEqual([['topup', 2900], ['plan', -2900], ['topup', 7000], ['upgrade', -7000]]);
    expect((await view(ws)).card).toMatchObject({ next_charge_minor: 9900, next_charge_plan: { plan_id: st.biz }, next_charge_interval: 'monthly' });
    await mailsSettle();
    expect(mailsOf(ws, 'billing_plan_activated')).toHaveLength(2);
    await invariants('S7');
  });

  // ─── S8 ──────────────────────────────────────────────────────────────────

  it('S8 an upgrade the card declines: refused with the card\'s reason, nothing changed, and no second row from Paddle\'s events', async () => {
    const ws = await newWorkspace('Card S8');
    const { subId } = await buyWithCard(ws, 'pro');
    fake.declineNext(subId, 'insufficient_funds');
    const res = await call('POST', `/api/billing/account/${ws}/card/charge`, { purpose: 'upgrade', planId: st.biz, expectedNetMinor: 7000 });
    expect([res.status, res.json.error, (res.json.details as Row)?.code]).toEqual([402, 'CARD_DECLINED', 'insufficient_funds']);
    const rows = async () => (await paymentsOf(ws, 'card_charge')).map((r) => [r.status, r.failure_reason]);
    expect(await rows()).toEqual([['failed', 'card_declined']]);
    expect(await subOf(ws)).toMatchObject({ plan_id: st.pro });
    expect(paddleSub(subId).items[0].price.unit_price.amount).toBe('2900');
    await settle();
    expect(await rows()).toEqual([['failed', 'card_declined']]);
    expect(await balanceOf(ws)).toBe(0);

    // The next attempt: the card pays.
    const again = await call('POST', `/api/billing/account/${ws}/card/charge`, { purpose: 'upgrade', planId: st.biz, expectedNetMinor: 7000 });
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect(await subOf(ws)).toMatchObject({ plan_id: st.biz });
    await settle();
    expect(await rows()).toEqual([['failed', 'card_declined'], ['succeeded', null]]);
    await invariants('S8');
  });

  // ─── S9 ──────────────────────────────────────────────────────────────────

  it('S9 an upgrade whose answer was lost: never asked twice, found and settled once', async () => {
    const ws = await newWorkspace('Card S9');
    const { subId } = await buyWithCard(ws, 'pro');
    fake.failAfterCreate(subId);
    const res = await call('POST', `/api/billing/account/${ws}/card/charge`, { purpose: 'upgrade', planId: st.biz, expectedNetMinor: 7000 });
    expect(res.status, JSON.stringify(res.json)).toBe(202);
    expect(res.json).toMatchObject({ status: 'processing' });
    const paymentId = String(res.json.paymentId);
    // Paddle charged it, but nobody here knows yet.
    const chargeTxn = fake.transactionsOf(subId).find((x) => x.origin === 'subscription_charge')!;
    expect(chargeTxn.status).toBe('completed');
    const pending = await one(`SELECT status, charge_requested_at, provider_ref FROM public.billing_account_payments WHERE id = $1`, [paymentId]);
    expect(pending.status).toBe('pending');
    expect(pending.charge_requested_at).toBeTruthy();
    expect(await subOf(ws)).toMatchObject({ plan_id: st.pro });
    // A second click while it is unknown is refused; Paddle is not asked again.
    const mark = fake.calls.length;
    const twice = await call('POST', `/api/billing/account/${ws}/card/charge`, { purpose: 'upgrade', planId: st.biz, expectedNetMinor: 7000 });
    expect([twice.status, twice.json.error]).toEqual([409, 'CARD_CHARGE_IN_PROGRESS']);
    expect(callsSince(mark).filter((c) => c.path.endsWith('/charge'))).toEqual([]);

    // Paddle's notifications are late: the job looks the charge up by its payment id and settles it.
    await travel(ws, 3 * MINUTE);
    const report = await cardJob();
    expect(report.errors).toEqual([]);
    expect(report.charges).toBeGreaterThanOrEqual(1);
    expect(await one(`SELECT status, provider_ref FROM public.billing_account_payments WHERE id = $1`, [paymentId]))
      .toEqual({ status: 'succeeded', provider_ref: chargeTxn.id });
    expect(await subOf(ws)).toMatchObject({ plan_id: st.biz });
    expect(paddleSub(subId).items[0].price.unit_price.amount).toBe('9900');
    // The late notifications and the customer's return: nothing more.
    await settle();
    const verify = await call('POST', `/api/billing/account/${ws}/payments/${paymentId}/verify`, { provider: PROVIDER, params: {} });
    expect(verify.json).toMatchObject({ status: 'succeeded' });
    expect(fake.calls.filter((c) => c.path === `/subscriptions/${subId}/charge`)).toHaveLength(1);
    expect(await balanceOf(ws)).toBe(0);
    await invariants('S9');
  });

  // ─── S10 ─────────────────────────────────────────────────────────────────

  it('S10 a downgrade, then an interval change: Paddle\'s item follows, its date does not move, and it renews the new plan', async () => {
    const ws = await newWorkspace('Card S10');
    const { subId } = await buyWithCard(ws, 'biz');
    const n = nextBilled(subId);
    const mark = fake.calls.length;
    const down = await call('POST', `/api/billing/account/${ws}/change`, { planId: st.pro, interval: 'monthly' });
    expect(down.json).toMatchObject({ action: 'change_scheduled' });
    expect(paddleSub(subId).items[0].price).toMatchObject({ unit_price: { amount: '2900' }, billing_cycle: { interval: 'month' }, custom_data: { plan_id: st.pro, interval: 'monthly' } });
    expect(nextBilled(subId)).toBe(n);
    const yearly = await call('POST', `/api/billing/account/${ws}/change`, { planId: st.pro, interval: 'yearly' });
    expect(yearly.json).toMatchObject({ action: 'change_scheduled' });
    expect(paddleSub(subId).items[0].price).toMatchObject({ unit_price: { amount: '29000' }, billing_cycle: { interval: 'year', frequency: 1 }, custom_data: { plan_id: st.pro, interval: 'yearly', net_minor: 29000 } });
    expect(paddleSub(subId).billing_cycle).toEqual({ interval: 'year', frequency: 1 });
    expect(nextBilled(subId)).toBe(n);
    const patches = patchesOf(subId, mark);
    expect(patches).toHaveLength(2);
    expect(patches.every((c) => c.body?.proration_billing_mode === 'do_not_bill' && !('next_billed_at' in (c.body ?? {})))).toBe(true);
    expect((await view(ws)).card).toMatchObject({ next_charge_minor: 29000, next_charge_interval: 'yearly', next_charge_plan: { plan_id: st.pro } });
    await settle();
    expect(patchesOf(subId, mark)).toHaveLength(2);

    // Paddle renews: the new plan, for a year.
    await toPaddleDate(ws, subId, MINUTE);
    const renewal = fake.transactionsOf(subId).find((x) => x.origin === 'subscription_recurring')!;
    expect(renewal.details.totals.grand_total).toBe('29000');
    await settle();
    const paid = await one(`SELECT * FROM public.billing_account_payments WHERE provider_ref = $1`, [renewal.id]);
    expect(paid).toMatchObject({ source: 'card_renewal', purpose: 'renewal', status: 'succeeded' });
    expect(paid.purpose_detail).toMatchObject({ plan_id: st.pro, billing_interval: 'yearly' });
    await toPeriodEnd(ws, MINUTE);
    expect((await dueJob()).errors).toEqual([]);
    const sub = await subOf(ws);
    expect(sub).toMatchObject({ plan_id: st.pro, billing_interval: 'yearly', status: 'active' });
    expect(t(sub.current_period_end)).toBe(t(periodEndOf(new Date(t(sub.current_period_start)).toISOString(), 'yearly')));
    await settle();
    expect(Math.abs(nextBilled(subId) - (await expectedChargeAt(ws)))).toBeLessThan(1000);
    await invariants('S10');
  });

  // ─── S11 ─────────────────────────────────────────────────────────────────

  it('S11 auto-renew off, on, off again: Paddle confirms each, then ends the subscription at its date without a charge', async () => {
    const ws = await newWorkspace('Card S11');
    const { subId, cardId } = await buyWithCard(ws, 'pro');
    const n = nextBilled(subId);
    const off = await call('PUT', `/api/billing/account/${ws}/auto-renew`, { enabled: false });
    expect(off.json).toMatchObject({ auto_renew: false, card: { next_charge_at: null } });
    expect(t((off.json.card as Row).scheduled_cancel_at)).toBe(n);
    expect(paddleSub(subId)).toMatchObject({ status: 'active', next_billed_at: null, scheduled_change: { action: 'cancel' } });
    expect(t(paddleSub(subId).scheduled_change!.effective_at)).toBe(n);
    expect(await cardRow(cardId)).toMatchObject({ status: 'active', cancel_intent: 'period_end' });

    const on = await call('PUT', `/api/billing/account/${ws}/auto-renew`, { enabled: true });
    expect(on.json).toMatchObject({ auto_renew: true, card: { scheduled_cancel_at: null } });
    expect(paddleSub(subId).scheduled_change).toBeNull();
    expect(nextBilled(subId)).toBe(n);
    expect(await cardRow(cardId)).toMatchObject({ cancel_intent: null });

    const again = await call('PUT', `/api/billing/account/${ws}/auto-renew`, { enabled: false });
    expect(again.json).toMatchObject({ auto_renew: false });
    // Paddle's notifications of these changes undo nothing.
    await settle();
    expect(paddleSub(subId).scheduled_change).toMatchObject({ action: 'cancel' });
    await mailsSettle();
    expect(mailsOf(ws, 'billing_card_removed')).toEqual([]);

    // Paddle's date passes: the subscription ends there, and nothing is charged.
    await travel(ws, t(paddleSub(subId).scheduled_change!.effective_at) - Date.now() + MINUTE);
    expect(paddleSub(subId).status).toBe('canceled');
    expect(fake.transactionsOf(subId).filter((x) => x.origin !== 'api')).toEqual([]);
    await settle();
    expect(await cardRow(cardId)).toMatchObject({ status: 'canceled', cancel_reason: 'period_end' });
    await mailsSettle();
    expect(mailsOf(ws, 'billing_card_removed').map((m) => m.data.reason)).toEqual(['automatic renewal was turned off']);
    // The plan runs to its end, then ends; the balance is not touched.
    expect((await view(ws)).plan).toMatchObject({ status: 'active' });
    await toPeriodEnd(ws, MINUTE);
    expect((await dueJob()).errors).toEqual([]);
    expect(await subOf(ws)).toMatchObject({ status: 'expired' });
    await noChargeAfter(ws, subId);
    await invariants('S11');
  });

  // ─── S12 ─────────────────────────────────────────────────────────────────

  it('S12 remove the card: cancelled at Paddle first; the balance is not used at the due moment; the next card reuses the customer', async () => {
    const ws = await newWorkspace('Card S12');
    const { subId, cardId } = await buyWithCard(ws, 'pro');
    const customer = paddleSub(subId).customer_id;
    await q(`SELECT public.billing_account_admin_adjust($1, 10000, 'USD', 'e2e credit', NULL, $2)`, [ws, `s12-credit-${ws}`]);
    const removed = await call('DELETE', `/api/billing/account/${ws}/card`);
    expect([removed.status, removed.json]).toEqual([200, { removed: true }]);
    expect(await cardRow(cardId)).toMatchObject({ status: 'canceled', cancel_reason: 'removed', cancel_intent: 'now' });
    expect(await accountOf(ws)).toMatchObject({ auto_renew: false, card_provider: null, card_subscription_id: null, card_customer_id: customer });
    expect(paddleSub(subId).status).toBe('canceled');
    await mailsSettle();
    expect(mailsOf(ws, 'billing_card_removed').map((m) => m.data.reason)).toEqual(['you removed the card']);
    const v = await view(ws);
    expect(v).toMatchObject({ card: null, auto_renew: false, plan: { status: 'active' } });
    // Removing it again: there is none.
    const twice = await call('DELETE', `/api/billing/account/${ws}/card`);
    expect([twice.status, twice.json.error]).toEqual([404, 'CARD_NOT_FOUND']);
    await settle();

    // The due moment: the plan ends; the 100.00 in the balance stays there.
    await toPeriodEnd(ws, MINUTE);
    expect((await dueJob()).errors).toEqual([]);
    expect(await subOf(ws)).toMatchObject({ status: 'expired' });
    expect(await balanceOf(ws)).toBe(10000);
    await noChargeAfter(ws, subId);

    // Buying again with a card: the same Paddle customer.
    const { txnId } = await cardCheckout(ws, st.pro, 'monthly', 2900);
    expect(fake.transactions.get(txnId)!.customer_id).toBe(customer);
    const { subscription } = fake.completeCheckout(txnId);
    await settle();
    expect(await one(`SELECT status, customer_id FROM public.billing_account_cards WHERE subscription_id = $1`, [subscription!.id]))
      .toEqual({ status: 'active', customer_id: customer });
    expect(await balanceOf(ws)).toBe(10000);
    await invariants('S12');
  });

  // ─── S13 ─────────────────────────────────────────────────────────────────

  it('S13 two tabs pay two card checkouts: one card, the other subscription cancelled as a duplicate, its money in the balance', async () => {
    const ws = await newWorkspace('Card S13');
    const a = await cardCheckout(ws, st.pro, 'monthly', 2900);
    // Tab A's checkout is being paid as tab B starts: Paddle will not close it.
    fake.refuseClose(a.txnId);
    const b = await cardCheckout(ws, st.pro, 'monthly', 2900);
    expect((await one(`SELECT status FROM public.billing_account_payments WHERE id = $1`, [a.paymentId])).status).toBe('pending');
    const subA = fake.completeCheckout(a.txnId).subscription!;
    const subB = fake.completeCheckout(b.txnId).subscription!;
    await settle();
    expect(await q(`SELECT subscription_id, status, cancel_reason FROM public.billing_account_cards WHERE workspace_id = $1 ORDER BY created_at`, [ws]))
      .toEqual([
        { subscription_id: subA.id, status: 'active', cancel_reason: null },
        { subscription_id: subB.id, status: 'canceled', cancel_reason: 'duplicate' },
      ]);
    expect([paddleSub(subA.id).status, paddleSub(subB.id).status]).toEqual(['active', 'canceled']);
    expect(await accountOf(ws)).toMatchObject({ card_subscription_id: subA.id, auto_renew: true });
    const second = await one(`SELECT status, purpose_result FROM public.billing_account_payments WHERE id = $1`, [b.paymentId]);
    expect(second.status).toBe('succeeded');
    expect(second.purpose_result).toHaveProperty('error');
    expect(await balanceOf(ws)).toBe(2900);
    expect(await subOf(ws)).toMatchObject({ plan_id: st.pro, status: 'active' });
    await invariants('S13');
  });

  // ─── S14 ─────────────────────────────────────────────────────────────────

  it('S14 a Super Admin assignment moves Paddle\'s date, and another plan swaps its item', async () => {
    const ws = await newWorkspace('Card S14');
    const { subId } = await buyWithCard(ws, 'pro');
    const later = new Date((await periodEnd(ws)) + 10 * DAY).toISOString();
    const assign = await call('POST', '/api/plans/admin/assign', { workspaceId: ws, planId: st.pro, expiresAt: later }, {}, st.adminCookie);
    expect(assign.status, JSON.stringify(assign.json)).toBe(200);
    expect(t((await subOf(ws)).current_period_end)).toBe(t(later));
    await settle();
    expect(Math.abs(nextBilled(subId) - (t(later) - DAY))).toBeLessThan(1000);

    const latest = new Date(t(later) + 5 * DAY).toISOString();
    const other = await call('POST', '/api/plans/admin/assign', { workspaceId: ws, planId: st.biz, expiresAt: latest }, {}, st.adminCookie);
    expect(other.status).toBe(200);
    await settle();
    expect(paddleSub(subId).items[0].price).toMatchObject({ unit_price: { amount: '9900' }, custom_data: { plan_id: st.biz } });
    expect(Math.abs(nextBilled(subId) - (t(latest) - DAY))).toBeLessThan(1000);
    expect((await view(ws)).card).toMatchObject({ next_charge_minor: 9900, next_charge_plan: { plan_id: st.biz } });
    await invariants('S14');
  });

  // ─── S15 ─────────────────────────────────────────────────────────────────

  it('S15 a stray charge is credited for review and refunded once; a chargeback of the renewal stops the card at once', async () => {
    const ws = await newWorkspace('Card S15');
    const { subId, cardId } = await buyWithCard(ws, 'pro');
    await toPaddleDate(ws, subId, MINUTE);
    await settle();
    const renewal = fake.transactionsOf(subId).find((x) => x.origin === 'subscription_recurring')!;
    expect((await accountOf(ws)).next_period_prepaid_minor).toBe('2900');

    // Someone charges the card in Paddle's dashboard: credited to the balance for review, never spent.
    const stray = fake.dashboardCharge(subId, 1500);
    await settle();
    const strayPayment = await one(`SELECT * FROM public.billing_account_payments WHERE provider_ref = $1`, [stray.id]);
    expect(strayPayment).toMatchObject({ source: 'card_charge', purpose: 'topup', status: 'succeeded', review: 'unexpected_charge:subscription_charge' });
    expect(await balanceOf(ws)).toBe(1500);
    await mailsSettle();
    expect(mailsOf(ws, 'billing_payment_receipt')).toHaveLength(2);
    // The Super Admin refunds it in Paddle: taken back once; the prepaid next period stays.
    fake.adjust(stray.id, 'refund');
    await settle();
    expect(await balanceOf(ws)).toBe(0);
    expect(Number((await one(`SELECT refunded_minor FROM public.billing_account_payments WHERE id = $1`, [strayPayment.id])).refunded_minor)).toBe(1500);
    expect((await accountOf(ws)).next_period_prepaid_minor).toBe('2900');
    expect(await cardRow(cardId)).toMatchObject({ status: 'active' });

    // A chargeback of the renewal: its money is taken back (the prepaid period first) and the card stops now.
    fake.adjust(renewal.id, 'chargeback');
    await settle();
    expect(await cardRow(cardId)).toMatchObject({ status: 'canceled', cancel_reason: 'chargeback' });
    expect(paddleSub(subId).status).toBe('canceled');
    expect(await accountOf(ws)).toMatchObject({ auto_renew: false, card_subscription_id: null, next_period_prepaid_minor: null, balance_minor: '0' });
    expect(Number((await one(`SELECT refunded_minor FROM public.billing_account_payments WHERE provider_ref = $1`, [renewal.id])).refunded_minor)).toBe(2900);
    await toPeriodEnd(ws, MINUTE);
    expect((await dueJob()).errors).toEqual([]);
    expect(await subOf(ws)).toMatchObject({ status: 'expired' });
    await noChargeAfter(ws, subId);
    await invariants('S15');
  });

  it('S15 a refunded card renewal turns auto-renew off: Paddle is never asked to charge that period again', async () => {
    const ws = await newWorkspace('Card S15 refund');
    const { subId, cardId } = await buyWithCard(ws, 'pro');
    await toPaddleDate(ws, subId, MINUTE);
    await settle();
    const renewal = fake.transactionsOf(subId).find((x) => x.origin === 'subscription_recurring')!;
    expect((await accountOf(ws)).next_period_prepaid_minor).toBe('2900');
    const charged = fake.transactionsOf(subId).length;

    // The Super Admin refunds the renewal in Paddle: the prepaid next period
    // goes back, and the card stops at Paddle's next date instead of
    // charging that period again within the hour.
    fake.adjust(renewal.id, 'refund');
    await settle();
    expect(Number((await one(`SELECT refunded_minor FROM public.billing_account_payments WHERE provider_ref = $1`, [renewal.id])).refunded_minor)).toBe(2900);
    expect(await accountOf(ws)).toMatchObject({ auto_renew: false, next_period_prepaid_minor: null });
    expect(await cardRow(cardId)).toMatchObject({ status: 'active', cancel_intent: 'period_end' });
    expect(paddleSub(subId).scheduled_change).toMatchObject({ action: 'cancel' });
    await travel(ws, 2 * HOUR);
    await settle();
    expect(fake.transactionsOf(subId)).toHaveLength(charged);

    // The plan runs to its end, then the workspace moves to Free; no later charge.
    await toPeriodEnd(ws, MINUTE);
    expect((await dueJob()).errors).toEqual([]);
    expect(await subOf(ws)).toMatchObject({ status: 'expired' });
    await settle();
    await noChargeAfter(ws, subId);
    await invariants('S15 refund');
  });

  it('S15 a stray renewal on a period already paid, refunded: auto-renew stays on, and the next period renews as usual', async () => {
    const ws = await newWorkspace('Card S15 stray');
    const { subId, cardId } = await buyWithCard(ws, 'pro');
    // The next period is paid from the balance (by its owner) while Paddle's
    // date was not moved yet (a sync that is late): Paddle still charges it.
    const owner = String((await one(`SELECT owner_id FROM public.workspaces WHERE id = $1`, [ws])).owner_id);
    await q(`SELECT public.billing_account_admin_adjust($1, 2900, 'USD', 'e2e credit', NULL, $2)`, [ws, `s15s-credit-${ws}`]);
    await q(`SELECT public.billing_account_renew($1, $2, $3::timestamptz, 2900)`, [ws, owner, new Date(await periodEnd(ws)).toISOString()]);
    expect(await accountOf(ws)).toMatchObject({ next_period_prepaid_minor: '2900', balance_minor: '0' });
    await toPaddleDate(ws, subId, MINUTE);
    const stray = fake.transactionsOf(subId).find((x) => x.origin === 'subscription_recurring')!;
    await settle();
    expect(await one(`SELECT source, purpose, status, review FROM public.billing_account_payments WHERE provider_ref = $1`, [stray.id]))
      .toEqual({ source: 'card_renewal', purpose: 'renewal', status: 'succeeded', review: 'already_renewed' });
    expect(await balanceOf(ws)).toBe(2900);

    // The Super Admin refunds the stray in Paddle: its money is taken back,
    // and nothing else changes (it renewed nothing).
    fake.adjust(stray.id, 'refund');
    await settle();
    expect(await balanceOf(ws)).toBe(0);
    expect(await accountOf(ws)).toMatchObject({ auto_renew: true, next_period_prepaid_minor: '2900' });
    expect(await cardRow(cardId)).toMatchObject({ status: 'active', cancel_intent: null });
    expect(paddleSub(subId).scheduled_change).toBeNull();

    // The due moment starts the period the balance paid; the card renews the one after it.
    await toPeriodEnd(ws, MINUTE);
    expect((await dueJob()).errors).toEqual([]);
    expect(await subOf(ws)).toMatchObject({ status: 'active', plan_id: st.pro });
    await settle();
    await toPaddleDate(ws, subId, MINUTE);
    await settle();
    const renewals = fake.transactionsOf(subId).filter((x) => x.origin === 'subscription_recurring' && x.id !== stray.id);
    expect(renewals).toHaveLength(1);
    expect(await one(`SELECT source, status, review FROM public.billing_account_payments WHERE provider_ref = $1`, [renewals[0].id]))
      .toEqual({ source: 'card_renewal', status: 'succeeded', review: null });
    expect((await accountOf(ws)).next_period_prepaid_minor).toBe('2900');
    await invariants('S15 stray');
  });

  // ─── S16 ─────────────────────────────────────────────────────────────────

  it('S16 a renewal Paddle charged at another amount: credited for review, and Paddle is never asked to charge that period again', async () => {
    const ws = await newWorkspace('Card S16');
    const { subId, cardId } = await buyWithCard(ws, 'pro');
    await toPaddleDate(ws, subId, -MINUTE);
    // Paddle took a customer credit off: 25.00 collected for a 29.00 renewal.
    const renewal = fake.renew(subId, { grandTotalMinor: 2500 })!;
    expect(renewal.status).toBe('completed');
    await settle();
    expect(await one(`SELECT source, purpose, status, review, amount_minor FROM public.billing_account_payments WHERE provider_ref = $1`, [renewal.id]))
      .toEqual({ source: 'card_renewal', purpose: 'topup', status: 'succeeded', review: 'amount_mismatch', amount_minor: '2500' });
    expect(await accountOf(ws)).toMatchObject({ balance_minor: '2500', next_period_prepaid_minor: null });
    await mailsSettle();
    expect(mailsOf(ws, 'billing_payment_receipt')).toHaveLength(2);
    // Paddle's period is paid at Paddle: its date is not moved earlier to charge it once more.
    const n = nextBilled(subId);
    await travel(ws, 11 * MINUTE);
    await settle();
    await travel(ws, 40 * MINUTE);
    await settle();
    expect(nextBilled(subId)).toBe(n - 51 * MINUTE);
    expect(fake.transactionsOf(subId).filter((x) => x.origin === 'subscription_recurring')).toHaveLength(1);

    // The due moment: no renewal paid this period; the plan ends, the card stops, the 25.00 stays.
    await toPeriodEnd(ws, MINUTE);
    expect((await dueJob()).errors).toEqual([]);
    expect(await subOf(ws)).toMatchObject({ status: 'expired' });
    expect(await cardRow(cardId)).toMatchObject({ status: 'canceled', cancel_reason: 'not_renewed' });
    expect(await balanceOf(ws)).toBe(2500);
    await settle();
    await noChargeAfter(ws, subId);
    await invariants('S16');
  });

  // ─── S17 ─────────────────────────────────────────────────────────────────

  it('S17 another installation\'s subscriptions naming our workspace and our payment: acknowledged, nothing changed, nothing cancelled', async () => {
    const ws = await newWorkspace('Card S17');
    const ours = await buyWithCard(ws, 'pro');
    await settle();
    const counts = async () => one(`SELECT
        (SELECT count(*)::int FROM public.billing_account_cards) AS cards,
        (SELECT count(*)::int FROM public.billing_account_payments) AS payments,
        (SELECT count(*)::int FROM public.billing_account_ledger) AS ledger`);
    const before = await counts();
    const state = async () => [await accountOf(ws), await subOf(ws), await cardRow(ours.cardId)];
    const stateBefore = await state();
    const mark = fake.calls.length;
    // A clone of this database (another installation on the same Paddle account) has the same workspace and payment ids.
    const plain = fake.foreignSubscription({ workspace_id: ws, intent_id: randomUUID(), card_setup: '1' });
    const cloned = fake.foreignSubscription({ workspace_id: ws, intent_id: ours.paymentId, card_setup: '1' });
    fake.renew(plain.id);
    fake.renew(cloned.id);
    fake.declineNext(plain.id, 'declined');
    fake.renew(plain.id);
    const results = await deliver();
    const cardEvents = results.filter((r) => r.queued.subscriptionId && fake.isForeign(r.queued.subscriptionId) && !(r.queued.event.event_type.startsWith('transaction.') && r.queued.event.data.origin === 'api'));
    expect(cardEvents.length).toBeGreaterThan(10);
    expect(cardEvents.filter((r) => JSON.stringify(r.body) !== JSON.stringify({ received: true, ignored: true })).map((r) => r.queued.event.event_type)).toEqual([]);
    expect(await counts()).toEqual(before);
    expect(await state()).toEqual(stateBefore);
    expect(callsSince(mark)).toEqual([]);
    expect([paddleSub(plain.id).status, paddleSub(cloned.id).status]).toEqual(['past_due', 'active']);

    // Our card checkout is paid but its subscription not registered yet when another installation's
    // subscription naming that checkout's payment reports a charge: it is not taken for ours.
    const other = await newWorkspace('Card S17 pending');
    const setup = await cardCheckout(other, st.pro, 'monthly', 2900);
    const mine = fake.completeCheckout(setup.txnId).subscription!;
    const theirs = fake.foreignSubscription({ workspace_id: other, intent_id: setup.paymentId, card_setup: '1' });
    fake.renew(theirs.id);
    const foreignMark = fake.calls.length;
    await deliver({ only: (e) => e.subscriptionId === theirs.id || fake.isForeign(e.subscriptionId ?? '') });
    expect(paddleSub(theirs.id).status).toBe('active');
    expect(await one(`SELECT count(*)::int AS n FROM public.billing_account_cards WHERE subscription_id = $1`, [theirs.id])).toEqual({ n: 0 });
    expect(callsSince(foreignMark).filter((c) => c.method !== 'GET')).toEqual([]);
    // Then our own notifications: our card.
    await settle();
    expect(await one(`SELECT status FROM public.billing_account_cards WHERE subscription_id = $1`, [mine.id])).toEqual({ status: 'active' });
    expect(paddleSub(theirs.id).status).toBe('active');
    expect(await accountOf(other)).toMatchObject({ card_subscription_id: mine.id, balance_minor: '0' });
    await invariants('S17');
  });

  // ─── S18 ─────────────────────────────────────────────────────────────────

  it('S18 a workspace deleted while its card is live: the card is cancelled at Paddle', async () => {
    const ws = await newWorkspace('Card S18');
    const { subId, cardId } = await buyWithCard(ws, 'pro');
    await q(`DELETE FROM public.workspaces WHERE id = $1`, [ws]);
    expect(await cardRow(cardId)).toMatchObject({ status: 'canceling', cancel_reason: 'workspace_deleted' });
    const report = await cardJob();
    expect(report.errors).toEqual([]);
    expect(await cardRow(cardId)).toMatchObject({ status: 'canceled', cancel_reason: 'workspace_deleted' });
    expect(paddleSub(subId).status).toBe('canceled');
    await settle();
    await noChargeAfter(ws, subId);
    await invariants('S18');
  });

  it('S18 the purge\'s order (the workspace\'s rows first, its card included, then the workspace): the card is kept and cancelled at Paddle', async () => {
    // admin_purge_workspaces deletes every workspace-scoped row before the
    // workspace itself, so the workspace's own trigger finds no card. (It
    // cannot run here: a workspace with ledger rows is refused, 259.)
    const ws = await newWorkspace('Card S18 purge');
    const { subId, cardId } = await buyWithCard(ws, 'pro');
    await q(`DO $purge$ BEGIN
      DELETE FROM public.billing_account_cards WHERE workspace_id = '${ws}';
      DELETE FROM public.workspaces WHERE id = '${ws}';
    END $purge$`);
    expect(await cardRow(cardId)).toMatchObject({ status: 'canceling', cancel_reason: 'workspace_deleted', setup_payment_id: null });
    const report = await cardJob();
    expect(report.errors).toEqual([]);
    expect(await cardRow(cardId)).toMatchObject({ status: 'canceled', cancel_reason: 'workspace_deleted' });
    expect(paddleSub(subId).status).toBe('canceled');
    await settle();
    await noChargeAfter(ws, subId);
    await invariants('S18 purge');
  });

  // ─── S19 ─────────────────────────────────────────────────────────────────

  it('S19 cancelled in Paddle\'s customer portal: followed as auto-renew off, mailed once, never undone', async () => {
    const ws = await newWorkspace('Card S19');
    const { subId, cardId } = await buyWithCard(ws, 'pro');
    fake.portalCancel(subId);
    await settle();
    expect(await cardRow(cardId)).toMatchObject({ status: 'active', cancel_intent: 'period_end' });
    expect((await accountOf(ws)).auto_renew).toBe(false);
    expect(paddleSub(subId).scheduled_change).toMatchObject({ action: 'cancel' });
    await mailsSettle();
    const portal = "the automatic payment was cancelled in Paddle's customer portal";
    expect(mailsOf(ws, 'billing_card_removed').map((m) => m.data.reason)).toEqual([portal]);
    const v = await view(ws);
    expect(v).toMatchObject({ auto_renew: false, card: { next_charge_at: null } });
    expect((v.card as Row).scheduled_cancel_at).toBeTruthy();
    // The six-hourly check changes nothing at Paddle.
    const mark = fake.calls.length;
    await travel(ws, 7 * HOUR);
    await settle();
    expect(callsSince(mark).filter((c) => c.method !== 'GET')).toEqual([]);
    expect(paddleSub(subId).scheduled_change).toMatchObject({ action: 'cancel' });
    // Its date: Paddle ends it; no second mail, no charge.
    await travel(ws, t(paddleSub(subId).scheduled_change!.effective_at) - Date.now() + MINUTE);
    await settle();
    expect(await cardRow(cardId)).toMatchObject({ status: 'canceled' });
    await mailsSettle();
    expect(mailsOf(ws, 'billing_card_removed')).toHaveLength(1);
    await toPeriodEnd(ws, MINUTE);
    expect((await dueJob()).errors).toEqual([]);
    expect(await subOf(ws)).toMatchObject({ status: 'expired' });
    await noChargeAfter(ws, subId);

    // Cancelled there at once: the card is gone at once.
    const now = await newWorkspace('Card S19 now');
    const quick = await buyWithCard(now, 'pro');
    fake.portalCancel(quick.subId, { immediately: true });
    await settle();
    expect(await cardRow(quick.cardId)).toMatchObject({ status: 'canceled', cancel_reason: 'canceled_at_paddle' });
    expect((await accountOf(now)).auto_renew).toBe(false);
    await mailsSettle();
    expect(mailsOf(now, 'billing_card_removed').map((m) => m.data.reason)).toEqual([portal]);
    await invariants('S19');
  });

  // ─── S20 ─────────────────────────────────────────────────────────────────

  it('S20 renewed from the balance while a card is saved: Paddle\'s charge moves one period on first, so the card does not pay that period', async () => {
    const ws = await newWorkspace('Card S20');
    const { subId } = await buyWithCard(ws, 'pro');
    await q(`SELECT public.billing_account_admin_adjust($1, 2900, 'USD', 'e2e credit', NULL, $2)`, [ws, `s20-credit-${ws}`]);
    const end = await periodEnd(ws);
    const oldDate = nextBilled(subId);
    const res = await call('POST', `/api/billing/account/${ws}/renew`, { expectedPeriodEnd: new Date(end).toISOString(), expectedPriceMinor: 2900 });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toMatchObject({ action: 'prepaid', amount_minor: 2900 });
    expect(await accountOf(ws)).toMatchObject({ balance_minor: '0', next_period_prepaid_minor: '2900' });
    expect(Math.abs(nextBilled(subId) - (await expectedChargeAt(ws)))).toBeLessThan(1000);
    expect(nextBilled(subId)).toBeGreaterThan(oldDate + 27 * DAY);
    const debit = await one(`SELECT actor_id FROM public.billing_account_ledger WHERE workspace_id = $1 AND kind = 'renewal'`, [ws]);
    expect(debit.actor_id).toBeTruthy();

    // Paddle's old date passes: nothing is charged.
    await travel(ws, oldDate - Date.now() + MINUTE);
    expect(fake.transactionsOf(subId).filter((x) => x.origin === 'subscription_recurring')).toEqual([]);
    // The due moment starts the period the balance paid; the card pays the one after it.
    await toPeriodEnd(ws, MINUTE);
    expect((await dueJob()).errors).toEqual([]);
    expect(await subOf(ws)).toMatchObject({ status: 'active', plan_id: st.pro });
    await settle();
    await toPaddleDate(ws, subId, MINUTE);
    const renewal = fake.transactionsOf(subId).find((x) => x.origin === 'subscription_recurring')!;
    await settle();
    expect(await one(`SELECT source, status FROM public.billing_account_payments WHERE provider_ref = $1`, [renewal.id]))
      .toEqual({ source: 'card_renewal', status: 'succeeded' });
    expect((await accountOf(ws)).next_period_prepaid_minor).toBe('2900');
    await invariants('S20');
  });

  // ─── Any order ───────────────────────────────────────────────────────────

  it('a card checkout\'s notifications in any order, each twice: the same card, plan and Paddle state', async () => {
    for (const seed of [1, 2, 3, 5, 8]) {
      const ws = await newWorkspace(`Card shuffle ${seed}`);
      const { paymentId, txnId } = await cardCheckout(ws, st.pro, 'monthly', 2900);
      const { subscription } = fake.completeCheckout(txnId);
      const subId = subscription!.id;
      await deliver({ shuffle: seed, duplicate: true });
      // A card held for its checkout is looked at again within minutes.
      await travel(ws, 11 * MINUTE);
      await settle();
      const card = await one(`SELECT * FROM public.billing_account_cards WHERE subscription_id = $1`, [subId]);
      expect(card, `seed ${seed}`).toMatchObject({ status: 'active', brand: 'visa', last4: '4242', setup_payment_id: paymentId });
      expect(await one(`SELECT status, card_id FROM public.billing_account_payments WHERE id = $1`, [paymentId]), `seed ${seed}`)
        .toEqual({ status: 'succeeded', card_id: card.id });
      expect(await subOf(ws), `seed ${seed}`).toMatchObject({ plan_id: st.pro, status: 'active' });
      expect(await accountOf(ws), `seed ${seed}`).toMatchObject({ auto_renew: true, card_subscription_id: subId, balance_minor: '0' });
      expect(Math.abs(nextBilled(subId) - (await expectedChargeAt(ws))), `seed ${seed}`).toBeLessThan(1000);
      expect(paddleSub(subId).custom_data, `seed ${seed}`).toEqual({ workspace_id: ws, card_id: card.id });
      await mailsSettle();
      expect(mailsOf(ws, 'billing_plan_activated'), `seed ${seed}`).toHaveLength(1);
    }
    await invariants('setup in any order');
  }, 120_000);

  it('a declined renewal paid with a new card, its notifications in any order and twice: paid, the card active, the failure not reported after the payment', async () => {
    for (const seed of [1, 2, 3, 5, 8, 13]) {
      const ws = await newWorkspace(`Card recovery ${seed}`);
      const { subId, cardId } = await buyWithCard(ws, 'pro');
      await settle();
      fake.declineNext(subId, 'expired_card');
      await toPaddleDate(ws, subId, MINUTE);
      const pastDue = fake.transactionsOf(subId).find((x) => x.status === 'past_due')!;
      // The customer pays it with another card before any notification arrived.
      fake.completeCheckout(pastDue.id, { card: MASTERCARD_5555 });
      await deliver({ shuffle: seed, duplicate: true });
      await settle();
      expect(await cardRow(cardId), `seed ${seed}`).toMatchObject({ status: 'active', brand: 'mastercard', last4: '5555', last_failure: null });
      const paid = await one(`SELECT status, purpose_result FROM public.billing_account_payments WHERE provider_ref = $1`, [pastDue.id]);
      expect(paid.status, `seed ${seed}`).toBe('succeeded');
      expect(paid.purpose_result, `seed ${seed}`).toMatchObject({ action: 'prepaid' });
      expect((await accountOf(ws)).next_period_prepaid_minor, `seed ${seed}`).toBe('2900');
      await mailsSettle();
      expect(mailsOf(ws, 'billing_card_payment_failed').length, `seed ${seed}`).toBeLessThanOrEqual(1);
      expect(mailsOf(ws, 'billing_card_renewed'), `seed ${seed}`).toHaveLength(1);
    }
    await invariants('recovery in any order');
  }, 120_000);

  // ─── I8 ──────────────────────────────────────────────────────────────────

  it('I8 every notification again, shuffled and twice, then again as new notifications: the same state and no new mail', async () => {
    await settle();
    const before = await billingState();
    const mails = captured.emails.length;
    const redelivered = await fake.replay({ shuffle: 7, duplicate: true });
    expect(redelivered.length).toBeGreaterThan(100);
    expect(redelivered.filter((r) => r.status >= 300).map((r) => `${r.queued.event.event_type} ${r.status}`)).toEqual([]);
    await settle();
    expect(await billingState()).toEqual(before);
    const fresh = await fake.replay({ shuffle: 11, freshIds: true });
    expect(fresh.filter((r) => r.status >= 300).map((r) => `${r.queued.event.event_type} ${r.status} ${JSON.stringify(r.body)}`)).toEqual([]);
    await settle();
    expect(await billingState()).toEqual(before);
    await mailsSettle();
    expect(captured.emails.slice(mails).map((m) => m.templateSlug)).toEqual([]);
    await invariants('I8');
  }, 300_000);

  it('nothing left this machine except to the Paddle fake, and nothing is left to deliver', () => {
    expect(guard?.blocked).toEqual([]);
    expect(fake.outbox.map((e) => e.event.event_type)).toEqual([]);
  });
});
