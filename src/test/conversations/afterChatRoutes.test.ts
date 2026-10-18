// @vitest-environment node
/**
 * The widget API of the rating after a chat and the transcript by email
 * (issue #340 g1), as runtime-late.js calls it:
 *
 *   GET  /api/widget/conversations/:id/csat
 *        → { closed_id, rateable, rating, operator, transcript: { available, to } }
 *   POST /api/widget/conversations/:id/csat {closed_id, rating, comment?}
 *        → 200 {ok, rating} | 400 invalid_rating | 403 csat_disabled /
 *          CONVERSATION_ACCESS_DENIED | 409 not_ratable / already_rated (+ rating)
 *          | 503 csat_unavailable
 *   POST /api/widget/conversations/:id/transcript {locale?, tz?}
 *        → 200 {ok, to} | 403 transcript_disabled | 409 no_email / nothing_to_send
 *          | 429 rate_limited (+ retry_after) / limit_reached / workspace_limit
 *          | 502 send_failed | 503 email_unavailable
 *
 * The REAL widgetRouter (and the real ownership check, rate limits, rating
 * and transcript services) runs in-process against an in-memory data layer;
 * the effective template, the email service and the timeline are stand-ins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createFakeServiceDb, fakeServiceClient, type FakeServiceDb, type Row } from './fakeServiceDb';

/** A JSON answer, read field by field by the assertions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed JSON, asserted on its shape
type Body = Record<string, any>;
type Next = () => void;
const state = vi.hoisted(() => ({
  db: null as unknown as FakeServiceDb,
  visitor: 'visitor-1' as string | null,
  template: 't2',
  options: {} as Record<string, unknown>,
  provider: true,
  edition: 'iran' as 'iran' | 'international',
  brandName: 'فروشگاه <b>آبی</b>' as string | null,
  sendResult: { success: true, provider: 'resend' } as { success: boolean; provider: string; error?: string },
  sendThrows: false,
  sent: [] as Array<Record<string, unknown>>,
  events: [] as Array<Record<string, unknown>>,
  published: [] as Array<Record<string, unknown>>,
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
  const { chatTemplateOptionDefaults, readTemplateOptions, chatTemplateOptionKeys } = await import('../../../shared/chatTemplateCatalog.js');
  return {
    ...real,
    workspaceChatTemplate: async () => ({
      id: state.template,
      descriptor: chatWidgetTemplate(state.template),
      options: { ...chatTemplateOptionDefaults(state.template), ...readTemplateOptions(state.options, chatTemplateOptionKeys(state.template)) },
    }),
    getWorkspaceWidgetSnapshot: async () => ({
      settings: { brand_name: state.brandName },
      workspace: { id: 'ws', name: 'Acme' },
      availabilityPrefs: { memberIds: [], prefsByUser: new Map() },
    }),
  };
});
vi.mock('../../../server/services/storage/urlResolver.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/storage/urlResolver.js')>()),
  hydrateUserAvatars: async (_c: unknown, rows: Row[]) => {
    for (const r of rows || []) { r.avatar_url = r.avatar_storage_key ? `https://cdn.test/${r.avatar_storage_key}` : null; delete r.avatar_storage_key; }
    return rows;
  },
}));
vi.mock('../../../server/services/email/index.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/email/index.js')>()),
  isEmailProviderConfigured: async () => state.provider,
  resolveEmailScope: async (_c: unknown, locale?: string) => {
    if (state.edition === 'iran') return { edition: 'iran', locales: ['fa', 'en'] };
    const base = String(locale || '').split('-')[0];
    return { edition: 'international', locales: [['en', 'fa', 'tr'].includes(base) ? base : 'en', 'en'] };
  },
  sendEmail: async (_c: unknown, request: Record<string, unknown>) => {
    state.sent.push(request);
    if (state.sendThrows) throw new Error('fetch failed');
    return state.sendResult;
  },
}));
vi.mock('../../../server/services/conversationEvents.js', () => ({
  recordConversationEvent: async (_c: unknown, input: Record<string, unknown>) => { state.events.push(input); return { ok: true }; },
  recordAuditAndEvent: async () => undefined,
}));
vi.mock('../../../server/services/realtime/publish.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/realtime/publish.js')>()),
  publishConversationEvent: async (_c: unknown, _ws: string, _cid: string, envelope: Record<string, unknown>) => {
    state.published.push(envelope);
    return { ok: true };
  },
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
const { recordConversationClosed } = await import('../../../server/services/conversationClosedNotice.js');
const { __resetWidgetRateLimitsForTests } = await import('../../../server/services/widget/security.js');
const { maskEmail, buildVisitorTranscript, transcriptTimeZone, MAX_TRANSCRIPT_BYTES } = await import('../../../server/services/visitorTranscript.js');

const app = express();
app.use((req, _res, next) => { Object.assign(req, { serverConfig: { supabaseUrl: 'https://x.test', supabaseServiceRoleKey: 'k' } }); next(); });
app.use(express.json());
app.use('/api/widget', widgetRouter);
const server = http.createServer(app).listen(0);

const WS = '11111111-1111-4111-8111-111111111111';
const SARA = '22222222-2222-4222-8222-222222222222';
const ALI = '33333333-3333-4333-8333-333333333333';
const NOW = Date.parse('2026-10-18T09:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

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
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString().replace('Z', `${String(seq++ % 1000).padStart(3, '0')}Z`);

/** A conversation of visitor-1's, with a contact. */
function conversation(contact: Row | null = { email: 'ali.r@example.com' }, fields: Row = {}): string {
  const id = randomUUID();
  let contactId: string | null = null;
  if (contact) {
    contactId = randomUUID();
    (state.db.tables.contacts ||= []).push({ id: contactId, workspace_id: WS, metadata: { visitor_id: 'visitor-1' }, ...contact });
  }
  (state.db.tables.conversations ||= []).push({
    id, workspace_id: WS, status: 'resolved', assigned_to: SARA, contact_id: contactId, visitor_session_id: null,
    metadata: { visitor_id: 'visitor-1' }, ...fields,
  });
  return id;
}
function message(cid: string, sender_type: string, body = 'hi', extra: Row = {}, msAgo = 60_000): string {
  const id = randomUUID();
  (state.db.tables.conversation_messages ||= []).push({
    id, conversation_id: cid, sender_type, sender_id: sender_type === 'agent' ? SARA : null, body, metadata: {}, created_at: at(msAgo), ...extra,
  });
  return id;
}
function closed(cid: string, msAgo = 30_000): string {
  return message(cid, 'system', 'Ali closed the conversation', {
    metadata: { kind: 'conversation_closed', by: 'agent', agent_id: ALI, agent_name: 'Ali', operator_id: SARA, operator_name: 'Sara (then)', status: 'resolved' },
  }, msAgo);
}
/** A chat Sara answered and closed: the usual rateable thread. */
function answeredAndClosed(contact?: Row | null): { cid: string; closedId: string } {
  const cid = conversation(contact);
  message(cid, 'contact', 'سلام', {}, 120_000);
  message(cid, 'agent', 'سلام، بفرمایید', {}, 90_000);
  return { cid, closedId: closed(cid) };
}
const csat = (cid: string) => call('GET', `/api/widget/conversations/${cid}/csat?workspace_id=${WS}`);
const rate = (cid: string, body: Row) => call('POST', `/api/widget/conversations/${cid}/csat`, { workspace_id: WS, ...body });
const transcript = (cid: string, body: Row = {}) => call('POST', `/api/widget/conversations/${cid}/transcript`, { workspace_id: WS, ...body });
const ratings = () => state.db.tables.conversation_ratings || [];
const ledger = () => state.db.tables.conversation_transcript_emails || [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) });
  state.db = createFakeServiceDb();
  state.db.tables.profiles = [{ id: SARA, full_name: 'Sara', avatar_storage_key: 'avatars/sara.png' }];
  state.visitor = 'visitor-1';
  state.template = 't2';
  state.options = {};
  state.provider = true;
  state.edition = 'iran';
  state.brandName = 'فروشگاه <b>آبی</b>';
  state.sendResult = { success: true, provider: 'resend' };
  state.sendThrows = false;
  state.sent.length = 0;
  state.events.length = 0;
  state.published.length = 0;
  __resetWidgetRateLimitsForTests();
});
afterEach(() => { vi.useRealTimers(); });

