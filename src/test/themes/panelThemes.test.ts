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
    expect(PANEL_THEME_IDS).toEqual(expect.arrayContaining(['classic', 'art', 'vivid']));
    expect(resolvePanelTheme('vivid')).toBe('vivid');
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

  // Art's shared stylesheets apply to the Art family (Art, and Vivid drawn
  // by it); Art's own colour schemes to Art alone. Both selectors have the
  // same specificity, so Art wears exactly what it wore before the family.
  const ownScope = (path: string) =>
    path.endsWith('/palettes.css') ? ':root[data-panel-theme="art"]' : ':root[data-panel-family="art"]';

  it.each(FILES)('%s applies only under <html data-panel-family="art"> (palettes: data-panel-theme="art")', (path) => {
    const selectors: string[] = [];
    // Every rule's selector list, inside or outside @media; @keyframes steps are not selectors.
    const source = strip(path).replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
    const rule = /([^{}@;]+)\{[^{}]*\}/g;
    for (let m = rule.exec(source); m; m = rule.exec(source)) {
      selectors.push(...splitSelectors(m[1]));
    }
    expect(selectors.length).toBeGreaterThan(5);
    for (const selector of selectors) {
      expect(selector.startsWith(ownScope(path)), selector).toBe(true);
    }
  });

  it('keys no shared rule to Art alone, and no colour scheme to the family', () => {
    for (const path of FILES) {
      const other = path.endsWith('/palettes.css') ? 'data-panel-family' : 'data-panel-theme';
      expect(strip(path), path).not.toContain(other);
    }
  });

  it('defines the panel tokens for light and dark', () => {
    for (const token of ['--background', '--primary', '--sidebar-background', '--card', '--border', '--ring']) {
      expect(css.match(new RegExp(`\\s${token}:`, 'g'))?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
    expect(css).toContain(':root[data-panel-family="art"].dark {');
  });

  it('is loaded by the app', () => {
    const main = read('src/main.tsx');
    for (const path of FILES) expect(main).toContain(`import "./${path.replace('src/', '')}";`);
  });
});

describe('the Vivid stylesheets', () => {
  const FILES = ['src/themes/vivid/theme.css', 'src/themes/vivid/palettes.css'];
  const strip = (path: string) => read(path).replace(/\/\*[\s\S]*?\*\//g, '');
  const css = strip('src/themes/vivid/theme.css');
  const selectorsOf = (path: string) => {
    const selectors: string[] = [];
    const rule = /([^{}@;]+)\{[^{}]*\}/g;
    const source = strip(path);
    for (let m = rule.exec(source); m; m = rule.exec(source)) selectors.push(...splitSelectors(m[1]));
    return selectors;
  };

  it.each(FILES)('%s applies only under <html data-panel-theme="vivid">', (path) => {
    const selectors = selectorsOf(path);
    expect(selectors.length).toBeGreaterThan(5);
    for (const selector of selectors) {
      expect(selector.startsWith(':root[data-panel-theme="vivid"]'), selector).toBe(true);
    }
  });

  it('is a small layer over Art: it sets the accent, never Art’s paper, ink or frame', () => {
    // Art's stylesheets do the drawing; Vivid's file is a thin layer.
    expect(selectorsOf('src/themes/vivid/theme.css').length).toBeLessThan(40);
    for (const token of ['--background', '--foreground', '--card', '--muted', '--muted-foreground', '--border', '--sidebar-background', '--art-side']) {
      expect(css, token).not.toMatch(new RegExp(`\\s${token}:`));
    }
    for (const token of ['--primary', '--ring', '--vivid-from', '--vivid-to', '--vivid-tint', '--art-chart-1']) {
      expect(css.match(new RegExp(`\\s${token}:`, 'g'))?.length ?? 0, token).toBeGreaterThanOrEqual(2);
    }
    expect(css).toContain(':root[data-panel-theme="vivid"].dark {');
  });

  it('draws the strip and the panel with logical directions (right to left in Persian)', () => {
    expect(css).toMatch(/\[dir="rtl"\] \{\s*--vivid-strip: linear-gradient\(270deg/);
    expect(css).not.toMatch(/(?:^|[\s;{])(?:left|right):/);
    expect(css).not.toMatch(/(?:margin|padding|border)-(?:left|right)/);
  });

  it('is brand-neutral: no product name in the theme', () => {
    for (const path of [...FILES, 'src/themes/vivid/palettes.ts']) {
      expect(read(path)).not.toMatch(/webyar|respok|وب‌?یار|رسپاک/i);
    }
  });

  it('is loaded by the app after Art’s stylesheets', () => {
    const main = read('src/main.tsx');
    for (const path of FILES) expect(main).toContain(`import "./${path.replace('src/', '')}";`);
    expect(main.indexOf('./themes/vivid/theme.css')).toBeGreaterThan(main.indexOf('./themes/art/charts.css'));
  });

  it('wears Art’s frame and Art’s Tailwind pigments', () => {
    const layout = read('src/components/layout/AppLayout.tsx');
    expect(layout.match(/isArtFamilySelection\(panelTheme\)/g)).toHaveLength(2);
    expect(read('src/components/layout/AppSidebar.tsx')).not.toMatch(/sectionLabels/);
    expect(paletteVariables(artPalette)).toEqual(paletteVariables(artPalette));
    expect(read('src/themes/palette.ts')).toMatch(/vivid: artPalette,/);
  });
});

describe('the sign-in pages’ international scheme (authPalette.css)', () => {
  const PATH = 'src/themes/authPalette.css';
  const strip = () => read(PATH).replace(/\/\*[\s\S]*?\*\//g, '');

  it('applies only under <html data-auth-palette="respok">, so the sign-in pages keep their look anywhere else', () => {
    const selectors: string[] = [];
    const rule = /([^{}@;]+)\{[^{}]*\}/g;
    const source = strip();
    for (let m = rule.exec(source); m; m = rule.exec(source)) selectors.push(...splitSelectors(m[1]));
    expect(selectors.length).toBeGreaterThanOrEqual(3);
    for (const selector of selectors) {
      expect(selector.startsWith(':root[data-auth-palette="respok"]'), selector).toBe(true);
    }
    // Light values never leak into dark mode, nor the other way round.
    expect(source).toContain(':root[data-auth-palette="respok"]:not(.dark) {');
    expect(source).toContain(':root[data-auth-palette="respok"].dark {');
  });

  it('is loaded by the app and set only by AuthLayout', () => {
    expect(read('src/main.tsx')).toContain('import "./themes/authPalette.css";');
    expect(read('src/components/layout/AuthLayout.tsx')).toMatch(/useApplyAuthPalette\(\)/);
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
