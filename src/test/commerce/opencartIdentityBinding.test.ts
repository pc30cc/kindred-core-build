/**
 * The identity bridge for a direct (OpenCart) store: the assertion must be
 * this store's, carry an opaque session reference, and come from the store's
 * own pages; re-binding the same shopper writes nothing; a different shopper
 * in the same browser switches the link and records a history cutoff.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { createCountingSupabase } from './helpers/countingSupabase';
import type { ServerConfig } from '../../../server/config.js';

const WS = 'ws-oc';
const CONN = 'conn-oc';
const INSTALL = 'inst-oc';
const SECRET = 'oc-secret';
const VISITOR = 'visitor-oc';
const ORIGIN = 'https://shop.example';

const fake = createCountingSupabase();
let contacts = 0;

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fake.client }));
vi.mock('../../../server/services/commerce/credentials.js', () => ({ readInstallationSecret: async () => SECRET }));
vi.mock('../../../server/services/commerce/storeContact.js', () => ({ syncStoreContact: async () => { contacts += 1; } }));

const { verifyAndBindCustomerContext, unbindCustomerContext } = await import('../../../server/services/commerce/identityBridge.js');
const CONFIG = {} as ServerConfig;

function assertion(over: Record<string, unknown> = {}, secret = SECRET): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    installation_id: INSTALL, external_customer_id: '101', store_id: '0', customer_group_id: '1', session_ref: 'ref-a',
    email: 'a@example.test', name: 'A', issued_at: now, expires_at: now + 120, nonce: Math.random().toString(16).slice(2), audience: 'webyar-widget', provider: 'opencart',
    ...over,
  })).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

const bind = (raw = assertion(), origin: string | null = ORIGIN) => verifyAndBindCustomerContext(CONFIG, WS, CONN, VISITOR, raw, { requestOrigin: origin });

beforeEach(() => {
  fake.db.commerce_connections = [{ id: CONN, workspace_id: WS, installation_id: INSTALL, provider_type: 'opencart', external_store_id: '0', approved_origin: ORIGIN, revoked_at: null, created_at: '2026-01-01' }];
  fake.db.commerce_customer_links = [];
  fake.db.commerce_nonce_cache = [];
  contacts = 0;
  fake.reset();
});

describe('what an OpenCart assertion must carry', () => {
  it('is refused for another store of the same installation', async () => {
    await expect(bind(assertion({ store_id: '1' }))).rejects.toMatchObject({ code: 'identity_expired' });
  });

  it('is refused without a session reference', async () => {
    await expect(bind(assertion({ session_ref: undefined }))).rejects.toMatchObject({ code: 'identity_expired' });
  });

  it('is refused when posted from another origin (a copied shop)', async () => {
    await expect(bind(assertion(), 'https://copy.example')).rejects.toMatchObject({ code: 'identity_expired' });
    expect(fake.db.commerce_customer_links).toEqual([]);
  });

  it('is refused when forged, expired or replayed', async () => {
    await expect(bind(assertion({}, 'wrong'))).rejects.toMatchObject({ code: 'identity_expired' });
    const past = Math.floor(Date.now() / 1000) - 3600;
    await expect(bind(assertion({ issued_at: past, expires_at: past + 120 }))).rejects.toMatchObject({ code: 'identity_expired' });
    const once = assertion();
    await bind(once);
    await expect(bind(once)).rejects.toMatchObject({ code: 'identity_expired' });
  });

  it('stores the opaque reference and the group, never anything else from the store', async () => {
    await bind();
    expect(fake.db.commerce_customer_links[0]).toMatchObject({ external_customer_id: '101', session_ref: 'ref-a', customer_group_id: '1', connection_id: CONN });
    expect(fake.db.commerce_customer_links[0]).not.toHaveProperty('email');
  });
});

describe('writes only when something changed', () => {
  it('first bind: one link row and one contact upsert', async () => {
    const r = await bind();
    expect(r.outcome).toBe('created');
    expect(fake.counts.commerce_customer_links).toMatchObject({ insert: 1 });
    expect(contacts).toBe(1);
  });

  it('the same shopper again: no link write, contact repair is checked', async () => {
    await bind();
    fake.reset();
    const r = await bind();
    expect(r.outcome).toBe('unchanged');
    expect(fake.counts.commerce_customer_links).toMatchObject({ insert: 0, update: 0 });
    expect(fake.counts.commerce_nonce_cache).toMatchObject({ insert: 1 });
    expect(contacts).toBe(2);
  });

  it('a new session of the same shopper: one UPDATE, no new row, no contact write', async () => {
    await bind();
    const r = await bind(assertion({ session_ref: 'ref-b' }));
    expect(r.outcome).toBe('refreshed');
    expect(fake.db.commerce_customer_links).toHaveLength(1);
    expect(fake.db.commerce_customer_links[0].session_ref).toBe('ref-b');
    expect(contacts).toBe(2);
  });

  it('another shopper must obtain a fresh visitor before binding', async () => {
    await bind();
    await expect(bind(assertion({ external_customer_id: '102', session_ref: 'ref-c' })))
      .rejects.toMatchObject({ code: 'identity_expired' });
    expect(fake.db.commerce_customer_links[0].external_customer_id).toBe('101');
    expect(contacts).toBe(1);
  });
});

describe('sign-out seen by the widget', () => {
  it('ends only this visitor’s links, with a cutoff', async () => {
    await bind();
    fake.db.commerce_customer_links.push({ id: 'other', workspace_id: WS, connection_id: CONN, visitor_id: 'someone-else', external_customer_id: '9', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    const r = await unbindCustomerContext(CONFIG, WS, VISITOR);
    expect(r.ended).toBe(1);
    const mine = fake.db.commerce_customer_links.find((l) => l.visitor_id === VISITOR);
    expect(new Date(String(mine?.expires_at)).getTime()).toBeLessThanOrEqual(Date.now());
    expect(mine?.private_cutoff_at).toBeTruthy();
    const other = fake.db.commerce_customer_links.find((l) => l.visitor_id === 'someone-else');
    expect(new Date(String(other?.expires_at)).getTime()).toBeGreaterThan(Date.now());
  });
});
