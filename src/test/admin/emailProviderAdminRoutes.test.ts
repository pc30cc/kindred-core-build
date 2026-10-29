// @vitest-environment node
/**
 * Super Admin → Providers → Email, server side (server/routes/
 * adminEmailProviders.ts) and the generic runtime-config routes it replaced
 * for the email rows (server/routes/adminManagement.ts):
 *
 *   - no secret reaches the browser: today's production row (the relay
 *     password in plain text under "config") reads back as "set", from the
 *     page's own route, the generic runtime-config read and the System
 *     page's list alike, and every other runtime row is redacted too;
 *   - a save goes through the config store: a blank password keeps the
 *     stored one, a password with spaces or "**" is stored as typed and
 *     encrypted, a vendor with no adapter is refused (by the generic route
 *     too), and every change is audited and shown with who made it;
 *   - "Test connection" is the adapter's verify; "Send test email" goes only
 *     to the signed-in admin's own address, through the slot's provider, and
 *     reports the real result; an unset notification slot is not tested
 *     through the platform provider by mistake;
 *   - the generic PUT keeps a credential the form never received, and never
 *     carries one to another vendor;
 *   - the suppression list: search, list, remove (audited).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

type Row = Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed JSON, asserted on its shape
type Json = any;

const db = vi.hoisted(() => ({ tables: {} as Record<string, Row[]>, seq: 0 }));
const ids = vi.hoisted(() => ({ ADMIN: '00000000-0000-4000-8000-0000000000aa' }));
const sent = vi.hoisted(() => [] as Array<{ config: Record<string, unknown>; to: string; subject: string; text: string; replyTo?: string }>);
const adapterResult = vi.hoisted(() => ({ value: { success: true, provider: 'smtp', id: '<m1@relay>', serverMessageId: '4ABCD' } as Record<string, unknown> }));

/** A small PostgREST-shaped client over `db.tables`: enough for these routes and the email core. */
function fakeClient() {
  return {
    from(table: string) {
      const rows = () => (db.tables[table] ??= []);
      const filters: Array<(r: Row) => boolean> = [];
      let order: { col: string; asc: boolean } | null = null;
      let limit = Infinity;
      let range: [number, number] | null = null;
      let wantCount = false;
      let mode: 'select' | 'delete' = 'select';
      const matched = () => {
        let out = rows().filter((r) => filters.every((f) => f(r)));
        if (order) {
          const { col, asc } = order;
          out = [...out].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1));
        }
        return out;
      };
      const run = () => {
        if (mode === 'delete') {
          const gone = matched();
          db.tables[table] = rows().filter((r) => !gone.includes(r));
          return { data: structuredClone(gone), error: null };
        }
        const all = matched();
        let page = all.slice(0, limit);
        if (range) page = all.slice(range[0], range[1] + 1);
        return { data: structuredClone(page), error: null, ...(wantCount ? { count: all.length } : {}) };
      };
      const b: Record<string, unknown> = {
        select: (_cols?: string, opts?: { count?: string }) => { if (opts?.count) wantCount = true; return b; },
        eq: (col: string, val: unknown) => { filters.push((r) => r[col] === val); return b; },
        is: (col: string, val: unknown) => { filters.push((r) => (r[col] ?? null) === val); return b; },
        in: (col: string, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return b; },
        ilike: (col: string, pattern: string) => {
          // LIKE: % any run, _ one character, a backslash escapes the next one.
          const literal = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          let source = '';
          for (let i = 0; i < pattern.length; i++) {
            const c = pattern[i];
            if (c === '\\' && i + 1 < pattern.length) source += literal(pattern[++i]);
            else source += c === '%' ? '.*' : c === '_' ? '.' : literal(c);
          }
          const re = new RegExp(`^${source}$`, 'is');
          filters.push((r) => re.test(String(r[col] ?? '')));
          return b;
        },
        order: (col: string, opts?: { ascending?: boolean }) => { order = { col, asc: opts?.ascending !== false }; return b; },
        limit: (n: number) => { limit = n; return b; },
        range: (from: number, to: number) => { range = [from, to]; return b; },
        maybeSingle: async () => ({ data: structuredClone(matched()[0] ?? null), error: null }),
        single: async () => ({ data: structuredClone(matched()[0] ?? null), error: null }),
        insert: (payload: Row | Row[]) => {
          // Strictly increasing times, so "newest first" is well defined.
          for (const row of Array.isArray(payload) ? payload : [payload]) rows().push({ created_at: new Date(Date.UTC(2026, 9, 29) + ++db.seq * 1000).toISOString(), ...structuredClone(row) });
          return { then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }) };
        },
        upsert: (payload: Row) => {
          const existing = rows().find((r) => r.key === payload.key);
          if (existing) Object.assign(existing, structuredClone(payload));
          else rows().push(structuredClone(payload));
          return { then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }) };
        },
        delete: () => { mode = 'delete'; return b; },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
      };
      return b;
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));
vi.mock('../../../server/lib/serviceClient.js', () => ({ serviceClientFor: () => fakeClient() }));
vi.mock('../../../server/lib/workspaceAuth.js', () => ({ requirePlatformAdmin: async () => ids.ADMIN }));
vi.mock('../../../server/services/operatorLocale.js', () => ({ operatorLocale: async () => 'en' }));
vi.mock('../../../server/services/email/providers/smtp.js', () => ({
  smtpAdapter: {
    name: 'smtp',
    send: async (config: { config: Record<string, unknown> }, message: { to: string; subject: string; text: string; replyTo?: string }) => {
      sent.push({ config: config.config, to: message.to, subject: message.subject, text: message.text, replyTo: message.replyTo });
      return adapterResult.value;
    },
    verify: async (config: { config: Record<string, unknown> }) => ({ ok: true, detail: `signed in to ${config.config.smtp_host}:587; encryption: auto` }),
  },
}));

