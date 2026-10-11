/**
 * The workspace billing routes with a saved card (server/routes/billingAccount.ts,
 * phase 3b). The card's own rules are card.ts's (stubbed here); these tests
 * hold what the routes add around them:
 *
 *   - the account view carries the card, whether one can be saved and on
 *     which gateways, for managers in the International edition only; Iran
 *     and members see null / false / [] and nothing is asked;
 *   - a checkout with autoRenew saves a card: plan or renewal only, the full
 *     price of the period (never the shortfall, whatever the balance), the
 *     price the page showed, Paddle's minimum, older card checkouts closed
 *     BEFORE the new payment row, a 'card_setup' row, and a recurring Paddle
 *     checkout named after the plan;
 *   - the card routes (charge, update, remove) need MANAGE and answer
 *     CARD_NOT_AVAILABLE outside the International edition; an upgrade
 *     charge answers 200 when settled and 202 while Paddle's answer is not
 *     known;
 *   - plan actions wait for a card that is past_due or about to be charged,
 *     and sync the card after; renewing goes through the card's ordering;
 *   - a card charge is never expired by the return route.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';

const WS = '11111111-1111-4111-8111-111111111111';
const PLAN = '22222222-2222-4222-8222-222222222222';
const PAY = '33333333-3333-4333-8333-333333333333';
const CALLBACK = 'https://app.test/acme/billing?card=setup';

class FakeBillingError extends Error {
  constructor(public code: string, public status = 400, public details: Record<string, unknown> | null = null) {
    super(code);
  }
}

const h = vi.hoisted(() => ({
  role: 'owner' as string,
  edition: 'international' as 'international' | 'iran',
  timeline: [] as string[],
  view: {} as Record<string, unknown>,
  planState: {} as Record<string, unknown>,
  account: {
    getAccountView: vi.fn(),
    createAccountPayment: vi.fn(),
    readAccountPayment: vi.fn(),
    verifyAccountPayment: vi.fn(),
    expireAccountPayment: vi.fn(async (..._a: unknown[]) => undefined),
  },
  plans: {
    accountPlanState: vi.fn(),
    amountNeededFor: vi.fn(),
    buyPlan: vi.fn(),
    upgradePlan: vi.fn(),
    scheduleChange: vi.fn(),
    setAutoRenew: vi.fn(),
  },
  card: {
    assertCardAllowsPlanChange: vi.fn(),
    cardAvailability: vi.fn(),
    cardUpdateCheckout: vi.fn(),
    cardView: vi.fn(),
    chargeCardForUpgrade: vi.fn(),
    prepareCardSetup: vi.fn(),
    removeCard: vi.fn(),
    renewWithCard: vi.fn(),
    syncWorkspaceCard: vi.fn(),
  },
  createCheckoutSession: vi.fn(),
  vat: null as number | null,
  /** Payment rows of the last hour (the 10-an-hour attempt cap). */
  paymentCount: 0,
}));

/** Records the call in the timeline, then answers with the spy. */
const traced = <T extends (...a: never[]) => unknown>(name: string, fn: T) =>
  (async (...a: Parameters<T>) => {
    h.timeline.push(name);
    return fn(...a);
  }) as unknown as T;

