/**
 * Shared rules of the Super Admin billing screens (shared/simpleBillingAdmin.ts,
 * phase 6): month keys in the edition's calendar, the monthly revenue
 * buckets, and the credit/debit size and filter rules.
 */
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_FILTERS,
  ADJUST_REASON_MAX,
  adjustAmountProblem,
  adjustReasonValid,
  bucketRevenue,
  isAdjustCategory,
  localDayOf,
  monthKeyOf,
  monthKeysEnding,
  parseAccountFilter,
  revenueCalendarOf,
  revenueWindowDays,
  type LedgerDayRow,
  type RevenueDayRow,
} from '../../../../shared/simpleBillingAdmin';
import { isTestPaymentProvider } from '../../../../shared/testGateways';

describe('monthKeyOf', () => {
  it('Jalali: 1 Farvardin starts a year; 31 Shahrivar → 1 Mehr', () => {
    expect(monthKeyOf('2026-03-20', 'jalali')).toBe('1404-12');
    expect(monthKeyOf('2026-03-21', 'jalali')).toBe('1405-01');
    expect(monthKeyOf('2026-09-22', 'jalali')).toBe('1405-06');
    expect(monthKeyOf('2026-09-23', 'jalali')).toBe('1405-07');
    expect(monthKeyOf('2026-10-11', 'jalali')).toBe('1405-07');
  });

  it('Gregorian month boundaries', () => {
    expect(monthKeyOf('2026-01-31', 'gregorian')).toBe('2026-01');
    expect(monthKeyOf('2026-02-01', 'gregorian')).toBe('2026-02');
    expect(monthKeyOf('2025-12-31', 'gregorian')).toBe('2025-12');
    expect(monthKeyOf('2028-02-29', 'gregorian')).toBe('2028-02');
  });

  it('refuses a value that is not a day', () => {
    expect(() => monthKeyOf('not-a-day', 'gregorian')).toThrow(RangeError);
  });
});

describe('localDayOf and the edition calendar', () => {
  it('a Tehran midnight moves the day; UTC does not', () => {
    // 2026-10-10 21:00 UTC is 2026-10-11 00:30 in Tehran (UTC+3:30).
    const at = new Date('2026-10-10T21:00:00Z');
    expect(localDayOf(at, 'Asia/Tehran')).toBe('2026-10-11');
    expect(localDayOf(at, 'UTC')).toBe('2026-10-10');
  });

  it('Iran is Jalali in Tehran; international is Gregorian in UTC', () => {
    expect(revenueCalendarOf('iran')).toEqual({ calendar: 'jalali', timeZone: 'Asia/Tehran' });
    expect(revenueCalendarOf('international')).toEqual({ calendar: 'gregorian', timeZone: 'UTC' });
  });
});

describe('monthKeysEnding', () => {
  it('the last N months, oldest first, ending with the current month', () => {
    expect(monthKeysEnding('2026-10-11', 3, 'gregorian')).toEqual(['2026-08', '2026-09', '2026-10']);
    expect(monthKeysEnding('2026-03-21', 2, 'jalali')).toEqual(['1404-12', '1405-01']);
    expect(monthKeysEnding('2026-01-01', 1, 'gregorian')).toEqual(['2026-01']);
  });

  it('36 months fit in the window the report reads', () => {
    const keys = monthKeysEnding('2026-10-11', 36, 'jalali');
    expect(keys).toHaveLength(36);
    expect(new Set(keys).size).toBe(36);
    expect(revenueWindowDays(36)).toBe(37 * 31);
  });
});

const pay = (day: string, currency: string, net: number, tax: number, extra: Partial<RevenueDayRow> = {}): RevenueDayRow => ({
  day, metric: 'payment', currency, provider: 'zarinpal', source: 'checkout', purpose: 'topup',
  count: 1, gross_minor: net + tax, tax_minor: tax, net_minor: net, ...extra,
});

const refund = (day: string, currency: string, gross: number, net: number, extra: Partial<RevenueDayRow> = {}): RevenueDayRow => ({
  day, metric: 'refund', currency, provider: 'zarinpal', source: 'checkout', purpose: 'topup',
  count: 1, gross_minor: gross, tax_minor: gross - net, net_minor: net, ...extra,
});