describe('the closed line in the visitor\'s thread', () => {
  it('a close writes it once; /history and /poll carry it exactly once, a visible system row; then GET …/csat rates it', async () => {
    state.db.tables.profiles.push({ id: ALI, full_name: 'Ali', avatar_storage_key: null });
    const cid = conversation();
    message(cid, 'contact', 'سلام', {}, 120_000);
    message(cid, 'agent', 'سلام، بفرمایید', {}, 90_000);
    message(cid, 'system', 'Ali unassigned this conversation', { metadata: { kind: 'conversation_unassigned', internal: true } }, 80_000);
    const config = { supabaseUrl: 'https://x.test', supabaseServiceRoleKey: 'k' } as never;
    const first = await recordConversationClosed(config, { workspaceId: WS, conversationId: cid, actorId: ALI, status: 'resolved' });
    expect(first).not.toBeNull();
    // Closed again with nothing said: no second line.
    expect(await recordConversationClosed(config, { workspaceId: WS, conversationId: cid, actorId: ALI, status: 'closed' })).toBeNull();
    expect(state.published).toEqual([expect.objectContaining({ type: 'message' })]);

    for (const path of ['history', 'poll']) {
      const res = await call('GET', `/api/widget/${path}?workspace_id=${WS}&conversation_id=${cid}`);
      expect(res.status, path).toBe(200);
      const rows = (res.body.messages as Body[]);
      const lines = rows.filter((m) => m.metadata?.kind === 'conversation_closed');
      expect(lines, path).toHaveLength(1);
      // The names only: the stored row's agent_id / operator_id never reach
      // the visitor (realtime/publish.ts visitorMessageMetadata).
      expect(lines[0], path).toMatchObject({
        id: first!.id, role: 'system', sender_type: 'system', text: 'Ali closed the conversation',
        metadata: { kind: 'conversation_closed', by: 'agent', agent_name: 'Ali', operator_name: 'Sara', status: 'resolved' },
      });
      expect(Object.keys(lines[0].metadata).sort(), path).toEqual(['agent_name', 'by', 'kind', 'operator_name', 'status']);
      // The newest row, and the inbox-only notice is not there.
      expect(rows[rows.length - 1].id, path).toBe(first!.id);
      expect(rows.some((m) => m.metadata?.internal === true), path).toBe(false);
    }
    expect((await csat(cid)).body).toMatchObject({ closed_id: first!.id, rateable: true, operator: { name: 'Sara' } });
  });

  it('a default workspace\'s close writes nothing: its thread is what it was', async () => {
    state.template = 'default';
    const cid = conversation();
    message(cid, 'agent', 'hi', {}, 90_000);
    const config = { supabaseUrl: 'https://x.test', supabaseServiceRoleKey: 'k' } as never;
    expect(await recordConversationClosed(config, { workspaceId: WS, conversationId: cid, actorId: ALI, status: 'resolved' })).toBeNull();
    const res = await call('GET', `/api/widget/history?workspace_id=${WS}&conversation_id=${cid}`);
    expect((res.body.messages as Body[]).map((m) => m.sender_type)).toEqual(['agent']);
    expect(state.published).toHaveLength(0);
  });
});

