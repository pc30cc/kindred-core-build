// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- the database, Core and provider test doubles are intentionally untyped. */
/**
 * A chat reply (Telegram, Bale, WhatsApp, Instagram, X) reaches the customer
 * once, whatever happens to the report to Core afterwards:
 *
 *   - a 'sent' report Core does not take (a deploy's 503 counts as a
 *     deployment problem, a 500 as a plain failure) is retried on its own;
 *     the message is not sent again;
 *   - a message Core no longer has (its conversation was deleted) ends the
 *     job: it is not requeued for free every 30 s, resending each time;
 *   - a media reply whose second file failed resumes at that file;
 *   - a provider operation that no longer exists fails, it is not requeued;
 *   - a deployment problem hands the rest of the claimed batch back at once.
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
  decryptPluginSecret: () => 'bot-token',
}));

const provider = vi.hoisted(() => ({
  texts: [] as Array<Record<string, any>>,
  media: [] as Array<Record<string, any>>,
  mediaFailures: [] as Array<boolean>,
  nextId: 100,
}));
vi.mock('../../../worker/channels/botApi.js', () => ({
  botApiFor: () => ({
    sendChatAction: async () => undefined,
    sendMessage: async (_token: unknown, input: Record<string, any>) => {
      provider.texts.push(input);
      return { message_id: ++provider.nextId };
    },
    sendMedia: async (_token: unknown, input: Record<string, any>) => {
      if (provider.mediaFailures.shift()) throw new Error('provider hiccup');
      provider.media.push(input);
      return { message_id: ++provider.nextId };
    },
  }),
}));

const { __channelsWorkerTesting, OUTBOUND_SENT, OUTBOUND_MEDIA_NEXT, pollCheckpoint, isTransientCoreFailure } =
  await import('../../../worker/channels/index.js');

const SECRET = 'internal-secret-value';
const INTEGRATION_ID = '0d2c6f0e-8a4b-4c9d-9e1f-2a3b4c5d6e7f';
const WORKSPACE_ID = '5b3c6f0e-8a4b-4c9d-9e1f-2a3b4c5d6e70';
const MESSAGE_ID = '1b4e28ba-2d11-4ab3-9c5e-0f6a1e2b3c4d';

/** Core's answers to /outbound-result and /operations, queued per test. */
const core = {
  calls: [] as Array<{ path: string; body: any }>,
  results: [] as Array<{ status: number; body: unknown }>,
  operationStatus: 404,
};

function startCore(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.get('/internal/channels/ready', (_req, res) => {
    res.json({ ok: true, service: CORE_INTERNAL_SERVICE_NAME, build: 'test', routes: INTERNAL_CHANNEL_ROUTES });
  });
  app.get('/internal/channels/auth-diagnostic', (_req, res) => {
    res.json({ service: CORE_INTERNAL_SERVICE_NAME, build: 'test', routes: INTERNAL_CHANNEL_ROUTES });
  });
  app.get(/^\/internal\/channels\/operations\/.+/, (req, res) => {
    core.calls.push({ path: req.path, body: null });
    res.status(core.operationStatus).json({ error: 'unknown_operation' });
  });
  app.post('/internal/channels/outbound-result', (req, res) => {
    core.calls.push({ path: req.path, body: req.body });
    const next = core.results.shift() ?? { status: 200, body: { ok: true } };
    res.status(next.status).json(next.body);
  });
  // Any other route: a Core without it (server/index.ts answers this way).
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
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
    client: {
      rpc: async (fn: string) => {
        if (fn !== 'claim_channel_jobs') return { data: [], error: null };
        const claimed = [...jobs.values()].filter((row) => row.status === 'pending');
        for (const row of claimed) Object.assign(row, { status: 'running', attempt_count: row.attempt_count + 1, claim_token: `token-${++tokens}` });
        return { data: claimed.map((row) => structuredClone(row)), error: null };
      },
      from: (table: string) => builder(table),
    },
  };
}

