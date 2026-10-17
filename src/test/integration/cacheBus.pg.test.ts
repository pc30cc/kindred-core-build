// @vitest-environment node
/**
 * The cross-node cache invalidation bus (server/lib/cacheBus.ts) on a real
 * PostgreSQL: two "backend processes" (two isolated module instances, each
 * with its own pool, LISTEN connection and instance id) on one database.
 *
 *   - a publish on A runs B's handlers; A runs its own once (its own
 *     notification is ignored);
 *   - isCrossNodeInvalidationActive() turns true only once a node's own
 *     heartbeat NOTIFY has come back, and false when heartbeats stop;
 *   - a killed LISTEN connection reconnects and flushes everything ('all').
 *
 * Driven by TEST_DATABASE_URL; skipped without it. Needs no migrations.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

type Bus = typeof import('../../../server/lib/cacheBus.js');

suite('cache bus over LISTEN/NOTIFY (two nodes, one database)', () => {
  const dbName = `cache_bus_${Date.now()}`;
  let admin: pg.Client;
  let url = '';
  let a: Bus;
  let b: Bus;
  const seenA: Array<string | null> = [];
  const seenB: Array<string | null> = [];

  const dataLayers: Array<{ closeDataLayer: () => Promise<void> }> = [];

  /** A fresh module graph = another backend process (own pool, listener, id). */
  async function loadNode(): Promise<Bus> {
    vi.resetModules();
    dataLayers.push(await import('../../../server/db/index.js'));
    return import('../../../server/lib/cacheBus.js');
  }

  beforeAll(async () => {
    const adminUrl = new URL(DSN!);
    adminUrl.pathname = '/postgres';
    admin = new pg.Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const u = new URL(DSN!);
    u.pathname = `/${dbName}`;
    url = u.toString();
    Object.assign(process.env, { DATABASE_URL: url, DATABASE_ROLE: 'none', DATABASE_SSL: 'disable' });
    delete process.env.DATABASE_MODE;
    a = await loadNode();
    b = await loadNode();
    expect(a.CACHE_BUS_INSTANCE_ID).not.toBe(b.CACHE_BUS_INSTANCE_ID);
    a.onInvalidate('widget', (k) => seenA.push(k));
    b.onInvalidate('widget', (k) => seenB.push(k));
    a.startCacheBusListener();
    b.startCacheBusListener();
    await vi.waitFor(() => {
      expect(a.isCrossNodeInvalidationActive()).toBe(true);
      expect(b.isCrossNodeInvalidationActive()).toBe(true);
    }, { timeout: 10_000 });
  }, 30_000);

  afterAll(async () => {
    await a?.stopCacheBusListener();
    await b?.stopCacheBusListener();
    for (const db of dataLayers) await db.closeDataLayer().catch(() => undefined);
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
    await admin?.end();
  });

  it('every (re)connect flushed this node ("all")', () => {
    expect(seenA).toContain(null);
    expect(seenB).toContain(null);
  });

  it('a publish on A reaches B; A ran its own handler once and ignored its echo', async () => {
    seenA.length = 0;
    seenB.length = 0;
    a.publishCacheInvalidation(['widget:7b0e9d8c-1f2a-4b3c-9d4e-5f6a7b8c9d0e', 'widget:11111111-1111-4111-8111-111111111111']);
    expect(seenA).toEqual(['7b0e9d8c-1f2a-4b3c-9d4e-5f6a7b8c9d0e', '11111111-1111-4111-8111-111111111111']);
    await vi.waitFor(() => expect(seenB).toEqual(['7b0e9d8c-1f2a-4b3c-9d4e-5f6a7b8c9d0e', '11111111-1111-4111-8111-111111111111']), { timeout: 5_000 });
    await new Promise((r) => setTimeout(r, 300));
    expect(seenA).toHaveLength(2);
  });

  it('scopes published in one tick share one NOTIFY', async () => {
    seenB.length = 0;
    const spy = vi.fn();
    const listener = new pg.Client({ connectionString: url });
    await listener.connect();
    await listener.query('LISTEN webyar_cache');
    listener.on('notification', (m) => { if (!String(m.payload).includes('"h"')) spy(m.payload); });
    b.publishCacheInvalidation(['widget:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']);
    b.publishCacheInvalidation(['widget:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']);
    b.publishCacheInvalidation(['widget:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']);
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    expect(JSON.parse(spy.mock.calls[0][0]).s).toEqual(['widget:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'widget:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']);
    await listener.end();
  });

  it('a foreign or malformed notification is ignored', async () => {
    seenB.length = 0;
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    await c.query(`SELECT pg_notify('webyar_cache', 'not json')`);
    await c.query(`SELECT pg_notify('webyar_cache', $1)`, [JSON.stringify({ o: 'x', s: ['Widget:bad', 'widget:a b'] })]);
    await c.query(`SELECT pg_notify('webyar_cache', $1)`, [JSON.stringify({ o: 'x', s: ['widget:ok-key'] })]);
    await vi.waitFor(() => expect(seenB).toEqual(['ok-key']), { timeout: 5_000 });
    await c.end();
  });

  it('a killed LISTEN connection reconnects and flushes everything', async () => {
    const client = b.__cacheBusListenerClientForTests() as unknown as { processID: number } | null;
    expect(client?.processID).toBeTruthy();
    seenB.length = 0;
    await admin.query('SELECT pg_terminate_backend($1)', [client!.processID]);
    await vi.waitFor(() => expect(b.isCrossNodeInvalidationActive()).toBe(false), { timeout: 5_000 });
    await vi.waitFor(() => {
      expect(b.__cacheBusListenerClientForTests()).not.toBeNull();
      expect(seenB).toContain(null);
    }, { timeout: 10_000 });
    // Heartbeat comes back: active again, and cross-node delivery works.
    b.__cacheBusHeartbeatForTests({ send: true });
    await vi.waitFor(() => expect(b.isCrossNodeInvalidationActive()).toBe(true), { timeout: 5_000 });
    seenB.length = 0;
    a.publishCacheInvalidation(['widget:after-reconnect']);
    await vi.waitFor(() => expect(seenB).toEqual(['after-reconnect']), { timeout: 5_000 });
  }, 20_000);

  it('LISTEN up but heartbeats not coming back (a pooler / replica URL) = not active', async () => {
    a.__cacheBusHeartbeatForTests({ drop: true, expire: true });
    expect(a.isCrossNodeInvalidationActive()).toBe(false);
    a.__cacheBusHeartbeatForTests({ send: true });
    await new Promise((r) => setTimeout(r, 300));
    expect(a.isCrossNodeInvalidationActive()).toBe(false);
    a.__cacheBusHeartbeatForTests({ drop: false, send: true });
    await vi.waitFor(() => expect(a.isCrossNodeInvalidationActive()).toBe(true), { timeout: 5_000 });
  });
});
