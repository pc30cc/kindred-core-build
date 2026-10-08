/**
 * Billing notifications print an amount in the currency it is in.
 *
 * Since 255 an invoice (and a card payment) can be in USD/EUR, whose amount
 * columns hold minor units; migration 256 puts `currency` next to
 * `amount_irr` in every notification payload. A Rial amount — and a job
 * queued before 256, which has no currency — must read exactly as before.
 */
import { describe, expect, it } from 'vitest';
import {
  buildBillingTemplateData,
  formatAmount,
  formatIrr,
  payloadCurrency,
  renderBillingNotification,
  type BillingLocale,
  type BillingNotificationType,
} from '../../../server/services/billing/notifications/messages';

/** formatIrr as it was before 256, verbatim: the IRR output must not move by a byte. */
function legacyFormatIrr(amount: unknown, locale: BillingLocale): string {
  const n = Number(amount ?? 0);
  if (!Number.isFinite(n)) return '0';
  const grouped = new Intl.NumberFormat(locale === 'fa' ? 'fa-IR' : locale === 'tr' ? 'tr-TR' : 'en-US', {
    maximumFractionDigits: 0,
  }).format(Math.round(n));
  return locale === 'fa' ? `${grouped} ریال` : locale === 'tr' ? `${grouped} IRR` : `${grouped} IRR`;
}

const LOCALES: BillingLocale[] = ['fa', 'en', 'tr'];
const AMOUNT_TYPES: BillingNotificationType[] = [
  'invoice_issued', 'invoice_reminder', 'invoice_due', 'wallet_autopay_insufficient', 'invoice_past_due',
  'payment_received', 'wallet_deposit_received', 'ai_credit_purchased',
];
const ALL_TYPES: BillingNotificationType[] = [
  ...AMOUNT_TYPES, 'subscription_restored', 'subscription_free_fallback', 'subscription_activated',
  'subscription_renewed', 'trial_ending_soon', 'trial_expired',
];
const base = {
  invoice_number: 'WY00001234', due_at: '2026-10-20T08:00:00Z', grace_period_ends_at: '2026-10-27T08:00:00Z',
  plan_name: 'Pro', period_end: '2026-11-20T08:00:00Z', trial_end: '2026-10-12T08:00:00Z', days_left: 3,
};

describe('Rial amounts read exactly as before 256', () => {
  it.each(LOCALES)('formatAmount(IRR) is formatIrr, byte for byte (%s)', (loc) => {
    for (const amount of [0, 1, 1_500_000, 29_000_000.4, '2500000', null, undefined, 'x']) {
      const legacy = legacyFormatIrr(amount, loc);
      expect(formatIrr(amount, loc)).toBe(legacy);
      for (const currency of [undefined, null, '', 'IRR', ' irr ', 'not-a-code', 42]) {
        expect(formatAmount(amount, currency, loc)).toBe(legacy);
      }
    }
  });

  it.each(LOCALES)('every message renders identically with currency IRR, without currency, and with the old amount (%s)', (loc) => {
    for (const type of ALL_TYPES) {
      const old = renderBillingNotification(type, loc, { ...base, amount_irr: 1_500_000 });
      expect(renderBillingNotification(type, loc, { ...base, amount_irr: 1_500_000, currency: 'IRR' })).toEqual(old);
      if (AMOUNT_TYPES.includes(type)) expect(old.text).toContain(legacyFormatIrr(1_500_000, loc));
    }
    expect(buildBillingTemplateData(loc, { ...base, amount_irr: 1_500_000, currency: 'IRR' }))
      .toEqual(buildBillingTemplateData(loc, { ...base, amount_irr: 1_500_000 }));
  });

  it('the exact Rial texts', () => {
    expect(renderBillingNotification('invoice_past_due', 'en', { ...base, amount_irr: 1_500_000 }).text).toBe(
      'Invoice WY00001234 for 1,500,000 IRR was not paid on its due date. You have until Oct 27, 2026 to pay before the workspace moves to the free plan. No data is deleted.',
    );
    expect(formatAmount(1_500_000, 'IRR', 'fa')).toBe('۱٬۵۰۰٬۰۰۰ ریال');
    expect(formatAmount(1_500_000, undefined, 'tr')).toBe('1.500.000 IRR');
  });
});

describe('an amount in another currency is minor units of it', () => {
  it('USD / EUR / TRY, in each locale', () => {
    expect(formatAmount(2900, 'USD', 'en')).toBe('$29.00');
    expect(formatAmount(2900, 'usd', 'en')).toBe('$29.00');
    expect(formatAmount(1999, 'EUR', 'en')).toBe('€19.99');
    expect(formatAmount('14990', 'TRY', 'tr')).toBe(new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' }).format(149.9));
    expect(formatAmount(2900, 'USD', 'fa')).toBe(new Intl.NumberFormat('fa-IR', { style: 'currency', currency: 'USD' }).format(29));
    // Never the Rial label, never the raw cents.
    for (const loc of LOCALES) {
      expect(formatAmount(2900, 'USD', loc)).not.toMatch(/IRR|ریال|2,900|2\.900/);
    }
  });

  it.each(LOCALES)('every amount-carrying message prints the dollar amount (%s)', (loc) => {
    const dollars = formatAmount(2900, 'USD', loc);
    for (const type of AMOUNT_TYPES) {
      const msg = renderBillingNotification(type, loc, { ...base, amount_irr: 2900, currency: 'USD' });
      expect(msg.text).toContain(dollars);
      expect(msg.text).not.toContain(legacyFormatIrr(2900, loc));
    }
    expect(buildBillingTemplateData(loc, { ...base, amount_irr: 2900, currency: 'USD' }).amount).toBe(dollars);
  });

  it('a renewal reminder for $29.00', () => {
    expect(renderBillingNotification('invoice_reminder', 'en', { ...base, amount_irr: 2900, currency: 'USD' }).text).toBe(
      'Invoice WY00001234 for $29.00 is due on Oct 20, 2026. Pay it or top up your wallet before the due date to avoid a service interruption.',
    );
  });

  it('reads the currency code as invoiceCurrency() does', () => {
    expect(payloadCurrency(' eur ')).toBe('EUR');
    expect(payloadCurrency(undefined)).toBe('IRR');
    expect(payloadCurrency('dollars')).toBe('IRR');
  });
});
