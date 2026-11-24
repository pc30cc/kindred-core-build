/**
 * The chat runtime in one language (scripts/build/runtimeLocales.mjs).
 *
 * runtime.js carries its dictionary in every language the widget speaks,
 * though a widget speaks one for the whole page view. The build also ships
 * runtime-<id>.js, the same file with that language's block only (English
 * as an empty block: the fallback's name), and /config names the one the
 * widget speaks (server/services/widget/manifest.ts).
 *
 * What must hold:
 *  - every language has every English key, so the empty fallback is never
 *    read;
 *  - each one-language runtime says exactly what the full one says in that
 *    language, for every key, and is a valid script once shipped;
 *  - the server's list of languages and its reading of a body's language
 *    are the runtime's;
 *  - /config names a one-language file only when the build made it.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { gzipSync } from 'node:zlib';
import { JSDOM } from 'jsdom';
import { runtimeForLocale, runtimeLocales } from '../../../scripts/build/runtimeLocales.mjs';
import { transformWidgetAsset } from '../../../scripts/build/widgetBrand.mjs';
import { RUNTIME_LOCALES, runtimeAssetNameFor, runtimeDictLocale } from '../../../server/services/widget/manifest';

const SOURCE = readFileSync(resolve(process.cwd(), 'public/widget/runtime.js'), 'utf8');
type Dict = Record<string, Record<string, string>>;
interface I18n { t(locale: string, key: string): string }

/** runtime.js's I18n module, run on its own (a closure over its `dict`). */
function i18nOf(code: string): I18n {
  const a = code.indexOf('  var I18n = (function () {');
  const b = code.indexOf('\n  })();', a) + '\n  })();'.length;
  expect(a, 'the I18n module').toBeGreaterThan(-1);
  return vm.runInNewContext(`${code.slice(a, b)}; I18n`) as I18n;
}
function dictOf(code: string): Dict {
  const a = code.indexOf('var dict = ');
  const b = code.indexOf('\n    return {\n      t: function (locale, key) {', a);
  return vm.runInNewContext(`${code.slice(a, b)}; dict`) as Dict;
}

const FULL = dictOf(SOURCE);
const FULL_I18N = i18nOf(SOURCE);

describe('the dictionary', () => {
  it('has the languages the server knows, English first', () => {
    expect(runtimeLocales(SOURCE)).toEqual([...RUNTIME_LOCALES]);
    expect(Object.keys(FULL)).toEqual([...RUNTIME_LOCALES]);
  });

  it('every language has every English key, never empty', () => {
    for (const locale of RUNTIME_LOCALES) {
      for (const key of Object.keys(FULL.en)) expect(FULL[locale][key], `${locale}.${key}`).toMatch(/\S/);
      expect(Object.keys(FULL[locale]).sort(), locale).toEqual(Object.keys(FULL.en).sort());
    }
  });
});

