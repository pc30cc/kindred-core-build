/**
 * Adding WHMCS must not change what a WooCommerce workspace does, and a WHMCS
 * connection must come out of the same pairing flow with the shape the live
 * query path relies on. Real pairing, gateway and link-verifier code; only the
 * database, the secret store and the wire are faked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createFakeDb, type FakeDb } from './support/fakeSupabase';
import { createFakeWhmcs, BASE, ORIGIN, type FakeWhmcs } from './support/fakeWhmcs';
import type { CommerceHttpRequest, CommerceHttpResponse } from '../../../server/services/commerce/httpClient.js';

const WS = '6ee40d07-32a3-4594-8a5f-d439f81afa5b';
const SHOP = 'https://shop.example.com';

let db: FakeDb;
let whmcs: FakeWhmcs;
let wire: (req: CommerceHttpRequest) => Promise<CommerceHttpResponse>;
/** What Web Yar holds for the installation; WHMCS holds `whmcs.secret`. */
let webyarSecret: string;
const installed: Array<{ workspaceId: string; pluginId: string }> = [];

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => db.client }));
vi.mock('../../../shared/net/hostGuard.js', () => ({ checkOutboundUrl: async () => ({ ok: true }) }));
vi.mock('../../../server/services/commerce/audit.js', () => ({ writeCommerceAudit: async () => {} }));
vi.mock('../../../server/services/plugins/state.js', () => ({
  installPlugin: async (_c: unknown, workspaceId: string, pluginId: string) => {
    installed.push({ workspaceId, pluginId });
    return { id: `inst-${pluginId}` };
  },
}));
vi.mock('../../../server/services/commerce/credentials.js', () => ({
  storeInstallationSecret: async () => {},
  readInstallationSecret: async () => webyarSecret,
}));
vi.mock('../../../server/services/commerce/httpClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  commerceHttpRequest: (req: CommerceHttpRequest) => wire(req),
}));

const pairing = await import('../../../server/services/commerce/pairing.js');
const { getActiveConnectionForWorkspace } = await import('../../../server/services/commerce/gateway.js');
const { verifyStoreLinks } = await import('../../../server/services/ai-agent/commerce-tools/answerLinks.js');
const { WooCommerceConnector } = await import('../../../server/services/commerce/connectors/woocommerce.js');
const CONFIG = {} as Parameters<typeof pairing.registerPairingRequest>[0];

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = b64url(createHash('sha256').update(VERIFIER).digest());

async function pair(provider: 'woocommerce' | 'whmcs', origin: string, storeBaseUrl?: string) {
  const state = `state-${provider}-0123456789`;
  await pairing.registerPairingRequest(CONFIG, {
    state, codeChallenge: CHALLENGE, redirectUri: `${origin}/callback`, storeOrigin: origin, provider, storeBaseUrl,
  });
  const { redirectUrl } = await pairing.approvePairingRequest(CONFIG, { state, workspaceId: WS, userId: 'user-1', permissions: {} });
  const code = new URL(redirectUrl).searchParams.get('code') as string;
  return pairing.exchangePairingCode(CONFIG, { state, code, codeVerifier: VERIFIER });
}

beforeEach(() => {
  db = createFakeDb({});
  installed.length = 0;
  whmcs = createFakeWhmcs('whmcs-secret-for-pairing-tests', 'inst-whmcs');
  webyarSecret = whmcs.secret;
  wire = (req) => whmcs.requester(req);
});

describe('pairing a WHMCS install', () => {
  it('records the base URL, installs the whmcs plugin, and starts with only the catalog enabled', async () => {
    const out = await pair('whmcs', ORIGIN, `${BASE}/`);
    expect(out).toMatchObject({ providerType: 'whmcs', usesCatalogIndex: false, storeId: BASE });
    expect(installed).toEqual([{ workspaceId: WS, pluginId: 'whmcs' }]);
    const conn = db.tables.commerce_connections[0];
    expect(conn).toMatchObject({ provider_type: 'whmcs', store_id: BASE, approved_origin: ORIGIN, catalog_ready: false });
    expect(conn.permissions).toEqual({ announcements: false, knowledgebase: false, networkstatus: false, catalog: true, services: false, domains: false, invoices: false, orders: false, tickets: false });
    // Nothing queued for a live-queried provider.
    expect(db.tables.commerce_sync_jobs ?? []).toEqual([]);
  });

  it('refuses a base URL on another origin or with a query, and an unknown provider', async () => {
    const reg = (over: Record<string, unknown>) => pairing.registerPairingRequest(CONFIG, {
      state: 'state-bad-0123456789', codeChallenge: CHALLENGE, redirectUri: `${ORIGIN}/cb`, storeOrigin: ORIGIN, provider: 'whmcs', ...over,
    });
    await expect(reg({ storeBaseUrl: 'https://evil.example.net/whmcs' })).rejects.toMatchObject({ code: 'invalid_base_url' });
    await expect(reg({ storeBaseUrl: `${BASE}?x=1` })).rejects.toMatchObject({ code: 'invalid_base_url' });
    await expect(reg({ storeBaseUrl: `${ORIGIN}/bill ing` })).rejects.toMatchObject({ code: 'invalid_base_url' });
    await expect(reg({ storeBaseUrl: 'https://user:pw@billing.example.com/whmcs' })).rejects.toMatchObject({ code: 'invalid_base_url' });
    await expect(reg({ provider: 'magento' })).rejects.toMatchObject({ code: 'invalid_provider' });
    expect(db.tables.commerce_pairing_requests ?? []).toEqual([]);
  });

  it('the handshake records the WHMCS version and never touches WooCommerce columns', async () => {
    const out = await pair('whmcs', ORIGIN, BASE);
    await pairing.runCapabilityHandshake(CONFIG, out.connectionId, { workspaceId: WS });
    const conn = db.tables.commerce_connections[0];
    expect(conn).toMatchObject({ health: 'connected', platform_version: '8.13.1', connector_version: '1.0.0' });
    expect(conn).not.toHaveProperty('woocommerce_version');
    expect(conn).not.toHaveProperty('hpos_enabled');
    expect(whmcs.calls.map((c) => c.op)).toEqual(['health']);
  });

  it('a WHMCS that refuses the signature is an authentication problem, not an outage', async () => {
    const out = await pair('whmcs', ORIGIN, BASE);
    whmcs.secret = 'rotated-on-the-whmcs-side';
    await pairing.runCapabilityHandshake(CONFIG, out.connectionId);
    expect(db.tables.commerce_connections[0]).toMatchObject({ health: 'authentication_error', last_error_code: 'commerce_permission_denied' });
  });

  it('the handshake is scoped to the caller’s workspace', async () => {
    const out = await pair('whmcs', ORIGIN, BASE);
    await pairing.runCapabilityHandshake(CONFIG, out.connectionId, { workspaceId: '11111111-1111-1111-1111-111111111111' });
    expect(whmcs.calls).toEqual([]);
    expect(db.tables.commerce_connections[0].health).toBe('reconnecting');
  });
});

