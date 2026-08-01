import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { parsePaddleSignatureHeader, verifyPaddleSignature, paddleProvider } from '../../../server/services/billing/providers/paddle.js';
import { verifyLemonSqueezySignature, timingSafeHexEqual, lemonSqueezyProvider } from '../../../server/services/billing/providers/lemonsqueezy.js';
import { timingSafeBase64Equal, paytrProvider } from '../../../server/services/billing/providers/paytr.js';

const SECRET = 'whsec_test_secret';
const BODY = '{"event_type":"transaction.completed","event_id":"evt_1","data":{"id":"txn_1","custom_data":{"workspace_id":"ws_1"}}}';

function paddleHeader(secret: string, body: string, ts: number) {
  const h1 = crypto.createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex');
  return `ts=${ts};h1=${h1}`;
}

describe('paddle signature header parsing', () => {
  it('parses a well-formed header', () => {
    expect(parsePaddleSignatureHeader('ts=1700000000;h1=abcdef')).toEqual({ timestamp: 1700000000, signatures: ['abcdef'] });
  });
  it('tolerates whitespace, ordering and unknown fields', () => {
    expect(parsePaddleSignatureHeader(' h1=ABCD ; x=1 ; ts=42 ')).toEqual({ timestamp: 42, signatures: ['abcd'] });
  });
  it('supports multiple h1 values during secret rotation', () => {
    expect(parsePaddleSignatureHeader('ts=42;h1=aa;h1=bb')?.signatures).toEqual(['aa', 'bb']);
  });
  it.each(['', 'garbage', 'h1=abcd', 'ts=42', 'ts=notanumber;h1=abcd', 'ts=42;h1=zz', 'ts=1;ts=2;h1=aa'])(
    'rejects malformed header %j',
    (h) => expect(parsePaddleSignatureHeader(h)).toBeNull(),
  );
});

describe('paddle signature verification', () => {
  const now = 1_700_000_000_000;
  const ts = Math.floor(now / 1000);

  it('accepts a valid, fresh signature', () => {
    expect(verifyPaddleSignature(SECRET, paddleHeader(SECRET, BODY, ts), BODY, now)).toBe(true);
  });
  it('rejects a signature made with a different secret', () => {
    expect(verifyPaddleSignature(SECRET, paddleHeader('other', BODY, ts), BODY, now)).toBe(false);
  });
  it('rejects a tampered body', () => {
    expect(verifyPaddleSignature(SECRET, paddleHeader(SECRET, BODY, ts), BODY + ' ', now)).toBe(false);
  });
  it('rejects a mismatched timestamp (signature bound to ts)', () => {
    const header = paddleHeader(SECRET, BODY, ts).replace(`ts=${ts}`, `ts=${ts - 1}`);
    expect(verifyPaddleSignature(SECRET, header, BODY, now)).toBe(false);
  });
  it('rejects a replay older than the tolerance window', () => {
    const old = ts - 301;
    expect(verifyPaddleSignature(SECRET, paddleHeader(SECRET, BODY, old), BODY, now)).toBe(false);
  });
  it('accepts the edge of the tolerance window', () => {
    const edge = ts - 300;
    expect(verifyPaddleSignature(SECRET, paddleHeader(SECRET, BODY, edge), BODY, now)).toBe(true);
  });
  it('rejects a far-future timestamp', () => {
    expect(verifyPaddleSignature(SECRET, paddleHeader(SECRET, BODY, ts + 301), BODY, now)).toBe(false);
  });
  it('accepts when one of several rotated signatures matches', () => {
    const good = crypto.createHmac('sha256', SECRET).update(`${ts}:${BODY}`).digest('hex');
    expect(verifyPaddleSignature(SECRET, `ts=${ts};h1=${'0'.repeat(good.length)};h1=${good}`, BODY, now)).toBe(true);
  });
});

describe('paddle verifyWebhook', () => {
  const ts = Math.floor(Date.now() / 1000);

  it('returns null when no signature or secret is present', async () => {
    await expect(paddleProvider.verifyWebhook({ provider: 'paddle', webhook_secret: SECRET }, {}, BODY)).resolves.toBeNull();
    await expect(paddleProvider.verifyWebhook({ provider: 'paddle' }, { 'paddle-signature': 'ts=1;h1=aa' }, BODY)).resolves.toBeNull();
  });
  it('throws on an invalid signature', async () => {
    await expect(
      paddleProvider.verifyWebhook({ provider: 'paddle', webhook_secret: SECRET }, { 'paddle-signature': `ts=${ts};h1=aabb` }, BODY),
    ).rejects.toThrow(/Invalid Paddle webhook signature/);
  });
  it('maps a verified event without altering the payload mapping', async () => {
    const event = await paddleProvider.verifyWebhook(
      { provider: 'paddle', webhook_secret: SECRET },
      { 'paddle-signature': paddleHeader(SECRET, BODY, ts) },
      BODY,
    );
    expect(event).toMatchObject({ type: 'checkout_completed', providerEventId: 'evt_1', workspaceId: 'ws_1' });
  });
});

