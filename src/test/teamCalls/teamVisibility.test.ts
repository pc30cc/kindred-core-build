/**
 * Members hidden from each other (owner, 2026-11-04; server/services/
 * teamVisibility.ts, migration 295): a pair works both ways, a missing table
 * hides nobody, any other failed read throws; the team chat leaves the other
 * out of the colleague list and answers the thread and a send as if they
 * were not a member; colleague calls, the team list and team presence ask
 * the same rule.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import express from 'express';
import http from 'node:http';

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key-team-visibility';

const WS = '11111111-1111-4111-8111-111111111111';
const ME = '33333333-3333-4333-8333-333333333333';
const FRIEND = '44444444-4444-4444-8444-444444444444';
const HIDDEN = '22222222-2222-4222-8222-222222222222';
const OWNER = '55555555-5555-4555-8555-555555555555';

vi.mock('../../../server/lib/workspaceAuth.js', () => ({
  authorizeWorkspaceAccess: async () => ({ userId: ME, isAdmin: false, role: 'agent' }),
  serverConfigOf: (req: { serverConfig?: unknown }) => req.serverConfig,
}));

// ── A small database: the rows each table answers, and the writes ────
let pairs: { data: unknown; error: unknown } = { data: [], error: null };
const inserts: Array<{ table: string; values: unknown }> = [];
const members = [
  { user_id: ME, role: 'agent' },
  { user_id: FRIEND, role: 'agent' },
  { user_id: HIDDEN, role: 'agent' },
  { user_id: OWNER, role: 'owner' },
];
vi.mock('../../../server/supabase.js', () => {
  const client = {
    rpc: async () => ({ data: true, error: null }),
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'is', 'in', 'or', 'order', 'limit', 'update']) b[m] = () => b;
      b.insert = (values: unknown) => { inserts.push({ table, values }); return b; };
      b.maybeSingle = async () => ({ data: null, error: null });
      b.single = async () => ({
        data: { id: 'm1', sender_id: ME, recipient_id: FRIEND, body: 'hi', attachment_id: null, reply_to_id: null, read_at: null, created_at: new Date().toISOString() },
        error: null,
      });
      b.then = (resolve: (v: unknown) => void) => {
        if (table === 'workspace_member_hidden_pairs') return resolve(pairs);
        if (table === 'workspace_members') return resolve({ data: members, error: null });
        if (table === 'profiles') {
          return resolve({ data: members.map((m) => ({ id: m.user_id, full_name: m.user_id, email: null })), error: null });
        }
        return resolve({ data: [], error: null });
      };
      return b;
    },
  };
  return { getServiceClient: () => client };
});
vi.mock('../../../server/services/storage/urlResolver.js', () => ({ hydrateUserAvatars: async () => {} }));
vi.mock('../../../server/services/realtime/publish.js', () => ({ publishTeamEvent: async () => {} }));
vi.mock('../../../server/services/push/index.js', () => ({ notifyTeamMessage: async () => {} }));

const { hiddenMembersFor, areHiddenFromEachOther } = await import('../../../server/services/teamVisibility.js');
const { teamChatRouter } = await import('../../../server/routes/teamChat.js');

const config = { supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'A', supabaseServiceRoleKey: 'S', corsOrigins: [] };
const app = express();
app.use((req, _res, next) => { (req as unknown as { serverConfig: unknown }).serverConfig = config; next(); });
app.use(express.json());
app.use('/api/team-chat', teamChatRouter);

function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, () => {
      const { port } = server.address() as { port: number };
      const payload = body === undefined ? '' : JSON.stringify(body);
      const req = http.request(
        { host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            server.close();
            let parsed: Record<string, unknown> | null = null;
            try { parsed = JSON.parse(data); } catch { /* noop */ }
            resolve({ status: res.statusCode || 0, body: parsed });
          });
        },
      );
      req.on('error', (err) => { server.close(); reject(err); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

beforeEach(() => {
  // The pair is stored low id first: HIDDEN < ME.
  pairs = { data: [{ user_a: HIDDEN, user_b: ME }], error: null };
  inserts.length = 0;
});

describe('the rule (services/teamVisibility.ts)', () => {
  it('hides the two from each other, both ways, and nobody else', async () => {
    expect([...(await hiddenMembersFor(config as never, WS, ME))]).toEqual([HIDDEN]);
    expect([...(await hiddenMembersFor(config as never, WS, HIDDEN))]).toEqual([ME]);
    expect((await hiddenMembersFor(config as never, WS, FRIEND)).size).toBe(0);
    expect(await areHiddenFromEachOther(config as never, WS, ME, HIDDEN)).toBe(true);
    expect(await areHiddenFromEachOther(config as never, WS, HIDDEN, ME)).toBe(true);
    expect(await areHiddenFromEachOther(config as never, WS, ME, FRIEND)).toBe(false);
  });

  it('hides nobody before migration 295 (the table is missing)', async () => {
    pairs = { data: null, error: { code: '42P01', message: 'relation "public.workspace_member_hidden_pairs" does not exist' } };
    expect((await hiddenMembersFor(config as never, WS, ME)).size).toBe(0);
  });

  it('throws on any other failed read: a list is never served on a guess', async () => {
    pairs = { data: null, error: { code: '08006', message: 'connection failure' } };
    await expect(hiddenMembersFor(config as never, WS, ME)).rejects.toThrow(/team_visibility_read_failed/);
  });
});

describe('the team chat', () => {
  it('leaves the hidden member out of the colleague list', async () => {
    const res = await call('GET', `/api/team-chat/colleagues?workspace_id=${WS}`);
    expect(res.status).toBe(200);
    const ids = (res.body?.colleagues as Array<{ user_id: string }>).map((c) => c.user_id).sort();
    expect(ids).toEqual([FRIEND, OWNER].sort());
  });

  it('lists everyone when there is no pair', async () => {
    pairs = { data: [], error: null };
    const res = await call('GET', `/api/team-chat/colleagues?workspace_id=${WS}`);
    expect((res.body?.colleagues as unknown[]).length).toBe(3);
  });

  it('answers the thread with the hidden member as if they were not a member', async () => {
    expect((await call('GET', `/api/team-chat/thread?workspace_id=${WS}&peer_id=${HIDDEN}`)).status).toBe(404);
    expect((await call('GET', `/api/team-chat/thread?workspace_id=${WS}&peer_id=${FRIEND}`)).status).toBe(200);
  });

  it('refuses a message to the hidden member and writes nothing', async () => {
    const res = await call('POST', '/api/team-chat/messages', { workspace_id: WS, recipient_id: HIDDEN, body: 'hi' });
    expect(res.status).toBe(404);
    expect(inserts).toEqual([]);
    const ok = await call('POST', '/api/team-chat/messages', { workspace_id: WS, recipient_id: FRIEND, body: 'hi' });
    expect(ok.status).toBe(200);
    expect(inserts.map((i) => i.table)).toEqual(['team_messages']);
  });
});

describe('every other surface asks the same rule', () => {
  const src = (path: string) => readFileSync(path, 'utf8');

  it('colleague calls: the hidden member cannot be rung (answers not_a_member)', () => {
    const route = src('server/routes/teamCalls.ts');
    expect(route).toMatch(/areHiddenFromEachOther\(config, workspaceId, callerId, calleeId\)/);
    expect(route).toMatch(/if \(!callerActive \|\| !calleeActive \|\| hidden\) return res\.status\(403\)\.json\(\{ error: 'not_a_member' \}\)/);
  });

  it('the team list and the team presence leave them out for the viewer', () => {
    expect(src('server/routes/workspaceMembers.ts')).toMatch(/hiddenMembersFor\(config, workspaceId, auth\.userId\)[\s\S]{0,400}\.filter\(\(m\) => !hidden\.has\(m\.user_id\)\)/);
    expect(src('server/routes/availability.ts')).toMatch(/hiddenMembersFor\(config, workspaceId, user\.id\)[\s\S]{0,200}everyone\.filter\(\(p\) => !hidden\.has\(p\.user_id\)\)/);
  });
});
