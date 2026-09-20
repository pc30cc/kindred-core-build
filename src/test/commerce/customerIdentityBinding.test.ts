/**
 * Binding a signed-in store customer to a widget visitor.
 *
 * The endpoint used to REQUIRE the caller to name the connection. That looked
 * like a security check and was not one: the assertion payload already names
 * its installation, only that installation's secret can sign it, and the
 * signature is checked against the secret this server looks up itself. The id
 * added no authority — but it did add a precondition the client could not
 * always meet. The connection id reaches a store only through
 * `pairing/exchange`, older plugin builds did not store it, and no endpoint
 * will tell an already-paired store what its id is. On the live store this was
 * written against, `webyar_wc_installation` has no `connection_id` at all, so
 * the bridge could never fire there no matter how correct the rest of it was.
 *
 * So the id is now optional, and these tests pin what replaced it: the
 * connection is resolved server-side, must belong to the workspace being bound
 * into, must not be revoked, and must be the installation the assertion names.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';

const WS = '6ee40d07-32a3-4594-8a5f-d439f81afa5b';
const OTHER_WS = '11111111-1111-1111-1111-111111111111';
const CONN_NEW = 'a22e727a-c3e8-4ae9-b548-9cd8ec3f1b2a';
const CONN_OLD = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const INSTALL = '9418e6df-2080-466c-a7e5-66eb563830a8';
const INSTALL_OLD = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const VISITOR = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const SECRET = 'installation-secret-for-tests';

type Row = Record<string, any>;

/** The whole commerce_connections table, filtered by the fake below. */
let connections: Row[] = [];
let nonceError: Row | null = null;

const seen = {
  links: [] as Row[],
  nonces: [] as Row[],
  /** Filters the connection lookup applied, so the workspace/revoked guards are visible. */
  connectionFilters: [] as Array<[string, string, any]>,
  connectionOrdered: [] as string[],
};

function fakeClient() {
  const make = (table: string) => {
    const filters: Array<[string, string, any]> = [];
    const b: any = {
      select: () => b,
      eq: (col: string, val: any) => { filters.push(['eq', col, val]); return b; },
      is: (col: string, val: any) => { filters.push(['is', col, val]); return b; },
      order: (col: string) => { if (table === 'commerce_connections') seen.connectionOrdered.push(col); return b; },
      limit: () => b,
      insert: async (row: Row) => {
        if (table === 'commerce_customer_links') { seen.links.push(row); return { error: null }; }
        if (table === 'commerce_nonce_cache') { seen.nonces.push(row); return { error: nonceError }; }
        return { error: null };
      },
      maybeSingle: async () => {
        if (table !== 'commerce_connections') return { data: null, error: null };
        seen.connectionFilters.push(...filters);
        const match = connections.filter((c) =>
          filters.every(([op, col, val]) => (op === 'is' ? c[col] === val : c[col] === val)));
        // `.order(created_at desc).limit(1)` — newest first, same as the AI stage.
        const sorted = [...match].sort((a, z) => String(z.created_at).localeCompare(String(a.created_at)));
        return { data: sorted[0] ?? null, error: null };
      },
    };
    return b;
  };
  return { from: (t: string) => make(t) };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));
vi.mock('../../../server/services/commerce/credentials.js', () => ({
  readInstallationSecret: async (_c: any, installationId: string) =>
    installationId === INSTALL ? SECRET : null,
}));

const { verifyAndBindCustomerContext } = await import('../../../server/services/commerce/identityBridge.js');

const CONFIG: any = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' };

const b64url = (raw: string) => Buffer.from(raw, 'utf8').toString('base64url');

/** Exactly what plugins/webyar-woocommerce/src/Identity/CustomerContext.php emits. */
function assertion(over: Record<string, any> = {}, secret = SECRET) {
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({
    installation_id: INSTALL,
    external_customer_id: '2',
    issued_at: now,
    expires_at: now + 120,
    nonce: Math.random().toString(16).slice(2),
    audience: 'webyar-widget',
    ...over,
  }));
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

const bind = (connectionId: string | null, raw = assertion()) =>
  verifyAndBindCustomerContext(CONFIG, WS, connectionId, VISITOR, raw);

beforeEach(() => {
  connections = [{ id: CONN_NEW, workspace_id: WS, installation_id: INSTALL, revoked_at: null, created_at: '2026-09-01T00:00:00Z' }];
  nonceError = null;
  seen.links.length = 0;
  seen.nonces.length = 0;
  seen.connectionFilters.length = 0;
  seen.connectionOrdered.length = 0;
});

