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

// ── Connector capabilities ─────────────────────────────────────────────

export const COMMERCE_CAPABILITIES = [
  'store.read',
  'products.read',
  'catalog.export',
  'availability.read',
  'orders.read',
  'tracking.read',
  'customer_context',
  'events.push',
  'widget.bootstrap',
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
