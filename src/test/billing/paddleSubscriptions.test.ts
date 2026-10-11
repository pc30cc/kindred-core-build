/**
 * Paddle subscription layer for the saved card (simple billing phase 3b,
 * server/services/billing/providers/paddleSubscriptions.ts): exact requests,
 * the do_not_bill guard, outcomes of a call that may have charged, and the
 * readers over Paddle's own example payloads (Paddle's OpenAPI spec,
 * github.com/PaddleHQ/paddle-openapi, trimmed of fields we never read).
 * Paddle is never called: `fetch` is stubbed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PADDLE_REQUEST_TIMEOUT_MS,
  buildChargeItem,
  buildRecurringItem,
  cancelSubscriptionAt,
  cardAutoRenewEnabled,
  clearScheduledChange,
  clientCheckoutFor,
  createCharge,
  getSubscription,
  getTransaction,
  getUpdatePaymentMethodTransaction,
  listSubscriptionTransactions,
  paddleConfigFor,
  paddleRequest,
  previewCharge,
  previewSubscriptionUpdate,
  readCardDetails,
  readCardEvent,
  readSubscription,
  readTransaction,
  updateSubscription,
  type SubscriptionPatch,
} from '../../../server/services/billing/providers/paddleSubscriptions.js';
import type { BillingProviderConfig } from '../../../server/services/billing/types.js';

const API_KEY = 'pdl_live_apikey_mock_not_real';
const LIVE: BillingProviderConfig = { provider: 'paddle', api_key: API_KEY, client_token: 'live_mock_client_token' };
const SANDBOX: BillingProviderConfig = {
  provider: 'paddle_sandbox',
  api_key: 'pdl_sdbx_apikey_mock_not_real',
  client_token: 'test_mock_client_token',
};
const SUB = 'sub_01hv8x29kz0t586xy6zn1a62ny';

type Reply = { status: number; body?: unknown; text?: string } | Error | 'hang' | 'body_error';
type Call = { url: string; method: string; headers: Record<string, string>; body: unknown; signal: AbortSignal | undefined };

/** Stubs fetch with the replies in order (the last one repeats) and records each call. */
function stubFetch(...replies: Reply[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      signal: init.signal ?? undefined,
    });
    const reply = replies.length > 1 ? replies.shift()! : replies[0];
    if (reply instanceof Error) throw reply;
    if (reply === 'hang') {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
      });
    }
    if (reply === 'body_error') {
      return { status: 200, ok: true, text: async () => { throw new Error('socket hang up'); } };
    }
    const text = reply.text ?? (reply.body === undefined ? '' : JSON.stringify(reply.body));
    return { status: reply.status, ok: reply.status >= 200 && reply.status < 300, text: async () => text, json: async () => JSON.parse(text) };
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// --- Paddle's examples ------------------------------------------------------

/** "Get a subscription (200)" — data. */
const SPEC_SUBSCRIPTION = {
  id: 'sub_01hv8y5ehszzq0yv20ttx3166y', status: 'active', customer_id: 'ctm_01hv8wt8nffez4p2t6typn4a5j',
  address_id: 'add_01hv8y4jk511j9g2n9a2mexjbx', business_id: null, currency_code: 'USD',
  created_at: '2024-04-12T10:38:00.761Z', updated_at: '2024-04-12T10:38:00.761Z',
  started_at: '2024-04-12T10:37:59.556997Z', first_billed_at: '2024-04-12T10:37:59.556997Z',
  next_billed_at: '2024-05-12T10:37:59.556997Z', paused_at: null, canceled_at: null, collection_mode: 'automatic',
  billing_details: null,
  current_billing_period: { starts_at: '2024-04-12T10:37:59.556997Z', ends_at: '2024-05-12T10:37:59.556997Z' },
  billing_cycle: { frequency: 1, interval: 'month' }, scheduled_change: null,
  items: [
    {
      status: 'active', quantity: 10, recurring: true, created_at: '2024-04-12T10:38:00.761Z', updated_at: '2024-04-12T10:38:00.761Z',
      previously_billed_at: '2024-04-12T10:37:59.556997Z', next_billed_at: '2024-05-12T10:37:59.556997Z', trial_dates: null,
      price: {
        id: 'pri_01gsz8x8sawmvhz1pv30nge1ke', product_id: 'pro_01gsz4t5hdjse780zja8vvr7jg', type: 'standard',
        description: 'Monthly', name: 'Monthly (per seat)', tax_mode: 'account_setting',
        billing_cycle: { frequency: 1, interval: 'month' }, trial_period: null,
        unit_price: { amount: '3000', currency_code: 'USD' }, custom_data: null, status: 'active',
      },
    },
    {
      status: 'active', quantity: 1, recurring: true, created_at: '2024-04-12T10:38:00.761Z', updated_at: '2024-04-12T10:38:00.761Z',
      previously_billed_at: '2024-04-12T10:37:59.556997Z', next_billed_at: '2024-05-12T10:37:59.556997Z', trial_dates: null,
      price: {
        id: 'pri_01h1vjfevh5etwq3rb416a23h2', product_id: 'pro_01h1vjes1y163xfj1rh1tkfb65', type: 'standard',
        description: 'Monthly', name: 'Monthly (recurring addon)', tax_mode: 'account_setting',
        billing_cycle: { frequency: 1, interval: 'month' }, trial_period: null,
        unit_price: { amount: '10000', currency_code: 'USD' }, custom_data: null, status: 'active',
      },
    },
  ],
  custom_data: null, discount: null, import_meta: null,
};

