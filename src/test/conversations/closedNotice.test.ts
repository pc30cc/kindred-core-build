// @vitest-environment node
/**
 * The visitor-visible closed line (server/services/conversationClosedNotice.ts):
 *
 *   - an operator's close (status `closed`) of a WIDGET conversation of a
 *     workspace whose effective template draws it (every template since one
 *     conversation per visitor, 2026-10-24) writes ONE system row
 *     {kind: 'conversation_closed', by, agent_*, operator_*, status} and
 *     publishes it like a message;
 *   - a resolve writes nothing, neither the inbox's PATCH nor "Send &
 *     resolve" (owner, 2026-10-24: resolved is still live for the visitor,
 *     whose next message reopens it); closing a resolved one later does;
 *   - so `default`, `intl` and `t1` workspaces get it too (their renderers
 *     draw it), while a Telegram, Bale, WhatsApp, Instagram, email or
 *     platform support conversation never does, nor a workspace whose
 *     template cannot be read;
 *   - never twice in a row: close → reopen → close with nothing said in
 *     between keeps the one line (a system notice in between does not count;
 *     the line an older server wrote on a resolve is not one, but a close
 *     right after one the visitor rated keeps that rating: one card, one
 *     rating);
 *   - it never throws, and the operator's PATCH / "Send & resolve" answer
 *     the same whether it works or fails;
 *   - the system's close after the quiet period (migration 284) prepares
 *     the nameless line (prepareClosedLine by 'system'), which the SQL close
 *     inserts; the rating is about the assignee who wrote, else the newest
 *     person who wrote, else (an operator's close) the closer
 *     (ratedOperatorOf); the PATCH writes an operator's close markers and a
 *     move out of closed clears them.
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
const { CHAT_WIDGET_TEMPLATES } = await import('../../../shared/widgetTemplates.js');
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
/** A row of the conversation; an agent row is OPERATOR's unless `sender` says whose. */
function message(cid: string, sender_type: string, metadata: Row = {}, sender: string | null = sender_type === 'agent' ? OPERATOR : null): string {
  const id = randomUUID();
  (state.db.tables.conversation_messages ||= []).push({ id, conversation_id: cid, sender_type, sender_id: sender, body: 'hi', metadata, created_at: tick() });
  return id;
}
const closedRows = (cid: string) => (state.db.tables.conversation_messages || [])
  .filter((m) => m.conversation_id === cid && (m.metadata as Row | null)?.kind === 'conversation_closed');
const close = (cid: string, ws = WS) =>
  recordConversationClosed(config, { workspaceId: ws, conversationId: cid, actorId: CLOSER, status: 'closed' });

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
      status: 'closed',
    });
    // Not internal: /history, /poll and the realtime channel carry it.
    expect((rows[0].metadata as Row).internal).toBeUndefined();
    expect(state.published).toHaveLength(1);
    expect(state.published[0]).toMatchObject({ ws: WS, cid, envelope: { type: 'message' } });
    expect(state.published[0].envelope.payload).toMatchObject({ id: rows[0].id, sender_type: 'system', metadata: rows[0].metadata });
  });

  it('a resolve is no close: nothing written, nothing published', async () => {
    const cid = conversation();
    message(cid, 'agent');
    const resolve = { workspaceId: WS, conversationId: cid, actorId: CLOSER, status: 'resolved' } as unknown as Parameters<typeof recordConversationClosed>[1];
    expect(await recordConversationClosed(config, resolve)).toBeNull();
    expect(state.db.inserts).toHaveLength(0);
    expect(state.published).toHaveLength(0);
  });

  it('with nobody who wrote the closer is the operator; without a profile it says "An operator"', async () => {
    const cid = conversation({ assigned_to: null });
    await close(cid);
    expect(closedRows(cid)[0].metadata).toMatchObject({ status: 'closed', operator_id: CLOSER, operator_name: 'Ali' });
    state.db.tables.profiles = [];
    // Assigned to OPERATOR, who never wrote: no credit for an answer nobody gave.
    const other = conversation();
    await close(other);
    expect(closedRows(other)[0]).toMatchObject({ body: 'An operator closed the conversation' });
    expect(closedRows(other)[0].metadata).toMatchObject({ agent_name: null, operator_name: null, operator_id: CLOSER });
  });

  it('a conversation marked as the widget\'s own channel gets it too', async () => {
    const cid = conversation({ metadata: { channel: 'widget' } });
    expect(await close(cid)).not.toBeNull();
    expect(closedRows(cid)).toHaveLength(1);
  });
});

