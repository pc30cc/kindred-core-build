// @vitest-environment node
/**
 * 289c — the operator notification emails, on a database built by the whole
 * chain, with the real email core and the real templates on the real data
 * layer (postgres-only):
 *
 *   - the migration: the new columns and indexes, one open digest per
 *     operator and workspace, the announcements table the backend's only;
 *     a second run changes nothing but gives a transcript job queued before
 *     it its conversation;
 *   - what a visitor typed (a conversation's subject, their name, the
 *     transcript) reaches the mail's HTML escaped and its subject and text
 *     as typed; every mail carries List-Unsubscribe with its one-click
 *     partner and a visible line under the template's own text;
 *   - the digest reads only what can be waiting: not spam, not what the AI
 *     holds, not what is closed;
 *   - the one-click POST turns the type off, and the next mail of it is
 *     not queued;
 *   - an announcement is written down by the request and fanned out by the
 *     ticker as platform mail, never in a workspace's email log;
 *   - a settled payment tells the admins (not the billing recipient, whose
 *     receipt says it);
 *   - an erasure takes the jobs about the erased conversations, and the
 *     retention purge the finished ones past their keep.
 *
 * Only the mail provider's call is stood in for (captured).
 * Driven by TEST_DATABASE_URL; skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { createFullChainDatabase, type FullChainDatabase } from './fullChainDatabase';
import { applyMigrationSql } from './pgMigrationChain';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

type Message = { to: string; subject: string; html: string; text: string; headers: Record<string, string> };
const provider = vi.hoisted(() => ({ sent: [] as Message[] }));
vi.mock('../../../server/services/email/providers/resend.js', () => ({
  resendAdapter: {
    name: 'resend',
    send: async (_cfg: unknown, message: Message) => {
      provider.sent.push({ to: message.to, subject: message.subject, html: message.html, text: message.text, headers: { ...message.headers } });
      return { success: true, provider: 'resend', id: `m-${provider.sent.length}` };
    },
  },
}));

const MIGRATION = resolve(process.cwd(), 'database/migrations/289c_notification_email_queue.sql');

suite('289c — the operator notification emails (real PostgreSQL, real email core)', () => {
  let chain: FullChainDatabase;
  let config: import('../../../server/config.js').ServerConfig;
  let producers: typeof import('../../../server/services/notificationEmail/producers.js');
  let dispatcher: typeof import('../../../server/services/notificationEmail/dispatcher.js');
  let queue: typeof import('../../../server/services/notificationEmail/queue.js');
  const owner = randomUUID();
  const admin = randomUUID();
  const agent = randomUUID();
  const ws = randomUUID();
  const contact = randomUUID();
  const q = async (sql: string, p: unknown[] = []) => (await chain.db.query(sql, p)).rows as Array<Record<string, unknown>>;
  const evil = '<a href=//evil.example>Verify your account</a>';

  const app = () => {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      Object.assign(req, { serverConfig: config, authUser: { id: owner } });
      next();
    });
    return a;
  };

  /** Every pending job due now, then one dispatch pass. */
  const dispatchNow = async () => {
    await q(`UPDATE public.notification_email_jobs SET scheduled_for = now() - interval '1 second' WHERE status = 'pending'`);
    return dispatcher.dispatchNotificationEmails(config);
  };

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `notif289c_${Date.now()}`);
    Object.assign(process.env, {
      DATABASE_URL: chain.url,
      PLATFORM_SIGNING_SECRET: 'signing-secret-for-this-test-only-0123456789',
      PLUGIN_SECRETS_MASTER_KEY: 'c'.repeat(64),
      SUPABASE_URL: 'https://legacy-project.supabase.co',
      SUPABASE_ANON_KEY: 'legacy-anon-key-value',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-key-value-at-least-32',
      CORS_ORIGINS: 'http://127.0.0.1',
      APP_BASE_URL: 'https://app.example.test',
    });
    delete process.env.DATABASE_MODE;
    for (const [id, name] of [[owner, 'Owner'], [admin, 'Admin'], [agent, '<img src=x onerror=alert(1)>']]) {
      await q(`INSERT INTO public.profiles (id, email, full_name, preferred_locale) VALUES ($1, $2, $3, 'en')`, [id, `${id.slice(0, 8)}@example.test`, name]);
    }
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme & Co', $2, $3)`, [ws, `ws-${ws.slice(0, 8)}`, owner]);
    await q(
      `INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'admin'), ($1, $4, 'agent')`,
      [ws, owner, admin, agent],
    );
    await q(`INSERT INTO public.contacts (id, workspace_id, name, email) VALUES ($1, $2, $3, 'mina@example.org')`, [contact, ws, '<b>Mina</b>']);
    await q(`UPDATE public.platform_settings SET region_mode = 'multi', active_locales = ARRAY['en', 'fa', 'tr'], default_locale = 'en'`);
    await q(`DELETE FROM public.platform_domains`);
    await q(`INSERT INTO public.platform_domains (api_base_url, app_base_url) VALUES ('https://api.example.test', 'https://app.example.test')`);
    await q(
      `INSERT INTO public.app_runtime_config (key, value) VALUES ('default_email_provider', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ provider_name: 'resend', config: { api_key: 're_test', from_email: 'no-reply@example.test', from_name: 'Sender' } })],
    );
    await q(`UPDATE public.notification_email_settings SET enabled = true, unread_messages_enabled = true, transcripts_enabled = true,
               paid_invoices_enabled = true, weekly_summary_enabled = true, product_updates_enabled = true`);
    const { loadConfig } = await import('../../../server/config.js');
    config = loadConfig();
    (await import('../../../server/services/platformRegion.js')).invalidatePlatformRegionCache();
    producers = await import('../../../server/services/notificationEmail/producers.js');
    dispatcher = await import('../../../server/services/notificationEmail/dispatcher.js');
    queue = await import('../../../server/services/notificationEmail/queue.js');
    (await import('../../../server/services/notificationEmail/settings.js')).invalidateNotificationEmailSettingsCache();
  }, 600_000);

  afterAll(async () => {
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer();
    await chain?.drop();
  });

  describe('the migration', () => {
    it('adds what a job is about, one open digest per operator, and an announcements table for the backend only', async () => {
      const cols = await q(`SELECT column_name, data_type FROM information_schema.columns
                             WHERE table_name = 'notification_email_jobs' AND column_name IN ('conversation_ids', 'covered_through') ORDER BY 1`);
      expect(cols).toEqual([{ column_name: 'conversation_ids', data_type: 'ARRAY' }, { column_name: 'covered_through', data_type: 'timestamp with time zone' }]);

      const [table] = await q(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.notification_email_announcements'::regclass`);
      expect(table.relrowsecurity).toBe(true);
      expect(await q(`SELECT policyname, roles::text[] AS roles FROM pg_policies WHERE tablename = 'notification_email_announcements'`))
        .toEqual([{ policyname: 'service_role_only', roles: ['service_role'] }]);
      for (const role of ['anon', 'authenticated']) {
        const [grants] = await q(`SELECT has_table_privilege($1, 'public.notification_email_announcements', 'SELECT') AS sel`, [role]);
        expect(grants, role).toEqual({ sel: false });
      }

      await q(`INSERT INTO public.notification_email_jobs (user_id, workspace_id, type, dedupe_key) VALUES ($1, $2, 'unread_messages', 'mig-a')`, [agent, ws]);
      await expect(q(`INSERT INTO public.notification_email_jobs (user_id, workspace_id, type, dedupe_key) VALUES ($1, $2, 'unread_messages', 'mig-b')`, [agent, ws]))
        .rejects.toThrow(/uq_notification_email_jobs_open_digest/);
      await q(`DELETE FROM public.notification_email_jobs WHERE dedupe_key = 'mig-a'`);
    });

    it('a second run changes nothing, and gives a transcript queued before it its conversation', async () => {
      const conversation = randomUUID();
      await q(`INSERT INTO public.notification_email_jobs (user_id, workspace_id, type, dedupe_key, status) VALUES ($1, $2, 'transcripts', $3, 'sent')`,
        [agent, ws, `transcript:${agent}:${conversation}`]);
      const before = await q(`SELECT indexname FROM pg_indexes WHERE tablename IN ('notification_email_jobs', 'notification_email_announcements') ORDER BY 1`);
      await applyMigrationSql(chain.db, readFileSync(MIGRATION, 'utf8'));
      expect(await q(`SELECT indexname FROM pg_indexes WHERE tablename IN ('notification_email_jobs', 'notification_email_announcements') ORDER BY 1`)).toEqual(before);
      expect(await q(`SELECT conversation_ids::text[] AS ids FROM public.notification_email_jobs WHERE dedupe_key = $1`, [`transcript:${agent}:${conversation}`]))
        .toEqual([{ ids: [conversation] }]);
      await q(`DELETE FROM public.notification_email_jobs`);
    });
  });

  describe('a digest and a transcript, as mailed', () => {
    const open = randomUUID();
    const spam = randomUUID();
    const aiHeld = randomUUID();
    const closed = randomUUID();

    beforeAll(async () => {
      for (const [id, status, spamFlag, metadata] of [
        [open, 'open', false, {}],
        [spam, 'open', true, {}],
        [aiHeld, 'open', false, { ai_state: 'ai_managed' }],
        [closed, 'closed', false, {}],
      ] as const) {
        await q(`INSERT INTO public.conversations (id, workspace_id, contact_id, status, is_spam, subject, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [id, ws, contact, status, spamFlag, id === open ? evil : 'other', JSON.stringify(metadata)]);
        await q(`INSERT INTO public.conversation_messages (conversation_id, sender_type, body, created_at) VALUES ($1, 'contact', $2, now() - interval '1 hour')`,
          [id, id === open ? `${evil} please` : 'x']);
      }
    });

    it('the digest lists only what can be waiting, and the visitor\'s subject is text in the HTML', async () => {
      provider.sent.length = 0;
      const swept = await producers.sweepUnreadDigest(config);
      expect(swept).toEqual({ workspaces: 1, queued: 3 });
      const jobs = await q(`SELECT user_id, conversation_ids::text[] AS ids, covered_through IS NOT NULL AS covered FROM public.notification_email_jobs WHERE type = 'unread_messages' ORDER BY user_id`);
      for (const job of jobs) expect(job).toMatchObject({ ids: [open], covered: true });

      await dispatchNow();
      expect(provider.sent).toHaveLength(3);
      const mail = provider.sent.find((m) => m.to.startsWith(agent.slice(0, 8)))!;
      expect(mail.html).toContain('&lt;a href=//evil.example&gt;Verify your account&lt;/a&gt;');
      expect(mail.html).not.toContain('<a href=//evil.example>');
      expect(mail.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(mail.html).not.toContain('<img src=x');
      expect(mail.html).toContain('Acme &amp; Co');
      // The text part as typed.
      expect(mail.text).toContain('Acme & Co');

      // The way out, in the headers and under the template's own text.
      expect(mail.headers['List-Unsubscribe']).toMatch(/^<https:\/\/api\.example\.test\/api\/notifications\/email\/unsubscribe\/[\w-]+\.[\w-]+>$/);
      expect(mail.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
      const link = mail.headers['List-Unsubscribe'].slice(1, -1);
      expect(mail.html).toContain(`href="${link}"`);
      expect(mail.html).toContain('“Conversations still waiting” is on in your email notifications');
      expect(mail.text).toContain(`Unsubscribe: ${link}`);
      expect(await q(`SELECT DISTINCT status, payload::text AS payload FROM public.notification_email_jobs WHERE type = 'unread_messages'`))
        .toEqual([{ status: 'sent', payload: '{}' }]);
    });

    it('not again for the same conversation', async () => {
      await q(`UPDATE public.notification_email_jobs SET sent_at = now() - interval '2 hours' WHERE type = 'unread_messages'`);
      expect(await producers.sweepUnreadDigest(config)).toEqual({ workspaces: 0, queued: 0 });
    });

    it('a transcript: the conversation\'s words and the contact\'s name are text in the HTML', async () => {
      provider.sent.length = 0;
      await q(`UPDATE public.conversations SET assigned_to = $2, status = 'resolved' WHERE id = $1`, [open, agent]);
      expect(await producers.queueTranscript(config, { conversationId: open, workspaceId: ws, actorId: agent })).toBe(1);
      await dispatchNow();
      expect(provider.sent).toHaveLength(1);
      const [mail] = provider.sent;
      expect(mail.subject).toBe(`Transcript — ${evil}`);
      expect(mail.html).toContain('<p>← &lt;a href=//evil.example&gt;Verify your account&lt;/a&gt; please</p>');
      expect(mail.html).toContain('&lt;b&gt;Mina&lt;/b&gt;');
      expect(mail.html).not.toContain('<b>Mina</b>');
      expect(mail.headers['List-Unsubscribe']).toContain('/api/notifications/email/unsubscribe/');
    });
  });

  describe('the one-click unsubscribe', () => {
    it('turns the type off for that person, and the next one is not queued', async () => {
      const { signUnsubscribeToken } = await import('../../../server/services/notificationEmail/unsubscribe.js');
      const { notificationEmailUnsubscribeRouter } = await import('../../../server/routes/notificationEmailUnsubscribe.js');
      const a = app();
      a.use('/api/notifications/email/unsubscribe', notificationEmailUnsubscribeRouter);

      const token = signUnsubscribeToken(agent, 'weekly_summary')!;
      expect((await request(a).get(`/api/notifications/email/unsubscribe/${token}`)).status).toBe(200);
      expect(await q(`SELECT weekly_summary FROM public.user_email_notification_prefs WHERE user_id = $1`, [agent])).toEqual([]);

      const res = await request(a).post(`/api/notifications/email/unsubscribe/${token}`).type('form').send('List-Unsubscribe=One-Click');
      expect(res.status).toBe(200);
      expect(await q(`SELECT weekly_summary, transcripts FROM public.user_email_notification_prefs WHERE user_id = $1`, [agent]))
        .toEqual([{ weekly_summary: false, transcripts: true }]);
      expect(await queue.enqueueNotificationEmail(config, {
        userId: agent, workspaceId: ws, type: 'weekly_summary', payload: {}, dedupeKey: 'after-unsubscribe',
      })).toEqual({ queued: false, reason: 'operator_opted_out' });
    });
  });

  describe('the announcement', () => {
    it('is written down by the request, fanned out by the ticker, and sent as platform mail', async () => {
      const { adminNotificationEmailRouter } = await import('../../../server/routes/adminNotificationEmail.js');
      const a = app();
      a.use('/api/admin/notification-email', adminNotificationEmailRouter);
      provider.sent.length = 0;
      await q(`DELETE FROM public.notification_email_jobs`);

      const res = await request(a).post('/api/admin/notification-email/announce').send({ title: 'New inbox', body: 'Line one\n<script>x</script>' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ queued: true, announcement: { status: 'sending', recipients_queued: 0 } });
      // The request queued nobody.
      expect(await q(`SELECT count(*)::int AS n FROM public.notification_email_jobs`)).toEqual([{ n: 0 }]);
      // The same again within the hour: one announcement.
      expect((await request(a).post('/api/admin/notification-email/announce').send({ title: 'New inbox', body: 'Line one\n<script>x</script>' })).body)
        .toMatchObject({ duplicate: true });

      expect(await producers.fanOutAnnouncements(config)).toEqual({ queued: 3 });
      expect(await q(`SELECT status, recipients_queued FROM public.notification_email_announcements`)).toEqual([{ status: 'done', recipients_queued: 3 }]);
      expect(await q(`SELECT DISTINCT workspace_id FROM public.notification_email_jobs WHERE type = 'product_updates'`)).toEqual([{ workspace_id: null }]);

      const logsBefore = (await q(`SELECT count(*)::int AS n FROM public.email_logs`))[0].n;
      await dispatchNow();
      expect(provider.sent).toHaveLength(3);
      expect(provider.sent[0].html).toContain('Line one<br>&lt;script&gt;x&lt;/script&gt;');
      expect(provider.sent[0].html).toContain('“Product announcements” is on in your email notifications');
      // Platform mail: in nobody's workspace log.
      expect((await q(`SELECT count(*)::int AS n FROM public.email_logs`))[0].n).toBe(logsBefore);

      const state = await request(a).get('/api/admin/notification-email');
      expect(state.body).toMatchObject({ provider_configured: false, notification_provider: { provider_name: null, configured: false } });
      expect(state.body.announcements[0]).toMatchObject({ title: 'New inbox', status: 'done' });
    });
  });

  describe('a settled payment', () => {
    it('tells the admins, not the billing recipient whose receipt says it', async () => {
      await q(`DELETE FROM public.notification_email_jobs`);
      const payment = randomUUID();
      const ledger = randomUUID();
      await q(`INSERT INTO public.billing_account_payments (id, workspace_id, provider, currency, amount_minor, net_minor, tax_minor, purpose, status)
               VALUES ($1, $2, 'test', 'USD', 3190, 2900, 290, 'topup', 'succeeded')`, [payment, ws]);
      await q(`INSERT INTO public.billing_account_ledger (id, workspace_id, kind, amount_minor, balance_after, currency, payment_id, receipt_number, net_minor, tax_minor, idempotency_key)
               VALUES ($1, $2, 'topup', 2900, 2900, 'USD', $3, 'R-9001', 2900, 290, $4)`, [ledger, ws, payment, `test-${ledger}`]);
      const { afterAccountSettlement } = await import('../../../server/services/billing/account/effects.js');
      await afterAccountSettlement(config, { payment_id: payment, ledger_id: ledger, receipt_number: 'R-9001', balance_minor: 2900 });
      await afterAccountSettlement(config, { payment_id: payment, ledger_id: ledger, receipt_number: 'R-9001', balance_minor: 2900 });

      const jobs = await q(`SELECT user_id, payload FROM public.notification_email_jobs WHERE type = 'paid_invoices'`);
      expect(jobs).toEqual([{ user_id: admin, payload: { workspace: 'Acme & Co', amount: '$31.90', invoice_label: ' (R-9001)', action_url: expect.stringContaining('/billing') } }]);
    });

    it('a billing mail shows the workspace\'s and the plan\'s names as text in its HTML', async () => {
      provider.sent.length = 0;
      const { sendBillingEmail } = await import('../../../server/services/billing/account/notify.js');
      expect(await sendBillingEmail(config, ws, 'billing_locked_data_deletion', () => ({
        plan_name: '<i>Pro</i>', locked_summary: '3 articles', deletion_date: 'soon', days_left: '7', export_url: 'https://app.example.test/export?a=1&b=2',
      }))).toEqual({ sent: true });
      const [mail] = provider.sent;
      expect(mail.html).toContain('Acme &amp; Co');
      expect(mail.html).toContain('&lt;i&gt;Pro&lt;/i&gt;');
      expect(mail.html).toContain('href="https://app.example.test/export?a=1&amp;b=2"');
      expect(mail.text).toContain('The locked data of Acme & Co (3 articles)');
    });
  });

  describe('privacy and retention', () => {
    it('an erasure takes the jobs about the erased conversations; the purge the finished ones past their keep', async () => {
      await q(`DELETE FROM public.notification_email_jobs`);
      const other = randomUUID();
      await q(`INSERT INTO public.conversations (id, workspace_id, status, subject) VALUES ($1, $2, 'open', 'kept')`, [other, ws]);
      const [about] = await q(`SELECT id FROM public.conversations WHERE contact_id = $1 LIMIT 1`, [contact]);
      await q(`INSERT INTO public.notification_email_jobs (user_id, workspace_id, type, dedupe_key, payload, conversation_ids, status)
               VALUES ($1, $2, 'transcripts', 'erase-a', '{"contact": "<b>Mina</b>"}', ARRAY[$3::uuid], 'pending'),
                      ($1, $2, 'transcripts', 'erase-b', '{"contact": "other"}', ARRAY[$4::uuid], 'sent')`,
        [agent, ws, about.id, other]);

      const { resolveSubject } = await import('../../../server/services/privacy/identity.js');
      const { runAnonymize } = await import('../../../server/services/privacy/anonymizer.js');
      const resolved = await resolveSubject(config, ws, 'contact', contact);
      const summary = await runAnonymize(config, {
        id: randomUUID(), workspace_id: ws, subject_type: 'contact', subject_id: contact, action: 'delete', resolved_identity: resolved,
      } as never);
      expect(summary.notification_emails_deleted).toBe(1);
      expect(await q(`SELECT dedupe_key FROM public.notification_email_jobs ORDER BY 1`)).toEqual([{ dedupe_key: 'erase-b' }]);

      await q(`UPDATE public.notification_email_jobs SET created_at = now() - interval '31 days'`);
      await dispatcher.purgeFinishedJobs(config);
      expect(await q(`SELECT count(*)::int AS n FROM public.notification_email_jobs`)).toEqual([{ n: 0 }]);
    });

    it('a job cut off mid-send is taken back on the real data layer', async () => {
      await q(`INSERT INTO public.notification_email_jobs (user_id, workspace_id, type, dedupe_key, status, claimed_at, attempts)
               VALUES ($1, $2, 'transcripts', 'stuck', 'sending', now() - interval '20 minutes', 1)`, [agent, ws]);
      expect(await dispatcher.reclaimStuckJobs(config)).toBe(1);
      expect(await q(`SELECT status, attempts, claimed_at FROM public.notification_email_jobs WHERE dedupe_key = 'stuck'`))
        .toEqual([{ status: 'pending', attempts: 2, claimed_at: null }]);
    });
  });
});
