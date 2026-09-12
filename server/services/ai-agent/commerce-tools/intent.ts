/**
 * Deterministic commerce-intent detection.
 *
 * This repo's AI Agent does not run a native multi-round tool-calling loop
 * (see docs/commerce/ARCHITECTURE.md §AI integration model) — commerce
 * tools are invoked from a fixed, bounded pre-generation stage, the same
 * way Knowledge Base retrieval is. Intent + structured filters are
 * extracted deterministically (regex/keyword heuristics, Persian +
 * English), never by asking the model to invent a tool call: model output
 * is never authorization (spec's core invariant).
 *
 * This is intentionally a heuristic, not an LLM call — it adds zero extra
 * provider latency/cost per turn. See the engineering report's Known
 * Limitations for the documented upgrade path (a structured-output
 * extraction call) if recall on more varied phrasing is needed later.
 */
import type { ProductSearchFilters } from '../../../../shared/commerce/types.js';

export type CommerceIntent =
  | { kind: 'none' }
  | { kind: 'search_products'; filters: ProductSearchFilters }
  | { kind: 'get_availability'; text: string }
  | { kind: 'order_status' }
  | { kind: 'order_lookup'; orderNumber: string }
  | { kind: 'store_info' };

const ORDER_KEYWORDS = /سفارش|پیگیری مرسوله|tracking number|track my order|order status|where.{0,15}my order/i;
const ORDER_NUMBER_RE = /(?:سفارش|order)\D{0,15}#?\s*(\d{3,12})/i;
const AVAILABILITY_KEYWORDS = /موجود(ه|است|ی)?|in stock|available\??|هست؟?$/i;
const STORE_INFO_KEYWORDS = /ساعت کاری فروشگاه|فروشگاه شما کجاست|store hours|about your store/i;
const PRODUCT_INTENT_KEYWORDS = /محصول|کفش|لباس|قیمت|خرید|معرفی کن|پیشنهاد|product|buy|price|recommend/i;

const MILLION_TOMAN_RE = /(\d+(?:[.,]\d+)?)\s*میلیون/;
const THOUSAND_TOMAN_RE = /(\d+(?:[.,]\d+)?)\s*هزار/;
const PLAIN_NUMBER_PRICE_RE = /(\d{4,})\s*(?:تومان|ریال)?/;
const SIZE_RE = /سایز\s*(\d{2,3})|size\s*(\d{2,3})/i;

const COLOR_MAP: Record<string, string> = {
  'مشکی': 'black', 'سیاه': 'black', 'سفید': 'white', 'قرمز': 'red',
  'آبی': 'blue', 'سبز': 'green', 'زرد': 'yellow', 'خاکستری': 'gray',
  'قهوه‌ای': 'brown', 'صورتی': 'pink', 'بنفش': 'purple',
  black: 'black', white: 'white', red: 'red', blue: 'blue',
  green: 'green', yellow: 'yellow', gray: 'gray', brown: 'brown',
};

function extractMaxPriceTomanMinor(text: string): string | null {
  // WooCommerce stores whatever minor unit the store uses; for Iranian
  // stores this is typically Toman/Rial as a plain integer — we pass the
  // extracted number through as-is (amountMinor is a store-reported unit,
  // never a Web Yar-invented conversion — spec §68/§69).
  const million = text.match(MILLION_TOMAN_RE);
  if (million) return String(Math.round(parseFloat(million[1].replace(',', '.')) * 1_000_000));
  const thousand = text.match(THOUSAND_TOMAN_RE);
  if (thousand) return String(Math.round(parseFloat(thousand[1].replace(',', '.')) * 1_000));
  const plain = text.match(PLAIN_NUMBER_PRICE_RE);
  if (plain) return plain[1];
  return null;
}

function extractAttributes(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const sizeMatch = text.match(SIZE_RE);
  if (sizeMatch) attrs.size = sizeMatch[1] || sizeMatch[2];
  for (const [term, canonical] of Object.entries(COLOR_MAP)) {
    if (text.includes(term)) {
      attrs.color = canonical;
      break;
    }
  }
  return attrs;
}

export function detectCommerceIntent(question: string): CommerceIntent {
  const text = (question || '').trim();
  if (!text) return { kind: 'none' };

  const orderNumberMatch = text.match(ORDER_NUMBER_RE);
  if (orderNumberMatch) return { kind: 'order_lookup', orderNumber: orderNumberMatch[1] };
  if (ORDER_KEYWORDS.test(text)) return { kind: 'order_status' };

  if (STORE_INFO_KEYWORDS.test(text)) return { kind: 'store_info' };

  const attrs = extractAttributes(text);
  const hasAvailabilityWord = AVAILABILITY_KEYWORDS.test(text);
  const maxPrice = extractMaxPriceTomanMinor(text);

  if (hasAvailabilityWord && (Object.keys(attrs).length > 0 || PRODUCT_INTENT_KEYWORDS.test(text))) {
    // "این کفش سایز ۴۳ مشکی موجوده؟" — attribute-qualified availability
    // question. Resolved as a search (to find the matching variant) whose
    // top candidate then gets a live availability revalidation — see
    // commerce-tools/runner.ts.
    return { kind: 'search_products', filters: { text, attributes: attrs, maxPrice: maxPrice ? { amountMinor: maxPrice, currency: 'IRR' } : undefined, limit: 3 } };
  }
  if (hasAvailabilityWord) return { kind: 'get_availability', text };

  if (PRODUCT_INTENT_KEYWORDS.test(text) || Object.keys(attrs).length > 0 || maxPrice) {
    return {
      kind: 'search_products',
      filters: {
        text,
        attributes: Object.keys(attrs).length ? attrs : undefined,
        maxPrice: maxPrice ? { amountMinor: maxPrice, currency: 'IRR' } : undefined,
        limit: 5,
      },
    };
  }

  return { kind: 'none' };
}
