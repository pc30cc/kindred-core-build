/**
 * Binding a signed-in WHMCS user to a widget visitor (server side).
 *
 * Scenario 6 (forged / expired / replayed assertions), scenario 5 (account
 * switch changes the subject), scenario 7 (no cross-workspace / cross-
 * installation mixing) and the cost rule "no repeated contact/link writes
 * per page load" — the latter asserted on the NUMBER of database requests.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb, type FakeDb, type Row } from './support/fakeSupabase';

const WS = '6ee40d07-32a3-4594-8a5f-d439f81afa5b';
const OTHER_WS = '11111111-1111-1111-1111-111111111111';
const INSTALL = '9418e6df-2080-466c-a7e5-66eb563830a8';
const WOO_INSTALL = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const SECRET = 'whmcs-installation-secret-for-tests';
const VISITOR_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const VISITOR_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const GRANT_1 = '0123456789abcdef0123456789abcdef';
const GRANT_2 = 'fedcba9876543210fedcba9876543210';

let db: FakeDb;
const contacts: Row[] = [];

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => db.client }));
// The real read is one SELECT on plugin_secrets (+ in-process decryption); counted as such.
vi.mock('../../../server/services/commerce/credentials.js', () => ({
  readInstallationSecret: async (_c: unknown, installationId: string) => {
    db.ops.push({ table: 'plugin_secrets', verb: 'select' });
    return installationId === INSTALL ? SECRET : 'woo-secret';
  },
}));
vi.mock('../../../server/services/widget/anonymousContact.js', () => ({
  ensureVisitorContact: async (_sb: unknown, input: Row) => { contacts.push(input); return 'contact-1'; },
}));

const { verifyAndBindWhmcsIdentity, resolveWhmcsBinding, signWhmcsAssertion } = await import('../../../server/services/commerce/whmcs/identity.js');
const CONFIG = {} as Parameters<typeof verifyAndBindWhmcsIdentity>[0];

let jti = 0;
function assertion(over: Record<string, unknown> = {}, secret = SECRET): string {
  const now = Math.floor(Date.now() / 1000);
  jti += 1;
  const payload = {
    v: 1, typ: 'whmcs.identity', iss: INSTALL, wid: WS, aud: 'webyar-widget', iat: now, exp: now + 300,
    jti: `${String(jti).padStart(4, '0')}aabbccddeeff00112233`, gid: GRANT_1, uid: '1', cid: '10', sub: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    name: 'Alice Example', email: 'alice@example.com', ...over,
  };
  const signed = `whmcs1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${signed}.${signWhmcsAssertion(secret, signed)}`;
}

beforeEach(() => {
  contacts.length = 0;
  db = createFakeDb({
    commerce_connections: [
      { id: 'conn-whmcs', workspace_id: WS, installation_id: INSTALL, provider_type: 'whmcs', revoked_at: null },
      { id: 'conn-woo', workspace_id: WS, installation_id: WOO_INSTALL, provider_type: 'woocommerce', revoked_at: null },
    ],
    conversations: [{ id: 'conv-a', workspace_id: WS, visitor_session_id: null, metadata: { visitor_id: VISITOR_A } }],
  });
});

describe('first bind and page reloads', () => {
  it('first bind writes the link, a nonce and the contact once', async () => {
    const out = await verifyAndBindWhmcsIdentity(CONFIG, WS, VISITOR_A, assertion());
    expect(out).toMatchObject({ linked: true, changed: true, connectionId: 'conn-whmcs' });
    expect(db.tables.commerce_customer_links).toHaveLength(1);
    expect(db.tables.commerce_customer_links[0]).toMatchObject({ grant_ref: GRANT_1, external_user_id: '1', external_customer_id: '10', visitor_id: VISITOR_A });
    expect(db.count('insert', 'commerce_nonce_cache')).toBe(1);
    expect(contacts).toEqual([expect.objectContaining({ email: 'alice@example.com', name: 'Alice Example', visitorId: VISITOR_A })]);
  });

  it('every later page load with the same grant costs reads only — zero writes, no contact', async () => {
    await verifyAndBindWhmcsIdentity(CONFIG, WS, VISITOR_A, assertion());
    db.reset();
    contacts.length = 0;
    for (let i = 0; i < 5; i++) {
      const out = await verifyAndBindWhmcsIdentity(CONFIG, WS, VISITOR_A, assertion());
      expect(out.changed).toBe(false);
    }
    expect(db.count('insert') + db.count('update') + db.count('upsert') + db.count('delete')).toBe(0);
    expect(db.count('select')).toBe(15); // connection + secret + link, per page load
    expect(contacts).toEqual([]);
  });
});

describe('forged, expired, replayed', () => {
  it('rejects a wrong signature, another workspace, and a WooCommerce installation id', async () => {
    await expect(verifyAndBindWhmcsIdentity(CONFIG, WS, VISITOR_A, assertion({}, 'not-the-secret'))).rejects.toMatchObject({ code: 'identity_expired' });
    await expect(verifyAndBindWhmcsIdentity(CONFIG, OTHER_WS, VISITOR_A, assertion())).rejects.toMatchObject({ code: 'identity_expired' });
    await expect(verifyAndBindWhmcsIdentity(CONFIG, WS, VISITOR_A, assertion({ iss: WOO_INSTALL }))).rejects.toMatchObject({ code: 'commerce_not_connected' });
    expect(db.tables.commerce_customer_links ?? []).toEqual([]);
  });

  it('rejects an expired or over-long assertion before touching the database', async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(verifyAndBindWhmcsIdentity(CONFIG, WS, VISITOR_A, assertion({ iat: now - 2000, exp: now - 1700 }))).rejects.toMatchObject({ code: 'identity_expired' });
    await expect(verifyAndBindWhmcsIdentity(CONFIG, WS, VISITOR_A, assertion({ exp: now + 7200 }))).rejects.toMatchObject({ code: 'identity_expired' });
    expect(db.ops).toEqual([]);
  });

  it('a lifted assertion replayed by another visitor is refused', async () => {
    const token = assertion();
    await verifyAndBindWhmcsIdentity(CONFIG, WS, VISITOR_A, token);
    await expect(verifyAndBindWhmcsIdentity(CONFIG, WS, VISITOR_B, token)).rejects.toMatchObject({ code: 'identity_expired' });
    const links = db.tables.commerce_customer_links;
    expect(links.filter((l) => l.visitor_id === VISITOR_B)).toEqual([]);
  });

  it('a revoked connection binds nothing', async () => {
    db.tables.commerce_connections[0].revoked_at = '2026-09-01T00:00:00Z';
    await expect(verifyAndBindWhmcsIdentity(CONFIG, WS, VISITOR_A, assertion())).rejects.toMatchObject({ code: 'commerce_not_connected' });
  });
});

describe('subject changes', () => {
  it('switching client account moves subject_since and keeps one row per visitor', async () => {
    await verifyAndBindWhmcsIdentity(CONFIG, WS, VISITOR_A, assertion());
    const firstSince = db.tables.commerce_customer_links[0].subject_since;
    await new Promise((r) => setTimeout(r, 5));
    const out = await verifyAndBindWhmcsIdentity(CONFIG, WS, VISITOR_A, assertion({ gid: GRANT_2, cid: '30' }));
    expect(out.changed).toBe(true);
    expect(db.tables.commerce_customer_links).toHaveLength(1);
    const link = db.tables.commerce_customer_links[0];
    expect(link).toMatchObject({ grant_ref: GRANT_2, external_customer_id: '30' });
    expect(String(link.subject_since) > String(firstSince)).toBe(true);
  });

  it('a new grant for the same subject (next login) keeps subject_since', async () => {
    await verifyAndBindWhmcsIdentity(CONFIG, WS, VISITOR_A, assertion());
    const since = db.tables.commerce_customer_links[0].subject_since;
    await verifyAndBindWhmcsIdentity(CONFIG, WS, VISITOR_A, assertion({ gid: GRANT_2 }));
    expect(db.tables.commerce_customer_links[0].subject_since).toBe(since);
  });

  it('a second user on the same visitor is never merged into the first user’s contact', async () => {
    await verifyAndBindWhmcsIdentity(CONFIG, WS, VISITOR_A, assertion());
    contacts.length = 0;
    await verifyAndBindWhmcsIdentity(CONFIG, WS, VISITOR_A, assertion({ gid: GRANT_2, uid: '2', cid: '30', email: 'bob@example.com', name: 'Bob' }));
    expect(contacts).toEqual([]);
  });

  it('one grant, one visitor: binding it elsewhere ends the old visitor’s binding', async () => {
    await verifyAndBindWhmcsIdentity(CONFIG, WS, VISITOR_A, assertion());
    await verifyAndBindWhmcsIdentity(CONFIG, WS, VISITOR_B, assertion());
    const byVisitor = Object.fromEntries(db.tables.commerce_customer_links.map((l) => [l.visitor_id, l]));
    expect(byVisitor[VISITOR_A].revoked_at).not.toBeNull();
    expect(byVisitor[VISITOR_B].revoked_at).toBeNull();
  });
});

describe('reading the binding for a turn', () => {
  it('resolves bound → grant, and revoked → nothing usable', async () => {
    await verifyAndBindWhmcsIdentity(CONFIG, WS, VISITOR_A, assertion());
    const bound = await resolveWhmcsBinding(CONFIG, { workspaceId: WS, connectionId: 'conn-whmcs', conversationId: 'conv-a' });
    expect(bound).toMatchObject({ state: 'bound', grant: { grantId: GRANT_1, userId: '1', clientId: '10' } });

    db.tables.commerce_customer_links[0].revoked_at = new Date().toISOString();
    const revoked = await resolveWhmcsBinding(CONFIG, { workspaceId: WS, connectionId: 'conn-whmcs', conversationId: 'conv-a' });
    expect(revoked.state).toBe('revoked');
  });

  it('never resolves across workspaces', async () => {
    await verifyAndBindWhmcsIdentity(CONFIG, WS, VISITOR_A, assertion());
    expect((await resolveWhmcsBinding(CONFIG, { workspaceId: OTHER_WS, connectionId: 'conn-whmcs', conversationId: 'conv-a' })).state).toBe('none');
  });
});

describe('conversation visitor ownership regression', () => {
  const input = { workspaceId: WS, connectionId: 'conn-whmcs', conversationId: 'conv-a' };
  beforeEach(async () => {
    await verifyAndBindWhmcsIdentity(CONFIG, WS, VISITOR_A, assertion());
    db.reset();
  });

  it('resolves an intro conversation without a session in two reads and zero writes', async () => {
    expect((await resolveWhmcsBinding(CONFIG, input)).state).toBe('bound');
    expect(db.ops).toEqual([
      { table: 'conversations', verb: 'select' },
      { table: 'commerce_customer_links', verb: 'select' },
    ]);
  });

  it('resolves a legacy session through its visitor_id, not its primary key', async () => {
    db.tables.conversations[0].metadata = {};
    db.tables.conversations[0].visitor_session_id = 'session-a';
    db.tables.visitor_sessions = [{ id: 'session-a', workspace_id: WS, visitor_id: VISITOR_A }];
    expect((await resolveWhmcsBinding(CONFIG, input)).state).toBe('bound');
    expect(db.ops).toEqual([
      { table: 'conversations', verb: 'select' },
      { table: 'visitor_sessions', verb: 'select' },
      { table: 'commerce_customer_links', verb: 'select' },
    ]);
  });

  it('prefers the canonical conversation visitor over a stale session', async () => {
    db.tables.conversations[0].visitor_session_id = 'session-b';
    db.tables.visitor_sessions = [{ id: 'session-b', workspace_id: WS, visitor_id: VISITOR_B }];
    expect((await resolveWhmcsBinding(CONFIG, input)).state).toBe('bound');
    expect(db.count('select', 'visitor_sessions')).toBe(0);
  });

  it('never treats a missing session row as a visitor id', async () => {
    db.tables.conversations[0].metadata = null;
    db.tables.conversations[0].visitor_session_id = VISITOR_A;
    expect((await resolveWhmcsBinding(CONFIG, input)).state).toBe('none');
    expect(db.count('select', 'commerce_customer_links')).toBe(0);
  });

  it('does not fall back to another account when the canonical visitor has no binding', async () => {
    db.tables.conversations[0].metadata = { visitor_id: VISITOR_B };
    db.tables.conversations[0].visitor_session_id = 'session-a';
    db.tables.visitor_sessions = [{ id: 'session-a', workspace_id: WS, visitor_id: VISITOR_A }];
    expect((await resolveWhmcsBinding(CONFIG, input)).state).toBe('none');
    expect(db.count('select', 'visitor_sessions')).toBe(0);
  });

  it.each([null, {}, { visitor_id: '' }, { visitor_id: 42 }, { visitor_id: [VISITOR_A] }])(
    'fails closed with missing or malformed metadata %j', async (metadata) => {
      db.tables.conversations[0].metadata = metadata;
      expect((await resolveWhmcsBinding(CONFIG, input)).state).toBe('none');
      expect(db.count('select', 'commerce_customer_links')).toBe(0);
    },
  );

  it('cannot resolve a session belonging to another workspace', async () => {
    db.tables.conversations[0].metadata = {};
    db.tables.conversations[0].visitor_session_id = 'session-a';
    db.tables.visitor_sessions = [{ id: 'session-a', workspace_id: OTHER_WS, visitor_id: VISITOR_A }];
    expect((await resolveWhmcsBinding(CONFIG, input)).state).toBe('none');
  });

  it('cannot use a link from another workspace or connection', async () => {
    expect((await resolveWhmcsBinding(CONFIG, { ...input, connectionId: 'conn-woo' })).state).toBe('none');
    db.tables.commerce_customer_links[0].workspace_id = OTHER_WS;
    expect((await resolveWhmcsBinding(CONFIG, input)).state).toBe('none');
  });

  it('does not resolve an expired binding', async () => {
    db.tables.commerce_customer_links[0].expires_at = new Date(Date.now() - 1000).toISOString();
    expect((await resolveWhmcsBinding(CONFIG, input)).state).toBe('revoked');
  });

  it('does no database work without a conversation', async () => {
    expect((await resolveWhmcsBinding(CONFIG, { ...input, conversationId: null })).state).toBe('none');
    expect(db.ops).toEqual([]);
  });
});
