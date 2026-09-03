/**
 * Generic Verification Core Super Admin UI — translation completeness
 * guard. Every string under admin.verification (and the admin.nav entry
 * that links to it) must exist, non-empty, in en/fa/tr with an identical
 * key set — mirrors the established invitationTranslationGuard.test.ts
 * pattern for the invitations UI.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';
import { LOCALE_CONFIG } from '@/i18n/config';

function flatten(obj: any, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object') return [prefix];
  return Object.entries(obj).flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k));
}

describe('Generic Verification Core admin UI — translation completeness', () => {
  const base = flatten((en as any).admin.verification).sort();

  it('admin.verification namespace is substantial and present in every locale', () => {
    expect(base.length).toBeGreaterThan(50);
    expect((fa as any).admin.verification).toBeTruthy();
    expect((tr as any).admin.verification).toBeTruthy();
  });

  it('admin.nav.verification exists in every locale', () => {
    expect((en as any).admin.nav.verification).toBeTruthy();
    expect((fa as any).admin.nav.verification).toBeTruthy();
    expect((tr as any).admin.nav.verification).toBeTruthy();
  });

  for (const [name, locale] of [['fa', fa], ['tr', tr]] as const) {
    it(`admin.verification has no missing or extra keys in ${name}`, () => {
      const keys = flatten((locale as any).admin.verification).sort();
      expect(keys.filter((k) => !base.includes(k))).toEqual([]);
      expect(base.filter((k) => !keys.includes(k))).toEqual([]);
    });

    it(`admin.verification has no empty placeholder strings in ${name}`, () => {
      const walk = (a: any, b: any, path: string[] = []): string[] => {
        if (typeof a === 'string') {
          if (typeof b !== 'string' || b.trim() === '') return [path.join('.')];
          return [];
        }
        if (!a || typeof a !== 'object') return [];
        return Object.keys(a).flatMap((k) => walk(a[k], b?.[k], [...path, k]));
      };
      expect(walk((en as any).admin.verification, (locale as any).admin.verification)).toEqual([]);
    });
  }

  it('fa is configured as RTL and tr/en as LTR (locale-correct direction for the preview and page)', () => {
    expect(LOCALE_CONFIG.fa.dir).toBe('rtl');
    expect(LOCALE_CONFIG.tr.dir).toBe('ltr');
    expect(LOCALE_CONFIG.en.dir).toBe('ltr');
  });

  it('VerificationPage.tsx has no hardcoded English fallback strings', () => {
    const src = readFileSync('src/pages/admin/VerificationPage.tsx', 'utf8');
    // Every user-facing label must go through t(...) — a bare capitalized
    // English phrase string literal (outside t() calls / translation keys)
    // would indicate a hardcoded fallback slipped in.
    expect(src).not.toMatch(/\|\|\s*'[A-Z][a-z]+ [a-z]/);
  });
});