describe('a store that cannot name its connection', () => {
  it('binds the customer anyway', async () => {
    const result = await bind(null);

    expect(result.externalCustomerId).toBe('2');
    expect(seen.links).toHaveLength(1);
    expect(seen.links[0]).toMatchObject({ workspace_id: WS, connection_id: CONN_NEW, external_customer_id: '2', visitor_id: VISITOR });
  });

  it('resolves the newest un-revoked connection, the one the AI stage will read back', async () => {
    // `resolveVerifiedCustomer` looks the link up by the connection
    // `getActiveConnectionForWorkspace` returns — newest first. Writing the
    // link against any other row would store a link nothing ever finds.
    connections.push({ id: CONN_OLD, workspace_id: WS, installation_id: INSTALL, revoked_at: null, created_at: '2025-01-01T00:00:00Z' });

    await bind(null);

    expect(seen.links[0].connection_id).toBe(CONN_NEW);
    expect(seen.connectionOrdered).toContain('created_at');
  });

  it('refuses when the workspace has no live connection at all', async () => {
    connections = [];
    await expect(bind(null)).rejects.toMatchObject({ code: 'commerce_not_connected' });
    expect(seen.links).toEqual([]);
  });

  it('refuses when every connection is revoked', async () => {
    connections = [{ id: CONN_NEW, workspace_id: WS, installation_id: INSTALL, revoked_at: '2026-09-10T00:00:00Z', created_at: '2026-09-01T00:00:00Z' }];
    await expect(bind(null)).rejects.toMatchObject({ code: 'commerce_not_connected' });
  });
});

describe('a connection id, when one is sent', () => {
  it('is honoured', async () => {
    await bind(CONN_NEW);
    expect(seen.links[0].connection_id).toBe(CONN_NEW);
  });

  it('cannot point at another workspace’s connection', async () => {
    // Previously this id went into the link row unexamined. The read path
    // filters by the workspace's OWN connection so the row was inert, but it
    // was still a caller-chosen foreign key written on trust.
    connections.push({ id: CONN_OLD, workspace_id: OTHER_WS, installation_id: INSTALL, revoked_at: null, created_at: '2026-09-02T00:00:00Z' });

    await expect(bind(CONN_OLD)).rejects.toMatchObject({ code: 'commerce_not_connected' });
    expect(seen.links).toEqual([]);
    expect(seen.connectionFilters).toContainEqual(['eq', 'workspace_id', WS]);
  });

  it('cannot point at a revoked connection', async () => {
    connections = [{ id: CONN_NEW, workspace_id: WS, installation_id: INSTALL, revoked_at: '2026-09-10T00:00:00Z', created_at: '2026-09-01T00:00:00Z' }];
    await expect(bind(CONN_NEW)).rejects.toMatchObject({ code: 'commerce_not_connected' });
    expect(seen.connectionFilters).toContainEqual(['is', 'revoked_at', null]);
  });
});

describe('what still has to be true about the assertion', () => {
  it('rejects one signed with the wrong secret', async () => {
    await expect(bind(null, assertion({}, 'not-the-secret'))).rejects.toMatchObject({ code: 'identity_expired' });
    expect(seen.links).toEqual([]);
  });

  it('rejects one issued for a different installation', async () => {
    // Making the id optional must not let an assertion from store A bind into
    // store B: the resolved connection's installation has to match the payload.
    connections = [{ id: CONN_NEW, workspace_id: WS, installation_id: INSTALL_OLD, revoked_at: null, created_at: '2026-09-01T00:00:00Z' }];
    await expect(bind(null)).rejects.toMatchObject({ code: 'identity_expired' });
  });

  it('rejects an expired one', async () => {
    const past = Math.floor(Date.now() / 1000) - 600;
    await expect(bind(null, assertion({ issued_at: past, expires_at: past + 120 })))
      .rejects.toMatchObject({ code: 'identity_expired' });
  });

  it('rejects one minted for another audience', async () => {
    await expect(bind(null, assertion({ audience: 'something-else' })))
      .rejects.toMatchObject({ code: 'identity_expired' });
  });

  it('rejects a replay, and never writes the link', async () => {
    nonceError = { code: '23505', message: 'duplicate key' };
    await expect(bind(null)).rejects.toMatchObject({ code: 'identity_expired' });
    expect(seen.nonces).toHaveLength(1);
    expect(seen.links).toEqual([]);
  });

  it('rejects a malformed one without touching the database', async () => {
    await expect(bind(null, 'not-an-assertion')).rejects.toMatchObject({ code: 'identity_expired' });
    expect(seen.connectionFilters).toEqual([]);
    expect(seen.links).toEqual([]);
  });
});
