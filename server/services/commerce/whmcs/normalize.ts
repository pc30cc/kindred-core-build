/**
 * WHMCS addon response → canonical account shapes (shared/commerce/whmcs.ts).
 *
 * Every value that crosses this boundary is untrusted merchant content: an
 * invoice description, a product name and above all a ticket reply are text a
 * customer or a staff member typed. Strings are stripped of markup and
 * control characters and length-bounded (sanitize.ts); money must look like a
 * decimal number; dates must look like dates; links must stay on the WHMCS
 * installation's own origin and base path. Anything else is dropped rather
 * than passed on "to be helpful".
 *
 * Pure functions, no I/O — unit-tested directly (src/test/commerce/whmcs*).
 */
import type {
  WhmcsContentItem,
  WhmcsDomain,
  WhmcsHealth,
  WhmcsInvoice,
  WhmcsListPage,
  WhmcsMoney,
  WhmcsOrder,
  WhmcsProduct,
  WhmcsServiceDetail,
  WhmcsServiceSummary,
  WhmcsSessionState,
  WhmcsTicket,
  WhmcsUserPermission,
} from '../../../../shared/commerce/whmcs.js';
import { WHMCS_LIMITS, WHMCS_USER_PERMISSIONS } from '../../../../shared/commerce/whmcs.js';
import { sanitizeCommerceText } from '../sanitize.js';

const DECIMAL_RE = /^-?\d{1,15}(\.\d{1,8})?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/;
const CURRENCY_RE = /^[A-Z]{3}$/;

/** Untrusted JSON object: every field is unknown until checked. */
type Raw = Record<string, unknown>;

/** Any value → an object whose fields can be probed safely. */
export function rec(value: unknown): Raw {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : {};
}

export interface LinkScope {
  /** scheme://host[:port] approved at pairing. */
  origin: string;
  /** WHMCS System URL (origin + optional path prefix), no trailing slash. */
  baseUrl: string;
}

export function text(value: unknown, max: number): string | null {
  return sanitizeCommerceText(typeof value === 'number' ? String(value) : value, max);
}

export function id(value: unknown): string | null {
  const s = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  return /^\d{1,12}$/.test(s) ? s : null;
}

/** `0000-00-00` is WHMCS's "no date"; anything that is not a real date becomes null. */
export function date(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(DATE_RE);
  if (!m) return null;
  if (m[1] === '0000' || m[2] === '00' || m[3] === '00') return null;
  return m[4] ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : `${m[1]}-${m[2]}-${m[3]}`;
}

export function money(amount: unknown, currency: unknown): WhmcsMoney | null {
  const a = typeof amount === 'number' ? String(amount) : typeof amount === 'string' ? amount.trim() : '';
  const c = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
  if (!DECIMAL_RE.test(a) || !CURRENCY_RE.test(c)) return null;
  return { amount: a, currency: c };
}

function bool(value: unknown): boolean | null {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  return null;
}

/** A link is kept only if it points into this WHMCS installation. */
export function scopedUrl(value: unknown, scope: LinkScope): string | null {
  if (typeof value !== 'string' || value.length > 500) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.origin !== scope.origin) return null;
  let basePath = '/';
  try {
    basePath = new URL(scope.baseUrl).pathname.replace(/\/+$/, '') + '/';
  } catch {
    return null;
  }
  if (!(parsed.pathname + '/').startsWith(basePath) && !parsed.pathname.startsWith(basePath)) return null;
  parsed.hash = '';
  return parsed.toString();
}