const ADMIN = ids.ADMIN;
const MASTER = 'a'.repeat(64);
const RELAY_PASS = 'relay-secret-1';

const { adminEmailProvidersRouter, __resetEmailProviderAdminRateLimit } = await import('../../../server/routes/adminEmailProviders.js');
const { adminManagementRouter, redactRuntimeConfigValue, keepStoredRuntimeSecrets } = await import('../../../server/routes/adminManagement.js');
const { decodeEmailProviderRow } = await import('../../../server/services/email/providerConfigStore.js');

const serverConfig = {
  supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', pluginSecretsMasterKey: MASTER,
  complianceAuditLoggingEnabled: true, deliveryDiagnosticsLoggingEnabled: true, corsOrigins: ['*'],
};

const app = express();
app.use((req, _res, next) => {
  Object.assign(req, { serverConfig, adminUser: { id: ADMIN } });
  next();
});
app.use(express.json());
app.use('/api/admin/providers/email', adminEmailProvidersRouter);
app.use('/api/admin/management', adminManagementRouter);
const server = http.createServer(app).listen(0);
afterAll(() => server.close());

function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Json; raw: string }> {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: (server.address() as AddressInfo).port, path, method,
      headers: payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {},
    }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : {}, raw }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** default_email_provider on both brands since 2026-10-29 15:11 UTC. */
const PRODUCTION = {
  provider_name: 'smtp',
  config: {
    smtp_host: 'mail-relay', smtp_port: '587', smtp_user: 'noreply@webyar.ai', smtp_pass: RELAY_PASS,
    from_email: 'noreply@webyar.ai', from_name: 'Webyar',
  },
};

const runtime = (key: string) => db.tables.app_runtime_config?.find((r) => r.key === key)?.value as Row | undefined;
const decoded = (key: string) => decodeEmailProviderRow(runtime(key), MASTER)?.config ?? null;

