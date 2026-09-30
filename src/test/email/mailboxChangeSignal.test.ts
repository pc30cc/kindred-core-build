// @vitest-environment node
/**
 * "This mailbox changed" — the content-free realtime signal and the push
 * that tell apps to re-read an inbox, for both providers.
 *
 *   - Yahoo: the IMAP poll's upsert publishes `email_mailbox_changed`
 *     (provider 'yahoo', no cursor) only when a NEW inbound message is
 *     stored — never for a re-delivery — coalesced per mailbox.
 *   - Both: the event carries `at` (so payload-deduplicating clients see two
 *     signals as two) and nothing of the mail; the push names the mailbox in
 *     `data.provider`.
 */
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb, type FakeDb } from '../commerce/support/fakeSupabase';

const SECRET = 'internal-secret-value';
const WS = '6ee40d07-32a3-4594-8a5f-d439f81afa5b';
const YAHOO_INT = '9b2f7c1e-3d4a-4b5c-8d6e-7f8091a2b3c4';
const GMAIL_INT = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';

let db: FakeDb;
const spies = vi.hoisted(() => ({
  published: [] as Array<{ payload: Record<string, unknown>; opts: unknown }>,
  pushed: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => db.client,
  getAnonClient: () => ({}),
}));
vi.mock('../../../server/services/realtime/publish.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/realtime/publish.js')>()),
  publishOperatorEvent: async (_config: unknown, payload: Record<string, unknown>, opts: unknown) => {
    spies.published.push({ payload, opts });
  },
}));
vi.mock('../../../server/services/push/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/push/index.js')>()),
  notifyEmailMessage: async (_config: unknown, input: Record<string, unknown>) => { spies.pushed.push(input); },
}));
vi.mock('../../../server/services/channels/integrations.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/channels/integrations.js')>()),
  updateIntegration: async () => {},
}));
vi.mock('../../../server/services/channels/gmail/oauth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/channels/gmail/oauth.js')>()),
  getGmailAccessToken: async () => 'access-token',
}));
vi.mock('../../../server/services/channels/gmail/oauthConfig.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/channels/gmail/oauthConfig.js')>()),
  getGmailOAuthConfig: () => ({ clientId: 'client', clientSecret: 'secret', redirectUri: 'https://x/cb' }),
}));

const { internalChannelsRouter } = await import('../../../server/routes/internalChannels.js');
const { YAHOO_CHANGE_COALESCE_MS } = await import('../../../server/services/email/yahooChangeNotifier.js');
const { scheduleGmailChange } = await import('../../../server/services/email/gmailChangeNotifier.js');

let server: { url: string; close: () => Promise<void> } | null = null;

async function startCore() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { serverConfig: unknown }).serverConfig = { coreInternalSecret: SECRET };
    next();
  });
  app.use('/internal/channels', internalChannelsRouter);
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const s = app.listen(0, () => {
      const { port } = s.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((done) => s.close(() => done())) });
    });
  });
}