function list(value: unknown, max: number): unknown[] {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

function asOf(value: unknown): string {
  return typeof value === 'string' && DATE_RE.test(value) ? value : new Date().toISOString();
}

function page<T>(raw: unknown, map: (r: unknown) => T | null): WhmcsListPage<T> {
  const r = rec(raw);
  const items = list(r.items, WHMCS_LIMITS.maxListItems).map(map).filter((v): v is T => v !== null);
  return { items, hasMore: r.has_more === true, asOf: asOf(r.as_of) };
}

export function normalizeService(input: unknown, scope: LinkScope): WhmcsServiceSummary | null {
  const raw = rec(input);
  const serviceId = id(raw.id);
  const product = text(raw.product, 120);
  if (!serviceId || !product) return null;
  return {
    id: serviceId,
    product,
    group: text(raw.group, 120),
    domain: text(raw.domain, 253),
    status: text(raw.status, 40) ?? 'unknown',
    billingCycle: text(raw.billing_cycle, 40),
    nextDueDate: date(raw.next_due_date),
    recurringAmount: money(raw.recurring_amount, raw.currency),
    manageUrl: scopedUrl(raw.manage_url, scope),
  };
}

export function normalizeServiceDetail(input: unknown, scope: LinkScope): WhmcsServiceDetail | null {
  const raw = rec(input);
  const base = normalizeService(raw, scope);
  if (!base) return null;
  return {
    ...base,
    registeredAt: date(raw.registered_at),
    firstPaymentAmount: money(raw.first_payment_amount, raw.currency),
    suspensionReason: text(raw.suspension_reason, 200),
    overdue: raw.overdue === true,
  };
}

export function normalizeDomain(input: unknown, scope: LinkScope): WhmcsDomain | null {
  const raw = rec(input);
  const domainId = id(raw.id);
  const name = text(raw.domain, 253);
  if (!domainId || !name) return null;
  const period = Number(raw.registration_period);
  return {
    id: domainId,
    domain: name,
    status: text(raw.status, 40) ?? 'unknown',
    registrationDate: date(raw.registration_date),
    expiryDate: date(raw.expiry_date),
    nextDueDate: date(raw.next_due_date),
    recurringAmount: money(raw.recurring_amount, raw.currency),
    registrationPeriodYears: Number.isInteger(period) && period > 0 && period <= 10 ? period : null,
    autoRenew: bool(raw.auto_renew),
    manageUrl: scopedUrl(raw.manage_url, scope),
  };
}

export function normalizeInvoice(input: unknown, scope: LinkScope): WhmcsInvoice | null {
  const raw = rec(input);
  const invoiceId = id(raw.id);
  if (!invoiceId) return null;
  const invoice: WhmcsInvoice = {
    id: invoiceId,
    number: text(raw.number, 40) ?? invoiceId,
    status: text(raw.status, 40) ?? 'unknown',
    issuedAt: date(raw.date),
    dueDate: date(raw.due_date),
    paidAt: date(raw.date_paid),
    total: money(raw.total, raw.currency),
    balance: money(raw.balance, raw.currency),
    overdue: raw.overdue === true,
    viewUrl: scopedUrl(raw.view_url, scope),
  };
  if (Array.isArray(raw.items)) {
    invoice.items = list(raw.items, WHMCS_LIMITS.maxListItems)
      .map((entry) => {
        const item = rec(entry);
        const description = text(item.description, 200);
        return description ? { description, amount: money(item.amount, raw.currency) } : null;
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);
  }
  return invoice;
}

export function normalizeOrder(input: unknown, scope: LinkScope): WhmcsOrder | null {
  const raw = rec(input);
  const orderId = id(raw.id);
  if (!orderId) return null;
  const order: WhmcsOrder = {
    id: orderId,
    number: text(raw.number, 40) ?? orderId,
    status: text(raw.status, 40) ?? 'unknown',
    paymentStatus: text(raw.payment_status, 40),
    placedAt: date(raw.date),
    amount: money(raw.amount, raw.currency),
    invoiceId: id(raw.invoice_id),
    viewUrl: scopedUrl(raw.view_url, scope),
  };
  if (Array.isArray(raw.items)) {
    order.items = list(raw.items, WHMCS_LIMITS.maxListItems)
      .map((entry) => {
        const item = rec(entry);
        const name = text(item.name, 200);
        if (!name) return null;
        const kind: 'service' | 'domain' | 'addon' | 'other' =
          item.kind === 'service' || item.kind === 'domain' || item.kind === 'addon' ? item.kind : 'other';
        return { kind, name, status: text(item.status, 40) };
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);
  }
  return order;
}

export function normalizeTicket(input: unknown, scope: LinkScope): WhmcsTicket | null {
  const raw = rec(input);
  const ticketId = id(raw.id);
  const subject = text(raw.subject, 200);
  if (!ticketId || !subject) return null;
  const ticket: WhmcsTicket = {
    id: ticketId,
    number: text(raw.tid, 40) ?? ticketId,
    subject,
    status: text(raw.status, 40) ?? 'unknown',
    department: text(raw.department, 120),
    priority: text(raw.priority, 40),
    openedAt: date(raw.date),
    lastReplyAt: date(raw.last_reply),
    viewUrl: scopedUrl(raw.view_url, scope),
  };
  if (Array.isArray(raw.replies)) {
    ticket.replies = list(raw.replies, WHMCS_LIMITS.maxTicketReplies)
      .map((entry) => {
        const reply = rec(entry);
        const excerpt = text(reply.excerpt, WHMCS_LIMITS.maxReplyChars);
        if (!excerpt) return null;
        return { from: reply.from === 'staff' ? 'staff' as const : 'customer' as const, at: date(reply.date), excerpt };
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);
  }
  return ticket;
}

export function normalizeProduct(input: unknown, scope: LinkScope): WhmcsProduct | null {
  const raw = rec(input);
  const productId = id(raw.id);
  const name = text(raw.name, 120);
  if (!productId || !name) return null;
  const currency = typeof raw.currency === 'string' && CURRENCY_RE.test(raw.currency) ? raw.currency : null;
  const prices = list(raw.prices, 8)
    .map((entry) => {
      const p = rec(entry);
      const cycle = text(p.cycle, 20);
      const price = typeof p.price === 'string' && DECIMAL_RE.test(p.price) ? p.price : null;
      if (!cycle || price === null) return null;
      const setup = typeof p.setup_fee === 'string' && DECIMAL_RE.test(p.setup_fee) ? p.setup_fee : null;
      return { cycle, price, setupFee: setup };
    })
    .filter((v): v is NonNullable<typeof v> => v !== null);
  return {
    id: productId,
    name,
    group: text(raw.group, 120),
    description: text(raw.description, 300),
    payType: text(raw.pay_type, 20),
    currency,
    prices,
    taxable: bool(raw.taxable),
    orderUrl: scopedUrl(raw.order_url, scope),
  };
}

export const normalizeServicePage = (raw: unknown, scope: LinkScope) => page(raw, (r) => normalizeService(r, scope));
export const normalizeDomainPage = (raw: unknown, scope: LinkScope) => page(raw, (r) => normalizeDomain(r, scope));
export const normalizeInvoicePage = (raw: unknown, scope: LinkScope) => page(raw, (r) => normalizeInvoice(r, scope));
export const normalizeOrderPage = (raw: unknown, scope: LinkScope) => page(raw, (r) => normalizeOrder(r, scope));
export const normalizeTicketPage = (raw: unknown, scope: LinkScope) => page(raw, (r) => normalizeTicket(r, scope));

export function normalizeCatalog(input: unknown, scope: LinkScope): WhmcsListPage<WhmcsProduct> & { taxMode: string | null } {
  const raw = rec(input);
  const items = list(raw.items, WHMCS_LIMITS.maxListItems)
    .map((r) => normalizeProduct(r, scope))
    .filter((v): v is WhmcsProduct => v !== null);
  const taxMode = raw.tax_mode === 'inclusive' || raw.tax_mode === 'exclusive' ? raw.tax_mode : null;
  return { items, hasMore: raw.has_more === true, asOf: asOf(raw.as_of), taxMode };
}

export function normalizeSession(input: unknown): WhmcsSessionState {
  const raw = rec(input);
  const allowed = new Set<string>(WHMCS_USER_PERMISSIONS);
  const permissions = list(raw.permissions, WHMCS_USER_PERMISSIONS.length)
    .filter((p): p is WhmcsUserPermission => typeof p === 'string' && allowed.has(p));
  return { valid: raw.valid === true, permissions };
}

export function normalizeHealth(input: unknown): WhmcsHealth {
  const raw = rec(input);
  return {
    protocolVersion: typeof raw.protocol_version === 'string' ? raw.protocol_version.slice(0, 40) : 'unknown',
    addonVersion: typeof raw.addon_version === 'string' ? raw.addon_version.slice(0, 20) : null,
    whmcsVersion: typeof raw.whmcs_version === 'string' ? raw.whmcs_version.slice(0, 40) : null,
    phpVersion: typeof raw.php_version === 'string' ? raw.php_version.slice(0, 20) : null,
    capabilities: list(raw.capabilities, 20).filter((c): c is string => typeof c === 'string' && c.length <= 40),
    schemaOk: raw.schema_ok === true,
    systemUrl: typeof raw.system_url === 'string' ? raw.system_url.slice(0, 300) : null,
  };
}

/** Public content is untrusted text, with no HTML or arbitrary external URLs. */
export function normalizeContent(raw: unknown, scope: LinkScope): WhmcsListPage<WhmcsContentItem> & { limited: boolean } {
  const r = rec(raw);
  const result = page<WhmcsContentItem>(raw, (value) => {
    const item = rec(value);
    const itemId = id(item.id);
    const title = text(item.title, 160);
    if (!itemId || !title) return null;
    return { id: itemId, title, excerpt: text(item.excerpt, 700), url: scopedUrl(item.url, scope),
      publishedAt: date(item.published_at), updatedAt: date(item.updated_at), status: text(item.status, 40) };
  });
  return { ...result, items: result.items.slice(0, 5), limited: r.limited === true };
}
