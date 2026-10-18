/**
 * The order card on the WooCommerce commerce stage (runner.ts): a verified
 * customer's order turn gets a card built from the objects the stage already
 * fetched, and the evidence handed to the model (tool results, so the prompt
 * and the reply text), the tools used and the store calls stay exactly what
 * they were before the card existed.
 *
 * The stage, intent detection and permission checks are the real code; only
 * the store, the identity link and the plan gate are stand-ins.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ServerConfig } from '../../../server/config.js';
import type { CommerceOrder, CommerceOrderSummary, TrackingResult } from '../../../shared/commerce/types.js';

const WS = 'ws-woo';
const CONV = 'conv-woo';

const CONNECTION = {
  id: 'conn-woo', workspace_id: WS, installation_id: 'inst-woo', provider_type: 'woocommerce',
  store_id: 'https://shop.example', approved_origin: 'https://shop.example',
  capabilities: ['store.read', 'products.read', 'orders.read', 'tracking.read'],
  permissions: { orders: true, customer_history: true, order_status: true, tracking: true, products: true } as Record<string, boolean>,
  health: 'connected', catalog_ready: true, revoked_at: null, protocol_version: 'webyar-commerce/1',
};

let connection = { ...CONNECTION };
let verified = true;
let latest: CommerceOrderSummary | null = null;
let order: CommerceOrder | null = null;
let tracking: TrackingResult | null = null;
let failWith: string | null = null;
const storeCalls: string[] = [];

function linkClient() {
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gte', 'order', 'limit', 'in', 'is']) builder[m] = () => builder;
  builder.maybeSingle = async () => ({ data: verified ? { external_customer_id: 'cust-1', expires_at: new Date(Date.now() + 60_000).toISOString() } : null, error: null });
  return { from: () => builder, rpc: async () => ({ data: null, error: null }) };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => linkClient() }));
vi.mock('../../../server/services/commerce/conversationVisitor.js', () => ({
  resolveConversationVisitor: async () => ({ visitorId: 'visitor-1', metadata: {} }),
}));
vi.mock('../../../server/services/commerce/audit.js', () => ({ recordCommerceToolAudit: async () => {}, flushCommerceToolAudit: async () => {} }));
vi.mock('../../../server/services/commerce/gateway.js', async (orig) => {
  const real = await orig<typeof import('../../../server/services/commerce/gateway.js')>();
  const { CommerceError } = await import('../../../shared/commerce/types.js');
  return {
    ...real,
    resolveConversationConnection: async () => connection,
    assertCommerceModuleEntitled: async () => {},
    withCommerceConnector: async (_c: unknown, _w: string, _id: string, opts: { toolName: string }, fn: (connector: unknown, ctx: unknown) => unknown) => {
      storeCalls.push(opts.toolName);
      if (failWith) throw new CommerceError(failWith as never, 'scripted');
      const connector = {
        getCustomerOrders: async () => (latest ? [latest] : []),
        getTracking: async () => tracking,
        getOrder: async () => {
          if (!order) throw new CommerceError('order_not_found', 'nope');
          return order;
        },
      };
      return fn(connector, { correlationId: 'test' });
    },
  };
});

const { runCommerceToolStage } = await import('../../../server/services/ai-agent/commerce-tools/runner.js');
const CONFIG = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } as unknown as ServerConfig;
const ask = (question: string) => runCommerceToolStage(CONFIG, { workspaceId: WS, conversationId: CONV, question });

const money = { amountMinor: '2450000', currency: 'IRT' };

beforeEach(() => {
  connection = { ...CONNECTION, permissions: { ...CONNECTION.permissions } };
  verified = true;
  failWith = null;
  storeCalls.length = 0;
  latest = { externalId: '48213', status: 'processing', total: money, createdAt: '2026-10-15T10:00:00Z' };
  tracking = { externalOrderId: '48213', carrier: 'Post', trackingNumber: 'RR123IR', trackingUrl: 'https://tracking.post.ir/?id=RR123IR', status: 'in transit', updatedAt: null };
  order = {
    externalId: '48213', status: 'completed', currency: 'IRT', total: money, createdAt: '2026-10-15T10:00:00Z', updatedAt: '2026-10-16T10:00:00Z',
    lineItems: [{ productExternalId: '11', title: 'کفش رانینگ، سایز ۴۲', quantity: 1, total: money }, { productExternalId: '12', title: 'جوراب', quantity: 2, total: money }],
    maskedContact: { email: null, phone: null },
  };
});

describe('order_status (the latest order) for a verified customer', () => {
  it('builds the card from the order and the tracking it read', async () => {
    const r = await ask('پیگیری سفارشم');
    expect(r.orderCard).toEqual({
      v: 1, number: '48213', summary: null, more: 0, status: 'shipped', statusLabel: null, step: 2, arrives: null,
      trackingUrl: 'https://tracking.post.ir/?id=RR123IR',
    });
  });

  it('leaves the evidence, the tools used and the store calls exactly as before', async () => {
    const r = await ask('پیگیری سفارشم');
    // The pre-card shape, byte for byte: no card field reaches the model.
    expect(r.toolResults).toEqual([
      { name: 'commerce.get_customer_orders', data: { external_id: '48213', status: 'processing', total: '2450000', created_at: '2026-10-15T10:00:00Z' } },
      { name: 'commerce.get_tracking', data: { carrier: 'Post', tracking_number: 'RR123IR', status: 'in transit' } },
    ]);
    expect(r.toolsUsed).toEqual(['commerce.get_customer_orders', 'commerce.get_tracking']);
    expect(storeCalls).toEqual(['commerce.get_customer_orders', 'commerce.get_tracking']);
    expect(Object.keys(r).sort()).toEqual(['orderCard', 'toolResults', 'toolsUsed']);
  });

  it('the plugin’s optional item line and delivery day reach the card only', async () => {
    latest = { ...latest!, itemSummary: 'کفش رانینگ', itemCount: 3 };
    tracking = { ...tracking!, estimatedDelivery: '2026-10-23' };
    const r = await ask('Track my order');
    expect(r.orderCard).toMatchObject({ summary: 'کفش رانینگ', more: 2, arrives: '2026-10-23' });
    expect(JSON.stringify(r.toolResults)).not.toMatch(/کفش|2026-10-23|item/);
  });

  it('without the tracking permission: no tracking call, a processing card without a link', async () => {
    connection.permissions.tracking = false;
    const r = await ask('Siparişimi takip et');
    expect(storeCalls).toEqual(['commerce.get_customer_orders']);
    expect(r.orderCard).toMatchObject({ status: 'processing', step: 1, trackingUrl: null });
  });

  it('a failed tracking call still gives the order’s own card', async () => {
    tracking = null;
    const r = await ask('پیگیری سفارشم');
    expect(r.orderCard).toMatchObject({ status: 'processing', step: 1, trackingUrl: null });
  });
});

describe('order_lookup (an order by number) for a verified customer', () => {
  it('builds the card from the order’s own lines, with no extra store call', async () => {
    const r = await ask('وضعیت سفارش ۴۸۲۱۳');
    expect(storeCalls).toEqual(['commerce.get_order_status']);
    expect(r.toolResults).toEqual([
      { name: 'commerce.get_order_status', data: { external_id: '48213', status: 'completed', total: '2450000' } },
    ]);
    expect(r.orderCard).toEqual({
      v: 1, number: '48213', summary: 'کفش رانینگ، سایز ۴۲', more: 1, status: 'completed', statusLabel: null, step: 3, arrives: null, trackingUrl: null,
    });
  });
});

describe('no card', () => {
  it('for an unverified visitor (identity_required)', async () => {
    verified = false;
    const r = await ask('پیگیری سفارشم');
    expect(r.toolResults[0]).toMatchObject({ data: { error_code: 'identity_required' } });
    expect(r).not.toHaveProperty('orderCard');
  });

  it('when the customer has no order (order_not_found)', async () => {
    latest = null;
    const r = await ask('پیگیری سفارشم');
    expect(r.toolResults[0]).toMatchObject({ data: { error_code: 'order_not_found' } });
    expect(r).not.toHaveProperty('orderCard');
  });

  it('when the store refuses (permission denied)', async () => {
    failWith = 'commerce_permission_denied';
    const r = await ask('وضعیت سفارش ۴۸۲۱۳');
    expect(r.toolResults[0]).toMatchObject({ data: { error_code: 'commerce_permission_denied' } });
    expect(r).not.toHaveProperty('orderCard');
  });

  it('when the owner switched orders off', async () => {
    connection.permissions.orders = false;
    const r = await ask('پیگیری سفارشم');
    expect(storeCalls).toEqual([]);
    expect(r).not.toHaveProperty('orderCard');
  });

  it('when the order number is not a plain one', async () => {
    latest = { ...latest!, externalId: '48213 OR 1=1' };
    expect(await ask('پیگیری سفارشم')).not.toHaveProperty('orderCard');
  });

  it('for a question that is not about an order', async () => {
    expect(await ask('ساعت کاری فروشگاه چیه؟')).not.toHaveProperty('orderCard');
  });
});
