/**
 * Canonical product index — writes go through the version-aware RPCs
 * defined in database/migrations/148_commerce_platform.sql
 * (commerce_upsert_product / commerce_upsert_variant and their tombstone
 * counterparts), which make duplicate and out-of-order delivery safe by
 * construction (see docs/commerce/CONNECTOR_PROTOCOL.md §Sync, §Events).
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import type { CommerceProduct, CommerceVariant, Money, ProductSearchFilters } from '../../../shared/commerce/types.js';

function moneyMinor(m: Money | null): number | null {
  if (!m) return null;
  const n = Number(m.amountMinor);
  return Number.isFinite(n) ? n : null;
}

export async function upsertProductInIndex(
  config: ServerConfig,
  workspaceId: string,
  connectionId: string,
  product: CommerceProduct,
): Promise<string | null> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('commerce_upsert_product', {
    p_workspace_id: workspaceId,
    p_connection_id: connectionId,
    p_external_id: product.externalId,
    p_product_type: product.type,
    p_sku: product.sku,
    p_title: product.title,
    p_short_description: product.shortDescription,
    p_canonical_url: product.canonicalUrl,
    p_image_url: product.imageUrl,
    p_currency: product.currency,
    p_regular_price_minor: moneyMinor(product.regularPrice),
    p_sale_price_minor: moneyMinor(product.salePrice),
    p_effective_price_minor: moneyMinor(product.effectivePrice),
    p_stock_state: product.stockState,
    p_stock_quantity: product.stockQuantity,
    p_categories: product.categories,
    p_tags: product.tags,
    p_attributes: product.attributes,
    p_is_virtual: product.isVirtual,
    p_is_downloadable: product.isDownloadable,
    p_entity_version: product.updatedAt,
  });
  if (error) throw new Error(`product index upsert failed: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  const productId = row?.product_id ?? null;

  if (productId) {
    for (const variant of product.variants) {
      await upsertVariantInIndex(config, workspaceId, connectionId, productId, variant);
    }
  }
  return productId;
}

export async function upsertVariantInIndex(
  config: ServerConfig,
  workspaceId: string,
  connectionId: string,
  productId: string,
  variant: CommerceVariant,
): Promise<void> {
  const sb = getServiceClient(config);
  const { error } = await sb.rpc('commerce_upsert_variant', {
    p_workspace_id: workspaceId,
    p_connection_id: connectionId,
    p_product_id: productId,
    p_external_id: variant.externalId,
    p_sku: variant.sku,
    p_attributes: variant.attributes,
    p_currency: variant.effectivePrice?.currency ?? variant.regularPrice?.currency ?? 'USD',
    p_regular_price_minor: moneyMinor(variant.regularPrice),
    p_sale_price_minor: moneyMinor(variant.salePrice),
    p_effective_price_minor: moneyMinor(variant.effectivePrice),
    p_stock_state: variant.stockState,
    p_stock_quantity: variant.stockQuantity,
    p_image_url: variant.imageUrl,
    p_entity_version: variant.updatedAt,
  });
  if (error) throw new Error(`variant index upsert failed: ${error.message}`);
}

export async function tombstoneProductInIndex(
  config: ServerConfig,
  connectionId: string,
  externalId: string,
  occurredAtIso: string,
): Promise<void> {
  const sb = getServiceClient(config);
  const { error } = await sb.rpc('commerce_tombstone_product', {
    p_connection_id: connectionId,
    p_external_id: externalId,
    p_entity_version: occurredAtIso,
  });
  if (error) throw new Error(`product tombstone failed: ${error.message}`);
}

export async function tombstoneVariantInIndex(
  config: ServerConfig,
  connectionId: string,
  externalId: string,
  occurredAtIso: string,
): Promise<void> {
  const sb = getServiceClient(config);
  const { error } = await sb.rpc('commerce_tombstone_variant', {
    p_connection_id: connectionId,
    p_external_id: externalId,
    p_entity_version: occurredAtIso,
  });
  if (error) throw new Error(`variant tombstone failed: ${error.message}`);
}

export interface IndexedProductRow {
  id: string;
  external_id: string;
  product_type: string;
  sku: string | null;
  title: string;
  short_description: string | null;
  canonical_url: string | null;
  image_url: string | null;
  currency: string;
  regular_price_minor: number | null;
  sale_price_minor: number | null;
  effective_price_minor: number | null;
  stock_state: string;
  stock_quantity: number | null;
  categories: unknown;
  tags: unknown;
  attributes: unknown;
  is_virtual: boolean;
  is_downloadable: boolean;
  updated_at: string;
}

/**
 * Words that make a sentence a question rather than a product.
 *
 * `search_text` is built with the `simple` text-search config, which has no
 * stopword list of its own, so every token handed to the tsquery has to be
 * present in the row. Left in, one filler word is enough to match nothing:
 * "هدفون" finds two products, "هدفون & خوب" finds none.
 */
/** Row window for category aggregation — bounded so a big catalogue cannot turn it into a scan. */
const CATEGORY_SCAN_ROWS = 500;

