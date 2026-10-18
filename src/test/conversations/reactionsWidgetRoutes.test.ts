// @vitest-environment node
/**
 * The visitor's side of message reactions (issue #340 g2), as runtime-late.js
 * calls it, and what a visitor never receives:
 *
 *   GET  /api/widget/conversations/:id/reactions
 *        → { reactions: { <message_id>: [{emoji, count, mine}] }, at }
 *   POST /api/widget/conversations/:id/reactions {workspace_id, message_id, emoji, on}
 *        → 200 {ok, message_id, reactions, at} | 400 invalid_payload / invalid_emoji
 *          | 403 CONVERSATION_ACCESS_DENIED | 404 message_not_found
 *          | 422 not_reactable | 503 migration_required
 *
 *   - the answers and the live event name nobody: counts, and the visitor's
 *     own part (`mine`);
 *   - GET /poll and /history carry no reactions and read no reactions table
 *     (default's answers are what they were);
 *   - /poll and /history rows carry no operator account id (a join's
 *     agent_id, a transfer's actor_id / from_id / to_id, the closed line's
 *     operator_id): the widget gets the names only.
 *
 * The REAL widgetRouter (ownership check, rate limits, the reactions service)
 * runs in-process against the in-memory data layer of fakeServiceDb.ts; the
 * effective template and the publishers are stand-ins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createFakeServiceDb, fakeServiceClient, type FakeServiceDb, type Row } from './fakeServiceDb';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed JSON, asserted on its shape
type Body = Record<string, any>;
type Next = () => void;
const state = vi.hoisted(() => ({
  db: null as unknown as FakeServiceDb,
  visitor: 'visitor-1' as string | null,
  template: 't2',
  conv: [] as Array<{ ws: string; cid: string; envelope: Record<string, unknown> }>,
  events: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeServiceClient(state.db) }));
vi.mock('../../../server/services/widget/visitorIdentity.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/visitorIdentity.js')>()),
  readVisitorCookie: () => (state.visitor ? { v: state.visitor } : null),
}));
vi.mock('../../../server/services/widget/security.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/security.js')>()),
  enforceWidgetToken: (_req: unknown, _res: unknown, next: Next) => next(),
  enforceOrigin: (_req: unknown, _res: unknown, next: Next) => next(),
}));
vi.mock('../../../server/services/widget/configSnapshot.js', async (orig) => {
  const real = await orig<typeof import('../../../server/services/widget/configSnapshot.js')>();
  const { chatWidgetTemplate } = await import('../../../shared/widgetTemplates.js');
  return {
    ...real,
    workspaceChatTemplate: async () => ({ id: state.template, descriptor: chatWidgetTemplate(state.template), options: {} }),
    getWorkspaceWidgetSnapshot: async () => ({
      settings: {}, workspace: { id: 'ws', name: 'Acme' }, availabilityPrefs: { memberIds: [], prefsByUser: new Map() },
    }),
  };
});
vi.mock('../../../server/services/storage/urlResolver.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/storage/urlResolver.js')>()),
  hydrateUserAvatars: async (_c: unknown, rows: Row[]) => {
    for (const r of rows || []) { r.avatar_url = null; delete r.avatar_storage_key; }
    return rows;
  },
  createStorageUrlResolver: () => ({ user: async () => null }),
}));
vi.mock('../../../server/services/realtime/publish.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/realtime/publish.js')>()),
  publishConversationEvent: async (_c: unknown, ws: string, cid: string, envelope: Record<string, unknown>) => {
    state.conv.push({ ws, cid, envelope });
    return { ok: true };
  },
  publishOperatorEvent: async (_c: unknown, payload: Record<string, unknown>) => { state.events.push(payload); },
}));
vi.mock('../../../server/services/ai-agent/settings.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/ai-agent/settings.js')>()),
  resolveAgentLogoUrl: async () => null,
}));
vi.mock('../../../server/services/knowledge-base/locks.js', () => ({ resolveKbLock: async () => null, applyKbUnlockedFilter: (q: unknown) => q }));
vi.mock('../../../server/routes/widgetIdentity.js', () => ({ widgetIdentityRouter: express.Router() }));
vi.mock('../../../server/routes/widgetCallbacks.js', () => ({ widgetCallbacksRouter: express.Router() }));
vi.mock('../../../server/routes/widgetDepartments.js', () => ({ widgetDepartmentsRouter: express.Router() }));
vi.mock('../../../server/routes/widgetCallInvitations.js', () => ({ widgetCallInvitationsRouter: express.Router() }));
vi.mock('../../../server/routes/widgetAttachments.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/routes/widgetAttachments.js')>()),
  widgetAttachmentsRouter: express.Router(),
}));

const { widgetRouter } = await import('../../../server/routes/widget.js');
const { __resetWidgetRateLimitsForTests } = await import('../../../server/services/widget/security.js');

const app = express();
app.use((req, _res, next) => { Object.assign(req, { serverConfig: { supabaseUrl: 'https://x.test', supabaseServiceRoleKey: 'k' } }); next(); });
app.use(express.json());
app.use('/api/widget', widgetRouter);
const server = http.createServer(app).listen(0);

const WS = '11111111-1111-4111-8111-111111111111';
const SARA = '22222222-2222-4222-8222-222222222222';
const ALI = '33333333-3333-4333-8333-333333333333';
const HEART = '❤️';
const NOW = Date.parse('2026-10-18T09:00:00Z');
const UUIDISH = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

type Answer = { status: number; body: Body; headers: http.IncomingHttpHeaders };
function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request({
      host: '127.0.0.1', port: (server.address() as AddressInfo).port, path, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: d ? JSON.parse(d) : null, headers: res.headers }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let seq = 0;
const stamp = () => new Date(NOW - 100_000 + seq++ * 1000).toISOString();

/** A conversation of `visitor` (metadata.visitor_id: their ownership anchor). */
function conversation(visitor = 'visitor-1'): string {
  const id = randomUUID();
  (state.db.tables.conversations ||= []).push({
    id, workspace_id: WS, status: 'open', assigned_to: SARA, contact_id: null, visitor_session_id: null, metadata: { visitor_id: visitor },
  });
  return id;
}
function message(cid: string, sender_type: string, extra: Row = {}): string {
  const id = randomUUID();
  (state.db.tables.conversation_messages ||= []).push({
    id, conversation_id: cid, sender_type, sender_id: sender_type === 'agent' ? SARA : null, body: 'hi', metadata: {}, created_at: stamp(), ...extra,
  });
  return id;
}
function reaction(cid: string, mid: string, actor: 'visitor' | string, emoji = HEART) {
  (state.db.tables.conversation_message_reactions ||= []).push({
    id: randomUUID(), workspace_id: WS, conversation_id: cid, message_id: mid,
    actor_type: actor === 'visitor' ? 'visitor' : 'operator', actor_id: actor === 'visitor' ? null : actor, emoji, created_at: stamp(),
  });
}
const rows = () => state.db.tables.conversation_message_reactions || [];
const read = (cid: string) => call('GET', `/api/widget/conversations/${cid}/reactions?workspace_id=${WS}`);
const react = (cid: string, body: Row) => call('POST', `/api/widget/conversations/${cid}/reactions`, { workspace_id: WS, ...body });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) });
  state.db = createFakeServiceDb();
  state.db.tables.profiles = [{ id: SARA, full_name: 'Sara', avatar_storage_key: null }];
  state.visitor = 'visitor-1';
  state.template = 't2';
  state.conv.length = 0;
  state.events.length = 0;
  __resetWidgetRateLimitsForTests();
});
afterEach(() => { vi.useRealTimers(); });

