/**
 * The WooCommerce adapter's optional order-card fields: item_summary /
 * item_count on the customer's order list and estimatedDelivery on tracking.
 * No plugin build sends them yet, so an answer without them must map to
 * exactly the object it always did (no new keys at all).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let answers: Array<{ status: number; json: unknown }> = [];
vi.mock('../../../server/services/commerce/httpClient.js', () => ({
  commerceHttpRequest: async () => {
    const next = answers.shift();
    if (!next) throw new Error('no answer queued');
    return { bytes: 10, ...next };
  },
}));

const { WooCommerceConnector } = await import('../../../server/services/commerce/connectors/woocommerce.js');

const INSTALL = '11111111-1111-4111-8111-111111111111';
const ctx = () => ({ workspaceId: 'w', connectionId: 'c', installationId: INSTALL, capabilities: [] as never[], correlationId: 'corr', deadlineAt: Date.now() + 5_000 });
const woo = () => new WooCommerceConnector({ origin: 'https://shop.example', installationId: INSTALL, secret: 's' });
const customer = { kind: 'verified_customer' as const, installationId: INSTALL, externalCustomerId: '7', limit: 1 };
const lookup = { kind: 'verified_customer' as const, installationId: INSTALL, externalCustomerId: '7', externalOrderId: '48213' };

beforeEach(() => { answers = []; });

describe('getCustomerOrders', () => {
  it('without the optional fields: exactly the old object', async () => {
    answers.push({ status: 200, json: { orders: [{ external_id: '48213', status: 'processing', currency: 'IRT', total: '2450000', created_at: '2026-10-15T10:00:00Z' }] } });
    const [o] = await woo().getCustomerOrders(ctx(), customer);
    expect(Object.keys(o)).toEqual(['externalId', 'status', 'total', 'createdAt']);
  });

  it('with them: the summary sanitized and capped, the count only alongside a summary', async () => {
    answers.push({ status: 200, json: { orders: [
      { external_id: '1', status: 'processing', currency: 'IRT', total: '1', item_summary: `<b>کفش</b> ${'x'.repeat(120)}`, item_count: 3 },
      { external_id: '2', status: 'processing', currency: 'IRT', total: '1', item_summary: 'Hat', item_count: 'lots' },
      { external_id: '3', status: 'processing', currency: 'IRT', total: '1', item_count: 4 },
    ] } });
    const [a, b, c] = await woo().getCustomerOrders(ctx(), { ...customer, limit: 3 });
    expect(a.itemSummary?.startsWith('کفش x')).toBe(true);
    expect(a.itemSummary?.length).toBeLessThanOrEqual(81);
    expect(a.itemCount).toBe(3);
    expect(b).toMatchObject({ itemSummary: 'Hat' });
    expect(b).not.toHaveProperty('itemCount');
    expect(c).not.toHaveProperty('itemSummary');
    expect(c).not.toHaveProperty('itemCount');
  });
});

describe('getTracking', () => {
  it('without estimatedDelivery: no new key', async () => {
    answers.push({ status: 200, json: { carrier: 'Post', trackingNumber: 'RR1', trackingUrl: 'https://t.example/1', status: 'x' } });
    const t = await woo().getTracking(ctx(), lookup);
    expect(t).not.toHaveProperty('estimatedDelivery');
  });

  it('reads either spelling', async () => {
    answers.push({ status: 200, json: { carrier: 'Post', estimatedDelivery: '2026-10-23' } });
    answers.push({ status: 200, json: { carrier: 'Post', estimated_delivery: '2026-10-24T12:00:00Z' } });
    expect((await woo().getTracking(ctx(), lookup)).estimatedDelivery).toBe('2026-10-23');
    expect((await woo().getTracking(ctx(), lookup)).estimatedDelivery).toBe('2026-10-24T12:00:00Z');
  });
});
