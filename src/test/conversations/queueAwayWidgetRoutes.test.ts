// @vitest-environment node
/**
 * The queue's place and the away thread's first message (issue #340 g4), as
 * runtime-late.js calls them, plus the escaping of the offline-message mail:
 *
 *   GET  /api/widget/queue?workspace_id&conversation_id
 *        → { position, wait_minutes } (nulls when not waiting, or before 276)
 *   POST /api/widget/offline-messages {…, client_message_id}
 *        → the leave-a-message answer + message_id; the same id again within
 *          24 h answers the same ids with nothing inserted, pushed or mailed.
 *        Without client_message_id (the leave-a-message form) the request is
 *        checked, stored and answered exactly as before.
 *   The owners' mail (`offline_message_received`): the visitor's name, address
 *   and message are text, never markup.
 *
 * The REAL widgetRouter runs in-process against fakeServiceDb.ts; availability,
 * billing limits, push, the timeline and the email service are stand-ins.
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
  sent: [] as Array<Record<string, unknown>>,
  pushes: [] as Array<Record<string, unknown>>,
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
vi.mock('../../../server/services/widget/availability.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/availability.js')>()),
  resolveAvailability: async () => ({ state: 'offline', reason: 'outside_hours', next_open_at: null }),
}));
vi.mock('../../../server/services/billing/locks/state.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/billing/locks/state.js')>()),
  locksEnabled: async () => false,
}));
vi.mock('../../../server/services/billing/conversationLimit.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/billing/conversationLimit.js')>()),
  enforceMaxConversationsLimit: async () => true,
  checkMaxConversationsAllowance: async () => ({ allowed: true }),
}));
vi.mock('../../../server/services/push/index.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/push/index.js')>()),
  notifyInboundMessage: async (_c: unknown, p: Record<string, unknown>) => { state.pushes.push(p); },
}));
vi.mock('../../../server/services/conversationEvents.js', () => ({
  recordConversationEvent: async (_c: unknown, input: Record<string, unknown>) => { state.events.push(input); return { ok: true }; },
  recordAuditAndEvent: async () => undefined,
}));
vi.mock('../../../server/services/email/index.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/email/index.js')>()),
  sendEmail: async (_c: unknown, request: Record<string, unknown>) => { state.sent.push(request); return { success: true, provider: 'resend' }; },
}));
vi.mock('../../../server/services/auth-email.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/auth-email.js')>()),
  resolveWorkspaceAppUrl: async (_c: unknown, _ws: string, path: string) => `https://app.test${path}`,
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

const { widgetRouter, escapeMailText } = await import('../../../server/routes/widget.js');
const { __resetWidgetRateLimitsForTests } = await import('../../../server/services/widget/security.js');

const app = express();
app.use((req, _res, next) => { Object.assign(req, { serverConfig: { supabaseUrl: 'https://x.test', supabaseServiceRoleKey: 'k' } }); next(); });
app.use(express.json());
app.use('/api/widget', widgetRouter);
const server = http.createServer(app).listen(0);

const WS = '11111111-1111-4111-8111-111111111111';
const SARA = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-10-18T09:00:00Z');
const HOUR = 60 * 60 * 1000;

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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) });
  state.db = createFakeServiceDb();
  state.db.now = () => new Date().toISOString();
  state.db.tables.workspace_members = [{ workspace_id: WS, user_id: SARA, role: 'owner' }];
  state.db.tables.profiles = [{ id: SARA, email: 'owner@example.com' }];
  state.visitor = 'visitor-1';
  state.sent.length = 0;
  state.pushes.length = 0;
  state.events.length = 0;
  __resetWidgetRateLimitsForTests();
});
afterEach(() => { vi.useRealTimers(); });

// ─── GET /queue ────────────────────────────────────────────────────────────
function queued(fields: Row = {}, meta: Row = {}): string {
  const id = randomUUID();
  (state.db.tables.conversations ||= []).push({
    id, workspace_id: WS, status: 'open', assigned_to: null, contact_id: null, visitor_session_id: null,
    metadata: { visitor_id: 'visitor-1', routing_outcome: 'manual_queue', queued_at: new Date(NOW - 60_000).toISOString(), ...meta },
    ...fields,
  });
  return id;
}
const queue = (cid: string, extra = '') => call('GET', `/api/widget/queue?workspace_id=${WS}&conversation_id=${cid}${extra}`);

describe('GET /queue', () => {
  it('a queued conversation: chat_queue_status\'s two integers, no-store', async () => {
    const cid = queued();
    state.db.rpc = (fn) => (fn === 'chat_queue_status' ? { data: [{ queue_position: 2, wait_minutes: 3 }], error: null } : { data: null, error: null });
    const res = await queue(cid);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ position: 2, wait_minutes: 3 });
    expect(state.db.rpcs).toEqual([{ fn: 'chat_queue_status', args: { p_workspace_id: WS, p_conversation_id: cid } }]);
    // No estimate yet (fewer than 3 claims): the place alone.
    state.db.rpc = () => ({ data: [{ queue_position: 1, wait_minutes: null }], error: null });
    expect((await queue(cid)).body).toEqual({ position: 1, wait_minutes: null });
  });

  it('nulls without asking the database when the conversation is not waiting: assigned, closed, never queued', async () => {
    state.db.rpc = () => ({ data: [{ queue_position: 9, wait_minutes: 9 }], error: null });
    for (const cid of [
      queued({ assigned_to: SARA }),
      queued({ status: 'resolved' }),
      queued({ status: 'closed' }),
      queued({}, { routing_outcome: 'assigned_auto' }),
      queued({}, { queued_at: null }),
    ]) {
      expect((await queue(cid)).body).toEqual({ position: null, wait_minutes: null });
    }
    expect(state.db.rpcs).toHaveLength(0);
  });

  it('before 276 (no chat_queue_status) or on any error: nulls, never a 500; no row (spam): nulls', async () => {
    const cid = queued();
    state.db.rpc = () => ({ data: null, error: { code: '42883', message: 'function public.chat_queue_status(uuid, uuid) does not exist' } });
    expect(await queue(cid)).toMatchObject({ status: 200, body: { position: null, wait_minutes: null } });
    state.db.rpc = () => ({ data: [], error: null });
    expect((await queue(cid)).body).toEqual({ position: null, wait_minutes: null });
  });

  it('403 for another visitor\'s conversation, 400 without the ids', async () => {
    const theirs = queued({}, { visitor_id: 'visitor-2' });
    expect(await queue(theirs)).toMatchObject({ status: 403, body: { code: 'CONVERSATION_ACCESS_DENIED' } });
    expect((await call('GET', `/api/widget/queue?workspace_id=${WS}`)).status).toBe(400);
    expect((await call('GET', `/api/widget/queue?workspace_id=${WS}&conversation_id=nope`)).status).toBe(400);
    expect(state.db.rpcs).toHaveLength(0);
  });
});

// ─── POST /offline-messages ────────────────────────────────────────────────
const leave = (body: Row) => call('POST', '/api/widget/offline-messages', { workspace_id: WS, ...body });
const tick = () => new Promise((r) => setTimeout(r, 20));

describe('POST /offline-messages without client_message_id (the leave-a-message form): exactly as before', () => {
  it('a conversation tagged offline with no metadata, the message with its two keys, no message_id in the answer', async () => {
    const res = await leave({ message: 'سلام، قیمت؟', locale: 'fa', honeypot: '' });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['captured', 'conversation_id', 'ok', 'transitioning']);
    const conv = state.db.inserts.find((i) => i.table === 'conversations')!.row;
    expect(conv).not.toHaveProperty('metadata');
    expect(conv).toMatchObject({ tags: ['offline'], subject: 'Offline message', status: 'open' });
    const msg = state.db.inserts.find((i) => i.table === 'conversation_messages')!.row;
    expect(msg.metadata).toEqual({ source: 'offline_capture', visitor_id: 'visitor-1' });
  });

  it('a one-character message is refused as before (400 invalid_payload)', async () => {
    const res = await leave({ message: 'x' });
    expect(res).toMatchObject({ status: 400, body: { error: 'invalid_payload' } });
    expect(state.db.inserts).toHaveLength(0);
  });
});

describe('POST /offline-messages with client_message_id (the away thread)', () => {
  const CMID = 'local_1760778000000_ab12cd';

  it('stores the client id on the conversation and the message, answers message_id; one push, one mail', async () => {
    const res = await leave({ message: 'x', client_message_id: CMID, locale: 'fa' });
    expect(res.status).toBe(200);
    const conv = state.db.inserts.find((i) => i.table === 'conversations')!.row;
    const msg = state.db.inserts.find((i) => i.table === 'conversation_messages')!.row;
    expect(conv.metadata).toEqual({ source: 'offline_capture', visitor_id: 'visitor-1', channel_thread_key: `widget_cmid:${CMID}` });
    expect(msg.metadata).toEqual({ source: 'offline_capture', visitor_id: 'visitor-1', client_message_id: CMID });
    expect(res.body).toEqual({ ok: true, captured: true, conversation_id: conv.id, transitioning: false, message_id: msg.id });
    await tick();
    expect(state.pushes).toHaveLength(1);
    expect(state.sent).toHaveLength(1);
    expect(state.events.filter((e) => e.eventType === 'captured_offline')).toHaveLength(1);
  });

  it('the same id again (a retry) answers the same ids: no second conversation, message, push, event or mail', async () => {
    const first = await leave({ message: 'سلام', client_message_id: CMID });
    await tick();
    const inserts = state.db.inserts.length;
    const second = await leave({ message: 'سلام', client_message_id: CMID });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({
      ok: true, captured: true, conversation_id: first.body.conversation_id, transitioning: false, message_id: first.body.message_id,
    });
    await tick();
    expect(state.db.inserts).toHaveLength(inserts);
    expect(state.pushes).toHaveLength(1);
    expect(state.sent).toHaveLength(1);
    expect(state.events.filter((e) => e.eventType === 'captured_offline')).toHaveLength(1);
  });

  it('a different id, another visitor\'s retry, or one older than 24 h is a new capture', async () => {
    const first = await leave({ message: 'one', client_message_id: CMID });
    const other = await leave({ message: 'two', client_message_id: 'local_1760778000000_zz99yy' });
    expect(other.body.conversation_id).not.toBe(first.body.conversation_id);
    state.visitor = 'visitor-2';
    const foreign = await leave({ message: 'three', client_message_id: CMID });
    expect(foreign.body.conversation_id).not.toBe(first.body.conversation_id);
    state.visitor = 'visitor-1';
    vi.setSystemTime(NOW + 25 * HOUR);
    const late = await leave({ message: 'four', client_message_id: CMID });
    expect(late.body.conversation_id).not.toBe(first.body.conversation_id);
    // Within the 24 hours the first is found again.
    vi.setSystemTime(NOW + 23 * HOUR);
    expect((await leave({ message: 'one', client_message_id: CMID })).body.conversation_id).toBe(first.body.conversation_id);
  });

  it('a client id finds only the same visitor\'s capture: with the cookie or without it, never across', async () => {
    const withCookie = await leave({ message: 'one', client_message_id: CMID });
    state.visitor = null;
    const without = await leave({ message: 'one', client_message_id: CMID });
    expect(without.body.conversation_id).not.toBe(withCookie.body.conversation_id);
    // A retry without the cookie finds its own capture again …
    expect((await leave({ message: 'one', client_message_id: CMID })).body.conversation_id).toBe(without.body.conversation_id);
    // … and the cookie's visitor still finds theirs.
    state.visitor = 'visitor-1';
    expect((await leave({ message: 'one', client_message_id: CMID })).body).toMatchObject({
      conversation_id: withCookie.body.conversation_id, message_id: withCookie.body.message_id,
    });
    expect(state.db.inserts.filter((i) => i.table === 'conversations')).toHaveLength(2);
  });

  it('the contact\'s stored details never cost the away message: a long name is cut, an address or number the form refuses is left out', async () => {
    const res = await leave({ message: 'hi', client_message_id: CMID, name: 'ن'.repeat(200), email: 'not-an-address', phone: '9'.repeat(60) });
    expect(res.status).toBe(200);
    expect(state.db.inserts.filter((i) => i.table === 'contacts')).toHaveLength(0);
    await tick();
    expect((state.sent[0] as { templateData: Record<string, string> }).templateData).toMatchObject({ contact_name: 'ن'.repeat(120), contact_email: '' });
    // The leave-a-message form keeps its checks.
    state.db.inserts.length = 0;
    expect((await leave({ message: 'hi there', name: 'ن'.repeat(200) })).status).toBe(400);
    expect((await leave({ message: 'hi there', email: 'not-an-address' })).status).toBe(400);
    expect(state.db.inserts).toHaveLength(0);
  });

  it('the away message is as long as POST /message takes (5,000); the leave-a-message form keeps its 4,000', async () => {
    expect((await leave({ message: 'س'.repeat(5000), client_message_id: CMID })).status).toBe(200);
    expect((await leave({ message: 'س'.repeat(5001), client_message_id: 'local_1760778000000_zz99yy' })).status).toBe(400);
    expect((await leave({ message: 'س'.repeat(4001) })).status).toBe(400);
    expect(state.db.inserts.filter((i) => i.table === 'conversations')).toHaveLength(1);
  });

  it('an empty message or a malformed client id is 400 invalid_payload', async () => {
    expect((await leave({ message: '   ', client_message_id: CMID })).status).toBe(400);
    expect((await leave({ message: 'hi', client_message_id: 'short' })).status).toBe(400);
    expect((await leave({ message: 'hi', client_message_id: 'x'.repeat(65) })).status).toBe(400);
    expect(state.db.inserts).toHaveLength(0);
  });
});

describe('the offline-message mail to the owners', () => {
  it('the visitor\'s name, address and message: as typed for the subject and text, escaped for the HTML and the fallback HTML', async () => {
    const evil = '<img src=x onerror="alert(1)"> & "co"';
    await leave({ message: `${evil}\nسلام`, name: '<b>Ali</b> & "co"', email: 'ali@example.com' });
    await tick();
    expect(state.sent).toHaveLength(1);
    const mail = state.sent[0] as { html: string; templateSlug: string; templateData: Record<string, string>; htmlData: Record<string, string> };
    expect(mail.templateSlug).toBe('offline_message_received');
    // The subject and the text part: what the visitor typed, no entities.
    expect(mail.templateData.contact_name).toBe('<b>Ali</b> & "co"');
    expect(mail.templateData.message_body).toBe(`${evil}\nسلام`);
    expect(mail.templateData.contact_email).toBe('ali@example.com');
    // The template's HTML part: text, never markup.
    expect(mail.htmlData.contact_name).toBe('&lt;b&gt;Ali&lt;/b&gt; &amp; &quot;co&quot;');
    expect(mail.htmlData.message_body).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &quot;co&quot;\nسلام');
    expect(mail.htmlData.contact_email).toBe('ali@example.com');
    expect(mail.htmlData.action_url).toMatch(/^https:\/\/app\.test\/inbox\?c=/);
    expect(mail.html).not.toMatch(/<img|<b>/);
    expect(mail.html).toContain('&lt;b&gt;Ali&lt;/b&gt;');
    expect(mail.html).toContain('&lt;img src=x');
    // The inbox link is still a link.
    expect(mail.html).toContain(`<a href="https://app.test/inbox?c=`);
  });

  it('escapeMailText: & < > " as entities, apostrophes and Persian as they are', () => {
    expect(escapeMailText(`<a href="x">O'Brien & co</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;O\'Brien &amp; co&lt;/a&gt;');
    expect(escapeMailText('سلام')).toBe('سلام');
  });
});
