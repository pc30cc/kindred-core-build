import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import ts from 'typescript';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';

const path = 'src/pages/admin/BrandingPage.tsx';
const coveredFunctions = new Set(['VisualIdentitySection', 'DomainUrlsSection', 'AdminBrandingPage']);
const technicalCopy = new Set([
  'https://cdn.example.com/logo.svg',
  'https://cdn.example.com/favicon.ico',
  'https://cdn.example.com/pwa-icon.png',
]);

function leaves(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leaves(child, prefix ? `${prefix}.${key}` : key),
  );
}

function untranslated(): string[] {
  const source = readFileSync(resolve(process.cwd(), path), 'utf8');
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const result: string[] = [];
  const inspect = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      const text = node.text.replace(/\s+/g, ' ').trim();
      if (/[A-Za-z]{2}/.test(text)) result.push(text);
    }
    if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
      const visibleAttributes = ['placeholder', 'title', 'aria-label', 'alt', 'label', 'description'];
      if (visibleAttributes.includes(node.name.getText(file)) && /[A-Za-z]{2}/.test(node.initializer.text)) {
        result.push(node.initializer.text);
      }
    }
    ts.forEachChild(node, inspect);
  };
  file.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name && coveredFunctions.has(node.name.text)) inspect(node);
  });
  return result.filter((text) => !technicalCopy.has(text));
}

describe('Super Admin phase 13 localization', () => {
  it('keeps branding page keys identical in all locales', () => {
    const expected = leaves(en.admin.brandingPage).sort();
    expect(leaves(fa.admin.brandingPage).sort()).toEqual(expected);
    expect(leaves(tr.admin.brandingPage).sort()).toEqual(expected);
  });

  it('localizes the branding shell, identity and domain sections', () => {
    expect(untranslated()).toEqual([]);
  });
});
