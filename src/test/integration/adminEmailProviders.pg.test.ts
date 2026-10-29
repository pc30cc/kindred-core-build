// @vitest-environment node
/**
 * Super Admin → Providers → Email on the real data layer (postgres-only, a
 * database built by the whole chain, 289 included): the routes of
 * server/routes/adminEmailProviders.ts and the runtime-config routes of
 * server/routes/adminManagement.ts, over HTTP, as the page calls them.
 *
 *   - today's production row (relay password in plain text under "config")
 *     never comes back, from any of the three reads;
 *   - a save keeps the blank password, stores it encrypted (the database
 *     holds no plain text afterwards), and the change shows with who made it,
 *     read back from audit_logs and profiles;
 *   - a vendor with no adapter is refused and the row stays as it was;
 *   - Send test email goes to the admin's own address through the saved
 *     provider (only the provider's call is stood in for);
 *   - the generic PUT keeps a credential the form never received;
 *   - suppressions: list with search and total, remove, audited.
 *
 * Driven by TEST_DATABASE_URL; skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createFullChainDatabase, type FullChainDatabase } from './fullChainDatabase';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

const sent = vi.hoisted(() => [] as Array<{ to: string; host: unknown; pass: unknown }>);
vi.mock('../../../server/services/email/providers/smtp.js', () => ({
  smtpAdapter: {
    name: 'smtp',
    send: async (cfg: { config: Record<string, unknown> }, message: { to: string }) => {
      sent.push({ to: message.to, host: cfg.config.smtp_host, pass: cfg.config.smtp_pass });
      return { success: true, provider: 'smtp', id: '<m1@relay>', serverMessageId: '4ABCD' };
    },
    verify: async () => ({ ok: true, detail: 'signed in' }),
  },
}));

const RELAY_PASS = 'relay-secret-pg-1';
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed JSON and rows, asserted on their shape
type Json = any;

suite('Super Admin email providers on the real data layer', () => {
  let chain: FullChainDatabase;
  let server: http.Server;
  const admin = randomUUID();
  const q = async (sql: string, p: unknown[] = []) => (await chain.db.query(sql, p)).rows as Json[];

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

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, 'd_test_email_admin');
    Object.assign(process.env, {
      DATABASE_URL: chain.url,
      PLATFORM_SIGNING_SECRET: 'signing-secret-for-this-test-only-0123456789',
      PLUGIN_SECRETS_MASTER_KEY: 'e'.repeat(64),
      SUPABASE_URL: 'https://legacy-project.supabase.co',
      SUPABASE_ANON_KEY: 'legacy-anon-key-value',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-key-value-at-least-32',
      CORS_ORIGINS: 'http://127.0.0.1',
    });
    delete process.env.DATABASE_MODE;
    await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, 'owner@webyar.test', 'Owner')`, [admin]);
    await q(
      `INSERT INTO public.app_runtime_config (key, value) VALUES
         ('default_email_provider', $1::jsonb),
         ('default_ai_provider', $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [
        JSON.stringify({ provider_name: 'smtp', config: { smtp_host: 'mail-relay', smtp_port: '587', smtp_user: 'noreply@webyar.test', smtp_pass: RELAY_PASS, from_email: 'noreply@webyar.test', from_name: 'Webyar' } }),
        JSON.stringify({ provider_name: 'openai', config: { api_key: 'sk-pg-secret', model: 'm' } }),
      ],
    );
    const { loadConfig } = await import('../../../server/config.js');
    const config = loadConfig();
    vi.doMock('../../../server/lib/workspaceAuth.js', () => ({ requirePlatformAdmin: async () => admin }));
    const { adminEmailProvidersRouter } = await import('../../../server/routes/adminEmailProviders.js');
    const { adminManagementRouter } = await import('../../../server/routes/adminManagement.js');
    const app = express();
    app.use((req, _res, next) => {
      Object.assign(req, { serverConfig: config, adminUser: { id: admin } });
      next();
    });
    app.use(express.json());
    app.use('/api/admin/providers/email', adminEmailProvidersRouter);
    app.use('/api/admin/management', adminManagementRouter);
    server = http.createServer(app).listen(0);
  }, 600_000);

  afterAll(async () => {
    server?.close();
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer();
    await chain?.drop();
  });

  it('no read carries the relay password', async () => {
    const page = await call('GET', '/api/admin/providers/email');
    expect(page.status).toBe(200);
    expect(page.json.slots.default).toMatchObject({ provider_name: 'smtp', secretKeysSet: ['smtp_pass'], readiness: 'configured' });
    const one = await call('GET', '/api/admin/management/runtime-config/default_email_provider');
    const list = await call('GET', '/api/admin/management/runtime-config');
    for (const res of [page, one, list]) {
      expect(res.status).toBe(200);
      expect(res.raw).not.toContain(RELAY_PASS);
      expect(res.raw).not.toContain('sk-pg-secret');
    }
  });

  it('a save keeps the blank password, encrypted, and shows who changed it', async () => {
    const res = await call('PUT', '/api/admin/providers/email/default', {
      provider_name: 'smtp',
      config: { smtp_host: 'mail-relay', smtp_port: '587', smtp_user: 'noreply@webyar.test', smtp_pass: '', from_email: 'noreply@webyar.test', from_name: 'Webyar', encryption: 'auto' },
    });
    expect(res.status).toBe(200);
    const [row] = await q(`SELECT value::text AS v FROM public.app_runtime_config WHERE key = 'default_email_provider'`);
    expect(row.v).not.toContain(RELAY_PASS);
    expect(JSON.parse(row.v).secrets.smtp_pass.algorithm).toBeTruthy();
    expect(res.json.slots.default.lastChange).toMatchObject({ slot: 'default', actor: { id: admin, name: 'Owner', email: 'owner@webyar.test' } });
    const [audit] = await q(`SELECT user_id, new_value FROM public.audit_logs WHERE action = 'admin.email_provider.changed'`);
    expect(audit.user_id).toBe(admin);
    expect(JSON.stringify(audit.new_value)).not.toContain(RELAY_PASS);

    // and the stored password is what the provider receives
    const sendRes = await call('POST', '/api/admin/providers/email/default/test-send', { to: 'attacker@example.com' });
    expect(sendRes.json).toMatchObject({ success: true, to: 'owner@webyar.test' });
    expect(sent).toEqual([{ to: 'owner@webyar.test', host: 'mail-relay', pass: RELAY_PASS }]);
  });

  it('a vendor without an adapter is refused and changes nothing', async () => {
    const [before] = await q(`SELECT value::text AS v FROM public.app_runtime_config WHERE key = 'default_email_provider'`);
    const res = await call('PUT', '/api/admin/providers/email/default', { provider_name: 'postmark', config: { server_token: 't', from_email: 'a@b.co' } });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('unknown_provider');
    const [after] = await q(`SELECT value::text AS v FROM public.app_runtime_config WHERE key = 'default_email_provider'`);
    expect(after.v).toBe(before.v);
  });

  it('the generic PUT keeps a credential the form never received', async () => {
    const res = await call('PUT', '/api/admin/management/runtime-config/default_ai_provider', { value: { provider_name: 'openai', config: { model: 'n' } } });
    expect(res.status).toBe(200);
    const [row] = await q(`SELECT value FROM public.app_runtime_config WHERE key = 'default_ai_provider'`);
    expect(row.value).toEqual({ provider_name: 'openai', config: { model: 'n', api_key: 'sk-pg-secret' } });
  });

  it('suppressions: search, total, remove (audited)', async () => {
    const { suppressEmailAddress } = await import('../../../server/services/email/suppressions.js');
    const { loadConfig } = await import('../../../server/config.js');
    const config = loadConfig();
    await suppressEmailAddress(config, { address: 'gone@bounce.test', reason: 'hard_bounce', source: 'relay' });
    await suppressEmailAddress(config, { address: 'angry@complain.test', reason: 'complaint', source: 'relay' });

    const all = await call('GET', '/api/admin/providers/email/suppressions');
    expect(all.json.total).toBe(2);
    const found = await call('GET', '/api/admin/providers/email/suppressions?search=bounce');
    expect(found.json.rows.map((r: Record<string, unknown>) => r.address)).toEqual(['gone@bounce.test']);

    const removed = await call('DELETE', '/api/admin/providers/email/suppressions/gone%40bounce.test');
    expect(removed.json).toEqual({ removed: true });
    expect(await q(`SELECT address FROM public.email_suppressions`)).toEqual([{ address: 'angry@complain.test' }]);
    const audits = await q(`SELECT user_id, new_value FROM public.audit_logs WHERE action = 'admin.email_suppression.removed'`);
    expect(audits).toEqual([{ user_id: admin, new_value: { address: 'gone@bounce.test' } }]);
  });
});
