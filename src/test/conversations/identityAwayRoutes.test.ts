// @vitest-environment node
/**
 * The identity routes of the away thread and of the thread replay (issue #340):
 *
 *   POST /api/widget/identity/offline-email {workspace_id?, conversation_id, email}
 *        → 200 {ok, contact_id} | 400 | 403 CONVERSATION_ACCESS_DENIED
 *          | 409 not_offline_capture | 500 merge_failed
 *     Only for the visitor's own conversation (the signed cookie alone) that
 *     was captured while away (tagged `offline`): never a way around the
 *     workspace's required pre-chat fields. The address is merged as pre-chat
 *     merges an unverified claim, the conversation gets its contact when it
 *     has none, the timeline `identified`, and the continuity cookie.
 *   GET /api/widget/identity/history: rows without operator account ids.
 *
 * The REAL widgetIdentityRouter runs in-process against fakeServiceDb.ts; the
 * merge, the session row, the cookie and the timeline are stand-ins (their own
 * tests cover them).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  merges: [] as Array<Record<string, unknown>>,
  mergeContact: 'contact-new' as string,
  mergeFails: false,
  cookies: [] as string[],
  events: [] as Array<Record<string, unknown>>,
  sessions: [] as string[],
  prechat: { require_name: true, require_email: true, require_phone: true } as Row,
  continuable: null as { id: string; updatedAt: string } | null,
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeServiceClient(state.db) }));
// The transcript by email / the away email step as they come back once
// visitor email is switched on (shared/visitorEmail.ts; off since 2026-10-21,
// checked as such in src/test/widget/visitorEmailSwitch.test.ts).
vi.mock('../../../shared/visitorEmail.js', () => ({ VISITOR_EMAIL_FEATURES_ENABLED: true, VISITOR_EMAIL_TEMPLATE_OPTIONS: ['transcriptEmail'] }));
vi.mock('../../../server/services/widget/visitorIdentity.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/visitorIdentity.js')>()),
  readVisitorCookie: () => (state.visitor ? { v: state.visitor } : null),
  resolveVisitorIdentity: () => ({ visitorId: state.visitor || 'minted', isNew: !state.visitor }),
}));
vi.mock('../../../server/services/widget/security.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/security.js')>()),
  enforceWidgetToken: (_req: unknown, _res: unknown, next: Next) => next(),
  enforceOrigin: (_req: unknown, _res: unknown, next: Next) => next(),
}));
vi.mock('../../../server/services/widget/identityMerge.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/identityMerge.js')>()),
  mergeVisitorIdentity: async (_c: unknown, _sb: unknown, input: Record<string, unknown>) => {
    state.merges.push(input);
    if (state.mergeFails) throw new Error('boom');
    return { contactId: state.mergeContact, isNewContact: true, conversationsMerged: 0 };
  },
  findContinuableConversation: async () => state.continuable,
}));
vi.mock('../../../server/services/widget/crossWidgetIdentity.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/crossWidgetIdentity.js')>()),
  resolveSessionNetworkContext: async () => ({}),
  ensureVisitorSessionRow: async (_sb: unknown, _ws: string, visitorId: string) => { state.sessions.push(visitorId); return null; },
  issueContinuityCookieForContact: async (_sb: unknown, _req: unknown, _res: unknown, _ws: string, contactId: string) => {
    state.cookies.push(contactId);
  },
}));
vi.mock('../../../server/services/conversationEvents.js', () => ({
  recordConversationEvent: async (_c: unknown, input: Record<string, unknown>) => { state.events.push(input); return { ok: true }; },
  recordAuditAndEvent: async () => undefined,
}));
vi.mock('../../../server/services/storage/urlResolver.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/storage/urlResolver.js')>()),
  hydrateUserAvatars: async (_c: unknown, rows: Row[]) => {
    for (const r of rows || []) { r.avatar_url = null; delete r.avatar_storage_key; }
    return rows;
  },
}));
vi.mock('../../../server/services/ai-agent/settings.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/ai-agent/settings.js')>()),
  resolveAgentLogoUrl: async () => null,
}));

const { widgetIdentityRouter } = await import('../../../server/routes/widgetIdentity.js');
const { __resetWidgetRateLimitsForTests } = await import('../../../server/services/widget/security.js');

const app = express();
app.use((req, _res, next) => { Object.assign(req, { serverConfig: { supabaseUrl: 'https://x.test', supabaseServiceRoleKey: 'k' } }); next(); });
app.use(express.json());
app.use('/api/widget/identity', widgetIdentityRouter);
const server = http.createServer(app).listen(0);

const WS = '11111111-1111-4111-8111-111111111111';
const SARA = '22222222-2222-4222-8222-222222222222';
const ALI = '33333333-3333-4333-8333-333333333333';

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

function conversation(fields: Row = {}, meta: Row = { visitor_id: 'visitor-1' }): string {
  const id = randomUUID();
  (state.db.tables.conversations ||= []).push({
    id, workspace_id: WS, status: 'open', assigned_to: null, contact_id: null, visitor_session_id: null,
    tags: ['offline'], metadata: meta, updated_at: new Date().toISOString(), ...fields,
  });
  return id;
}
const offlineEmail = (body: Row) => call('POST', '/api/widget/identity/offline-email', { workspace_id: WS, ...body });

beforeEach(() => {
  state.db = createFakeServiceDb();
  state.db.tables.widget_prechat_settings = [{ workspace_id: WS, ask_name: true, ask_email: true, ask_phone: true, ...state.prechat }];
  state.visitor = 'visitor-1';
  state.merges.length = 0;
  state.mergeContact = randomUUID();
  state.mergeFails = false;
  state.cookies.length = 0;
  state.events.length = 0;
  state.sessions.length = 0;
  __resetWidgetRateLimitsForTests();
});

describe('POST /identity/offline-email', () => {
  it('merges the address as an unverified pre-chat claim (whatever pre-chat requires), links the conversation, issues the cookie', async () => {
    const cid = conversation();
    const res = await offlineEmail({ conversation_id: cid, email: '  Ali@Example.com ' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, contact_id: state.mergeContact });
    expect(state.merges).toEqual([expect.objectContaining({
      workspaceId: WS, visitorId: 'visitor-1', method: 'prechat',
      identity: { name: null, email: 'Ali@Example.com', phone: null },
    })]);
    // Never a verified merge: an unverified claim never links to another contact.
    expect(state.merges[0]).not.toHaveProperty('verifiedIdentifiers');
    expect(state.db.tables.conversations[0].contact_id).toBe(state.mergeContact);
    expect(state.cookies).toEqual([state.mergeContact]);
    expect(state.sessions).toEqual(['visitor-1']);
    await vi.waitFor(() => expect(state.events).toEqual([expect.objectContaining({
      workspaceId: WS, conversationId: cid, eventType: 'identified', actorType: 'visitor',
      payload: { contact_id: state.mergeContact, method: 'offline_email', is_new_contact: true },
    })]));
  });

  it('a conversation that already has its contact keeps it', async () => {
    const own = randomUUID();
    const cid = conversation({ contact_id: own });
    expect((await offlineEmail({ conversation_id: cid, email: 'ali@example.com' })).status).toBe(200);
    expect(state.db.tables.conversations[0].contact_id).toBe(own);
  });

  it('409 not_offline_capture for a conversation not captured while away: no merge, no cookie', async () => {
    const cid = conversation({ tags: ['vip'] });
    const noTags = conversation({ tags: null });
    expect(await offlineEmail({ conversation_id: cid, email: 'ali@example.com' })).toMatchObject({ status: 409, body: { error: 'not_offline_capture' } });
    expect((await offlineEmail({ conversation_id: noTags, email: 'ali@example.com' })).status).toBe(409);
    expect(state.merges).toHaveLength(0);
    expect(state.cookies).toHaveLength(0);
  });

  it('403 for another visitor\'s conversation (and without the cookie: a visitor_id in the body proves nothing)', async () => {
    const theirs = conversation({}, { visitor_id: 'visitor-2' });
    expect(await offlineEmail({ conversation_id: theirs, email: 'ali@example.com' })).toMatchObject({ status: 403, body: { code: 'CONVERSATION_ACCESS_DENIED' } });
    state.visitor = null;
    const mine = conversation();
    expect((await offlineEmail({ conversation_id: mine, email: 'ali@example.com', visitor_id: 'visitor-1' })).status).toBe(403);
    const elsewhere = conversation({ workspace_id: randomUUID() });
    state.visitor = 'visitor-1';
    expect((await offlineEmail({ conversation_id: elsewhere, email: 'ali@example.com' })).status).toBe(403);
    expect(state.merges).toHaveLength(0);
  });

  it('400 for an invalid address or conversation id; 500 merge_failed when the merge throws', async () => {
    const cid = conversation();
    expect(await offlineEmail({ conversation_id: cid, email: 'not-an-email' })).toMatchObject({ status: 400, body: { error: 'Invalid input' } });
    expect((await offlineEmail({ conversation_id: 'nope', email: 'ali@example.com' })).status).toBe(400);
    expect((await offlineEmail({ conversation_id: cid })).status).toBe(400);
    state.mergeFails = true;
    expect(await offlineEmail({ conversation_id: cid, email: 'ali@example.com' })).toMatchObject({ status: 500, body: { error: 'merge_failed' } });
    expect(state.cookies).toHaveLength(0);
  });
});

describe('GET /identity/history: no operator account ids', () => {
  it('rows without sender_id and the metadata ids; names stay', async () => {
    const cid = conversation({ tags: [] });
    state.db.tables.visitor_sessions = [];
    state.db.tables.profiles = [{ id: SARA, full_name: 'Sara', avatar_storage_key: null }];
    const msgs: Row[] = [
      { sender_type: 'contact', sender_id: null, body: 'hi', metadata: { source: 'widget' } },
      { sender_type: 'agent', sender_id: SARA, body: 'hello', metadata: { source: 'inbox' } },
      { sender_type: 'system', sender_id: null, body: 'joined', metadata: { kind: 'routing_agent_joined', agent_id: SARA, agent_name: 'Sara', actor_id: ALI } },
      { sender_type: 'system', sender_id: null, body: 'moved', metadata: { kind: 'conversation_transferred', actor_id: ALI, from_id: ALI, to_id: SARA, to_name: 'Sara' } },
      { sender_type: 'system', sender_id: null, body: 'closed', metadata: { kind: 'conversation_closed', agent_id: ALI, agent_name: 'Ali', operator_id: SARA, operator_name: 'Sara' } },
    ];
    state.continuable = { id: cid, updatedAt: new Date().toISOString() };
    state.db.tables.conversation_messages = msgs.map((m, i) => ({
      id: randomUUID(), conversation_id: cid, created_at: new Date(Date.now() - (10 - i) * 1000).toISOString(), seen_at: null, reply_to_message_id: null, ...m,
    }));
    const res = await call('GET', `/api/widget/identity/history?workspace_id=${WS}`);
    expect(res.status).toBe(200);
    expect(res.body.conversation_id).toBe(cid);
    const rows = res.body.messages as Body[];
    expect(rows).toHaveLength(5);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(SARA);
    expect(text).not.toContain(ALI);
    for (const m of rows) expect(m).not.toHaveProperty('sender_id');
    expect(rows[1]).toMatchObject({ sender_type: 'agent', sender_name: 'Sara', metadata: { source: 'inbox' } });
    expect(rows[2].metadata).toEqual({ kind: 'routing_agent_joined', agent_name: 'Sara' });
    expect(rows[3].metadata).toEqual({ kind: 'conversation_transferred', to_name: 'Sara' });
    expect(rows[4].metadata).toEqual({ kind: 'conversation_closed', agent_name: 'Ali', operator_name: 'Sara' });
  });
});
