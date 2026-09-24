/**
 * OpenCart connector — transport and normalization rules, without a store.
 * (The same connector against a REAL store: opencartLive.e2e.test.ts.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac, createHash } from 'node:crypto';

interface Sent { url: string; headers: Record<string, string>; body: string; timeoutMs?: number; maxResponseBytes?: number }
const sent: Sent[] = [];
let answers: Array<{ status: number; json: unknown; bytes?: number } | Error> = [];

vi.mock('../../../server/services/commerce/httpClient.js', () => ({
  commerceHttpRequest: async (req: Sent & { method: string }) => {
    sent.push({ url: req.url, headers: req.headers, body: req.body, timeoutMs: req.timeoutMs, maxResponseBytes: req.maxResponseBytes });
    const next = answers.shift();
    if (!next) throw new Error('no answer queued');
    if (next instanceof Error) throw next;
    return { bytes: 100, ...next };
  },
}));

const { OpenCartConnector, mapOpenCartError, openCartApiRoute } = await import('../../../server/services/commerce/connectors/opencart.js');
const { CommerceError } = await import('../../../shared/commerce/types.js');

const SECRET = 'secret-for-tests';
const INSTALLATION = '11111111-1111-4111-8111-111111111111';

function connector(version: string | null = '4.1.0.4', storeUrl = 'https://shop.example/') {
  return new OpenCartConnector({ origin: 'https://shop.example', storeUrl, externalStoreId: '2', installationId: INSTALLATION, secret: SECRET, platformVersion: version });
}

const ctx = (ms = 5_000) => ({ workspaceId: 'w', connectionId: 'c', installationId: INSTALLATION, capabilities: [], correlationId: 'corr', deadlineAt: Date.now() + ms });

beforeEach(() => {
  sent.length = 0;
  answers = [];
});

describe('the one signed route', () => {
  it('uses the 4.1 route with a `.` method and signs /opencart/v1/<op>', async () => {
    answers.push({ status: 200, json: { products: [], page: 1, has_more: false } });
    await connector().searchDirect(ctx(), { terms: ['mac'] }, {});
    const req = sent[0];
    expect(req.url).toBe('https://shop.example/index.php?route=extension/webyar/module/webyar.api&op=products%2Fsearch&store_id=2');
    const body = req.body;
    const expected = createHmac('sha256', SECRET).update([
      'webyar-commerce/1', 'POST', '/opencart/v1/products/search', INSTALLATION,
      req.headers['X-WebYar-Timestamp'], req.headers['X-WebYar-Nonce'], createHash('sha256').update(body).digest('hex'),
    ].join('\n')).digest('hex');
    expect(req.headers['X-WebYar-Signature']).toBe(expected);
    expect(JSON.parse(body)).toMatchObject({ store_id: '2', terms: ['mac'], page: 1, page_size: 5 });
    expect(req.maxResponseBytes).toBe(128 * 1024);
  });

  it('uses the 3.0 route shape for 3.x stores', () => {
    expect(openCartApiRoute('3.0.5.1')).toBe('extension/module/webyar/api');
    expect(openCartApiRoute('4.1.0.0')).toBe('extension/webyar/module/webyar.api');
    expect(openCartApiRoute(null)).toBe('extension/webyar/module/webyar.api');
  });

  it('keeps the store path of a sub-folder store', async () => {
    answers.push({ status: 200, json: { products: [] } });
    await connector('4.1.0.4', 'https://shop.example/store2/').searchDirect(ctx(), {}, {});
    expect(sent[0].url.startsWith('https://shop.example/store2/index.php?route=')).toBe(true);
  });

  it('refuses a store URL that is not on the approved origin', () => {
    expect(() => connector('4.1.0.4', 'https://elsewhere.example/')).toThrow(CommerceError);
  });

  it('passes the time left in the turn as the request timeout', async () => {
    answers.push({ status: 200, json: {} });
    await connector().searchDirect(ctx(1_200), {}, {});
    expect(sent[0].timeoutMs).toBeLessThanOrEqual(1_200);
  });

  it('never calls when the deadline has already passed', async () => {
    await expect(connector().searchDirect(ctx(-1), {}, {})).rejects.toMatchObject({ code: 'commerce_timeout' });
    expect(sent).toHaveLength(0);
  });

  it('caps the page size at 10 whatever is asked', async () => {
    answers.push({ status: 200, json: {} });
    await connector().searchDirect(ctx(), { pageSize: 500 }, {});
    expect(JSON.parse(sent[0].body).page_size).toBe(10);
  });
});

describe('retries: at most one, only for a transient failure, always re-signed', () => {
  it('retries a 500 once with a NEW nonce', async () => {
    answers.push({ status: 500, json: { error: 'internal_error' } }, { status: 200, json: { products: [] } });
    await connector().searchDirect(ctx(), {}, {});
    expect(sent).toHaveLength(2);
    expect(sent[0].headers['X-WebYar-Nonce']).not.toBe(sent[1].headers['X-WebYar-Nonce']);
  });

  it('retries a dropped connection once', async () => {
    answers.push(new CommerceError('commerce_live_unavailable', 'reset'), { status: 200, json: {} });
    await connector().searchDirect(ctx(), {}, {});
    expect(sent).toHaveLength(2);
  });

  it('gives up after the second failure', async () => {
    answers.push({ status: 502, json: {} }, { status: 502, json: {} }, { status: 200, json: {} });
    await expect(connector().searchDirect(ctx(), {}, {})).rejects.toMatchObject({ code: 'commerce_live_unavailable' });
    expect(sent).toHaveLength(2);
  });

  it.each([
    [401, 'bad_signature', 'commerce_permission_denied'],
    [401, 'identity_session_ended', 'identity_expired'],
    [403, 'disabled_by_store', 'commerce_permission_denied'],
    [404, 'order_not_found', 'order_not_found'],
    [422, 'invalid_request', 'commerce_invalid_response'],
    [503, 'extension_disabled', 'commerce_not_connected'],
  ])('does not retry %i %s → %s', async (status, error, code) => {
    answers.push({ status, json: { error } }, { status: 200, json: {} });
    await expect(connector().searchDirect(ctx(), {}, {})).rejects.toMatchObject({ code });
    expect(sent).toHaveLength(1);
  });

  it('does not retry a timeout', async () => {
    answers.push(new CommerceError('commerce_timeout', 'slow'), { status: 200, json: {} });
    await expect(connector().searchDirect(ctx(), {}, {})).rejects.toMatchObject({ code: 'commerce_timeout' });
    expect(sent).toHaveLength(1);
  });
});

describe('what comes back is data, bounded and store-bound', () => {
  it('drops links that do not point at the store itself', async () => {
    answers.push({ status: 200, json: { products: [
      { id: '1', name: 'Good', url: 'https://shop.example/index.php?route=product/product&product_id=1', image: 'https://evil.example/x.png', stock: { state: 'in_stock' } },
      { id: '2', name: 'Bad', url: 'javascript:alert(1)', stock: { state: 'weird' } },
    ] } });
    const r = await connector().searchDirect(ctx(), {}, {});
    expect(r.products[0].url).toContain('https://shop.example/');
    expect(r.products[0].imageUrl).toBeNull();
    expect(r.products[1].url).toBeNull();
    expect(r.products[1].stock.state).toBe('unknown');
  });

  it('passes the store-formatted price through untouched', async () => {
    answers.push({ status: 200, json: { products: [{ id: '40', name: 'آیفون', price: { amount: '6160000', currency: 'IRT', formatted: '6,160,000 تومان', tax_included: true }, stock: { state: 'in_stock' } }] } });
    const r = await connector().searchDirect(ctx(), {}, {});
    expect(r.products[0].price).toEqual({ amount: '6160000', currency: 'IRT', formatted: '6,160,000 تومان', taxIncluded: true });
  });

  it('strips markup from merchant text', async () => {
    answers.push({ status: 200, json: { products: [{ id: '1', name: '<b>Mac</b><script>x</script>', stock: {} }] } });
    const r = await connector().searchDirect(ctx(), {}, {});
    expect(r.products[0].name).not.toMatch(/[<>]/);
  });

  it('sends the signed-in customer reference only in the signed body', async () => {
    answers.push({ status: 200, json: { orders: [] } });
    await connector().listOrders(ctx(), { externalCustomerId: '101', sessionRef: 'opaque' }, 1, {});
    expect(JSON.parse(sent[0].body).customer).toEqual({ id: '101', session_ref: 'opaque' });
    expect(sent[0].url).not.toContain('opaque');
  });

  it('refuses a private read without a customer reference, without calling', async () => {
    await expect(connector().listOrders(ctx(), { externalCustomerId: '', sessionRef: '' }, 1, {})).rejects.toMatchObject({ code: 'identity_required' });
    expect(sent).toHaveLength(0);
  });

  it('refuses a malformed order id before calling', async () => {
    await expect(connector().getOrderDetail(ctx(), { externalCustomerId: '1', sessionRef: 'r' }, '12 OR 1=1', {})).rejects.toMatchObject({ code: 'order_not_found' });
    expect(sent).toHaveLength(0);
  });

  it('never claims tracking the store did not supply', async () => {
    answers.push({ status: 200, json: { order_id: '5001', available: true, shipments: [] } });
    const t = await connector().getTrackingDirect(ctx(), { externalCustomerId: '1', sessionRef: 'r' }, '5001', {});
    expect(t.available).toBe(false);
  });

  it('reports the store-side cost of each call', async () => {
    const metas: unknown[] = [];
    answers.push({ status: 200, json: { products: [], _meta: { db: { queries: 3 }, ms: 4.2 } }, bytes: 321 });
    await connector().searchDirect(ctx(), {}, { onMeta: (m) => metas.push(m) });
    expect(metas).toEqual([{ storeQueries: 3, storeMs: 4.2, responseBytes: 321 }]);
  });

  it('refuses the generic order lookups, which carry no session reference', async () => {
    const c = connector();
    await expect(c.getOrder(ctx(), { kind: 'verified_customer', installationId: INSTALLATION, externalCustomerId: '1', externalOrderId: '2' })).rejects.toMatchObject({ code: 'identity_required' });
    await expect(c.verifyOrderContactMatch()).rejects.toMatchObject({ code: 'commerce_permission_denied' });
  });
});

describe('error mapping', () => {
  it('maps identity errors to identity codes, never to a data error', () => {
    expect(mapOpenCartError(401, 'identity_required')).toBe('identity_required');
    expect(mapOpenCartError(401, 'identity_invalid')).toBe('identity_expired');
    expect(mapOpenCartError(403, 'account_disabled')).toBe('order_access_denied');
    expect(mapOpenCartError(404, 'unknown_operation')).toBe('connector_outdated');
    expect(mapOpenCartError(500, 'x')).toBe('commerce_live_unavailable');
  });
});

describe('signing is byte-identical to the PHP extension', () => {
  it('reproduces the shared vector (plugins/webyar-opencart/tests/fixtures/signing-vector.json)', async () => {
    const { readFileSync } = await import('node:fs');
    const { computeSignature, sha256Hex } = await import('../../../server/services/commerce/signing.js');
    const v = JSON.parse(readFileSync('plugins/webyar-opencart/tests/fixtures/signing-vector.json', 'utf8'));
    expect(computeSignature(v.secret, {
      protocolVersion: v.protocolVersion, method: v.method, canonicalPath: v.canonicalPath, installationId: v.installationId,
      timestamp: v.timestamp, nonce: v.nonce, bodySha256Hex: sha256Hex(v.body),
    })).toBe(v.expectedSignature);
  });
});

describe('self-update (1.1.0+)', () => {
  const withUpdate = (ms = 5_000) => ({ ...ctx(ms), capabilities: ['connector.update'] as never[] });

  it('compares versions strictly and ignores malformed ones', async () => {
    const { isOlderConnector } = await import('../../../server/services/commerce/connectors/opencart.js');
    expect(isOlderConnector('1.0.0', '1.1.0')).toBe(true);
    expect(isOlderConnector('1.1.0', '1.1.0')).toBe(false);
    expect(isOlderConnector('1.10.0', '1.9.0')).toBe(false);
    expect(isOlderConnector('0.9.9', '1.0.0')).toBe(true);
    expect(isOlderConnector('1.0', '1.1.0')).toBe(false);
    expect(isOlderConnector(null, '1.1.0')).toBe(false);
  });

  it('asks an older store that can update itself — once per interval, in the background', async () => {
    const { claimUpdateNudge } = await import('../../../server/services/commerce/connectors/opencart.js');
    const installation = 'aaaaaaaa-1111-4111-8111-111111111111';
    const c = new OpenCartConnector({ origin: 'https://shop.example', storeUrl: 'https://shop.example/', externalStoreId: '2', installationId: installation, secret: SECRET, platformVersion: '4.1.0.4' });
    answers.push({ status: 200, json: { categories: [], _meta: { connector_version: '1.0.0' } } });
    answers.push({ status: 200, json: { status: 'updated', from: '1.0.0', to: '1.1.0' } });
    await c.listCategories(withUpdate(), {});
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.map((s) => s.url.match(/op=([^&]+)/)?.[1])).toEqual(['catalog%2Fcategories', 'connector%2Fupdate']);
    expect(sent[1].headers['X-WebYar-Signature']).toMatch(/^[a-f0-9]{64}$/);
    expect(sent[1].timeoutMs).toBeGreaterThan(30_000);
    expect(claimUpdateNudge(installation)).toBe(false);
  });

  it('does not ask when the store is current or cannot update itself', async () => {
    answers.push({ status: 200, json: { categories: [], _meta: { connector_version: '1.1.0' } } });
    answers.push({ status: 200, json: { categories: [], _meta: { connector_version: '1.0.0' } } });
    await connector().listCategories(withUpdate(), {});
    await connector().listCategories(ctx(), {});
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(2);
  });

  it('reports what the store did', async () => {
    answers.push({ status: 200, json: { status: 'up_to_date', from: '1.1.0', to: null } });
    await expect(connector().requestSelfUpdate(ctx())).resolves.toEqual({ status: 'up_to_date', from: '1.1.0', to: null });
  });
});
