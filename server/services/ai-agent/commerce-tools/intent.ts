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
  | { kind: 'browse_products' }
  | { kind: 'product_reviews'; text: string }
  | { kind: 'list_categories' }
  | { kind: 'order_returns' }
  | { kind: 'store_info' };

// Turkish (sipariş/kargo/takip) is additive: it only ever turns "no intent"
// into an order question, never changes how a Persian or English one reads.
const ORDER_KEYWORDS = /سفارش|پیگیری مرسوله|tracking number|track my order|order status|where.{0,15}my order|my orders|sipariş|kargom|kargo takip|siparişim/i;
const ORDER_NUMBER_RE = /(?:سفارش|order|sipariş)\D{0,15}#?\s*(\d{3,12})/i;
// «مرجوعی من کجاست» / "my return status" / «iade durumum» — the customer's OWN
// returns, not the return POLICY (a knowledge-base question).
const RETURN_STATUS_KEYWORDS = /(?:مرجوعی|مرجوع|برگشت)\s*(?:من|ام|م\b)|وضعیت\s*(?:مرجوعی|مرجوع)|my returns?\b|return status|iade(?:m|lerim| durum)/i;
// "«X» دارید؟" is how a Persian shopper asks whether a store stocks
// something at all — far more common than the word موجود — and it used to
// produce no commerce intent whatsoever, so the store stayed invisible for
// the most ordinary question it receives. Bare «داری» is deliberately
// excluded: it is the second person singular that shows up in phrases like
// «دوست داری», which are not about stock.
const AVAILABILITY_KEYWORDS = /موجود(ه|است|ی)?|in stock|available\??|هست؟?$|دارید|دارین|می‌فروشید|میفروشید|stokta|stok var|var mı|mevcut mu|do you (?:have|sell|carry|stock)|have you got|got any/i;
// Checked BEFORE availability, so that the handful of «… دارید؟» questions
// that are about the shop rather than its catalogue — opening hours,
// branches, an address — do not get answered with a product's stock level.
const STORE_INFO_KEYWORDS = /ساعا?ت کاری|فروشگاه شما کجاست|آدرس فروشگاه|شعبه|نمایندگی|store hours|about your store|çalışma saatleri|mağaza adresi/i;
// A shopper asking what the shop sells, rather than for one named thing.
// «محصولات الان چی دارید ؟» used to match PRODUCT_INTENT_KEYWORDS on the word
// «محصول» and be run as a NAME search for the word "products" — which matches
// no product in any catalogue, so the assistant answered that it had no list.
// The question is a request to browse, and browsing needs no text filter at
// all. Both of these are checked before the search branches below, because
// «چی دارید» also contains the availability word «دارید».
// «نظرات در مورد این محصول چیه» / «ریویو بخون» / «چند ستاره گرفته». Checked
// before the product branches, because a review question names a product too
// and would otherwise come back as a price.
// No `\b` anywhere in here: JavaScript word boundaries are ASCII-only, so
// «نظرات» followed by a space is NOT a boundary and the pattern silently
// missed the most obvious phrasing of all — «نظرات در مورد این محصول چیه».
// The plural/compound forms are listed instead, which also keeps «نظرت چیه»
// (the visitor asking the ASSISTANT's opinion) out of it.
const REVIEW_KEYWORDS = /نظرات|نظرها|نظرهای|نظر مشتری|نظر کاربر|ریویو|reviews?|امتیاز|چند ستاره|ستاره گرفته|rating|yorumlar|yorumları|değerlendirme|kaç yıldız/i;
const BROWSE_KEYWORDS = /چی\s*(?:دارید|دارین|داری)|چیا\s*(?:دارید|دارین)|چه\s*محصولات|لیست\s*محصولات|همه[\s\u200c]*محصولات|محصولات\s*(?:شما|تون|خودتون)|what\s+(?:do\s+you\s+)?(?:have|sell)|product\s+list|show\s+me\s+(?:your\s+)?products|neler var|ne satıyorsunuz|ürünleriniz|ürün listesi/i;
// «دسته بندی», «دسته‌بندی» and «دسته‌بندی‌ها» — the space and the ZWNJ are
// both ordinary spellings of the same word.
const CATEGORY_KEYWORDS = /دسته[\s\u200c]*بندی|دسته[\s\u200c]*ها\b|categor(?:y|ies)|kategori/i;
const PRODUCT_INTENT_KEYWORDS = /محصول|کفش|لباس|قیمت|خرید|بخرم|می‌خوام|میخوام|می‌خواستم|میخواستم|معرفی کن|پیشنهاد|product|buy|price|recommend|looking for|ürün|fiyat|satın al|önerir misin|arıyorum/i;

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

/**
 * Persian (۰-۹) and Arabic-Indic (٠-٩) digits → ASCII, so the numeric
 * extractors below see something `\d` can match.
 *
 * A Persian keyboard produces ۴۳, not 43, so without this "سایز ۴۳" yielded
 * no size attribute, "زیر ۵ میلیون" no price ceiling, and "سفارش ۱۲۳۴۵" fell
 * back to a generic order-status answer instead of looking that order up.
 * Only the STRUCTURED extraction reads the normalized string — the free-text
 * query keeps the shopper's original characters, because the product index's
 * full-text column holds whatever digits the store itself typed.
 *
 * Group separators (',' and '٬') are deliberately left alone: neither form
 * was ever stripped, so "۱٬۵۰۰٬۰۰۰ تومان" still reads as no plain number,
 * exactly as "1,500,000" always has.
 */
