/**
 * End-to-end shape of what the language model is handed for a store question.
 *
 * The product rows here are the live WooCommerce store's catalogue export run
 * through the real normalizer — the same bytes the sync worker writes into
 * commerce_products. The stage itself (intent detection, the catalog_ready
 * guard, the index search, the tool-result rendering) is the real code.
 *
 * Only the live-gateway leg is stubbed: it needs the store's installation
 * secret and an outbound call to the shop, neither of which belongs in a unit
 * test.
 *
 * The assertion that matters is the last one: a price reaches the model. Three
 * separate defects each independently prevented that — prices normalized to
 * null, the readiness flag short-circuiting the turn, and a tsquery that ANDed
 * the shopper's whole sentence — so a test that only checks "some tool ran"
 * would have passed throughout.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const WS = 'ws-1';
const CONN = 'conn-1';

/** Verbatim from the live store, via normalizeWooCommerceProduct. */
const MOBILE = [{ id: '16', name: 'موبایل و تبلت', slug: 'mobile' }];
const AUDIO = [{ id: '17', name: 'صوتی و تصویری', slug: 'audio' }];
const ACCESSORIES = [{ id: '18', name: 'لوازم جانبی', slug: 'accessories' }];
const HOME = [{ id: '19', name: 'لوازم خانگی هوشمند', slug: 'home' }];
const UNCATEGORIZED = [{ id: '15', name: 'Uncategorized', slug: 'uncategorized' }];

const INDEX_ROWS = [
  row('11', 'simple', 'WY-NOVA12-128', 'گوشی هوشمند نوا ۱۲', 'نمایشگر ۶.۷ اینچی AMOLED، تراشه‌ی هشت‌هسته‌ای و باتری ۵۰۰۰ میلی‌آمپرساعت.', 28500000, 26900000, 26900000, 'in_stock', 13, MOBILE),
  row('13', 'simple', 'WY-ECHO-PRO', 'هدفون بی‌سیم اکو پرو', 'حذف نویز فعال، ۴۰ ساعت پخش و اتصال هم‌زمان به دو دستگاه.', 4350000, null, 4350000, 'in_stock', 41, AUDIO),
  row('15', 'simple', 'WY-PULSE3', 'ساعت هوشمند پالس ۳', 'پایش ضربان قلب و اکسیژن خون، GPS داخلی و مقاومت ۵ ATM.', 7200000, 6480000, 6480000, 'in_stock', 4, ACCESSORIES),
  row('17', 'simple', 'WY-VMAX-20K', 'پاوربانک ۲۰۰۰۰ میلی‌آمپر ولت‌مکس', 'خروجی ۶۵ وات USB-C، مناسب شارژ لپ‌تاپ و گوشی.', 1250000, null, 1250000, 'out_of_stock', 0, ACCESSORIES),
  row('19', 'simple', 'WY-RESON-BT', 'اسپیکر بلوتوثی رزونانس', 'توان ۳۰ وات، ضدآب IPX7 و ۱۸ ساعت پخش مداوم.', 2890000, 2490000, 2490000, 'in_stock', 23, AUDIO),
  row('21', 'simple', 'WY-HOME-RGB', 'لامپ هوشمند رنگی هوم‌لایت', '۱۶ میلیون رنگ، کنترل با اپلیکیشن و سازگار با دستیار صوتی.', 480464, null, 480464, 'in_stock', 148, HOME),
  row('23', 'variable', 'WY-TSHIRT', 'تی‌شرت نخی وب‌یار', 'سه سایز، نخ پنبه، دوخت ایرانی.', null, null, 450000, 'in_stock', null, UNCATEGORIZED),
];

function row(external_id: string, product_type: string, sku: string, title: string, short_description: string,
  regular_price_minor: number | null, sale_price_minor: number | null, effective_price_minor: number | null,
  stock_state: string, stock_quantity: number | null, categories: Array<{ id: string; name: string; slug: string }> = []) {
  return {
    id: external_id, external_id, product_type, sku, title, short_description,
    canonical_url: `https://p.webyar.ai/product/${sku}/`, image_url: null, currency: 'IRT',
    regular_price_minor, sale_price_minor, effective_price_minor, stock_state, stock_quantity,
    categories, tags: [], attributes: [], is_virtual: false, is_downloadable: false,
    updated_at: '2026-09-20T17:31:57+00:00',
  };
}

const CONNECTION: any = {
  id: CONN, workspace_id: WS, installation_id: 'inst-1', provider_type: 'woocommerce',
  store_id: 'https://p.webyar.ai', approved_origin: 'https://p.webyar.ai',
  capabilities: ['store.read', 'products.read', 'availability.read', 'orders.read'],
  permissions: { stock: true, orders: true, prices: true, products: true, tracking: true, order_status: true, customer_history: true },
  health: 'connected', catalog_ready: true, revoked_at: null, protocol_version: 'webyar-commerce/1',
};

let connection: any = CONNECTION;

