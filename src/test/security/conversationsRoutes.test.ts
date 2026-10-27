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
/** When set, the fake conversation_inbox_counters RPC answers with this row. */
let inboxCounters: Row | null = null;
const inboxCounterCalls: Row[] = [];
/** Every patch_conversation_metadata call (recorded only: the rows stay as they are). */
const metadataPatches: Array<{ conversationId: unknown; patch: Row }> = [];
/**
 * When set, a read of conversation_messages takes its rows at once (as a real
 * read takes its snapshot when it starts) but answers only when this settles.
 */
let holdMessageReads: Promise<void> | null = null;
let heldMessageReads = 0;

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
  filter(path: string, op: string, val: unknown): QueryBuilder;
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
  select(cols?: string): { then(resolve: Resolve): unknown };
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
      const sorts: Array<{ col: string; ascending: boolean }> = [];
      let countMode = false;
      // Applied with the server's own row cap (DATABASE_MAX_ROWS, 1000), as a
      // real read is: a limit never returns more, whatever it asks for.
      let rowLimit: number | null = null;
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
        // `metadata->>key eq value` (send-message's idempotency lookup).
        filter(path: string, _op: string, val: unknown) {
          const m = /^metadata->>(\w+)$/.exec(path);
          if (m) filters.push((r) => ((r.metadata || {}) as Row)[m[1]] === val);
          return builder;
        },
        // Applied, so an answer's order can be tested (the unread ids).
        order(col: string, opts?: { ascending?: boolean }) { sorts.push({ col, ascending: opts?.ascending !== false }); return builder; },
        limit(n: unknown) { rowLimit = Math.min(Number(n), 1000); return builder; },
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
            select(cols?: string) {
              const matched = rows.filter((r) => scoped.every((f) => f(r)));
              for (const r of matched) Object.assign(r, patch);
              // `alias:col->>key` projections of the representation: a jsonb
              // field as text, null when absent (every column is returned too).
              const aliases = String(cols || '').split(',').map((c) => /^\s*(\w+):(\w+)->>(\w+)\s*$/.exec(c))
                .filter((m): m is RegExpExecArray => !!m);
              const project = (r: Row): Row => {
                const out: Row = { ...r };
                for (const [, alias, col, key] of aliases) {
                  const v = ((r[col] || {}) as Row)[key];
                  out[alias] = v === undefined || v === null ? null : String(v);
                }
                return out;
              };
              return { then: (resolve: Resolve) => resolve({ data: matched.map(project), error: null }) };
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
          for (const { col, ascending } of [...sorts].reverse()) {
            matched = [...matched].sort((a, b) => {
              const x = String(a[col] ?? '');
              const y = String(b[col] ?? '');
              return (x < y ? -1 : x > y ? 1 : 0) * (ascending ? 1 : -1);
            });
          }
          if (countMode) return resolve({ data: null, error: null, count: matched.length });
          if (rowLimit !== null) matched = matched.slice(0, rowLimit);
          if (table === 'conversation_messages' && holdMessageReads) {
            heldMessageReads += 1;
            const taken = matched.map((r) => ({ ...r }));
            return holdMessageReads.then(() => resolve({ data: taken, error: null }));
          }
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
      if (name === 'conversation_inbox_counters' && inboxCounters) {
        inboxCounterCalls.push(args);
        return { data: [inboxCounters], error: null };
      }
      if (name === 'conversation_inbox_counters') {
        // A database without migration 241 answers "function not found".
        return { data: null, error: { code: 'PGRST202', message: 'function not found' } };
      }
      if (name === 'patch_conversation_metadata') {
        metadataPatches.push({ conversationId: args.p_conversation_id, patch: args.p_patch as Row });
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
const operatorEvents = vi.hoisted(() => [] as Array<{ payload: Record<string, unknown>; opts?: { skipConversationChannel?: boolean } }>);
const conversationPublishes = vi.hoisted(() => [] as Array<{ conversationId: string; event: { type: string; payload: Record<string, unknown> } }>);
vi.mock('../../../server/services/realtime/publish.js', () => ({
  publishConversationEvent: async (_c: unknown, _w: string, conversationId: string, event: { type: string; payload: Record<string, unknown> }) => {
    conversationPublishes.push({ conversationId, event });
    return { ok: false, reason: 'not_configured' };
  },
  publishOperatorEvent: async (_c: unknown, payload: Record<string, unknown>, opts?: { skipConversationChannel?: boolean }) => {
    operatorEvents.push({ payload, opts });
    return { ok: false };
  },
  buildMessageEnvelope: (m: unknown) => ({ type: 'message', payload: m }),
}));
vi.mock('../../../server/services/billing/conversationLimit.js', () => ({
  enforceMaxConversationsLimit: async () => true,
}));
const wakes = vi.hoisted(() => [] as Array<{ workspaceId: string; conversationId: string }>);
vi.mock('../../../server/services/widget/visitorWake.js', () => ({
  wakeVisitorWidget: async (_c: unknown, workspaceId: string, conversationId: string) => { wakes.push({ workspaceId, conversationId }); },
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
  metadataPatches.length = 0;
  holdMessageReads = null;
  heldMessageReads = 0;
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

  it('status=resolved is the finished tab: resolved and closed, for the apps that ask for resolved alone', async () => {
    const convResolved = crypto.randomUUID();
    const convClosed = crypto.randomUUID();
    db.conversations.push(
      { id: convResolved, workspace_id: WS, status: 'resolved', is_spam: false, ai_state: null, assigned_to: null, updated_at: '2026-01-07T00:00:00Z' },
      { id: convClosed, workspace_id: WS, status: 'closed', is_spam: false, ai_state: null, assigned_to: null, updated_at: '2026-01-08T00:00:00Z' },
      { id: crypto.randomUUID(), workspace_id: WS, status: 'closed', is_spam: true, ai_state: null, assigned_to: null, updated_at: '2026-01-09T00:00:00Z' },
    );
    const ids = async (query: string) => {
      const res = await call('GET', `/api/conversations?workspace_id=${WS}&queue=main&${query}`, { token: 'member-token' });
      expect(res.status).toBe(200);
      return (res.json.conversations as Array<{ id: string }>).map((c) => c.id).sort();
    };
    expect(await ids('status=resolved')).toEqual([convResolved, convClosed].sort());
    expect(await ids('status=resolved,closed')).toEqual([convResolved, convClosed].sort());
    expect(await ids('status=closed')).toEqual([convClosed]);
    expect(await ids('status=open')).toEqual([convOpen, convNeedsHuman].sort());
  });

  it('status=closed alone is the Closed box: every closed conversation, the AI-held ones the timer closed too', async () => {
    const convClosed = crypto.randomUUID();
    const convAiClosed = crypto.randomUUID();
    const convAiResolved = crypto.randomUUID();
    db.conversations.push(
      { id: convClosed, workspace_id: WS, status: 'closed', is_spam: false, ai_state: null, assigned_to: null, updated_at: '2026-01-08T00:00:00Z' },
      { id: convAiClosed, workspace_id: WS, status: 'closed', is_spam: false, ai_state: 'ai_managed', assigned_to: null, updated_at: '2026-01-09T00:00:00Z' },
      { id: convAiResolved, workspace_id: WS, status: 'resolved', is_spam: false, ai_state: 'ai_managed', assigned_to: null, updated_at: '2026-01-10T00:00:00Z' },
      { id: crypto.randomUUID(), workspace_id: WS, status: 'closed', is_spam: true, ai_state: 'ai_managed', assigned_to: null, updated_at: '2026-01-11T00:00:00Z' },
    );
    const ids = async (query: string) => {
      const res = await call('GET', `/api/conversations?workspace_id=${WS}&queue=main&${query}`, { token: 'member-token' });
      expect(res.status).toBe(200);
      return (res.json.conversations as Array<{ id: string }>).map((c) => c.id).sort();
    };
    expect(await ids('status=closed')).toEqual([convClosed, convAiClosed].sort());
    // Every other status keeps the AI's conversations in their own queue.
    expect(await ids('status=resolved')).toEqual([convClosed]);
    expect(await ids('status=resolved,closed')).toEqual([convClosed]);
  });

  it('the Closed box keeps an AI-greeted conversation whose messages fell outside the list\'s one message window', async () => {
    const intro = { source: 'ai_agent_intro', ai_state: 'ai_managed' };
    const timer = (outcome: string) => ({ ...intro, closed_reason: 'inactivity', closed_by: 'system', closed_outcome: outcome });
    const closed = (id: string, metadata: Row, updatedAt: string, more: Row = {}) => ({
      id, workspace_id: WS, status: 'closed', is_spam: false, ai_state: 'ai_managed', assigned_to: null, metadata, updated_at: updatedAt, ...more,
    });
    const msg = (cid: string, sender: string, at: string, metadata: Row = {}) => ({
      id: crypto.randomUUID(), conversation_id: cid, sender_type: sender, sender_id: sender === 'agent' ? MEMBER : null,
      body: 'x', created_at: at, seen_at: at, metadata,
    });
    const filler = crypto.randomUUID(); // a person's, with 1000 newer messages: the window is full
    const aiOld = crypto.randomUUID(); // the AI answered the visitor; nothing of it read
    const aiSplit = crypto.randomUUID(); // its AI answer read, the visitor's turn before it not
    const aiNoMarkers = crypto.randomUUID(); // closed before 284 (no markers); nothing read
    const greetOnly = crypto.randomUUID(); // the timer closed a greeting nobody answered; nothing read
    const greetRead = crypto.randomUUID(); // a greeting nobody answered, read: kept out as before
    db.conversations.push(
      closed(filler, {}, '2026-02-10T00:00:00Z', { ai_state: null, assigned_to: MEMBER }),
      closed(aiOld, timer('ai_unresolved'), '2026-01-10T00:10:00Z'),
      closed(aiSplit, timer('ai_resolved'), '2026-01-10T00:09:00Z'),
      closed(aiNoMarkers, intro, '2026-01-10T00:08:00Z'),
      closed(greetOnly, timer('no_visitor_message'), '2026-01-10T00:07:00Z'),
      closed(greetRead, intro, '2026-01-10T00:06:00Z'),
    );
    const greeting = { source: 'ai_agent_intro' };
    db.conversation_messages.push(
      msg(aiOld, 'ai', '2026-01-10T00:00:00.000Z', greeting),
      msg(aiOld, 'contact', '2026-01-10T00:01:00.000Z'),
      msg(aiOld, 'ai', '2026-01-10T00:02:00.000Z'),
      msg(greetOnly, 'ai', '2026-01-10T00:03:00.000Z', greeting),
      msg(aiNoMarkers, 'contact', '2026-01-10T00:04:00.000Z'),
      msg(aiNoMarkers, 'ai', '2026-01-10T00:04:30.000Z'),
      msg(aiSplit, 'contact', '2026-01-10T00:05:00.000Z'),
      msg(aiSplit, 'ai', '2026-03-01T00:00:00.000Z'),
      msg(greetRead, 'ai', '2026-03-02T00:00:00.000Z', greeting),
    );
    for (let i = 0; i < 1000; i++) {
      db.conversation_messages.push(msg(filler, i % 2 ? 'agent' : 'contact', new Date(Date.UTC(2026, 1, 1) + i * 1000).toISOString()));
    }
    const res = await call('GET', `/api/conversations?workspace_id=${WS}&queue=main&status=closed`, { token: 'member-token' });
    expect(res.status).toBe(200);
    const rows = res.json.conversations as Array<{ id: string; last_message: unknown }>;
    expect(rows.map((r) => r.id).sort()).toEqual([filler, aiOld, aiSplit, aiNoMarkers].sort());
    // The window really missed them (the server reads 1000 at most).
    expect(rows.find((r) => r.id === aiOld)?.last_message).toBeNull();
    expect(rows.find((r) => r.id === aiNoMarkers)?.last_message).toBeNull();
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

  it('both endpoints read the single conversation_inbox_counters query when it exists', async () => {
    inboxCounters = {
      inbox_main: 11, inbox_automated: 12, inbox_needs_human: 13, inbox_spam: 14,
      tab_open: 21, tab_pending: 22, tab_resolved: 23, tab_all: 24, tab_needs_human: 25, tab_automated: 26,
    };
    inboxCounterCalls.length = 0;
    try {
      const counts = await call('GET', `/api/conversations/inbox-counts?workspace_id=${WS}`, { token: 'member-token' });
      expect(counts.json).toEqual({ main: 11, automated: 12, needs_human: 13, spam: 14 });
      const tabs = await call('GET', `/api/conversations/inbox-tab-counts?workspace_id=${WS}`, { token: 'member-token' });
      expect(tabs.json).toEqual({ open: 21, pending: 22, resolved: 23, all: 24, needs_human: 25, automated: 26 });
      // Scoped to the caller: the workspace, the caller's id, and their view.
      expect(inboxCounterCalls.length).toBeGreaterThan(0);
      for (const args of inboxCounterCalls) {
        expect(args.p_workspace_id).toBe(WS);
        expect(typeof args.p_user_id).toBe('string');
        expect(typeof args.p_sees_all).toBe('boolean');
      }
    } finally {
      inboxCounters = null;
    }
  });
});

describe('GET /api/conversations/unread — the Inbox badge', () => {
  const COLLEAGUE = crypto.randomUUID();
  const unread = (token = 'member-token', workspaceId = WS) =>
    call('GET', `/api/conversations/unread?workspace_id=${workspaceId}`, { token });
  const say = (conversationId: string, extra: Row = {}) => {
    db.conversation_messages.push({
      id: crypto.randomUUID(), conversation_id: conversationId, sender_type: 'contact', body: 'hi',
      seen_at: null, created_at: '2026-01-01T00:00:00Z', metadata: {}, ...extra,
    });
  };
  const chat = (extra: Row = {}): string => {
    const id = crypto.randomUUID();
    db.conversations.push({ id, workspace_id: WS, status: 'open', is_spam: false, ai_state: null, assigned_to: null, updated_at: '2026-01-01T12:00:00Z', ...extra });
    return id;
  };

  it('counts the open chats of the main queue, nobody\'s or mine, with a visitor message nobody has read', async () => {
    const mine = chat({ assigned_to: MEMBER, ai_state: 'human_active', updated_at: '2026-01-07T00:00:00Z' });
    say(convOpen);
    say(convNeedsHuman);
    say(mine);
    say(mine); // a conversation, not its messages
    const res = await unread();
    expect(res.status).toBe(200);
    // Most recently active first.
    expect(res.json).toEqual({ conversations: 3, ids: [mine, convNeedsHuman, convOpen] });
  });

  it('leaves out the AI\'s, spam, a colleague\'s, the finished and the waiting ones, and another workspace\'s', async () => {
    const colleagues = chat({ assigned_to: COLLEAGUE });
    const resolved = chat({ status: 'resolved' });
    const closed = chat({ status: 'closed' });
    for (const id of [convAutomated, convSpam, convPending, convForeign, colleagues, resolved, closed]) say(id);
    expect((await unread()).json).toEqual({ conversations: 0, ids: [] });
  });

  it('counts the operator\'s own scope also for a supervisor watching "All"', async () => {
    // MEMBER is the owner: a colleague's chat is still not on their badge.
    const colleagues = chat({ assigned_to: COLLEAGUE });
    say(colleagues);
    const res = await call('GET', `/api/conversations/unread?workspace_id=${WS}&scope=all`, { token: 'member-token' });
    expect(res.json).toEqual({ conversations: 0, ids: [] });
  });

  it('leaves out what is read, menu taps, and the team\'s and the system\'s messages', async () => {
    say(convOpen, { seen_at: '2026-01-01T00:01:00Z' });
    say(convNeedsHuman, { metadata: { channel_menu_event: 'true' } });
    const tapped = chat();
    say(tapped, { metadata: { channel_menu_event: true } });
    const command = chat();
    say(command, { metadata: { channel_menu_command: '/start' } });
    const answered = chat();
    say(answered, { sender_type: 'agent' });
    say(answered, { sender_type: 'system' });
    say(answered, { sender_type: 'ai' });
    expect((await unread()).json).toEqual({ conversations: 0, ids: [] });
    // One real message among the taps: the chat counts.
    say(convNeedsHuman);
    expect((await unread()).json).toEqual({ conversations: 1, ids: [convNeedsHuman] });
  });

  it('a chat with more unread messages than one read returns does not hide the others', async () => {
    // Its messages come first (conversation_id order), as the index returns them.
    const flooded = chat({ updated_at: '2026-02-01T00:00:00Z' });
    for (let i = 0; i < 1200; i += 1) say(flooded);
    const others = [chat(), chat(), chat()];
    for (const c of others) say(c);
    const res = await unread();
    expect(res.json.conversations).toBe(4);
    expect(new Set(res.json.ids as string[])).toEqual(new Set([flooded, ...others]));
  });

  it('a read asked for after a chat was read never gets the answer of one that began before', async () => {
    const read = chat();
    say(read);
    let release!: () => void;
    holdMessageReads = new Promise((r) => { release = r; });
    // A read (a realtime refresh) has taken its rows: the message is unread.
    const before = unread();
    await vi.waitFor(() => expect(heldMessageReads).toBe(1));
    holdMessageReads = null;
    // The operator opens the chat (POST /seen), and the panel asks again.
    for (const m of db.conversation_messages) if (m.conversation_id === read) m.seen_at = '2026-10-23T10:00:00Z';
    const after = unread();
    // Time for it to reach the server while the first is still answering (it
    // used to be handed that answer); the fixed code never waits for it.
    await new Promise((r) => setTimeout(r, 200));
    release();
    expect((await before).json).toEqual({ conversations: 1, ids: [read] });
    expect((await after).json).toEqual({ conversations: 0, ids: [] });
  });

  it('names at most 100 chats, the most recently active first, and counts every one', async () => {
    const many: string[] = [];
    for (let i = 0; i < 120; i += 1) {
      many.push(chat({ updated_at: new Date(Date.UTC(2026, 1, 1, 0, i)).toISOString() }));
      say(many[i]);
    }
    const res = await unread();
    expect(res.json.conversations).toBe(120);
    expect(res.json.ids).toEqual(many.slice(-100).reverse());
  });

  it('is refused to a non-member, to the signed-out, and to staff without an Inbox', async () => {
    say(convOpen);
    expect((await unread('outsider-token')).status).toBe(403);
    expect((await call('GET', `/api/conversations/unread?workspace_id=${WS}`)).status).toBe(401);
    expect((await call('GET', '/api/conversations/unread', { token: 'member-token' })).status).toBe(400);
    const member = db.workspace_members[0];
    const role = member.role;
    member.role = 'analyst';
    try {
      const staff = await unread();
      expect(staff.status).toBe(403);
      expect(staff.json.error).toBe('inbox_not_allowed');
    } finally {
      member.role = role;
    }
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
    conversationPublishes.length = 0;
    const res = await call('POST', `/api/conversations/${convOpen}/seen`, { token: 'member-token' });
    expect(res.status).toBe(200);
    expect(res.json.count).toBe(1);
    expect(db.conversation_messages.find((m) => m.id === msgId)?.seen_at).not.toBeNull();
    // The visitor's widget hears it live: exactly that message, when (I-03).
    await vi.waitFor(() => expect(conversationPublishes.some((p) => p.event.type === 'seen')).toBe(true));
    const seen = conversationPublishes.find((p) => p.event.type === 'seen')!;
    expect(seen.conversationId).toBe(convOpen);
    expect(seen.event.payload).toEqual({
      conversation_id: convOpen,
      seen_at: db.conversation_messages.find((m) => m.id === msgId)?.seen_at,
      message_ids: [msgId],
    });
    // Nothing newly read → nothing published.
    conversationPublishes.length = 0;
    await call('POST', `/api/conversations/${convOpen}/seen`, { token: 'member-token' });
    await new Promise((r) => setTimeout(r, 20));
    expect(conversationPublishes.filter((p) => p.event.type === 'seen')).toHaveLength(0);
  });

  it('tells every operator\'s panel the chat was read, on the inbox channel only, and only when something was', async () => {
    db.conversation_messages.push({ id: crypto.randomUUID(), conversation_id: convOpen, sender_type: 'contact', body: 'hi', seen_at: null, created_at: '2026-01-01T00:00:00Z' });
    operatorEvents.length = 0;
    await call('POST', `/api/conversations/${convOpen}/seen`, { token: 'member-token' });
    await vi.waitFor(() => expect(operatorEvents.filter((e) => e.payload.kind === 'conversation_seen')).toHaveLength(1));
    const [seen] = operatorEvents.filter((e) => e.payload.kind === 'conversation_seen');
    expect(seen.payload).toEqual({
      kind: 'conversation_seen',
      conversation_id: convOpen,
      workspace_id: WS,
      actor_id: MEMBER,
      seen_at: db.conversation_messages[0].seen_at,
    });
    // Never on the conversation's channel, which the visitor's widget hears.
    expect(seen.opts).toEqual({ skipConversationChannel: true });
    // Read already: nothing to tell.
    operatorEvents.length = 0;
    await call('POST', `/api/conversations/${convOpen}/seen`, { token: 'member-token' });
    await new Promise((r) => setTimeout(r, 20));
    expect(operatorEvents.filter((e) => e.payload.kind === 'conversation_seen')).toHaveLength(0);
  });

  it('rejects marking a foreign-workspace conversation as seen', async () => {
    const res = await call('POST', `/api/conversations/${convForeign}/seen`, { token: 'member-token' });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/conversations/send-message — the visitor hears of it (V-07)', () => {
  it('an operator\'s message wakes the visitor\'s widget, once per message', async () => {
    wakes.length = 0;
    const res = await call('POST', '/api/conversations/send-message', {
      token: 'member-token',
      body: { workspace_id: WS, conversation_id: convOpen, body: 'موجود است', client_message_id: 'cmid-wake-1' },
    });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(wakes).toEqual([{ workspaceId: WS, conversationId: convOpen }]));
    // A replay of the same message wakes nobody again.
    await call('POST', '/api/conversations/send-message', {
      token: 'member-token',
      body: { workspace_id: WS, conversation_id: convOpen, body: 'موجود است', client_message_id: 'cmid-wake-1' },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(wakes).toHaveLength(1);
  });
});

describe('POST /api/conversations/send-message — the first reply ends a pre-chat wait (migration 287)', () => {
  const reply = (conversationId: string, clientMessageId: string) => call('POST', '/api/conversations/send-message', {
    token: 'member-token',
    body: { workspace_id: WS, conversation_id: conversationId, body: 'سلام، در خدمتم', client_message_id: clientMessageId },
  });
  const flagPatches = (conversationId: string) => metadataPatches
    .filter((p) => p.conversationId === conversationId && 'routing_pending' in p.patch).map((p) => p.patch);

  it('the reply that claims a conversation routing held for the pre-chat form clears the flag, and only the flag', async () => {
    const at = '2026-10-27T08:00:00.000Z';
    const open = db.conversations.find((c) => c.id === convOpen)!;
    open.metadata = { routing_pending: true, routing_pending_at: at };
    expect((await reply(convOpen, 'cmid-prechat-1')).status).toBe(200);
    expect(open.assigned_to).toBe(MEMBER);
    expect(flagPatches(convOpen)).toEqual([{ routing_pending: false }]);
    // A later reply claims nothing and writes no patch again.
    expect((await reply(convOpen, 'cmid-prechat-2')).status).toBe(200);
    expect(flagPatches(convOpen)).toHaveLength(1);
  });

  it('nothing when the conversation carries no flag, or somebody already has it', async () => {
    expect((await reply(convOpen, 'cmid-prechat-3')).status).toBe(200);
    expect(db.conversations.find((c) => c.id === convOpen)!.assigned_to).toBe(MEMBER);
    const held = db.conversations.find((c) => c.id === convPending)!;
    Object.assign(held, { assigned_to: crypto.randomUUID(), metadata: { routing_pending: true, routing_pending_at: '2026-10-27T08:00:00.000Z' } });
    expect((await reply(convPending, 'cmid-prechat-4')).status).toBe(200);
    expect(metadataPatches.filter((p) => 'routing_pending' in p.patch)).toEqual([]);
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
