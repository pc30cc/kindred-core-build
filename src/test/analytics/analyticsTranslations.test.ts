/**
 * Every Analytics Storage string exists in all three locales, and no visible
 * copy was hardcoded into the components.
 *
 * Key parity is checked structurally (leaf paths must match exactly across
 * en/fa/tr), and the components are parsed so a literal that slipped into
 * JSX text or a user-facing attribute fails here rather than shipping as
 * English in a Persian or Turkish UI.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import ts from 'typescript';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';

const COMPONENTS = [
  'src/features/providers/AdminAnalyticsStoragePanel.tsx',
  'src/features/providers/AdminStorageSection.tsx',
];

/** Technical identifiers that are the same word in every language. */
const TECHNICAL_COPY = new Set(['Parquet', 'ZSTD', ':', '·', '—', '/']);

function leaves(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leaves(child, prefix ? `${prefix}.${key}` : key),
  );
}

function untranslated(path: string): string[] {
  const source = readFileSync(resolve(process.cwd(), path), 'utf8');
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const add = (value: string) => {
    const text = value.replace(/\s+/g, ' ').trim();
    if (/[A-Za-z]{2}/.test(text) && !TECHNICAL_COPY.has(text)) found.push(text);
  };
  const inspect = (node: ts.Node) => {
    if (ts.isJsxText(node)) add(node.text);
    if (
      ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)
      && ['placeholder', 'title', 'aria-label', 'alt'].includes(node.name.getText(file))
    ) {
      add(node.initializer.text);
    }
    ts.forEachChild(node, inspect);
  };
  file.forEachChild(inspect);
  return found;
}

describe('Analytics Storage localization', () => {
  it('has the identical key set in English, Persian and Turkish', () => {
    const expected = leaves(en.analyticsStorage).sort();
    expect(leaves(fa.analyticsStorage).sort()).toEqual(expected);
    expect(leaves(tr.analyticsStorage).sort()).toEqual(expected);
    expect(expected.length).toBeGreaterThan(70);
  });

  it('actually translates the strings rather than copying the English through', () => {
    // A handful of load-bearing strings, checked explicitly: key parity alone
    // would pass if fa/tr held English values.
    expect(fa.analyticsStorage.title).toBe('ذخیره‌سازی آنالیتیکس');
    expect(tr.analyticsStorage.title).toBe('Analitik Depolama');
    expect(en.analyticsStorage.title).toBe('Analytics Storage');

    for (const key of ['subtitle', 'independenceNote', 'credentialsNote'] as const) {
      expect(fa.analyticsStorage[key]).not.toBe(en.analyticsStorage[key]);
      expect(tr.analyticsStorage[key]).not.toBe(en.analyticsStorage[key]);
    }
  });

  it('keeps every interpolation placeholder in all three locales', () => {
    const placeholders = (value: string) => [...value.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
    const walk = (a: unknown, b: unknown, path: string) => {
      if (typeof a === 'string') {
        expect(placeholders(b as string), `placeholders differ at ${path}`).toEqual(placeholders(a));
        return;
      }
      if (!a || typeof a !== 'object') return;
      for (const [key, child] of Object.entries(a as Record<string, unknown>)) {
        walk(child, (b as Record<string, unknown>)[key], `${path}.${key}`);
      }
    };
    walk(en.analyticsStorage, fa.analyticsStorage, 'fa');
    walk(en.analyticsStorage, tr.analyticsStorage, 'tr');
  });

  it.each(COMPONENTS)('leaves no hardcoded visible copy in %s', (path) => {
    expect(untranslated(path)).toEqual([]);
  });
});
