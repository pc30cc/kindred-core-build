/**
 * The saved card wired into the account services (phase 3b): what the
 * existing billing code does differently when a payment or a workspace has a
 * card. card.ts itself is stubbed here (cardService.test.ts covers it).
 *
 *   index.ts    a Paddle payment_succeeded naming another transaction than
 *               the payment's checkout is a mismatch, never a replay (P5);
 *               the verify route asks no checkout API for card charges; a
 *               card charge never expires; a chargeback stops the card;
 *               createAccountPayment writes `source` only for a card setup;
 *   plans.ts    the due moment pulls a missed card renewal first and cancels
 *               the card it stopped; a period the card prepaid starts without
 *               a second mail; auto-renew asks Paddle while a card is live; a
 *               renewal paid online is the card's (CARD_PAYS_RENEWAL);
 *   effects.ts  a clean card renewal has no receipt of ours (Paddle mails
 *               its invoice) and names the card; one that could not be spent
 *               has the receipt and a REVIEW log;
 *   job.ts      the card step runs under its own lease.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  inserts: [] as Array<{ table: string; row: Row }>,
  rpc: vi.fn(),
  timeline: [] as string[],
  emails: [] as Array<{ slug: string; data: Record<string, string>; receiptLedgerId?: string | null }>,
  entitlements: vi.fn(async (..._a: unknown[]) => undefined),
  verifyPayment: vi.fn(),
  closeCheckout: vi.fn(async (..._a: unknown[]) => true),
  card: {
    readLiveCard: vi.fn(),
    pullCardRenewal: vi.fn(),
    cancelCardNow: vi.fn(),
    setCardAutoRenew: vi.fn(),
    resolveCardCharge: vi.fn(),
    runCardJob: vi.fn(),
    syncWorkspaceCard: vi.fn(),
  },
  lease: { acquire: vi.fn(), release: vi.fn(async () => undefined) },
}));

let seq = 0;

function query(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let op: 'select' | 'insert' | 'update' = 'select';
  let payload: Row = {};
  const matching = () => (h.db[table] ?? []).filter((r) => filters.every((f) => f(r)));
  const run = () => {
    if (op === 'insert') {
      const row = { id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, ...payload };
      (h.db[table] ??= []).push(row);
      h.inserts.push({ table, row: payload });
      return { data: [row], error: null };
    }
    if (op === 'update') {
      const rows = matching();
      for (const r of rows) Object.assign(r, payload);
      return { data: rows, error: null };
    }
    return { data: matching(), error: null };
  };
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'order', 'limit', 'range', 'gte', 'lt', 'lte']) b[m] = () => b;
  b.eq = (col: string, value: unknown) => {
    filters.push((r) => r[col] === value);
    return b;
  };
  b.in = (col: string, values: unknown[]) => {
    filters.push((r) => values.includes(r[col]));
    return b;
  };
  b.is = (col: string, value: unknown) => {
    filters.push((r) => (r[col] ?? null) === value);
    return b;
  };
  b.insert = (row: Row) => {
    op = 'insert';
    payload = row;
    return b;
  };
  b.update = (patch: Row) => {
    op = 'update';
    payload = patch;
    return b;
  };
  const one = async () => {
    const { data } = run();
    return { data: data[0] ?? null, error: null };
  };
  b.maybeSingle = one;
  b.single = one;
  b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject);
  return b;
}

vi.mock('../../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => query(table),
    rpc: async (name: string, args: Row) => {
      h.timeline.push(`rpc:${name}`);
      return (await h.rpc(name, args)) ?? { data: null, error: null };
    },
  }),
}));
vi.mock('../../../../server/services/billing/index.js', () => ({
  getProvider: (name: string) => ({ name, verifyPayment: h.verifyPayment, closeCheckout: h.closeCheckout }),
  resolveNamedBillingConfig: async () => null,
}));
vi.mock('../../../../server/services/billing/edition.js', () => ({
  getBillingRegion: async () => ({ edition: 'international', regionMode: 'multi', currency: 'USD' }),
}));
vi.mock('../../../../server/services/billing/entitlementChange.js', () => ({
  handleWorkspaceEntitlementChanged: h.entitlements,
}));
vi.mock('../../../../server/services/observability/tickerLease.js', () => ({
  acquireTickerLease: h.lease.acquire,
  releaseTickerLease: h.lease.release,
}));
vi.mock('../../../../server/services/billing/account/notify.js', () => ({
  sendBillingEmail: async (_c: unknown, _ws: string, slug: string, build: (ctx: unknown) => Record<string, string>, options: { receiptLedgerId?: string | null } = {}) => {
    const ctx = { locale: 'en', edition: 'international', money: (m: number, c: string) => `${m} ${c}`, date: (d: string | null) => String(d ?? ''), number: String };
    h.timeline.push(`mail:${slug}`);
    h.emails.push({ slug, data: build(ctx), receiptLedgerId: options.receiptLedgerId });
    return { sent: true };
  },
  planNamesFor: async (_c: unknown, ids: Array<string | null | undefined>) =>
    new Map(ids.filter(Boolean).map((id) => [id as string, { name: 'Pro', localized: {} }])),
  localizedPlanName: (plan: { name: string } | undefined) => plan?.name ?? '',
  billingIntervalLabel: (interval: string) => interval,
}));
vi.mock('../../../../server/services/billing/account/card.js', () => ({
  readLiveCard: h.card.readLiveCard,
  pullCardRenewal: async (...a: unknown[]) => {
    h.timeline.push('pull');
    return h.card.pullCardRenewal(...a);
  },
  cancelCardNow: async (...a: unknown[]) => {
    h.timeline.push('cancel');
    return h.card.cancelCardNow(...a);
  },
  setCardAutoRenew: h.card.setCardAutoRenew,
  syncWorkspaceCard: h.card.syncWorkspaceCard,
  resolveCardCharge: h.card.resolveCardCharge,
  runCardJob: h.card.runCardJob,
  cardLabel: (brand: string | null, last4: string | null) => `${brand === 'visa' ? 'Visa' : 'Card'} •••• ${last4}`,
}));

const account = await import('../../../../server/services/billing/account/index.js');
const plans = await import('../../../../server/services/billing/account/plans.js');
const { afterAccountSettlement } = await import('../../../../server/services/billing/account/effects.js');
const { runSimpleBillingCard } = await import('../../../../server/services/billing/account/job.js');

const CFG = { supabaseUrl: 'http://db', supabaseServiceRoleKey: 'k' } as never;
const W = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRO = '11111111-1111-4111-8111-111111111111';
const TEAM = '22222222-2222-4222-8222-222222222222';
const CARD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const LIVE = { id: CARD, workspace_id: W, provider: 'paddle_sandbox', status: 'active' };

function payment(over: Row = {}) {
  return {
    id: 'p1', workspace_id: W, provider: 'paddle_sandbox', currency: 'USD',
    amount_minor: 2900, net_minor: 2900, tax_minor: 0, tax_percent: null,
    purpose: 'renewal', purpose_detail: {}, purpose_result: null, status: 'pending', provider_ref: 'txn_checkout',
    provider_payment_id: null, failure_reason: null, ledger_id: null, return_url: null, created_by: null,
    created_at: iso(Date.now() - 2 * 60 * 60 * 1000), updated_at: '', completed_at: null,
    verified_amount_minor: null, verified_at: null, refunded_minor: 0, closed_at: null,
    source: 'checkout', card_id: null, charge_requested_at: null, review: null,
    ...over,
  } as never;
}

const mails = (slug: string) => h.emails.filter((e) => e.slug === slug);
const rpcNames = () => h.rpc.mock.calls.map((c) => c[0]);

let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  seq = 0;
  h.db = {
    billing_accounts: [{ workspace_id: W, currency: 'USD', balance_minor: 0, auto_renew: true, scheduled_plan_id: null, scheduled_interval: null, next_period_prepaid_minor: null, next_period_start: null, billing_profile: {} }],
    billing_plans: [{ id: PRO, slug: 'pro', name: 'Pro', localized: {}, is_free: false, is_hidden: false, is_active: true, prices: { USD: { monthly: 2900, yearly: 29000 } } }],
    workspace_subscriptions: [{ workspace_id: W, plan_id: PRO, status: 'active', billing_interval: 'monthly', current_period_start: iso(Date.now() - 30 * DAY), current_period_end: iso(Date.now() + 5 * DAY) }],
    billing_account_payments: [],
    billing_account_cards: [{ id: CARD, workspace_id: W, brand: 'visa', last4: '4242' }],
  };
  h.inserts.length = 0;
  h.timeline.length = 0;
  h.emails.length = 0;
  h.rpc.mockReset().mockResolvedValue({ data: null, error: null });
  h.entitlements.mockClear();
  h.verifyPayment.mockReset();
  h.closeCheckout.mockClear();
  for (const fn of Object.values(h.card)) fn.mockReset();
  h.card.readLiveCard.mockResolvedValue(null);
  h.card.pullCardRenewal.mockResolvedValue(false);
  h.card.cancelCardNow.mockResolvedValue(true);
  h.lease.acquire.mockReset().mockResolvedValue(true);
  h.lease.release.mockClear();
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  errorLog.mockRestore();
});

// ─── index.ts ────────────────────────────────────────────────────────────────

describe('handleAccountPaymentWebhook (P5)', () => {
  const succeeded = (txn: string) => ({ type: 'payment_succeeded', providerEventId: 'e1', providerPaymentId: txn, providerRef: txn, amount: 2900, currency: 'USD', raw: {} }) as never;

  it("a Paddle transaction that is not the payment's checkout is a mismatch, never a replay", async () => {
    const out = await account.handleAccountPaymentWebhook(CFG, {
      providerName: 'paddle_sandbox', workspaceId: W, event: succeeded('txn_renewal'),
      payment: payment({ status: 'succeeded', provider_ref: 'txn_checkout' }),
    });
    expect(out).toBe('mismatch');
    expect(h.rpc).not.toHaveBeenCalled();
    expect(errorLog.mock.calls.flat().join(' ')).toMatch(/REVIEW webhook payment=p1 .*txn_renewal is not its checkout txn_checkout/);
  });

  it('nor is it ever settled on a pending payment', async () => {
    const out = await account.handleAccountPaymentWebhook(CFG, {
      providerName: 'paddle_sandbox', workspaceId: W, event: succeeded('txn_other'), payment: payment(),
    });
    expect(out).toBe('mismatch');
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('its own checkout is settled, and replayed once settled', async () => {
    h.rpc.mockResolvedValue({ data: { replayed: false, ledger_id: 'l1', payment_id: 'p1' }, error: null });
    const settled = await account.handleAccountPaymentWebhook(CFG, {
      providerName: 'paddle_sandbox', workspaceId: W, event: succeeded('txn_checkout'), payment: payment(),
    });
    expect(settled).toBe('settled');
    expect(rpcNames()).toEqual(['billing_account_record_verification', 'billing_account_settle_payment']);
    const replay = await account.handleAccountPaymentWebhook(CFG, {
      providerName: 'paddle_sandbox', workspaceId: W, event: succeeded('txn_checkout'), payment: payment({ status: 'succeeded' }),
    });
    expect(replay).toBe('replayed');
  });

  it('other card gateways keep their own references (a Stripe session is not its payment intent)', async () => {
    const out = await account.handleAccountPaymentWebhook(CFG, {
      providerName: 'stripe', workspaceId: W, event: succeeded('pi_1'),
      payment: payment({ provider: 'stripe', provider_ref: 'cs_1', status: 'succeeded' }),
    });
    expect(out).toBe('replayed');
  });
});

describe('a chargeback', () => {
  const chargeback = { type: 'refund_processed', providerEventId: 'adj', refundId: 'adj_1', amount: 2900, currency: 'USD', chargeback: true, raw: {} } as never;

  beforeEach(() => {
    h.rpc.mockImplementation(async (name: string) =>
      name === 'billing_account_refund_payment' ? { data: { replayed: false, shortfall_minor: 0 }, error: null } : { data: {}, error: null });
  });

  it("is recorded as a refund, then the payment's card is marked canceling and cancelled at Paddle (REVIEW)", async () => {
    const out = await account.handleAccountPaymentWebhook(CFG, {
      providerName: 'paddle_sandbox', workspaceId: W, event: chargeback,
      payment: payment({ status: 'succeeded', source: 'card_renewal', card_id: CARD }),
    });
    expect(out).toBe('refunded');
    expect(rpcNames()).toEqual(['billing_account_refund_payment', 'billing_card_set_status']);
    expect(h.rpc.mock.calls[1][1]).toEqual({ p_card_id: CARD, p_status: 'canceling', p_reason: 'chargeback' });
    expect(h.card.cancelCardNow).toHaveBeenCalledWith(CFG, CARD, 'chargeback');
    expect(h.card.readLiveCard).not.toHaveBeenCalled();
    expect(errorLog.mock.calls.flat().join(' ')).toMatch(/REVIEW chargeback adj_1 payment=p1/);
  });

  it('of a checkout payment stops the live card of the same gateway', async () => {
    h.card.readLiveCard.mockResolvedValue(LIVE);
    await account.handleAccountPaymentWebhook(CFG, {
      providerName: 'paddle_sandbox', workspaceId: W, event: chargeback, payment: payment({ status: 'succeeded' }),
    });
    expect(h.card.cancelCardNow).toHaveBeenCalledWith(CFG, CARD, 'chargeback');
    h.card.cancelCardNow.mockClear();
    h.card.readLiveCard.mockResolvedValue({ ...LIVE, provider: 'paddle' });
    await account.handleAccountPaymentWebhook(CFG, {
      providerName: 'paddle_sandbox', workspaceId: W, event: chargeback, payment: payment({ status: 'succeeded' }),
    });
    expect(h.card.cancelCardNow).not.toHaveBeenCalled();
  });

  it('a plain refund leaves the card alone', async () => {
    await account.handleAccountPaymentWebhook(CFG, {
      providerName: 'paddle_sandbox', workspaceId: W, event: { ...(chargeback as object), chargeback: undefined } as never,
      payment: payment({ status: 'succeeded', source: 'card_renewal', card_id: CARD }),
    });
    expect(rpcNames()).toEqual(['billing_account_refund_payment']);
    expect(h.card.cancelCardNow).not.toHaveBeenCalled();
  });

  it('a refunded card renewal that renewed the period turns auto-renew off and syncs the card', async () => {
    h.card.readLiveCard.mockResolvedValue(LIVE);
    await account.handleAccountPaymentWebhook(CFG, {
      providerName: 'paddle_sandbox', workspaceId: W, event: { ...(chargeback as object), chargeback: undefined } as never,
      payment: payment({ status: 'succeeded', source: 'card_renewal', card_id: CARD, purpose_result: { action: 'prepaid', card: true } }),
    });
    expect(h.db.billing_accounts[0].auto_renew).toBe(false);
    expect(h.card.syncWorkspaceCard).toHaveBeenCalledWith(CFG, W);
  });

  it('a refunded card renewal that renewed nothing (kept in the balance for review) leaves auto-renew on', async () => {
    h.card.readLiveCard.mockResolvedValue(LIVE);
    for (const stray of [
      { review: 'already_renewed', purpose_result: { error: 'already_renewed' } },
      { review: null, purpose_result: { error: 'card_not_live' } },
      { review: 'amount_below_price', purpose_result: null },
    ]) {
      await account.handleAccountPaymentWebhook(CFG, {
        providerName: 'paddle_sandbox', workspaceId: W, event: { ...(chargeback as object), chargeback: undefined } as never,
        payment: payment({ status: 'succeeded', source: 'card_renewal', card_id: CARD, ...stray }),
      });
    }
    expect(h.db.billing_accounts[0].auto_renew).toBe(true);
    expect(h.card.syncWorkspaceCard).not.toHaveBeenCalled();
  });

  it('a card Paddle does not cancel now stays canceling for the job; the refund still counts', async () => {
    h.card.cancelCardNow.mockResolvedValue(false);
    const out = await account.handleAccountPaymentWebhook(CFG, {
      providerName: 'paddle_sandbox', workspaceId: W, event: chargeback,
      payment: payment({ status: 'succeeded', source: 'card_charge', card_id: CARD }),
    });
    expect(out).toBe('refunded');
    expect(rpcNames()).toContain('billing_card_set_status');
  });
});

describe('verifyAccountPayment with card payments', () => {
  it('an upgrade charge is looked up on the card (resolveCardCharge), never through a checkout', async () => {
    h.card.resolveCardCharge.mockResolvedValue({ status: 'pending' });
    const row = payment({ source: 'card_charge', purpose: 'upgrade', provider_ref: null, card_id: CARD });
    const out = await account.verifyAccountPayment(CFG, { payment: row, providerConfig: {} as never, params: {} });
    expect(out).toEqual({ status: 'pending' });
    expect(h.card.resolveCardCharge).toHaveBeenCalledWith(CFG, row);
    expect(h.verifyPayment).not.toHaveBeenCalled();
  });

  it('a renewal Paddle charged waits for its own events', async () => {
    const out = await account.verifyAccountPayment(CFG, {
      payment: payment({ source: 'card_renewal', provider_ref: 'txn_r' }), providerConfig: {} as never, params: {},
    });
    expect(out).toEqual({ status: 'pending', reason: 'card_renewal' });
    expect(h.verifyPayment).not.toHaveBeenCalled();
    const failed = await account.verifyAccountPayment(CFG, {
      payment: payment({ source: 'card_renewal', status: 'failed', failure_reason: 'card_declined' }), providerConfig: {} as never, params: {},
    });
    expect(failed).toEqual({ status: 'failed', reason: 'card_declined' });
  });

  it('a card setup is a checkout: asked about as before', async () => {
    h.verifyPayment.mockResolvedValue({ verified: false, status: 'pending' });
    const out = await account.verifyAccountPayment(CFG, {
      payment: payment({ source: 'card_setup', purpose: 'plan' }), providerConfig: {} as never, params: {},
    });
    expect(out).toEqual({ status: 'pending' });
    expect(h.verifyPayment).toHaveBeenCalledTimes(1);
  });
});

describe('expireAccountPayment', () => {
  it('ends a lapsed checkout and closes it at the gateway', async () => {
    h.db.billing_account_payments = [{ id: 'p1', status: 'pending' }];
    await account.expireAccountPayment(CFG, payment(), {} as never);
    expect(h.db.billing_account_payments[0]).toMatchObject({ status: 'expired', failure_reason: 'expired' });
    expect(h.closeCheckout).toHaveBeenCalledWith({}, 'txn_checkout');
  });

  it.each(['card_charge', 'card_renewal'])('never ends a %s (Paddle may have charged it)', async (source) => {
    h.db.billing_account_payments = [{ id: 'p1', status: 'pending' }];
    await account.expireAccountPayment(CFG, payment({ source }), {} as never);
    expect(h.db.billing_account_payments[0].status).toBe('pending');
    expect(h.closeCheckout).not.toHaveBeenCalled();
  });
});

describe('createAccountPayment and payment rows', () => {
  const input = { workspaceId: W, provider: 'paddle_sandbox', currency: 'USD', netMinor: 2900, taxMinor: 0, taxPercent: null, purpose: 'plan', createdBy: null };

  it('a card setup names its source; any other checkout is written exactly as before 262', async () => {
    const setup = await account.createAccountPayment(CFG, { ...input, source: 'card_setup' });
    expect(h.inserts[0].row).toMatchObject({ source: 'card_setup', amount_minor: 2900 });
    expect(setup.source).toBe('card_setup');
    const plain = await account.createAccountPayment(CFG, input);
    expect(h.inserts[1].row).not.toHaveProperty('source');
    expect(plain.source).toBe('checkout');
    await account.createAccountPayment(CFG, { ...input, source: 'checkout' });
    expect(h.inserts[2].row).not.toHaveProperty('source');
  });

  it('a row read back carries its card columns', async () => {
    h.db.billing_account_payments = [{ id: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f', source: 'card_charge', card_id: CARD, charge_requested_at: '2026-10-10T00:00:00Z', review: 'charge_mismatch' }];
    const row = await account.readAccountPayment(CFG, '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f');
    expect(row).toMatchObject({ source: 'card_charge', card_id: CARD, charge_requested_at: '2026-10-10T00:00:00Z', review: 'charge_mismatch' });
  });

  it('the account row carries the card pointers', async () => {
    h.db.billing_accounts[0].card_customer_id = 'ctm_1';
    h.db.billing_accounts[0].card_subscription_id = 'sub_1';
    expect(await account.readAccount(CFG, W)).toMatchObject({ card_customer_id: 'ctm_1', card_subscription_id: 'sub_1' });
  });
});

// ─── plans.ts ────────────────────────────────────────────────────────────────

describe('the due moment with a saved card', () => {
  beforeEach(() => {
    h.db.workspace_subscriptions[0].current_period_end = iso(Date.now() - 60_000);
  });

  it('pulls a missed renewal before the due step, then cancels the card the due step stopped', async () => {
    h.card.readLiveCard.mockResolvedValue(LIVE);
    h.rpc.mockImplementation(async (name: string) => (name === 'billing_account_process_due'
      ? { data: { action: 'expired', reason: 'card_not_paid', plan_id: PRO, expired_at: iso(Date.now()), card_cancel: { card_id: CARD, provider: 'paddle_sandbox', subscription_id: 'sub_1' } }, error: null }
      : { data: null, error: null }));
    const result = await plans.processDueNow(CFG, W);
    expect(result).toMatchObject({ action: 'expired' });
    expect(h.timeline.filter((t) => ['pull', 'rpc:billing_account_process_due', 'cancel'].includes(t))).toEqual([
      'pull', 'rpc:billing_account_process_due', 'cancel',
    ]);
    expect(h.card.cancelCardNow).toHaveBeenCalledWith(CFG, CARD);
    expect(mails('billing_expired')).toHaveLength(1);
  });

  it('without a card it is the due step alone', async () => {
    h.rpc.mockImplementation(async (name: string) => (name === 'billing_account_process_due'
      ? { data: { action: 'expired', reason: 'not_renewed', plan_id: PRO }, error: null }
      : { data: null, error: null }));
    await plans.processDue(CFG, W);
    expect(h.card.pullCardRenewal).not.toHaveBeenCalled();
    expect(h.card.cancelCardNow).not.toHaveBeenCalled();
  });

  it('a failed due step throws (the job counts it; the page shows the period as it is)', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    await expect(plans.processDue(CFG, W)).rejects.toThrow('boom');
    expect(await plans.processDueNow(CFG, W)).toBeNull();
  });

  it('a period the card prepaid starts with entitlements refreshed and no second mail', async () => {
    h.card.readLiveCard.mockResolvedValue(LIVE);
    h.rpc.mockImplementation(async (name: string) => (name === 'billing_account_process_due'
      ? { data: { action: 'renewed', prepaid: true, prepaid_card: true, plan_id: PRO, previous_plan_id: PRO }, error: null }
      : { data: null, error: null }));
    await plans.processDueNow(CFG, W);
    expect(h.entitlements).toHaveBeenCalledTimes(1);
    expect(h.emails).toHaveLength(0);
    expect(h.card.cancelCardNow).not.toHaveBeenCalled();
  });

  it('a period prepaid from the balance still mails its start', async () => {
    h.rpc.mockImplementation(async (name: string) => (name === 'billing_account_process_due'
      ? { data: { action: 'renewed', prepaid: true, prepaid_card: false, plan_id: PRO, previous_plan_id: PRO }, error: null }
      : { data: null, error: null }));
    await plans.processDueNow(CFG, W);
    expect(mails('billing_renewed')).toHaveLength(1);
    expect(mails('billing_renewed')[0].data).not.toHaveProperty('card');
    expect(mails('billing_card_renewed')).toHaveLength(0);
  });
});

describe('a renewal the card paid has its own mail, naming the card', () => {
  it('billing_card_renewed with {card} when a card paid; billing_renewed (no card) when the balance did', async () => {
    await plans.afterPlanChange(CFG, W, { action: 'prepaid', plan_id: PRO, amount_minor: 2900, balance_minor: 0 }, 'payment_succeeded', { card: 'Visa •••• 4242' });
    expect(mails('billing_renewed')).toHaveLength(0);
    expect(mails('billing_card_renewed')).toHaveLength(1);
    expect(mails('billing_card_renewed')[0].data).toMatchObject({ card: 'Visa •••• 4242', amount: '2900 USD', balance: '0 USD' });
    await plans.afterPlanChange(CFG, W, { action: 'prepaid', plan_id: PRO }, 'payment_succeeded');
    expect(mails('billing_renewed')).toHaveLength(1);
    expect(mails('billing_card_renewed')).toHaveLength(1);
  });

  it('a pulled card renewal that started a changed plan is still billing_plan_changed', async () => {
    await plans.afterPlanChange(CFG, W, { action: 'renewed', plan_id: PRO, previous_plan_id: TEAM }, 'payment_succeeded', { card: 'Visa •••• 4242' });
    expect(mails('billing_plan_changed')).toHaveLength(1);
    expect(mails('billing_card_renewed')).toHaveLength(0);
  });
});

describe('auto-renew with a saved card', () => {
  it('asks Paddle through the card while one is live', async () => {
    h.card.readLiveCard.mockResolvedValue(LIVE);
    h.card.setCardAutoRenew.mockResolvedValue(false);
    expect(await plans.setAutoRenew(CFG, W, false)).toBe(false);
    expect(h.card.setCardAutoRenew).toHaveBeenCalledWith(CFG, W, false);
    expect(h.db.billing_accounts[0].auto_renew).toBe(true);
  });

  it('without a card only the flag changes', async () => {
    expect(await plans.setAutoRenew(CFG, W, false)).toBe(false);
    expect(h.card.setCardAutoRenew).not.toHaveBeenCalled();
    expect(h.db.billing_accounts[0].auto_renew).toBe(false);
  });
});

describe('paying a renewal online', () => {
  it('is the card’s while one is live (CARD_PAYS_RENEWAL)', async () => {
    h.card.readLiveCard.mockResolvedValue(LIVE);
    await expect(plans.amountNeededFor(CFG, W, { purpose: 'renewal' })).rejects.toMatchObject({ code: 'CARD_PAYS_RENEWAL', status: 409 });
  });

  it('a card checkout passes, and every answer carries the full price of the period', async () => {
    h.card.readLiveCard.mockResolvedValue(LIVE);
    const need = await plans.amountNeededFor(CFG, W, { purpose: 'renewal', forCardSetup: true });
    expect(need).toMatchObject({ needed: 2900, periodPriceMinor: 2900, detail: { plan_id: PRO, billing_interval: 'monthly' } });
    h.card.readLiveCard.mockResolvedValue(null);
    expect((await plans.amountNeededFor(CFG, W, { purpose: 'renewal' })).periodPriceMinor).toBe(2900);
  });
});

// ─── effects.ts ──────────────────────────────────────────────────────────────

describe('after a card payment is settled', () => {
  const settle = (row: Row, result: Row | null, purpose = 'renewal') => {
    h.db.billing_account_payments = [{ id: 'p1', workspace_id: W, currency: 'USD', amount_minor: 2900, ...row }];
    return afterAccountSettlement(CFG, { payment_id: 'p1', ledger_id: 'l1', receipt_number: 'RS-1', balance_minor: 0, purpose, purpose_result: result });
  };

  it('a clean renewal on the card: no receipt of ours, billing_card_renewed names the card', async () => {
    await settle({ source: 'card_renewal', card_id: CARD }, { action: 'prepaid', plan_id: PRO, card: true });
    expect(mails('billing_payment_receipt')).toHaveLength(0);
    expect(mails('billing_renewed')).toHaveLength(0);
    expect(mails('billing_card_renewed')).toHaveLength(1);
    expect(mails('billing_card_renewed')[0].data.card).toBe('Visa •••• 4242');
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('a renewal that could not be spent: the receipt (the money is in the balance) and REVIEW, no plan mail', async () => {
    await settle({ source: 'card_renewal', card_id: CARD }, { error: 'auto_renew_off' });
    expect(mails('billing_payment_receipt')).toHaveLength(1);
    expect(mails('billing_payment_receipt')[0].receiptLedgerId).toBe('l1');
    expect(mails('billing_renewed')).toHaveLength(0);
    expect(errorLog.mock.calls.flat().join(' ')).toMatch(/REVIEW payment=p1 source=card_renewal .*auto_renew_off/);
  });

  it('an unexpected charge credited for review: the receipt and REVIEW', async () => {
    await settle({ source: 'card_charge', card_id: CARD, review: 'unexpected_charge:subscription_update' }, null, 'topup');
    expect(mails('billing_payment_receipt')).toHaveLength(1);
    expect(errorLog.mock.calls.flat().join(' ')).toMatch(/REVIEW payment=p1 source=card_charge .*unexpected_charge:subscription_update/);
  });

  it('an upgrade charged to the card: the receipt and the plan mail', async () => {
    await settle({ source: 'card_charge', card_id: CARD }, { action: 'upgraded', plan_id: PRO }, 'upgrade');
    expect(mails('billing_payment_receipt')).toHaveLength(1);
    expect(mails('billing_plan_activated')).toHaveLength(1);
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('a checkout: as before (receipt, plan mail, no card)', async () => {
    await settle({ source: 'checkout' }, { action: 'prepaid', plan_id: PRO });
    expect(mails('billing_payment_receipt')).toHaveLength(1);
    expect(mails('billing_renewed')).toHaveLength(1);
    expect(mails('billing_renewed')[0].data).not.toHaveProperty('card');
    expect(mails('billing_card_renewed')).toHaveLength(0);
  });
});

// ─── job.ts ──────────────────────────────────────────────────────────────────

describe('runSimpleBillingCard', () => {
  it('runs the card job under its own lease, then releases it', async () => {
    h.card.runCardJob.mockResolvedValue({ synced: 2, activated: 0, charges: 0, canceled: 1, pulled: 0, errors: [] });
    const report = await runSimpleBillingCard(CFG);
    expect(report).toMatchObject({ synced: 2, canceled: 1 });
    expect(h.lease.acquire).toHaveBeenCalledWith(CFG, 'simple_billing_card');
    expect(h.lease.release).toHaveBeenCalledWith(CFG, 'simple_billing_card');
  });

  it('skips while another process holds the lease', async () => {
    h.lease.acquire.mockResolvedValue(false);
    expect(await runSimpleBillingCard(CFG)).toMatchObject({ skipped: true });
    expect(h.card.runCardJob).not.toHaveBeenCalled();
  });

  it('a failing run is reported and the lease released', async () => {
    h.card.runCardJob.mockRejectedValue(new Error('db down'));
    expect(await runSimpleBillingCard(CFG)).toMatchObject({ errors: ['card: db down'] });
    expect(h.lease.release).toHaveBeenCalled();
  });
});
