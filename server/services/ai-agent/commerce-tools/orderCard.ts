/**
 * The order card: structured data about ONE order, stored beside an AI reply
 * that answered a question about it (conversation_messages.metadata of the AI
 * row: `kind: 'order_status'`, `order: OrderStatusCard`).
 *
 * Built from the very objects the commerce stage already fetched for the
 * turn, never from another store call, and never handed to the model: the
 * tool results, the prompt and therefore the reply text stay exactly what
 * they were. Templates that draw it (t2) read `metadata.order`; every other
 * surface (default/intl, the inbox list, Telegram/WhatsApp/e-mail, the
 * mobile and desktop apps) keeps showing the text.
 *
 * Pure: no I/O, never throws, null when there is no card to draw.
 */
import type {
  CommerceOrderLineItem,
  DirectOrderDetail,
  DirectTrackingResult,
  OrderStatus,
  TrackingResult,
} from '../../../../shared/commerce/types.js';
import { sanitizeCommerceText } from '../../commerce/sanitize.js';

/** The card's status: WooCommerce's set, plus 'shipped' inferred from tracking. */
export type OrderCardStatus =
  | 'pending' | 'on_hold' | 'processing' | 'shipped' | 'completed'
  | 'cancelled' | 'refunded' | 'failed' | 'unknown';

/** Index into the four fixed steps (placed · preparing · shipped · delivered); null = no progress row. */
export type OrderCardStep = 0 | 1 | 2 | 3 | null;

export interface OrderStatusCard {
  v: 1;
  number: string;
  /** First product line, sanitized (≤ 80 characters + an ellipsis); null when the store sent none. */
  summary: string | null;
  /** How many other product lines the order has. */
  more: number;
  status: OrderCardStatus;
  /** The store's own status name (direct stores only); WooCommerce: always null. */
  statusLabel: string | null;
  step: OrderCardStep;
  /** Estimated delivery day, YYYY-MM-DD; null when the store gave none. */
  arrives: string | null;
  /** The carrier's tracking page (https only); null when there is none. */
  trackingUrl: string | null;
}

/** What the card needs of a store order: a full order, or a summary with the plugin's optional item fields. */
export interface StoreOrderInput {
  externalId: unknown;
  status: OrderStatus | string;
  lineItems?: CommerceOrderLineItem[] | null;
  itemSummary?: string | null;
  itemCount?: number | null;
}

export const ORDER_CARD_SUMMARY_MAX = 80;
export const ORDER_CARD_LABEL_MAX = 40;
export const ORDER_CARD_URL_MAX = 500;
const ORDER_CARD_MORE_MAX = 999;
const ORDER_NUMBER_RE = /^[A-Za-z0-9#._-]{1,32}$/;
const KNOWN_STATUSES: ReadonlySet<string> = new Set([
  'pending', 'on_hold', 'processing', 'completed', 'cancelled', 'refunded', 'failed', 'unknown',
]);

/**
 * The step a status stands on. `hasTracking` (a tracking number or URL read
 * this turn) is the only thing that says an order left the store: WooCommerce
 * has no 'shipped' status of its own.
 */
export function stepFor(status: OrderStatus | string, hasTracking: boolean): { status: OrderCardStatus; step: OrderCardStep } {
  const s = KNOWN_STATUSES.has(String(status)) ? (status as OrderStatus) : 'unknown';
  switch (s) {
    case 'pending':
    case 'on_hold':
      return { status: s, step: 0 };
    case 'processing':
      return hasTracking ? { status: 'shipped', step: 2 } : { status: 'processing', step: 1 };
    case 'completed':
      return { status: 'completed', step: 3 };
    case 'cancelled':
    case 'refunded':
    case 'failed':
      return { status: s, step: null };
    default:
      return hasTracking ? { status: 'shipped', step: 2 } : { status: 'unknown', step: null };
  }
}

/**
 * A tracking link the card may open in a new tab: an absolute https URL with
 * no credentials in it, at most ORDER_CARD_URL_MAX characters. Anything else
 * (javascript:, data:, http:, a relative path, garbage) is no link at all.
 */
export function safeTrackingUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > ORDER_CARD_URL_MAX) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return null;
    const out = u.toString();
    return out.length <= ORDER_CARD_URL_MAX ? out : null;
  } catch {
    return null;
  }
}

