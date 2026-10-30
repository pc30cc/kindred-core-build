// @vitest-environment node
/**
 * 289b — the email outbox, on a database built by the whole chain, with the
 * real email core on the real data layer (postgres-only):
 *
 *   - public.email_outbox and email_outbox_claim() are the backend's only
 *     (RLS on, a service_role policy, nothing for anon or authenticated); a
 *     second run of 289b changes nothing; a final row can never keep its
 *     payload;
 *   - enqueueEmail stores the request sealed, the worker sends it through
 *     sendEmail (logged in email_logs) and empties the row; a dedupe key
 *     makes the same mail one mail;
 *   - sendEmailWithRetry: one attempt now, a queued retry only for a failure
 *     that can pass, on the schedule (1 minute, then 5), never past the
 *     deadline; a permanent failure is never retried; an expired row is
 *     never sent; a row whose lease ran out is claimed again; final rows
 *     older than 7 days are purged;
 *   - reset links: the earlier link is revoked only once the new one has
 *     reached the provider (inline or from the queue), an older queued mail
 *     is cancelled by the newer one, and a link nobody will receive is
 *     revoked at once;
 *   - billing: a queued receipt goes out once; the operator's receipt
 *     re-send plans from the billing records, re-sends once, and a re-run
 *     finds nothing left to send.
 *
 * Only the mail provider's call is stood in for (an outcome queue).
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

type Outcome = 'ok' | 'timeout' | 'rejected';
const provider = vi.hoisted(() => ({
  outcomes: [] as Outcome[],
  sent: [] as Array<{ to: string; subject: string; html: string; text: string }>,
}));
vi.mock('../../../server/services/email/providers/resend.js', () => ({
  resendAdapter: {
    name: 'resend',
    send: async (_cfg: unknown, message: { to: string; subject: string; html: string; text: string }) => {
      const outcome = provider.outcomes.shift() ?? 'ok';
      if (outcome === 'timeout') {
        return { success: false, provider: 'resend', errorCode: 'timeout', permanent: false, error: 'timeout: the provider did not answer within 15 s' };
      }
      if (outcome === 'rejected') {
        return { success: false, provider: 'resend', errorCode: 'rejected', permanent: true, error: 'rejected: the provider refused the message (HTTP 422)' };
      }
      provider.sent.push({ to: message.to, subject: message.subject, html: message.html, text: message.text });
      return { success: true, provider: 'resend', id: `m-${provider.sent.length}` };
    },
  },
}));

const MIGRATION = resolve(process.cwd(), 'database/migrations/289b_email_outbox.sql');

suite('289b — the email outbox (real PostgreSQL, real email core)', () => {
  let chain: FullChainDatabase;
  let config: import('../../../server/config.js').ServerConfig;
  let outbox: typeof import('../../../server/services/email/outbox.js');
  let authEmail: typeof import('../../../server/services/auth-email.js');
  let notify: typeof import('../../../server/services/billing/account/notify.js');
  let receipts: typeof import('../../../server/services/billing/account/receiptResend.js');
  const owner = randomUUID();
  const ws = randomUUID();
  const q = async (sql: string, p: unknown[] = []) => (await chain.db.query(sql, p)).rows as Array<Record<string, unknown>>;
  const due = (id: string) => q(`UPDATE public.email_outbox SET next_attempt_at = now() WHERE id = $1`, [id]);
  const row = async (id: string) => (await q(`SELECT * FROM public.email_outbox WHERE id = $1`, [id]))[0];
  const mail = (to: string, subject = 'Hello') => ({ workspaceId: ws, to, subject, html: `<p>${subject}</p>` });

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `email289b_${Date.now()}`);
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
    await q(`INSERT INTO public.profiles (id, email, full_name, preferred_locale) VALUES ($1, $2, 'Owner', 'en')`, [owner, `owner-${owner.slice(0, 8)}@example.test`]);
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [ws, `ws-${ws.slice(0, 8)}`, owner]);
    await q(`UPDATE public.platform_settings SET region_mode = 'multi', active_locales = ARRAY['en', 'fa', 'tr']`);
    await q(
      `INSERT INTO public.app_runtime_config (key, value) VALUES ('default_email_provider', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify({ provider_name: 'resend', config: { api_key: 're_test', from_email: 'no-reply@example.test', from_name: 'Sender' } })],
    );
    const { loadConfig } = await import('../../../server/config.js');
    config = loadConfig();
    (await import('../../../server/services/platformRegion.js')).invalidatePlatformRegionCache();
    outbox = await import('../../../server/services/email/outbox.js');
    authEmail = await import('../../../server/services/auth-email.js');
    notify = await import('../../../server/services/billing/account/notify.js');
    receipts = await import('../../../server/services/billing/account/receiptResend.js');
  }, 600_000);

  afterAll(async () => {
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer();
    await chain?.drop();
  });

  it('the table and the function are the backend\'s only', async () => {
    const [table] = await q(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.email_outbox'::regclass`);
    expect(table.relrowsecurity).toBe(true);
    expect(await q(`SELECT policyname, roles::text[] AS roles FROM pg_policies WHERE tablename = 'email_outbox'`))
      .toEqual([{ policyname: 'service_role_only', roles: ['service_role'] }]);
    const fn = 'public.email_outbox_claim(text, integer, integer)';
    for (const role of ['anon', 'authenticated']) {
      const [grants] = await q(
        `SELECT has_table_privilege($1, 'public.email_outbox', 'SELECT') AS sel,
                has_table_privilege($1, 'public.email_outbox', 'INSERT') AS ins,
                has_function_privilege($1, '${fn}', 'EXECUTE') AS exec`,
        [role],
      );
      expect(grants, role).toEqual({ sel: false, ins: false, exec: false });
    }
    const [svc] = await q(`SELECT has_function_privilege('service_role', '${fn}', 'EXECUTE') AS exec`);
    expect(svc.exec).toBe(true);
    const [definer] = await q(`SELECT prosecdef FROM pg_proc WHERE oid = '${fn}'::regprocedure`);
    expect(definer.prosecdef).toBe(false);
  });

  it('a final row can never keep its payload, nor a waiting one lose it', async () => {
    await expect(q(`INSERT INTO public.email_outbox (payload, status, finished_at) VALUES ('{"v":1}', 'sent', now())`))
      .rejects.toThrow(/email_outbox_payload_check/);
    await expect(q(`INSERT INTO public.email_outbox (payload, status) VALUES (NULL, 'pending')`))
      .rejects.toThrow(/email_outbox_pending_payload_check/);
    await expect(q(`INSERT INTO public.email_outbox (payload, status) VALUES ('{"v":1}', 'sent')`))
      .rejects.toThrow(/email_outbox_final_check/);
  });

  it('a second run of 289b changes nothing', async () => {
    const before = await q(`SELECT indexname FROM pg_indexes WHERE tablename = 'email_outbox' ORDER BY 1`);
    await applyMigrationSql(chain.db, readFileSync(MIGRATION, 'utf8'));
    expect(await q(`SELECT indexname FROM pg_indexes WHERE tablename = 'email_outbox' ORDER BY 1`)).toEqual(before);
    expect(await q(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'email_outbox'`)).toEqual([{ n: 1 }]);
  });

  it('enqueueEmail: stored sealed, sent through sendEmail and logged, then emptied', async () => {
    provider.sent.length = 0;
    const queued = await outbox.enqueueEmail(config, mail('first@example.org', 'Receipt R-SECRET-1'));
    expect(queued).toMatchObject({ queued: true, id: expect.any(String) });
    const [stored] = await q(`SELECT status, attempts, payload::text AS raw, payload ? 'sealed' AS sealed FROM public.email_outbox WHERE id = $1`, [queued.id]);
    expect(stored).toMatchObject({ status: 'pending', attempts: 0, sealed: true });
    expect(stored.raw).not.toContain('R-SECRET-1');
    expect(stored.raw).not.toContain('first@example.org');

    expect(await outbox.drainEmailOutbox(config)).toBe(1);
    expect(provider.sent).toEqual([expect.objectContaining({ to: 'first@example.org', subject: 'Receipt R-SECRET-1' })]);
    expect(await row(queued.id!)).toMatchObject({ status: 'sent', attempts: 1, payload: null, provider: 'resend', provider_message_id: 'm-1', claim_token: null });
    expect(await q(`SELECT status FROM public.email_logs WHERE workspace_id = $1 AND recipient_email = 'first@example.org'`, [ws]))
      .toEqual([{ status: 'sent' }]);
  });

  it('a dedupe key makes the same mail one mail', async () => {
    provider.sent.length = 0;
    const a = await outbox.enqueueEmail(config, mail('dedupe@example.org'), { dedupeKey: 'test:dedupe:1' });
    const b = await outbox.enqueueEmail(config, mail('dedupe@example.org'), { dedupeKey: 'test:dedupe:1' });
    expect(a).toMatchObject({ queued: true });
    expect(b).toEqual({ queued: true, duplicate: true, id: a.id });
    await outbox.drainEmailOutbox(config);
    expect(provider.sent).toHaveLength(1);
    expect(await outbox.enqueueEmail(config, mail('dedupe@example.org'), { dedupeKey: 'test:dedupe:1' }))
      .toEqual({ queued: true, duplicate: true, id: a.id });
  });

  it('refuses what cannot be mailed rather than queueing it', async () => {
    expect(await outbox.enqueueEmail(config, mail('a@example.org, b@example.org'))).toEqual({ queued: false, error: 'invalid_recipient' });
    expect(await outbox.enqueueEmail(config, { ...mail('x@example.org'), workspaceId: '' })).toEqual({ queued: false, error: 'invalid_request' });
    expect(await outbox.enqueueEmail(config, mail('x@example.org'), { expiresAt: new Date(Date.now() - 1000) })).toEqual({ queued: false, error: 'expired' });
  });

  it('sendEmailWithRetry: a failure that can pass is queued, retried on the schedule, then sent', async () => {
    provider.sent.length = 0;
    provider.outcomes.push('timeout');
    const first = await outbox.sendEmailWithRetry(config, mail('retry@example.org', 'Your link'));
    expect(first).toMatchObject({ success: false, errorCode: 'timeout', queuedRetry: true });
    const [queued] = await q(
      `SELECT id, status, attempts, last_error_code, last_error,
              round(extract(epoch FROM next_attempt_at - now()) / 60) AS in_minutes,
              round(extract(epoch FROM give_up_at - created_at) / 3600) AS window_hours
         FROM public.email_outbox WHERE status = 'pending' AND template_slug IS NULL ORDER BY created_at DESC LIMIT 1`,
    );
    expect(queued).toMatchObject({ status: 'pending', attempts: 1, last_error_code: 'timeout', in_minutes: '1', window_hours: '24' });
    expect(queued.last_error).toMatch(/^timeout: /);

    // Not due yet: nothing goes.
    expect(await outbox.drainEmailOutbox(config)).toBe(0);

    // Due, and failing again: the next wait is 5 minutes.
    provider.outcomes.push('timeout');
    await due(queued.id as string);
    await outbox.drainEmailOutbox(config);
    const [again] = await q(`SELECT status, attempts, round(extract(epoch FROM next_attempt_at - now()) / 60) AS in_minutes FROM public.email_outbox WHERE id = $1`, [queued.id]);
    expect(again).toEqual({ status: 'pending', attempts: 2, in_minutes: '5' });

    await due(queued.id as string);
    await outbox.drainEmailOutbox(config);
    expect(await row(queued.id as string)).toMatchObject({ status: 'sent', attempts: 3, payload: null });
    expect(provider.sent).toEqual([expect.objectContaining({ to: 'retry@example.org' })]);
    // Each attempt went through sendEmail, so each is in the log.
    expect(await q(`SELECT status FROM public.email_logs WHERE recipient_email = 'retry@example.org' ORDER BY created_at`))
      .toEqual([{ status: 'failed' }, { status: 'failed' }, { status: 'sent' }]);
  });

  it('a permanent failure is never retried, inline or from the queue', async () => {
    provider.outcomes.push('rejected');
    const inline = await outbox.sendEmailWithRetry(config, mail('refused@example.org'));
    expect(inline).toMatchObject({ success: false, errorCode: 'rejected', permanent: true });
    expect(inline.queuedRetry).toBeUndefined();
    expect(await q(`SELECT 1 FROM public.email_outbox WHERE template_slug IS NULL AND status = 'pending'`)).toEqual([]);

    provider.outcomes.push('rejected');
    const queued = await outbox.enqueueEmail(config, mail('refused2@example.org'));
    await outbox.drainEmailOutbox(config);
    expect(await row(queued.id!)).toMatchObject({ status: 'failed', attempts: 1, payload: null, last_error_code: 'rejected' });
  });

  it('gives up at the deadline, never sends an expired row, and reclaims a lapsed lease', async () => {
    provider.sent.length = 0;
    // The next wait would pass the deadline: failed, not rescheduled.
    provider.outcomes.push('timeout');
    const late = await outbox.enqueueEmail(config, mail('late@example.org'), { expiresAt: new Date(Date.now() + 30_000) });
    await outbox.drainEmailOutbox(config);
    expect(await row(late.id!)).toMatchObject({ status: 'failed', last_error_code: 'timeout', payload: null });

    const expired = await outbox.enqueueEmail(config, mail('expired@example.org'));
    await q(`UPDATE public.email_outbox SET give_up_at = now() - interval '1 second' WHERE id = $1`, [expired.id]);
    await outbox.drainEmailOutbox(config);
    expect(await row(expired.id!)).toMatchObject({ status: 'expired', payload: null });

    const lapsed = await outbox.enqueueEmail(config, mail('lapsed@example.org'));
    await q(
      `UPDATE public.email_outbox SET status = 'sending', claim_token = gen_random_uuid(), claimed_by = 'dead-worker',
              attempts = 1, lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [lapsed.id],
    );
    await outbox.drainEmailOutbox(config);
    expect(await row(lapsed.id!)).toMatchObject({ status: 'sent', attempts: 2 });
    expect(provider.sent.map((m) => m.to)).toEqual(['lapsed@example.org']);
  });

  it('purges final rows after 7 days, and only those', async () => {
    const old = await outbox.enqueueEmail(config, mail('old@example.org'));
    const recent = await outbox.enqueueEmail(config, mail('recent@example.org'));
    await outbox.drainEmailOutbox(config, { runMaintenance: false });
    await q(`UPDATE public.email_outbox SET finished_at = now() - interval '8 days' WHERE id = $1`, [old.id]);
    await q(`UPDATE public.email_outbox SET finished_at = now() - interval '6 days' WHERE id = $1`, [recent.id]);
    await outbox.drainEmailOutbox(config);
    expect(await row(old.id!)).toBeUndefined();
    expect(await row(recent.id!)).toMatchObject({ status: 'sent' });
  });

  describe('reset links', () => {
    const user = randomUUID();
    const email = `reset-${user.slice(0, 8)}@example.org`;
    const tokens = () => q(
      `SELECT id, revoked_at IS NOT NULL AS revoked FROM public.auth_reset_tokens WHERE user_id = $1 ORDER BY created_at`,
      [user],
    );

    beforeAll(async () => {
      await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, 'Reset User')`, [user, email]);
      await q(
        `INSERT INTO public.auth_reset_tokens (user_id, email, token_hash, expires_at, created_at)
         VALUES ($1, $2, 'old-link-hash', now() + interval '20 hours', now() - interval '1 hour')`,
        [user, email],
      );
    });

    it('a failed send keeps the earlier link working and queues the new one, sealed', async () => {
      provider.sent.length = 0;
      provider.outcomes.push('timeout');
      expect(await authEmail.issueRecoveryEmail(config, { userId: user, email })).toEqual({ success: true, queued: true });
      expect(await tokens()).toEqual([{ id: expect.any(String), revoked: false }, { id: expect.any(String), revoked: false }]);
      const [queued] = await q(
        `SELECT supersede_key, after_sent, payload::text AS raw,
                give_up_at <= (SELECT max(expires_at) FROM public.auth_reset_tokens WHERE user_id = $1) AS within_link
           FROM public.email_outbox WHERE template_slug = 'password_reset' AND status = 'pending'`,
        [user],
      );
      expect(queued).toMatchObject({ supersede_key: `password_reset:${user}`, within_link: true });
      expect(queued.after_sent).toMatchObject({ action: 'revoke_earlier_tokens', table: 'auth_reset_tokens', userId: user });
      expect(queued.raw).not.toContain('reset-password?token=');
    });

    it('a newer link that goes out cancels the queued one and revokes every earlier link', async () => {
      provider.sent.length = 0;
      expect(await authEmail.issueRecoveryEmail(config, { userId: user, email })).toEqual({ success: true });
      expect((await tokens()).map((t) => t.revoked)).toEqual([true, true, false]);
      expect(await q(`SELECT status, last_error_code, payload FROM public.email_outbox WHERE template_slug = 'password_reset'`))
        .toEqual([{ status: 'cancelled', last_error_code: 'superseded', payload: null }]);
      expect(provider.sent).toHaveLength(1);
      expect(provider.sent[0].text).toMatch(/reset-password\?token=/);
    });

    it('a link the queue delivers later revokes the earlier ones then', async () => {
      provider.outcomes.push('timeout');
      expect(await authEmail.issueRecoveryEmail(config, { userId: user, email })).toEqual({ success: true, queued: true });
      expect((await tokens()).map((t) => t.revoked)).toEqual([true, true, false, false]);
      const [pending] = await q(`SELECT id FROM public.email_outbox WHERE template_slug = 'password_reset' AND status = 'pending'`);
      await due(pending.id as string);
      await outbox.drainEmailOutbox(config);
      expect((await tokens()).map((t) => t.revoked)).toEqual([true, true, true, false]);
      expect(await row(pending.id as string)).toMatchObject({ status: 'sent', payload: null });
    });

    it('a link nobody will receive is revoked at once; the earlier one stays', async () => {
      provider.outcomes.push('rejected');
      const result = await authEmail.issueRecoveryEmail(config, { userId: user, email });
      expect(result).toMatchObject({ success: false, error: expect.stringMatching(/^rejected: /) });
      expect((await tokens()).map((t) => t.revoked)).toEqual([true, true, true, false, true]);
    });
  });

  describe('billing mail', () => {
    const payment = randomUUID();
    const ledger = randomUUID();

    beforeAll(async () => {
      await q(
        `INSERT INTO public.billing_account_payments (id, workspace_id, provider, currency, amount_minor, net_minor, tax_minor, purpose, status, purpose_result)
         VALUES ($1, $2, 'test', 'USD', 3190, 2900, 290, 'plan', 'succeeded', '{"balance_minor": 150}'::jsonb)`,
        [payment, ws],
      );
      await q(
        `INSERT INTO public.billing_account_ledger (id, workspace_id, kind, amount_minor, balance_after, currency, payment_id, receipt_number, net_minor, tax_minor, idempotency_key)
         VALUES ($1, $2, 'topup', 2900, 3050, 'USD', $3, 'R-7001', 2900, 290, $4)`,
        [ledger, ws, payment, `test-${ledger}`],
      );
    });

    it('a queued billing mail goes out once, whatever is queued twice', async () => {
      provider.sent.length = 0;
      const key = notify.billingMailKey('billing_trial_ended', ws, '2026-10-01T00:00:00Z');
      expect(notify.billingMailKey('billing_trial_ended', ws, undefined)).toBeUndefined();
      const first = await notify.sendBillingEmail(config, ws, 'billing_trial_ended', () => ({}), { queue: true, dedupeKey: key });
      const second = await notify.sendBillingEmail(config, ws, 'billing_trial_ended', () => ({}), { queue: true, dedupeKey: key });
      expect(first).toEqual({ sent: false, queued: true });
      expect(second).toEqual({ sent: false, queued: true });
      await outbox.drainEmailOutbox(config);
      expect(provider.sent.map((m) => m.to)).toEqual([`owner-${owner.slice(0, 8)}@example.test`]);
    });

    it('the receipt re-send plans from the billing records and re-sends once', async () => {
      await q(
        `INSERT INTO public.email_logs (workspace_id, template_slug, recipient_email, subject, status, error_message, metadata, created_at) VALUES
           ($1, 'billing_payment_receipt', 'old@example.org', 'Receipt', 'failed', 'auth: refused', '{"templateData": {"receipt_number": "R-7001"}}', '2026-10-10T10:00:00Z'),
           ($1, 'billing_payment_receipt', 'old@example.org', 'Receipt', 'failed', 'auth: refused', '{"templateData": {"receipt_number": "R-7001"}}', '2026-10-10T11:00:00Z'),
           ($1, 'billing_payment_receipt', 'old@example.org', 'Receipt', 'failed', 'auth: refused', '{"templateData": {"receipt_number": "R-404"}}', '2026-10-11T10:00:00Z'),
           ($1, 'billing_payment_receipt', 'old@example.org', 'Receipt', 'failed', 'auth: refused', '{"templateData": {}}', '2026-10-11T11:00:00Z'),
           ($1, 'billing_plan_activated', 'old@example.org', 'Plan', 'failed', 'auth: refused', '{}', '2026-10-12T10:00:00Z'),
           ($1, 'billing_payment_receipt', 'old@example.org', 'Receipt', 'failed', 'auth: refused', '{"templateData": {"receipt_number": "R-7001"}}', '2026-11-01T10:00:00Z')`,
        [ws],
      );
      const window = { since: new Date('2026-10-09T00:00:00Z'), until: new Date('2026-10-16T00:00:00Z') };
      const plan = await receipts.planReceiptResend(config, window);
      expect(plan.items.map((i) => [i.receiptNumber, i.skip])).toEqual([
        ['R-7001', null],
        ['R-7001', 'repeat'],
        ['R-404', 'receipt_not_found'],
        [null, 'no_receipt_number'],
      ]);
      expect(plan.items[0]).toMatchObject({ ledgerId: ledger, recipient: `owner-${owner.slice(0, 8)}@example.test` });
      expect(plan.otherFailures).toEqual({ billing_plan_activated: 1 });
      // The plan wrote nothing.
      expect(await q(`SELECT 1 FROM public.email_outbox WHERE template_slug = 'billing_payment_receipt'`)).toEqual([]);

      provider.sent.length = 0;
      expect(await receipts.applyReceiptResend(config, plan)).toEqual({ queued: 1, sentNow: 0, failed: [] });
      await outbox.drainEmailOutbox(config);
      expect(provider.sent).toHaveLength(1);
      expect(provider.sent[0].to).toBe(`owner-${owner.slice(0, 8)}@example.test`);
      // Rebuilt from the records: the amount paid and the balance the settlement left.
      expect(provider.sent[0].text).toContain('R-7001');
      expect(provider.sent[0].text).toContain('31.90');
      expect(provider.sent[0].text).toContain('1.50');

      const again = await receipts.planReceiptResend(config, window);
      expect(again.items[0].skip).toBe('already_sent');
      expect(await receipts.applyReceiptResend(config, again)).toEqual({ queued: 0, sentNow: 0, failed: [] });
    });
  });
});