beforeEach(() => {
  db.tables = {
    app_runtime_config: [
      { key: 'default_email_provider', value: structuredClone(PRODUCTION) },
      { key: 'default_ai_provider', value: { provider_name: 'openai', config: { api_key: 'sk-live-123', model: 'gpt-x' } } },
      { key: 'widget_prechat_fields', value: [{ key: 'name', label: 'Name' }] },
    ],
    profiles: [{ id: ADMIN, email: 'owner@webyar.ai', full_name: 'Owner' }],
    audit_logs: [],
    email_suppressions: [],
    email_settings: [],
  };
  sent.length = 0;
  adapterResult.value = { success: true, provider: 'smtp', id: '<m1@relay>', serverMessageId: '4ABCD' };
  __resetEmailProviderAdminRateLimit();
  delete process.env.SMTP_PASS;
});

describe('no secret is sent to the browser', () => {
  it('the page reads today\'s production row with the password named, never shown', async () => {
    const res = await call('GET', '/api/admin/providers/email');
    expect(res.status).toBe(200);
    expect(res.raw).not.toContain(RELAY_PASS);
    expect(res.json.slots.default).toMatchObject({
      provider_name: 'smtp',
      config: { smtp_host: 'mail-relay', smtp_user: 'noreply@webyar.ai', from_email: 'noreply@webyar.ai' },
      secretKeysSet: ['smtp_pass'],
      readiness: 'configured',
      problems: [],
    });
    expect(res.json.slots.notification).toMatchObject({ provider_name: null, readiness: 'unconfigured' });
    expect(res.json.testRecipient).toBe('owner@webyar.ai');
    expect(res.json.encryptionAvailable).toBe(true);
  });

  it('the generic runtime-config read and the System page list redact every key', async () => {
    const one = await call('GET', '/api/admin/management/runtime-config/default_email_provider');
    expect(one.raw).not.toContain(RELAY_PASS);
    expect(one.json).toEqual({
      value: { provider_name: 'smtp', config: { smtp_host: 'mail-relay', smtp_port: '587', smtp_user: 'noreply@webyar.ai', from_email: 'noreply@webyar.ai', from_name: 'Webyar' } },
      secretKeysSet: ['config.smtp_pass'],
    });

    const ai = await call('GET', '/api/admin/management/runtime-config/default_ai_provider');
    expect(ai.json).toEqual({ value: { provider_name: 'openai', config: { model: 'gpt-x' } }, secretKeysSet: ['config.api_key'] });

    const list = await call('GET', '/api/admin/management/runtime-config');
    expect(list.raw).not.toContain(RELAY_PASS);
    expect(list.raw).not.toContain('sk-live-123');
    const prechat = list.json.config.find((r: Row) => r.key === 'widget_prechat_fields');
    // A pre-chat field's own `key` is not a credential.
    expect(prechat.value).toEqual([{ key: 'name', label: 'Name' }]);
    expect(prechat.secretKeysSet).toEqual([]);
  });

  it('an encrypted row reads back without its envelope either', async () => {
    await call('PUT', '/api/admin/providers/email/default', { provider_name: 'smtp', config: { ...PRODUCTION.config, smtp_pass: '' } });
    expect(JSON.stringify(runtime('default_email_provider'))).not.toContain(RELAY_PASS);
    const list = await call('GET', '/api/admin/management/runtime-config');
    const row = list.json.config.find((r: Row) => r.key === 'default_email_provider');
    expect(JSON.stringify(row)).not.toMatch(/ciphertext|auth_tag|nonce/);
    expect(row.secretKeysSet).toEqual(['config.smtp_pass']);
  });
});