/** Ours: one inline recurring price we set, a scheduled cancel (auto-renew off). */
const CARD_SUBSCRIPTION = {
  ...SPEC_SUBSCRIPTION,
  id: SUB,
  next_billed_at: '2026-11-08T10:00:00Z',
  current_billing_period: { starts_at: '2026-10-09T10:00:00Z', ends_at: '2026-11-08T10:00:00Z' },
  scheduled_change: { action: 'cancel', effective_at: '2026-11-08T10:00:00Z', resume_at: null },
  items: [{
    ...SPEC_SUBSCRIPTION.items[0],
    quantity: 1,
    price: {
      ...SPEC_SUBSCRIPTION.items[0].price,
      id: 'pri_01jcardrecurring0000000000',
      unit_price: { amount: '2900', currency_code: 'USD' },
      billing_cycle: { frequency: 1, interval: 'year' },
      custom_data: { plan_id: 'plan-pro', interval: 'yearly', net_minor: 2900, tax_minor: 0 },
    },
  }],
  custom_data: { workspace_id: 'ws-1', card_id: 'card-1' },
};

/** "List transactions (200)" — data, one item each: a renewal that failed 3-D Secure, the checkout that created that subscription, another subscription's renewal, an API checkout. */
const SPEC_TRANSACTIONS = [
  {"id":"txn_01hv8xbtmb6zc7c264ycteehth","status":"past_due","customer_id":"ctm_01hv8wt8nffez4p2t6typn4a5j","custom_data":null,"currency_code":"USD","origin":"subscription_recurring","subscription_id":"sub_01hv8x29kz0t586xy6zn1a62ny","created_at":"2024-04-12T10:24:01.588479Z","billed_at":"2024-04-12T10:24:01.163479Z","items":[{"price":{"id":"pri_01gsz8x8sawmvhz1pv30nge1ke","description":"Monthly","name":"Monthly (per seat)","billing_cycle":{"interval":"month","frequency":1},"tax_mode":"account_setting","unit_price":{"amount":"3000","currency_code":"USD"},"custom_data":null},"quantity":10}],"details":{"totals":{"subtotal":"40000","tax":"3549","discount":"0","total":"43549","grand_total":"43549","grand_total_tax":"3549","fee":null,"credit":"0","credit_to_balance":"0","balance":"43549","earnings":null,"currency_code":"USD"}},"payments":[{"amount":"43549","status":"error","error_code":"authentication_failed","method_details":{"type":"card","card":{"type":"visa","last4":"3184","expiry_month":1,"expiry_year":2025,"cardholder_name":"Michael McGovern"}},"created_at":"2024-04-12T10:24:01.692772Z","captured_at":null}]},
  {"id":"txn_01hv8wptq8987qeep44cyrewp9","status":"completed","customer_id":"ctm_01hv8wt8nffez4p2t6typn4a5j","custom_data":null,"currency_code":"USD","origin":"web","subscription_id":"sub_01hv8x29kz0t586xy6zn1a62ny","created_at":"2024-04-12T10:12:33.2014Z","billed_at":"2024-04-12T10:18:48.294633Z","items":[{"price":{"id":"pri_01gsz8x8sawmvhz1pv30nge1ke","description":"Monthly","name":"Monthly (per seat)","billing_cycle":{"interval":"month","frequency":1},"tax_mode":"account_setting","unit_price":{"amount":"3000","currency_code":"USD"},"custom_data":null},"quantity":10}],"details":{"totals":{"subtotal":"59900","tax":"5315","discount":"0","total":"65215","grand_total":"65215","grand_total_tax":"5315","fee":"3311","credit":"0","credit_to_balance":"0","balance":"0","earnings":"56589","currency_code":"USD"}},"payments":[{"amount":"65215","status":"captured","error_code":null,"method_details":{"type":"card","card":{"type":"visa","last4":"3184","expiry_month":1,"expiry_year":2025,"cardholder_name":"Michael McGovern"}},"created_at":"2024-04-12T10:18:33.579142Z","captured_at":"2024-04-12T10:18:47.635628Z"},{"amount":"65215","status":"error","error_code":"declined","method_details":{"type":"card","card":{"type":"visa","last4":"0002","expiry_month":1,"expiry_year":2025,"cardholder_name":"Michael McGovern"}},"created_at":"2024-04-12T10:15:57.888183Z","captured_at":null}]},
  {"id":"txn_01hv8wnvvtedwjrhfhpr9vkq9w","status":"completed","customer_id":"ctm_01hchnxgrh0wcyngy8q9d1hpkz","custom_data":null,"currency_code":"USD","origin":"subscription_recurring","subscription_id":"sub_01hchny8h8r5w9xtb514qs6rdy","created_at":"2024-04-12T10:12:01.643104Z","billed_at":"2024-04-12T10:12:01.530736Z","items":[{"price":{"id":"pri_01h1vjfevh5etwq3rb416a23h2","description":"Monthly (recurring addon)","name":null,"billing_cycle":{"interval":"month","frequency":1},"tax_mode":"account_setting","unit_price":{"amount":"10000","currency_code":"USD"},"custom_data":null},"quantity":1}],"details":{"totals":{"subtotal":"40000","tax":"7600","discount":"0","total":"47600","grand_total":"47600","grand_total_tax":"7600","fee":"2430","credit":"0","credit_to_balance":"0","balance":"0","earnings":"37570","currency_code":"USD"}},"payments":[{"amount":"47600","status":"captured","error_code":null,"method_details":{"type":"card","card":{"type":"visa","last4":"5556","expiry_month":6,"expiry_year":2026,"cardholder_name":"test"}},"created_at":"2024-04-12T10:12:01.729257Z","captured_at":"2024-04-12T10:12:04.496216Z"}]},
  {"id":"txn_01hv8kxg3hxyxs9t471ms9kfsz","status":"ready","customer_id":"ctm_01hv6y1jedq4p1n0yqn5ba3ky4","custom_data":null,"currency_code":"USD","origin":"api","subscription_id":null,"created_at":"2024-04-12T07:38:54.904246Z","billed_at":null,"items":[{"price":{"id":"pri_01gsz91wy9k1yn7kx82aafwvea","description":"Annual","name":"Annual (per seat)","billing_cycle":{"interval":"year","frequency":1},"tax_mode":"account_setting","unit_price":{"amount":"50000","currency_code":"USD"},"custom_data":null},"quantity":20}],"details":{"totals":{"subtotal":"1319900","tax":"117141","discount":"0","total":"1437041","grand_total":"1437041","grand_total_tax":"117141","fee":null,"credit":"0","credit_to_balance":"0","balance":"1437041","earnings":null,"currency_code":"USD"}},"payments":[]},
];

