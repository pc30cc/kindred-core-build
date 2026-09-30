// @vitest-environment node
/**
 * A mailbox's folders: `?folder=` on the thread list and on a thread, and
 * `GET folders` for the menu.
 *
 *   - Gmail: each system folder is its label (All mail is none; Spam and
 *     Trash include them), a label is `label:<id>`; Sent and Drafts name
 *     whom a mail is to; Spam, Trash and Drafts show their own messages.
 *   - The menu is the system folders, then the user's labels by name, with
 *     Gmail's own counters and nothing of the mail.
 *   - Yahoo (table-backed) has Inbox, Starred and Sent; any other folder is
 *     `unsupported_folder`.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createFakeDb, type FakeDb, type Row } from '../commerce/support/fakeSupabase';
import { GMAIL_PLUGIN_ID } from '../../../shared/channels/gmailKeys.js';
import { YAHOO_PLUGIN_ID } from '../../../shared/channels/yahooKeys.js';

const WS = '6ee40d07-32a3-4594-8a5f-d439f81afa5b';
const THREAD = '18c3f4a5b6c7d8e9';

let db: FakeDb;
const state = vi.hoisted(() => ({
  installations: {} as Record<string, string>,
  integrations: new Map<string, Record<string, unknown>>(),
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => db.client }));
vi.mock('../../../server/lib/workspaceAuth.js', () => ({
  authorizeWorkspaceAccess: async () => ({ userId: 'user-1' }),
  serverConfigOf: () => ({}),
}));
vi.mock('../../../server/middleware/featureGating.js', () => ({ enforceModule: async () => true }));
vi.mock('../../../server/services/plugins/state.js', () => ({
  getInstallation: async (_c: unknown, workspaceId: string, pluginId: string) =>
    workspaceId === WS && state.installations[pluginId] ? { id: state.installations[pluginId] } : null,
}));
vi.mock('../../../server/services/channels/integrations.js', () => ({
  getIntegrationForInstallation: async (_c: unknown, installationId: string) => {
    const row = state.integrations.get(installationId);
    return row ? { ...row } : null;
  },
  updateIntegration: async () => {},
}));
vi.mock('../../../server/services/channels/gmail/oauth.js', () => ({
  GMAIL_PLUGIN_ID: 'gmail',
  getGmailAccessToken: async () => 'access-token',
  evictGmailAccessToken: () => {},
}));
vi.mock('../../../server/services/channels/gmail/oauthConfig.js', () => ({
  getGmailOAuthConfig: () => ({ clientId: 'client', clientSecret: 'secret', redirectUri: 'https://x/cb' }),
}));
vi.mock('../../../server/services/storage/index.js', () => ({
  uploadFile: async () => ({ success: true }),
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

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function message(id: string, labelIds: string[], headers: Record<string, string>, minutes: number) {
  return {
    id,
    threadId: THREAD,
    labelIds,
    internalDate: String(1_700_000_000_000 + minutes * 60_000),
    snippet: `snippet ${id}`,
    payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) },
  };
}

/** A thread with a received mail, our reply, a draft, and a mail that went to spam. */
const rawThread = {
  id: THREAD,
  historyId: '900',
  messages: [
    message('18c3f4a5b6c7d801', ['INBOX'], { From: 'ali@example.com', To: 'me@gmail.com', Subject: 'Invoice' }, 1),
    message('18c3f4a5b6c7d802', ['SENT'], { From: 'me@gmail.com', To: 'ali@example.com', Subject: 'Re: Invoice' }, 2),
    message('18c3f4a5b6c7d803', ['DRAFT'], { From: 'me@gmail.com', To: 'sara@example.com', Subject: 'Re: Invoice' }, 3),
    message('18c3f4a5b6c7d804', ['SPAM', 'UNREAD'], { From: 'win@lottery.example', To: 'me@gmail.com', Subject: 'Re: Invoice' }, 4),
  ],
};

const gmail = {
  requests: [] as URL[],
  labels: [] as Array<Record<string, unknown>>,
  counts: {} as Record<string, { threadsUnread?: number; threadsTotal?: number } | 'fail'>,
};

