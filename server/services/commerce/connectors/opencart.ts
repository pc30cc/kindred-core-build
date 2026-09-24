/**
 * OpenCart connector adapter — a DIRECT (index-less) connector.
 *
 * Talks to the `webyar-opencart` extension's single signed catalog route
 * (`index.php?route=…webyar…api&op=<op>`; canonical signed path
 * `/opencart/v1/<op>`, see docs/commerce/OPENCART.md §Protocol). Nothing it
 * reads is stored: products, prices, stock, orders and reviews are fetched
 * per question, normalized here, and handed to the AI stage.
 *
 * Every string off the wire is merchant content and is sanitized; every URL
 * must be on the connected store's own origin or it is dropped; money arrives
 * already converted, rounded and formatted by the store's own currency code
 * and is passed through, never recomputed.
 *
 * Transport rules: re-signed per attempt (fresh nonce — the store refuses a
 * replayed one), SSRF-guarded (commerceHttpRequest), no redirects, the time
 * left in the turn as the timeout, at most ONE retry and only for transient
 * transport/5xx failures of these read-only operations.
 */
import {
  CommerceError,
  type AuthorizedCustomerLookup,
  type AuthorizedOrderLookup,
  type AvailabilityInput,
  type AvailabilityResult,
  type CommerceConnectorContext,
  type CommerceErrorCode,
  type CommerceOrder,
  type CommerceOrderSummary,
  type CommerceProduct,
  type CustomerRef,
  type DirectCommerceConnector,
  type DirectOrderDetail,
  type DirectOrderStatus,
  type DirectOrderSummary,
  type DirectProductDetail,
  type DirectProductSummary,
  type DirectReadOptions,
  type DirectReturn,
  type DirectReviewsResult,
  type DirectSearchFilters,
  type DirectSearchResult,
  type DirectTrackingResult,
  type DisplayMoney,
  type Page,
  type ProductReviewsResult,
  type ProductSearchInput,
  type ProductSearchResult,
  type StockState,
  type StoreContext,
  type StoreInfo,
  type TrackingResult,
} from '../../../../shared/commerce/types.js';
import { commerceHttpRequest } from '../httpClient.js';
import { buildSignedHeaders } from '../signing.js';
import { sanitizeCommerceText, boundedArray } from '../sanitize.js';

export interface OpenCartTransport {
  /** Approved origin (scheme+host+port) captured at pairing. */
  origin: string;
  /** The store's base URL (may include a path), e.g. https://shop.example/ */
  storeUrl: string;
  /** OpenCart store_id within the installation. */
  externalStoreId: string;
  installationId: string;
  secret: string;
  /** OpenCart version from the handshake; selects the 3.0 vs 4.1 route. */
  platformVersion: string | null;
}

export const OPENCART_MAX_PAGE_SIZE = 10;
export const OPENCART_MAX_IDS = 10;
/** Responses are small by construction; anything bigger is refused. */
export const OPENCART_MAX_RESPONSE_BYTES = 128 * 1024;
const MIN_RETRY_BUDGET_MS = 1_500;

/**
 * The extension version this Web Yar release ships (public/downloads/opencart,
 * signed manifest). A store answering with an older `_meta.connector_version`
 * is asked — at most once per UPDATE_NUDGE_INTERVAL_MS — to update itself.
 * Kept equal to core/Protocol.php CONNECTOR_VERSION by a test.
 */
export const OPENCART_LATEST_CONNECTOR_VERSION = '1.1.1';
export const UPDATE_NUDGE_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Downloading and swapping a ~100 KB package takes a store a few seconds. */
const UPDATE_DEADLINE_MS = 45_000;
const lastUpdateNudge = new Map<string, number>();

