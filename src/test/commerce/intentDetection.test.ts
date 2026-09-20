/**
 * Deterministic commerce-intent detection against the exact acceptance
 * scenario phrases from the spec (Persian). Model output is never
 * authorization — intent/filter extraction here is regex-based and
 * auditable, not an LLM guess (docs/commerce/ARCHITECTURE.md §AI
 * integration model).
 */
import { describe, it, expect } from 'vitest';
import { detectCommerceIntent } from '../../../server/services/ai-agent/commerce-tools/intent.js';

describe('commerce intent detection', () => {
  it('Scenario B — "این محصول موجوده؟" is a commerce availability question (routed via search since it names "this product", not a specific SKU)', () => {
    const intent = detectCommerceIntent('این محصول موجوده؟');
    expect(['get_availability', 'search_products']).toContain(intent.kind);
  });

  it('a bare availability phrase with no product-ish keyword is a direct availability check', () => {
    const intent = detectCommerceIntent('موجوده؟');
    expect(intent.kind).toBe('get_availability');
  });

  it('Scenario C — product discovery with a price ceiling in Toman', () => {
    // The `.replace('۵', '5')` that used to sit here was papering over the
    // bug below: a Persian keyboard types ۵, and the extractor could not read it.
    const intent = detectCommerceIntent('یک محصول مشکی تا ۵ میلیون معرفی کن');
    expect(intent.kind).toBe('search_products');
    if (intent.kind === 'search_products') {
      expect(intent.filters.attributes?.color).toBe('black');
      expect(intent.filters.maxPrice?.amountMinor).toBe('5000000');
    }
  });

  it('Scenario D — variant-qualified availability ("سایز 43 این مدل موجوده؟")', () => {
    const intent = detectCommerceIntent('سایز 43 این مدل موجوده؟');
    expect(intent.kind).toBe('search_products');
    if (intent.kind === 'search_products') {
      expect(intent.filters.attributes?.size).toBe('43');
    }
  });

  it('full example — black shoe, size 43, under 5 million', () => {
    const intent = detectCommerceIntent('یه کفش مردونه مشکی سایز 43 تا 5 میلیون میخوام');
    expect(intent.kind).toBe('search_products');
    if (intent.kind === 'search_products') {
      expect(intent.filters.attributes?.color).toBe('black');
      expect(intent.filters.attributes?.size).toBe('43');
      expect(intent.filters.maxPrice?.amountMinor).toBe('5000000');
    }
  });

  it('Scenario F — "سفارش آخرم کجاست؟" is an order-status question with no order number', () => {
    const intent = detectCommerceIntent('سفارش آخرم کجاست؟');
    expect(intent.kind).toBe('order_status');
  });

  it('Scenario G — "سفارش 1234 کجاست؟" extracts the order number', () => {
    const intent = detectCommerceIntent('سفارش 1234 کجاست؟');
    expect(intent.kind).toBe('order_lookup');
    if (intent.kind === 'order_lookup') {
      expect(intent.orderNumber).toBe('1234');
    }
  });

  it('English order tracking phrasing', () => {
    const intent = detectCommerceIntent('where is my order');
    expect(intent.kind).toBe('order_status');
  });

  it('unrelated small talk has no commerce intent', () => {
    expect(detectCommerceIntent('سلام، خوبی؟').kind).toBe('none');
    expect(detectCommerceIntent('what are your business hours').kind).toBe('none');
    expect(detectCommerceIntent('').kind).toBe('none');
  });
});

