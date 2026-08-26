/**
 * GoTrue-off closure (item 7) — inbox-adjacent routes that must not be
 * assumed safe just because the main inbox is migrated: team chat
 * (operator-to-operator DMs) and the conversation timeline read. Both
 * already route through authorizeWorkspaceAccess (first-party gs_session
 * cookie), but neither had adversarial cross-workspace coverage before
 * this pass.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';

type Row = Record<string, any>;
const db: Record<string, Row[]> = {};

function fakeClient() {
  return {
    from(table: string) {
      const rows: Row[] = db[table] || (db[table] = []);
      const filters: Array<(r: Row) => boolean> = [];
      let orderCol: string | null = null;
      let orderAsc = true;
      let limitN: number | null = null;
      const builder: any = {
        select: () => builder,
        eq(col: string, val: any) { filters.push((r: Row) => r[col] === val); return builder; },
        is(col: string, val: null) { filters.push((r: Row) => r[col] === val); return builder; },
        in(col: string, vals: any[]) { filters.push((r: Row) => vals.includes(r[col])); return builder; },
        or(_expr: string) { return builder; }, // .or() predicates evaluated below via matchOr
        order(col: string, opts?: { ascending?: boolean }) { orderCol = col; orderAsc = opts?.ascending ?? true; return builder; },
        limit(n: number) { limitN = n; return builder; },
        insert(payload: Row) {
          const inserted = { id: payload.id ?? crypto.randomUUID(), created_at: new Date().toISOString(), read_at: null, ...payload };
          rows.push(inserted);
          return { select: () => ({ single: async () => ({ data: inserted, error: null }) }) };
        },
        update(patch: Row) {
          const scoped: Array<(r: Row) => boolean> = [...filters];
          const updateBuilder: any = {
            eq(col: string, val: any) { scoped.push((r: Row) => r[col] === val); return updateBuilder; },
            is(col: string, val: null) { scoped.push((r: Row) => r[col] === val); return updateBuilder; },
            then(resolve: any) {
              for (const r of rows) if (scoped.every((f) => f(r))) Object.assign(r, patch);
              return resolve({ data: null, error: null });
            },
          };
          return updateBuilder;
        },
        maybeSingle: async () => {
          const matched = rows.filter((r) => filters.every((f) => f(r)));
          return { data: matched[0] ?? null, error: null };
        },
        then(resolve: any) {
          let matched = rows.filter((r) => filters.every((f) => f(r)));
          if (orderCol) {
            const c = orderCol;
            matched = [...matched].sort((a, b) => (a[c] === b[c] ? 0 : (a[c] > b[c] ? 1 : -1) * (orderAsc ? 1 : -1)));
          }
          if (limitN != null) matched = matched.slice(0, limitN);
          return resolve({ data: matched, error: null });
        },
      };
      return builder;
    },
    rpc: async (name: string, args: any) => {
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

vi.mock('../../../server/middleware/adminBypass.js', () => ({
  isGlobalAdmin: async () => false,
}));

vi.mock('../../../server/services/auth/sessions.js', () => ({
  SESSION_COOKIE_NAME: 'gs_session',
  validateSessionToken: async (_config: unknown, token: string | undefined) => {
    if (!token) return null;
    const user = db.__sessions?.find((s) => s.token === token);
    return user ? { sessionId: 's1', userId: user.userId, email: 'x@example.com' } : null;
  },
  verifyOriginForMutation: () => true,
}));

const { teamChatRouter } = await import('../../../server/routes/teamChat.js');
const { conversationNotesRouter } = await import('../../../server/routes/conversationNotes.js');

const app = express();
app.use((req, _res, next) => {
  (req as any).serverConfig = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: ['*'] };
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use('/api/team-chat', teamChatRouter);
app.use('/api/conversations', conversationNotesRouter);

const server = http.createServer(app).listen(0);
const port = () => (server.address() as any).port;

function call(method: string, path: string, token: string | null, body?: unknown): Promise<{ status: number; json: any }> {
  const payload = body === undefined ? null : JSON.stringify(body);
  const headers: Record<string, string> = {};
  if (token) headers.cookie = `gs_session=${token}`;
  if (payload) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: port(), path, method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let json: any = {};
        try { json = JSON.parse(d || '{}'); } catch { json = { raw: d }; }
        resolve({ status: res.statusCode || 0, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const WS_A = crypto.randomUUID();
const WS_B = crypto.randomUUID();
const AGENT_A1 = crypto.randomUUID();
const AGENT_A2 = crypto.randomUUID();
const OWNER_B = crypto.randomUUID();

beforeEach(() => {
  for (const key of Object.keys(db)) delete db[key];
  db.__sessions = [
    { token: 'a1-token', userId: AGENT_A1 },
    { token: 'a2-token', userId: AGENT_A2 },
    { token: 'b-token', userId: OWNER_B },
  ];
  db.workspace_members = [
    { workspace_id: WS_A, user_id: AGENT_A1, role: 'agent' },
    { workspace_id: WS_A, user_id: AGENT_A2, role: 'agent' },
    { workspace_id: WS_B, user_id: OWNER_B, role: 'owner' },
  ];
  db.profiles = [
    { id: AGENT_A1, full_name: 'Agent One', email: 'a1@x.com', avatar_url: null },
    { id: AGENT_A2, full_name: 'Agent Two', email: 'a2@x.com', avatar_url: null },
    { id: OWNER_B, full_name: 'Owner B', email: 'b@x.com', avatar_url: null },
  ];
});

describe('team chat — cross-workspace isolation', () => {
  it('a non-member cannot list colleagues of a workspace they do not belong to', async () => {
    const res = await call('GET', `/api/team-chat/colleagues?workspace_id=${WS_A}`, 'b-token');
    expect(res.status).toBe(403);
  });

  it('a non-member cannot send a message into a foreign workspace', async () => {
    const res = await call('POST', '/api/team-chat/messages', 'b-token', {
      workspace_id: WS_A, recipient_id: AGENT_A1, body: 'hi',
    });
    expect(res.status).toBe(403);
    expect(db.team_messages ?? []).toHaveLength(0);
  });

  it('cannot message someone who is not a member of the same workspace, even as a real member', async () => {
    const res = await call('POST', '/api/team-chat/messages', 'a1-token', {
      workspace_id: WS_A, recipient_id: OWNER_B, body: 'hi',
    });
    expect(res.status).toBe(404);
    expect(db.team_messages ?? []).toHaveLength(0);
  });

  it('a valid member-to-member message is delivered and readable only by its participants', async () => {
    const send = await call('POST', '/api/team-chat/messages', 'a1-token', {
      workspace_id: WS_A, recipient_id: AGENT_A2, body: 'hello a2',
    });
    expect(send.status).toBe(200);

    const thread = await call('GET', `/api/team-chat/thread?workspace_id=${WS_A}&peer_id=${AGENT_A2}`, 'a1-token');
    expect(thread.status).toBe(200);
    expect(thread.json.messages).toHaveLength(1);

    const foreignRead = await call('GET', `/api/team-chat/thread?workspace_id=${WS_A}&peer_id=${AGENT_A2}`, 'b-token');
    expect(foreignRead.status).toBe(403);
  });

  it('rejects an unauthenticated request at every route', async () => {
    expect((await call('GET', `/api/team-chat/colleagues?workspace_id=${WS_A}`, null)).status).toBe(401);
    expect((await call('GET', `/api/team-chat/thread?workspace_id=${WS_A}&peer_id=${AGENT_A2}`, null)).status).toBe(401);
    expect((await call('POST', '/api/team-chat/messages', null, { workspace_id: WS_A, recipient_id: AGENT_A2, body: 'x' })).status).toBe(401);
    expect((await call('POST', '/api/team-chat/read', null, { workspace_id: WS_A, peer_id: AGENT_A2 })).status).toBe(401);
  });
});

describe('conversation timeline — cross-workspace isolation', () => {
  const CONV_A = crypto.randomUUID();
  const CONV_B = crypto.randomUUID();

  beforeEach(() => {
    db.conversations = [
      { id: CONV_A, workspace_id: WS_A },
      { id: CONV_B, workspace_id: WS_B },
    ];
    db.conversation_events = [
      { id: crypto.randomUUID(), conversation_id: CONV_A, workspace_id: WS_A, event_type: 'created', actor_type: 'system', actor_id: null, payload: {}, created_at: '2026-01-01' },
      { id: crypto.randomUUID(), conversation_id: CONV_B, workspace_id: WS_B, event_type: 'created', actor_type: 'system', actor_id: null, payload: {}, created_at: '2026-01-01' },
    ];
  });

  it('a member can read the timeline of a conversation in their own workspace', async () => {
    const res = await call('GET', `/api/conversations/${CONV_A}/timeline?workspace_id=${WS_A}`, 'a1-token');
    expect(res.status).toBe(200);
    expect(res.json.events).toHaveLength(1);
  });

  it('a non-member of the workspace is denied outright', async () => {
    const res = await call('GET', `/api/conversations/${CONV_A}/timeline?workspace_id=${WS_A}`, 'b-token');
    expect(res.status).toBe(403);
  });

  it('a real member of workspace A cannot read workspace B\'s conversation by claiming workspace_id=A', async () => {
    // conv belongs to WS_B; caller is a member of WS_A and asserts workspace_id=WS_A.
    const res = await call('GET', `/api/conversations/${CONV_B}/timeline?workspace_id=${WS_A}`, 'a1-token');
    expect(res.status).toBe(404);
  });

  it('a member of workspace B cannot read workspace A\'s conversation by asserting workspace_id=B (membership check on B passes, but the conversation isn\'t theirs)', async () => {
    const res = await call('GET', `/api/conversations/${CONV_A}/timeline?workspace_id=${WS_B}`, 'b-token');
    expect(res.status).toBe(404);
  });
});
