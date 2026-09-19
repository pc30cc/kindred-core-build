/**
 * Every translation key the Branding page asks for must exist.
 *
 * TypeScript does NOT check this, which is easy to assume it does. `t()` is
 * declared as `(key: TranslationKey, ...)` where `TranslationKey` is
 * `NestedKeyOf<TranslationKeys>` — a recursive mapped type over the whole
 * English locale. On an object that size TypeScript gives up and widens the
 * result, so `t('this.key.does.not.exist')` compiles without complaint. It was
 * verified: a deliberately invented key passes `tsc` clean.
 *
 * That matters here because this page used to wrap all 137 of its `t()` calls
 * in `as any`, and those casts were removed. The casts turned out to be
 * unnecessary — but a green typecheck was never the evidence, since the
 * compiler would have accepted a typo just as happily. This test is the
 * evidence: it resolves each key against the real locale object.
 *
 * `getNestedValue` in src/i18n/index.tsx falls back to returning the key
 * itself when a lookup misses, so a missing key does not throw — it renders
 * `admin.brandingPage.emailSettings.replyToEmailHint` at the user. Silent, and
 * only visible to someone looking at that exact screen in that exact state.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';

const PAGE = 'src/pages/admin/BrandingPage.tsx';

/** Resolves a dotted path to a string leaf, the way the i18n lookup does. */
function resolves(locale: unknown, path: string): boolean {
  let current: unknown = locale;
  for (const part of path.split('.')) {
    if (current == null || typeof current !== 'object') return false;
    current = (current as Record<string, unknown>)[part];
    if (current === undefined) return false;
  }
  return typeof current === 'string';
}

/**
 * Literal keys only. Template-literal calls like
 * t(`admin.brandingPage.domains.fields.${f.key}.label`) are resolved from a
 * runtime value and cannot be checked statically without evaluating the page.
 */
function literalKeys(source: string): string[] {
  return [...new Set([...source.matchAll(/\bt\('([^']+)'/g)].map((m) => m[1]))];
}

describe('BrandingPage translation keys', () => {
  const keys = literalKeys(readFileSync(PAGE, 'utf8'));

  it('finds the keys it is meant to check', () => {
    // A guard on the guard: if the page stops using `t('…')` literals, this
    // test would pass by checking nothing.
    expect(keys.length).toBeGreaterThan(50);
  });

  it('every key resolves in the English locale', () => {
    expect(keys.filter((k) => !resolves(en, k))).toEqual([]);
  });

  it('every key resolves in Persian and Turkish too', () => {
    // A key present only in English renders the raw dotted path to anyone who
    // is not reading the app in English.
    expect(keys.filter((k) => !resolves(fa, k))).toEqual([]);
    expect(keys.filter((k) => !resolves(tr, k))).toEqual([]);
  });

  it('no `as any` cast has come back to hide a missing key', () => {
    expect(readFileSync(PAGE, 'utf8')).not.toMatch(/t\((?:'[^']*'|`[^`]*`)\s+as any/);
  });
});
