/**
 * The commerce stage for DIRECT connectors (OpenCart): answers from the
 * live store, per question, within a hard per-turn budget.
 *
 * What this stage guarantees (docs/commerce/OPENCART.md §AI tools):
 *
 *  - No store call unless the turn is about the store: an intent was
 *    detected, or the question points at a result listed earlier in the
 *    conversation. The caller already returns before this stage otherwise.
 *  - At most MAX_COMMERCE_CALLS_PER_TURN store calls, all inside ONE
 *    deadline (COMMERCE_TOOL_DEADLINE_MS); each call gets only what is left.
 *  - Only the tool a question needs runs; nothing is preloaded.
 *  - Model output is never identity or authorization: the customer comes
 *    from the identity link, and the STORE re-validates that customer's live
 *    session and order ownership on every private read.
 *  - Public answers may come from the bounded cache, keyed by everything
 *    that changes them (store, language, customer group / customer, op,
 *    input). Private answers are never cached. An explicit "right now"
 *    question bypasses the cache.
 *  - Evidence handed to the model is bounded (MAX_EVIDENCE_BYTES) and made
 *    of primitives only (renderToolResults); store text is data, never
 *    instructions.
 *  - Follow-ups («دومی», "the second one", «ikincisi», "more") resolve
 *    against ids kept in conversation metadata — never against text.
 *  - One audit INSERT per turn (all rows of the turn in one statement).
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import type { ReadOnlyToolResult } from '../actions/readOnly.js';
import {
  CommerceError,
  isDirectConnector,
  type CommerceCapability,
  type CommerceErrorCode,
  type CustomerRef,
  type DirectCommerceConnector,
  type DirectOrderDetail,
  type DirectOrderSummary,
  type DirectProductDetail,
  type DirectProductSummary,
  type DirectReadMeta,
  type DirectSearchResult,
  type StoreContext,
} from '../../../../shared/commerce/types.js';
import { withCommerceConnector, assertCommerceModuleEntitled, type CommerceConnectionRow, type CommercePermissionKey } from '../../commerce/gateway.js';
import { flushCommerceToolAudit, type CommerceToolAuditRow } from '../../commerce/audit.js';
import { buildSearchTerms } from '../../commerce/productIndex.js';
import { publicCache, liveSingleFlight, PUBLIC_TTL_MS } from '../../commerce/liveGuard.js';
import { recordLiveRead } from '../../commerce/metrics.js';
import type { CommerceIntent, FollowUp } from './intent.js';
import { MAX_COMMERCE_CALLS_PER_TURN, COMMERCE_TOOL_DEADLINE_MS } from './limits.js';

/** Hard cap on the evidence bytes one turn adds to the prompt. */
export const MAX_EVIDENCE_BYTES = 7_000;
/** Results listed per page (store-side cap is 10). */
export const DIRECT_PAGE_SIZE = 5;
const REFS_KEY = 'commerce_refs';
const MAX_REF_IDS = 10;
const MAX_REF_URLS = 12;

export interface DirectStageInput {
  workspaceId: string;
  conversationId: string | null;
  question: string;
  correlationId?: string;
  /** Conversation language ('fa' | 'en' | 'tr' …) — a hint; the store picks its closest language. */
  locale?: string | null;
  connection: CommerceConnectionRow;
  intent: CommerceIntent;
  followUp: FollowUp;
}

export interface DirectStageResult {
  toolResults: ReadOnlyToolResult[];
  toolsUsed: string[];
  /** Conversation turns older than this must not be fed to the model (identity changed). */
  historyCutoffAt: string | null;
  /** Store links the model was given this turn or earlier in this conversation. */
  allowedUrls: string[];
  /** Observability for the run log / resource report. */
  meta: { storeCalls: number; cacheHits: number; evidenceBytes: number; storeQueries: number; responseBytes: number };
}