/** True when `reported` is a well-formed version older than `latest`. */
export function isOlderConnector(reported: string | null | undefined, latest = OPENCART_LATEST_CONNECTOR_VERSION): boolean {
  const parse = (v: string) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null);
  const a = parse(String(reported ?? ''));
  const b = parse(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/** Once per installation per interval; the store's own lock covers overlap. */
export function claimUpdateNudge(installationId: string, now = Date.now()): boolean {
  const last = lastUpdateNudge.get(installationId) ?? 0;
  if (now - last < UPDATE_NUDGE_INTERVAL_MS) return false;
  lastUpdateNudge.set(installationId, now);
  if (lastUpdateNudge.size > 5_000) lastUpdateNudge.delete(lastUpdateNudge.keys().next().value as string);
  return true;
}

export function openCartApiRoute(platformVersion: string | null): string {
  return /^3\./.test(String(platformVersion ?? '')) ? 'extension/module/webyar/api' : 'extension/webyar/module/webyar.api';
}

/** Store error code → the platform's safe taxonomy. */
export function mapOpenCartError(status: number, code: unknown): CommerceErrorCode {
  const c = typeof code === 'string' ? code : '';
  if (c === 'identity_required') return 'identity_required';
  if (c.startsWith('identity_') || c === 'customer_out_of_store_scope') return 'identity_expired';
  if (c === 'account_disabled') return 'order_access_denied';
  if (c === 'order_not_found') return 'order_not_found';
  if (c === 'product_not_found') return 'product_not_found';
  if (c === 'unknown_operation') return 'connector_outdated';
  if (c === 'protocol_mismatch') return 'protocol_mismatch';
  if (c === 'not_connected' || c === 'store_mismatch' || c === 'extension_disabled' || c === 'extension_not_installed') return 'commerce_not_connected';
  if (status === 401 || status === 403 || status === 409) return 'commerce_permission_denied';
  if (status === 404) return 'commerce_invalid_response';
  if (status >= 500) return 'commerce_live_unavailable';
  return 'commerce_invalid_response';
}

const STOCK: ReadonlyArray<StockState> = ['in_stock', 'out_of_stock', 'backorder', 'unknown'];

/** A JSON object off the wire: every field is unknown until checked. */
type Wire = Record<string, unknown>;

function obj(v: unknown): Wire {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Wire) : {};
}

function list(v: unknown, max: number): Wire[] {
  return boundedArray(Array.isArray(v) ? v : [], max).map(obj);
}

function str(v: unknown, max = 200): string {
  return typeof v === 'string' || typeof v === 'number' ? String(v).slice(0, max) : '';
}

function strOrNull(v: unknown, max = 200): string | null {
  return typeof v === 'string' ? v.slice(0, max) : null;
}

export class OpenCartConnector implements DirectCommerceConnector {
  readonly providerType = 'opencart';
  readonly searchStrategy = 'direct' as const;
  private readonly storeHost: string;

  constructor(private readonly transport: OpenCartTransport) {
    const base = new URL(transport.storeUrl);
    if (base.origin !== new URL(transport.origin).origin) {
      // The approved origin is the only host Web Yar ever calls.
      throw new CommerceError('commerce_not_connected', 'store url is not on the approved origin');
    }
    this.storeHost = base.host.toLowerCase();
  }

  // ── transport ─────────────────────────────────────────────────────────

