/**
 * What the widget API tells a template about who answers (contract §3,
 * `conversationOperator` / `chatHeader`) and the article vote's middle face:
 *
 *  - GET /conversations: each row carries `operatorName`, `operatorAvatar`
 *    and `operatorOnline` of its assigned operator, from ONE profile read for
 *    the whole list and the cached workspace snapshot's availability (no
 *    query per row);
 *  - GET /history: `assigned_operator` ({ name, avatar, online } or null);
 *  - both only on request (`operator=1`, which runtime.js sends for a
 *    renderer that draws who answers): without it (the default template)
 *    the routes read and answer exactly what they did before, with no
 *    profile read and no workspace snapshot lookup of their own;
 *  - POST /kb/articles/:slug/feedback accepts 'neutral'; until migration 275
 *    widens the CHECK, the database refuses it and the API answers 400
 *    invalid_rating, as for any rating it refuses.
 *
 * The REAL widgetRouter runs in-process against an in-memory fake of the
 * data layer (as messageSendBehavioral.test.ts does).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

const WS = '11111111-1111-4111-8111-111111111111';
const OP_ONLINE = '22222222-2222-4222-8222-222222222222';
const OP_AWAY = '33333333-3333-4333-8333-333333333333';

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  reads: [] as Array<{ table: string; select: string }>,
  failInsert: null as null | { code: string; message: string },
}));

/** The fake's query chain: every PostgREST-style call returns the chain. */
interface FakeQuery {
  [method: string]: unknown;
  then: <T>(resolve: (r: { data: Row[]; error: null }) => T) => Promise<T>;
}

function builder(table: string): FakeQuery {
  const filters: Array<(r: Row) => boolean> = [];
  let max = Infinity;
  const rows = () => (db.tables[table] || []).filter((r) => filters.every((f) => f(r))).slice(0, max);
  const self = () => b;
  const b: FakeQuery = {
    select: (cols = '*') => { db.reads.push({ table, select: cols }); return b; },
    eq: (col: string, val: unknown) => { filters.push((r) => r[col] === val); return b; },
    in: (col: string, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return b; },
    is: self, not: self, or: self, contains: self, order: self, filter: self,
    limit: (n: number) => { max = n; return b; },
    maybeSingle: async () => ({ data: rows()[0] || null, error: null }),
    single: async () => ({ data: rows()[0] || null, error: null }),
    update: () => {
      const u: FakeQuery = {
        eq: () => u, select: () => u, limit: () => u,
        then: (res) => Promise.resolve({ data: [] as Row[], error: null as null }).then(res),
      };
      return u;
    },
    insert: async () => ({ error: db.failInsert }),
    then: (resolve) => Promise.resolve({ data: rows(), error: null as null }).then(resolve),
  };
  return b;
}