describe('the runtime in one language', () => {
  for (const locale of RUNTIME_LOCALES) {
    describe(locale, () => {
      const variant = runtimeForLocale(SOURCE, locale);

      it('carries that language only (English as an empty block, unless it is English)', () => {
        const d = dictOf(variant);
        expect(Object.keys(d).sort()).toEqual([...new Set(['en', locale])].sort());
        if (locale !== 'en') expect(d.en).toEqual({});
        expect(d[locale]).toEqual(FULL[locale]);
      });

      it('says what the full runtime says, for every key, with or without a region tag', () => {
        const t = i18nOf(variant);
        for (const key of [...Object.keys(FULL.en), 'no-such-key']) {
          for (const tag of [locale, `${locale}-XX`, locale.toUpperCase()]) {
            expect(t.t(tag, key), `${tag}.${key}`).toBe(FULL_I18N.t(tag, key));
          }
        }
      });

      it('is the same file but for the other languages\' blocks', () => {
        const lines = variant.split('\n');
        const kept = new Set(lines);
        // Everything before and after the dictionary is there as it was.
        const before = SOURCE.slice(0, SOURCE.indexOf('      // @locale en'));
        const after = SOURCE.slice(SOURCE.indexOf('      // @locale-end'));
        expect(variant.startsWith(before)).toBe(true);
        expect(variant.endsWith(after)).toBe(true);
        expect(kept.has('      // @locale-end')).toBe(true);
      });

      it('ships in both builds: a valid script, smaller than the full one', () => {
        for (const brand of ['iran', 'respok'] as const) {
          const shipped = transformWidgetAsset('runtime.js', Buffer.from(variant, 'utf8'), brand) as string;
          const full = transformWidgetAsset('runtime.js', Buffer.from(SOURCE, 'utf8'), brand) as string;
          expect(() => new vm.Script(shipped), brand).not.toThrow();
          expect(gzipSync(shipped).length, brand).toBeLessThan(gzipSync(full).length - 3000);
        }
      });

      it('runs in a page: the runtime registers and speaks its language', () => {
        const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://shop.example/', runScripts: 'outside-only' });
        try {
          const win = dom.window as unknown as { eval(src: string): void; __gs_runtime: { init: unknown; t: (l: string, k: string) => string } };
          win.eval(variant);
          expect(typeof win.__gs_runtime.init).toBe('function');
          expect(win.__gs_runtime.t(locale, 'chat')).toBe(FULL[locale].chat);
        } finally {
          dom.window.close();
        }
      });
    });
  }

  it('refuses a file whose blocks it cannot cut', () => {
    expect(() => runtimeForLocale(SOURCE, 'de')).toThrow(/no @locale de/);
    expect(() => runtimeLocales('var x = 1;')).toThrow(/no @locale block/);
    expect(() => runtimeLocales('// @locale fa\n// @locale-end')).toThrow(/no @locale en/);
    expect(() => runtimeLocales('// @locale en\nx')).toThrow(/no @locale-end/);
    expect(() => runtimeLocales('// @locale en\n// @locale en\n// @locale-end')).toThrow(/twice/);
    expect(() => runtimeLocales('// @locale en\n// @locale-end\n// @locale-end')).toThrow(/stray/);
  });
});

describe('the language a /config body makes the runtime speak', () => {
  it('is read the way runtime.js reads it', () => {
    // runtime.js init (resolvedLocale) and I18n.t, as manifest.ts mirrors them.
    expect(SOURCE).toContain("if (typeof wl === 'string' && wl && wl !== 'auto') return wl;\n       return config.locale || 'en';");
    expect(SOURCE).toContain("var l = dict[locale] ? locale : (dict[base] ? base : 'en');");
    const cases: Array<[unknown, unknown, string]> = [
      ['auto', 'fa', 'fa'], [undefined, 'fa', 'fa'], ['tr', 'fa', 'tr'], ['auto', 'fa-IR', 'fa'], ['FA', 'en', 'fa'],
      ['auto', '', 'en'], ['auto', 'ar', 'en'], [null, null, 'en'], ['', 'tr', 'tr'], ['auto', 'en-US', 'en'], [5, 'tr', 'tr'],
    ];
    for (const [widgetLanguage, locale, want] of cases) {
      expect(runtimeDictLocale(widgetLanguage, locale), `${String(widgetLanguage)} / ${String(locale)}`).toBe(want);
      // The runtime's own choice from the same body.
      const wl = widgetLanguage;
      const resolved = typeof wl === 'string' && wl && wl !== 'auto' ? wl : (locale as string) || 'en';
      expect(FULL_I18N.t(resolved, 'chat'), `${String(widgetLanguage)} / ${String(locale)}`).toBe(FULL[want].chat);
    }
  });

  it('names the build\'s one-language runtime, else the full one', () => {
    const built = { 'runtime.js': 'runtime.b41263a8.js', 'runtime-fa.js': 'runtime-fa.bce6b77d.js', 'runtime-en.js': 'runtime-en.2f512111.js' };
    expect(runtimeAssetNameFor(built, 'fa')).toBe('runtime-fa.bce6b77d.js');
    expect(runtimeAssetNameFor(built, 'en')).toBe('runtime-en.2f512111.js');
    // A build without that language's file, or from before them.
    expect(runtimeAssetNameFor(built, 'tr')).toBe('runtime.b41263a8.js');
    expect(runtimeAssetNameFor({ 'runtime.js': 'runtime.b41263a8.js' }, 'fa')).toBe('runtime.b41263a8.js');
    // An unhashed name is a backend that cannot see the build: never a one-language file.
    expect(runtimeAssetNameFor({ 'runtime.js': 'runtime.js', 'runtime-fa.js': 'runtime-fa.js' }, 'fa')).toBe('runtime.js');
    expect(runtimeAssetNameFor({}, 'fa')).toBe('runtime.js');
  });
});