describe('lemon squeezy signature verification', () => {
  const sign = (secret: string, body: string) => crypto.createHmac('sha256', secret).update(body).digest('hex');

  it('accepts a valid signature', () => {
    expect(verifyLemonSqueezySignature(SECRET, sign(SECRET, BODY), BODY)).toBe(true);
  });
  it('is case-insensitive on hex', () => {
    expect(verifyLemonSqueezySignature(SECRET, sign(SECRET, BODY).toUpperCase(), BODY)).toBe(true);
  });
  it.each([
    ['wrong secret', sign('nope', BODY)],
    ['truncated', sign(SECRET, BODY).slice(0, 32)],
    ['non-hex', 'zzzz'],
    ['empty', ''],
  ])('rejects %s', (_label, sig) => {
    expect(verifyLemonSqueezySignature(SECRET, sig, BODY)).toBe(false);
  });
  it('rejects a tampered body', () => {
    expect(verifyLemonSqueezySignature(SECRET, sign(SECRET, BODY), `${BODY} `)).toBe(false);
  });
  it('rejects when the secret is missing', () => {
    expect(verifyLemonSqueezySignature('', sign(SECRET, BODY), BODY)).toBe(false);
  });
  it('hex comparison rejects unequal lengths without throwing', () => {
    expect(timingSafeHexEqual('aabb', 'aa')).toBe(false);
    expect(timingSafeHexEqual('aabb', 'aabb')).toBe(true);
  });
  it('verifyWebhook returns null without a secret and throws on mismatch', async () => {
    await expect(lemonSqueezyProvider.verifyWebhook({ provider: 'lemon_squeezy' }, { 'x-signature': 'aa' }, BODY)).resolves.toBeNull();
    await expect(
      lemonSqueezyProvider.verifyWebhook({ provider: 'lemon_squeezy', webhook_secret: SECRET }, { 'x-signature': 'aabb' }, BODY),
    ).rejects.toThrow(/Invalid Lemon Squeezy webhook signature/);
  });
});

describe('paytr callback hash verification', () => {
  const key = 'merchant_key';
  const salt = 'merchant_salt';
  const config = { provider: 'paytr', merchant_key: key, merchant_salt: salt };
  const oid = 'ws1_1700000000';

  function callback(status: string, amount: string, hashOverride?: string) {
    const hash = hashOverride ?? crypto.createHmac('sha256', key).update(`${oid}${salt}${status}${amount}`).digest('base64');
    return new URLSearchParams({ merchant_oid: oid, status, total_amount: amount, hash }).toString();
  }

  it('accepts a valid callback and preserves mapping', async () => {
    const event = await paytrProvider.verifyWebhook(config, {}, callback('success', '1000'));
    expect(event).toMatchObject({ type: 'payment_succeeded', providerPaymentId: oid, amount: 1000, currency: 'TRY' });
  });
  it('maps failures without throwing', async () => {
    const event = await paytrProvider.verifyWebhook(config, {}, callback('failed', '1000'));
    expect(event?.type).toBe('payment_failed');
  });
  it('rejects a tampered amount', async () => {
    const body = callback('success', '1000').replace('total_amount=1000', 'total_amount=1');
    await expect(paytrProvider.verifyWebhook(config, {}, body)).rejects.toThrow(/Invalid PayTR webhook hash/);
  });
  it('rejects a tampered status', async () => {
    const body = callback('failed', '1000').replace('status=failed', 'status=success');
    await expect(paytrProvider.verifyWebhook(config, {}, body)).rejects.toThrow(/Invalid PayTR webhook hash/);
  });
  it.each(['', 'not-base64!!', 'YWJj'])('rejects malformed hash %j', async (h) => {
    await expect(paytrProvider.verifyWebhook(config, {}, callback('success', '1000', h))).rejects.toThrow(/Invalid PayTR webhook hash/);
  });
  it('fails closed when credentials, hash or order id are missing', async () => {
    await expect(paytrProvider.verifyWebhook({ provider: 'paytr' }, {}, callback('success', '1000'))).resolves.toBeNull();
    const noHash = new URLSearchParams({ merchant_oid: oid, status: 'success', total_amount: '1000' }).toString();
    await expect(paytrProvider.verifyWebhook(config, {}, noHash)).resolves.toBeNull();
    await expect(paytrProvider.verifyWebhook(config, {}, 'status=success&total_amount=1&hash=YWJj')).resolves.toBeNull();
  });
  it('base64 comparison rejects unequal lengths without throwing', () => {
    expect(timingSafeBase64Equal('YWJj', 'YQ==')).toBe(false);
    expect(timingSafeBase64Equal('YWJj', 'YWJj')).toBe(true);
  });
});
