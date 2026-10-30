// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- the database and Core test doubles are intentionally untyped. */
/**
 * A mailbox reply (Yahoo, and the legacy queued Gmail path) leaves the
 * Channels Worker at most once:
 *
 *   - it goes out with the Message-ID Core stored and the From name;
 *   - a 'sent' report Core does not take, a restart or an expired lease never
 *     sends it again: the job's own row says the provider accepted it, and
 *     only the report is retried;
 *   - a run that finds the mail handed over with no answer recorded does not
 *     send it again, and the reply fails visibly as `send_outcome_unknown`;
 *   - a send the provider definitely refused may be retried for real;
 *   - its files are read through Core, and one that cannot be read fails the
 *     job instead of the mail going out without it;
 *   - the report after the last retry goes to the mail route, keyed by the
 *     email_messages row (never the chat route, which refused it).
 */
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CORE_INTERNAL_SERVICE_NAME, INTERNAL_CHANNEL_ROUTES } from '../../../shared/channels/internalRoutes.js';

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({}),
  getAnonClient: () => ({}),
}));
vi.mock('../../../server/lib/pluginCrypto.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  decryptPluginSecret: () => 'refresh-token',
}));

const smtp = vi.hoisted(() => ({
  sends: [] as Array<Record<string, any>>,
  next: [] as Array<() => never | void>,
}));
vi.mock('../../../channels/mail/yahoo/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../channels/mail/yahoo/client.js')>();
  return {
    ...actual,
    createYahooAdapter: () => ({ refreshAccessToken: async () => ({ accessToken: 'access', refreshToken: null, expiresInSeconds: 3600 }) }),
    sendViaYahooSmtp: async (_token: string, msg: Record<string, any>) => {
      smtp.sends.push(msg);
      smtp.next.shift()?.();
      return { messageId: msg.messageId };
    },
  };
});

const { __channelsWorkerTesting, MAIL_SEND_ACCEPTED, MAIL_SEND_STARTED } = await import('../../../worker/channels/index.js');
const { YahooSmtpSendError } = await import('../../../channels/mail/yahoo/client.js');

const SECRET = 'internal-secret-value';
const EMAIL_MESSAGE_ID = '1b4e28ba-2d11-4ab3-9c5e-0f6a1e2b3c4d';
const ATTACHMENT_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const INTEGRATION_ID = '0d2c6f0e-8a4b-4c9d-9e1f-2a3b4c5d6e7f';

/** Core's side of the conversation: what it was told, and how it answers. */
const core = {
  calls: [] as Array<{ path: string; body: any }>,
  resultStatus: [] as number[],
  attachment: { status: 200, body: Buffer.from('PDF-BYTES') },
};

