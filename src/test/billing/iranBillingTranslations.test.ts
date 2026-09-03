/**
 * Phase 15 — fa translation completeness for the Iran billing redesign.
 *
 * The Iran-native billing page is Persian-only in production (region
 * 'iran' forces locale 'fa'), but `t()`'s key type is derived from en.ts, so
 * every `billingIran.*` key used by the Iran page must exist, with real
 * (non-empty) text, in all three locale files — a missing key would either
 * fail to compile or silently fall back to English/the raw key at runtime.
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

describe('billingIran translation completeness', () => {
  const enKeys = leafKeys((en as any).billingIran).sort();

  it('en.billingIran has a non-trivial key set', () => {
    expect(enKeys.length).toBeGreaterThan(20);
  });

  it('fa carries every billingIran key with non-empty Persian text', () => {
    const faKeys = leafKeys((fa as any).billingIran).sort();
    expect(faKeys).toEqual(enKeys);
    for (const key of enKeys) {
      const value = key.split('.').reduce((o, k) => o?.[k], (fa as any).billingIran);
      expect(typeof value).toBe('string');
      expect((value as string).trim().length).toBeGreaterThan(0);
    }
  });

  it('tr carries every billingIran key (parity, even though Iran forces fa)', () => {
    const trKeys = leafKeys((tr as any).billingIran).sort();
    expect(trKeys).toEqual(enKeys);
  });

  it('fa strings contain Persian script, not leftover English placeholders', () => {
    const sample = (fa as any).billingIran.pageTitle as string;
    expect(sample).toMatch(/[؀-ۿ]/);
  });
});
