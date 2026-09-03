import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import ts from 'typescript';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';

const files = [
  'src/pages/admin/MapGeoPage.tsx',
  'src/components/admin/MapTilesPreview.tsx',
];

const technicalCopy = new Set(['MaxMind Local', '8.8.8.8', '/api/admin/map-geo/*']);

function leaves(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leaves(child, prefix ? `${prefix}.${key}` : key),
  );
}

function untranslated(path: string): string[] {
  const source = readFileSync(resolve(process.cwd(), path), 'utf8');
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const result: string[] = [];
  const add = (value: string) => {
    const text = value.replace(/\s+/g, ' ').trim();
    if (/[A-Za-z]{2}/.test(text) && !technicalCopy.has(text)) result.push(text);
  };
  const inspect = (node: ts.Node) => {
    if (ts.isJsxText(node)) add(node.text);
    if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)
      && ['placeholder', 'title', 'aria-label', 'alt'].includes(node.name.getText(file))) {
      add(node.initializer.text);
    }
    ts.forEachChild(node, inspect);
  };
  file.forEachChild(inspect);
  return result;
}

describe('Super Admin phase 16 localization', () => {
  it('keeps every Super Admin translation key identical in all locales', () => {
    const expected = leaves(en.admin).sort();
    expect(leaves(fa.admin).sort()).toEqual(expected);
    expect(leaves(tr.admin).sort()).toEqual(expected);
    expect(expected.length).toBeGreaterThan(2000);
  });

  it.each(files)('removes visible hardcoded copy from %s', (path) => {
    expect(untranslated(path)).toEqual([]);
  });
});
