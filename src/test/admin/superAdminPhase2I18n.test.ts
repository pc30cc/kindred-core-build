import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import ts from 'typescript';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';

const phaseFiles = [
  'src/pages/admin/SecurityPage.tsx',
  'src/pages/admin/SystemPage.tsx',
  'src/components/admin/observability/SystemDegradedBanner.tsx',
  'src/components/admin/observability/EffectivePolicyPanel.tsx',
];

function leafPaths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [prefix];
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key));
}

function visibleEnglishLiterals(path: string): string[] {
  const source = readFileSync(resolve(process.cwd(), path), 'utf8');
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      const text = node.text.replace(/\s+/g, ' ').trim();
      if (/[A-Za-z]{2}/.test(text)) found.push(text);
    }
    if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
      const visibleProps = ['placeholder', 'title', 'aria-label', 'label', 'description'];
      if (visibleProps.includes(node.name.getText(file)) && /[A-Za-z]{2}/.test(node.initializer.text)) {
        found.push(node.initializer.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found.filter(text => !['IP', 'RLS', 'CORS', 'RSS', 'ms', 'failover_epoch'].includes(text));
}

describe('Super Admin phase 2 localization', () => {
  it('keeps Security and System locale keys in exact parity', () => {
    for (const section of ['security', 'system'] as const) {
      const english = leafPaths(en.admin[section]).sort();
      expect(leafPaths(fa.admin[section]).sort()).toEqual(english);
      expect(leafPaths(tr.admin[section]).sort()).toEqual(english);
    }
  });

  it.each(phaseFiles)('%s contains no untranslated visible English copy', path => {
    expect(visibleEnglishLiterals(path)).toEqual([]);
  });
});
