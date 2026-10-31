// @vitest-environment node
/**
 * The PWA manifest (GET /api/manifest.webmanifest, server/routes/manifest.ts)
 * is the dashboard's: PlatformBrandingGate asks it with the UI language, and
 * the app it installs opens on the panel. So its language is one of the
 * PANEL's (shared/panelLanguages.ts), not the visitors': a WebYar panel the
 * Super Admin opened to English gets an English, left-to-right manifest with
 * the English description, and still WebYar's icons. A language the panel
 * does not offer gives the panel's default. The live rows of both brands
 * answer as before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { WEBYAR_BRAND } from '../../../shared/webyarBrand';
import { INTL_BRAND } from '../../../shared/internationalMode';

const h = vi.hoisted(() => ({ settings: null as Record<string, unknown> | null }));

const LOCALIZED = [
  { locale: 'fa', platform_name: 'وبیار', meta_description: 'گفتگوی آنلاین' },
  { locale: 'en', platform_name: 'WebYar', meta_description: 'Live chat' },
  { locale: 'tr', platform_name: 'WebYar TR', meta_description: 'Canlı sohbet' },
];

vi.mock('../../../server/supabase.js', () => {
  const builder = (table: string, filter: { in?: string[] } = {}): object => new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') {
        const rows = table === 'platform_branding_localized'
          ? LOCALIZED.filter((r) => !filter.in || filter.in.includes(r.locale))
          : [];
        return (resolve: (r: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve);
      }
      if (prop === 'maybeSingle' || prop === 'single') {
        return async () => ({ data: table === 'platform_settings' ? h.settings : table === 'platform_branding' ? {} : null, error: null });
      }
      if (prop === 'in') return (_col: string, values: string[]) => builder(table, { ...filter, in: values });
      return () => builder(table, filter);
    },
  });
  return { getServiceClient: () => ({ from: (table: string) => builder(table) }) };
});
vi.mock('../../../server/services/platformBrandAssets.js', () => ({ readCustomBrandAssets: async () => null }));

const { manifestRouter } = await import('../../../server/routes/manifest.js');
const { __resetPlatformRegionCache } = await import('../../../server/services/platformRegion.js');

const app = express();
app.use((req, _res, next) => { Object.assign(req, { serverConfig: { supabaseUrl: 'https://x.supabase.co', supabaseServiceRoleKey: 'k' } }); next(); });
app.use('/api/manifest.webmanifest', manifestRouter);

function platform(row: Record<string, unknown>) {
  h.settings = row;
  __resetPlatformRegionCache();
}

async function manifest(locale?: string) {
  const res = await request(app).get(`/api/manifest.webmanifest${locale ? `?locale=${locale}` : ''}`);
  expect(res.status).toBe(200);
  return JSON.parse(res.text) as { lang: string; dir: string; name: string; description?: string; icons: Array<{ src: string }> };
}

const WEBYAR = { region_mode: 'iran', active_locales: ['fa'], default_locale: 'fa', site_mode: 'single_language' };
const WEBYAR_EN_PANEL = { region_mode: 'iran', active_locales: ['fa', 'en'], default_locale: 'fa', site_mode: 'multi_language' };
const RESPOK = { region_mode: 'multi', active_locales: ['en', 'tr'], default_locale: 'en', site_mode: 'multi_language' };

beforeEach(() => platform(WEBYAR));

describe('the dashboard\'s manifest speaks the panel\'s languages', () => {
  it('WebYar as it is (Persian only): Persian, rtl, whatever the page asks', async () => {
    for (const locale of ['fa', 'en', 'tr', undefined]) {
      const m = await manifest(locale);
      expect(m).toMatchObject({ lang: 'fa', dir: 'rtl', name: 'وبیار', description: 'گفتگوی آنلاین' });
      expect(m.icons[0].src).toBe(WEBYAR_BRAND.pwa192);
    }
  });

  it('WebYar with English on its panel: an English page gets English, ltr, still WebYar\'s icons', async () => {
    platform(WEBYAR_EN_PANEL);
    const en = await manifest('en-US');
    expect(en).toMatchObject({ lang: 'en', dir: 'ltr', name: 'WebYar', description: 'Live chat' });
    expect(en.icons[0].src).toBe(WEBYAR_BRAND.pwa192);
    expect(await manifest('fa')).toMatchObject({ lang: 'fa', dir: 'rtl' });
    // Turkish is not on this panel: its default.
    expect(await manifest('tr')).toMatchObject({ lang: 'fa', dir: 'rtl' });
  });

  it('RESPOK (multi, en and tr): as before, Persian asked gives the default, English', async () => {
    platform(RESPOK);
    expect(await manifest('tr')).toMatchObject({ lang: 'tr', dir: 'ltr', name: 'WebYar TR' });
    expect(await manifest('en')).toMatchObject({ lang: 'en', dir: 'ltr' });
    const fa = await manifest('fa');
    expect(fa).toMatchObject({ lang: 'en', dir: 'ltr' });
    expect(fa.icons[0].src).toBe(INTL_BRAND.pwa192);
  });
});
