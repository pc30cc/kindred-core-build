// @vitest-environment node
/**
 * A workspace with Gmail AND Yahoo connected at once.
 *
 *   - `?provider=gmail|yahoo` on every `/api/email-inbox` route picks the
 *     mailbox; any other value is a 400; without it, Gmail first as before.
 *   - `GET mailboxes` lists the connected ones with their unread counts and
 *     nothing of their mail; a count that cannot be read is null, a Gmail
 *     grant found revoked is marked errored and left out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createFakeDb, type FakeDb, type Row } from '../commerce/support/fakeSupabase';
import { GMAIL_PLUGIN_ID } from '../../../shared/channels/gmailKeys.js';
import { YAHOO_PLUGIN_ID } from '../../../shared/channels/yahooKeys.js';
import { GmailError } from '../../../server/services/channels/gmail/types.js';

const WS = '6ee40d07-32a3-4594-8a5f-d439f81afa5b';
const GMAIL_THREAD = '18c3f4a5b6c7d8e9';

let db: FakeDb;
/** Tables whose reads fail, to stand in for a database error. */
const failing = new Set<string>();
const state = vi.hoisted(() => ({
  installations: {} as Record<string, string>,
  integrations: new Map<string, Record<string, unknown>>(),
  updates: [] as Array<{ id: string; patch: Record<string, unknown> }>,
  tokenError: null as Error | null,
  jobs: [] as Array<{ jobType: string; integrationId: string }>,
  moduleAllowed: true,
}));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from(table: string) {
      if (!failing.has(table)) return db.client.from(table);
      const failed: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit', 'lt', 'ilike']) failed[m] = () => failed;
      failed.then = (resolve: (v: unknown) => void) => resolve({ data: null, count: null, error: { message: 'db down' } });
      return failed;
    },
  }),
}));
vi.mock('../../../server/lib/workspaceAuth.js', () => ({
  authorizeWorkspaceAccess: async () => ({ userId: 'user-1' }),
  serverConfigOf: () => ({}),
}));
vi.mock('../../../server/middleware/featureGating.js', () => ({
  enforceModule: async (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    if (state.moduleAllowed) return true;
    res.status(403).json({ error: 'module_not_available' });
    return false;
  },
}));
vi.mock('../../../server/services/plugins/state.js', () => ({
  getInstallation: async (_c: unknown, workspaceId: string, pluginId: string) =>
    workspaceId === WS && state.installations[pluginId] ? { id: state.installations[pluginId] } : null,
}));
vi.mock('../../../server/services/channels/integrations.js', () => ({
  getIntegrationForInstallation: async (_c: unknown, installationId: string) => {
    const row = state.integrations.get(installationId);
    return row ? { ...row } : null;
  },
  updateIntegration: async (_c: unknown, id: string, patch: Record<string, unknown>) => {
    state.updates.push({ id, patch });
    for (const row of state.integrations.values()) if (row.id === id) Object.assign(row, patch);
  },
}));
vi.mock('../../../server/services/channels/gmail/oauth.js', () => ({
  GMAIL_PLUGIN_ID: 'gmail',
  getGmailAccessToken: async () => {
    if (state.tokenError) throw state.tokenError;
    return 'access-token';
  },
  evictGmailAccessToken: () => {},
}));
vi.mock('../../../server/services/channels/gmail/oauthConfig.js', () => ({
  getGmailOAuthConfig: () => ({ clientId: 'client', clientSecret: 'secret', redirectUri: 'https://x/cb' }),
}));
vi.mock('../../../server/services/channels/jobs.js', () => ({
  enqueueChannelJob: async (_sb: unknown, job: { jobType: string; integrationId: string }) => { state.jobs.push(job); return { id: 'job-1' }; },
}));
vi.mock('../../../server/services/storage/index.js', () => ({
  uploadFile: async (_c: unknown, input: { fileKey: string }) => ({ success: true, fileKey: input.fileKey }),
  getFileUrl: async () => null,
  downloadFile: async () => ({ success: false }),
}));

