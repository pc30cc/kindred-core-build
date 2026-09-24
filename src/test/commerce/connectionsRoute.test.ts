/**
 * The dashboard's commerce connection routes, for the parts WHMCS changed:
 * "Check connection" is a live call to the merchant's server, so it must be
 * tenant-scoped, coalesced and rate-limited; a live-queried provider has no
 * catalogue to sync or count.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createFakeDb, type FakeDb } from './support/fakeSupabase';

const WS = '6ee40d07-32a3-4594-8a5f-d439f81afa5b';
const OTHER_WS = '11111111-1111-1111-1111-111111111111';

let db: FakeDb;
const handshakes: Array<{ connectionId: string; workspaceId?: string }> = [];
let handshakeDelayMs = 0;
const enqueued: string[] = [];
const permissionUpdates: Array<Record<string, boolean>> = [];

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => db.client }));
vi.mock('../../../server/lib/workspaceAuth.js', () => ({
  authorizeWorkspaceAccess: async () => ({ userId: 'user-1', isAdmin: true }),
}));
vi.mock('../../../server/middleware/featureGating.js', () => ({ checkModuleAccess: async () => ({ allowed: true }) }));
vi.mock('../../../server/services/commerce/lifecycle.js', () => ({
  disconnectConnection: async () => {},
  rotateConnectionCredential: async () => {},
  updateConnectionPermissions: async (_c: unknown, _ws: string, _id: string, _u: string, patch: Record<string, boolean>) => { permissionUpdates.push(patch); },
}));
vi.mock('../../../server/services/commerce/sync.js', () => ({
  enqueueSyncJob: async (_c: unknown, _ws: string, id: string) => { enqueued.push(id); return { id: 'job-1' }; },
}));
vi.mock('../../../server/services/commerce/pairing.js', () => ({
  runCapabilityHandshake: async (_c: unknown, connectionId: string, opts: { workspaceId?: string } = {}) => {
    handshakes.push({ connectionId, workspaceId: opts.workspaceId });
    await new Promise((r) => setTimeout(r, handshakeDelayMs));
    const row = db.tables.commerce_connections.find((c) => c.id === connectionId && (!opts.workspaceId || c.workspace_id === opts.workspaceId));
    if (row) row.health = 'connected';
  },
}));

const { commerceConnectionsRouter } = await import('../../../server/routes/commerce/connections.js');

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { (req as unknown as { serverConfig: unknown }).serverConfig = {}; next(); });
  a.use('/api/workspaces', commerceConnectionsRouter);
  return a;
}

function conn(id: string, workspaceId: string, provider: string) {
  return { id, workspace_id: workspaceId, provider_type: provider, store_id: `https://${id}.example.com`, approved_origin: `https://${id}.example.com`, health: 'offline', revoked_at: null, created_at: '2026-09-01T00:00:00Z', permissions: {}, capabilities: [], platform_version: provider === 'whmcs' ? '8.13.1' : undefined };
}

beforeEach(() => {
  handshakes.length = 0;
  enqueued.length = 0;
  permissionUpdates.length = 0;
  handshakeDelayMs = 0;
  db = createFakeDb({
    commerce_connections: [
      conn('whmcs-a', WS, 'whmcs'), conn('whmcs-b', WS, 'whmcs'), conn('whmcs-c', WS, 'whmcs'), conn('whmcs-d', WS, 'whmcs'),
      conn('woo-a', WS, 'woocommerce'),
      conn('foreign', OTHER_WS, 'whmcs'),
    ],
  });
});

describe('POST …/test (Check connection)', () => {
  it('reports what the check observed, with the time it was observed', async () => {
    const res = await request(app()).post(`/api/workspaces/${WS}/commerce/connections/whmcs-a/test`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, health: 'connected', lastErrorCode: null });
    expect(Date.parse(res.body.checkedAt)).toBeGreaterThan(Date.now() - 5000);
    expect(handshakes).toEqual([{ connectionId: 'whmcs-a', workspaceId: WS }]);
  });

  it('another workspace’s connection id is not found, and its server is never contacted', async () => {
    const res = await request(app()).post(`/api/workspaces/${WS}/commerce/connections/foreign/test`);
    expect(res.status).toBe(404);
    expect(handshakes).toEqual([{ connectionId: 'foreign', workspaceId: WS }]);
    expect(db.tables.commerce_connections.find((c) => c.id === 'foreign')?.health).toBe('offline');
  });

  it('five clicks while a check is running share that one check', async () => {
    handshakeDelayMs = 50;
    const a = app();
    const results = await Promise.all(Array.from({ length: 5 }, () => request(a).post(`/api/workspaces/${WS}/commerce/connections/whmcs-b/test`)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(handshakes).toHaveLength(1);
  });

  it('more than six checks a minute are refused before reaching the merchant', async () => {
    const a = app();
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await request(a).post(`/api/workspaces/${WS}/commerce/connections/whmcs-c/test`)).status);
    expect(statuses.slice(0, 6)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(statuses.slice(6)).toEqual([429, 429]);
    expect(handshakes).toHaveLength(6);
  });
});

describe('a live-queried provider has no catalogue', () => {
  it('sync is refused for WHMCS and still works for WooCommerce', async () => {
    const whmcs = await request(app()).post(`/api/workspaces/${WS}/commerce/connections/whmcs-d/sync`);
    expect(whmcs.status).toBe(400);
    expect(whmcs.body).toEqual({ error: 'sync_not_applicable' });
    const woo = await request(app()).post(`/api/workspaces/${WS}/commerce/connections/woo-a/sync`);
    expect(woo.status).toBe(200);
    expect(enqueued).toEqual(['woo-a']);
  });

  it('the WHMCS detail view costs one query and shows the WHMCS version', async () => {
    db.reset();
    const res = await request(app()).get(`/api/workspaces/${WS}/commerce/connections/whmcs-d`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ productCount: null, lastSyncJob: null, connection: { provider_type: 'whmcs', platform_version: '8.13.1' } });
    expect(db.ops).toEqual([{ table: 'commerce_connections', verb: 'select' }]);
  });

  it('the WHMCS permission keys are accepted, unknown keys are not', async () => {
    const ok = await request(app()).patch(`/api/workspaces/${WS}/commerce/connections/whmcs-d/permissions`).send({ services: true, invoices: true, tickets: false });
    expect(ok.status).toBe(200);
    expect(permissionUpdates).toEqual([{ services: true, invoices: true, tickets: false }]);
    const bad = await request(app()).patch(`/api/workspaces/${WS}/commerce/connections/whmcs-d/permissions`).send({ services: true, reboot: true });
    expect(bad.status).toBe(400);
  });
});
