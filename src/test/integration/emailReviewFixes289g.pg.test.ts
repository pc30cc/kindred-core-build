// @vitest-environment node
/**
 * 289g — three follow-ups of the email work, on a database built by the
 * whole chain, with the real email core, outbox, quota module and offline
 * notice on the real data layer (postgres-only):
 *
 *   - the migration: user_email_notification_prefs.offline_messages (on by
 *     default), email_outbox.supersede_rank, and email_send_quota_return(),
 *     the backend's only (SECURITY INVOKER, nothing for anon or
 *     authenticated); a second run changes nothing;
 *   - a quota's use given back: only in the window it was taken in, never
 *     below zero, and the next take fits again (sendQuota.ts);
 *   - ranked summaries: queued out of order, the highest rank is the one the
 *     outbox sends;
 *   - end to end: an owner who turned the offline-message mail off is not
 *     mailed; the other gets it with List-Unsubscribe, its one-click partner
 *     and the line under its text, and the one click turns it off.
 *
 * Only the mail provider's call is stood in for. Driven by TEST_DATABASE_URL;
 * skipped without it.
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

type Sent = { to: string; subject: string; html: string; text: string; headers: Record<string, string> };
const provider = vi.hoisted(() => ({ sent: [] as Sent[] }));
vi.mock('../../../server/services/email/providers/resend.js', () => ({
  resendAdapter: {
    name: 'resend',
    send: async (_cfg: unknown, message: Sent) => {
      provider.sent.push({ to: message.to, subject: message.subject, html: message.html, text: message.text, headers: { ...message.headers } });
      return { success: true, provider: 'resend', id: `m-${provider.sent.length}` };
    },
  },
}));
vi.mock('../../../server/services/widget/availability.js', () => ({
  resolveAvailability: async () => ({ state: 'offline', reason: 'outside_hours', next_open_at: null }),
}));

const MIGRATION = resolve(process.cwd(), 'database/migrations/289g_email_review_fixes.sql');

suite('289g — offline notice opt-out, ranked supersede, quota give-back (real PostgreSQL)', () => {
  let chain: FullChainDatabase;
  let config: import('../../../server/config.js').ServerConfig;
  let quota: typeof import('../../../server/services/email/sendQuota.js');
  let outbox: typeof import('../../../server/services/email/outbox.js');
  let notice: typeof import('../../../server/services/widget/offlineNotice.js');
  const owner = randomUUID();
  const admin = randomUUID();
  const ws = randomUUID();
  const q = async (sql: string, p: unknown[] = []) => (await chain.db.query(sql, p)).rows as Array<Record<string, unknown>>;

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `email289g_${Date.now()}`);
    Object.assign(process.env, {
      DATABASE_URL: chain.url,
      PLATFORM_SIGNING_SECRET: 'signing-secret-for-this-test-only-0123456789',
      PLUGIN_SECRETS_MASTER_KEY: 'f'.repeat(64),
      SUPABASE_URL: 'https://legacy-project.supabase.co',
      SUPABASE_ANON_KEY: 'legacy-anon-key-value',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-key-value-at-least-32',
      CORS_ORIGINS: 'http://127.0.0.1',
      APP_BASE_URL: 'https://app.example.test',
    });
    delete process.env.DATABASE_MODE;
    for (const [id, name] of [[owner, 'Owner'], [admin, 'Admin']]) {
      await q(`INSERT INTO public.profiles (id, email, full_name, preferred_locale) VALUES ($1, $2, $3, 'en')`, [id, `${id.slice(0, 8)}@example.test`, name]);
    }
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [ws, `ws-${ws.slice(0, 8)}`, owner]);
    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'admin') ON CONFLICT DO NOTHING`, [ws, owner, admin]);
    await q(`UPDATE public.platform_settings SET region_mode = 'multi', active_locales = ARRAY['en', 'fa', 'tr'], default_locale = 'en'`);
    await q(`DELETE FROM public.platform_domains`);
    await q(`INSERT INTO public.platform_domains (api_base_url, app_base_url) VALUES ('https://api.example.test', 'https://app.example.test')`);
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

  describe('the migration', () => {
    it('adds the switch on by default, the rank, and a function for the backend only', async () => {
      expect(await q(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
                        WHERE table_schema = 'public' AND ((table_name = 'user_email_notification_prefs' AND column_name = 'offline_messages')
                           OR (table_name = 'email_outbox' AND column_name = 'supersede_rank')) ORDER BY 1`)).toEqual([
        { column_name: 'offline_messages', data_type: 'boolean', is_nullable: 'NO', column_default: 'true' },
        { column_name: 'supersede_rank', data_type: 'integer', is_nullable: 'YES', column_default: null },
      ]);
      const fn = 'public.email_send_quota_return(text, text, timestamp with time zone)';
      for (const role of ['anon', 'authenticated']) {
        const [grants] = await q(`SELECT has_function_privilege($1, '${fn}', 'EXECUTE') AS exec`, [role]);
        expect(grants, role).toEqual({ exec: false });
      }
      const [svc] = await q(`SELECT has_function_privilege('service_role', '${fn}', 'EXECUTE') AS exec`);
      expect(svc.exec).toBe(true);
      const [definer] = await q(`SELECT prosecdef FROM pg_proc WHERE oid = '${fn}'::regprocedure`);
      expect(definer.prosecdef).toBe(false);
    });

    it('a second run changes nothing', async () => {
      await q(`INSERT INTO public.user_email_notification_prefs (user_id, offline_messages) VALUES ($1, false)
               ON CONFLICT (user_id) DO UPDATE SET offline_messages = false`, [admin]);
      await applyMigrationSql(chain.db, readFileSync(MIGRATION, 'utf8'));
      expect(await q(`SELECT offline_messages FROM public.user_email_notification_prefs WHERE user_id = $1`, [admin])).toEqual([{ offline_messages: false }]);
      expect(await q(`SELECT current_setting('lock_timeout') AS lt`)).toEqual([{ lt: '0' }]);
      await q(`DELETE FROM public.user_email_notification_prefs WHERE user_id = $1`, [admin]);
    });
  });

  describe('a quota\'s use given back', () => {
    it('only in its window, never below zero, and the next take fits again', async () => {
      const spec = { scope: 'g_test', key: randomUUID(), windowSeconds: 60, max: 2 };
      const first = await quota.takeEmailQuota(config, spec);
      const second = await quota.takeEmailQuota(config, spec);
      expect(second).toMatchObject({ allowed: true, used: 2 });
      expect((await quota.takeEmailQuota(config, spec)).allowed).toBe(false);

      await quota.returnEmailQuota(config, spec, second);
      await quota.returnEmailQuota(config, spec, second);
      expect((await quota.peekEmailQuota(config, spec)).used).toBe(1);
      expect((await quota.takeEmailQuota(config, spec)).allowed).toBe(true);

      // Another window's start gives nothing back.
      await quota.returnEmailQuota(config, spec, { ...first, windowStartedAt: new Date(first.windowStartedAt.getTime() - 60_000) });
      expect((await quota.peekEmailQuota(config, spec)).used).toBe(2);
      // Never below zero.
      for (let i = 0; i < 4; i += 1) await quota.returnEmailQuota(config, spec, first);
      expect(await q(`SELECT hits FROM public.email_send_quota WHERE quota_key = $1`, [spec.key])).toEqual([{ hits: 0 }]);
    });
  });

  describe('ranked summaries', () => {
    it('queued out of order, the highest rank is the one sent', async () => {
      provider.sent.length = 0;
      const key = `offline_summary:${ws}:${Date.now()}:test`;
      const mail = (n: number) => ({ workspaceId: ws, to: `${owner.slice(0, 8)}@example.test`, subject: `More: ${n}`, html: `<p>${n}</p>` });
      expect(await outbox.enqueueEmail(config, mail(2), { supersedeKey: key, supersedeRank: 2 })).toMatchObject({ queued: true });
      // The capture that took the window first reaches the queue last.
      expect(await outbox.enqueueEmail(config, mail(1), { supersedeKey: key, supersedeRank: 1 })).toMatchObject({ queued: true, superseded: true });
      expect(await outbox.enqueueEmail(config, mail(3), { supersedeKey: key, supersedeRank: 3 })).toMatchObject({ queued: true });
      expect(await q(`SELECT supersede_rank, status FROM public.email_outbox WHERE supersede_key = $1 ORDER BY supersede_rank`, [key])).toEqual([
        { supersede_rank: 1, status: 'cancelled' },
        { supersede_rank: 2, status: 'cancelled' },
        { supersede_rank: 3, status: 'pending' },
      ]);
      await outbox.drainEmailOutbox(config);
      expect(provider.sent.map((m) => m.subject)).toEqual(['More: 3']);
    });
  });

  describe('the offline-message mail', () => {
    it('is not sent to an owner who turned it off; the other gets the way out, and one click uses it', async () => {
      provider.sent.length = 0;
      await q(`DELETE FROM public.email_outbox`);
      await q(`INSERT INTO public.user_email_notification_prefs (user_id, offline_messages) VALUES ($1, false)`, [admin]);
      const capture = { conversationId: randomUUID(), messageId: randomUUID(), message: 'Hello', name: 'Visitor', email: null, phone: null };
      expect(await notice.notifyOfflineCapture(config, ws, capture)).toBe('immediate');
      await outbox.drainEmailOutbox(config);
      expect(provider.sent.map((m) => m.to)).toEqual([`${owner.slice(0, 8)}@example.test`]);
      const [mail] = provider.sent;
      const link = /^<(https:\/\/api\.example\.test\/api\/notifications\/email\/unsubscribe\/[^>]+)>$/.exec(mail.headers['List-Unsubscribe'] ?? '')?.[1];
      expect(link).toBeTruthy();
      expect(mail.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
      expect(mail.html).toContain('“Offline messages from visitors” is on in your email notifications');
      expect(mail.text).toContain(link!);

      const { notificationEmailUnsubscribeRouter } = await import('../../../server/routes/notificationEmailUnsubscribe.js');
      const a = express();
      a.use((req, _res, next) => { Object.assign(req, { serverConfig: config }); next(); });
      a.use('/api/notifications/email/unsubscribe', notificationEmailUnsubscribeRouter);
      const res = await request(a).post(new URL(link!).pathname).type('form').send('List-Unsubscribe=One-Click');
      expect(res.status).toBe(200);
      expect(await q(`SELECT offline_messages FROM public.user_email_notification_prefs WHERE user_id = $1`, [owner])).toEqual([{ offline_messages: false }]);

      // Now nobody wants it: nobody is mailed.
      await q(`DELETE FROM public.email_send_quota WHERE quota_key = $1`, [ws]);
      const next = { ...capture, conversationId: randomUUID(), messageId: randomUUID() };
      expect(await notice.notifyOfflineCapture(config, ws, next)).toBe('no_recipient');
    });
  });
});
