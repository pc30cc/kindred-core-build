/**
 * Plan price units: `billing_plans.prices` holds USD/EUR/TRY in minor units
 * and IRR in Rial; the plan editor speaks the amounts people read.
 */
import { describe, it, expect } from 'vitest';
import {
  formatPlanPrice,
  parsePlanPriceInput,
  planPriceFromDisplay,
  planPriceInputValue,
  planPriceToDisplay,
  planPriceUnitLabel,
} from '@/lib/planPrice';
import { minorToMajorString } from '../../../server/services/billing/providers/minorAmount';

describe('plan price units', () => {
  it('stores USD/EUR/TRY in minor units', () => {
    expect(planPriceFromDisplay(29, 'USD')).toBe(2900);
    expect(planPriceFromDisplay(29.99, 'EUR')).toBe(2999);
    expect(planPriceFromDisplay(999, 'TRY')).toBe(99900);
    // Float noise is rounded away, not truncated (0.29 * 100 = 28.999999999999996).
    expect(planPriceFromDisplay(0.29, 'USD')).toBe(29);
    expect(planPriceFromDisplay(19.99, 'USD')).toBe(1999);
  });

  it('stores IRR as Rial from a Toman amount', () => {
    expect(planPriceFromDisplay(1_500_000, 'IRR')).toBe(15_000_000);
    expect(planPriceToDisplay(15_000_000, 'IRR')).toBe(1_500_000);
  });

  it('never stores a negative or invalid amount', () => {
    expect(planPriceFromDisplay(-5, 'USD')).toBe(0);
    expect(planPriceFromDisplay(Number.NaN, 'USD')).toBe(0);
    expect(planPriceToDisplay('x', 'USD')).toBe(0);
    expect(planPriceToDisplay(null, 'USD')).toBe(0);
  });

  it('round-trips the seeded prices through the editor field', () => {
    const seeded = { USD: 2900, EUR: 2700, TRY: 349900, IRR: 50_000_000 } as const;
    for (const [cur, stored] of Object.entries(seeded)) {
      const text = planPriceInputValue(stored, cur);
      expect(planPriceFromDisplay(parsePlanPriceInput(text)!, cur)).toBe(stored);
    }
    expect(planPriceInputValue(2900, 'USD')).toBe('29');
    expect(planPriceInputValue(2999, 'USD')).toBe('29.99');
    expect(planPriceInputValue(15_000_000, 'IRR')).toBe('1500000');
    expect(planPriceInputValue(0, 'TRY')).toBe('0');
    for (let cents = 0; cents < 10_000; cents += 7) {
      expect(planPriceFromDisplay(parsePlanPriceInput(planPriceInputValue(cents, 'USD'))!, 'USD')).toBe(cents);
    }
  });

  it('parses what admins type', () => {
    expect(parsePlanPriceInput('29')).toBe(29);
    expect(parsePlanPriceInput('29.99')).toBe(29.99);
    expect(parsePlanPriceInput('29,99')).toBe(29.99);
    expect(parsePlanPriceInput('29.5')).toBe(29.5);
    expect(parsePlanPriceInput('1,500,000')).toBe(1_500_000);
    expect(parsePlanPriceInput('1.500.000')).toBe(1_500_000);
    expect(parsePlanPriceInput('1,234.56')).toBe(1234.56);
    expect(parsePlanPriceInput('1.234,56')).toBe(1234.56);
    expect(parsePlanPriceInput('۱٬۵۰۰٬۰۰۰')).toBe(1_500_000);
    expect(parsePlanPriceInput('۲۹٫۹۹')).toBe(29.99);
    expect(parsePlanPriceInput(' 29 ')).toBe(29);
    expect(parsePlanPriceInput('')).toBe(0);
    expect(parsePlanPriceInput('29.')).toBe(29);
    expect(parsePlanPriceInput('-1')).toBeNull();
    expect(parsePlanPriceInput('abc')).toBeNull();
    expect(parsePlanPriceInput('$29')).toBeNull();
    expect(parsePlanPriceInput('1e3')).toBeNull();
  });

  it('formats a stored price as people read it', () => {
    expect(formatPlanPrice(2900, 'USD', 'en')).toBe('$29.00');
    expect(formatPlanPrice(2999, 'EUR', 'en')).toBe('€29.99');
    expect(formatPlanPrice(29, 'USD', 'en')).toBe('$0.29');
    expect(formatPlanPrice(99900, 'TRY', 'tr')).toContain('999,00');
    expect(formatPlanPrice(15_000_000, 'IRR', 'en')).toBe('1,500,000 Toman');
    expect(formatPlanPrice(15_000_000, 'IRR', 'fa')).toBe('۱٬۵۰۰٬۰۰۰ تومان');
  });

  it('labels each currency with its symbol, IRR with Toman', () => {
    expect(planPriceUnitLabel('USD', 'en')).toBe('$');
    expect(planPriceUnitLabel('EUR', 'en')).toBe('€');
    expect(planPriceUnitLabel('TRY', 'tr')).toBe('₺');
    expect(planPriceUnitLabel('IRR', 'fa')).toBe('تومان');
    expect(planPriceUnitLabel('IRR', 'en')).toBe('Toman');
  });
});

describe('gateway amount from a stored minor-unit price', () => {
  it('converts to a two-decimal major amount', () => {
    expect(minorToMajorString('2900')).toBe('29.00');
    expect(minorToMajorString('14990')).toBe('149.90');
    expect(minorToMajorString(99900)).toBe('999.00');
    expect(minorToMajorString(undefined)).toBe('0');
    expect(minorToMajorString('nope')).toBe('0');
  });
});
