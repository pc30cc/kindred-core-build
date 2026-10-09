/**
 * Editions phase 3 — Bale (an Iranian messenger) exists in the Iranian
 * edition only: the plugin catalogue (workspace and Super Admin), installing
 * it and the plan capability catalogue all hide it in International. The
 * Iranian edition — and an unknown edition — list it exactly as before.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';

const WS = '11111111-1111-4111-8111-111111111111';
const state = vi.hoisted(() => ({ edition: 'iran' as 'iran' | 'international' | null }));

vi.mock('../../../server/services/platformRegion.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/platformRegion.js')>()),
  getPlatformEditionOrNull: async () => state.edition,
}));
vi.mock('../../../server/lib/workspaceAuth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/lib/workspaceAuth.js')>()),
  authorizeWorkspaceAccess: async () => ({ userId: 'u1', isAdmin: false, role: 'owner' }),
  requirePlatformAdmin: async () => 'admin-1',
  serverConfigOf: (req: { serverConfig?: unknown }) => req.serverConfig,
}));
vi.mock('../../../server/middleware/featureGating.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/middleware/featureGating.js')>()),
  checkChannelAccess: async () => ({ allowed: true }),
  checkModuleAccess: async () => ({ allowed: true }),
}));
vi.mock('../../../server/services/plugins/state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/plugins/state.js')>();
  const { PLUGIN_REGISTRY } = await import('../../../server/plugins/registry.js');
  const row = (id: string) => ({
    plugin_id: id, enabled: true, marketplace_visible: true, installable: true, maintenance_mode: false,
    featured: false, sort_order: 0, rollout_status: 'public', policy: {},
  });
  return {
    ...actual,
    listPlatformState: async () => PLUGIN_REGISTRY.map((p) => row(p.id)),
    getPlatformState: async (_c: unknown, id: string) => row(id),
    listInstallations: async () => [],
    installPlugin: async () => ({ id: 'inst-1', status: 'active' }),
  };
});

const { pluginsRouter, adminPluginsRouter } = await import('../../../server/routes/plugins.js');
const { plansRouter } = await import('../../../server/routes/plans.js');

const app = express();
app.use((req, _res, next) => {
  (req as unknown as { serverConfig: unknown }).serverConfig = { supabaseUrl: 'http://db', supabaseServiceRoleKey: 'k' };
  next();
});
app.use(express.json());
app.use('/api/plugins', pluginsRouter);
app.use('/api/admin/plugins', adminPluginsRouter);
app.use('/api/plans', plansRouter);
const server = http.createServer(app).listen(0);
afterAll(() => server.close());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: (server.address() as { port: number }).port, path, method, headers: { 'content-type': 'application/json', connection: 'close' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: data ? JSON.parse(data) : {} }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

const ids = (items: Array<{ id: string }>) => items.map((i) => i.id);

beforeEach(() => {
  state.edition = 'iran';
});

describe('Bale × edition', () => {
  it.each(['iran', null] as const)('edition %s: Bale is listed, installable and a plan channel — as before', async (edition) => {
    state.edition = edition;
    const catalog = await call('GET', `/api/plugins/catalog?workspace_id=${WS}`);
    expect(catalog.status).toBe(200);
    expect(ids(catalog.body.items)).toEqual(expect.arrayContaining(['bale', 'telegram']));
    expect(ids((await call('GET', '/api/admin/plugins')).body.items)).toContain('bale');
    const caps = await call('GET', '/api/plans/capabilities?type=channel');
    expect(caps.body.capabilities.map((c: { key: string }) => c.key)).toContain('bale');
    const install = await call('POST', '/api/plugins/install', { workspace_id: WS, plugin_id: 'bale' });
    expect(install.status).toBe(200);
  });

  it('International: no Bale in the catalogue, the admin list or the plan capabilities; install refused', async () => {
    state.edition = 'international';
    const catalog = await call('GET', `/api/plugins/catalog?workspace_id=${WS}`);
    expect(catalog.status).toBe(200);
    expect(ids(catalog.body.items)).not.toContain('bale');
    expect(ids(catalog.body.items)).toContain('telegram');
    expect(ids((await call('GET', '/api/admin/plugins')).body.items)).not.toContain('bale');
    const caps = await call('GET', '/api/plans/capabilities');
    const keys = caps.body.capabilities.map((c: { key: string }) => c.key);
    expect(keys).not.toContain('bale');
    expect(keys).toContain('telegram');
    const install = await call('POST', '/api/plugins/install', { workspace_id: WS, plugin_id: 'bale' });
    expect(install).toMatchObject({ status: 403, body: { reason: 'not_available_in_edition' } });
    // Other channels are unaffected.
    expect((await call('POST', '/api/plugins/install', { workspace_id: WS, plugin_id: 'telegram' })).status).toBe(200);
  });
});
