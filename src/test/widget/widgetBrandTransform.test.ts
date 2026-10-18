/**
 * scripts/build/widgetBrand.mjs's guards: the RESPOK build of a widget file
 * fails instead of shipping a reference to the local kit it removed
 * (a ReferenceError in visitors' browsers), and refuses malformed markers;
 * the same for the Iran build and the International-only kit (`@intl-kit`,
 * `INTL_KIT`). The shipped files themselves: widgetBrandBuild.test.ts.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { declaredNames, stripIntlKit, stripLocalKit, transformWidgetAsset } from '../../../scripts/build/widgetBrand.mjs';

describe('the widget brand transform', () => {
  const src = [
    'var LOCAL_KIT = true;',
    '/* @iran-kit:begin */',
    'var KIT_X = 1;',
    'function kitY() { return KIT_X; }',
    '/* @iran-kit:end */',
    'window.a = KIT_X;',
    'if (LOCAL_KIT) window.b = kitY();',
  ].join('\n');

  it('refuses a RESPOK file that still uses what a deleted block defined', () => {
    expect(() => transformWidgetAsset('x.js', src, 'respok')).toThrow(/KIT_X/);
  });

  it('drops the blocks and every LOCAL_KIT branch for RESPOK, keeps both elsewhere', () => {
    const ok = src.replace('window.a = KIT_X;\n', '');
    const respok = String(transformWidgetAsset('x.js', ok, 'respok'));
    expect(respok).not.toMatch(/KIT_X|kitY|LOCAL_KIT/);
    for (const brand of ['iran', 'both'] as const) {
      const out = String(transformWidgetAsset('x.js', ok, brand));
      expect(out).toContain('KIT_X');
      expect(out).toContain('kitY');
    }
  });

  // Hardened for issue #340: the guard used to read only the first name of
  // a declaration, so `var a = 1, b = 2;` left `b` unchecked.
  describe('every name a block declares is checked', () => {
    const block = (flag: 'LOCAL_KIT' | 'INTL_KIT', marker: 'iran' | 'intl', after: string) => [
      `var ${flag} = true;`,
      `/* @${marker}-kit:begin */`,
      'var KIT_A = 1, KIT_B = f(1, [2, 3]), KIT_C = "x, y; z", KIT_D = /[,;]/g, KIT_E;',
      'function kitF() { var local = 1, other = { p: 1, q: 2 }; return local + other.p; }',
      'var KIT_G = function () { var inner = 1, inner2 = 2; return inner + inner2; }, KIT_H = 2;',
      `/* @${marker}-kit:end */`,
      after,
    ].join('\n');

    it.each(['KIT_A', 'KIT_B', 'KIT_C', 'KIT_D', 'KIT_E', 'kitF', 'KIT_G', 'KIT_H'])('%s used outside its branch fails both builds', (name) => {
      expect(() => transformWidgetAsset('x.js', block('LOCAL_KIT', 'iran', `window.x = ${name};`), 'respok')).toThrow(new RegExp(`RESPOK build still uses ${name}`));
      expect(() => transformWidgetAsset('x.js', block('INTL_KIT', 'intl', `window.x = ${name};`), 'iran')).toThrow(new RegExp(`Iran build still uses ${name}`));
    });

    it('a function\'s own locals are not the code around\'s (the minifier renames them)', () => {
      expect(declaredNames(block('LOCAL_KIT', 'iran', '').split('\n').slice(2, 5).join('\n'), 'x.js'))
        .toEqual(['KIT_A', 'KIT_B', 'KIT_C', 'KIT_D', 'KIT_E', 'kitF', 'KIT_G', 'KIT_H']);
      const used = 'if (LOCAL_KIT) window.x = [KIT_A, KIT_B, KIT_C, KIT_D, KIT_E, kitF(), KIT_G(), KIT_H];';
      expect(String(transformWidgetAsset('x.js', block('LOCAL_KIT', 'iran', used), 'respok'))).not.toMatch(/KIT_|kitF/);
      expect(declaredNames('for (var i = 0, n = 2; i < n; i++) {}\nif (x) { var hoisted = 1, h2 = 2 }\nvar arrow = (a) => { var no = 1; return a; }, last = 1;'))
        .toEqual(['i', 'n', 'hoisted', 'h2', 'arrow', 'last']);
    });

    it('refuses a declaration it cannot read instead of guessing', () => {
      expect(() => declaredNames('var { a, b } = o;', 'x.js')).toThrow(/cannot read/);
      expect(() => transformWidgetAsset('x.js', 'var INTL_KIT = true;\n/* @intl-kit:begin */ var [a, b] = o; /* @intl-kit:end */', 'iran')).toThrow(/cannot read/);
    });
  });

  it('refuses unbalanced markers and a LOCAL_KIT without its switch', () => {
    expect(() => stripLocalKit('/* @iran-kit:begin */ var a;', 'x.js')).toThrow(/without/);
    expect(() => stripLocalKit('var a; /* @iran-kit:end */', 'x.js')).toThrow(/without/);
    expect(() => stripLocalKit('if (LOCAL_KIT) a();', 'x.js')).toThrow(/LOCAL_KIT/);
  });

  describe('the International-only kit (@intl-kit), the mirror for the Iran build', () => {
    const intl = [
      'var INTL_KIT = true;',
      '/* @intl-kit:begin */',
      'var RPK_X = 1;',
      'function rpkY() { return RPK_X; }',
      '/* @intl-kit:end */',
      'window.a = RPK_X;',
      'if (INTL_KIT) window.b = rpkY();',
    ].join('\n');

    it('refuses an Iran file that still uses what a deleted block defined', () => {
      expect(() => transformWidgetAsset('x.js', intl, 'iran')).toThrow(/Iran build still uses RPK_X/);
    });

    it('drops the blocks and every INTL_KIT branch for Iran, keeps both for RESPOK and both', () => {
      const ok = intl.replace('window.a = RPK_X;\n', '');
      const iran = String(transformWidgetAsset('x.js', ok, 'iran'));
      expect(iran).not.toMatch(/RPK_X|rpkY|INTL_KIT/);
      for (const brand of ['respok', 'both'] as const) {
        const out = String(transformWidgetAsset('x.js', ok, brand));
        expect(out).toContain('RPK_X');
        expect(out).toContain('rpkY');
      }
    });

    it('refuses unbalanced, stray or nested markers and an INTL_KIT without its switch, in every build', () => {
      expect(() => stripIntlKit('/* @intl-kit:begin */ var a;', 'x.js')).toThrow(/without/);
      expect(() => stripIntlKit('var a; /* @intl-kit:end */', 'x.js')).toThrow(/without/);
      expect(() => stripIntlKit('/* @intl-kit:begin */ /* @intl-kit:begin */ /* @intl-kit:end */', 'x.js')).toThrow(/nested/);
      expect(() => stripIntlKit('if (INTL_KIT) a();', 'x.js')).toThrow(/INTL_KIT/);
      expect(() => stripIntlKit('var INTL_KIT = true;\nvar INTL_KIT = true;', 'x.js')).toThrow(/more than once/);
      for (const brand of ['iran', 'respok', 'both'] as const) {
        expect(() => transformWidgetAsset('x.js', 'var a = 1; /* @intl-kit:end */', brand), brand).toThrow(/without/);
        expect(() => transformWidgetAsset('x.js', '/* @iran-kit:begin */ var a = 1;', brand), brand).toThrow(/without/);
        expect(() => transformWidgetAsset('x.css', '/* @intl-kit:begin */ .a { color: red; }', brand), brand).toThrow(/without/);
      }
    });

    it('the two kits do not mix: each build removes only the other region\'s', () => {
      const both = [
        'var LOCAL_KIT = true;', 'var INTL_KIT = true;',
        '/* @iran-kit:begin */', 'var IRAN_ONLY = 1;', '/* @iran-kit:end */',
        '/* @intl-kit:begin */', 'var INTL_ONLY = 2;', '/* @intl-kit:end */',
        'if (LOCAL_KIT) window.i = IRAN_ONLY;', 'if (INTL_KIT) window.n = INTL_ONLY;',
      ].join('\n');
      const iran = String(transformWidgetAsset('x.js', both, 'iran'));
      expect(iran).toContain('IRAN_ONLY');
      expect(iran).not.toContain('INTL_ONLY');
      const respok = String(transformWidgetAsset('x.js', both, 'respok'));
      expect(respok).toContain('INTL_ONLY');
      expect(respok).not.toContain('IRAN_ONLY');
    });
  });

  it('minifies CSS and leaves other files as they are', () => {
    expect(transformWidgetAsset('a.css', '/* note */\n.a { color: #ffffff; }\n', 'respok')).toBe('.a{color:#fff}\n');
    const bytes = Buffer.from([0, 1, 2]);
    expect(transformWidgetAsset('font.woff2', bytes, 'respok')).toBe(bytes);
  });
});
