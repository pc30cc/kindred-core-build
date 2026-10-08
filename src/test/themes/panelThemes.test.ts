/**
 * Workspace panel themes (src/themes, shared/panelThemes.ts).
 *
 * The promises this checks:
 *   - Classic is untouched: routing Tailwind's palette through CSS variables
 *     gives every class exactly Tailwind's own colour, and no theme rule can
 *     apply unless <html> carries that theme's attribute.
 *   - Every theme the server accepts is listed, previewable and translated in
 *     all three languages.
 *   - The stored value is validated: unknown values fall back to Classic, and
 *     the database's own check accepts every theme id.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import tailwindColors from 'tailwindcss/colors';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';
import {
  PALETTE_FAMILIES,
  PALETTE_SHADES,
  hexToRgb,
  paletteColors,
  paletteVariables,
  rgbToLch,
} from '@/themes/palette';
import { artPalette } from '@/themes/art/palette';
import { panelThemes } from '@/themes/registry';
import {
  DEFAULT_PANEL_THEME,
  PANEL_THEME_IDS,
  isPanelThemeId,
  resolvePanelTheme,
} from '../../../shared/panelThemes';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const hexOf = (family: string, shade: string) =>
  (tailwindColors as unknown as Record<string, Record<string, string>>)[family][shade];
const channels = (hex: string) => hexToRgb(hex).map((x) => Math.round(x * 255)).join(' ');

describe('theme ids', () => {
  it('Classic is the default and anything unknown falls back to it', () => {
    expect(DEFAULT_PANEL_THEME).toBe('classic');
    expect(PANEL_THEME_IDS).toEqual(expect.arrayContaining(['classic', 'art']));
    expect(resolvePanelTheme('art')).toBe('art');
    for (const value of [undefined, null, '', 'ART', 'neon', 42, {}]) {
      expect(isPanelThemeId(value)).toBe(false);
      expect(resolvePanelTheme(value)).toBe('classic');
    }
  });

  it('migration 253 defaults to classic and its check accepts every theme id', () => {
    const sql = read('database/migrations/253_workspace_panel_theme.sql');
    expect(sql).toMatch(/workspace_panel_theme text NOT NULL DEFAULT 'classic'/);
    const check = /workspace_panel_theme ~ '([^']+)'/.exec(sql);
    expect(check).not.toBeNull();
    const pattern = new RegExp(check![1]);
    for (const id of PANEL_THEME_IDS) expect(pattern.test(id)).toBe(true);
  });

  it('the public config hands the theme to every member', () => {
    expect(read('server/services/platformPublicConfig.ts')).toMatch(/'workspace_panel_theme'/);
  });
});

describe('palette', () => {
  it('Classic: every variable is exactly Tailwind’s own colour', () => {
    const vars = paletteVariables();
    for (const family of PALETTE_FAMILIES) {
      for (const shade of PALETTE_SHADES) {
        expect(vars[`--palette-${family}-${shade}`]).toBe(channels(hexOf(family, shade)));
      }
    }
  });

  it('every shade is routed through its variable with Tailwind’s opacity slot', () => {
    expect(paletteColors.sky['500']).toBe('rgb(var(--palette-sky-500) / <alpha-value>)');
    expect(Object.keys(paletteColors)).toHaveLength(PALETTE_FAMILIES.length);
  });

  it('Art repaints the hues, keeps their lightness and stays in sRGB', () => {
    const vars = paletteVariables(artPalette);
    for (const family of PALETTE_FAMILIES) {
      for (const shade of PALETTE_SHADES) {
        const value = vars[`--palette-${family}-${shade}`];
        const rgb = value.split(' ').map(Number);
        expect(rgb).toHaveLength(3);
        for (const c of rgb) expect(c >= 0 && c <= 255).toBe(true);
        const original = rgbToLch(hexToRgb(hexOf(family, shade)));
        const art = rgbToLch(rgb.map((c) => c / 255) as [number, number, number]);
        expect(Math.abs(art.l - original.l)).toBeLessThan(0.02);
        expect(art.c).toBeLessThanOrEqual(original.c + 0.002);
      }
    }
    expect(vars['--palette-sky-500']).not.toBe(channels(hexOf('sky', '500')));
  });

  it('Art turns the cool grays into a warm paper gray', () => {
    const slate = rgbToLch(hexToRgb('#' + paletteVariables(artPalette)['--palette-slate-500']
      .split(' ')
      .map((c) => Number(c).toString(16).padStart(2, '0'))
      .join('')));
    expect(slate.h).toBeGreaterThan(40);
    expect(slate.h).toBeLessThan(100);
    expect(slate.c).toBeLessThan(0.02);
  });
});

/** A selector list split on its top-level commas (`:is(a, b)` stays one selector). */
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of list) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
    } else current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

describe('the Art stylesheets', () => {
  const FILES = [
    'src/themes/art/theme.css',
    'src/themes/art/components.css',
    'src/themes/art/pages.css',
    'src/themes/art/inbox.css',
    'src/themes/art/sidebar.css',
    'src/themes/art/palettes.css',
    'src/themes/art/charts.css',
  ];
  const strip = (path: string) => read(path).replace(/\/\*[\s\S]*?\*\//g, '');
  const css = strip('src/themes/art/theme.css');

  it.each(FILES)('%s applies only under <html data-panel-theme="art">', (path) => {
    const selectors: string[] = [];
    // Every rule's selector list, inside or outside @media; @keyframes steps are not selectors.
    const source = strip(path).replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
    const rule = /([^{}@;]+)\{[^{}]*\}/g;
    for (let m = rule.exec(source); m; m = rule.exec(source)) {
      selectors.push(...splitSelectors(m[1]));
    }
    expect(selectors.length).toBeGreaterThan(5);
    for (const selector of selectors) {
      expect(selector.startsWith(':root[data-panel-theme="art"]'), selector).toBe(true);
    }
  });

  it('defines the panel tokens for light and dark', () => {
    for (const token of ['--background', '--primary', '--sidebar-background', '--card', '--border', '--ring']) {
      expect(css.match(new RegExp(`\\s${token}:`, 'g'))?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
    expect(css).toContain(':root[data-panel-theme="art"].dark {');
  });

  it('is loaded by the app', () => {
    const main = read('src/main.tsx');
    for (const path of FILES) expect(main).toContain(`import "./${path.replace('src/', '')}";`);
  });
});

describe('the themes on Super Admin → Panel theme', () => {
  it('lists every theme the server accepts, once, in order', () => {
    expect(panelThemes.map((t) => t.id)).toEqual([...PANEL_THEME_IDS]);
  });

  it.each([
    ['en', en],
    ['fa', fa],
    ['tr', tr],
  ])('is fully translated (%s)', (_locale, messages) => {
    const page = messages.admin.panelThemes as unknown as Record<string, unknown> & {
      themes: Record<string, Record<string, string>>;
    };
    for (const id of PANEL_THEME_IDS) {
      for (const key of ['name', 'description', 'trait1', 'trait2', 'trait3']) {
        expect(page.themes[id]?.[key], `${id}.${key}`).toBeTruthy();
      }
    }
    expect(messages.admin.nav.panelTheme).toBeTruthy();
    expect(messages.interface.themeNotice).toContain('{{name}}');
    expect(messages.admin.panelThemes.preview.banner).toContain('{{name}}');
  });
});
