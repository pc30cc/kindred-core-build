// @vitest-environment node
/**
 * 289 — email suppressions, on a database built by the whole chain, and the
 * email core on the real data layer (postgres-only):
 *
 *   - public.email_suppressions and email_suppression_record() are the
 *     backend's only (RLS on, a service_role policy, nothing for anon or
 *     authenticated); a second run of 289 changes nothing;
 *   - a record counts every event, never weakens a row in force (a manual
 *     suppression stays manual, one without an end gets none), and an
 *     expired row starts over from the new event;
 *   - suppressions.ts: suppress, look up (case-insensitive, expired rows
 *     hold nothing), list with search and total, unsuppress;
 *   - sendEmail refuses a suppressed address before the provider and logs
 *     why, with our code, not a provider's text;
 *   - the config store reads today's plain-text row unchanged, and a write
 *     stores the secret encrypted, reads it back, and audits the change in
 *     audit_logs with field names only.
 *
 * Only the mail provider's call is stood in for (captured).
 * Driven by TEST_DATABASE_URL; skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createFullChainDatabase, type FullChainDatabase } from './fullChainDatabase';
import { applyMigrationSql } from './pgMigrationChain';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

const sent = vi.hoisted(() => [] as Array<{ to: string; subject: string }>);
vi.mock('../../../server/services/email/providers/resend.js', () => ({
  resendAdapter: {
    name: 'resend',
    send: async (_cfg: unknown, message: { to: string; subject: string }) => {
      sent.push({ to: message.to, subject: message.subject });
      return { success: true, provider: 'resend', id: `m-${sent.length}` };
    },
  },
}));

const MIGRATION = resolve(process.cwd(), 'database/migrations/289_email_suppressions.sql');

suite('289 — email suppressions and the provider config store (real PostgreSQL, real email core)', () => {
  let chain: FullChainDatabase;
  let config: import('../../../server/config.js').ServerConfig;
  let suppressions: typeof import('../../../server/services/email/suppressions.js');
  let store: typeof import('../../../server/services/email/providerConfigStore.js');
  let sendEmail: typeof import('../../../server/services/email/index.js').sendEmail;
  const admin = randomUUID();
  const ws = randomUUID();
  const q = async (sql: string, p: unknown[] = []) => (await chain.db.query(sql, p)).rows as Array<Record<string, unknown>>;

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `email289_${Date.now()}`);
    Object.assign(process.env, {
      DATABASE_URL: chain.url,
      PLATFORM_SIGNING_SECRET: 'signing-secret-for-this-test-only-0123456789',
      PLUGIN_SECRETS_MASTER_KEY: 'f'.repeat(64),
      SUPABASE_URL: 'https://legacy-project.supabase.co',
      SUPABASE_ANON_KEY: 'legacy-anon-key-value',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-key-value-at-least-32',
      CORS_ORIGINS: 'http://127.0.0.1',
    });
    delete process.env.DATABASE_MODE;
    await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, 'Super Admin')`, [admin, `sa-${admin.slice(0, 8)}@test.local`]);
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [ws, `ws-${ws.slice(0, 8)}`, admin]);
    await q(
      `INSERT INTO public.app_runtime_config (key, value) VALUES ('default_email_provider', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ provider_name: 'resend', config: { api_key: 're_test', from_email: 'no-reply@example.test', from_name: 'Sender' } })],
    );
    const { loadConfig } = await import('../../../server/config.js');
    config = loadConfig();
    suppressions = await import('../../../server/services/email/suppressions.js');
    store = await import('../../../server/services/email/providerConfigStore.js');
    ({ sendEmail } = await import('../../../server/services/email/index.js'));
  }, 600_000);

  afterAll(async () => {
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer();
    await chain?.drop();
  });

  it('the table and the function are the backend\'s only', async () => {
    const [table] = await q(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.email_suppressions'::regclass`);
    expect(table.relrowsecurity).toBe(true);
    expect(await q(`SELECT policyname, roles::text[] AS roles FROM pg_policies WHERE tablename = 'email_suppressions'`))
      .toEqual([{ policyname: 'service_role_only', roles: ['service_role'] }]);
    for (const role of ['anon', 'authenticated']) {
      const [grants] = await q(
        `SELECT has_table_privilege($1, 'public.email_suppressions', 'SELECT') AS sel,
                has_table_privilege($1, 'public.email_suppressions', 'INSERT') AS ins,
                has_function_privilege($1, 'public.email_suppression_record(text, text, text, text, timestamptz)', 'EXECUTE') AS exec`,
        [role],
      );
      expect(grants, role).toEqual({ sel: false, ins: false, exec: false });
    }
    const [svc] = await q(`SELECT has_function_privilege('service_role', 'public.email_suppression_record(text, text, text, text, timestamptz)', 'EXECUTE') AS exec`);
    expect(svc.exec).toBe(true);
    const [fn] = await q(`SELECT prosecdef FROM pg_proc WHERE oid = 'public.email_suppression_record(text, text, text, text, timestamptz)'::regprocedure`);
    expect(fn.prosecdef).toBe(false);
  });

  it('the checks keep only one plain, lower-case address per row', async () => {
    await expect(q(`INSERT INTO public.email_suppressions (address, reason, source) VALUES ('Upper@Example.com', 'manual', 't')`)).rejects.toThrow(/address_check/);
    await expect(q(`INSERT INTO public.email_suppressions (address, reason, source) VALUES ('a@b.co', 'spam', 't')`)).rejects.toThrow(/reason_check/);
  });

  it('a record counts every event and never weakens a row in force', async () => {
    const record = (address: string, reason: string, expires: string | null) =>
      q(`SELECT public.email_suppression_record($1, $2, 'd', 'test', $3::timestamptz) AS n`, [address, reason, expires]);
    expect((await record(' Manual@Example.com ', 'manual', null))[0].n).toBe(1);
    expect((await record('manual@example.com', 'hard_bounce', '2999-01-01'))[0].n).toBe(2);
    expect(await q(`SELECT reason, expires_at FROM public.email_suppressions WHERE address = 'manual@example.com'`))
      .toEqual([{ reason: 'manual', expires_at: null }]);

    await record('bounce@example.com', 'hard_bounce', '2999-01-01');
    await record('bounce@example.com', 'complaint', '3000-01-01');
    const [stronger] = await q(`SELECT reason, bounce_count, expires_at FROM public.email_suppressions WHERE address = 'bounce@example.com'`);
    expect(stronger).toMatchObject({ reason: 'complaint', bounce_count: 2 });
    expect(new Date(stronger.expires_at as string).getUTCFullYear()).toBe(3000);

    await q(`INSERT INTO public.email_suppressions (address, reason, source, expires_at, first_seen_at)
             VALUES ('old@example.com', 'manual', 't', now() - interval '1 day', now() - interval '30 days')`);
    await record('old@example.com', 'hard_bounce', '2999-01-01');
    const [restarted] = await q(`SELECT reason, bounce_count, expires_at, first_seen_at < now() - interval '29 days' AS kept_first
                                   FROM public.email_suppressions WHERE address = 'old@example.com'`);
    expect(restarted).toMatchObject({ reason: 'hard_bounce', bounce_count: 2, kept_first: true });
    expect(new Date(restarted.expires_at as string).getUTCFullYear()).toBe(2999);
  });

  it('a second run of 289 changes nothing', async () => {
    const before = await q(`SELECT * FROM public.email_suppressions ORDER BY address`);
    await applyMigrationSql(chain.db, readFileSync(MIGRATION, 'utf8'));
    expect(await q(`SELECT * FROM public.email_suppressions ORDER BY address`)).toEqual(before);
    expect(await q(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'email_suppressions'`)).toEqual([{ n: 1 }]);
  });

  it('suppressions.ts: suppress, look up, list, unsuppress', async () => {
    await suppressions.suppressEmailAddress(config, { address: 'Person@Example.org', reason: 'hard_bounce', detail: '550 5.1.1\r\nunknown user', source: 'relay' });
    await suppressions.suppressEmailAddress(config, { address: 'person@example.org', reason: 'hard_bounce', source: 'relay' });
    expect(await suppressions.isEmailSuppressed(config, 'PERSON@example.org')).toBe(true);
    expect(await suppressions.isEmailSuppressed(config, 'someone-else@example.org')).toBe(false);
    expect(await suppressions.isEmailSuppressed(config, 'old@example.com')).toBe(true);

    await suppressions.suppressEmailAddress(config, { address: 'gone@example.org', reason: 'manual', source: 'admin', expiresAt: new Date(Date.now() - 1000) });
    expect(await suppressions.isEmailSuppressed(config, 'gone@example.org')).toBe(false);

    const listed = await suppressions.listEmailSuppressions(config, { search: 'example.org', limit: 1 });
    expect(listed.total).toBe(2);
    expect(listed.rows).toHaveLength(1);
    const all = await suppressions.listEmailSuppressions(config, { search: 'person@' });
    expect(all.rows).toEqual([expect.objectContaining({ address: 'person@example.org', reason: 'hard_bounce', bounce_count: 2, detail: '550 5.1.1 unknown user', source: 'relay' })]);
    expect((await suppressions.listEmailSuppressions(config, { search: "%' OR 1=1 --" })).total).toBe(0);

    await expect(suppressions.suppressEmailAddress(config, { address: 'a@b.co, c@d.co', reason: 'manual', source: 'admin' })).rejects.toThrow(/invalid_address/);
    expect(await suppressions.unsuppressEmailAddress(config, 'gone@example.org')).toBe(true);
    expect(await suppressions.unsuppressEmailAddress(config, 'gone@example.org')).toBe(false);
  });

  it('sendEmail refuses a suppressed address before the provider, and logs why', async () => {
    sent.length = 0;
    const blocked = await sendEmail(config, { workspaceId: ws, to: 'person@example.org', subject: 'Hi', html: '<p>x</p>' });
    expect(blocked).toMatchObject({ success: false, errorCode: 'suppressed', permanent: true });
    expect(sent).toHaveLength(0);
    const delivered = await sendEmail(config, { workspaceId: ws, to: 'fine@example.org', subject: 'Code 555123', html: '<p>x</p>', templateData: { code: '555123' } });
    expect(delivered.success).toBe(true);
    expect(sent).toEqual([{ to: 'fine@example.org', subject: 'Code 555123' }]);
    const rows = await q(`SELECT recipient_email, status, error_message, subject FROM public.email_logs WHERE workspace_id = $1 ORDER BY created_at`, [ws]);
    expect(rows).toEqual([
      { recipient_email: 'person@example.org', status: 'failed', error_message: expect.stringMatching(/^suppressed: /), subject: 'Hi' },
      { recipient_email: 'fine@example.org', status: 'sent', error_message: null, subject: 'Code [REDACTED]' },
    ]);
  });

  it('the config store: today\'s plain row unchanged, then encrypted on write, audited by field name', async () => {
    const production = {
      provider_name: 'smtp',
      config: { smtp_host: 'mail-relay', smtp_port: '587', smtp_user: 'noreply@webyar.ai', smtp_pass: 'relay-pass-289', from_email: 'noreply@webyar.ai', from_name: 'Webyar' },
    };
    await q(`UPDATE public.app_runtime_config SET value = $1::jsonb WHERE key = 'default_email_provider'`, [JSON.stringify(production)]);
    expect(await store.readEmailProviderConfig(config, 'default_email_provider')).toEqual(production);

    const result = await store.writeEmailProviderConfig(config, 'default_email_provider', {
      provider_name: 'smtp', config: { ...production.config, smtp_pass: '', from_name: 'WebYar' },
    }, { userId: admin });
    expect(result).toEqual({ ok: true });
    const [row] = await q(`SELECT value::text AS raw, value FROM public.app_runtime_config WHERE key = 'default_email_provider'`);
    expect(row.raw).not.toContain('relay-pass-289');
    expect((row.value as { secrets: { smtp_pass: { algorithm: string } } }).secrets.smtp_pass.algorithm).toBe('aes-256-gcm');
    expect((await store.readEmailProviderConfig(config, 'default_email_provider'))?.config).toMatchObject({ smtp_pass: 'relay-pass-289', from_name: 'WebYar' });
    expect((await store.readEmailProviderForAdmin(config, 'default_email_provider')).secretKeysSet).toEqual(['smtp_pass']);

    const audit = await q(`SELECT user_id, workspace_id, action, entity_type, new_value FROM public.audit_logs WHERE action = 'admin.email_provider.changed'`);
    expect(audit).toEqual([{
      user_id: admin, workspace_id: null, action: 'admin.email_provider.changed', entity_type: 'app_runtime_config',
      new_value: { key: 'default_email_provider', provider_name: 'smtp', changed_fields: ['from_name'] },
    }]);
    expect(JSON.stringify(audit)).not.toContain('relay-pass-289');
  });
});