describe('GET …/csat', () => {
  it('answers only the visitor who owns the conversation (404 otherwise)', async () => {
    const { cid } = answeredAndClosed();
    state.visitor = 'visitor-2';
    expect(await csat(cid)).toMatchObject({ status: 404, body: { error: 'not_found' } });
    state.visitor = null;
    expect((await csat(cid)).status).toBe(404);
    state.visitor = 'visitor-1';
    expect((await csat(randomUUID())).status).toBe(404);
    expect((await csat('not-a-uuid')).status).toBe(404);
    // Another workspace's conversation, even the visitor's own id.
    const other = conversation(null, { workspace_id: '44444444-4444-4444-8444-444444444444' });
    expect((await csat(other)).status).toBe(404);
  });

  it('a rateable closure: its id, the operator it names (name and avatar now), and the transcript', async () => {
    const { cid, closedId } = answeredAndClosed();
    const res = await csat(cid);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      closed_id: closedId,
      rateable: true,
      rating: null,
      operator: { name: 'Sara', avatar: 'https://cdn.test/avatars/sara.png' },
      transcript: { available: true, to: 'a•••@example.com' },
    });
  });

  it('nothing to rate: no closed line, or the thread moved on after it', async () => {
    const cid = conversation();
    message(cid, 'agent');
    expect((await csat(cid)).body).toMatchObject({ closed_id: null, rateable: false, rating: null, operator: null });
    const { cid: reopened } = answeredAndClosed();
    message(reopened, 'contact', 'one more thing', {}, 1_000);
    expect((await csat(reopened)).body).toMatchObject({ closed_id: null, rateable: false });
    // A system notice after the line does not move the thread on.
    const { cid: joined, closedId } = answeredAndClosed();
    message(joined, 'system', 'Reza joined', { metadata: { kind: 'routing_agent_joined' } }, 1_000);
    expect((await csat(joined)).body).toMatchObject({ closed_id: closedId, rateable: true });
  });

  it('not rateable: older than 7 days, an AI-only chat, the option off, a template without the card', async () => {
    const old = conversation();
    message(old, 'agent', 'hi', {}, 9 * DAY);
    closed(old, 7 * DAY + 60_000);
    expect((await csat(old)).body).toMatchObject({ rateable: false });
    const ai = conversation();
    message(ai, 'ai');
    const aiClosed = closed(ai);
    expect((await csat(ai)).body).toMatchObject({ closed_id: aiClosed, rateable: false, transcript: { available: false, to: null } });
    const { cid } = answeredAndClosed();
    state.options = { csat: false };
    expect((await csat(cid)).body).toMatchObject({ rateable: false });
    state.options = {};
    state.template = 't1';
    expect((await csat(cid)).body).toMatchObject({ rateable: false, transcript: { available: true } });
    state.template = 'default';
    expect((await csat(cid)).body).toMatchObject({ rateable: false, transcript: { available: false } });
  });

  it('a failed read on the transcript\'s side hides the link, never the rating', async () => {
    const { cid, closedId } = answeredAndClosed();
    state.db.failing.add('contacts');
    const res = await csat(cid);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ closed_id: closedId, rateable: true, transcript: { available: false, to: null } });
  });

  it('before migration 276: nothing rateable, no transcript, never a 500', async () => {
    const { cid } = answeredAndClosed();
    state.db.missing.add('conversation_ratings');
    state.db.missing.add('conversation_transcript_emails');
    const res = await csat(cid);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rateable: false, rating: null, transcript: { available: false, to: null } });
  });
});