describe('saving goes through the config store', () => {
  it('a blank password keeps the stored one, now encrypted, and the change is audited with who', async () => {
    const res = await call('PUT', '/api/admin/providers/email/default', {
      provider_name: 'smtp',
      config: { ...PRODUCTION.config, smtp_pass: '', encryption: 'auto', reply_to: 'support@webyar.ai' },
    });
    expect(res.status).toBe(200);
    expect(res.raw).not.toContain(RELAY_PASS);
    expect(decoded('default_email_provider')).toMatchObject({ smtp_pass: RELAY_PASS, reply_to: 'support@webyar.ai', encryption: 'auto' });
    expect(db.tables.audit_logs).toHaveLength(1);
    expect(JSON.stringify(db.tables.audit_logs)).not.toContain(RELAY_PASS);
    expect(res.json.slots.default.lastChange).toMatchObject({
      slot: 'default',
      provider_name: 'smtp',
      changed_fields: expect.arrayContaining(['encryption', 'reply_to']),
      actor: { id: ADMIN, name: 'Owner', email: 'owner@webyar.ai' },
    });
    expect(res.json.history).toHaveLength(1);
  });

  it('no valid password is refused or changed: spaces, "**" and any letter are stored as typed', async () => {
    const password = '  pa ss**word ü  ';
    const res = await call('PUT', '/api/admin/providers/email/default', { provider_name: 'smtp', config: { ...PRODUCTION.config, smtp_pass: password } });
    expect(res.status).toBe(200);
    expect(decoded('default_email_provider')?.smtp_pass).toBe(password);
  });

  it('a vendor without a server adapter is refused, and the working row is untouched', async () => {
    const res = await call('PUT', '/api/admin/providers/email/default', { provider_name: 'mailgun', config: { api_key: 'k', from_email: 'a@b.co' } });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: 'unknown_provider', field: 'provider_name' });
    const generic = await call('PUT', '/api/admin/management/runtime-config/default_email_provider', {
      value: { provider_name: 'mailgun', config: { api_key: 'k', from_email: 'a@b.co' } },
    });
    expect(generic.status).toBe(400);
    expect(generic.json.error).toBe('unknown_provider');
    expect(runtime('default_email_provider')).toEqual(PRODUCTION);
    expect(db.tables.audit_logs).toEqual([]);
  });

  it('a missing required field names the field', async () => {
    const res = await call('PUT', '/api/admin/providers/email/default', { provider_name: 'smtp', config: { smtp_host: 'mail-relay' } });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: 'missing_field', field: 'from_email' });
  });

  it('the generic routes write the email rows through the store too: validated, encrypted, audited', async () => {
    const put = await call('PUT', '/api/admin/management/runtime-config/default_email_provider', {
      value: { provider_name: 'smtp', config: { ...PRODUCTION.config, smtp_pass: '' } },
    });
    expect(put.status).toBe(200);
    expect(JSON.stringify(runtime('default_email_provider'))).not.toContain(RELAY_PASS);
    expect(decoded('default_email_provider')?.smtp_pass).toBe(RELAY_PASS);
    const del = await call('DELETE', '/api/admin/management/runtime-config/default_email_provider');
    expect(del.status).toBe(200);
    expect(runtime('default_email_provider')).toBeUndefined();
    expect(db.tables.audit_logs.map((r) => (r.new_value as Row).provider_name)).toEqual(['smtp', 'disabled']);
  });

  it('the notification slot is its own row, and removing it is audited', async () => {
    const res = await call('PUT', '/api/admin/providers/email/notification', {
      provider_name: 'resend', config: { api_key: 're_live_1', from_email: 'notify@webyar.ai' },
    });
    expect(res.status).toBe(200);
    expect(res.raw).not.toContain('re_live_1');
    expect(res.json.slots.notification).toMatchObject({ provider_name: 'resend', secretKeysSet: ['api_key'], readiness: 'configured' });
    expect(decoded('notification_email_provider')?.api_key).toBe('re_live_1');
    expect(decoded('default_email_provider')?.smtp_pass).toBe(RELAY_PASS);

    const removed = await call('DELETE', '/api/admin/providers/email/notification');
    expect(removed.json.slots.notification.provider_name).toBeNull();
    expect(removed.json.history.map((h: Row) => [h.slot, h.provider_name])).toEqual([['notification', 'disabled'], ['notification', 'resend']]);
  });

  it('an unknown slot is not a row of the platform', async () => {
    expect((await call('PUT', '/api/admin/providers/email/default_email_provider', { provider_name: 'smtp', config: {} })).status).toBe(404);
    expect((await call('POST', '/api/admin/providers/email/billing/test-send', {})).status).toBe(404);
  });
});