/** A renewal of ours: our price custom_data, and the checkout's custom_data Paddle copied (intent_id included). */
const RENEWAL = {
  ...SPEC_TRANSACTIONS[2],
  id: 'txn_01jrenewal000000000000000',
  subscription_id: SUB,
  status: 'completed',
  custom_data: { workspace_id: 'ws-1', intent_id: 'pay-setup-1', card_setup: '1' },
  items: [
    { price: { ...SPEC_TRANSACTIONS[2].items[0].price, custom_data: { plan_id: 'plan-pro', interval: 'monthly', net_minor: 2900, tax_minor: 0 } }, quantity: 1 },
    { price: { ...SPEC_TRANSACTIONS[2].items[0].price, custom_data: null }, quantity: 1 },
  ],
  details: { totals: { ...SPEC_TRANSACTIONS[2].details.totals, total: '2900', grand_total: '2900', credit: '0' } },
};

/** "Preview a one-time charge for a subscription (200)" — the parts read. */
const SPEC_CHARGE_PREVIEW = {
  status: 'active', customer_id: 'ctm_01hv8wt8nffez4p2t6typn4a5j', currency_code: 'USD',
  next_billed_at: '2024-06-10T12:01:46.293348Z',
  immediate_transaction: {
    billing_period: { starts_at: '2024-05-13T10:40:05.929Z', ends_at: '2024-06-10T12:01:46.293348Z' },
    details: {
      totals: {
        subtotal: '19900', tax: '1766', discount: '0', total: '21666', fee: null, credit: '0', credit_to_balance: '0',
        balance: '21666', grand_total: '21666', grand_total_tax: '1766', earnings: null, currency_code: 'USD',
      },
    },
    adjustments: [],
  },
  update_summary: {
    credit: { amount: '0', currency_code: 'USD' },
    charge: { amount: '21666', currency_code: 'USD' },
    result: { action: 'charge', amount: '21666', currency_code: 'USD' },
  },
};

/** "Get a transaction to update payment method (200)" — data, trimmed. */
const SPEC_UPDATE_PAYMENT_METHOD_TXN = {
  id: 'txn_01jspbekkwn03q6zp8bezp3tv2', status: 'ready', customer_id: 'ctm_01jspbafm96p2ppbe85921nf6p',
  custom_data: null, origin: 'subscription_payment_method_change', collection_mode: 'automatic',
  subscription_id: 'sub_01jspbbyjtkycfmjf7ye85yvp2', currency_code: 'USD',
  details: { totals: { subtotal: '0', tax: '0', discount: '0', total: '0', grand_total: '0', credit: '0', currency_code: 'USD' } },
  payments: [],
};

// --- paddleRequest ------------------------------------------------------------

describe('paddleRequest', () => {
  it('sends the key, JSON and the body, and answers the envelope’s data', async () => {
    const { calls } = stubFetch({ status: 200, body: { data: { id: 'sub_1' }, meta: { request_id: 'r' } } });
    const result = await paddleRequest(LIVE, '/subscriptions/sub_1', { method: 'PATCH', body: { custom_data: { a: 1 } } });
    expect(result).toEqual({ ok: true, status: 200, data: { id: 'sub_1' }, error: null, unknownOutcome: false });
    expect(calls[0]).toMatchObject({
      url: 'https://api.paddle.com/subscriptions/sub_1',
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: { custom_data: { a: 1 } },
    });
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
  });

  it('GET by default, with no body; the sandbox flag picks the sandbox API', async () => {
    const { calls } = stubFetch({ status: 200, body: { data: [] } });
    await paddleRequest({ ...SANDBOX, sandbox: 'true' }, '/subscriptions?per_page=1');
    expect(calls[0]).toMatchObject({ url: 'https://sandbox-api.paddle.com/subscriptions?per_page=1', method: 'GET', body: undefined });
  });

  it('a Paddle error envelope is a refusal: its code and detail, never an unknown outcome (even for a charge)', async () => {
    stubFetch({ status: 409, body: { error: { type: 'request_error', code: 'subscription_locked_renewal', detail: 'Subscription is locked for renewal' } } });
    expect(await paddleRequest(LIVE, '/subscriptions/sub_1/charge', { method: 'POST', body: {}, charges: true })).toEqual({
      ok: false, status: 409, data: null,
      error: { code: 'subscription_locked_renewal', detail: 'Subscription is locked for renewal' },
      unknownOutcome: false,
    });
  });

  it('a 5xx may have charged: unknown outcome for a charge only', async () => {
    stubFetch({ status: 502, text: '<html>Bad gateway</html>' });
    const charge = await paddleRequest(LIVE, '/x', { method: 'POST', body: {}, charges: true });
    expect(charge).toMatchObject({ ok: false, status: 502, error: { code: 'http_502' }, unknownOutcome: true });
    const read = await paddleRequest(LIVE, '/x');
    expect(read).toMatchObject({ ok: false, status: 502, error: { code: 'http_502' }, unknownOutcome: false });
    stubFetch({ status: 500, body: { error: { code: 'internal_error', detail: 'Something went wrong' } } });
    expect(await paddleRequest(LIVE, '/x', { method: 'POST', body: {}, charges: true }))
      .toMatchObject({ error: { code: 'internal_error' }, unknownOutcome: true });
  });

  it('a network error never throws; for a charge the outcome is unknown', async () => {
    stubFetch(new TypeError('fetch failed'));
    expect(await paddleRequest(LIVE, '/x', { method: 'POST', body: {}, charges: true })).toEqual({
      ok: false, status: 0, data: null, error: { code: 'network_error', detail: 'fetch failed' }, unknownOutcome: true,
    });
    expect(await paddleRequest(LIVE, '/x')).toMatchObject({ error: { code: 'network_error' }, unknownOutcome: false });
  });

  it('times out (aborts the request) after timeoutMs', async () => {
    const { calls } = stubFetch('hang');
    const result = await paddleRequest(LIVE, '/x', { method: 'POST', body: {}, charges: true, timeoutMs: 20 });
    expect(calls[0].signal?.aborted).toBe(true);
    expect(result).toEqual({
      ok: false, status: 0, data: null, error: { code: 'timeout', detail: 'Paddle did not answer within 20 ms' }, unknownOutcome: true,
    });
  });

  it('waits 15 s by default', async () => {
    vi.useFakeTimers();
    const { calls } = stubFetch('hang');
    const pending = paddleRequest(LIVE, '/x');
    await vi.advanceTimersByTimeAsync(PADDLE_REQUEST_TIMEOUT_MS - 1);
    expect(calls[0].signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ error: { code: 'timeout' } });
    expect(PADDLE_REQUEST_TIMEOUT_MS).toBe(15_000);
  });

  it('a 2xx it cannot read: unknown for a charge, an error otherwise', async () => {
    stubFetch({ status: 201, text: 'OK' });
    expect(await paddleRequest(LIVE, '/x', { method: 'POST', body: {}, charges: true }))
      .toMatchObject({ ok: false, status: 201, error: { code: 'unknown_outcome' }, unknownOutcome: true });
    expect(await paddleRequest(LIVE, '/x')).toMatchObject({ ok: false, error: { code: 'http_201' }, unknownOutcome: false });
    stubFetch('body_error');
    expect(await paddleRequest(LIVE, '/x', { method: 'POST', body: {}, charges: true }))
      .toMatchObject({ ok: false, status: 200, error: { code: 'network_error', detail: 'socket hang up' }, unknownOutcome: true });
  });

  it('an empty 2xx body is ok with no data', async () => {
    stubFetch({ status: 204 });
    expect(await paddleRequest(LIVE, '/x', { method: 'PATCH', body: {} })).toEqual({ ok: true, status: 204, data: null, error: null, unknownOutcome: false });
  });

  it('without an API key nothing is sent', async () => {
    const { fn } = stubFetch({ status: 200, body: { data: {} } });
    expect(await paddleRequest({ provider: 'paddle' }, '/x')).toMatchObject({ ok: false, status: 0, error: { code: 'not_configured' } });
    expect(fn).not.toHaveBeenCalled();
  });

  it('never puts the API key into an error', async () => {
    stubFetch(new Error(`connect failed with Bearer ${API_KEY}`));
    const result = await paddleRequest(LIVE, '/x');
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(result.error?.detail).toContain('[redacted]');
  });
});

