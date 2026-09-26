/**
 * C6 — POST /api/widget/message must not route a visitor into another
 * customer's conversation because the visitor typed that customer's email or
 * phone (`visitor_email` / `visitor_phone`).
 *
 * The old "final fallback" looked the contact up by the typed email/phone and
 * appended the message to that contact's open thread, returning its
 * conversation_id; ensureVisitorContact then also adopted the victim's
 * contact and a continuity cookie for it was issued. Mounts the REAL
 * widgetRouter with the REAL ensureVisitorContact over an in-memory database.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { createInMemoryWidgetDb, type Row } from './helpers/inMemoryWidgetDb';

const WS = '11111111-1111-4111-8111-111111111111';
const VICTIM_CONTACT = '55555555-5555-4555-8555-555555555555';
const VICTIM_CONV = '66666666-6666-4666-8666-666666666666';
const VICTIM_EMAIL = 'victim@example.com';
const VICTIM_PHONE = '+15550001111';

const db = createInMemoryWidgetDb();
const continuityCookies: string[] = [];

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => db.client }));

vi.mock('../../../server/services/widget/security.js', () => ({
  createSessionToken: () => 'wss_test',
  verifySessionToken: () => ({ valid: true, workspaceId: WS }),
  verifyTokenForRefresh: () => ({ valid: true, workspaceId: WS }),
  enforceWidgetToken: (_req: Request, _res: Response, next: NextFunction) => next(),
  enforceOrigin: (_req: Request, _res: Response, next: NextFunction) => next(),
  widgetRateLimit: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  resolveWorkspaceId: (_req: Request, _res: Response, bodyWsId?: string) => bodyWsId || WS,
  verifyConversationOwnership: async () => ({ valid: false, conversation: null }),
  getClientIp: () => '127.0.0.1',
  getRequestOrigin: () => 'https://example.com',
}));

vi.mock('../../../server/services/widget/visitorIdentity.js', () => ({
  readVisitorCookie: (req: Request) => ({ v: String(req.headers['x-test-visitor'] || 'anon'), w: WS, exp: Math.floor(Date.now() / 1000) + 3600 }),
  resolveVisitorIdentity: (req: Request) => ({ visitorId: String(req.headers['x-test-visitor'] || 'anon'), isNew: false }),
  clearVisitorCookie: () => {},
}));

vi.mock('../../../server/services/widget/continuity.js', () => ({
  createSignedContactContinuityToken: (_ws: string, contactId: string) => contactId,
  setContinuityCookie: (_res: Response, contactId: string) => { continuityCookies.push(contactId); },
  readContinuityCookie: () => null,
  persistContinuityToken: async () => null,
  resolveContinuityToken: async () => ({ valid: false }),
  revokeContinuityToken: async () => true,
}));

vi.mock('../../../server/services/geo/index.js', () => ({
  resolveVisitorGeo: async () => ({ country: null, country_code: null, region: null, city: null, source: 'none' }),
  enrichVisitorSessionGeo: async () => {},
}));
vi.mock('../../../server/services/billing/conversationLimit.js', () => ({ enforceMaxConversationsLimit: async () => true }));
vi.mock('../../../server/services/ai-agent/platformGuards.js', () => ({ isAutoAnswerAllowedForWorkspace: async () => ({ allowed: true }) }));
vi.mock('../../../server/services/ai-agent/engine.js', () => ({
  maybeRunAiAssistantAfterVisitorMessage: async () => ({ action: 'skipped', reason: 'test_stub' }),
}));
vi.mock('../../../server/services/ai-agent/logs.js', () => ({ logRun: async () => {} }));
vi.mock('../../../server/services/ai-agent/handoffState.js', () => ({
  clearAiManagementForPlatformOff: async () => ({ previousAiState: null, changed: false }),
  markNeedsHuman: async () => {},
}));
vi.mock('../../../server/services/realtime/publish.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/realtime/publish.js')>();
  return { ...actual, publishConversationEvent: async () => ({ ok: true }) };
});
vi.mock('../../../server/services/push/index.js', () => ({ notifyInboundMessage: async () => {} }));
vi.mock('../../../server/routes/widgetAttachments.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/routes/widgetAttachments.js')>();
  return { ...actual, widgetAttachmentsRouter: express.Router(), attachUploadedFileToMessage: async () => true };
});
vi.mock('../../../server/routes/widgetIdentity.js', () => ({ widgetIdentityRouter: express.Router() }));
vi.mock('../../../server/routes/widgetCallbacks.js', () => ({ widgetCallbacksRouter: express.Router() }));
vi.mock('../../../server/routes/widgetDepartments.js', () => ({ widgetDepartmentsRouter: express.Router() }));
vi.mock('../../../server/routes/widgetCallInvitations.js', () => ({ widgetCallInvitationsRouter: express.Router() }));
vi.mock('../../../server/services/widget/availability.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/widget/availability.js')>();
  return { ...actual, resolveAvailability: async () => ({ state: 'offline', reason: 'outside_hours', next_open_at: null }) };
});
vi.mock('../../../server/services/conversationEvents.js', () => ({ recordConversationEvent: async () => {} }));
vi.mock('../../../server/services/conversationLifecycle.js', () => ({
  applyInboundConversationLifecycle: async () => {},
  INBOUND_REUSABLE_STATUSES: ['open', 'pending', 'resolved'],
}));

const { widgetRouter } = await import('../../../server/routes/widget.js');

const app = express();
app.use((req, _res, next) => {
  (req as unknown as { serverConfig: Row }).serverConfig = {
    supabaseUrl: 'https://example.supabase.co',
    supabaseAnonKey: 'ANON_KEY',
    supabaseServiceRoleKey: 'SERVICE_KEY',
  };
  next();
});
app.use(express.json());
app.use('/api/widget', widgetRouter);
const server = http.createServer(app).listen(0);
afterAll(() => { server.close(); });

function postMessage(visitor: string, body: Row, path = '/api/widget/message'): Promise<{ status: number; body: Row }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ workspace_id: WS, ...body });
    const req = http.request({
      host: '127.0.0.1',
      port: (server.address() as AddressInfo).port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-Widget-Token': 'wss_test',
        'x-test-visitor': visitor,
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode || 0, body: d ? JSON.parse(d) as Row : {} }); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

beforeEach(() => {
  db.reset();
  continuityCookies.length = 0;
  const now = new Date().toISOString();
  db.rows('widget_settings').push({ workspace_id: WS, enabled: true, chat_enabled: true });
  db.rows('contacts').push({
    id: VICTIM_CONTACT, workspace_id: WS, name: 'Victoria', email: VICTIM_EMAIL, phone: VICTIM_PHONE,
    visitor_code: 'VICT', metadata: { visitor_id: 'victim-visitor' },
  });
  db.rows('visitor_sessions').push({ id: 'victim-session', workspace_id: WS, visitor_id: 'victim-visitor', contact_id: VICTIM_CONTACT, last_seen_at: now });
  db.rows('conversations').push({
    id: VICTIM_CONV, workspace_id: WS, contact_id: VICTIM_CONTACT, visitor_session_id: 'victim-session',
    status: 'open', metadata: {}, updated_at: now,
  });
});

function messagesIn(convId: string): Row[] {
  return db.rows('conversation_messages').filter((m) => m.conversation_id === convId);
}

describe('C6 — POST /message with another customer\'s visitor_email / visitor_phone', () => {
  it.each([
    ['email', { visitor_email: VICTIM_EMAIL }],
    ['phone', { visitor_phone: VICTIM_PHONE }],
  ])('typed %s: never appends to the victim\'s thread, never returns its id, never links the victim contact', async (_kind, identity) => {
    const res = await postMessage('attacker-visitor', {
      visitor_id: 'attacker-visitor', message: 'hi, what did I order?', ...identity,
    });
    expect(res.status).toBe(200);
    expect(res.body.conversation_id).toBeTruthy();
    expect(res.body.conversation_id).not.toBe(VICTIM_CONV);
    expect(JSON.stringify(res.body)).not.toContain(VICTIM_CONTACT);
    expect(messagesIn(VICTIM_CONV)).toHaveLength(0);

    const conv = db.rows('conversations').find((c) => c.id === res.body.conversation_id) as Row;
    expect(conv.contact_id).toBeTruthy();
    expect(conv.contact_id).not.toBe(VICTIM_CONTACT);
    expect(continuityCookies).not.toContain(VICTIM_CONTACT);
    for (const s of db.rows('visitor_sessions').filter((x) => x.visitor_id === 'attacker-visitor')) {
      expect(s.contact_id).not.toBe(VICTIM_CONTACT);
    }

    // The operator still sees what was typed, on the attacker's own contact.
    const own = db.rows('contacts').find((c) => c.id === conv.contact_id) as Row;
    const meta = own.metadata as Row;
    expect(meta.unverified_email ?? meta.unverified_phone).toBeTruthy();
    expect(own.email ?? null).toBeNull();
    expect(own.phone ?? null).toBeNull();
  });
});

describe('C6 — POST /offline-messages with another customer\'s email', () => {
  it('files the capture under the visitor\'s own contact, never the victim\'s', async () => {
    const res = await postMessage('attacker-visitor', {
      message: 'please call me back about my account', email: VICTIM_EMAIL, name: 'Mallory',
    }, '/api/widget/offline-messages');
    expect(res.status).toBe(200);
    expect(res.body.conversation_id).toBeTruthy();
    const conv = db.rows('conversations').find((c) => c.id === res.body.conversation_id) as Row;
    expect(conv.contact_id).toBeTruthy();
    expect(conv.contact_id).not.toBe(VICTIM_CONTACT);
    const own = db.rows('contacts').find((c) => c.id === conv.contact_id) as Row;
    expect(own.email).toBeNull();
    expect((own.metadata as Row).unverified_email).toBe(VICTIM_EMAIL);
    expect((own.metadata as Row).visitor_id).toBe('attacker-visitor');

    // A second capture from the same visitor reuses their own contact.
    const again = await postMessage('attacker-visitor', { message: 'hello again', email: VICTIM_EMAIL }, '/api/widget/offline-messages');
    const conv2 = db.rows('conversations').find((c) => c.id === again.body.conversation_id) as Row;
    expect(conv2.contact_id).toBe(conv.contact_id);
  });

  it('a new address is still stored on the new contact', async () => {
    const res = await postMessage('nora-visitor', { message: 'hi there', email: 'nora@example.com' }, '/api/widget/offline-messages');
    const conv = db.rows('conversations').find((c) => c.id === res.body.conversation_id) as Row;
    const own = db.rows('contacts').find((c) => c.id === conv.contact_id) as Row;
    expect(own.email).toBe('nora@example.com');
    expect((own.metadata as Row).source).toBe('offline_capture');
  });
});