describe('every template draws it (one conversation per visitor)', () => {
  for (const [template, descriptor] of Object.entries(CHAT_WIDGET_TEMPLATES)) {
    it(`a ${template} workspace: the one row, published`, async () => {
      expect(descriptor.closedNotice).toBe(true);
      state.templates[WS] = template;
      const cid = conversation();
      message(cid, 'agent');
      expect(await close(cid)).not.toBeNull();
      expect(closedRows(cid)).toHaveLength(1);
      expect(state.published).toHaveLength(1);
    });
  }
});

describe('no new row anywhere else', () => {
  it('a workspace whose template cannot be read: nothing written, nothing published', async () => {
    state.templateFails = true;
    const cid = conversation();
    message(cid, 'agent');
    expect(await close(cid)).toBeNull();
    expect(state.db.inserts).toHaveLength(0);
    expect(state.published).toHaveLength(0);
  });

  for (const channel of ['telegram', 'bale', 'whatsapp', 'instagram', 'email', 'platform_support']) {
    it(`a ${channel} conversation of a t2 workspace: nothing written`, async () => {
      const cid = conversation({ metadata: { channel } });
      expect(await close(cid)).toBeNull();
      expect(state.db.inserts).toHaveLength(0);
    });
  }

  it('another workspace\'s conversation id: nothing written', async () => {
    const cid = conversation();
    expect(await close(cid, randomUUID())).toBeNull();
    expect(state.db.inserts).toHaveLength(0);
  });
});

