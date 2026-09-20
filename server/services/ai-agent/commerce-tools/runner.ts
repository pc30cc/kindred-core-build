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
import { CommerceError, type CommerceErrorCode } from '../../../../shared/commerce/types.js';
import { getActiveConnectionForWorkspace, withCommerceConnector, assertPermission, assertCommerceModuleEntitled } from '../../commerce/gateway.js';
import { searchIndexedProducts, listIndexedCategories, type IndexedProductRow } from '../../commerce/productIndex.js';
import { detectCommerceIntent } from './intent.js';
import { MAX_COMMERCE_CALLS_PER_TURN, MAX_RESULTS_PER_TOOL, COMMERCE_TOOL_DEADLINE_MS } from './limits.js';

export interface CommerceStageInput {
  workspaceId: string;
  conversationId: string | null;
  question: string;
  correlationId?: string;
}

export interface CommerceStageResult {
  toolResults: ReadOnlyToolResult[];
  toolsUsed: string[];
}

function moneyToToman(amountMinor: number | null): string | null {
  if (amountMinor === null || amountMinor === undefined) return null;
  return String(amountMinor);
}

function productRowToToolData(row: IndexedProductRow): Record<string, unknown> {
  return {
    external_id: row.external_id,
    title: row.title,
    sku: row.sku,
    type: row.product_type,
    price: moneyToToman(row.effective_price_minor) ?? moneyToToman(row.regular_price_minor),
    currency: row.currency,
    stock_state: row.stock_state,
    stock_quantity: row.stock_quantity,
    url: row.canonical_url,
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
  try {
    const intent = detectCommerceIntent(input.question);
    if (intent.kind === 'none') return empty;

    const connection = await getActiveConnectionForWorkspace(config, input.workspaceId);
    if (!connection) return empty;
    await assertCommerceModuleEntitled(config, input.workspaceId); // plan gate — throws CommerceError, caught below

    const deadlineAt = Date.now() + COMMERCE_TOOL_DEADLINE_MS;
    const results: ReadOnlyToolResult[] = [];
    const toolsUsed: string[] = [];
    let calls = 0;

    const callGateway = async <T>(toolName: string, permission: Parameters<typeof assertPermission>[1], capability: any, fn: any): Promise<T | null> => {
      if (calls >= MAX_COMMERCE_CALLS_PER_TURN || Date.now() >= deadlineAt) return null;
      calls += 1;
      toolsUsed.push(toolName);
      try {
        return await withCommerceConnector(config, input.workspaceId, connection.id, {
          capability, permission, toolName, conversationId: input.conversationId, correlationId: input.correlationId,
        }, fn);
      } catch (err) {
        const code: CommerceErrorCode = err instanceof CommerceError ? err.code : 'commerce_invalid_response';
        results.push({ name: toolName, data: { error_code: code } });
        return null;
      }
    };

    if (!connection.catalog_ready) {
      results.push({ name: 'commerce_status', data: { error_code: 'catalog_syncing' } });
      return { toolResults: results, toolsUsed };
    }

    switch (intent.kind) {
      case 'store_info': {
        const info = await callGateway<any>('commerce.get_store_info', undefined as any, 'store.read', (c: any, ctx: any) => c.getStoreInfo(ctx));
        if (info) results.push({ name: 'commerce.get_store_info', data: { name: info.name, currency: info.currency, catalog_ready: info.catalogReady } });
        break;
      }
      case 'browse_products': {
        // "چی دارید؟" is a request to browse, not to search for a product
        // named "what". Deliberately NO text filter: the index returns the
        // most recently updated rows, which is the closest thing to "what we
        // sell" that the catalogue can answer without inventing a ranking.
        assertPermission(connection, 'products');
        const { rows, totalMatched } = await searchIndexedProducts(config, connection.id, { limit: MAX_RESULTS_PER_TOOL })
          .catch(() => ({ rows: [] as IndexedProductRow[], totalMatched: 0 }));
        for (const row of rows) results.push({ name: 'commerce.search_products', data: productRowToToolData(row) });
        results.push({ name: 'commerce.catalog_size', data: { total_products: totalMatched } });
        toolsUsed.push('commerce.browse_products');
        break;
      }
      case 'list_categories': {
        assertPermission(connection, 'products');
        const categories = await listIndexedCategories(config, connection.id).catch(() => []);
        if (!categories.length) {
          results.push({ name: 'commerce.list_categories', data: { error_code: 'no_categories' } });
        } else {
          for (const c of categories) {
            results.push({ name: 'commerce.list_categories', data: { category: c.name, product_count: c.productCount } });
          }
        }
        toolsUsed.push('commerce.list_categories');
        break;
      }
      case 'search_products': {
        assertPermission(connection, 'products'); // throws commerce_permission_denied if not granted — caught below
        const { rows } = await searchIndexedProducts(config, connection.id, intent.filters).catch(() => ({ rows: [] as IndexedProductRow[] }));
        const bounded = rows.slice(0, MAX_RESULTS_PER_TOOL);
        for (const row of bounded) results.push({ name: 'commerce.search_products', data: productRowToToolData(row) });
        toolsUsed.push('commerce.search_products');

        // Live revalidation of the top candidates before the AI states
        // price/stock as fact (spec §25) — never trust the index alone for
        // volatile fields.
        if (bounded.length && connection.permissions?.stock) {
          const ids = bounded.slice(0, 5).map((r) => r.external_id);
          const live = await callGateway<any[]>('commerce.get_product', 'stock', 'products.read', (c: any, ctx: any) => c.getProducts(ctx, ids));
          for (const p of live ?? []) {
            results.push({ name: 'commerce.get_product_live', data: { external_id: p.externalId, stock_state: p.stockState, price: p.effectivePrice?.amountMinor ?? null, currency: p.currency } });
          }
        }
        break;
      }
      case 'get_availability': {
        const { rows } = await searchIndexedProducts(config, connection.id, { text: intent.text, limit: 1 }).catch(() => ({ rows: [] as IndexedProductRow[] }));
        const top = rows[0];
        if (!top) {
          results.push({ name: 'commerce.get_availability', data: { error_code: 'product_not_found' } });
          break;
        }
        const avail = await callGateway<any>('commerce.get_availability', 'stock', 'availability.read', (c: any, ctx: any) => c.getAvailability(ctx, { productExternalId: top.external_id }));
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
          results.push({ name: 'commerce.order_lookup', data: { error_code: 'identity_required' } });
          break;
        }
        if (intent.kind === 'order_status') {
          const orders = await callGateway<any[]>('commerce.get_customer_orders', 'customer_history', 'orders.read', (c: any, ctx: any) =>
            c.getCustomerOrders(ctx, { kind: 'verified_customer', installationId: connection.installation_id, externalCustomerId, limit: 1 }));
          const latest = orders?.[0];
          if (latest) {
            results.push({ name: 'commerce.get_customer_orders', data: { external_id: latest.externalId, status: latest.status, total: latest.total?.amountMinor ?? null, created_at: latest.createdAt } });
            if (connection.permissions?.tracking) {
              const tracking = await callGateway<any>('commerce.get_tracking', 'tracking', 'tracking.read', (c: any, ctx: any) =>
                c.getTracking(ctx, { kind: 'verified_customer', installationId: connection.installation_id, externalCustomerId, externalOrderId: latest.externalId }));
              if (tracking) results.push({ name: 'commerce.get_tracking', data: { carrier: tracking.carrier, tracking_number: tracking.trackingNumber, status: tracking.status } });
            }
          } else {
            results.push({ name: 'commerce.get_customer_orders', data: { error_code: 'order_not_found' } });
          }
        } else {
          const order = await callGateway<any>('commerce.get_order_status', 'order_status', 'orders.read', (c: any, ctx: any) =>
            c.getOrder(ctx, { kind: 'verified_customer', installationId: connection.installation_id, externalCustomerId, externalOrderId: (intent as any).orderNumber }));
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
