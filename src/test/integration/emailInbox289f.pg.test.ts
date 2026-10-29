// @vitest-environment node
/**
 * 289f — the Email Inbox's queued (Yahoo) replies, on a database built by the
 * whole chain, with Core's real compose and internal routes:
 *
 *   - email_messages.client_request_id is unique per workspace where set, and
 *     a second run of 289f changes nothing;
 *   - composeReply queues a reply once per client request id, sends it with
 *     the From name and by attachment id, accepts only files this workspace
 *     staged (or files of the same thread), and takes back what it wrote when
 *     the job cannot be queued: no 'queued' row is left that nothing sends;
 *   - /yahoo/outbound-result never turns a 'sent' reply into 'failed';
 *   - /yahoo/upsert-thread-message keeps a spam-folder message only when it
 *     answers one of the mailbox's threads;
 *   - /mail/outbound-attachment serves only a file of that very message.
 *
 * Driven by TEST_DATABASE_URL; skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createFullChainDatabase, type FullChainDatabase } from './fullChainDatabase';
import { applyMigrationSql } from './pgMigrationChain';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

const MIGRATION = resolve(process.cwd(), 'database/migrations/289f_email_inbox_request_ids.sql');
const SECRET = 'internal-secret-for-this-test-only';

suite('289f — Email Inbox replies queued once, with their files checked (real PostgreSQL)', () => {
  let chain: FullChainDatabase;
  let config: import('../../../server/config.js').ServerConfig;
  let inbox: typeof import('../../../server/services/email/inbox.js');
  let core: { url: string; close: () => Promise<void> };
  const owner = randomUUID();
  const ws = randomUUID();
  const other = randomUUID();
  let integration: string;
  const q = async (sql: string, p: unknown[] = []) => (await chain.db.query(sql, p)).rows as Array<Record<string, unknown>>;
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${core.url}/internal/channels${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}`, 'X-Core-Internal-Secret': SECRET },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    try { json = JSON.parse(text); } catch { /* bytes */ }
    return { status: res.status, json };
  };
  const reply = (extra: Partial<import('../../../server/services/email/inbox.js').ComposeReplyInput> = {}) => ({
    threadId: null,
    to: ['customer@example.test'],
    subject: 'Your order',
    textBody: 'It ships today.',
    htmlBody: '<p>It ships today.</p>',
    ...extra,
  });
  const stagedKey = (workspaceId: string) => `workspace/${workspaceId}/attachments/email/2026/10/${randomUUID()}-invoice.pdf`;

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `email289f_${Date.now()}`);
    Object.assign(process.env, {
      DATABASE_URL: chain.url,
      PLATFORM_SIGNING_SECRET: 'signing-secret-for-this-test-only-0123456789',
      PLUGIN_SECRETS_MASTER_KEY: 'f'.repeat(64),
      SUPABASE_URL: 'https://legacy-project.supabase.co',
      SUPABASE_ANON_KEY: 'legacy-anon-key-value',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-key-value-at-least-32',
      CORS_ORIGINS: 'http://127.0.0.1',
      CORE_INTERNAL_SECRET: SECRET,
    });
    delete process.env.DATABASE_MODE;
    await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, 'Owner')`, [owner, `o-${owner.slice(0, 8)}@test.local`]);
    for (const [id, name] of [[ws, 'Acme Shop'], [other, 'Other']]) {
      await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, $2, $3, $4)`, [id, name, `ws-${id.slice(0, 8)}`, owner]);
    }
    const installation = (await q(
      `INSERT INTO public.workspace_plugin_installations (workspace_id, plugin_id, status) VALUES ($1, 'yahoomail', 'installed') RETURNING id`, [ws],
    ))[0].id as string;
    integration = (await q(
      `INSERT INTO public.channel_integrations (workspace_id, installation_id, provider, public_integration_id, status, external_account_id, display_name)
       VALUES ($1, $2, 'yahoo', $3, 'connected', 'support@acme.test', 'support@acme.test') RETURNING id`,
      [ws, installation, `yh-${randomUUID().slice(0, 8)}`],
    ))[0].id as string;

    const { loadConfig } = await import('../../../server/config.js');
    config = loadConfig();
    inbox = await import('../../../server/services/email/inbox.js');
    const { internalChannelsRouter } = await import('../../../server/routes/internalChannels.js');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { serverConfig: unknown }).serverConfig = { ...config, coreInternalSecret: SECRET };
      next();
    });
    app.use('/internal/channels', internalChannelsRouter);
    core = await new Promise((done) => {
      const server = app.listen(0, () => {
        const { port } = server.address() as AddressInfo;
        done({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((ok) => server.close(() => ok())) });
      });
    });
  }, 600_000);

  afterAll(async () => {
    await core?.close();
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer();
    await chain?.drop();
  });

  it('adds the column and its index, and a second run changes nothing', async () => {
    const [col] = await q(`SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'email_messages' AND column_name = 'client_request_id'`);
    expect(col.data_type).toBe('text');
    const [idx] = await q(`SELECT indexdef FROM pg_indexes WHERE indexname = 'email_messages_client_request_uidx'`);
    expect(idx.indexdef).toMatch(/UNIQUE.*\(workspace_id, client_request_id\).*WHERE \(client_request_id IS NOT NULL\)/);
    await applyMigrationSql(chain.db, readFileSync(MIGRATION, 'utf8'));
    expect(await q(`SELECT 1 FROM pg_indexes WHERE indexname = 'email_messages_client_request_uidx'`)).toHaveLength(1);
    const [rls] = await q(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.email_messages'::regclass`);
    expect(rls.relrowsecurity).toBe(true);
  });

  it('queues a reply once per client request id, with its Message-ID, From name and files by id', async () => {
    const key = stagedKey(ws);
    const input = reply({
      clientRequestId: 'req-once-0001',
      attachments: [{ storageKey: key, filename: 'invoice.pdf', contentType: 'application/pdf', sizeBytes: 12 }],
    });
    const first = await inbox.composeReply(config, ws, owner, input, 'yahoo');
    const again = await inbox.composeReply(config, ws, owner, input, 'yahoo');
    expect(again.messageId).toBe(first.messageId);

    const messages = await q(`SELECT id, external_message_id, delivery_status, thread_id FROM public.email_messages WHERE client_request_id = 'req-once-0001'`);
    expect(messages).toHaveLength(1);
    expect(messages[0].delivery_status).toBe('queued');
    const jobs = await q(`SELECT payload FROM public.channel_jobs WHERE job_type = 'yahoo_outbound_message' AND payload->>'email_message_id' = $1`, [first.messageId]);
    expect(jobs).toHaveLength(1);
    const payload = jobs[0].payload as { message_id: string; from_name: string; attachments: unknown[] };
    expect(payload.message_id).toBe(messages[0].external_message_id);
    // A new thread's id is that same Message-ID: the customer's answer cites it.
    const [thread] = await q(`SELECT external_thread_id FROM public.email_threads WHERE id = $1`, [messages[0].thread_id]);
    expect(thread.external_thread_id).toBe(messages[0].external_message_id);
    // The connected address doubles as its display name, so the workspace's name is used.
    expect(payload.from_name).toBe('Acme Shop');
    const [att] = await q(`SELECT id FROM public.email_attachments WHERE message_id = $1`, [first.messageId]);
    expect(payload.attachments).toEqual([expect.objectContaining({ attachment_id: att.id, filename: 'invoice.pdf' })]);
  });

  it('refuses a file this workspace did not stage, and one from another thread', async () => {
    const foreign = reply({ attachments: [{ storageKey: stagedKey(other), filename: 'x.pdf', contentType: 'application/pdf', sizeBytes: 1 }] });
    await expect(inbox.composeReply(config, ws, owner, foreign, 'yahoo')).rejects.toMatchObject({ code: 'invalid_attachment' });
    const traversal = reply({ attachments: [{ storageKey: `workspace/${ws}/attachments/email/../../../${other}/a`, filename: 'a', contentType: 'text/plain', sizeBytes: 1 }] });
    await expect(inbox.composeReply(config, ws, owner, traversal, 'yahoo')).rejects.toMatchObject({ code: 'invalid_attachment' });

    // A file already sent in one thread may go out again in that thread only.
    const key = stagedKey(ws);
    const files = [{ storageKey: key, filename: 'a.pdf', contentType: 'application/pdf', sizeBytes: 1 }];
    const sent = await inbox.composeReply(config, ws, owner, reply({ attachments: files }), 'yahoo');
    const [row] = await q(`SELECT thread_id FROM public.email_messages WHERE id = $1`, [sent.messageId]);
    await expect(inbox.composeReply(config, ws, owner, reply({ attachments: files }), 'yahoo')).rejects.toMatchObject({ code: 'invalid_attachment' });
    await expect(inbox.composeReply(config, ws, owner, reply({ threadId: row.thread_id as string, attachments: files }), 'yahoo')).resolves.toBeTruthy();
    expect(await q(`SELECT 1 FROM public.email_messages WHERE workspace_id = $1 AND delivery_status = 'queued' AND id NOT IN (SELECT (payload->>'email_message_id')::uuid FROM public.channel_jobs WHERE job_type = 'yahoo_outbound_message')`, [ws])).toHaveLength(0);
  });

  it('takes back the thread and the row when the job cannot be queued, so a retry starts clean', async () => {
    await q(`ALTER TABLE public.channel_jobs ADD CONSTRAINT test_no_yahoo_send CHECK (job_type <> 'yahoo_outbound_message') NOT VALID`);
    try {
      await expect(inbox.composeReply(config, ws, owner, reply({ subject: 'Unqueued', clientRequestId: 'req-unqueued-01' }), 'yahoo'))
        .rejects.toMatchObject({ code: 'email_provider_error' });
    } finally {
      await q(`ALTER TABLE public.channel_jobs DROP CONSTRAINT test_no_yahoo_send`);
    }
    expect(await q(`SELECT 1 FROM public.email_messages WHERE client_request_id = 'req-unqueued-01'`)).toHaveLength(0);
    expect(await q(`SELECT 1 FROM public.email_threads WHERE workspace_id = $1 AND subject = 'Unqueued'`, [ws])).toHaveLength(0);
    const retried = await inbox.composeReply(config, ws, owner, reply({ subject: 'Unqueued', clientRequestId: 'req-unqueued-01' }), 'yahoo');
    expect(await q(`SELECT 1 FROM public.channel_jobs WHERE payload->>'email_message_id' = $1`, [retried.messageId])).toHaveLength(1);
  });

  it('a late failure report never overwrites a sent reply', async () => {
    const { messageId } = await inbox.composeReply(config, ws, owner, reply({ subject: 'Report order' }), 'yahoo');
    expect((await post('/yahoo/outbound-result', { email_message_id: messageId, integration_id: integration, outcome: 'sent' })).status).toBe(200);
    expect((await post('/yahoo/outbound-result', {
      email_message_id: messageId, integration_id: integration, outcome: 'failed', error_message: 'send_outcome_unknown: …',
    })).status).toBe(200);
    const [row] = await q(`SELECT delivery_status, delivery_error FROM public.email_messages WHERE id = $1`, [messageId]);
    expect(row).toEqual({ delivery_status: 'sent', delivery_error: null });

    // A reply that never went still fails visibly.
    const failed = await inbox.composeReply(config, ws, owner, reply({ subject: 'Will fail' }), 'yahoo');
    await post('/yahoo/outbound-result', { email_message_id: failed.messageId, integration_id: integration, outcome: 'failed', error_message: 'attachment_unreadable: a.pdf' });
    const [failedRow] = await q(`SELECT delivery_status, delivery_error FROM public.email_messages WHERE id = $1`, [failed.messageId]);
    expect(failedRow).toEqual({ delivery_status: 'failed', delivery_error: 'attachment_unreadable: a.pdf' });
  });

  it('keeps a spam-folder message only when it answers one of the mailbox\'s threads', async () => {
    const { messageId } = await inbox.composeReply(config, ws, owner, reply({ subject: 'Spam reply' }), 'yahoo');
    const [ours] = await q(`SELECT external_message_id, thread_id FROM public.email_messages WHERE id = $1`, [messageId]);
    const message = (id: string, extra: Record<string, unknown>) => ({
      external_message_id: id, from_address: 'customer@example.test', text_body: 'thanks', sent_at: new Date().toISOString(), ...extra,
    });

    const stray = await post('/yahoo/upsert-thread-message', {
      integration_id: integration, workspace_id: ws, subject: 'You won', reply_only: true,
      message: message('<spam-1@spam.test>', { in_reply_to: '<unknown@elsewhere.test>' }),
    });
    expect(stray.json).toMatchObject({ accepted: false, reason: 'not_a_reply', is_new_message: false });

    // A client that cites only the message it answers (no References) still lands in the thread.
    const answer = await post('/yahoo/upsert-thread-message', {
      integration_id: integration, workspace_id: ws, subject: 'Re: Spam reply', reply_only: true,
      message: message('<answer-1@example.test>', { in_reply_to: ours.external_message_id }),
    });
    expect(answer.json).toMatchObject({ thread_id: ours.thread_id, is_new_message: true });
    expect(await q(`SELECT 1 FROM public.email_messages WHERE external_message_id = '<spam-1@spam.test>'`)).toHaveLength(0);
  });

  it('the spam folder has a watermark of its own on the poll loop', async () => {
    expect((await post('/yahoo/poll-checkpoint', { integration_id: integration, last_spam_uid: 42 })).status).toBe(200);
    expect((await post('/yahoo/poll-checkpoint', { integration_id: integration })).status).toBe(400);
    const [row] = await q(`SELECT metadata FROM public.channel_integrations WHERE id = $1`, [integration]);
    expect((row.metadata as Record<string, unknown>).yahoo_last_spam_uid).toBe(42);
    await post('/yahoo/reschedule-poll', { integration_id: integration, workspace_id: ws, email_address: 'support@acme.test', since_uid: 7, spam_since_uid: 42 });
    const [job] = await q(`SELECT payload FROM public.channel_jobs WHERE job_type = 'yahoo_poll_inbox' AND integration_id = $1 AND status = 'pending'`, [integration]);
    expect(job.payload).toMatchObject({ since_uid: 7, spam_since_uid: 42 });
  });

  it('serves a queued reply\'s file only for that message, and says when it is gone', async () => {
    const key = stagedKey(ws);
    const { messageId } = await inbox.composeReply(config, ws, owner, reply({
      subject: 'With a file', attachments: [{ storageKey: key, filename: 'f.pdf', contentType: 'application/pdf', sizeBytes: 3 }],
    }), 'yahoo');
    const [att] = await q(`SELECT id FROM public.email_attachments WHERE message_id = $1`, [messageId]);
    const elsewhere = await inbox.composeReply(config, ws, owner, reply({ subject: 'Another' }), 'yahoo');
    expect((await post('/mail/outbound-attachment', { email_message_id: elsewhere.messageId, attachment_id: att.id })).status).toBe(410);
    // The key was never written to storage (this test stages nothing): gone, which no retry fixes.
    expect((await post('/mail/outbound-attachment', { email_message_id: messageId, attachment_id: att.id })).status).toBe(410);

    // Once stored (local storage, this database's default), its bytes come back.
    const file = join('/tmp/storage', key);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'PDF');
    try {
      const res = await fetch(`${core.url}/internal/channels/mail/outbound-attachment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}`, 'X-Core-Internal-Secret': SECRET },
        body: JSON.stringify({ email_message_id: messageId, attachment_id: att.id }),
      });
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('PDF');
    } finally {
      rmSync(file, { force: true });
    }
  });
});
