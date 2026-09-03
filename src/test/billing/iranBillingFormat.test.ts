/**
 * Phase 15 — Iran billing money/display contract.
 *
 *  - IRR (whole Rial integer) must always render as Toman (÷10), never as
 *    raw Rial, and never with an "IRR"/"Rial" label in customer-facing text.
 *  - Backend statuses map to Persian; raw enum strings never reach the UI.
 */
import { describe, it, expect } from 'vitest';
import { formatToman, irrToToman } from '../../lib/money';
import { formatMoney } from '../../lib/region';
import { mapPaymentStatus, describeTransaction } from '../../pages/app/billing/iran/format';

describe('IRR → Toman money contract', () => {
  it('irrToToman divides by exactly 10', () => {
    expect(irrToToman(15_000_000)).toBe(1_500_000);
    expect(irrToToman(0)).toBe(0);
    expect(irrToToman(null)).toBe(0);
  });

  it('formatToman renders the Persian Toman label, never Rial/IRR', () => {
    const out = formatToman(15_000_000, 'fa');
    expect(out).toContain('تومان');
    expect(out).not.toMatch(/ریال|IRR|IRT|TOMAN|RIAL/i);
    // 15,000,000 Rial = 1,500,000 Toman.
    expect(out).toContain('۱٬۵۰۰٬۰۰۰');
  });

  it('region.ts formatMoney also converts Rial-family amounts to Toman (not /100 then /10)', () => {
    // Pro plan monthly price stored as whole Rial: 15,000,000 IRR = 1,500,000 Toman.
    const out = formatMoney(15_000_000, 'fa', 'iran');
    expect(out).not.toMatch(/۱۵۰۰۰۰|15000\b/); // must NOT be the old buggy /1000 result (15,000)
    expect(out).toContain('۱٬۵۰۰٬۰۰۰');
  });
});

describe('Persian transaction status mapping', () => {
  it('never leaks a raw backend status', () => {
    const raw = ['succeeded', 'pending', 'failed', 'refunded', 'partially_refunded', 'canceled', 'garbage', undefined, null];
    const mapped = raw.map((r) => mapPaymentStatus(r as any));
    for (const m of mapped) {
      expect(['succeeded', 'pending', 'failed', 'refunded', 'canceled']).toContain(m);
    }
  });

  it('maps unknown/garbage statuses to failed (never passthrough)', () => {
    expect(mapPaymentStatus('some_unmapped_enum' as any)).toBe('failed');
  });
});

describe('Transaction description classification', () => {
  it('classifies an AI credit top-up event', () => {
    expect(describeTransaction({ event_type: 'ai_credit_topup' })).toBe('topup');
  });

  it('defaults to renewal for a plain subscription payment', () => {
    expect(describeTransaction({ event_type: 'payment_succeeded' })).toBe('renewal');
  });
});