vi.mock('../../../../server/lib/workspaceAuth.js', () => ({
  serverConfigOf: (req: { serverConfig?: unknown }) => req.serverConfig,
  authorizeWorkspaceAccess: async (_req: unknown, res: { status(c: number): { json(b: unknown): void } }, _ws: string, opts: { manage?: boolean } = {}) => {
    if (opts.manage && !['owner', 'admin'].includes(h.role)) {
      res.status(403).json({ error: 'FORBIDDEN' });
      return null;
    }
    return { userId: 'u1', isAdmin: false, role: h.role };
  },
}));
vi.mock('../../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'gte']) b[m] = () => b;
      b.maybeSingle = async () => ({ data: { email: 'owner@acme.test' }, error: null });
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null, count: h.paymentCount });
      return b;
    },
  }),
}));
vi.mock('../../../../server/services/billing/index.js', () => ({
  logBillingEvent: async () => undefined,
  resolveNamedBillingConfig: async (_u: string, _k: string, _ws: string, name: string) => ({ provider: { name }, config: {} }),
}));
vi.mock('../../../../server/services/billing/callbackUrl.js', () => ({
  isAllowedBillingCallbackUrl: (_req: unknown, _cfg: unknown, url: string) => url.startsWith('https://app.test/'),
  resolvePublicApiOrigin: async () => 'https://api.test',
}));
vi.mock('../../../../server/services/billing/edition.js', () => ({
  editionErrorResponse: () => null,
  getBillingRegion: async () =>
    h.edition === 'iran'
      ? { edition: 'iran', regionMode: 'iran', currency: 'IRR' }
      : { edition: 'international', regionMode: 'multi', currency: 'USD' },
}));
vi.mock('../../../../server/services/billing/account/index.js', () => ({
  AccountBillingError: FakeBillingError,
  accountCurrency: async () => 'USD',
  accountPaymentNeedsBinding: () => true,
  createAccountPayment: traced('createAccountPayment', h.account.createAccountPayment),
  expireAccountPayment: h.account.expireAccountPayment,
  failAccountPayment: async () => undefined,
  getAccountView: h.account.getAccountView,
  getBillingSettings: async () => ({ vat_percent: { USD: h.vat } }),
  getReceipt: async () => null,
  isAccountPaymentLapsed: () => true,
  isCheckoutPayment: (p: { source?: string }) => !p.source || p.source === 'checkout' || p.source === 'card_setup',
  listLedger: async () => ({ items: [] }),
  patchAccountPayment: async () => undefined,
  readAccountPayment: h.account.readAccountPayment,
  updateBillingProfile: async () => ({}),
  verifyAccountPayment: h.account.verifyAccountPayment,
}));
vi.mock('../../../../server/services/billing/account/gateways.js', () => ({
  accountGateways: async () => [{ provider_name: 'paddle_sandbox', display_name: { en: 'Paddle' }, is_test: true }],
  isIranianGateway: (name: string) => name === 'zarinpal',
  resolveAccountGateway: async (_c: unknown, _ws: string, _cur: string, name: string | undefined) => ({
    provider: { name: name ?? 'paddle_sandbox', createCheckoutSession: h.createCheckoutSession },
    config: { client_token: 'test_x' },
  }),
}));
vi.mock('../../../../server/services/billing/account/plans.js', () => ({
  accountPlanState: h.plans.accountPlanState,
  amountNeededFor: h.plans.amountNeededFor,
  buyPlan: traced('buyPlan', h.plans.buyPlan),
  listPlanOptions: async () => [],
  processDueNow: async () => null,
  quotePlanChange: async () => ({}),
  scheduleChange: traced('scheduleChange', h.plans.scheduleChange),
  setAutoRenew: h.plans.setAutoRenew,
  upgradePlan: traced('upgradePlan', h.plans.upgradePlan),
}));
vi.mock('../../../../server/services/billing/account/card.js', () => ({
  assertCardAllowsPlanChange: traced('assertCardAllowsPlanChange', h.card.assertCardAllowsPlanChange),
  cardAvailability: h.card.cardAvailability,
  cardUpdateCheckout: h.card.cardUpdateCheckout,
  cardView: h.card.cardView,
  chargeCardForUpgrade: h.card.chargeCardForUpgrade,
  prepareCardSetup: traced('prepareCardSetup', h.card.prepareCardSetup),
  removeCard: h.card.removeCard,
  renewWithCard: h.card.renewWithCard,
  syncWorkspaceCard: traced('syncWorkspaceCard', h.card.syncWorkspaceCard),
}));
vi.mock('../../../../server/services/billing/account/notify.js', () => ({
  planNamesFor: async (_c: unknown, ids: string[]) => new Map(ids.map((id) => [id, { name: 'Pro', localized: {} }])),
}));

const { billingAccountRouter } = await import('../../../../server/routes/billingAccount.js');

const app = express();
app.use((req, _res, next) => {
  (req as unknown as { serverConfig: unknown }).serverConfig = { supabaseUrl: 'http://db', supabaseServiceRoleKey: 'k' };
  next();
});
app.use(express.json());
app.use('/api/billing', billingAccountRouter);
const server = http.createServer(app).listen(0);
afterAll(() => server.close());