describe('GET …/reactions', () => {
  it('the visitor\'s projection: counts per message, `mine` = their own, no ids; messages without any are absent', async () => {
    const cid = conversation();
    const team = message(cid, 'agent');
    const mine = message(cid, 'contact');
    message(cid, 'agent');
    reaction(cid, team, 'visitor');
    reaction(cid, mine, SARA, '👍');
    reaction(cid, mine, ALI, '👍');
    reaction(cid, mine, ALI, HEART);
    const res = await read(cid);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      reactions: {
        [team]: [{ emoji: HEART, count: 1, mine: true }],
        [mine]: [{ emoji: HEART, count: 1, mine: false }, { emoji: '👍', count: 2, mine: false }],
      },
      at: NOW,
    });
    const text = JSON.stringify(res.body.reactions);
    expect(text).not.toContain(SARA);
    expect(text).not.toContain(ALI);
    expect(text).not.toMatch(/actor|visitor/);
  });

  it('{ reactions: {} } when none, and before migration 276 (the table missing), never a 500', async () => {
    const cid = conversation();
    message(cid, 'agent');
    expect((await read(cid)).body).toEqual({ reactions: {}, at: NOW });
    state.db.missing.add('conversation_message_reactions');
    expect(await read(cid)).toMatchObject({ status: 200, body: { reactions: {}, at: NOW } });
    // Any other failure of the read is "none" too: reactions are cosmetic.
    state.db.missing.clear();
    state.db.failing.add('conversation_message_reactions');
    expect(await read(cid)).toMatchObject({ status: 200, body: { reactions: {} } });
  });

  it('403 for a conversation the visitor does not own (another visitor\'s, another workspace\'s); 400 for a bad id', async () => {
    const theirs = conversation('visitor-2');
    expect(await read(theirs)).toMatchObject({ status: 403, body: { code: 'CONVERSATION_ACCESS_DENIED' } });
    const elsewhere = conversation();
    state.db.tables.conversations.find((c) => c.id === elsewhere)!.workspace_id = randomUUID();
    expect((await read(elsewhere)).status).toBe(403);
    state.visitor = null;
    expect((await read(conversation())).status).toBe(403);
    expect((await call('GET', `/api/widget/conversations/not-a-uuid/reactions?workspace_id=${WS}`)).status).toBe(400);
  });
});

