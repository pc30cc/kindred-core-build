import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'crypto';
import {
  stripeProvider,
  parseStripeSignatureHeader,
  verifyStripeSignature,
} from '../../../server/services/billing/providers/stripe.js';
import type { BillingProviderConfig } from '../../../server/services/billing/types.js';

const SECRET = 'whsec_MOCK_VALUE';
const config = { provider: 'stripe', webhook_secret: SECRET } as unknown as BillingProviderConfig;

const BODY = JSON.stringify({
  id: 'evt_1',
  type: 'checkout.session.completed',
  data: { object: { id: 'cs_1', customer: 'cus_1', metadata: { workspace_id: 'ws-1' }, amount_total: 1000, currency: 'usd' } },
});

function sign(body: string, ts: number, secret = SECRET) {
  return crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
}
function header(body: string, ts: number, extra: string[] = []) {
  return [`t=${ts}`, `v1=${sign(body, ts)}`, ...extra].join(',');
}
const nowSec = () => Math.floor(Date.now() / 1000);

afterEach(() => vi.useRealTimers());

describe('parseStripeSignatureHeader', () => {
  it('accepts whitespace, unknown fields and multiple v1 in any order', () => {
    const parsed = parseStripeSignatureHeader(' v0=abc , v1=AABB, t=1700000000 , v1=ccdd ');
    expect(parsed).toEqual({ timestamp: 1700000000, signatures: ['aabb', 'ccdd'] });
  });
  it('rejects missing timestamp, malformed timestamp and missing v1', () => {
    expect(parseStripeSignatureHeader('v1=aabb')).toBeNull();
    expect(parseStripeSignatureHeader('t=abc,v1=aabb')).toBeNull();
    expect(parseStripeSignatureHeader('t=0,v1=aabb')).toBeNull();
    expect(parseStripeSignatureHeader('t=1700000000')).toBeNull();
  });
});

describe('verifyStripeSignature', () => {
  it('accepts a valid signature within tolerance', () => {
    const ts = nowSec();
    expect(verifyStripeSignature(SECRET, header(BODY, ts), BODY)).toBe(true);
  });
  it('accepts when one of several v1 signatures matches', () => {
    const ts = nowSec();
    const h = `t=${ts},v1=${'0'.repeat(64)},v1=${sign(BODY, ts)}`;
    expect(verifyStripeSignature(SECRET, h, BODY)).toBe(true);
  });
  it('rejects a wrong signature and a signature of different length', () => {
    const ts = nowSec();
    expect(verifyStripeSignature(SECRET, `t=${ts},v1=${'a'.repeat(64)}`, BODY)).toBe(false);
    expect(verifyStripeSignature(SECRET, `t=${ts},v1=abcd`, BODY)).toBe(false);
  });
  it('rejects a modified body', () => {
    const ts = nowSec();
    expect(verifyStripeSignature(SECRET, header(BODY, ts), BODY + ' ')).toBe(false);
  });
  it('rejects stale and far-future timestamps', () => {
    const old = nowSec() - 600;
    const future = nowSec() + 600;
    expect(verifyStripeSignature(SECRET, header(BODY, old), BODY)).toBe(false);
    expect(verifyStripeSignature(SECRET, header(BODY, future), BODY)).toBe(false);
  });
  it('rejects a signature made with a different secret', () => {
    const ts = nowSec();
    const h = `t=${ts},v1=${sign(BODY, ts, 'other')}`;
    expect(verifyStripeSignature(SECRET, h, BODY)).toBe(false);
  });
});

describe('stripeProvider.verifyWebhook', () => {
  it('returns the mapped event for a valid signature', async () => {
    const ts = nowSec();
    const event = await stripeProvider.verifyWebhook(config, { 'stripe-signature': header(BODY, ts) }, BODY);
    expect(event?.type).toBe('checkout_completed');
    expect(event?.workspaceId).toBe('ws-1');
  });

  it('throws (fail-closed) on an invalid signature and never leaks the secret', async () => {
    const ts = nowSec();
    await expect(
      stripeProvider.verifyWebhook(config, { 'stripe-signature': `t=${ts},v1=${'b'.repeat(64)}` }, BODY),
    ).rejects.toThrow(/Invalid Stripe webhook signature/);
    try {
      await stripeProvider.verifyWebhook(config, { 'stripe-signature': `t=${ts},v1=${'b'.repeat(64)}` }, BODY);
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(SECRET);
    }
  });

  it('returns null when the signature header or secret is missing', async () => {
    await expect(stripeProvider.verifyWebhook(config, {}, BODY)).resolves.toBeNull();
    await expect(
      stripeProvider.verifyWebhook({ provider: 'stripe' } as BillingProviderConfig, { 'stripe-signature': 'x' }, BODY),
    ).resolves.toBeNull();
  });

  it('rejects malformed JSON even when the signature is valid', async () => {
    const bad = '{not json';
    const ts = nowSec();
    await expect(
      stripeProvider.verifyWebhook(config, { 'stripe-signature': header(bad, ts) }, bad),
    ).rejects.toBeInstanceOf(SyntaxError);
  });

  it('rejects replays outside the tolerance window', async () => {
    const ts = nowSec() - 3600;
    await expect(
      stripeProvider.verifyWebhook(config, { 'stripe-signature': header(BODY, ts) }, BODY),
    ).rejects.toThrow(/Invalid Stripe webhook signature/);
  });
});
