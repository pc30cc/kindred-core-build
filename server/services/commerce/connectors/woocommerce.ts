/**
 * WooCommerce connector adapter.
 *
 * Translates the canonical CommerceConnector contract into signed calls
 * against the webyar-woocommerce plugin's narrow REST surface
 * (/wp-json/webyar/v1/**, see docs/commerce/CONNECTOR_PROTOCOL.md). This is
 * the ONLY file in the platform allowed to know that surface exists — the
 * Commerce Gateway, the AI tool layer, and every caller above them see only
 * CommerceProduct/CommerceOrder/etc.
 *
 * Every value read off the wire is treated as untrusted merchant content
 * (server/services/commerce/sanitize.ts) before it becomes part of a
 * canonical object.
 */
import {
  type CommerceConnector,
  type CommerceConnectorContext,
  type CommerceProduct,
  type CommerceVariant,
  type CommerceTaxonomy,
  type CommerceAttribute,
  type Money,
  type StockState,
  type StoreInfo,
  type ProductSearchInput,
  type ProductSearchResult,
  type AvailabilityInput,
  type AvailabilityResult,
  type AuthorizedOrderLookup,
  type CommerceOrder,
  type TrackingResult,
  type AuthorizedCustomerLookup,
  type CommerceOrderSummary,
  type OrderStatus,
  CommerceError,
} from '../../../../shared/commerce/types.js';
import type { ProductReviewsResult } from '../../../../shared/commerce/types.js';
import { commerceHttpRequest } from '../httpClient.js';
import { buildSignedHeaders } from '../signing.js';
import { sanitizeCommerceText, sanitizeUrl, boundedArray } from '../sanitize.js';

export interface WooCommerceTransport {
  origin: string;
  installationId: string;
  secret: string;
}

const MAX_PRODUCTS_PER_CALL = 20;
const MAX_VARIANTS_PER_PRODUCT = 50;
const PRODUCT_TYPES: ReadonlyArray<CommerceProduct['type']> = ['simple', 'variable', 'grouped', 'external'];

/**
 * A JSON object exactly as the plugin sent it. Nothing about its shape is
 * trusted: every field is narrowed where it is read.
 */
type Wire = Record<string, unknown>;

function wire(value: unknown): Wire {
  return value !== null && typeof value === 'object' ? (value as Wire) : {};
}

