/**
 * The platform's logo on the client, from one place (src/lib/brandAssets.ts):
 * the uploads in the public config's `brand_assets`, kept in localStorage
 * (`wy-brand-assets`) for the first paint and index.html's splash, else the
 * edition's bundled kit through the gates the marks always used. An upload
 * wins in both editions; without one every mark is exactly as before (the
 * kit tests: edition/webyarBrandKit, themes/internationalMode).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ data: undefined as unknown }));

vi.mock('@/lib/platformPublicConfig', async (orig) => ({
  ...(await orig<typeof import('@/lib/platformPublicConfig')>()),
  usePlatformPublicConfig: () => ({ data: state.data }),
  fetchPlatformPublicConfig: () => Promise.resolve(state.data),
}));
vi.mock('@/i18n', () => ({
  useI18n: () => ({ locale: 'en', dir: 'ltr', t: (key: string) => key }),
  useTranslation: () => ({ locale: 'en', dir: 'ltr', t: (key: string) => key }),
}));
vi.mock('@/lib/native', () => ({ isNativePlatform: () => false, getNativePlatform: () => 'web' }));

import { BRAND_ASSETS_CACHE_KEY, brandAssetsView, cachedBrandAssets, normalizeBrandAssets, useBrandAssets } from '@/lib/brandAssets';
import { BrandImage, BrandLockup, BrandLogo } from '@/components/brand/BrandLogo';
import { BrandFooter, BrandWordmark } from '@/components/brand/BrandLoader';
import ReceiptDocument from '@/pages/app/billing/account/ReceiptDocument';
import { PlatformBrandingGate } from '@/features/branding/PlatformBrandingGate';
import { notificationIcon } from '@/features/notifications/operatorBrowserNotification';
import { __resetEditionForTests } from '@/lib/edition';
import { INTL_BRAND } from '../../../shared/internationalMode';
import { WEBYAR_BRAND } from '../../../shared/webyarBrand';

const CDN = 'https://cdn.example.test/platform/brand';
const UPLOADED = {
  logo_light: `${CDN}/1-logo-light.svg`,
  logo_dark: `${CDN}/2-logo-dark.svg`,
  logo_png_light: `${CDN}/3-logo-light-email.png`,
  logo_png_dark: null,
  logo_png_width: 300,
  logo_png_height: 120,
  symbol: `${CDN}/4-symbol.svg`,
  apple_touch_180: `${CDN}/5-symbol-180.png`,
  icon_192: `${CDN}/6-symbol-192.png`,
  icon_512: `${CDN}/7-symbol-512.png`,
};

const config = (regionMode: string, brandAssets: unknown = null) => ({
  branding: { logo_url: null, favicon_url: null, pwa_icon_url: null, primary_color: '#3B82F6', pwa_enabled: true, pwa_short_name: null },
  localized: [{ locale: 'en', platform_name: 'Platform' }],
  region: { region_mode: regionMode, active_locales: null, default_locale: null, site_mode: 'single_language' },
  brand: null,
  brand_assets: brandAssets,
});

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}
const sources = (root: ParentNode) => [...root.querySelectorAll('img')].map((img) => img.getAttribute('src'));

beforeEach(() => {
  state.data = undefined;
  localStorage.clear();
  __resetEditionForTests();
});

describe('the hook: an upload, else the edition\'s kit, else nothing', () => {
  it('falls back to each edition\'s kit, and to nothing before the edition is known', () => {
    expect(brandAssetsView(null, 'iran')).toMatchObject({
      source: 'kit', kit: 'iran', customSymbol: false, lockup: WEBYAR_BRAND.logo, wordmark: WEBYAR_BRAND.logo, symbol: WEBYAR_BRAND.symbol, icons: null,
    });
    expect(brandAssetsView(null, 'international')).toMatchObject({
      source: 'kit', kit: 'international', lockup: INTL_BRAND.horizontal, wordmark: INTL_BRAND.wordmark, symbol: INTL_BRAND.appIcon,
    });
    expect(brandAssetsView(null, null)).toMatchObject({ source: 'none', kit: null, lockup: null, wordmark: null, symbol: null });
  });

  it('an upload wins in both editions, and while the edition is unknown', () => {
    for (const edition of ['iran', 'international', null] as const) {
      expect(brandAssetsView(UPLOADED, edition)).toMatchObject({
        source: 'custom',
        customSymbol: true,
        lockup: { light: UPLOADED.logo_light, dark: UPLOADED.logo_dark },
        wordmark: { light: UPLOADED.logo_light, dark: UPLOADED.logo_dark },
        symbol: UPLOADED.symbol,
        icons: { appleTouch180: UPLOADED.apple_touch_180, png192: UPLOADED.icon_192, png512: UPLOADED.icon_512 },
      });
    }
    // Without a dark file the light one serves both.
    expect(brandAssetsView({ ...UPLOADED, logo_dark: null }, 'iran').lockup).toEqual({ light: UPLOADED.logo_light, dark: UPLOADED.logo_light });
  });

  it('takes no URL a page could not show safely', () => {
    expect(normalizeBrandAssets({ logo_light: 'javascript:alert(1)', symbol: '//evil.test/x.svg' })).toBeNull();
    expect(normalizeBrandAssets({ logo_light: '/storage/platform/brand/a.svg', logo_dark: 'data:image/svg+xml,<svg/>' }))
      .toMatchObject({ logo_light: '/storage/platform/brand/a.svg', logo_dark: null });
    expect(normalizeBrandAssets('nope')).toBeNull();
  });

  it('keeps the config\'s uploads for the next first paint, and forgets them on a reset', async () => {
    state.data = config('iran', UPLOADED);
    const { result, rerender } = renderHook(() => useBrandAssets());
    expect(result.current.source).toBe('custom');
    await waitFor(() => expect(cachedBrandAssets()).toEqual(UPLOADED));
    state.data = config('iran', null);
    rerender();
    expect(result.current).toMatchObject({ source: 'kit', lockup: WEBYAR_BRAND.logo });
    await waitFor(() => expect(localStorage.getItem(BRAND_ASSETS_CACHE_KEY)).toBeNull());
  });

  it('before the config arrives, the cached uploads', () => {
    localStorage.setItem('wy-edition', 'international');
    localStorage.setItem(BRAND_ASSETS_CACHE_KEY, JSON.stringify(UPLOADED));
    const { result } = renderHook(() => useBrandAssets());
    expect(result.current.lockup?.light).toBe(UPLOADED.logo_light);
  });
});

describe('the marks wear the upload', () => {
  it.each(['iran', 'multi'])('%s: the square mark, the lockup, the launch foot and the auth wordmark', (mode) => {
    state.data = config(mode, UPLOADED);
    const { container } = wrap(
      <div>
        <BrandLogo src="https://cdn.example.test/operator.png" />
        <BrandLockup name="Platform" />
        <BrandFooter />
        <BrandWordmark />
      </div>,
    );
    const imgs = sources(container);
    // Abroad the upload wins over a caller's src as the kit's icon did; in
    // Iran a caller's src is still first.
    expect(imgs[0]).toBe(mode === 'iran' ? 'https://cdn.example.test/operator.png' : UPLOADED.symbol);
    expect(imgs).toEqual(expect.arrayContaining([UPLOADED.logo_light, UPLOADED.logo_dark]));
    expect(container.querySelector('.wy-brand-footer .wy-brand-light')?.getAttribute('src')).toBe(UPLOADED.logo_light);
    expect(container.querySelector('.wy-brand-footer .wy-brand-dark')?.getAttribute('src')).toBe(UPLOADED.logo_dark);
    expect(container.querySelectorAll('img[data-brand-upload="lockup"]')).toHaveLength(2);
    expect(container.querySelectorAll('img[data-brand-upload="wordmark"]')).toHaveLength(2);
    expect(container.innerHTML).not.toMatch(/\/brand\/(webyar|intl)\//);
  });

  it('the square mark: the uploaded symbol, fitted', () => {
    state.data = config('iran', UPLOADED);
    const img = wrap(<BrandImage variant="symbol" alt="Platform" />).container.querySelector('img')!;
    expect(img.getAttribute('src')).toBe(UPLOADED.symbol);
    expect(img.getAttribute('data-brand-upload')).toBe('symbol');
    expect(img.className).toContain('object-contain');
    expect(img.getAttribute('alt')).toBe('Platform');
  });

  it('without an upload: exactly the kit\'s marks, as before', () => {
    state.data = config('multi');
    const { container } = wrap(<div><BrandLockup name="Platform" /><BrandWordmark /></div>);
    expect(sources(container)).toEqual([INTL_BRAND.horizontal.light, INTL_BRAND.horizontal.dark, INTL_BRAND.wordmark.light, INTL_BRAND.wordmark.dark]);
    expect(container.querySelector('[data-brand-upload]')).toBeNull();
  });

  it('the receipt: the uploaded logo\'s light file (the sheet is always light)', () => {
    state.data = config('multi', UPLOADED);
    const receipt = {
      id: 'l', kind: 'topup', amount_minor: 1500, balance_after: 1500, currency: 'USD', plan_id: null, billing_interval: null,
      period_start: null, period_end: null, payment_id: 'p', receipt_number: 'RS-1', net_minor: 1500, tax_minor: 0, tax_percent: null,
      buyer: {}, seller: {}, description: {}, created_at: '2026-10-01T09:00:00Z',
    };
    const { container } = wrap(<ReceiptDocument receipt={receipt as never} locale="en" dir="ltr" />);
    const head = container.querySelector('[data-receipt-logo]')!;
    expect(head.getAttribute('data-receipt-logo')).toBe('upload');
    expect(head.getAttribute('src')).toBe(UPLOADED.logo_light);
  });

  it('a browser notification wears the uploaded symbol\'s 192 px PNG', () => {
    expect(notificationIcon()).toBe(WEBYAR_BRAND.pwa192);
    localStorage.setItem(BRAND_ASSETS_CACHE_KEY, JSON.stringify(UPLOADED));
    expect(notificationIcon()).toBe(UPLOADED.icon_192);
  });
});

describe('the head: favicon and home-screen icon', () => {
  function mount() {
    document.head.innerHTML = '<link rel="icon" href="/favicon.png" type="image/png"><link rel="apple-touch-icon" href="/apple-touch-icon.png">';
    wrap(<PlatformBrandingGate><span>app</span></PlatformBrandingGate>);
    const q = (sel: string, attr: string) => document.head.querySelector(sel)?.getAttribute(attr) ?? null;
    return { icon: () => q('link[rel="icon"]', 'href'), type: () => q('link[rel="icon"]', 'type'), touch: () => q('link[rel="apple-touch-icon"]', 'href'), mask: () => q('link[rel="mask-icon"]', 'href') };
  }

  it.each(['iran', 'multi'])('%s: the uploaded symbol\'s PNGs, over the kit', async (mode) => {
    state.data = config(mode, UPLOADED);
    const h = mount();
    await waitFor(() => expect(h.icon()).toBe(UPLOADED.icon_192));
    expect(h.type()).toBe('image/png');
    expect(h.touch()).toBe(UPLOADED.apple_touch_180);
    // The kit's pinned-tab mask draws the kit's symbol: not under an upload.
    expect(h.mask()).toBeNull();
  });

  it('a logo alone changes no icon', async () => {
    state.data = config('multi', { ...UPLOADED, symbol: null, apple_touch_180: null, icon_192: null, icon_512: null });
    const h = mount();
    await waitFor(() => expect(h.icon()).toBe(INTL_BRAND.appIcon));
    expect(h.touch()).toBe(INTL_BRAND.appleTouchIcon);
  });
});

describe('the boot splash (index.html), from the cached uploads', () => {
  const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
  const splash = /<div id="boot-splash"[\s\S]*?\n {4}<\/div>/.exec(html)![0];
  const script = /<script>\s*(\/\/ International mode[\s\S]*?)<\/script>/.exec(html)![1];

  function boot(storage: Record<string, string>) {
    localStorage.clear();
    for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v);
    document.head.innerHTML = '<link rel="icon" href="/favicon.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png">';
    document.body.innerHTML = splash;
    new Function(script)();
    return {
      foot: document.querySelector('#boot-splash .wy-footer') as HTMLElement,
      icon: document.querySelector('link[rel="icon"]')!.getAttribute('href'),
      touch: document.querySelector('link[rel="apple-touch-icon"]')!.getAttribute('href'),
    };
  }

  it.each(['iran', 'international'])('%s: the uploaded lockup at the foot, the symbol\'s icons in the head', (edition) => {
    const out = boot({ 'wy-edition': edition, [BRAND_ASSETS_CACHE_KEY]: JSON.stringify(UPLOADED) });
    expect(out.foot.className).toBe('wy-footer wy-brand-footer');
    expect(sources(out.foot)).toEqual([UPLOADED.logo_light, UPLOADED.logo_dark]);
    expect(out.icon).toBe(UPLOADED.icon_192);
    expect(out.touch).toBe(UPLOADED.apple_touch_180);
  });

  it('nothing cached, or nothing usable: the edition\'s splash, untouched', () => {
    expect(boot({ 'wy-edition': 'international' }).foot.className).toBe('wy-footer wy-intl-footer');
    const evil = boot({ 'wy-edition': 'iran', [BRAND_ASSETS_CACHE_KEY]: JSON.stringify({ logo_light: 'javascript:alert(1)', symbol: 'x', icon_192: '"><script>' }) });
    expect(evil.foot.className).toBe('wy-footer wy-kit-footer');
    expect(evil.icon).toBe('/brand/webyar/favicon.svg');
    expect(boot({ [BRAND_ASSETS_CACHE_KEY]: '{not json' }).icon).toBe('/favicon.png');
  });
});
