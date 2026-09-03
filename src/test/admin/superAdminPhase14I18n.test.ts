import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import ts from 'typescript';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';

const files = [
  'src/pages/admin/BrandingPage.tsx',
  'src/components/admin/EmailTemplatesTab.tsx',
];

const technicalCopy = new Set([
  '#3B82F6',
  '#6366F1',
  'UTC',
  '<html>...</html>',
  'https://cdn.example.com/logo.svg',
  'https://cdn.example.com/favicon.ico',
  'https://cdn.example.com/pwa-icon.png',
  'https://cdn.example.com/email-logo.png',
  'noreply@example.com',
  'support@example.com',
]);

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
  file.forEachChild(inspect);
  return result.filter((text) => !technicalCopy.has(text));
}

describe('Super Admin phase 14 localization', () => {
  it('keeps the complete branding and email key tree identical in all locales', () => {
    const expected = leaves(en.admin.brandingPage).sort();
    expect(leaves(fa.admin.brandingPage).sort()).toEqual(expected);
    expect(leaves(tr.admin.brandingPage).sort()).toEqual(expected);
  });

  it.each(files)('removes visible hardcoded copy from %s', (path) => {
    expect(untranslated(path)).toEqual([]);
  });

  it('keeps the email template preview fully sandboxed', () => {
    const source = readFileSync(resolve(process.cwd(), files[1]), 'utf8');
    expect(source).toContain('sandbox=""');
    expect(source).not.toMatch(/sandbox="[^"]*allow-/);
  });
});