describe('bucketRevenue', () => {
  const base = {
    edition: 'international' as const,
    today: '2026-10-11',
    months: 2,
    includeTest: false,
    isTest: isTestPaymentProvider,
    ledgerDays: [] as LedgerDayRow[],
    liability: [],
    currencies: ['USD', 'TRY'],
  };

  it('keeps only the last N months (the partial oldest one is dropped), zeros included', () => {
    const report = bucketRevenue({
      ...base,
      days: [
        pay('2026-08-31', 'USD', 999, 0), // outside the 2 months kept
        pay('2026-09-01', 'USD', 1000, 0),
        pay('2026-10-10', 'USD', 2000, 200, { provider: 'paddle', source: 'card_renewal', purpose: 'renewal' }),
      ],
    });
    expect(report.months).toEqual(['2026-09', '2026-10']);
    expect(report.calendar).toBe('gregorian');
    expect(report.time_zone).toBe('UTC');
    expect(report.currencies).toEqual(['USD', 'TRY']);
    // One row per month and currency, months oldest first per currency.
    expect(report.rows.map((r) => `${r.currency}:${r.month}`)).toEqual(['USD:2026-09', 'USD:2026-10', 'TRY:2026-09', 'TRY:2026-10']);
    const oct = report.rows[1];
    expect(oct).toMatchObject({ payments: 1, gross_minor: 2200, tax_minor: 200, net_minor: 2000, net_after_refunds_minor: 2000 });
    expect(oct.by_purpose).toEqual({ renewal: { count: 1, gross_minor: 2200, tax_minor: 200, net_minor: 2000 } });
    expect(oct.by_provider).toEqual({ paddle: { count: 1, gross_minor: 2200, net_minor: 2000, is_test: false } });
    expect(oct.by_source).toEqual({ card_renewal: { count: 1, gross_minor: 2200, net_minor: 2000 } });
    expect(report.rows[2]).toMatchObject({ payments: 0, gross_minor: 0, net_after_refunds_minor: 0 });
    expect(report.totals.USD).toMatchObject({ payments: 2, net_minor: 3000, gross_minor: 3200, tax_minor: 200 });
    expect(report.totals.TRY.payments).toBe(0);
  });

  it('never adds two currencies together; refunds count in their own month', () => {
    const report = bucketRevenue({
      ...base,
      days: [
        pay('2026-09-05', 'USD', 1000, 100),
        pay('2026-09-05', 'TRY', 50_000, 10_000),
        refund('2026-10-02', 'USD', 1100, 1000),
      ],
    });
    const usdSep = report.rows.find((r) => r.currency === 'USD' && r.month === '2026-09')!;
    const usdOct = report.rows.find((r) => r.currency === 'USD' && r.month === '2026-10')!;
    const trySep = report.rows.find((r) => r.currency === 'TRY' && r.month === '2026-09')!;
    expect(usdSep).toMatchObject({ net_minor: 1000, refunds: 0, net_after_refunds_minor: 1000 });
    expect(usdOct).toMatchObject({
      payments: 0, net_minor: 0, refunds: 1, refund_gross_minor: 1100, refund_tax_minor: 100, refund_net_minor: 1000, net_after_refunds_minor: -1000,
    });
    expect(trySep).toMatchObject({ net_minor: 50_000, tax_minor: 10_000 });
    expect(report.totals.USD).toMatchObject({ net_minor: 1000, refund_net_minor: 1000, net_after_refunds_minor: 0 });
    expect(report.totals.TRY).toMatchObject({ net_minor: 50_000, net_after_refunds_minor: 50_000 });
  });

  it('test gateways are left out unless asked for', () => {
    const days = [pay('2026-10-01', 'USD', 1000, 0), pay('2026-10-01', 'USD', 500, 0, { provider: 'paddle_sandbox' }), refund('2026-10-02', 'USD', 500, 500, { provider: 'paddle_sandbox' })];
    const without = bucketRevenue({ ...base, days });
    expect(without.totals.USD).toMatchObject({ payments: 1, net_minor: 1000, refunds: 0 });
    const withTest = bucketRevenue({ ...base, days, includeTest: true });
    expect(withTest.include_test).toBe(true);
    expect(withTest.totals.USD).toMatchObject({ payments: 2, net_minor: 1500, refunds: 1, net_after_refunds_minor: 1000 });
    expect(withTest.rows.find((r) => r.month === '2026-10' && r.currency === 'USD')!.by_provider.paddle_sandbox.is_test).toBe(true);
  });

  it('Iran: Jalali months, a currency found in the data is added after the edition ones', () => {
    const report = bucketRevenue({
      ...base,
      edition: 'iran',
      currencies: ['IRR'],
      today: '2026-10-11',
      months: 2,
      days: [pay('2026-09-22', 'IRR', 1_000_000, 100_000), pay('2026-09-23', 'IRR', 2_000_000, 200_000)],
      ledgerDays: [
        { day: '2026-09-22', currency: 'IRR', kind: 'admin_credit', count: 1, in_minor: 50_000, out_minor: 0 },
        { day: '2026-09-23', currency: 'IRR', kind: 'renewal', count: 2, in_minor: 0, out_minor: 3_000_000 },
        { day: '2026-09-24', currency: 'IRR', kind: 'renewal', count: 1, in_minor: 0, out_minor: 1_000_000 },
        { day: '2026-07-01', currency: 'IRR', kind: 'renewal', count: 9, in_minor: 0, out_minor: 9 },
      ],
      liability: [{ currency: 'irr', accounts: 3, positive_accounts: 2, balance_minor: 7, prepaid_minor: 1 }],
    });
    expect(report.calendar).toBe('jalali');
    expect(report.time_zone).toBe('Asia/Tehran');
    expect(report.months).toEqual(['1405-06', '1405-07']);
    expect(report.rows.map((r) => [r.month, r.net_minor])).toEqual([['1405-06', 1_000_000], ['1405-07', 2_000_000]]);
    expect(report.ledger).toEqual([
      { month: '1405-06', currency: 'IRR', kind: 'admin_credit', count: 1, in_minor: 50_000, out_minor: 0 },
      { month: '1405-07', currency: 'IRR', kind: 'renewal', count: 3, in_minor: 0, out_minor: 4_000_000 },
    ]);
    expect(report.liability).toEqual([{ currency: 'IRR', accounts: 3, positive_accounts: 2, balance_minor: 7, prepaid_minor: 1 }]);
    expect(report.currencies).toEqual(['IRR']);
  });
});

