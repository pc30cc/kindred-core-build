/**
 * A panel theme's options (shared/panelThemes.ts, migration 254): Art's
 * layout (top menu or side menu) and colour scheme, chosen by the Super Admin
 * for everyone.
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
  PANEL_THEME_OPTIONS,
  PANEL_THEME_OPTION_KEYS,
  isValidPanelThemeOptions,
  resolvePanelThemeOptions,
  resolvePanelThemeSelection,
} from '../../../shared/panelThemes';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('the options', () => {
  it('Art has a layout and a colour scheme; the first value of each is its default', () => {
    expect(ART_LAYOUTS).toEqual(['topnav', 'sidebar']);
    expect(ART_PALETTES).toEqual(['clay', 'sage', 'indigo', 'plum', 'ocean', 'saffron', 'graphite']);
    expect(PANEL_THEME_OPTIONS.art).toEqual({ layout: ART_LAYOUTS, palette: ART_PALETTES });
    expect(PANEL_THEME_OPTIONS.classic).toEqual({});
    expect([...PANEL_THEME_OPTION_KEYS].sort()).toEqual(['layout', 'palette']);
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
    expect(page).toMatch(/theme === 'art' && artDirty && optionsSaveable \? \{ theme, options: \{ \.\.\.art \} \} : \{ theme \}/);
    // An older backend (mid-deploy) answers 200 without the options.
    expect(page).toMatch(/'options_not_saved'/);
    expect(page).toMatch(/code === 'migration_required'\s*\? tk\('admin\.panelThemes\.options\.needsMigration'\)/);
  });

  it('names a theme with its options', () => {
    const t = (key: TranslationKey) => {
      const value = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], en);
      return typeof value === 'string' ? value : key;
    };
    expect(panelThemeLabel(t, { theme: 'art', options: { layout: 'sidebar', palette: 'sage' } })).toBe('Art · Side menu · Sage');
    expect(panelThemeLabel(t, { theme: 'classic', options: {} })).toBe('Classic');
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
    });
    expect(tr.admin.panelThemes.palettes).toEqual({
      clay: 'Kil',
      sage: 'Adaçayı',
      indigo: 'Çivit',
      plum: 'Erik',
      ocean: 'Okyanus',
      saffron: 'Safran',
      graphite: 'Grafit',
    });
    expect(tr.admin.panelThemes.layouts).toMatchObject({ topnav: { name: 'Üst menü' }, sidebar: { name: 'Yan menü' } });
  });
});
