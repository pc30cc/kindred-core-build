// @vitest-environment node
/**
 * Bounce and complaint reports on the real data layer (postgres-only), from
 * the route to public.email_suppressions:
 *
 *   - the relay's report, signed with the smtp config's events_token as the
 *     Super Admin saved it (encrypted by the config store), suppresses a
 *     5.1.1 for good and a 5.2.2 for 30 days, leaves a 5.7.1 (a refusal of
 *     our sending) off the list, and the next send to a suppressed address
 *     is refused before the provider;
 *   - switching the default provider to Resend closes the relay's route and
 *     opens Resend's, whose Svix-signed complaint suppresses for good.
 *
 * Driven by TEST_DATABASE_URL; skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHmac, randomUUID } from 'node:crypto';
import { createFullChainDatabase, type FullChainDatabase } from './fullChainDatabase';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

const RELAY_TOKEN = 'relay-events-token-pg-test-0123456789';
const SVIX_SECRET = `whsec_${Buffer.from('resend-webhook-secret-pg-test').toString('base64')}`;

suite('email events → suppressions (real PostgreSQL)', () => {
  let chain: FullChainDatabase;
  let app: express.Express;
  let config: import('../../../server/config.js').ServerConfig;
  let signRelayReport: typeof import('../../../server/routes/emailEvents.js').signRelayReport;
  let store: typeof import('../../../server/services/email/providerConfigStore.js');
  let sendEmail: typeof import('../../../server/services/email/index.js').sendEmail;
  const admin = randomUUID();
  const ws = randomUUID();
  const q = async (sql: string, p: unknown[] = []) => (await chain.db.query(sql, p)).rows as Array<Record<string, unknown>>;

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `emailevents_${Date.now()}`);
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
    await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, 'Super Admin')`, [admin, `sa-${admin.slice(0, 8)}@test.local`]);
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [ws, `ws-${ws.slice(0, 8)}`, admin]);
    const { loadConfig } = await import('../../../server/config.js');
    config = loadConfig();
    store = await import('../../../server/services/email/providerConfigStore.js');
    ({ sendEmail } = await import('../../../server/services/email/index.js'));
    const events = await import('../../../server/routes/emailEvents.js');
    signRelayReport = events.signRelayReport;
    app = express();
    app.use((req, _res, next) => { Object.assign(req, { serverConfig: config }); next(); });
    app.use('/api/email-events', events.emailEventsRouter);
  }, 600_000);

  afterAll(async () => {
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer();
    await chain?.drop();
  });

  const relayPost = (payload: unknown) => {
    const body = JSON.stringify(payload);
    const ts = String(Math.floor(Date.now() / 1000));
    return request(app)
      .post('/api/email-events/relay')
      .set('content-type', 'application/json')
      .set('x-relay-timestamp', ts)
      .set('x-relay-signature', signRelayReport(RELAY_TOKEN, ts, body))
      .send(body);
  };

  it('the relay\'s report suppresses by class, and the next send is refused', async () => {
    const saved = await store.writeEmailProviderConfig(config, 'default_email_provider', {
      provider_name: 'smtp',
      config: { smtp_host: 'mail-relay', smtp_port: '587', from_email: 'noreply@example.test', events_token: RELAY_TOKEN },
    }, { userId: admin });
    expect(saved).toEqual({ ok: true });
    const [row] = await q(`SELECT value FROM public.app_runtime_config WHERE key = 'default_email_provider'`);
    expect(JSON.stringify(row.value)).not.toContain(RELAY_TOKEN);

    const res = await relayPost({
      events: [
        { type: 'bounce', recipient: 'Gone@Example.org', status: '5.1.1', detail: 'said: 550 5.1.1 unknown user' },
        { type: 'bounce', recipient: 'full@example.org', status: '5.2.2' },
        { type: 'bounce', recipient: 'policy@example.org', status: '5.7.1' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, recorded: 2 });

    const rows = await q(`SELECT address, reason, source, expires_at FROM public.email_suppressions
                           WHERE address IN ('gone@example.org', 'full@example.org', 'policy@example.org') ORDER BY address DESC`);
    expect(rows.map((r) => r.address)).toEqual(['gone@example.org', 'full@example.org']);
    expect(rows[0]).toMatchObject({ address: 'gone@example.org', reason: 'hard_bounce', source: 'relay', expires_at: null });
    const days = (new Date(rows[1].expires_at as string).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);

    const result = await sendEmail(config, { workspaceId: ws, to: 'gone@example.org', subject: 's', html: '<p>x</p>' });
    expect(result).toMatchObject({ success: false, errorCode: 'suppressed', permanent: true });
  });

  it('switching to Resend closes the relay\'s route and opens Resend\'s', async () => {
    const saved = await store.writeEmailProviderConfig(config, 'default_email_provider', {
      provider_name: 'resend',
      config: { api_key: 're_test', from_email: 'noreply@example.test', webhook_secret: SVIX_SECRET },
    }, { userId: admin });
    expect(saved).toEqual({ ok: true });
    expect((await relayPost({ events: [] })).status).toBe(404);

    const body = JSON.stringify({ type: 'email.complained', data: { to: ['annoyed@example.org'] } });
    const id = 'msg_pg_1';
    const ts = String(Math.floor(Date.now() / 1000));
    const key = Buffer.from(SVIX_SECRET.slice('whsec_'.length), 'base64');
    const res = await request(app)
      .post('/api/email-events/resend')
      .set('content-type', 'application/json')
      .set('svix-id', id)
      .set('svix-timestamp', ts)
      .set('svix-signature', `v1,${createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')}`)
      .send(body);
    expect(res.body).toEqual({ ok: true, recorded: 1 });
    expect(await q(`SELECT reason, source, expires_at FROM public.email_suppressions WHERE address = 'annoyed@example.org'`))
      .toEqual([{ reason: 'complaint', source: 'resend_webhook', expires_at: null }]);
  });
});