function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const port = (server.address() as import('node:net').AddressInfo).port;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: `/api/billing/account/${WS}${path}`, method, headers: { 'content-type': 'application/json', connection: 'close' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, json: JSON.parse(data || '{}') }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

const CARD_VIEW = { id: 'card-1', provider: 'paddle_sandbox', status: 'active', brand: 'visa', last4: '4242', chargeable: true };
const SETUP = { customerId: 'ctm_1', recurring: { interval: 'monthly' }, priceCustomData: { plan_id: PLAN, interval: 'monthly', net_minor: 2900, tax_minor: 0 } };

beforeEach(() => {
  h.role = 'owner';
  h.edition = 'international';
  h.vat = null;
  h.paymentCount = 0;
  h.timeline.length = 0;
  for (const group of [h.account, h.plans, h.card]) for (const fn of Object.values(group)) fn.mockReset();
  h.createCheckoutSession.mockReset().mockResolvedValue({
    paymentUrl: 'https://app.test/x', sessionId: 'txn_setup', clientCheckout: { provider: 'paddle_sandbox', transactionId: 'txn_setup' },
  });
  h.account.getAccountView.mockImplementation(async () => ({ edition: h.edition, currency: h.edition === 'iran' ? 'IRR' : 'USD', balance_minor: 0 }));
  h.plans.accountPlanState.mockResolvedValue({ paid_period: null });
  h.account.createAccountPayment.mockImplementation(async (_c: unknown, input: Record<string, unknown>) => ({ id: PAY, ...input }));
  h.card.cardView.mockResolvedValue(CARD_VIEW);
  h.card.cardAvailability.mockResolvedValue({ available: true, providers: ['paddle_sandbox'] });
  h.card.prepareCardSetup.mockResolvedValue(SETUP);
  h.card.assertCardAllowsPlanChange.mockResolvedValue(undefined);
  h.card.syncWorkspaceCard.mockResolvedValue(undefined);
  h.plans.amountNeededFor.mockResolvedValue({
    needed: 2900, currency: 'USD', balance: 10_000, detail: { plan_id: PLAN, billing_interval: 'monthly' }, periodPriceMinor: 2900,
  });
});

describe('GET /account: the card part of the view', () => {
  it('a manager in the International edition sees the card and where one can be saved', async () => {
    const res = await call('GET', '');
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ card: CARD_VIEW, card_available: true, card_providers: ['paddle_sandbox'] });
    expect(h.card.cardAvailability.mock.calls[0][2]).toBe('USD');
  });

  it('Iran: card null, none available, and nothing about cards is asked', async () => {
    h.edition = 'iran';
    const res = await call('GET', '');
    expect(res.json).toMatchObject({ card: null, card_available: false, card_providers: [] });
    expect(h.card.cardView).not.toHaveBeenCalled();
    expect(h.card.cardAvailability).not.toHaveBeenCalled();
    expect(Object.keys(res.json).sort()).toEqual(
      ['edition', 'currency', 'balance_minor', 'paid_period', 'can_manage', 'gateways', 'card', 'card_available', 'card_providers'].sort(),
    );
  });

  it('a member who cannot manage billing sees no card', async () => {
    h.role = 'member';
    const res = await call('GET', '');
    expect(res.json).toMatchObject({ card: null, card_available: false, card_providers: [], can_manage: false });
    expect(h.card.cardView).not.toHaveBeenCalled();
  });

  it('the card is chargeable only on a gateway still offered to this viewer with card renewal on', async () => {
    expect((await call('GET', '')).json.card).toMatchObject({ id: 'card-1', chargeable: true });
    h.card.cardAvailability.mockResolvedValue({ available: false, providers: [] });
    expect((await call('GET', '')).json.card).toMatchObject({ id: 'card-1', chargeable: false });
    h.card.cardAvailability.mockResolvedValue({ available: true, providers: ['paddle_sandbox'] });
    h.card.cardView.mockResolvedValue({ ...CARD_VIEW, chargeable: false });
    expect((await call('GET', '')).json.card).toMatchObject({ id: 'card-1', chargeable: false });
  });

  it('a card that cannot be read shows none; the page still loads', async () => {
    h.card.cardView.mockRejectedValue(new Error('db blip'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await call('GET', '');
    warn.mockRestore();
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ card: null, card_available: true });
  });
});

