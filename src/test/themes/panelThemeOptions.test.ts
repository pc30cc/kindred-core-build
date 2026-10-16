/**
 * A panel theme's options (shared/panelThemes.ts, migration 254): Art's
 * layout (top menu or side menu) and colour scheme, and Vivid's (Art's two
 * layouts and its own accent colours), chosen by the Super Admin for
 * everyone.
 *
 * The promises this checks:
 *   - What is stored is only ever read through resolvePanelThemeOptions, so a
 *     missing, unknown or malformed value is that option's default: a
 *     database from before 254 looks exactly as before.
 *   - The server accepts only known options with known values
 *     (isValidPanelThemeOptions), whatever the request carries.
 *   - Migration 254 is re-runnable and the public config hands the options to
 *     every member.
 *   - The side menu is chosen by the platform option, not by the browser.
 *   - Every layout, colour scheme and new text is translated in fa, en and tr.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';
import type { TranslationKey } from '@/i18n';
import { panelThemeLabel, panelThemes, previewSwatches } from '@/themes/registry';
import {
  ART_LAYOUTS,
  ART_PALETTES,
  INTERNATIONAL_ART_PALETTES,
  PANEL_THEME_OPTIONS,
  VIVID_PALETTES,
  ART_FAMILY_THEMES,
  isArtFamilyTheme,
  panelThemeFamily,
  artPaletteFor,
  artPalettesFor,
  PANEL_THEME_OPTION_KEYS,
  isValidPanelThemeOptions,
  resolvePanelThemeOptions,
  resolvePanelThemeSelection,
} from '../../../shared/panelThemes';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('the options', () => {
  it('Art has a layout and a colour scheme; the first value of each is its default', () => {
    expect(ART_LAYOUTS).toEqual(['topnav', 'sidebar']);
    expect(ART_PALETTES).toEqual(['clay', 'sage', 'indigo', 'plum', 'ocean', 'saffron', 'graphite', 'respok']);
    expect(PANEL_THEME_OPTIONS.art).toEqual({ layout: ART_LAYOUTS, palette: ART_PALETTES });
    expect(PANEL_THEME_OPTIONS.classic).toEqual({});
    expect([...PANEL_THEME_OPTION_KEYS].sort()).toEqual(['layout', 'palette']);
  });

  it('Vivid has Art’s layouts and its own colour schemes, coral (the receipt’s) first', () => {
    expect(VIVID_PALETTES).toEqual(['coral', 'ocean', 'violet', 'emerald', 'amber']);
    expect(PANEL_THEME_OPTIONS.vivid).toEqual({ layout: ART_LAYOUTS, palette: VIVID_PALETTES });
    expect(resolvePanelThemeOptions('vivid', {})).toEqual({ layout: 'topnav', palette: 'coral' });
    // A scheme saved before Vivid had a layout keeps working: Art's default layout.
    expect(resolvePanelThemeOptions('vivid', { vivid: { palette: 'emerald' } })).toEqual({ layout: 'topnav', palette: 'emerald' });
    expect(resolvePanelThemeOptions('vivid', { vivid: { layout: 'sidebar', palette: 'amber' } })).toEqual({ layout: 'sidebar', palette: 'amber' });
    // Art's schemes are not Vivid's, and each theme reads its own entry only.
    expect(resolvePanelThemeOptions('vivid', { vivid: { palette: 'clay' } })).toEqual({ layout: 'topnav', palette: 'coral' });
    expect(resolvePanelThemeOptions('vivid', { art: { layout: 'sidebar', palette: 'ocean' } })).toEqual({ layout: 'topnav', palette: 'coral' });
    expect(resolvePanelThemeOptions('art', { vivid: { layout: 'sidebar', palette: 'ocean' } })).toEqual({ layout: 'topnav', palette: 'clay' });
    for (const palette of VIVID_PALETTES) expect(isValidPanelThemeOptions('vivid', { palette })).toBe(true);
    for (const layout of ART_LAYOUTS) expect(isValidPanelThemeOptions('vivid', { layout })).toBe(true);
    expect(isValidPanelThemeOptions('vivid', { palette: 'clay' })).toBe(false);
    expect(isValidPanelThemeOptions('vivid', { layout: 'floating' })).toBe(false);
  });

  it('Art and Vivid are drawn by Art (one family); Classic by itself', () => {
    expect(ART_FAMILY_THEMES).toEqual(['art', 'vivid']);
    expect(isArtFamilyTheme('art')).toBe(true);
    expect(isArtFamilyTheme('vivid')).toBe(true);
    expect(isArtFamilyTheme('classic')).toBe(false);
    expect(panelThemeFamily('vivid')).toBe('art');
    expect(panelThemeFamily('classic')).toBeNull();
  });

  it('resolves what is stored, every missing or unknown value to its default', () => {
    expect(resolvePanelThemeOptions('art', { art: { layout: 'sidebar', palette: 'ocean' } })).toEqual({
      layout: 'sidebar',
      palette: 'ocean',
    });
    expect(resolvePanelThemeOptions('art', { art: { palette: 'plum' } })).toEqual({ layout: 'topnav', palette: 'plum' });
    expect(resolvePanelThemeOptions('art', { art: { layout: 'SIDEBAR', palette: 7, extra: 'x' } })).toEqual({
      layout: 'topnav',
      palette: 'clay',
    });
    for (const raw of [undefined, null, '', 'art', 42, [], [{ art: { layout: 'sidebar' } }], {}, { art: null }, { art: 'sidebar' }, { art: [] }]) {
      expect(resolvePanelThemeOptions('art', raw), JSON.stringify(raw)).toEqual({ layout: 'topnav', palette: 'clay' });
    }
  });

  it('reads a theme’s own entry only', () => {
    const stored = { classic: { layout: 'sidebar' }, art: { layout: 'sidebar', palette: 'sage' } };
    expect(resolvePanelThemeOptions('classic', stored)).toEqual({});
    expect(resolvePanelThemeOptions('art', { classic: { layout: 'sidebar', palette: 'sage' } })).toEqual({
      layout: 'topnav',
      palette: 'clay',
    });
    expect(resolvePanelThemeSelection('art', stored)).toEqual({ theme: 'art', options: { layout: 'sidebar', palette: 'sage' } });
    expect(resolvePanelThemeSelection('classic', stored)).toEqual({ theme: 'classic', options: {} });
  });

  it('accepts only known options set to known values', () => {
    for (const layout of ART_LAYOUTS) expect(isValidPanelThemeOptions('art', { layout })).toBe(true);
    for (const palette of ART_PALETTES) expect(isValidPanelThemeOptions('art', { palette })).toBe(true);
    expect(isValidPanelThemeOptions('art', { layout: 'sidebar', palette: 'graphite' })).toBe(true);
    expect(isValidPanelThemeOptions('art', {})).toBe(true);
    expect(isValidPanelThemeOptions('classic', {})).toBe(true);

    const bad: unknown[] = [
      undefined,
      null,
      'sidebar',
      42,
      ['sidebar'],
      { layout: 'floating' },
      { layout: 'Sidebar' },
      { palette: 'neon' },
      { palette: null },
      { palette: ['clay'] },
      { colour: 'clay' },
      { layout: 'sidebar', extra: 'x' },
      // Inherited names are not options.
      { constructor: 'sidebar' },
      { toString: 'clay' },
      { hasOwnProperty: 'clay' },
      JSON.parse('{"__proto__": "clay"}'),
    ];
    for (const options of bad) expect(isValidPanelThemeOptions('art', options), JSON.stringify(options)).toBe(false);
    expect(isValidPanelThemeOptions('classic', { layout: 'sidebar' })).toBe(false);
  });
});

describe('the international-only colour scheme', () => {
  it('is respok, stored and validated like any other (no migration)', () => {
    expect(INTERNATIONAL_ART_PALETTES).toEqual(['respok']);
    expect(isValidPanelThemeOptions('art', { palette: 'respok' })).toBe(true);
    expect(resolvePanelThemeOptions('art', { art: { palette: 'respok' } })).toEqual({ layout: 'topnav', palette: 'respok' });
  });

  it('is offered only in international mode', () => {
    expect(artPalettesFor(true)).toEqual(ART_PALETTES);
    expect(artPalettesFor(false)).toEqual(['clay', 'sage', 'indigo', 'plum', 'ocean', 'saffron', 'graphite']);
  });

  it('is worn only in international mode; anywhere else it is clay, and every other scheme is itself', () => {
    expect(artPaletteFor('respok', true)).toBe('respok');
    expect(artPaletteFor('respok', false)).toBe('clay');
    for (const palette of ART_PALETTES.filter((id) => id !== 'respok')) {
      expect(artPaletteFor(palette, false)).toBe(palette);
      expect(artPaletteFor(palette, true)).toBe(palette);
    }
  });
});

describe('storage', () => {
  it('migration 254 adds a JSON object column defaulting to {} and is re-runnable', () => {
    const sql = read('database/migrations/254_workspace_panel_theme_options.sql');
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS workspace_panel_theme_options jsonb NOT NULL DEFAULT '\{\}'::jsonb/,
    );
    expect(sql).toMatch(/jsonb_typeof\(workspace_panel_theme_options\) = 'object'/);
    expect(sql).toMatch(/EXCEPTION WHEN duplicate_object THEN NULL/);
    // Exactly one migration takes the number.
    expect(readdirSync('database/migrations').filter((f) => f.startsWith('254_'))).toHaveLength(1);
  });

  it('the public config hands the options to every member', () => {
    expect(read('server/services/platformPublicConfig.ts')).toMatch(/'workspace_panel_theme_options'/);
    expect(read('src/lib/platformPublicConfig.ts')).toMatch(/workspace_panel_theme_options\?:/);
  });
});

describe('the side menu', () => {
  const shell = 'src/themes/art/shell';

  it('is chosen by the platform option, never by the browser', () => {
    for (const file of readdirSync(shell)) {
      expect(read(`${shell}/${file}`), file).not.toContain('wy-art-layout');
    }
    expect(read(`${shell}/ArtShell.tsx`)).toMatch(/layout === 'sidebar' && isDesktop/);
    const appLayout = read('src/components/layout/AppLayout.tsx');
    expect(appLayout).toMatch(/<ArtShellSkeleton layout=\{panelTheme\.options\.layout\}/);
    expect(appLayout).toMatch(/<ArtShell\s+layout=\{panelTheme\.options\.layout\}/);
    expect(appLayout).toMatch(/useApplyPanelTheme\(panelTheme\.theme, panelTheme\.options\)/);
  });

  it('never remounts the page when the layout changes: one tree, one <main>', () => {
    // A Super Admin switching the layout reaches open panels, and a window
    // crossing 1024px switches it too; a remount would drop the page's state
    // (the open conversation, a half-typed reply).
    const source = read(`${shell}/ArtShell.tsx`).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(source.match(/<main\b/g)).toHaveLength(1);
    expect(source).not.toMatch(/if \(sideLayout\)/);
    expect(source).toMatch(/className=\{sideLayout \? 'relative flex min-h-0 flex-1' : 'contents'\}/);
  });

  it('takes its colours from the tokens, so every colour scheme reaches it', () => {
    const css = read('src/themes/art/sidebar.css').replace(/\/\*[\s\S]*?\*\//g, '');
    // Warm literals belong to clay; the scheme's tokens replace them.
    expect(css).not.toMatch(/hsl\(\s*\d/);
    expect(css).not.toMatch(/rgb\(\s*(?!255 255 255)\d/);
  });
});

describe('Super Admin → Panel theme', () => {
  it('sends options only where they can be kept, and never reports a save the server did not make', () => {
    const page = read('src/pages/admin/PanelThemePage.tsx');
    // Before migration 254 "Use for everyone" switches the theme alone.
    expect(page).toMatch(/if \(theme === 'art' && artDirty && optionsSaveable\) return \{ theme, options: \{ \.\.\.art \} \};/);
    expect(page).toMatch(/if \(theme === 'vivid' && vividDirty && optionsSaveable\) return \{ theme, options: \{ \.\.\.vivid \} \};/);
    expect(page).toMatch(/return \{ theme \};/);
    // An older backend (mid-deploy) answers 200 without the options.
    expect(page).toMatch(/'options_not_saved'/);
    // The international-only scheme is listed only in international mode, and
    // shown (and named) as clay outside it.
    expect(page).toMatch(/palettes=\{artPalettesFor\(international\)\}/);
    expect(page).toMatch(/value=\{artShown\}/);
    expect(page).toMatch(/art=\{isArt \? artShown : undefined\}/);
    expect(page).toMatch(/code === 'migration_required'\s*\? tk\('admin\.panelThemes\.options\.needsMigration'\)/);
  });

  it('names a theme with its options', () => {
    const t = (key: TranslationKey) => {
      const value = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], en);
      return typeof value === 'string' ? value : key;
    };
    expect(panelThemeLabel(t, { theme: 'art', options: { layout: 'sidebar', palette: 'sage' } })).toBe('Art · Side menu · Sage');
    expect(panelThemeLabel(t, { theme: 'classic', options: {} })).toBe('Classic');
    expect(panelThemeLabel(t, { theme: 'vivid', options: { layout: 'sidebar', palette: 'ocean' } })).toBe('Vivid · Side menu · Ocean');
  });

  it('draws every colour scheme in both modes without failing on a missing swatch', () => {
    const art = panelThemes.find((theme) => theme.id === 'art')!;
    for (const mode of ['light', 'dark'] as const) {
      expect(previewSwatches(art, mode)).toEqual(art[mode]);
      for (const palette of ART_PALETTES) {
        const swatches = previewSwatches(art, mode, palette);
        expect(swatches.accents).toHaveLength(4);
        expect(typeof swatches.primary).toBe('string');
      }
    }
    // Classic has no colour schemes.
    const classic = panelThemes.find((theme) => theme.id === 'classic')!;
    expect(previewSwatches(classic, 'light', 'ocean')).toEqual(classic.light);
    // Vivid: coral is its base; every scheme is one accent with the strip.
    const vivid = panelThemes.find((theme) => theme.id === 'vivid')!;
    for (const mode of ['light', 'dark'] as const) {
      expect(previewSwatches(vivid, mode)).toEqual(vivid[mode]);
      expect(previewSwatches(vivid, mode, 'coral')).toEqual(vivid[mode]);
      expect(previewSwatches(vivid, mode, 'clay')).toEqual(vivid[mode]);
      for (const palette of VIVID_PALETTES) {
        const swatches = previewSwatches(vivid, mode, palette);
        expect(swatches.strip).toMatch(/^linear-gradient\(/);
        expect(swatches.card).toBe(previewSwatches(panelThemes.find((theme) => theme.id === 'art')!, mode, 'clay').card);
        expect(swatches.accents).toHaveLength(4);
      }
      expect(previewSwatches(vivid, mode, 'violet').primary).not.toBe(vivid[mode].primary);
    }
  });

  it.each([
    ['en', en],
    ['fa', fa],
    ['tr', tr],
  ])('is fully translated (%s)', (_locale, messages) => {
    const page = messages.admin.panelThemes as unknown as {
      options: Record<string, string>;
      layouts: Record<string, { name: string; description: string }>;
      palettes: Record<string, string>;
      how5: string;
    };
    for (const key of ['title', 'layout', 'palette', 'save', 'reset', 'unsaved', 'saved', 'needsMigration', 'notSaved']) {
      expect(page.options[key], `options.${key}`).toBeTruthy();
    }
    expect(page.options.saved).toContain('{{name}}');
    for (const layout of ART_LAYOUTS) {
      expect(page.layouts[layout]?.name, `layouts.${layout}.name`).toBeTruthy();
      expect(page.layouts[layout]?.description, `layouts.${layout}.description`).toBeTruthy();
    }
    for (const palette of ART_PALETTES) expect(page.palettes[palette], `palettes.${palette}`).toBeTruthy();
    expect(page.how5).toBeTruthy();
    const vivid = messages.admin.panelThemes as unknown as {
      vividOptions: Record<string, string>;
      vividPalettes: Record<string, string>;
    };
    for (const key of ['title', 'palette']) expect(vivid.vividOptions[key], `vividOptions.${key}`).toBeTruthy();
    expect(Object.keys(vivid.vividPalettes).sort()).toEqual([...VIVID_PALETTES].sort());
    for (const palette of VIVID_PALETTES) expect(vivid.vividPalettes[palette], `vividPalettes.${palette}`).toBeTruthy();

    const shell = messages.artShell as unknown as Record<string, string>;
    for (const key of [
      'sideNav',
      'sideConversations',
      'sideCustomers',
      'sideAi',
      'sideGrowth',
      'sideTools',
      'sideManage',
      'collapseSidebar',
      'expandSidebar',
      'planFree',
      'planTrial',
      'planTrialLastDay',
      'planUpgrade',
    ]) {
      expect(shell[key], `artShell.${key}`).toBeTruthy();
    }
    expect(shell.planTrial).toContain('{{days}}');
  });

  it('uses the names the owner gave the layouts and colour schemes', () => {
    expect(fa.admin.panelThemes.layouts).toMatchObject({ topnav: { name: 'منوی بالا' }, sidebar: { name: 'منوی کناری' } });
    expect(fa.admin.panelThemes.palettes).toEqual({
      clay: 'خاک رس',
      sage: 'مریم‌گلی',
      indigo: 'نیلی',
      plum: 'آلویی',
      ocean: 'اقیانوسی',
      saffron: 'زعفرانی',
      graphite: 'زغالی',
      respok: 'رسپاک',
    });
    expect(tr.admin.panelThemes.palettes).toEqual({
      clay: 'Kil',
      sage: 'Adaçayı',
      indigo: 'Çivit',
      plum: 'Erik',
      ocean: 'Okyanus',
      saffron: 'Safran',
      graphite: 'Grafit',
      respok: 'Respok',
    });
    expect(tr.admin.panelThemes.layouts).toMatchObject({ topnav: { name: 'Üst menü' }, sidebar: { name: 'Yan menü' } });
  });
});
