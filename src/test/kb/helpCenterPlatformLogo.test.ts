// @vitest-environment node
/**
 * The server-rendered help center (GET /help/..., server/routes/kb.ts): the
 * platform's OWN help center (its own workspace's) wears the platform's logo
 * at its head and its icon in the tab, from the one place the logo is set
 * (server/services/platformBrandAssets.ts); a customer's help center, on the
 * customer's domain, shows none of it, exactly as before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const PLATFORM_WS = '0b7d6c00-0000-4000-8000-0000000000aa';
const CUSTOMER_WS = '0b7d6c00-0000-4000-8000-0000000000bb';
const h = vi.hoisted(() => ({ workspace: '' as string | null }));

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
vi.mock('../../../server/services/platformBrandAssets.js', () => ({
  resolveBrandAssets: async () => ({
    source: 'custom',
    logo: { light: 'https://cdn.example.test/platform/brand/a-logo-light.svg', dark: 'https://cdn.example.test/platform/brand/b-logo-dark.svg' },
    logoPng: { light: '', dark: '', width: 1, height: 1 },
    symbol: 'https://cdn.example.test/platform/brand/c-symbol.svg',
    icons: { appleTouch180: '', png192: 'https://cdn.example.test/platform/brand/d-symbol-192.png', png512: '' },
  }),
}));

const { publicKbRouter } = await import('../../../server/routes/kb.js');
const app = express();
app.use((req, _res, next) => { Object.assign(req, { serverConfig: { supabaseUrl: 'https://x.supabase.co' } }); next(); });
app.use(publicKbRouter);

beforeEach(() => { h.workspace = PLATFORM_WS; });

describe('the help center\'s head', () => {
  it('the platform\'s own: its light logo, linked home, and its icon', async () => {
    const res = await request(app).get('/help/en');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<a class="kb-brand" href="/help/en"><img src="https://cdn.example.test/platform/brand/a-logo-light.svg" alt="" /></a>');
    expect(res.text).toContain('<link rel="icon" type="image/png" href="https://cdn.example.test/platform/brand/d-symbol-192.png" />');
    const search = await request(app).get('/help/fa/search?q=x');
    expect(search.text).toContain('href="/help/fa"><img src="https://cdn.example.test/platform/brand/a-logo-light.svg"');
  });

  it('a customer\'s: nothing of the platform\'s, as before', async () => {
    h.workspace = CUSTOMER_WS;
    const res = await request(app).get('/help/en');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('kb-brand"');
    expect(res.text).not.toContain('rel="icon"');
    expect(res.text).not.toContain('cdn.example.test');
  });
});
