/**
 * Section E/F language contract guard.
 *
 * Every invitation-related string must exist in en, fa and tr with the same
 * key set, and the invitation UI must not ship hardcoded English fallbacks.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';

const NAMESPACES = ['invitations', 'invite'] as const;

function flatten(obj: any, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object') return [prefix];
  return Object.entries(obj).flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k));
}

describe('invitation translation completeness', () => {
  for (const ns of NAMESPACES) {
    const base = flatten((en as any)[ns]).sort();

    it(`${ns} namespace exists in every locale`, () => {
      expect(base.length).toBeGreaterThan(10);
      expect((fa as any)[ns]).toBeTruthy();
      expect((tr as any)[ns]).toBeTruthy();
    });

    for (const [name, locale] of [['fa', fa], ['tr', tr]] as const) {
      it(`${ns} has no missing keys in ${name}`, () => {
        const keys = flatten((locale as any)[ns]).sort();
        expect(base.filter((k) => !keys.includes(k))).toEqual([]);
      });

      it(`${ns} has no empty or English-identical placeholders in ${name}`, () => {
        const walk = (a: any, b: any, path: string[] = []): string[] => {
          if (typeof a === 'string') {
            if (typeof b !== 'string' || b.trim() === '') return [path.join('.')];
            return [];
          }
          if (!a || typeof a !== 'object') return [];
          return Object.keys(a).flatMap((k) => walk(a[k], b?.[k], [...path, k]));
        };
        expect(walk((en as any)[ns], (locale as any)[ns])).toEqual([]);
      });
    }
  }

  it('InvitePage has no hardcoded English fallback helper', () => {
    const src = readFileSync('src/pages/auth/InvitePage.tsx', 'utf8');
    expect(src).not.toMatch(/\btt\(/);
    expect(src).not.toMatch(/\|\|\s*'[A-Z][a-z]+ [a-z]/);
  });
});