function textJob(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    provider: 'telegram',
    job_type: 'telegram_outbound_message',
    workspace_id: WORKSPACE_ID,
    integration_id: INTEGRATION_ID,
    payload: { chat_id: 42, text: 'Your order ships today.', message_id: MESSAGE_ID, ...extra },
  };
}

function mediaJob(id: string) {
  return {
    id,
    provider: 'whatsapp',
    job_type: 'whatsapp_outbound_media',
    workspace_id: WORKSPACE_ID,
    integration_id: INTEGRATION_ID,
    payload: {
      chat_id: '15550001111',
      text: 'Photos of your order',
      message_id: MESSAGE_ID,
      attachments: [
        { url: 'https://cdn.example.test/a.jpg', kind: 'photo' },
        { url: 'https://cdn.example.test/b.jpg', kind: 'photo' },
        { url: 'https://cdn.example.test/c.jpg', kind: 'photo' },
      ],
    },
  };
}

const reports = () => core.calls.filter((c) => c.path === '/internal/channels/outbound-result').map((c) => c.body);

describe('chat replies reach the customer once', () => {
  let server: { url: string; close: () => Promise<void> };
  let db: ReturnType<typeof fakeDb>;

  beforeAll(async () => {
    server = await startCore();
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(() => {
    db = fakeDb();
    core.calls = [];
    core.results = [];
    core.operationStatus = 404;
    provider.texts = [];
    provider.media = [];
    provider.mediaFailures = [];
    provider.nextId = 100;
    __channelsWorkerTesting.configure({ sb: db.client, coreBaseUrl: server.url, coreSecret: SECRET });
  });

  it('sends, records the send on the job, and reports it', async () => {
    db.add(textJob('job-1'));
    await __channelsWorkerTesting.processBatch();
    expect(provider.texts).toHaveLength(1);
    expect(reports()).toEqual([expect.objectContaining({ message_id: MESSAGE_ID, outcome: 'sent', external_message_id: 101 })]);
    expect(db.jobs.get('job-1')).toMatchObject({ status: 'succeeded' });
    expect(db.jobs.get('job-1')!.payload[OUTBOUND_SENT]).toBeTruthy();
  });

  it('a report Core does not take (500) is retried without sending again', async () => {
    db.add(textJob('job-2'));
    core.results = [{ status: 500, body: { error: 'outbound_result_failed' } }];
    await __channelsWorkerTesting.processBatch();
    expect(provider.texts).toHaveLength(1);
    expect(db.jobs.get('job-2')).toMatchObject({ status: 'pending' });

    await __channelsWorkerTesting.processBatch();
    expect(provider.texts).toHaveLength(1);
    expect(reports().map((r) => r.outcome)).toEqual(['sent', 'sent']);
    // The retry reports the id the first run got from the provider.
    expect(reports()[1].external_message_id).toBe(101);
    expect(db.jobs.get('job-2')).toMatchObject({ status: 'succeeded' });
  });

  it('a deploy (503 on the report) requeues the job for free, and the retry only reports', async () => {
    db.add(textJob('job-3'));
    core.results = [{ status: 503, body: { error: 'not_ready' } }];
    await __channelsWorkerTesting.processBatch();
    expect(db.jobs.get('job-3')).toMatchObject({ status: 'pending', attempt_count: 0 });

    // The worker re-checks Core before claiming again.
    __channelsWorkerTesting.configure({ sb: db.client, coreBaseUrl: server.url, coreSecret: SECRET });
    await __channelsWorkerTesting.processBatch();
    expect(provider.texts).toHaveLength(1);
    expect(db.jobs.get('job-3')).toMatchObject({ status: 'succeeded' });
  });

  it('a message Core no longer has ends the job instead of resending it forever', async () => {
    db.add(textJob('job-4'));
    core.results = [{ status: 404, body: { error: 'unknown_message' } }];
    await __channelsWorkerTesting.processBatch();
    expect(provider.texts).toHaveLength(1);
    expect(db.jobs.get('job-4')).toMatchObject({ status: 'succeeded' });
    // And nothing is left to run again.
    await __channelsWorkerTesting.processBatch();
    expect(provider.texts).toHaveLength(1);
  });

  it('a job whose earlier run already sent it only reports', async () => {
    db.add(textJob('job-5', { [OUTBOUND_SENT]: new Date().toISOString(), outbound_external_message_id: 77 }));
    await __channelsWorkerTesting.processBatch();
    expect(provider.texts).toHaveLength(0);
    expect(reports()).toEqual([expect.objectContaining({ outcome: 'sent', external_message_id: 77 })]);
  });

  it('a media reply whose second file failed resumes at that file', async () => {
    db.add(mediaJob('job-6'));
    provider.mediaFailures = [false, true];
    await __channelsWorkerTesting.processBatch();
    expect(provider.media.map((m) => m.url)).toEqual(['https://cdn.example.test/a.jpg']);
    expect(db.jobs.get('job-6')).toMatchObject({ status: 'pending' });
    expect(db.jobs.get('job-6')!.payload[OUTBOUND_MEDIA_NEXT]).toBe(1);
    expect(reports()).toEqual([]);

    await __channelsWorkerTesting.processBatch();
    expect(provider.media.map((m) => m.url)).toEqual([
      'https://cdn.example.test/a.jpg',
      'https://cdn.example.test/b.jpg',
      'https://cdn.example.test/c.jpg',
    ]);
    // The caption went with the first file only, once.
    expect(provider.media.filter((m) => m.caption)).toHaveLength(1);
    expect(reports()).toEqual([expect.objectContaining({ outcome: 'sent', external_message_id: provider.nextId })]);
    expect(db.jobs.get('job-6')).toMatchObject({ status: 'succeeded' });
  });

  it('a provider operation that no longer exists fails instead of looping', async () => {
    db.add({ id: 'job-7', provider: 'telegram', job_type: 'provider_operation', workspace_id: WORKSPACE_ID, integration_id: INTEGRATION_ID, payload: { operation_id: 'op-gone' } });
    await __channelsWorkerTesting.processBatch();
    expect(db.jobs.get('job-7')).toMatchObject({ status: 'failed' });
    expect(__channelsWorkerTesting.isCoreAuthReady()).toBe(true);
  });

  it('a Core without the route (a stale deploy) requeues for free and hands back the rest of the batch', async () => {
    db.add({ id: 'job-8', provider: 'telegram', job_type: 'telegram_inbound_event', workspace_id: WORKSPACE_ID, integration_id: INTEGRATION_ID, payload: { update: {} } });
    db.add(textJob('job-9'));
    await __channelsWorkerTesting.processBatch();
    expect(db.jobs.get('job-8')).toMatchObject({ status: 'pending', attempt_count: 0, claim_token: null });
    expect(db.jobs.get('job-9')).toMatchObject({ status: 'pending', attempt_count: 0, claim_token: null });
    expect(provider.texts).toHaveLength(0);
  });
});

describe('the Yahoo poll checkpoint', () => {
  it('moves past every message read when all were stored', () => {
    expect(pollCheckpoint(120, [])).toBe(120);
    expect(pollCheckpoint(null, [])).toBeNull();
  });

  it('stops before the first message Core could not store', () => {
    expect(pollCheckpoint(120, [117, 119])).toBe(116);
    expect(pollCheckpoint(5, [1])).toBeNull();
  });

  it('holds back only for failures that may pass', () => {
    expect(isTransientCoreFailure(new Error('fetch failed'))).toBe(true);
    expect(isTransientCoreFailure(Object.assign(new Error('x'), { status: 500 }))).toBe(true);
    expect(isTransientCoreFailure(Object.assign(new Error('x'), { status: 429 }))).toBe(true);
    expect(isTransientCoreFailure(Object.assign(new Error('x'), { infrastructure: true }))).toBe(true);
    expect(isTransientCoreFailure(Object.assign(new Error('x'), { status: 400 }))).toBe(false);
    expect(isTransientCoreFailure(Object.assign(new Error('x'), { status: 413 }))).toBe(false);
  });
});
