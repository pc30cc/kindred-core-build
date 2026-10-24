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
import { CHAT_TEMPLATE_LOGO_DIRECTIONS, CHAT_TEMPLATE_NAV_MODES, CHAT_TEMPLATE_NAV_STYLES, CHAT_TEMPLATE_TOPIC_ICONS } from '../../../shared/chatTemplateCatalog';

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

  it('the International skins over Templates 1 and 2: Classic and Simple, and the logo direction named in every locale', () => {
    expect(en.widgetCatalog.names).toMatchObject({ 't1-intl': 'Classic', 't2-intl': 'Simple' });
    expect(fa.widgetCatalog.names).toMatchObject({ 't1-intl': 'کلاسیک', 't2-intl': 'ساده' });
    expect(tr.widgetCatalog.names).toMatchObject({ 't1-intl': 'Klasik', 't2-intl': 'Sade' });
    for (const locale of [en, fa, tr]) {
      const c = locale.widgetCatalog;
      // Same layout, same description as the template it skins.
      expect(c.descriptions['t1-intl']).toBe(c.descriptions.t1);
      expect(c.descriptions['t2-intl']).toBe(c.descriptions.t2);
      expect(c.options.logoDirection).toBeTruthy();
      expect(c.options.logoDirectionHint).toBeTruthy();
      for (const v of CHAT_TEMPLATE_LOGO_DIRECTIONS) expect(c.options.logoDirections[v]).toBeTruthy();
      // The catalog is shared by both editions: neither brand's name in it.
      expect(strings(c).filter((text) => /respok|webyar|وب\s?یار/i.test(text))).toEqual([]);
    }
  });

  it('a description says what the template looks like, never what a site shows now (it shows under any card, in any state)', () => {
    for (const locale of [en, fa, tr]) {
      for (const text of Object.values(locale.widgetCatalog.descriptions as Record<string, string>)) {
        expect(text).not.toMatch(/today|امروز|bugün/i);
      }
    }
  });

  it('the history preview view is named in every locale, as the widget titles it', () => {
    for (const locale of [en, fa, tr]) expect(locale.widgetPage.preview.view.list).toBeTruthy();
    expect([en, fa, tr].map((l) => l.widgetPage.preview.view.list)).toEqual(['Previous conversations', 'گفتگوهای قبلی', 'Önceki sohbetler']);
  });

  it('t1\'s description names its bottom menu as the renderer draws it (its COPY: msgs, help)', () => {
    const src = readFileSync(resolve(process.cwd(), 'public/widget/presentation-t1.js'), 'utf8');
    for (const [code, locale] of [['en', en], ['fa', fa], ['tr', tr]] as const) {
      const [msgs, help] = src.match(new RegExp(`\\n\\s*${code}: '([^']*)'`))![1].split('|');
      for (const id of ['t1', 't1-intl'] as const) {
        const text = (locale.widgetCatalog.descriptions as Record<string, string>)[id];
        expect(text, `${code} ${id}`).toContain(msgs);
        expect(text, `${code} ${id}`).toContain(help);
      }
    }
  });

  it.each(files)('no hard-coded visible copy in %s', (path) => {
    expect(untranslated(path)).toEqual([]);
  });
});
