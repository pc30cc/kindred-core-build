/**
 * Phase D — translation completeness for the Billing V2 workspace screens.
 *
 * `t()`'s key type is derived from en.ts, so a key that exists in English but
 * is missing in fa would silently render English text on a Persian-only
 * financial page. Money screens are the worst possible place for that, so the
 * three locales must stay in exact parity.
 */
import { describe, it, expect } from 'vitest';
import en from '../../i18n/locales/en';
import fa from '../../i18n/locales/fa';
import tr from '../../i18n/locales/tr';

function leafKeys(obj: any, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) return leafKeys(v, path);
    return [path];
  });
}

function valueAt(root: any, key: string) {
  return key.split('.').reduce((o, k) => o?.[k], root);
}

describe('billingV2 translation completeness', () => {
  const enRoot = (en as any).billingV2;
  const enKeys = leafKeys(enRoot).sort();

  it('en.billingV2 covers all six sections', () => {
    for (const section of ['overview', 'invoices', 'plans', 'wallet', 'ai', 'transactions']) {
      expect(enRoot[section], `missing section ${section}`).toBeTruthy();
    }
    expect(enKeys.length).toBeGreaterThan(80);
  });

  it('fa carries every key with non-empty Persian text', () => {
    expect(leafKeys((fa as any).billingV2).sort()).toEqual(enKeys);
    for (const key of enKeys) {
      const value = valueAt((fa as any).billingV2, key);
      expect(typeof value, key).toBe('string');
      expect((value as string).trim().length, key).toBeGreaterThan(0);
    }
  });

  it('tr carries every key', () => {
    expect(leafKeys((tr as any).billingV2).sort()).toEqual(enKeys);
    for (const key of enKeys) {
      expect(typeof valueAt((tr as any).billingV2, key), key).toBe('string');
    }
  });

  it('every backend invoice status has a translated label in all locales', () => {
    const statuses = ['draft', 'open', 'partially_paid', 'paid', 'past_due', 'void', 'expired', 'refunded'];
    for (const root of [en, fa, tr]) {
      for (const s of statuses) {
        expect((root as any).billingV2.invoices.statuses[s], s).toBeTruthy();
      }
    }
  });

  it('every transaction status and purchase type has a label', () => {
    const statuses = ['pending', 'processing', 'succeeded', 'canceled', 'failed', 'expired', 'refunded', 'review'];
    const purchases = ['subscription', 'ai_credit_topup', 'wallet_deposit'];
    for (const root of [en, fa, tr]) {
      for (const s of statuses) expect((root as any).billingV2.transactions.statuses[s], s).toBeTruthy();
      for (const p of purchases) expect((root as any).billingV2.transactions.purchase[p], p).toBeTruthy();
    }
  });

  it('every wallet ledger entry type has a label (no raw DB enum can leak)', () => {
    const types = ['deposit', 'invoice_payment', 'refund', 'credit', 'debit', 'admin_adjustment', 'chargeback'];
    for (const root of [en, fa, tr]) {
      for (const type of types) expect((root as any).billingV2.wallet.entryTypes[type], type).toBeTruthy();
    }
  });

  it('annual plans describe AI credit as a monthly release, never a yearly lump sum', () => {
    expect((en as any).billingV2.plans.aiMonthly).toContain('per month');
    expect((fa as any).billingV2.plans.aiMonthly).toContain('ماهانه');
    expect((fa as any).billingV2.overview.annualNote).toContain('ماه');
  });
});