interface CommerceRefs {
  v: 1;
  connection_id: string;
  /** 'guest' or a hash of connection+customer — order ids are only reused for the same subject. */
  subject: string;
  last: 'products' | 'orders' | null;
  products: string[];
  search: { terms: string[]; max_price?: string | null; category?: string | null; page: number; has_more: boolean } | null;
  orders: string[];
  orders_page: number;
  orders_has_more: boolean;
  urls: string[];
}

function emptyRefs(connectionId: string, subject: string): CommerceRefs {
  return { v: 1, connection_id: connectionId, subject, last: null, products: [], search: null, orders: [], orders_page: 1, orders_has_more: false, urls: [] };
}

function readRefs(metadata: unknown, connectionId: string, subject: string): CommerceRefs {
  const raw = (metadata as any)?.[REFS_KEY];
  if (!raw || raw.v !== 1 || raw.connection_id !== connectionId) return emptyRefs(connectionId, subject);
  const refs: CommerceRefs = {
    ...emptyRefs(connectionId, subject),
    last: raw.last === 'products' || raw.last === 'orders' ? raw.last : null,
    products: Array.isArray(raw.products) ? raw.products.map(String).slice(0, MAX_REF_IDS) : [],
    search: raw.search && typeof raw.search === 'object' ? raw.search : null,
    urls: Array.isArray(raw.urls) ? raw.urls.filter((u: unknown) => typeof u === 'string').slice(0, MAX_REF_URLS) : [],
  };
  // Another customer (or signed out): their order ids are not this subject's.
  if (raw.subject === subject) {
    refs.orders = Array.isArray(raw.orders) ? raw.orders.map(String).slice(0, MAX_REF_IDS) : [];
    refs.orders_page = Number(raw.orders_page) || 1;
    refs.orders_has_more = raw.orders_has_more === true;
  } else if (refs.last === 'orders') {
    refs.last = null;
  }
  return refs;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value as object).sort().map((k) => `${k}:${stable((value as any)[k])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

function pick<T>(list: T[], ordinal: number | 'last' | null): T | undefined {
  if (!list.length || ordinal === null) return undefined;
  return ordinal === 'last' ? list[list.length - 1] : list[ordinal - 1];
}

const CURRENCY_NAMES: Record<string, string> = { IRT: 'Toman', IRR: 'Rial', USD: 'US Dollar', EUR: 'Euro', GBP: 'Pound Sterling', AED: 'UAE Dirham', TRY: 'Turkish Lira' };

export async function runDirectCommerceStage(config: ServerConfig, input: DirectStageInput): Promise<DirectStageResult> {
  const { connection, intent, followUp } = input;
  const correlationId = input.correlationId ?? randomUUID();
  const deadlineAt = Date.now() + COMMERCE_TOOL_DEADLINE_MS;
  const results: ReadOnlyToolResult[] = [];
  const toolsUsed: string[] = [];
  const audit: CommerceToolAuditRow[] = [];
  const allowedUrls = new Set<string>();
  const meta = { storeCalls: 0, cacheHits: 0, evidenceBytes: 0, storeQueries: 0, responseBytes: 0 };
  const perms = connection.permissions ?? ({} as Record<string, boolean>);
  const sb = getServiceClient(config);

  await assertCommerceModuleEntitled(config, input.workspaceId); // plan gate — throws CommerceError

  // ── conversation + identity (two indexed reads, only on commerce turns) ──
  let visitorId: string | null = null;
  let metadata: Record<string, unknown> = {};
  if (input.conversationId) {
    const { data: conv } = await sb.from('conversations').select('visitor_session_id, metadata').eq('id', input.conversationId).eq('workspace_id', input.workspaceId).maybeSingle();
    visitorId = (conv as any)?.visitor_session_id ?? null;
    metadata = ((conv as any)?.metadata ?? {}) as Record<string, unknown>;
  }
  let customer: CustomerRef | null = null;
  let customerGroup: string | null = null;
  let historyCutoffAt: string | null = null;
  if (visitorId) {
    const { data: link } = await sb
      .from('commerce_customer_links')
      .select('external_customer_id, session_ref, customer_group_id, expires_at, private_cutoff_at')
      .eq('connection_id', connection.id)
      .eq('visitor_id', visitorId)
      .order('verified_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const l = link as any;
    historyCutoffAt = l?.private_cutoff_at ?? null;
    if (l && l.session_ref && new Date(l.expires_at).getTime() > Date.now()) {
      customer = { externalCustomerId: String(l.external_customer_id), sessionRef: String(l.session_ref) };
      customerGroup = l.customer_group_id ? String(l.customer_group_id) : null;
    }
  }
  const subject = customer ? createHash('sha256').update(`${connection.id}|${customer.externalCustomerId}`).digest('hex').slice(0, 16) : 'guest';
  const refs = readRefs(metadata, connection.id, subject);
  const refsBefore = stable(refs);
  for (const u of refs.urls) allowedUrls.add(u);

  const language = (input.locale || '').slice(0, 8) || null;
  const customerKey = customer ? `c:${customer.externalCustomerId}:g${customerGroup ?? '?'}` : 'guest';

  // ── the one path to the store ─────────────────────────────────────────
  const live = async <T>(tool: string, capability: CommerceCapability, permission: CommercePermissionKey, run: (c: DirectCommerceConnector, ctx: any, onMeta: (m: DirectReadMeta) => void) => Promise<T>): Promise<T | null> => {
    if (meta.storeCalls >= MAX_COMMERCE_CALLS_PER_TURN || Date.now() >= deadlineAt) {
      results.push({ name: tool, data: { error_code: 'turn_budget_exhausted' } });
      return null;
    }
    meta.storeCalls += 1;
    toolsUsed.push(tool);
    const started = Date.now();
    let last: DirectReadMeta | null = null;
    try {
      const value = await withCommerceConnector(config, input.workspaceId, connection.id, {
        capability, permission, toolName: tool, conversationId: input.conversationId, correlationId, auditSink: audit, deadlineAt, connection,
      }, (c, ctx) => {
        if (!isDirectConnector(c)) throw new CommerceError('commerce_not_connected', 'not a direct connector');
        return run(c, ctx, (m) => { last = m; });
      });
      const m = last as DirectReadMeta | null;
      meta.storeQueries += m?.storeQueries ?? 0;
      meta.responseBytes += m?.responseBytes ?? 0;
      recordLiveRead({ provider: connection.provider_type, op: tool, outcome: 'ok', durationMs: Date.now() - started, responseBytes: m?.responseBytes, storeQueries: m?.storeQueries });
      return value;
    } catch (err) {
      const code: CommerceErrorCode = err instanceof CommerceError ? err.code : 'commerce_invalid_response';
      recordLiveRead({ provider: connection.provider_type, op: tool, outcome: 'error', durationMs: Date.now() - started });
      results.push({ name: tool, data: { error_code: code, ...remedyFor(code) } });
      return null;
    }
  };

  /**
   * Public reads go through the cache and single-flight. The entry is stored
   * under the context the STORE reports having used, so a stale customer
   * reference that the store answered as a guest can never be cached as that
   * customer's (or group's) prices, and the reverse.
   */
  const publicRead = async <T extends { context?: StoreContext | null }>(tool: string, capability: CommerceCapability, permission: CommercePermissionKey, input_: unknown, ttl: number, fresh: boolean, run: (c: DirectCommerceConnector, ctx: any, onMeta: (m: DirectReadMeta) => void) => Promise<T>, contextFree = false): Promise<T | null> => {
    const base = [connection.id, connection.installation_id, connection.external_store_id ?? '', tool, language ?? '', stable(input_)].join('|');
    // Reviews and categories carry no price or stock: one entry serves everyone.
    const key = `${base}|${contextFree ? 'any' : customerKey}`;
    if (!fresh) {
      const hit = publicCache.get(key) as T | undefined;
      if (hit) {
        meta.cacheHits += 1;
        toolsUsed.push(tool);
        audit.push({ workspaceId: input.workspaceId, connectionId: connection.id, conversationId: input.conversationId, correlationId, toolName: tool, durationMs: 0, success: true, cacheHit: true });
        recordLiveRead({ provider: connection.provider_type, op: tool, outcome: 'cache_hit', durationMs: 0 });
        return hit;
      }
    }
    const value = await liveSingleFlight.run(`${key}|${fresh ? 'fresh' : 'any'}`, () => live(tool, capability, permission, run));
    if (value) {
      const ctx = value.context;
      const actualKey = contextFree
        ? `${base}|any`
        : ctx && !ctx.customer ? `${base}|guest` : ctx && ctx.customer && customer ? `${base}|c:${customer.externalCustomerId}:g${ctx.customerGroupId}` : null;
      if (actualKey) publicCache.set(actualKey, value, ttl, Buffer.byteLength(JSON.stringify(value)));
    }
    return value;
  };

  const searchFilters = (text: string, maxPrice?: string | null) => ({
    terms: buildSearchTerms(text).slice(0, 6),
    ...(maxPrice ? { maxPrice } : {}),
  });

  const addProducts = (tool: string, list: DirectProductSummary[], page: number, startIndex = 0) => {
    list.forEach((p, i) => {
      results.push({ name: tool, data: productData(p, startIndex + i + 1, perms) });
      if (p.url) allowedUrls.add(p.url);
    });
    refs.products = list.map((p) => p.externalId).slice(0, MAX_REF_IDS);
    refs.last = 'products';
    void page;
  };

  const addDetail = (p: DirectProductDetail) => {
    results.push({ name: 'commerce.product_details', data: detailData(p, perms) });
    if (p.url) allowedUrls.add(p.url);
  };

  const addSearchMeta = (r: DirectSearchResult) => {
    results.push({ name: 'commerce.search_meta', data: {
      source: 'live_store',
      page: r.page,
      has_more: r.hasMore,
      match_mode: 'keyword_in_product_name_or_tags',
      semantic_search: false,
      ...(r.unsupportedFilters.length ? { unsupported_filters: r.unsupportedFilters.join(';') } : {}),
      ...contextData(r.context),
    } });
  };

  const privateGuard = (permission: CommercePermissionKey): boolean => {
    if (perms[permission] !== true) {
      results.push({ name: 'commerce.orders', data: { error_code: 'commerce_permission_denied' } });
      return false;
    }
    if (!customer) {
      // Never an order by number, e-mail or phone: the shopper signs in to
      // the store and asks again.
      results.push({ name: 'commerce.orders', data: { error_code: 'identity_required', remedy: 'sign_in_to_store' } });
      audit.push({ workspaceId: input.workspaceId, connectionId: connection.id, conversationId: input.conversationId, correlationId, toolName: 'commerce.order_lookup', durationMs: 0, success: false, safeErrorCode: 'identity_required' });
      return false;
    }
    return true;
  };

  const addOrders = (list: DirectOrderSummary[], page: number, hasMore: boolean) => {
    list.forEach((o, i) => results.push({ name: 'commerce.customer_orders', data: { n: i + 1, ...orderSummaryData(o) } }));
    if (!list.length) results.push({ name: 'commerce.customer_orders', data: { error_code: 'order_not_found', note: 'no_orders_in_this_store' } });
    results.push({ name: 'commerce.orders_meta', data: { source: 'live_store', page, has_more: hasMore } });
    refs.orders = list.map((o) => o.externalId).slice(0, MAX_REF_IDS);
    refs.orders_page = page;
    refs.orders_has_more = hasMore;
    refs.last = 'orders';
  };

  const addOrderDetail = (o: DirectOrderDetail) => {
    results.push({ name: 'commerce.order_details', data: orderDetailData(o) });
    for (const h of o.history.slice(0, 4)) {
      results.push({ name: 'commerce.order_history', data: { order_id: o.externalId, date: h.date, status: h.status.name, status_category: h.status.category, comment: h.comment } });
    }
    if (o.viewUrl) allowedUrls.add(o.viewUrl);
  };

  const orderDetailWithTracking = async (orderId: string) => {
    const detail = await live('commerce.get_order', 'orders.read', 'orders', (c, ctx, onMeta) => c.getOrderDetail(ctx, customer as CustomerRef, orderId, { language, onMeta }));
    if (!detail) return;
    addOrderDetail(detail);
    if (followUp.wantsTracking) await tracking(orderId);
  };

  const tracking = async (orderId: string) => {
    if (perms.tracking !== true) return;
    const t = await live('commerce.get_tracking', 'tracking.read', 'tracking', (c, ctx, onMeta) => c.getTrackingDirect(ctx, customer as CustomerRef, orderId, { language, onMeta }));
    if (!t) return;
    if (!t.available) {
      // Said plainly, so nothing gets invented to fill the gap.
      results.push({ name: 'commerce.tracking', data: { order_id: t.externalOrderId, tracking_available: false, reason: t.reason ?? 'no_tracking_source' } });
      return;
    }
    for (const s of t.shipments) results.push({ name: 'commerce.tracking', data: { order_id: t.externalOrderId, tracking_available: true, carrier: s.carrier, tracking_number: s.trackingNumber, tracking_url: s.trackingUrl, status: s.status, updated_at: s.updatedAt } });
  };

  const productDetails = async (id: string, fresh: boolean) => {
    const r = await publicRead('commerce.get_product', 'products.read', 'products', { ids: [id] }, PUBLIC_TTL_MS.product, fresh, (c, ctx, onMeta) => c.getProductDetails(ctx, [id], { customer, language, onMeta }));
    if (!r) return;
    if (!r.products.length) results.push({ name: 'commerce.product_details', data: { error_code: 'product_not_found', product_id: id } });
    for (const p of r.products) addDetail(p);
    results.push({ name: 'commerce.product_meta', data: { source: 'live_store', ...contextData(r.context) } });
  };

  const reviewsFor = async (id: string) => {
    if (perms.products !== true || perms.reviews === false) {
      results.push({ name: 'commerce.get_reviews', data: { error_code: 'commerce_permission_denied' } });
      return;
    }
    const r = await publicRead('commerce.get_reviews', 'reviews.read', 'products', { id }, PUBLIC_TTL_MS.reviews, false, async (c, ctx, onMeta) => ({ ...(await c.getReviewsDirect(ctx, id, 1, { language, onMeta })), context: null }), true);
    if (!r) return;
    results.push({ name: 'commerce.get_reviews', data: { product: r.productName, average_rating: r.averageRating, review_count: r.reviewCount, has_more: r.hasMore } });
    for (const rv of r.reviews) results.push({ name: 'commerce.review', data: { product: r.productName, author: rv.author, rating: rv.rating, date: rv.date, text: rv.text } });
  };

  const search = async (filters: ReturnType<typeof searchFilters>, page: number, fresh = false) => {
    if (perms.products !== true) {
      results.push({ name: 'commerce.search_products', data: { error_code: 'commerce_permission_denied' } });
      return null;
    }
    const q = { ...filters, page, pageSize: DIRECT_PAGE_SIZE };
    const r = await publicRead('commerce.search_products', 'products.read', 'products', q, PUBLIC_TTL_MS.search, fresh, (c, ctx, onMeta) => c.searchDirect(ctx, q, { customer, language, onMeta }));
    if (!r) return null;
    addProducts('commerce.search_products', r.products, r.page, (r.page - 1) * DIRECT_PAGE_SIZE);
    if (!r.products.length) results.push({ name: 'commerce.search_products', data: { error_code: 'product_not_found', searched_terms: (filters.terms ?? []).join(' ') } });
    addSearchMeta(r);
    refs.search = { terms: filters.terms ?? [], max_price: (filters as any).maxPrice ?? null, page: r.page, has_more: r.hasMore };
    return r;
  };

  try {
    const refProduct = refs.last === 'products' ? pick(refs.products, followUp.ordinal) : undefined;
    const refOrder = refs.last === 'orders' ? pick(refs.orders, followUp.ordinal) : undefined;

    if (followUp.more && refs.last === 'products' && refs.search && refs.search.has_more && intent.kind !== 'search_products') {
      await search({ terms: refs.search.terms, ...(refs.search.max_price ? { maxPrice: refs.search.max_price } : {}) }, refs.search.page + 1);
    } else if (followUp.more && refs.last === 'orders' && refs.orders_has_more) {
      if (privateGuard('orders')) {
        const page = refs.orders_page + 1;
        const r = await live('commerce.list_orders', 'orders.read', 'orders', (c, ctx, onMeta) => c.listOrders(ctx, customer as CustomerRef, page, { language, onMeta }));
        if (r) addOrders(r.items, r.page, r.hasMore);
      }
    } else if (refProduct && intent.kind !== 'order_status' && intent.kind !== 'order_lookup') {
      if (intent.kind === 'product_reviews') await reviewsFor(refProduct);
      else await productDetails(refProduct, followUp.wantsFresh);
    } else if (refOrder && intent.kind !== 'order_lookup') {
      if (privateGuard('orders')) await orderDetailWithTracking(refOrder);
    } else {
      switch (intent.kind) {
        case 'browse_products': {
          await search({ terms: [] }, 1);
          break;
        }
        case 'list_categories': {
          if (perms.products !== true) { results.push({ name: 'commerce.list_categories', data: { error_code: 'commerce_permission_denied' } }); break; }
          const r = await publicRead('commerce.list_categories', 'products.read', 'products', {}, PUBLIC_TTL_MS.categories, false, async (c, ctx, onMeta) => ({ items: await c.listCategories(ctx, { language, onMeta }), context: null }), true);
          for (const cat of r?.items ?? []) {
            results.push({ name: 'commerce.list_categories', data: { category: cat.name, url: cat.url } });
            if (cat.url) allowedUrls.add(cat.url);
          }
          break;
        }
        case 'search_products': {
          const r = await search(searchFilters(intent.filters.text ?? input.question, intent.filters.maxPrice?.amountMinor ?? null), 1, followUp.wantsFresh);
          // An option question («سایز ۴۳ مشکی») about ONE clear match: read its
          // real options instead of assuming variations exist.
          const wantsOptions = followUp.aboutOptions || Object.keys(intent.filters.attributes ?? {}).length > 0;
          if (r && r.products.length === 1 && wantsOptions && r.products[0].hasOptions) await productDetails(r.products[0].externalId, followUp.wantsFresh);
          break;
        }
        case 'get_availability': {
          // The summary already carries the store's stock state; only a
          // single match with options needs its option list to answer.
          // "Right now" questions bypass the cache.
          const r = await search(searchFilters(intent.text), 1, followUp.wantsFresh);
          if (r && r.products.length === 1 && r.products[0].hasOptions) await productDetails(r.products[0].externalId, followUp.wantsFresh);
          break;
        }
        case 'product_reviews': {
          const target = pick(refs.products, followUp.ordinal ?? (refs.products.length === 1 ? 1 : null));
          if (target) { await reviewsFor(target); break; }
          const r = await search(searchFilters(intent.text), 1);
          if (r?.products[0]) await reviewsFor(r.products[0].externalId);
          break;
        }
        case 'order_status': {
          if (!privateGuard('orders')) break;
          if (followUp.lastOrder && refs.orders[0]) { await orderDetailWithTracking(refs.orders[0]); break; }
          const r = await live('commerce.list_orders', 'orders.read', 'orders', (c, ctx, onMeta) => c.listOrders(ctx, customer as CustomerRef, 1, { language, onMeta }));
          if (!r) break;
          addOrders(r.items, r.page, r.hasMore);
          if ((followUp.lastOrder || followUp.wantsTracking) && r.items[0]) {
            if (followUp.wantsTracking) await tracking(r.items[0].externalId);
            else await orderDetailWithTracking(r.items[0].externalId);
          }
          break;
        }
        case 'order_lookup': {
          if (!privateGuard('orders')) break;
          // The number comes from the shopper's text; the store answers only
          // if that order is theirs, in this store — otherwise "not found".
          await orderDetailWithTracking(intent.orderNumber);
          break;
        }
        case 'order_returns': {
          if (!privateGuard('orders')) break;
          const r = await live('commerce.list_returns', 'returns.read', 'orders', (c, ctx, onMeta) => c.listReturns(ctx, customer as CustomerRef, 1, { language, onMeta }));
          for (const rt of r?.items ?? []) results.push({ name: 'commerce.returns', data: { return_id: rt.externalId, order_id: rt.orderExternalId, product: rt.product, quantity: rt.quantity, status: rt.status, date: rt.createdAt } });
          if (r && !r.items.length) results.push({ name: 'commerce.returns', data: { note: 'no_returns_in_this_store' } });
          break;
        }
        case 'store_info':
          results.push({ name: 'commerce.store', data: { store_url: connection.store_id } });
          allowedUrls.add(connection.store_id);
          break;
        default:
          break;
      }
    }

    if (followUp.more && !meta.storeCalls && !meta.cacheHits && (refs.last === 'products' || refs.last === 'orders')) {
      results.push({ name: 'commerce.pagination', data: { has_more: false, note: 'all_results_already_shown' } });
    }
  } finally {
    // Refs change → one metadata write; unchanged → none.
    refs.urls = [...allowedUrls].slice(-MAX_REF_URLS);
    if (input.conversationId && stable(refs) !== refsBefore) {
      await persistRefs(config, input.workspaceId, input.conversationId, refs).catch(() => {});
    }
    await flushCommerceToolAudit(config, audit);
  }

  const bounded = boundEvidence(results);
  meta.evidenceBytes = bounded.bytes;
  recordLiveRead({ provider: connection.provider_type, op: 'turn', outcome: 'ok', durationMs: 0, evidenceBytes: bounded.bytes });
  return { toolResults: bounded.results, toolsUsed, historyCutoffAt, allowedUrls: [...allowedUrls], meta };
}

async function persistRefs(config: ServerConfig, workspaceId: string, conversationId: string, refs: CommerceRefs): Promise<void> {
  // Re-read so a concurrent metadata writer (working memory, handoff state)
  // is never clobbered: only this key is replaced.
  const sb = getServiceClient(config);
  const { data } = await sb.from('conversations').select('metadata').eq('id', conversationId).eq('workspace_id', workspaceId).maybeSingle();
  if (!data) return;
  const current = ((data as any).metadata || {}) as Record<string, unknown>;
  await sb.from('conversations').update({ metadata: { ...current, [REFS_KEY]: refs } }).eq('id', conversationId).eq('workspace_id', workspaceId);
}

function remedyFor(code: CommerceErrorCode): Record<string, string> {
  if (code === 'identity_required') return { remedy: 'sign_in_to_store' };
  // The store no longer recognises this browser's session (signed out,
  // expired, another account): sign in again. Nothing cached is shown.
  if (code === 'identity_expired') return { remedy: 'sign_in_again' };
  if (code === 'commerce_live_unavailable' || code === 'commerce_timeout') return { remedy: 'store_unreachable_try_later' };
  return {};
}

function contextData(ctx: StoreContext | null): Record<string, string | boolean> {
  if (!ctx) return {};
  return {
    currency: ctx.currency,
    ...(CURRENCY_NAMES[ctx.currency] ? { currency_name: CURRENCY_NAMES[ctx.currency] } : {}),
    prices_include_tax: ctx.taxIncluded,
    prices_for: ctx.customer ? 'signed_in_customer' : 'guest',
    as_of: new Date().toISOString(),
  };
}

function productData(p: DirectProductSummary, n: number, perms: Record<string, boolean>): Record<string, unknown> {
  return {
    n,
    external_id: p.externalId,
    name: p.name,
    ...(p.manufacturer ? { brand: p.manufacturer } : {}),
    ...(perms.prices !== false
      ? p.priceHidden
        ? { price: null, price_note: 'sign_in_to_see_prices' }
        : { price: p.price?.formatted ?? null, ...(p.special ? { special_price: p.special.formatted } : {}) }
      : {}),
    ...(perms.stock === true ? { stock: p.stock.state, ...(p.stock.text ? { stock_text: p.stock.text } : {}), ...(typeof p.stock.quantity === 'number' ? { stock_quantity: p.stock.quantity } : {}) } : {}),
    ...(p.rating !== null ? { rating: p.rating } : {}),
    review_count: p.reviewCount,
    has_options: p.hasOptions,
    url: p.url,
  };
}

function detailData(p: DirectProductDetail, perms: Record<string, boolean>): Record<string, unknown> {
  const options = p.options
    .map((o) => `${o.name}${o.required ? '*' : ''}: ${o.values.length ? o.values.map((v) => (perms.prices !== false && v.priceDelta ? `${v.name} (${v.priceDelta})` : v.name)).join(' | ') : o.type}`)
    .join(' ; ')
    .slice(0, 900);
  const tiers = perms.prices !== false ? p.quantityDiscounts.map((d) => `${d.minQuantity}+: ${d.unitPrice.formatted}`).join(' ; ') : '';
  return {
    ...productData(p, 1, perms),
    n: undefined,
    minimum_quantity: p.minimum,
    ...(options ? { options, options_note: 'values are what the store offers now; OpenCart tracks stock per option value, not per combination' } : { options: 'none' }),
    ...(perms.prices !== false && p.specialEnds ? { special_ends: p.specialEnds } : {}),
    ...(tiers ? { quantity_prices: tiers } : {}),
    ...(p.attributes.length ? { attributes: p.attributes.map((a) => `${a.name}: ${a.value}`).join(' ; ').slice(0, 500) } : {}),
    ...(p.description ? { description: p.description.slice(0, 400) } : {}),
  };
}

function orderSummaryData(o: DirectOrderSummary): Record<string, unknown> {
  return { order_id: o.externalId, date: o.createdAt, status: o.status.name, status_category: o.status.category, total: o.total.formatted, items: o.itemCount };
}

function orderDetailData(o: DirectOrderDetail): Record<string, unknown> {
  return {
    ...orderSummaryData(o),
    items: o.items.slice(0, 10).map((i) => `${i.quantity} × ${i.name}${i.options.length ? ` (${i.options.join(', ')})` : ''} = ${i.total.formatted}`).join(' ; ').slice(0, 900),
    totals: o.totals.map((t) => `${t.title}: ${t.amount.formatted}`).join(' ; ').slice(0, 400),
    shipping_method: o.shippingMethod,
    payment_method: o.paymentMethod,
    // OpenCart core has no payment or delivery state of its own.
    payment_status: 'not_reported_by_store',
    view_url: o.viewUrl,
    source: 'live_store',
  };
}

/** Keeps the evidence under MAX_EVIDENCE_BYTES, dropping trailing list rows first. */
export function boundEvidence(results: ReadOnlyToolResult[]): { results: ReadOnlyToolResult[]; bytes: number } {
  const clean = results.map((r) => ({ name: r.name, data: Object.fromEntries(Object.entries(r.data).filter(([, v]) => v !== undefined)) }));
  const size = (list: ReadOnlyToolResult[]) => Buffer.byteLength(JSON.stringify(list));
  let bytes = size(clean);
  if (bytes <= MAX_EVIDENCE_BYTES) return { results: clean, bytes };
  const kept = [...clean];
  for (let i = kept.length - 1; i >= 0 && size(kept) > MAX_EVIDENCE_BYTES; i -= 1) {
    if (/meta$|_meta|pagination/.test(kept[i].name)) continue;
    kept.splice(i, 1);
  }
  kept.push({ name: 'commerce.evidence', data: { truncated: true, note: 'ask_for_more_to_see_the_rest' } });
  bytes = size(kept);
  return { results: kept, bytes };
}