describe('POST …/reactions', () => {
  it('sets the visitor\'s ❤️ once (a second call changes nothing), answers and publishes the new counts, no ids', async () => {
    const cid = conversation();
    const mid = message(cid, 'agent');
    reaction(cid, mid, SARA);
    const first = await react(cid, { message_id: mid, emoji: HEART, on: true });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true, message_id: mid, reactions: [{ emoji: HEART, count: 2, mine: true }], at: NOW });
    expect(rows().filter((r) => r.actor_type === 'visitor')).toEqual([
      expect.objectContaining({ workspace_id: WS, conversation_id: cid, message_id: mid, actor_type: 'visitor', actor_id: null, emoji: HEART }),
    ]);
    expect(state.events).toEqual([{
      kind: 'message_reactions', workspace_id: WS, conversation_id: cid, message_id: mid,
      reactions: [{ emoji: HEART, count: 2, visitor: true }], at: NOW,
    }]);

    // The same again (a retry, a second tab): 200, the unique key holds, no news.
    const again = await react(cid, { message_id: mid, emoji: HEART, on: true });
    expect(again.body.reactions).toEqual([{ emoji: HEART, count: 2, mine: true }]);
    expect(rows()).toHaveLength(2);
    expect(state.events).toHaveLength(1);
    expect(JSON.stringify([first.body, state.events])).not.toContain(SARA);
  });

  it('takes back only the visitor\'s own ❤️ (an operator\'s stays); taking back what is not there changes nothing', async () => {
    const cid = conversation();
    const mid = message(cid, 'ai', { metadata: { agent_name: 'Nilu' } });
    reaction(cid, mid, 'visitor');
    reaction(cid, mid, SARA);
    const off = await react(cid, { message_id: mid, emoji: HEART, on: false });
    expect(off.body.reactions).toEqual([{ emoji: HEART, count: 1, mine: false }]);
    expect(rows()).toEqual([expect.objectContaining({ actor_type: 'operator', actor_id: SARA })]);
    expect(state.events).toHaveLength(1);
    const noop = await react(cid, { message_id: mid, emoji: HEART, on: false });
    expect(noop.status).toBe(200);
    expect(rows()).toHaveLength(1);
    expect(state.events).toHaveLength(1);
  });

  it('a bare U+2764 is ❤️; any other emoji (the visitor has ❤️ only), a ZWJ heart or junk is invalid_emoji', async () => {
    const cid = conversation();
    const mid = message(cid, 'bot');
    expect((await react(cid, { message_id: mid, emoji: '❤', on: true })).status).toBe(200);
    expect(rows()[0].emoji).toBe(HEART);
    for (const emoji of ['👍', '🔥', '❤️‍🔥', 'x'.repeat(40), 12, null]) {
      expect(await react(cid, { message_id: mid, emoji, on: true }), String(emoji)).toMatchObject({ status: 400, body: { error: 'invalid_emoji' } });
    }
    expect(rows()).toHaveLength(1);
  });

  it('400 invalid_payload without a message uuid or a boolean `on`', async () => {
    const cid = conversation();
    const mid = message(cid, 'agent');
    expect((await react(cid, { message_id: 'nope', emoji: HEART, on: true })).body).toEqual({ error: 'invalid_payload' });
    expect((await react(cid, { message_id: mid, emoji: HEART, on: 'yes' })).body).toEqual({ error: 'invalid_payload' });
  });

  it('404 for another conversation\'s message or an inbox-only row; 422 for the visitor\'s own message and system rows', async () => {
    const cid = conversation();
    const other = conversation();
    const foreign = message(other, 'agent');
    const internal = message(cid, 'system', { metadata: { kind: 'conversation_unassigned', internal: true } });
    const internalAgent = message(cid, 'agent', { metadata: { internal: true } });
    const own = message(cid, 'contact');
    const join = message(cid, 'system', { metadata: { kind: 'routing_agent_joined', agent_name: 'Sara' } });
    expect(await react(cid, { message_id: foreign, emoji: HEART, on: true })).toMatchObject({ status: 404, body: { error: 'message_not_found' } });
    expect((await react(cid, { message_id: internal, emoji: HEART, on: true })).status).toBe(404);
    expect((await react(cid, { message_id: internalAgent, emoji: HEART, on: true })).status).toBe(404);
    expect((await react(cid, { message_id: randomUUID(), emoji: HEART, on: true })).status).toBe(404);
    expect(await react(cid, { message_id: own, emoji: HEART, on: true })).toMatchObject({ status: 422, body: { error: 'not_reactable' } });
    expect((await react(cid, { message_id: join, emoji: HEART, on: true })).status).toBe(422);
    expect(rows()).toHaveLength(0);
    expect(state.events).toHaveLength(0);
  });

  it('403 for a conversation that is not the visitor\'s, before any message is read', async () => {
    const theirs = conversation('visitor-2');
    const mid = message(theirs, 'agent');
    state.db.reads.length = 0;
    expect(await react(theirs, { message_id: mid, emoji: HEART, on: true })).toMatchObject({ status: 403, body: { code: 'CONVERSATION_ACCESS_DENIED' } });
    expect(state.db.reads).not.toContain('conversation_messages');
    expect(rows()).toHaveLength(0);
  });

  it('503 migration_required before 276; a reaction is no reply: the conversation is untouched, nothing else is published', async () => {
    const cid = conversation();
    const mid = message(cid, 'agent');
    const before = JSON.stringify(state.db.tables.conversations);
    state.db.missing.add('conversation_message_reactions');
    expect(await react(cid, { message_id: mid, emoji: HEART, on: true })).toMatchObject({ status: 503, body: { code: 'migration_required' } });
    state.db.missing.clear();
    expect((await react(cid, { message_id: mid, emoji: HEART, on: true })).status).toBe(200);
    expect(JSON.stringify(state.db.tables.conversations)).toBe(before);
    expect(state.conv).toHaveLength(0);
    expect(state.db.inserts.map((i) => i.table)).toEqual(['conversation_message_reactions']);
  });

  it('any conversation status is accepted (a closed thread can still get a heart)', async () => {
    const cid = conversation();
    state.db.tables.conversations[0].status = 'closed';
    const mid = message(cid, 'agent');
    expect((await react(cid, { message_id: mid, emoji: HEART, on: true })).status).toBe(200);
  });
});

