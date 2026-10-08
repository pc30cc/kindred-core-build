/**
 * Which price a gateway is asked to charge, in which units, and how a
 * provider's reported amounts become the platform's minor units.
 *
 * The Turkish gateways used to send every checkout as TRY: a USD price of
 * 2900 ($29) went out as 29.00 TRY. A gateway is now sent the currency it was
 * priced in, or — when it cannot charge that — its fallback currency, and the
 * caller then charges the plan's price IN THAT currency.
 */
import { describe, it, expect } from 'vitest';
import { resolveChargeCurrency } from '../../../server/services/billing/chargeCurrency.js';
import {
  majorToMinor,
  minorFromProvider,
  minorToMajorString,
  normalizeCurrencyCode,
  requireSupportedCurrency,
} from '../../../server/services/billing/providers/minorAmount.js';
import { nextRefundState, recordProviderRefund } from '../../../server/services/billing/refunds.js';
import { iyzicoProvider } from '../../../server/services/billing/providers/iyzico.js';
import { paytrProvider } from '../../../server/services/billing/providers/paytr.js';
import { sipayProvider } from '../../../server/services/billing/providers/sipay.js';
import { paratikaProvider } from '../../../server/services/billing/providers/paratika.js';
import { craftgateProvider } from '../../../server/services/billing/providers/craftgate.js';
import { paypalProvider } from '../../../server/services/billing/providers/paypal.js';
import { stripeProvider } from '../../../server/services/billing/providers/stripe.js';

const TURKISH = [iyzicoProvider, paytrProvider, sipayProvider, paratikaProvider, craftgateProvider];

describe('resolveChargeCurrency', () => {
  it.each(TURKISH.map((p) => [p.name, p]))('%s charges TRY, USD and EUR as requested', (_name, provider) => {
    for (const code of ['TRY', 'USD', 'EUR']) {
      expect(resolveChargeCurrency(provider, code)).toEqual({ currency: code, fellBack: false });
    }
  });

  it.each(TURKISH.map((p) => [p.name, p]))('%s falls back to TRY — explicitly — for a currency it cannot charge', (_name, provider) => {
    expect(resolveChargeCurrency(provider, 'IRR')).toEqual({ currency: 'TRY', fellBack: true });
  });

  it('a gateway without a fallback refuses instead (PayPal cannot charge TRY)', () => {
    expect(resolveChargeCurrency(paypalProvider, 'TRY')).toBeNull();
    expect(resolveChargeCurrency(stripeProvider, 'usd')).toEqual({ currency: 'USD', fellBack: false });
  });

  it('a provider with no declared list keeps its old behaviour', () => {
    expect(resolveChargeCurrency({}, 'usd')).toEqual({ currency: 'USD', fellBack: false });
    expect(resolveChargeCurrency({}, '')).toBeNull();
  });
});

describe('minor-unit helpers', () => {
  it('major → minor rounds instead of truncating floating-point products', () => {
    expect(majorToMinor('19.99')).toBe(1999);
    expect(majorToMinor(19.99)).toBe(1999);
    expect(majorToMinor('149.90')).toBe(14990);
    expect(majorToMinor('0')).toBe(0);
    for (const bad of ['', 'abc', -1, null, undefined, {}]) expect(majorToMinor(bad)).toBeUndefined();
  });

  it('provider minor amounts must already be integers', () => {
    expect(minorFromProvider('2900')).toBe(2900);
    expect(minorFromProvider(2900)).toBe(2900);
    for (const bad of ['29.00', 29.5, '-1', '', null, undefined]) expect(minorFromProvider(bad)).toBeUndefined();
  });

  it('minor → major string', () => {
    expect(minorToMajorString('14990')).toBe('149.90');
    expect(minorToMajorString(0)).toBe('0');
  });

  it('currency codes are normalised and validated', () => {
    expect(normalizeCurrencyCode(' usd ')).toBe('USD');
    expect(normalizeCurrencyCode('US')).toBeUndefined();
    expect(normalizeCurrencyCode(7)).toBeUndefined();
    expect(requireSupportedCurrency('X', 'eur', ['EUR'])).toBe('EUR');
    expect(() => requireSupportedCurrency('X', 'TRY', ['EUR'])).toThrow('X cannot charge TRY');
  });
});

describe('refund accounting', () => {
  const payment = { id: 'p', amount: 2900, refund_amount: 0 };

  it('a running total (Stripe / PayPal / Lemon Squeezy) is taken as is', () => {
    expect(nextRefundState(payment, { refundedTotal: 1000 })).toEqual({ refundAmount: 1000, status: 'partially_refunded' });
    expect(nextRefundState({ ...payment, refund_amount: 1000 }, { refundedTotal: 2900 })).toEqual({
      refundAmount: 2900, status: 'refunded',
    });
  });

  it('a per-refund amount (Paddle) is added to what was refunded before', () => {
    expect(nextRefundState({ ...payment, refund_amount: 1000 }, { amount: 900 })).toEqual({
      refundAmount: 1900, status: 'partially_refunded',
    });
  });

  it('a refund reported under its id counts once, however often it is reported (Paddle adjustments)', () => {
    const first = nextRefundState(payment, { amount: 1000, refundId: 'adj_1' });
    expect(first).toEqual({ refundAmount: 1000, status: 'partially_refunded', refunds: { adj_1: 1000 } });
    const again = nextRefundState({ ...payment, refund_amount: 1000, metadata: { provider_refunds: first.refunds } }, {
      amount: 1000, refundId: 'adj_1',
    });
    expect(again.refundAmount).toBe(1000);
    const second = nextRefundState({ ...payment, refund_amount: 1000, metadata: { provider_refunds: first.refunds } }, {
      amount: 1900, refundId: 'adj_2',
    });
    expect(second).toEqual({ refundAmount: 2900, status: 'refunded', refunds: { adj_1: 1000, adj_2: 1900 } });
  });

  it('keeps the per-refund amounts on the payment, next to its other metadata', async () => {
    const patches: unknown[] = [];
    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = () => builder;
    builder.limit = () => builder;
    builder.maybeSingle = async () => ({
      data: { id: 'p', amount: 2900, refund_amount: 1000, metadata: { intentId: 'pi-1', provider_refunds: { adj_1: 1000 } } },
      error: null,
    });
    builder.update = (patch: unknown) => {
      patches.push(patch);
      return builder;
    };
    builder.then = (resolve: (v: unknown) => void) => resolve({ error: null });
    const sb = { from: () => builder };
    // The same adjustment reported again: nothing is added.
    await recordProviderRefund(sb as never, 'paddle', { providerPaymentId: 'txn_1', amount: 1000, refundId: 'adj_1' });
    expect(patches[0]).toEqual({
      refund_amount: 1000,
      status: 'partially_refunded',
      metadata: { intentId: 'pi-1', provider_refunds: { adj_1: 1000 } },
    });
  });

  it('never exceeds the payment, and no amount means the whole payment', () => {
    expect(nextRefundState(payment, { refundedTotal: 99999 })).toEqual({ refundAmount: 2900, status: 'refunded' });
    expect(nextRefundState(payment, {})).toEqual({ refundAmount: 2900, status: 'refunded' });
  });
});