describe('POST checkout with autoRenew (saving a card)', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    purpose: 'plan', planId: PLAN, interval: 'monthly', currency: 'USD', providerName: 'paddle_sandbox',
    callbackUrl: CALLBACK, expectedNetMinor: 2900, autoRenew: true, ...over,
  });

  it('charges the full price (the balance covers it: still the full price), with the card closed out first', async () => {
    h.vat = 10;
    h.plans.amountNeededFor.mockResolvedValue({
      needed: 2900, currency: 'USD', balance: 10_000, detail: { plan_id: PLAN, billing_interval: 'monthly' }, periodPriceMinor: 2900,
    });
    const res = await call('POST', '/checkout', body());
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ paymentId: PAY, net_minor: 2900, tax_minor: 290, amount_minor: 3190 });
    // Priced here, not by the net the quote compares.
    expect(h.plans.amountNeededFor.mock.calls[0][2]).toMatchObject({ purpose: 'plan', planId: PLAN, forCardSetup: true, expectedNetMinor: undefined });
    // Older card checkouts closed BEFORE this payment row exists.
    expect(h.timeline.indexOf('prepareCardSetup')).toBeLessThan(h.timeline.indexOf('createAccountPayment'));
    expect(h.card.prepareCardSetup.mock.calls[0][2]).toEqual({
      providerName: 'paddle_sandbox', purpose: 'plan', planId: PLAN, interval: 'monthly', viewer: { isPlatformAdmin: false },
    });
    expect(h.account.createAccountPayment.mock.calls[0][1]).toMatchObject({
      netMinor: 2900, taxMinor: 290, purpose: 'plan', source: 'card_setup', purposeDetail: { plan_id: PLAN, billing_interval: 'monthly' },
    });
    expect(h.createCheckoutSession.mock.calls[0][1]).toMatchObject({
      intentId: PAY,
      description: 'Pro',
      recurring: { interval: 'monthly' },
      priceCustomData: SETUP.priceCustomData,
      cardSetup: true,
      customerId: 'ctm_1',
      metadata: { amount: '3190' },
    });
  });

  it('a renewal saves the card by paying the next period now; its plan and interval come from the renewal', async () => {
    h.plans.amountNeededFor.mockResolvedValue({
      needed: 900, currency: 'USD', balance: 0, detail: { plan_id: PLAN, billing_interval: 'yearly', period_end: '2026-11-01T00:00:00.000Z' }, periodPriceMinor: 29000,
    });
    const res = await call('POST', '/checkout', { purpose: 'renewal', currency: 'USD', providerName: 'paddle_sandbox', callbackUrl: CALLBACK, expectedNetMinor: 29000, autoRenew: true });
    expect(res.status).toBe(200);
    expect(h.card.prepareCardSetup.mock.calls[0][2]).toMatchObject({ purpose: 'renewal', planId: PLAN, interval: 'yearly' });
    expect(h.account.createAccountPayment.mock.calls[0][1]).toMatchObject({ netMinor: 29000, purpose: 'renewal', source: 'card_setup' });
  });

  it('without an earlier Paddle customer none is sent', async () => {
    h.card.prepareCardSetup.mockResolvedValue({ ...SETUP, customerId: null });
    await call('POST', '/checkout', body());
    expect(h.createCheckoutSession.mock.calls[0][1]).not.toHaveProperty('customerId');
  });

  it('an upgrade cannot save a card', async () => {
    const res = await call('POST', '/checkout', body({ purpose: 'upgrade' }));
    expect(res).toEqual({ status: 400, json: { error: 'CARD_SETUP_PURPOSE' } });
    expect(h.plans.amountNeededFor).not.toHaveBeenCalled();
  });

  it('needs the price the page showed; another price now charges nothing', async () => {
    expect((await call('POST', '/checkout', body({ expectedNetMinor: undefined }))).status).toBe(400);
    const res = await call('POST', '/checkout', body({ expectedNetMinor: 2500 }));
    expect(res).toEqual({ status: 409, json: { error: 'QUOTE_CHANGED', details: { price_minor: 2900 } } });
    expect(h.card.prepareCardSetup).not.toHaveBeenCalled();
    expect(h.account.createAccountPayment).not.toHaveBeenCalled();
  });

  it("below Paddle's minimum nothing is prepared or created", async () => {
    h.plans.amountNeededFor.mockResolvedValue({ needed: 50, currency: 'USD', balance: 0, detail: { plan_id: PLAN, billing_interval: 'monthly' }, periodPriceMinor: 50 });
    const res = await call('POST', '/checkout', body({ expectedNetMinor: 50 }));
    expect(res).toEqual({ status: 400, json: { error: 'CARD_CHARGE_BELOW_MINIMUM', details: { minimum_minor: 70, amount_minor: 50 } } });
    expect(h.card.prepareCardSetup).not.toHaveBeenCalled();
    expect(h.account.createAccountPayment).not.toHaveBeenCalled();
  });

  it('a card already saved (or a setup in flight) creates no payment', async () => {
    h.card.prepareCardSetup.mockRejectedValue(new FakeBillingError('CARD_ALREADY_SAVED', 409));
    const res = await call('POST', '/checkout', body());
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('CARD_ALREADY_SAVED');
    expect(h.account.createAccountPayment).not.toHaveBeenCalled();
    expect(h.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('Iran: CARD_NOT_AVAILABLE before anything is priced', async () => {
    h.edition = 'iran';
    const res = await call('POST', '/checkout', body());
    expect(res).toEqual({ status: 400, json: { error: 'CARD_NOT_AVAILABLE' } });
    expect(h.plans.amountNeededFor).not.toHaveBeenCalled();
  });

  it('with no gateway named, the first one that saves cards', async () => {
    h.card.cardAvailability.mockResolvedValue({ available: true, providers: ['paddle'] });
    await call('POST', '/checkout', body({ providerName: undefined }));
    expect(h.card.prepareCardSetup.mock.calls[0][2]).toMatchObject({ providerName: 'paddle' });
  });
});

describe('POST checkout without a card setup', () => {
  it('a renewal paid online while a card is live is refused (the card pays it)', async () => {
    h.plans.amountNeededFor.mockRejectedValue(new FakeBillingError('CARD_PAYS_RENEWAL', 409));
    const res = await call('POST', '/checkout', { purpose: 'renewal', currency: 'USD', callbackUrl: CALLBACK });
    expect(res.json.error).toBe('CARD_PAYS_RENEWAL');
    expect(h.plans.amountNeededFor.mock.calls[0][2]).toMatchObject({ forCardSetup: false });
  });

  it('charges the shortfall as before, with no card in it', async () => {
    h.plans.amountNeededFor.mockResolvedValue({ needed: 2900, currency: 'USD', balance: 2000, detail: { plan_id: PLAN }, periodPriceMinor: 2900 });
    const res = await call('POST', '/checkout', { purpose: 'plan', planId: PLAN, interval: 'monthly', currency: 'USD', callbackUrl: CALLBACK, expectedNetMinor: 2900 });
    expect(res.status).toBe(200);
    expect(h.account.createAccountPayment.mock.calls[0][1]).toMatchObject({ netMinor: 900 });
    expect(h.account.createAccountPayment.mock.calls[0][1]).not.toHaveProperty('source');
    expect(h.createCheckoutSession.mock.calls[0][1]).not.toHaveProperty('recurring');
    expect(h.card.prepareCardSetup).not.toHaveBeenCalled();
  });

  it('an upgrade paid online waits while the card is past_due', async () => {
    h.card.assertCardAllowsPlanChange.mockRejectedValue(new FakeBillingError('CARD_PAST_DUE', 409));
    const res = await call('POST', '/checkout', { purpose: 'upgrade', planId: PLAN, currency: 'USD', callbackUrl: CALLBACK });
    expect(res.json.error).toBe('CARD_PAST_DUE');
    expect(h.plans.amountNeededFor).not.toHaveBeenCalled();
  });
});

describe('POST card/charge (upgrade charged to the card)', () => {
  const body = { purpose: 'upgrade', planId: PLAN, expectedNetMinor: 1500 };

  it('200 with what the upgrade did when Paddle charged and it settled', async () => {
    h.card.chargeCardForUpgrade.mockResolvedValue({ status: 'succeeded', paymentId: PAY, purposeResult: { action: 'upgraded' } });
    const res = await call('POST', '/card/charge', body);
    expect(res).toEqual({ status: 200, json: { status: 'succeeded', paymentId: PAY, purpose_result: { action: 'upgraded' } } });
    expect(h.card.chargeCardForUpgrade.mock.calls[0][2]).toEqual({ planId: PLAN, expectedNetMinor: 1500, actorId: 'u1' });
  });

  it('the total the button showed goes along (VAT included); a malformed one is refused', async () => {
    h.card.chargeCardForUpgrade.mockResolvedValue({ status: 'succeeded', paymentId: PAY, purposeResult: { action: 'upgraded' } });
    expect((await call('POST', '/card/charge', { ...body, expectedTotalMinor: 1650 })).status).toBe(200);
    expect(h.card.chargeCardForUpgrade.mock.calls[0][2]).toEqual({ planId: PLAN, expectedNetMinor: 1500, expectedTotalMinor: 1650, actorId: 'u1' });
    expect((await call('POST', '/card/charge', { ...body, expectedTotalMinor: 0 })).status).toBe(400);
    expect((await call('POST', '/card/charge', { ...body, expectedTotalMinor: 16.5 })).status).toBe(400);
    expect(h.card.chargeCardForUpgrade).toHaveBeenCalledTimes(1);
  });

  it('counts toward the 10 payment attempts an hour: the 11th is refused before the card is touched', async () => {
    h.card.chargeCardForUpgrade.mockResolvedValue({ status: 'succeeded', paymentId: PAY, purposeResult: { action: 'upgraded' } });
    h.paymentCount = 9;
    expect((await call('POST', '/card/charge', body)).status).toBe(200);
    h.paymentCount = 10;
    expect(await call('POST', '/card/charge', body)).toEqual({ status: 429, json: { error: 'TOO_MANY_CHECKOUTS' } });
    expect(h.card.chargeCardForUpgrade).toHaveBeenCalledTimes(1);
  });

  it("202 while Paddle's answer is not known", async () => {
    h.card.chargeCardForUpgrade.mockResolvedValue({ status: 'processing', paymentId: PAY });
    expect(await call('POST', '/card/charge', body)).toEqual({ status: 202, json: { status: 'processing', paymentId: PAY } });
  });

  it("a decline answers 402 with Paddle's reason", async () => {
    h.card.chargeCardForUpgrade.mockRejectedValue(new FakeBillingError('CARD_DECLINED', 402, { code: 'subscription_payment_declined' }));
    expect(await call('POST', '/card/charge', body)).toEqual({
      status: 402, json: { error: 'CARD_DECLINED', details: { code: 'subscription_payment_declined' } },
    });
  });

  it('only an upgrade, only for managers, only in the International edition', async () => {
    expect((await call('POST', '/card/charge', { ...body, purpose: 'renewal' })).status).toBe(400);
    h.role = 'member';
    expect((await call('POST', '/card/charge', body)).status).toBe(403);
    h.role = 'owner';
    h.edition = 'iran';
    expect(await call('POST', '/card/charge', body)).toEqual({ status: 400, json: { error: 'CARD_NOT_AVAILABLE' } });
    expect(h.card.chargeCardForUpgrade).not.toHaveBeenCalled();
  });
});

describe('POST card/update and DELETE card', () => {
  it("returns Paddle's update checkout, back to the page's own URL", async () => {
    h.card.cardUpdateCheckout.mockResolvedValue({ clientCheckout: { transactionId: 'txn_upd' }, transactionId: 'txn_upd' });
    const url = 'https://app.test/acme/billing?card=updated';
    const res = await call('POST', '/card/update', { callbackUrl: url });
    expect(res).toEqual({ status: 200, json: { clientCheckout: { transactionId: 'txn_upd' }, transactionId: 'txn_upd' } });
    expect(h.card.cardUpdateCheckout.mock.calls[0][2]).toEqual({ successUrl: url });
  });

  it('refuses a return to another site, and Iran', async () => {
    expect(await call('POST', '/card/update', { callbackUrl: 'https://evil.test/x' })).toEqual({ status: 400, json: { error: 'INVALID_CALLBACK_URL' } });
    h.edition = 'iran';
    expect((await call('POST', '/card/update', { callbackUrl: 'https://app.test/x' })).json.error).toBe('CARD_NOT_AVAILABLE');
    expect(h.card.cardUpdateCheckout).not.toHaveBeenCalled();
  });

  it('removes the card; no card is 404', async () => {
    h.card.removeCard.mockResolvedValue({ removed: true });
    expect(await call('DELETE', '/card')).toEqual({ status: 200, json: { removed: true } });
    h.card.removeCard.mockRejectedValue(new FakeBillingError('CARD_NOT_FOUND', 404));
    expect((await call('DELETE', '/card')).status).toBe(404);
    h.role = 'member';
    expect((await call('DELETE', '/card')).status).toBe(403);
  });
});

describe('auto-renew, renew and plan actions with a card', () => {
  it('auto-renew answers with the card as it is now; Iran answers as before', async () => {
    h.plans.setAutoRenew.mockResolvedValue(false);
    expect(await call('PUT', '/auto-renew', { enabled: false })).toEqual({ status: 200, json: { auto_renew: false, card: CARD_VIEW } });
    h.edition = 'iran';
    expect(await call('PUT', '/auto-renew', { enabled: false })).toEqual({ status: 200, json: { auto_renew: false } });
  });

  it("renew goes through the card's ordering", async () => {
    h.card.renewWithCard.mockResolvedValue({ action: 'prepaid' });
    const res = await call('POST', '/renew', { expectedPeriodEnd: '2026-11-01T00:00:00.000Z', expectedPriceMinor: 2900 });
    expect(res.json).toEqual({ action: 'prepaid' });
    expect(h.card.renewWithCard.mock.calls[0][2]).toEqual({ actorId: 'u1', expectedPeriodEnd: '2026-11-01T00:00:00.000Z', expectedPriceMinor: 2900 });
  });

  it.each([
    ['/upgrade', { planId: PLAN }, 'upgradePlan'],
    ['/change', { planId: PLAN, interval: 'yearly' }, 'scheduleChange'],
    ['/plan', { planId: PLAN, interval: 'monthly' }, 'buyPlan'],
  ])('%s: the card is checked first and synced after', async (path, body, action) => {
    const spy = h.plans[action as 'upgradePlan'];
    spy.mockResolvedValue({ action: 'done' });
    const res = await call('POST', path, body);
    expect(res).toEqual({ status: 200, json: { action: 'done' } });
    expect(h.timeline).toEqual(['assertCardAllowsPlanChange', action, 'syncWorkspaceCard']);
  });

  it.each(['/upgrade', '/change', '/plan'])('%s waits while the card is past_due or about to be charged', async (path) => {
    h.card.assertCardAllowsPlanChange.mockRejectedValue(new FakeBillingError('CARD_RENEWAL_IN_PROGRESS', 409, { frozen_until: '2026-11-01T06:00:00.000Z' }));
    const res = await call('POST', path, { planId: PLAN, interval: 'monthly' });
    expect(res).toEqual({ status: 409, json: { error: 'CARD_RENEWAL_IN_PROGRESS', details: { frozen_until: '2026-11-01T06:00:00.000Z' } } });
    expect(h.timeline).toEqual(['assertCardAllowsPlanChange']);
  });
});

describe('the return route never ends a card charge', () => {
  it.each([
    ['card_charge', false],
    ['card_renewal', false],
    ['checkout', true],
    ['card_setup', true],
  ])('a lapsed pending %s row: expired = %s', async (source, expired) => {
    h.account.readAccountPayment.mockResolvedValue({ id: PAY, workspace_id: WS, provider: 'paddle_sandbox', status: 'pending', verified_at: null, source });
    h.account.verifyAccountPayment.mockResolvedValue({ status: 'pending' });
    const res = await call('POST', `/payments/${PAY}/verify`, { provider: 'paddle_sandbox', params: {} });
    expect(res.json).toEqual(expired ? { status: 'failed', reason: 'expired' } : { status: 'pending' });
    expect(h.account.expireAccountPayment).toHaveBeenCalledTimes(expired ? 1 : 0);
  });
});
