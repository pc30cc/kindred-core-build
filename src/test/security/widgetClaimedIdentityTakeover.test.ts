/**
 * C6 — visitor identity takeover by a typed email / phone.
 *
 * Before the fix, an email or phone number TYPED by a visitor (pre-chat form,
 * call-widget pre-call form, `visitor_email` on POST /message) was looked up
 * with `.eq('email', …)` and the EXISTING contact holding it was merged onto
 * the typing visitor's session. /identity/me then returned the victim's PII,
 * /identity/history returned the victim's conversation, and a continuity
 * cookie for the victim's contact was issued to the attacker.
 *
 * These tests mount the REAL widgetIdentityRouter (identity merge,
 * cross-widget identity resolution and contact verification all run for
 * real) over an in-memory database, and prove:
 *   - pre-chat with another customer's email or phone never links to that
 *     customer's contact, never issues a continuity cookie for it, and never
 *     exposes their PII or conversation;
 *   - the operator still sees what the visitor typed (unverified claim);
 *   - the verification flow (verify/confirm with the delivered code) still
 *     merges the visitor into the existing contact;
 *   - a verified owner is never merged into a contact that merely CLAIMED
 *     their address earlier (pre-claim squatting).
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { createInMemoryWidgetDb, type Row } from './helpers/inMemoryWidgetDb';

const WS = '22222222-2222-4222-8222-222222222222';
const VICTIM_CONTACT = '55555555-5555-4555-8555-555555555555';
const VICTIM_CONV = '66666666-6666-4666-8666-666666666666';
const VICTIM_EMAIL = 'victim@example.com';
const VICTIM_PHONE = '+15550001111';
const VICTIM_NAME = 'Victoria Realname';
const VICTIM_SECRET = 'my card ends 4242 and order #98765';

const db = createInMemoryWidgetDb();
const continuityCookies: Array<{ contactId: string }> = [];

process.env.WIDGET_VERIFICATION_SECRET = 'test-verification-secret';

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => db.client }));

vi.mock('../../../server/services/widget/security.js', () => ({
  enforceWidgetToken: (_req: Request, _res: Response, next: NextFunction) => next(),
  enforceOrigin: (_req: Request, _res: Response, next: NextFunction) => next(),
  widgetRateLimit: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  resolveWorkspaceId: (_req: Request, _res: Response, bodyWsId?: string) => bodyWsId || WS,
  getClientIp: () => '127.0.0.1',
}));

// The visitor is whoever the test says it is (x-test-visitor) — this suite is
// about what a visitor can reach, not about cookie signing.
vi.mock('../../../server/services/widget/visitorIdentity.js', () => {
  const visitorOf = (req: Request) => String(req.headers['x-test-visitor'] || 'anon');
  return {
    readVisitorCookie: (req: Request) => ({ v: visitorOf(req), w: WS, exp: Math.floor(Date.now() / 1000) + 3600 }),
    resolveVisitorIdentity: (req: Request) => ({ visitorId: visitorOf(req), isNew: false }),
    clearVisitorCookie: () => {},
  };
});

// Record every continuity cookie the server tries to hand out.
vi.mock('../../../server/services/widget/continuity.js', () => ({
  createSignedContactContinuityToken: (_ws: string, contactId: string) => `signed:${contactId}`,
  setContinuityCookie: (_res: Response, token: string) => {
    continuityCookies.push({ contactId: token.replace(/^signed:/, '') });
  },
  readContinuityCookie: () => null,
  persistContinuityToken: async (_sb: unknown, opts: { contactId: string }) => {
    continuityCookies.push({ contactId: opts.contactId });
    return { token: 'tok', expiresAt: new Date(Date.now() + 3600_000) };
  },
  resolveContinuityToken: async () => ({ valid: false }),
  revokeContinuityToken: async () => true,
}));

vi.mock('../../../server/services/geo/index.js', () => ({
  resolveVisitorGeo: async () => ({
    country: null, country_code: null, region: null, city: null,
    latitude: null, longitude: null, timezone: null, source: 'none',
  }),
  enrichVisitorSessionGeo: async () => {},
}));

vi.mock('../../../server/services/conversationEvents.js', () => ({ recordConversationEvent: async () => {} }));
vi.mock('../../../server/services/storage/urlResolver.js', () => ({
  createStorageUrlResolver: () => ({}),
  resolveContactAvatarUrl: async () => null,
}));
vi.mock('../../../server/services/widget/senderIdentity.js', () => ({
  enrichMessagesWithSender: async (_c: unknown, _sb: unknown, msgs: unknown[]) => msgs,
}));
vi.mock('../../../server/routes/widgetAttachments.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/routes/widgetAttachments.js')>();
  return {
    ...actual,
    enrichMessagesWithAttachments: async (_c: unknown, _ws: string, msgs: unknown[]) => msgs,
    enrichMessagesWithReplyTo: async (_c: unknown, _id: string, msgs: unknown[]) => msgs,
  };
});

const { widgetIdentityRouter } = await import('../../../server/routes/widgetIdentity.js');
const { requestContactVerification } = await import('../../../server/services/widget/contactVerification.js');
const { ensureVisitorContact } = await import('../../../server/services/widget/anonymousContact.js');

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
app.use('/api/widget/identity', widgetIdentityRouter);
const server = http.createServer(app).listen(0);
afterAll(() => { server.close(); });

interface HttpResult { status: number; body: Row }

function call(method: 'GET' | 'POST', path: string, visitor: string, body?: Row): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request({
      host: '127.0.0.1',
      port: (server.address() as AddressInfo).port,
      path,
      method,
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
    if (payload) req.write(payload);
    req.end();
  });
}

const prechat = (visitor: string, body: Row) => call('POST', '/api/widget/identity/prechat', visitor, { workspace_id: WS, ...body });
const me = (visitor: string) => call('GET', `/api/widget/identity/me?workspace_id=${WS}`, visitor);
const history = (visitor: string) => call('GET', `/api/widget/identity/history?workspace_id=${WS}`, visitor);

function seedVictim(): void {
  const now = new Date().toISOString();
  db.rows('contacts').push({
    id: VICTIM_CONTACT, workspace_id: WS, name: VICTIM_NAME, email: VICTIM_EMAIL, phone: VICTIM_PHONE,
    visitor_code: 'VICT', metadata: { visitor_id: 'victim-visitor', source: 'widget' }, updated_at: now,
  });
  db.rows('visitor_sessions').push({
    id: 'victim-session', workspace_id: WS, visitor_id: 'victim-visitor', contact_id: VICTIM_CONTACT, last_seen_at: now,
  });
  db.rows('conversations').push({
    id: VICTIM_CONV, workspace_id: WS, contact_id: VICTIM_CONTACT, visitor_session_id: 'victim-session',
    status: 'open', metadata: {}, updated_at: now,
  });
  db.rows('conversation_messages').push({
    id: 'victim-msg-1', conversation_id: VICTIM_CONV, sender_type: 'contact', body: VICTIM_SECRET,
    metadata: {}, created_at: now, seen_at: null, reply_to_message_id: null,
  });
}

function victimRow(): Row {
  return db.rows('contacts').find((c) => c.id === VICTIM_CONTACT) as Row;
}

function sessionsOf(visitor: string): Row[] {
  return db.rows('visitor_sessions').filter((s) => s.visitor_id === visitor);
}

function expectNoVictimExposure(res: HttpResult): void {
  const s = JSON.stringify(res.body);
  expect(s).not.toContain(VICTIM_CONTACT);
  expect(s).not.toContain(VICTIM_CONV);
  expect(s).not.toContain(VICTIM_NAME);
  expect(s).not.toContain(VICTIM_PHONE);
  expect(s).not.toContain(VICTIM_SECRET);
}

beforeEach(() => {
  db.reset();
  continuityCookies.length = 0;
  seedVictim();
});

describe('C6 — pre-chat with another customer\'s email/phone does not take over their identity', () => {
  it('email: the attacker gets their own contact, no victim link, no victim continuity cookie', async () => {
    const res = await prechat('attacker-visitor', { name: 'Mallory', email: VICTIM_EMAIL });
    expect(res.status).toBe(200);
    expect(res.body.contact_id).toBeTruthy();
    expect(res.body.contact_id).not.toBe(VICTIM_CONTACT);
    expect(res.body.conversations_merged).toBe(0);

    // No attacker session is pinned to the victim; no continuity cookie for the victim.
    expect(sessionsOf('attacker-visitor').length).toBeGreaterThan(0);
    for (const s of sessionsOf('attacker-visitor')) expect(s.contact_id).not.toBe(VICTIM_CONTACT);
    expect(continuityCookies.map((c) => c.contactId)).not.toContain(VICTIM_CONTACT);
    expect(db.rows('identity_merges').some((m) => m._contact_id === VICTIM_CONTACT)).toBe(false);

    // Victim contact untouched, victim conversation still theirs.
    expect(victimRow()).toMatchObject({ email: VICTIM_EMAIL, phone: VICTIM_PHONE, name: VICTIM_NAME });
    expect((victimRow().metadata as Row).visitor_id).toBe('victim-visitor');
    expect(db.rows('conversations').find((c) => c.id === VICTIM_CONV)?.contact_id).toBe(VICTIM_CONTACT);

    // Operator still sees what was typed — as an unverified claim on the
    // attacker's own contact (the column belongs to the victim).
    const own = db.rows('contacts').find((c) => c.id === res.body.contact_id) as Row;
    expect(own.email).toBeNull();
    expect(own.name).toBe('Mallory');
    expect((own.metadata as Row).unverified_email).toBe(VICTIM_EMAIL);
    expect((own.metadata as Row).visitor_id).toBe('attacker-visitor');
  });

  it('email: /identity/me and /identity/history expose none of the victim\'s PII or messages', async () => {
    await prechat('attacker-visitor', { name: 'Mallory', email: VICTIM_EMAIL });

    const who = await me('attacker-visitor');
    expect(who.status).toBe(200);
    expectNoVictimExposure(who);
    expect((who.body.contact as Row | null)?.email ?? null).not.toBe(VICTIM_EMAIL);

    const hist = await history('attacker-visitor');
    expect(hist.status).toBe(200);
    expect(hist.body.conversation_id).not.toBe(VICTIM_CONV);
    expectNoVictimExposure(hist);
    expect(continuityCookies.map((c) => c.contactId)).not.toContain(VICTIM_CONTACT);
  });

  it('phone: typing the victim\'s phone number does not link either', async () => {
    db.rows('widget_prechat_settings').push({
      workspace_id: WS, ask_name: true, ask_email: false, ask_phone: true,
      require_name: true, require_email: false, require_phone: true, verify_email: false, verify_phone: false,
    });
    const res = await prechat('attacker-visitor', { name: 'Mallory', phone: '+1 555 000 1111' });
    expect(res.status).toBe(200);
    expect(res.body.contact_id).not.toBe(VICTIM_CONTACT);
    for (const s of sessionsOf('attacker-visitor')) expect(s.contact_id).not.toBe(VICTIM_CONTACT);
    const own = db.rows('contacts').find((c) => c.id === res.body.contact_id) as Row;
    expect(own.phone).toBeNull();
    expect((own.metadata as Row).unverified_phone).toBe(VICTIM_PHONE);

    expectNoVictimExposure(await me('attacker-visitor'));
    expectNoVictimExposure(await history('attacker-visitor'));
  });

  it('an attacker who already has an anonymous contact keeps it — the victim\'s address is not merged in', async () => {
    const ownId = await ensureVisitorContact(db.client as never, { workspaceId: WS, visitorId: 'attacker-visitor' });
    const res = await prechat('attacker-visitor', { name: 'Mallory', email: VICTIM_EMAIL });
    expect(res.status).toBe(200);
    expect(res.body.contact_id).toBe(ownId);
    const own = db.rows('contacts').find((c) => c.id === ownId) as Row;
    expect(own.email).toBeNull();
    expect((own.metadata as Row).unverified_email).toBe(VICTIM_EMAIL);
    expectNoVictimExposure(await history('attacker-visitor'));
  });

  it('a genuinely new email is still stored on the visitor\'s new contact (marked as an unverified claim)', async () => {
    const res = await prechat('new-visitor', { name: 'Nora', email: 'nora@example.com' });
    expect(res.status).toBe(200);
    const own = db.rows('contacts').find((c) => c.id === res.body.contact_id) as Row;
    expect(own.email).toBe('nora@example.com');
    expect((own.metadata as Row).unverified_email).toBe('nora@example.com');
    const who = await me('new-visitor');
    expect((who.body.contact as Row).email).toBe('nora@example.com');
  });
});

describe('C6 — ensureVisitorContact (POST /message contact path) with a typed email', () => {
  it('never returns or links the existing contact that holds the email', async () => {
    const id = await ensureVisitorContact(db.client as never, {
      workspaceId: WS, visitorId: 'attacker-visitor', sessionId: 'attacker-session', email: VICTIM_EMAIL,
    });
    expect(id).toBeTruthy();
    expect(id).not.toBe(VICTIM_CONTACT);
    const own = db.rows('contacts').find((c) => c.id === id) as Row;
    expect(own.email).toBeNull();
    expect((own.metadata as Row).unverified_email).toBe(VICTIM_EMAIL);
    expect(victimRow().email).toBe(VICTIM_EMAIL);
  });

  it('a signed (identityVerified) store identity still resolves the existing customer', async () => {
    const id = await ensureVisitorContact(db.client as never, {
      workspaceId: WS, visitorId: 'shop-visitor', email: VICTIM_EMAIL, identityVerified: true,
    });
    expect(id).toBe(VICTIM_CONTACT);
  });
});

describe('C6 — the verification flow still merges into the existing contact', () => {
  async function verify(visitor: string, identifier: string, channel: 'email' | 'phone' = 'email', issuedTo = visitor) {
    const issued = await requestContactVerification(db.client as never, {
      workspaceId: WS, visitorId: issuedTo, channel, identifier,
    });
    expect(issued.success).toBe(true);
    return call('POST', '/api/widget/identity/verify/confirm', visitor, {
      workspace_id: WS, channel, identifier, token: issued.rawToken,
    });
  }

  it('the real owner on a new device: pre-chat stays separate, verify/confirm merges and history resumes', async () => {
    const pre = await prechat('owner-new-device', { name: 'Victoria', email: VICTIM_EMAIL });
    expect(pre.body.contact_id).not.toBe(VICTIM_CONTACT);
    expectNoVictimExposure(await history('owner-new-device'));

    const confirmed = await verify('owner-new-device', VICTIM_EMAIL);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.contact_id).toBe(VICTIM_CONTACT);

    // Sessions re-pointed from the placeholder to the verified contact.
    for (const s of sessionsOf('owner-new-device')) expect(s.contact_id).toBe(VICTIM_CONTACT);
    const who = await me('owner-new-device');
    expect((who.body.contact as Row).id).toBe(VICTIM_CONTACT);
    const hist = await history('owner-new-device');
    expect(hist.body.conversation_id).toBe(VICTIM_CONV);
    expect(JSON.stringify(hist.body)).toContain(VICTIM_SECRET);
  });

  it('verified phone merges too', async () => {
    const confirmed = await verify('owner-phone-device', VICTIM_PHONE, 'phone');
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.contact_id).toBe(VICTIM_CONTACT);
  });

  it('a code issued to another visitor cannot be redeemed by this visitor', async () => {
    const confirmed = await verify('attacker-visitor', VICTIM_EMAIL, 'email', 'victim-visitor');
    expect(confirmed.status).toBe(400);
    for (const s of sessionsOf('attacker-visitor')) expect(s.contact_id).not.toBe(VICTIM_CONTACT);
    expectNoVictimExposure(await history('attacker-visitor'));
  });

  it('pre-claim squatting: a verified owner is never merged into the attacker\'s contact that only claimed the address', async () => {
    const address = 'future-customer@example.com';
    const squat = await prechat('attacker-visitor', { name: 'Mallory', email: address });
    const squatter = squat.body.contact_id as string;
    expect((db.rows('contacts').find((c) => c.id === squatter) as Row).email).toBe(address);

    const confirmed = await verify('real-owner', address);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.contact_id).not.toBe(squatter);

    const squatterRow = db.rows('contacts').find((c) => c.id === squatter) as Row;
    expect(squatterRow.email).toBeNull();
    expect((squatterRow.metadata as Row).unverified_email).toBe(address); // operator still sees the claim
    const ownerRow = db.rows('contacts').find((c) => c.id === confirmed.body.contact_id) as Row;
    expect(ownerRow.email).toBe(address);
    expect((ownerRow.metadata as Row).unverified_email ?? null).toBeNull();
    for (const s of sessionsOf('real-owner')) expect(s.contact_id).toBe(ownerRow.id);
    for (const s of sessionsOf('attacker-visitor')) expect(s.contact_id).toBe(squatter);
  });

  it('verifying your own claimed address clears the claim marker and keeps your contact', async () => {
    const pre = await prechat('nora-visitor', { name: 'Nora', email: 'nora@example.com' });
    const confirmed = await verify('nora-visitor', 'nora@example.com');
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.contact_id).toBe(pre.body.contact_id);
    const row = db.rows('contacts').find((c) => c.id === pre.body.contact_id) as Row;
    expect(row.email).toBe('nora@example.com');
    expect((row.metadata as Row).unverified_email ?? null).toBeNull();
  });
});