// The index query runs in Postgres; here the rows are supplied directly and
// the ORing + re-ranking under test happen in searchIndexedProducts itself.
function fakeClient() {
  const builder: any = {
    select: () => builder, eq: () => builder, is: () => builder, in: () => builder,
    gte: () => builder, lte: () => builder, contains: () => builder,
    textSearch: (_c: string, q: string) => { builder._q = q; return builder; },
    _q: undefined as string | undefined,
    order: () => builder, limit: () => builder,
    maybeSingle: async () => ({ data: null, error: null }),
    then: (resolve: any) => {
      const q: string = builder._q ?? '';
      const terms = q.split('|').map((t) => t.trim()).filter(Boolean);
      const hay = (r: any) => `${r.title} ${r.short_description} ${r.sku}`;
      const data = terms.length ? INDEX_ROWS.filter((r) => terms.some((t) => hay(r).includes(t))) : INDEX_ROWS;
      return resolve({ data, error: null, count: data.length });
    },
  };
  return { from: () => builder, rpc: async () => ({ data: null, error: null }) };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));
vi.mock('../../../server/services/commerce/gateway.js', async (orig) => {
  const real = await (orig() as Promise<any>);
  return {
    ...real,
    getActiveConnectionForWorkspace: async () => connection,
    assertCommerceModuleEntitled: async () => {},
    // Live revalidation: the store answers with the same figures the index
    // holds, which is the normal case for a catalogue nothing just changed.
    withCommerceConnector: async (_c: any, _w: string, _id: string, opts: any, fn: any) => {
      const connector = {
        getProducts: async (_ctx: any, ids: string[]) =>
          INDEX_ROWS.filter((r) => ids.includes(r.external_id)).map((r) => ({
            externalId: r.external_id, stockState: r.stock_state, currency: r.currency,
            effectivePrice: r.effective_price_minor === null ? null : { amountMinor: String(r.effective_price_minor), currency: 'IRT' },
          })),
        getAvailability: async (_ctx: any, input: any) => {
          const r = INDEX_ROWS.find((x) => x.external_id === input.productExternalId)!;
          return {
            stockState: r.stock_state, stockQuantity: r.stock_quantity,
            effectivePrice: r.effective_price_minor === null ? null : { amountMinor: String(r.effective_price_minor), currency: 'IRT' },
          };
        },
        getStoreInfo: async () => ({ name: 'فروشگاه آزمایشی وب‌یار', currency: 'IRT', url: 'https://p.webyar.ai', catalogReady: true, productCount: 11 }),
      };
      return fn(connector, { correlationId: opts.correlationId ?? 'test' });
    },
  };
});

const { runCommerceToolStage } = await import('../../../server/services/ai-agent/commerce-tools/runner.js');
const { renderToolResults } = await import('../../../server/services/ai-agent/actions/readOnly.js');

const CONFIG: any = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' };
const ask = (question: string) => runCommerceToolStage(CONFIG, { workspaceId: WS, conversationId: null, question });

beforeEach(() => { connection = { ...CONNECTION }; });