// --- Readers ----------------------------------------------------------------

describe('readSubscription', () => {
  it('reads Paddle’s example subscription', () => {
    expect(readSubscription(SPEC_SUBSCRIPTION)).toEqual({
      id: 'sub_01hv8y5ehszzq0yv20ttx3166y',
      status: 'active',
      customerId: 'ctm_01hv8wt8nffez4p2t6typn4a5j',
      currency: 'USD',
      nextBilledAt: '2024-05-12T10:37:59.556Z',
      currentPeriodStart: '2024-04-12T10:37:59.556Z',
      currentPeriodEnd: '2024-05-12T10:37:59.556Z',
      scheduledChange: null,
      items: [
        { priceId: 'pri_01gsz8x8sawmvhz1pv30nge1ke', amountMinor: 3000, currency: 'USD', interval: 'month', frequency: 1, customData: {} },
        { priceId: 'pri_01h1vjfevh5etwq3rb416a23h2', amountMinor: 10000, currency: 'USD', interval: 'month', frequency: 1, customData: {} },
      ],
      customData: {},
      canceledAt: null,
    });
  });

  it('reads our recurring item, its custom_data and a scheduled cancel; also from a whole answer', () => {
    const expected = {
      id: SUB,
      nextBilledAt: '2026-11-08T10:00:00.000Z',
      scheduledChange: { action: 'cancel', effectiveAt: '2026-11-08T10:00:00.000Z' },
      items: [{
        priceId: 'pri_01jcardrecurring0000000000', amountMinor: 2900, currency: 'USD', interval: 'year', frequency: 1,
        customData: { plan_id: 'plan-pro', interval: 'yearly', net_minor: 2900, tax_minor: 0 },
      }],
      customData: { workspace_id: 'ws-1', card_id: 'card-1' },
    };
    expect(readSubscription(CARD_SUBSCRIPTION)).toMatchObject(expected);
    expect(readSubscription({ data: CARD_SUBSCRIPTION, meta: { request_id: 'r' } })).toMatchObject(expected);
  });

  it('reads a canceled one (Paddle’s cancel answer: no next billing, no period)', () => {
    const canceled = {
      ...SPEC_SUBSCRIPTION, status: 'canceled', next_billed_at: null, current_billing_period: null,
      canceled_at: '2024-04-12T11:24:54.868Z',
    };
    expect(readSubscription(canceled)).toMatchObject({
      status: 'canceled', nextBilledAt: null, currentPeriodStart: null, currentPeriodEnd: null, canceledAt: '2024-04-12T11:24:54.868Z',
    });
  });

  it.each([[null], [undefined], ['sub_1'], [[]], [{}], [{ status: 'active' }]])('no subscription in %j', (value) => {
    expect(readSubscription(value)).toBeNull();
  });
});

