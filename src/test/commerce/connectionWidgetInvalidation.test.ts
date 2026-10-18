/**
 * The connection changes that decide the widget's track-order row publish
 * `widget:<workspace>` (configSnapshot.ts getStoreOrders drops its answer):
 * disconnect, a permission change, pairing, and a handshake that changes a
 * store's health. A heartbeat handshake that changes nothing publishes
 * nothing (no snapshot rebuild every heartbeat).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { createCountingSupabase } from './helpers/countingSupabase';
import type { ServerConfig } from '../../../server/config.js';

const fake = createCountingSupabase();
const published: string[][] = [];

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fake.client }));
vi.mock('../../../server/lib/cacheBus.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/lib/cacheBus.js')>()),
  publishCacheInvalidation: (scopes: string[]) => { published.push([...scopes]); },
}));
vi.mock('../../../shared/net/hostGuard.js', () => ({ checkOutboundUrl: async () => ({ ok: true }) }));
vi.mock('../../../server/services/plugins/state.js', () => ({
  installPlugin: async () => ({ id: 'inst-1' }),
  setInstallationStatus: async () => {},
}));
vi.mock('../../../server/services/commerce/credentials.js', () => ({
  storeInstallationSecret: async () => {},
  readInstallationSecret: async () => null,
  revokeInstallationSecrets: async () => {},
  rotateInstallationSecret: async () => 'x',
}));
vi.mock('../../../server/services/commerce/audit.js', () => ({ writeCommerceAudit: async () => {} }));

const { registerPairingRequest, approvePairingRequest, exchangePairingCode, runCapabilityHandshake } = await import('../../../server/services/commerce/pairing.js');
const { disconnectConnection, updateConnectionPermissions } = await import('../../../server/services/commerce/lifecycle.js');
const CONFIG = {} as ServerConfig;
const WS = 'ws-shop';

const verifier = 'v'.repeat(64);
const challenge = createHash('sha256').update(verifier).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function connection(extra: Record<string, unknown> = {}) {
  return {
    id: 'conn-1', workspace_id: WS, installation_id: 'inst-1', provider_type: 'woocommerce', store_id: 'https://shop.example',
    approved_origin: 'https://shop.example', capabilities: ['orders.read'], permissions: { orders: true }, health: 'connected',
    catalog_ready: true, revoked_at: null, protocol_version: 'webyar-commerce/1', external_store_id: null, platform_version: null,
    ...extra,
  };
}

beforeEach(() => {
  published.length = 0;
  fake.db.commerce_pairing_requests = [];
  fake.db.commerce_connections = [connection()];
  fake.db.commerce_sync_jobs = [];
});

describe('lifecycle', () => {
  it('a disconnect publishes widget:<ws>', async () => {
    await disconnectConnection(CONFIG, WS, 'conn-1', 'user-1');
    expect(fake.db.commerce_connections[0]).toMatchObject({ health: 'disconnected' });
    expect(published).toContainEqual([`widget:${WS}`]);
  });

  it('a permission change publishes widget:<ws>', async () => {
    await updateConnectionPermissions(CONFIG, WS, 'conn-1', 'user-1', { orders: false });
    expect(published).toEqual([[`widget:${WS}`]]);
  });

  it('nothing to disconnect: nothing published', async () => {
    await disconnectConnection(CONFIG, WS, 'conn-unknown', 'user-1');
    expect(published).toEqual([]);
  });
});

describe('pairing', () => {
  it('the code exchange publishes widget:<ws> once the connection row is written', async () => {
    fake.db.commerce_connections = [];
    const state = 'p'.repeat(20);
    await registerPairingRequest(CONFIG, { state, codeChallenge: challenge, redirectUri: 'https://shop.example/wp-admin/admin.php?page=webyar', storeOrigin: 'https://shop.example', provider: 'woocommerce' });
    const { redirectUrl } = await approvePairingRequest(CONFIG, { state, workspaceId: WS, userId: 'u', permissions: {} });
    published.length = 0;
    const code = new URL(redirectUrl).searchParams.get('code') as string;
    await exchangePairingCode(CONFIG, { state, code, codeVerifier: verifier });
    expect(fake.db.commerce_connections).toHaveLength(1);
    expect(published).toEqual([[`widget:${WS}`]]);
  });

  it('a handshake that changes a store’s health publishes; the same health again does not', async () => {
    // No secret readable: the handshake writes authentication_error.
    fake.db.commerce_connections = [connection({ health: 'connected' })];
    await runCapabilityHandshake(CONFIG, 'conn-1');
    expect(fake.db.commerce_connections[0].health).toBe('authentication_error');
    expect(published).toEqual([[`widget:${WS}`]]);
    published.length = 0;
    await runCapabilityHandshake(CONFIG, 'conn-1');
    expect(published).toEqual([]);
  });

  it('OpenCart’s handshake too', async () => {
    fake.db.commerce_connections = [connection({ provider_type: 'opencart', health: 'reconnecting', external_store_id: '0' })];
    await runCapabilityHandshake(CONFIG, 'conn-1');
    expect(fake.db.commerce_connections[0].health).toBe('authentication_error');
    expect(published).toEqual([[`widget:${WS}`]]);
  });

  it('a billing connection (WHMCS) never does', async () => {
    fake.db.commerce_connections = [connection({ provider_type: 'whmcs', health: 'connected' })];
    await runCapabilityHandshake(CONFIG, 'conn-1');
    expect(published).toEqual([]);
  });
});
