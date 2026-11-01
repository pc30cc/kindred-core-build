/**
 * Apirone (server/services/billing/providers/apirone.ts): USDT on TRON,
 * charged in US dollars, the Iranian edition only (owner, 2026-11-01,
 * temporary, for Apple's App Review).
 *
 *   - the invoice is the USD amount plus the gateway's fee, rounded UP to a
 *     whole micro-USDT, in usdt@trx, for an hour, with our webhook as its
 *     callback-url and the return URL as its linkback;
 *   - a lookup reads the PUBLIC invoice info of the stored invoice and maps
 *     what arrived (each transaction once) back to cents in the proportion
 *     of the invoice: a full payment is exactly the payment's amount, less
 *     or more is reported as it came (receivedFinal);
 *   - completed (or a `completed` entry in the history) and expired-with-
 *     money are final; created / paid / partpaid / overpaid are set at 0
 *     confirmations and wait (overpaying never skips the confirmation);
 *     a transaction listed after the last `completed` entry is not counted;
 *     expired with nothing is expired;
 *   - the callback is unsigned: another account is refused before anything
 *     is fetched, and everything else (status, payment id) comes from the
 *     invoice looked up, never from the callback; it is acknowledged `*ok*`;
 *   - the International edition never lists, resolves or charges it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apironeAccountId,
  apironeFeePercent,
  apironeInvoiceAmount,
  apironePaymentIdFromLinkback,
  apironeProvider,
  apironeReceived,
  apironeReceivedMinor,
  apironeSettingsProblem,
} from '../../../server/services/billing/providers/apirone';
import { getAllProviders, getProvider } from '../../../server/services/billing/index';
import { canChargeAccount, gatewayListing, gatewayNeedsConfig, gatewaySettingsProblem } from '../../../server/services/billing/account/gateways';
import { getProviderReferenceContract } from '../../../server/services/billing/providerBinding';
import {
  IRANIAN_PAYMENT_PROVIDERS,
  isIranianPaymentProvider,
  isIranOnlyPaymentProvider,
  isProviderAllowedInEdition,
} from '../../../shared/edition';
import type { BillingProviderConfig, CheckoutRequest } from '../../../server/services/billing/types';

const ACCOUNT = 'apr-0123456789abcdef0123456789abcdef';
const OTHER_ACCOUNT = 'apr-ffffffffffffffffffffffffffffffff';
const PAYMENT_ID = '33333333-3333-4333-8333-333333333333';
const RETURN_URL = `https://app.webyar.ai/acme/billing?payment=${PAYMENT_ID}&provider=apirone`;
const config: BillingProviderConfig = { provider: 'apirone', account: ACCOUNT, fee_percent: '1' };

const req: CheckoutRequest = {
  workspaceId: 'ws-1',
  planId: 'account',
  interval: 'monthly',
  currency: 'USD',
  callbackUrl: RETURN_URL,
  webhookUrl: 'https://api.webyar.ai/api/billing/webhook/apirone',
  intentId: PAYMENT_ID,
  description: 'Plan',
  metadata: { amount: '2900' },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stubFetch(...answers: Response[]) {
  const fetchMock = vi.fn();
  for (const a of answers) fetchMock.mockResolvedValueOnce(a);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The public invoice info, as GET /v2/invoices/{invoice} answers it. */
