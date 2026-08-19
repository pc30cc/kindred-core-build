/**
 * BLOCKER 2 — Contacts routes.
 *
 * useContacts.ts used to query `contacts` directly from the browser via
 * RLS scoped to auth.uid() (silently empty/no-op without a Supabase Auth
 * session), and — for update/delete/bulk-delete — accepted a bare contact
 * id with NO workspace check at all: a service-role write reachable for
 * any contact id regardless of tenant. This proves the replacement routes
 * in server/routes/contacts.ts prove `contact.workspace_id` is accessible
 * to the caller before every read/write, and reject cross-workspace ids.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';

type Row = Record<string, any>;
const db: Record<string, Row[]> = {};

function fakeClient() {
  return {
    from(table: string) {
      const rows: Row[] = db[table] || (db[table] = []);
      const filters: Array<(r: Row) => boolean> = [];
      let inFilter: { col: string; vals: any[] } | null = null;
      const builder: any = {
        select: () => builder,
        eq(col: string, val: any) { filters.push((r) => r[col] === val); return builder; },
        in(col: string, vals: any[]) { inFilter = { col, vals }; return builder; },
        order: () => builder,
        insert(payload: any) {
          const items = Array.isArray(payload) ? payload : [payload];
          const inserted = items.map((it) => ({ id: it.id ?? crypto.randomUUID(), created_at: new Date().toISOString(), ...it }));
          rows.push(...inserted);
          return { select: () => ({ single: async () => ({ data: inserted[0], error: null }) }), then: (resolve: any) => resolve({ data: inserted, error: null }) };
        },
        update(patch: any) {
          const scoped: Array<(r: Row) => boolean> = [...filters];
          const updateBuilder: any = {
            eq(col: string, val: any) { scoped.push((r: Row) => r[col] === val); return updateBuilder; },
            select() {
              const matched = rows.filter((r) => scoped.every((f) => f(r)));
              for (const r of matched) Object.assign(r, patch);
              return { single: async () => ({ data: matched[0] ?? null, error: null }) };
            },
          };
          return updateBuilder;
        },
        delete() {
          const scoped: Array<(r: Row) => boolean> = [...filters];
          const deleteBuilder: any = {
            eq(col: string, val: any) { scoped.push((r: Row) => r[col] === val); return deleteBuilder; },
            in(col: string, vals: any[]) { scoped.push((r: Row) => vals.includes(r[col])); return deleteBuilder; },
            then(resolve: any) {
              db[table] = rows.filter((r) => !scoped.every((f) => f(r)));
              return resolve({ data: null, error: null });
            },
          };
          return deleteBuilder;
        },
        async maybeSingle() {
          const matched = rows.filter((r) => filters.every((f) => f(r)));
          return { data: matched[0] ?? null, error: null };
        },
        then(resolve: any) {
          let matched = rows.filter((r) => filters.every((f) => f(r)));
          if (inFilter) matched = matched.filter((r) => inFilter!.vals.includes(r[inFilter!.col]));
          return resolve({ data: matched, error: null });
        },
      };
      return builder;
    },
    rpc: async (name: string, args: any) => {
      if (name === 'is_workspace_member') {
        const member = (db.workspace_members || []).find((m) => m.workspace_id === args._workspace_id && m.user_id === args._user_id);
        return { data: !!member, error: null };
      }
      return { data: null, error: null };
    },
  };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));
vi.mock('../../../server/middleware/adminBypass.js', () => ({ isGlobalAdmin: async () => false }));
vi.mock('../../../server/services/auth/sessions.js', () => ({
  SESSION_COOKIE_NAME: 'gs_session',
  validateSessionToken: async (_config: unknown, token: string | undefined) => {
    if (!token) return null;
    const user = db.__sessions?.find((s) => s.token === token);
    return user ? { sessionId: 'test-session', userId: user.userId, email: 'test@example.com' } : null;
  },
  verifyOriginForMutation: () => true,
}));
vi.mock('../../../server/services/billing/contactsLimit.js', () => ({
  enforceMaxContactsCreate: async () => true,
  assertContactsBatchFits: async () => true,
}));
vi.mock('../../../server/middleware/featureGating.js', () => ({
  clearEntitlementCache: () => {},
  checkEntitlementFromDB: async () => ({ allowed: true }),
}));
vi.mock('../../../server/services/visitors/networkProfile.js', () => ({
  resolveIpVisibilityPolicy: async () => ({ entitled: false }),
  resolveContactNetworkProfile: async () => null,
}));

const { contactsRouter } = await import('../../../server/routes/contacts.js');

const app = express();
app.use((req, _res, next) => {
  (req as any).serverConfig = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: ['*'] };
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use('/api/contacts', contactsRouter);

const server = http.createServer(app).listen(0);
const port = () => (server.address() as any).port;

function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const req = http.request(
      {
        host: '127.0.0.1', port: port(), path, method,
        headers: {
          ...(opts.token ? { cookie: `gs_session=${opts.token}` } : {}),
          ...(bodyStr !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bodyStr) } : {}),
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          let json: any = {};
          try { json = JSON.parse(d || '{}'); } catch { json = { raw: d }; }
          resolve({ status: res.statusCode || 0, json });
        });
      },
    );
    req.on('error', reject);
    if (bodyStr !== undefined) req.write(bodyStr);
    req.end();
  });
}

const MEMBER = crypto.randomUUID();
const OUTSIDER = crypto.randomUUID();
const WS = crypto.randomUUID();
const WS_B = crypto.randomUUID();
let contactA: string, contactA2: string, contactB: string;

beforeEach(() => {
  for (const key of Object.keys(db)) delete db[key];
  contactA = crypto.randomUUID();
  contactA2 = crypto.randomUUID();
  contactB = crypto.randomUUID();
  db.__sessions = [
    { token: 'member-token', userId: MEMBER },
    { token: 'outsider-token', userId: OUTSIDER },
  ];
  db.workspace_members = [{ id: crypto.randomUUID(), workspace_id: WS, user_id: MEMBER, role: 'agent' }];
  db.contacts = [
    { id: contactA, workspace_id: WS, name: 'Alice', email: 'alice@example.com' },
    { id: contactA2, workspace_id: WS, name: 'Alice 2', email: 'alice2@example.com' },
    { id: contactB, workspace_id: WS_B, name: 'Bob (foreign)', email: 'bob@example.com' },
  ];
  db.conversations = [];
  db.conversation_messages = [];
  db.profiles = [];
});

describe('GET /api/contacts — list', () => {
  it('lists only the caller\'s workspace contacts', async () => {
    const res = await call('GET', `/api/contacts?workspace_id=${WS}`, { token: 'member-token' });
    expect(res.status).toBe(200);
    const ids = res.json.contacts.map((c: any) => c.id);
    expect(ids.sort()).toEqual([contactA, contactA2].sort());
    expect(ids).not.toContain(contactB);
  });

  it('rejects a non-member', async () => {
    const res = await call('GET', `/api/contacts?workspace_id=${WS}`, { token: 'outsider-token' });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/contacts/:id — authorization derives from the contact\'s own workspace_id', () => {
  it('workspace member reads their own contact', async () => {
    const res = await call('GET', `/api/contacts/${contactA}`, { token: 'member-token' });
    expect(res.status).toBe(200);
    expect(res.json.contact.id).toBe(contactA);
  });

  it('rejects reading a contact from a foreign workspace', async () => {
    const res = await call('GET', `/api/contacts/${contactB}`, { token: 'member-token' });
    expect(res.status).toBe(403);
  });

  it('404s a nonexistent contact id', async () => {
    const res = await call('GET', `/api/contacts/${crypto.randomUUID()}`, { token: 'member-token' });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/contacts/:id — update requires proving contact.workspace_id first', () => {
  it('workspace member updates their own contact', async () => {
    const res = await call('PATCH', `/api/contacts/${contactA}`, { token: 'member-token', body: { name: 'Alice Updated' } });
    expect(res.status).toBe(200);
    expect(res.json.contact.name).toBe('Alice Updated');
  });

  it('rejects updating a contact in a foreign workspace — no tenant validation bypass', async () => {
    const res = await call('PATCH', `/api/contacts/${contactB}`, { token: 'member-token', body: { name: 'Hijacked' } });
    expect(res.status).toBe(403);
    expect(db.contacts.find((c) => c.id === contactB)?.name).toBe('Bob (foreign)');
  });
});

describe('DELETE /api/contacts/:id', () => {
  it('workspace member deletes their own contact', async () => {
    const res = await call('DELETE', `/api/contacts/${contactA}`, { token: 'member-token' });
    expect(res.status).toBe(200);
    expect(db.contacts.find((c) => c.id === contactA)).toBeUndefined();
  });

  it('rejects deleting a contact in a foreign workspace', async () => {
    const res = await call('DELETE', `/api/contacts/${contactB}`, { token: 'member-token' });
    expect(res.status).toBe(403);
    expect(db.contacts.find((c) => c.id === contactB)).toBeDefined();
  });
});

describe('POST /api/contacts/bulk-delete', () => {
  it('deletes a batch that all belongs to the caller\'s workspace', async () => {
    const res = await call('POST', '/api/contacts/bulk-delete', { token: 'member-token', body: { ids: [contactA, contactA2] } });
    expect(res.status).toBe(200);
    expect(res.json.deleted).toBe(2);
    expect(db.contacts).toHaveLength(1);
  });

  it('rejects a batch mixing a foreign-workspace id — no partial delete', async () => {
    const res = await call('POST', '/api/contacts/bulk-delete', { token: 'member-token', body: { ids: [contactA, contactB] } });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('mixed_workspace_batch');
    // Neither should have been deleted.
    expect(db.contacts.find((c) => c.id === contactA)).toBeDefined();
    expect(db.contacts.find((c) => c.id === contactB)).toBeDefined();
  });

  it('rejects a batch containing a nonexistent id', async () => {
    const res = await call('POST', '/api/contacts/bulk-delete', { token: 'member-token', body: { ids: [contactA, crypto.randomUUID()] } });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('unknown_contact_id');
    expect(db.contacts.find((c) => c.id === contactA)).toBeDefined();
  });

  it('a batch entirely within a foreign workspace is rejected (caller not a member there)', async () => {
    const res = await call('POST', '/api/contacts/bulk-delete', { token: 'member-token', body: { ids: [contactB] } });
    expect(res.status).toBe(403);
    expect(db.contacts.find((c) => c.id === contactB)).toBeDefined();
  });
});

describe('GET /api/contacts/:id/conversations', () => {
  it('resolves conversations with operator/AI enrichment, scoped to the contact\'s own workspace', async () => {
    const convId = crypto.randomUUID();
    const opId = crypto.randomUUID();
    db.conversations.push({ id: convId, workspace_id: WS, contact_id: contactA, assigned_to: opId, updated_at: '2026-01-01T00:00:00Z' });
    db.conversation_messages.push({ conversation_id: convId, sender_type: 'agent', sender_id: opId, body: 'hello', created_at: '2026-01-01T00:00:01Z' });
    db.profiles.push({ id: opId, full_name: 'Op Erator', email: 'op@example.com', avatar_url: null });

    const res = await call('GET', `/api/contacts/${contactA}/conversations`, { token: 'member-token' });
    expect(res.status).toBe(200);
    expect(res.json.conversations).toHaveLength(1);
    expect(res.json.conversations[0].handled_by_operator).toBe(true);
    expect(res.json.conversations[0].operator_name).toBe('Op Erator');
  });

  it('rejects reading conversations for a foreign-workspace contact', async () => {
    const res = await call('GET', `/api/contacts/${contactB}/conversations`, { token: 'member-token' });
    expect(res.status).toBe(403);
  });
});