describe('/poll and /history: unchanged for reactions, and no operator account ids', () => {
  function seedThread(cid: string) {
    message(cid, 'contact');
    const reply = message(cid, 'agent', { body: 'سلام', metadata: { source: 'inbox', client_message_id: 'cm_123456789' } });
    message(cid, 'system', {
      body: 'Sara joined the conversation.',
      metadata: { kind: 'routing_agent_joined', agent_id: SARA, agent_name: 'Sara', actor_id: ALI, actor_name: 'Ali' },
    });
    message(cid, 'system', {
      body: 'Ali transferred this conversation to Sara',
      metadata: { kind: 'conversation_transferred', internal: false, actor_id: ALI, actor_name: 'Ali', from_id: ALI, from_name: 'Ali', to_id: SARA, to_name: 'Sara' },
    });
    message(cid, 'system', {
      body: 'Ali closed the conversation',
      metadata: { kind: 'conversation_closed', by: 'agent', agent_id: ALI, agent_name: 'Ali', operator_id: SARA, operator_name: 'Sara', status: 'resolved' },
    });
    message(cid, 'system', { body: 'call', sender_id: ALI, metadata: { kind: 'call_ended', call_session_id: 'c1', ended_by: 'operator', duration_seconds: 5 } });
    return reply;
  }

  it('neither carries a `reactions` key nor reads the reactions table, with reactions stored', async () => {
    const cid = conversation();
    const reply = seedThread(cid);
    reaction(cid, reply, 'visitor');
    for (const path of ['history', 'poll']) {
      state.db.reads.length = 0;
      const res = await call('GET', `/api/widget/${path}?workspace_id=${WS}&conversation_id=${cid}`);
      expect(res.status, path).toBe(200);
      expect(JSON.stringify(res.body), path).not.toContain('reactions');
      expect(state.db.reads, path).not.toContain('conversation_message_reactions');
    }
  });

  it('every row reaches the visitor without sender_id and without the metadata ids; the names and other fields stay', async () => {
    const cid = conversation();
    seedThread(cid);
    for (const path of ['history', 'poll']) {
      const res = await call('GET', `/api/widget/${path}?workspace_id=${WS}&conversation_id=${cid}`);
      const messages = res.body.messages as Body[];
      expect(messages, path).toHaveLength(6);
      for (const m of messages) {
        expect(m, path).not.toHaveProperty('sender_id');
        expect(m, path).not.toHaveProperty('_sender_id');
      }
      // No operator's user id anywhere in the answer (`operator` on /poll is a name and avatar).
      expect(JSON.stringify(res.body), path).not.toContain(SARA);
      expect(JSON.stringify(res.body), path).not.toContain(ALI);
      const byKind = Object.fromEntries(messages.filter((m) => m.metadata?.kind).map((m) => [m.metadata.kind, m.metadata]));
      expect(byKind.routing_agent_joined, path).toEqual({ kind: 'routing_agent_joined', agent_name: 'Sara', actor_name: 'Ali' });
      expect(byKind.conversation_transferred, path).toEqual({
        kind: 'conversation_transferred', internal: false, actor_name: 'Ali', from_name: 'Ali', to_name: 'Sara',
      });
      expect(byKind.conversation_closed, path).toEqual({
        kind: 'conversation_closed', by: 'agent', agent_name: 'Ali', operator_name: 'Sara', status: 'resolved',
      });
      expect(byKind.call_ended, path).toEqual({ kind: 'call_ended', call_session_id: 'c1', ended_by: 'operator', duration_seconds: 5 });
      // The operator's reply keeps its name and its own metadata.
      const reply = messages.find((m) => m.text === 'سلام')!;
      expect(reply, path).toMatchObject({ sender_type: 'agent', sender_name: 'Sara', metadata: { source: 'inbox', client_message_id: 'cm_123456789' } });
    }
  });

  it('a row with nothing to remove is served as it is stored', async () => {
    const cid = conversation();
    message(cid, 'contact', { metadata: { source: 'widget', visitor_id: 'visitor-1' } });
    const res = await call('GET', `/api/widget/history?workspace_id=${WS}&conversation_id=${cid}`);
    expect(res.body.messages[0].metadata).toEqual({ source: 'widget', visitor_id: 'visitor-1' });
    expect(JSON.stringify(res.body)).not.toMatch(new RegExp(SARA));
    expect(UUIDISH.test(JSON.stringify(res.body.messages[0].metadata))).toBe(false);
  });
});
