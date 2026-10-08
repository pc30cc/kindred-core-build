/**
 * International mode (shared/internationalMode.ts, src/lib/internationalMode.ts):
 * the platform runs several languages (site_mode multi_language, RESPOK) and
 * the UI is not in Persian. Only then does the app wear the RESPOK brand kit.
 *
 * The promises this checks:
 *   - The rule itself: multi_language and not fa; a missing or unknown site
 *     mode is single_language (WebYar), where nothing changes.
 *   - Art's `respok` scheme is worn only there: the panel, a preview and the
 *     sign-in pages fall back (clay, or their own colours) in Persian and on a
 *     single-language site, whatever is stored.
 *   - The brand marks (BrandLogo, the auth lockup, the launch loader) show the
 *     kit only there; Persian never resolves a kit file.
 *   - The site mode reaches the client through the public config, and the
 *     manifest's icons follow the same rule.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ data: undefined as unknown, locale: 'en', admin: true }));

vi.mock('@/lib/platformPublicConfig', () => ({
  usePlatformPublicConfig: () => ({ data: state.data }),
}));

vi.mock('@/hooks/useAdmin', () => ({
  useIsGlobalAdmin: () => ({ data: state.admin }),
}));

vi.mock('@/i18n', () => ({
  useI18n: () => ({ locale: state.locale, dir: state.locale === 'fa' ? 'rtl' : 'ltr', t: (key: string) => key }),
  useTranslation: () => ({ locale: state.locale, dir: state.locale === 'fa' ? 'rtl' : 'ltr', t: (key: string) => key }),
}));

import { INTL_BRAND, isInternationalMode, resolveSiteMode } from '../../../shared/internationalMode';
import { ART_PALETTES, resolvePanelThemeSelection } from '../../../shared/panelThemes';
import { cachedSiteMode, useInternationalMode, SITE_MODE_CACHE_KEY } from '@/lib/internationalMode';
import { endPanelThemePreview, startPanelThemePreview, usePanelTheme, wearablePanelTheme } from '@/themes/usePanelTheme';
import { authPaletteFor, useApplyAuthPalette } from '@/themes/authPalette';
import { BrandLockup, BrandLogo } from '@/components/brand/BrandLogo';
import { BrandFooter, BrandLoader, BrandWordmark } from '@/components/brand/BrandLoader';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const config = (siteMode: string | undefined, palette = 'respok', theme = 'art') => ({
  branding: { workspace_panel_theme: theme, workspace_panel_theme_options: { art: { layout: 'sidebar', palette } } },
  localized: [],
  region: { region_mode: null, active_locales: null, default_locale: null, ...(siteMode ? { site_mode: siteMode } : {}) },
  realtime: null,
});

beforeEach(() => {
  state.data = undefined;
  state.locale = 'en';
  state.admin = true;
  localStorage.clear();
  act(() => endPanelThemePreview());
});

afterEach(() => {
  delete document.documentElement.dataset.authPalette;
});

describe('the rule', () => {
  it('is multi_language and a language other than Persian', () => {
    expect(isInternationalMode('multi_language', 'en')).toBe(true);
    expect(isInternationalMode('multi_language', 'tr')).toBe(true);
    expect(isInternationalMode('multi_language', 'fa')).toBe(false);
    for (const locale of ['en', 'tr', 'fa']) expect(isInternationalMode('single_language', locale)).toBe(false);
    for (const mode of [undefined, null, '', 'MULTI_LANGUAGE', 'multi', 42]) {
      expect(isInternationalMode(mode, 'en'), String(mode)).toBe(false);
    }
    expect(isInternationalMode('multi_language', '')).toBe(false);
    expect(isInternationalMode('multi_language', undefined)).toBe(false);
  });

  it('reads a missing or unknown site mode as single_language', () => {
    expect(resolveSiteMode('multi_language')).toBe('multi_language');
    for (const value of [undefined, null, 'single_language', 'x']) expect(resolveSiteMode(value)).toBe('single_language');
  });

  it('follows the public config and remembers its site mode for the next first paint', () => {
    state.data = config('multi_language');
    expect(renderHook(() => useInternationalMode()).result.current).toBe(true);
    expect(localStorage.getItem(SITE_MODE_CACHE_KEY)).toBe('multi_language');

    // Next load, before the config arrives: the cache decides.
    state.data = undefined;
    expect(cachedSiteMode()).toBe('multi_language');
    expect(renderHook(() => useInternationalMode()).result.current).toBe(true);
    state.locale = 'fa';
    expect(renderHook(() => useInternationalMode()).result.current).toBe(false);
  });

  it('is off on a backend that does not send the site mode yet', () => {
    state.data = config(undefined);
    expect(renderHook(() => useInternationalMode()).result.current).toBe(false);
    expect(localStorage.getItem(SITE_MODE_CACHE_KEY)).toBe('single_language');
  });
});

describe('Art’s respok scheme', () => {
  it('is worn in international mode', () => {
    state.data = config('multi_language');
    expect(renderHook(() => usePanelTheme()).result.current).toMatchObject({
      theme: 'art',
      options: { layout: 'sidebar', palette: 'respok' },
      platformOptions: { layout: 'sidebar', palette: 'respok' },
    });
  });

  it.each([
    ['Persian on a multi-language site', 'multi_language', 'fa'],
    ['English on a single-language site', 'single_language', 'en'],
    ['Persian on a single-language site', 'single_language', 'fa'],
  ])('is clay in %s, while what is stored stays respok', (_name, siteMode, locale) => {
    state.data = config(siteMode);
    state.locale = locale;
    const { result } = renderHook(() => usePanelTheme());
    expect(result.current).toMatchObject({ theme: 'art', options: { layout: 'sidebar', palette: 'clay' }, platformOptions: { palette: 'clay' } });
    // The cache keeps the stored choice; the fallback is applied when worn.
    expect(JSON.parse(localStorage.getItem('wy-panel-theme-options')!)).toEqual({ layout: 'sidebar', palette: 'respok' });
  });

  it('is clay in a Persian Super Admin’s preview too', () => {
    state.data = config('multi_language', 'sage');
    state.locale = 'fa';
    startPanelThemePreview('art', { palette: 'respok' });
    const { result } = renderHook(() => usePanelTheme());
    // Previewing respok in Persian wears clay: the preview names clay, never respok.
    expect(result.current.options).toMatchObject({ palette: 'clay' });
    expect(result.current.preview).toMatchObject({ options: { palette: 'clay' } });
  });

  it('never resolves to respok in Persian, whatever is stored', () => {
    for (const palette of ART_PALETTES) {
      for (const siteMode of ['multi_language', 'single_language']) {
        const selection = resolvePanelThemeSelection('art', { art: { palette } });
        const worn = wearablePanelTheme(selection, isInternationalMode(siteMode, 'fa'));
        expect(worn.theme === 'art' && worn.options.palette).not.toBe('respok');
        expect(authPaletteFor(selection, isInternationalMode(siteMode, 'fa'))).toBeNull();
      }
    }
  });
});

describe('the sign-in pages', () => {
  it('wear respok only in international mode, under Art in that scheme', () => {
    const art = (palette: string) => resolvePanelThemeSelection('art', { art: { palette } });
    expect(authPaletteFor(art('respok'), true)).toBe('respok');
    expect(authPaletteFor(art('respok'), false)).toBeNull();
    expect(authPaletteFor(art('sage'), true)).toBeNull();
    expect(authPaletteFor(resolvePanelThemeSelection('classic', { art: { palette: 'respok' } }), true)).toBeNull();
  });

  it('carry <html data-auth-palette> while AuthLayout is mounted, and never in Persian', () => {
    state.data = config('multi_language');
    const { unmount } = renderHook(() => useApplyAuthPalette());
    expect(document.documentElement.dataset.authPalette).toBe('respok');
    unmount();
    expect(document.documentElement.dataset.authPalette).toBeUndefined();

    state.locale = 'fa';
    renderHook(() => useApplyAuthPalette());
    expect(document.documentElement.dataset.authPalette).toBeUndefined();
  });

  it('keep their own colours under another scheme or theme', () => {
    state.data = config('multi_language', 'ocean');
    renderHook(() => useApplyAuthPalette());
    expect(document.documentElement.dataset.authPalette).toBeUndefined();
    state.data = config('multi_language', 'respok', 'classic');
    renderHook(() => useApplyAuthPalette());
    expect(document.documentElement.dataset.authPalette).toBeUndefined();
  });
});

describe('the brand marks', () => {
  const marks = () => (
    <div>
      <BrandLogo src="https://cdn.example.com/operator.png" />
      <BrandLockup name="Platform" />
      <BrandLoader />
      <BrandFooter />
      <BrandWordmark />
    </div>
  );

  it('show the RESPOK kit in international mode, over an operator logo', () => {
    state.data = config('multi_language', 'clay');
    const { container } = render(marks());
    const sources = [...container.querySelectorAll('img')].map((img) => img.getAttribute('src'));
    expect(sources).toContain(INTL_BRAND.appIcon);
    expect(sources).toEqual(expect.arrayContaining([INTL_BRAND.horizontal.light, INTL_BRAND.horizontal.dark, INTL_BRAND.wordmark.light]));
    expect(sources).not.toContain('https://cdn.example.com/operator.png');
    expect(container.querySelector('.wy-loader.wy-intl')).not.toBeNull();
    expect(container.textContent).not.toContain('WEBYAR');
  });

  it.each([
    ['Persian on a multi-language site', 'multi_language', 'fa'],
    ['English on a single-language site', 'single_language', 'en'],
  ])('never show it in %s', (_name, siteMode, locale) => {
    state.data = config(siteMode);
    state.locale = locale;
    const { container } = render(marks());
    expect(container.innerHTML).not.toContain('/brand/intl/');
    expect(container.querySelector('.wy-intl')).toBeNull();
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example.com/operator.png');
    expect(container.textContent).toContain('Platform');
  });

  it('ship only files that exist, with nothing of the WebYar name in their paths', () => {
    const files: string[] = [
      ...[INTL_BRAND.horizontal, INTL_BRAND.wordmark].flatMap((v) => [v.light, v.dark]),
      INTL_BRAND.appIcon,
      INTL_BRAND.appleTouchIcon,
      INTL_BRAND.pwa192,
      INTL_BRAND.pwa512,
      INTL_BRAND.pwaMaskable,
    ];
    for (const file of files) {
      expect(file).not.toMatch(/webyar/i);
      expect(() => read(`public${file}`), file).not.toThrow();
    }
  });
});

describe('the server', () => {
  it('hands the site mode to every member', () => {
    expect(read('server/services/platformPublicConfig.ts')).toMatch(/select\('region_mode, active_locales, default_locale, site_mode'\)/);
    expect(read('src/lib/platformPublicConfig.ts')).toMatch(/site_mode\?: string \| null/);
  });

  it('gives the manifest the kit’s icons only in international mode', () => {
    const manifest = read('server/routes/manifest.ts');
    expect(manifest).toMatch(/isInternationalMode\(\(settings as \{ site_mode\?: unknown \} \| null\)\?\.site_mode, effectiveLocale\)/);
    expect(manifest).toMatch(/const icons = international\s*\?/);
  });

  it('the boot splash follows the same rule from the cache', () => {
    const html = read('index.html');
    expect(html).toContain(`ls.getItem('${SITE_MODE_CACHE_KEY}') !== 'multi_language'`);
    expect(html).toContain("if (locale === 'fa') return;");
  });
});
