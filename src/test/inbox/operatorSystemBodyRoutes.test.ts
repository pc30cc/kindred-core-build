// @vitest-environment node
/**
 * The operator read APIs write a system row's `body` in the requesting
 * operator's language (profiles.preferred_locale, else the platform's), for
 * the installed native apps that print `body` for a kind they lack
 * (conversation_closed, support_rating) and windows-native, which prints it
 * for every kind in its list:
 *
 *   GET /api/conversations                 last_message.body / system_meta
 *   GET /api/conversations/:id/messages    every system row (?since too)
 *   GET /api/contacts/:id/conversations    last_message_body / last_message_meta
 *
 * Stored rows are not rewritten; `metadata` keeps its values apart from the
 * English stand-in names ('a colleague'), nulled. The REAL routers run
 * against fakeServiceDb.ts; membership, the plan gates and avatars are
 * stand-ins.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createFakeServiceDb, fakeServiceClient, type FakeServiceDb, type Row } from '../conversations/fakeServiceDb';

const state = vi.hoisted(() => ({
  db: null as unknown as FakeServiceDb,
  user: 'sara',
}));

// The `?since` delta reads `updated_at > bound`; the fake has `gte`, which
// for these rows answers the same.
vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => {
    const client = fakeServiceClient(state.db);
    return {
      ...client,
      from(table: string) {
        const builder = client.from(table) as unknown as Record<string, (...args: unknown[]) => unknown>;
        builder.gt ??= (col: unknown, value: unknown) => builder.gte(col, value);
        return builder;
      },
    };
  },
}));
vi.mock('../../../server/lib/workspaceAuth.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/lib/workspaceAuth.js')>()),
  authorizeWorkspaceAccess: async () => ({ userId: state.user, isAdmin: false, role: 'owner' }),
}));
vi.mock('../../../server/services/contactChatLocks.js', async (orig) => {
  const real = await orig<typeof import('../../../server/services/contactChatLocks.js')>();
  return {
    ...real,
    resolveContactChatLocks: async () => real.unlockedState(),
    conversationLockedNow: async () => ({ locked: false, state: real.unlockedState() }),
  };
});
vi.mock('../../../server/middleware/featureGating.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/middleware/featureGating.js')>()),
  enforceModule: async () => true,
}));
vi.mock('../../../server/services/storage/urlResolver.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/storage/urlResolver.js')>()),
  hydrateUserAvatars: async (_c: unknown, rows: Row[]) => rows.map((r) => ({ ...r, avatar_url: null })),
  hydrateContactAvatars: async () => undefined,
}));

const { conversationsRouter } = await import('../../../server/routes/conversations.js');
const { contactsRouter } = await import('../../../server/routes/contacts.js');
const { __resetOperatorLocaleCache } = await import('../../../server/services/operatorLocale.js');
const { __resetPlatformRegionCache } = await import('../../../server/services/platformRegion.js');

const app = express();
app.use((req, _res, next) => { Object.assign(req, { serverConfig: { supabaseUrl: 'https://x.test', supabaseServiceRoleKey: 'k' } }); next(); });
app.use(express.json());
app.use('/api/conversations', conversationsRouter);
app.use('/api/contacts', contactsRouter);
const server = http.createServer(app).listen(0);

const WS = '11111111-1111-4111-8111-111111111111';
const CONTACT = '22222222-2222-4222-8222-222222222222';

type Json = Record<string, unknown>;
function get(path: string): Promise<{ status: number; body: Json }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, path }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: d ? JSON.parse(d) : {} }));
    }).on('error', reject);
  });
}

let seq = 0;
function conversation(): string {
  const id = randomUUID();
  const at = new Date(Date.parse('2026-10-18T08:00:00Z') + seq++ * 1000).toISOString();
  (state.db.tables.conversations ||= []).push({
    id, workspace_id: WS, contact_id: CONTACT, status: 'open', is_spam: false, ai_state: null,
    assigned_to: null, metadata: { channel: 'widget' }, created_at: at, updated_at: at,
  });
  return id;
}
function message(cid: string, sender_type: string, body: string, metadata: Row = {}): string {
  const id = randomUUID();
  const at = new Date(Date.parse('2026-10-18T08:00:00Z') + seq++ * 1000).toISOString();
  (state.db.tables.conversation_messages ||= []).push({
    id, conversation_id: cid, sender_type, sender_id: null, body, metadata, created_at: at, updated_at: at,
  });
  return id;
}

const QUEUE = { kind: 'routing_in_queue' };
const CLOSED = { kind: 'conversation_closed', by: 'agent', agent_id: 'sara', agent_name: 'Sara', operator_id: 'sara', operator_name: 'Sara', status: 'resolved' };
const RATING = { kind: 'support_rating', internal: true, score: 4, comment: 'خوب بود' };
const JOINED = { kind: 'routing_agent_joined', agent_name: 'a colleague', agent_id: 'ali' };

function preferred(locale: string | null) {
  state.db.tables.profiles = [{ id: 'sara', full_name: 'Sara', email: 'sara@x.test', preferred_locale: locale }];
}

beforeEach(() => {
  state.db = createFakeServiceDb();
  state.db.tables.platform_settings = [{ id: 1, region_mode: 'multi', active_locales: ['en', 'fa', 'tr'], default_locale: 'en' }];
  state.db.tables.contacts = [{ id: CONTACT, workspace_id: WS, name: 'Mina', email: null, created_at: '2026-10-01T00:00:00Z', metadata: {} }];
  state.user = 'sara';
  preferred('fa');
  __resetOperatorLocaleCache();
  __resetPlatformRegionCache();
});

describe('GET /api/conversations/:id/messages', () => {
  it('a Persian operator reads the queue, closed and rating rows in Persian', async () => {
    const cid = conversation();
    message(cid, 'contact', 'سلام');
    message(cid, 'system', 'Your message is in the support queue.', QUEUE);
    message(cid, 'system', 'Sara closed the conversation', CLOSED);
    message(cid, 'system', 'Rated 4/5: خوب بود', RATING);
    const res = await get(`/api/conversations/${cid}/messages`);
    expect(res.status).toBe(200);
    const rows = res.body.messages as Json[];
    expect(rows.map((m) => m.body)).toEqual([
      'سلام',
      'کاربر در صف پشتیبانی منتظر است',
      'Sara گفتگو را بست',
      'به این گفتگو 4 از ۵ امتیاز داد — «خوب بود»',
    ]);
    // The kind and the rest of the metadata are as stored.
    expect(rows[2].metadata).toEqual(CLOSED);
    expect(rows[3].metadata).toEqual(RATING);
    // Nothing was written back.
    expect(state.db.tables.conversation_messages.map((m) => m.body)).toContain('Your message is in the support queue.');
  });

  it('an English operator reads the English sentence', async () => {
    preferred('en');
    const cid = conversation();
    message(cid, 'system', 'Your message is in the support queue.', QUEUE);
    message(cid, 'system', 'Sara closed the conversation', CLOSED);
    const rows = (await get(`/api/conversations/${cid}/messages`)).body.messages as Json[];
    expect(rows.map((m) => m.body)).toEqual(['The visitor is waiting in the support queue', 'Sara closed the conversation']);
  });

  it('an operator with no language of their own reads the platform default', async () => {
    preferred(null);
    state.db.tables.platform_settings[0].default_locale = 'tr';
    const cid = conversation();
    message(cid, 'system', 'Your message is in the support queue.', QUEUE);
    const rows = (await get(`/api/conversations/${cid}/messages`)).body.messages as Json[];
    expect(rows[0].body).toBe('Ziyaretçi destek kuyruğunda bekliyor');
  });

  it("nulls 'a colleague' in the metadata and writes the generic join", async () => {
    const cid = conversation();
    message(cid, 'system', 'a colleague joined the conversation.', JOINED);
    const rows = (await get(`/api/conversations/${cid}/messages`)).body.messages as Json[];
    expect(rows[0].body).toBe('یکی از همکاران به گفتگو پیوست');
    expect(rows[0].metadata).toEqual({ ...JOINED, agent_name: null });
  });

  it('keeps the stored body of a kind it cannot write, and of every non-system row', async () => {
    const cid = conversation();
    message(cid, 'system', 'Something new', { kind: 'something_new' });
    message(cid, 'agent', 'Your message is in the support queue.', QUEUE);
    const rows = (await get(`/api/conversations/${cid}/messages`)).body.messages as Json[];
    expect(rows.map((m) => m.body)).toEqual(['Something new', 'Your message is in the support queue.']);
  });

  it('localizes the rows of a ?since delta too', async () => {
    const cid = conversation();
    message(cid, 'contact', 'hi');
    const first = await get(`/api/conversations/${cid}/messages`);
    const cursor = (first.body.sync as Json).cursor as string;
    expect(cursor).toBeTruthy();
    message(cid, 'system', 'Your message is in the support queue.', QUEUE);
    const delta = await get(`/api/conversations/${cid}/messages?since=${encodeURIComponent(cursor)}`);
    expect((delta.body.sync as Json).mode).toBe('delta');
    const rows = delta.body.messages as Json[];
    expect(rows.find((m) => (m.metadata as Json)?.kind === 'routing_in_queue')?.body).toBe('کاربر در صف پشتیبانی منتظر است');
  });
});

describe('GET /api/conversations', () => {
  it("writes a system preview's body in the operator's language and keeps system_kind and system_meta", async () => {
    const cid = conversation();
    message(cid, 'contact', 'سلام');
    message(cid, 'system', 'Sara closed the conversation', CLOSED);
    const res = await get(`/api/conversations?workspace_id=${WS}&queue=main&scope=all`);
    expect(res.status).toBe(200);
    const row = (res.body.conversations as Json[]).find((c) => c.id === cid)!;
    const last = row.last_message as Json;
    expect(last.body).toBe('Sara گفتگو را بست');
    expect(last.system_kind).toBe('conversation_closed');
    expect(last.system_meta).toEqual(CLOSED);
  });

  it("an English operator's preview is the English sentence; the stand-in name is nulled", async () => {
    preferred('en');
    const cid = conversation();
    message(cid, 'system', 'a colleague joined the conversation.', JOINED);
    const res = await get(`/api/conversations?workspace_id=${WS}&queue=main&scope=all`);
    const last = (res.body.conversations as Json[]).find((c) => c.id === cid)!.last_message as Json;
    expect(last.body).toBe('A colleague joined the conversation');
    expect(last.system_meta).toEqual({ ...JOINED, agent_name: null });
  });
});

describe('GET /api/contacts/:id/conversations', () => {
  it("writes the last system row's body in the operator's language", async () => {
    const cid = conversation();
    message(cid, 'contact', 'سلام');
    message(cid, 'system', 'Your message is in the support queue.', QUEUE);
    const res = await get(`/api/contacts/${CONTACT}/conversations`);
    expect(res.status).toBe(200);
    const row = (res.body.conversations as Json[]).find((c) => c.id === cid)!;
    expect(row.last_message_body).toBe('کاربر در صف پشتیبانی منتظر است');
    expect(row.last_message_meta).toEqual(QUEUE);
  });
});