async function upsertYahoo(messageId: string, opts: { references?: string[] } = {}) {
  const res = await fetch(`${server!.url}/internal/channels/yahoo/upsert-thread-message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-core-internal-secret': SECRET },
    body: JSON.stringify({
      integration_id: YAHOO_INT,
      workspace_id: WS,
      subject: 'Private subject',
      participants: [{ email: 'ali@example.com' }],
      message: {
        external_message_id: messageId,
        references: opts.references ?? [],
        from_address: 'ali@example.com',
        text_body: 'Private body',
        snippet: 'Private snippet',
        sent_at: new Date().toISOString(),
      },
    }),
  });
  return { status: res.status, body: (await res.json()) as { thread_id: string; is_new_message: boolean } };
}

/** Lets the coalescing window pass. */
async function afterWindow() {
  await vi.advanceTimersByTimeAsync(YAHOO_CHANGE_COALESCE_MS + 10);
}

beforeEach(async () => {
  spies.published.length = 0;
  spies.pushed.length = 0;
  db = createFakeDb({ email_threads: [], email_messages: [] });
  db.unique.email_messages = [['thread_id', 'external_message_id']];
  server = await startCore();
  // Only timeouts are faked: the HTTP round trips run on real I/O.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(async () => {
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  await server?.close();
  server = null;
  vi.unstubAllGlobals();
});

describe('Yahoo: a new inbound message', () => {
  it('publishes one content-free email_mailbox_changed on the inbox channel', async () => {
    const res = await upsertYahoo('<m1@yahoo.com>');
    expect(res.body.is_new_message).toBe(true);
    expect(spies.published).toHaveLength(0);
    await afterWindow();

    expect(spies.published).toHaveLength(1);
    const { payload, opts } = spies.published[0];
    expect(payload).toEqual({
      kind: 'email_mailbox_changed',
      workspace_id: WS,
      conversation_id: '',
      provider: 'yahoo',
      history_id: null,
      at: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(String(payload.at)))).toBe(false);
    // Workspace inbox channel only: there is no conversation to publish to.
    expect(opts).toEqual({ skipConversationChannel: true });
    expect(JSON.stringify(payload)).not.toMatch(/Private|ali@example\.com/);
  });

  it('names the Yahoo mailbox in the push', async () => {
    const res = await upsertYahoo('<m1@yahoo.com>');
    expect(spies.pushed).toEqual([expect.objectContaining({ workspaceId: WS, threadId: res.body.thread_id, provider: 'yahoo' })]);
  });

  it('a new message in a thread it already holds publishes too', async () => {
    await upsertYahoo('<root@yahoo.com>');
    await afterWindow();
    const reply = await upsertYahoo('<reply@yahoo.com>', { references: ['<root@yahoo.com>'] });
    expect(reply.body.is_new_message).toBe(true);
    await afterWindow();
    expect(spies.published).toHaveLength(2);
    expect(db.tables.email_threads).toHaveLength(1);
  });
});

describe('Yahoo: nothing new', () => {
  it('a re-delivered message publishes nothing and pushes nothing', async () => {
    await upsertYahoo('<m1@yahoo.com>');
    await afterWindow();
    spies.published.length = 0;
    spies.pushed.length = 0;

    const again = await upsertYahoo('<m1@yahoo.com>');
    expect(again.body.is_new_message).toBe(false);
    await afterWindow();
    expect(spies.published).toEqual([]);
    expect(spies.pushed).toEqual([]);
  });

  it('a rejected payload publishes nothing', async () => {
    const res = await fetch(`${server!.url}/internal/channels/yahoo/upsert-thread-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-core-internal-secret': SECRET },
      body: JSON.stringify({ integration_id: YAHOO_INT, workspace_id: WS }),
    });
    expect(res.status).toBe(400);
    await afterWindow();
    expect(spies.published).toEqual([]);
  });
});

describe('Yahoo: a poll posting several messages back to back', () => {
  it('is one signal per window, and the next window gets its own', async () => {
    await upsertYahoo('<a@yahoo.com>');
    await upsertYahoo('<b@yahoo.com>');
    await upsertYahoo('<c@yahoo.com>');
    await afterWindow();
    expect(spies.published).toHaveLength(1);

    await upsertYahoo('<d@yahoo.com>');
    await afterWindow();
    expect(spies.published).toHaveLength(2);
    // Every new message still gets its own (deduplicated downstream) push.
    expect(spies.pushed).toHaveLength(4);
  });
});

describe('Gmail: the change notifier', () => {
  it('publishes with `at` and names Gmail in the push', async () => {
    db.tables.channel_integrations = [{
      id: GMAIL_INT, workspace_id: WS, installation_id: 'inst-gmail', provider: 'gmail', status: 'connected',
      external_account_id: 'me@gmail.com', metadata: { gmail_history_id: '100' },
    }];
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/history?')) {
        return new Response(JSON.stringify({
          historyId: '120',
          history: [{ messagesAdded: [{ message: { id: '18c3f4a5b6c7d8ea', threadId: '18c3f4a5b6c7d8e9' } }] }],
        }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });

    scheduleGmailChange({} as never, GMAIL_INT);
    await vi.advanceTimersByTimeAsync(2_100);
    await vi.waitFor(() => expect(spies.pushed).toHaveLength(1));

    expect(spies.published).toHaveLength(1);
    expect(spies.published[0].payload).toEqual({
      kind: 'email_mailbox_changed',
      workspace_id: WS,
      conversation_id: '',
      provider: 'gmail',
      history_id: '120',
      at: expect.any(String),
    });
    expect(spies.published[0].opts).toEqual({ skipConversationChannel: true });
    expect(spies.pushed[0]).toEqual({
      workspaceId: WS,
      threadId: '18c3f4a5b6c7d8e9',
      dedupeId: `gmail-${GMAIL_INT}-18c3f4a5b6c7d8ea`,
      provider: 'gmail',
    });
  });
});
