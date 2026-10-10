/**
 * Paddle sandbox gateway (`paddle_sandbox`, server/services/billing/providers/paddle-sandbox.ts)
 * and the credential checks it shares with live `paddle`.
 *
 * Forced sandbox: every API call goes to sandbox-api.paddle.com and the
 * browser opens the checkout in Paddle.js' sandbox environment, whatever was
 * stored. Live credentials are refused by the sandbox gateway, sandbox
 * credentials by the live one (unless its own Sandbox Mode is on).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'crypto';
import { paddleSandboxProvider, paddleSandboxOpenToCustomers } from '../../../server/services/billing/providers/paddle-sandbox.js';
import {
  paddleProvider,
  paddleCredentialProblem,
  isPaddleSandboxFlag,
  PADDLE_CURRENCIES,
} from '../../../server/services/billing/providers/paddle.js';
import { getProvider, getAllProviders } from '../../../server/services/billing/index.js';
import { getProviderReferenceContract } from '../../../server/services/billing/providerBinding.js';
import { canCollectInvoice, isCardInvoiceProvider } from '../../../server/services/billing/cardInvoice.js';
import { resolveChargeCurrency } from '../../../server/services/billing/chargeCurrency.js';
import { isProviderAllowedInEdition, isIranianPaymentProvider } from '../../../shared/edition.js';
import { isAlwaysTestGateway, isPaddleProvider, isTestPaymentProvider } from '../../../shared/testGateways.js';
import type { BillingProviderConfig, CheckoutRequest } from '../../../server/services/billing/types.js';

const SANDBOX: BillingProviderConfig = {
  provider: 'paddle_sandbox',
  api_key: 'pdl_sdbx_apikey_mock_not_real',
  client_token: 'test_mock_client_token',
  webhook_secret: 'pdl_ntfset_sandbox_secret',
};

const LIVE: BillingProviderConfig = {
  provider: 'paddle',
  api_key: 'pdl_live_apikey_mock_not_real',
  client_token: 'live_mock_client_token',
  webhook_secret: 'pdl_ntfset_live_secret',
};

const req: CheckoutRequest = {
  workspaceId: 'ws-1',
  planId: 'plan-uuid',
  interval: 'monthly',
  currency: 'USD',
  callbackUrl: 'https://app.test.localhost/pay?intent=pi-1&provider=paddle_sandbox',
  intentId: 'pi-1',
  invoiceId: 'inv-1',
  description: 'Pro (monthly) — invoice AB12345678',
  metadata: { amount: '2900' },
};

function mockFetch(body: unknown) {
  const fn = vi.fn(async () => ({ status: 200, ok: true, json: async () => body, text: async () => JSON.stringify(body) }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

function urlOf(fn: ReturnType<typeof mockFetch>, i = 0): string {
  return (fn.mock.calls[i] as unknown as [string])[0];
}

function signed(secret: string, event: unknown) {
  const body = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const h1 = crypto.createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex');
  return { body, headers: { 'paddle-signature': `ts=${ts};h1=${h1}` } };
}

afterEach(() => vi.unstubAllGlobals());

describe('registry, edition and shared lists', () => {
  it('is a registered provider of its own', () => {
    expect(getProvider('paddle_sandbox')).toBe(paddleSandboxProvider);
    expect(paddleSandboxProvider.name).toBe('paddle_sandbox');
    expect(getProvider('paddle')).toBe(paddleProvider);
  });

  it('is listed in the International edition only — never in the Iranian one', () => {
    expect(Object.keys(getAllProviders('international'))).toEqual(expect.arrayContaining(['paddle', 'paddle_sandbox']));
    expect(Object.keys(getAllProviders('iran'))).not.toContain('paddle_sandbox');
    expect(Object.keys(getAllProviders('iran'))).toContain('paddle');
    expect(isProviderAllowedInEdition('paddle_sandbox', 'international')).toBe(true);
    expect(isProviderAllowedInEdition('paddle_sandbox', 'iran')).toBe(false);
    expect(isProviderAllowedInEdition(' Paddle_Sandbox ', 'iran')).toBe(false);
    expect(isIranianPaymentProvider('paddle_sandbox')).toBe(false);
    // Nothing else changed for the Iranian edition.
    for (const name of ['zarinpal', 'internal_test', 'stripe', 'paddle']) expect(isProviderAllowedInEdition(name, 'iran')).toBe(true);
  });

  it('is a test gateway, always marked as one, and a Paddle (Paddle.js) gateway', () => {
    expect(isTestPaymentProvider('paddle_sandbox')).toBe(true);
    expect(isAlwaysTestGateway('paddle_sandbox')).toBe(true);
    expect(isPaddleProvider('paddle_sandbox')).toBe(true);
    expect(isTestPaymentProvider('paddle')).toBe(false);
    expect(isAlwaysTestGateway('zarinpal_test')).toBe(false);
    for (const name of ['internal_test', 'zarinpal_test', 'idpay_test', 'iranpardakht_sandbox']) expect(isTestPaymentProvider(name)).toBe(true);
  });

  it('binds the return to the stored transaction (`_ptxn`), like live Paddle', () => {
    expect(getProviderReferenceContract('paddle_sandbox')).toEqual(getProviderReferenceContract('paddle'));
    expect(getProviderReferenceContract('paddle_sandbox')).toMatchObject({ requiresPaymentReferenceBinding: true, callbackKeys: ['_ptxn'] });
  });

  it('collects invoices in Paddle’s currencies (card-invoice flow, charge currency)', () => {
    expect(isCardInvoiceProvider('paddle_sandbox')).toBe(true);
    expect(paddleSandboxProvider.supportedCurrencies).toEqual(PADDLE_CURRENCIES);
    for (const code of PADDLE_CURRENCIES) expect(canCollectInvoice('paddle_sandbox', code)).toBe(true);
    expect(canCollectInvoice('paddle_sandbox', 'IRR')).toBe(false);
    expect(resolveChargeCurrency(paddleSandboxProvider, 'eur')).toMatchObject({ currency: 'EUR' });
    expect(paddleSandboxProvider.capabilities).toEqual(paddleProvider.capabilities);
  });
});

describe('paddle_sandbox talks to the sandbox only', () => {
  it('creates the transaction on sandbox-api.paddle.com and opens it in the sandbox environment', async () => {
    const fetchMock = mockFetch({ data: { id: 'txn_sbx' } });
    // A stored `sandbox: 'false'` (or none) changes nothing: the sandbox is forced.
    const result = await paddleSandboxProvider.createCheckoutSession({ ...SANDBOX, sandbox: 'false' }, req);
    expect(urlOf(fetchMock)).toBe('https://sandbox-api.paddle.com/transactions');
    const init = (fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1];
    expect(init.headers.Authorization).toBe(`Bearer ${SANDBOX.api_key}`);
    expect(result.sessionId).toBe('txn_sbx');
    expect(result.clientCheckout).toMatchObject({
      provider: 'paddle_sandbox',
      environment: 'sandbox',
      transactionId: 'txn_sbx',
      clientToken: SANDBOX.client_token,
      successUrl: 'https://app.test.localhost/pay?intent=pi-1&provider=paddle_sandbox&_ptxn=txn_sbx',
    });
  });

  it('verifies, closes and tests against the sandbox', async () => {
    let fetchMock = mockFetch({ data: { id: 'txn_1', status: 'completed', currency_code: 'USD', details: { totals: { total: '2900' } } } });
    expect(await paddleSandboxProvider.verifyPayment!(SANDBOX, { _ptxn: 'txn_1' })).toMatchObject({ verified: true, status: 'paid', amount: 2900, currency: 'USD' });
    expect(urlOf(fetchMock)).toBe('https://sandbox-api.paddle.com/transactions/txn_1');

    fetchMock = mockFetch({ data: { id: 'txn_old', status: 'canceled' } });
    expect(await paddleSandboxProvider.closeCheckout!(SANDBOX, 'txn_old')).toBe(true);
    expect(urlOf(fetchMock)).toBe('https://sandbox-api.paddle.com/transactions/txn_old');

    fetchMock = mockFetch({ data: [] });
    expect(await paddleSandboxProvider.testConnection(SANDBOX)).toMatchObject({ success: true });
    expect(urlOf(fetchMock)).toBe('https://sandbox-api.paddle.com/event-types');
  });

  it('refuses a live API key or client-side token before calling Paddle, with an admin-facing reason', async () => {
    const fetchMock = mockFetch({ data: { id: 'never' } });
    await expect(paddleSandboxProvider.createCheckoutSession({ ...SANDBOX, api_key: LIVE.api_key }, req)).rejects.toThrow(/not a sandbox key.*_sdbx.*sandbox-vendors\.paddle\.com/);
    await expect(paddleSandboxProvider.createCheckoutSession({ ...SANDBOX, client_token: LIVE.client_token }, req)).rejects.toThrow(/not a sandbox token.*test_/);
    expect(await paddleSandboxProvider.testConnection({ ...SANDBOX, api_key: 'legacy0123456789abcdef' })).toMatchObject({
      success: false,
      error: expect.stringContaining('_sdbx'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validateConfig: sandbox shapes pass, live shapes are refused, empty values are left to the checkout', () => {
    expect(paddleSandboxProvider.validateConfig!(SANDBOX)).toBeNull();
    expect(paddleSandboxProvider.validateConfig!({ provider: 'paddle_sandbox' })).toBeNull();
    expect(paddleSandboxProvider.validateConfig!({ ...SANDBOX, api_key: LIVE.api_key })).toMatch(/_sdbx/);
    expect(paddleSandboxProvider.validateConfig!({ ...SANDBOX, client_token: LIVE.client_token })).toMatch(/test_/);
  });

  it('is admin-only until "Open to customers" is switched on', () => {
    expect(paddleSandboxOpenToCustomers(SANDBOX)).toBe(false);
    expect(paddleSandboxOpenToCustomers({ ...SANDBOX, open_to_customers: 'false' })).toBe(false);
    expect(paddleSandboxOpenToCustomers({ ...SANDBOX, open_to_customers: 'true' })).toBe(true);
    expect(paddleSandboxOpenToCustomers({ ...SANDBOX, open_to_customers: true })).toBe(true);
  });
});

describe('paddle_sandbox webhook: its own secret', () => {
  const transaction = {
    id: 'txn_1',
    status: 'completed',
    currency_code: 'USD',
    custom_data: { workspace_id: 'ws-1', intent_id: 'pi-1', invoice_id: 'inv-1' },
    details: { totals: { total: '2900' } },
  };

  it('verifies a notification signed with the sandbox secret and maps it like Paddle', async () => {
    const { body, headers } = signed(SANDBOX.webhook_secret as string, { event_id: 'evt_sbx', event_type: 'transaction.paid', data: transaction });
    expect(await paddleSandboxProvider.verifyWebhook(SANDBOX, headers, body)).toMatchObject({
      type: 'payment_succeeded',
      providerEventId: 'evt_sbx',
      intentId: 'pi-1',
      providerPaymentId: 'txn_1',
      amount: 2900,
      currency: 'USD',
    });
  });

  it('refuses a notification signed with another secret (the live account’s)', async () => {
    const { body, headers } = signed(LIVE.webhook_secret as string, { event_id: 'evt_live', event_type: 'transaction.paid', data: transaction });
    await expect(paddleSandboxProvider.verifyWebhook(SANDBOX, headers, body)).rejects.toThrow(/Invalid Paddle webhook signature/);
    // …and the live gateway refuses the sandbox's.
    const sandboxSigned = signed(SANDBOX.webhook_secret as string, { event_id: 'evt_sbx', event_type: 'transaction.paid', data: transaction });
    await expect(paddleProvider.verifyWebhook(LIVE, sandboxSigned.headers, sandboxSigned.body)).rejects.toThrow(/Invalid Paddle webhook signature/);
  });

  it('counts an approved refund once per adjustment', async () => {
    const { body, headers } = signed(SANDBOX.webhook_secret as string, {
      event_id: 'evt_adj',
      event_type: 'adjustment.updated',
      data: { id: 'adj_1', action: 'refund', status: 'approved', transaction_id: 'txn_1', currency_code: 'USD', totals: { total: '2900' } },
    });
    expect(await paddleSandboxProvider.verifyWebhook(SANDBOX, headers, body)).toMatchObject({
      type: 'refund_processed',
      providerEventId: 'adjustment_adj_1_approved',
      refundId: 'adj_1',
      providerPaymentId: 'txn_1',
      amount: 2900,
    });
  });
});

describe('live paddle: sandbox credentials only with its Sandbox Mode on', () => {
  it('reads the stored toggle strings correctly (a saved "false" is off)', () => {
    expect(isPaddleSandboxFlag('false')).toBe(false);
    expect(isPaddleSandboxFlag('')).toBe(false);
    expect(isPaddleSandboxFlag(undefined)).toBe(false);
    expect(isPaddleSandboxFlag('true')).toBe(true);
    expect(isPaddleSandboxFlag(true)).toBe(true);
  });

  it('a stored sandbox "false" goes to the live API', async () => {
    const fetchMock = mockFetch({ data: { id: 'txn_live' } });
    const result = await paddleProvider.createCheckoutSession({ ...LIVE, sandbox: 'false' }, { ...req, callbackUrl: 'https://app.test.localhost/pay' });
    expect(urlOf(fetchMock)).toBe('https://api.paddle.com/transactions');
    expect(result.clientCheckout).toMatchObject({ provider: 'paddle', environment: 'production' });
  });

  it('refuses `_sdbx` / `test_` credentials while Sandbox Mode is off', async () => {
    const fetchMock = mockFetch({ data: { id: 'never' } });
    expect(paddleCredentialProblem({ ...LIVE, api_key: SANDBOX.api_key }, 'paddle')).toMatch(/sandbox API key.*Paddle — Sandbox \(test\)/);
    expect(paddleCredentialProblem({ ...LIVE, client_token: SANDBOX.client_token, sandbox: 'false' }, 'paddle')).toMatch(/sandbox client-side token/);
    await expect(paddleProvider.createCheckoutSession({ ...LIVE, api_key: SANDBOX.api_key }, req)).rejects.toThrow(/sandbox API key/);
    expect(await paddleProvider.testConnection({ ...LIVE, client_token: SANDBOX.client_token })).toMatchObject({ success: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts them with Sandbox Mode on, and live (or pre-prefix) credentials with it off', () => {
    expect(paddleProvider.validateConfig!({ ...SANDBOX, provider: 'paddle', sandbox: 'true' })).toBeNull();
    expect(paddleProvider.validateConfig!(LIVE)).toBeNull();
    expect(paddleProvider.validateConfig!({ ...LIVE, api_key: '0123456789abcdef0123456789abcdef' })).toBeNull();
  });
});
