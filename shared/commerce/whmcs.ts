/**
 * WHMCS (billing/hosting) account contract.
 *
 * PURE TYPES AND CONSTANTS ONLY (same rule as shared/commerce/types.ts) —
 * safe to import from server/**, worker/** and src/**.
 *
 * WHMCS is NOT a shop. Services, domains, invoices and tickets are account
 * records with their own lifecycles, so they get their own contract instead
 * of being bent into `CommerceOrder`. What WHMCS shares with WooCommerce is
 * the CONNECTION: pairing, the installation secret, request signing, the
 * SSRF-guarded gateway, owner permissions and plan entitlements
 * (docs/commerce/WHMCS.md).
 *
 * Nothing in here is ever persisted by Web Yar. These shapes exist for the
 * length of one AI turn (plus the bounded in-process cache described in
 * server/services/commerce/whmcs/cache.ts) and are then discarded.
 */

export const WHMCS_PROVIDER = 'whmcs' as const;

/** Logical path covered by the request signature (independent of where WHMCS is mounted). */
export const WHMCS_API_CANONICAL_PATH = '/webyar/whmcs/v1' as const;

/** Where the addon's machine endpoint lives, relative to the WHMCS System URL. */
export const WHMCS_API_ENDPOINT_PATH = '/modules/addons/webyar/api.php' as const;

/** Assertion envelope prefix — lets the identity route tell a WHMCS assertion from a WooCommerce one. */
export const WHMCS_ASSERTION_PREFIX = 'whmcs1' as const;

/**
 * Owner-controlled permissions on a WHMCS connection. Stored in the existing
 * `commerce_connections.permissions` jsonb column. Private sections default to
 * OFF: the workspace owner opts in per section after connecting.
 */
export const WHMCS_CONNECTION_PERMISSIONS = [
  'catalog',
  'announcements',
  'knowledgebase',
  'networkstatus',
  'services',
  'domains',
  'invoices',
  'orders',
  'tickets',
] as const;
export type WhmcsConnectionPermission = (typeof WHMCS_CONNECTION_PERMISSIONS)[number];

export const WHMCS_DEFAULT_PERMISSIONS: Record<WhmcsConnectionPermission, boolean> = {
  catalog: true,
  announcements: false,
  knowledgebase: false,
  networkstatus: false,
  services: false,
  domains: false,
  invoices: false,
  orders: false,
  tickets: false,
};

/**
 * The WHMCS User → Client Account permission names, exactly as WHMCS lists
 * them (Local API `GetPermissionsList`). The addon enforces these itself on
 * every private read; they are mirrored here only so Web Yar can explain a
 * denial.
 */
export const WHMCS_USER_PERMISSIONS = [
  'profile', 'contacts', 'products', 'manageproducts', 'productsso', 'domains',
  'managedomains', 'invoices', 'quotes', 'tickets', 'affiliates', 'emails', 'orders',
] as const;
export type WhmcsUserPermission = (typeof WHMCS_USER_PERMISSIONS)[number];

export const WHMCS_PUBLIC_RESOURCES = ['announcements', 'knowledgebase', 'networkstatus'] as const;
export type WhmcsPublicResource = (typeof WHMCS_PUBLIC_RESOURCES)[number];
export type WhmcsAccountResource = Exclude<WhmcsConnectionPermission, 'catalog' | WhmcsPublicResource>;

/** Which WHMCS user permission a resource needs on the selected Client Account. */
export const WHMCS_RESOURCE_USER_PERMISSION: Record<WhmcsAccountResource, WhmcsUserPermission> = {
  services: 'products',
  domains: 'domains',
  invoices: 'invoices',
  orders: 'orders',
  tickets: 'tickets',
};

/** The complete, closed set of operations the addon answers. There is no generic proxy. */
export const WHMCS_OPS = [
  'health',
  'content.announcements',
  'content.knowledgebase',
  'content.networkstatus',
  'catalog.search',
  'catalog.browse',
  'session.check',
  'services.list',
  'services.get',
  'domains.list',
  'domains.get',
  'invoices.list',
  'invoices.get',
  'orders.list',
  'orders.get',
  'tickets.list',
  'tickets.get',
] as const;
export type WhmcsOp = (typeof WHMCS_OPS)[number];

