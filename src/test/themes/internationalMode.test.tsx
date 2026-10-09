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
import { useInternationalMode, SITE_MODE_CACHE_KEY, EDITION_CACHE_KEY } from '@/lib/internationalMode';
import { __resetEditionForTests } from '@/lib/edition';
import { endPanelThemePreview, startPanelThemePreview, usePanelTheme, wearablePanelTheme } from '@/themes/usePanelTheme';
import { authPaletteFor, useApplyAuthPalette } from '@/themes/authPalette';
import { BrandLockup, BrandLogo } from '@/components/brand/BrandLogo';
import { BrandFooter, BrandLoader, BrandWordmark } from '@/components/brand/BrandLoader';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
/** RESPOK runs region_mode 'multi' (International); WebYar 'iran'. */
const config = (regionMode: string | null, palette = 'respok', theme = 'art') => ({
  branding: { workspace_panel_theme: theme, workspace_panel_theme_options: { art: { layout: 'sidebar', palette } } },
  localized: [],
  region: {
    region_mode: regionMode,
    active_locales: null,
    default_locale: null,
    site_mode: regionMode === 'iran' ? 'single_language' : 'multi_language',
  },
  realtime: null,
});

beforeEach(() => {
  state.data = undefined;
  state.locale = 'en';
  state.admin = true;
  localStorage.clear();
  __resetEditionForTests();
  act(() => endPanelThemePreview());
});

afterEach(() => {
  delete document.documentElement.dataset.authPalette;
});

describe('the rule', () => {
  it('is the International edition, in every language — Persian included', () => {
    for (const locale of ['en', 'tr', 'fa', undefined]) {
      expect(isInternationalMode('international', locale)).toBe(true);
      expect(isInternationalMode('iran', locale)).toBe(false);
    }
    // Anything that is not an edition (unknown, or not loaded yet) changes nothing.
    for (const value of [undefined, null, '', 'multi', 'multi_language', 'INTERNATIONAL', 42]) {
      expect(isInternationalMode(value, 'en'), String(value)).toBe(false);
    }
  });

  it('still reads a missing or unknown site mode as single_language', () => {
    expect(resolveSiteMode('multi_language')).toBe('multi_language');
    for (const value of [undefined, null, 'single_language', 'x']) expect(resolveSiteMode(value)).toBe('single_language');
  });

  it('follows the public config and remembers the edition for the next first paint', () => {
    state.data = config('multi');
    expect(renderHook(() => useInternationalMode()).result.current).toBe(true);
    expect(localStorage.getItem(EDITION_CACHE_KEY)).toBe('international');

    // Next load, before the config arrives: the cache decides, Persian included.
    __resetEditionForTests();
    state.data = undefined;
    state.locale = 'fa';
    expect(renderHook(() => useInternationalMode()).result.current).toBe(true);
  });

  it('is off in the Iranian edition, and remembers that too', () => {
    for (const locale of ['fa', 'en']) {
      state.locale = locale;
      state.data = config('iran');
      expect(renderHook(() => useInternationalMode()).result.current).toBe(false);
      expect(localStorage.getItem(EDITION_CACHE_KEY)).toBe('iran');
      state.data = undefined;
      expect(renderHook(() => useInternationalMode()).result.current).toBe(false);
    }
  });

  it('is off while the edition is unknown; an older RESPOK cache counts as International', () => {
    expect(renderHook(() => useInternationalMode()).result.current).toBe(false);
    localStorage.setItem(SITE_MODE_CACHE_KEY, 'multi_language');
    expect(renderHook(() => useInternationalMode()).result.current).toBe(true);
    // A cached 'iran' region wins over any stale site-mode hint.
    localStorage.setItem('platform-region-mode', 'iran');
    expect(renderHook(() => useInternationalMode()).result.current).toBe(false);
  });

  it('a failed config read never flips a known edition', () => {
    state.data = config('iran');
    renderHook(() => useInternationalMode());
    __resetEditionForTests();
    state.data = undefined; // the read failed: React Query has no data
    expect(renderHook(() => useInternationalMode()).result.current).toBe(false);
    expect(localStorage.getItem(EDITION_CACHE_KEY)).toBe('iran');
  });
});

