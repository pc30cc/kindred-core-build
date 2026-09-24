/**
 * Canonical Commerce Integration Platform contracts.
 *
 * PURE TYPES ONLY (mirrors shared/ai/types.ts's rule) — this file is safe to
 * import from server/**, worker/**, and src/** alike. WooCommerce-specific
 * (or any provider-specific) shapes MUST NOT appear here or leak past a
 * connector adapter — see docs/commerce/ARCHITECTURE.md.
 */

// ── Money ───────────────────────────────────────────────────────────────

/**
 * No floating-point money anywhere in the pipeline. `amountMinor` is a
 * string-encoded integer in the currency's minor unit as reported by the
 * store; currencies without a minor unit (e.g. most IRR configurations)
 * are passed through as-is — Web Yar never invents a conversion.
 */
export interface Money {
  amountMinor: string;
  currency: string;
}

/**
 * A price exactly as a store that formats its own money DISPLAYS it — the
 * direct-read connectors (OpenCart) return the amount already converted,
 * rounded and formatted by the store's own currency code, so Web Yar never
 * converts or rounds a price itself. `amount` is a plain decimal string in
 * `currency`; `formatted` is what the shop's product page shows.
 */
export interface DisplayMoney {
  amount: string;
  currency: string;
  formatted: string;
  taxIncluded?: boolean;
}

// ── Product ─────────────────────────────────────────────────────────────

export type StockState = 'in_stock' | 'out_of_stock' | 'backorder' | 'unknown';

export interface CommerceTaxonomy {
  id: string;
  name: string;
  slug: string | null;
}

export interface CommerceAttribute {
  name: string;
  values: string[];
  /** True when this attribute is used to distinguish variants (e.g. size/color). */
  usedForVariations: boolean;
}

export interface CommerceVariant {
  externalId: string;
  sku: string | null;
  attributes: Record<string, string>;
  regularPrice: Money | null;
  salePrice: Money | null;
  effectivePrice: Money | null;
  stockState: StockState;
  stockQuantity: number | null;
  imageUrl: string | null;
  updatedAt: string;
}

export type CommerceProductType = 'simple' | 'variable' | 'grouped' | 'external';

export interface CommerceProduct {
  externalId: string;
  type: CommerceProductType;

  sku: string | null;
  title: string;
  shortDescription: string | null;

  canonicalUrl: string | null;
  imageUrl: string | null;

  currency: string;

  regularPrice: Money | null;
  salePrice: Money | null;
  effectivePrice: Money | null;

  stockState: StockState;
  stockQuantity: number | null;

  categories: CommerceTaxonomy[];
  tags: CommerceTaxonomy[];
  attributes: CommerceAttribute[];
  variants: CommerceVariant[];

  isVirtual: boolean;
  isDownloadable: boolean;

  updatedAt: string;
}

// ── Search ──────────────────────────────────────────────────────────────

export interface ProductSearchFilters {
  /** Free-text lexical/semantic query. */
  text?: string;
  minPrice?: Money;
  maxPrice?: Money;
  inStockOnly?: boolean;
  categorySlug?: string;
  attributes?: Record<string, string>;
  limit?: number;
  cursor?: string | null;
}

export interface ProductSearchInput {
  filters: ProductSearchFilters;
}

export interface ProductSearchResult {
  catalogReady: boolean;
  products: CommerceProduct[];
  nextCursor: string | null;
  totalMatched: number | null;
  /** True when results came from the live store rather than the cached index. */
  liveRevalidated: boolean;
}

export interface AvailabilityInput {
  productExternalId: string;
  variantExternalId?: string | null;
}

export interface AvailabilityResult {
  productExternalId: string;
  variantExternalId: string | null;
  stockState: StockState;
  stockQuantity: number | null;
  effectivePrice: Money | null;
  asOf: string;
  source: 'live' | 'indexed';
}

// ── Store ───────────────────────────────────────────────────────────────

export interface StoreInfo {
  name: string;
  currency: string;
  url: string;
  catalogReady: boolean;
  productCount: number | null;
}

// ── Orders ──────────────────────────────────────────────────────────────

export type OrderStatus =
  | 'pending' | 'processing' | 'on_hold' | 'completed'
  | 'cancelled' | 'refunded' | 'failed' | 'unknown';

export interface CommerceOrderLineItem {
  productExternalId: string | null;
  title: string;
  quantity: number;
  total: Money;
}

