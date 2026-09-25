import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb, type FakeDb } from './support/fakeSupabase';
import { createFakeWhmcs, BASE, ORIGIN, type FakeWhmcs } from './support/fakeWhmcs';
import type { CommerceHttpRequest } from '../../../server/services/commerce/httpClient.js';

const WS = '6ee40d07-32a3-4594-8a5f-d439f81afa5b';
const SECRET = 'handshake-test-secret';
let db: FakeDb;
let whmcs: FakeWhmcs;
let schemaOk = true;
let storeName: string | undefined;
vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => db.client }));
vi.mock('../../../server/services/plugins/state.js', () => ({ installPlugin: vi.fn() }));
vi.mock('../../../server/services/commerce/credentials.js', () => ({
  storeInstallationSecret: vi.fn(), readInstallationSecret: async () => SECRET,
}));
vi.mock('../../../server/services/commerce/httpClient.js', () => ({
  commerceHttpRequest: async (req: CommerceHttpRequest) => {
    const result = await whmcs.requester(req);
    if (result.status === 200 && storeName !== undefined) {
      (result.json as { data: { store_name?: string } }).data.store_name = storeName;
    }
    if (!schemaOk && result.status === 200) {
      (result.json as { data: { schema_ok: boolean } }).data.schema_ok = false;
    }
    return result;
  },
}));
const { runCapabilityHandshake } = await import('../../../server/services/commerce/pairing.js');
const CONFIG = {} as Parameters<typeof runCapabilityHandshake>[0];

beforeEach(() => {
  schemaOk = true;
  storeName = undefined;
  whmcs = createFakeWhmcs(SECRET, 'inst-whmcs');
  db = createFakeDb({ commerce_connections: [{
    id: 'conn-whmcs', workspace_id: WS, installation_id: 'inst-whmcs',
    approved_origin: ORIGIN, store_id: BASE, provider_type: 'whmcs', revoked_at: null,
    health: 'authentication_error', last_error_code: 'commerce_permission_denied',
    last_error_at: '2026-09-01T00:00:00Z',
  }] });
});

describe('WHMCS handshake recovery', () => {
  it('refreshes a sanitized Persian merchant name in the existing connection write', async () => {
    storeName = '<b>فروشگاه من</b>';
    await runCapabilityHandshake(CONFIG, 'conn-whmcs', { workspaceId: WS });
    expect(db.tables.commerce_connections[0].store_name).toBe('فروشگاه من');
    expect(db.count('update', 'commerce_connections')).toBe(1);
    storeName = 'نام تازه';
    await runCapabilityHandshake(CONFIG, 'conn-whmcs', { workspaceId: WS });
    expect(db.tables.commerce_connections[0].store_name).toBe('نام تازه');
  });

  it('preserves a known name for older addons and clears an explicitly empty setting', async () => {
    db.tables.commerce_connections[0].store_name = 'Known merchant';
    await runCapabilityHandshake(CONFIG, 'conn-whmcs', { workspaceId: WS });
    expect(db.tables.commerce_connections[0].store_name).toBe('Known merchant');
    storeName = '';
    await runCapabilityHandshake(CONFIG, 'conn-whmcs', { workspaceId: WS });
    expect(db.tables.commerce_connections[0].store_name).toBeNull();
  });
  it('clears an obsolete authentication error after a successful handshake in the existing write', async () => {
    await runCapabilityHandshake(CONFIG, 'conn-whmcs', { workspaceId: WS });
    expect(db.tables.commerce_connections[0]).toMatchObject({
      health: 'connected', last_error_code: null, last_error_at: null,
    });
    expect(db.count('update', 'commerce_connections')).toBe(1);
    expect(whmcs.calls).toHaveLength(1);
  });
  it('retains a real schema problem instead of showing a healthy connection', async () => {
    schemaOk = false;
    await runCapabilityHandshake(CONFIG, 'conn-whmcs', { workspaceId: WS });
    expect(db.tables.commerce_connections[0]).toMatchObject({ health: 'degraded', last_error_code: 'schema_unsupported' });
    expect(db.tables.commerce_connections[0].last_error_at).toBeTruthy();
  });
  it('keeps a bad signature rejected', async () => {
    whmcs.secret = 'different-secret';
    await runCapabilityHandshake(CONFIG, 'conn-whmcs', { workspaceId: WS });
    expect(db.tables.commerce_connections[0]).toMatchObject({ health: 'authentication_error', last_error_code: 'commerce_permission_denied' });
  });
});
