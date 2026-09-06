import { describe, it, expect } from 'vitest';
import {
  internalTestProvider,
  signOutcome,
  verifyCheckoutSignature,
} from '../../../server/services/billing/providers/internal-test.js';

const config = { provider: 'internal_test', currency: 'IRR' };
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
  it('builds a signed, self-hosted gateway URL', async () => {
    const result = await checkout('1500000');
    const url = new URL(result.paymentUrl);
    expect(url.origin).toBe('https://app.example.com');
    expect(url.pathname).toBe('/api/billing/test-gateway');
    expect(result.providerRef).toMatch(/^TESTGW-[0-9A-F]{20}$/);
    expect(url.searchParams.get('ref')).toBe(result.providerRef);
    expect(
      verifyCheckoutSignature(
        url.searchParams.get('ref')!,
        url.searchParams.get('amount')!,
        url.searchParams.get('cb')!,
        url.searchParams.get('sig')!,
      ),
    ).toBe(true);
  });

  it('rejects a zero amount', async () => {
    await expect(checkout('0')).rejects.toThrow();
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
