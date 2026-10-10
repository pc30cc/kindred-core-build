/**
 * The billing mails' formatting: Toman and the Persian calendar in the
 * Iranian edition, the Gregorian calendar everywhere else (Persian mail of
 * the international edition included), and interval names per language.
 */
import { describe, it, expect } from 'vitest';
import { billingIntervalLabel, formatBillingDate, formatBillingMoney } from '../../../../server/services/billing/account/notify';

const ISO = '2026-10-18T12:00:00Z';

describe('billing mail formatting', () => {
  it('Persian mail of the Iranian edition uses the Persian calendar', () => {
    const date = formatBillingDate('iran', 'fa', ISO);
    expect(date).toContain('۱۴۰۵');
    expect(date).not.toContain('۲۰۲۶');
  });

  it('Persian mail of the international edition keeps the Gregorian calendar', () => {
    const date = formatBillingDate('international', 'fa', ISO);
    expect(date).toContain('۲۰۲۶');
    expect(date).not.toContain('۱۴۰۵');
  });

  it('English and Turkish mail use the Gregorian calendar', () => {
    expect(formatBillingDate('international', 'en', ISO)).toContain('2026');
    expect(formatBillingDate('international', 'tr', ISO)).toContain('2026');
  });

  it('Rial reads as Toman; other currencies in their own format', () => {
    expect(formatBillingMoney('iran', 'fa', 'IRR', 2_000_000)).toBe('۲۰۰٬۰۰۰ تومان');
    expect(formatBillingMoney('international', 'en', 'USD', 2900)).toBe('$29.00');
  });

  it('names the interval in the mail\'s language', () => {
    expect(billingIntervalLabel('monthly', 'fa')).toBe('ماهانه');
    expect(billingIntervalLabel('yearly', 'tr')).toBe('yıllık');
    expect(billingIntervalLabel('yearly', 'de')).toBe('yearly');
  });
});
