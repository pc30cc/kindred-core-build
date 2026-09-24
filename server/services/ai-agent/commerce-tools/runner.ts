/**
 * Commerce tool execution for the AI generation pipeline. Runs AFTER
 * intent detection (intent.ts), BEFORE generation, bounded by
 * limits.ts. Every result is shaped as a ReadOnlyToolResult
 * (server/services/ai-agent/actions/readOnly.ts) — the SAME "factual data
 * only, never instructions" contract the existing get_business_hours tool
 * uses, so commerce evidence is sanitized (primitives only) by the exact
 * same code path already proven safe against prompt injection.
 */
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import type { ReadOnlyToolResult } from '../actions/readOnly.js';
import {
  CommerceError,
  type AvailabilityResult,
  type CommerceCapability,
  type CommerceConnector,
  type CommerceConnectorContext,
  type CommerceErrorCode,
  type CommerceOrder,
  type CommerceOrderSummary,
  type CommerceProduct,
  type ProductReviewsResult,
  type StoreInfo,
  type TrackingResult,
} from '../../../../shared/commerce/types.js';
import { getActiveConnectionForWorkspace, withCommerceConnector, assertPermission, assertCommerceModuleEntitled, type CommerceConnectionRow, type CommercePermissionKey } from '../../commerce/gateway.js';
import { searchIndexedProducts, listIndexedCategories, buildSearchTerms, type IndexedProductRow } from '../../commerce/productIndex.js';
import { detectCommerceIntent } from './intent.js';
import { MAX_COMMERCE_CALLS_PER_TURN, MAX_RESULTS_PER_TOOL, COMMERCE_TOOL_DEADLINE_MS } from './limits.js';
import { randomUUID } from 'node:crypto';
import { recordCommerceToolAudit } from '../../commerce/audit.js';

export interface CommerceStageInput {
  workspaceId: string;
  conversationId: string | null;
  question: string;
  correlationId?: string;
  /** The workspace's live connections, when the caller already read them for this turn. */
  connections?: CommerceConnectionRow[];
  /** Validated page context — picks the store the visitor is actually on. */
  pageOrigin?: string | null;
  pagePath?: string | null;
}

export interface CommerceStageResult {
  toolResults: ReadOnlyToolResult[];
  toolsUsed: string[];
}

/**
 * The unit an amount is IN, spelled out.
 *
 * The store reports a currency CODE, and the model has to guess what it
 * means. Asked for powerbank models, it read `currency=IRT` and told the
 * shopper «۱٬۹۸۰٬۰۰۰ ریال» — the price is in Toman, so that is wrong by a
 * factor of ten, in the direction that makes the shop look cheap.
 *
 * This is a LABEL, never a conversion: the amount is passed through exactly
 * as the store reported it (spec §68/§69), and this only says which unit it
 * was already in. An unknown code gets no label rather than a guess.
 */
const CURRENCY_LABELS: Record<string, string> = {
  IRT: 'Toman',
  IRR: 'Rial',
  USD: 'US Dollar',
  EUR: 'Euro',
  GBP: 'Pound Sterling',
  AED: 'UAE Dirham',
  TRY: 'Turkish Lira',
};

function currencyLabel(code: string | null | undefined): string | null {
  const key = String(code ?? '').trim().toUpperCase();
  return CURRENCY_LABELS[key] ?? null;
}

function moneyToToman(amountMinor: number | null): string | null {
  if (amountMinor === null || amountMinor === undefined) return null;
  return String(amountMinor);
}

/**
 * A link the model can actually reproduce.
 *
 * The canonical permalink of a Persian-named product is percent-encoded —
 * the only form that survives HTTP — and a model handed one does not copy
 * it, it retypes it. On the live store it produced a URL that decoded to
 * «میليياٟمپر» instead of «میلی‌آمپر», and, asked for a link a turn later,
 * simply invented `/product/nova-12`. Both answer 404.
 *
 * WordPress resolves `?p=<id>` for any public post and redirects to the
 * canonical permalink, so this is the SAME page behind thirty ASCII
 * characters. Checked against the live store: `?p=17` answers 200 and lands
 * on the canonical URL.
 *
 * The visitor never sees this form — `verifyStoreLinks` turns it back into
 * the canonical permalink after generation, and the widget renders a button
 * either way. It exists purely so the model has something it can copy.
 */