export interface CommerceOrder {
  externalId: string;
  status: OrderStatus;
  currency: string;
  total: Money;
  createdAt: string;
  updatedAt: string;
  lineItems: CommerceOrderLineItem[];
  /** Masked by default — full values require an elevated, explicitly authorized read. */
  maskedContact: { email: string | null; phone: string | null };
}

export interface CommerceOrderSummary {
  externalId: string;
  status: OrderStatus;
  total: Money;
  createdAt: string;
}

export interface TrackingResult {
  externalOrderId: string;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  status: string | null;
  updatedAt: string | null;
}

/**
 * Every order/customer lookup MUST carry proof of authorization — an order
 * number by itself is never sufficient. See docs/commerce/SECURITY.md
 * §Guest order verification.
 */
export type AuthorizedOrderLookup =
  | { kind: 'verified_customer'; installationId: string; externalCustomerId: string; externalOrderId: string }
  | { kind: 'verified_guest'; installationId: string; verificationProofToken: string; externalOrderId: string };

export type AuthorizedCustomerLookup = {
  kind: 'verified_customer';
  installationId: string;
  externalCustomerId: string;
  limit?: number;
};

/**
 * What the shop's own product page already shows, read back as data.
 *
 * Only APPROVED reviews and only the display name a reviewer already appears
 * under publicly — never their email, IP or user id. This is the same thing
 * any visitor sees by scrolling, so it discloses nothing new.
 */
export interface ProductReview {
  author: string;
  rating: number | null;
  verified: boolean;
  date: string;
  text: string;
}

export interface ProductReviewsResult {
  productExternalId: string;
  averageRating: number | null;
  reviewCount: number;
  reviews: ProductReview[];
}

// ── Connector capabilities ─────────────────────────────────────────────

export const COMMERCE_CAPABILITIES = [
  'store.read',
  'products.read',
  'catalog.export',
  'availability.read',
  'reviews.read',
  'orders.read',
  'tracking.read',
  'customer_context',
  'events.push',
  'widget.bootstrap',
  // Additive (webyar-commerce/1 stays compatible): returned only by
  // connectors that answer searches live from the store and read returns.
  'returns.read',
  'search.direct',
] as const;

export type CommerceCapability = (typeof COMMERCE_CAPABILITIES)[number];

export const COMMERCE_PROTOCOL_VERSION = 'webyar-commerce/1' as const;

// ── Error taxonomy ──────────────────────────────────────────────────────

export const COMMERCE_ERROR_CODES = [
  'commerce_not_connected',
  'commerce_permission_denied',
  'commerce_live_unavailable',
  'commerce_timeout',
  'commerce_invalid_response',
  'product_not_found',
  'variation_not_available',
  'identity_required',
  'identity_expired',
  'order_not_found',
  'order_access_denied',
  'connector_outdated',
  'protocol_mismatch',
  'catalog_syncing',
] as const;

export type CommerceErrorCode = (typeof COMMERCE_ERROR_CODES)[number];

export class CommerceError extends Error {
  constructor(readonly code: CommerceErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'CommerceError';
  }
}

// ── Context passed to every connector method ───────────────────────────

export interface CommerceConnectorContext {
  workspaceId: string;
  connectionId: string;
  installationId: string;
  capabilities: CommerceCapability[];
  correlationId: string;
  /** Overall wall-clock deadline for this call, epoch millis. */
  deadlineAt: number;
}

// ── The canonical, provider-neutral connector contract ─────────────────

export interface CommerceConnector {
  readonly providerType: string;

  getStoreInfo(ctx: CommerceConnectorContext): Promise<StoreInfo>;

  searchProducts(
    ctx: CommerceConnectorContext,
    input: ProductSearchInput,
  ): Promise<ProductSearchResult>;

  getProducts(
    ctx: CommerceConnectorContext,
    ids: string[],
  ): Promise<CommerceProduct[]>;

  getAvailability(
    ctx: CommerceConnectorContext,
    input: AvailabilityInput,
  ): Promise<AvailabilityResult>;

  /**
   * Optional: a store whose plugin predates this simply does not implement
   * it, and the tool that calls it degrades to "no review data" rather than
   * failing the turn.
   */
  getProductReviews?(
    ctx: CommerceConnectorContext,
    input: { productExternalId: string; limit?: number },
  ): Promise<ProductReviewsResult>;

  getOrder(
    ctx: CommerceConnectorContext,
    input: AuthorizedOrderLookup,
  ): Promise<CommerceOrder>;

  getTracking(
    ctx: CommerceConnectorContext,
    input: AuthorizedOrderLookup,
  ): Promise<TrackingResult>;