/** The first 10 characters of an ISO date when they are a real calendar day, else null. */
export function arrivalDay(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function orderNumber(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const value = String(raw);
  return ORDER_NUMBER_RE.test(value) ? value : null;
}

function otherLines(count: number): number {
  return Number.isFinite(count) ? Math.min(ORDER_CARD_MORE_MAX, Math.max(0, Math.floor(count) - 1)) : 0;
}

/** WooCommerce (and any indexed store): a full order, or the latest-order summary, plus this turn's tracking. */
export function orderCardFromStore(order: StoreOrderInput | null | undefined, tracking: TrackingResult | null | undefined): OrderStatusCard | null {
  try {
    if (!order) return null;
    const number = orderNumber(order.externalId);
    if (!number) return null;
    const lines = Array.isArray(order.lineItems) ? order.lineItems.filter((l) => l && typeof l === 'object') : null;
    let summary: string | null;
    let more: number;
    if (lines && lines.length) {
      summary = sanitizeCommerceText(lines[0].title, ORDER_CARD_SUMMARY_MAX);
      more = otherLines(lines.length);
    } else {
      summary = sanitizeCommerceText(order.itemSummary, ORDER_CARD_SUMMARY_MAX);
      more = summary ? otherLines(Number(order.itemCount ?? 1)) : 0;
    }
    const trackingUrl = tracking ? safeTrackingUrl(tracking.trackingUrl) : null;
    const hasTracking = !!tracking && (!!String(tracking.trackingNumber ?? '').trim() || !!trackingUrl);
    const { status, step } = stepFor(order.status, hasTracking);
    return {
      v: 1,
      number,
      summary,
      more,
      status,
      statusLabel: null,
      step,
      arrives: tracking ? arrivalDay(tracking.estimatedDelivery) : null,
      trackingUrl,
    };
  } catch {
    return null;
  }
}

/** Direct stores (OpenCart): one order's detail, plus the shipments read this turn. */
export function orderCardFromDirect(detail: DirectOrderDetail | null | undefined, tracking: DirectTrackingResult | null | undefined): OrderStatusCard | null {
  try {
    if (!detail) return null;
    const number = orderNumber(detail.externalId);
    if (!number) return null;
    const items = Array.isArray(detail.items) ? detail.items.filter((i) => i && typeof i === 'object') : [];
    const summary = items.length ? sanitizeCommerceText(items[0].name, ORDER_CARD_SUMMARY_MAX) : null;
    const lineCount = Math.max(items.length, Number(detail.itemCount) || 0);
    const shipments = tracking && tracking.available && Array.isArray(tracking.shipments) ? tracking.shipments : [];
    const trackingUrl = shipments.map((s) => safeTrackingUrl(s?.trackingUrl)).find((u): u is string => !!u) ?? null;
    const hasTracking = !!trackingUrl || shipments.some((s) => !!String(s?.trackingNumber ?? '').trim());
    const category = detail.status?.category;
    const { status, step }: { status: OrderCardStatus; step: OrderCardStep } = category === 'complete'
      ? { status: 'completed', step: 3 }
      : category === 'processing'
        ? (hasTracking ? { status: 'shipped', step: 2 } : { status: 'processing', step: 1 })
        : { status: 'unknown', step: null };
    return {
      v: 1,
      number,
      summary,
      more: summary ? otherLines(lineCount) : 0,
      status,
      statusLabel: sanitizeCommerceText(detail.status?.name, ORDER_CARD_LABEL_MAX),
      step,
      arrives: null,
      trackingUrl,
    };
  } catch {
    return null;
  }
}