describe('readTransaction / readCardDetails', () => {
  it('a renewal that failed 3-D Secure (Paddle’s example): origin, subscription, totals, card, error', () => {
    expect(readTransaction(SPEC_TRANSACTIONS[0])).toEqual({
      id: 'txn_01hv8xbtmb6zc7c264ycteehth',
      status: 'past_due',
      origin: 'subscription_recurring',
      subscriptionId: SUB,
      customerId: 'ctm_01hv8wt8nffez4p2t6typn4a5j',
      currency: 'USD',
      totalMinor: 43549,
      grandTotalMinor: 43549,
      creditMinor: 0,
      itemCustomData: [{}],
      customData: {},
      card: { brand: 'visa', last4: '3184', expMonth: 1, expYear: 2025 },
      errorCode: 'authentication_failed',
      createdAt: '2024-04-12T10:24:01.588Z',
      billedAt: '2024-04-12T10:24:01.163Z',
    });
  });

  it('a paid checkout after a decline: the newest attempt’s card, no error', () => {
    expect(readTransaction(SPEC_TRANSACTIONS[1])).toMatchObject({
      origin: 'web', status: 'completed', totalMinor: 65215, card: { brand: 'visa', last4: '3184' }, errorCode: null,
    });
    // Order is Paddle’s (newest first), and re-checked by date.
    const reversed = { ...SPEC_TRANSACTIONS[1], payments: [...SPEC_TRANSACTIONS[1].payments].reverse() };
    expect(readCardDetails(reversed)).toEqual({ brand: 'visa', last4: '3184', expMonth: 1, expYear: 2025 });
    expect(readTransaction(reversed)?.errorCode).toBeNull();
  });

  it('our renewal: item custom_data in order ({} for none) and the copied custom_data', () => {
    expect(readTransaction(RENEWAL)).toMatchObject({
      origin: 'subscription_recurring',
      subscriptionId: SUB,
      grandTotalMinor: 2900,
      creditMinor: 0,
      itemCustomData: [{ plan_id: 'plan-pro', interval: 'monthly', net_minor: 2900, tax_minor: 0 }, {}],
      customData: { workspace_id: 'ws-1', intent_id: 'pay-setup-1', card_setup: '1' },
      card: { brand: 'visa', last4: '5556', expMonth: 6, expYear: 2026 },
    });
  });

  it('no card before any attempt, or for another method', () => {
    expect(readCardDetails(SPEC_UPDATE_PAYMENT_METHOD_TXN)).toBeNull();
    expect(readCardDetails({ id: 'txn_1', payments: [{ status: 'captured', method_details: { type: 'paypal', card: null, paypal: { email: 'a@b.c' } } }] })).toBeNull();
    expect(readTransaction(SPEC_UPDATE_PAYMENT_METHOD_TXN)).toMatchObject({ origin: 'subscription_payment_method_change', grandTotalMinor: 0, card: null, errorCode: null });
    expect(readTransaction({ status: 'paid' })).toBeNull();
  });
});

describe('readCardEvent', () => {
  it('a transaction event: the transaction, its subscription and id', () => {
    const event = { event_id: 'evt_1', event_type: 'transaction.past_due', occurred_at: '2024-04-12T10:24:03.642083Z', data: SPEC_TRANSACTIONS[0] };
    expect(readCardEvent(event)).toMatchObject({
      eventType: 'transaction.past_due', entity: 'transaction', occurredAt: '2024-04-12T10:24:03.642Z',
      subscriptionId: SUB, customerId: 'ctm_01hv8wt8nffez4p2t6typn4a5j', transactionId: 'txn_01hv8xbtmb6zc7c264ycteehth',
      subscription: null, transaction: { errorCode: 'authentication_failed' }, customData: {},
    });
  });

  it('subscription.created: the subscription and the checkout transaction that created it', () => {
    const event = {
      event_id: 'evt_2', event_type: 'subscription.created', occurred_at: '2024-04-12T13:16:10.444253Z',
      data: { ...CARD_SUBSCRIPTION, transaction_id: 'txn_01hv975mbh902hcyb7mks5kt0n' },
    };
    expect(readCardEvent(event)).toMatchObject({
      entity: 'subscription', subscriptionId: SUB, transactionId: 'txn_01hv975mbh902hcyb7mks5kt0n', transaction: null,
      subscription: { id: SUB, status: 'active' }, customData: { workspace_id: 'ws-1', card_id: 'card-1' },
    });
  });
});

// --- Subscription calls --------------------------------------------------------