function modelSafeProductUrl(connection: CommerceConnectionRow, row: IndexedProductRow): string | null {
  if (connection.provider_type !== 'woocommerce') return row.canonical_url;
  const store = String(connection.store_id || '').replace(/\/+$/, '');
  if (!store || !row.external_id) return row.canonical_url;
  return `${store}/?p=${encodeURIComponent(row.external_id)}`;
}

function productRowToToolData(row: IndexedProductRow, connection: CommerceConnectionRow): Record<string, unknown> {
  return {
    external_id: row.external_id,
    title: row.title,
    sku: row.sku,
    type: row.product_type,
    price: moneyToToman(row.effective_price_minor) ?? moneyToToman(row.regular_price_minor),
    currency: row.currency,
    ...(currencyLabel(row.currency) ? { currency_name: currencyLabel(row.currency) } : {}),
    stock_state: row.stock_state,
    stock_quantity: row.stock_quantity,
    url: modelSafeProductUrl(connection, row),
  };
}

async function resolveVerifiedCustomer(
  config: ServerConfig,
  workspaceId: string,
  connectionId: string,
  conversationId: string | null,
): Promise<string | null> {
  if (!conversationId) return null;
  const sb = getServiceClient(config);
  const { data: conv } = await sb.from('conversations').select('visitor_session_id').eq('id', conversationId).eq('workspace_id', workspaceId).maybeSingle();
  const visitorId = conv?.visitor_session_id;
  if (!visitorId) return null;

  const { data: link } = await sb
    .from('commerce_customer_links')
    .select('external_customer_id, expires_at')
    .eq('connection_id', connectionId)
    .eq('visitor_id', visitorId)
    .gte('expires_at', new Date().toISOString())
    .order('verified_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return link?.external_customer_id ?? null;
}

/**
 * Runs the deterministic commerce stage for one visitor turn. Never throws
 * — any failure (no connection, gateway error, deadline) degrades to "no
 * commerce evidence for this turn" so the existing AI Core answer path is
 * completely unaffected (spec §88 — commerce is additive).
 */
export async function runCommerceToolStage(config: ServerConfig, input: CommerceStageInput): Promise<CommerceStageResult> {
  const empty: CommerceStageResult = { toolResults: [], toolsUsed: [] };
  /** Rows the catalogue probe already fetched, so the search below does not re-run it. */
  let catalogueProbe: { rows: IndexedProductRow[]; startedAt: number } | null = null;
  try {
    const keywordIntent = detectCommerceIntent(input.question);

    const connection = await getActiveConnectionForWorkspace(config, input.workspaceId, {
      family: 'store',
      connections: input.connections,
      pageOrigin: input.pageOrigin ?? null,
      pagePath: input.pagePath ?? null,
    });
    if (!connection) return empty;
    await assertCommerceModuleEntitled(config, input.workspaceId); // plan gate — throws CommerceError, caught below

    /**
     * When no phrasing rule matched, ask the CATALOGUE whether this was a
     * product question.
     *
     * The keyword list could not keep up with how people actually type.
     * «تی شرت هم داری ؟» and «پاور بانک چی داشتی» both produced no intent at
     * all — the informal singular «داری» is deliberately not a stock word
     * («دوست داری» is not about the shop) and the past tense «داشتی» was in
     * no list — so the commerce stage never ran and the assistant answered
     * about a t-shirt the shop very much sells with "I have no information".
     *
     * Every missing phrasing is a new rule, and the rules will never be
     * finished. The catalogue is the thing that actually knows: if the words
     * in a message name something the shop stocks, it is a product question,
     * whatever verb it was asked with. It is self-limiting — a message that
     * matches nothing adds nothing — and it costs one bounded index query.
     */
    let intent = keywordIntent;
    if (intent.kind === 'none') {
      if (!buildSearchTerms(input.question).length) return empty;
      const probeStartedAt = Date.now();
      const { rows } = await searchIndexedProducts(config, connection.id, { text: input.question, limit: MAX_RESULTS_PER_TOOL })
        .catch(() => ({ rows: [] as IndexedProductRow[] }));
      if (!rows.length) return empty;
      intent = { kind: 'search_products', filters: { text: input.question, limit: MAX_RESULTS_PER_TOOL } };
      catalogueProbe = { rows, startedAt: probeStartedAt };
    }

    const deadlineAt = Date.now() + COMMERCE_TOOL_DEADLINE_MS;
    const results: ReadOnlyToolResult[] = [];
    const toolsUsed: string[] = [];
    let calls = 0;
    // ONE id for the whole turn, so the audit rows of a single question can
    // be read together. Without it each gateway call minted its own and the
    // trail could not be joined back into a turn.
    const correlationId = input.correlationId ?? randomUUID();

    /**
     * COMPLIANCE_AUDIT_LOGGING for the tools served from Web Yar's OWN index.
     *
     * `withCommerceConnector` already audits everything that reaches the
     * store, but a catalogue search, a browse and a category listing never
     * go through it — they read the index instead. They are still an AI
     * agent reading a merchant's catalogue, and they were the only commerce
     * tools leaving no trace at all. `cacheHit` says exactly which side
     * answered: true here, false for a call that went to the store.
     */
    const auditIndexRead = (
      toolName: string,
      startedAt: number,
      outcome: { resultCount?: number | null; errorCode?: string | null },
    ) => {
      void recordCommerceToolAudit(config, {
        workspaceId: input.workspaceId,
        connectionId: connection.id,
        conversationId: input.conversationId,
        correlationId,
        toolName,
        durationMs: Date.now() - startedAt,
        success: !outcome.errorCode,
        safeErrorCode: outcome.errorCode ?? null,
        cacheHit: true,
        liveRevalidated: false,
        resultCount: outcome.resultCount ?? null,
      });
    };

    const callGateway = async <T>(
      toolName: string,
      permission: CommercePermissionKey | undefined,
      capability: CommerceCapability,
      fn: (connector: CommerceConnector, ctx: CommerceConnectorContext) => Promise<T>,
    ): Promise<T | null> => {
      if (calls >= MAX_COMMERCE_CALLS_PER_TURN || Date.now() >= deadlineAt) return null;
      calls += 1;
      toolsUsed.push(toolName);
      try {
        return await withCommerceConnector(config, input.workspaceId, connection.id, {
          capability, permission, toolName, conversationId: input.conversationId, correlationId,
        }, fn);
      } catch (err) {
        const code: CommerceErrorCode = err instanceof CommerceError ? err.code : 'commerce_invalid_response';
        results.push({ name: toolName, data: { error_code: code } });
        return null;
      }
    };

    if (!connection.catalog_ready) {
      results.push({ name: 'commerce_status', data: { error_code: 'catalog_syncing' } });
      auditIndexRead('commerce.catalog_status', Date.now(), { errorCode: 'catalog_syncing' });
      return { toolResults: results, toolsUsed };
    }

    switch (intent.kind) {
      case 'store_info': {
        const info = await callGateway<StoreInfo>('commerce.get_store_info', undefined, 'store.read', (c, ctx) => c.getStoreInfo(ctx));
        if (info) results.push({ name: 'commerce.get_store_info', data: { name: info.name, currency: info.currency, catalog_ready: info.catalogReady } });
        break;
      }
      case 'browse_products': {
        // "چی دارید؟" is a request to browse, not to search for a product
        // named "what". Deliberately NO text filter: the index returns the
        // most recently updated rows, which is the closest thing to "what we
        // sell" that the catalogue can answer without inventing a ranking.
        assertPermission(connection, 'products');
        const browseStartedAt = Date.now();
        const { rows, totalMatched } = await searchIndexedProducts(config, connection.id, { limit: MAX_RESULTS_PER_TOOL })
          .catch(() => ({ rows: [] as IndexedProductRow[], totalMatched: 0 }));
        for (const row of rows) results.push({ name: 'commerce.search_products', data: productRowToToolData(row, connection) });
        results.push({ name: 'commerce.catalog_size', data: { total_products: totalMatched } });
        toolsUsed.push('commerce.browse_products');
        auditIndexRead('commerce.browse_products', browseStartedAt, { resultCount: rows.length });
        break;
      }
      case 'product_reviews': {
        // Which product the visitor means comes from the index, exactly as
        // the availability branch resolves it; the reviews themselves are
        // read live, because a review posted this morning should be readable
        // this morning and there is no review column in the index.
        assertPermission(connection, 'products');
        const reviewsStartedAt = Date.now();
        const { rows } = await searchIndexedProducts(config, connection.id, { text: intent.text, limit: 1 })
          .catch(() => ({ rows: [] as IndexedProductRow[] }));
        const subject = rows[0];
        if (!subject) {
          results.push({ name: 'commerce.get_reviews', data: { error_code: 'product_not_found' } });
          auditIndexRead('commerce.get_reviews', reviewsStartedAt, { resultCount: 0, errorCode: 'product_not_found' });
          break;
        }
        const reviews = await callGateway<ProductReviewsResult | null>('commerce.get_reviews', 'products', 'reviews.read', (c, ctx) =>
          (c.getProductReviews
            ? c.getProductReviews(ctx, { productExternalId: subject.external_id, limit: MAX_RESULTS_PER_TOOL })
            : Promise.resolve(null)));
        if (!reviews) break; // the gateway already pushed a safe error result
        results.push({ name: 'commerce.get_reviews', data: {
          product: subject.title,
          average_rating: reviews.averageRating,
          review_count: reviews.reviewCount,
        } });
        for (const r of reviews.reviews ?? []) {
          results.push({ name: 'commerce.review', data: {
            product: subject.title,
            author: r.author,
            rating: r.rating,
            verified: r.verified,
            text: r.text,
          } });
        }
        break;
      }
      case 'list_categories': {
        assertPermission(connection, 'products');
        const categoriesStartedAt = Date.now();
        const categories = await listIndexedCategories(config, connection.id).catch(() => []);
        if (!categories.length) {
          results.push({ name: 'commerce.list_categories', data: { error_code: 'no_categories' } });
        } else {
          for (const c of categories) {
            results.push({ name: 'commerce.list_categories', data: { category: c.name, product_count: c.productCount } });
          }
        }
        toolsUsed.push('commerce.list_categories');
        auditIndexRead('commerce.list_categories', categoriesStartedAt, {
          resultCount: categories.length,
          errorCode: categories.length ? null : 'no_categories',
        });
        break;
      }
      case 'search_products': {
        assertPermission(connection, 'products'); // throws commerce_permission_denied if not granted — caught below
        const searchStartedAt = catalogueProbe?.startedAt ?? Date.now();
        // The probe above already ran exactly this search; running it twice
        // would double the cost of every question it rescued.
        const { rows } = catalogueProbe
          ? { rows: catalogueProbe.rows }
          : await searchIndexedProducts(config, connection.id, intent.filters).catch(() => ({ rows: [] as IndexedProductRow[] }));
        const bounded = rows.slice(0, MAX_RESULTS_PER_TOOL);
        for (const row of bounded) results.push({ name: 'commerce.search_products', data: productRowToToolData(row, connection) });
        toolsUsed.push('commerce.search_products');
        auditIndexRead('commerce.search_products', searchStartedAt, { resultCount: bounded.length });

        // Live revalidation of the top candidates before the AI states
        // price/stock as fact (spec §25) — never trust the index alone for
        // volatile fields.
        if (bounded.length && connection.permissions?.stock) {
          const ids = bounded.slice(0, 5).map((r) => r.external_id);
          const live = await callGateway<CommerceProduct[]>('commerce.get_product', 'stock', 'products.read', (c, ctx) => c.getProducts(ctx, ids));
          for (const p of live ?? []) {
            results.push({ name: 'commerce.get_product_live', data: {
              external_id: p.externalId,
              stock_state: p.stockState,
              price: p.effectivePrice?.amountMinor ?? null,
              currency: p.currency,
              ...(currencyLabel(p.currency) ? { currency_name: currencyLabel(p.currency) } : {}),
            } });
          }
        }
        break;
      }
      case 'get_availability': {
        const availabilityStartedAt = Date.now();
        const { rows } = await searchIndexedProducts(config, connection.id, { text: intent.text, limit: 1 }).catch(() => ({ rows: [] as IndexedProductRow[] }));
        const top = rows[0];
        if (!top) {
          results.push({ name: 'commerce.get_availability', data: { error_code: 'product_not_found' } });
          auditIndexRead('commerce.get_availability', availabilityStartedAt, { resultCount: 0, errorCode: 'product_not_found' });
          break;
        }
        const avail = await callGateway<AvailabilityResult>('commerce.get_availability', 'stock', 'availability.read', (c, ctx) => c.getAvailability(ctx, { productExternalId: top.external_id }));
        if (avail) results.push({ name: 'commerce.get_availability', data: { product: top.title, stock_state: avail.stockState, stock_quantity: avail.stockQuantity, price: avail.effectivePrice?.amountMinor ?? null } });
        break;
      }
      case 'order_status':
      case 'order_lookup': {
        assertPermission(connection, 'orders');
        const externalCustomerId = await resolveVerifiedCustomer(config, input.workspaceId, connection.id, input.conversationId);
        if (!externalCustomerId) {
          // Order number alone (or "my last order" with no verified
          // identity) is never sufficient — spec §28/§43. No order data leaks.
          // Naming the remedy, not just the refusal: this store verifies a
          // customer by them being signed in to it, so "sign in and ask
          // again" is an answer the visitor can act on, where a bare
          // `identity_required` left the model to invent one.
          results.push({ name: 'commerce.order_lookup', data: { error_code: 'identity_required', remedy: 'sign_in_to_store' } });
          // A refusal is part of the record: it says an order was asked for
          // and that nothing was disclosed.
          auditIndexRead('commerce.order_lookup', Date.now(), { errorCode: 'identity_required' });
          break;
        }
        if (intent.kind === 'order_status') {
          const orders = await callGateway<CommerceOrderSummary[]>('commerce.get_customer_orders', 'customer_history', 'orders.read', (c, ctx) =>
            c.getCustomerOrders(ctx, { kind: 'verified_customer', installationId: connection.installation_id, externalCustomerId, limit: 1 }));
          const latest = orders?.[0];
          if (latest) {
            results.push({ name: 'commerce.get_customer_orders', data: { external_id: latest.externalId, status: latest.status, total: latest.total?.amountMinor ?? null, created_at: latest.createdAt } });
            if (connection.permissions?.tracking) {
              const tracking = await callGateway<TrackingResult>('commerce.get_tracking', 'tracking', 'tracking.read', (c, ctx) =>
                c.getTracking(ctx, { kind: 'verified_customer', installationId: connection.installation_id, externalCustomerId, externalOrderId: latest.externalId }));
              if (tracking) results.push({ name: 'commerce.get_tracking', data: { carrier: tracking.carrier, tracking_number: tracking.trackingNumber, status: tracking.status } });
            }
          } else {
            results.push({ name: 'commerce.get_customer_orders', data: { error_code: 'order_not_found' } });
          }
        } else {
          const orderNumber = intent.kind === 'order_lookup' ? intent.orderNumber : '';
          const order = await callGateway<CommerceOrder>('commerce.get_order_status', 'order_status', 'orders.read', (c, ctx) =>
            c.getOrder(ctx, { kind: 'verified_customer', installationId: connection.installation_id, externalCustomerId, externalOrderId: orderNumber }));
          if (order) results.push({ name: 'commerce.get_order_status', data: { external_id: order.externalId, status: order.status, total: order.total?.amountMinor ?? null } });
        }
        break;
      }
    }

    return { toolResults: results, toolsUsed };
  } catch (err) {
    if (err instanceof CommerceError) return { toolResults: [{ name: 'commerce_status', data: { error_code: err.code } }], toolsUsed: [] };
    console.warn('[commerce-tools] stage failed:', err instanceof Error ? err.message : err);
    return empty;
  }
}
