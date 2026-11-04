/**
 * The widget API audit of 2026-11-04, the pieces outside the main widget
 * router: the ownership rule itself, the attachments sub-router, the
 * callback request, /api/visitors heartbeat and disconnect, and the geo
 * providers' timeout.
 *
 *   widgetapi-4  verifyConversationOwnership: the signed visitor alone (the
 *                dvsid cookie or the visitor credential); a visitor id or a
 *                session id a caller passes proves nothing.
 *   widgetapi-5  a file no conversation holds is only its uploader's (to
 *                upload into, attach and download; never an operator's
 *                team-chat file), and a message naming another file's id
 *                never describes it (migration 301).
 *   widgetapi-2  POST /callback/request: rate-limited as a message, the
 *                signed visitor required (so the dedupe always has a key),
 *                and a conversation it names must be theirs.
 *   widgetapi-9  POST /api/visitors/heartbeat and /disconnect: a widget
 *                token, its workspace and the signed visitor's own session.
 *   widgetapi-11 every geo provider fetch carries a 3 s timeout.
 *
 * Only the database (the shared in-memory fake), storage and the token/
 * origin gates are faked; ownership and the routes run for real.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createFakeServiceDb, fakeServiceClient, type FakeServiceDb, type Row } from '../conversations/fakeServiceDb';

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '99999999-9999-4999-8999-999999999999';
const VISITOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_VISITOR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SESSION = '22222222-2222-4222-8222-222222222222';
const OTHER_SESSION = '33333333-3333-4333-8333-333333333333';

const state = vi.hoisted(() => ({
  db: null as unknown as FakeServiceDb,
  visitor: null as string | null,
  tokenWorkspace: '11111111-1111-4111-8111-111111111111' as string | null,
  rateCategories: [] as string[],
  callbacks: [] as Array<Record<string, unknown>>,
  uploads: 0,
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeServiceClient(state.db) }));
vi.mock('../../../server/services/widget/visitorIdentity.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/visitorIdentity.js')>()),
  readVisitorCookie: (_req: unknown, ws?: string) =>
    (state.visitor && ws === '11111111-1111-4111-8111-111111111111' ? { v: state.visitor, w: ws, iat: 1, exp: 9e9 } : null),
}));
vi.mock('../../../server/services/widget/security.js', async (orig) => {
  const real = await orig<typeof import('../../../server/services/widget/security.js')>();
  return {
    ...real,
    enforceWidgetToken: (req: { _widgetWorkspaceId?: string }, res: { status(n: number): { json(b: unknown): void } }, next: () => void) => {
      if (!state.tokenWorkspace) return res.status(401).json({ error: 'missing token' });
      req._widgetWorkspaceId = state.tokenWorkspace;
      next();
    },
    enforceOrigin: (_req: unknown, _res: unknown, next: () => void) => next(),
    widgetRateLimit: (category: string) => (_req: unknown, _res: unknown, next: () => void) => { state.rateCategories.push(category); next(); },
    readWidgetToken: (req: { headers: Record<string, unknown> }) => (req.headers['x-widget-token'] as string) || null,
    verifySessionToken: (token: string) => (token === 'wss_good' && state.tokenWorkspace
      ? { valid: true, workspaceId: state.tokenWorkspace }
      : { valid: false, reason: 'invalid' }),
  };
});
vi.mock('../../../server/services/widget/public.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/public.js')>()),
  isWorkspaceOriginAllowed: async () => true,
}));
vi.mock('../../../server/services/widget/planGate.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/planGate.js')>()),
  widgetPlanDenied: async () => new Set<string>(),
}));
vi.mock('../../../server/services/storage/index.js', () => ({
  uploadFile: async () => { state.uploads += 1; return { success: true }; },
  downloadFile: async () => ({ success: true, data: Buffer.from('file-bytes') }),
  resolveStorageConfig: async () => ({ provider: 'local' }),
}));
vi.mock('../../../server/middleware/featureGating.js', () => ({
  requireLimit: () => async (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../../server/services/billing/usageResolvers.js', () => ({ usageFnForLimit: () => () => 0 }));
vi.mock('../../../server/services/calls/entitlementComposer.js', () => ({
  loadEffectiveCallEntitlements: async () => ({ callbacks_enabled: true }),
}));
vi.mock('../../../server/services/calls/callbacks.js', () => ({
  createCallbackRequest: async (_c: unknown, input: Record<string, unknown>) => {
    state.callbacks.push(input);
    return { id: randomUUID(), created_at: new Date().toISOString(), ...input };
  },
}));
vi.mock('../../../server/services/calls/queue.js', () => ({ markEntryAsCallback: async () => {} }));
vi.mock('../../../server/services/widget/crossWidgetIdentity.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/crossWidgetIdentity.js')>()),
  resolveSessionNetworkContext: async () => ({}),
  ensureVisitorSessionRow: async () => '22222222-2222-4222-8222-222222222222',
}));
vi.mock('../../../server/services/realtime/publish.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/realtime/publish.js')>()),
  publishVisitorEvent: async () => {},
}));
vi.mock('../../../server/services/visitors/presenceSource.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/visitors/presenceSource.js')>()),
  resolveVisitorPresenceMode: async () => 'database',
}));
vi.mock('../../../server/services/webAnalytics/pageViews.js', () => ({ recordVisitorPageView: async () => {} }));

const { verifyConversationOwnership } = await import('../../../server/services/widget/security.js');
const attachments = await import('../../../server/routes/widgetAttachments.js');
const { widgetCallbacksRouter } = await import('../../../server/routes/widgetCallbacks.js');
const { visitorRouter } = await import('../../../server/routes/visitors.js');

const config = { supabaseUrl: 'https://x.test', supabaseServiceRoleKey: 'k' } as never;
const app = express();
app.use((req, _res, next) => { (req as unknown as Row).serverConfig = config; next(); });
app.use(express.json());
app.use('/api/widget/attachments', attachments.widgetAttachmentsRouter);
app.use('/api/widget/callback', widgetCallbacksRouter);
app.use('/api/visitors', visitorRouter);
const server = http.createServer(app).listen(0);
afterAll(() => { server.close(); });

type Answer = { status: number; body: Row };
function call(method: 'GET' | 'POST', path: string, body?: Row, headers: Record<string, string> = { 'X-Widget-Token': 'wss_good' }): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request({
      host: '127.0.0.1', port: (server.address() as AddressInfo).port, path, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Origin: 'https://shop.test', ...headers },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        const type = String(res.headers['content-type'] || '');
        resolve({ status: res.statusCode || 0, body: type.includes('json') && d ? JSON.parse(d) as Row : { raw: d } });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const req = (visitor: string | null) => {
  state.visitor = visitor;
  return { cookies: {}, headers: {} } as never;
};

function conversation(fields: Row = {}): Row {
  const row: Row = { id: randomUUID(), workspace_id: WS, status: 'open', contact_id: null, visitor_session_id: null, assigned_to: null, metadata: {}, updated_at: new Date().toISOString(), ...fields };
  (state.db.tables.conversations ||= []).push(row);
  return row;
}
function attachment(fields: Row = {}): Row {
  const id = randomUUID();
  const row: Row = {
    id, workspace_id: WS, conversation_id: null, message_id: null, storage_provider: 'local',
    storage_path: `workspace/${WS}/attachments/${id}.png`, file_name: 'photo.png', mime_type: 'image/png',
    size_bytes: 4, uploaded_by_type: 'visitor', uploaded_by_id: null, uploaded_by_visitor_id: VISITOR,
    visitor_session_id: null, status: 'uploaded', ...fields,
  };
  (state.db.tables.conversation_attachments ||= []).push(row);
  return row;
}

beforeEach(() => {
  state.db = createFakeServiceDb();
  state.visitor = null;
  state.tokenWorkspace = WS;
  state.rateCategories = [];
  state.callbacks = [];
  state.uploads = 0;
  state.db.tables.widget_settings = [{ workspace_id: WS, enabled: true, chat_enabled: true, attachments_enabled: true, voice_notes_enabled: true }];
  state.db.tables.visitor_sessions = [
    { id: SESSION, workspace_id: WS, visitor_id: VISITOR, current_page: 'https://shop.test/a', last_seen_at: new Date().toISOString() },
    { id: OTHER_SESSION, workspace_id: WS, visitor_id: OTHER_VISITOR, current_page: 'https://shop.test/b', last_seen_at: new Date().toISOString() },
  ];
  state.db.tables.visitor_presence = [
    { visitor_session_id: SESSION, status: 'online' },
    { visitor_session_id: OTHER_SESSION, status: 'online' },
  ];
  state.db.tables.contacts = [{ id: 'c-mine', workspace_id: WS, metadata: { visitor_id: VISITOR } }];
});

describe('widgetapi-4 — verifyConversationOwnership: the signed visitor alone', () => {
  it('a visitor id and a session id the caller passes prove nothing', async () => {
    const conv = conversation({ visitor_session_id: OTHER_SESSION, metadata: { visitor_id: OTHER_VISITOR } });
    // The victim's own ids, without their cookie: not theirs.
    expect((await verifyConversationOwnership(config, String(conv.id), WS, OTHER_VISITOR, OTHER_SESSION, req(null))).valid).toBe(false);
    // Another signed visitor naming the victim's ids: not theirs either.
    expect((await verifyConversationOwnership(config, String(conv.id), WS, OTHER_VISITOR, OTHER_SESSION, req(VISITOR))).valid).toBe(false);
    // Without the request nothing is owned.
    expect((await verifyConversationOwnership(config, String(conv.id), WS, OTHER_VISITOR, OTHER_SESSION)).valid).toBe(false);
  });

  it('the signed visitor owns it by the conversation, its contact or its session', async () => {
    const byMeta = conversation({ metadata: { visitor_id: VISITOR } });
    const byContact = conversation({ contact_id: 'c-mine' });
    const bySession = conversation({ visitor_session_id: SESSION });
    for (const c of [byMeta, byContact, bySession]) {
      expect((await verifyConversationOwnership(config, String(c.id), WS, null, null, req(VISITOR))).valid).toBe(true);
    }
    // Never across workspaces.
    const foreign = conversation({ workspace_id: OTHER_WS, metadata: { visitor_id: VISITOR } });
    expect((await verifyConversationOwnership(config, String(foreign.id), WS, null, null, req(VISITOR))).valid).toBe(false);
  });
});

describe('widgetapi-5 — a file no conversation holds is its uploader’s only', () => {
  const init = (body: Row = {}) => call('POST', '/api/widget/attachments/init', { file_name: 'p.png', mime_type: 'image/png', size_bytes: 4, ...body });

  it('/init needs the signed visitor and records them (and only their own session)', async () => {
    expect((await init()).status).toBe(401);
    state.visitor = VISITOR;
    const answer = await init({ session_id: OTHER_SESSION });
    expect(answer.status).toBe(200);
    const row = state.db.tables.conversation_attachments.find((a) => a.id === answer.body.attachment_id)!;
    expect(row.uploaded_by_visitor_id).toBe(VISITOR);
    expect(row.visitor_session_id).toBeNull();
    const own = await init({ session_id: SESSION });
    expect(state.db.tables.conversation_attachments.find((a) => a.id === own.body.attachment_id)!.visitor_session_id).toBe(SESSION);
  });

  it('/init before migration 301 still reserves the file', async () => {
    state.db.missingColumns = { conversation_attachments: ['uploaded_by_visitor_id'] };
    state.visitor = VISITOR;
    const answer = await init();
    expect(answer.status).toBe(200);
    expect(state.db.tables.conversation_attachments.find((a) => a.id === answer.body.attachment_id)!.uploaded_by_visitor_id).toBeUndefined();
  });

  it('/init drops a conversation that is not the visitor’s (a body visitor_id names nobody)', async () => {
    const theirs = conversation({ visitor_session_id: OTHER_SESSION, metadata: { visitor_id: OTHER_VISITOR } });
    state.visitor = VISITOR;
    const answer = await init({ conversation_id: theirs.id, visitor_id: OTHER_VISITOR, session_id: OTHER_SESSION });
    expect(state.db.tables.conversation_attachments.find((a) => a.id === answer.body.attachment_id)!.conversation_id).toBeNull();
  });

  it('only the uploader writes its bytes', async () => {
    const row = attachment({ status: 'uploading' });
    state.visitor = OTHER_VISITOR;
    expect((await call('POST', `/api/widget/attachments/${row.id}/upload`, { data: 'AAAA' })).status).toBe(403);
    expect(state.uploads).toBe(0);
    state.visitor = VISITOR;
    expect((await call('POST', `/api/widget/attachments/${row.id}/upload`, { data: 'AAAA' })).status).toBe(200);
    expect(state.uploads).toBe(1);
  });

  it('only the uploader downloads an unbound file; never an operator’s team-chat file', async () => {
    const mine = attachment();
    const team = attachment({ uploaded_by_type: 'agent', uploaded_by_id: randomUUID(), uploaded_by_visitor_id: null, status: 'attached' });
    state.visitor = OTHER_VISITOR;
    expect((await call('GET', `/api/widget/attachments/${mine.id}`)).status).toBe(403);
    expect((await call('GET', `/api/widget/attachments/${team.id}`)).status).toBe(403);
    state.visitor = VISITOR;
    expect((await call('GET', `/api/widget/attachments/${team.id}`)).status).toBe(403);
    const ok = await call('GET', `/api/widget/attachments/${mine.id}`);
    expect(ok.status).toBe(200);
    expect(ok.body.raw).toBe('file-bytes');
  });

  it('a bound file: the conversation’s signed visitor, never a query session_id', async () => {
    const theirs = conversation({ visitor_session_id: OTHER_SESSION, metadata: { visitor_id: OTHER_VISITOR } });
    const file = attachment({ conversation_id: theirs.id, uploaded_by_visitor_id: OTHER_VISITOR, status: 'attached' });
    state.visitor = VISITOR;
    expect((await call('GET', `/api/widget/attachments/${file.id}?visitor_id=${OTHER_VISITOR}&session_id=${OTHER_SESSION}`)).status).toBe(403);
    state.visitor = OTHER_VISITOR;
    expect((await call('GET', `/api/widget/attachments/${file.id}`)).status).toBe(200);
  });

  it('a visitor attaches only their own upload; an operator’s reply is unchanged', async () => {
    const conv = conversation({ metadata: { visitor_id: VISITOR } });
    const theirs = attachment({ uploaded_by_visitor_id: OTHER_VISITOR });
    const team = attachment({ uploaded_by_type: 'agent', uploaded_by_visitor_id: null });
    const mine = attachment();
    expect(await attachments.attachUploadedFileToMessage(config, String(theirs.id), WS, String(conv.id), 'm1', { visitorId: VISITOR })).toBe(false);
    expect(await attachments.attachUploadedFileToMessage(config, String(team.id), WS, String(conv.id), 'm1', { visitorId: VISITOR })).toBe(false);
    expect(await attachments.attachUploadedFileToMessage(config, String(mine.id), WS, String(conv.id), 'm1', { visitorId: null })).toBe(false);
    expect(theirs.status).toBe('uploaded');
    expect(await attachments.attachUploadedFileToMessage(config, String(mine.id), WS, String(conv.id), 'm1', { visitorId: VISITOR })).toBe(true);
    expect(mine).toMatchObject({ status: 'attached', conversation_id: conv.id, message_id: 'm1' });
    // The operator panel's own send (routes/conversations.ts) passes no visitor.
    const operatorFile = attachment({ uploaded_by_type: 'agent', uploaded_by_visitor_id: null });
    expect(await attachments.attachUploadedFileToMessage(config, String(operatorFile.id), WS, String(conv.id), 'm2')).toBe(true);
  });

  it('isVisitorsOwnUpload: before 301 a visitor upload passes only where allowed, an operator’s never', () => {
    const visitorRow = { uploaded_by_type: 'visitor', uploaded_by_visitor_id: null };
    expect(attachments.isVisitorsOwnUpload(visitorRow, VISITOR, true, true)).toBe(true);
    expect(attachments.isVisitorsOwnUpload(visitorRow, VISITOR, true, false)).toBe(false);
    expect(attachments.isVisitorsOwnUpload({ uploaded_by_type: 'agent' }, VISITOR, true, true)).toBe(false);
    expect(attachments.isVisitorsOwnUpload(visitorRow, VISITOR)).toBe(false);
    expect(attachments.isVisitorsOwnUpload({ uploaded_by_type: 'visitor', uploaded_by_visitor_id: VISITOR }, null)).toBe(false);
  });

  it('a message naming another conversation’s file is not described in this one', async () => {
    const conv = conversation();
    const own = attachment({ conversation_id: conv.id, status: 'attached' });
    const foreign = attachment({ conversation_id: randomUUID(), status: 'attached', file_name: 'secret-contract.pdf' });
    const unbound = attachment({ file_name: 'team-plan.pdf' });
    const out = await attachments.enrichMessagesWithAttachments(config, WS, [
      { id: 'm-own', metadata: { attachment_id: own.id } },
      { id: 'm-foreign', metadata: { attachment_id: foreign.id } },
      { id: 'm-unbound', metadata: { attachment_id: unbound.id } },
    ], { conversationId: String(conv.id) }) as Array<Row>;
    expect(out[0].attachment).toMatchObject({ id: own.id });
    expect(out[1].attachment).toBeUndefined();
    expect(out[2].attachment).toBeUndefined();
  });
});

describe('widgetapi-2 — POST /callback/request', () => {
  const request = (body: Row = {}) => call('POST', '/api/widget/callback/request', { channel: 'audio', ...body });

  it('is rate-limited as a message and needs the signed visitor', async () => {
    const answer = await request();
    expect(state.rateCategories).toContain('message');
    expect(answer.status).toBe(401);
    expect(state.callbacks).toHaveLength(0);
  });

  it('keys the callback on the visitor’s session (the dedupe key) and refuses another visitor’s conversation', async () => {
    state.visitor = VISITOR;
    const theirs = conversation({ visitor_session_id: OTHER_SESSION, metadata: { visitor_id: OTHER_VISITOR } });
    expect((await request({ conversation_id: theirs.id })).status).toBe(403);
    expect(state.callbacks).toHaveLength(0);
    const mine = conversation({ metadata: { visitor_id: VISITOR } });
    expect((await request({ conversation_id: mine.id })).status).toBe(200);
    expect(state.callbacks[0]).toMatchObject({ visitorSessionId: SESSION, conversationId: mine.id });
  });
});

describe('widgetapi-9 — /api/visitors heartbeat and disconnect', () => {
  const presence = (id: string) => state.db.tables.visitor_presence.find((p) => p.visitor_session_id === id)!;
  const session = (id: string) => state.db.tables.visitor_sessions.find((s) => s.id === id)!;

  it('without a widget token or the signed visitor nothing changes', async () => {
    expect((await call('POST', '/api/visitors/disconnect', { session_id: OTHER_SESSION }, {})).status).toBe(401);
    expect((await call('POST', '/api/visitors/disconnect', { session_id: OTHER_SESSION })).status).toBe(401);
    expect((await call('POST', '/api/visitors/heartbeat', { session_id: OTHER_SESSION, current_page: 'https://evil.test' }, {})).status).toBe(401);
    expect(presence(OTHER_SESSION).status).toBe('online');
    expect(session(OTHER_SESSION).current_page).toBe('https://shop.test/b');
  });

  it('another visitor’s session, or another workspace, is not found', async () => {
    state.visitor = VISITOR;
    expect((await call('POST', '/api/visitors/disconnect', { session_id: OTHER_SESSION })).status).toBe(404);
    expect((await call('POST', '/api/visitors/heartbeat', { session_id: OTHER_SESSION, current_page: 'https://evil.test' })).status).toBe(404);
    expect((await call('POST', '/api/visitors/heartbeat', { workspace_id: OTHER_WS, session_id: SESSION })).status).toBe(403);
    expect(presence(OTHER_SESSION).status).toBe('online');
    expect(session(OTHER_SESSION).current_page).toBe('https://shop.test/b');
  });

  it('the visitor’s own session works as before', async () => {
    state.visitor = VISITOR;
    expect((await call('POST', '/api/visitors/heartbeat', { workspace_id: WS, session_id: SESSION, current_page: 'https://shop.test/c' })).status).toBe(200);
    expect(session(SESSION).current_page).toBe('https://shop.test/c');
    expect((await call('POST', '/api/visitors/disconnect', { session_id: SESSION })).status).toBe(200);
    expect(presence(SESSION).status).toBe('offline');
  });
});

describe('widgetapi-11 — geo provider lookups time out', () => {
  it('every provider fetch carries the 3 s signal', async () => {
    const geo = await import('../../../server/services/geo/index.js');
    expect(geo.GEO_PROVIDER_TIMEOUT_MS).toBe(3000);
    const src = readFileSync('server/services/geo/index.ts', 'utf8');
    const fetches = src.match(/await fetch\([^;]*\);/g) || [];
    expect(fetches.length).toBeGreaterThanOrEqual(4);
    for (const f of fetches) expect(f).toContain('signal: providerSignal()');
  });
});