describe('credit and debit rules', () => {
  it('adjustAmountProblem: positive integers up to the top-up cap of the currency', () => {
    expect(adjustAmountProblem(1, 'USD')).toBeNull();
    expect(adjustAmountProblem(5_000_000, 'USD')).toBeNull();
    expect(adjustAmountProblem(5_000_001, 'USD')).toBe('ADJUST_TOO_LARGE');
    expect(adjustAmountProblem(10_000_000_000, 'irr')).toBeNull();
    expect(adjustAmountProblem(10_000_000_001, 'IRR')).toBe('ADJUST_TOO_LARGE');
    expect(adjustAmountProblem(200_000_001, 'TRY')).toBe('ADJUST_TOO_LARGE');
    expect(adjustAmountProblem(0, 'USD')).toBe('ADJUST_AMOUNT_INVALID');
    expect(adjustAmountProblem(-5, 'USD')).toBe('ADJUST_AMOUNT_INVALID');
    expect(adjustAmountProblem(1.5, 'USD')).toBe('ADJUST_AMOUNT_INVALID');
    expect(adjustAmountProblem('100', 'USD')).toBe('ADJUST_AMOUNT_INVALID');
    expect(adjustAmountProblem(100, 'XYZ')).toBe('CURRENCY_NOT_SUPPORTED');
  });

  it('reason 3-500 characters after trimming; categories', () => {
    expect(adjustReasonValid('  ab ')).toBe(false);
    expect(adjustReasonValid('abc')).toBe(true);
    expect(adjustReasonValid('x'.repeat(ADJUST_REASON_MAX))).toBe(true);
    expect(adjustReasonValid('x'.repeat(ADJUST_REASON_MAX + 1))).toBe(false);
    expect(adjustReasonValid(null)).toBe(false);
    expect(isAdjustCategory('goodwill')).toBe(true);
    expect(isAdjustCategory('bonus')).toBe(false);
  });

  it('parseAccountFilter: the list, owner:<uuid>, the default', () => {
    for (const f of ACCOUNT_FILTERS) expect(parseAccountFilter(f)).toBe(f);
    expect(parseAccountFilter(undefined)).toBe('with_account');
    expect(parseAccountFilter('')).toBe('with_account');
    expect(parseAccountFilter('owner:6F1B2C3D-1111-4222-8333-444455556666')).toBe('owner:6f1b2c3d-1111-4222-8333-444455556666');
    expect(parseAccountFilter('owner:nope')).toBeNull();
    expect(parseAccountFilter('rich')).toBeNull();
    expect(parseAccountFilter(['all'])).toBeNull();
  });
});