/** Hard bounds shared by both ends of the protocol (the addon enforces its own copy). */
export const WHMCS_LIMITS = {
  /** Items per list page. */
  maxListItems: 10,
  /** Products per catalog answer. */
  maxCatalogResults: 5,
  /** Customer-visible ticket replies returned for one ticket. */
  maxTicketReplies: 3,
  /** Characters kept per ticket reply excerpt. */
  maxReplyChars: 600,
  /** Characters of a free-text catalog query. */
  maxQueryChars: 80,
} as const;

/** A reference to a live WHMCS grant — never an authorization by itself. */
export interface WhmcsGrantRef {
  grantId: string;
  userId: string;
  clientId: string;
}

/**
 * Money exactly as WHMCS reports it: a decimal string plus the currency code.
 * Web Yar never does arithmetic on it; balances are computed by WHMCS's own
 * database (DECIMAL columns) inside the addon.
 */
export interface WhmcsMoney {
  amount: string;
  currency: string;
}

export interface WhmcsLink {
  url: string;
}

export interface WhmcsServiceSummary {
  id: string;
  product: string;
  group: string | null;
  domain: string | null;
  /** WHMCS billing status (Active/Suspended/…). Not server uptime. */
  status: string;
  billingCycle: string | null;
  nextDueDate: string | null;
  recurringAmount: WhmcsMoney | null;
  manageUrl: string | null;
}

export interface WhmcsServiceDetail extends WhmcsServiceSummary {
  registeredAt: string | null;
  firstPaymentAmount: WhmcsMoney | null;
  /** Only the reason WHMCS already shows the customer; null otherwise. */
  suspensionReason: string | null;
  overdue: boolean;
}

export interface WhmcsDomain {
  id: string;
  domain: string;
  status: string;
  registrationDate: string | null;
  /** Registry expiry — NOT the same as the billing due date below. */
  expiryDate: string | null;
  nextDueDate: string | null;
  recurringAmount: WhmcsMoney | null;
  registrationPeriodYears: number | null;
  autoRenew: boolean | null;
  manageUrl: string | null;
}

export interface WhmcsInvoiceItem {
  description: string;
  amount: WhmcsMoney | null;
}

export interface WhmcsInvoice {
  id: string;
  number: string;
  status: string;
  issuedAt: string | null;
  dueDate: string | null;
  paidAt: string | null;
  total: WhmcsMoney | null;
  balance: WhmcsMoney | null;
  overdue: boolean;
  viewUrl: string | null;
  items?: WhmcsInvoiceItem[];
}

export interface WhmcsOrderItem {
  kind: 'service' | 'domain' | 'addon' | 'other';
  name: string;
  /** Provisioning/registration status of that item — separate from order and payment status. */
  status: string | null;
}

export interface WhmcsOrder {
  id: string;
  number: string;
  /** WHMCS order status (Pending/Active/Fraud/Cancelled). */
  status: string;
  /** Status of the order's invoice, when there is one. */
  paymentStatus: string | null;
  placedAt: string | null;
  amount: WhmcsMoney | null;
  invoiceId: string | null;
  viewUrl: string | null;
  items?: WhmcsOrderItem[];
}

export interface WhmcsTicketReply {
  from: 'staff' | 'customer';
  at: string | null;
  excerpt: string;
}

export interface WhmcsTicket {
  id: string;
  number: string;
  subject: string;
  status: string;
  department: string | null;
  priority: string | null;
  openedAt: string | null;
  lastReplyAt: string | null;
  viewUrl: string | null;
  replies?: WhmcsTicketReply[];
}

export interface WhmcsProductPrice {
  cycle: string;
  price: string;
  setupFee: string | null;
}

export interface WhmcsProduct {
  id: string;
  name: string;
  group: string | null;
  description: string | null;
  payType: string | null;
  currency: string | null;
  prices: WhmcsProductPrice[];
  taxable: boolean | null;
  orderUrl: string | null;
}

export interface WhmcsListPage<T> {
  items: T[];
  /** True when WHMCS has more rows than were returned (count is not computed). */
  hasMore: boolean;
  asOf: string;
}

export interface WhmcsSessionState {
  valid: boolean;
  /** Effective WHMCS user permissions on the selected client account. */
  permissions: WhmcsUserPermission[];
}

export interface WhmcsHealth {
  protocolVersion: string;
  addonVersion: string | null;
  whmcsVersion: string | null;
  phpVersion: string | null;
  capabilities: string[];
  schemaOk: boolean;
  systemUrl: string | null;
}

/** Ephemeral public-content excerpt; never mirrored into WebYar storage. */
export interface WhmcsContentItem {
  id: string;
  title: string;
  excerpt: string | null;
  url: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  status: string | null;
}
