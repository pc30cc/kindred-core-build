/**
 * scripts/build/widgetBrand.mjs's guards: the RESPOK build of a widget file
 * fails instead of shipping a reference to the local kit it removed
 * (a ReferenceError in visitors' browsers), and refuses malformed markers.
 * The shipped files themselves: widgetBrandBuild.test.ts.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { stripLocalKit, transformWidgetAsset } from '../../../scripts/build/widgetBrand.mjs';

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

  it('refuses unbalanced markers and a LOCAL_KIT without its switch', () => {
    expect(() => stripLocalKit('/* @iran-kit:begin */ var a;', 'x.js')).toThrow(/without/);
    expect(() => stripLocalKit('var a; /* @iran-kit:end */', 'x.js')).toThrow(/without/);
    expect(() => stripLocalKit('if (LOCAL_KIT) a();', 'x.js')).toThrow(/LOCAL_KIT/);
  });

  it('minifies CSS and leaves other files as they are', () => {
    expect(transformWidgetAsset('a.css', '/* note */\n.a { color: #ffffff; }\n', 'respok')).toBe('.a{color:#fff}\n');
    const bytes = Buffer.from([0, 1, 2]);
    expect(transformWidgetAsset('font.woff2', bytes, 'respok')).toBe(bytes);
  });
});
