// @vitest-environment node
/**
 * The "new offline message" mail reaches each owner or admin in THEIR
 * language (server/services/operatorLocale.ts: preferred_locale, else the
 * platform's default), never in the language of the visitor who wrote it:
 * a Turkish visitor on a Persian team's widget used to send every owner a
 * Turkish mail.
 *
 *  - two owners, fa and en, get fa and en whatever the visitor's locale;
 *  - an owner without a preferred language gets the platform's default;
 *  - with no owner address, the workspace's reply-to address gets the
 *    platform's default;
 *  - the test send (POST /admin/test-offline-email) without a locale is in
 *    the requesting member's language; an explicit one still wins.
 *
 * The REAL widgetRouter runs in-process against fakeServiceDb.ts; the email
 * service records what it is asked to send.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createFakeServiceDb, fakeServiceClient, type FakeServiceDb, type Row } from './fakeServiceDb';

type Next = () => void;
type Sent = { to?: string; locale?: string; templateSlug?: string };
const state = vi.hoisted(() => ({
  db: null as unknown as FakeServiceDb,
  sent: [] as Array<Record<string, unknown>>,
  user: 'u-fa' as string,
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeServiceClient(state.db) }));
vi.mock('../../../server/services/widget/visitorIdentity.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/visitorIdentity.js')>()),
  readVisitorCookie: () => ({ v: 'visitor-1' }),
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
  notifyInboundMessage: async () => {},
}));
vi.mock('../../../server/services/conversationEvents.js', () => ({
  recordConversationEvent: async () => ({ ok: true }),
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
vi.mock('../../../server/services/platformRegion.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/platformRegion.js')>()),
  getPlatformAllowedLocales: async () => ['fa', 'en', 'tr'],
}));
vi.mock('../../../server/lib/workspaceAuth.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/lib/workspaceAuth.js')>()),
  authorizeWorkspaceAccess: async () => ({ userId: state.user, isAdmin: false, role: 'owner' }),
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
const { __resetOperatorLocaleCache } = await import('../../../server/services/operatorLocale.js');

const app = express();
app.use((req, _res, next) => { Object.assign(req, { serverConfig: { supabaseUrl: 'https://x.test', supabaseServiceRoleKey: 'k' } }); next(); });
app.use(express.json());
app.use('/api/widget', widgetRouter);
const server = http.createServer(app).listen(0);

const WS = '11111111-1111-4111-8111-111111111111';

function post(path: string, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: (server.address() as AddressInfo).port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode || 0)); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const leave = (locale: string) => post('/api/widget/offline-messages', { workspace_id: WS, message: 'Merhaba, fiyat nedir?', locale, honeypot: '' });
const mails = () => state.sent as Sent[];
const byRecipient = () => Object.fromEntries(mails().map((m) => [m.to, m.locale]));

beforeEach(() => {
  state.db = createFakeServiceDb();
  state.db.tables.workspace_members = [
    { workspace_id: WS, user_id: 'u-fa', role: 'owner' },
    { workspace_id: WS, user_id: 'u-en', role: 'admin' },
  ];
  state.db.tables.profiles = [
    { id: 'u-fa', email: 'sara@example.com', preferred_locale: 'fa' },
    { id: 'u-en', email: 'john@example.com', preferred_locale: 'en-US' },
  ];
  state.db.tables.platform_settings = [{ id: 1, default_locale: 'fa' }];
  state.sent.length = 0;
  state.user = 'u-fa';
  __resetWidgetRateLimitsForTests();
  __resetOperatorLocaleCache();
});

describe('the offline-message mail is in each recipient\'s language', () => {
  for (const visitorLocale of ['tr', 'en', 'fa']) {
    it(`a ${visitorLocale} visitor: the fa owner gets fa, the en admin gets en`, async () => {
      expect(await leave(visitorLocale)).toBe(200);
      await vi.waitFor(() => expect(mails()).toHaveLength(2));
      expect(byRecipient()).toEqual({ 'sara@example.com': 'fa', 'john@example.com': 'en' });
      for (const m of mails()) expect(m.templateSlug).toBe('offline_message_received');
    });
  }

  it('an owner who chose no language gets the platform\'s default, not the visitor\'s', async () => {
    state.db.tables.profiles = [
      { id: 'u-fa', email: 'sara@example.com', preferred_locale: null },
      { id: 'u-en', email: 'john@example.com', preferred_locale: 'en' },
    ];
    expect(await leave('tr')).toBe(200);
    await vi.waitFor(() => expect(mails()).toHaveLength(2));
    expect(byRecipient()).toEqual({ 'sara@example.com': 'fa', 'john@example.com': 'en' });
  });

  it('no owner address: the workspace\'s reply-to address, in the platform\'s default', async () => {
    state.db.tables.profiles = [];
    state.db.tables.email_settings = [{ workspace_id: WS, reply_to_email: 'team@example.com' }] as Row[];
    expect(await leave('tr')).toBe(200);
    await vi.waitFor(() => expect(mails()).toHaveLength(1));
    expect(byRecipient()).toEqual({ 'team@example.com': 'fa' });
  });
});

describe('the test send', () => {
  it('without a locale: the requesting member\'s language', async () => {
    state.user = 'u-en';
    expect(await post('/api/widget/admin/test-offline-email', { workspace_id: WS, to: 'me@example.com' })).toBe(200);
    expect(mails()).toHaveLength(1);
    expect(mails()[0].locale).toBe('en');
    state.user = 'u-fa';
    __resetOperatorLocaleCache();
    expect(await post('/api/widget/admin/test-offline-email', { workspace_id: WS, to: 'me@example.com' })).toBe(200);
    expect(mails()[1].locale).toBe('fa');
  });

  it('an explicit locale still wins', async () => {
    expect(await post('/api/widget/admin/test-offline-email', { workspace_id: WS, to: 'me@example.com', locale: 'tr' })).toBe(200);
    expect(mails()[0].locale).toBe('tr');
  });
});

describe('P-01: the leave-a-message form\'s consent box', () => {
  const leaveWith = (extra: Record<string, unknown>) => post('/api/widget/offline-messages', {
    workspace_id: WS, message: 'Hello, the price?', locale: 'en', honeypot: '', email: 'ali@example.com', ...extra,
  });
  const conversations = () => (state.db.tables.conversations as Row[] | undefined)?.length ?? 0;

  it('while the workspace asks for it: refused without it (nothing captured), taken with it', async () => {
    state.db.tables.widget_prechat_settings = [{ workspace_id: WS, privacy_notice_enabled: true, privacy_consent_required: true }];
    expect(await leaveWith({})).toBe(400);
    expect(await leaveWith({ privacy_consent: 'yes' })).toBe(400);
    expect(conversations()).toBe(0);
    expect(mails()).toEqual([]);
    expect(await leaveWith({ privacy_consent: true })).toBe(200);
    expect(conversations()).toBe(1);
  });

  it('a privacy line without the box (or none) asks nothing of the visitor', async () => {
    state.db.tables.widget_prechat_settings = [{ workspace_id: WS, privacy_notice_enabled: true, privacy_consent_required: false }];
    expect(await leaveWith({})).toBe(200);
    state.db.tables.widget_prechat_settings = [{ workspace_id: WS, privacy_notice_enabled: false, privacy_consent_required: true }];
    expect(await leaveWith({})).toBe(200);
  });
});