describe('the generic runtime-config PUT keeps what the form never received', () => {
  it('a blank credential keeps the stored one for the same vendor, never for another', async () => {
    await call('PUT', '/api/admin/management/runtime-config/default_ai_provider', { value: { provider_name: 'openai', config: { model: 'gpt-y' } } });
    expect(runtime('default_ai_provider')).toEqual({ provider_name: 'openai', config: { model: 'gpt-y', api_key: 'sk-live-123' } });

    await call('PUT', '/api/admin/management/runtime-config/default_ai_provider', { value: { provider_name: 'anthropic', config: { model: 'c' } } });
    expect(runtime('default_ai_provider')).toEqual({ provider_name: 'anthropic', config: { model: 'c' } });
  });

  it('the helpers: nested paths, envelopes, arrays and booleans', () => {
    const { value, secretKeysSet } = redactRuntimeConfigValue({
      provider: 's3',
      config: { bucket: 'b', secret_access_key: 'x', access_key_id: 'AKIA', region: 'r' },
      secrets: { api_key: { ciphertext: 'c' } },
      nodes: [{ host: 'h', token: 't' }],
      allow_attachment_fallback: true,
      api_key: '',
    });
    expect(value).toEqual({ provider: 's3', config: { bucket: 'b', region: 'r' }, nodes: [{ host: 'h' }], allow_attachment_fallback: true, api_key: '' });
    expect(secretKeysSet.sort()).toEqual(['config.access_key_id', 'config.secret_access_key', 'nodes.0.token', 'secrets']);

    expect(keepStoredRuntimeSecrets(
      { provider: 's3', config: { bucket: 'old', secret_access_key: 'x' } },
      { provider: 's3', config: { bucket: 'new', secret_access_key: '  ' } },
    )).toEqual({ provider: 's3', config: { bucket: 'new', secret_access_key: 'x' } });
    expect(keepStoredRuntimeSecrets(
      { provider: 's3', config: { secret_access_key: 'x' } },
      { provider: 'minio', config: {} },
    )).toEqual({ provider: 'minio', config: {} });
  });
});

