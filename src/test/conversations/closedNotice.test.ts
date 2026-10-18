// @vitest-environment node
/**
 * The visitor-visible closed line (server/services/conversationClosedNotice.ts):
 *
 *   - an operator's close of a WIDGET conversation of a workspace whose
 *     effective template draws it (t2) writes ONE system row
 *     {kind: 'conversation_closed', by, agent_*, operator_*, status} and
 *     publishes it like a message;
 *   - `default`, `intl` and `t1` workspaces get no row at all (their visitors'
 *     threads, lists and unread counts stay exactly as they were), and
 *     neither does a Telegram, Bale, WhatsApp, Instagram, email or platform
 *     support conversation;
 *   - never twice in a row: resolve → reopen → resolve with nothing said in
 *     between keeps the one line (a system notice in between does not count);
 *   - it never throws, and the operator's PATCH / "Send & resolve" answer
 *     the same whether it works or fails.
 *
 * The PATCH route and the post-send action run for real against an in-memory
 * data layer; only the effective template is a stand-in (its resolution is
 * pinned in src/test/widget/templateCatalogConfig.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createFakeServiceDb, fakeServiceClient, type FakeServiceDb, type Row } from './fakeServiceDb';

const state = vi.hoisted(() => ({
  db: null as unknown as FakeServiceDb,
  templates: {} as Record<string, string>,
  templateFails: false,
  published: [] as Array<{ ws: string; cid: string; envelope: { type: string; payload: Record<string, unknown> } }>,
  userId: '',
  rpc: async (): Promise<{ data: unknown; error: unknown }> => ({ data: null, error: null }),
}));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({ ...fakeServiceClient(state.db), rpc: (...a: unknown[]) => (state.rpc as (...x: unknown[]) => unknown)(...a) }),
}));
vi.mock('../../../server/services/widget/configSnapshot.js', async (orig) => {
  const real = await orig<typeof import('../../../server/services/widget/configSnapshot.js')>();
  const { chatWidgetTemplate } = await import('../../../shared/widgetTemplates.js');
  return {
    ...real,
    workspaceChatTemplate: async (_c: unknown, ws: string) => {
      if (state.templateFails) throw new Error('snapshot unavailable');
      const id = state.templates[ws] ?? 'default';
      return { id, descriptor: chatWidgetTemplate(id), options: {} };
    },
  };
});
vi.mock('../../../server/services/storage/urlResolver.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/storage/urlResolver.js')>()),
  hydrateUserAvatars: async (_c: unknown, rows: Row[]) => {
    for (const r of rows || []) { r.avatar_url = r.avatar_storage_key ? `https://cdn.test/${r.avatar_storage_key}` : null; delete r.avatar_storage_key; }
    return rows;
  },
}));
vi.mock('../../../server/services/realtime/publish.js', () => ({
  publishConversationEvent: async (_c: unknown, ws: string, cid: string, envelope: { type: string; payload: Record<string, unknown> }) => {
    state.published.push({ ws, cid, envelope });
    return { ok: true };
  },
  publishOperatorEvent: async () => undefined,
  buildMessageEnvelope: (m: Record<string, unknown>) => ({ type: 'message', payload: m }),
}));
vi.mock('../../../server/services/conversationEvents.js', () => ({
  recordConversationEvent: async () => ({ ok: true }),
  recordAuditAndEvent: async () => undefined,
}));
vi.mock('../../../server/lib/workspaceAuth.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/lib/workspaceAuth.js')>()),
  authorizeWorkspaceAccess: async () => ({ userId: state.userId, isAdmin: false, role: 'agent' }),
}));
vi.mock('../../../server/services/contactChatLocks.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/contactChatLocks.js')>()),
  conversationLockedNow: async () => ({ locked: false, state: null }),
}));
vi.mock('../../../server/services/notificationEmail/producers.js', () => ({ queueTranscript: async () => undefined }));
vi.mock('../../../server/services/platformSupport/service.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/platformSupport/service.js')>()),
  onSupportConversationChanged: async () => undefined,
}));

const { recordConversationClosed, latestClosedRow } = await import('../../../server/services/conversationClosedNotice.js');
const { applyPostSendAction } = await import('../../../server/services/conversationPostSend.js');
const { conversationsRouter } = await import('../../../server/routes/conversations.js');

const config = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } as never;
const app = express();
app.use((req, _res, next) => { Object.assign(req, { serverConfig: config }); next(); });
app.use(express.json());
app.use('/api/conversations', conversationsRouter);
const server = http.createServer(app).listen(0);

const WS = randomUUID();
const CLOSER = randomUUID();
const OPERATOR = randomUUID();

let clock = Date.parse('2026-10-18T09:00:00Z');
const tick = () => new Date((clock += 1000)).toISOString();

function conversation(fields: Row = {}): string {
  const id = randomUUID();
  (state.db.tables.conversations ||= []).push({
    id, workspace_id: WS, status: 'open', assigned_to: OPERATOR, metadata: {}, created_at: tick(), updated_at: tick(), ...fields,
  });
  return id;
}
function message(cid: string, sender_type: string, metadata: Row = {}): string {
  const id = randomUUID();
  (state.db.tables.conversation_messages ||= []).push({ id, conversation_id: cid, sender_type, body: 'hi', metadata, created_at: tick() });
  return id;
}
const closedRows = (cid: string) => (state.db.tables.conversation_messages || [])
  .filter((m) => m.conversation_id === cid && (m.metadata as Row | null)?.kind === 'conversation_closed');
const close = (cid: string, status: 'resolved' | 'closed' = 'resolved', ws = WS) =>
  recordConversationClosed(config, { workspaceId: ws, conversationId: cid, actorId: CLOSER, status });

function patch(cid: string, body: Row): Promise<{ status: number; body: Row }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: `/api/conversations/${cid}`, method: 'PATCH',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: JSON.parse(d || '{}') }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

beforeEach(() => {
  state.db = createFakeServiceDb();
  state.db.now = tick;
  state.db.tables.profiles = [
    { id: CLOSER, full_name: 'Ali', avatar_storage_key: null },
    { id: OPERATOR, full_name: 'سارا', avatar_storage_key: 'avatars/sara.png' },
  ];
  state.templates = { [WS]: 't2' };
  state.templateFails = false;
  state.published.length = 0;
  state.userId = CLOSER;
  state.rpc = async () => ({ data: null, error: null });
});

describe('the closed line on a template that draws it', () => {
  it('writes one visitor-visible system row naming the closer and the operator, and publishes it as a message', async () => {
    const cid = conversation();
    message(cid, 'contact');
    message(cid, 'agent');
    const out = await close(cid);
    const rows = closedRows(cid);
    expect(rows).toHaveLength(1);
    expect(out).toEqual({ id: rows[0].id });
    expect(rows[0]).toMatchObject({ sender_type: 'system', body: 'Ali closed the conversation' });
    expect(rows[0].metadata).toEqual({
      kind: 'conversation_closed',
      by: 'agent',
      agent_id: CLOSER,
      agent_name: 'Ali',
      operator_id: OPERATOR,
      operator_name: 'سارا',
      status: 'resolved',
    });
    // Not internal: /history, /poll and the realtime channel carry it.
    expect((rows[0].metadata as Row).internal).toBeUndefined();
    expect(state.published).toHaveLength(1);
    expect(state.published[0]).toMatchObject({ ws: WS, cid, envelope: { type: 'message' } });
    expect(state.published[0].envelope.payload).toMatchObject({ id: rows[0].id, sender_type: 'system', metadata: rows[0].metadata });
  });

  it('records `closed` too; with nobody assigned the closer is the operator; without a profile it says "An operator"', async () => {
    const cid = conversation({ assigned_to: null });
    await close(cid, 'closed');
    expect(closedRows(cid)[0].metadata).toMatchObject({ status: 'closed', operator_id: CLOSER, operator_name: 'Ali' });
    state.db.tables.profiles = [];
    const other = conversation();
    await close(other);
    expect(closedRows(other)[0]).toMatchObject({ body: 'An operator closed the conversation' });
    expect(closedRows(other)[0].metadata).toMatchObject({ agent_name: null, operator_name: null, operator_id: OPERATOR });
  });

  it('a conversation marked as the widget\'s own channel gets it too', async () => {
    const cid = conversation({ metadata: { channel: 'widget' } });
    expect(await close(cid)).not.toBeNull();
    expect(closedRows(cid)).toHaveLength(1);
  });
});

describe('no new row anywhere else', () => {
  for (const template of ['default', 'intl', 't1']) {
    it(`a ${template} workspace: nothing written, nothing published`, async () => {
      state.templates[WS] = template;
      const cid = conversation();
      message(cid, 'agent');
      expect(await close(cid)).toBeNull();
      expect(closedRows(cid)).toHaveLength(0);
      expect(state.db.inserts).toHaveLength(0);
      expect(state.published).toHaveLength(0);
    });
  }

  for (const channel of ['telegram', 'bale', 'whatsapp', 'instagram', 'email', 'platform_support']) {
    it(`a ${channel} conversation of a t2 workspace: nothing written`, async () => {
      const cid = conversation({ metadata: { channel } });
      expect(await close(cid)).toBeNull();
      expect(state.db.inserts).toHaveLength(0);
    });
  }

  it('another workspace\'s conversation id: nothing written', async () => {
    const cid = conversation();
    expect(await close(cid, 'resolved', randomUUID())).toBeNull();
    expect(state.db.inserts).toHaveLength(0);
  });
});

describe('never twice in a row', () => {
  it('resolve → reopen → resolve with nothing said keeps the one line; a system notice in between does not count', async () => {
    const cid = conversation();
    message(cid, 'agent');
    await close(cid);
    expect(await close(cid)).toBeNull();
    message(cid, 'system', { kind: 'routing_agent_joined', agent_name: 'Reza' });
    message(cid, 'system', { kind: 'conversation_unassigned', internal: true });
    expect(await close(cid)).toBeNull();
    expect(closedRows(cid)).toHaveLength(1);
    // Somebody spoke: a new closure, a new line.
    message(cid, 'contact');
    expect(await close(cid)).not.toBeNull();
    expect(closedRows(cid)).toHaveLength(2);
  });

  it('two closes of one conversation at the same moment (two PATCHes, a PATCH and "Send & resolve") write one line', async () => {
    const cid = conversation();
    message(cid, 'agent');
    const outs = await Promise.all([close(cid), close(cid, 'closed'), close(cid)]);
    expect(closedRows(cid)).toHaveLength(1);
    expect(outs.filter(Boolean)).toHaveLength(1);
    expect(state.published).toHaveLength(1);
    // Another conversation is not held up by this one.
    const other = conversation();
    const [a, b] = await Promise.all([close(cid), close(other)]);
    expect(a).toBeNull();
    expect(b).not.toBeNull();
    // Two PATCHes racing through the real route: one line.
    const raced = conversation();
    message(raced, 'agent');
    const [p1, p2] = await Promise.all([
      patch(raced, { workspace_id: WS, status: 'resolved' }),
      patch(raced, { workspace_id: WS, status: 'resolved' }),
    ]);
    expect([p1.status, p2.status]).toEqual([200, 200]);
    await new Promise((r) => setTimeout(r, 30));
    expect(closedRows(raced)).toHaveLength(1);
  });

  it('latestClosedRow: the newest closed line nothing was said after', () => {
    const closed = { id: 'c', sender_type: 'system', created_at: '3', metadata: { kind: 'conversation_closed' } };
    const join = { id: 'j', sender_type: 'system', created_at: '4', metadata: { kind: 'routing_agent_joined' } };
    const note = { id: 'n', sender_type: 'system', created_at: '5', metadata: { internal: true } };
    const reply = { id: 'r', sender_type: 'agent', created_at: '6', metadata: {} };
    expect(latestClosedRow([note, join, closed])).toBe(closed);
    expect(latestClosedRow([reply, closed])).toBeNull();
    expect(latestClosedRow([{ ...reply, sender_type: 'ai' }, closed])).toBeNull();
    expect(latestClosedRow([join])).toBeNull();
    expect(latestClosedRow([])).toBeNull();
  });
});

describe('never fails or holds up the operator', () => {
  it('a failing template lookup, insert or read returns null and throws nothing', async () => {
    const cid = conversation();
    state.templateFails = true;
    await expect(close(cid)).resolves.toBeNull();
    state.templateFails = false;
    state.db.failing.add('conversation_messages');
    await expect(close(cid)).resolves.toBeNull();
    state.db.failing.clear();
    state.db.failing.add('conversations');
    await expect(close(cid)).resolves.toBeNull();
    expect(state.db.inserts).toHaveLength(0);
  });

  it('PATCH open → resolved writes the line once; a second PATCH to closed adds none', async () => {
    const cid = conversation();
    message(cid, 'agent');
    const res = await patch(cid, { workspace_id: WS, status: 'resolved' });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(closedRows(cid)).toHaveLength(1));
    expect(closedRows(cid)[0].metadata).toMatchObject({ status: 'resolved', agent_id: CLOSER, operator_id: OPERATOR });
    // resolved → closed is no new closure.
    expect((await patch(cid, { workspace_id: WS, status: 'closed' })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(closedRows(cid)).toHaveLength(1);
  });

  it('PATCH answers 200 whether the line can be written or not, and writes none for a default workspace', async () => {
    const cid = conversation();
    state.templateFails = true;
    expect((await patch(cid, { workspace_id: WS, status: 'resolved' })).status).toBe(200);
    state.templateFails = false;
    state.templates[WS] = 'default';
    const other = conversation();
    expect((await patch(other, { workspace_id: WS, status: 'closed' })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(closedRows(cid)).toHaveLength(0);
    expect(closedRows(other)).toHaveLength(0);
  });

  it('"Send & resolve" writes the line after the reply; "Send & wait" does not', async () => {
    const cid = conversation();
    const reply = message(cid, 'agent');
    // The post-send RPC: the transition happened.
    state.rpc = async () => ({ data: [{ changed: true, new_status: 'resolved', changed_at: tick() }], error: null });
    const waited = await applyPostSendAction(config, { action: 'wait_for_customer', workspaceId: WS, conversationId: cid, actorId: CLOSER, messageId: reply });
    expect(waited.changed).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(closedRows(cid)).toHaveLength(0);
    const resolved = await applyPostSendAction(config, { action: 'resolve', workspaceId: WS, conversationId: cid, actorId: CLOSER, messageId: reply });
    expect(resolved).toMatchObject({ changed: true, status: 'resolved' });
    await vi.waitFor(() => expect(closedRows(cid)).toHaveLength(1));
    const rows = state.db.tables.conversation_messages;
    expect(rows[rows.length - 1].metadata).toMatchObject({ kind: 'conversation_closed', status: 'resolved' });
  });
});
