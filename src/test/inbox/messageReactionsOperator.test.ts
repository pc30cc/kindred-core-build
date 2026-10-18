// @vitest-environment node
/**
 * The inbox's side of message reactions (issue #340 g2):
 *
 *   POST /api/conversations/:id/messages/:messageId/reactions {workspace_id, emoji, on}
 *        → 200 {ok, message_id, reactions: [{emoji, count, mine, visitor}], at}
 *          | 400 | 401 / 403 | 404 conversation_not_found / message_not_found
 *          | 409 reactions_not_shown | 422 reactions_unsupported_channel / not_reactable
 *          | 503 migration_required
 *   GET /api/conversations/:id/messages: `reactions` on rows that have any
 *        (for this operator: `mine` their own), `can_react` on the visitor's
 *        messages only where the visitor sees reactions (a widget
 *        conversation of a workspace whose template draws them).
 *
 * The REAL conversationsRouter runs in-process against fakeServiceDb.ts;
 * membership, the plan lock, the effective template and the publisher are
 * stand-ins.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createFakeServiceDb, fakeServiceClient, type FakeServiceDb, type Row } from '../conversations/fakeServiceDb';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed JSON, asserted on its shape
type Body = Record<string, any>;
const state = vi.hoisted(() => ({
  db: null as unknown as FakeServiceDb,
  user: 'sara' as string | null,
  members: {} as Record<string, string[]>,
  seatLocked: false,
  planLocked: false,
  template: 't2',
  events: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeServiceClient(state.db) }));
vi.mock('../../../server/lib/workspaceAuth.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/lib/workspaceAuth.js')>()),
  authorizeWorkspaceAccess: async (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, ws: string) => {
    if (!state.user) { res.status(401).json({ error: 'Unauthorized' }); return null; }
    if (!(state.members[ws] || []).includes(state.user)) { res.status(403).json({ error: 'Not a member of this workspace' }); return null; }
    if (state.seatLocked) { res.status(403).json({ error: 'seat_locked', code: 'seat_locked' }); return null; }
    return { userId: state.user, isAdmin: false, role: 'agent' };
  },
}));
vi.mock('../../../server/services/contactChatLocks.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/contactChatLocks.js')>()),
  conversationLockedNow: async () => ({ locked: state.planLocked, state: { retentionDays: 30 } }),
}));
vi.mock('../../../server/services/widget/configSnapshot.js', async (orig) => {
  const real = await orig<typeof import('../../../server/services/widget/configSnapshot.js')>();
  const { chatWidgetTemplate } = await import('../../../shared/widgetTemplates.js');
  return {
    ...real,
    workspaceChatTemplate: async () => ({ id: state.template, descriptor: chatWidgetTemplate(state.template), options: {} }),
  };
});
vi.mock('../../../server/services/storage/urlResolver.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/storage/urlResolver.js')>()),
  hydrateUserAvatars: async (_c: unknown, rows: Row[]) => rows.map((r) => ({ ...r, avatar_url: null })),
}));
vi.mock('../../../server/services/realtime/publish.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/realtime/publish.js')>()),
  publishConversationEvent: async () => ({ ok: true }),
  publishOperatorEvent: async (_c: unknown, payload: Record<string, unknown>) => { state.events.push(payload); },
}));

const { conversationsRouter } = await import('../../../server/routes/conversations.js');

const app = express();
app.use((req, _res, next) => { Object.assign(req, { serverConfig: { supabaseUrl: 'https://x.test', supabaseServiceRoleKey: 'k' } }); next(); });
app.use(express.json());
app.use('/api/conversations', conversationsRouter);
const server = http.createServer(app).listen(0);

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '44444444-4444-4444-8444-444444444444';
const HEART = '❤️';
const SARA = 'sara';
const ALI = 'ali';

type Answer = { status: number; body: Body };
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

let seq = 0;
function conversation(ws = WS, metadata: Row = {}): string {
  const id = randomUUID();
  (state.db.tables.conversations ||= []).push({ id, workspace_id: ws, status: 'open', metadata, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  return id;
}
function message(cid: string, sender_type: string, extra: Row = {}): string {
  const id = randomUUID();
  (state.db.tables.conversation_messages ||= []).push({
    id, conversation_id: cid, sender_type, sender_id: sender_type === 'agent' ? SARA : null, body: 'hi', metadata: {},
    created_at: new Date(Date.parse('2026-10-18T08:00:00Z') + seq++ * 1000).toISOString(), ...extra,
  });
  return id;
}
const react = (cid: string, mid: string, body: Row) =>
  call('POST', `/api/conversations/${cid}/messages/${mid}/reactions`, { workspace_id: WS, ...body });
const thread = async (cid: string) => (await call('GET', `/api/conversations/${cid}/messages`)).body.messages as Body[];
const rows = () => state.db.tables.conversation_message_reactions || [];

beforeEach(() => {
  state.db = createFakeServiceDb();
  state.db.tables.profiles = [{ id: SARA, full_name: 'Sara' }, { id: ALI, full_name: 'Ali' }];
  state.user = SARA;
  state.members = { [WS]: [SARA, ALI], [OTHER_WS]: ['someone'] };
  state.seatLocked = false;
  state.planLocked = false;
  state.template = 't2';
  state.events.length = 0;
});

describe('POST …/messages/:messageId/reactions', () => {
  it('an operator reacts to a visitor\'s message: their row, the summary for them, one event without ids', async () => {
    const cid = conversation();
    const mid = message(cid, 'contact');
    const res = await react(cid, mid, { emoji: '👍', on: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, message_id: mid, reactions: [{ emoji: '👍', count: 1, mine: true, visitor: false }] });
    expect(typeof res.body.at).toBe('number');
    expect(rows()).toEqual([expect.objectContaining({ actor_type: 'operator', actor_id: SARA, emoji: '👍', message_id: mid, conversation_id: cid, workspace_id: WS })]);
    expect(state.events).toEqual([{
      kind: 'message_reactions', workspace_id: WS, conversation_id: cid, message_id: mid,
      reactions: [{ emoji: '👍', count: 1, visitor: false }], at: res.body.at,
    }]);
    expect(JSON.stringify(state.events)).not.toContain(SARA);
  });

  it('two operators: the count is 2, and each sees `mine` only for their own; taking back one leaves the other', async () => {
    const cid = conversation();
    const mid = message(cid, 'contact');
    await react(cid, mid, { emoji: HEART, on: true });
    state.user = ALI;
    const ali = await react(cid, mid, { emoji: HEART, on: true });
    expect(ali.body.reactions).toEqual([{ emoji: HEART, count: 2, mine: true, visitor: false }]);
    expect((await react(cid, mid, { emoji: HEART, on: true })).body.reactions[0].count).toBe(2);
    state.user = SARA;
    const off = await react(cid, mid, { emoji: HEART, on: false });
    expect(off.body.reactions).toEqual([{ emoji: HEART, count: 1, mine: false, visitor: false }]);
    expect(rows()).toEqual([expect.objectContaining({ actor_id: ALI })]);
    // Three changes, three events; the idempotent repeat published nothing.
    expect(state.events).toHaveLength(3);
  });

  it('a bare U+2764 is ❤️; an emoji off the list is invalid_emoji; a bad id or body is 400', async () => {
    const cid = conversation();
    const mid = message(cid, 'contact');
    expect((await react(cid, mid, { emoji: '❤', on: true })).body.reactions[0].emoji).toBe(HEART);
    expect(await react(cid, mid, { emoji: '🔥', on: true })).toMatchObject({ status: 400, body: { error: 'invalid_emoji' } });
    expect((await react(cid, mid, { emoji: HEART })).status).toBe(400);
    expect((await call('POST', `/api/conversations/${cid}/messages/nope/reactions`, { workspace_id: WS, emoji: HEART, on: true })).status).toBe(400);
    expect((await call('POST', `/api/conversations/${cid}/messages/${mid}/reactions`, { workspace_id: 'nope', emoji: HEART, on: true })).status).toBe(400);
  });

  it('an emoji since dropped from the list: nobody gives it, whoever gave it takes it back', async () => {
    const cid = conversation();
    const mid = message(cid, 'contact');
    for (const actor of [SARA, ALI]) {
      (state.db.tables.conversation_message_reactions ||= []).push({
        id: randomUUID(), workspace_id: WS, conversation_id: cid, message_id: mid, actor_type: 'operator', actor_id: actor, emoji: '🔥',
        created_at: new Date().toISOString(),
      });
    }
    expect(await react(cid, mid, { emoji: '🔥', on: true })).toMatchObject({ status: 400, body: { error: 'invalid_emoji' } });
    const off = await react(cid, mid, { emoji: '🔥', on: false });
    expect(off.status).toBe(200);
    expect(off.body.reactions).toEqual([{ emoji: '🔥', count: 1, mine: false, visitor: false }]);
    expect(rows()).toEqual([expect.objectContaining({ actor_id: ALI, emoji: '🔥' })]);
    // Still no way to pass anything else off as an emoji.
    for (const emoji of ['x'.repeat(17), 'a b', '', 7]) {
      expect((await react(cid, mid, { emoji, on: false })).status, String(emoji)).toBe(400);
    }
  });

  it('401 without a session, 403 for a non-member or a paused seat, 404 for another workspace\'s conversation', async () => {
    const cid = conversation();
    const mid = message(cid, 'contact');
    state.user = null;
    expect((await react(cid, mid, { emoji: HEART, on: true })).status).toBe(401);
    state.user = 'stranger';
    expect((await react(cid, mid, { emoji: HEART, on: true })).status).toBe(403);
    state.user = SARA;
    state.seatLocked = true;
    expect((await react(cid, mid, { emoji: HEART, on: true })).status).toBe(403);
    state.seatLocked = false;
    // Sara names her own workspace for a conversation of another one.
    const foreign = conversation(OTHER_WS);
    const foreignMsg = message(foreign, 'contact');
    expect(await react(foreign, foreignMsg, { emoji: HEART, on: true })).toMatchObject({ status: 404, body: { error: 'conversation_not_found' } });
    expect(rows()).toHaveLength(0);
  });

  it('403 when the plan locks the conversation; 422 on a channel conversation; 409 when the template shows no reactions', async () => {
    const cid = conversation();
    const mid = message(cid, 'contact');
    state.planLocked = true;
    expect((await react(cid, mid, { emoji: HEART, on: true })).status).toBe(403);
    state.planLocked = false;
    const telegram = conversation(WS, { channel: 'telegram' });
    const tgMsg = message(telegram, 'contact');
    expect(await react(telegram, tgMsg, { emoji: HEART, on: true })).toMatchObject({ status: 422, body: { error: 'reactions_unsupported_channel' } });
    const widget = conversation(WS, { channel: 'widget' });
    const wMsg = message(widget, 'contact');
    state.template = 'default';
    expect(await react(widget, wMsg, { emoji: HEART, on: true })).toMatchObject({ status: 409, body: { error: 'reactions_not_shown' } });
    state.template = 't1';
    expect((await react(widget, wMsg, { emoji: HEART, on: true })).status).toBe(409);
    state.template = 't2';
    expect((await react(widget, wMsg, { emoji: HEART, on: true })).status).toBe(200);
  });

  it('404 for another conversation\'s message; 422 for the team\'s and system messages (operators react to the visitor only)', async () => {
    const cid = conversation();
    const other = conversation();
    const foreign = message(other, 'contact');
    expect((await react(cid, foreign, { emoji: HEART, on: true })).body).toEqual({ error: 'message_not_found' });
    for (const t of ['agent', 'ai', 'system']) {
      expect(await react(cid, message(cid, t), { emoji: HEART, on: true }), t).toMatchObject({ status: 422, body: { error: 'not_reactable' } });
    }
    expect(rows()).toHaveLength(0);
  });

  it('503 migration_required before 276', async () => {
    const cid = conversation();
    const mid = message(cid, 'contact');
    state.db.missing.add('conversation_message_reactions');
    expect(await react(cid, mid, { emoji: HEART, on: true })).toMatchObject({ status: 503, body: { code: 'migration_required' } });
  });
});

describe('GET …/messages: reactions and can_react', () => {
  it('`reactions` only on rows that have some (mine for this operator), `can_react` only on the visitor\'s messages', async () => {
    const cid = conversation();
    const visitorMsg = message(cid, 'contact');
    const reply = message(cid, 'agent');
    message(cid, 'system', { metadata: { kind: 'routing_agent_joined' } });
    const plain = message(cid, 'contact');
    state.db.tables.conversation_message_reactions = [
      { message_id: visitorMsg, conversation_id: cid, workspace_id: WS, actor_type: 'operator', actor_id: ALI, emoji: '🙏', created_at: '1' },
      { message_id: visitorMsg, conversation_id: cid, workspace_id: WS, actor_type: 'operator', actor_id: SARA, emoji: '🙏', created_at: '2' },
      { message_id: reply, conversation_id: cid, workspace_id: WS, actor_type: 'visitor', actor_id: null, emoji: HEART, created_at: '3' },
    ];
    const list = await thread(cid);
    const byId = Object.fromEntries(list.map((m) => [m.id, m]));
    expect(byId[visitorMsg].reactions).toEqual([{ emoji: '🙏', count: 2, visitor: false, mine: true }]);
    expect(byId[visitorMsg].can_react).toBe(true);
    expect(byId[reply].reactions).toEqual([{ emoji: HEART, count: 1, visitor: true, mine: false }]);
    expect(byId[reply]).not.toHaveProperty('can_react');
    expect(byId[plain]).not.toHaveProperty('reactions');
    expect(byId[plain].can_react).toBe(true);
    for (const m of list.filter((x) => x.sender_type === 'system')) {
      expect(m).not.toHaveProperty('reactions');
      expect(m).not.toHaveProperty('can_react');
    }
    // Ali reads his own `mine`.
    state.user = ALI;
    expect((await thread(cid)).find((m) => m.id === visitorMsg)!.reactions[0].mine).toBe(true);
    state.user = SARA;
  });

  it('no can_react where the visitor would not see it (default template, a channel conversation, before 276)', async () => {
    const cid = conversation();
    const mid = message(cid, 'contact');
    state.template = 'default';
    expect((await thread(cid)).find((m) => m.id === mid)).not.toHaveProperty('can_react');
    state.template = 't2';
    const telegram = conversation(WS, { channel: 'telegram' });
    message(telegram, 'contact');
    state.db.reads.length = 0;
    const tg = await thread(telegram);
    expect(tg[0]).not.toHaveProperty('can_react');
    // A channel conversation's thread does not even look for reactions.
    expect(state.db.reads).not.toContain('conversation_message_reactions');
    state.db.missing.add('conversation_message_reactions');
    const before = await call('GET', `/api/conversations/${cid}/messages`);
    expect(before.status).toBe(200);
    expect(before.body.messages[0]).not.toHaveProperty('can_react');
    expect(before.body.messages[0]).not.toHaveProperty('reactions');
  });

  it('reactions survive a template switch: the chips still show, reacting is off', async () => {
    const cid = conversation();
    const mid = message(cid, 'contact');
    await react(cid, mid, { emoji: '😂', on: true });
    state.template = 'default';
    const m = (await thread(cid)).find((x) => x.id === mid)!;
    expect(m.reactions).toEqual([{ emoji: '😂', count: 1, visitor: false, mine: true }]);
    expect(m).not.toHaveProperty('can_react');
  });
});