function invoice(over: Record<string, unknown> = {}) {
  return {
    invoice: 'inv0001',
    created: '2026-11-01T10:00:00.000000',
    currency: 'usdt@trx',
    address: 'TXYZ',
    expire: '2026-11-01T11:00:00.000000',
    amount: 29_290_000,
    'user-data': { title: 'Plan', price: '$29.29' },
    status: 'completed',
    history: [
      { date: '2026-11-01T10:00:00', status: 'created' },
      { date: '2026-11-01T10:05:00', status: 'paid', txid: 'tx-1', amount: 29_290_000 },
      { date: '2026-11-01T10:06:00', status: 'completed' },
    ],
    linkback: RETURN_URL,
    'invoice-url': 'https://apirone.com/invoice?id=inv0001',
    ...over,
  };
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('the invoice amount: the USD amount plus the fee, rounded up to micro-USDT', () => {
  it('$29 at 1% is 29.29 USDT', () => {
    expect(apironeInvoiceAmount(2900, 1)).toBe(29_290_000n);
    expect(apironeInvoiceAmount(29_000, 1)).toBe(292_900_000n);
  });

  it('no fee is the amount itself; a fraction of a micro-USDT is rounded up, never down', () => {
    expect(apironeInvoiceAmount(500, 0)).toBe(5_000_000n);
    // 1 cent = 10 000 micro; × 1.012345 = 10 123.45 → 10 124.
    expect(apironeInvoiceAmount(1, 1.2345)).toBe(10_124n);
    // 3 cents × 1.0001 = 30 003 exactly.
    expect(apironeInvoiceAmount(3, 0.01)).toBe(30_003n);
  });

  it('refuses an amount that is not a positive whole number of cents', () => {
    expect(() => apironeInvoiceAmount(0, 1)).toThrow();
    expect(() => apironeInvoiceAmount(12.5, 1)).toThrow();
  });
});

describe('settings', () => {
  it('the account id is apr- and 32 hex characters; the fee is 0..10 (blank: 1)', () => {
    expect(apironeSettingsProblem({ provider: 'apirone' })).toBe('Apirone: Account ID is empty.');
    expect(apironeSettingsProblem({ provider: 'apirone', account: 'apr-123' })).toMatch(/32 hexadecimal/);
    expect(apironeSettingsProblem({ provider: 'apirone', account: ACCOUNT })).toBeNull();
    expect(apironeSettingsProblem({ provider: 'apirone', account: ACCOUNT, fee_percent: '11' })).toMatch(/Fee percent/);
    expect(apironeSettingsProblem({ provider: 'apirone', account: ACCOUNT, fee_percent: '-1' })).toMatch(/Fee percent/);
    expect(apironeSettingsProblem({ provider: 'apirone', account: ACCOUNT, fee_percent: 'abc' })).toMatch(/Fee percent/);
    expect(apironeFeePercent({})).toBe(1);
    expect(apironeFeePercent({ fee_percent: '0' })).toBe(0);
    expect(apironeFeePercent({ fee_percent: 2.5 })).toBe(2.5);
    // The id is read case-insensitively, also from `account_id`.
    expect(apironeAccountId({ account_id: ACCOUNT.toUpperCase().replace('APR', 'apr') })).toBe(ACCOUNT);
  });

  it('validateConfig refuses a malformed id on save; empty settings may be saved', () => {
    expect(apironeProvider.validateConfig!({ provider: 'apirone' })).toBeNull();
    expect(apironeProvider.validateConfig!({ provider: 'apirone', account: 'apr-x' })).toMatch(/Account ID/);
    expect(apironeProvider.validateConfig!(config)).toBeNull();
  });

  it('the account gateway check names the missing account id', () => {
    expect(gatewayNeedsConfig('apirone')).toBe(true);
    expect(gatewaySettingsProblem('apirone', { provider: 'apirone' })).toMatch(/empty\.$/);
    expect(gatewaySettingsProblem('apirone', config)).toBeNull();
  });
});

describe('createCheckoutSession', () => {
  it('creates a usdt@trx invoice for the amount plus the fee, with our callback and linkback', async () => {
    const fetchMock = stubFetch(json({ ...invoice({ status: 'created', history: [] }), account: ACCOUNT, 'callback-url': req.webhookUrl }));
    const out = await apironeProvider.createCheckoutSession(config, req);
    expect(out).toEqual({ paymentUrl: 'https://apirone.com/invoice?id=inv0001', providerRef: 'inv0001', sessionId: 'inv0001' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://apirone.com/api/v2/accounts/${ACCOUNT}/invoices`);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      currency: 'usdt@trx',
      amount: '29290000',
      lifetime: 3600,
      'callback-url': 'https://api.webyar.ai/api/billing/webhook/apirone',
      linkback: RETURN_URL,
    });
    expect(body['user-data']).toMatchObject({
      title: 'Plan',
      price: '$29.29',
      'sub-price': '$29.00',
      items: [{ name: 'Plan', cost: '$29.00', qty: 1, total: '$29.00' }],
      extras: [{ name: 'Payment fee (1%)', price: '$0.29' }],
    });
    // Nothing secret is sent: the account id is in the path, no key anywhere.
    expect(JSON.stringify(init)).not.toMatch(/transfer-key/);
  });

  it('charges USD only, and needs the public webhook address and valid settings', async () => {
    const fetchMock = stubFetch();
    await expect(apironeProvider.createCheckoutSession(config, { ...req, currency: 'IRR' })).rejects.toThrow(/cannot charge IRR/);
    await expect(apironeProvider.createCheckoutSession(config, { ...req, webhookUrl: undefined })).rejects.toThrow(/public API address/);
    await expect(apironeProvider.createCheckoutSession({ provider: 'apirone' }, req)).rejects.toThrow(/Account ID is empty/);
    await expect(apironeProvider.createCheckoutSession(config, { ...req, metadata: { amount: '0' } })).rejects.toThrow(/invalid amount/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an answer for another amount, or without the invoice page, is refused', async () => {
    stubFetch(json(invoice({ amount: 1_000_000, status: 'created' })));
    await expect(apironeProvider.createCheckoutSession(config, req)).rejects.toThrow(/not the 29290000/);
    stubFetch(json(invoice({ 'invoice-url': '', status: 'created' })));
    await expect(apironeProvider.createCheckoutSession(config, req)).rejects.toThrow(/invoice-url/);
  });

  it('Apirone\'s refusal is reported with its message and the HTTP status', async () => {
    stubFetch(json({ message: 'Invalid account' }, 400));
    await expect(apironeProvider.createCheckoutSession(config, req)).rejects.toThrow('Apirone error: create invoice: Invalid account (HTTP 400)');
  });
});

describe('what arrived: each transaction once, mapped back to cents', () => {
  it('sums the history\'s amounts over unique transaction ids', () => {
    expect(apironeReceived([
      { status: 'partpaid', txid: 'a', amount: 190_000 },
      { status: 'paid', txid: 'b', amount: '365000' },
      { status: 'completed', txid: 'b', amount: 365_000 },
      { status: 'created' },
      { status: 'paid', amount: 5 },
    ])).toBe(555_000n);
    expect(apironeReceived(null)).toBe(0n);
  });

  it('a full payment is exactly the payment amount; less and more in proportion, rounded down', () => {
    expect(apironeReceivedMinor(29_290_000n, 2900, 29_290_000n)).toBe(2900);
    expect(apironeReceivedMinor(14_645_000n, 2900, 29_290_000n)).toBe(1450);
    expect(apironeReceivedMinor(50_000_000n, 2900, 29_290_000n)).toBe(4950);
    expect(apironeReceivedMinor(1n, 2900, 29_290_000n)).toBe(0);
  });
});

describe('verifyPayment: the stored invoice, looked up publicly', () => {
  const params = { invoice: 'inv0001', amount: '2900' };

  it('completed in full: verified for exactly the payment amount, in USD, keyed by the invoice', async () => {
    const fetchMock = stubFetch(json(invoice()));
    const out = await apironeProvider.verifyPayment!(config, params);
    expect(out).toEqual({
      verified: true,
      providerRef: 'inv0001',
      paymentId: 'inv0001',
      amount: 2900,
      currency: 'USD',
      status: 'success',
      receivedFinal: true,
    });
    expect(fetchMock.mock.calls[0][0]).toBe('https://apirone.com/api/v2/invoices/inv0001');
    expect(String(fetchMock.mock.calls[0][0])).not.toMatch(/transfer-key/);
  });

  it('overpaid: pending until completed (it is set at 0 confirmations, like paid)', async () => {
    stubFetch(json(invoice({ status: 'overpaid', history: [{ status: 'overpaid', txid: 'tx-1', amount: 50_000_000 }] })));
    expect(await apironeProvider.verifyPayment!(config, params)).toEqual({ verified: false, providerRef: 'inv0001', status: 'pending' });
  });

  it('overpaid, then completed: verified for what arrived (more than the payment)', async () => {
    stubFetch(json(invoice({
      status: 'completed',
      history: [
        { status: 'created' },
        { status: 'overpaid', txid: 'tx-1', amount: 50_000_000 },
        { status: 'completed' },
      ],
    })));
    expect(await apironeProvider.verifyPayment!(config, params)).toMatchObject({ verified: true, amount: 4950, receivedFinal: true });
  });

  it('a transaction after the completion is not counted: only the confirmed ones are credited', async () => {
    stubFetch(json(invoice({
      status: 'overpaid',
      history: [
        { status: 'paid', txid: 'tx-1', amount: 29_290_000 },
        { status: 'completed' },
        { status: 'overpaid', txid: 'tx-2', amount: 10_000_000 },
      ],
    })));
    expect(await apironeProvider.verifyPayment!(config, params)).toMatchObject({ verified: true, amount: 2900, receivedFinal: true });
  });

  it('expired after a part payment: verified for the part that arrived', async () => {
    stubFetch(json(invoice({ status: 'expired', history: [{ status: 'partpaid', txid: 'tx-1', amount: 14_645_000 }] })));
    expect(await apironeProvider.verifyPayment!(config, params)).toMatchObject({ verified: true, amount: 1450, receivedFinal: true });
  });

  it('expired with nothing: expired, not verified', async () => {
    stubFetch(json(invoice({ status: 'expired', history: [{ status: 'created' }] })));
    expect(await apironeProvider.verifyPayment!(config, params)).toEqual({ verified: false, providerRef: 'inv0001', status: 'expired' });
  });

  it.each(['created', 'paid', 'partpaid', 'overpaid'])('%s: pending, nothing credited yet', async (status) => {
    stubFetch(json(invoice({ status, history: [{ status: 'created' }, { status, txid: 'tx-1', amount: 29_290_000 }] })));
    expect(await apironeProvider.verifyPayment!(config, params)).toEqual({ verified: false, providerRef: 'inv0001', status: 'pending' });
  });

  it('an answer about another invoice or another coin is refused', async () => {
    stubFetch(json(invoice({ invoice: 'other' })));
    await expect(apironeProvider.verifyPayment!(config, params)).rejects.toThrow(/another invoice/);
    stubFetch(json(invoice({ currency: 'btc' })));
    await expect(apironeProvider.verifyPayment!(config, params)).rejects.toThrow(/not usdt@trx/);
  });
});

describe('verifyWebhook: an unsigned nudge, read from the invoice itself', () => {
  const callback = (over: Record<string, unknown> = {}) => JSON.stringify({ account: ACCOUNT, invoice: 'inv0001', status: 'completed', ...over });

  it('another account is refused before anything is fetched', async () => {
    const fetchMock = stubFetch();
    await expect(apironeProvider.verifyWebhook(config, {}, callback({ account: OTHER_ACCOUNT }))).rejects.toThrow(/another account/);
    await expect(apironeProvider.verifyWebhook({ provider: 'apirone' }, {}, callback())).rejects.toThrow(/not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a final invoice: payment_succeeded for the payment its OWN linkback names, no amount', async () => {
    stubFetch(json(invoice()));
    const event = await apironeProvider.verifyWebhook(config, {}, callback());
    expect(event).toMatchObject({
      type: 'payment_succeeded',
      providerEventId: 'inv0001:completed',
      providerRef: 'inv0001',
      providerPaymentId: 'inv0001',
      intentId: PAYMENT_ID,
      currency: 'USD',
    });
    expect(event).not.toHaveProperty('amount');
  });

  it('the callback\'s own status is never trusted: the fetched one decides', async () => {
    stubFetch(json(invoice({ status: 'paid', history: [{ status: 'paid', txid: 'tx-1', amount: 29_290_000 }] })));
    const event = await apironeProvider.verifyWebhook(config, {}, callback({ status: 'completed' }));
    expect(event).toMatchObject({ type: 'ignored', providerEventId: 'inv0001:paid' });
  });

  it('the payment id comes from the fetched linkback, never from the callback', async () => {
    const other = '44444444-4444-4444-8444-444444444444';
    stubFetch(json(invoice({ linkback: `https://app.webyar.ai/x/billing?payment=${other}&provider=apirone` })));
    const event = await apironeProvider.verifyWebhook(config, {}, JSON.stringify({ account: ACCOUNT, invoice: 'inv0001', status: 'completed', payment: PAYMENT_ID }));
    expect(event?.intentId).toBe(other);
    expect(apironePaymentIdFromLinkback('not a url')).toBeUndefined();
  });

  it('overpaid is not final: ignored until completed', async () => {
    stubFetch(json(invoice({ status: 'overpaid', history: [{ status: 'overpaid', txid: 't', amount: 30_000_000 }] })));
    expect(await apironeProvider.verifyWebhook(config, {}, callback({ status: 'overpaid' }))).toMatchObject({
      type: 'ignored',
      providerEventId: 'inv0001:overpaid',
    });
  });

  it('expired with money is final; expired with nothing is ignored', async () => {
    stubFetch(json(invoice({ status: 'expired', history: [{ status: 'partpaid', txid: 't', amount: 1_000_000 }] })));
    expect((await apironeProvider.verifyWebhook(config, {}, callback()))?.type).toBe('payment_succeeded');
    stubFetch(json(invoice({ status: 'expired', history: [] })));
    expect((await apironeProvider.verifyWebhook(config, {}, callback()))?.type).toBe('ignored');
  });

  it('is acknowledged with `*ok*` and charges USD only', () => {
    expect(apironeProvider.webhookAckBody).toBe('*ok*');
    expect(apironeProvider.supportedCurrencies).toEqual(['USD']);
  });
});

describe('testConnection: the account\'s public info', () => {
  it('succeeds when Apirone answers for this account', async () => {
    const fetchMock = stubFetch(json({ account: ACCOUNT, info: [{ currency: 'usdt@trx' }] }));
    expect(await apironeProvider.testConnection(config)).toMatchObject({ success: true });
    expect(fetchMock.mock.calls[0][0]).toBe(`https://apirone.com/api/v2/accounts/${ACCOUNT}?currency=usdt%40trx`);
  });

  it('fails with the reason otherwise', async () => {
    stubFetch(json({ message: 'Account not found' }, 404));
    expect(await apironeProvider.testConnection(config)).toMatchObject({ success: false, error: expect.stringMatching(/Account not found/) });
    expect(await apironeProvider.testConnection({ provider: 'apirone' })).toMatchObject({ success: false, error: 'Apirone: Account ID is empty.' });
  });
});

describe('the edition gate and the account gateway rules', () => {
  it('Iranian edition only, and not an Iranian (Rial, bank) gateway', () => {
    expect(isProviderAllowedInEdition('apirone', 'iran')).toBe(true);
    expect(isProviderAllowedInEdition('apirone', 'international')).toBe(false);
    expect(isIranOnlyPaymentProvider('apirone')).toBe(true);
    expect(isIranianPaymentProvider('apirone')).toBe(false);
    expect(IRANIAN_PAYMENT_PROVIDERS).not.toContain('apirone' as never);
    expect(Object.keys(getAllProviders('iran'))).toContain('apirone');
    expect(Object.keys(getAllProviders('international'))).not.toContain('apirone');
    expect(getProvider('apirone')).toBe(apironeProvider);
  });

  it('charges a USD account only', () => {
    expect(canChargeAccount('apirone', 'USD')).toBe(true);
    expect(canChargeAccount('apirone', 'IRR')).toBe(false);
    expect(canChargeAccount('apirone', 'TRY')).toBe(false);
  });

  it('is listed for a USD account in Iran with complete settings, never in the International edition', () => {
    const gateway = { provider_name: 'apirone', is_active: true, currencies: [] as string[] };
    expect(gatewayListing(gateway, 'USD', config, 'iran')).toEqual({ listed: true, reasons: [] });
    expect(gatewayListing(gateway, 'IRR', config, 'iran').reasons).toEqual(['currency']);
    expect(gatewayListing(gateway, 'USD', { provider: 'apirone' }, 'iran')).toMatchObject({ listed: false, reasons: ['not_configured'] });
    expect(gatewayListing(gateway, 'USD', config, 'international').reasons).toContain('not_in_edition');
  });

  it('binds the invoice: a return or callback may only name the stored one', () => {
    expect(getProviderReferenceContract('apirone')).toEqual({ requiresPaymentReferenceBinding: true, callbackKeys: ['invoice'] });
  });
});