  getCustomerOrders(
    ctx: CommerceConnectorContext,
    input: AuthorizedCustomerLookup,
  ): Promise<CommerceOrderSummary[]>;

  /**
   * Contact-match check used ONLY to gate whether Web Yar may issue a real
   * OTP for guest order verification. Must never return unmasked contact
   * details — a boolean match result only.
   */
  verifyOrderContactMatch(
    ctx: CommerceConnectorContext,
    input: { externalOrderId: string; email?: string; phone?: string },
  ): Promise<{ matched: boolean }>;
}

// ── Search strategy ────────────────────────────────────────────────────

/**
 * How a connector answers catalogue questions.
 *
 *  - `indexed`: from Web Yar's own product index, kept warm by sync + events,
 *    with live revalidation of volatile fields (WooCommerce).
 *  - `direct`: live from the store, per question, with bounded paginated
 *    queries; Web Yar stores no catalogue at all, so there is no sync, no
 *    heartbeat and no `catalog_ready` gate (OpenCart).
 */
export type CommerceSearchStrategy = 'indexed' | 'direct';

// ── Direct-read contract (index-less connectors) ───────────────────────

/** The signed-in customer, as the STORE must re-validate it on every private read. */
export interface CustomerRef {
  externalCustomerId: string;
  /** Opaque, store-encrypted session reference; unreadable by Web Yar. */
  sessionRef: string;
}

/** What the store actually priced a response for — the cache key uses THIS. */
export interface StoreContext {
  storeId: string;
  language: string;
  currency: string;
  customerGroupId: string;
  customer: boolean;
  pricesVisible: boolean;
  taxIncluded: boolean;
  taxRegion: string;
}

export interface DirectStock {
  state: StockState;
  /** Only when the store itself shows quantities to shoppers. */
  quantity?: number;
  /** The store's own stock-status text (e.g. "2-3 Days", "Pre-Order"). */
  text?: string;
}

export interface DirectProductSummary {
  externalId: string;
  name: string;
  model: string | null;
  manufacturer: string | null;
  url: string | null;
  imageUrl: string | null;
  price: DisplayMoney | null;
  special: DisplayMoney | null;
  /** Set when the store hides prices from this viewer (e.g. guests). */
  priceHidden: 'login_required' | null;
  stock: DirectStock;
  rating: number | null;
  reviewCount: number;
  hasOptions: boolean;
}

export interface DirectProductOptionValue {
  id: string;
  name: string;
  priceDelta: string | null;
}

export interface DirectProductOption {
  id: string;
  name: string;
  type: string;
  required: boolean;
  /** Only values the storefront itself offers (in stock or not stock-tracked). */
  values: DirectProductOptionValue[];
}

export interface DirectProductDetail extends DirectProductSummary {
  description: string | null;
  minimum: number;
  options: DirectProductOption[];
  attributes: Array<{ name: string; value: string }>;
  specialEnds: string | null;
  quantityDiscounts: Array<{ minQuantity: number; unitPrice: DisplayMoney }>;
}

export interface DirectSearchFilters {
  terms?: string[];
  category?: string | null;
  categoryId?: string | null;
  manufacturer?: string | null;
  /** Decimal amounts in the DISPLAY currency. */
  minPrice?: string | null;
  maxPrice?: string | null;
  inStockOnly?: boolean;
  sort?: 'relevance' | 'price_asc' | 'price_desc' | 'newest' | 'rating';
  page?: number;
  pageSize?: number;
  countTotal?: boolean;
}

export interface DirectSearchResult {
  products: DirectProductSummary[];
  page: number;
  pageSize: number;
  hasMore: boolean;
  total: number | null;
  appliedFilters: Record<string, unknown>;
  unsupportedFilters: string[];
  context: StoreContext | null;
}

export interface DirectReviewsResult extends ProductReviewsResult {
  productName: string;
  page: number;
  hasMore: boolean;
}

export interface DirectOrderStatus {
  /** The store's own (possibly custom, translated) status name. */
  name: string | null;
  /** From the store's own "processing" / "complete" status settings. */
  category: 'processing' | 'complete' | 'other';
}

export interface DirectOrderSummary {
  externalId: string;
  createdAt: string | null;
  updatedAt: string | null;
  status: DirectOrderStatus;
  total: DisplayMoney;
  itemCount: number;
}

