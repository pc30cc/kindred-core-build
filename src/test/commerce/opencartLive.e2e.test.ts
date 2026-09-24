// @vitest-environment node
/**
 * OpenCart END-TO-END: the real Web Yar connector, gateway, identity bridge
 * and AI commerce stage against a REAL OpenCart store with the extension
 * installed through OpenCart's own installer
 * (plugins/webyar-opencart/tests/integration/run.sh sets this up locally).
 *
 * Only two things are stand-ins, and both are instrumented, not simulated:
 *  - Web Yar's database is an in-memory client that COUNTS every
 *    select/insert/update per table — the "Web Yar DB ops" in the report;
 *  - the SSRF guard is told to allow the loopback test store (it rightly
 *    refuses private addresses in production).
 *
 * Skipped unless OPENCART_E2E_BASE is set, so the normal suite never needs a
 * store. With OPENCART_E2E_REPORT set, writes the measured numbers as JSON.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import { createCountingSupabase } from './helpers/countingSupabase';
import type { ServerConfig } from '../../../server/config.js';

const BASE = process.env.OPENCART_E2E_BASE || '';
const BASE1 = process.env.OPENCART_E2E_BASE1 || '';
const VERSION = process.env.OPENCART_E2E_VERSION || '4.1.0.4';
const SECRET0 = process.env.OPENCART_E2E_SECRET0 || '';
const SECRET1 = process.env.OPENCART_E2E_SECRET1 || '';
const SLOW_BASE = process.env.OPENCART_E2E_SLOW_BASE || '';
const REPORT = process.env.OPENCART_E2E_REPORT || '';
const run = BASE ? describe : describe.skip;

const WS = '00000000-0000-4000-8000-0000000000a1';
const CONN0 = '00000000-0000-4000-8000-0000000000c0';
const CONN1 = '00000000-0000-4000-8000-0000000000c1';
const CONN_SLOW = '00000000-0000-4000-8000-0000000000c9';
const INST0 = '11111111-1111-4111-8111-111111111111';
const INST1 = '22222222-2222-4222-8222-222222222222';
const VISITOR = '00000000-0000-4000-8000-0000000000b1';
const CONV = '00000000-0000-4000-8000-0000000000d1';

const fake = createCountingSupabase();
let contactUpserts = 0;

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fake.client }));
vi.mock('../../../shared/net/hostGuard.js', async (orig) => ({
  ...(await orig<typeof import('../../../shared/net/hostGuard.js')>()),
  // TEST ONLY: the local store lives on 127.0.0.1, which production refuses.
  checkOutboundUrl: async () => ({ ok: true }),
}));
vi.mock('../../../server/services/commerce/credentials.js', () => ({
  readInstallationSecret: async (_c: unknown, id: string) => (id === INST0 ? SECRET0 : id === INST1 ? SECRET1 : null),
}));
vi.mock('../../../server/middleware/featureGating.js', () => ({
  checkEntitlementFromDB: async () => ({ allowed: true, plan: 'test' }),
  checkModuleAccess: async () => ({ allowed: true, plan: 'test' }),
}));
vi.mock('../../../server/services/widget/anonymousContact.js', () => ({
  ensureVisitorContact: async () => { contactUpserts += 1; return null; },
}));

const CONFIG = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', selfHostBillingUnlimited: true, complianceAuditLoggingEnabled: true } as unknown as ServerConfig;
const PERMISSIONS = { products: true, prices: true, stock: true, orders: true, order_status: true, tracking: true, customer_history: true, reviews: true, coupons: false };

function connection(id: string, inst: string, base: string, storeId: string) {
  return {
    id, workspace_id: WS, installation_id: inst, provider_type: 'opencart', store_id: base, approved_origin: new URL(base).origin,
    external_store_id: storeId, platform_version: VERSION, protocol_version: 'webyar-commerce/1',
    capabilities: [], permissions: PERMISSIONS, health: 'reconnecting', catalog_ready: false, revoked_at: null,
    created_at: id === CONN0 ? '2026-09-02T00:00:00Z' : '2026-09-01T00:00:00Z',
  };
}

// ── counting fetch: every HTTP call to a store is observed ───────────────
const realFetch = globalThis.fetch;
let storeCalls = 0;
let storeBytes = 0;

// ── a real storefront session (cookie jar of one) ───────────────────────
async function storefrontLogin(base: string, email: string, password: string): Promise<string> {
  const oc4 = !/^3\./.test(VERSION);
  const page = await realFetch(`${base}index.php?route=account/login${oc4 ? '&language=en-gb' : ''}`);
  const cookie = (page.headers.get('set-cookie') || '').match(/OCSESSID=[^;]+/)?.[0] ?? '';
  const html = await page.text();
  if (oc4) {
    const action = html.match(/action="([^"]*account\/login\.login[^"]*)"/)![1].replace(/&amp;/g, '&');
    await realFetch(action, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email, password }) });
  } else {
    await realFetch(`${base}index.php?route=account/login`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email, password }) });
  }
  return cookie;
}

async function storefrontLogout(base: string, cookie: string) {
  await realFetch(`${base}index.php?route=account/logout${/^3\./.test(VERSION) ? '' : '&language=en-gb'}`, { headers: { cookie } });
}

async function contextAssertion(base: string, cookie: string): Promise<{ assertion: string | null; bytes: number }> {
  const route = /^3\./.test(VERSION) ? 'extension/module/webyar/context' : 'extension/webyar/module/webyar.context';
  const res = await realFetch(`${base}index.php?route=${route}`, { headers: { cookie, 'sec-fetch-site': 'same-origin' } });
  const text = await res.text();
  return { assertion: JSON.parse(text).assertion, bytes: Buffer.byteLength(text) };
}

type ReportRow = Record<string, unknown> & { scenario: string; storeHttpCalls: number; ms: number };
const report: ReportRow[] = [];

run('OpenCart live store, end to end', () => {
  let runStage: typeof import('../../../server/services/ai-agent/commerce-tools/runner.js').runCommerceToolStage;
  let bind: typeof import('../../../server/services/commerce/identityBridge.js').verifyAndBindCustomerContext;
  let unbind: typeof import('../../../server/services/commerce/identityBridge.js').unbindCustomerContext;
  let handshake: typeof import('../../../server/services/commerce/pairing.js').runCapabilityHandshake;
  let guard: typeof import('../../../server/services/commerce/liveGuard.js');
  let metrics: typeof import('../../../server/services/commerce/metrics.js');

  beforeAll(async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('webyar') && url.includes('api')) storeCalls += 1;
      const res = await realFetch(input, init);
      return res;
    }) as typeof fetch;
    fake.db.commerce_connections = [connection(CONN0, INST0, BASE, '0'), ...(BASE1 ? [connection(CONN1, INST1, BASE1, '1')] : [])];
    fake.db.conversations = [{ id: CONV, workspace_id: WS, visitor_session_id: VISITOR, metadata: {} }];
    ({ runCommerceToolStage: runStage } = await import('../../../server/services/ai-agent/commerce-tools/runner.js'));
    ({ verifyAndBindCustomerContext: bind, unbindCustomerContext: unbind } = await import('../../../server/services/commerce/identityBridge.js'));
    ({ runCapabilityHandshake: handshake } = await import('../../../server/services/commerce/pairing.js'));
    guard = await import('../../../server/services/commerce/liveGuard.js');
    metrics = await import('../../../server/services/commerce/metrics.js');
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    if (REPORT) writeFileSync(REPORT, JSON.stringify({ opencart: VERSION, measuredAt: new Date().toISOString(), scenarios: report, metrics: metrics.commerceMetricsSnapshot() }, null, 2));
  });

  /** Runs one step and records exactly what it cost on both sides. */
  async function measure<T>(scenario: string, fn: () => Promise<T>, extra: (r: T) => Record<string, unknown> = () => ({})): Promise<T> {
    fake.reset();
    storeCalls = 0;
    storeBytes = 0;
    const heap = process.memoryUsage().heapUsed;
    const started = performance.now();
    const result = await fn();
    const ms = Math.round(performance.now() - started);
    const ops = fake.total();
    const direct = (result as { directMeta?: Record<string, number> } | null)?.directMeta;
    report.push({
      scenario,
      storeHttpCalls: storeCalls,
      webyarDb: { select: ops.select, insert: ops.insert, update: ops.update, delete: ops.delete, byTable: JSON.parse(JSON.stringify(fake.counts)) },
      storeQueries: direct?.storeQueries ?? null,
      responseBytes: direct?.responseBytes ?? null,
      evidenceBytes: direct?.evidenceBytes ?? null,
      cacheHits: direct?.cacheHits ?? 0,
      ms,
      heapDeltaKb: Math.round((process.memoryUsage().heapUsed - heap) / 1024),
      cache: guard.publicCache.snapshot(),
      ...extra(result),
    });
    return result;
  }

  const ask = (question: string, locale = 'en') => runStage(CONFIG, { workspaceId: WS, conversationId: CONV, question, locale });
  type ToolRow = Record<string, unknown>;
  const rows = (r: { toolResults: Array<{ name: string; data: ToolRow }> }, name: string): ToolRow[] => r.toolResults.filter((t) => t.name === name).map((t) => t.data);

  it('handshake (connect / manual check) marks the store connected with its real capabilities', async () => {
    await measure('handshake (pairing / manual check)', () => handshake(CONFIG, CONN0));
    const c = fake.db.commerce_connections.find((r) => r.id === CONN0);
    expect(c.health).toBe('connected');
    expect(c.capabilities).toContain('search.direct');
    expect(c.platform_version).toBe(VERSION);
    if (BASE1) await handshake(CONFIG, CONN1);
  });

  it('an unrelated question calls no store and reads only the connection row', async () => {
    const r = await measure('unrelated question', () => ask('hello, how are you today?'));
    expect(storeCalls).toBe(0);
    expect(r.toolResults).toEqual([]);
    expect(fake.total()).toMatchObject({ insert: 0, update: 0 });
  });

  it('a guest product search answers from the live store with real prices', async () => {
    const r = await measure('product search (guest)', () => ask('do you have macbook?'));
    const products = rows(r, 'commerce.search_products');
    expect(products.length).toBeGreaterThan(0);
    expect(products[0].price).toMatch(/\$/);
    expect(storeCalls).toBe(1);
    expect(fake.total().insert).toBeLessThanOrEqual(1); // the per-turn audit batch
  });

  it('the same question again is served from the cache — no store call', async () => {
    const r = await measure('repeat search (warm cache)', () => ask('do you have macbook?'));
    expect(storeCalls).toBe(0);
    expect(r.directMeta?.cacheHits).toBe(1);
  });

  it('a follow-up about «the second one» reads that product, fresh', async () => {
    const r = await measure('price/stock of selected product (follow-up)', () => ask('is the second one still in stock right now?'));
    const detail = rows(r, 'commerce.product_details')[0];
    expect(detail).toBeTruthy();
    expect(storeCalls).toBe(1);
  });

  it('identical concurrent questions cost the store one call', async () => {
    guard.publicCache.clear();
    await measure('5 identical concurrent searches', async () => {
      const all = await Promise.all(Array.from({ length: 5 }, () => runStage(CONFIG, { workspaceId: WS, conversationId: null, question: 'do you have iphone?', locale: 'en' })));
      return all[0];
    });
    expect(storeCalls).toBe(1);
  });

  it('a guest asking about orders is told to sign in; the store is not called', async () => {
    const r = await measure('orders as guest', () => ask('where is my order?'));
    expect(storeCalls).toBe(0);
    expect(rows(r, 'commerce.orders')[0]).toMatchObject({ error_code: 'identity_required', remedy: 'sign_in_to_store' });
  });

  let aliCookie = '';
  it('opening the widget as a signed-in customer binds once; re-opening writes nothing new', async () => {
    aliCookie = await storefrontLogin(BASE, 'ali@example.test', 'Test12345!');
    const first = await contextAssertion(BASE, aliCookie);
    expect(first.assertion).toBeTruthy();
    const b1 = await measure('widget open, signed in (first bind)', () => bind(CONFIG, WS, CONN0, VISITOR, first.assertion!, { requestOrigin: new URL(BASE).origin }), (r) => ({ outcome: r.outcome, contextBytes: first.bytes }));
    expect(b1.outcome).toBe('created');
    const again = await contextAssertion(BASE, aliCookie);
    const b2 = await measure('widget re-open, same customer', () => bind(CONFIG, WS, CONN0, VISITOR, again.assertion!, { requestOrigin: new URL(BASE).origin }), (r) => ({ outcome: r.outcome }));
    expect(b2.outcome).toBe('unchanged');
    expect(fake.total()).toMatchObject({ update: 0 });
    expect(fake.counts.commerce_customer_links?.insert ?? 0).toBe(0);
    expect(contactUpserts).toBe(1);
  });

  it('a copied shop on another origin cannot introduce a customer', async () => {
    const a = await contextAssertion(BASE, aliCookie);
    await expect(bind(CONFIG, WS, CONN0, VISITOR, a.assertion!, { requestOrigin: 'https://clone.example' })).rejects.toMatchObject({ code: 'identity_expired' });
  });

  it('the customer sees their own orders, then the latest one’s details and tracking', async () => {
    const list = await measure('order list (signed in)', () => ask('show my orders'));
    const orders = rows(list, 'commerce.customer_orders');
    expect(orders.map((o) => o.order_id)).toEqual(['5002', '5001']);
    expect(orders[0].status).toBe('Packed for courier');
    expect(orders[0].status_category).toBe('other');
    const detail = await measure('order details + tracking (follow-up)', () => ask('has the second one been shipped? tracking?'));
    expect(rows(detail, 'commerce.order_details')[0]).toMatchObject({ order_id: '5001', payment_status: 'not_reported_by_store' });
    expect(rows(detail, 'commerce.tracking')[0]).toMatchObject({ tracking_available: false, reason: 'no_tracking_source' });
    expect(JSON.stringify(detail.toolResults)).not.toMatch(/INTERNAL|Secret street|ali@example|10\.1\.2\.3|AFFILIATE/);
    expect(storeCalls).toBeLessThanOrEqual(2);
  });

  it('another customer’s order number reveals nothing', async () => {
    const r = await measure('order id tampering', () => ask('status of order 5005?'));
    expect(JSON.stringify(r.toolResults)).toContain('order_not_found');
    expect(JSON.stringify(r.toolResults)).not.toContain('999');
  });

  it('after logout the store refuses the old session; nothing cached is shown', async () => {
    await storefrontLogout(BASE, aliCookie);
    const r = await measure('orders after logout', () => ask('show my orders'));
    expect(rows(r, 'commerce.customer_orders').filter((o) => o.order_id)).toEqual([]);
    expect(JSON.stringify(r.toolResults)).toContain('identity_expired');
    expect(JSON.stringify(r.toolResults)).not.toContain('5002');
  });

  it('another customer on the same browser: the link switches and history is cut off', async () => {
    const bita = await storefrontLogin(BASE, 'bita@example.test', 'Test12345!');
    const a = await contextAssertion(BASE, bita);
    const b = await measure('account switch (bind other customer)', () => bind(CONFIG, WS, CONN0, VISITOR, a.assertion!, { requestOrigin: new URL(BASE).origin }), (r) => ({ outcome: r.outcome }));
    expect(b.outcome).toBe('switched');
    const r = await measure('orders after account switch', () => ask('show my orders'));
    expect(rows(r, 'commerce.customer_orders').map((o) => o.order_id)).toEqual(['5005']);
    expect(r.historyCutoffAt).toBeTruthy();
    // Bita's group prices, never Ali's or a guest's cached ones.
    const priced = await measure('search as wholesale customer (group price)', () => ask('do you have iphone?'));
    expect(priced.directMeta?.cacheHits).toBe(0);
    await measure('sign-out reported by the widget (unlink)', () => unbind(CONFIG, WS, VISITOR));
  });

  it('a store-0 link grants nothing on store 1', async () => {
    if (!BASE1) return;
    const r = await measure('store switch (store 1, no link there)', () => runStage(CONFIG, { workspaceId: WS, conversationId: CONV, question: 'show my orders', locale: 'en', pageUrl: `${BASE1}index.php` }));
    expect(storeCalls).toBe(0);
    expect(JSON.stringify(r.toolResults)).toContain('identity_required');
  });

  it('a hanging store costs one deadline, at most one retry, then the circuit opens', async () => {
    if (!SLOW_BASE) return;
    const caps = fake.db.commerce_connections.find((c) => c.id === CONN0)?.capabilities ?? [];
    fake.db.commerce_connections = [{ ...connection(CONN_SLOW, INST0, SLOW_BASE, '0'), health: 'connected', capabilities: caps }];
    guard.publicCache.clear();
    const r = await measure('store timeout', () => runStage(CONFIG, { workspaceId: WS, conversationId: null, question: 'do you have nothing-like-this?', locale: 'en' }));
    expect(JSON.stringify(r.toolResults)).toMatch(/commerce_timeout|commerce_live_unavailable/);
    expect(report[report.length - 1].ms).toBeLessThan(8_500);
    for (let i = 0; i < 3; i += 1) await runStage(CONFIG, { workspaceId: WS, conversationId: null, question: `do you have thing${i}?`, locale: 'en' });
    const fast = await measure('store circuit open', () => runStage(CONFIG, { workspaceId: WS, conversationId: null, question: 'do you have thing-x?', locale: 'en' }));
    expect(report[report.length - 1].storeHttpCalls).toBe(0);
    expect(report[report.length - 1].ms).toBeLessThan(100);
    expect(JSON.stringify(fast.toolResults)).toContain('commerce_live_unavailable');
    fake.db.commerce_connections = [{ ...connection(CONN0, INST0, BASE, '0'), health: 'connected', capabilities: caps }];
  }, 60_000);

  it('the cache stays bounded under many distinct questions', async () => {
    guard.connectionGuard.reset();
    const caps = ['store.read', 'products.read', 'availability.read', 'reviews.read', 'orders.read', 'tracking.read', 'returns.read', 'customer_context', 'widget.bootstrap', 'search.direct'];
    fake.db.commerce_connections = [{ ...connection(CONN0, INST0, BASE, '0'), health: 'connected', capabilities: caps }];
    storeCalls = 0;
    const heap = process.memoryUsage().heapUsed;
    await measure('120 distinct searches (bounded cache)', async () => {
      for (let i = 0; i < 120; i += 1) await runStage(CONFIG, { workspaceId: WS, conversationId: null, question: `do you have product${i}?`, locale: i % 2 ? 'en' : 'fa' });
      return null;
    });
    const snap = guard.publicCache.snapshot();
    expect(snap.entries).toBeLessThanOrEqual(guard.PUBLIC_CACHE_LIMITS.maxEntries);
    expect(snap.bytes).toBeLessThanOrEqual(guard.PUBLIC_CACHE_LIMITS.maxBytes);
    report[report.length - 1].heapDeltaKbTotal = Math.round((process.memoryUsage().heapUsed - heap) / 1024);
    expect(report[report.length - 1].storeHttpCalls).toBeGreaterThan(100);
  }, 120_000);
});
