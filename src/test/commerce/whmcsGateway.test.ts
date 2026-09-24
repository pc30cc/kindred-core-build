/**
 * The WHMCS gateway's cost and safety rules, end to end over the signed
 * protocol (support/fakeWhmcs.ts verifies every request with the real
 * signer).
 *
 *   scenario 7  — cache entries never cross customers, accounts,
 *                 installations or workspaces;
 *   scenario 8  — revoke / permission change is not bypassed by the cache;
 *   scenario 11 — a WHMCS failure never becomes a fabricated answer;
 *   cost rules  — identical concurrent reads coalesce, per-turn budget,
 *                 circuit breaker, bounded retry, health written on change.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb, type FakeDb } from './support/fakeSupabase';
import { createFakeWhmcs, BASE, ORIGIN, type FakeWhmcs } from './support/fakeWhmcs';
import type { CommerceConnectionRow } from '../../../server/services/commerce/gateway.js';

const SECRET = 'whmcs-secret-gateway-tests';
const INSTALL = '9418e6df-2080-466c-a7e5-66eb563830a8';
const WS = '6ee40d07-32a3-4594-8a5f-d439f81afa5b';

let db: FakeDb;
let whmcs: FakeWhmcs;

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => db.client }));
vi.mock('../../../server/services/commerce/credentials.js', () => ({
  readInstallationSecret: async () => { db.ops.push({ table: 'plugin_secrets', verb: 'select' }); return SECRET; },
}));
vi.mock('../../../server/middleware/featureGating.js', () => ({ checkEntitlementFromDB: async () => ({ allowed: true }) }));

const gateway = await import('../../../server/services/commerce/whmcs/gateway.js');
const { WhmcsConnector } = await import('../../../server/services/commerce/connectors/whmcs.js');
const normalize = await import('../../../server/services/commerce/whmcs/normalize.js');
const CONFIG = { supabaseUrl: 'x', supabaseServiceRoleKey: 'k' } as Parameters<typeof gateway.createWhmcsTurnContext>[0];

function connection(over: Partial<CommerceConnectionRow> = {}): CommerceConnectionRow {
  return {
    id: 'conn-whmcs', workspace_id: WS, installation_id: INSTALL, provider_type: 'whmcs', store_id: BASE, approved_origin: ORIGIN,
    capabilities: ['catalog.read', 'identity.grant', 'account.services.read', 'account.invoices.read', 'account.domains.read', 'account.orders.read', 'account.tickets.read'],
    permissions: { catalog: true, services: true, invoices: true, domains: true, orders: true, tickets: true },
    health: 'connected', catalog_ready: false, revoked_at: null, protocol_version: 'webyar-commerce/1', ...over,
  };
}

const alice = { grantId: 'a'.repeat(32), userId: '1', clientId: '10' };
const bob = { grantId: 'b'.repeat(32), userId: '2', clientId: '20' };

function turn(conn = connection(), deadlineMs?: number) {
  return gateway.createWhmcsTurnContext(CONFIG, WS, conn, {
    deadlineMs,
    connectorFactory: (t) => new WhmcsConnector(t, whmcs.requester),
  });
}

const scope = { origin: ORIGIN, baseUrl: BASE };
const servicesList = (grant = alice, freshOnly = false) => ({
  op: 'services.list' as const, params: { limit: 10 }, permission: 'services' as const, grant, userPermission: 'products' as const,
  freshOnly, normalize: (d: unknown) => normalize.normalizeServicePage(d, scope),
});

beforeEach(() => {
  gateway.__resetWhmcsRuntimeForTests();
  db = createFakeDb({ commerce_connections: [connection() as unknown as Record<string, unknown>] });
  whmcs = createFakeWhmcs(SECRET, INSTALL);
  whmcs.grants.set(alice.grantId, { uid: '1', cid: '10', valid: true });
  whmcs.grants.set(bob.grantId, { uid: '2', cid: '20', valid: true });
  whmcs.permissions.set('1:10', ['products', 'invoices', 'domains', 'orders', 'tickets']);
  whmcs.permissions.set('2:20', ['products', 'invoices', 'domains', 'orders', 'tickets']);
});

describe('public catalogue cache', () => {
  it('a repeated plan question inside the TTL makes no WHMCS call', async () => {
    const req = { op: 'catalog.browse' as const, params: { limit: 10 }, permission: 'catalog' as const, normalize: (d: unknown) => normalize.normalizeCatalog(d, scope) };
    const first = await gateway.whmcsRead(turn(), req);
    const second = await gateway.whmcsRead(turn(), req);
    expect(first.source).toBe('live');
    expect(second.source).toBe('cache');
    expect(whmcs.calls.map((c) => c.op)).toEqual(['catalog.browse']);
  });
});

describe('private cache: never on TTL alone', () => {
  it('a warm entry is served only after a live session check in this turn', async () => {
    await gateway.whmcsRead(turn(), servicesList());
    whmcs.calls.length = 0;
    const again = await gateway.whmcsRead(turn(), servicesList());
    expect(again.source).toBe('cache');
    expect(whmcs.calls.map((c) => c.op)).toEqual(['session.check']);
  });

  it('asking for the current state bypasses the cache', async () => {
    await gateway.whmcsRead(turn(), servicesList());
    whmcs.calls.length = 0;
    const fresh = await gateway.whmcsRead(turn(), servicesList(alice, true));
    expect(fresh.source).toBe('live');
    expect(whmcs.calls.map((c) => c.op)).toEqual(['services.list']);
  });

  it('after logout the cached data is dropped and never served', async () => {
    await gateway.whmcsRead(turn(), servicesList());
    whmcs.grants.get(alice.grantId)!.valid = false;
    await expect(gateway.whmcsRead(turn(), servicesList())).rejects.toMatchObject({ code: 'identity_expired' });
    // Even if the grant came back, the old entry is gone: the next read is live.
    whmcs.grants.get(alice.grantId)!.valid = true;
    whmcs.calls.length = 0;
    const next = await gateway.whmcsRead(turn(), servicesList());
    expect(next.source).toBe('live');
  });

  it('a permission removed in WHMCS is enforced on the warm path too', async () => {
    await gateway.whmcsRead(turn(), servicesList());
    whmcs.permissions.set('1:10', ['tickets']);
    await expect(gateway.whmcsRead(turn(), servicesList())).rejects.toMatchObject({ code: 'account_permission_denied' });
  });

  it('an owner permission switched off in Web Yar is refused before any call', async () => {
    const conn = connection({ permissions: { services: false } });
    await expect(gateway.whmcsRead(turn(conn), servicesList())).rejects.toMatchObject({ code: 'commerce_permission_denied' });
    expect(whmcs.calls).toEqual([]);
  });

  it('entries never cross customers, accounts, installations or workspaces', () => {
    const conn = connection();
    const keys = new Set([
      gateway.whmcsCacheKey(conn, WS, alice, 'services.list', { limit: 10 }),
      gateway.whmcsCacheKey(conn, WS, bob, 'services.list', { limit: 10 }),
      gateway.whmcsCacheKey(conn, WS, { ...alice, clientId: '30' }, 'services.list', { limit: 10 }),
      gateway.whmcsCacheKey(conn, WS, { ...alice, grantId: 'c'.repeat(32) }, 'services.list', { limit: 10 }),
      gateway.whmcsCacheKey(connection({ installation_id: 'other-install' }), WS, alice, 'services.list', { limit: 10 }),
      gateway.whmcsCacheKey(conn, 'other-workspace', alice, 'services.list', { limit: 10 }),
      gateway.whmcsCacheKey(connection({ permissions: { services: true } }), WS, alice, 'services.list', { limit: 10 }),
      gateway.whmcsCacheKey(conn, WS, alice, 'services.list', { limit: 5 }),
      gateway.whmcsCacheKey(conn, WS, alice, 'invoices.list', { limit: 10 }),
    ]);
    expect(keys.size).toBe(9);
    // Same logical input, different key order → same key.
    expect(gateway.whmcsCacheKey(conn, WS, alice, 'invoices.list', { limit: 10, filter: 'unpaid' }))
      .toBe(gateway.whmcsCacheKey(conn, WS, alice, 'invoices.list', { filter: 'unpaid', limit: 10 }));
  });

  it('Bob never receives Alice’s cached services', async () => {
    const a = await gateway.whmcsRead(turn(), servicesList(alice));
    const b = await gateway.whmcsRead(turn(), servicesList(bob));
    expect((a.value as { items: Array<{ id: string }> }).items.map((i) => i.id)).toEqual(['101', '102']);
    expect((b.value as { items: Array<{ id: string }> }).items.map((i) => i.id)).toEqual(['201']);
    expect(b.source).toBe('live');
  });
});

describe('coalescing, budget, deadline, retry', () => {
  it('ten identical concurrent reads make one WHMCS call', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => gateway.whmcsRead(turn(), servicesList(alice, true))));
    expect(results).toHaveLength(10);
    expect(whmcs.calls.filter((c) => c.op === 'services.list')).toHaveLength(1);
  });

  it('a turn cannot make more than three WHMCS calls', async () => {
    const ctx = turn();
    for (let i = 0; i < 3; i++) await gateway.whmcsRead(ctx, { ...servicesList(alice, true), params: { limit: 10 - i } });
    await expect(gateway.whmcsRead(ctx, { ...servicesList(alice, true), params: { limit: 4 } })).rejects.toMatchObject({ code: 'rate_limited' });
    expect(whmcs.calls).toHaveLength(3);
  });

  it('a transient failure is retried once; an application error never is', async () => {
    let attempts = 0;
    const flaky = createFakeWhmcs(SECRET, INSTALL);
    flaky.grants = whmcs.grants;
    flaky.permissions = whmcs.permissions;
    const ctx = gateway.createWhmcsTurnContext(CONFIG, WS, connection(), {
      connectorFactory: (t) => new WhmcsConnector(t, async (req) => {
        attempts += 1;
        if (attempts === 1) throw new (await import('../../../shared/commerce/types.js')).CommerceError('commerce_live_unavailable', 'ECONNRESET');
        return flaky.requester(req);
      }),
    });
    const res = await gateway.whmcsRead(ctx, servicesList(alice, true));
    expect(res.source).toBe('live');
    expect(attempts).toBe(2);

    whmcs.grants.get(alice.grantId)!.valid = false;
    await expect(gateway.whmcsRead(turn(), servicesList(alice, true))).rejects.toMatchObject({ code: 'identity_expired' });
    expect(whmcs.calls.filter((c) => c.status === 403)).toHaveLength(1);
  });

  it('a slow WHMCS is cut at the turn deadline — no answer is invented', async () => {
    whmcs.mode = 'slow';
    const started = Date.now();
    await expect(gateway.whmcsRead(turn(connection(), 300), servicesList(alice, true))).rejects.toMatchObject({ code: 'commerce_timeout' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('circuit breaker and health writes', () => {
  it('opens after three consecutive outages, writes health once, then stops calling', async () => {
    whmcs.mode = 'down';
    for (let i = 0; i < 3; i++) {
      await expect(gateway.whmcsRead(turn(), servicesList(alice, true))).rejects.toMatchObject({ code: 'commerce_live_unavailable' });
    }
    const healthWrites = () => db.ops.filter((o) => o.table === 'commerce_connections' && o.verb === 'update').length;
    await new Promise((r) => setTimeout(r, 0));
    expect(healthWrites()).toBe(1);
    expect(db.tables.commerce_connections[0].health).toBe('offline');

    whmcs.mode = 'ok';
    whmcs.calls.length = 0;
    await expect(gateway.whmcsRead(turn(), servicesList(alice, true))).rejects.toMatchObject({ code: 'commerce_live_unavailable' });
    expect(whmcs.calls).toEqual([]);
  });

  it('only a refused signature marks the connection as an authentication error', async () => {
    const healthOf = () => db.tables.commerce_connections[0].health;

    // The WHMCS admin switched "services" off in the addon: not a credential problem.
    whmcs.disabledSections.add('services');
    await expect(gateway.whmcsRead(turn(), servicesList())).rejects.toMatchObject({ code: 'commerce_permission_denied' });
    expect(healthOf()).toBe('connected');

    // Web Yar's secret no longer matches the addon's: that is one.
    whmcs.disabledSections.clear();
    whmcs.secret = 'rotated-in-whmcs';
    await expect(gateway.whmcsRead(turn(), servicesList())).rejects.toMatchObject({ code: 'commerce_permission_denied' });
    await new Promise((r) => setTimeout(r, 0));
    expect(healthOf()).toBe('authentication_error');
  });

  it('a successful read does not write health every time', async () => {
    for (let i = 0; i < 5; i++) await gateway.whmcsRead(turn(), servicesList(alice, true));
    await new Promise((r) => setTimeout(r, 0));
    const writes = db.ops.filter((o) => o.table === 'commerce_connections' && o.verb === 'update').length;
    expect(writes).toBeLessThanOrEqual(1); // last_seen_at at most once per 15 minutes
  });
});

describe('bounded memory', () => {
  it('the cache stays within its caps under load', async () => {
    for (let i = 0; i < 60; i++) {
      const grant = { grantId: String(i).padStart(32, '0'), userId: '1', clientId: '10' };
      whmcs.grants.set(grant.grantId, { uid: '1', cid: '10', valid: true });
      await gateway.whmcsRead(turn(), servicesList(grant, true));
    }
    const stats = gateway.whmcsRuntimeStats();
    expect(stats.cache.entries).toBeLessThanOrEqual(2_000);
    expect(stats.cache.bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(stats.cache.inflight).toBe(0);
  });
});
