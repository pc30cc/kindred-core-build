// @vitest-environment node
/**
 * The server-rendered help center (GET /help/..., server/routes/kb.ts): the
 * platform's OWN help center (its own workspace's) wears what the Super Admin
 * uploaded — the logo at its head, the symbol in the tab — from the one place
 * the logo is set (server/services/platformBrandAssets.ts). It never wore the
 * kit's, so without an upload it is exactly as before; a customer's help
 * center, on the customer's domain, shows none of it either way. The host
 * probe the SPA's help pages ask says which help center it is.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const PLATFORM_WS = '0b7d6c00-0000-4000-8000-0000000000aa';
const CUSTOMER_WS = '0b7d6c00-0000-4000-8000-0000000000bb';
const LOGO = 'https://cdn.example.test/platform/brand/a-logo-light.svg';
const ICON = 'https://cdn.example.test/platform/brand/d-symbol-192.png';
const h = vi.hoisted(() => ({
  workspace: '' as string | null,
  uploads: null as null | { logo_light: string | null; icon_192: string | null; symbol: string | null },
}));

vi.mock('../../../server/supabase.js', () => {
  const builder: object = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (r: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
      if (prop === 'maybeSingle' || prop === 'single') return async () => ({ data: null, error: null });
      return () => builder;
    },
  });
  return { getServiceClient: () => ({ from: () => builder, rpc: () => builder }) };
});
vi.mock('../../../server/services/widget/public.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/public.js')>()),
  resolveWorkspaceIdFromOrigin: async () => h.workspace,
}));
vi.mock('../../../server/services/platformHosts.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/platformHosts.js')>()),
  isPlatformWorkspace: async (_config: unknown, id: string) => id === PLATFORM_WS,
}));
vi.mock('../../../server/services/knowledge-base/locks.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/knowledge-base/locks.js')>()),
  resolveKbLock: async () => ({ active: false, cut: null }),
}));
vi.mock('../../../server/services/platformPublicConfig.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/platformPublicConfig.js')>()),
  getPlatformPublicConfig: async () => ({
    branding: null,
    localized: [{ locale: 'en', platform_name: 'Acme <Help>' }, { locale: 'fa', platform_name: 'آکمه' }],
    region: null,
    realtime: null,
    brand: { edition: 'international', site_url: 'https://acme.example', support_email: null },
    sms_verification: false,
    brand_assets: h.uploads
      ? { logo_dark: null, logo_png_light: null, logo_png_dark: null, logo_png_width: null, logo_png_height: null, apple_touch_180: null, icon_512: null, ...h.uploads }
      : null,
  }),
}));

const { publicKbRouter, widgetKbRouter } = await import('../../../server/routes/kb.js');
const app = express();
app.use((req, _res, next) => { Object.assign(req, { serverConfig: { supabaseUrl: 'https://x.supabase.co' } }); next(); });
app.use('/api/widget/kb', widgetKbRouter);
app.use(publicKbRouter);

beforeEach(() => {
  h.workspace = PLATFORM_WS;
  h.uploads = { logo_light: LOGO, icon_192: ICON, symbol: 'https://cdn.example.test/platform/brand/c-symbol.svg' };
});

describe('the help center\'s head', () => {
  it('the platform\'s own: its uploaded logo, linked home and named, and its icon', async () => {
    const res = await request(app).get('/help/en');
    expect(res.status).toBe(200);
    expect(res.text).toContain(`<a class="kb-brand" href="/help/en"><img src="${LOGO}" alt="Acme &lt;Help&gt;" /></a>`);
    expect(res.text).toContain(`<link rel="icon" type="image/png" href="${ICON}" />`);
    expect(res.text).toContain('.kb-brand img{');
    const search = await request(app).get('/help/fa/search?q=x');
    expect(search.text).toContain(`href="/help/fa"><img src="${LOGO}" alt="آکمه"`);
  });

  it('the platform\'s own without an upload: byte for byte a page that never had a brand', async () => {
    h.uploads = null;
    // One host for both, so the page's own URLs are the same.
    const own = await request(app).get('/help/en').set('Host', 'help.example.test');
    expect(own.status).toBe(200);
    expect(own.text).not.toContain('kb-brand');
    expect(own.text).not.toContain('rel="icon"');
    h.workspace = CUSTOMER_WS;
    const customer = await request(app).get('/help/en').set('Host', 'help.example.test');
    expect(own.text).toBe(customer.text);
    // The shell's lines as they always were: no line left empty by a missing piece.
    expect(own.text).toMatch(/<link rel="canonical" href="[^"]*" \/>\n {2}<link rel="alternate"/);
    expect(own.text).toContain('.kb-empty{color:#666;padding:24px 0;}\n  </style>');
  });

  it('only a symbol uploaded: the tab icon, no head logo', async () => {
    h.uploads = { logo_light: null, icon_192: ICON, symbol: 'https://cdn.example.test/platform/brand/c-symbol.svg' };
    const res = await request(app).get('/help/en');
    expect(res.text).toContain(`<link rel="icon" type="image/png" href="${ICON}" />`);
    expect(res.text).not.toContain('kb-brand');
  });

  it('a customer\'s: nothing of the platform\'s, as before', async () => {
    h.workspace = CUSTOMER_WS;
    const res = await request(app).get('/help/en');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('kb-brand');
    expect(res.text).not.toContain('rel="icon"');
    expect(res.text).not.toContain('cdn.example.test');
  });
});

describe('the host probe (GET /api/widget/kb/help-host)', () => {
  it('says whether the help center is the platform\'s own', async () => {
    expect((await request(app).get('/api/widget/kb/help-host')).body).toEqual({ workspace_id: PLATFORM_WS, platform: true });
    h.workspace = CUSTOMER_WS;
    expect((await request(app).get('/api/widget/kb/help-host')).body).toEqual({ workspace_id: CUSTOMER_WS, platform: false });
  });
});