const QUESTION_WORDS = new Set([
  // Persian fillers, pronouns, particles and question words.
  'یه', 'یک', 'این', 'اون', 'آن', 'رو', 'را', 'از', 'با', 'به', 'در', 'که', 'تا', 'و', 'یا',
  'برای', 'هم', 'چه', 'چی', 'چیه', 'چند', 'چنده', 'چقدر', 'کدوم', 'کدام', 'کجا', 'کجاست',
  'دارید', 'دارین', 'داری', 'دارد', 'هست', 'هستش', 'باشه', 'بود', 'میشه', 'می‌شه', 'شود',
  'خوب', 'بهترین', 'عالی', 'مناسب', 'ارزان', 'ارزون', 'ارزانترین', 'ارزونترین', 'گران', 'گرون',
  'معرفی', 'پیشنهاد', 'بده', 'بدید', 'کن', 'کنید', 'کنین', 'میخوام', 'می‌خوام', 'میخواستم',
  'لطفا', 'لطفاً', 'سلام', 'ممنون', 'موجوده', 'موجود', 'میفروشید', 'می‌فروشید',
  'زیر', 'بالای', 'کمتر', 'بیشتر', 'حدود', 'تومان', 'تومن', 'ریال', 'میلیون', 'هزار',
  // English equivalents.
  'a', 'an', 'the', 'is', 'are', 'do', 'you', 'have', 'got', 'any', 'some', 'me', 'my', 'i',
  'show', 'find', 'want', 'need', 'looking', 'for', 'under', 'over', 'best', 'good', 'cheap',
  'please', 'hi', 'hello', 'what', 'which', 'how', 'much', 'price', 'in', 'stock', 'available',
]);

/**
 * The shopper's free text reduced to the words worth searching for.
 * Exported so the tokenisation is testable without a database.
 */
export function buildSearchTerms(text: string | null | undefined): string[] {
  if (!text || !text.trim()) return [];
  // U+200C ZERO WIDTH NON-JOINER is a letter-level part of Persian spelling
  // («تی‌شرت», «ارزان‌ترین»), not punctuation, and `to_tsvector` keeps it
  // inside the token. Stripping it here — as the old `[^\p{L}\p{N}]` did,
  // since it is a format character rather than a letter — turned «تی‌شرت»
  // into «تیشرت», which matches nothing in an index that stored «تی‌شرت».
  const ZWNJ = '\u200c';
  const all = text
    .trim()
    .split(/\s+/)
    .slice(0, 12)
    .map((t) => t.replace(/[^\p{L}\p{N}\u200c]/gu, ''))
    .filter(Boolean);
  // Keep the content words. If the question was nothing BUT question words we
  // fall back to all of them rather than matching the whole catalogue.
  const content = all.filter((t) => !QUESTION_WORDS.has(t.replace(new RegExp(ZWNJ, 'g'), '').toLowerCase()));
  const kept = (content.length ? content : all).slice(0, 8);

  // Shoppers type both spellings, and so do store owners, so search for
  // both: whichever side used the joiner, the other still matches.
  const out: string[] = [];
  const push = (term: string) => { if (term && !out.includes(term)) out.push(term); };
  for (const t of kept) {
    push(t);
    push(t.replace(new RegExp(ZWNJ, 'g'), ''));
  }

  // Persian compounds are written with a space as often as without one, and
  // `to_tsvector` splits on the space — so «پاور بانک» is two tokens that
  // appear in no row, while the catalogue holds the single token «پاوربانک».
  // Measured against the live index: `to_tsquery('simple','پاور | بانک')`
  // matched 0 rows, `'پاوربانک'` matched 1. The shopper asked «پاور بانک
  // دارید ؟» and was told the stock could not be verified.
  //
  // So each adjacent pair is also searched joined. Pairs only, and only over
  // the terms already kept, so the query stays bounded; the re-rank below
  // then decides which row actually wins. The reverse direction — a shopper
  // typing «پاوربانک» when the store wrote «پاور بانک» — cannot be done this
  // way, since splitting a compound needs a dictionary we do not have.
  for (let i = 0; i + 1 < kept.length; i += 1) {
    const joined = (kept[i] + kept[i + 1]).replace(new RegExp(ZWNJ, 'g'), '');
    if (joined !== kept[i] && joined !== kept[i + 1]) push(joined);
  }
  return out;
}

/**
 * Structured filters (price/stock/category) are plain column predicates —
 * NEVER inferred semantically. Free text uses the tsvector column. See
 * docs/commerce/ARCHITECTURE.md §23.
 *
 * Free text is matched with OR and then re-ranked here by how many of the
 * shopper's terms a row actually contains. It used to AND every token of the
 * question together, which meant a real shopper sentence — "یه هدفون خوب
 * معرفی کن" — matched nothing at all even against a fully populated index,
 * because no product contains the words "یه" or "معرفی". Ranking in this
 * process rather than with ts_rank keeps the query a plain PostgREST filter;
 * the candidate window is bounded so the extra rows never grow with the
 * catalogue.
 */