function wireList(value: unknown, max: number): unknown[] {
  return boundedArray(Array.isArray(value) ? (value as unknown[]) : null, max);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Accepts BOTH shapes the plugin actually sends.
 *
 * Product payloads carry canonical Money objects — `CommerceProduct.regularPrice`
 * is typed `Money | null` and the plugin's ProductReader emits
 * `{ amountMinor, currency }`. Order payloads carry bare scalars: OrderReader
 * emits `'total' => '8700000'`.
 *
 * Reading only the scalar form meant `String({...})` produced '[object Object]',
 * the numeric test rejected it, and every product price landed in the index as
 * NULL — so the assistant knew a product existed but could never quote its
 * price. The unit fixture used scalars for products too, which is why nothing
 * caught it.
 */
function toMoney(raw: unknown, currency: string): Money | null {
  if (raw === null || raw === undefined || raw === '') return null;

  if (typeof raw === 'object') {
    const amount = String(wire(raw).amountMinor ?? '').trim();
    if (!/^-?\d+(\.\d+)?$/.test(amount)) return null;
    const c = wire(raw).currency;
    return { amountMinor: amount, currency: typeof c === 'string' && c ? c : currency };
  }

  const amount = String(raw).trim();
  if (!/^-?\d+(\.\d+)?$/.test(amount)) return null;
  return { amountMinor: amount, currency };
}

function toStockState(raw: unknown): StockState {
  return raw === 'in_stock' || raw === 'out_of_stock' || raw === 'backorder' ? raw : 'unknown';
}

function normalizeTaxonomy(value: unknown): CommerceTaxonomy | null {
  if (!value || typeof value !== 'object') return null;
  const raw = wire(value);
  const name = sanitizeCommerceText(raw.name, 120);
  if (!name) return null;
  return { id: String(raw.id ?? ''), name, slug: typeof raw.slug === 'string' ? raw.slug.slice(0, 120) : null };
}

function normalizeAttribute(value: unknown): CommerceAttribute | null {
  if (!value || typeof value !== 'object') return null;
  const raw = wire(value);
  const name = sanitizeCommerceText(raw.name, 80);
  if (!name) return null;
  const values = wireList(raw.values, 30)
    .map((v: unknown) => sanitizeCommerceText(v, 80))
    .filter((v: string | null): v is string => !!v);
  return { name, values, usedForVariations: raw.usedForVariations === true };
}

function normalizeVariant(value: unknown, currency: string): CommerceVariant | null {
  if (!value || typeof value !== 'object') return null;
  const raw = wire(value);
  if (!raw.externalId) return null;
  const attrs: Record<string, string> = {};
  if (raw.attributes && typeof raw.attributes === 'object') {
    for (const [k, v] of Object.entries(raw.attributes).slice(0, 20)) {
      const key = sanitizeCommerceText(k, 60);
      const val = sanitizeCommerceText(v, 120);
      if (key && val) attrs[key] = val;
    }
  }
  return {
    externalId: String(raw.externalId),
    sku: typeof raw.sku === 'string' ? raw.sku.slice(0, 100) : null,
    attributes: attrs,
    regularPrice: toMoney(raw.regularPrice, currency),
    salePrice: toMoney(raw.salePrice, currency),
    effectivePrice: toMoney(raw.effectivePrice, currency),
    stockState: toStockState(raw.stockState),
    stockQuantity: typeof raw.stockQuantity === 'number' ? raw.stockQuantity : null,
    imageUrl: sanitizeUrl(raw.imageUrl),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString(),
  };
}

export function normalizeWooCommerceProduct(value: unknown): CommerceProduct | null {
  if (!value || typeof value !== 'object') return null;
  const raw = wire(value);
  if (!raw.externalId) return null;
  const currency = typeof raw.currency === 'string' ? raw.currency.slice(0, 10) : 'USD';
  const title = sanitizeCommerceText(raw.title, 200);
  if (!title) return null;

  return {
    externalId: String(raw.externalId),
    type: PRODUCT_TYPES.find((t) => t === raw.type) ?? 'simple',
    sku: typeof raw.sku === 'string' ? raw.sku.slice(0, 100) : null,
    title,
    shortDescription: sanitizeCommerceText(raw.shortDescription, 500),
    canonicalUrl: sanitizeUrl(raw.canonicalUrl),
    imageUrl: sanitizeUrl(raw.imageUrl),
    currency,
    regularPrice: toMoney(raw.regularPrice, currency),
    salePrice: toMoney(raw.salePrice, currency),
    effectivePrice: toMoney(raw.effectivePrice, currency),
    stockState: toStockState(raw.stockState),
    stockQuantity: typeof raw.stockQuantity === 'number' ? raw.stockQuantity : null,
    categories: wireList(raw.categories, 20).map(normalizeTaxonomy).filter((v): v is CommerceTaxonomy => !!v),
    tags: wireList(raw.tags, 20).map(normalizeTaxonomy).filter((v): v is CommerceTaxonomy => !!v),
    attributes: wireList(raw.attributes, 20).map(normalizeAttribute).filter((v): v is CommerceAttribute => !!v),
    variants: wireList(raw.variants, MAX_VARIANTS_PER_PRODUCT)
      .map((v) => normalizeVariant(v, currency))
      .filter((v): v is CommerceVariant => !!v),
    isVirtual: raw.isVirtual === true,
    isDownloadable: raw.isDownloadable === true,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString(),
  };
}

export class WooCommerceConnector implements CommerceConnector {
  readonly providerType = 'woocommerce';

  constructor(private readonly transport: WooCommerceTransport) {}

  private async call(ctx: CommerceConnectorContext, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Wire | null> {
    const bodyStr = body !== undefined ? JSON.stringify(body) : '';
    const url = `${this.transport.origin}${path}`;
    const headers = buildSignedHeaders(this.transport.secret, this.transport.installationId, method, path, bodyStr);
    headers['X-WebYar-Correlation'] = ctx.correlationId;

    const remaining = ctx.deadlineAt - Date.now();
    if (remaining <= 0) throw new CommerceError('commerce_timeout', 'commerce tool deadline exceeded');

    const res = await commerceHttpRequest({
      url,
      method,
      headers,
      body: bodyStr || undefined,
      retryable: method === 'GET',
    });

    if (res.status === 401 || res.status === 403) {
      throw new CommerceError('commerce_permission_denied', `plugin rejected request: ${res.status}`);
    }
    if (res.status === 404) throw new CommerceError('product_not_found', 'not found');
    if (res.status >= 500) throw new CommerceError('commerce_live_unavailable', `plugin error: ${res.status}`);
    if (res.status >= 400) throw new CommerceError('commerce_invalid_response', `plugin rejected request: ${res.status}`);

    return res.json !== null && typeof res.json === 'object' ? (res.json as Wire) : null;
  }

  async getStoreInfo(ctx: CommerceConnectorContext): Promise<StoreInfo> {
    const data = await this.call(ctx, 'GET', '/wp-json/webyar/v1/health');
    return {
      name: sanitizeCommerceText(data?.store_name, 200) ?? 'Store',
      currency: typeof data?.currency === 'string' ? data.currency : 'USD',
      url: sanitizeUrl(data?.store_url) ?? this.transport.origin,
      catalogReady: data?.catalog_ready === true,
      productCount: typeof data?.product_count === 'number' ? data.product_count : null,
    };
  }

  async searchProducts(ctx: CommerceConnectorContext, input: ProductSearchInput): Promise<ProductSearchResult> {
    const limit = Math.min(Math.max(input.filters.limit ?? 8, 1), MAX_PRODUCTS_PER_CALL);
    const data = await this.call(ctx, 'POST', '/wp-json/webyar/v1/products/search', {
      text: input.filters.text ?? null,
      min_price: input.filters.minPrice?.amountMinor ?? null,
      max_price: input.filters.maxPrice?.amountMinor ?? null,
      in_stock_only: input.filters.inStockOnly ?? false,
      category_slug: input.filters.categorySlug ?? null,
      attributes: input.filters.attributes ?? null,
      limit,
      cursor: input.filters.cursor ?? null,
    });

    return {
      catalogReady: data?.catalog_ready !== false,
      products: wireList(data?.products, limit)
        .map(normalizeWooCommerceProduct)
        .filter((p): p is CommerceProduct => !!p),
      nextCursor: typeof data?.next_cursor === 'string' ? data.next_cursor : null,
      totalMatched: typeof data?.total_matched === 'number' ? data.total_matched : null,
      liveRevalidated: false,
    };
  }

  async getProducts(ctx: CommerceConnectorContext, ids: string[]): Promise<CommerceProduct[]> {
    const bounded = ids.slice(0, MAX_PRODUCTS_PER_CALL);
    const data = await this.call(ctx, 'POST', '/wp-json/webyar/v1/products/resolve', { ids: bounded });
    return wireList(data?.products, bounded.length)
      .map(normalizeWooCommerceProduct)
      .filter((p): p is CommerceProduct => !!p);
  }

  async getAvailability(ctx: CommerceConnectorContext, input: AvailabilityInput): Promise<AvailabilityResult> {
    const data = await this.call(ctx, 'POST', '/wp-json/webyar/v1/products/availability', {
      product_id: input.productExternalId,
      variant_id: input.variantExternalId ?? null,
    });
    if (!data || data.found === false) throw new CommerceError('variation_not_available', 'variation not found');
    return {
      productExternalId: input.productExternalId,
      variantExternalId: input.variantExternalId ?? null,
      stockState: toStockState(data.stock_state),
      stockQuantity: typeof data.stock_quantity === 'number' ? data.stock_quantity : null,
      effectivePrice: toMoney(data.effective_price, str(data.currency) ?? 'USD'),
      asOf: new Date().toISOString(),
      source: 'live',
    };
  }

  async getProductReviews(
    ctx: CommerceConnectorContext,
    input: { productExternalId: string; limit?: number },
  ): Promise<ProductReviewsResult> {
    const data = await this.call(ctx, 'POST', '/wp-json/webyar/v1/products/reviews', {
      product_id: input.productExternalId,
      limit: input.limit ?? 5,
    });
    if (!data || data.found === false) throw new CommerceError('product_not_found', 'product not found');
    const average = Number(data.average_rating);
    return {
      productExternalId: String(data.product_id ?? input.productExternalId),
      // WooCommerce reports "0" for a product nobody has rated; that is an
      // absence, not a score of zero.
      averageRating: Number.isFinite(average) && average > 0 ? average : null,
      reviewCount: Number.isFinite(Number(data.review_count)) ? Number(data.review_count) : 0,
      reviews: Array.isArray(data.reviews)
        ? data.reviews.slice(0, 10).map((item: unknown) => {
            const r = wire(item);
            return {
              author: String(r.author ?? '').slice(0, 80),
              rating: Number.isFinite(Number(r.rating)) ? Number(r.rating) : null,
              verified: !!r.verified,
              date: String(r.date ?? ''),
              text: String(r.text ?? '').slice(0, 600),
            };
          })
        : [],
    };
  }

  async getOrder(ctx: CommerceConnectorContext, input: AuthorizedOrderLookup): Promise<CommerceOrder> {
    const data = await this.call(ctx, 'POST', '/wp-json/webyar/v1/orders/lookup', {
      order_id: input.externalOrderId,
      authorization: input,
    });
    if (!data || data.found === false) throw new CommerceError('order_not_found', 'order not found');
    const currency = typeof data.currency === 'string' ? data.currency : 'USD';
    return {
      externalId: input.externalOrderId,
      // The plugin maps WooCommerce statuses onto OrderStatus (OrderReader::map_status).
      status: (str(data.status) ?? 'unknown') as OrderStatus,
      currency,
      total: toMoney(data.total, currency) ?? { amountMinor: '0', currency },
      createdAt: str(data.created_at) ?? new Date(0).toISOString(),
      updatedAt: str(data.updated_at) ?? new Date(0).toISOString(),
      lineItems: wireList(data.line_items, 30).map((item) => {
        const li = wire(item);
        return {
          productExternalId: li.product_id ? String(li.product_id) : null,
          title: sanitizeCommerceText(li.title, 200) ?? 'Item',
          quantity: typeof li.quantity === 'number' ? li.quantity : 1,
          total: toMoney(li.total, currency) ?? { amountMinor: '0', currency },
        };
      }),
      maskedContact: {
        email: typeof data.masked_email === 'string' ? data.masked_email : null,
        phone: typeof data.masked_phone === 'string' ? data.masked_phone : null,
      },
    };
  }

  async getTracking(ctx: CommerceConnectorContext, input: AuthorizedOrderLookup): Promise<TrackingResult> {
    const data = await this.call(ctx, 'POST', '/wp-json/webyar/v1/orders/tracking', {
      order_id: input.externalOrderId,
      authorization: input,
    });
    if (!data || data.found === false) throw new CommerceError('order_not_found', 'order not found');
    // TrackingResolver (and the `webyar_commerce_tracking_payload` filter it
    // documents for shipping plugins) emits camelCase keys; snake_case is
    // still read for plugin builds that sent it.
    const trackingNumber = data.trackingNumber ?? data.tracking_number;
    const updatedAt = data.updatedAt ?? data.updated_at;
    return {
      externalOrderId: input.externalOrderId,
      carrier: sanitizeCommerceText(data.carrier, 80),
      trackingNumber: typeof trackingNumber === 'string' || typeof trackingNumber === 'number' ? String(trackingNumber).slice(0, 80) : null,
      trackingUrl: sanitizeUrl(data.trackingUrl ?? data.tracking_url),
      status: sanitizeCommerceText(data.status, 80),
      updatedAt: typeof updatedAt === 'string' ? updatedAt : null,
    };
  }

  async getCustomerOrders(ctx: CommerceConnectorContext, input: AuthorizedCustomerLookup): Promise<CommerceOrderSummary[]> {
    const limit = Math.min(Math.max(input.limit ?? 5, 1), 10);
    const data = await this.call(ctx, 'POST', '/wp-json/webyar/v1/orders/lookup', {
      customer_id: input.externalCustomerId,
      authorization: input,
      limit,
    });
    return wireList(data?.orders, limit).map((item) => {
      const o = wire(item);
      const currency = typeof o.currency === 'string' ? o.currency : 'USD';
      return {
        externalId: String(o.external_id ?? o.id ?? ''),
        status: (str(o.status) ?? 'unknown') as OrderStatus,
        total: toMoney(o.total, currency) ?? { amountMinor: '0', currency },
        createdAt: str(o.created_at) ?? new Date(0).toISOString(),
      };
    });
  }

  /**
   * Protocol-level capability handshake (docs/commerce/CONNECTOR_PROTOCOL.md
   * §Capability handshake). Not part of the generic CommerceConnector
   * contract — a future OAuth-based connector (Shopify) negotiates scopes
   * differently at pairing time and would not need this method at all.
   */
  async negotiateCapabilities(ctx: CommerceConnectorContext): Promise<{
    protocolVersion: string;
    connectorVersion: string | null;
    woocommerceVersion: string | null;
    wordpressVersion: string | null;
    hposEnabled: boolean | null;
    capabilities: string[];
    catalogReady: boolean;
  }> {
    const data = await this.call(ctx, 'GET', '/wp-json/webyar/v1/health');
    return {
      protocolVersion: typeof data?.protocol_version === 'string' ? data.protocol_version : 'unknown',
      connectorVersion: typeof data?.connector_version === 'string' ? data.connector_version : null,
      woocommerceVersion: typeof data?.woocommerce_version === 'string' ? data.woocommerce_version : null,
      wordpressVersion: typeof data?.wordpress_version === 'string' ? data.wordpress_version : null,
      hposEnabled: typeof data?.hpos_enabled === 'boolean' ? data.hpos_enabled : null,
      capabilities: wireList(data?.capabilities, 20).filter((c): c is string => typeof c === 'string'),
      catalogReady: data?.catalog_ready === true,
    };
  }

  async verifyOrderContactMatch(
    ctx: CommerceConnectorContext,
    input: { externalOrderId: string; email?: string; phone?: string },
  ): Promise<{ matched: boolean }> {
    const data = await this.call(ctx, 'POST', '/wp-json/webyar/v1/orders/verify-contact', {
      order_id: input.externalOrderId,
      email: input.email ?? null,
      phone: input.phone ?? null,
    });
    return { matched: data?.matched === true };
  }
}
