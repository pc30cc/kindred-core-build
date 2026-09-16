/**
 * A RESTORED THREAD MUST STILL KNOW WHO SPOKE.
 *
 * `GET /api/widget/identity/history` is the endpoint the widget calls when it
 * opens and replays an existing conversation (smart continuation). It served
 * the same message rows as /poll and /history but skipped the sender step, so
 * every restored operator and AI bubble arrived with no `sender_name` and no
 * `sender_avatar`.
 *
 * That was invisible for a while: the shipped runtime fell back to
 * `metadata.agent_logo_url`, a provider URL snapshotted into the row, so AI
 * bubbles at least drew SOMETHING (a dead link, once the provider changed).
 * Operator bubbles never drew anything. Removing the snapshot — which the
 * key-only model requires — turned the gap into a visible "no avatars at all".
 *
 * A message row records only a sender id; the link is derived from a storage
 * key at read time. So the fix is the enrichment step, and these tests pin it
 * at the route level: the real router runs, and the derivation is real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'node:http';
import express from 'express';

const WS = '6ee40d07-32a3-4594-8a5f-d439f81afa5b';
const CONV = '33333333-3333-4333-8333-333333333333';
const OPERATOR = 'fc7c4681-98dc-470e-b9c1-8b037d4e945f';
const OPERATOR_KEY = `users/${OPERATOR}/avatar/8e600ccd.jpg`;
const AI_KEY = `workspace/${WS}/avatars/ai-agent/60549a5a-logo.jpg`;
const CDN = 'https://cdn.vendor-a.test';

type Row = Record<string, unknown>;

const db: { messages: Row[]; profiles: Row[]; agentSettings: Row | null } = {
  messages: [], profiles: [], agentSettings: null,
};

function builderFor(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  const rows = () => {
    const source = table === 'conversation_messages' ? db.messages
      : table === 'profiles' ? db.profiles
      : table === 'ai_agent_settings' ? (db.agentSettings ? [db.agentSettings] : [])
      : [];
    return source.filter((r) => filters.every((f) => f(r)));
  };
  const b = {
    select: () => b,
    eq: (col: string, val: unknown) => { filters.push((r) => r[col] === val); return b; },
    in: (col: string, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return b; },
    not: () => b,
    order: () => b,
    limit: () => b,
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    single: async () => ({ data: rows()[0] ?? null, error: null }),
    then: (onOk: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(onOk),
  };
  return b;
}

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({ from: (table: string) => builderFor(table), rpc: async () => ({ data: null, error: null }) }),
}));

// Only the provider lookup is stubbed; ownership checks and URL construction
// are the real ones.
vi.mock('../../../server/services/storage/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/storage/index.js')>();
  return {
    ...actual,
    resolveStorageConfig: async () => ({ provider: 'bunny_storage', cdnUrl: CDN }),
    resolveGlobalStorageConfig: async () => ({ provider: 'bunny_storage', cdnUrl: CDN }),
  };
});

vi.mock('../../../server/services/widget/security.js', () => ({
  enforceWidgetToken: (_q: unknown, _s: unknown, next: () => void) => next(),
  enforceOrigin: (_q: unknown, _s: unknown, next: () => void) => next(),
  widgetRateLimit: () => (_q: unknown, _s: unknown, next: () => void) => next(),
  resolveWorkspaceId: () => WS,
  getClientIp: () => '127.0.0.1',
}));

vi.mock('../../../server/services/widget/visitorIdentity.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/widget/visitorIdentity.js')>();
  return { ...actual, readVisitorCookie: () => ({ v: 'visitor-1', w: WS, exp: Math.floor(Date.now() / 1000) + 3600 }) };
});

vi.mock('../../../server/services/widget/identityMerge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/widget/identityMerge.js')>();
  return { ...actual, findContinuableConversation: async () => ({ id: CONV, updatedAt: new Date().toISOString() }) };
});

const { widgetIdentityRouter } = await import('../../../server/routes/widgetIdentity.js');

const app = express();
app.use((req, _res, next) => {
  (req as express.Request & { serverConfig: unknown }).serverConfig = {
    supabaseUrl: 'https://example.supabase.co', supabaseServiceRoleKey: 'SERVICE_KEY',
  };
  next();
});
app.use(express.json());
app.use('/api/widget/identity', widgetIdentityRouter);
const server = http.createServer(app).listen(0);
const port = () => (server.address() as { port: number }).port;

type HistoryBody = {
  messages: Array<{ sender_type: string; sender_name: string | null; sender_avatar: string | null; metadata?: unknown }>;
};

function history(): Promise<HistoryBody> {
  return new Promise((done, fail) => {
    const req = http.request(
      { host: '127.0.0.1', port: port(), path: `/api/widget/identity/history?workspace_id=${WS}`, method: 'GET' },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => { try { done(JSON.parse(d)); } catch (e) { fail(e); } });
      },
    );
    req.on('error', fail);
    req.end();
  });
}

beforeEach(() => {
  db.profiles = [{ id: OPERATOR, full_name: 'مجتبی', avatar_storage_key: OPERATOR_KEY }];
  db.agentSettings = { workspace_id: WS, agent_name: 'هوشمند', agent_logo_url: null, metadata: { ai_avatar_storage_key: AI_KEY } };
  db.messages = [
    { id: 'm1', conversation_id: CONV, sender_type: 'contact', sender_id: null, body: 'سلام', metadata: {}, created_at: '2026-01-01T00:00:00Z', seen_at: null, reply_to_message_id: null },
    { id: 'm2', conversation_id: CONV, sender_type: 'agent', sender_id: OPERATOR, body: 'بله؟', metadata: {}, created_at: '2026-01-01T00:01:00Z', seen_at: null, reply_to_message_id: null },
    { id: 'm3', conversation_id: CONV, sender_type: 'ai', sender_id: null, body: 'کمک', metadata: {}, created_at: '2026-01-01T00:02:00Z', seen_at: null, reply_to_message_id: null },
  ];
});

describe('GET /identity/history — sender identity on a restored thread', () => {
  it('gives an operator bubble the avatar derived from the profile key', async () => {
    const body = await history();
    const op = body.messages.find((m) => m.sender_type === 'agent');

    expect(op?.sender_name).toBe('مجتبی');
    expect(op?.sender_avatar).toBe(`${CDN}/${OPERATOR_KEY}`);
  });

  it('gives an AI bubble the avatar derived from the agent settings key', async () => {
    const body = await history();
    const ai = body.messages.find((m) => m.sender_type === 'ai');

    expect(ai?.sender_name).toBe('هوشمند');
    expect(ai?.sender_avatar).toBe(`${CDN}/${AI_KEY}`);
  });

  it('follows a provider promotion, because nothing about the link was stored', async () => {
    const before = (await history()).messages.find((m) => m.sender_type === 'ai')?.sender_avatar;

    const storage = await import('../../../server/services/storage/index.js');
    vi.spyOn(storage, 'resolveStorageConfig').mockResolvedValue(
      { provider: 'bunny_storage', cdnUrl: 'https://cdn.vendor-b.test' } as never,
    );
    const after = (await history()).messages.find((m) => m.sender_type === 'ai')?.sender_avatar;
    vi.restoreAllMocks();

    expect(before).toBe(`${CDN}/${AI_KEY}`);
    expect(after).toBe(`https://cdn.vendor-b.test/${AI_KEY}`);
  });

  it('leaves the visitor\'s own messages without a sender identity', async () => {
    const body = await history();
    const visitor = body.messages.find((m) => m.sender_type === 'contact');

    expect(visitor?.sender_name).toBeUndefined();
    expect(visitor?.sender_avatar).toBeUndefined();
  });

  it('sends no avatar rather than a stale one when nothing is stored', async () => {
    db.profiles = [{ id: OPERATOR, full_name: 'مجتبی', avatar_storage_key: null }];
    db.agentSettings = { workspace_id: WS, agent_name: 'هوشمند', agent_logo_url: null, metadata: {} };

    const body = await history();

    expect(body.messages.find((m) => m.sender_type === 'agent')?.sender_avatar).toBeNull();
    expect(body.messages.find((m) => m.sender_type === 'ai')?.sender_avatar).toBeNull();
  });

  it('never leaks the operator\'s user id to the visitor', async () => {
    const body = await history();

    expect(JSON.stringify(body)).not.toContain(OPERATOR + '"');
    for (const m of body.messages) expect('_sender_id' in m).toBe(false);
  });
});
