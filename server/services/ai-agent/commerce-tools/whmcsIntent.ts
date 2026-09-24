/**
 * WHMCS intent detection — deterministic, no model call, no I/O.
 *
 * Why not another model call: routing every message through a classifier
 * costs a provider round trip on EVERY turn, including the large majority
 * that are not about the account at all, to save a WHMCS call on the few
 * that are. The engine already avoids that trade for WooCommerce
 * (commerce-tools/intent.ts) and this follows the same decision.
 *
 * Why not a pile of one-off regexes either: the phrasings that matter are
 * inflected words — «فاکتورهام», «سرویس‌هام», «faturalarım», «alan adım» —
 * and a regex per phrasing never catches up. So the text is normalised
 * (digits, Arabic/Persian letter variants, ZWNJ), split into tokens, and each
 * token is matched as STEM + allowed SUFFIX, with the possessive suffixes
 * doubling as the "this is about MY account" signal. Recall/precision are
 * measured on a labelled fa/en/tr corpus in
 * src/test/commerce/whmcsIntent.test.ts and reported in docs/commerce/WHMCS.md.
 *
 * A follow-up with no resource word of its own («دومی کی تمدید میشه؟»,
 * "and the second one?", «ikincisi?») is resolved from the visitor's own
 * previous turns — the minimal context of the same conversation — without
 * storing anything.
 */

export type WhmcsResource = 'services' | 'domains' | 'invoices' | 'orders' | 'tickets';

export type WhmcsSelector =
  | { kind: 'id'; value: string }
  | { kind: 'ordinal'; index: number }
  | { kind: 'last' }
  | { kind: 'domain'; value: string };

export type WhmcsFilter = 'unpaid' | 'overdue' | 'open' | null;

export type WhmcsIntent =
  | { kind: 'none' }
  | { kind: 'catalog'; mode: 'search' | 'browse'; query: string }
  | {
      kind: 'account';
      resource: WhmcsResource;
      mode: 'list' | 'detail';
      selector: WhmcsSelector | null;
      filter: WhmcsFilter;
      /** The visitor asked for the current state explicitly — never answer from cache. */
      fresh: boolean;
      /** True when the resource came from an earlier turn, not this message. */
      followUp: boolean;
    };

// ── Normalisation ────────────────────────────────────────────────────────