describe('POST …/csat', () => {
  it('refuses another visitor (403 CONVERSATION_ACCESS_DENIED)', async () => {
    const { cid, closedId } = answeredAndClosed();
    state.visitor = 'visitor-2';
    expect(await rate(cid, { closed_id: closedId, rating: 5 })).toMatchObject({
      status: 403, body: { code: 'CONVERSATION_ACCESS_DENIED' },
    });
    expect(ratings()).toHaveLength(0);
  });

  it('400 invalid_rating for anything but an integer 1–5 and an optional comment of at most 1000 characters', async () => {
    const { cid, closedId } = answeredAndClosed();
    for (const rating of [0, 6, 2.5, '5', null, undefined, true]) {
      expect(await rate(cid, { closed_id: closedId, rating }), String(rating)).toMatchObject({ status: 400, body: { error: 'invalid_rating' } });
    }
    expect((await rate(cid, { closed_id: closedId, rating: 4, comment: 'x'.repeat(1001) })).status).toBe(400);
    expect((await rate(cid, { closed_id: closedId, rating: 4, comment: 12 })).status).toBe(400);
    expect(ratings()).toHaveLength(0);
  });

  it('403 csat_disabled when the template has no card or the option is off', async () => {
    const { cid, closedId } = answeredAndClosed();
    for (const [template, options] of [['t2', { csat: false }], ['t1', {}], ['default', {}], ['intl', {}]] as const) {
      state.template = template;
      state.options = options;
      // With a code: the widget's fetchWith refreshes the token on a code-less 403.
      expect(await rate(cid, { closed_id: closedId, rating: 5 }), template).toMatchObject({ status: 403, body: { error: 'csat_disabled', code: 'CSAT_DISABLED' } });
    }
    expect(ratings()).toHaveLength(0);
  });

  it('rates the closure once: the row, the timeline event, then 409 already_rated with the stored rating', async () => {
    const { cid, closedId } = answeredAndClosed();
    const res = await rate(cid, { closed_id: closedId, rating: 4, comment: '  عالی بود <b>!</b>  ' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, rating: { score: 4, comment: 'عالی بود <b>!</b>', rated_at: expect.any(String) } });
    expect(ratings()).toHaveLength(1);
    expect(ratings()[0]).toMatchObject({
      workspace_id: WS, conversation_id: cid, closed_message_id: closedId, operator_id: SARA, score: 4, comment: 'عالی بود <b>!</b>',
    });
    expect(state.events).toEqual([expect.objectContaining({
      workspaceId: WS, conversationId: cid, eventType: 'rated', actorType: 'visitor', actorId: null,
      payload: { score: 4, comment: 'عالی بود <b>!</b>', closed_id: closedId, operator_id: SARA, source: 'widget' },
    })]);
    // No message row: the thread and the visitor's list stay as they were.
    expect((state.db.tables.conversation_messages || []).filter((m) => m.conversation_id === cid)).toHaveLength(3);

    const again = await rate(cid, { closed_id: closedId, rating: 1 });
    expect(again).toMatchObject({ status: 409, body: { error: 'already_rated', rating: { score: 4, comment: 'عالی بود <b>!</b>' } } });
    expect(ratings()).toHaveLength(1);
    expect((await csat(cid)).body).toMatchObject({ rateable: false, rating: { score: 4, comment: 'عالی بود <b>!</b>' } });
  });

  it('a comment left empty is stored as none', async () => {
    const { cid, closedId } = answeredAndClosed();
    expect((await rate(cid, { closed_id: closedId, rating: 3, comment: '   ' })).body.rating).toMatchObject({ score: 3, comment: null });
  });

  it('409 not_ratable: another closure, a made-up id, a reopened thread, the window passed, no human reply', async () => {
    const { cid, closedId } = answeredAndClosed();
    const { closedId: foreign } = answeredAndClosed();
    for (const id of [foreign, randomUUID(), 'x', 7, null]) {
      expect(await rate(cid, { closed_id: id, rating: 5 }), String(id)).toMatchObject({ status: 409, body: { error: 'not_ratable' } });
    }
    message(cid, 'contact', 'still here', {}, 1_000);
    expect((await rate(cid, { closed_id: closedId, rating: 5 })).body).toEqual({ error: 'not_ratable' });

    const old = conversation();
    message(old, 'agent', 'hi', {}, 9 * DAY);
    const oldClosed = closed(old, 7 * DAY + 60_000);
    expect((await rate(old, { closed_id: oldClosed, rating: 5 })).status).toBe(409);
    const ai = conversation();
    message(ai, 'ai');
    expect((await rate(ai, { closed_id: closed(ai), rating: 5 })).body).toEqual({ error: 'not_ratable' });
    expect(ratings()).toHaveLength(0);
  });

  it('another tab rating at the same moment: the unique closure answers 409 already_rated with its rating', async () => {
    const { cid, closedId } = answeredAndClosed();
    state.db.beforeInsert = (table, row) => {
      if (table !== 'conversation_ratings') return;
      state.db.beforeInsert = undefined;
      state.db.tables.conversation_ratings!.push({ ...row, id: randomUUID(), score: 2, comment: 'other tab', created_at: new Date().toISOString() });
    };
    state.db.tables.conversation_ratings = [];
    const res = await rate(cid, { closed_id: closedId, rating: 5 });
    expect(res).toMatchObject({ status: 409, body: { error: 'already_rated', rating: { score: 2, comment: 'other tab' } } });
    expect(ratings()).toHaveLength(1);
    expect(state.events).toHaveLength(0);
  });

  it('before migration 276: 503 csat_unavailable', async () => {
    const { cid, closedId } = answeredAndClosed();
    state.db.missing.add('conversation_ratings');
    expect(await rate(cid, { closed_id: closedId, rating: 5 })).toMatchObject({ status: 503, body: { error: 'csat_unavailable' } });
  });
});