describe('Art’s respok scheme', () => {
  it.each(['en', 'fa', 'tr'])('is worn in the International edition (%s)', (locale) => {
    state.data = config('multi');
    state.locale = locale;
    expect(renderHook(() => usePanelTheme()).result.current).toMatchObject({
      theme: 'art',
      options: { layout: 'sidebar', palette: 'respok' },
      platformOptions: { layout: 'sidebar', palette: 'respok' },
    });
  });

  it.each(['fa', 'en'])('is clay in the Iranian edition (%s), while what is stored stays respok', (locale) => {
    state.data = config('iran');
    state.locale = locale;
    const { result } = renderHook(() => usePanelTheme());
    expect(result.current).toMatchObject({ theme: 'art', options: { layout: 'sidebar', palette: 'clay' }, platformOptions: { palette: 'clay' } });
    // The cache keeps the stored choice; the fallback is applied when worn.
    expect(JSON.parse(localStorage.getItem('wy-panel-theme-options')!)).toEqual({ layout: 'sidebar', palette: 'respok' });
  });

  it('is clay in an Iranian Super Admin’s preview too', () => {
    state.data = config('iran', 'sage');
    state.locale = 'fa';
    startPanelThemePreview('art', { palette: 'respok' });
    const { result } = renderHook(() => usePanelTheme());
    expect(result.current.options).toMatchObject({ palette: 'clay' });
    expect(result.current.preview).toMatchObject({ options: { palette: 'clay' } });
  });

  it('never resolves to respok in the Iranian edition, whatever is stored', () => {
    for (const palette of ART_PALETTES) {
      for (const locale of ['fa', 'en']) {
        const selection = resolvePanelThemeSelection('art', { art: { palette } });
        const worn = wearablePanelTheme(selection, isInternationalMode('iran', locale));
        expect(worn.theme === 'art' && worn.options.palette).not.toBe('respok');
        expect(authPaletteFor(selection, isInternationalMode('iran', locale))).toBeNull();
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

  it('carry <html data-auth-palette> while AuthLayout is mounted — in Persian too — and never in the Iranian edition', () => {
    state.data = config('multi');
    state.locale = 'fa';
    const { unmount } = renderHook(() => useApplyAuthPalette());
    expect(document.documentElement.dataset.authPalette).toBe('respok');
    unmount();
    expect(document.documentElement.dataset.authPalette).toBeUndefined();

    state.data = config('iran');
    renderHook(() => useApplyAuthPalette());
    expect(document.documentElement.dataset.authPalette).toBeUndefined();
  });

  it('keep their own colours under another scheme or theme', () => {
    state.data = config('multi', 'ocean');
    renderHook(() => useApplyAuthPalette());
    expect(document.documentElement.dataset.authPalette).toBeUndefined();
    state.data = config('multi', 'respok', 'classic');
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

  it.each(['en', 'fa'])('show the RESPOK kit in the International edition (%s), over an operator logo', (locale) => {
    state.data = config('multi', 'clay');
    state.locale = locale;
    const { container } = render(marks());
    const sources = [...container.querySelectorAll('img')].map((img) => img.getAttribute('src'));
    expect(sources).toContain(INTL_BRAND.appIcon);
    expect(sources).toEqual(expect.arrayContaining([INTL_BRAND.horizontal.light, INTL_BRAND.horizontal.dark, INTL_BRAND.wordmark.light]));
    expect(sources).not.toContain('https://cdn.example.com/operator.png');
    expect(container.querySelector('.wy-loader.wy-intl')).not.toBeNull();
    expect(container.textContent).not.toContain('WEBYAR');
    // WebYar's brand kit is the Iranian edition's only.
    expect(container.innerHTML).not.toContain('/brand/webyar/');
    expect(container.querySelector('.wy-kit-loader')).toBeNull();
  });

  it.each(['fa', 'en'])('never show it in the Iranian edition (%s): WebYar\'s own kit there, the operator\'s logo still first', (locale) => {
    state.data = config('iran');
    state.locale = locale;
    const { container } = render(marks());
    expect(container.innerHTML).not.toContain('/brand/intl/');
    expect(container.querySelector('.wy-intl')).toBeNull();
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example.com/operator.png');
    // The lockup is the kit's Persian logotype (in every UI language), named by the platform.
    const sources = [...container.querySelectorAll('img')].map((img) => img.getAttribute('src'));
    expect(sources).toEqual(expect.arrayContaining(['/brand/webyar/webyar-logo-fa-color.svg', '/brand/webyar/webyar-logo-fa-on-dark.svg']));
    expect(sources.filter((src) => src?.includes('latin'))).toEqual([]);
    expect(container.querySelector('img[data-webyar-brand="logo"]')?.getAttribute('alt')).toBe('Platform');
    expect(container.querySelector('svg.wy-kit-loader')).not.toBeNull();
    expect(container.querySelector('.wy-kit-footer')).not.toBeNull();
    expect(container.textContent).not.toContain('WEBYAR');
  });

  it('keep the old marks while the edition is unknown (no kit is assumed)', () => {
    state.data = undefined;
    const { container } = render(marks());
    expect(container.innerHTML).not.toContain('/brand/webyar/');
    expect(container.innerHTML).not.toContain('/brand/intl/');
    expect(container.querySelector('.wy-kit-loader')).toBeNull();
    expect(container.textContent).toContain('WEBYAR');
    expect(container.textContent).toContain('Platform');
  });

  it('BrandLogo without an operator logo shows the kit\'s symbol in Iran only', () => {
    state.data = config('iran');
    const iran = render(<BrandLogo />).container.querySelector('img')!;
    expect(iran.getAttribute('src')).toBe('/brand/webyar/webyar-symbol-turquoise.svg');
    expect(iran.getAttribute('alt')).toBe('وب‌یار');
    expect(iran.className).toContain('object-contain');
    state.data = config('multi');
    expect(render(<BrandLogo />).container.querySelector('img')!.getAttribute('src')).toBe(INTL_BRAND.appIcon);
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
  it('hands the region mode (and site mode) to every member', () => {
    expect(read('server/services/platformPublicConfig.ts')).toMatch(/select\('region_mode, active_locales, default_locale, site_mode'\)/);
    expect(read('src/lib/platformPublicConfig.ts')).toMatch(/site_mode\?: string \| null/);
  });

  it('gives the manifest the kit’s icons only in the International edition', () => {
    const manifest = read('server/routes/manifest.ts');
    expect(manifest).toMatch(/getPlatformEditionOrNull\(config\)/);
    expect(manifest).toMatch(/isInternationalMode\(edition, effectiveLocale\)/);
    expect(manifest).toMatch(/const icons = international\s*\?/);
  });
});

describe('the boot splash (index.html)', () => {
  const html = read('index.html');
  const splash = /<div id="boot-splash"[\s\S]*?\n {4}<\/div>/.exec(html)![0];
  const script = /<script>\s*(\/\/ International mode[\s\S]*?)<\/script>/.exec(html)![1];

  function boot(storage: Record<string, string>) {
    localStorage.clear();
    for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v);
    document.head.innerHTML = '<link rel="icon" href="/favicon.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png">';
    document.body.innerHTML = splash;
    new Function(script)();
    return {
      intl: !!document.querySelector('.wy-loader.wy-intl'),
      icon: document.querySelector('link[rel="icon"]')!.getAttribute('href'),
    };
  }

  it('wears the kit for a cached International edition, Persian included', () => {
    for (const locale of ['fa', 'en']) {
      expect(boot({ [EDITION_CACHE_KEY]: 'international', 'app-locale': locale })).toEqual({ intl: true, icon: '/brand/intl/favicon.svg' });
    }
    // An older RESPOK browser: only the site-mode cache.
    expect(boot({ [SITE_MODE_CACHE_KEY]: 'multi_language', 'app-locale': 'fa' }).intl).toBe(true);
  });

  it('wears WebYar’s kit in the Iranian edition and keeps the old first paint while the edition is unknown', () => {
    expect(boot({ [EDITION_CACHE_KEY]: 'iran', [SITE_MODE_CACHE_KEY]: 'multi_language' })).toEqual({ intl: false, icon: '/brand/webyar/favicon.svg' });
    expect(boot({ 'platform-region-mode': 'iran', [SITE_MODE_CACHE_KEY]: 'multi_language' })).toEqual({ intl: false, icon: '/brand/webyar/favicon.svg' });
    expect(boot({})).toEqual({ intl: false, icon: '/favicon.png' });
    expect(boot({ [SITE_MODE_CACHE_KEY]: 'single_language', 'app-locale': 'en' }).intl).toBe(false);
  });
});