async function fakeGmail(input: string | URL | Request): Promise<Response> {
  const url = new URL(String(input));
  gmail.requests.push(url);
  const path = url.pathname.replace('/gmail/v1/users/me', '');
  if (path === '/labels') return json(200, { labels: gmail.labels });
  if (path.startsWith('/labels/')) {
    const id = decodeURIComponent(path.slice('/labels/'.length));
    const count = gmail.counts[id];
    if (count === 'fail') return json(500, { error: { message: 'backend error' } });
    return json(200, { id, ...(count ?? {}) });
  }
  if (path === '/threads') return json(200, { threads: [{ id: THREAD, historyId: '900' }] });
  if (path === `/threads/${THREAD}`) return json(200, rawThread);
  return json(404, { error: { message: 'not found' } });
}

function paths() {
  return gmail.requests.map((u) => u.pathname.replace('/gmail/v1/users/me', ''));
}

function listRequest(): URL {
  const found = gmail.requests.find((u) => u.pathname.endsWith('/threads'));
  if (!found) throw new Error('no list request');
  return found;
}

// ── Fixtures ─────────────────────────────────────────────────────────────

function connect(provider: 'gmail' | 'yahoo') {
  state.installations[provider === 'gmail' ? GMAIL_PLUGIN_ID : YAHOO_PLUGIN_ID] = `inst-${provider}`;
  state.integrations.set(`inst-${provider}`, {
    id: `int-${provider}`,
    installation_id: `inst-${provider}`,
    workspace_id: WS,
    provider,
    status: 'connected',
    external_account_id: provider === 'gmail' ? 'me@gmail.com' : 'me@yahoo.com',
    metadata: {},
  });
}

function thread(id: string, day: number, opts: { read?: boolean; starred?: boolean } = {}): Row {
  return {
    id, workspace_id: WS, integration_id: 'int-yahoo', provider: 'yahoo', external_thread_id: `ext-${id}`,
    subject: `Subject ${id}`, participants: [], last_message_at: `2026-09-${String(day).padStart(2, '0')}T10:00:00Z`,
    is_read: opts.read ?? true, is_starred: opts.starred ?? false, labels: [],
  };
}

function outbound(threadId: string, day: number): Row {
  return {
    id: `msg-${threadId}`, thread_id: threadId, workspace_id: WS, external_message_id: `<${threadId}@x>`,
    direction: 'outbound', from_address: 'me@yahoo.com', snippet: 'sent', sent_at: `2026-09-${String(day).padStart(2, '0')}T11:00:00Z`,
  };
}

