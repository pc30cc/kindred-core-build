/**
 * Unified transaction history contract:
 *  - a settled payment and its intent collapse into ONE row (payment wins),
 *  - unpaid attempts (pending/canceled/failed/expired) stay visible,
 *  - no attempt is ever presented as settled money.
 */
import { describe, it, expect } from 'vitest';
import { buildTransactionHistory } from '../../../server/services/billing/transactionHistory';
import { generateDocumentNumber, DOCUMENT_NUMBER_PATTERN } from '../../../server/services/billing/invoiceNumber';

describe('document number', () => {
  it('is always 2 uppercase letters + 8 digits', () => {
    for (let i = 0; i < 500; i += 1) {
      expect(generateDocumentNumber()).toMatch(DOCUMENT_NUMBER_PATTERN);
    }
  });

  it('does not repeat in a large sample', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i += 1) seen.add(generateDocumentNumber());
    expect(seen.size).toBeGreaterThan(4990);
  });
});

describe('buildTransactionHistory', () => {
  it('de-duplicates a succeeded intent against its payment', () => {
    const rows = buildTransactionHistory(
      [{ id: 'pay1', payment_intent_id: 'int1', amount: 15_000_000, status: 'succeeded', created_at: '2026-01-02T00:00:00Z' }],
      [{ id: 'int1', status: 'succeeded', invoice_number: 'QF58392017', plan_name_snapshot: 'Pro', billing_interval: 'monthly', created_at: '2026-01-02T00:00:00Z' }],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].settled).toBe(true);
    expect(rows[0].documentNumber).toBe('QF58392017');
    expect(rows[0].planName).toBe('Pro');
  });

  it('keeps unpaid attempts visible and never marks them settled', () => {
    const rows = buildTransactionHistory([], [
      { id: 'a', status: 'pending', amount_irr: 1000, created_at: '2026-01-03T00:00:00Z' },
      { id: 'b', status: 'canceled', amount_irr: 2000, created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-02T01:00:00Z' },
      { id: 'c', status: 'expired', amount_irr: 3000, created_at: '2026-01-01T00:00:00Z' },
    ]);
    expect(rows.map((r) => r.status)).toEqual(['pending', 'canceled', 'expired']);
    expect(rows.every((r) => r.settled === false)).toBe(true);
    expect(rows[1].canceledAt).toBe('2026-01-02T01:00:00Z');
  });

  it('sorts newest first across both sources', () => {
    const rows = buildTransactionHistory(
      [{ id: 'pay-old', amount: 1, status: 'succeeded', created_at: '2026-01-01T00:00:00Z' }],
      [{ id: 'int-new', status: 'pending', amount_irr: 2, created_at: '2026-02-01T00:00:00Z' }],
    );
    expect(rows.map((r) => r.id)).toEqual(['int-new', 'pay-old']);
  });

  it('maps an unknown status conservatively (never leaks the raw enum)', () => {
    const [row] = buildTransactionHistory([], [{ id: 'x', status: 'weird_state', created_at: '2026-01-01T00:00:00Z' }]);
    expect(row.status).toBe('failed');
  });

  it('prefers the final (discounted) amount for an attempt', () => {
    const [row] = buildTransactionHistory([], [
      { id: 'x', status: 'pending', amount_irr: 10_000, final_amount_irr: 8_000, created_at: '2026-01-01T00:00:00Z' },
    ]);
    expect(row.amountIrr).toBe(8_000);
  });
});