function startCore(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.get('/internal/channels/ready', (_req, res) => {
    res.json({ ok: true, service: CORE_INTERNAL_SERVICE_NAME, build: 'test', routes: INTERNAL_CHANNEL_ROUTES });
  });
  app.post('/internal/channels/mail/outbound-attachment', (req, res) => {
    core.calls.push({ path: req.path, body: req.body });
    res.status(core.attachment.status).send(core.attachment.body);
  });
  app.post(/^\/internal\/channels\/.+/, (req, res) => {
    core.calls.push({ path: req.path, body: req.body });
    const status = core.resultStatus.shift() ?? 200;
    res.status(status).json(status === 200 ? { ok: true } : { error: 'nope' });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}

type JobRow = Record<string, any>;

/** channel_jobs as the worker sees it: claims, fenced updates, and the credential reads. */
function fakeDb() {
  const jobs = new Map<string, JobRow>();
  let tokens = 0;
  const builder = (table: string) => {
    const state: { op: string; values?: any; filters: Array<[string, unknown]>; returning: boolean } = { op: 'select', filters: [], returning: false };
    const run = async (single: boolean) => {
      if (table === 'channel_integrations') return { data: { installation_id: 'inst', status: 'connected' }, error: null };
      if (table === 'plugin_secrets') return { data: { algorithm: 'aes', nonce: 'n', ciphertext: 'c', auth_tag: 't' }, error: null };
      if (table !== 'channel_jobs' || state.op !== 'update') return { data: single ? null : [], error: null };
      const matched = [...jobs.values()].filter((row) => state.filters.every(([col, value]) => row[col] === value));
      for (const row of matched) Object.assign(row, structuredClone(state.values));
      return { data: state.returning ? matched.map((row) => ({ id: row.id })) : null, error: null };
    };
    const b: any = {
      select() { if (state.op === 'select') return b; state.returning = true; return b; },
      update(values: any) { state.op = 'update'; state.values = values; return b; },
      insert() { state.op = 'insert'; return b; },
      upsert() { state.op = 'upsert'; return b; },
      eq(col: string, value: unknown) { state.filters.push([col, value]); return b; },
      maybeSingle: () => run(true),
      then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => run(false).then(resolve, reject),
    };
    return b;
  };
  return {
    jobs,
    add(row: JobRow) {
      jobs.set(row.id, { status: 'pending', attempt_count: 0, max_attempts: 8, claim_token: null, ...row });
    },
    /** The lease ran out and another worker claimed the job (a new token). */
    steal(id: string) {
      jobs.get(id)!.claim_token = `stolen-${++tokens}`;
    },
    client: {
      rpc: async (fn: string) => {
        if (fn !== 'claim_channel_jobs') return { data: [], error: null };
        const claimed = [...jobs.values()].filter((row) => row.status === 'pending' || (row.status === 'running' && row.claim_token === null));
        for (const row of claimed) Object.assign(row, { status: 'running', attempt_count: row.attempt_count + 1, claim_token: `token-${++tokens}` });
        return { data: claimed.map((row) => structuredClone(row)), error: null };
      },
      from: (table: string) => builder(table),
    },
  };
}

function yahooJob(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    provider: 'yahoo',
    job_type: 'yahoo_outbound_message',
    workspace_id: 'ws-1',
    integration_id: INTEGRATION_ID,
    payload: {
      email_message_id: EMAIL_MESSAGE_ID,
      message_id: '<abc123.1700000000000@acme.test>',
      from_email: 'support@acme.test',
      from_name: 'Acme Shop',
      to: ['customer@example.test'],
      subject: 'Your order',
      text_body: 'It ships today.',
      attachments: [],
      ...extra,
    },
  };
}

const mailReports = () => core.calls.filter((c) => c.path === '/internal/channels/yahoo/outbound-result').map((c) => c.body);

describe('mailbox replies leave the worker at most once', () => {
  let server: { url: string; close: () => Promise<void> };
  let db: ReturnType<typeof fakeDb>;

  beforeAll(async () => {
    Object.assign(process.env, {
      YAHOO_OAUTH_CLIENT_ID: 'client',
      YAHOO_OAUTH_CLIENT_SECRET: 'secret',
      YAHOO_OAUTH_REDIRECT_URI: 'https://app.test/cb',
    });
    server = await startCore();
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(() => {
    db = fakeDb();
    core.calls = [];
    core.resultStatus = [];
    core.attachment = { status: 200, body: Buffer.from('PDF-BYTES') };
    smtp.sends = [];
    smtp.next = [];
    __channelsWorkerTesting.configure({ sb: db.client, coreBaseUrl: server.url, coreSecret: SECRET });
  });

  it('sends with the Message-ID Core stored and the From name, and reports it sent', async () => {
    db.add(yahooJob('job-1'));
    await __channelsWorkerTesting.processBatch();
    expect(smtp.sends).toHaveLength(1);
    expect(smtp.sends[0]).toMatchObject({ messageId: '<abc123.1700000000000@acme.test>', fromName: 'Acme Shop', fromEmail: 'support@acme.test' });
    expect(mailReports()).toEqual([{ email_message_id: EMAIL_MESSAGE_ID, integration_id: INTEGRATION_ID, outcome: 'sent' }]);
    expect(db.jobs.get('job-1')).toMatchObject({ status: 'succeeded' });
    expect(db.jobs.get('job-1')!.payload[MAIL_SEND_ACCEPTED]).toBeTruthy();
  });

  it('a report Core does not take is retried without sending the mail again', async () => {
    db.add(yahooJob('job-2'));
    core.resultStatus = [500];
    await __channelsWorkerTesting.processBatch();
    expect(smtp.sends).toHaveLength(1);
    expect(db.jobs.get('job-2')).toMatchObject({ status: 'pending' });
    // No 'failed' report for a mail that went out.
    expect(mailReports().map((r) => r.outcome)).toEqual(['sent']);

    await __channelsWorkerTesting.processBatch();
    expect(smtp.sends).toHaveLength(1);
    expect(mailReports().map((r) => r.outcome)).toEqual(['sent', 'sent']);
    expect(db.jobs.get('job-2')).toMatchObject({ status: 'succeeded' });
  });

  it('a run that finds the mail handed over with no answer does not send it, and fails it visibly', async () => {
    // A worker restarted (or its lease ran out) between the hand-over and the report.
    db.add(yahooJob('job-3', { [MAIL_SEND_STARTED]: new Date().toISOString() }));
    await __channelsWorkerTesting.processBatch();
    expect(smtp.sends).toHaveLength(0);
    expect(db.jobs.get('job-3')).toMatchObject({ status: 'failed' });
    const [report] = mailReports();
    expect(report).toMatchObject({ email_message_id: EMAIL_MESSAGE_ID, outcome: 'failed' });
    expect(report.error_message).toMatch(/^send_outcome_unknown/);
    expect(core.calls.some((c) => c.path === '/internal/channels/outbound-result')).toBe(false);
  });

  it('a connection lost after the message was written is not retried', async () => {
    db.add(yahooJob('job-4'));
    smtp.next = [() => { throw new YahooSmtpSendError(true, 'Connection closed'); }];
    await __channelsWorkerTesting.processBatch();
    expect(smtp.sends).toHaveLength(1);
    expect(db.jobs.get('job-4')).toMatchObject({ status: 'failed' });
    expect(mailReports()[0].error_message).toMatch(/^send_outcome_unknown/);
  });

  it('a send Yahoo refused clears the mark, so the retry sends for real', async () => {
    db.add(yahooJob('job-5'));
    smtp.next = [() => { throw new YahooSmtpSendError(false, '421 try again later'); }];
    await __channelsWorkerTesting.processBatch();
    expect(db.jobs.get('job-5')).toMatchObject({ status: 'pending' });
    expect(db.jobs.get('job-5')!.payload[MAIL_SEND_STARTED]).toBeNull();
    expect(mailReports()).toEqual([]);

    await __channelsWorkerTesting.processBatch();
    expect(smtp.sends).toHaveLength(2);
    expect(mailReports().map((r) => r.outcome)).toEqual(['sent']);
  });

  it('does not send when it has lost the claim, and leaves the job to the run that holds it', async () => {
    db.add(yahooJob('job-6', { attachments: [{ attachment_id: ATTACHMENT_ID, filename: 'a.pdf', content_type: 'application/pdf' }] }));
    // The lease runs out while the file is read; another worker claims the job.
    core.attachment = { status: 200, body: Buffer.from('X') };
    const original = db.client.from;
    db.client.from = (table: string) => {
      if (table === 'channel_jobs') {
        db.steal('job-6');
        db.client.from = original;
      }
      return original(table);
    };
    await __channelsWorkerTesting.processBatch();
    expect(smtp.sends).toHaveLength(0);
    expect(db.jobs.get('job-6')).toMatchObject({ status: 'running' });
    expect(mailReports()).toEqual([]);
  });

  it('reads each file through Core and attaches its bytes', async () => {
    db.add(yahooJob('job-7', { attachments: [{ attachment_id: ATTACHMENT_ID, filename: 'invoice.pdf', content_type: 'application/pdf', url: null }] }));
    await __channelsWorkerTesting.processBatch();
    expect(core.calls.find((c) => c.path === '/internal/channels/mail/outbound-attachment')?.body).toEqual({
      email_message_id: EMAIL_MESSAGE_ID,
      attachment_id: ATTACHMENT_ID,
    });
    expect(smtp.sends[0].attachments).toEqual([{ filename: 'invoice.pdf', contentType: 'application/pdf', content: Buffer.from('PDF-BYTES') }]);
  });

  it('a file that cannot be read fails the job, never the mail without it', async () => {
    db.add(yahooJob('job-8', { attachments: [{ attachment_id: ATTACHMENT_ID, filename: 'invoice.pdf' }] }));
    core.attachment = { status: 502, body: Buffer.from('{"error":"attachment_unreadable"}') };
    await __channelsWorkerTesting.processBatch();
    expect(smtp.sends).toHaveLength(0);
    expect(db.jobs.get('job-8')).toMatchObject({ status: 'pending' });
    expect(db.jobs.get('job-8')!.payload[MAIL_SEND_STARTED]).toBeUndefined();

    // Out of retries: the reply's row says why.
    db.jobs.get('job-8')!.attempt_count = 7;
    await __channelsWorkerTesting.processBatch();
    expect(smtp.sends).toHaveLength(0);
    expect(db.jobs.get('job-8')).toMatchObject({ status: 'failed' });
    const [report] = mailReports();
    expect(report).toMatchObject({ email_message_id: EMAIL_MESSAGE_ID, integration_id: INTEGRATION_ID, outcome: 'failed' });
    expect(report.error_message).toMatch(/^attachment_unreadable/);
  });

  it('a file that is gone fails the reply at once', async () => {
    db.add(yahooJob('job-9', { attachments: [{ attachment_id: ATTACHMENT_ID, filename: 'invoice.pdf' }] }));
    core.attachment = { status: 410, body: Buffer.from('{"error":"attachment_missing"}') };
    await __channelsWorkerTesting.processBatch();
    expect(smtp.sends).toHaveLength(0);
    expect(db.jobs.get('job-9')).toMatchObject({ status: 'failed' });
    expect(mailReports()[0]).toMatchObject({ outcome: 'failed' });
  });

  it('a legacy job whose file has no address fails instead of sending without it', async () => {
    db.add(yahooJob('job-10', { attachments: [{ url: '/storage/workspace/x/a.pdf', filename: 'a.pdf' }] }));
    await __channelsWorkerTesting.processBatch();
    expect(smtp.sends).toHaveLength(0);
    expect(db.jobs.get('job-10')).toMatchObject({ status: 'failed' });
    expect(mailReports()[0].error_message).toMatch(/^attachment_unreadable/);
  });
});
