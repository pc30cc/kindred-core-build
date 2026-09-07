import { describe, it, expect } from 'vitest';
import {
  internalTestProvider,
  signOutcome,
  verifyCheckoutSignature,
} from '../../../server/services/billing/providers/internal-test.js';

// `config.gateway_base_url` is the canonical PUBLIC API origin, populated by
// resolveNamedBillingConfig/resolveBillingConfig from platform_domains
// (see server/services/billing/index.ts). It is deliberately a DIFFERENT
// host than the browser callback URL in these tests — that is the real,
// supported split-deployment topology (APP_ORIGIN !== API_ORIGIN), and the
// provider must build its own page from the API origin, never the callback.
const API_ORIGIN = 'https://api.example.com';
const config = { provider: 'internal_test', currency: 'IRR', gateway_base_url: API_ORIGIN };
const CALLBACK = 'https://app.example.com/ws/billing?intent=abc&provider=internal_test';

async function checkout(amount: string) {
  return internalTestProvider.createCheckoutSession(config, {
    workspaceId: 'ws-1',
    planId: 'pro',
    interval: 'monthly',
    currency: 'IRR',
    callbackUrl: CALLBACK,
    metadata: { amount },
  });
}

describe('internal test gateway provider', () => {
  it('builds a signed gateway URL on the canonical API origin, not the browser callback origin', async () => {
    const result = await checkout('1500000');
    const url = new URL(result.paymentUrl);
    expect(url.origin).toBe(API_ORIGIN);
    expect(url.origin).not.toBe('https://app.example.com');
    expect(url.pathname).toBe('/api/billing/test-gateway');
    expect(result.providerRef).toMatch(/^TESTGW-[0-9A-F]{20}$/);
    expect(url.searchParams.get('ref')).toBe(result.providerRef);
    // The callback the bank/simulator uses to return the browser stays the
    // app-origin URL — it is carried as a signed query param, not the page host.
    expect(url.searchParams.get('cb')).toBe(CALLBACK);
    expect(
      verifyCheckoutSignature(
        url.searchParams.get('ref')!,
        url.searchParams.get('amount')!,
        url.searchParams.get('cb')!,
        url.searchParams.get('sig')!,
      ),
    ).toBe(true);
  });

  it('refuses to build a checkout session with no canonical API origin configured', async () => {
    await expect(
      internalTestProvider.createCheckoutSession(
        { provider: 'internal_test', currency: 'IRR' },
        {
          workspaceId: 'ws-1',
          planId: 'pro',
          interval: 'monthly',
          currency: 'IRR',
          callbackUrl: CALLBACK,
          metadata: { amount: '1500000' },
        },
      ),
    ).rejects.toThrow(/API origin/);
  });

  it('rejects a zero amount', async () => {
    await expect(checkout('0')).rejects.toThrow();
  });

  it('keeps the canonical IRR amount even when an old gateway config says IRT', async () => {
    const result = await internalTestProvider.createCheckoutSession(
      { provider: 'internal_test', currency: 'IRT', gateway_base_url: API_ORIGIN },
      {
        workspaceId: 'ws-1',
        planId: 'pro',
        interval: 'monthly',
        currency: 'IRR',
        callbackUrl: CALLBACK,
        metadata: { amount: '1500000' },
      },
    );
    expect(new URL(result.paymentUrl).searchParams.get('amount')).toBe('1500000');
  });

  it('verifies only a correctly signed success outcome', async () => {
    const ref = 'TESTGW-ABC';
    await expect(
      internalTestProvider.verifyPayment!(config, {
        authority: ref, status: 'OK', rsig: signOutcome(ref, 'OK'), amount: '1500000',
      }),
    ).resolves.toMatchObject({ verified: true, providerRef: ref });

    await expect(
      internalTestProvider.verifyPayment!(config, {
        authority: ref, status: 'OK', rsig: 'forged', amount: '1500000',
      }),
    ).resolves.toMatchObject({ verified: false });

    await expect(
      internalTestProvider.verifyPayment!(config, {
        authority: ref, status: 'NOK', rsig: signOutcome(ref, 'NOK'), amount: '1500000',
      }),
    ).resolves.toMatchObject({ verified: false, status: 'canceled' });
  });
});