describe('subscription calls', () => {
  it('getSubscription: GET /subscriptions/{id}', async () => {
    const { calls } = stubFetch({ status: 200, body: { data: CARD_SUBSCRIPTION } });
    const result = await getSubscription(LIVE, SUB);
    expect(calls[0]).toMatchObject({ url: `https://api.paddle.com/subscriptions/${SUB}`, method: 'GET', body: undefined });
    expect(result.ok).toBe(true);
    expect(result.subscription?.id).toBe(SUB);
  });

  it('getSubscription: an error answers no subscription', async () => {
    stubFetch({ status: 404, body: { error: { code: 'entity_not_found', detail: 'Unable to find subscription' } } });
    expect(await getSubscription(LIVE, 'sub_x')).toMatchObject({ ok: false, error: { code: 'entity_not_found' }, subscription: null });
  });

  it('an empty id is never sent (it would address the list)', async () => {
    const { fn } = stubFetch({ status: 200, body: { data: [] } });
    expect(await getSubscription(LIVE, ' ')).toMatchObject({ ok: false, error: { code: 'invalid_request' }, subscription: null });
    expect(await cancelSubscriptionAt(LIVE, '', 'immediately')).toMatchObject({ ok: false });
    expect(await createCharge(LIVE, '', [buildChargeItem({ name: 'x', description: 'xx', amountMinor: 100, currency: 'USD', customData: {} })])).toMatchObject({ ok: false, unknownOutcome: false });
    expect(fn).not.toHaveBeenCalled();
  });

  const recurring = buildRecurringItem({
    name: 'Pro (monthly)', description: 'Pro plan, monthly', amountMinor: 2900, currency: 'USD', interval: 'monthly',
    customData: { plan_id: 'plan-pro', interval: 'monthly', net_minor: 2900, tax_minor: 0 },
  });
  const patch: SubscriptionPatch = {
    items: [recurring],
    next_billed_at: '2026-11-07T10:00:00.000Z',
    custom_data: { workspace_id: 'ws-1', card_id: 'card-1' },
    proration_billing_mode: 'do_not_bill',
  };

  it('previewSubscriptionUpdate: PATCH …/preview with the patch; no immediate transaction → billsNow false', async () => {
    const preview = { ...CARD_SUBSCRIPTION, id: undefined, immediate_transaction: null, next_transaction: null, update_summary: null };
    const { calls } = stubFetch({ status: 200, body: { data: preview } });
    const result = await previewSubscriptionUpdate(LIVE, SUB, patch);
    expect(calls[0].url).toBe(`https://api.paddle.com/subscriptions/${SUB}/preview`);
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].body).toEqual({
      items: [{
        quantity: 1,
        price: {
          description: 'Pro plan, monthly',
          name: 'Pro (monthly)',
          unit_price: { amount: '2900', currency_code: 'USD' },
          tax_mode: 'internal',
          product: { name: 'Pro (monthly)', tax_category: 'standard' },
          custom_data: { plan_id: 'plan-pro', interval: 'monthly', net_minor: 2900, tax_minor: 0 },
          billing_cycle: { interval: 'month', frequency: 1 },
        },
      }],
      next_billed_at: '2026-11-07T10:00:00.000Z',
      custom_data: { workspace_id: 'ws-1', card_id: 'card-1' },
      proration_billing_mode: 'do_not_bill',
    });
    expect(result.billsNow).toBe(false);
    // A preview has no id of its own: the requested one is used.
    expect(result.subscription).toMatchObject({ id: SUB, nextBilledAt: '2026-11-08T10:00:00.000Z' });
  });

  it.each([
    ['an immediate transaction', { immediate_transaction: SPEC_CHARGE_PREVIEW.immediate_transaction, update_summary: null }],
    ['a prorated charge in the summary', { immediate_transaction: null, update_summary: SPEC_CHARGE_PREVIEW.update_summary }],
    ['a prorated credit in the summary', {
      immediate_transaction: null,
      update_summary: { credit: { amount: '500', currency_code: 'USD' }, charge: { amount: '0', currency_code: 'USD' }, result: { action: 'credit', amount: '500', currency_code: 'USD' } },
    }],
  ])('previewSubscriptionUpdate: %s → billsNow', async (_label, fields) => {
    stubFetch({ status: 200, body: { data: { ...CARD_SUBSCRIPTION, ...fields } } });
    expect((await previewSubscriptionUpdate(LIVE, SUB, patch)).billsNow).toBe(true);
  });

  it('previewSubscriptionUpdate: a failed preview counts as billing', async () => {
    stubFetch({ status: 409, body: { error: { code: 'subscription_locked_renewal', detail: 'locked' } } });
    expect(await previewSubscriptionUpdate(LIVE, SUB, patch)).toMatchObject({ ok: false, billsNow: true, subscription: null });
  });

  it('updateSubscription: PATCH /subscriptions/{id} with exactly the patch', async () => {
    const { calls } = stubFetch({ status: 200, body: { data: CARD_SUBSCRIPTION } });
    const result = await updateSubscription(LIVE, SUB, { next_billed_at: '2026-11-07T10:00:00.000Z', proration_billing_mode: 'do_not_bill' });
    expect(calls[0]).toMatchObject({
      url: `https://api.paddle.com/subscriptions/${SUB}`,
      method: 'PATCH',
      body: { next_billed_at: '2026-11-07T10:00:00.000Z', proration_billing_mode: 'do_not_bill' },
    });
    expect(result.subscription?.id).toBe(SUB);
  });

  it('updateSubscription: custom_data alone needs no billing mode', async () => {
    const { calls } = stubFetch({ status: 200, body: { data: CARD_SUBSCRIPTION } });
    await updateSubscription(LIVE, SUB, { custom_data: { workspace_id: 'ws-1', card_id: 'card-1' } });
    expect(calls[0].body).toEqual({ custom_data: { workspace_id: 'ws-1', card_id: 'card-1' } });
  });

  it.each([
    ['items without a billing mode', { items: [recurring] }],
    ['next_billed_at without a billing mode', { next_billed_at: '2026-11-07T10:00:00.000Z' }],
    ['items billed in full now', { items: [recurring], proration_billing_mode: 'full_immediately' }],
    ['a prorated date change', { next_billed_at: '2026-11-07T10:00:00.000Z', proration_billing_mode: 'prorated_immediately' }],
    ['any other billing mode', { custom_data: {}, proration_billing_mode: 'prorated_next_billing_period' }],
    ['a field we never change', { currency_code: 'EUR', proration_billing_mode: 'do_not_bill' }],
    ['a scheduled change other than null', { scheduled_change: { action: 'cancel' } }],
    ['a date that is not one', { next_billed_at: 'next month', proration_billing_mode: 'do_not_bill' }],
  ])('refuses %s: throws before calling Paddle (update and preview)', async (_label, bad) => {
    const { fn } = stubFetch({ status: 200, body: { data: CARD_SUBSCRIPTION } });
    await expect(updateSubscription(LIVE, SUB, bad as unknown as SubscriptionPatch)).rejects.toThrow(/Paddle subscription update refused/);
    await expect(previewSubscriptionUpdate(LIVE, SUB, bad as unknown as SubscriptionPatch)).rejects.toThrow(/Paddle subscription update refused/);
    expect(fn).not.toHaveBeenCalled();
  });

  it.each([['immediately'], ['next_billing_period']] as const)('cancelSubscriptionAt %s: POST …/cancel', async (effectiveFrom) => {
    const answer = { ...SPEC_SUBSCRIPTION, id: SUB, status: 'canceled', next_billed_at: null, canceled_at: '2024-04-12T11:24:54.868Z' };
    const { calls } = stubFetch({ status: 200, body: { data: answer } });
    const result = await cancelSubscriptionAt(LIVE, SUB, effectiveFrom);
    expect(calls[0]).toMatchObject({ url: `https://api.paddle.com/subscriptions/${SUB}/cancel`, method: 'POST', body: { effective_from: effectiveFrom } });
    expect(result.subscription).toMatchObject({ status: 'canceled', canceledAt: '2024-04-12T11:24:54.868Z' });
  });

  it('cancelSubscriptionAt: refuses an effective_from Paddle does not know', async () => {
    const { fn } = stubFetch({ status: 200, body: { data: CARD_SUBSCRIPTION } });
    await expect(cancelSubscriptionAt(LIVE, SUB, 'later' as 'immediately')).rejects.toThrow(/unknown effective_from/);
    expect(fn).not.toHaveBeenCalled();
  });

  it('clearScheduledChange: PATCH scheduled_change null', async () => {
    const { calls } = stubFetch({ status: 200, body: { data: { ...CARD_SUBSCRIPTION, scheduled_change: null } } });
    const result = await clearScheduledChange(LIVE, SUB);
    expect(calls[0]).toMatchObject({ url: `https://api.paddle.com/subscriptions/${SUB}`, method: 'PATCH', body: { scheduled_change: null } });
    expect(result.subscription?.scheduledChange).toBeNull();
  });
});