export interface DirectOrderDetail extends DirectOrderSummary {
  currency: string;
  items: Array<{ productExternalId: string | null; name: string; model: string | null; quantity: number; options: string[]; total: DisplayMoney }>;
  itemsTruncated: boolean;
  totals: Array<{ code: string; title: string; amount: DisplayMoney }>;
  shippingMethod: string | null;
  paymentMethod: string | null;
  /** OpenCart core records no separate payment state — never inferred. */
  paymentStatus: 'not_reported_by_store';
  history: Array<{ date: string | null; status: DirectOrderStatus; comment: string | null }>;
  viewUrl: string | null;
}

export interface DirectTrackingResult {
  externalOrderId: string;
  available: boolean;
  reason: string | null;
  shipments: Array<{ carrier: string | null; trackingNumber: string | null; trackingUrl: string | null; status: string | null; updatedAt: string | null; source: string }>;
  status: DirectOrderStatus;
}

export interface DirectReturn {
  externalId: string;
  orderExternalId: string;
  product: string;
  quantity: number;
  status: string | null;
  createdAt: string | null;
}

export interface Page<T> {
  items: T[];
  page: number;
  hasMore: boolean;
  context: StoreContext | null;
}

export interface DirectReadMeta {
  /** Database work the store reported for this response. */
  storeQueries: number | null;
  storeMs: number | null;
  responseBytes: number;
}

/**
 * The live, index-less read surface. A connector that implements it declares
 * `searchStrategy: 'direct'`. Every private method takes a CustomerRef the
 * STORE re-validates against its live session — Web Yar's own link is never,
 * alone, permission to read an order.
 */
export interface DirectCommerceConnector extends CommerceConnector {
  readonly searchStrategy: 'direct';
  searchDirect(ctx: CommerceConnectorContext, filters: DirectSearchFilters, opts: DirectReadOptions): Promise<DirectSearchResult>;
  getProductDetails(ctx: CommerceConnectorContext, ids: string[], opts: DirectReadOptions): Promise<{ products: DirectProductDetail[]; notFound: string[]; context: StoreContext | null }>;
  getReviewsDirect(ctx: CommerceConnectorContext, productExternalId: string, page: number, opts: DirectReadOptions): Promise<DirectReviewsResult>;
  listCategories(ctx: CommerceConnectorContext, opts: DirectReadOptions): Promise<Array<{ id: string; name: string; url: string | null }>>;
  listOrders(ctx: CommerceConnectorContext, customer: CustomerRef, page: number, opts: DirectReadOptions): Promise<Page<DirectOrderSummary>>;
  getOrderDetail(ctx: CommerceConnectorContext, customer: CustomerRef, externalOrderId: string, opts: DirectReadOptions): Promise<DirectOrderDetail>;
  getTrackingDirect(ctx: CommerceConnectorContext, customer: CustomerRef, externalOrderId: string, opts: DirectReadOptions): Promise<DirectTrackingResult>;
  listReturns(ctx: CommerceConnectorContext, customer: CustomerRef, page: number, opts: DirectReadOptions): Promise<Page<DirectReturn>>;
}

export interface DirectReadOptions {
  /** Signed-in shopper, for group prices on public reads; required on private ones. */
  customer?: CustomerRef | null;
  /** Language hint (e.g. 'fa', 'tr', 'en') — the store picks its closest enabled language. */
  language?: string | null;
  /** Receives the store-reported cost of each call (observability only). */
  onMeta?: (meta: DirectReadMeta) => void;
}

export function isDirectConnector(connector: CommerceConnector): connector is DirectCommerceConnector {
  return (connector as Partial<DirectCommerceConnector>).searchStrategy === 'direct';
}

// ── Events (plugin → Web Yar) ───────────────────────────────────────────

export type CommerceEventType =
  | 'product.created' | 'product.updated' | 'product.deleted'
  | 'variation.created' | 'variation.updated' | 'variation.deleted'
  | 'stock.changed'
  | 'order.created' | 'order.updated' | 'order.status_changed';

export interface CommerceEvent {
  event_id: string;
  installation_id: string;
  type: CommerceEventType;
  entity_id: string;
  entity_version: string;
  occurred_at: string;
  protocol_version: typeof COMMERCE_PROTOCOL_VERSION;
  payload: Record<string, unknown>;
}

export type ConnectionHealthState =
  | 'connected'
  | 'degraded'
  | 'reconnecting'
  | 'authentication_error'
  | 'plugin_outdated'
  | 'protocol_mismatch'
  | 'stale_origin'
  | 'offline'
  | 'disconnected';
