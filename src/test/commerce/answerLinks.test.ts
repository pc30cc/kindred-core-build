/**
 * The assistant may only hand out links it was actually given.
 *
 * From the live store, a real answer and the real catalogue URL behind it:
 *
 *   given  …/product/%d9%be%d8%a7%d9%88%d8%b1%d8%a8%d8%a7%d9%86%da%a9-%db%b2%db%b0…/
 *   sent   …/product/پاوربانک-%d۲%DB%B0%DB%B0%DB%B0%DB%B0-میليياٟمپر-ولتمکس/
 *
 * Half decoded by hand, `%db%b2` turned into `%d` plus a Persian ۲, and
 * «میلی‌آمپر» came back as «میليياٟمپر» — different letters and a stray
 * U+065F. The visitor was handed a 404 stated as fact.
 */
import { describe, it, expect } from 'vitest';
import { repairCommerceLinks, urlsFromToolResults } from '../../../server/services/ai-agent/commerce-tools/answerLinks.js';

/** Verbatim from commerce_products.canonical_url. */
const POWERBANK = 'https://p.webyar.ai/product/%d9%be%d8%a7%d9%88%d8%b1%d8%a8%d8%a7%d9%86%da%a9-%db%b2%db%b0%db%b0%db%b0%db%b0-%d9%85%db%8c%d9%84%db%8c%d8%a2%d9%85%d9%be%d8%b1-%d9%88%d9%84%d8%aa%d9%85%da%a9%d8%b3/';
const SPEAKER = 'https://p.webyar.ai/product/%d8%a7%d8%b3%d9%be%db%8c%da%a9%d8%b1-%d8%a8%d9%84%d9%88%d8%aa%d9%88%d8%ab%db%8c-%d8%b1%d8%b2%d9%88%d9%86%d8%a7%d9%86%d8%b3/';
/** Verbatim from what the model sent. */
const MANGLED = 'https://p.webyar.ai/product/پاوربانک-%d۲%DB%B0%DB%B0%DB%B0%DB%B0-میليياٟمپر-ولتمکس/';

describe('a store link the model retyped', () => {
  it('is put back to the one the catalogue actually holds', () => {
    const answer = `در حال حاضر پاوربانک ۲۰۰۰۰ میلی‌آمپر ولت‌مکس موجود نیست. لینک خرید: ${MANGLED}`;

    const out = repairCommerceLinks(answer, [POWERBANK]);

    expect(out).toContain(POWERBANK);
    expect(out).not.toContain(MANGLED);
    // Only the address changed; the answer around it is untouched.
    expect(out.startsWith('در حال حاضر پاوربانک ۲۰۰۰۰ میلی‌آمپر ولت‌مکس موجود نیست. لینک خرید: ')).toBe(true);
  });

  it('picks the product it meant, not merely the right shop', () => {
    // Both candidates are on p.webyar.ai; only one is a powerbank.
    const out = repairCommerceLinks(`لینک: ${MANGLED}`, [SPEAKER, POWERBANK]);

    expect(out).toContain(POWERBANK);
    expect(out).not.toContain(SPEAKER);
  });

  it('is left exactly alone when it was copied correctly', () => {
    const answer = `لینک خرید: ${POWERBANK}`;
    expect(repairCommerceLinks(answer, [POWERBANK, SPEAKER])).toBe(answer);
  });

  it('keeps the sentence’s punctuation where it was', () => {
    const out = repairCommerceLinks(`ببینید ${MANGLED}.`, [POWERBANK]);
    expect(out).toBe(`ببینید ${POWERBANK}.`);
  });
});

describe('a link that is nothing the tools gave', () => {
  it('is dropped rather than left pointing somewhere wrong', () => {
    // Same shop, no resemblance to any product it was handed. A 404 stated as
    // fact is worse than a sentence with no link in it.
    const invented = 'https://p.webyar.ai/product/چیزی-که-وجود-ندارد-اصلا/';
    const out = repairCommerceLinks(`لینک: ${invented}`, [POWERBANK, SPEAKER]);

    expect(out).toBe('لینک: ');
  });

  it('but another site’s link is none of this code’s business', () => {
    // Knowledge-base articles and operator-written text carry links too.
    const answer = 'راهنما: https://docs.example.com/guide/setup را ببینید.';
    expect(repairCommerceLinks(answer, [POWERBANK])).toBe(answer);
  });

  it('and an answer with no links at all is returned unchanged', () => {
    const answer = 'قیمت ۱٬۲۵۰٬۰۰۰ تومان است.';
    expect(repairCommerceLinks(answer, [POWERBANK])).toBe(answer);
  });

  it('and nothing is touched when the tools supplied no links', () => {
    expect(repairCommerceLinks(`لینک: ${MANGLED}`, [])).toContain(MANGLED);
  });
});

describe('which links count as given', () => {
  it('every url the commerce tools put in front of the model', () => {
    const results = [
      { name: 'commerce.search_products', data: { title: 'پاوربانک', url: POWERBANK } },
      { name: 'commerce.search_products', data: { title: 'اسپیکر', url: SPEAKER } },
      { name: 'commerce.catalog_size', data: { total_products: 11 } },
      { name: 'commerce.get_product_live', data: { external_id: '17', price: '1250000' } },
    ];
    expect(urlsFromToolResults(results)).toEqual([POWERBANK, SPEAKER]);
  });

  it('and nothing that is not an http url', () => {
    expect(urlsFromToolResults([
      { data: { url: null } },
      { data: { url: 'javascript:alert(1)' } },
      { data: { url: '/product/17' } },
      { data: {} },
    ])).toEqual([]);
  });
});