type Next = () => void;

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => ({ from: (t: string) => builder(t), rpc: async () => ({ data: null, error: null }) }) }));
vi.mock('../../../server/services/widget/visitorIdentity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/widget/visitorIdentity.js')>()),
  readVisitorCookie: () => ({ v: 'visitor-1' }),
}));
vi.mock('../../../server/services/widget/security.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/widget/security.js')>()),
  enforceWidgetToken: (_req: unknown, _res: unknown, next: Next) => next(),
  enforceOrigin: (_req: unknown, _res: unknown, next: Next) => next(),
  widgetRateLimit: () => (_req: unknown, _res: unknown, next: Next) => next(),
  resolveWorkspaceId: (_req: unknown, _res: unknown, wsId: string) => wsId || WS,
  verifyConversationOwnership: async (_c: unknown, conversationId: string) => {
    const conv = (db.tables.conversations || []).find((c) => c.id === conversationId);
    return conv ? { valid: true, conversation: conv } : { valid: false, conversation: null };
  },
}));
vi.mock('../../../server/services/widget/configSnapshot.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/widget/configSnapshot.js')>()),
  // Only OP_ONLINE is a member with no availability prefs (= reachable).
  // Counted as a read: on a cold entry it is a rebuild of the whole snapshot.
  getWorkspaceWidgetSnapshot: async () => {
    db.reads.push({ table: '(workspace snapshot)', select: '' });
    return { availabilityPrefs: { memberIds: [OP_ONLINE], prefsByUser: new Map() } };
  },
}));
vi.mock('../../../server/services/storage/urlResolver.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/storage/urlResolver.js')>()),
  hydrateUserAvatars: async (_c: unknown, rows: Row[]) => {
    for (const r of rows || []) { r.avatar_url = r.avatar_storage_key ? `https://cdn.test/${r.avatar_storage_key}` : null; delete r.avatar_storage_key; }
    return rows;
  },
}));
vi.mock('../../../server/services/knowledge-base/locks.js', () => ({
  resolveKbLock: async () => null,
  applyKbUnlockedFilter: (q: unknown) => q,
}));
vi.mock('../../../server/routes/widgetIdentity.js', () => ({ widgetIdentityRouter: express.Router() }));
vi.mock('../../../server/routes/widgetCallbacks.js', () => ({ widgetCallbacksRouter: express.Router() }));
vi.mock('../../../server/routes/widgetDepartments.js', () => ({ widgetDepartmentsRouter: express.Router() }));
vi.mock('../../../server/routes/widgetCallInvitations.js', () => ({ widgetCallInvitationsRouter: express.Router() }));
vi.mock('../../../server/routes/widgetAttachments.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/routes/widgetAttachments.js')>()),
  widgetAttachmentsRouter: express.Router(),
  enrichMessagesWithAttachments: async (_c: unknown, _w: string, m: unknown[]) => m,
  enrichMessagesWithReplyTo: async (_c: unknown, _id: string, m: unknown[]) => m,
}));

const { widgetRouter } = await import('../../../server/routes/widget.js');
const app = express();
app.use((req, _res, next) => {
  (req as unknown as Record<string, unknown>).serverConfig = { supabaseUrl: 'https://x.test', supabaseServiceRoleKey: 'k' };
  next();
});
app.use(express.json());
app.use('/api/widget', widgetRouter);
const server = http.createServer(app).listen(0);

/** A JSON answer as the tests read it. */
type Answer = { status: number; body: Record<string, unknown> & { conversations?: Array<{ id: string }> } };