describe('what the model receives for a store question', () => {
  it('answers a product question with the right product AND its price', async () => {
    const { toolResults } = await ask('قیمت ساعت هوشمند پالس چنده؟');
    const block = renderToolResults(toolResults)!;

    // Printed so a reviewer can read exactly what the model was told.
    // eslint-disable-next-line no-console
    console.log('\n' + block + '\n');

    const top = toolResults.find((r) => r.name === 'commerce.search_products')!;
    expect(top.data.title).toBe('ساعت هوشمند پالس ۳');
    expect(top.data.price).toBe('6480000');
    expect(top.data.currency).toBe('IRT');
    expect(block).toContain('6480000');
  });

  it('recommends from the catalogue for an open-ended request', async () => {
    const { toolResults } = await ask('یه هدفون خوب معرفی کن');
    const hits = toolResults.filter((r) => r.name === 'commerce.search_products');

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].data.title).toBe('هدفون بی‌سیم اکو پرو');
    expect(hits[0].data.price).toBe('4350000');
  });

  it('honours a stated budget', async () => {
    const { toolResults } = await ask('گوشی زیر ۳۰ میلیون دارید؟');
    const hits = toolResults.filter((r) => r.name === 'commerce.search_products');

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].data.title).toBe('گوشی هوشمند نوا ۱۲');
    expect(Number(hits[0].data.price)).toBeLessThanOrEqual(30_000_000);
  });

  it('reports a sold-out product as sold out rather than hiding it', async () => {
    const { toolResults } = await ask('پاوربانک دارید؟');
    const avail = toolResults.find((r) => r.name === 'commerce.get_availability')!;

    expect(avail.data.product).toBe('پاوربانک ۲۰۰۰۰ میلی‌آمپر ولت‌مکس');
    expect(avail.data.stock_state).toBe('out_of_stock');
  });

  it('revalidates price and stock live before the model states them as fact', async () => {
    const { toolResults, toolsUsed } = await ask('قیمت ساعت هوشمند پالس چنده؟');
    // The top few candidates are each revalidated, so pick the one this
    // question is actually about rather than whichever came back first.
    const live = toolResults.filter((r) => r.name === 'commerce.get_product_live');

    expect(toolsUsed).toContain('commerce.get_product');
    expect(live.length).toBeGreaterThan(0);
    expect(live.find((r) => r.data.external_id === '15')!.data.price).toBe('6480000');
    // Every revalidated row carries a price — a null here is what the whole
    // toMoney defect looked like from the model's side.
    expect(live.every((r) => r.data.price !== null)).toBe(true);
  });

  it('answers «چی دارید؟» with the catalogue instead of searching for the word "products"', async () => {
    // Live transcript: «محصولات الان چی دارید ؟» → "لیست دقیق و به‌روز
    // محصولات وب‌یار در دسترس من نیست". The question matched the product
    // keyword «محصول» and was run as a NAME search for the shopper's whole
    // sentence, and no product is called «محصولات» — so a fully populated,
    // correctly priced index returned nothing.
    const { toolResults, toolsUsed } = await ask('محصولات الان چی دارید ؟');
    const hits = toolResults.filter((r) => r.name === 'commerce.search_products');

    expect(toolsUsed).toContain('commerce.browse_products');
    expect(hits.length).toBeGreaterThan(1);
    expect(hits.every((h) => h.data.title)).toBe(true);
    expect(toolResults.find((r) => r.name === 'commerce.catalog_size')!.data.total_products).toBe(INDEX_ROWS.length);
  });

  it('answers «دسته‌بندی‌ها رو بیار» from the catalogue, not from the model’s imagination', async () => {
    // Live transcript: asked for the categories, the assistant replied with
    // "ابزارهای هوش مصنوعی برای ساخت و مدیریت وب‌سایت" and four more — a
    // plausible-sounding list of things this store does not sell. There was
    // no category tool at all, so commerce never ran and the model answered
    // from what it assumed the business was.
    const { toolResults, toolsUsed } = await ask('دسته بندی هارو بیار');
    const cats = toolResults.filter((r) => r.name === 'commerce.list_categories');

    expect(toolsUsed).toContain('commerce.list_categories');
    expect(cats.map((c) => c.data.category)).toEqual(
      expect.arrayContaining(['لوازم جانبی', 'صوتی و تصویری', 'موبایل و تبلت', 'لوازم خانگی هوشمند']),
    );
    // Counted from the rows, not guessed: three products are accessories.
    expect(cats.find((c) => c.data.category === 'لوازم جانبی')!.data.product_count).toBe(2);
    expect(renderToolResults(toolResults)).toContain('لوازم جانبی');
  });

  it('says the catalogue is still syncing rather than answering from an empty index', async () => {
    connection = { ...CONNECTION, catalog_ready: false };
    const { toolResults } = await ask('یه هدفون خوب معرفی کن');

    expect(toolResults).toEqual([{ name: 'commerce_status', data: { error_code: 'catalog_syncing' } }]);
  });

  it('refuses to reveal an order to an unverified visitor, and says how to fix that', async () => {
    // The refusal alone left the model to invent a remedy. This store
    // verifies a customer by them being signed in to it, so that is what the
    // visitor is told to do.
    const { toolResults } = await ask('وضعیت سفارش ۱۲۳۴۵ چی شد؟');

    expect(toolResults).toEqual([
      { name: 'commerce.order_lookup', data: { error_code: 'identity_required', remedy: 'sign_in_to_store' } },
    ]);
    expect(renderToolResults(toolResults)).toContain('remedy=sign_in_to_store');
  });

  it('answers «تی شرت هم داری ؟» — the verb a real shopper uses', async () => {
    // From the live store. The informal singular «داری» is deliberately not a
    // stock word («دوست داری» is not about the shop) and no rule covered this
    // phrasing, so no intent matched, the commerce stage never ran, and the
    // assistant said it had no information about a t-shirt the shop sells.
    // The catalogue knows better than the keyword list: the words name a
    // product, so it is a product question.
    const { toolResults } = await ask('تی شرت هم داری ؟');
    const hits = toolResults.filter((r) => r.name === 'commerce.search_products');

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].data.title).toBe('تی‌شرت نخی وب‌یار');
  });

  it('and «پاور بانک چی داشتی» — past tense, spaced compound, still a product question', async () => {
    const { toolResults } = await ask('پاور بانک چی داشتی');
    const hits = toolResults.filter((r) => r.name === 'commerce.search_products');

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].data.title).toBe('پاوربانک ۲۰۰۰۰ میلی‌آمپر ولت‌مکس');
  });

  it('stays out of the way of a question that is not about the shop', async () => {
    const { toolResults, toolsUsed } = await ask('سلام خوبی؟');
    expect(toolResults).toEqual([]);
    expect(toolsUsed).toEqual([]);
  });
});
