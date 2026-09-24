/**
 * Intent and follow-up detection used by the direct stage — Persian,
 * English and Turkish. Deterministic regexes: no model decides whether the
 * store is called or who the customer is.
 */
import { describe, it, expect } from 'vitest';
import { detectCommerceIntent, detectFollowUp } from '../../../server/services/ai-agent/commerce-tools/intent';
import { buildSearchTerms } from '../../../server/services/commerce/productIndex';

describe('Turkish questions reach the store like Persian and English ones', () => {
  it.each([
    ['Siparişim nerede?', 'order_status'],
    ['12345 numaralı sipariş ne durumda?', 'order_lookup'],
    ['Bu ürünün yorumları nasıl?', 'product_reviews'],
    ['Kategoriler neler?', 'list_categories'],
    ['iPhone stokta var mı?', 'get_availability'],
    ['Neler var?', 'browse_products'],
  ])('%s → %s', (q, kind) => {
    expect(detectCommerceIntent(q).kind).toBe(kind);
  });
});

describe('own returns vs the return policy', () => {
  it('"my return status" is the customer\'s own returns', () => {
    expect(detectCommerceIntent('what is my return status?').kind).toBe('order_returns');
    expect(detectCommerceIntent('وضعیت مرجوعی من چیه؟').kind).toBe('order_returns');
    expect(detectCommerceIntent('iade durumum nedir?').kind).toBe('order_returns');
  });

  it('a policy question is not a private read', () => {
    expect(detectCommerceIntent('what is your return policy?').kind).not.toBe('order_returns');
  });
});

describe('unrelated messages produce no intent (so no store call)', () => {
  it.each(['سلام، خوبی؟', 'thanks, that is all', 'Teşekkürler, iyi günler'])('%s', (q) => {
    expect(detectCommerceIntent(q).kind).toBe('none');
    const f = detectFollowUp(q);
    expect(f.ordinal === null && !f.more && !f.lastOrder).toBe(true);
  });
});

describe('follow-up references', () => {
  it.each([
    ['دومی رنگ مشکی داره؟', 2],
    ['does the second one come in black?', 2],
    ['İkincisi siyah var mı?', 2],
    ['اولی چنده؟', 1],
    ['the first one please', 1],
    ['sonuncusu stokta mı?', 'last'],
  ])('%s → %s', (q, ordinal) => {
    expect(detectFollowUp(q).ordinal).toBe(ordinal);
  });

  it('asks for more results', () => {
    expect(detectFollowUp('بیشتر نشون بده').more).toBe(true);
    expect(detectFollowUp('show more').more).toBe(true);
    expect(detectFollowUp('daha fazla göster').more).toBe(true);
  });

  it('knows the last order and a tracking question', () => {
    const f = detectFollowUp('سفارش آخرم کی ارسال شده؟');
    expect(f.lastOrder).toBe(true);
    expect(f.wantsTracking).toBe(true);
    expect(detectFollowUp('son siparişim kargoda mı?').lastOrder).toBe(true);
  });

  it('knows an explicit "right now"', () => {
    expect(detectFollowUp('الان موجوده؟').wantsFresh).toBe(true);
    expect(detectFollowUp('is it in stock right now?').wantsFresh).toBe(true);
    expect(detectFollowUp('şu an stokta mı?').wantsFresh).toBe(true);
  });
});

describe('search terms drop the question words in all three languages', () => {
  it('keeps only the product words', () => {
    expect(buildSearchTerms('iPhone stokta var mı?')).toEqual(['iPhone']);
    expect(buildSearchTerms('قیمت آیفون چنده؟')).toEqual(['آیفون']);
    expect(buildSearchTerms('do you have a macbook?')).toEqual(['macbook']);
  });
});
