/**
 * GET /api/widget/identity/history (findContinuableConversation) hands back
 * only a LIVE conversation (open, pending, resolved; one current
 * conversation per visitor, 2026-10-24), whatever its age: never a closed
 * one (the 30-day window that resumed any status is gone), another channel's
 * conversation of the same contact, or an unanswered greeting. A verified
 * contact's live thread from another device still resumes.
 *
 * The REAL widgetIdentityRouter and findContinuableConversation run on the
 * shared in-memory fake.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createFakeServiceDb, fakeServiceClient, type FakeServiceDb, type Row } from '../conversations/fakeServiceDb';

const WS = '22222222-2222-4222-8222-222222222222';
const VISITOR = 'visitor-1';
const SESSION = '33333333-3333-4333-8333-333333333333';
const OTHER_DEVICE_SESSION = '44444444-4444-4444-8444-444444444444';
const PROVEN_CONTACT = '55555555-5555-4555-8555-555555555555';

const state = vi.hoisted(() => ({ db: null as unknown as FakeServiceDb }));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeServiceClient(state.db) }));
vi.mock('../../../server/services/widget/security.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/security.js')>()),
  enforceWidgetToken: (_req: unknown, _res: unknown, next: () => void) => next(),
  enforceOrigin: (_req: unknown, _res: unknown, next: () => void) => next(),
  widgetRateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  resolveWorkspaceId: (_req: unknown, _res: unknown, wsId: string) => wsId || '22222222-2222-4222-8222-222222222222',
}));
vi.mock('../../../server/services/widget/visitorIdentity.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/visitorIdentity.js')>()),
  readVisitorCookie: () => ({ v: 'visitor-1', w: '22222222-2222-4222-8222-222222222222', exp: Math.floor(Date.now() / 1000) + 3600 }),
}));
vi.mock('../../../server/routes/widgetAttachments.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/routes/widgetAttachments.js')>()),
  enrichMessagesWithAttachments: async (_c: unknown, _w: string, m: unknown[]) => m,
  enrichMessagesWithReplyTo: async (_c: unknown, _id: string, m: unknown[]) => m,
}));

const { widgetIdentityRouter } = await import('../../../server/routes/widgetIdentity.js');
const { findContinuableConversation } = await import('../../../server/services/widget/identityMerge.js');

const app = express();
app.use((req, _res, next) => {
  (req as unknown as Row).serverConfig = { supabaseUrl: 'https://x.test', supabaseServiceRoleKey: 'k' };
  next();
});
app.use(express.json());
app.use('/api/widget/identity', widgetIdentityRouter);
const server = http.createServer(app).listen(0);
afterAll(() => { server.close(); });

function history(): Promise<Row> {
  return new Promise((resolve, reject) => {
    http.get({
      host: '127.0.0.1', port: (server.address() as AddressInfo).port,
      path: `/api/widget/identity/history?workspace_id=${WS}`, headers: { 'X-Widget-Token': 'wss_test' },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d) as Row); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

const daysAgo = (d: number) => new Date(Date.now() - d * 86400_000).toISOString();
function conversation(fields: Row = {}): Row {
  const row: Row = { id: randomUUID(), workspace_id: WS, status: 'open', contact_id: null, visitor_session_id: SESSION, assigned_to: null, metadata: {}, updated_at: daysAgo(1), ...fields };
  state.db.tables.conversations.push(row);
  return row;
}
function message(conversationId: unknown, senderType: string, fields: Row = {}): void {
  state.db.tables.conversation_messages.push({ id: randomUUID(), conversation_id: conversationId, sender_type: senderType, body: 'سلام', metadata: {}, created_at: daysAgo(1), ...fields });
}
const find = (contactId: string | null = null) => findContinuableConversation(fakeServiceClient(state.db) as never, WS, VISITOR, contactId);

beforeEach(() => {
  state.db = createFakeServiceDb();
  state.db.honourOr = true;
  state.db.tables.visitor_sessions = [{ id: SESSION, workspace_id: WS, visitor_id: VISITOR, contact_id: null, last_seen_at: daysAgo(0) }];
  state.db.tables.conversations = [];
  state.db.tables.conversation_messages = [];
});

describe('findContinuableConversation: live only', () => {
  it('never a closed one, however recent; the live one however old', async () => {
    conversation({ status: 'closed', updated_at: daysAgo(0) });
    expect(await find()).toBeNull();
    const old = conversation({ status: 'resolved', updated_at: daysAgo(90) });
    expect(await find()).toEqual({ id: old.id, updatedAt: old.updated_at });
  });

  for (const status of ['open', 'pending', 'resolved']) {
    it(`${status} is live`, async () => {
      const live = conversation({ status });
      expect((await find())?.id).toBe(live.id);
    });
  }

  it('skips an unanswered greeting and another channel\'s conversation', async () => {
    const greeting = conversation({ metadata: { source: 'ai_agent_intro', ai_state: 'ai_managed' }, updated_at: daysAgo(0) });
    message(greeting.id, 'ai', { metadata: { source: 'ai_agent_intro' } });
    conversation({ metadata: { channel: 'whatsapp' }, updated_at: daysAgo(0) });
    expect(await find()).toBeNull();
    const mine = conversation({ updated_at: daysAgo(3) });
    expect((await find())?.id).toBe(mine.id);
  });

  it('a verified contact\'s live thread from another device resumes', async () => {
    const theirs = conversation({ contact_id: PROVEN_CONTACT, visitor_session_id: OTHER_DEVICE_SESSION });
    expect(await find()).toBeNull();
    expect((await find(PROVEN_CONTACT))?.id).toBe(theirs.id);
  });
});

describe('GET /api/widget/identity/history', () => {
  it('only ended threads: nothing to resume', async () => {
    const closed = conversation({ status: 'closed', updated_at: daysAgo(0) });
    message(closed.id, 'contact');
    const res = await history();
    expect(res).toMatchObject({ conversation_id: null, messages: [] });
  });

  it('the live thread and its messages', async () => {
    conversation({ status: 'closed', updated_at: daysAgo(0) });
    const live = conversation({ status: 'pending', updated_at: daysAgo(2) });
    message(live.id, 'agent', { body: 'منتظر پاسخ شما هستیم' });
    const res = await history();
    expect(res.conversation_id).toBe(live.id);
    expect((res.messages as Row[]).map((m) => m.text)).toEqual(['منتظر پاسخ شما هستیم']);
  });
});