// --- Items and charges -------------------------------------------------------------

describe('items', () => {
  it('buildChargeItem: a one-time, tax-inclusive price for exactly the amount, with our custom_data', () => {
    expect(buildChargeItem({
      name: 'Upgrade to Business', description: 'Upgrade Pro → Business (difference)', amountMinor: 2000, currency: 'usd',
      customData: { payment_id: 'pay-1', workspace_id: 'ws-1' },
    })).toEqual({
      quantity: 1,
      price: {
        description: 'Upgrade Pro → Business (difference)',
        name: 'Upgrade to Business',
        unit_price: { amount: '2000', currency_code: 'USD' },
        tax_mode: 'internal',
        product: { name: 'Upgrade to Business', tax_category: 'standard' },
        custom_data: { payment_id: 'pay-1', workspace_id: 'ws-1' },
      },
    });
  });

  it('attaches the catalog product when one is configured', () => {
    const item = buildChargeItem({ name: 'x', description: 'xy', amountMinor: 100, currency: 'USD', productId: ' pro_01abc ', customData: {} });
    expect(item.price.product_id).toBe('pro_01abc');
    expect(item.price.product).toBeUndefined();
  });

  it('keeps Paddle’s length limits (charge name 50, recurring name 150) and a description of at least 2 characters', () => {
    const long = 'N'.repeat(300);
    const charge = buildChargeItem({ name: long, description: '', amountMinor: 100, currency: 'USD', customData: {} });
    expect(charge.price.name).toHaveLength(50);
    expect(charge.price.description).toHaveLength(50);
    expect((charge.price.product as { name: string }).name).toHaveLength(200);
    const yearly = buildRecurringItem({ name: long, description: 'D'.repeat(900), amountMinor: 29000, currency: 'USD', interval: 'yearly', customData: {} });
    expect(yearly.price.name).toHaveLength(150);
    expect(yearly.price.description).toHaveLength(500);
    expect(yearly.price.billing_cycle).toEqual({ interval: 'year', frequency: 1 });
  });

  it.each([[0], [-5], [12.5], [Number.NaN]])('refuses amount %s', (amountMinor) => {
    expect(() => buildChargeItem({ name: 'x', description: 'xy', amountMinor, currency: 'USD', customData: {} })).toThrow(/positive amount/);
  });

  it('refuses a currency Paddle cannot charge, and a recurring item without monthly/yearly', () => {
    expect(() => buildChargeItem({ name: 'x', description: 'xy', amountMinor: 100, currency: 'IRR', customData: {} })).toThrow(/Paddle cannot charge IRR/);
    expect(() => buildRecurringItem({ name: 'x', description: 'xy', amountMinor: 100, currency: 'USD', interval: 'weekly' as 'monthly', customData: {} }))
      .toThrow(/monthly or yearly/);
  });
});

describe('one-time charges', () => {
  const item = buildChargeItem({ name: 'Upgrade', description: 'Upgrade difference', amountMinor: 2000, currency: 'USD', customData: { payment_id: 'pay-1', workspace_id: 'ws-1' } });
  const body = { effective_from: 'immediately', on_payment_failure: 'prevent_change', items: [item] };

  it('previewCharge: POST …/charge/preview with the charge’s own body; totals of the immediate transaction', async () => {
    const { calls } = stubFetch({ status: 200, body: { data: SPEC_CHARGE_PREVIEW } });
    const result = await previewCharge(LIVE, SUB, [item]);
    expect(calls[0]).toMatchObject({ url: `https://api.paddle.com/subscriptions/${SUB}/charge/preview`, method: 'POST', body });
    expect(result).toMatchObject({ ok: true, grandTotalMinor: 21666, creditMinor: 0 });
  });

  it('previewCharge: no totals when the preview failed', async () => {
    stubFetch({ status: 400, body: { error: { code: 'subscription_update_when_past_due', detail: 'past due' } } });
    expect(await previewCharge(LIVE, SUB, [item])).toMatchObject({ ok: false, grandTotalMinor: null, creditMinor: null });
  });

  it('createCharge: POST …/charge, immediately, prevent_change', async () => {
    const { calls } = stubFetch({ status: 201, body: { data: CARD_SUBSCRIPTION } });
    expect(await createCharge(LIVE, SUB, [item])).toMatchObject({ ok: true, status: 201, unknownOutcome: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: `https://api.paddle.com/subscriptions/${SUB}/charge`, method: 'POST', body });
  });

  it('createCharge: a decline is definitive (nothing charged, nothing changed)', async () => {
    stubFetch({ status: 400, body: { error: { type: 'request_error', code: 'subscription_payment_declined', detail: 'Payment was declined' } } });
    expect(await createCharge(LIVE, SUB, [item])).toMatchObject({ ok: false, status: 400, error: { code: 'subscription_payment_declined' }, unknownOutcome: false });
  });

  it('createCharge: a timeout is an unknown outcome, and the call is not repeated', async () => {
    vi.useFakeTimers();
    const { calls } = stubFetch('hang');
    const pending = createCharge(LIVE, SUB, [item]);
    await vi.advanceTimersByTimeAsync(PADDLE_REQUEST_TIMEOUT_MS);
    expect(await pending).toMatchObject({ ok: false, error: { code: 'timeout' }, unknownOutcome: true });
    expect(calls).toHaveLength(1);
  });

  it('a charge needs items', async () => {
    const { fn } = stubFetch({ status: 201, body: { data: {} } });
    await expect(createCharge(LIVE, SUB, [])).rejects.toThrow(/at least one item/);
    expect(fn).not.toHaveBeenCalled();
  });
});

