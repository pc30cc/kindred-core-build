/**
 * Pairing an OpenCart store: store scope carried from register to exchange,
 * one installation per store, the owner's consent-screen permissions kept,
 * no sync job, and the provider profile that keeps it out of every
 * background loop.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { createCountingSupabase } from './helpers/countingSupabase';
import type { ServerConfig } from '../../../server/config.js';

const fake = createCountingSupabase();
const installs: Array<{ pluginId: string; instanceKey: string }> = [];

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fake.client }));
vi.mock('../../../shared/net/hostGuard.js', () => ({ checkOutboundUrl: async () => ({ ok: true }) }));
vi.mock('../../../server/services/plugins/state.js', () => ({
  installPlugin: async (_c: unknown, _ws: string, pluginId: string, _u: string, instanceKey = 'default') => {
    installs.push({ pluginId, instanceKey });
    return { id: `inst-${installs.length}` };
  },
}));
vi.mock('../../../server/services/commerce/credentials.js', () => ({ storeInstallationSecret: async () => {}, readInstallationSecret: async () => null }));
vi.mock('../../../server/services/commerce/audit.js', () => ({ writeCommerceAudit: async () => {} }));

const { registerPairingRequest, approvePairingRequest, exchangePairingCode, PairingError } = await import('../../../server/services/commerce/pairing.js');
const { providerProfile, providersWithBackgroundWork, isDirectProvider } = await import('../../../server/services/commerce/providers.js');
const CONFIG = {} as ServerConfig;

const verifier = 'v'.repeat(64);
const challenge = createHash('sha256').update(verifier).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function pair(state: string, storeId: string, storeUrl: string, permissions: Record<string, boolean>) {
  await registerPairingRequest(CONFIG, { state, codeChallenge: challenge, redirectUri: `${storeUrl}index.php?route=x`, storeOrigin: 'https://shop.example', provider: 'opencart', externalStoreId: storeId, storeUrl, platformVersion: '4.1.0.4' });
  const { redirectUrl } = await approvePairingRequest(CONFIG, { state, workspaceId: 'ws', userId: 'u', permissions });
  const code = new URL(redirectUrl).searchParams.get('code') as string;
  return exchangePairingCode(CONFIG, { state, code, codeVerifier: verifier });
}

beforeEach(() => {
  fake.db.commerce_pairing_requests = [];
  fake.db.commerce_connections = [];
  installs.length = 0;
});

describe('register', () => {
  it('requires the OpenCart store id and an https store URL on the same origin', async () => {
    const base = { state: 's'.repeat(20), codeChallenge: challenge, redirectUri: 'https://shop.example/index.php', storeOrigin: 'https://shop.example', provider: 'opencart' };
    await expect(registerPairingRequest(CONFIG, { ...base, storeUrl: 'https://shop.example/' })).rejects.toBeInstanceOf(PairingError);
    await expect(registerPairingRequest(CONFIG, { ...base, externalStoreId: '0', storeUrl: 'https://other.example/' })).rejects.toBeInstanceOf(PairingError);
    await expect(registerPairingRequest(CONFIG, { ...base, externalStoreId: '0', storeUrl: 'http://shop.example/' })).rejects.toBeInstanceOf(PairingError);
    await expect(registerPairingRequest(CONFIG, { ...base, provider: 'magento' })).rejects.toBeInstanceOf(PairingError);
  });
});

describe('exchange', () => {
  it('creates a store-scoped connection with the owner’s consent choices', async () => {
    const r = await pair('a'.repeat(20), '0', 'https://shop.example/', { products: true, prices: true, stock: false, reviews: true, orders: true, tracking: false, bogus: true } as Record<string, boolean>);
    const conn = fake.db.commerce_connections[0];
    expect(conn).toMatchObject({ provider_type: 'opencart', store_id: 'https://shop.example/', approved_origin: 'https://shop.example', external_store_id: '0', platform_version: '4.1.0.4' });
    expect(conn.permissions).toEqual({ products: true, prices: true, stock: false, reviews: true, orders: true, tracking: false });
    expect(r.providerType).toBe('opencart');
    expect(installs[0].pluginId).toBe('opencart');
  });

  it('two stores of one shop get two installations, not one taking over the other', async () => {
    await pair('b'.repeat(20), '0', 'https://shop.example/', { products: true });
    await pair('c'.repeat(20), '1', 'https://shop.example/second/', { products: true });
    expect(installs.map((i) => i.instanceKey)).toHaveLength(2);
    expect(new Set(installs.map((i) => i.instanceKey)).size).toBe(2);
    expect(fake.db.commerce_connections).toHaveLength(2);
  });
});

describe('provider profile', () => {
  it('OpenCart is direct: no sync, no background health, no guest OTP', () => {
    expect(providerProfile('opencart')).toMatchObject({ searchStrategy: 'direct', catalogSync: false, periodicHealth: false, guestOtp: false });
    expect(isDirectProvider('opencart')).toBe(true);
    expect(providersWithBackgroundWork()).not.toContain('opencart');
  });

  it('WooCommerce keeps its indexed profile', () => {
    expect(providerProfile('woocommerce')).toMatchObject({ searchStrategy: 'indexed', catalogSync: true, periodicHealth: true, guestOtp: true });
    expect(providersWithBackgroundWork()).toContain('woocommerce');
  });

  it('an unknown provider gets no background work', () => {
    expect(providerProfile('whatever')).toMatchObject({ catalogSync: false, periodicHealth: false });
  });
});
