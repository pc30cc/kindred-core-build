/**
 * Translation completeness for the workspace billing screens (simple billing;
 * billing v2's overview, invoice, wallet and transaction tabs and their keys
 * were removed in phase 7A).
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

type Tree = { [key: string]: unknown };

function leafKeys(obj: unknown, prefix = ''): string[] {
  return Object.entries(obj as Tree).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) return leafKeys(v, path);
    return [path];
  });
}

function valueAt(root: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((o, k) => (o as Tree | undefined)?.[k], root);
}

const billingOf = (locale: unknown) => (locale as { billing: Tree }).billing;

describe('billing translation completeness', () => {
  const enRoot = billingOf(en);
  const enKeys = leafKeys(enRoot).sort();

  it('en.billing covers the simple billing sections, and billing v2\'s are gone', () => {
    for (const section of ['account', 'locks', 'plans', 'common']) {
      expect(enRoot[section], `missing section ${section}`).toBeTruthy();
    }
    for (const section of ['overview', 'invoices', 'wallet', 'ai', 'transactions', 'checkout', 'errors']) {
      expect(enRoot[section], `leftover v2 section ${section}`).toBeUndefined();
    }
    expect(enKeys.length).toBeGreaterThan(80);
  });

  it('fa carries every key with non-empty Persian text', () => {
    expect(leafKeys(billingOf(fa)).sort()).toEqual(enKeys);
    for (const key of enKeys) {
      const value = valueAt(billingOf(fa), key);
      expect(typeof value, key).toBe('string');
      expect((value as string).trim().length, key).toBeGreaterThan(0);
    }
  });

  it('tr carries every key', () => {
    expect(leafKeys(billingOf(tr)).sort()).toEqual(enKeys);
    for (const key of enKeys) {
      expect(typeof valueAt(billingOf(tr), key), key).toBe('string');
    }
  });
});