describe('Persian-keyboard digits', () => {
  // The plugin's whole admin UI is Persian and the shoppers it serves type on
  // Persian keyboards, so ۴۳ — not 43 — is the ordinary input. Every numeric
  // extractor here is built on `\d`, which matches ASCII only, so without
  // normalization the structured filters silently came back empty: the
  // assistant would answer a "under 5 million" question with products over
  // budget, and a "size 43" question with every size in the catalogue.

  it('reads a price ceiling written with Persian digits', () => {
    const intent = detectCommerceIntent('گوشی زیر ۵ میلیون تومان میخوام');
    expect(intent.kind).toBe('search_products');
    if (intent.kind === 'search_products') expect(intent.filters.maxPrice?.amountMinor).toBe('5000000');
  });

  it('reads a size written with Persian digits', () => {
    const intent = detectCommerceIntent('این کفش سایز ۴۳ مشکی موجوده؟');
    expect(intent.kind).toBe('search_products');
    if (intent.kind === 'search_products') {
      expect(intent.filters.attributes?.size).toBe('43');
      expect(intent.filters.attributes?.color).toBe('black');
    }
  });

  it('looks up an order number written with Persian digits', () => {
    const intent = detectCommerceIntent('وضعیت سفارش ۱۲۳۴۵ چی شد؟');
    expect(intent.kind).toBe('order_lookup');
    if (intent.kind === 'order_lookup') expect(intent.orderNumber).toBe('12345');
  });

  it('reads Arabic-Indic digits too', () => {
    const intent = detectCommerceIntent('قیمت زیر ٣٠٠ هزار تومان');
    expect(intent.kind).toBe('search_products');
    if (intent.kind === 'search_products') expect(intent.filters.maxPrice?.amountMinor).toBe('300000');
  });

  it('hands the shopper’s original text to full-text search, digits untouched', () => {
    // The index's search_text column holds whatever the STORE typed, so
    // rewriting the shopper's digits here could only cost us matches.
    const intent = detectCommerceIntent('قیمت گوشی ۱۳ پرو');
    expect(intent.kind).toBe('search_products');
    if (intent.kind === 'search_products') expect(intent.filters.text).toContain('۱۳');
  });
});

describe('«… دارید؟» — how a shopper actually asks for stock', () => {
  // Before this, «پاوربانک دارید؟» produced NO commerce intent at all: the
  // keyword list knew موجود but not دارید, and a store that sells power banks
  // was invisible for the single most ordinary question it receives.

  it('treats a bare “do you have X?” as an availability question', () => {
    expect(detectCommerceIntent('پاوربانک دارید؟').kind).toBe('get_availability');
    expect(detectCommerceIntent('این مدل رو می‌فروشید؟').kind).toBe('get_availability');
  });

  it('keeps a stated budget as a search, not a stock check', () => {
    // Routing this to the single-product availability path would silently
    // throw away the ceiling the shopper just named.
    const intent = detectCommerceIntent('گوشی زیر ۳۰ میلیون دارید؟');
    expect(intent.kind).toBe('search_products');
    if (intent.kind === 'search_products') expect(intent.filters.maxPrice?.amountMinor).toBe('30000000');
  });

  it('does not read the singular «داری» as a stock question', () => {
    // «دوست داری» is not about the catalogue.
    expect(detectCommerceIntent('دوست داری کمکم کنی؟').kind).toBe('none');
  });

  it('reads «چی دارید؟» as browse the catalogue, not search for a product named "what"', () => {
    // From the live transcript. «محصولات الان چی دارید ؟» matched the product
    // keyword «محصول» and became a name search for the whole sentence, which
    // no product matches — so a full index answered nothing.
    for (const q of ['محصولات الان چی دارید ؟', 'چیا دارین؟', 'لیست محصولات رو بده', 'what do you sell?']) {
      expect(detectCommerceIntent(q).kind).toBe('browse_products');
    }
  });

  it('reads a request for the categories as one', () => {
    // Spelled with a space, with a نیم‌فاصله, and in English.
    for (const q of ['دسته بندی هارو بیار', 'دسته‌بندی‌های فروشگاه چیه؟', 'what categories do you have?']) {
      expect(detectCommerceIntent(q).kind).toBe('list_categories');
    }
  });

  it('does not swallow an ordinary product question into browsing', () => {
    // «دارید» appears in all of these; only the «چی دارید» shape is a browse.
    expect(detectCommerceIntent('پاور بانک دارید ؟').kind).toBe('get_availability');
    expect(detectCommerceIntent('قیمت ساعت هوشمند پالس چنده؟').kind).toBe('search_products');
    expect(detectCommerceIntent('یه هدفون خوب معرفی کن').kind).toBe('search_products');
  });

  it('answers shop questions about the shop, not about a product’s stock', () => {
    // These all end in «دارید؟» too, so they have to be claimed before the
    // availability branch or they come back as some product's stock level.
    for (const q of ['ساعت کاری دارید؟', 'ساعات کاری فروشگاه چیه؟', 'شعبه‌ی حضوری دارید؟', 'نمایندگی در شیراز دارید؟']) {
      expect(detectCommerceIntent(q).kind).toBe('store_info');
    }
  });
});

