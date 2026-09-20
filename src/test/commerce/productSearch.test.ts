/**
 * Free-text product search — the query the assistant actually runs.
 *
 * `commerce_products.search_text` is a `simple`-config tsvector, which has no
 * stopword list, so every token handed to the tsquery must be present in the
 * row. The search used to AND the shopper's whole sentence together, and
 * against the real store that returned NOTHING for every realistic question:
 *
 *     'هدفون'                          → 2 products
 *     'هدفون & خوب'                    → 0
 *     'یه & هدفون & خوب & معرفی & کن'  → 0
 *
 * A fully populated, perfectly priced index was therefore invisible to the
 * assistant. These tests pin the two halves of the fix: which words are
 * searched for, and which product comes back first.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type Row = Record<string, any>;

let candidateRows: Row[] = [];
const captured: { textSearch?: { query: string; opts: any }; limit?: number; filters: Array<[string, any, any]> } = { filters: [] };

function fakeClient() {
  const builder: any = {
    select: () => builder,
    eq: (c: string, v: any) => { captured.filters.push(['eq', c, v]); return builder; },
    is: () => builder,
    gte: (c: string, v: any) => { captured.filters.push(['gte', c, v]); return builder; },
    lte: (c: string, v: any) => { captured.filters.push(['lte', c, v]); return builder; },
    contains: (c: string, v: any) => { captured.filters.push(['contains', c, v]); return builder; },
    textSearch: (_col: string, query: string, opts: any) => { captured.textSearch = { query, opts }; return builder; },
    order: () => builder,
    limit: (n: number) => { captured.limit = n; return builder; },
    // The real driver filters in Postgres; here the candidate set is supplied
    // directly, because what is under test is the tsquery we ask for and the
    // order we return.
    then: (resolve: any) => resolve({ data: candidateRows, error: null, count: candidateRows.length }),
  };
  return { from: () => builder };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));

const { searchIndexedProducts, buildSearchTerms } = await import('../../../server/services/commerce/productIndex.js');

const CONFIG: any = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' };
const CONN = 'conn-1';

/** Shapes mirror the live store's index rows. */
const product = (sku: string, title: string, desc = '') => ({
  id: sku, external_id: sku, product_type: 'simple', sku, title, short_description: desc,
  canonical_url: null, image_url: null, currency: 'IRT',
  regular_price_minor: 1000, sale_price_minor: null, effective_price_minor: 1000,
  stock_state: 'in_stock', stock_quantity: 1, categories: [], tags: [], attributes: [],
  is_virtual: false, is_downloadable: false, updated_at: '2026-09-20T00:00:00Z',
});

beforeEach(() => {
  candidateRows = [];
  captured.textSearch = undefined;
  captured.limit = undefined;
  captured.filters.length = 0;
});

describe('what the search asks Postgres for', () => {
  it('drops the words that make a sentence a question', async () => {
    expect(buildSearchTerms('یه هدفون خوب معرفی کن')).toEqual(['هدفون']);
    expect(buildSearchTerms('do you have any headphones')).toEqual(['headphones']);
  });

  it('keeps both spellings of a word written with a نیم‌فاصله', () => {
    // U+200C is part of the Persian spelling and `to_tsvector` keeps it inside
    // the token, so stripping it turned «تی‌شرت» into a term that matched no
    // row in an index holding «تی‌شرت».
    expect(buildSearchTerms('تی‌شرت دارید؟')).toEqual(['تی‌شرت', 'تیشرت']);
  });

  it('falls back to the raw words when the question is nothing but filler', () => {
    // Better to search for something and find nothing than to drop the filter
    // entirely and hand back the whole catalogue.
    expect(buildSearchTerms('دارید؟')).toEqual(['دارید']);
  });

  it('ORs the terms instead of requiring every one of them', async () => {
    candidateRows = [product('A', 'هدفون بی‌سیم اکو پرو')];
    await searchIndexedProducts(CONFIG, CONN, { text: 'یه هدفون خوب معرفی کن' } as any);

    expect(captured.textSearch!.query).toBe('هدفون');
    // No `type` means to_tsquery, where `|` is the OR operator.
    expect(captured.textSearch!.opts?.type).toBeUndefined();
    expect(captured.textSearch!.opts?.config).toBe('simple');
  });

  it('still sends price and stock as plain column predicates', async () => {
    candidateRows = [product('A', 'گوشی هوشمند نوا ۱۲')];
    await searchIndexedProducts(CONFIG, CONN, {
      text: 'گوشی', maxPrice: { amountMinor: '30000000', currency: 'IRT' }, inStockOnly: true,
    } as any);

    expect(captured.filters).toContainEqual(['lte', 'effective_price_minor', 30000000]);
    expect(captured.filters).toContainEqual(['eq', 'stock_state', 'in_stock']);
  });
});

describe('which product comes back first', () => {
  it('ranks the row matching the most of the shopper’s words highest', async () => {
    // Every one of these matches the OR query; only one is the answer.
    candidateRows = [
      product('WY-NOVA12-128', 'گوشی هوشمند نوا ۱۲'),
      product('WY-HOME-RGB', 'لامپ هوشمند رنگی هوم‌لایت'),
      product('WY-PULSE3', 'ساعت هوشمند پالس ۳'),
    ];
    const { rows } = await searchIndexedProducts(CONFIG, CONN, { text: 'قیمت ساعت هوشمند پالس چنده؟', limit: 3 } as any);

    expect(rows[0].sku).toBe('WY-PULSE3'); // ساعت + هوشمند + پالس
  });

  it('folds the نیم‌فاصله away when scoring, so one word is not two hits', async () => {
    candidateRows = [
      product('WY-BUNDLE', 'پک کامل صوتی وب‌یار', 'هدفون و اسپیکر با هم.'),
      product('WY-TSHIRT', 'تی‌شرت نخی وب‌یار'),
    ];
    const { rows } = await searchIndexedProducts(CONFIG, CONN, { text: 'تی‌شرت دارید؟', limit: 2 } as any);

    expect(rows[0].sku).toBe('WY-TSHIRT');
  });

  it('over-fetches a bounded window so there is something to rank', async () => {
    candidateRows = [product('A', 'هدفون')];
    await searchIndexedProducts(CONFIG, CONN, { text: 'هدفون', limit: 5 } as any);
    expect(captured.limit).toBe(20);

    captured.limit = undefined;
    await searchIndexedProducts(CONFIG, CONN, { text: 'هدفون', limit: 20 } as any);
    expect(captured.limit).toBe(60); // capped, never limit × 4 without bound
  });

  it('does not over-fetch when there is no text to rank by', async () => {
    candidateRows = [product('A', 'هدفون')];
    await searchIndexedProducts(CONFIG, CONN, { limit: 5 } as any);
    expect(captured.textSearch).toBeUndefined();
    expect(captured.limit).toBe(5);
  });

  it('never returns more than the caller asked for', async () => {
    candidateRows = Array.from({ length: 30 }, (_, i) => product(`P${i}`, `محصول هوشمند ${i}`));
    const { rows } = await searchIndexedProducts(CONFIG, CONN, { text: 'هوشمند', limit: 4 } as any);
    expect(rows).toHaveLength(4);
  });
});