const { emailInboxRouter } = await import('../../../server/routes/emailInbox.js');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/email-inbox', emailInboxRouter);
  return a;
}

// ── Gmail, over HTTP ─────────────────────────────────────────────────────

const gmail = { calls: [] as string[], labels: { status: 200, body: {} as unknown }, labelsDelayMs: 0 };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const rawThread = {
  id: GMAIL_THREAD,
  historyId: '900',
  messages: [{
    id: '18c3f4a5b6c7d8ea',
    threadId: GMAIL_THREAD,
    labelIds: ['INBOX', 'UNREAD'],
    internalDate: '1700000000000',
    snippet: 'gmail snippet',
    payload: { headers: [{ name: 'From', value: 'ali@example.com' }, { name: 'Subject', value: 'From Gmail' }] },
  }],
};

async function fakeGmail(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const path = url.replace('https://gmail.googleapis.com/gmail/v1/users/me', '');
  gmail.calls.push(`${init?.method ?? 'GET'} ${path.replace(/\?.*$/, '')}`);
  if (path.startsWith('/labels/INBOX')) {
    if (gmail.labelsDelayMs) await new Promise((r) => setTimeout(r, gmail.labelsDelayMs));
    return json(gmail.labels.status, gmail.labels.body);
  }
  if (path.startsWith('/threads?')) return json(200, { threads: [{ id: GMAIL_THREAD, historyId: '900' }] });
  if (path.startsWith(`/threads/${GMAIL_THREAD}/modify`)) return json(200, {});
  if (path.startsWith(`/threads/${GMAIL_THREAD}`)) return json(200, rawThread);
  return json(404, { error: { message: 'not found' } });
}

// ── Fixtures ─────────────────────────────────────────────────────────────

function integration(provider: 'gmail' | 'yahoo', status = 'connected'): Record<string, unknown> {
  return {
    id: `int-${provider}`,
    installation_id: `inst-${provider}`,
    workspace_id: WS,
    provider,
    status,
    external_account_id: provider === 'gmail' ? 'me@gmail.com' : 'me@yahoo.com',
    metadata: {},
  };
}

function connect(...providers: Array<'gmail' | 'yahoo'>) {
  for (const p of providers) {
    state.installations[p === 'gmail' ? GMAIL_PLUGIN_ID : YAHOO_PLUGIN_ID] = `inst-${p}`;
    state.integrations.set(`inst-${p}`, integration(p));
  }
}

function thread(id: string, integrationId: string, provider: string, isRead: boolean, workspaceId = WS): Row {
  return {
    id, workspace_id: workspaceId, integration_id: integrationId, provider, external_thread_id: `ext-${id}`,
    subject: `Subject ${id}`, participants: [], last_message_at: `2026-09-2${id.length % 9}T10:00:00Z`,
    is_read: isRead, is_starred: false, labels: [],
  };
}

