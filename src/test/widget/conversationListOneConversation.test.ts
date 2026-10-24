/**
 * GET /api/widget/conversations for one current conversation per visitor
 * (2026-10-24): what the widget needs to pick the current conversation and
 * fill «گفتگوهای قبلی», through the REAL widgetRouter on the shared
 * in-memory fake.
 *
 *   endedAt            a closed row only: routing_thread_ended_at, else
 *                      ai_thread_reset_at, else updated_at; null while live
 *                      (open, pending, resolved).
 *   unreadReplies      an operator's or the AI's answers after the read
 *                      marker; never the greeting, a system or bot row, the
 *                      AI's hand-over line or the closed line. unreadCount
 *                      (the launcher's badge) is unchanged.
 *   hasVisitorMessage  whether the visitor ever wrote, also past the newest
 *                      500 messages the list reads.
 *   hidden             an unanswered greeting (an older widget's intro row)
 *                      and another channel's conversation of the contact;
 *                      the 20 rows listed are the visitor's own.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createFakeServiceDb, fakeServiceClient, type FakeServiceDb, type Row } from '../conversations/fakeServiceDb';

const WS = '11111111-1111-4111-8111-111111111111';
const VISITOR = 'visitor-me';
const SESSION = '22222222-2222-4222-8222-222222222222';
const CONTACT = '33333333-3333-4333-8333-333333333333';
const OPERATOR = '55555555-5555-4555-8555-555555555555';

const state = vi.hoisted(() => ({ db: null as unknown as FakeServiceDb }));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeServiceClient(state.db) }));
vi.mock('../../../server/services/widget/visitorIdentity.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/visitorIdentity.js')>()),
  readVisitorCookie: () => ({ v: 'visitor-me', w: '11111111-1111-4111-8111-111111111111', exp: 9e9 }),
}));
vi.mock('../../../server/services/widget/security.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/security.js')>()),
  enforceWidgetToken: (req: { _widgetWorkspaceId?: string }, _res: unknown, next: () => void) => { req._widgetWorkspaceId = '11111111-1111-4111-8111-111111111111'; next(); },
  enforceOrigin: (_req: unknown, _res: unknown, next: () => void) => next(),
  widgetRateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  resolveWorkspaceId: (_req: unknown, _res: unknown, wsId: string) => wsId || '11111111-1111-4111-8111-111111111111',
}));
vi.mock('../../../server/routes/widgetAttachments.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/routes/widgetAttachments.js')>()),
  widgetAttachmentsRouter: express.Router(),
}));
vi.mock('../../../server/routes/widgetIdentity.js', () => ({ widgetIdentityRouter: express.Router() }));
vi.mock('../../../server/routes/widgetCallbacks.js', () => ({ widgetCallbacksRouter: express.Router() }));
vi.mock('../../../server/routes/widgetDepartments.js', () => ({ widgetDepartmentsRouter: express.Router() }));
vi.mock('../../../server/routes/widgetCallInvitations.js', () => ({ widgetCallInvitationsRouter: express.Router() }));

const { widgetRouter } = await import('../../../server/routes/widget.js');

const app = express();
app.use((req, _res, next) => {
  (req as unknown as Row).serverConfig = { supabaseUrl: 'https://x.test', supabaseServiceRoleKey: 'k' };
  next();
});
app.use('/api/widget', widgetRouter);
const server = http.createServer(app).listen(0);
afterAll(() => { server.close(); });

function list(): Promise<Array<Row>> {
  return new Promise((resolve, reject) => {
    http.get({
      host: '127.0.0.1', port: (server.address() as AddressInfo).port,
      path: `/api/widget/conversations?workspace_id=${WS}`, headers: { 'X-Widget-Token': 'wss_test' },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve((JSON.parse(d) as { conversations: Row[] }).conversations); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

const at = (minutesAgo: number) => new Date(Date.parse('2026-10-24T08:00:00Z') - minutesAgo * 60_000).toISOString();
function conversation(fields: Row = {}): Row {
  const row: Row = {
    id: randomUUID(), workspace_id: WS, status: 'open', contact_id: CONTACT, visitor_session_id: SESSION,
    assigned_to: null, metadata: {}, updated_at: at(60), ...fields,
  };
  state.db.tables.conversations.push(row);
  return row;
}
function message(conversationId: unknown, senderType: string, minutesAgo: number, fields: Row = {}): Row {
  const row: Row = { id: randomUUID(), conversation_id: conversationId, sender_type: senderType, body: 'متن', metadata: {}, created_at: at(minutesAgo), ...fields };
  state.db.tables.conversation_messages.push(row);
  return row;
}
const byId = (rows: Row[]) => Object.fromEntries(rows.map((r) => [String(r.id), r]));

beforeEach(() => {
  state.db = createFakeServiceDb();
  state.db.honourOr = true;
  state.db.tables.visitor_sessions = [{ id: SESSION, workspace_id: WS, visitor_id: VISITOR }];
  state.db.tables.contacts = [{ id: CONTACT, workspace_id: WS, metadata: { visitor_id: VISITOR } }];
  state.db.tables.conversations = [];
  state.db.tables.conversation_messages = [];
  state.db.tables.widget_conversation_reads = [];
});

describe('which rows are listed', () => {
  it('an unanswered greeting and another channel\'s conversation are not; an answered greeting and an operator\'s outreach are', async () => {
    const greeting = conversation({ metadata: { source: 'ai_agent_intro', ai_state: 'ai_managed' }, updated_at: at(1) });
    message(greeting.id, 'ai', 2, { metadata: { source: 'ai_agent_intro' } });
    const answered = conversation({ metadata: { source: 'ai_agent_intro', ai_state: 'ai_managed' }, updated_at: at(5) });
    message(answered.id, 'ai', 9, { metadata: { source: 'ai_agent_intro' } });
    message(answered.id, 'contact', 8);
    const outreach = conversation({ assigned_to: OPERATOR, updated_at: at(10) });
    message(outreach.id, 'agent', 11, { sender_id: OPERATOR });
    const telegram = conversation({ metadata: { channel: 'telegram' }, visitor_session_id: null, updated_at: at(2) });
    message(telegram.id, 'contact', 3);

    const rows = await list();
    expect(rows.map((r) => r.id)).toEqual([answered.id, outreach.id]);
    expect(byId(rows)[String(answered.id)].hasVisitorMessage).toBe(true);
    // The outreach can become current (a reply waits in it), but has no message of the visitor's.
    expect(byId(rows)[String(outreach.id)]).toMatchObject({ hasVisitorMessage: false, unreadReplies: 1 });
    void telegram;
  });

  it('twenty of the visitor\'s own remain when hidden rows are newer', async () => {
    for (let i = 0; i < 5; i++) {
      const g = conversation({ metadata: { source: 'ai_agent_intro', ai_state: 'ai_managed' }, updated_at: at(i) });
      message(g.id, 'ai', i, { metadata: { source: 'ai_agent_intro' } });
    }
    const own: Row[] = [];
    for (let i = 0; i < 22; i++) {
      const c = conversation({ status: 'closed', updated_at: at(100 + i) });
      message(c.id, 'contact', 100 + i);
      own.push(c);
    }
    const rows = await list();
    expect(rows).toHaveLength(20);
    expect(rows.map((r) => r.id)).toEqual(own.slice(0, 20).map((c) => c.id));
  });

  it('past the newest 500 messages, whether the visitor wrote is still read (and an answered greeting stays listed)', async () => {
    const busy = conversation({ updated_at: at(1) });
    for (let i = 0; i < 500; i++) message(busy.id, 'agent', 1 + i / 1000, { sender_id: OPERATOR });
    const old = conversation({ status: 'closed', updated_at: at(400) });
    message(old.id, 'contact', 900);
    const quiet = conversation({ status: 'closed', updated_at: at(500) });
    message(quiet.id, 'agent', 950, { sender_id: OPERATOR });
    const oldGreeting = conversation({ metadata: { source: 'ai_agent_intro', ai_state: 'ai_managed' }, updated_at: at(600) });
    message(oldGreeting.id, 'ai', 990, { metadata: { source: 'ai_agent_intro' } });
    message(oldGreeting.id, 'contact', 989);
    const unanswered = conversation({ metadata: { source: 'ai_agent_intro', ai_state: 'ai_managed' }, updated_at: at(700) });
    message(unanswered.id, 'ai', 995, { metadata: { source: 'ai_agent_intro' } });

    const rows = byId(await list());
    expect(rows[String(old.id)].hasVisitorMessage).toBe(true);
    expect(rows[String(quiet.id)].hasVisitorMessage).toBe(false);
    expect(rows[String(oldGreeting.id)].hasVisitorMessage).toBe(true);
    expect(rows[String(unanswered.id)]).toBeUndefined();
  });
});

describe('the fields', () => {
  it('endedAt for a closed row only, from the thread-end stamps, else updated_at', async () => {
    const stamped = conversation({ status: 'closed', updated_at: at(10), metadata: { routing_thread_ended_at: at(30), ai_thread_reset_at: at(31) } });
    const reset = conversation({ status: 'closed', updated_at: at(11), metadata: { ai_thread_reset_at: at(40) } });
    const bare = conversation({ status: 'closed', updated_at: at(12) });
    const resolved = conversation({ status: 'resolved', updated_at: at(13), metadata: { routing_thread_ended_at: at(50) } });
    const pending = conversation({ status: 'pending', updated_at: at(14) });
    const open = conversation({ status: 'open', updated_at: at(15) });
    for (const c of [stamped, reset, bare, resolved, pending, open]) message(c.id, 'contact', 60);

    const rows = byId(await list());
    expect(rows[String(stamped.id)].endedAt).toBe(at(30));
    expect(rows[String(reset.id)].endedAt).toBe(at(40));
    expect(rows[String(bare.id)].endedAt).toBe(at(12));
    expect(rows[String(resolved.id)].endedAt).toBeNull();
    expect(rows[String(pending.id)].endedAt).toBeNull();
    expect(rows[String(open.id)].endedAt).toBeNull();
  });

  it('unreadReplies counts the team\'s answers after the read marker; unreadCount stays the badge it was', async () => {
    const c = conversation({ status: 'closed', updated_at: at(1) });
    message(c.id, 'ai', 50, { metadata: { source: 'ai_agent_intro' } });
    message(c.id, 'contact', 49);
    message(c.id, 'agent', 48, { sender_id: OPERATOR, body: 'قبل از خواندن' });
    state.db.tables.widget_conversation_reads = [{ workspace_id: WS, visitor_id: VISITOR, conversation_id: c.id, last_read_at: at(45) }];
    message(c.id, 'agent', 40, { sender_id: OPERATOR, body: 'پاسخ اپراتور' });
    message(c.id, 'ai', 39, { metadata: { source: 'ai_agent' }, body: 'پاسخ هوش مصنوعی' });
    message(c.id, 'ai', 38, { metadata: { source: 'ai_agent', handoff: true }, body: 'شما را به همکارم وصل می‌کنم' });
    message(c.id, 'ai', 37, { metadata: { source: 'ai_agent_intro' }, body: 'سلام!' });
    message(c.id, 'bot', 36, { metadata: { source: 'smart_rule' }, body: 'سؤالی دارید؟' });
    message(c.id, 'system', 35, { metadata: { kind: 'routing_in_queue' }, body: 'Your message is in the support queue.' });
    message(c.id, 'system', 34, { metadata: { kind: 'conversation_closed' }, body: 'Sara closed the conversation' });
    message(c.id, 'agent', 33, { sender_id: OPERATOR, body: 'یادداشت', metadata: { internal: true } });

    const [row] = await list();
    expect(row.unreadReplies).toBe(2);
    // The badge as before: every inbound row after the marker but the closed line and inbox-only rows.
    expect(row.unreadCount).toBe(6);
  });

  it('every row keeps its keys, in order, with the three new ones after them (default template)', async () => {
    const c = conversation();
    message(c.id, 'contact', 5);
    const [row] = await list();
    expect(Object.keys(row)).toEqual([
      'id', 'status', 'updatedAt', 'preview', 'attachmentKind', 'outbound', 'unreadCount', 'lastMessageAt',
      'endedAt', 'unreadReplies', 'hasVisitorMessage',
    ]);
  });
});
