// @vitest-environment node
/**
 * `config.commerce = { trackOrder: true }` (the t2 home's track-order row) in
 * GET /config (server/services/widget/configSnapshot.ts getStoreOrders):
 *
 *   - only for a template with Core features, and only when the workspace
 *     has a store the AI can answer "track my order" for (owner permissions,
 *     negotiated capability, usable health, synced catalogue, the OpenCart
 *     platform policy, the plan);
 *   - `default` / `intl`: no key and no commerce_connections read at all, so
 *     their payload is exactly as before;
 *   - cached 60 s per workspace, dropped by `widget:<ws>`, which the
 *     connection's disconnect, permission change and pairing publish;
 *   - any failure reads as no row.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request } from 'express';
import { createFakeDb, allowAllRpc, widgetScenarioTables, WS, type FakeDb } from './widgetConfigFakeDb';

const holder = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  policy: { enabled: true, sections: {} as Record<string, boolean> },
  published: [] as string[][],
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (t: string) => holder.db.client.from(t),
    rpc: (f: string, a?: Record<string, unknown>) => holder.db.client.rpc(f, a),
  }),
}));
vi.mock('../../../server/services/commerce/opencartPolicy.js', () => ({
  getOpenCartPolicy: async () => holder.policy,
  assertOpenCartPolicy: async () => {},
}));

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key-store-orders';
const config = { supabaseUrl: 'https://x.supabase.co', supabaseServiceRoleKey: 'SERVICE_KEY' } as never;

const snapshotMod = await import('../../../server/services/widget/configSnapshot.js');
const cacheBus = await import('../../../server/lib/cacheBus.js');
const { invalidateLocal } = cacheBus;

const req = { query: {}, headers: {}, protocol: 'https', get: () => 'api.test', socket: { remoteAddress: '127.0.0.1' } } as unknown as Request;
const CATALOG = { default: 'default', items: { t1: { enabled: true }, t2: { enabled: true } } };

type Tables = ReturnType<typeof widgetScenarioTables>;
type Row = Record<string, unknown>;

function woo(extra: Row = {}): Row {
  return {
    id: 'conn-woo', workspace_id: WS, installation_id: 'inst-woo', provider_type: 'woocommerce', store_id: 'https://shop.example',
    approved_origin: 'https://shop.example', capabilities: ['store.read', 'products.read', 'orders.read', 'tracking.read'],
    permissions: { orders: true, customer_history: true, order_status: true, tracking: true, products: true },
    health: 'connected', catalog_ready: true, revoked_at: null, protocol_version: 'webyar-commerce/1', created_at: '2026-01-01',
    ...extra,
  };
}
function opencart(extra: Row = {}): Row {
  return {
    ...woo(), id: 'conn-oc', installation_id: 'inst-oc', provider_type: 'opencart', catalog_ready: false,
    capabilities: ['store.read', 'products.read', 'orders.read', 'search.direct'], permissions: { orders: true, products: true },
    ...extra,
  };
}

async function fresh(template: string, connections: Row[], opts: { deny?: string[]; failing?: Set<string>; edition?: 'iran' | 'international' } = {}) {
  const tables = widgetScenarioTables({ edition: opts.edition ?? 'iran', ai: false, smart: false }) as Tables & Record<string, Row[]>;
  tables.widget_edition_settings = [{ edition: opts.edition ?? 'iran', chat_templates: CATALOG }];
  Object.assign(tables.widget_settings[0], { widget_template_id: template, widget_template_options: {} });
  tables.commerce_connections = connections;
  const denied = new Set(opts.deny ?? []);
  holder.db = createFakeDb(tables, {
    failingTables: opts.failing,
    rpc: (fn, args) => (fn === 'check_workspace_entitlement' && denied.has(String(args?._feature))
      ? { data: { allowed: false, plan: 'pro', reason: 'feature_disabled' }, error: null }
      : allowAllRpc(fn, args)),
  });
  snapshotMod.__resetWidgetConfigCachesForTests();
  (await import('../../../server/middleware/featureGating.js')).clearEntitlementCache();
  (await import('../../../server/services/platformRegion.js')).invalidatePlatformRegionCache();
  (await import('../../../server/services/ai-agent/platformSettings.js')).__resetPlatformAiAgentSettingsCache();
  return tables;
}

async function body(edition: 'iran' | 'international' = 'iran') {
  const out = await snapshotMod.resolveWidgetConfigBody(config, req, WS, { edition, quotaFull: null });
  expect(out.status).toBe(200);
  return out.body as Record<string, unknown>;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-18T10:00:00Z') });
  delete process.env.WIDGET_CONFIG_CACHE_TTL_MS;
  holder.policy = { enabled: true, sections: {} };
});
afterEach(() => { vi.useRealTimers(); });

describe('config.commerce for a Core-features template', () => {
  it('t2 with a WooCommerce store that may read orders and order history: trackOrder', async () => {
    await fresh('t2', [woo()]);
    const b = await body();
    expect(b.templateId).toBe('t2');
    expect(b.commerce).toEqual({ trackOrder: true });
    // Right after templateOptions, nowhere else.
    const keys = Object.keys(b);
    expect(keys[keys.indexOf('templateOptions') + 1]).toBe('commerce');
  });

  it('t1 carries it too (its renderer ignores it)', async () => {
    await fresh('t1', [woo()]);
    expect((await body()).commerce).toEqual({ trackOrder: true });
  });

  it.each([
    ['revoked', [woo({ revoked_at: '2026-10-01T00:00:00Z' })]],
    ['disconnected', [woo({ health: 'disconnected' })]],
    ['a protocol mismatch', [woo({ health: 'protocol_mismatch' })]],
    ['an outdated plugin', [woo({ health: 'plugin_outdated' })]],
    ['an authentication error', [woo({ health: 'authentication_error' })]],
    ['orders off', [woo({ permissions: { orders: false, customer_history: true } })]],
    ['order history off', [woo({ permissions: { orders: true, customer_history: false, order_status: true } })]],
    ['orders.read not negotiated', [woo({ capabilities: ['store.read', 'products.read'] })]],
    ['the catalogue still syncing', [woo({ catalog_ready: false })]],
    ['WHMCS only', [woo({ provider_type: 'whmcs', id: 'conn-whmcs' })]],
    ['no connection', []],
  ])('no key with %s', async (_label, rows) => {
    await fresh('t2', rows as Row[]);
    expect(await body()).not.toHaveProperty('commerce');
  });

  it('no key when the plan has no commerce module or no order history', async () => {
    await fresh('t2', [woo()], { deny: ['commerce'] });
    expect(await body()).not.toHaveProperty('commerce');
    await fresh('t2', [woo()], { deny: ['commerce_customer_history'] });
    expect(await body()).not.toHaveProperty('commerce');
  });

  it('OpenCart: orders allowed, the platform policy on, commerce_orders on the plan', async () => {
    await fresh('t2', [opencart()]);
    expect((await body()).commerce).toEqual({ trackOrder: true });
    holder.policy = { enabled: false, sections: {} };
    await fresh('t2', [opencart()]);
    expect(await body()).not.toHaveProperty('commerce');
    holder.policy = { enabled: true, sections: { orders: false } };
    await fresh('t2', [opencart()]);
    expect(await body()).not.toHaveProperty('commerce');
    holder.policy = { enabled: true, sections: {} };
    await fresh('t2', [opencart()], { deny: ['commerce_orders'] });
    expect(await body()).not.toHaveProperty('commerce');
    await fresh('t2', [opencart({ health: 'stale_origin' })]);
    expect(await body()).not.toHaveProperty('commerce');
  });

  it('one qualifying store among several is enough', async () => {
    await fresh('t2', [woo({ id: 'w1', health: 'disconnected' }), woo({ provider_type: 'whmcs', id: 'wh' }), opencart()]);
    expect((await body()).commerce).toEqual({ trackOrder: true });
  });

  it('a failed connection read: no key (and a short lifetime)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await fresh('t2', [woo()], { failing: new Set(['commerce_connections']) });
    const b = await body();
    expect(b.templateId).toBe('t2');
    expect(b).not.toHaveProperty('commerce');
    // Recovered: past the degraded 5 s the next view reads again.
    holder.db.options.failingTables = new Set();
    vi.setSystemTime(new Date('2026-10-18T10:00:06Z'));
    expect((await snapshotMod.getStoreOrders(config, WS))).toBe(true);
    warn.mockRestore();
  });
});

describe('default and intl', () => {
  it('no commerce key and no commerce_connections read, whatever the store', async () => {
    await fresh('default', [woo()]);
    const b = await body();
    expect(b.templateId).toBe('default');
    expect(b).not.toHaveProperty('commerce');
    expect(holder.db.calls.log).not.toContain('from:commerce_connections');
    await fresh('t2', [woo()], { edition: 'international' });
    const intl = await body('international');
    expect(intl.templateId).toBe('intl');
    expect(intl).not.toHaveProperty('commerce');
    expect(holder.db.calls.log).not.toContain('from:commerce_connections');
  });

  it('default\'s payload is the same with or without a store', async () => {
    await fresh('default', []);
    const without = JSON.stringify(await body());
    await fresh('default', [woo()]);
    expect(JSON.stringify(await body())).toBe(without);
  });
});

describe('cache and invalidation', () => {
  it('a second view reads nothing; `widget:<ws>` makes the next view read again', async () => {
    const tables = await fresh('t2', [woo()]);
    expect((await body()).commerce).toEqual({ trackOrder: true });
    holder.db.resetCalls();
    expect((await body()).commerce).toEqual({ trackOrder: true });
    expect(holder.db.calls.log).not.toContain('from:commerce_connections');
    // The owner switches order history off.
    (tables.commerce_connections[0].permissions as Row).customer_history = false;
    expect((await body()).commerce).toEqual({ trackOrder: true });
    invalidateLocal([`widget:${WS}`]);
    expect(await body()).not.toHaveProperty('commerce');
    expect(holder.db.calls.log).toContain('from:commerce_connections');
  });

  it('past 60 s the answer is refreshed', async () => {
    const tables = await fresh('t2', [woo()]);
    expect(await snapshotMod.getStoreOrders(config, WS)).toBe(true);
    tables.commerce_connections[0].revoked_at = '2026-10-18T10:00:30Z';
    vi.setSystemTime(new Date('2026-10-18T10:01:01Z'));
    // Stale-while-revalidate: this view may still see the old answer; the next one does not.
    await snapshotMod.getStoreOrders(config, WS);
    await vi.waitFor(async () => expect(await snapshotMod.getStoreOrders(config, WS)).toBe(false));
  });

  it('a made-up workspace id is answered false with no read', async () => {
    await fresh('t2', [woo()]);
    holder.db.resetCalls();
    expect(await snapshotMod.getStoreOrders(config, 'not-a-uuid')).toBe(false);
    expect(holder.db.calls.from).toBe(0);
  });
});

describe('trackOrderEntitlementFor (the row rules)', () => {
  const { trackOrderEntitlementFor } = snapshotMod;
  const on = { enabled: true, sections: {} };
  it('names the plan feature the turn needs', () => {
    expect(trackOrderEntitlementFor(woo() as never, null)).toBe('commerce_customer_history');
    expect(trackOrderEntitlementFor(opencart() as never, on)).toBe('commerce_orders');
  });
  it('null for anything that cannot answer', () => {
    expect(trackOrderEntitlementFor(null, on)).toBeNull();
    expect(trackOrderEntitlementFor(opencart() as never, null)).toBeNull();
    expect(trackOrderEntitlementFor(woo({ provider_type: 'shopify' }) as never, on)).toBeNull();
    expect(trackOrderEntitlementFor(woo({ capabilities: null }) as never, on)).toBeNull();
    expect(trackOrderEntitlementFor(woo({ permissions: null }) as never, on)).toBeNull();
    expect(trackOrderEntitlementFor(woo({ permissions: { orders: 'true', customer_history: true } }) as never, on)).toBeNull();
  });
});
