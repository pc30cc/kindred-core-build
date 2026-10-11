// @vitest-environment node
/**
 * Simple billing phase 4, part 6: the owner's export of locked data and the
 * hourly deletion of it (design §7, §8), against a database built by the
 * whole chain (migration 264 included), through the real data layer in
 * postgres-only mode and the real routes:
 *
 *   - switch off: nothing is observed, noticed or deleted; an episode left
 *     open is removed;
 *   - switch on: a locked agent's open chat goes back to the queue; the clock
 *     opens per kind; the 30-day notice (one mail for kinds due the same
 *     day), the 7-day notice only after it, an unsent mail taken back; no
 *     deletion before both and the deadline; then only the rows the 30-day
 *     notice named, storage objects first; the episode closes and a newer
 *     locked row starts a new one; a chat batch deletes its chats and their
 *     files;
 *   - the export: owner only, one at a time, the locked rows only, a
 *     single-use download, purged when it expires.
 *
 * Driven by TEST_DATABASE_URL; skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { createFullChainDatabase, type FullChainDatabase } from './fullChainDatabase';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

type Row = Record<string, unknown>;

interface EmailRequest { to: string; templateSlug?: string; templateData?: Record<string, string> }
const mail = vi.hoisted(() => ({
  sent: [] as Array<{ to: string; slug?: string; data: Record<string, string> }>,
  fail: false,
}));
vi.mock('../../../server/services/email/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/email/index.js')>();
  const send = async (_config: unknown, req: EmailRequest) => {
    if (mail.fail) return { success: false, error: 'smtp down' };
    mail.sent.push({ to: req.to, slug: req.templateSlug, data: req.templateData ?? {} });
    return { success: true, provider: 'test-capture', id: `m-${mail.sent.length}` };
  };
  return { ...actual, sendEmail: send, sendPlatformEmail: send };
});

suite('billing locks: locked-data export and retention deletion against the real chain', () => {
  let chain: FullChainDatabase;
  let config: never;
  let app: express.Express;
  let retention: typeof import('../../../server/services/billing/locks/retention.js');
  let exporter: typeof import('../../../server/services/billing/locks/exportWorker.js');
  let state: typeof import('../../../server/services/billing/locks/state.js');
  const q = async (sql: string, p: unknown[] = []) => (await chain.db.query(sql, p)).rows as Row[];
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0];

  const storageDir = mkdtempSync(join(tmpdir(), 'lock-retention-'));
  const tokens: Record<string, string> = {};
  let plan = '';
  let ws = '';
  let owner = '';
  let agent = '';
  let kbOld = '';
  let kbNew = '';
  let contactOld = '';
  let contactNew = '';
  let avatarKey = '';
  let heldChat = '';

  async function profile(name: string): Promise<string> {
    const id = randomUUID();
    await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, $3)`, [id, `${name}-${id.slice(0, 6)}@test.local`, name]);
    return id;
  }

  async function switchTo(on: boolean) {
    await q(`INSERT INTO public.billing_settings (edition, locks_enabled) VALUES ('international', $1)
             ON CONFLICT (edition) DO UPDATE SET locks_enabled = EXCLUDED.locks_enabled`, [on]);
    state.clearLockStateCache();
  }

  const clocks = () => q(`SELECT kind, episode_key, since, cutoff_at, locked_count, notice_30_at, notice_7_at, deleted_at
                            FROM public.billing_lock_clocks WHERE workspace_id = $1 ORDER BY kind, since`, [ws]);
  const open = async (kind: string) => (await clocks()).filter((c) => c.kind === kind && c.deleted_at === null);
  const shift = (kind: string, set: string) =>
    q(`UPDATE public.billing_lock_clocks SET ${set} WHERE workspace_id = $1 AND kind = $2 AND deleted_at IS NULL`, [ws, kind]);
  const file = (key: string) => join(storageDir, key);
  function put(key: string, body: string) {
    mkdirSync(dirname(file(key)), { recursive: true });
    writeFileSync(file(key), body);
  }
  const run = () => retention.runLockRetention(config, new Date(), 50);

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `billing_lock_retention_${Date.now()}`);
    Object.assign(process.env, {
      DATABASE_URL: chain.url,
      PLATFORM_SIGNING_SECRET: 'signing-secret-for-this-test-only-0123456789',
      SUPABASE_URL: 'https://legacy-project.supabase.co',
      SUPABASE_ANON_KEY: 'legacy-anon-key-value',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-key-value-at-least-32',
      APP_BASE_URL: 'http://127.0.0.1:5173',
    });
    delete process.env.DATABASE_MODE;
    await q(`UPDATE public.platform_settings SET region_mode = 'multi'`);
    // Every file of this suite lives in its own directory.
    await q(`INSERT INTO public.app_runtime_config (key, value) VALUES ('default_storage_provider', $1)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify({ provider: 'local', config: { local_path: storageDir, public_url: 'http://127.0.0.1:9/storage' } })]);

    // One article, one contact, one seat (the owner's); chats kept 30 days;
    // locked data deleted 60 days after it was first seen.
    plan = String((await one(
      `INSERT INTO public.billing_plans (name, slug, prices, limits, is_active, is_free, sort_order, locked_data_retention_days, localized)
       VALUES ('Small', 'small-ret', $1, $2, true, false, 10, 60, $3) RETURNING id`,
      [
        JSON.stringify({ USD: { monthly: 900, yearly: 9000 } }),
        JSON.stringify({ max_kb_articles: 1, max_contacts: 1, max_agents: 1, data_retention_days: 30 }),
        JSON.stringify({ en: { name: 'Small plan' } }),
      ])).id);

    owner = await profile('owner');
    await q(`UPDATE public.profiles SET preferred_locale = 'en' WHERE id = $1`, [owner]);
    agent = await profile('agent');
    ws = randomUUID();
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [ws, `acme-${ws.slice(0, 8)}`, owner]);
    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'owner', now() - interval '400 days')
             ON CONFLICT (workspace_id, user_id) DO NOTHING`, [ws, owner]);
    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'agent', now() - interval '30 days')`, [ws, agent]);
    await q(`INSERT INTO public.workspace_subscriptions (workspace_id, plan_id, status, billing_interval, provider_name, current_period_start, current_period_end)
             VALUES ($1, $2, 'active', 'monthly', 'account', now() - interval '10 days', now() + interval '20 days')
             ON CONFLICT (workspace_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, status = 'active',
               current_period_start = EXCLUDED.current_period_start, current_period_end = EXCLUDED.current_period_end`, [ws, plan]);

    kbOld = String((await one(`INSERT INTO public.knowledge_base_articles (workspace_id, slug, locale, title, content, status, created_at)
      VALUES ($1, 'kept', 'en', 'Kept article', 'kept body', 'published', now() - interval '100 days') RETURNING id`, [ws])).id);
    kbNew = String((await one(`INSERT INTO public.knowledge_base_articles (workspace_id, slug, locale, title, content, status, created_at)
      VALUES ($1, 'راهنما', 'fa', 'Locked article', 'locked body', 'published', now() - interval '90 days') RETURNING id`, [ws])).id);
    contactOld = String((await one(`INSERT INTO public.contacts (workspace_id, name, email, created_at)
      VALUES ($1, 'Kept Person', 'kept@acme.test', now() - interval '100 days') RETURNING id`, [ws])).id);
    avatarKey = `workspace/${ws}/avatars/contacts/${randomUUID()}.png`;
    contactNew = String((await one(`INSERT INTO public.contacts (workspace_id, name, email, phone, avatar_storage_key, created_at)
      VALUES ($1, 'Locked Person', 'locked@acme.test', '=1+2', $2, now() - interval '90 days') RETURNING id`, [ws, avatarKey])).id);
    put(avatarKey, 'png');
    // Spam is never counted, never locked, never deleted (D1).
    await q(`INSERT INTO public.contacts (workspace_id, name, email, is_spam, created_at) VALUES ($1, 'Spam', 'spam@x.test', true, now())`, [ws]);
    // The agent's open chat, recent (not past retention).
    heldChat = String((await one(`INSERT INTO public.conversations (workspace_id, status, assigned_to, created_at, updated_at)
      VALUES ($1, 'open', $2, now() - interval '1 day', now() - interval '1 day') RETURNING id`, [ws, agent])).id);
    // A chat past retention (45 days: locked, but after any batch cutoff, so on no deletion clock).
    const stale = String((await one(`INSERT INTO public.conversations (workspace_id, status, subject, created_at, updated_at)
      VALUES ($1, 'closed', 'Old question', now() - interval '45 days', now() - interval '45 days') RETURNING id`, [ws])).id);
    await q(`INSERT INTO public.conversation_messages (conversation_id, sender_type, body, created_at) VALUES ($1, 'agent', 'old answer', now() - interval '45 days')`, [stale]);
    await q(`UPDATE public.conversations SET updated_at = now() - interval '45 days' WHERE id = $1`, [stale]);
  }, 600_000);

  afterAll(async () => {
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer().catch(() => undefined);
    await chain?.drop();
    rmSync(storageDir, { recursive: true, force: true });
  });

  it('loads the server modules and routes on the chain', async () => {
    const { loadConfig } = await import('../../../server/config.js');
    config = loadConfig() as never;
    retention = await import('../../../server/services/billing/locks/retention.js');
    exporter = await import('../../../server/services/billing/locks/exportWorker.js');
    state = await import('../../../server/services/billing/locks/state.js');
    const { billingLockExportRouter } = await import('../../../server/routes/billingLockExport.js');
    const { createSession } = await import('../../../server/services/auth/sessions.js');
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as unknown as { serverConfig: unknown }).serverConfig = config; next(); });
    app.use('/api/billing/account', billingLockExportRouter);
    for (const id of [owner, agent]) tokens[id] = (await createSession(config, { userId: id, email: `${id}@test.local` })).token;
    expect(await state.readLocksEnabled(config)).toBe(false);
  });

  it('switch off: nothing is observed or sent, and an episode left open is removed', async () => {
    await q(`INSERT INTO public.billing_lock_clocks (workspace_id, kind, episode_key, since, notice_30_at)
             VALUES ($1, 'contact', 'stale', now() - interval '100 days', now() - interval '50 days')`, [ws]);
    const report = await run();
    expect(report.skipped).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.notices).toBe(0);
    expect(await clocks()).toEqual([]);
    expect(mail.sent).toEqual([]);
    expect(String((await one(`SELECT assigned_to FROM public.conversations WHERE id = $1`, [heldChat])).assigned_to)).toBe(agent);
  });

  it('switch on: the locked agent\'s chat goes back to the queue, and the clock opens per kind without a notice yet', async () => {
    await switchTo(true);
    const report = await run();
    expect(report.errors).toEqual([]);
    expect(report.workspaces).toBeGreaterThanOrEqual(1);
    expect(report.released).toBe(1);
    expect((await one(`SELECT assigned_to FROM public.conversations WHERE id = $1`, [heldChat])).assigned_to).toBeNull();
    expect((await open('kb_article')).map((c) => c.locked_count)).toEqual([1]);
    expect((await open('contact')).map((c) => c.locked_count)).toEqual([1]);
    expect(await open('conversation')).toEqual([]); // no chat is before a batch cutoff
    expect(report.notices).toBe(0); // since + 60 days is more than 30 days away
    expect(mail.sent).toEqual([]);
  });

  it('exports what is locked now: owner only, one at a time, a single-use download', async () => {
    const asOwner = { Authorization: `Bearer ${tokens[owner]}` };
    // Not the owner (here a member paused by the plan): refused.
    const other = await request(app).post(`/api/billing/account/${ws}/locked-export`).set({ Authorization: `Bearer ${tokens[agent]}` }).send({});
    expect(other.status).toBe(403);
    expect((await request(app).get(`/api/billing/account/${ws}/locked-export`).set(asOwner)).body).toEqual({ job: null });
    expect((await request(app).post(`/api/billing/account/${ws}/locked-export`).set(asOwner).send({ kinds: ['member'] })).status).toBe(400);

    const started = await request(app).post(`/api/billing/account/${ws}/locked-export`).set(asOwner).send({});
    expect(started.status).toBe(202);
    expect(started.body.job).toMatchObject({ status: 'pending', kinds: ['kb_article', 'contact', 'conversation'] });
    expect(started.body.job).not.toHaveProperty('artifact_storage_key');
    const busy = await request(app).post(`/api/billing/account/${ws}/locked-export`).set(asOwner).send({});
    expect(busy.status).toBe(409);
    expect(busy.body.job.id).toBe(started.body.job.id);

    expect(await exporter.runLockExportTick(config)).toBe(true);
    const done = await request(app).get(`/api/billing/account/${ws}/locked-export`).set(asOwner);
    expect(done.body.job).toMatchObject({ id: started.body.job.id, status: 'completed' });
    expect(done.body.job.counts).toMatchObject({ kb_article: 1, contact: 1, conversation: 1, messages: 1 });
    const row = await one(`SELECT artifact_storage_key, artifact_storage_provider FROM public.billing_lock_exports WHERE id = $1`, [started.body.job.id]);
    expect(row.artifact_storage_key).toBe(`workspace/${ws}/billing-exports/${started.body.job.id}.zip`);
    expect(existsSync(file(String(row.artifact_storage_key)))).toBe(true);
    // A system file: not counted against the workspace's storage.
    expect((await one(`SELECT count(*)::int AS n FROM public.storage_usage_logs WHERE workspace_id = $1`, [ws])).n).toBe(0);

    const tokenRes = await request(app).post(`/api/billing/account/${ws}/locked-export/${started.body.job.id}/download-token`).set(asOwner);
    expect(tokenRes.status).toBe(200);
    const token = String(tokenRes.body.token);
    const zip = await request(app).get(`/api/billing/account/locked-export/download?token=${encodeURIComponent(token)}`)
      .buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(zip.status).toBe(200);
    expect(zip.headers['content-type']).toContain('application/zip');
    const text = (zip.body as Buffer).toString('utf8');
    // Store-only ZIP: names and contents are readable as they are.
    for (const name of ['kb_articles.json', 'kb/fa/راهنما.md', 'contacts.csv', 'contacts.json', 'conversations.json', 'manifest.json', 'README.txt']) {
      expect(text).toContain(name);
    }
    expect(text).toContain('locked@acme.test');
    expect(text).toContain("'=1+2"); // a formula is defused in the CSV
    expect(text).toContain('Locked article');
    expect(text).toContain('old answer');
    expect(text).not.toContain('kept@acme.test');
    expect(text).not.toContain('Kept article');
    expect(text).not.toContain('spam@x.test');
    // Single use.
    expect((await request(app).get(`/api/billing/account/locked-export/download?token=${encodeURIComponent(token)}`)).status).toBe(403);

    // A new one may start once the last is done.
    expect((await request(app).post(`/api/billing/account/${ws}/locked-export`).set(asOwner).send({ kinds: ['contact'] })).status).toBe(202);
    expect(await exporter.runLockExportTick(config)).toBe(true);

    // Expired: the sweep deletes the files and keeps the rows.
    await q(`UPDATE public.billing_lock_exports SET expires_at = now() - interval '1 minute' WHERE workspace_id = $1`, [ws]);
    expect(await exporter.purgeExpiredLockExports(config)).toEqual({ purged: 2, skipped: 0 });
    expect(existsSync(file(String(row.artifact_storage_key)))).toBe(false);
    const after = await request(app).get(`/api/billing/account/${ws}/locked-export`).set(asOwner);
    expect(after.body.job.status).toBe('expired');
    expect((await request(app).post(`/api/billing/account/${ws}/locked-export/${started.body.job.id}/download-token`).set(asOwner)).status).toBe(409);
  });

  it('the 30-day notice: one mail for the kinds due that day, sent once', async () => {
    // First seen 40 days ago: deleted at since + 60 = in 20 days, so the 30-day notice is due.
    await shift('kb_article', `since = since - interval '40 days'`);
    await shift('contact', `since = since - interval '40 days'`);
    const report = await run();
    expect(report.errors).toEqual([]);
    expect(report.notices).toBe(1);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].slug).toBe('billing_locked_data_deletion');
    expect(mail.sent[0].to).toMatch(/^owner-/);
    expect(mail.sent[0].data).toMatchObject({
      plan_name: 'Small plan',
      days_left: '30',
      locked_summary: '1 article, 1 contact',
      export_url: expect.stringContaining('/billing'),
    });
    expect(mail.sent[0].data.deletion_date).toBeTruthy();
    for (const kind of ['kb_article', 'contact']) {
      const [c] = await open(kind);
      expect(c.notice_30_at).not.toBeNull();
      expect(c.notice_7_at).toBeNull();
    }
    expect((await run()).notices).toBe(0);
    expect(mail.sent).toHaveLength(1);
  });

  it('the 7-day notice comes only after the 30-day one, and a failed mail is taken back', async () => {
    // The deadline is now 30 days after the 30-day notice; 23 days later the 7-day notice is due.
    await shift('kb_article', `since = since - interval '30 days', notice_30_at = notice_30_at - interval '24 days'`);
    await shift('contact', `since = since - interval '30 days', notice_30_at = notice_30_at - interval '24 days'`);
    mail.fail = true;
    const failed = await run();
    mail.fail = false;
    expect(failed.notices).toBe(0);
    for (const kind of ['kb_article', 'contact']) expect((await open(kind))[0].notice_7_at).toBeNull();

    const report = await run();
    expect(report.notices).toBe(1);
    expect(mail.sent).toHaveLength(2);
    expect(mail.sent[1].data.days_left).toBe('7');
    for (const kind of ['kb_article', 'contact']) expect((await open(kind))[0].notice_7_at).not.toBeNull();
    // Still nothing deleted: the 7-day notice has 7 days to run.
    expect(report.deleted).toEqual({ kb_article: 0, contact: 0, conversation: 0 });
    expect((await one(`SELECT count(*)::int AS n FROM public.contacts WHERE workspace_id = $1`, [ws])).n).toBe(3);
  });

  it('deletes only the rows the 30-day notice named, files first; the episode closes and a newer locked row opens a new one', async () => {
    // A contact locked after the 30-day notice went out: never named, never deleted now.
    const late = String((await one(`INSERT INTO public.contacts (workspace_id, name, email, created_at) VALUES ($1, 'Late', 'late@acme.test', now()) RETURNING id`, [ws])).id);
    await shift('kb_article', `notice_30_at = notice_30_at - interval '10 days', notice_7_at = notice_7_at - interval '8 days'`);
    await shift('contact', `notice_30_at = notice_30_at - interval '10 days', notice_7_at = notice_7_at - interval '8 days'`);
    const report = await run();
    expect(report.errors).toEqual([]);
    expect(report.deleted).toMatchObject({ kb_article: 1, contact: 1 });
    expect((await q(`SELECT id FROM public.knowledge_base_articles WHERE workspace_id = $1`, [ws])).map((r) => r.id)).toEqual([kbOld]);
    const left = (await q(`SELECT id FROM public.contacts WHERE workspace_id = $1 AND NOT is_spam ORDER BY created_at`, [ws])).map((r) => r.id);
    expect(left).toEqual([contactOld, late]);
    expect(left).not.toContain(contactNew);
    expect(existsSync(file(avatarKey))).toBe(false);
    expect(await open('kb_article')).toEqual([]);

    // The contact episode closed; the late contact is on a new clock next hour.
    const contactClocks = (await clocks()).filter((c) => c.kind === 'contact');
    expect(contactClocks.filter((c) => c.deleted_at !== null)).toHaveLength(1);
    await run();
    const fresh = await open('contact');
    expect(fresh).toHaveLength(1);
    expect(fresh[0].notice_30_at).toBeNull();
  });

  it('a chat batch past its date deletes its chats and their files, never a newer one', async () => {
    const old = String((await one(`INSERT INTO public.conversations (workspace_id, status, subject, created_at, updated_at)
      VALUES ($1, 'closed', 'Very old', now() - interval '300 days', now() - interval '300 days') RETURNING id`, [ws])).id);
    const attachment = `workspace/${ws}/attachments/chat/2025/12/${randomUUID()}-a.txt`;
    put(attachment, 'hello');
    await q(`INSERT INTO public.conversation_attachments (workspace_id, conversation_id, storage_provider, storage_path, file_name, mime_type, size_bytes, uploaded_by_type, status)
             VALUES ($1, $2, 'local', $3, 'a.txt', 'text/plain', 5, 'visitor', 'attached')`, [ws, old, attachment]);
    // A batch whose date (the 1st of this month) has passed, both notices sent long ago.
    await q(`INSERT INTO public.billing_lock_clocks (workspace_id, kind, episode_key, since, cutoff_at, locked_count, notice_30_at, notice_7_at)
             SELECT $1, 'conversation', to_char(d AT TIME ZONE 'UTC', 'YYYY-MM-DD'), d - interval '30 days', d - interval '90 days', 1,
                    d - interval '40 days', d - interval '10 days'
               FROM (SELECT date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS d) x`, [ws]);
    const report = await run();
    expect(report.errors).toEqual([]);
    expect(report.deleted.conversation).toBe(1);
    expect(await one(`SELECT id FROM public.conversations WHERE id = $1`, [old])).toBeUndefined();
    expect(existsSync(file(attachment))).toBe(false);
    // The 45-day-old chat is locked but after the batch's cutoff: kept.
    expect((await one(`SELECT count(*)::int AS n FROM public.conversations WHERE workspace_id = $1 AND subject = 'Old question'`, [ws])).n).toBe(1);
    const batch = (await clocks()).filter((c) => c.kind === 'conversation' && c.deleted_at !== null);
    expect(batch).toHaveLength(1);
  });

  it('switch off again: the open episodes are removed, nothing more is sent', async () => {
    const before = mail.sent.length;
    await switchTo(false);
    const report = await run();
    expect(report.skipped).toBe(true);
    expect((await clocks()).filter((c) => c.deleted_at === null)).toEqual([]);
    expect(mail.sent).toHaveLength(before);
  });
});