describe('never twice in a row', () => {
  it('close → reopen → close with nothing said keeps the one line; a system notice in between does not count', async () => {
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

  it('two closes of one conversation at the same moment (two PATCHes) write one line', async () => {
    const cid = conversation();
    message(cid, 'agent');
    const outs = await Promise.all([close(cid), close(cid), close(cid)]);
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
      patch(raced, { workspace_id: WS, status: 'closed' }),
      patch(raced, { workspace_id: WS, status: 'closed' }),
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
    // The line an older server wrote on a resolve is none.
    const resolveLine = { id: 'o', sender_type: 'system', created_at: '7', metadata: { kind: 'conversation_closed', status: 'resolved' } };
    expect(latestClosedRow([resolveLine])).toBeNull();
    expect(latestClosedRow([resolveLine, closed])).toBe(closed);
  });

  it('a close after the line an older server wrote on a resolve, with nothing said since, writes its own', async () => {
    const cid = conversation({ status: 'resolved' });
    message(cid, 'agent');
    message(cid, 'system', { kind: 'conversation_closed', by: 'agent', status: 'resolved', operator_id: OPERATOR, operator_name: 'سارا' });
    const out = await close(cid);
    expect(out).not.toBeNull();
    expect(closedRows(cid).map((m) => (m.metadata as Row).status)).toEqual(['resolved', 'closed']);
  });

  it('…and when the visitor rated that resolve line, the close is that same closure: its rating, no second card, one rating', async () => {
    const { csatState, rateClosedConversation } = await import('../../../server/services/conversationRatings.js');
    const at = Date.parse('2026-10-18T10:00:00Z');
    const cid = conversation({ status: 'resolved' });
    message(cid, 'agent');
    const resolveLine = message(cid, 'system', { kind: 'conversation_closed', by: 'agent', status: 'resolved', operator_id: OPERATOR, operator_name: 'سارا' });
    state.db.tables.conversation_ratings = [{
      id: randomUUID(), workspace_id: WS, conversation_id: cid, closed_message_id: resolveLine, operator_id: OPERATOR, score: 4, comment: null, created_at: tick(),
    }];
    const out = await close(cid);
    expect(out).not.toBeNull();
    expect(closedRows(cid).find((m) => m.id === out!.id)?.metadata).toMatchObject({ status: 'closed', rated_line_id: resolveLine });
    expect(await csatState(config, { workspaceId: WS, conversationId: cid, csatEnabled: true }, at))
      .toMatchObject({ closed_id: out!.id, rateable: false, rating: { score: 4 } });
    await expect(rateClosedConversation(config, { workspaceId: WS, conversationId: cid, closedId: out!.id, score: 1, comment: null }, at))
      .rejects.toMatchObject({ status: 409, code: 'already_rated', rating: { score: 4 } });
    expect(state.db.tables.conversation_ratings).toHaveLength(1);
  });

  it('a resolve line nobody rated, or one something was said after: the close is rated on its own', async () => {
    const { csatState } = await import('../../../server/services/conversationRatings.js');
    const at = Date.parse('2026-10-18T10:00:00Z');
    const unrated = conversation({ status: 'resolved' });
    message(unrated, 'contact');
    message(unrated, 'agent');
    message(unrated, 'system', { kind: 'conversation_closed', by: 'agent', status: 'resolved', operator_id: OPERATOR });
    state.db.tables.conversation_ratings = [];
    const first = await close(unrated);
    expect((closedRows(unrated).find((m) => m.id === first!.id)?.metadata as Row).rated_line_id).toBeUndefined();
    expect(await csatState(config, { workspaceId: WS, conversationId: unrated, csatEnabled: true }, at))
      .toMatchObject({ closed_id: first!.id, rateable: true, rating: null });

    const movedOn = conversation({ status: 'resolved' });
    message(movedOn, 'agent');
    const old = message(movedOn, 'system', { kind: 'conversation_closed', by: 'agent', status: 'resolved', operator_id: OPERATOR });
    state.db.tables.conversation_ratings.push({ id: randomUUID(), workspace_id: WS, conversation_id: movedOn, closed_message_id: old, score: 5, created_at: tick() });
    message(movedOn, 'contact');
    message(movedOn, 'agent');
    const second = await close(movedOn);
    expect((closedRows(movedOn).find((m) => m.id === second!.id)?.metadata as Row).rated_line_id).toBeUndefined();
    expect(await csatState(config, { workspaceId: WS, conversationId: movedOn, csatEnabled: true }, at))
      .toMatchObject({ closed_id: second!.id, rateable: true, rating: null });
  });
});

describe('the system\'s close after the quiet period (migration 284): prepareClosedLine by \'system\'', () => {
  it('the nameless line: body, agent_* null, closed_reason, the operator who wrote, nothing written yet', async () => {
    const { prepareClosedLine } = await import('../../../server/services/conversationClosedNotice.js');
    const cid = conversation();
    message(cid, 'contact');
    message(cid, 'agent');
    const line = await prepareClosedLine(config, { workspaceId: WS, conversationId: cid, by: 'system' });
    expect(line).toEqual({
      body: 'The conversation was closed',
      metadata: {
        kind: 'conversation_closed', by: 'system', closed_reason: 'inactivity',
        agent_id: null, agent_name: null, operator_id: OPERATOR, operator_name: 'سارا', status: 'closed',
      },
    });
    // Prepared only: the SQL close inserts it, the ticker publishes it.
    expect(state.db.inserts).toHaveLength(0);
    expect(state.published).toHaveLength(0);
    // An actor passed by mistake is no closer of a system close.
    expect((await prepareClosedLine(config, { workspaceId: WS, conversationId: cid, by: 'system', actorId: CLOSER }))!.metadata)
      .toMatchObject({ agent_id: null, agent_name: null, operator_id: OPERATOR });
  });

  it('an AI-only conversation: nobody to name (the workspace mark on the card)', async () => {
    const { prepareClosedLine } = await import('../../../server/services/conversationClosedNotice.js');
    const cid = conversation({ assigned_to: null });
    message(cid, 'contact');
    message(cid, 'ai');
    expect((await prepareClosedLine(config, { workspaceId: WS, conversationId: cid, by: 'system' }))!.metadata)
      .toMatchObject({ by: 'system', operator_id: null, operator_name: null, agent_name: null });
  });

  it('null when the thread already ends with a line, or for another channel; a rated resolve line is carried', async () => {
    const { prepareClosedLine } = await import('../../../server/services/conversationClosedNotice.js');
    const cid = conversation();
    message(cid, 'agent');
    await close(cid);
    expect(await prepareClosedLine(config, { workspaceId: WS, conversationId: cid, by: 'system' })).toBeNull();
    const telegram = conversation({ metadata: { channel: 'telegram' } });
    message(telegram, 'contact');
    expect(await prepareClosedLine(config, { workspaceId: WS, conversationId: telegram, by: 'system' })).toBeNull();

    const rated = conversation({ status: 'resolved' });
    message(rated, 'agent');
    const resolveLine = message(rated, 'system', { kind: 'conversation_closed', by: 'agent', status: 'resolved', operator_id: OPERATOR });
    state.db.tables.conversation_ratings = [{ id: randomUUID(), workspace_id: WS, conversation_id: rated, closed_message_id: resolveLine, score: 5, created_at: tick() }];
    expect((await prepareClosedLine(config, { workspaceId: WS, conversationId: rated, by: 'system' }))!.metadata)
      .toMatchObject({ by: 'system', rated_line_id: resolveLine });
  });
});

describe('ratedOperatorOf: who a closure\'s rating is about (decision 15)', () => {
  it('the assignee who wrote, else the newest person who wrote, else the closer (an operator\'s close only), else nobody', async () => {
    const { ratedOperatorOf } = await import('../../../server/services/conversationClosedNotice.js');
    const sb = fakeServiceClient(state.db) as never;
    const REZA = randomUUID();
    const wrote = conversation();
    message(wrote, 'agent', {}, OPERATOR);
    message(wrote, 'agent', {}, REZA);
    expect(await ratedOperatorOf(sb, { id: wrote, assigned_to: OPERATOR }, CLOSER)).toBe(OPERATOR);
    // The assignee never wrote: the newest person who did.
    const other = conversation();
    message(other, 'agent', {}, CLOSER);
    message(other, 'agent', {}, REZA);
    expect(await ratedOperatorOf(sb, { id: other, assigned_to: OPERATOR }, CLOSER)).toBe(REZA);
    // Nobody wrote: the closer, for an operator's close; nobody for the system's.
    const silent = conversation();
    message(silent, 'ai');
    expect(await ratedOperatorOf(sb, { id: silent, assigned_to: OPERATOR }, CLOSER)).toBe(CLOSER);
    expect(await ratedOperatorOf(sb, { id: silent, assigned_to: OPERATOR }, null)).toBeNull();
    expect(await ratedOperatorOf(sb, { id: silent, assigned_to: null })).toBeNull();
  });
});

describe('the close markers on the PATCH (shared/inactivityClose.ts)', () => {
  it('a close writes the operator\'s markers with closed_from; a move out of closed nulls every one', async () => {
    const { CLOSED_KEYS } = await import('../../../shared/inactivityClose.js');
    const patches: Row[] = [];
    state.rpc = (async (fn: string, args: Row) => {
      if (fn === 'patch_conversation_metadata') patches.push(args.p_patch as Row);
      return { data: null, error: null };
    }) as never;
    const markers = () => patches.filter((p) => 'closed_reason' in p);
    const cid = conversation({ status: 'resolved' });
    message(cid, 'agent');
    expect((await patch(cid, { workspace_id: WS, status: 'closed' })).status).toBe(200);
    expect(markers()).toEqual([{
      closed_reason: 'operator', closed_by: 'agent', closed_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), closed_from: 'resolved',
      closed_source: null, closed_idle_hours: null, closed_last_exchange_at: null, closed_outcome: null,
      closed_line_id: null, closed_prev_stamps: null,
    }]);
    expect(Object.keys(markers()[0]).sort()).toEqual([...CLOSED_KEYS].sort());
    const row = state.db.tables.conversations!.find((c) => c.id === cid)!;
    row.status = 'closed';
    patches.length = 0;
    expect((await patch(cid, { workspace_id: WS, status: 'open' })).status).toBe(200);
    expect(markers()).toEqual([Object.fromEntries(CLOSED_KEYS.map((k) => [k, null]))]);
    // A move that never touches closed writes none.
    patches.length = 0;
    const open = conversation();
    expect((await patch(open, { workspace_id: WS, status: 'pending' })).status).toBe(200);
    expect(markers()).toEqual([]);
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

  it('PATCH open → resolved writes no line; resolved → closed writes it once; open → closed writes it too', async () => {
    const ends: Row[] = [];
    state.rpc = (async (fn: string, args: Row) => {
      if (fn === 'patch_conversation_metadata' && (args.p_patch as Row)?.routing_thread_ended_at) ends.push(args);
      return { data: null, error: null };
    }) as never;
    const cid = conversation();
    message(cid, 'agent');
    expect((await patch(cid, { workspace_id: WS, status: 'resolved' })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(closedRows(cid)).toHaveLength(0);
    expect((await patch(cid, { workspace_id: WS, status: 'closed' })).status).toBe(200);
    await vi.waitFor(() => expect(closedRows(cid)).toHaveLength(1));
    expect(closedRows(cid)[0].metadata).toMatchObject({ status: 'closed', agent_id: CLOSER, operator_id: OPERATOR });
    // The resolve's end stamp is renewed at the close: the visitor's thread
    // ended then (GET /api/widget/conversations endedAt).
    expect(ends.map((a) => a.p_conversation_id)).toEqual([cid, cid]);
    const direct = conversation();
    message(direct, 'agent');
    expect((await patch(direct, { workspace_id: WS, status: 'closed' })).status).toBe(200);
    await vi.waitFor(() => expect(closedRows(direct)).toHaveLength(1));
  });

  it('PATCH answers 200 whether the line can be written or not, and writes it for a default workspace', async () => {
    const cid = conversation();
    state.templateFails = true;
    expect((await patch(cid, { workspace_id: WS, status: 'closed' })).status).toBe(200);
    state.templateFails = false;
    state.templates[WS] = 'default';
    const other = conversation();
    message(other, 'agent');
    expect((await patch(other, { workspace_id: WS, status: 'closed' })).status).toBe(200);
    await vi.waitFor(() => expect(closedRows(other)).toHaveLength(1));
    expect(closedRows(cid)).toHaveLength(0);
  });

  it('neither "Send & resolve" nor "Send & wait" writes the line', async () => {
    const cid = conversation();
    const reply = message(cid, 'agent');
    // The post-send RPC: the transition happened.
    state.rpc = async () => ({ data: [{ changed: true, new_status: 'resolved', changed_at: tick() }], error: null });
    const waited = await applyPostSendAction(config, { action: 'wait_for_customer', workspaceId: WS, conversationId: cid, actorId: CLOSER, messageId: reply });
    expect(waited.changed).toBe(true);
    const resolved = await applyPostSendAction(config, { action: 'resolve', workspaceId: WS, conversationId: cid, actorId: CLOSER, messageId: reply });
    expect(resolved).toMatchObject({ changed: true, status: 'resolved' });
    await new Promise((r) => setTimeout(r, 20));
    expect(closedRows(cid)).toHaveLength(0);
    expect(state.published).toHaveLength(0);
  });
});
