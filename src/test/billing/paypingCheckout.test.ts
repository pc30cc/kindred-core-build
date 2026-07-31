import { describe, it, expect, vi, afterEach } from 'vitest';
import { paypingProvider } from '../../../server/services/billing/providers/payping.js';
import type { BillingProviderConfig, CheckoutRequest } from '../../../server/services/billing/types.js';

const config: BillingProviderConfig = { provider: 'payping', bearer_token: 'mock-token-not-real' };

const req: CheckoutRequest = {
  workspaceId: 'ws-1',
  planId: 'plan-pro',
  interval: 'monthly',
  currency: 'IRR',
  callbackUrl: 'https://app.test.localhost/callback',
  customerEmail: 'buyer@test.localhost',
  customerName: 'Test Buyer',
  metadata: { amount: '250000' },
};

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => ({
    status,
    ok: status === 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('payping createCheckoutSession', () => {
  it('returns payment url and session id on a valid success response', async () => {
    const fetchMock = mockFetch(200, { code: 'pay-code-123' });
    const result = await paypingProvider.createCheckoutSession(config, req);

    expect(result.paymentUrl).toBe('https://api.payping.ir/v2/pay/gotoipg/pay-code-123');
    expect(result.sessionId).toBe('pay-code-123');

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    const payload = JSON.parse(init.body);
    // amount contract unchanged: 250000 rial metadata -> 25000 toman sent to PayPing
    expect(payload).toEqual({
      amount: 25000,
      returnUrl: 'https://app.test.localhost/callback',
      payerIdentity: 'buyer@test.localhost',
      payerName: 'Test Buyer',
      description: 'Plan plan-pro',
      clientRefId: 'ws-1_plan-pro',
    });
  });

  it('throws with the provider error text on a non-200 response', async () => {
    mockFetch(400, { error: 'invalid amount' });
    await expect(paypingProvider.createCheckoutSession(config, req)).rejects.toThrow(/PayPing error/);
  });

  it.each([
    ['missing code', {}],
    ['wrong code type', { code: 12345 }],
    ['empty code', { code: '' }],
    ['null body', null],
  ])('rejects malformed success response: %s', async (_label, body) => {
    mockFetch(200, body);
    await expect(paypingProvider.createCheckoutSession(config, req)).rejects.toThrow(
      'PayPing error: malformed response (missing payment code)',
    );
  });

  it('does not leak the bearer token in the thrown error', async () => {
    mockFetch(200, { code: 42 });
    await expect(paypingProvider.createCheckoutSession(config, req)).rejects.toSatisfy(
      (e: Error) => !e.message.includes('mock-token-not-real'),
    );
  });
});
