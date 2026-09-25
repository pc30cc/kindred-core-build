/**
 * BLOCKER 2 — Inbox (conversations) routes.
 *
 * useConversations.ts (list, per-tab counts, sidebar counts, message
 * thread, mark-seen, delete-all) used to query `conversations` /
 * `conversation_messages` / `conversation_attachments` / `profiles`
 * directly from the browser (plus one supabase.rpc call for mark-seen),
 * relying on RLS / auth.uid() that no longer resolves without a Supabase
 * Auth session. This proves the replacement routes in
 * server/routes/conversations.ts reproduce every queue/filter/enrichment
 * behavior, and reject cross-workspace access on every id-based operation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};

/** What every fake query settles with. */
type Result = { data: unknown; error: null; count?: number };
type Resolve = (value: Result) => unknown;

/** The subset of the PostgREST builder the conversations routes use. */
interface QueryBuilder {
  select(cols?: string, opts?: { count?: string; head?: boolean }): QueryBuilder;
  eq(col: string, val: unknown): QueryBuilder;
  neq(col: string, val: unknown): QueryBuilder;
  is(col: string, val: unknown): QueryBuilder;
  in(col: string, vals: unknown[]): QueryBuilder;
  or(clauses: string): QueryBuilder;
  order(...args: unknown[]): QueryBuilder;
  limit(...args: unknown[]): QueryBuilder;
  insert(payload: Row | Row[]): { select(): { single(): Promise<Result> }; then(resolve: Resolve): unknown };
  update(patch: Row): UpdateBuilder;
  delete(): DeleteBuilder;
  maybeSingle(): Promise<Result>;
  then(resolve: Resolve): unknown;
}

interface UpdateBuilder {
  eq(col: string, val: unknown): UpdateBuilder;
  is(col: string, val: unknown): UpdateBuilder;
  select(): { then(resolve: Resolve): unknown };
  then(resolve: Resolve): unknown;
}

interface DeleteBuilder {
  eq(col: string, val: unknown): DeleteBuilder;
  in(col: string, vals: unknown[]): DeleteBuilder;
  then(resolve: Resolve): unknown;
}

/** A response body as the tests read it. */
interface ResponseBody {
  conversations?: Row[];
  conversation?: Row;
  messages?: Row[];
  [key: string]: unknown;
}

// A single OR clause like "ai_state.is.null" or "ai_state.neq.ai_managed".
function evalOrClause(row: Row, clause: string): boolean {
  const [col, op, ...rest] = clause.split('.');
  const val = rest.join('.');
  if (op === 'is') return val === 'null' ? row[col] === null || row[col] === undefined : row[col] === val;
  if (op === 'neq') return row[col] !== val;
  if (op === 'eq') return row[col] === val;
  return false;
}