describe('WooCommerce is unchanged when WHMCS is also connected', () => {
  it('a WooCommerce pairing writes exactly the columns it always did', async () => {
    const out = await pair('woocommerce', SHOP, `${SHOP}/ignored`);
    expect(out).toMatchObject({ providerType: 'woocommerce', usesCatalogIndex: true, storeId: SHOP });
    expect(db.tables.commerce_pairing_requests[0]).not.toHaveProperty('requested_base_url');
    const conn = db.tables.commerce_connections[0];
    expect(conn).not.toHaveProperty('permissions');
    expect(installed).toEqual([{ workspaceId: WS, pluginId: 'woocommerce' }]);
  });

  it('each family resolves to its own connection, whichever was paired last', async () => {
    await pair('woocommerce', SHOP);
    await pair('whmcs', ORIGIN, BASE);
    for (const row of db.tables.commerce_connections) row.health = 'connected';
    expect((await getActiveConnectionForWorkspace(CONFIG, WS, { family: 'store' }))?.provider_type).toBe('woocommerce');
    expect((await getActiveConnectionForWorkspace(CONFIG, WS, { family: 'billing' }))?.provider_type).toBe('whmcs');
    // Default family is the shop, as every pre-WHMCS caller expects.
    expect((await getActiveConnectionForWorkspace(CONFIG, WS))?.provider_type).toBe('woocommerce');
  });

  it('the store link verifier checks shop links against the shop and leaves billing links alone', async () => {
    await pair('woocommerce', SHOP);
    await pair('whmcs', ORIGIN, BASE);
    db.tables.commerce_products = [{ connection_id: db.tables.commerce_connections[0].id, workspace_id: WS, canonical_url: `${SHOP}/product/real/`, external_id: '1' }];
    const invoice = `${BASE}/viewinvoice.php?id=1001`;
    const text = `Pay here: ${invoice} or buy ${SHOP}/product/invented/`;
    const out = await verifyStoreLinks(CONFIG, WS, text);
    expect(out).toContain(invoice);
    expect(out).not.toContain('/product/invented/');
  });

  it('with only WHMCS connected, the store link verifier changes nothing', async () => {
    await pair('whmcs', ORIGIN, BASE);
    const text = `Your invoice: ${BASE}/viewinvoice.php?id=1001`;
    expect(await verifyStoreLinks(CONFIG, WS, text)).toBe(text);
  });
});

describe('WooCommerce tracking payload', () => {
  it('reads the keys TrackingResolver actually sends (camelCase), and still accepts snake_case', async () => {
    const woo = new WooCommerceConnector({ origin: SHOP, installationId: 'inst-woo', secret: 'woo-secret' });
    const ctx = { workspaceId: WS, connectionId: 'c', installationId: 'inst-woo', capabilities: [], correlationId: 't', deadlineAt: Date.now() + 5000 };
    const auth = { kind: 'verified_customer' as const, installationId: 'inst-woo', externalCustomerId: '7', externalOrderId: '100' };

    wire = async () => ({ status: 200, json: { found: true, carrier: 'Post', trackingNumber: 'RR123', trackingUrl: 'https://track.example.com/RR123', status: 'completed', updatedAt: '2026-09-20T10:00:00+00:00' } });
    expect(await woo.getTracking(ctx, auth)).toMatchObject({ carrier: 'Post', trackingNumber: 'RR123', trackingUrl: 'https://track.example.com/RR123', updatedAt: '2026-09-20T10:00:00+00:00' });

    wire = async () => ({ status: 200, json: { found: true, tracking_number: 'RR456', tracking_url: 'https://track.example.com/RR456' } });
    expect(await woo.getTracking(ctx, auth)).toMatchObject({ trackingNumber: 'RR456', trackingUrl: 'https://track.example.com/RR456' });
  });

  it('a refused order is not found, never someone else’s tracking', async () => {
    const woo = new WooCommerceConnector({ origin: SHOP, installationId: 'inst-woo', secret: 'woo-secret' });
    const ctx = { workspaceId: WS, connectionId: 'c', installationId: 'inst-woo', capabilities: [], correlationId: 't', deadlineAt: Date.now() + 5000 };
    wire = async () => ({ status: 404, json: { found: false } });
    await expect(woo.getTracking(ctx, { kind: 'verified_customer', installationId: 'inst-woo', externalCustomerId: '7', externalOrderId: '200' })).rejects.toBeTruthy();
  });
});
