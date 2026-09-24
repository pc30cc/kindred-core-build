/**
 * COMPLIANCE_AUDIT_LOGGING — what an AI agent did against a merchant's store.
 *
 * `withCommerceConnector` has always audited the calls that REACH the store,
 * and on the live database those rows are there: `commerce.get_product`,
 * `commerce.get_availability`. What left no trace at all were the tools Web
 * Yar answers from its own index — a catalogue search, a browse, a category
 * listing — because they never go through that gate. They are still an agent
 * reading a merchant's catalogue.
 *
 * The refusals matter as much as the reads: a row saying an order was asked
 * for and nothing was disclosed is the part of the trail an audit is for.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const WS = 'ws-1';
const CONN = 'conn-1';

const audited: any[] = [];
let connection: any;
let indexRows: any[] = [];
let categories: any[] = [];

vi.mock('../../../server/services/commerce/audit.js', () => ({
  recordCommerceToolAudit: async (_c: any, row: any) => { audited.push(row); },
}));
// Nothing here reads real rows — the builder just has to be chainable in
// whatever shape a caller uses, and to answer "found nothing".
vi.mock('../../../server/supabase.js', () => {
  const builder: any = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'maybeSingle' || prop === 'single') return async () => ({ data: null, error: null });
      if (prop === 'then') return (resolve: any) => resolve({ data: [], error: null, count: 0 });
      return () => builder;
    },
  });
  return { getServiceClient: () => ({ from: () => builder, rpc: async () => ({ data: null, error: null }) }) };
});
vi.mock('../../../server/services/commerce/productIndex.js', () => ({
  searchIndexedProducts: async () => ({ rows: indexRows, totalMatched: indexRows.length }),
  listIndexedCategories: async () => categories,
}));
vi.mock('../../../server/services/commerce/gateway.js', () => ({
  getActiveConnectionForWorkspace: async () => connection,
  resolveConversationConnection: async () => connection,
  assertCommerceModuleEntitled: async () => {},
  assertPermission: () => {},
  withCommerceConnector: async () => null,
}));

const { runCommerceToolStage } = await import('../../../server/services/ai-agent/commerce-tools/runner.js');

const CONFIG: any = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' };
const ask = (question: string) =>
  runCommerceToolStage(CONFIG, { workspaceId: WS, conversationId: 'conv-1', question });

const product = (id: string, title: string) => ({
  id, external_id: id, product_type: 'simple', sku: `SKU-${id}`, title, short_description: '',
  canonical_url: `https://shop.test/product/${id}/`, image_url: null, currency: 'IRT',
  regular_price_minor: 1000, sale_price_minor: null, effective_price_minor: 1000,
  stock_state: 'in_stock', stock_quantity: 3, categories: [], tags: [], attributes: [],
  is_virtual: false, is_downloadable: false, updated_at: '2026-09-21T00:00:00Z',
});

beforeEach(() => {
  audited.length = 0;
  indexRows = [product('11', 'گوشی هوشمند نوا ۱۲')];
  categories = [{ name: 'موبایل و تبلت', slug: 'mobile', productCount: 1 }];
  connection = {
    id: CONN, workspace_id: WS, installation_id: 'inst-1', provider_type: 'woocommerce',
    store_id: 'https://shop.test', approved_origin: 'https://shop.test',
    capabilities: ['store.read', 'products.read', 'availability.read', 'orders.read'],
    permissions: { products: true, stock: false, orders: true },
    health: 'connected', catalog_ready: true, revoked_at: null,
  };
});

const rowFor = (tool: string) => audited.find((r) => r.tool_name === tool || r.toolName === tool);

describe('the tools Web Yar answers from its own index', () => {
  it('records a catalogue search', async () => {
    await ask('قیمت گوشی هوشمند نوا چنده؟');

    const row = rowFor('commerce.search_products');
    expect(row).toBeTruthy();
    expect(row).toMatchObject({ workspaceId: WS, connectionId: CONN, conversationId: 'conv-1', success: true, resultCount: 1 });
    // The index answered, not the store — that is what cacheHit means here.
    expect(row.cacheHit).toBe(true);
    expect(row.liveRevalidated).toBe(false);
  });

  it('records a browse, with how much of the catalogue came back', async () => {
    indexRows = [product('11', 'الف'), product('13', 'ب')];
    await ask('چی دارید؟');

    expect(rowFor('commerce.browse_products')).toMatchObject({ success: true, resultCount: 2 });
  });

  it('records a category listing', async () => {
    await ask('دسته بندی هارو بیار');
    expect(rowFor('commerce.list_categories')).toMatchObject({ success: true, resultCount: 1 });
  });

  it('and says so when a catalogue has no categories to list', async () => {
    categories = [];
    await ask('دسته بندی هارو بیار');

    expect(rowFor('commerce.list_categories')).toMatchObject({ success: false, safeErrorCode: 'no_categories' });
  });
});

describe('a refusal is part of the record too', () => {
  it('an order asked for without a verified identity', async () => {
    await ask('وضعیت سفارش ۱۲۳۴۵ چی شد؟');

    expect(rowFor('commerce.order_lookup')).toMatchObject({ success: false, safeErrorCode: 'identity_required' });
  });

  it('a question asked while the catalogue is still syncing', async () => {
    connection = { ...connection, catalog_ready: false };
    await ask('یه هدفون خوب معرفی کن');

    expect(rowFor('commerce.catalog_status')).toMatchObject({ success: false, safeErrorCode: 'catalog_syncing' });
  });

  it('and a product the catalogue does not have', async () => {
    indexRows = [];
    await ask('پاوربانک دارید؟');

    expect(rowFor('commerce.get_availability')).toMatchObject({ success: false, safeErrorCode: 'product_not_found', resultCount: 0 });
  });
});

describe('one turn reads as one turn', () => {
  it('every tool of a question shares a correlation id', async () => {
    indexRows = [product('11', 'گوشی هوشمند نوا ۱۲')];
    await ask('چی دارید؟');

    const ids = new Set(audited.map((r) => r.correlationId));
    expect(audited.length).toBeGreaterThan(0);
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBeTruthy();
  });

  it('and a question that is not about the shop records nothing', async () => {
    await ask('سلام خوبی؟');
    expect(audited).toEqual([]);
  });
});