describe('the transcript: availability (GET …/csat)', () => {
  it('only with a provider, an email on the contact, a human reply, the option on and a template that offers it', async () => {
    const { cid } = answeredAndClosed();
    expect((await csat(cid)).body.transcript).toEqual({ available: true, to: 'a•••@example.com' });
    state.provider = false;
    expect((await csat(cid)).body.transcript).toEqual({ available: false, to: null });
    state.provider = true;
    state.options = { transcriptEmail: false };
    expect((await csat(cid)).body.transcript).toEqual({ available: false, to: null });
    state.options = {};
    for (const contact of [null, { email: null }, { email: '' }, { email: 'not-an-address' }]) {
      const { cid: c } = answeredAndClosed(contact);
      expect((await csat(c)).body.transcript, JSON.stringify(contact)).toEqual({ available: false, to: null });
    }
    // Template 1 offers it (its menu), default and intl do not.
    state.template = 't1';
    expect((await csat(cid)).body.transcript.available).toBe(true);
    for (const t of ['default', 'intl']) {
      state.template = t;
      expect((await csat(cid)).body.transcript.available, t).toBe(false);
    }
  });

  it('maskEmail keeps the first character and the domain', () => {
    expect(maskEmail('ali.r@example.com')).toBe('a•••@example.com');
    expect(maskEmail('z@x.io')).toBe('z•••@x.io');
    expect(maskEmail('سارا@example.com')).toBe('س•••@example.com');
    expect(maskEmail('nope')).toBe('•••');
  });
});