beforeEach(() => {
  state.installations = {};
  state.integrations.clear();
  gmail.requests.length = 0;
  gmail.labels = [
    { id: 'INBOX', name: 'INBOX', type: 'system' },
    { id: 'SPAM', name: 'SPAM', type: 'system' },
    { id: 'Label_20', name: 'Suppliers', type: 'user' },
    { id: 'Label_10', name: 'Clients/Acme', type: 'user' },
    { id: 'Label_30', name: 'Hidden one', type: 'user', labelListVisibility: 'labelHide' },
  ];
  gmail.counts = {
    INBOX: { threadsUnread: 7, threadsTotal: 90 },
    SPAM: { threadsUnread: 3, threadsTotal: 12 },
    DRAFT: { threadsUnread: 0, threadsTotal: 2 },
    Label_10: { threadsUnread: 1, threadsTotal: 4 },
    Label_20: 'fail',
  };
  vi.stubGlobal('fetch', fakeGmail);
  db = createFakeDb({
    email_threads: [
      thread('y-inbox', 20, { read: false }),
      thread('y-starred', 19, { starred: true }),
      thread('y-replied', 18),
    ],
    email_messages: [outbound('y-replied', 18)],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── ?folder= ─────────────────────────────────────────────────────────────

describe('?folder=', () => {
  it('is a 400 for anything but a folder, before any mailbox is asked', async () => {
    connect('gmail');
    const a = app();
    for (const bad of ['outbox', 'INBOX', 'label:', 'label:../x', 'label:a b', 'label:' + 'x'.repeat(101)]) {
      const list = await request(a).get(`/api/email-inbox/${WS}/threads`).query({ folder: bad });
      expect(list.status).toBe(400);
      expect(list.body).toEqual({ error: 'invalid_folder' });
      const one = await request(a).get(`/api/email-inbox/${WS}/threads/${THREAD}`).query({ folder: bad });
      expect(one.status).toBe(400);
    }
    const twice = await request(a).get(`/api/email-inbox/${WS}/threads?folder=sent&folder=spam`);
    expect(twice.status).toBe(400);
    expect(gmail.requests).toEqual([]);
  });
});

describe('Gmail folders', () => {
  beforeEach(() => connect('gmail'));

  it.each([
    ['inbox', ['INBOX'], false],
    ['starred', ['STARRED'], false],
    ['important', ['IMPORTANT'], false],
    ['sent', ['SENT'], false],
    ['drafts', ['DRAFT'], false],
    ['all', [], false],
    ['spam', ['SPAM'], true],
    ['trash', ['TRASH'], true],
    ['label:Label_10', ['Label_10'], false],
  ])('%s lists Gmail label %j', async (folder, labels, spamTrash) => {
    const res = await request(app()).get(`/api/email-inbox/${WS}/threads`).query({ folder });
    expect(res.status).toBe(200);
    const list = listRequest();
    expect(list.searchParams.getAll('labelIds')).toEqual(labels);
    expect(list.searchParams.get('includeSpamTrash')).toBe(spamTrash ? 'true' : null);
  });

  it('with no folder, the inbox as before', async () => {
    await request(app()).get(`/api/email-inbox/${WS}/threads`);
    expect(listRequest().searchParams.getAll('labelIds')).toEqual(['INBOX']);
  });

  it('the unread and starred filters narrow the folder', async () => {
    await request(app()).get(`/api/email-inbox/${WS}/threads?folder=sent&unread=true&starred=true`);
    expect(listRequest().searchParams.getAll('labelIds')).toEqual(['SENT', 'UNREAD', 'STARRED']);
    gmail.requests.length = 0;
    await request(app()).get(`/api/email-inbox/${WS}/threads?folder=starred&starred=true`);
    expect(listRequest().searchParams.getAll('labelIds')).toEqual(['STARRED']);
  });

  it('the inbox row names who wrote; Sent and Drafts name whom the mail is to', async () => {
    const a = app();
    const inbox = await request(a).get(`/api/email-inbox/${WS}/threads`);
    expect(inbox.body.threads[0].participants).toEqual([{ email: 'ali@example.com' }]);
    const sent = await request(a).get(`/api/email-inbox/${WS}/threads?folder=sent`);
    expect(sent.body.threads[0].participants).toEqual([{ email: 'ali@example.com' }]);
    const drafts = await request(a).get(`/api/email-inbox/${WS}/threads?folder=drafts`);
    expect(drafts.body.threads[0].participants).toEqual([{ email: 'sara@example.com' }]);
  });

  it('a thread opened from a folder shows that folder\'s messages', async () => {
    const a = app();
    const ids = async (folder?: string) => {
      const res = await request(a).get(`/api/email-inbox/${WS}/threads/${THREAD}`).query(folder ? { folder } : {});
      expect(res.status).toBe(200);
      return res.body.messages.map((m: { id: string }) => m.id);
    };
    // The inbox: no draft, no spam — as before.
    expect(await ids()).toEqual(['18c3f4a5b6c7d801', '18c3f4a5b6c7d802']);
    expect(await ids('spam')).toEqual(['18c3f4a5b6c7d804']);
    expect(await ids('drafts')).toEqual(['18c3f4a5b6c7d801', '18c3f4a5b6c7d802', '18c3f4a5b6c7d803']);
    expect(await ids('label:Label_10')).toEqual(['18c3f4a5b6c7d801', '18c3f4a5b6c7d802']);
  });

  it('a draft is ours and not sent', async () => {
    const res = await request(app()).get(`/api/email-inbox/${WS}/threads/${THREAD}?folder=drafts`);
    const draft = res.body.messages.find((m: { id: string }) => m.id === '18c3f4a5b6c7d803');
    expect(draft).toEqual(expect.objectContaining({ direction: 'outbound', deliveryStatus: 'draft' }));
    const reply = res.body.messages.find((m: { id: string }) => m.id === '18c3f4a5b6c7d802');
    expect(reply.deliveryStatus).toBe('sent');
  });

  it('a thread with nothing in the folder is not found there', async () => {
    rawThread.messages.splice(3, 1);
    try {
      const res = await request(app()).get(`/api/email-inbox/${WS}/threads/${THREAD}?folder=spam`);
      expect(res.status).toBe(404);
    } finally {
      rawThread.messages.push(message('18c3f4a5b6c7d804', ['SPAM', 'UNREAD'], { From: 'win@lottery.example', To: 'me@gmail.com', Subject: 'Re: Invoice' }, 4));
    }
  });
});

// ── GET folders ──────────────────────────────────────────────────────────

describe('GET folders', () => {
  it('Gmail: the system folders, then the visible labels by name, with Gmail\'s counters', async () => {
    connect('gmail');
    const res = await request(app()).get(`/api/email-inbox/${WS}/folders`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      folders: [
        { id: 'inbox', kind: 'system', name: null, unread: 7, total: null },
        { id: 'starred', kind: 'system', name: null, unread: null, total: null },
        { id: 'important', kind: 'system', name: null, unread: null, total: null },
        { id: 'sent', kind: 'system', name: null, unread: null, total: null },
        { id: 'drafts', kind: 'system', name: null, unread: null, total: 2 },
        { id: 'all', kind: 'system', name: null, unread: null, total: null },
        { id: 'spam', kind: 'system', name: null, unread: 3, total: null },
        { id: 'trash', kind: 'system', name: null, unread: null, total: null },
        { id: 'label:Label_10', kind: 'label', name: 'Clients/Acme', unread: 1, total: null },
        // Its count failed: listed, without a number.
        { id: 'label:Label_20', kind: 'label', name: 'Suppliers', unread: null, total: null },
      ],
    });
    // Labels and their counters only: no thread or message is read.
    expect(paths().every((p) => p.startsWith('/labels'))).toBe(true);
  });

  it('Yahoo: Inbox with its unread count, Starred and Sent', async () => {
    connect('yahoo');
    const res = await request(app()).get(`/api/email-inbox/${WS}/folders?provider=yahoo`);
    expect(res.body).toEqual({
      folders: [
        { id: 'inbox', kind: 'system', name: null, unread: 1, total: null },
        { id: 'starred', kind: 'system', name: null, unread: null, total: null },
        { id: 'sent', kind: 'system', name: null, unread: null, total: null },
      ],
    });
  });

  it('no mailbox connected is email_not_connected', async () => {
    const res = await request(app()).get(`/api/email-inbox/${WS}/folders`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('email_not_connected');
  });
});

describe('Yahoo folders', () => {
  beforeEach(() => connect('yahoo'));

  it('Sent is the threads this mailbox wrote in; Starred the starred ones', async () => {
    const a = app();
    const sent = await request(a).get(`/api/email-inbox/${WS}/threads?provider=yahoo&folder=sent`);
    expect(sent.body.threads.map((t: { id: string }) => t.id)).toEqual(['y-replied']);
    const starred = await request(a).get(`/api/email-inbox/${WS}/threads?provider=yahoo&folder=starred`);
    expect(starred.body.threads.map((t: { id: string }) => t.id)).toEqual(['y-starred']);
    const inbox = await request(a).get(`/api/email-inbox/${WS}/threads?provider=yahoo&folder=inbox`);
    expect(inbox.body.threads.map((t: { id: string }) => t.id)).toEqual(['y-inbox', 'y-starred', 'y-replied']);
  });

  it('Sent with nothing sent is empty', async () => {
    db.tables.email_messages.length = 0;
    const res = await request(app()).get(`/api/email-inbox/${WS}/threads?provider=yahoo&folder=sent`);
    expect(res.body).toEqual({ threads: [], nextBefore: null, syncing: false });
  });

  it('a folder Yahoo does not have is unsupported_folder', async () => {
    for (const folder of ['spam', 'drafts', 'trash', 'all', 'important', 'label:Label_1']) {
      const res = await request(app()).get(`/api/email-inbox/${WS}/threads`).query({ provider: 'yahoo', folder });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('unsupported_folder');
    }
  });
});