function normalizeDigits(text: string): string {
  return text
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/٫/g, '.');
}

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
  // Matching reads the digit-normalized copy; `text` stays verbatim for
  // anything handed downstream as a search query.
  const scan = normalizeDigits(text);

  const orderNumberMatch = scan.match(ORDER_NUMBER_RE);
  if (orderNumberMatch) return { kind: 'order_lookup', orderNumber: orderNumberMatch[1] };
  if (RETURN_STATUS_KEYWORDS.test(scan)) return { kind: 'order_returns' };
  if (ORDER_KEYWORDS.test(scan)) return { kind: 'order_status' };

  if (STORE_INFO_KEYWORDS.test(scan)) return { kind: 'store_info' };

  if (REVIEW_KEYWORDS.test(scan)) return { kind: 'product_reviews', text };
  if (CATEGORY_KEYWORDS.test(scan)) return { kind: 'list_categories' };
  if (BROWSE_KEYWORDS.test(scan)) return { kind: 'browse_products' };

  const attrs = extractAttributes(scan);
  const hasAvailabilityWord = AVAILABILITY_KEYWORDS.test(scan);
  const maxPrice = extractMaxPriceTomanMinor(scan);

  if (hasAvailabilityWord && (Object.keys(attrs).length > 0 || maxPrice || PRODUCT_INTENT_KEYWORDS.test(scan))) {
    // "این کفش سایز ۴۳ مشکی موجوده؟" — attribute-qualified availability
    // question. Resolved as a search (to find the matching variant) whose
    // top candidate then gets a live availability revalidation — see
    // commerce-tools/runner.ts.
    //
    // A price ceiling counts as qualification too: "گوشی زیر ۳۰ میلیون
    // دارید؟" is a search with a budget, and routing it to the single-product
    // availability path would silently discard the budget the shopper just
    // stated.
    return { kind: 'search_products', filters: { text, attributes: attrs, maxPrice: maxPrice ? { amountMinor: maxPrice, currency: 'IRR' } : undefined, limit: 3 } };
  }
  if (hasAvailabilityWord) return { kind: 'get_availability', text };

  if (PRODUCT_INTENT_KEYWORDS.test(scan) || Object.keys(attrs).length > 0 || maxPrice) {
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

// ── Follow-up references (direct connectors) ──────────────────────────
//
// «دومی رنگ مشکی داره؟», "the second one", «ikincisi» — a question about a
// result the assistant listed earlier in THIS conversation. Resolved against
// the ids kept in conversation metadata (never against text the model wrote),
// and every order id is re-checked for ownership by the store.

const ORDINALS: Array<[RegExp, number]> = [
  [/(?:^|\s)(?:اولی|اولین|اوّلی|first(?: one)?|1st|ilki|birinci(?:si)?)(?:\s|$|[؟?.,!])/i, 1],
  [/(?:^|\s)(?:دومی|دومین|second(?: one)?|2nd|ikinci(?:si)?)(?:\s|$|[؟?.,!])/i, 2],
  [/(?:^|\s)(?:سومی|سومین|third(?: one)?|3rd|üçüncü(?:sü)?)(?:\s|$|[؟?.,!])/i, 3],
  [/(?:^|\s)(?:چهارمی|چهارمین|fourth(?: one)?|4th|dördüncü(?:sü)?)(?:\s|$|[؟?.,!])/i, 4],
  [/(?:^|\s)(?:پنجمی|پنجمین|fifth(?: one)?|5th|beşinci(?:si)?)(?:\s|$|[؟?.,!])/i, 5],
];
const LAST_RE = /(?:^|\s)(?:آخری|last one|the last|sonuncu(?:su)?)(?:\s|$|[؟?.,!])/i;
const MORE_RE = /بیشتر نشون|موارد بیشتر|بقیه(?:ش|ـش)?|بعدی(?:ها)?|ادامه(?:‌|\s)?(?:بده|لیست)|صفحه بعد|show more|more results|next page|any more|daha fazla|devamı|sonraki sayfa/i;
const LAST_ORDER_RE = /(?:سفارش|خرید)\s*(?:آخر|آخری|قبلی)|آخرین\s*(?:سفارش|خرید)|last order|latest order|most recent order|son sipariş/i;
const TRACKING_RE = /رهگیری|مرسوله|ارسال\s*(?:شد|شده|میشه|می‌شه)|کی\s*(?:می‌رسه|میرسه|میاد)|پست|پیک|تحویل|tracking|shipped|shipping|delivery|deliver|kargo|takip|teslim/i;
const FRESHNESS_RE = /الان|همین\s*الان|هنوز|فعلا|فعلاً|currently|right now|still|at the moment|şu an|hala|hâlâ/i;
const OPTION_RE = /رنگ|سایز|اندازه|مدل|گزینه|ویژگی|مشخصات|color|colour|size|option|variant|spec|renk|beden|boyut|özellik/i;

export interface FollowUp {
  /** 1-based position in the last listed results, or 'last'. */
  ordinal: number | 'last' | null;
  more: boolean;
  lastOrder: boolean;
  wantsTracking: boolean;
  wantsFresh: boolean;
  aboutOptions: boolean;
}

export function detectFollowUp(question: string): FollowUp {
  const text = normalizeDigits((question || '').trim());
  let ordinal: FollowUp['ordinal'] = null;
  for (const [re, n] of ORDINALS) if (re.test(` ${text} `)) { ordinal = n; break; }
  if (ordinal === null && LAST_RE.test(` ${text} `) && !LAST_ORDER_RE.test(text)) ordinal = 'last';
  return {
    ordinal,
    more: MORE_RE.test(text),
    lastOrder: LAST_ORDER_RE.test(text),
    wantsTracking: TRACKING_RE.test(text),
    wantsFresh: FRESHNESS_RE.test(text),
    aboutOptions: OPTION_RE.test(text),
  };
}