describe('Test connection and Send test email', () => {
  it('Test connection is the adapter\'s verify of the saved provider', async () => {
    const res = await call('POST', '/api/admin/providers/email/default/verify', {});
    expect(res.json).toEqual({ ok: true, detail: 'signed in to mail-relay:587; encryption: auto' });
    expect(sent).toEqual([]);
  });

  it('Send test email goes to the admin\'s own address only, through the saved provider, with the real result', async () => {
    const res = await call('POST', '/api/admin/providers/email/default/test-send', { to: 'someone-else@example.com' });
    expect(res.json).toEqual({ success: true, provider: 'smtp', id: '<m1@relay>', serverMessageId: '4ABCD', to: 'owner@webyar.ai' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'owner@webyar.ai', subject: 'Test email' });
    expect(sent[0].config.smtp_pass).toBe(RELAY_PASS);
    expect(sent[0].text).toContain('the platform email provider (smtp)');
  });

  it('a failure comes back as the email core reports it', async () => {
    adapterResult.value = { success: false, provider: 'smtp', errorCode: 'auth', permanent: true, error: 'auth: the SMTP server refused the sign-in (535)' };
    const res = await call('POST', '/api/admin/providers/email/default/test-send', {});
    expect(res.json).toEqual({ success: false, provider: 'smtp', errorCode: 'auth', error: 'auth: the SMTP server refused the sign-in (535)', to: 'owner@webyar.ai' });
  });

  it('an unset notification slot is not "tested" through the platform provider', async () => {
    const res = await call('POST', '/api/admin/providers/email/notification/test-send', {});
    expect(res.json).toMatchObject({ success: false, errorCode: 'unconfigured' });
    expect(sent).toEqual([]);
  });

  it('a set notification slot sends through its own provider', async () => {
    await call('PUT', '/api/admin/providers/email/notification', {
      provider_name: 'smtp', config: { smtp_host: 'notify-relay', from_email: 'notify@webyar.ai' },
    });
    const res = await call('POST', '/api/admin/providers/email/notification/test-send', {});
    expect(res.json.success).toBe(true);
    expect(sent[0].config.smtp_host).toBe('notify-relay');
  });

  it('the Reply-To saved on the provider is on the test mail', async () => {
    await call('PUT', '/api/admin/providers/email/default', { provider_name: 'smtp', config: { ...PRODUCTION.config, smtp_pass: '', reply_to: 'support@webyar.ai' } });
    await call('POST', '/api/admin/providers/email/default/test-send', {});
    expect(sent[0].replyTo).toBe('support@webyar.ai');
  });

  it('an admin without a valid address gets a clear refusal', async () => {
    db.tables.profiles = [{ id: ADMIN, email: 'not-an-address', full_name: 'Owner' }];
    const res = await call('POST', '/api/admin/providers/email/default/test-send', {});
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('no_admin_address');
  });

  it('five tests a minute, then 429', async () => {
    for (let i = 0; i < 5; i++) expect((await call('POST', '/api/admin/providers/email/default/test-send', {})).status).toBe(200);
    expect((await call('POST', '/api/admin/providers/email/default/test-send', {})).status).toBe(429);
    expect(sent).toHaveLength(5);
  });
});

describe('the Branding Reply-To that never applied', () => {
  it('is offered while the provider has none, and not once it has one', async () => {
    db.tables.email_settings = [{ workspace_id: null, reply_to_email: 'help@webyar.ai' }];
    expect((await call('GET', '/api/admin/providers/email')).json.legacyReplyTo).toBe('help@webyar.ai');
    await call('PUT', '/api/admin/providers/email/default', { provider_name: 'smtp', config: { ...PRODUCTION.config, smtp_pass: '', reply_to: 'support@webyar.ai' } });
    expect((await call('GET', '/api/admin/providers/email')).json.legacyReplyTo).toBeNull();
  });
});

describe('suppressions', () => {
  const row = (address: string, last: string): Row => ({
    address, reason: 'hard_bounce', detail: null, source: 'relay', bounce_count: 2,
    first_seen_at: '2026-10-29T10:00:00Z', last_seen_at: last, expires_at: null,
  });

  it('search, list newest first, remove (audited)', async () => {
    db.tables.email_suppressions = [row('a@x.com', '2026-10-29T11:00:00Z'), row('b@y.com', '2026-10-29T12:00:00Z')];
    const all = await call('GET', '/api/admin/providers/email/suppressions');
    expect(all.json.total).toBe(2);
    expect(all.json.rows.map((r: Row) => r.address)).toEqual(['b@y.com', 'a@x.com']);
    const found = await call('GET', '/api/admin/providers/email/suppressions?search=y.co');
    expect(found.json.rows.map((r: Row) => r.address)).toEqual(['b@y.com']);

    const removed = await call('DELETE', `/api/admin/providers/email/suppressions/${encodeURIComponent('B@y.com')}`);
    expect(removed.json).toEqual({ removed: true });
    expect(db.tables.email_suppressions.map((r) => r.address)).toEqual(['a@x.com']);
    expect(db.tables.audit_logs).toMatchObject([{ action: 'admin.email_suppression.removed', user_id: ADMIN, new_value: { address: 'b@y.com' } }]);

    expect((await call('DELETE', '/api/admin/providers/email/suppressions/b%40y.com')).json).toEqual({ removed: false });
    expect((await call('DELETE', '/api/admin/providers/email/suppressions/not-an-address')).status).toBe(400);
  });
});