export function normalizeForIntent(input: string): string {
  return String(input || '')
    .toLowerCase()
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[ًٌٍَُِّْٰ]/g, '')
    // ZWNJ joins a word with its suffix: «سرویس‌هام» and «سرویسهام» are one token.
    .replace(/‌/g, '')
    .replace(/[‍‎‏]/g, '')
    .replace(/İ/g, 'i')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(text: string): string[] {
  return text.split(/[\s.,;:!?؟،؛()«»"'[\]{}/\\|*+=<>~`^]+/u).filter(Boolean);
}

// ── Lexicon ──────────────────────────────────────────────────────────────

/** Persian suffixes that may follow a noun stem. The possessive ones mark MY account. */
const FA_POSSESSIVE = ['م', 'ام', 'هام', 'هایم', 'مو', 'امو', 'هامو', 'هایمو', 'هامون', 'مون', 'مان', 'هایمان', 'یم', 'ایم'];
const FA_OTHER = ['', 'ها', 'های', 'هایی', 'ی', 'ای', 'رو', 'ش', 'اش', 'هاش', 'شو', 'اشو', 'هارو', 'هاشو', 'و'];

/** Turkish endings. Anything carrying the 1sg possessive `-(I)m` counts as MY account. */
const TR_POSSESSIVE_RE = /^(?:l[ae]r)?(?:[ıiuü])?m(?:[ıiuü]|[ıiuü]n|d[ae]|d[ae]n|[ae])?$/;
const TR_OTHER_RE = /^(?:l[ae]r(?:[ıi])?|[yn]?[ıiuü]|y?[ae]|d[ae]|d[ae]n|[ıiuü]n|n[ıiuü]n|s[ıi]|l[ae]r[ıi]n[ıi])?$/;

interface StemMatch {
  matched: boolean;
  possessive: boolean;
}

function matchStem(token: string, stems: readonly string[], lang: 'fa' | 'tr' | 'en'): StemMatch {
  for (const stem of stems) {
    if (!token.startsWith(stem)) continue;
    const rest = token.slice(stem.length);
    if (lang === 'fa') {
      if (FA_POSSESSIVE.includes(rest)) return { matched: true, possessive: true };
      if (FA_OTHER.includes(rest)) return { matched: true, possessive: false };
    } else if (lang === 'tr') {
      if (TR_POSSESSIVE_RE.test(rest)) return { matched: true, possessive: true };
      if (TR_OTHER_RE.test(rest)) return { matched: true, possessive: false };
    } else if (rest === '' || rest === 's' || rest === 'es') {
      return { matched: true, possessive: false };
    }
  }
  return { matched: false, possessive: false };
}

const RESOURCE_STEMS: Record<WhmcsResource, { fa: string[]; tr: string[]; en: string[] }> = {
  services: {
    fa: ['سرویس', 'هاست', 'هاستینگ', 'میزبانی', 'سرور', 'اشتراک', 'پکیج', 'خدمات'],
    tr: ['hizmet', 'hosting', 'sunucu', 'paket', 'abonelik', 'servis'],
    en: ['service', 'hosting', 'server', 'vps', 'subscription', 'package'],
  },
  domains: {
    fa: ['دامنه', 'دامین', 'دومین', 'دامنهی'],
    tr: ['domain', 'alanadı', 'alanad'],
    en: ['domain'],
  },
  invoices: {
    fa: ['فاکتور', 'صورتحساب', 'قبض', 'بدهی', 'بدهکاری'],
    tr: ['fatura', 'borç', 'borc'],
    en: ['invoice', 'bill'],
  },
  orders: {
    fa: ['سفارش'],
    tr: ['sipariş', 'siparis'],
    en: ['order'],
  },
  tickets: {
    fa: ['تیکت', 'تیکتی'],
    // Turkish voices a final p/ç/t/k before a vowel: talep → talebi, borç → borcu.
    tr: ['ticket', 'talep', 'talebi', 'talebim', 'destektalebi'],
    en: ['ticket'],
  },
};

/** Multi-word phrases, matched on the normalised text before tokenising. */
const RESOURCE_PHRASES: Array<[RegExp, WhmcsResource]> = [
  [/صورت ?حساب/, 'invoices'],
  [/درخواست پشتیبانی/, 'tickets'],
  [/alan ?ad(?:[ıi]|lar)/, 'domains'],
  [/destek talep/, 'tickets'],
  [/support (?:request|case)s?/, 'tickets'],
  [/(?:payment|amount) due|how much do i owe|outstanding balance/, 'invoices'],
  [/پرداخت ?نشده/, 'invoices'],
  [/ödenmemiş|odenmemis/, 'invoices'],
  // "What do I have to pay?" names no resource at all, but in a billing
  // system it can only mean the invoices.
  [/(?:باید|بایست)[^.؟?]{0,12}پرداخت|پرداخت کنم|need to pay|have to pay|pay (?:now|this month)|ödemem|ödemeliyim|odemem|odemeliyim/, 'invoices'],
  // "Has support replied?" is a ticket question.
  [/پشتیبانی[^.؟?]{0,20}(?:جواب|پاسخ)|support[^.?]{0,20}(?:repl|answer|respond)|destek[^.?]{0,20}(?:cevap|yanıt|yanit)/, 'tickets'],
];

const EN_POSSESSIVE = /(?:^| )(?:my|mine|i have|do i|am i|i owe|i paid|my account|i need to pay|i have to pay)(?: |$|\?)/;
const FA_POSSESSIVE_WORDS = /(?:^| )(?:من|مال من|حسابم|اکانتم|حساب کاربریم|پنلم)(?: |$)/;
const TR_POSSESSIVE_WORDS = /(?:^| )(?:benim|hesabım|hesabim|alan ?adım|alan ?adlarım|alan ?adımı|alan ?adlarımı)(?: |$)/;

/** Account-state words: asking about these only makes sense for something the visitor owns. */
const ACCOUNT_SIGNAL = /تمدید|منقضی|انقضا|سررسید|سر ?رسید|معلق|تعلیق|ساسپند|وضعیت|پرداخت|بدهکار|مانده|سر رسید|renew|expir|due|suspend|status|unpaid|overdue|balance|outstanding|yenile|sona er|vade|askı|askiya|durum|ödeme|odeme|bakiye/;

const CATALOG_SIGNAL = /قیمت|تعرفه|هزینه|خرید|بخرم|بخرید|می‌خوام بخرم|چند (?:است|هست|ه)|ارزان|ارزون|مقایسه|پلن|پکیج|معرفی|price|pricing|cost|how much|buy|purchase|order a|plans?|packages?|cheap|compare|offer|fiyat|ücret|ucret|satın|satin|kaç para|kac para|planlar|paketler|ne kadar|ucuz/;

/** A question about what is on offer, with no resource word of its own. */
const OFFER_QUESTION = /(?:do you (?:have|offer|sell)|is there|are there|var mı|var mi|دارید|دارین|هست؟|موجوده)/;
const PLAN_WORD = /پلن|پکیج|تعرفه|plan|package|paket/;

const CATALOG_BROWSE = /چه (?:پلن|پکیج|سرویس|هاست)|چه ?نوع|لیست (?:پلن|تعرفه|قیمت)|تعرفه ها|تعرفهها|همه (?:پلن|پکیج)|what (?:plans|packages|hosting)|list of (?:plans|packages)|show (?:me )?(?:your )?(?:plans|packages|pricing)|hangi (?:paket|plan)|paketleriniz|planlarınız|fiyat listesi/;

const FRESH_SIGNAL = /الان|الآن|همین الان|فعلا|فعلاً|هنوز|همین حالا|پرداخت کردم|واریز کردم|right now|currently|\bnow\b|still|just paid|i paid|up to date|şimdi|simdi|hala|hâlâ|az önce|ödedim|odedim|güncel/;

const UNPAID_SIGNAL = /پرداخت ?نشده|نپرداخته|بدهی|بدهکار|مانده|unpaid|outstanding|owe|balance|due|ödenmemiş|odenmemis|borç|borc|bakiye/;
const OVERDUE_SIGNAL = /سررسید ?گذشته|معوق|عقب افتاده|دیر شده|overdue|past due|late|vadesi geçmiş|vadesi gecmis|gecikmiş|gecikmis/;
const OPEN_SIGNAL = /باز|پاسخ ?داده ?نشده|بی ?جواب|open|unanswered|pending|açık|acik|cevaplanmamış/;

const ORDINALS: Array<[RegExp, number | 'last']> = [
  [/(?:^| )(?:اولی|اولین|اول|first|1st|birinci|ilk|ilki)(?: |$)/, 1],
  [/(?:^| )(?:دومی|دومین|دوم|second|2nd|ikinci|ikincisi)(?: |$)/, 2],
  [/(?:^| )(?:سومی|سومین|سوم|third|3rd|üçüncü|ucuncu|üçüncüsü)(?: |$)/, 3],
  [/(?:^| )(?:چهارمی|چهارمین|چهارم|fourth|4th|dördüncü|dorduncu)(?: |$)/, 4],
  [/(?:^| )(?:پنجمی|پنجمین|پنجم|fifth|5th|beşinci|besinci)(?: |$)/, 5],
  [/(?:^| )(?:آخری|آخرین|last|latest|most recent|newest|sonuncu|son|en son)(?: |$)/, 'last'],
];

const ID_RE = /(?:#|شماره|number|no\.?|numara|nr\.?)\s*([a-z]{3}-\d{4,8}|\d{1,10})/;
const TICKET_TID_RE = /\b([a-z]{3}-\d{6})\b/;
const DOMAIN_RE = /(?:^|[\s(«"'])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(?=$|[\s)»"',.;:!?؟،])/;

/** Anaphora with no resource word: «لینکش», «مبلغش», "its link", "that one". */
const ANAPHORA = /لینک|مبلغ|تاریخ|کی |چقدر|جزئیات|اون|آن|همین|ش(?: |$)|link|amount|details|that one|it |its |this one|onun|bunun|linki|detay/;

function resourcesIn(normalized: string): { resources: WhmcsResource[]; possessive: boolean } {
  const found = new Set<WhmcsResource>();
  let possessive = false;
  for (const [re, resource] of RESOURCE_PHRASES) if (re.test(normalized)) found.add(resource);
  for (const token of tokens(normalized)) {
    for (const [resource, stems] of Object.entries(RESOURCE_STEMS) as Array<[WhmcsResource, (typeof RESOURCE_STEMS)[WhmcsResource]]>) {
      const fa = matchStem(token, stems.fa, 'fa');
      const tr = matchStem(token, stems.tr, 'tr');
      const en = matchStem(token, stems.en, 'en');
      if (fa.matched || tr.matched || en.matched) {
        found.add(resource);
        if (fa.possessive || tr.possessive) possessive = true;
      }
    }
  }
  // «بدهی» is an invoice question on its own; «سرور» next to «دامنه» is not a second resource.
  return { resources: [...found], possessive };
}

function selectorIn(normalized: string, resource: WhmcsResource | null): WhmcsSelector | null {
  if (resource === 'tickets') {
    const tid = normalized.match(TICKET_TID_RE);
    if (tid) return { kind: 'id', value: tid[1].toUpperCase() };
  }
  const id = normalized.match(ID_RE);
  if (id) return { kind: 'id', value: id[1].toUpperCase() };
  if (resource === 'services' || resource === 'domains' || resource === null) {
    const domain = normalized.match(DOMAIN_RE);
    if (domain && !/^(?:www\.)?(?:webyar|example)\./.test(domain[1])) return { kind: 'domain', value: domain[1] };
  }
  for (const [re, value] of ORDINALS) {
    if (re.test(normalized)) return value === 'last' ? { kind: 'last' } : { kind: 'ordinal', index: value };
  }
  // «فاکتور 1234» — a bare number right after the resource word.
  const bare = normalized.match(/(?:فاکتور|invoice|fatura|سفارش|order|sipariş|تیکت|ticket|سرویس|service)\s*(\d{2,10})(?: |$)/);
  if (bare) return { kind: 'id', value: bare[1] };
  return null;
}

function filterFor(resource: WhmcsResource, normalized: string): WhmcsFilter {
  if (resource === 'invoices') {
    if (OVERDUE_SIGNAL.test(normalized)) return 'overdue';
    if (UNPAID_SIGNAL.test(normalized)) return 'unpaid';
    return null;
  }
  if (resource === 'tickets' && OPEN_SIGNAL.test(normalized)) return 'open';
  return null;
}

/** The primary resource when a message names several («دامنه و سرویسم»): the first account-only one wins. */
function primary(resources: WhmcsResource[]): WhmcsResource | null {
  for (const r of ['invoices', 'tickets', 'orders', 'domains', 'services'] as WhmcsResource[]) {
    if (resources.includes(r)) return r;
  }
  return null;
}

function catalogQuery(original: string): string {
  return String(original || '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

export function detectWhmcsIntent(question: string): WhmcsIntent {
  const normalized = normalizeForIntent(question);
  if (!normalized) return { kind: 'none' };

  const { resources, possessive: suffixPossessive } = resourcesIn(normalized);
  const possessive = suffixPossessive
    || EN_POSSESSIVE.test(normalized)
    || FA_POSSESSIVE_WORDS.test(normalized)
    || TR_POSSESSIVE_WORDS.test(normalized);
  const accountSignal = ACCOUNT_SIGNAL.test(normalized);
  const catalogSignal = CATALOG_SIGNAL.test(normalized);
  const fresh = FRESH_SIGNAL.test(normalized);
  const resource = primary(resources);

  if (resource) {
    const selector = selectorIn(normalized, resource);
    const accountOnly = resource === 'invoices' || resource === 'tickets' || resource === 'orders';
    const isAccount = accountOnly
      ? !(resource === 'orders' && catalogSignal && !possessive && !accountSignal && !selector)
      : possessive || (accountSignal && !catalogSignal) || (selector !== null && selector.kind !== 'ordinal' && !catalogSignal);
    if (isAccount) {
      return {
        kind: 'account',
        resource,
        mode: selector ? 'detail' : 'list',
        selector,
        filter: filterFor(resource, normalized),
        fresh,
        followUp: false,
      };
    }
    if (resource === 'services' && (catalogSignal || OFFER_QUESTION.test(normalized) || /\?|؟|hosting|hizmet/.test(normalized))) {
      return {
        kind: 'catalog',
        mode: CATALOG_BROWSE.test(normalized) || !stripsToQuery(normalized) ? 'browse' : 'search',
        query: catalogQuery(question),
      };
    }
    // «DNS دامنه چیست؟», "what is a domain" — general knowledge, not the account.
    return { kind: 'none' };
  }

  if (CATALOG_BROWSE.test(normalized)) return { kind: 'catalog', mode: 'browse', query: catalogQuery(question) };
  // «پلن ارزون‌تر دارید؟», "is there a cheaper plan?", «daha ucuz paket var mı?»
  if (PLAN_WORD.test(normalized) && (catalogSignal || OFFER_QUESTION.test(normalized))) {
    return { kind: 'catalog', mode: stripsToQuery(normalized) ? 'search' : 'browse', query: catalogQuery(question) };
  }
  return { kind: 'none' };
}

/** True when the question has something left to search for beyond the generic words. */
function stripsToQuery(normalized: string): boolean {
  const generic = /قیمت|تعرفه|هزینه|خرید|چنده|چند|است|هست|دارید|دارین|چه|ها|های|سرویس|هاست|هاستینگ|پلن|پکیج|price|pricing|cost|how|much|do|you|have|plans?|packages?|hosting|the|a|of|fiyat|ne|kadar|var|mı|mi|paket|hosting/g;
  return normalized.replace(generic, ' ').replace(/[\s?؟.!]+/g, '').length >= 2;
}

/**
 * Resolves a message that carries no resource word from the visitor's own
 * previous turns. Returns the current intent unchanged when it already has a
 * resource, and `none` when nothing earlier explains it.
 */
export function resolveWhmcsFollowUp(
  question: string,
  previousVisitorTurns: readonly string[],
): WhmcsIntent {
  const current = detectWhmcsIntent(question);
  if (current.kind !== 'none') return current;

  const normalized = normalizeForIntent(question);
  const selector = selectorIn(normalized, null);
  const anaphoric = selector !== null || ANAPHORA.test(normalized) || ACCOUNT_SIGNAL.test(normalized);
  if (!anaphoric) return current;

  for (const turn of [...previousVisitorTurns].reverse().slice(0, 4)) {
    const earlier = detectWhmcsIntent(turn);
    if (earlier.kind !== 'account') continue;
    const chosen = selector ?? earlier.selector;
    return {
      kind: 'account',
      resource: earlier.resource,
      mode: chosen ? 'detail' : earlier.mode,
      selector: chosen,
      filter: earlier.filter,
      fresh: FRESH_SIGNAL.test(normalized),
      followUp: true,
    };
  }
  return current;
}