beforeEach(() => {
  state.installations = {};
  state.integrations.clear();
  state.updates.length = 0;
  state.jobs.length = 0;
  state.tokenError = null;
  state.moduleAllowed = true;
  failing.clear();
  gmail.calls.length = 0;
  gmail.labels = { status: 200, body: { id: 'INBOX', name: 'INBOX', threadsUnread: 12, threadsTotal: 40 } };
  gmail.labelsDelayMs = 0;
  vi.stubGlobal('fetch', fakeGmail);
  db = createFakeDb({
    email_threads: [
      thread('y-unread-1', 'int-yahoo', 'yahoo', false),
      thread('y-unread-2', 'int-yahoo', 'yahoo', false),
      thread('y-read', 'int-yahoo', 'yahoo', true),
      // Imported from Gmail before it went live: never part of the Yahoo mailbox.
      thread('legacy-gmail', 'int-gmail', 'gmail', false),
      thread('other-ws', 'int-other', 'yahoo', false, '11111111-1111-1111-1111-111111111111'),
    ],
    email_messages: [],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── ?provider= validation ───────────────────────────────────────────────

describe('?provider=', () => {
  it('rejects anything but gmail or yahoo, on reads and writes alike', async () => {
    connect('gmail', 'yahoo');
    const a = app();
    const responses = await Promise.all([
      request(a).get(`/api/email-inbox/${WS}/threads?provider=outlook`),
      request(a).get(`/api/email-inbox/${WS}/threads/${GMAIL_THREAD}?provider=GMAIL`),
      request(a).get(`/api/email-inbox/${WS}/changes?since=1&provider=icloud`),
      request(a).get(`/api/email-inbox/${WS}/mailboxes?provider=x`),
      request(a).get(`/api/email-inbox/${WS}/attachments/abc/file?provider=x`),
      request(a).get(`/api/email-inbox/${WS}/threads?provider=gmail&provider=yahoo`),
      request(a).post(`/api/email-inbox/${WS}/threads/${GMAIL_THREAD}/read?provider=hotmail`).send({ is_read: true }),
      request(a).post(`/api/email-inbox/${WS}/threads/${GMAIL_THREAD}/star?provider=hotmail`).send({ starred: true }),
      request(a).post(`/api/email-inbox/${WS}/attachments?provider=hotmail`).set('Content-Type', 'application/octet-stream').send(Buffer.from('x')),
      request(a).post(`/api/email-inbox/${WS}/send?provider=hotmail`).send({ to: ['a@b.co'], subject: 's', text_body: 'b' }),
    ]);
    for (const res of responses) {
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'invalid_provider' });
    }
    expect(gmail.calls).toEqual([]);
  });

  it('treats an empty value as none', async () => {
    connect('gmail', 'yahoo');
    const res = await request(app()).get(`/api/email-inbox/${WS}/threads?provider=`);
    expect(res.status).toBe(200);
    expect(res.body.threads.map((t: { id: string }) => t.id)).toEqual([GMAIL_THREAD]);
  });
});

// ── Routing to the chosen mailbox ───────────────────────────────────────

describe('with both mailboxes connected', () => {
  beforeEach(() => connect('gmail', 'yahoo'));

  it('serves Gmail when no provider is named, as before', async () => {
    const res = await request(app()).get(`/api/email-inbox/${WS}/threads`);
    expect(res.status).toBe(200);
    expect(res.body.threads.map((t: { id: string; provider: string }) => [t.id, t.provider])).toEqual([[GMAIL_THREAD, 'gmail']]);
    expect(gmail.calls[0]).toBe('GET /threads');
  });

  it('?provider=yahoo lists that mailbox only, and never asks Gmail', async () => {
    const res = await request(app()).get(`/api/email-inbox/${WS}/threads?provider=yahoo`);
    expect(res.status).toBe(200);
    expect(res.body.threads.map((t: { id: string }) => t.id).sort()).toEqual(['y-read', 'y-unread-1', 'y-unread-2']);
    expect(gmail.calls).toEqual([]);
  });

  it('?provider=gmail lists Gmail', async () => {
    const res = await request(app()).get(`/api/email-inbox/${WS}/threads?provider=gmail`);
    expect(res.body.threads.map((t: { id: string }) => t.id)).toEqual([GMAIL_THREAD]);
  });

  it('writes read/star to the named mailbox', async () => {
    const a = app();
    const yahoo = await request(a).post(`/api/email-inbox/${WS}/threads/y-unread-1/read?provider=yahoo`).send({ is_read: true });
    expect(yahoo.status).toBe(200);
    expect(db.tables.email_threads.find((t) => t.id === 'y-unread-1')?.is_read).toBe(true);
    expect(gmail.calls).toEqual([]);

    const live = await request(a).post(`/api/email-inbox/${WS}/threads/${GMAIL_THREAD}/star?provider=gmail`).send({ starred: true });
    expect(live.status).toBe(200);
    expect(gmail.calls).toEqual([`POST /threads/${GMAIL_THREAD}/modify`]);
  });

  it('/changes for Yahoo asks the client to reload page one', async () => {
    const res = await request(app()).get(`/api/email-inbox/${WS}/changes?since=5&provider=yahoo`);
    expect(res.body).toEqual({ historyId: null, threadIds: [], contentThreadIds: [], reset: true });
    expect(gmail.calls).toEqual([]);
  });

  it('staging and sending go to the named mailbox', async () => {
    const a = app();
    // Default (Gmail, live): the bytes come straight back as an inline key.
    const live = await request(a).post(`/api/email-inbox/${WS}/attachments?filename=a.txt`).set('Content-Type', 'application/octet-stream').send(Buffer.from('hi'));
    expect(live.body.storageKey).toMatch(/^inline:/);
    // Yahoo: staged in storage, as that mailbox has always done.
    const staged = await request(a).post(`/api/email-inbox/${WS}/attachments?filename=a.txt&provider=yahoo`).set('Content-Type', 'application/octet-stream').send(Buffer.from('hi'));
    expect(staged.status).toBe(200);
    expect(staged.body.storageKey).not.toMatch(/^inline:/);

    const sent = await request(a).post(`/api/email-inbox/${WS}/send?provider=yahoo`).send({ to: ['ali@example.com'], subject: 'Hello', text_body: 'Hi' });
    expect(sent.status).toBe(200);
    expect(state.jobs).toEqual([expect.objectContaining({ jobType: 'yahoo_outbound_message', integrationId: 'int-yahoo' })]);
    expect(gmail.calls).toEqual([]);
  });
});

describe('a named mailbox that is not connected', () => {
  beforeEach(() => connect('yahoo'));

  it('lists nothing, as an unconnected inbox always has', async () => {
    const res = await request(app()).get(`/api/email-inbox/${WS}/threads?provider=gmail`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ threads: [], nextBefore: null, syncing: false });
  });

  it('is email_not_connected everywhere else, even with the other one connected', async () => {
    const a = app();
    const thread = await request(a).get(`/api/email-inbox/${WS}/threads/${GMAIL_THREAD}?provider=gmail`);
    expect(thread.status).toBe(409);
    expect(thread.body.error).toBe('email_not_connected');
    const read = await request(a).post(`/api/email-inbox/${WS}/threads/${GMAIL_THREAD}/read?provider=gmail`).send({ is_read: true });
    expect(read.status).toBe(409);
    const send = await request(a).post(`/api/email-inbox/${WS}/send?provider=gmail`).send({ to: ['a@b.co'], subject: 's', text_body: 'b' });
    expect(send.status).toBe(409);
    expect(state.jobs).toEqual([]);
  });

  it('without a provider, falls back to Yahoo as before', async () => {
    const res = await request(app()).get(`/api/email-inbox/${WS}/threads`);
    // Unnamed, the table-backed list is what it was: every row of the workspace.
    expect(res.body.threads.map((t: { id: string }) => t.id).sort()).toEqual(['legacy-gmail', 'y-read', 'y-unread-1', 'y-unread-2']);
  });
});

// ── GET mailboxes ────────────────────────────────────────────────────────

describe('GET mailboxes', () => {
  it('lists the connected mailboxes, Gmail first, with unread counts and nothing else', async () => {
    connect('yahoo', 'gmail');
    const res = await request(app()).get(`/api/email-inbox/${WS}/mailboxes`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      mailboxes: [
        { provider: 'gmail', address: 'me@gmail.com', status: 'connected', unread: 12 },
        // The Yahoo mailbox's own unread rows: not the legacy Gmail row, not another workspace's.
        { provider: 'yahoo', address: 'me@yahoo.com', status: 'connected', unread: 2 },
      ],
    });
    // Gmail's own INBOX counter, one call; no thread or message is read.
    expect(gmail.calls).toEqual(['GET /labels/INBOX']);
  });

  it("the Yahoo count is what that mailbox's unread list shows", async () => {
    connect('gmail', 'yahoo');
    const a = app();
    const mailboxes = await request(a).get(`/api/email-inbox/${WS}/mailboxes`);
    const unreadList = await request(a).get(`/api/email-inbox/${WS}/threads?provider=yahoo&unread=true`);
    const yahoo = mailboxes.body.mailboxes.find((m: { provider: string }) => m.provider === 'yahoo');
    expect(yahoo.unread).toBe(unreadList.body.threads.length);
  });

  it('only connected mailboxes appear', async () => {
    connect('gmail', 'yahoo');
    state.integrations.get('inst-gmail')!.status = 'disconnected';
    const res = await request(app()).get(`/api/email-inbox/${WS}/mailboxes`);
    expect(res.body.mailboxes.map((m: { provider: string }) => m.provider)).toEqual(['yahoo']);
    expect(gmail.calls).toEqual([]);
  });

  it('is empty with nothing connected', async () => {
    const res = await request(app()).get(`/api/email-inbox/${WS}/mailboxes`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mailboxes: [] });
  });

  it('?provider= narrows the list to that mailbox', async () => {
    connect('gmail', 'yahoo');
    const res = await request(app()).get(`/api/email-inbox/${WS}/mailboxes?provider=yahoo`);
    expect(res.body.mailboxes).toEqual([{ provider: 'yahoo', address: 'me@yahoo.com', status: 'connected', unread: 2 }]);
    expect(gmail.calls).toEqual([]);
  });

  it('a Gmail count that fails is null, and the request still succeeds', async () => {
    connect('gmail', 'yahoo');
    for (const status of [500, 429]) {
      gmail.labels = { status, body: { error: { message: 'backend error' } } };
      const res = await request(app()).get(`/api/email-inbox/${WS}/mailboxes`);
      expect(res.status).toBe(200);
      expect(res.body.mailboxes).toEqual([
        { provider: 'gmail', address: 'me@gmail.com', status: 'connected', unread: null },
        { provider: 'yahoo', address: 'me@yahoo.com', status: 'connected', unread: 2 },
      ]);
    }
    expect(state.updates).toEqual([]);
  });

  it('a Yahoo count that fails is null, and the request still succeeds', async () => {
    connect('gmail', 'yahoo');
    failing.add('email_threads');
    const res = await request(app()).get(`/api/email-inbox/${WS}/mailboxes`);
    expect(res.status).toBe(200);
    expect(res.body.mailboxes).toEqual([
      { provider: 'gmail', address: 'me@gmail.com', status: 'connected', unread: 12 },
      { provider: 'yahoo', address: 'me@yahoo.com', status: 'connected', unread: null },
    ]);
  });

  it('a revoked Gmail grant is marked errored and its mailbox left out', async () => {
    connect('gmail', 'yahoo');
    state.tokenError = new GmailError('gmail_token_revoked', undefined, 'Google 400 @ https://oauth2.googleapis.com/token — invalid_grant');
    const res = await request(app()).get(`/api/email-inbox/${WS}/mailboxes`);
    expect(res.status).toBe(200);
    expect(res.body.mailboxes.map((m: { provider: string }) => m.provider)).toEqual(['yahoo']);
    expect(state.updates).toEqual([{ id: 'int-gmail', patch: expect.objectContaining({ status: 'error', last_error_code: 'gmail_token_revoked' }) }]);
    // And from then on it is simply not connected.
    state.tokenError = null;
    const again = await request(app()).get(`/api/email-inbox/${WS}/mailboxes`);
    expect(again.body.mailboxes.map((m: { provider: string }) => m.provider)).toEqual(['yahoo']);
  });

  it('concurrent requests share one Gmail call', async () => {
    connect('gmail');
    gmail.labelsDelayMs = 30;
    const a = app();
    const results = await Promise.all([1, 2, 3].map(() => request(a).get(`/api/email-inbox/${WS}/mailboxes`)));
    for (const res of results) expect(res.body.mailboxes).toEqual([{ provider: 'gmail', address: 'me@gmail.com', status: 'connected', unread: 12 }]);
    expect(gmail.calls.filter((c) => c === 'GET /labels/INBOX')).toHaveLength(1);
  });

  it('answers to the workspace plan like every other inbox route', async () => {
    connect('gmail');
    state.moduleAllowed = false;
    const res = await request(app()).get(`/api/email-inbox/${WS}/mailboxes`);
    expect(res.status).toBe(403);
    expect(gmail.calls).toEqual([]);
  });
});
