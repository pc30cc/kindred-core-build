// @vitest-environment node
/**
 * 289d — the mail limits' counters and the owners' offline-message mail, on
 * a database built by the whole chain, with the real email core, outbox and
 * quota module on the real data layer (postgres-only):
 *
 *   - public.email_send_quota and email_send_quota_take() are the backend's
 *     only (RLS on, a service_role policy, nothing for anon or
 *     authenticated, SECURITY INVOKER);
 *   - a take counts once per call, also when calls race: of 12 at once with
 *     a limit of 5, exactly 5 fit; a peek counts nothing; a window that ended
 *     starts again; sendQuota.ts uses these counters (not its memory);
 *   - the seeded offline_message_received subject names no visitor field and
 *     its seeded text part is cleared; a row the Super Admin rewrote is left
 *     as written; offline_messages_summary is seeded in both editions, in
 *     fa, en and tr; a second run of 289d changes nothing;
 *   - end to end: a capture's notice and its window's summary, through the
 *     outbox, reach the provider with no visitor text in a Subject, the
 *     visitor's words as text in the HTML and the text part, and the summary
 *     with no visitor text at all.
 *
 * Only the mail provider's call is stood in for. Driven by TEST_DATABASE_URL;
 * skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createFullChainDatabase, type FullChainDatabase } from './fullChainDatabase';
import { applyMigrationSql } from './pgMigrationChain';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

const provider = vi.hoisted(() => ({
  sent: [] as Array<{ to: string; subject: string; html: string; text: string }>,
}));
vi.mock('../../../server/services/email/providers/resend.js', () => ({
  resendAdapter: {
    name: 'resend',
    send: async (_cfg: unknown, message: { to: string; subject: string; html: string; text: string }) => {
      provider.sent.push({ to: message.to, subject: message.subject, html: message.html, text: message.text });
      return { success: true, provider: 'resend', id: `m-${provider.sent.length}` };
    },
  },
}));
vi.mock('../../../server/services/widget/availability.js', () => ({
  resolveAvailability: async () => ({ state: 'offline', reason: 'outside_hours', next_open_at: null }),
}));

const MIGRATION = resolve(process.cwd(), 'database/migrations/289d_email_send_quota.sql');

suite('289d — mail limits and the offline notice (real PostgreSQL)', () => {
  let chain: FullChainDatabase;
  let config: import('../../../server/config.js').ServerConfig;
  let quota: typeof import('../../../server/services/email/sendQuota.js');
  let outbox: typeof import('../../../server/services/email/outbox.js');
  let notice: typeof import('../../../server/services/widget/offlineNotice.js');
  const owner = randomUUID();
  const ws = randomUUID();
  const q = async (sql: string, p: unknown[] = []) => (await chain.db.query(sql, p)).rows as Array<Record<string, unknown>>;
  const take = async (scope: string, key: string, max: number, windowSeconds = 60, peek = false) =>
    (await q(`SELECT * FROM public.email_send_quota_take($1, $2, $3, $4, $5)`, [scope, key, windowSeconds, max, !peek]))[0];

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `email289d_${Date.now()}`);
    Object.assign(process.env, {
      DATABASE_URL: chain.url,
      PLATFORM_SIGNING_SECRET: 'signing-secret-for-this-test-only-0123456789',
      PLUGIN_SECRETS_MASTER_KEY: 'd'.repeat(64),
      SUPABASE_URL: 'https://legacy-project.supabase.co',
      SUPABASE_ANON_KEY: 'legacy-anon-key-value',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-key-value-at-least-32',
      CORS_ORIGINS: 'http://127.0.0.1',
      APP_BASE_URL: 'https://app.example.test',
    });
    delete process.env.DATABASE_MODE;
    await q(`INSERT INTO public.profiles (id, email, full_name, preferred_locale) VALUES ($1, $2, 'Owner', 'en')`, [owner, `owner-${owner.slice(0, 8)}@example.test`]);
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [ws, `ws-${ws.slice(0, 8)}`, owner]);
    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`, [ws, owner]);
    await q(`UPDATE public.platform_settings SET region_mode = 'multi', active_locales = ARRAY['en', 'fa', 'tr']`);
    await q(
      `INSERT INTO public.app_runtime_config (key, value) VALUES ('default_email_provider', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ provider_name: 'resend', config: { api_key: 're_test', from_email: 'no-reply@example.test', from_name: 'Sender' } })],
    );
    const { loadConfig } = await import('../../../server/config.js');
    config = loadConfig();
    (await import('../../../server/services/platformRegion.js')).invalidatePlatformRegionCache();
    quota = await import('../../../server/services/email/sendQuota.js');
    outbox = await import('../../../server/services/email/outbox.js');
    notice = await import('../../../server/services/widget/offlineNotice.js');
  }, 600_000);

  afterAll(async () => {
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer();
    await chain?.drop();
  });

  it('the table and the function are the backend\'s only', async () => {
    const [table] = await q(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.email_send_quota'::regclass`);
    expect(table.relrowsecurity).toBe(true);
    expect(await q(`SELECT policyname, roles::text[] AS roles FROM pg_policies WHERE tablename = 'email_send_quota'`))
      .toEqual([{ policyname: 'service_role_only', roles: ['service_role'] }]);
    const fn = 'public.email_send_quota_take(text, text, integer, integer, boolean)';
    for (const role of ['anon', 'authenticated']) {
      const [grants] = await q(
        `SELECT has_table_privilege($1, 'public.email_send_quota', 'SELECT') AS sel,
                has_function_privilege($1, '${fn}', 'EXECUTE') AS exec`,
        [role],
      );
      expect(grants, role).toEqual({ sel: false, exec: false });
    }
    const [svc] = await q(`SELECT has_function_privilege('service_role', '${fn}', 'EXECUTE') AS exec`);
    expect(svc.exec).toBe(true);
    const [definer] = await q(`SELECT prosecdef FROM pg_proc WHERE oid = '${fn}'::regprocedure`);
    expect(definer.prosecdef).toBe(false);
  });

  it('a take counts once per call; a peek counts nothing; a window that ended starts again', async () => {
    const key = randomUUID();
    expect(await take('t', key, 2)).toMatchObject({ allowed: true, used: 1 });
    expect(await take('t', key, 2, 60, true)).toMatchObject({ allowed: true, used: 1 });
    expect(await take('t', key, 2, 60, true)).toMatchObject({ allowed: true, used: 1 });
    expect(await take('t', key, 2)).toMatchObject({ allowed: true, used: 2 });
    expect(await take('t', key, 2)).toMatchObject({ allowed: false, used: 3 });
    expect(await take('t', key, 2, 60, true)).toMatchObject({ allowed: false, used: 3 });
    await q(`UPDATE public.email_send_quota SET window_started_at = now() - interval '2 minutes', window_ends_at = now() - interval '1 minute' WHERE quota_key = $1`, [key]);
    expect(await take('t', key, 2, 60, true)).toMatchObject({ allowed: true, used: 0 });
    expect(await take('t', key, 2)).toMatchObject({ allowed: true, used: 1 });
    await expect(q(`SELECT * FROM public.email_send_quota_take('', 'k', 60, 1)`)).rejects.toThrow(/invalid scope or key/);
  });

  it('of 12 takes at once with a limit of 5, exactly 5 fit', async () => {
    const key = randomUUID();
    const { default: pg } = await import('pg');
    const clients = await Promise.all(Array.from({ length: 12 }, async () => {
      const c = new pg.Client({ connectionString: chain.url });
      await c.connect();
      return c;
    }));
    try {
      const rows = await Promise.all(clients.map((c) => c.query(`SELECT allowed FROM public.email_send_quota_take('race', $1, 60, 5)`, [key])));
      expect(rows.filter((r) => r.rows[0].allowed === true)).toHaveLength(5);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  });

  it('sendQuota.ts counts in the table, not in its memory', async () => {
    const key = randomUUID();
    const first = await quota.takeEmailQuota(config, { scope: 'module', key, windowSeconds: 60, max: 1 });
    expect(first).toMatchObject({ allowed: true, used: 1 });
    expect(first.retryAfterSeconds).toBeGreaterThan(55);
    quota.__resetEmailQuotaMemoryForTests();
    expect(await quota.takeEmailQuota(config, { scope: 'module', key, windowSeconds: 60, max: 1 })).toMatchObject({ allowed: false, used: 2 });
    expect(await q(`SELECT hits FROM public.email_send_quota WHERE scope = 'module' AND quota_key = $1`, [key])).toEqual([{ hits: 2 }]);
  });

  it('the seeded offline notice names no visitor field in its subject and has no text part of its own', async () => {
    const rows = await q(`SELECT edition, locale, subject, text_body FROM public.email_templates
                           WHERE workspace_id IS NULL AND slug = 'offline_message_received' ORDER BY edition, locale`);
    expect(rows).toEqual([
      { edition: 'international', locale: 'en', subject: 'New offline message', text_body: null },
      { edition: 'international', locale: 'fa', subject: 'پیام آفلاین جدید', text_body: null },
      { edition: 'international', locale: 'tr', subject: 'Yeni çevrimdışı mesaj', text_body: null },
      { edition: 'iran', locale: 'en', subject: 'New offline message', text_body: null },
      { edition: 'iran', locale: 'fa', subject: 'پیام آفلاین جدید', text_body: null },
      { edition: 'iran', locale: 'tr', subject: 'Yeni çevrimdışı mesaj', text_body: null },
    ]);
    const summary = await q(`SELECT edition, locale, subject FROM public.email_templates
                              WHERE workspace_id IS NULL AND slug = 'offline_messages_summary' ORDER BY edition, locale`);
    expect(summary.map((r) => `${r.edition}/${r.locale}`)).toEqual(['international/en', 'international/fa', 'international/tr', 'iran/en', 'iran/fa', 'iran/tr']);
    for (const r of summary) expect(String(r.subject)).toMatch(/\{count\}$/);
  });

  it('a template the Super Admin rewrote is left as written, and a second run changes nothing', async () => {
    await q(`UPDATE public.email_templates SET subject = 'Message from {contact_name}!', text_body = 'From {contact_name}'
              WHERE workspace_id IS NULL AND slug = 'offline_message_received' AND edition = 'international' AND locale = 'tr'`);
    await q(`UPDATE public.email_templates SET subject = 'Own summary {count}'
              WHERE workspace_id IS NULL AND slug = 'offline_messages_summary' AND edition = 'iran' AND locale = 'en'`);
    const before = await q(`SELECT edition, slug, locale, subject, html_body, text_body FROM public.email_templates
                             WHERE workspace_id IS NULL AND slug IN ('offline_message_received', 'offline_messages_summary') ORDER BY 1, 2, 3`);
    await applyMigrationSql(chain.db, readFileSync(MIGRATION, 'utf8'));
    const after = await q(`SELECT edition, slug, locale, subject, html_body, text_body FROM public.email_templates
                            WHERE workspace_id IS NULL AND slug IN ('offline_message_received', 'offline_messages_summary') ORDER BY 1, 2, 3`);
    expect(after).toEqual(before);
    expect(await q(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'email_send_quota'`)).toEqual([{ n: 1 }]);
    expect(await q(`SELECT current_setting('lock_timeout') AS lt`)).toEqual([{ lt: '0' }]);
    // Put the international/tr row back for the end-to-end case below.
    await q(`UPDATE public.email_templates SET subject = 'Yeni çevrimdışı mesaj', text_body = NULL
              WHERE workspace_id IS NULL AND slug = 'offline_message_received' AND edition = 'international' AND locale = 'tr'`);
  });

  it('end to end: the notice and the window\'s summary reach the provider with no visitor text in a Subject', async () => {
    provider.sent.length = 0;
    const visitor = { name: 'Mallory <b>Admin</b> — verify your account', message: 'Click http://evil.example/login & win <script>x</script>' };
    const first = { conversationId: randomUUID(), messageId: randomUUID(), message: visitor.message, name: visitor.name, email: 'mallory@example.org', phone: null };
    expect(await notice.notifyOfflineCapture(config, ws, first)).toBe('immediate');
    // The same message again (a replayed request): the outbox's dedupe key makes it one mail.
    await q(`DELETE FROM public.email_send_quota WHERE quota_key = $1`, [ws]);
    expect(await notice.notifyOfflineCapture(config, ws, first)).toBe('immediate');
    await outbox.drainEmailOutbox(config);
    expect(provider.sent).toHaveLength(1);
    const mail = provider.sent[0];
    expect(mail.to).toBe(`owner-${owner.slice(0, 8)}@example.test`);
    expect(mail.subject).toBe('New offline message');
    expect(mail.subject).not.toMatch(/Mallory|verify/);
    expect(mail.html).toContain('Mallory &lt;b&gt;Admin&lt;/b&gt;');
    expect(mail.html).not.toContain('<script>');
    expect(mail.text).toContain(visitor.message);
    expect(mail.text).toContain(visitor.name);

    // A second capture in the window: a summary, queued for the window's end.
    const second = { conversationId: randomUUID(), messageId: randomUUID(), message: 'second <i>one</i>', name: 'Eve', email: null, phone: null };
    expect(await notice.notifyOfflineCapture(config, ws, second)).toBe('summary');
    expect(await outbox.drainEmailOutbox(config)).toBe(0);
    const [pending] = await q(`SELECT id, template_slug, category,
                                      round(extract(epoch FROM next_attempt_at - now()) / 60) AS in_minutes
                                 FROM public.email_outbox WHERE status = 'pending' AND workspace_id = $1`, [ws]);
    expect(pending).toMatchObject({ template_slug: 'offline_messages_summary', category: 'notification' });
    expect(Number(pending.in_minutes)).toBeGreaterThanOrEqual(14);
    await q(`UPDATE public.email_outbox SET next_attempt_at = now() WHERE id = $1`, [pending.id]);
    await outbox.drainEmailOutbox(config);
    const summary = provider.sent[1];
    expect(summary.subject).toBe('More offline messages: 1');
    expect(summary.html).toContain('https://app.example.test/');
    expect(`${summary.subject}\n${summary.html}\n${summary.text}`).not.toMatch(/Eve|second|Mallory|evil/);
  });
});
