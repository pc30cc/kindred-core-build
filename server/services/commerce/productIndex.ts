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
 * Structured filters (price/stock/category) are plain column predicates —
 * NEVER inferred semantically. Free text uses the tsvector column. See
 * docs/commerce/ARCHITECTURE.md §23.
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

  if (filters.text && filters.text.trim()) {
    const terms = filters.text
      .trim()
      .split(/\s+/)
      .slice(0, 8)
      .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ''))
      .filter(Boolean);
    if (terms.length) query = query.textSearch('search_text', terms.join(' & '), { type: 'plain', config: 'simple' });
  }
  if (filters.minPrice) query = query.gte('effective_price_minor', Number(filters.minPrice.amountMinor));
  if (filters.maxPrice) query = query.lte('effective_price_minor', Number(filters.maxPrice.amountMinor));
  if (filters.inStockOnly) query = query.eq('stock_state', 'in_stock');
  if (filters.categorySlug) query = query.contains('categories', [{ slug: filters.categorySlug }]);

  query = query.order('updated_at', { ascending: false }).limit(limit);

  const { data, error, count } = await query;
  if (error) throw new Error(`product search failed: ${error.message}`);
  return { rows: (data ?? []) as IndexedProductRow[], totalMatched: count ?? (data?.length ?? 0) };
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
