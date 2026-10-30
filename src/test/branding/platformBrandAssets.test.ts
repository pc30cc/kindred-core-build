// @vitest-environment node
/**
 * The one server resolver of the platform's logo
 * (server/services/platformBrandAssets.ts): what the Super Admin uploaded,
 * else the edition's kit made absolute against a base (the app's address by
 * default); an unknown edition answers null so callers keep what they
 * showed. The email package reads `logo`, `logoPng`, `symbol` and `icons`
 * under exactly these names.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const source = vi.hoisted(() => ({
  value: null as null | { edition: 'iran' | 'international'; custom: Record<string, unknown> | null; appBaseUrl: string | null },
  fail: false,
  lookups: [] as string[],
}));

vi.mock('../../../server/services/platformPublicConfig.js', () => ({
  getPlatformBrandSource: async () => {
    if (source.fail) throw new Error('database down');
    return source.value;
  },
}));
vi.mock('../../../server/services/storage/urlResolver.js', () => ({
  createStorageUrlResolver: () => ({
    platform: async (key: string | null | undefined) => {
      if (key) source.lookups.push(key);
      return key && key.startsWith('platform/') ? `https://cdn.test/${key}` : null;
    },
  }),
}));

const {
  brandAssetsFor,
  customBrandAssetsFromRow,
  readCustomBrandAssets,
  resolveBrandAssets,
} = await import('../../../server/services/platformBrandAssets');
const { WEBYAR_BRAND } = await import('../../../shared/webyarBrand');
const { INTL_BRAND } = await import('../../../shared/internationalMode');

const CONFIG = { corsOrigins: ['*', 'https://cors.example.test'] } as never;

const UPLOADED = {
  logo_light: 'https://cdn.test/platform/brand/1-logo-light.svg',
  logo_dark: null,
  logo_png_light: 'https://cdn.test/platform/brand/2-logo-light-email.png',
  logo_png_dark: null,
  logo_png_width: 300,
  logo_png_height: 120,
  symbol: 'https://cdn.test/platform/brand/3-symbol.svg',
  apple_touch_180: 'https://cdn.test/platform/brand/4-symbol-180.png',
  icon_192: 'https://cdn.test/platform/brand/5-symbol-192.png',
  icon_512: 'https://cdn.test/platform/brand/6-symbol-512.png',
};

beforeEach(() => {
  source.value = null;
  source.fail = false;
  source.lookups = [];
  delete process.env.APP_BASE_URL;
});
afterEach(() => {
  delete process.env.APP_BASE_URL;
});

describe('brandAssetsFor: the kit, unless uploaded', () => {
  it('Iran: WebYar\'s kit, absolute on the base, with its email PNGs', () => {
    expect(brandAssetsFor('iran', null, 'https://app.webyar.ai')).toEqual({
      source: 'kit',
      logo: { light: `https://app.webyar.ai${WEBYAR_BRAND.logo.light}`, dark: `https://app.webyar.ai${WEBYAR_BRAND.logo.dark}` },
      logoPng: {
        light: 'https://app.webyar.ai/brand/webyar/email/webyar-logo.png',
        dark: 'https://app.webyar.ai/brand/webyar/email/webyar-logo-dark.png',
        width: 360,
        height: 139,
      },
      symbol: `https://app.webyar.ai${WEBYAR_BRAND.symbol}`,
      icons: {
        appleTouch180: `https://app.webyar.ai${WEBYAR_BRAND.appleTouchIcon}`,
        png192: `https://app.webyar.ai${WEBYAR_BRAND.pwa192}`,
        png512: `https://app.webyar.ai${WEBYAR_BRAND.pwa512}`,
      },
    });
  });

  it('International: RESPOK\'s kit', () => {
    const a = brandAssetsFor('international', null, 'https://app.respok.app');
    expect(a.source).toBe('kit');
    expect(a.logo).toEqual({ light: `https://app.respok.app${INTL_BRAND.horizontal.light}`, dark: `https://app.respok.app${INTL_BRAND.horizontal.dark}` });
    expect(a.logoPng).toEqual({
      light: 'https://app.respok.app/brand/intl/email/respok-logo.png',
      dark: 'https://app.respok.app/brand/intl/email/respok-logo-dark.png',
      width: 400,
      height: 92,
    });
    expect(a.symbol).toBe(`https://app.respok.app${INTL_BRAND.appIcon}`);
    expect(JSON.stringify(a)).not.toMatch(/webyar/i);
  });

  it('an upload wins in both editions; the dark logo and its PNG fall back to the light ones', () => {
    for (const edition of ['iran', 'international'] as const) {
      const a = brandAssetsFor(edition, UPLOADED, 'https://app.example.test');
      expect(a.source).toBe('custom');
      expect(a.logo).toEqual({ light: UPLOADED.logo_light, dark: UPLOADED.logo_light });
      expect(a.logoPng).toEqual({ light: UPLOADED.logo_png_light, dark: UPLOADED.logo_png_light, width: 300, height: 120 });
      expect(a.symbol).toBe(UPLOADED.symbol);
      expect(a.icons).toEqual({ appleTouch180: UPLOADED.apple_touch_180, png192: UPLOADED.icon_192, png512: UPLOADED.icon_512 });
    }
  });

  it('only a symbol: the kit\'s logo stays, the symbol and its icons are the upload', () => {
    const a = brandAssetsFor('iran', { ...UPLOADED, logo_light: null, logo_png_light: null, logo_png_width: null, logo_png_height: null }, '');
    expect(a.source).toBe('kit');
    expect(a.logo.light).toBe(WEBYAR_BRAND.logo.light);
    expect(a.symbol).toBe(UPLOADED.symbol);
    expect(a.icons.png192).toBe(UPLOADED.icon_192);
  });

  it('a symbol without all its icons keeps the kit\'s icons (never a mix)', () => {
    const a = brandAssetsFor('international', { ...UPLOADED, icon_512: null }, '');
    expect(a.symbol).toBe(UPLOADED.symbol);
    expect(a.icons).toEqual({ appleTouch180: INTL_BRAND.appleTouchIcon, png192: INTL_BRAND.pwa192, png512: INTL_BRAND.pwa512 });
  });
});

describe('resolveBrandAssets', () => {
  it('the platform\'s edition and uploads, the kit on the app\'s address', async () => {
    source.value = { edition: 'iran', custom: null, appBaseUrl: 'https://app.webyar.ai/' };
    const a = await resolveBrandAssets(CONFIG);
    expect(a?.logo.light).toBe(`https://app.webyar.ai${WEBYAR_BRAND.logo.light}`);
    source.value = { edition: 'international', custom: UPLOADED, appBaseUrl: 'https://app.respok.app' };
    expect((await resolveBrandAssets(CONFIG))?.logo.light).toBe(UPLOADED.logo_light);
  });

  it('a base the caller names (the widgets\' asset origin) wins over the app\'s address', async () => {
    source.value = { edition: 'international', custom: null, appBaseUrl: 'https://app.respok.app' };
    const a = await resolveBrandAssets(CONFIG, { base: 'https://assets.respok.app/' });
    expect(a?.logo.light).toBe(`https://assets.respok.app${INTL_BRAND.horizontal.light}`);
  });

  it('without an app address: APP_BASE_URL, then a real CORS origin (never "*")', async () => {
    source.value = { edition: 'iran', custom: null, appBaseUrl: null };
    process.env.APP_BASE_URL = 'https://env.example.test/';
    expect((await resolveBrandAssets(CONFIG))?.symbol).toBe(`https://env.example.test${WEBYAR_BRAND.symbol}`);
    delete process.env.APP_BASE_URL;
    expect((await resolveBrandAssets(CONFIG))?.symbol).toBe(`https://cors.example.test${WEBYAR_BRAND.symbol}`);
  });

  it('an unknown edition answers null: named as null, or a platform whose settings cannot be read', async () => {
    source.value = { edition: 'iran', custom: UPLOADED, appBaseUrl: null };
    expect(await resolveBrandAssets(CONFIG, { edition: null })).toBeNull();
    source.value = null;
    expect(await resolveBrandAssets(CONFIG)).toBeNull();
    source.fail = true;
    expect(await resolveBrandAssets(CONFIG)).toBeNull();
  });

  it('a named edition with an unreadable config: the kit (a mail still has a logo)', async () => {
    source.fail = true;
    const a = await resolveBrandAssets(CONFIG, { edition: 'international', base: 'https://app.respok.app' });
    expect(a?.source).toBe('kit');
    expect(a?.logoPng.light).toBe('https://app.respok.app/brand/intl/email/respok-logo.png');
  });

  it('readCustomBrandAssets: the uploads only, null without', async () => {
    source.value = { edition: 'iran', custom: UPLOADED, appBaseUrl: null };
    expect(await readCustomBrandAssets(CONFIG)).toBe(UPLOADED);
    source.value = { edition: 'iran', custom: null, appBaseUrl: null };
    expect(await readCustomBrandAssets(CONFIG)).toBeNull();
  });
});

describe('customBrandAssetsFromRow: keys to URLs', () => {
  it('no key, no storage lookup', async () => {
    expect(await customBrandAssetsFromRow(CONFIG, { logo_url: 'https://old.example/logo.svg' })).toBeNull();
    expect(await customBrandAssetsFromRow(CONFIG, null)).toBeNull();
    expect(source.lookups).toEqual([]);
  });

  it('the lockup is a pair: no dark logo or PNG counts without a light one', async () => {
    const out = await customBrandAssetsFromRow(CONFIG, {
      logo_dark_storage_key: 'platform/brand/x-logo-dark.svg',
      logo_email_dark_storage_key: 'platform/brand/x-logo-dark-email.png',
      symbol_storage_key: 'platform/brand/s-symbol.png',
      symbol_png_192_storage_key: 'platform/brand/s-symbol-192.png',
    });
    expect(out).toMatchObject({ logo_light: null, logo_dark: null, logo_png_dark: null, symbol: 'https://cdn.test/platform/brand/s-symbol.png', icon_192: 'https://cdn.test/platform/brand/s-symbol-192.png' });
  });

  it('a key outside platform/ is never served, and the PNG\'s size only with the PNG', async () => {
    const out = await customBrandAssetsFromRow(CONFIG, {
      logo_light_storage_key: 'workspace/00000000-0000-0000-0000-000000000000/branding/x.svg',
      logo_email_width: 300,
      logo_email_height: 120,
    });
    expect(out).toBeNull();
    const ok = await customBrandAssetsFromRow(CONFIG, { logo_light_storage_key: 'platform/brand/a-logo-light.svg', logo_email_width: 300, logo_email_height: 120 });
    expect(ok).toMatchObject({ logo_light: 'https://cdn.test/platform/brand/a-logo-light.svg', logo_png_light: null, logo_png_width: null, logo_png_height: null });
  });
});