function fakeClient() {
  return {
    from(table: string) {
      const rows: Row[] = db[table] || (db[table] = []);
      const filters: Array<(r: Row) => boolean> = [];
      let inFilter: { col: string; vals: unknown[] } | null = null;
      // PostgREST ANDs successive .or() calls together, each one its own
      // group. The list query makes two — one narrowing ai_state, one
      // narrowing assignment scope — and a single slot meant the second
      // silently replaced the first, letting an ai_managed conversation into
      // the main queue in the fake but not in production.
      const orGroups: string[][] = [];
      let countMode = false;
      const builder: QueryBuilder = {
        select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
          if (opts?.head) countMode = true;
          return builder;
        },
        eq(col: string, val: unknown) { filters.push((r) => r[col] === val); return builder; },
        neq(col: string, val: unknown) { filters.push((r) => r[col] !== val); return builder; },
        is(col: string, val: unknown) { filters.push((r) => (val === null ? (r[col] === null || r[col] === undefined) : r[col] === val)); return builder; },
        in(col: string, vals: unknown[]) { inFilter = { col, vals }; return builder; },
        or(clauseStr: string) { orGroups.push(clauseStr.split(',')); return builder; },
        order: () => builder,
        limit: () => builder,
        insert(payload: Row | Row[]) {
          const items = Array.isArray(payload) ? payload : [payload];
          const inserted = items.map((it) => ({ id: it.id ?? crypto.randomUUID(), created_at: new Date().toISOString(), ...it }));
          rows.push(...inserted);
          return {
            select: () => ({ single: async () => ({ data: inserted[0], error: null }) }),
            then: (resolve: Resolve) => resolve({ data: inserted, error: null }),
          };
        },
        update(patch: Row) {
          const scoped: Array<(r: Row) => boolean> = [...filters];
          const updateBuilder: UpdateBuilder = {
            eq(col: string, val: unknown) { scoped.push((r: Row) => r[col] === val); return updateBuilder; },
            is(col: string, val: unknown) { scoped.push((r: Row) => (val === null ? r[col] == null : r[col] === val)); return updateBuilder; },
            select() {
              const matched = rows.filter((r) => scoped.every((f) => f(r)));
              for (const r of matched) Object.assign(r, patch);
              return { then: (resolve: Resolve) => resolve({ data: matched, error: null }) };
            },
            then(resolve: Resolve) {
              for (const r of rows) if (scoped.every((f) => f(r))) Object.assign(r, patch);
              return resolve({ data: null, error: null });
            },
          };
          return updateBuilder;
        },
        delete() {
          const scoped: Array<(r: Row) => boolean> = [...filters];
          const deleteBuilder: DeleteBuilder = {
            eq(col: string, val: unknown) { scoped.push((r: Row) => r[col] === val); return deleteBuilder; },
            in(col: string, vals: unknown[]) { scoped.push((r: Row) => vals.includes(r[col])); return deleteBuilder; },
            then(resolve: Resolve) {
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
        then(resolve: Resolve) {
          let matched = rows.filter((r) => filters.every((f) => f(r)));
          if (inFilter) matched = matched.filter((r) => inFilter!.vals.includes(r[inFilter!.col]));
          for (const group of orGroups) {
            matched = matched.filter((r) => group.some((c) => evalOrClause(r, c)));
          }
          if (countMode) return resolve({ data: null, error: null, count: matched.length });
          return resolve({ data: matched, error: null });
        },
      };
      return builder;
    },
    rpc: async (name: string, args: Row) => {
      if (name === 'is_workspace_member') {
        const member = (db.workspace_members || []).find(
          (m) => m.workspace_id === args._workspace_id && m.user_id === args._user_id,
        );
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
vi.mock('../../../server/services/realtime/publish.js', () => ({
  publishConversationEvent: async () => ({ ok: false, reason: 'not_configured' }),
  publishOperatorEvent: async () => ({ ok: false }),
  buildMessageEnvelope: (m: unknown) => ({ type: 'message', payload: m }),
}));
vi.mock('../../../server/services/billing/conversationLimit.js', () => ({
  enforceMaxConversationsLimit: async () => true,
}));

const { conversationsRouter } = await import('../../../server/routes/conversations.js');

const app = express();
app.use((req, _res, next) => {
  Object.assign(req, { serverConfig: { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: ['*'] } });
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use('/api/conversations', conversationsRouter);

const server = http.createServer(app).listen(0);
const port = () => (server.address() as AddressInfo).port;

function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<{ status: number; json: ResponseBody }> {
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
          let json: ResponseBody = {};
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
let convOpen: string, convPending: string, convAutomated: string, convSpam: string, convNeedsHuman: string, convForeign: string;

beforeEach(() => {
  for (const key of Object.keys(db)) delete db[key];
  convOpen = crypto.randomUUID();
  convPending = crypto.randomUUID();
  convAutomated = crypto.randomUUID();
  convSpam = crypto.randomUUID();
  convNeedsHuman = crypto.randomUUID();
  convForeign = crypto.randomUUID();
  db.__sessions = [
    { token: 'member-token', userId: MEMBER },
    { token: 'outsider-token', userId: OUTSIDER },
  ];
  db.workspace_members = [
    { id: crypto.randomUUID(), workspace_id: WS, user_id: MEMBER, role: 'owner' },
  ];
  db.conversations = [
    { id: convOpen, workspace_id: WS, status: 'open', is_spam: false, ai_state: null, assigned_to: null, updated_at: '2026-01-01T00:00:00Z' },
    { id: convPending, workspace_id: WS, status: 'pending', is_spam: false, ai_state: null, assigned_to: null, updated_at: '2026-01-02T00:00:00Z' },
    { id: convAutomated, workspace_id: WS, status: 'open', is_spam: false, ai_state: 'ai_managed', assigned_to: null, updated_at: '2026-01-03T00:00:00Z' },
    { id: convSpam, workspace_id: WS, status: 'open', is_spam: true, ai_state: null, assigned_to: null, updated_at: '2026-01-04T00:00:00Z' },
    { id: convNeedsHuman, workspace_id: WS, status: 'open', is_spam: false, ai_state: 'needs_human', assigned_to: null, updated_at: '2026-01-05T00:00:00Z' },
    { id: convForeign, workspace_id: WS_B, status: 'open', is_spam: false, ai_state: null, assigned_to: null, updated_at: '2026-01-06T00:00:00Z' },
  ];
  db.contacts = [];
  db.conversation_messages = [];
  db.conversation_attachments = [];
  db.profiles = [];
});

describe('GET /api/conversations — inbox list, queue filtering', () => {
  it('lists all workspace conversations for the main queue (excludes spam and automated)', async () => {
    const res = await call('GET', `/api/conversations?workspace_id=${WS}&queue=main`, { token: 'member-token' });
    expect(res.status).toBe(200);
    const ids = res.json.conversations.map((c) => c.id);
    expect(ids).toContain(convOpen);
    expect(ids).toContain(convPending);
    expect(ids).toContain(convNeedsHuman);
    expect(ids).not.toContain(convSpam);
    expect(ids).not.toContain(convAutomated);
    expect(ids).not.toContain(convForeign);
  });

  it('automated queue returns only unassigned ai_managed, non-spam conversations', async () => {
    const res = await call('GET', `/api/conversations?workspace_id=${WS}&queue=automated`, { token: 'member-token' });
    expect(res.status).toBe(200);
    const ids = res.json.conversations.map((c) => c.id);
    expect(ids).toEqual([convAutomated]);
  });

  it('spam queue returns only is_spam=true conversations', async () => {
    const res = await call('GET', `/api/conversations?workspace_id=${WS}&queue=spam`, { token: 'member-token' });
    expect(res.status).toBe(200);
    const ids = res.json.conversations.map((c) => c.id);
    expect(ids).toEqual([convSpam]);
  });

  it('needs_human filter restricts main queue to ai_state=needs_human', async () => {
    const res = await call('GET', `/api/conversations?workspace_id=${WS}&queue=main&needs_human=true`, { token: 'member-token' });
    expect(res.status).toBe(200);
    const ids = res.json.conversations.map((c) => c.id);
    expect(ids).toEqual([convNeedsHuman]);
  });

  it('status filter narrows the main queue to one or more statuses', async () => {
    const res = await call('GET', `/api/conversations?workspace_id=${WS}&queue=main&status=pending`, { token: 'member-token' });
    expect(res.status).toBe(200);
    const ids = res.json.conversations.map((c) => c.id);
    expect(ids).toEqual([convPending]);
  });

  it('rejects a non-member (tenant isolation)', async () => {
    const res = await call('GET', `/api/conversations?workspace_id=${WS}&queue=main`, { token: 'outsider-token' });
    expect(res.status).toBe(403);
  });

  it('unauthenticated caller rejected', async () => {
    const res = await call('GET', `/api/conversations?workspace_id=${WS}&queue=main`);
    expect(res.status).toBe(401);
  });
});

describe('GET /api/conversations/inbox-counts and /inbox-tab-counts', () => {
  it('sidebar counts reflect the queue definitions', async () => {
    const res = await call('GET', `/api/conversations/inbox-counts?workspace_id=${WS}`, { token: 'member-token' });
    expect(res.status).toBe(200);
    expect(res.json.main).toBe(3); // open, pending, needs_human
    expect(res.json.automated).toBe(1);
    expect(res.json.spam).toBe(1);
    expect(res.json.needs_human).toBe(1);
  });

  it('tab counts reflect per-status breakdown within the main queue', async () => {
    const res = await call('GET', `/api/conversations/inbox-tab-counts?workspace_id=${WS}`, { token: 'member-token' });
    expect(res.status).toBe(200);
    expect(res.json.open).toBe(2); // convOpen + convNeedsHuman are both status='open'
    expect(res.json.pending).toBe(1);
    expect(res.json.all).toBe(3);
  });

  it('counts reject a non-member', async () => {
    const res = await call('GET', `/api/conversations/inbox-counts?workspace_id=${WS}`, { token: 'outsider-token' });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/conversations/:id/messages — authorization derives from the conversation, not a client-supplied workspace_id', () => {
  it('workspace member reads messages for their own conversation', async () => {
    db.conversation_messages.push({ id: crypto.randomUUID(), conversation_id: convOpen, sender_type: 'contact', body: 'hi', created_at: '2026-01-01T00:00:00Z' });
    const res = await call('GET', `/api/conversations/${convOpen}/messages`, { token: 'member-token' });
    expect(res.status).toBe(200);
    expect(res.json.messages).toHaveLength(1);
  });

  it('rejects a direct request for a conversation in a foreign workspace', async () => {
    const res = await call('GET', `/api/conversations/${convForeign}/messages`, { token: 'member-token' });
    expect(res.status).toBe(403);
  });

  it('404s a nonexistent conversation id', async () => {
    const res = await call('GET', `/api/conversations/${crypto.randomUUID()}/messages`, { token: 'member-token' });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/conversations/:id/seen', () => {
  it('marks unseen visitor messages as seen and is workspace-scoped by the conversation itself', async () => {
    const msgId = crypto.randomUUID();
    db.conversation_messages.push({ id: msgId, conversation_id: convOpen, sender_type: 'contact', body: 'hi', seen_at: null, created_at: '2026-01-01T00:00:00Z' });
    const res = await call('POST', `/api/conversations/${convOpen}/seen`, { token: 'member-token' });
    expect(res.status).toBe(200);
    expect(res.json.count).toBe(1);
    expect(db.conversation_messages.find((m) => m.id === msgId)?.seen_at).not.toBeNull();
  });

  it('rejects marking a foreign-workspace conversation as seen', async () => {
    const res = await call('POST', `/api/conversations/${convForeign}/seen`, { token: 'member-token' });
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/conversations — delete-all is destructive, so it requires manage:true', () => {
  it('a plain member (non-owner/admin) cannot delete all conversations', async () => {
    // Demote MEMBER to a non-manager role for this test.
    db.workspace_members[0].role = 'agent';
    const res = await call('DELETE', '/api/conversations', { token: 'member-token', body: { workspace_id: WS } });
    expect(res.status).toBe(403);
    expect(db.conversations.filter((c) => c.workspace_id === WS)).toHaveLength(5);
  });

  it('owner can delete all conversations in their workspace, and it never touches another workspace', async () => {
    const res = await call('DELETE', '/api/conversations', { token: 'member-token', body: { workspace_id: WS } });
    expect(res.status).toBe(200);
    expect(res.json.deleted).toBe(5);
    expect(db.conversations.filter((c) => c.workspace_id === WS)).toHaveLength(0);
    expect(db.conversations.find((c) => c.id === convForeign)).toBeDefined();
  });
});

describe('GET /api/conversations/:id — one conversation, as a row of the list', () => {
  const one = (id: string, token?: string, workspaceId: string | null = WS) =>
    call('GET', `/api/conversations/${id}${workspaceId ? `?workspace_id=${workspaceId}` : ''}`, token ? { token } : {});

  it('returns the conversation with the same enrichment the list gives it', async () => {
    db.conversation_messages.push(
      { id: crypto.randomUUID(), conversation_id: convOpen, sender_type: 'contact', body: 'first', seen_at: null, created_at: '2026-01-01T00:00:00Z' },
      { id: crypto.randomUUID(), conversation_id: convOpen, sender_type: 'contact', body: 'second', seen_at: null, created_at: '2026-01-01T00:01:00Z' },
    );
    const byId = await one(convOpen, 'member-token');
    expect(byId.status).toBe(200);
    expect(byId.json.conversation.id).toBe(convOpen);
    expect(byId.json.conversation.unread_count).toBe(2);

    const list = await call('GET', `/api/conversations?workspace_id=${WS}&queue=main`, { token: 'member-token' });
    const row = list.json.conversations.find((c) => c.id === convOpen);
    expect(byId.json.conversation.unread_count).toBe(row.unread_count);
    expect(byId.json.conversation.last_message).toEqual(row.last_message);
  });

  it('finds a conversation whatever queue it is in (spam, automated)', async () => {
    expect((await one(convSpam, 'member-token')).status).toBe(200);
    expect((await one(convAutomated, 'member-token')).status).toBe(200);
  });

  it('never returns a conversation of another workspace', async () => {
    // Named under the caller's own workspace: not there.
    expect((await one(convForeign, 'member-token')).status).toBe(404);
    // Named under its real workspace: the caller is not a member of it.
    expect((await one(convForeign, 'member-token', WS_B)).status).toBe(403);
  });

  it('rejects an unauthenticated caller and a non-member', async () => {
    expect((await one(convOpen)).status).toBe(401);
    expect((await one(convOpen, 'outsider-token')).status).toBe(403);
  });

  it('requires workspace_id, 404s an unknown id and leaves a non-id to other routes', async () => {
    expect((await one(convOpen, 'member-token', null)).status).toBe(400);
    expect((await one(crypto.randomUUID(), 'member-token')).status).toBe(404);
    expect((await one('not-a-uuid', 'member-token')).status).toBe(404);
  });

  it('never shadows the literal routes registered before it', async () => {
    const res = await call('GET', `/api/conversations/inbox-counts?workspace_id=${WS}`, { token: 'member-token' });
    expect(res.status).toBe(200);
    expect(res.json.main).toBe(3);
  });
});