// --- Transactions -----------------------------------------------------------------

describe('transactions', () => {
  it('listSubscriptionTransactions: newest first, 30 a page, filtered again to that subscription', async () => {
    const { calls } = stubFetch({ status: 200, body: { data: SPEC_TRANSACTIONS, meta: { pagination: { per_page: 30 } } } });
    const result = await listSubscriptionTransactions(LIVE, SUB);
    expect(calls[0]).toMatchObject({
      url: `https://api.paddle.com/transactions?subscription_id=${SUB}&per_page=30&order_by=created_at[DESC]`,
      method: 'GET',
    });
    expect(result.transactions.map((t) => [t.id, t.origin])).toEqual([
      ['txn_01hv8xbtmb6zc7c264ycteehth', 'subscription_recurring'],
      ['txn_01hv8wptq8987qeep44cyrewp9', 'web'],
    ]);
  });

  it.each([[5, 5], [100, 30], [0, 1]])('per_page %s → %s', async (perPage, sent) => {
    const { calls } = stubFetch({ status: 200, body: { data: [] } });
    await listSubscriptionTransactions(LIVE, SUB, { perPage });
    expect(calls[0].url).toContain(`&per_page=${sent}&`);
  });

  it('listSubscriptionTransactions: an error lists nothing', async () => {
    stubFetch(new TypeError('fetch failed'));
    expect(await listSubscriptionTransactions(LIVE, SUB)).toMatchObject({ ok: false, transactions: [] });
  });

  it('getTransaction: GET /transactions/{id}', async () => {
    const { calls } = stubFetch({ status: 200, body: { data: RENEWAL } });
    const result = await getTransaction(LIVE, RENEWAL.id);
    expect(calls[0]).toMatchObject({ url: `https://api.paddle.com/transactions/${RENEWAL.id}`, method: 'GET' });
    expect(result.transaction).toMatchObject({ id: RENEWAL.id, subscriptionId: SUB });
  });

  it('getUpdatePaymentMethodTransaction: the transaction to open in Paddle.js', async () => {
    const { calls } = stubFetch({ status: 200, body: { data: SPEC_UPDATE_PAYMENT_METHOD_TXN } });
    const result = await getUpdatePaymentMethodTransaction(LIVE, 'sub_01jspbbyjtkycfmjf7ye85yvp2');
    expect(calls[0]).toMatchObject({
      url: 'https://api.paddle.com/subscriptions/sub_01jspbbyjtkycfmjf7ye85yvp2/update-payment-method-transaction',
      method: 'GET',
    });
    expect(result.transactionId).toBe('txn_01jspbekkwn03q6zp8bezp3tv2');
  });
});

// --- Gateway config --------------------------------------------------------------------

describe('gateway config', () => {
  it('paddleConfigFor: the sandbox is forced for paddle_sandbox, whatever was stored', async () => {
    const config = paddleConfigFor('paddle_sandbox', { ...SANDBOX, sandbox: 'false' });
    expect(config.sandbox).toBe(true);
    const { calls } = stubFetch({ status: 200, body: { data: CARD_SUBSCRIPTION } });
    await getSubscription(config, SUB);
    expect(calls[0].url).toBe(`https://sandbox-api.paddle.com/subscriptions/${SUB}`);
  });

  it('paddleConfigFor: live credentials are refused for paddle_sandbox', () => {
    expect(() => paddleConfigFor('paddle_sandbox', { ...SANDBOX, api_key: API_KEY })).toThrow(/not a sandbox key/);
    expect(() => paddleConfigFor('paddle_sandbox', { ...SANDBOX, client_token: 'live_x' })).toThrow(/not a sandbox token/);
  });

  it('paddleConfigFor: live paddle as is; anything else is not a Paddle gateway', () => {
    expect(paddleConfigFor('paddle', LIVE)).toBe(LIVE);
    expect(() => paddleConfigFor('stripe', LIVE)).toThrow(/not a Paddle gateway/);
  });

  it.each([
    [undefined, false], ['false', false], ['', false], [false, false], ['true', true], [true, true], ['on', true], [1, true],
  ])('cardAutoRenewEnabled(card_auto_renew = %j) → %s', (value, expected) => {
    expect(cardAutoRenewEnabled({ ...LIVE, card_auto_renew: value })).toBe(expected);
  });

  it('cardAutoRenewEnabled: no config, no card renewal', () => {
    expect(cardAutoRenewEnabled(null)).toBe(false);
    expect(cardAutoRenewEnabled(undefined)).toBe(false);
  });

  it('clientCheckoutFor: the shape createCheckoutSession returns', () => {
    expect(clientCheckoutFor('paddle', LIVE, 'txn_1', 'https://app.test/billing?card=updated', 'a@b.test')).toEqual({
      provider: 'paddle', transactionId: 'txn_1', clientToken: 'live_mock_client_token', environment: 'production',
      successUrl: 'https://app.test/billing?card=updated', customerEmail: 'a@b.test',
    });
    expect(clientCheckoutFor('paddle_sandbox', SANDBOX, 'txn_2', 'https://app.test/billing')).toEqual({
      provider: 'paddle_sandbox', transactionId: 'txn_2', clientToken: 'test_mock_client_token', environment: 'sandbox',
      successUrl: 'https://app.test/billing',
    });
  });

  it('clientCheckoutFor: refuses a missing token or live credentials on the sandbox', () => {
    expect(() => clientCheckoutFor('paddle', { ...LIVE, client_token: '' }, 'txn_1', 'https://app.test')).toThrow(/client-side token is not configured/);
    expect(() => clientCheckoutFor('paddle_sandbox', { ...SANDBOX, client_token: 'live_x' }, 'txn_1', 'https://app.test')).toThrow(/not a sandbox token/);
  });
});
