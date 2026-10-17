/**
 * The chat widget template catalog's copy (src/i18n/widgetCatalog.ts): the
 * same key tree in English, Persian and Turkish, a default name for every
 * template, no brand word, and no hard-coded visible text in the screens that
 * use it (Super Admin → Widget templates, Widget → Appearance → Widget
 * template, the template options).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import ts from 'typescript';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';
import { IRAN_BRAND_PATTERNS } from '../../../scripts/build/brandAudit.mjs';
import { CHAT_WIDGET_TEMPLATES } from '../../../shared/widgetTemplates';
import { CHAT_TEMPLATE_NAV_MODES, CHAT_TEMPLATE_NAV_STYLES, CHAT_TEMPLATE_TOPIC_ICONS } from '../../../shared/chatTemplateCatalog';

const files = [
  'src/components/admin/widget/WidgetCatalogSection.tsx',
  'src/components/app/widget/TemplateChoiceCard.tsx',
  'src/components/app/widget/TemplateOptionsFields.tsx',
  'src/components/app/widget/TemplateSketch.tsx',
];

const visibleProps = new Set(['label', 'title', 'description', 'placeholder', 'aria-label', 'alt', 'message']);

function leaves(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leaves(child, prefix ? `${prefix}.${key}` : key),
  );
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

function untranslated(path: string): string[] {
  const source = readFileSync(resolve(process.cwd(), path), 'utf8');
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const result: string[] = [];
  const add = (value: string) => {
    const text = value.replace(/\s+/g, ' ').trim();
    if (/[A-Za-z؀-ۿ]{2}/.test(text)) result.push(text);
  };
  const inspect = (node: ts.Node) => {
    if (ts.isJsxText(node)) add(node.text);
    if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)
      && visibleProps.has(node.name.getText(file))) add(node.initializer.text);
    ts.forEachChild(node, inspect);
  };
  file.forEachChild(inspect);
  return result;
}

describe('widget template catalog copy', () => {
  it('keeps the same key tree in every locale', () => {
    const expected = leaves(en.widgetCatalog).sort();
    expect(leaves(fa.widgetCatalog).sort()).toEqual(expected);
    expect(leaves(tr.widgetCatalog).sort()).toEqual(expected);
  });

  it('names and describes every template, every option value and icon', () => {
    for (const locale of [en, fa, tr]) {
      for (const id of Object.keys(CHAT_WIDGET_TEMPLATES)) {
        expect((locale.widgetCatalog.names as Record<string, string>)[id]).toBeTruthy();
        expect((locale.widgetCatalog.descriptions as Record<string, string>)[id]).toBeTruthy();
      }
      for (const v of CHAT_TEMPLATE_NAV_STYLES) expect(locale.widgetCatalog.options.navStyles[v]).toBeTruthy();
      for (const v of CHAT_TEMPLATE_NAV_MODES) expect(locale.widgetCatalog.options.navModes[v]).toBeTruthy();
      for (const v of CHAT_TEMPLATE_TOPIC_ICONS) expect(locale.widgetCatalog.options.icons[v]).toBeTruthy();
    }
  });

  it('the owner\'s default names, and no brand word anywhere', () => {
    expect(fa.widgetCatalog.names).toMatchObject({ default: 'آشنا', t1: 'فیروزه', t2: 'نسیم' });
    expect(en.widgetCatalog.names).toMatchObject({ default: 'Familiar', t1: 'Turquoise', t2: 'Breeze' });
    expect(tr.widgetCatalog.names).toMatchObject({ default: 'Tanıdık', t1: 'Turkuaz', t2: 'Esinti' });
    for (const locale of [en, fa, tr]) {
      const hits = strings(locale.widgetCatalog).filter((text) => IRAN_BRAND_PATTERNS.some((re: RegExp) => re.test(text)));
      expect(hits).toEqual([]);
    }
  });

  it('the Messages preview view is named in every locale', () => {
    for (const locale of [en, fa, tr]) expect(locale.widgetPage.preview.view.list).toBeTruthy();
  });

  it.each(files)('no hard-coded visible copy in %s', (path) => {
    expect(untranslated(path)).toEqual([]);
  });
});
