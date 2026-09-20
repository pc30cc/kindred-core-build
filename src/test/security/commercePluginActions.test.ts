/**
 * Plugin-triggered connection actions — signature authentication.
 *
 * These routes exist so a store can act on its OWN connection without a
 * logged-in member's session, which a server-to-server call from WordPress
 * cannot present. The invariants under test:
 *
 *   1. An unsigned or badly signed request is refused — possession of the
 *      installation secret is the whole credential, so a forgeable one would
 *      let anyone queue syncs against any store.
 *   2. The connection is resolved FROM the installation, never from anything
 *      the caller supplies, so a store cannot name another store's connection.
 *   3. A revoked connection is refused even with a valid signature.
 *
 * Same fake-client + real-router harness as commerceTenantIsolation.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import { COMMERCE_PROTOCOL_VERSION } from '../../../shared/commerce/types.js';

type Row = Record<string, any>;
const db: Record<string, Row[]> = {};

function fakeClient() {
  return {
    from(table: string) {
      const rows: Row[] = db[table] || (db[table] = []);
      const filters: Array<(r: Row) => boolean> = [];
      let projection: string[] | null = null;
      const project = (r: Row) => (projection ? Object.fromEntries(projection.map((c) => [c, r[c]])) : r);
      const builder: any = {
        select(cols?: string) {
          if (cols && cols !== '*') projection = cols.split(',').map((c) => c.trim());
          return builder;
        },
        eq(col: string, val: any) { filters.push((r: Row) => r[col] === val); return builder; },
        in: () => builder,
        update: () => builder,
        delete: () => builder,
        insert: async () => ({ data: null, error: null }),
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => {
          const m = rows.filter((r) => filters.every((f) => f(r)));
          return { data: m[0] ? project(m[0]) : null, error: null };
        },
        single: async () => {
          const m = rows.filter((r) => filters.every((f) => f(r)));
          return { data: m[0] ? project(m[0]) : null, error: null };
        },
        then(resolve: any) {
          const m = rows.filter((r) => filters.every((f) => f(r))).map(project);
          return resolve({ data: m, error: null, count: m.length });
        },
      };
      return builder;
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

const SECRET_A = 'secret-for-store-a';
const handshakes: string[] = [];
const syncs: Array<{ workspaceId: string; connectionId: string }> = [];

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));
vi.mock('../../../server/services/commerce/credentials.js', () => ({
  readInstallationSecret: async (_c: unknown, installationId: string) =>
    installationId === 'inst-a' ? SECRET_A : null,
}));
vi.mock('../../../server/services/commerce/pairing.js', () => ({
  runCapabilityHandshake: async (_c: unknown, connectionId: string) => { handshakes.push(connectionId); },
}));
vi.mock('../../../server/services/commerce/sync.js', () => ({
  enqueueSyncJob: async (_c: unknown, workspaceId: string, connectionId: string) => {
    syncs.push({ workspaceId, connectionId });
    return { id: 'job-1' };
  },
}));
vi.mock('../../../server/services/commerce/lifecycle.js', () => ({
  disconnectConnection: async () => {},
}));
// The real verifier writes nonces through the service client; the fake above
// returns "no row", which is exactly "nonce unseen".
vi.mock('../../../server/services/commerce/signing.js', async (orig) => {
  const real = await (orig() as Promise<any>);
  return { ...real };
});

const { commercePluginActionsRouter } = await import('../../../server/routes/commerce/pluginActions.js');

const app = express();
app.use((req, _res, next) => {
  (req as any).serverConfig = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: ['*'] };
  next();
});
app.use('/api/commerce/connection', commercePluginActionsRouter);
const server = http.createServer(app).listen(0);
const port = () => (server.address() as any).port;

function sign(secret: string, canonicalPath: string, body = '') {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  const sts = [COMMERCE_PROTOCOL_VERSION, 'POST', canonicalPath, 'inst-a', ts, nonce, crypto.createHash('sha256').update(body).digest('hex')].join('\n');
  return {
    'X-WebYar-Installation': 'inst-a',
    'X-WebYar-Timestamp': ts,
    'X-WebYar-Nonce': nonce,
    'X-WebYar-Signature': crypto.createHmac('sha256', secret).update(sts).digest('hex'),
    'X-WebYar-Protocol': COMMERCE_PROTOCOL_VERSION,
    'Content-Type': 'application/json',
  };
}

async function post(path: string, headers: Record<string, string>) {
  const res = await fetch(`http://127.0.0.1:${port()}${path}`, { method: 'POST', headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  handshakes.length = 0;
  syncs.length = 0;
  db.commerce_connections = [
    { id: 'conn-a', workspace_id: 'ws-a', installation_id: 'inst-a', revoked_at: null },
    { id: 'conn-b', workspace_id: 'ws-b', installation_id: 'inst-b', revoked_at: null },
  ];
});

describe('plugin-triggered connection actions', () => {
  it('runs the handshake for a correctly signed request', async () => {
    const r = await post('/api/commerce/connection/test', sign(SECRET_A, '/api/commerce/connection/test'));
    expect(r.status).toBe(200);
    expect(handshakes).toEqual(['conn-a']);
  });

  it('queues a sync scoped to the caller’s own connection', async () => {
    const r = await post('/api/commerce/connection/sync', sign(SECRET_A, '/api/commerce/connection/sync'));
    expect(r.status).toBe(200);
    expect(syncs).toEqual([{ workspaceId: 'ws-a', connectionId: 'conn-a' }]);
  });

  it('refuses a request with no signature headers', async () => {
    const r = await post('/api/commerce/connection/sync', { 'Content-Type': 'application/json' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('missing_signature_headers');
    expect(syncs).toHaveLength(0);
  });

  it('refuses a signature made with the wrong secret', async () => {
    const r = await post('/api/commerce/connection/sync', sign('not-the-secret', '/api/commerce/connection/sync'));
    expect(r.status).toBe(401);
    expect(syncs).toHaveLength(0);
  });

  it('refuses a signature bound to a different route', async () => {
    // Signed for /test but sent to /sync — a valid signature must not be
    // replayable onto a different, more expensive action.
    const r = await post('/api/commerce/connection/sync', sign(SECRET_A, '/api/commerce/connection/test'));
    expect(r.status).toBe(401);
    expect(syncs).toHaveLength(0);
  });

  it('refuses an unknown installation', async () => {
    const h = sign(SECRET_A, '/api/commerce/connection/sync');
    h['X-WebYar-Installation'] = 'inst-unknown';
    const r = await post('/api/commerce/connection/sync', h);
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('unknown_installation');
  });

  it('rejects a protocol version it does not speak', async () => {
    const h = sign(SECRET_A, '/api/commerce/connection/sync');
    h['X-WebYar-Protocol'] = 'webyar-commerce/999';
    const r = await post('/api/commerce/connection/sync', h);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('protocol_mismatch');
  });

  it('refuses a revoked connection even when the signature is valid', async () => {
    db.commerce_connections[0].revoked_at = new Date().toISOString();
    const r = await post('/api/commerce/connection/sync', sign(SECRET_A, '/api/commerce/connection/sync'));
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('commerce_not_connected');
    expect(syncs).toHaveLength(0);
  });

  it('never lets a store reach another store’s connection', async () => {
    // inst-a holds the only secret we can sign with; whatever it asks for,
    // the connection is looked up from the installation, so conn-b is
    // unreachable by construction.
    await post('/api/commerce/connection/sync', sign(SECRET_A, '/api/commerce/connection/sync'));
    expect(syncs.every((s) => s.connectionId === 'conn-a' && s.workspaceId === 'ws-a')).toBe(true);
  });
});