describe('POST …/transcript', () => {
  it('mails the transcript to the contact\'s own address (never one from the request), escaped, with the template', async () => {
    const cid = conversation();
    message(cid, 'contact', 'قیمت $& و $1 و {brand} و {transcript_text} <script>alert(1)</script>', {}, 300_000);
    message(cid, 'system', 'Sara unassigned this conversation', { metadata: { kind: 'conversation_unassigned', internal: true } }, 250_000);
    message(cid, 'system', 'Sara joined the conversation.', { metadata: { kind: 'routing_agent_joined' } }, 240_000);
    const fileMsg = message(cid, 'contact', '', { metadata: { attachment_id: 'att-1' } }, 200_000);
    (state.db.tables.conversation_attachments ||= []).push({
      id: 'att-1', workspace_id: WS, message_id: fileMsg, file_name: 'invoice <1>.pdf', mime_type: 'application/pdf', size_bytes: 10, status: 'attached',
    });
    message(cid, 'agent', 'سلام علی، بفرمایید', {}, 100_000);
    closed(cid);

    const res = await transcript(cid, { locale: 'fa', tz: 'Asia/Tehran', to: 'victim@evil.test', email: 'victim@evil.test' });
    expect(res).toMatchObject({ status: 200, body: { ok: true, to: 'a•••@example.com' } });
    expect(state.sent).toHaveLength(1);
    const mail = state.sent[0] as { to: string; templateSlug: string; locale: string; workspaceId: string; templateData: Record<string, string>; html: string; subject: string };
    expect(mail).toMatchObject({ workspaceId: WS, to: 'ali.r@example.com', templateSlug: 'visitor_conversation_transcript', locale: 'fa' });
    expect(Object.keys(mail.templateData)).toEqual(['workspace', 'workspace_name', 'date', 'transcript', 'transcript_text']);
    expect(mail.templateData.workspace).toBe('فروشگاه &lt;b&gt;آبی&lt;/b&gt;');
    expect(mail.templateData.workspace_name).toBe('فروشگاه <b>آبی</b>');
    const html = mail.templateData.transcript;
    expect(html).toContain('قیمت $&amp; و $1 و {brand} و {transcript_text} &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('📎 invoice &lt;1&gt;.pdf');
    expect(html).not.toMatch(/https?:/);
    expect(html).toContain('شما · ');
    expect(html).toContain('Sara · ');
    // Inbox-only and system rows are not in it.
    expect(html).not.toContain('unassigned');
    expect(html).not.toContain('joined');
    expect(html).not.toContain('closed the conversation');
    expect(html.match(/<tr>/g)).toHaveLength(3);
    // Persian digits, Tehran time (09:00Z - 300 s = 12:25 in Tehran).
    expect(html).toContain('۱۲:۲۵');
    expect(mail.templateData.transcript_text).toContain('قیمت $& و $1 و {brand} و {transcript_text} <script>alert(1)</script>');
    expect(mail.templateData.date).toBe('۲۶ مهر ۱۴۰۵');

    expect(ledger()).toEqual([expect.objectContaining({ workspace_id: WS, conversation_id: cid, status: 'sent' })]);
    expect(state.events).toEqual([expect.objectContaining({
      eventType: 'transcript_emailed', actorType: 'visitor', actorId: null,
      payload: { status: 'sent', to: 'a•••@example.com', messages: 3, source: 'widget' },
    })]);
    expect(JSON.stringify(state.events)).not.toContain('ali.r@example.com');
  });

  it('the International edition: the visitor\'s language and zone, Gregorian Persian, an invalid zone falls back to UTC', async () => {
    state.edition = 'international';
    const { cid } = answeredAndClosed();
    await transcript(cid, { locale: 'tr-TR', tz: 'Europe/Istanbul' });
    const tr = state.sent[0] as { locale: string; templateData: Record<string, string> };
    expect(tr.locale).toBe('tr');
    expect(tr.templateData.transcript).toContain('Siz · ');
    expect(tr.templateData.date).toBe('18 Ekim 2026');
    expect(transcriptTimeZone('Not/AZone', 'international')).toBe('UTC');
    expect(transcriptTimeZone(undefined, 'iran')).toBe('Asia/Tehran');
    expect(transcriptTimeZone('Europe/Istanbul', 'iran')).toBe('Europe/Istanbul');
  });

  it('refuses another visitor (403), a template without it (403), no provider (503), no email (409), no human reply (409)', async () => {
    const { cid } = answeredAndClosed();
    state.visitor = 'visitor-2';
    expect((await transcript(cid)).body).toMatchObject({ code: 'CONVERSATION_ACCESS_DENIED' });
    state.visitor = 'visitor-1';
    __resetWidgetRateLimitsForTests();
    state.options = { transcriptEmail: false };
    expect(await transcript(cid)).toMatchObject({ status: 403, body: { error: 'transcript_disabled', code: 'TRANSCRIPT_DISABLED' } });
    state.options = {};
    state.template = 'default';
    expect(await transcript(cid)).toMatchObject({ status: 403, body: { error: 'transcript_disabled', code: 'TRANSCRIPT_DISABLED' } });
    __resetWidgetRateLimitsForTests();
    state.template = 't2';
    state.provider = false;
    expect(await transcript(cid)).toMatchObject({ status: 503, body: { error: 'email_unavailable' } });
    state.provider = true;
    const { cid: noEmail } = answeredAndClosed({ email: null });
    expect(await transcript(noEmail)).toMatchObject({ status: 409, body: { error: 'no_email' } });
    __resetWidgetRateLimitsForTests();
    const ai = conversation();
    message(ai, 'contact');
    message(ai, 'ai');
    expect(await transcript(ai)).toMatchObject({ status: 409, body: { error: 'nothing_to_send' } });
    expect(state.sent).toHaveLength(0);
    expect(ledger()).toHaveLength(0);
  });

  it('limits: one per 10 minutes, 3 per conversation, 100 per workspace a day; a failed send costs no turn', async () => {
    const { cid } = answeredAndClosed();
    expect((await transcript(cid)).status).toBe(200);
    const soon = await transcript(cid);
    expect(soon).toMatchObject({ status: 429, body: { error: 'rate_limited', code: 'RATE_LIMITED', retry_after: 600 } });
    expect(soon.headers['retry-after']).toBe('600');
    __resetWidgetRateLimitsForTests();
    vi.setSystemTime(NOW + 11 * 60_000);
    expect((await transcript(cid)).status).toBe(200);
    vi.setSystemTime(NOW + 22 * 60_000);
    __resetWidgetRateLimitsForTests();
    // A failed send: 502, a 'failed' row, and no cooldown.
    state.sendResult = { success: false, provider: 'resend', error: 'boom' };
    expect(await transcript(cid)).toMatchObject({ status: 502, body: { error: 'send_failed' } });
    expect(state.events[state.events.length - 1]).toMatchObject({ eventType: 'transcript_emailed', payload: { status: 'failed' } });
    state.sendResult = { success: true, provider: 'resend' };
    expect((await transcript(cid)).status).toBe(200);
    __resetWidgetRateLimitsForTests();
    vi.setSystemTime(NOW + 60 * 60_000);
    expect(await transcript(cid)).toMatchObject({ status: 429, body: { error: 'limit_reached' } });
    expect(ledger().map((r) => r.status)).toEqual(['sent', 'sent', 'failed', 'sent']);
    expect((await csat(cid)).body.transcript).toEqual({ available: false, to: null });

    const { cid: other } = answeredAndClosed();
    for (let i = 0; i < 100; i += 1) {
      ledger().push({ id: randomUUID(), workspace_id: WS, conversation_id: randomUUID(), status: 'failed', created_at: new Date(NOW + 60 * 60_000 - i * 1000).toISOString() });
    }
    expect(await transcript(other)).toMatchObject({ status: 429, body: { error: 'workspace_limit' } });
  });

  it('a provider that throws (a network error) is a failed send: 502, a failed row, the timeline; then a retry', async () => {
    const { cid } = answeredAndClosed();
    state.sendThrows = true;
    expect(await transcript(cid)).toMatchObject({ status: 502, body: { error: 'send_failed' } });
    expect(ledger()).toEqual([expect.objectContaining({ conversation_id: cid, status: 'failed' })]);
    expect(state.events).toEqual([expect.objectContaining({ eventType: 'transcript_emailed', payload: expect.objectContaining({ status: 'failed' }) })]);
    state.sendThrows = false;
    expect(await transcript(cid)).toMatchObject({ status: 200, body: { ok: true } });
  });

  it('the widget\'s burst limit (category `transcript`): 3 a visitor in 10 minutes', async () => {
    const { cid } = answeredAndClosed({ email: null });
    for (let i = 0; i < 3; i += 1) expect((await transcript(cid)).body).toMatchObject({ error: 'no_email' });
    const fourth = await transcript(cid);
    expect(fourth).toMatchObject({ status: 429, body: { code: 'RATE_LIMITED' } });
    expect(Number(fourth.body.retry_after)).toBeGreaterThan(500);
  });

  it('before migration 276: 503 email_unavailable, nothing sent', async () => {
    const { cid } = answeredAndClosed();
    state.db.missing.add('conversation_transcript_emails');
    expect(await transcript(cid)).toMatchObject({ status: 503, body: { error: 'email_unavailable' } });
    expect(state.sent).toHaveLength(0);
  });

  it('a long conversation keeps the newest 200 messages and at most 200 KB', async () => {
    const cid = conversation();
    for (let i = 0; i < 230; i += 1) message(cid, i % 2 ? 'agent' : 'contact', `${i}:${'x'.repeat(3990)}`, {}, (300 - i) * 1000);
    const out = await buildVisitorTranscript({ supabaseUrl: 'https://x.test', supabaseServiceRoleKey: 'k' } as never, {
      workspaceId: WS, conversationId: cid, workspaceName: 'Acme', locale: 'en', timeZone: 'UTC', edition: 'international',
    });
    expect(Buffer.byteLength(out.html, 'utf8')).toBeLessThanOrEqual(MAX_TRANSCRIPT_BYTES);
    expect(out.count).toBeGreaterThan(40);
    expect(out.count).toBeLessThan(200);
    // The newest row is kept, the oldest went first.
    expect(out.html).toContain('229:');
    expect(out.html).not.toContain('>30:');
    expect(out.text.split('\n\n')).toHaveLength(out.count);
  });

  it('the cap is in bytes: a Persian transcript (two bytes a letter) stays within 200 KB too', async () => {
    const cid = conversation();
    for (let i = 0; i < 120; i += 1) message(cid, i % 2 ? 'agent' : 'contact', `${i}:${'س'.repeat(3990)}`, {}, (300 - i) * 1000);
    const out = await buildVisitorTranscript({ supabaseUrl: 'https://x.test', supabaseServiceRoleKey: 'k' } as never, {
      workspaceId: WS, conversationId: cid, workspaceName: 'فروشگاه', locale: 'fa', timeZone: 'Asia/Tehran', edition: 'iran',
    });
    expect(MAX_TRANSCRIPT_BYTES).toBe(200 * 1024);
    expect(Buffer.byteLength(out.html, 'utf8')).toBeLessThanOrEqual(MAX_TRANSCRIPT_BYTES);
    // Characters alone would have let about twice as much through.
    expect(out.count).toBeLessThan(30);
    expect(out.html).toContain('119:');
  });
});
