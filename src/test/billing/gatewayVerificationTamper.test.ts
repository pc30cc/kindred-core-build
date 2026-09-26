/**
 * GATEWAY VERIFICATION — tamper resistance for the Iranian one-time gateways.
 *
 *   - the callback reference must be the stored one on EVERY declared key;
 *   - verify is called with the stored reference + server amount only;
 *   - the gateway-confirmed amount must equal the intent amount (fail closed
 *     when missing);
 *   - "already verified" (101 / 201 / SEP 2) only for the intent that itself
 *     already verified, never for a new intent;
 *   - Iranian checkout pricing is IRR only, never a client-chosen currency.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildBoundVerifyParams,
  buildGatewayVerificationMarker,
  evaluateGatewayVerification,
  expectedIntentAmountIrr,
  providerRefMatchesIntent,
  resolveIrrPlanPrice,
} from '../../../server/services/billing/gatewayVerification';
import { zarinpalProvider } from '../../../server/services/billing/providers/zarinpal';
import { sepProvider } from '../../../server/services/billing/providers/sep';

type TestIntent = {
  provider_name: string;
  provider_ref: string | null;
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'expired' | 'canceled';
  amount_irr: number;
  expected_amount_irr?: number | string | null;
  metadata: Record<string, unknown>;
};

function intent(overrides: Partial<TestIntent> = {}): TestIntent {
  return {
    provider_name: 'zarinpal',
    provider_ref: 'A_STORED',
    status: 'pending',
    amount_irr: 1_500_000,
    metadata: {},
    ...overrides,
  };
}

function verifiedIntent(overrides: Partial<TestIntent> = {}, ref = 'REF_1', amount = 1_500_000): TestIntent {
  return intent({
    status: 'processing',
    metadata: { gateway_verification: buildGatewayVerificationMarker(ref, amount, new Date('2026-01-01T00:00:00Z')) },
    ...overrides,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reference binding — mismatched keys', () => {
  it('rejects a callback whose spelling variants carry different references', () => {
    // Previously "any key matched" passed, while verify read `Authority` (= B).
    expect(providerRefMatchesIntent(intent(), { Authority: 'B_OTHER', authority: 'A_STORED' }))
      .toEqual({ ok: false, reason: 'provider_reference_mismatch' });
    expect(providerRefMatchesIntent(intent({ provider_name: 'zibal', provider_ref: '111' }), { trackId: '111', track_id: '222' }))
      .toEqual({ ok: false, reason: 'provider_reference_mismatch' });
  });

  it('accepts the stored reference on every present key', () => {
    expect(providerRefMatchesIntent(intent(), { Authority: 'A_STORED', authority: 'A_STORED', Status: 'OK' }))
      .toEqual({ ok: true });
  });

  it('IDPay binds on `id` only — its distinct `track_id` does not break a legit callback', () => {
    const idpay = intent({ provider_name: 'idpay', provider_ref: 'pay-1' });
    expect(providerRefMatchesIntent(idpay, { id: 'pay-1', track_id: '998877', order_id: 'o' })).toEqual({ ok: true });
    expect(providerRefMatchesIntent(idpay, { id: 'pay-2', track_id: 'pay-1' }))
      .toEqual({ ok: false, reason: 'provider_reference_mismatch' });
  });

  it('SEP binds the Token; PayPing binds the code', () => {
    expect(providerRefMatchesIntent(intent({ provider_name: 'sep_shaparak', provider_ref: 'TOK' }), { Token: 'TOK', RefNum: 'R1' }))
      .toEqual({ ok: true });
    expect(providerRefMatchesIntent(intent({ provider_name: 'sep_shaparak', provider_ref: 'TOK' }), { Token: 'OTHER', RefNum: 'R1' }))
      .toEqual({ ok: false, reason: 'provider_reference_mismatch' });
    expect(providerRefMatchesIntent(intent({ provider_name: 'payping', provider_ref: 'C1' }), { code: 'C2', refid: 'R' }))
      .toEqual({ ok: false, reason: 'provider_reference_mismatch' });
  });
});

describe('verify params are bound to the stored reference and server amount', () => {
  it('overwrites every reference key and the amount, whatever the callback said', () => {
    const out = buildBoundVerifyParams(intent(), { Authority: 'B_OTHER', authority: 'C', amount: '1', Status: 'OK' }, 1_500_000);
    expect(out).toMatchObject({ Authority: 'A_STORED', authority: 'A_STORED', amount: '1500000', Status: 'OK' });
  });

  it('drops non-scalar callback values', () => {
    const out = buildBoundVerifyParams(intent(), { Authority: 'A_STORED', nested: { a: 1 }, n: 5 }, 10);
    expect(out).toEqual({ Authority: 'A_STORED', authority: 'A_STORED', n: '5', amount: '10' });
  });

  it('ZarinPal verify is sent for the stored authority, not the tampered callback one', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      text: async () => JSON.stringify({ data: { code: 100, ref_id: 5555 } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const params = buildBoundVerifyParams(intent(), { Authority: 'B_OTHER' }, 1_500_000);
    await zarinpalProvider.verifyPayment!({ provider: 'zarinpal', merchant_id: 'm' }, params);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.authority).toBe('A_STORED');
    expect(body.amount).toBe(1_500_000);
  });
});

describe('gateway-confirmed amount', () => {
  it('accepts the exact expected amount', () => {
    expect(evaluateGatewayVerification(intent(), { verified: true, providerRef: 'R', amount: 1_500_000, status: 'success' }))
      .toEqual({ ok: true, confirmedAmountIrr: 1_500_000, alreadyVerified: false });
  });

  it('rejects a wrong amount', () => {
    expect(evaluateGatewayVerification(intent(), { verified: true, providerRef: 'R', amount: 1_000, status: 'success' }))
      .toEqual({ ok: false, reason: 'gateway_amount_mismatch' });
  });

  it('fails closed when the gateway returns no amount', () => {
    expect(evaluateGatewayVerification(intent(), { verified: true, providerRef: 'R', status: 'success' }))
      .toEqual({ ok: false, reason: 'gateway_amount_missing' });
  });

  it('V2 intents are checked against expected_amount_irr', () => {
    const v2 = intent({ amount_irr: 1_500_000, expected_amount_irr: '900000' });
    expect(expectedIntentAmountIrr(v2)).toBe(900_000);
    expect(evaluateGatewayVerification(v2, { verified: true, providerRef: 'R', amount: 1_500_000, status: 'success' }))
      .toEqual({ ok: false, reason: 'gateway_amount_mismatch' });
    expect(evaluateGatewayVerification(v2, { verified: true, providerRef: 'R', amount: 900_000, status: 'success' }))
      .toEqual({ ok: true, confirmedAmountIrr: 900_000, alreadyVerified: false });
  });

  it('SEP: the gateway OrginalAmount must match the intent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ ResultCode: 0, Success: true, TransactionDetail: { OrginalAmount: 10_000 } }),
    }));
    const sepIntent = intent({ provider_name: 'sep_shaparak', provider_ref: 'TOK' });
    const result = await sepProvider.verifyPayment!(
      { provider: 'sep', terminal_id: 't' },
      buildBoundVerifyParams(sepIntent, { Token: 'TOK', RefNum: 'CHEAP_REFNUM' }, 1_500_000),
    );
    expect(evaluateGatewayVerification(sepIntent, result)).toEqual({ ok: false, reason: 'gateway_amount_mismatch' });
  });

  it('an unverified result never passes', () => {
    expect(evaluateGatewayVerification(intent(), { verified: false, providerRef: '', amount: 1_500_000, status: 'failed' }))
      .toEqual({ ok: false, reason: 'gateway_not_verified' });
  });
});

describe('"already verified" replay', () => {
  const already = { verified: true, providerRef: 'REF_1', amount: 1_500_000, status: 'already_verified' };

  it('is rejected for a new (pending) intent', () => {
    expect(evaluateGatewayVerification(intent(), already))
      .toEqual({ ok: false, reason: 'gateway_already_verified_unbound' });
  });

  it('is rejected for a processing intent without its own verification marker', () => {
    expect(evaluateGatewayVerification(intent({ status: 'processing' }), already))
      .toEqual({ ok: false, reason: 'gateway_already_verified_unbound' });
  });

  it('is accepted for the same intent re-calling back (idempotent recovery)', () => {
    expect(evaluateGatewayVerification(verifiedIntent(), already))
      .toEqual({ ok: true, confirmedAmountIrr: 1_500_000, alreadyVerified: true });
  });

  it('falls back to the recorded confirmed amount when the gateway omits it (Zibal 201)', () => {
    const zibal = verifiedIntent({ provider_name: 'zibal', provider_ref: '777' }, 'ZREF');
    expect(evaluateGatewayVerification(zibal, { verified: true, providerRef: '777', status: 'already_verified' }))
      .toEqual({ ok: true, confirmedAmountIrr: 1_500_000, alreadyVerified: true });
  });

  it('rejects a different, already-consumed gateway reference (SEP RefNum reuse)', () => {
    const sep = verifiedIntent({ provider_name: 'sep_shaparak', provider_ref: 'TOK' }, 'REFNUM_MINE');
    expect(evaluateGatewayVerification(sep, { verified: true, providerRef: 'REFNUM_SOMEONE_ELSE', amount: 1_500_000, status: 'already_verified' }))
      .toEqual({ ok: false, reason: 'gateway_already_verified_reference_mismatch' });
  });

  it('SEP ResultCode 2 is surfaced as already_verified, not a fresh success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ ResultCode: 2, Success: true, TransactionDetail: { OrginalAmount: 1_500_000 } }),
    }));
    const sepIntent = intent({ provider_name: 'sep_shaparak', provider_ref: 'TOK' });
    const result = await sepProvider.verifyPayment!(
      { provider: 'sep', terminal_id: 't' },
      buildBoundVerifyParams(sepIntent, { Token: 'TOK', RefNum: 'OLD' }, 1_500_000),
    );
    expect(result.status).toBe('already_verified');
    expect(evaluateGatewayVerification(sepIntent, result))
      .toEqual({ ok: false, reason: 'gateway_already_verified_unbound' });
  });
});

describe('Iranian checkout pricing is IRR only', () => {
  const prices = { IRR: { monthly: 1_500_000, yearly: 15_000_000 }, USD: { monthly: 10, yearly: 100 } };

  it('rejects a non-IRR client currency instead of charging its number as Rial', () => {
    expect(resolveIrrPlanPrice(prices, 'monthly', 'USD')).toEqual({ ok: false, error: 'CURRENCY_NOT_SUPPORTED' });
    expect(resolveIrrPlanPrice(prices, 'monthly', 'irt')).toEqual({ ok: false, error: 'CURRENCY_NOT_SUPPORTED' });
  });

  it('prices from IRR when the currency is IRR (any case) or absent', () => {
    expect(resolveIrrPlanPrice(prices, 'monthly', 'IRR')).toEqual({ ok: true, amountIrr: 1_500_000 });
    expect(resolveIrrPlanPrice(prices, 'yearly', 'irr')).toEqual({ ok: true, amountIrr: 15_000_000 });
    expect(resolveIrrPlanPrice(prices, 'monthly', undefined)).toEqual({ ok: true, amountIrr: 1_500_000 });
  });

  it('never falls back to another currency when the IRR price is missing', () => {
    expect(resolveIrrPlanPrice({ USD: { monthly: 10 } }, 'monthly', 'IRR')).toEqual({ ok: false, error: 'PRICE_NOT_AVAILABLE' });
    expect(resolveIrrPlanPrice(null, 'monthly', undefined)).toEqual({ ok: false, error: 'PRICE_NOT_AVAILABLE' });
  });
});
