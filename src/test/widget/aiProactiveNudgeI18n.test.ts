/**
 * AI Proactive Nudge workspace UI — translation completeness guard.
 * Every string under widgetPage.smart.ai must exist, non-empty, in
 * en/fa/tr with an identical key set — mirrors the established
 * adminTranslationCompleteness.test.ts pattern.
 */
import { describe, it, expect } from 'vitest';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';

function flatten(obj: any, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object') return [prefix];
  return Object.entries(obj).flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k));
}

describe('AI Proactive Nudge UI — translation completeness', () => {
  const base = flatten((en as any).widgetPage.smart.ai).sort();

  it('widgetPage.smart.ai namespace is present and substantial in every locale', () => {
    expect(base.length).toBeGreaterThan(20);
    expect((fa as any).widgetPage.smart.ai).toBeTruthy();
    expect((tr as any).widgetPage.smart.ai).toBeTruthy();
  });

  for (const [name, locale] of [['fa', fa], ['tr', tr]] as const) {
    it(`widgetPage.smart.ai has no missing or extra keys in ${name}`, () => {
      const keys = flatten((locale as any).widgetPage.smart.ai).sort();
      expect(keys.filter((k) => !base.includes(k))).toEqual([]);
      expect(base.filter((k) => !keys.includes(k))).toEqual([]);
    });

    it(`widgetPage.smart.ai has no empty placeholder strings in ${name}`, () => {
      const walk = (a: any, b: any, path: string[] = []): string[] => {
        if (typeof a === 'string') {
          if (typeof b !== 'string' || b.trim() === '') return [path.join('.')];
          return [];
        }
        if (!a || typeof a !== 'object') return [];
        return Object.keys(a).flatMap((k) => walk(a[k], b?.[k], [...path, k]));
      };
      expect(walk((en as any).widgetPage.smart.ai, (locale as any).widgetPage.smart.ai)).toEqual([]);
    });
  }
});

describe('AI Proactive Nudge Super Admin controls — translation completeness', () => {
  const base = flatten((en as any).admin.aiAgentControl.proactive).sort();

  it('admin.aiAgentControl.proactive namespace is present and substantial in every locale', () => {
    expect(base.length).toBeGreaterThan(10);
    expect((fa as any).admin.aiAgentControl.proactive).toBeTruthy();
    expect((tr as any).admin.aiAgentControl.proactive).toBeTruthy();
  });

  for (const [name, locale] of [['fa', fa], ['tr', tr]] as const) {
    it(`admin.aiAgentControl.proactive has no missing or extra keys in ${name}`, () => {
      const keys = flatten((locale as any).admin.aiAgentControl.proactive).sort();
      expect(keys.filter((k) => !base.includes(k))).toEqual([]);
      expect(base.filter((k) => !keys.includes(k))).toEqual([]);
    });

    it(`admin.aiAgentControl.proactive has no empty placeholder strings in ${name}`, () => {
      const walk = (a: any, b: any, path: string[] = []): string[] => {
        if (typeof a === 'string') {
          if (typeof b !== 'string' || b.trim() === '') return [path.join('.')];
          return [];
        }
        if (!a || typeof a !== 'object') return [];
        return Object.keys(a).flatMap((k) => walk(a[k], b?.[k], [...path, k]));
      };
      expect(walk((en as any).admin.aiAgentControl.proactive, (locale as any).admin.aiAgentControl.proactive)).toEqual([]);
    });
  }
});
