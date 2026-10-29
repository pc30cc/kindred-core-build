// @vitest-environment node
/**
 * Bounce and complaint reports (server/routes/emailEvents.ts):
 *
 *   - each route answers 404 unless its provider is the default or the
 *     notification provider with its secret set;
 *   - a report is taken only with a valid signature inside the timestamp
 *     window: Svix's HMAC for Resend, SendGrid's ECDSA, our relay's HMAC
 *     with events_token; a replay is refused or counted once;
 *   - a 5.1.x hard bounce suppresses for good, another hard bounce for 30
 *     days, a complaint for good, a soft bounce not at all;
 *   - a failed write answers 500 and the provider's retry is not a duplicate;
 *   - nothing logs a secret.
 *
 * The config store and the suppression list are stood in for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';

const state = vi.hoisted(() => ({
  rows: {} as Record<string, unknown>,
  suppressed: [] as Array<{ address: string; reason: string; detail?: string; source: string; expiresAt?: Date | null }>,
  failWrites: false,
}));

vi.mock('../../../server/services/email/providerConfigStore.js', () => ({
  EMAIL_PROVIDER_KEYS: ['default_email_provider', 'notification_email_provider'],
  loadEmailProviderConfig: async (_config: unknown, key: string) => {
    const row = state.rows[key] as { provider_name: string; config: Record<string, unknown> } | undefined;
    return row ? { status: 'ok', provider: row } : { status: 'none' };
  },
}));
vi.mock('../../../server/services/email/suppressions.js', () => ({
  suppressionKey: (a: string) => (/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(a) ? a.toLowerCase() : null),
  suppressEmailAddress: async (_config: unknown, input: (typeof state.suppressed)[number]) => {
    if (state.failWrites) throw new Error('email_suppression_write_failed: down');
    state.suppressed.push(input);
  },
}));

const {
  emailEventsRouter,
  resetEmailEventReplayCache,
  signRelayReport,
  suppressionExpiry,
  enhancedStatus,
  TEMPORARY_SUPPRESSION_MS,
} = await import('../../../server/routes/emailEvents.js');

const app = express();
app.use((req, _res, next) => { Object.assign(req, { serverConfig: {} }); next(); });
app.use('/api/email-events', emailEventsRouter);

const SVIX_SECRET = `whsec_${Buffer.from('resend-test-secret-bytes').toString('base64')}`;
const RELAY_TOKEN = 'relay-events-token-for-tests';
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const SENDGRID_PUBLIC = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

const now = () => Math.floor(Date.now() / 1000);

function svixPost(payload: unknown, opts: { id?: string; ts?: number; secret?: string } = {}) {
  const body = JSON.stringify(payload);
  const id = opts.id ?? `msg_${Math.random().toString(36).slice(2)}`;
  const ts = String(opts.ts ?? now());
  const key = Buffer.from((opts.secret ?? SVIX_SECRET).slice('whsec_'.length), 'base64');
  const sig = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
  return request(app)
    .post('/api/email-events/resend')
    .set('content-type', 'application/json')
    .set('svix-id', id)
    .set('svix-timestamp', ts)
    .set('svix-signature', `v1,${sig}`)
    .send(body);
}

function sendgridPost(payload: unknown, opts: { ts?: number; key?: typeof privateKey } = {}) {
  const body = JSON.stringify(payload);
  const ts = String(opts.ts ?? now());
  const sig = sign('sha256', Buffer.from(ts + body), opts.key ?? privateKey).toString('base64');
  return request(app)
    .post('/api/email-events/sendgrid')
    .set('content-type', 'application/json')
    .set('x-twilio-email-event-webhook-signature', sig)
    .set('x-twilio-email-event-webhook-timestamp', ts)
    .send(body);
}

function relayPost(payload: unknown, opts: { ts?: number; token?: string } = {}) {
  const body = JSON.stringify(payload);
  const ts = String(opts.ts ?? now());
  return request(app)
    .post('/api/email-events/relay')
    .set('content-type', 'application/json')
    .set('x-relay-timestamp', ts)
    .set('x-relay-signature', signRelayReport(opts.token ?? RELAY_TOKEN, ts, body))
    .send(body);
}

const bounced = (to: string, type: string, subType: string, message = '') => ({
  type: 'email.bounced',
  data: { to: [to], bounce: { type, subType, message } },
});

let logs: string[] = [];

beforeEach(() => {
  state.rows = {};
  state.suppressed = [];
  state.failWrites = false;
  resetEmailEventReplayCache();
  logs = [];
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const line of logs) {
    expect(line).not.toContain(RELAY_TOKEN);
    expect(line).not.toContain(SVIX_SECRET);
  }
});

describe('which routes answer', () => {
  it('404 while the provider is not configured, or configured without its secret', async () => {
    expect((await svixPost({ type: 'email.complained', data: { to: ['a@b.co'] } })).status).toBe(404);
    expect((await sendgridPost([])).status).toBe(404);
    expect((await relayPost({ events: [] })).status).toBe(404);

    state.rows.default_email_provider = { provider_name: 'smtp', config: { smtp_host: 'mail-relay' } };
    state.rows.notification_email_provider = { provider_name: 'resend', config: { api_key: 'k' } };
    expect((await relayPost({ events: [] })).status).toBe(404);
    expect((await svixPost({ type: 'email.complained', data: { to: ['a@b.co'] } })).status).toBe(404);
    // Another provider's secret does not open this route.
    state.rows.default_email_provider = { provider_name: 'smtp', config: { events_token: RELAY_TOKEN } };
    expect((await svixPost({ type: 'email.complained', data: { to: ['a@b.co'] } })).status).toBe(404);
    expect(state.suppressed).toEqual([]);
  });

  it('the notification provider opens its route too', async () => {
    state.rows.notification_email_provider = { provider_name: 'resend', config: { webhook_secret: SVIX_SECRET } };
    const res = await svixPost({ type: 'email.complained', data: { to: ['A@B.co'] } });
    expect(res.status).toBe(200);
    expect(state.suppressed).toEqual([
      expect.objectContaining({ address: 'A@B.co', reason: 'complaint', source: 'resend_webhook', expiresAt: null }),
    ]);
  });
});

describe('Resend (Svix)', () => {
  beforeEach(() => {
    state.rows.default_email_provider = { provider_name: 'resend', config: { webhook_secret: SVIX_SECRET } };
  });

  it('refuses a wrong signature, a stale or future timestamp', async () => {
    const other = `whsec_${Buffer.from('another-secret').toString('base64')}`;
    expect((await svixPost(bounced('x@y.co', 'Permanent', 'General'), { secret: other })).status).toBe(401);
    expect((await svixPost(bounced('x@y.co', 'Permanent', 'General'), { ts: now() - 600 })).status).toBe(401);
    expect((await svixPost(bounced('x@y.co', 'Permanent', 'General'), { ts: now() + 600 })).status).toBe(401);
    expect(state.suppressed).toEqual([]);
  });

  it('a replayed delivery counts once', async () => {
    const payload = bounced('x@y.co', 'Permanent', 'General');
    expect((await svixPost(payload, { id: 'msg_1' })).body).toEqual({ ok: true, recorded: 1 });
    expect((await svixPost(payload, { id: 'msg_1' })).body).toEqual({ ok: true, duplicate: true });
    expect(state.suppressed).toHaveLength(1);
  });

  it('maps a hard bounce by its status; a soft one changes nothing', async () => {
    await svixPost(bounced('gone@y.co', 'Permanent', 'General', '550 5.1.1 user unknown'));
    await svixPost(bounced('noemail@y.co', 'Permanent', 'NoEmail'));
    await svixPost(bounced('policy@y.co', 'Permanent', 'General', '550 5.7.1 rejected'));
    await svixPost(bounced('full@y.co', 'Transient', 'MailboxFull', '452 4.2.2 full'));
    await svixPost({ type: 'email.delivered', data: { to: ['ok@y.co'] } });
    const byAddress = Object.fromEntries(state.suppressed.map((s) => [s.address, s]));
    expect(Object.keys(byAddress).sort()).toEqual(['gone@y.co', 'noemail@y.co', 'policy@y.co']);
    expect(byAddress['gone@y.co']).toMatchObject({ reason: 'hard_bounce', expiresAt: null });
    expect(byAddress['noemail@y.co']).toMatchObject({ reason: 'hard_bounce', expiresAt: null });
    const until = byAddress['policy@y.co'].expiresAt as Date;
    expect(Math.abs(until.getTime() - (Date.now() + TEMPORARY_SUPPRESSION_MS))).toBeLessThan(60_000);
  });

  it('a failed write answers 500, and the retry is recorded', async () => {
    state.failWrites = true;
    const payload = bounced('x@y.co', 'Permanent', 'General');
    expect((await svixPost(payload, { id: 'msg_retry' })).status).toBe(500);
    state.failWrites = false;
    expect((await svixPost(payload, { id: 'msg_retry' })).body).toEqual({ ok: true, recorded: 1 });
  });
});

describe('SendGrid (signed Event Webhook)', () => {
  beforeEach(() => {
    state.rows.default_email_provider = { provider_name: 'sendgrid', config: { webhook_public_key: SENDGRID_PUBLIC } };
  });

  it('refuses a signature by another key, or a stale one', async () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
    expect((await sendgridPost([{ email: 'x@y.co', event: 'spamreport' }], { key: other })).status).toBe(401);
    expect((await sendgridPost([{ email: 'x@y.co', event: 'spamreport' }], { ts: now() - 3600 })).status).toBe(401);
    expect(state.suppressed).toEqual([]);
  });

  it('takes bounce, dropped and spamreport; skips blocked and others', async () => {
    const res = await sendgridPost([
      { email: 'gone@y.co', event: 'bounce', type: 'bounce', status: '5.1.1', reason: '550 5.1.1 no such user' },
      { email: 'policy@y.co', event: 'bounce', type: 'bounce', status: '5.7.1' },
      { email: 'blocked@y.co', event: 'bounce', type: 'blocked', status: '4.7.0' },
      { email: 'invalid@y.co', event: 'dropped', reason: 'Invalid' },
      { email: 'spam@y.co', event: 'dropped', reason: 'Spam Reporting Address' },
      { email: 'unsub@y.co', event: 'dropped', reason: 'Unsubscribed Address' },
      { email: 'complain@y.co', event: 'spamreport' },
      { email: 'ok@y.co', event: 'delivered' },
    ]);
    expect(res.body).toEqual({ ok: true, recorded: 5 });
    const byAddress = Object.fromEntries(state.suppressed.map((s) => [s.address, s]));
    expect(byAddress['gone@y.co']).toMatchObject({ reason: 'hard_bounce', expiresAt: null, source: 'sendgrid_webhook' });
    expect(byAddress['policy@y.co'].expiresAt).toBeInstanceOf(Date);
    expect(byAddress['invalid@y.co']).toMatchObject({ reason: 'hard_bounce', expiresAt: null });
    expect(byAddress['spam@y.co']).toMatchObject({ reason: 'complaint', expiresAt: null });
    expect(byAddress['complain@y.co']).toMatchObject({ reason: 'complaint', expiresAt: null });
    expect(byAddress['blocked@y.co']).toBeUndefined();
    expect(byAddress['unsub@y.co']).toBeUndefined();
  });
});

describe('our relay', () => {
  beforeEach(() => {
    state.rows.default_email_provider = {
      provider_name: 'smtp',
      config: { smtp_host: 'mail-relay', events_token: RELAY_TOKEN },
    };
  });

  it('refuses another token, a stale timestamp and a body changed after signing', async () => {
    const events = { events: [{ type: 'bounce', recipient: 'x@y.co', status: '5.1.1' }] };
    expect((await relayPost(events, { token: 'not-the-token' })).status).toBe(401);
    expect((await relayPost(events, { ts: now() - 301 })).status).toBe(401);
    const ts = String(now());
    const tampered = await request(app)
      .post('/api/email-events/relay')
      .set('content-type', 'application/json')
      .set('x-relay-timestamp', ts)
      .set('x-relay-signature', signRelayReport(RELAY_TOKEN, ts, JSON.stringify(events)))
      .send(JSON.stringify({ events: [{ type: 'bounce', recipient: 'victim@y.co', status: '5.1.1' }] }));
    expect(tampered.status).toBe(401);
    expect(state.suppressed).toEqual([]);
  });

  it('records 5.x.x bounces by their class, skips deferrals and bad addresses', async () => {
    const res = await relayPost({
      events: [
        { type: 'bounce', recipient: 'gone@y.co', status: '5.1.1', detail: 'host said: 550 5.1.1 unknown', queue_id: 'ABC123' },
        { type: 'bounce', recipient: 'policy@y.co', status: '5.7.1' },
        { type: 'bounce', recipient: 'later@y.co', status: '4.4.1' },
        { type: 'bounce', recipient: 'a@b.co, c@d.co', status: '5.1.1' },
        { type: 'deferred', recipient: 'x@y.co', status: '4.2.2' },
      ],
    });
    expect(res.body).toEqual({ ok: true, recorded: 2 });
    expect(state.suppressed[0]).toMatchObject({ address: 'gone@y.co', reason: 'hard_bounce', source: 'relay', expiresAt: null });
    expect(state.suppressed[0].detail).toContain('5.1.1');
    expect(state.suppressed[1]).toMatchObject({ address: 'policy@y.co' });
    expect(state.suppressed[1].expiresAt).toBeInstanceOf(Date);
  });
});

describe('helpers', () => {
  it('finds an enhanced status code', () => {
    expect(enhancedStatus('550 5.1.1 <x@y.co>: Recipient address rejected')).toBe('5.1.1');
    expect(enhancedStatus('421 4.7.0 Try again later')).toBe('4.7.0');
    expect(enhancedStatus('no code')).toBeUndefined();
  });

  it('suppresses 5.1.x and complaints for good, other hard bounces for 30 days', () => {
    const t = Date.UTC(2026, 9, 29);
    expect(suppressionExpiry({ address: 'a@b.co', kind: 'complaint', detail: '' }, t)).toBeNull();
    expect(suppressionExpiry({ address: 'a@b.co', kind: 'hard_bounce', status: '5.1.10', detail: '' }, t)).toBeNull();
    expect(suppressionExpiry({ address: 'a@b.co', kind: 'hard_bounce', status: '5.2.2', detail: '' }, t)?.getTime())
      .toBe(t + 30 * 24 * 3600_000);
    expect(suppressionExpiry({ address: 'a@b.co', kind: 'hard_bounce', detail: '' }, t)).not.toBeNull();
  });
});