export async function searchIndexedProducts(
  config: ServerConfig,
  connectionId: string,
  filters: ProductSearchFilters,
): Promise<{ rows: IndexedProductRow[]; totalMatched: number }> {
  const sb = getServiceClient(config);
  const limit = Math.min(Math.max(filters.limit ?? 8, 1), 20);

  let query = sb
    .from('commerce_products')
    .select(
      'id, external_id, product_type, sku, title, short_description, canonical_url, image_url, currency, regular_price_minor, sale_price_minor, effective_price_minor, stock_state, stock_quantity, categories, tags, attributes, is_virtual, is_downloadable, updated_at',
      { count: 'exact' },
    )
    .eq('connection_id', connectionId)
    .is('deleted_at', null);

  const terms = buildSearchTerms(filters.text);
  if (terms.length) {
    // `to_tsquery` syntax (no `type`), so `|` is the OR operator; the terms
    // are already stripped to letters and digits, so nothing here can inject
    // query syntax.
    query = query.textSearch('search_text', terms.join(' | '), { config: 'simple' });
  }
  if (filters.minPrice) query = query.gte('effective_price_minor', Number(filters.minPrice.amountMinor));
  if (filters.maxPrice) query = query.lte('effective_price_minor', Number(filters.maxPrice.amountMinor));
  if (filters.inStockOnly) query = query.eq('stock_state', 'in_stock');
  if (filters.categorySlug) query = query.contains('categories', [{ slug: filters.categorySlug }]);

  // Over-fetch only when there is something to re-rank; a bounded window so
  // a large catalogue cannot turn this into a full scan.
  const candidateLimit = terms.length ? Math.min(limit * 4, 60) : limit;
  query = query.order('updated_at', { ascending: false }).limit(candidateLimit);

  const { data, error, count } = await query;
  if (error) throw new Error(`product search failed: ${error.message}`);
  const rows = (data ?? []) as IndexedProductRow[];

  if (!terms.length) return { rows, totalMatched: count ?? rows.length };

  // Compare with the joiner folded away on both sides, so the two spellings
  // of one word do not score as two separate hits.
  const fold = (v: string) => v.replace(/\u200c/g, '').toLowerCase();
  const lowered = [...new Set(terms.map(fold))].filter(Boolean);
  const score = (r: IndexedProductRow) => {
    const hay = fold(`${r.title ?? ''} ${r.short_description ?? ''} ${r.sku ?? ''}`);
    return lowered.reduce((acc, t) => acc + (hay.includes(t) ? 1 : 0), 0);
  };
  const ranked = rows
    .map((r, i) => ({ r, s: score(r), i }))
    // Most of the shopper's words first; the query's own updated_at ordering
    // breaks ties, so the comparison stays stable.
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.r);

  return { rows: ranked, totalMatched: count ?? ranked.length };
}

/**
 * The catalogue's categories, counted from the index.
 *
 * A shopper asking «دسته‌بندی‌ها رو بیار» had no tool at all: the question
 * matched no intent, commerce never ran, and the assistant answered from the
 * model's own idea of what the business sells — which for this store was a
 * list of AI website products that do not exist in its catalogue.
 *
 * Aggregated here rather than in SQL because `categories` is a jsonb array on
 * each product row and there is no category table to join; the row window is
 * bounded so this never grows into a scan of a large catalogue.
 */
export async function listIndexedCategories(
  config: ServerConfig,
  connectionId: string,
  limit = 12,
): Promise<Array<{ name: string; slug: string | null; productCount: number }>> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('commerce_products')
    .select('categories')
    .eq('connection_id', connectionId)
    .is('deleted_at', null)
    .limit(CATEGORY_SCAN_ROWS);
  if (error) throw new Error(`category read failed: ${error.message}`);

  const counts = new Map<string, { name: string; slug: string | null; productCount: number }>();
  for (const row of (data ?? []) as Array<{ categories: unknown }>) {
    if (!Array.isArray(row.categories)) continue;
    for (const raw of row.categories) {
      if (!raw || typeof raw !== 'object') continue;
      const cat = raw as { name?: unknown; slug?: unknown };
      const name = typeof cat.name === 'string' ? cat.name.trim() : '';
      const slug = typeof cat.slug === 'string' ? cat.slug : null;
      const key = slug ?? name;
      if (!name || !key) continue;
      const existing = counts.get(key);
      if (existing) existing.productCount += 1;
      else counts.set(key, { name, slug, productCount: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.productCount - a.productCount || a.name.localeCompare(b.name)).slice(0, limit);
}

export async function getIndexedProductsByIds(
  config: ServerConfig,
  connectionId: string,
  externalIds: string[],
): Promise<IndexedProductRow[]> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('commerce_products')
    .select(
      'id, external_id, product_type, sku, title, short_description, canonical_url, image_url, currency, regular_price_minor, sale_price_minor, effective_price_minor, stock_state, stock_quantity, categories, tags, attributes, is_virtual, is_downloadable, updated_at',
    )
    .eq('connection_id', connectionId)
    .in('external_id', externalIds.slice(0, 20))
    .is('deleted_at', null);
  if (error) throw new Error(`product lookup failed: ${error.message}`);
  return (data ?? []) as IndexedProductRow[];
}