function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request({
      host: '127.0.0.1', port: (server.address() as AddressInfo).port, path, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: d ? JSON.parse(d) : null }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

beforeEach(() => {
  db.reads.length = 0;
  db.failInsert = null;
  db.tables = {
    visitor_sessions: [{ id: 'sess-1', workspace_id: WS, visitor_id: 'visitor-1' }],
    contacts: [],
    conversations: [
      { id: 'c-online', workspace_id: WS, status: 'open', updated_at: '2026-10-17T10:00:00Z', assigned_to: OP_ONLINE, visitor_session_id: 'sess-1' },
      { id: 'c-away', workspace_id: WS, status: 'resolved', updated_at: '2026-10-16T10:00:00Z', assigned_to: OP_AWAY, visitor_session_id: 'sess-1' },
      { id: 'c-none', workspace_id: WS, status: 'open', updated_at: '2026-10-15T10:00:00Z', assigned_to: null, visitor_session_id: 'sess-1' },
    ],
    widget_conversation_reads: [],
    conversation_messages: [],
    profiles: [
      { id: OP_ONLINE, full_name: 'سارا', avatar_storage_key: 'sara.png' },
      { id: OP_AWAY, full_name: 'مهدی', avatar_storage_key: null },
    ],
    knowledge_base_articles: [{ id: 'art-1', workspace_id: WS, slug: 'track', locale: 'fa' }],
  };
});

describe('GET /api/widget/conversations — the assigned operator on every row', () => {
  it('carries name, avatar and presence, and null when nobody is assigned', async () => {
    const res = await call('GET', `/api/widget/conversations?workspace_id=${WS}&operator=1`);
    expect(res.status).toBe(200);
    const byId = Object.fromEntries((res.body.conversations || []).map((c) => [c.id, c]));
    expect(byId['c-online']).toMatchObject({ operatorName: 'سارا', operatorAvatar: 'https://cdn.test/sara.png', operatorOnline: true });
    expect(byId['c-away']).toMatchObject({ operatorName: 'مهدی', operatorAvatar: null, operatorOnline: false });
    expect(byId['c-none']).toMatchObject({ operatorName: null, operatorAvatar: null, operatorOnline: false });
  });

  it('reads the profiles ONCE for the whole list (no query per row)', async () => {
    await call('GET', `/api/widget/conversations?workspace_id=${WS}&operator=1`);
    expect(db.reads.filter((r) => r.table === 'profiles')).toHaveLength(1);
    expect(db.reads.find((r) => r.table === 'conversations')!.select).toContain('assigned_to');
  });

  it('without operator=1 (the default template) reads and answers exactly what it did before', async () => {
    const res = await call('GET', `/api/widget/conversations?workspace_id=${WS}`);
    expect(res.status).toBe(200);
    expect(db.reads.map((r) => r.table)).toEqual([
      'visitor_sessions', 'contacts', 'conversations', 'widget_conversation_reads', 'conversation_messages',
    ]);
    expect(db.reads.find((r) => r.table === 'conversations')!.select).toBe('id, status, updated_at');
    for (const row of res.body.conversations || []) {
      expect(Object.keys(row)).toEqual([
        'id', 'status', 'updatedAt', 'preview', 'attachmentKind', 'outbound', 'unreadCount', 'lastMessageAt',
      ]);
    }
  });
});

describe('GET /api/widget/history — assigned_operator', () => {
  it('is { name, avatar, online } for an assigned thread', async () => {
    const res = await call('GET', `/api/widget/history?workspace_id=${WS}&conversation_id=c-online&operator=1`);
    expect(res.status).toBe(200);
    expect(res.body.assigned_operator).toEqual({ name: 'سارا', avatar: 'https://cdn.test/sara.png', online: true });
  });

  it('is null while nobody is assigned', async () => {
    const res = await call('GET', `/api/widget/history?workspace_id=${WS}&conversation_id=c-none&operator=1`);
    expect(res.body.assigned_operator).toBeNull();
    expect(db.reads.filter((r) => r.table === 'profiles')).toHaveLength(0);
  });

  it('without operator=1 (the default template) reads and answers exactly what it did before', async () => {
    db.tables.conversation_messages = [
      { id: 'm1', conversation_id: 'c-online', body: 'سلام', sender_type: 'agent', sender_id: OP_ONLINE, created_at: '2026-10-17T09:01:00Z', metadata: {} },
    ];
    const res = await call('GET', `/api/widget/history?workspace_id=${WS}&conversation_id=c-online`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['messages']);
    // The thread's own sender lookup only: one profile read, no snapshot.
    expect(db.reads.map((r) => r.table)).toEqual(['conversation_messages', 'profiles']);
    expect((res.body.messages as Array<Record<string, unknown>>)[0]).toMatchObject({ sender_name: 'سارا' });
  });
});

describe('POST /api/widget/kb/articles/:slug/feedback — the neutral face', () => {
  it('accepts up, neutral and down', async () => {
    for (const rating of ['up', 'neutral', 'down']) {
      const res = await call('POST', `/api/widget/kb/articles/track/feedback?workspace_id=${WS}&locale=fa`, { rating, workspace_id: WS });
      expect(res.status, rating).toBe(200);
      expect(res.body).toEqual({ ok: true, rating });
    }
  });

  it('refuses any other value as before', async () => {
    const res = await call('POST', `/api/widget/kb/articles/track/feedback?workspace_id=${WS}`, { rating: 'meh', workspace_id: WS });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_rating' });
  });

  it('before migration 275 the CHECK refuses neutral: answered as invalid input, not a server error', async () => {
    db.failInsert = { code: '23514', message: 'new row violates check constraint "kb_article_feedback_rating_chk"' };
    const res = await call('POST', `/api/widget/kb/articles/track/feedback?workspace_id=${WS}`, { rating: 'neutral', workspace_id: WS });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_rating' });
  });
});