  private async call(ctx: CommerceConnectorContext, op: string, body: Record<string, unknown>, opts: DirectReadOptions = {}): Promise<Wire> {
    const payload = JSON.stringify({
      ...body,
      store_id: this.transport.externalStoreId,
      ...(opts.language ? { language: opts.language } : {}),
      ...(opts.customer ? { customer: { id: opts.customer.externalCustomerId, session_ref: opts.customer.sessionRef } } : {}),
    });
    const signedPath = `/opencart/v1/${op}`;
    const base = this.transport.storeUrl.endsWith('/') ? this.transport.storeUrl : `${this.transport.storeUrl}/`;
    const url = `${base}index.php?route=${openCartApiRoute(this.transport.platformVersion)}&op=${encodeURIComponent(op)}&store_id=${encodeURIComponent(this.transport.externalStoreId)}`;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remaining = ctx.deadlineAt - Date.now();
      if (remaining <= 0) throw new CommerceError('commerce_timeout', 'commerce deadline exceeded');

      // A fresh nonce every attempt: the store keeps each accepted one.
      const headers = buildSignedHeaders(this.transport.secret, this.transport.installationId, 'POST', signedPath, payload);
      headers['X-WebYar-Correlation'] = ctx.correlationId;

      let res;
      try {
        res = await commerceHttpRequest({ url, method: 'POST', headers, body: payload, retryable: false, timeoutMs: remaining, maxResponseBytes: OPENCART_MAX_RESPONSE_BYTES });
      } catch (err) {
        const transient = err instanceof CommerceError && err.code === 'commerce_live_unavailable';
        if (attempt === 0 && transient && ctx.deadlineAt - Date.now() >= MIN_RETRY_BUDGET_MS) continue;
        throw err;
      }

      const json = obj(res.json);
      const meta = obj(json._meta);
      const db = obj(meta.db);
      opts.onMeta?.({
        storeQueries: typeof db.queries === 'number' ? db.queries : null,
        storeMs: typeof meta.ms === 'number' ? meta.ms : null,
        responseBytes: res.bytes ?? 0,
      });

      if (res.status === 200) {
        if (op !== 'connector/update') this.maybeNudgeUpdate(ctx, meta.connector_version);
        return json;
      }

      const code = mapOpenCartError(res.status, json.error);
      // Only a server-side failure of a read is worth one more try — never
      // authentication, permission, validation or not-found.
      if (attempt === 0 && res.status >= 500 && res.status !== 503 && ctx.deadlineAt - Date.now() >= MIN_RETRY_BUDGET_MS) continue;
      throw new CommerceError(code, `store answered ${res.status}${json.error ? ` ${str(json.error, 40)}` : ''}`);
    }
    throw new CommerceError('commerce_live_unavailable', 'store unavailable');
  }

  /**
   * Asks the store to install the newest signed release of the extension
   * (`connector/update`). The store verifies the release signature and the
   * package checksum itself and refuses when its owner turned automatic
   * updates off; Web Yar only says "there is one".
   */
  async requestSelfUpdate(ctx: CommerceConnectorContext): Promise<{ status: string; from: string | null; to: string | null }> {
    const data = await this.call({ ...ctx, deadlineAt: Math.max(ctx.deadlineAt, Date.now() + UPDATE_DEADLINE_MS) }, 'connector/update', {});
    return { status: str(data.status, 20) || 'unknown', from: strOrNull(data.from, 20), to: strOrNull(data.to, 20) };
  }

  /** Fire-and-forget: never delays or fails the read that noticed it. */
  private maybeNudgeUpdate(ctx: CommerceConnectorContext, reported: unknown): void {
    if (!(ctx.capabilities as string[]).includes('connector.update')) return;
    if (!isOlderConnector(typeof reported === 'string' ? reported : null)) return;
    if (!claimUpdateNudge(this.transport.installationId)) return;
    const correlationId = `update-${ctx.connectionId}`;
    this.requestSelfUpdate({ ...ctx, correlationId, deadlineAt: Date.now() + UPDATE_DEADLINE_MS }).catch(() => undefined);
  }

  // ── normalization ─────────────────────────────────────────────────────

  /** A link is kept only when it points at the connected store itself. */
  private storeUrl(raw: unknown): string | null {
    if (typeof raw !== 'string' || !raw) return null;
    try {
      const u = new URL(raw);
      if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.host.toLowerCase() !== this.storeHost) return null;
      return u.toString();
    } catch {
      return null;
    }
  }

  private money(raw: unknown): DisplayMoney | null {
    const m = obj(raw);
    const amount = str(m.amount, 40);
    if (!/^-?\d+(\.\d+)?$/.test(amount)) return null;
    const formatted = sanitizeCommerceText(m.formatted, 60);
    return {
      amount,
      currency: str(m.currency, 10),
      formatted: formatted ?? amount,
      ...(typeof m.tax_included === 'boolean' ? { taxIncluded: m.tax_included } : {}),
    };
  }

  private context(raw: unknown): StoreContext | null {
    if (!raw || typeof raw !== 'object') return null;
    const c = obj(raw);
    return {
      storeId: str(c.store_id, 20),
      language: str(c.language, 16),
      currency: str(c.currency, 10),
      customerGroupId: str(c.customer_group_id, 20),
      customer: c.customer === true,
      pricesVisible: c.prices_visible === true,
      taxIncluded: c.tax_included === true,
      taxRegion: str(c.tax_region, 40) || 'store',
    };
  }

  private summary(raw: unknown): DirectProductSummary | null {
    const p = obj(raw);
    const name = sanitizeCommerceText(p.name, 200);
    if (!p.id || !name) return null;
    const stock = obj(p.stock);
    const state = STOCK.find((s) => s === stock.state) ?? 'unknown';
    const stockText = sanitizeCommerceText(stock.text, 60);
    return {
      externalId: str(p.id, 20),
      name,
      model: sanitizeCommerceText(p.model, 64),
      manufacturer: sanitizeCommerceText(p.manufacturer, 80),
      url: this.storeUrl(p.url),
      imageUrl: this.storeUrl(p.image),
      price: this.money(p.price),
      special: this.money(p.special),
      priceHidden: p.price_hidden === 'login_required' ? 'login_required' : null,
      stock: {
        state,
        ...(typeof stock.quantity === 'number' ? { quantity: stock.quantity } : {}),
        ...(stockText ? { text: stockText } : {}),
      },
      rating: typeof p.rating === 'number' ? p.rating : null,
      reviewCount: Number.isFinite(Number(p.review_count)) ? Number(p.review_count) : 0,
      hasOptions: p.has_options === true,
    };
  }

  private detail(raw: unknown): DirectProductDetail | null {
    const base = this.summary(raw);
    if (!base) return null;
    const p = obj(raw);
    return {
      ...base,
      description: sanitizeCommerceText(p.description, 700),
      minimum: Math.max(1, Number(p.minimum) || 1),
      options: list(p.options, 20).map((o) => ({
        id: str(o.id, 20),
        name: sanitizeCommerceText(o.name, 80) ?? '',
        type: str(o.type, 20),
        required: o.required === true,
        values: list(o.values, 40).map((v) => ({
          id: str(v.id, 20),
          name: sanitizeCommerceText(v.name, 80) ?? '',
          priceDelta: sanitizeCommerceText(v.price_delta, 40),
        })).filter((v) => v.name),
      })).filter((o) => o.name),
      attributes: list(p.attributes, 20).map((a) => ({ name: sanitizeCommerceText(a.name, 80) ?? '', value: sanitizeCommerceText(a.value, 160) ?? '' })).filter((a) => a.name),
      specialEnds: strOrNull(p.special_ends, 20),
      quantityDiscounts: list(p.quantity_discounts, 5)
        .map((d) => ({ minQuantity: Number(d.min_quantity) || 0, unitPrice: this.money(d.unit_price) }))
        .filter((d): d is { minQuantity: number; unitPrice: DisplayMoney } => d.minQuantity > 1 && !!d.unitPrice),
    };
  }

  private status(raw: unknown): DirectOrderStatus {
    const s = obj(raw);
    const category = s.category === 'processing' || s.category === 'complete' ? s.category : 'other';
    return { name: sanitizeCommerceText(s.name, 60), category };
  }

  private orderSummary(raw: unknown): DirectOrderSummary | null {
    const o = obj(raw);
    const total = this.money(o.total);
    if (!o.id || !total) return null;
    return {
      externalId: str(o.id, 20),
      createdAt: strOrNull(o.date_added, 40),
      updatedAt: strOrNull(o.updated_at, 40),
      status: this.status(o.status),
      total,
      itemCount: Number(o.item_count) || 0,
    };
  }

  // ── direct read surface ───────────────────────────────────────────────

  async searchDirect(ctx: CommerceConnectorContext, f: DirectSearchFilters, opts: DirectReadOptions): Promise<DirectSearchResult> {
    const pageSize = Math.min(Math.max(f.pageSize ?? 5, 1), OPENCART_MAX_PAGE_SIZE);
    const data = await this.call(ctx, 'products/search', {
      terms: boundedArray(f.terms, 6),
      ...(f.category ? { category: f.category } : {}),
      ...(f.categoryId ? { category_id: f.categoryId } : {}),
      ...(f.manufacturer ? { manufacturer: f.manufacturer } : {}),
      ...(f.minPrice ? { min_price: f.minPrice } : {}),
      ...(f.maxPrice ? { max_price: f.maxPrice } : {}),
      ...(f.inStockOnly ? { in_stock_only: true } : {}),
      ...(f.sort && f.sort !== 'relevance' ? { sort: f.sort } : {}),
      ...(f.countTotal ? { count_total: true } : {}),
      page: Math.max(1, Math.min(f.page ?? 1, 100)),
      page_size: pageSize,
    }, opts);
    return {
      products: list(data.products, pageSize).map((p) => this.summary(p)).filter((p): p is DirectProductSummary => !!p),
      page: Number(data.page) || 1,
      pageSize,
      hasMore: data.has_more === true,
      total: typeof data.total === 'number' ? data.total : null,
      appliedFilters: obj(data.applied_filters),
      unsupportedFilters: boundedArray(Array.isArray(data.unsupported_filters) ? data.unsupported_filters : [], 10).map((u) => str(u, 60)),
      context: this.context(data.context),
    };
  }

  async getProductDetails(ctx: CommerceConnectorContext, ids: string[], opts: DirectReadOptions) {
    const bounded = [...new Set(ids.map((id) => String(id)).filter((id) => /^\d{1,11}$/.test(id)))].slice(0, OPENCART_MAX_IDS);
    if (!bounded.length) return { products: [], notFound: [], context: null };
    const data = await this.call(ctx, 'products/get', { ids: bounded.map(Number) }, opts);
    return {
      products: list(data.products, bounded.length).map((p) => this.detail(p)).filter((p): p is DirectProductDetail => !!p),
      notFound: boundedArray(Array.isArray(data.not_found) ? data.not_found : [], bounded.length).map((id) => str(id, 20)),
      context: this.context(data.context),
    };
  }

  async getReviewsDirect(ctx: CommerceConnectorContext, productExternalId: string, page: number, opts: DirectReadOptions): Promise<DirectReviewsResult> {
    const data = await this.call(ctx, 'products/reviews', { product_id: Number(productExternalId) || 0, page: Math.max(1, page), page_size: 5 }, opts);
    return {
      productExternalId: str(data.product_id, 20) || productExternalId,
      productName: sanitizeCommerceText(data.product_name, 200) ?? '',
      averageRating: typeof data.average_rating === 'number' && data.average_rating > 0 ? data.average_rating : null,
      reviewCount: Number(data.review_count) || 0,
      page: Number(data.page) || 1,
      hasMore: data.has_more === true,
      reviews: list(data.reviews, 5).map((r) => ({
        author: sanitizeCommerceText(r.author, 60) ?? '',
        rating: Number.isFinite(Number(r.rating)) ? Number(r.rating) : null,
        verified: false,
        date: str(r.date, 10),
        text: sanitizeCommerceText(r.text, 500) ?? '',
      })),
    };
  }

  async listCategories(ctx: CommerceConnectorContext, opts: DirectReadOptions) {
    const data = await this.call(ctx, 'catalog/categories', {}, opts);
    return list(data.categories, 30)
      .map((c) => ({ id: str(c.id, 20), name: sanitizeCommerceText(c.name, 120) ?? '', url: this.storeUrl(c.url) }))
      .filter((c) => c.name);
  }

  private requireCustomer(customer: CustomerRef | null | undefined): CustomerRef {
    if (!customer?.externalCustomerId || !customer.sessionRef) throw new CommerceError('identity_required', 'no signed-in customer');
    return customer;
  }

  async listOrders(ctx: CommerceConnectorContext, customer: CustomerRef, page: number, opts: DirectReadOptions): Promise<Page<DirectOrderSummary>> {
    const data = await this.call(ctx, 'orders/list', { page: Math.max(1, page), page_size: 5 }, { ...opts, customer: this.requireCustomer(customer) });
    return {
      items: list(data.orders, OPENCART_MAX_PAGE_SIZE).map((o) => this.orderSummary(o)).filter((o): o is DirectOrderSummary => !!o),
      page: Number(data.page) || 1,
      hasMore: data.has_more === true,
      context: this.context(data.context),
    };
  }

  async getOrderDetail(ctx: CommerceConnectorContext, customer: CustomerRef, externalOrderId: string, opts: DirectReadOptions): Promise<DirectOrderDetail> {
    if (!/^\d{1,11}$/.test(externalOrderId)) throw new CommerceError('order_not_found', 'invalid order id');
    const data = await this.call(ctx, 'orders/get', { order_id: Number(externalOrderId) }, { ...opts, customer: this.requireCustomer(customer) });
    const o = obj(data.order);
    const summary = this.orderSummary(o);
    if (!summary) throw new CommerceError('commerce_invalid_response', 'malformed order');
    const fallback: DisplayMoney = { amount: '0', currency: summary.total.currency, formatted: '' };
    return {
      ...summary,
      currency: str(o.currency, 10) || summary.total.currency,
      items: list(o.items, 50).map((i) => ({
        productExternalId: i.product_id ? str(i.product_id, 20) : null,
        name: sanitizeCommerceText(i.name, 160) ?? '',
        model: sanitizeCommerceText(i.model, 64),
        quantity: Number(i.quantity) || 0,
        options: boundedArray(Array.isArray(i.options) ? i.options : [], 8).map((x) => sanitizeCommerceText(x, 140) ?? '').filter(Boolean),
        total: this.money(i.total) ?? fallback,
      })),
      itemsTruncated: o.items_truncated === true,
      totals: list(o.totals, 12)
        .map((t) => ({ code: str(t.code, 30), title: sanitizeCommerceText(t.title, 80) ?? '', amount: this.money(t.amount) }))
        .filter((t): t is { code: string; title: string; amount: DisplayMoney } => !!t.amount),
      shippingMethod: sanitizeCommerceText(o.shipping_method, 120),
      paymentMethod: sanitizeCommerceText(o.payment_method, 120),
      paymentStatus: 'not_reported_by_store',
      history: list(o.history, 20).map((h) => ({ date: strOrNull(h.date, 40), status: this.status(h.status), comment: sanitizeCommerceText(h.comment, 300) })),
      viewUrl: this.storeUrl(o.view_url),
    };
  }

  async getTrackingDirect(ctx: CommerceConnectorContext, customer: CustomerRef, externalOrderId: string, opts: DirectReadOptions): Promise<DirectTrackingResult> {
    if (!/^\d{1,11}$/.test(externalOrderId)) throw new CommerceError('order_not_found', 'invalid order id');
    const data = await this.call(ctx, 'orders/tracking', { order_id: Number(externalOrderId) }, { ...opts, customer: this.requireCustomer(customer) });
    const shipments = list(data.shipments, 5).map((s) => ({
      carrier: sanitizeCommerceText(s.carrier, 80),
      trackingNumber: sanitizeCommerceText(s.tracking_number, 80),
      // A carrier's tracking page is legitimately off-store; only its scheme is checked.
      trackingUrl: typeof s.tracking_url === 'string' && /^https?:\/\//i.test(s.tracking_url) ? s.tracking_url.slice(0, 300) : null,
      status: sanitizeCommerceText(s.status, 80),
      updatedAt: strOrNull(s.updated_at, 30),
      source: sanitizeCommerceText(s.source, 40) ?? 'extension',
    }));
    return {
      externalOrderId: str(data.order_id, 20) || externalOrderId,
      available: data.available === true && shipments.length > 0,
      reason: strOrNull(data.reason, 40),
      shipments,
      status: this.status(data.status),
    };
  }

  async listReturns(ctx: CommerceConnectorContext, customer: CustomerRef, page: number, opts: DirectReadOptions): Promise<Page<DirectReturn>> {
    const data = await this.call(ctx, 'orders/returns', { page: Math.max(1, page), page_size: 5 }, { ...opts, customer: this.requireCustomer(customer) });
    return {
      items: list(data.returns, OPENCART_MAX_PAGE_SIZE).map((r) => ({
        externalId: str(r.id, 20),
        orderExternalId: str(r.order_id, 20),
        product: sanitizeCommerceText(r.product, 160) ?? '',
        quantity: Number(r.quantity) || 0,
        status: sanitizeCommerceText(r.status, 60),
        createdAt: strOrNull(r.date_added, 40),
      })),
      page: Number(data.page) || 1,
      hasMore: data.has_more === true,
      context: this.context(data.context),
    };
  }

  /** Capability handshake (the extension's `health`). */
  async negotiateCapabilities(ctx: CommerceConnectorContext) {
    const data = await this.call(ctx, 'health', {});
    const store = obj(data.store);
    return {
      protocolVersion: str(data.protocol_version, 40) || 'unknown',
      connectorVersion: strOrNull(data.connector_version, 20),
      platformVersion: strOrNull(data.platform_version, 20),
      capabilities: boundedArray(Array.isArray(data.capabilities) ? data.capabilities : [], 20).filter((c): c is string => typeof c === 'string'),
      storeUrl: strOrNull(store.url, 500),
      storeId: store.id !== undefined ? str(store.id, 20) : null,
      storeName: sanitizeCommerceText(store.name, 120),
      defaultCurrency: strOrNull(store.default_currency, 10),
      policy: obj(data.store_policy),
    };
  }

  // ── canonical CommerceConnector contract ──────────────────────────────
  // The AI stage uses the direct surface above. These keep the generic
  // contract honest for callers that are not order-aware of session refs.

  async getStoreInfo(ctx: CommerceConnectorContext): Promise<StoreInfo> {
    const h = await this.negotiateCapabilities(ctx);
    return { name: h.storeName ?? 'Store', currency: h.defaultCurrency ?? '', url: this.transport.storeUrl, catalogReady: true, productCount: null };
  }

  async searchProducts(ctx: CommerceConnectorContext, input: ProductSearchInput): Promise<ProductSearchResult> {
    const result = await this.searchDirect(ctx, { terms: input.filters.text ? input.filters.text.split(/\s+/).slice(0, 6) : [], pageSize: input.filters.limit ?? 5 }, {});
    return { catalogReady: true, products: result.products.map((p) => this.toCanonical(p)), nextCursor: null, totalMatched: result.total, liveRevalidated: true };
  }

  async getProducts(ctx: CommerceConnectorContext, ids: string[]): Promise<CommerceProduct[]> {
    const result = await this.getProductDetails(ctx, ids, {});
    return result.products.map((p) => this.toCanonical(p));
  }

  async getAvailability(ctx: CommerceConnectorContext, input: AvailabilityInput): Promise<AvailabilityResult> {
    const result = await this.getProductDetails(ctx, [input.productExternalId], {});
    const p = result.products[0];
    if (!p) throw new CommerceError('product_not_found', 'product not found');
    return { productExternalId: p.externalId, variantExternalId: null, stockState: p.stock.state, stockQuantity: p.stock.quantity ?? null, effectivePrice: null, asOf: new Date().toISOString(), source: 'live' };
  }

  async getProductReviews(ctx: CommerceConnectorContext, input: { productExternalId: string }): Promise<ProductReviewsResult> {
    return this.getReviewsDirect(ctx, input.productExternalId, 1, {});
  }

  // Orders need the session reference the store re-validates; the generic
  // lookups do not carry one, so they are refused rather than weakened.
  async getOrder(_ctx: CommerceConnectorContext, _input: AuthorizedOrderLookup): Promise<CommerceOrder> {
    throw new CommerceError('identity_required', 'opencart orders require a live customer session reference');
  }

  async getTracking(_ctx: CommerceConnectorContext, _input: AuthorizedOrderLookup): Promise<TrackingResult> {
    throw new CommerceError('identity_required', 'opencart tracking requires a live customer session reference');
  }

  async getCustomerOrders(_ctx: CommerceConnectorContext, _input: AuthorizedCustomerLookup): Promise<CommerceOrderSummary[]> {
    throw new CommerceError('identity_required', 'opencart orders require a live customer session reference');
  }

  /** Guests sign in to the store; OpenCart has no contact-match OTP path. */
  async verifyOrderContactMatch(): Promise<{ matched: boolean }> {
    throw new CommerceError('commerce_permission_denied', 'guest order lookup is sign-in only for opencart');
  }

  private toCanonical(p: DirectProductSummary): CommerceProduct {
    const currency = p.price?.currency ?? '';
    return {
      externalId: p.externalId, type: 'simple', sku: null, title: p.name, shortDescription: null,
      canonicalUrl: p.url, imageUrl: p.imageUrl, currency,
      regularPrice: null, salePrice: null, effectivePrice: null,
      stockState: p.stock.state, stockQuantity: p.stock.quantity ?? null,
      categories: [], tags: [], attributes: [], variants: [], isVirtual: false, isDownloadable: false,
      updatedAt: new Date(0).toISOString(),
    };
  }
}
