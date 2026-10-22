// @vitest-environment node
/**
 * The pre-chat form a visitor is asked (shared/prechatPolicy.ts), and the
 * identity routes that serve and enforce it (server/routes/widgetIdentity.ts
 * through services/widget/prechatEffective.ts):
 *
 *   - V-01: a field is required only while it is asked. A workspace that
 *     turned the name off (the panel used to leave `require_name` on) is no
 *     longer refused for a name its visitors were never asked.
 *   - S-02: the Super Admin's policy applies server-side: `force_on` = asked
 *     and required, `force_off` = never asked, whatever the workspace saved;
 *     `default_on` / `default_off` decide for a workspace without a row; and
 *     config.preChat (the widget's fallback) reads force_on as on.
 *   - W-04: a plan without `widget_prechat_form` asks only what the Super
 *     Admin forces (nothing forced: no form), never the old form.
 *   - V-14: a refused field is named (`field`, `<field>_invalid`) so the
 *     widget says it under that field.
 *
 * The REAL widgetIdentityRouter runs in-process against fakeServiceDb.ts; the
 * snapshots (policy, plan) and the merge are stand-ins.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createFakeServiceDb, fakeServiceClient, type FakeServiceDb, type Row } from '../conversations/fakeServiceDb';
import {
  defaultPrechatRow,
  effectivePrechat,
  normalizePreChatPolicy,
  requireOnlyAsked,
} from '../../../shared/prechatPolicy';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed JSON, asserted on its shape
type Body = Record<string, any>;
type Next = () => void;
const state = vi.hoisted(() => ({
  db: null as unknown as FakeServiceDb,
  policy: null as unknown,
  entitlements: null as unknown,
  merges: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeServiceClient(state.db) }));
vi.mock('../../../server/services/widget/configSnapshot.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/configSnapshot.js')>()),
  getWidgetPlatformSnapshot: async () => ({ preChatPolicy: state.policy }),
  getWorkspaceWidgetSnapshot: async () => ({ entitlements: state.entitlements }),
}));
vi.mock('../../../server/services/widget/visitorIdentity.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/visitorIdentity.js')>()),
  readVisitorCookie: () => ({ v: 'visitor-1' }),
  resolveVisitorIdentity: () => ({ visitorId: 'visitor-1', isNew: false }),
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
    return { contactId: 'contact-1', isNewContact: true, conversationsMerged: 0 };
  },
}));
vi.mock('../../../server/services/widget/crossWidgetIdentity.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/crossWidgetIdentity.js')>()),
  resolveKnownContact: async () => null,
  resolveSessionNetworkContext: async () => ({}),
  ensureVisitorSessionRow: async () => null,
  issueContinuityCookieForContact: async () => undefined,
}));
vi.mock('../../../server/services/conversationEvents.js', () => ({
  recordConversationEvent: async () => ({ ok: true }),
  recordAuditAndEvent: async () => undefined,
}));
vi.mock('../../../server/services/storage/urlResolver.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/storage/urlResolver.js')>()),
  resolveContactAvatarUrl: async () => null,
}));

const { widgetIdentityRouter } = await import('../../../server/routes/widgetIdentity.js');
const { buildPreChatConfig } = await import('../../../server/services/widget/configSnapshot.js');
const { __resetWidgetRateLimitsForTests } = await import('../../../server/services/widget/security.js');

const app = express();
app.use((req, _res, next) => { Object.assign(req, { serverConfig: { supabaseUrl: 'https://x.test', supabaseServiceRoleKey: 'k' } }); next(); });
app.use(express.json());
app.use('/api/widget/identity', widgetIdentityRouter);
const server = http.createServer(app).listen(0);

const WS = '11111111-1111-4111-8111-111111111111';

function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: Body }> {
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
const me = async () => (await call('GET', `/api/widget/identity/me?workspace_id=${WS}`)).body.prechat as Body;
const form = async () => (await call('GET', `/api/widget/identity/prechat?workspace_id=${WS}`)).body;
const submit = (body: Row) => call('POST', '/api/widget/identity/prechat', { workspace_id: WS, ...body });
function row(fields: Row) {
  state.db.tables.widget_prechat_settings = [{
    workspace_id: WS, ask_name: true, ask_email: true, ask_phone: false,
    require_name: true, require_email: true, require_phone: false,
    verify_email: false, verify_phone: false, prechat_timing: 'after_handoff', ...fields,
  }];
}
const PLAN_DENIES = { features: { widget_prechat_form: false }, maxDomains: 0 };

beforeEach(() => {
  state.db = createFakeServiceDb();
  state.policy = { name: 'default_on', email: 'default_on', phone: 'default_off' };
  state.entitlements = { features: { widget_prechat_form: true }, maxDomains: 1 };
  state.merges.length = 0;
  __resetWidgetRateLimitsForTests();
});

describe('shared/prechatPolicy.ts', () => {
  it('a field is required only while it is asked; the policy forces both ways', () => {
    const stored = { ask_name: false, require_name: true, ask_email: true, require_email: true, ask_phone: true, require_phone: true, prechat_timing: 'always' };
    expect(effectivePrechat(stored, null)).toMatchObject({
      ask_name: false, require_name: false, ask_email: true, require_email: true, ask_phone: true, require_phone: true, timing: 'always',
    });
    expect(effectivePrechat(stored, { name: 'force_on', email: 'default_on', phone: 'force_off' })).toMatchObject({
      ask_name: true, require_name: true, ask_phone: false, require_phone: false,
    });
    expect(requireOnlyAsked(stored)).toMatchObject({ require_name: false, require_email: true, require_phone: true, prechat_timing: 'always' });
  });

  it('without a row: the policy\'s defaults (name and email asked and required, the phone off unless the policy turns it on)', () => {
    expect(defaultPrechatRow(null)).toMatchObject({ ask_name: true, ask_email: true, ask_phone: false, require_name: true, require_email: true, require_phone: false });
    expect(effectivePrechat(null, { name: 'default_off', email: 'default_on', phone: 'default_on' })).toMatchObject({
      ask_name: false, require_name: false, ask_email: true, require_email: true, ask_phone: true, require_phone: false, timing: 'after_handoff',
    });
    // An unreadable policy reads as the columns' defaults (migration 044).
    expect(normalizePreChatPolicy({ name: 'nope' })).toEqual({ name: 'default_on', email: 'default_on', phone: 'default_off' });
  });

  it('a plan without the pre-chat form: only what the Super Admin forces, else no form at all', () => {
    const stored = { ask_name: true, require_name: true, ask_email: true, require_email: true, prechat_timing: 'always' };
    expect(effectivePrechat(stored, null, { planAllowsForm: false })).toMatchObject({
      ask_name: false, ask_email: false, ask_phone: false, require_name: false, require_email: false, timing: 'never',
    });
    expect(effectivePrechat(stored, { email: 'force_on' }, { planAllowsForm: false })).toMatchObject({
      ask_name: false, ask_email: true, require_email: true, timing: 'after_handoff',
    });
  });

  it('config.preChat (the widget\'s fallback): force_on is on and locked, force_off off and locked (it used to read force_on as off)', () => {
    const pc = buildPreChatConfig({ name: 'force_on', email: 'force_off', phone: 'default_on' });
    expect(pc.name).toMatchObject({ enabled: true, locked: true, mode: 'force_on' });
    expect(pc.email).toMatchObject({ enabled: false, locked: true, mode: 'force_off' });
    expect(pc.phone).toMatchObject({ enabled: true, locked: false });
  });
});

describe('the identity routes serve and enforce the same form', () => {
  it('V-01: the name turned off (its stale "required" left on): not asked, not required, and the visitor is not refused for it', async () => {
    row({ ask_name: false, require_name: true });
    expect(await me()).toMatchObject({ ask_name: false, require_name: false, ask_email: true, require_email: true });
    expect(await form()).toMatchObject({ ask_name: false, require_name: false });
    const res = await submit({ email: 'ali@example.com' });
    expect(res.status).toBe(200);
    expect(state.merges).toHaveLength(1);
  });

  it('S-02: the Super Admin\'s force_off removes a field the workspace asks; force_on adds one it does not, required', async () => {
    row({ ask_phone: true, require_phone: true, ask_email: false, require_email: false });
    state.policy = { name: 'default_on', email: 'force_on', phone: 'force_off' };
    expect(await me()).toMatchObject({ ask_phone: false, require_phone: false, ask_email: true, require_email: true });
    expect(await submit({ name: 'علی' })).toMatchObject({ status: 400, body: { error: 'email_required', field: 'email' } });
    expect(await submit({ name: 'علی', email: 'ali@example.com' })).toMatchObject({ status: 200 });
  });

  it('W-04: a plan without the pre-chat form asks nothing (timing never) and refuses nothing', async () => {
    row({ ask_name: true, require_name: true, ask_email: true, require_email: true, prechat_timing: 'always' });
    state.entitlements = PLAN_DENIES;
    expect(await me()).toMatchObject({ ask_name: false, ask_email: false, require_name: false, require_email: false, timing: 'never' });
    expect((await submit({})).status).toBe(200);
  });

  it('a plan that cannot be read keeps the workspace\'s own form (fail-open, as before the check)', async () => {
    row({ ask_name: true, require_name: true });
    state.entitlements = { features: { widget_prechat_form: false }, maxDomains: 0, degraded: true };
    expect(await me()).toMatchObject({ ask_name: true, require_name: true });
  });

  it('V-14: an address the server refuses names its field', async () => {
    row({});
    const res = await submit({ name: 'علی', email: 'ali@example.com.' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'email_invalid', field: 'email' });
    expect(res.body.details.email).toBeTruthy();
    expect(state.merges).toEqual([]);
  });
});

describe('P-01: the forms\' privacy line', () => {
  it('is served while the workspace shows it, whatever the plan; absent otherwise', async () => {
    row({});
    expect(await me()).not.toHaveProperty('privacy');
    row({ privacy_notice_enabled: false, privacy_notice_text: 'x', privacy_consent_required: true });
    expect(await me()).not.toHaveProperty('privacy');
    row({ privacy_notice_enabled: true, privacy_notice_text: '  We use   it to reply. ', privacy_policy_url: 'https://shop.example/p', privacy_consent_required: false });
    expect((await me()).privacy).toEqual({ text: 'We use it to reply.', url: 'https://shop.example/p', consent: false });
    state.entitlements = PLAN_DENIES;
    expect((await me()).privacy).toEqual({ text: 'We use it to reply.', url: 'https://shop.example/p', consent: false });
    // A stored link that is not https is never served.
    row({ privacy_notice_enabled: true, privacy_policy_url: 'http://shop.example/p' });
    expect((await me()).privacy).toEqual({ text: null, url: null, consent: false });
  });

  it('with the consent box: the form is refused without it (named "privacy"), taken with it, and the consent kept on the contact', async () => {
    row({ privacy_notice_enabled: true, privacy_policy_url: 'https://shop.example/p', privacy_consent_required: true });
    state.db.tables.contacts = [{ id: 'contact-1', workspace_id: WS, metadata: { source: 'widget' } }];
    expect(await submit({ name: 'علی', email: 'ali@example.com' })).toMatchObject({ status: 400, body: { error: 'privacy_consent_required', field: 'privacy' } });
    expect(await submit({ name: 'علی', email: 'ali@example.com', privacy_consent: false })).toMatchObject({ status: 400 });
    expect(state.merges).toEqual([]);
    expect((await submit({ name: 'علی', email: 'ali@example.com', privacy_consent: true })).status).toBe(200);
    expect(state.merges).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 20));
    const contact = (state.db.tables.contacts as Row[]).find((c) => c.id === 'contact-1')!;
    expect(contact.metadata).toMatchObject({ source: 'widget', privacy_consent: { source: 'prechat', policy_url: 'https://shop.example/p' } });
    expect(typeof (contact.metadata as Body).privacy_consent.at).toBe('string');
  });

  it('without the box nothing is asked of the visitor', async () => {
    row({ privacy_notice_enabled: true, privacy_consent_required: false });
    expect((await submit({ name: 'علی', email: 'ali@example.com' })).status).toBe(200);
  });
});
