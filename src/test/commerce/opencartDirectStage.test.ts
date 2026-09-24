/**
 * The direct (OpenCart) commerce stage with a scripted store: which turns
 * call the store, how often, what is cached for whom, and what the model is
 * handed. The gateway, permission/capability gates, audit batching and the
 * stage are the real code; only the store and Web Yar's database are
 * stand-ins (the database one counts every operation).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCountingSupabase } from './helpers/countingSupabase';
import type { ServerConfig } from '../../../server/config.js';
import type { DirectProductSummary, DirectSearchFilters, DirectReadOptions, CustomerRef } from '../../../shared/commerce/types.js';

const WS = 'ws-direct';
const CONN = 'conn-direct';
const CONV = 'conv-1';
const VISITOR = 'visitor-1';

const fake = createCountingSupabase();
const calls: Array<{ op: string; args: unknown[] }> = [];
let searchResult: (f: DirectSearchFilters, o: DirectReadOptions) => unknown = () => ({});

function product(id: string, name: string, extra: Partial<DirectProductSummary> = {}): DirectProductSummary {
  return {
    externalId: id, name, model: null, manufacturer: null, url: `https://shop.example/index.php?route=product/product&product_id=${id}`, imageUrl: null,
    price: { amount: '10.00', currency: 'USD', formatted: '$10.00', taxIncluded: true }, special: null, priceHidden: null,
    stock: { state: 'in_stock' }, rating: null, reviewCount: 0, hasOptions: false, ...extra,
  };
}

const guestCtx = { storeId: '0', language: 'en-gb', currency: 'USD', customerGroupId: '1', customer: false, pricesVisible: true, taxIncluded: true, taxRegion: 'store' };

const fakeConnector = {
  providerType: 'opencart',
  searchStrategy: 'direct',
  async searchDirect(_c: unknown, f: DirectSearchFilters, o: DirectReadOptions) { calls.push({ op: 'search', args: [f, o] }); return searchResult(f, o); },
  async getProductDetails(_c: unknown, ids: string[], o: DirectReadOptions) {
    calls.push({ op: 'details', args: [ids, o] });
    return { products: ids.map((id) => ({ ...product(id, `P${id}`), description: 'd', minimum: 1, options: [{ id: '1', name: 'Color', type: 'select', required: true, values: [{ id: '9', name: 'Black', priceDelta: '+$1.00' }] }], attributes: [], specialEnds: null, quantityDiscounts: [] })), notFound: [], context: guestCtx };
  },
  async listOrders(_c: unknown, customer: CustomerRef, page: number) {
    calls.push({ op: 'orders', args: [customer, page] });
    return { items: [{ externalId: '5002', createdAt: null, updatedAt: null, status: { name: 'Packed', category: 'other' }, total: { amount: '1', currency: 'USD', formatted: '$1' }, itemCount: 1 }], page, hasMore: false, context: null };
  },
  async getOrderDetail(_c: unknown, customer: CustomerRef, id: string) {
    calls.push({ op: 'order', args: [customer, id] });
    return { externalId: id, createdAt: null, updatedAt: null, status: { name: 'Packed', category: 'other' }, total: { amount: '1', currency: 'USD', formatted: '$1' }, itemCount: 1, currency: 'USD', items: [], itemsTruncated: false, totals: [], shippingMethod: 'Flat', paymentMethod: 'COD', paymentStatus: 'not_reported_by_store', history: [], viewUrl: null };
  },
  async getTrackingDirect(_c: unknown, _cu: CustomerRef, id: string) {
    calls.push({ op: 'tracking', args: [id] });
    return { externalOrderId: id, available: false, reason: 'no_tracking_source', shipments: [], status: { name: 'Packed', category: 'other' } };
  },
  async getReviewsDirect() { calls.push({ op: 'reviews', args: [] }); return { productExternalId: '1', productName: 'P', averageRating: null, reviewCount: 0, page: 1, hasMore: false, reviews: [] }; },
  async listCategories() { calls.push({ op: 'categories', args: [] }); return []; },
  async listReturns() { calls.push({ op: 'returns', args: [] }); return { items: [], page: 1, hasMore: false, context: null }; },
};

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fake.client }));
vi.mock('../../../server/services/commerce/credentials.js', () => ({ readInstallationSecret: async () => 'secret' }));
vi.mock('../../../server/middleware/featureGating.js', () => ({
  checkEntitlementFromDB: async () => ({ allowed: true, plan: 'test' }),
  checkModuleAccess: async () => ({ allowed: true, plan: 'test' }),
}));
vi.mock('../../../server/services/commerce/connectors/registry.js', () => ({ resolveConnector: () => fakeConnector }));

const { runCommerceToolStage } = await import('../../../server/services/ai-agent/commerce-tools/runner.js');
const { publicCache, connectionGuard } = await import('../../../server/services/commerce/liveGuard.js');
const { MAX_EVIDENCE_BYTES } = await import('../../../server/services/ai-agent/commerce-tools/directRunner.js');

const CONFIG = { supabaseUrl: 'x', supabaseServiceRoleKey: 'k', selfHostBillingUnlimited: true, complianceAuditLoggingEnabled: true } as unknown as ServerConfig;
const ALL_CAPS = ['store.read', 'products.read', 'availability.read', 'reviews.read', 'orders.read', 'tracking.read', 'returns.read', 'search.direct'];

function seed(permissions: Record<string, boolean> = { products: true, prices: true, stock: true, orders: true, tracking: true, reviews: true }) {
  fake.db.commerce_connections = [{
    id: CONN, workspace_id: WS, installation_id: 'inst', provider_type: 'opencart', store_id: 'https://shop.example/', approved_origin: 'https://shop.example',
    external_store_id: '0', platform_version: '4.1.0.4', capabilities: ALL_CAPS, permissions, health: 'connected', catalog_ready: false, revoked_at: null,
    protocol_version: 'webyar-commerce/1', created_at: '2026-01-01',
  }];
  fake.db.conversations = [{ id: CONV, workspace_id: WS, visitor_session_id: VISITOR, metadata: {} }];
  fake.db.commerce_customer_links = [];
  fake.db.commerce_tool_audit = [];
}

function link(customer = '101', group = '1', extra: Record<string, unknown> = {}) {
  fake.db.commerce_customer_links.push({ id: `l-${customer}`, workspace_id: WS, connection_id: CONN, visitor_id: VISITOR, external_customer_id: customer, session_ref: `ref-${customer}`, customer_group_id: group, verified_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3_600_000).toISOString(), private_cutoff_at: null, ...extra });
}

const ask = (question: string, conversationId: string | null = CONV) => runCommerceToolStage(CONFIG, { workspaceId: WS, conversationId, question, locale: 'en' });
const named = (r: { toolResults: Array<{ name: string; data: Record<string, unknown> }> }, name: string) => r.toolResults.filter((t) => t.name === name).map((t) => t.data);

beforeEach(() => {
  seed();
  calls.length = 0;
  fake.reset();
  publicCache.clear();
  connectionGuard.reset();
  searchResult = () => ({ products: [product('1', 'MacBook'), product('2', 'MacBook Air', { hasOptions: true }), product('3', 'MacBook Pro')], page: 1, pageSize: 5, hasMore: true, total: null, appliedFilters: {}, unsupportedFilters: [], context: guestCtx });
});

describe('which turns reach the store', () => {
  it('an unrelated message: no store call, no write, one read', async () => {
    const r = await ask('thanks, that is all for today');
    expect(calls).toEqual([]);
    expect(r.toolResults).toEqual([]);
    expect(fake.total()).toMatchObject({ select: 1, insert: 0, update: 0 });
  });

  it('a product question: exactly one search, one audit INSERT for the turn', async () => {
    const r = await ask('do you have a macbook?');
    expect(calls.map((c) => c.op)).toEqual(['search']);
    expect(named(r, 'commerce.search_products')[0]).toMatchObject({ name: 'MacBook', price: '$10.00' });
    expect(fake.counts.commerce_tool_audit).toMatchObject({ insert: 1 });
  });

  it('the same question again is answered from the cache', async () => {
    await ask('do you have a macbook?');
    calls.length = 0;
    const r = await ask('do you have a macbook?');
    expect(calls).toEqual([]);
    expect(r.directMeta?.cacheHits).toBe(1);
  });

  it('"right now" bypasses the cache', async () => {
    await ask('do you have a macbook?');
    calls.length = 0;
    await ask('do you have a macbook right now?');
    expect(calls.map((c) => c.op)).toEqual(['search']);
  });

  it('never makes more than three store calls in a turn', async () => {
    link();
    // order status + tracking of the latest: two calls, bounded by design
    await ask('where is my order? has it shipped?');
    expect(calls.length).toBeLessThanOrEqual(3);
  });
});

describe('private data', () => {
  it('without a signed-in customer: identity_required, and the store is not asked', async () => {
    const r = await ask('show my orders');
    expect(calls).toEqual([]);
    expect(named(r, 'commerce.orders')[0]).toMatchObject({ error_code: 'identity_required', remedy: 'sign_in_to_store' });
  });

  it('an order number alone is not proof', async () => {
    const r = await ask('status of order 5002');
    expect(calls).toEqual([]);
    expect(JSON.stringify(r.toolResults)).toContain('identity_required');
  });

  it('a signed-in customer: their reference goes to the store, which decides', async () => {
    link('101');
    await ask('show my orders');
    expect(calls[0]).toMatchObject({ op: 'orders' });
    expect((calls[0].args[0] as CustomerRef)).toEqual({ externalCustomerId: '101', sessionRef: 'ref-101' });
  });

  it('an expired link is no customer at all', async () => {
    link('101', '1', { expires_at: new Date(Date.now() - 1000).toISOString() });
    const r = await ask('show my orders');
    expect(calls).toEqual([]);
    expect(JSON.stringify(r.toolResults)).toContain('identity_required');
  });

  it('the owner switched orders off: nothing is read', async () => {
    seed({ products: true, prices: true, stock: true, orders: false, tracking: false });
    link();
    const r = await ask('show my orders');
    expect(calls).toEqual([]);
    expect(JSON.stringify(r.toolResults)).toContain('commerce_permission_denied');
  });

  it('missing tracking is said plainly', async () => {
    link();
    const r = await ask('has my last order shipped? tracking number?');
    expect(named(r, 'commerce.tracking')[0]).toMatchObject({ tracking_available: false, reason: 'no_tracking_source' });
  });

  it('reports the identity cutoff so earlier turns are not shown to the model', async () => {
    link('102', '1', { private_cutoff_at: '2026-09-01T00:00:00.000Z' });
    const r = await ask('show my orders');
    expect(r.historyCutoffAt).toBe('2026-09-01T00:00:00.000Z');
  });
});

describe('the cache never mixes prices between people', () => {
  it('a customer does not get the guest entry, and the guest does not get the customer one', async () => {
    await ask('do you have a macbook?', null); // guest, cached
    link('102', '2');
    calls.length = 0;
    searchResult = () => ({ products: [product('1', 'MacBook', { price: { amount: '7.00', currency: 'USD', formatted: '$7.00' } })], page: 1, pageSize: 5, hasMore: false, total: null, appliedFilters: {}, unsupportedFilters: [], context: { ...guestCtx, customer: true, customerGroupId: '2' } });
    const r = await ask('do you have a macbook?');
    expect(calls.map((c) => c.op)).toEqual(['search']);
    expect(named(r, 'commerce.search_products')[0].price).toBe('$7.00');
    calls.length = 0;
    const g = await ask('do you have a macbook?', null);
    expect(calls).toEqual([]);
    expect(named(g, 'commerce.search_products')[0].price).toBe('$10.00');
  });

  it('a stale reference answered as a guest is stored as a guest answer only', async () => {
    link('103', '2');
    searchResult = () => ({ products: [product('1', 'MacBook')], page: 1, pageSize: 5, hasMore: false, total: null, appliedFilters: {}, unsupportedFilters: [], context: guestCtx });
    await ask('do you have a macbook?');
    calls.length = 0;
    await ask('do you have a macbook?'); // same customer again: nothing under their key
    expect(calls.map((c) => c.op)).toEqual(['search']);
  });
});

describe('follow-ups and pagination', () => {
  it('«the second one» resolves to the second listed product, by id', async () => {
    await ask('do you have a macbook?');
    calls.length = 0;
    await ask('does the second one come in black?');
    expect(calls[0]).toMatchObject({ op: 'details' });
    expect(calls[0].args[0]).toEqual(['2']);
  });

  it('«more» asks the store for the next page of the same search', async () => {
    await ask('do you have a macbook?');
    calls.length = 0;
    await ask('show more');
    expect(calls[0].op).toBe('search');
    expect((calls[0].args[0] as DirectSearchFilters).page).toBe(2);
  });

  it('a follow-up with nothing listed before makes no call', async () => {
    const r = await ask('the second one?');
    expect(calls).toEqual([]);
    expect(r.toolResults).toEqual([]);
  });

  it('order refs from another customer are not reused', async () => {
    link('101');
    await ask('show my orders');
    fake.db.commerce_customer_links = [];
    link('102');
    calls.length = 0;
    await ask('what about the first one?');
    expect(calls.find((c) => c.op === 'order')).toBeUndefined();
  });
});

describe('what the model is handed', () => {
  it('stays under the evidence cap however much the store returns', async () => {
    searchResult = () => ({ products: Array.from({ length: 10 }, (_, i) => product(String(i), `Product ${'x'.repeat(190)} ${i}`)), page: 1, pageSize: 10, hasMore: true, total: null, appliedFilters: {}, unsupportedFilters: [], context: guestCtx });
    const r = await ask('do you have a product?');
    expect(Buffer.byteLength(JSON.stringify(r.toolResults))).toBeLessThanOrEqual(MAX_EVIDENCE_BYTES + 200);
  });

  it('prices and stock are left out when the owner switched them off', async () => {
    seed({ products: true, prices: false, stock: false, orders: false, tracking: false });
    const r = await ask('do you have a macbook?');
    const row = named(r, 'commerce.search_products')[0];
    expect(row).not.toHaveProperty('price');
    expect(row).not.toHaveProperty('stock');
  });

  it('says there are more results instead of pretending the list is complete', async () => {
    const r = await ask('do you have a macbook?');
    expect(named(r, 'commerce.search_meta')[0]).toMatchObject({ has_more: true, semantic_search: false });
  });
});
