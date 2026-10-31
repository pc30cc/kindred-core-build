// @vitest-environment node
/**
 * GET /help (server/routes/kb.ts) opens the public help center in the
 * platform's default language, kept inside the VISITORS' languages
 * (clampLocaleToPlatformRegion: Iran, Persian only). `default_locale` is the
 * dashboard's default since the Super Admin sets the panel's languages
 * (shared/panelLanguages.ts): a WebYar panel opened in English must not
 * send its visitors to /help/en. RESPOK keeps its default.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const h = vi.hoisted(() => ({ settings: null as Record<string, unknown> | null }));

vi.mock('../../../server/supabase.js', () => {
  const builder = (table: string): object => new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (r: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
      if (prop === 'maybeSingle' || prop === 'single') {
        return async () => ({ data: table === 'platform_settings' ? h.settings : null, error: null });
      }
      return () => builder(table);
    },
  });
  return { getServiceClient: () => ({ from: (table: string) => builder(table), rpc: () => builder('rpc') }) };
});

const { publicKbRouter } = await import('../../../server/routes/kb.js');
const { __resetPlatformRegionCache } = await import('../../../server/services/platformRegion.js');

const app = express();
app.use((req, _res, next) => { Object.assign(req, { serverConfig: { supabaseUrl: 'https://x.supabase.co', supabaseServiceRoleKey: 'k' } }); next(); });
app.use(publicKbRouter);

function platform(row: Record<string, unknown> | null) {
  h.settings = row;
  __resetPlatformRegionCache();
}

async function helpRedirect(): Promise<string | undefined> {
  const res = await request(app).get('/help');
  expect(res.status).toBe(302);
  return res.headers.location;
}

beforeEach(() => platform(null));

describe('GET /help opens the help center in a visitor language', () => {
  it('WebYar (iran, Persian only): /help/fa', async () => {
    platform({ region_mode: 'iran', active_locales: ['fa'], default_locale: 'fa', site_mode: 'single_language' });
    expect(await helpRedirect()).toBe('/help/fa');
  });

  it('WebYar with its dashboard opened in English: still /help/fa', async () => {
    platform({ region_mode: 'iran', active_locales: ['fa', 'en'], default_locale: 'en', site_mode: 'multi_language' });
    expect(await helpRedirect()).toBe('/help/fa');
    platform({ region_mode: 'iran', active_locales: ['en'], default_locale: 'en', site_mode: 'single_language' });
    expect(await helpRedirect()).toBe('/help/fa');
  });

  it('RESPOK (multi, en and tr, default en): /help/en, as before', async () => {
    platform({ region_mode: 'multi', active_locales: ['en', 'tr'], default_locale: 'en', site_mode: 'multi_language' });
    expect(await helpRedirect()).toBe('/help/en');
  });

  it('a multi-language platform keeps a default its visitors have', async () => {
    platform({ region_mode: 'multi', active_locales: ['en', 'tr'], default_locale: 'tr', site_mode: 'multi_language' });
    expect(await helpRedirect()).toBe('/help/tr');
  });
});
