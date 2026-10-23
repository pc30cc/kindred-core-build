// @vitest-environment node
/**
 * Who has a conversation, on a real database built by the whole chain (278b
 * included), through the real routes (DECISIONS §3–§4; R-03, R-04, R-06,
 * R-10, R-17, R-20, R-21, R-22, R-29, I-03, I-05):
 *
 *   A  the Inbox's door: staff without an Inbox get 403 `inbox_not_allowed`
 *      (list, thread, reply, notes); "All conversations" for supervisors only.
 *   B  taking a conversation is atomic: two take-overs, two claims, two
 *      first replies at once — one wins, the other hears who has it (409);
 *      the visitor reads who joined right before that operator's first
 *      message (operatorReplyJoin.ts), never at an assignment; a platform
 *      admin's reply claims only when they hold an Inbox seat.
 *   C  moving one by hand: who may move whose, to whom (never staff, a
 *      suspended member or a non-member), 409 when it changed; an AI thread
 *      assigned to a person is theirs; an unassign routes again (auto: the
 *      next operator, never the one who let it go); a transfer to an
 *      operator or a department.
 *   D  a member removed or suspended gives their open chats back: released
 *      in offboarding's own transaction, announced, routed again (the stale
 *      ones wait in Unassigned); finished ones keep them.
 *   E  a resolved conversation the visitor starts again keeps its operator
 *      only when they could take it now; resolving lets the AI answer a later
 *      thread; an operator's reply reopens a closed one; Visitors-page
 *      outreach is the operator's; the list carries the department and when
 *      the visitor last read the thread.
 *
 * Presence and the transports are fakes. Driven by TEST_DATABASE_URL;
 * skipped without it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import pg from 'pg';
import { createFullChainDatabase, type FullChainDatabase } from './fullChainDatabase';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

type Row = Record<string, unknown>;
type Next = () => void;
const state = vi.hoisted(() => ({
  /** user id → routing presence state ('active' | 'away' | …). */
  presence: new Map<string, string>(),
  visitor: 'visitor-1' as string,
  events: [] as Array<Record<string, unknown>>,
  published: [] as Array<{ cid: string; envelope: Record<string, unknown> }>,
}));

vi.mock('../../../server/services/widget/operatorPresence.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/operatorPresence.js')>()),
  readRoutingPresence: async (_c: unknown, _ws: string, ids: string[]) =>
    new Map(ids.filter((id) => state.presence.has(id)).map((id) => [id, { state: state.presence.get(id)!, lastActivityAt: Date.now() - 60_000 }])),
}));
vi.mock('../../../server/services/widget/security.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/security.js')>()),
  enforceWidgetToken: (_req: unknown, _res: unknown, next: Next) => next(),
  enforceOrigin: (_req: unknown, _res: unknown, next: Next) => next(),
}));
vi.mock('../../../server/services/widget/visitorIdentity.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/visitorIdentity.js')>()),
  readVisitorCookie: () => ({ v: state.visitor }),
  resolveVisitorIdentity: () => ({ visitorId: state.visitor, isNew: false }),
}));
vi.mock('../../../server/services/realtime/publish.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/realtime/publish.js')>()),
  publishConversationEvent: async (_c: unknown, _ws: string, cid: string, envelope: Record<string, unknown>) => {
    state.published.push({ cid, envelope });
    return { ok: true };
  },
  publishOperatorEvent: async (_c: unknown, payload: Record<string, unknown>) => { state.events.push(payload); },
}));
vi.mock('../../../server/services/push/index.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/push/index.js')>()),
  notifyInboundMessage: async () => undefined,
  notifyHandoff: async () => undefined,
  notifyAssignment: async () => undefined,
}));
vi.mock('../../../server/services/notificationEmail/producers.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/notificationEmail/producers.js')>()),
  queueTranscript: async () => undefined,
}));

/** Polls `read` until `ok` holds (fire-and-forget work), up to ~4 s; returns the last value. */
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  let v = await read();
  for (let i = 0; i < 80 && !ok(v); i++) {
    await new Promise((r) => setTimeout(r, 50));
    v = await read();
  }
  return v;
}

suite('who has a conversation, on a real database (278b)', () => {
  let chain: FullChainDatabase;
  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await chain.db.query(sql, params)).rows as Row[];
  const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];

  const owner = randomUUID();
  const a = randomUUID(); // support_agent, Ali
  const b = randomUUID(); // agent, Bahar
  const c = randomUUID(); // sales_agent, Cyrus (the Sales department)
  const lead = randomUUID(); // team_lead, Leila
  const admin = randomUUID();
  const seo = randomUUID();
  const d = randomUUID(); // agent, Dara (removed / suspended in D)
  const ws = randomUUID();

  let config: ReturnType<typeof import('../../../server/config.js')['loadConfig']>;
  let routing: typeof import('../../../server/services/chatRouting.js');
  let resetCaches: () => void;
  let app: express.Express;
  const tokens: Record<string, string> = {};
  const as = (user: string) => ({ Authorization: `Bearer ${tokens[user]}` });
  let sales = '';

  const conversation = async (fields: { status?: string; assigned?: string | null; meta?: Row; updatedAgo?: string; contact?: string | null } = {}) => {
    const id = randomUUID();
    await q(`INSERT INTO public.conversations (id, workspace_id, status, assigned_to, contact_id, metadata, updated_at)
             VALUES ($1, $2, $3::conversation_status, $4, $5, $6::jsonb, now() - $7::interval)`,
    [id, ws, fields.status ?? 'open', fields.assigned ?? null, fields.contact ?? null, JSON.stringify(fields.meta ?? {}), fields.updatedAgo ?? '0 seconds']);
    await q(`INSERT INTO public.conversation_messages (conversation_id, sender_type, body) VALUES ($1, 'contact', 'سلام')`, [id]);
    return id;
  };
  const conv = async (cid: string) => one(`SELECT status, assigned_to, metadata FROM public.conversations WHERE id = $1`, [cid]);
  const assignee = async (cid: string) => (await conv(cid)).assigned_to as string | null;
  const events = async (cid: string, type: string) => (await q(
    `SELECT actor_type, actor_id, payload FROM public.conversation_events WHERE conversation_id = $1 AND event_type = $2 ORDER BY created_at`, [cid, type],
  )).map((r) => ({ actor: r.actor_type, actor_id: r.actor_id, ...(r.payload as Row) }));
  const systemKinds = async (cid: string) => (await q(
    `SELECT metadata FROM public.conversation_messages WHERE conversation_id = $1 AND sender_type = 'system' ORDER BY created_at`, [cid],
  )).map((r) => (r.metadata as Row).kind);
  /** The thread in order: who wrote each row (an operator's id, `join:<id>`, a notice's kind, or the sender type). */
  const thread = async (cid: string) => (await q(
    `SELECT sender_type, sender_id, body, metadata, created_at FROM public.conversation_messages WHERE conversation_id = $1 ORDER BY created_at, id`, [cid],
  )).map((r) => ({
    who: r.sender_type === 'agent' ? String(r.sender_id)
      : (r.metadata as Row | null)?.kind === 'routing_agent_joined' ? `join:${(r.metadata as Row).agent_id}`
        : String((r.metadata as Row | null)?.kind ?? r.sender_type),
    kind: (r.metadata as Row | null)?.kind ?? null,
    body: r.body,
    metadata: r.metadata as Row,
  }));
  const joinsOf = async (cid: string) => (await thread(cid)).filter((r) => r.kind === 'routing_agent_joined');
  /** The row right before `user`'s first message is their join. */
  const introducedFirst = async (cid: string, user: string) => {
    const rows = await thread(cid);
    const first = rows.findIndex((r) => r.who === user);
    return first > 0 && rows[first - 1].who === `join:${user}`;
  };
  /** The AI answered: a new stretch begins. */
  const aiAnswers = (cid: string) => q(`INSERT INTO public.conversation_messages (conversation_id, sender_type, body) VALUES ($1, 'ai', 'سلام! چطور می‌تونم کمک کنم؟')`, [cid]);
  /** The `message` envelopes the conversation channel received, in order. */
  const publishedRows = (cid: string) => state.published.filter((p) => p.cid === cid && p.envelope.type === 'message')
    .map((p) => p.envelope.payload as Row);
  const memberRow = async (user: string) => String((await one(`SELECT id FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2`, [ws, user])).id);
  const patch = (user: string, cid: string, body: Row) => request(app).patch(`/api/conversations/${cid}`).set(as(user)).send({ workspace_id: ws, ...body });
  const send = (user: string, cid: string, body = 'سلام، در خدمتم') => request(app).post('/api/conversations/send-message').set(as(user))
    .send({ workspace_id: ws, conversation_id: cid, body });

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `lifecycle278b_${Date.now()}`);
    for (const [id, name] of [[owner, 'Owner'], [a, 'Ali'], [b, 'Bahar'], [c, 'Cyrus'], [lead, 'Leila'], [admin, 'Admin'], [seo, 'Seo'], [d, 'Dara']]) {
      await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, $3)`, [id, `p-${id.slice(0, 8)}@test.local`, name]);
    }
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [ws, `ws-${ws.slice(0, 8)}`, owner]);
    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES
               ($1, $2, 'owner'), ($1, $3, 'support_agent'), ($1, $4, 'agent'), ($1, $5, 'sales_agent'),
               ($1, $6, 'team_lead'), ($1, $7, 'admin'), ($1, $8, 'seo_manager')`, [ws, owner, a, b, c, lead, admin, seo]);
    await q(`INSERT INTO public.widget_settings (workspace_id, enabled, assignment_mode) VALUES ($1, true, 'auto')`, [ws]);
    // No pre-chat form (without a row of its own the default one is asked, and routing waits for it).
    await q(`INSERT INTO public.widget_prechat_settings (workspace_id, ask_name, ask_email, ask_phone, require_name, require_email, prechat_timing)
             VALUES ($1, false, false, false, false, false, 'never')`, [ws]);
    sales = String((await one(`INSERT INTO public.workspace_departments (workspace_id, name) VALUES ($1, 'Sales') RETURNING id`, [ws])).id);
    await q(`INSERT INTO public.workspace_department_members (workspace_id, department_id, user_id) VALUES ($1, $2, $3)`, [ws, sales, c]);

    Object.assign(process.env, {
      DATABASE_URL: chain.url,
      PLATFORM_SIGNING_SECRET: 'signing-secret-for-this-test-only-0123456789',
      SUPABASE_URL: 'https://legacy-project.supabase.co',
      SUPABASE_ANON_KEY: 'legacy-anon-key-value',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-key-value-at-least-32',
      CORS_ORIGINS: 'http://127.0.0.1',
    });
    delete process.env.DATABASE_MODE;
    config = { ...(await import('../../../server/config.js')).loadConfig(), selfHostBillingUnlimited: true };
    routing = await import('../../../server/services/chatRouting.js');
    const departments = await import('../../../server/services/calls/departments.js');
    const global = await import('../../../server/services/calls/globalAdvancedRouting.js');
    resetCaches = () => {
      departments.invalidateDepartmentCache(ws);
      global.__resetGlobalAdvancedRoutingCache();
    };
    const { conversationsRouter } = await import('../../../server/routes/conversations.js');
    const { conversationNotesRouter } = await import('../../../server/routes/conversationNotes.js');
    const { workspaceMembersRouter } = await import('../../../server/routes/workspaceMembers.js');
    const { widgetRouter } = await import('../../../server/routes/widget.js');
    const { activityRouter } = await import('../../../server/routes/ai-agent/activity.js');
    const { realtimeRouter } = await import('../../../server/routes/realtime.js');
    const { createSession } = await import('../../../server/services/auth/sessions.js');
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { Object.assign(req, { serverConfig: config }); next(); });
    app.use('/api/conversations', conversationsRouter);
    app.use('/api/conversations', conversationNotesRouter);
    app.use('/api/workspace-members', workspaceMembersRouter);
    app.use('/api/widget', widgetRouter);
    app.use('/api/ai-agent', activityRouter);
    app.use('/api/realtime', realtimeRouter);
    for (const id of [owner, a, b, c, lead, admin, seo]) {
      tokens[id] = (await createSession(config as never, { userId: id, email: `p-${id.slice(0, 8)}@test.local` })).token;
    }
  }, 600_000);

  afterAll(async () => {
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer().catch(() => undefined);
    await chain?.drop();
  });

  beforeEach(async () => {
    state.presence.clear();
    state.events.length = 0;
    state.published.length = 0;
    await q(`DELETE FROM public.conversations WHERE workspace_id = $1`, [ws]);
    await q(`DELETE FROM public.chat_routing_members WHERE workspace_id = $1`, [ws]);
    await q(`UPDATE public.workspace_members SET suspended_at = NULL, receives_chats = true WHERE workspace_id = $1`, [ws]);
    await q(`UPDATE public.widget_settings SET assignment_mode = 'auto', last_agent_routing_enabled = true, last_agent_window_days = 30 WHERE workspace_id = $1`, [ws]);
    resetCaches?.();
  });

  // ─── A: the Inbox's door ───────────────────────────────────────────────

  it('A1 staff without an Inbox get 403 inbox_not_allowed (list, thread, reply, notes); admins and the team get in', async () => {
    const cid = await conversation();
    for (const call of [
      () => request(app).get(`/api/conversations?workspace_id=${ws}`).set(as(seo)),
      () => request(app).get(`/api/conversations/${cid}/messages`).set(as(seo)),
      () => send(seo, cid),
      () => request(app).get(`/api/conversations/${cid}/notes?workspace_id=${ws}`).set(as(seo)),
      () => request(app).get(`/api/conversations/inbox-counts?workspace_id=${ws}`).set(as(seo)),
    ]) {
      const res = await call();
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'inbox_not_allowed' });
    }
    for (const user of [admin, a, lead, owner]) {
      expect((await request(app).get(`/api/conversations?workspace_id=${ws}`).set(as(user))).status).toBe(200);
    }
    // Nothing was written by the refused reply.
    expect((await q(`SELECT 1 FROM public.conversation_messages WHERE conversation_id = $1 AND sender_type = 'agent'`, [cid]))).toHaveLength(0);
  });

  it('A2 "All conversations" for supervisors (owner, admin, team lead); everyone else sees the unassigned and their own', async () => {
    const bahars = await conversation({ assigned: b });
    const open = await conversation();
    const listed = async (user: string) => ((await request(app).get(`/api/conversations?workspace_id=${ws}&scope=all`).set(as(user))).body.conversations as Row[])
      .map((r) => r.id);
    for (const user of [owner, admin, lead]) expect(new Set(await listed(user))).toEqual(new Set([bahars, open]));
    expect(await listed(a)).toEqual([open]);
  });

  // ─── B: taking one is atomic ───────────────────────────────────────────

  it('A3 staff without an Inbox get no conversation channel and no unread digest; the team and admins do', async () => {
    const cid = await conversation();
    const inbox = (user: string) => request(app).post('/api/realtime/operator-inbox-subscribe').set(as(user)).send({ workspace_id: ws, transport: 'supabase' });
    const thread = (user: string) => request(app).post('/api/realtime/operator-subscribe').set(as(user)).send({ workspace_id: ws, conversation_id: cid, transport: 'supabase' });
    for (const res of [await inbox(seo), await thread(seo)]) expect(res).toMatchObject({ status: 403, body: { error: 'inbox_not_allowed' } });
    for (const user of [a, admin]) {
      expect((await inbox(user)).status).not.toBe(403);
      expect((await thread(user)).status).not.toBe(403);
    }
    // Their own channel (a colleague's message) stays theirs.
    expect((await request(app).post('/api/realtime/operator-user-subscribe').set(as(seo)).send({ workspace_id: ws, transport: 'supabase' })).status).not.toBe(403);
    const { audienceFor } = await import('../../../server/services/notificationEmail/producers.js');
    const digest = await audienceFor(config as never, ws, 'unread_messages');
    expect(digest).not.toContain(seo);
    expect(digest).toEqual(expect.arrayContaining([owner, a, admin]));
    expect(await audienceFor(config as never, ws, 'weekly_summary')).toContain(seo);
  });

  it('B1 two take-overs at once: one takes it, the other hears who has it (409 already_assigned)', async () => {
    const cid = await conversation({ meta: { ai_state: 'ai_managed' } });
    const results = await Promise.all([a, b].map((user) => request(app).post(`/api/conversations/${cid}/take-over`).set(as(user)).send({ workspaceId: ws })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = await assignee(cid);
    expect([a, b]).toContain(winner);
    const loser = results.find((r) => r.status === 409)!;
    expect(loser.body).toEqual({ error: 'already_assigned', assigned_to: winner });
    expect((await conv(cid)).metadata).toMatchObject({ ai_state: 'human_active', human_takeover_by: winner });
    expect(await until(() => events(cid, 'assigned'), (e) => e.length >= 1)).toEqual([expect.objectContaining({ to: winner, method: 'take_over' })]);
    // Taking over a colleague's: refused the same way; the holder taking over again: fine.
    const other = winner === a ? b : a;
    expect((await request(app).post(`/api/conversations/${cid}/take-over`).set(as(other)).send({ workspaceId: ws })).status).toBe(409);
    expect((await request(app).post(`/api/conversations/${cid}/take-over`).set(as(winner!)).send({ workspaceId: ws })).status).toBe(200);
  });

  it('B2 two claims at once: exactly one; the holder claiming again is told it is theirs', async () => {
    const cid = await conversation();
    const results = await Promise.all([a, b, lead].map((user) => request(app).post(`/api/conversations/${cid}/claim`).set(as(user)).send({ workspace_id: ws })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    const winner = await assignee(cid);
    for (const r of results.filter((x) => x.status === 409)) expect(r.body).toEqual({ error: 'already_assigned', assigned_to: winner });
    expect((await request(app).post(`/api/conversations/${cid}/claim`).set(as(winner!)).send({ workspace_id: ws })).body).toEqual({ ok: true, assigned_to: winner });
    // One `assigned` event, and nothing for the visitor yet: they read who
    // joined with the winner's first message.
    expect(await until(() => events(cid, 'assigned'), (e) => e.length >= 1)).toHaveLength(1);
    expect((await systemKinds(cid)).filter((k) => k === 'routing_agent_joined')).toHaveLength(0);
    expect((await send(winner!, cid)).status).toBe(200);
    expect(await introducedFirst(cid, winner!)).toBe(true);
  });

  it('B3 the first reply claims an unassigned conversation, once, even when two operators reply at once', async () => {
    const cid = await conversation();
    const results = await Promise.all([send(a, cid, 'سلام از علی'), send(b, cid, 'سلام از بهار')]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const winner = await assignee(cid);
    expect([a, b]).toContain(winner);
    const assigned = await until(() => events(cid, 'assigned'), (e) => e.length >= 1);
    expect(assigned).toEqual([expect.objectContaining({ to: winner, method: 'first_reply' })]);
    // Both wrote, so both were introduced, each right before their own message.
    expect((await joinsOf(cid)).map((r) => r.metadata.agent_id).sort()).toEqual([a, b].sort());
    expect(await introducedFirst(cid, a)).toBe(true);
    expect(await introducedFirst(cid, b)).toBe(true);
    // A reply to a conversation somebody has claims nothing.
    await send(lead, cid, 'من هم هستم');
    await new Promise((r) => setTimeout(r, 150));
    expect(await assignee(cid)).toBe(winner);
    expect(await events(cid, 'assigned')).toHaveLength(1);
  });

  // ─── C: moving one by hand ─────────────────────────────────────────────

  it('B4 the AI agent\'s older take-over route: staff get 403, a colleague\'s chat is 409 with the AI left alone, an unassigned one is taken', async () => {
    const legacy = (user: string, cid: string) => request(app).post(`/api/ai-agent/conversations/${cid}/take-over`).set(as(user)).send({ workspaceId: ws });
    const aiHeld = { ai_state: 'ai_managed', managed_by_ai: true };
    const free = await conversation({ meta: aiHeld });
    expect(await legacy(seo, free)).toMatchObject({ status: 403, body: { error: 'inbox_not_allowed' } });
    expect(await assignee(free)).toBeNull();
    expect(((await conv(free)).metadata as Row).ai_state).toBe('ai_managed');
    const bahars = await conversation({ assigned: b, meta: aiHeld });
    expect(await legacy(a, bahars)).toMatchObject({ status: 409, body: { error: 'already_assigned', assigned_to: b } });
    expect(((await conv(bahars)).metadata as Row).ai_state).toBe('ai_managed');
    expect((await legacy(a, free)).status).toBe(200);
    expect(await assignee(free)).toBe(a);
    expect(((await conv(free)).metadata as Row).ai_state).toBe('human_active');
    expect(await until(() => events(free, 'assigned'), (e) => e.length >= 1)).toEqual([expect.objectContaining({ to: a, method: 'take_over' })]);
  });

  it('B5 the visitor reads who joined right before the first message: once per stretch after the AI, in order, live and stored', async () => {
    const { visitorMessagePayload } = await import('../../../server/services/realtime/publish.js');
    const cid = await conversation();
    await aiAnswers(cid);
    expect((await send(a, cid, 'سلام، علی هستم')).status).toBe(200);
    const replay = { workspace_id: ws, conversation_id: cid, body: 'بررسی می‌کنم', client_message_id: `cm-${randomUUID()}` };
    expect((await request(app).post('/api/conversations/send-message').set(as(a)).send(replay)).status).toBe(200);
    // Stored: one line, named, before Ali's first message.
    const joins = await joinsOf(cid);
    expect(joins).toHaveLength(1);
    expect(joins[0].metadata).toEqual({ kind: 'routing_agent_joined', agent_id: a, agent_name: 'Ali' });
    expect(joins[0].body).toBe('Ali joined the conversation.');
    expect((await thread(cid)).map((r) => r.who)).toEqual(['contact', 'ai', `join:${a}`, a, a]);
    // Live: the line first, then the replies; the visitor's copy has no operator id.
    const live = publishedRows(cid);
    expect(live.map((m) => (m.metadata as Row).kind ?? m.sender_type)).toEqual(['routing_agent_joined', 'agent', 'agent']);
    const visitorCopy = visitorMessagePayload(live[0]);
    expect(visitorCopy.metadata).toEqual({ kind: 'routing_agent_joined', agent_name: 'Ali' });
    expect(visitorCopy).not.toHaveProperty('sender_id');
    // A replay of the same message adds nothing.
    const replayed = await request(app).post('/api/conversations/send-message').set(as(a)).send(replay);
    expect(replayed.body.duplicate).toBe(true);
    expect(await thread(cid)).toHaveLength(5);
    expect(publishedRows(cid)).toHaveLength(3);

    // Bahar writes too: her own line, right before her message.
    expect((await send(b, cid, 'من هم کمک می‌کنم')).status).toBe(200);
    expect(await introducedFirst(cid, b)).toBe(true);
    expect((await joinsOf(cid)).map((r) => r.metadata.agent_id)).toEqual([a, b]);
    // Ali again in the same stretch: no second line.
    await send(a, cid, 'ممنون بهار');
    expect(await joinsOf(cid)).toHaveLength(2);

    // The AI answers again, then Ali: a new stretch, a new line.
    await aiAnswers(cid);
    await send(a, cid, 'برگشتم');
    const rows = await thread(cid);
    expect(rows.slice(-3).map((r) => r.who)).toEqual(['ai', `join:${a}`, a]);

    // Two different messages from Ali at once, after the AI: one line.
    await aiAnswers(cid);
    const both = await Promise.all([send(a, cid, 'یک'), send(a, cid, 'دو')]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    const after = (await thread(cid)).slice(-4);
    expect(after.map((r) => r.who)).toEqual(['ai', `join:${a}`, a, a]);

    // A conversation the visitor has not written in (outreach): the operator opens it.
    const outreach = randomUUID();
    await q(`INSERT INTO public.conversations (id, workspace_id, status) VALUES ($1, $2, 'open')`, [outreach, ws]);
    expect((await send(b, outreach, 'سلام، می‌تونم کمکتون کنم؟')).status).toBe(200);
    expect((await thread(outreach)).map((r) => r.who)).toEqual([b]);
  });

  it('B6 a platform admin with an Inbox seat claims on reply; without one, no claim, but the visitor still reads who joined', async () => {
    const { createSession } = await import('../../../server/services/auth/sessions.js');
    const seated = randomUUID();
    const outsider = randomUUID();
    for (const [id, name] of [[seated, 'Sima'], [outsider, 'Omid']]) {
      await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, $3)`, [id, `p-${id.slice(0, 8)}@test.local`, name]);
      await q(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')`, [id]);
      tokens[id] = (await createSession(config as never, { userId: id, email: `p-${id.slice(0, 8)}@test.local` })).token;
    }
    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'agent')`, [ws, seated]);
    try {
      const mine = await conversation();
      expect((await send(seated, mine, 'سلام، سیما هستم')).status).toBe(200);
      expect(await until(() => assignee(mine), (v) => v === seated)).toBe(seated);
      expect(await until(() => events(mine, 'assigned'), (e) => e.length >= 1)).toEqual([expect.objectContaining({ to: seated, method: 'first_reply' })]);
      expect(await introducedFirst(mine, seated)).toBe(true);

      const theirs = await conversation();
      expect((await send(outsider, theirs, 'سلام، امید هستم')).status).toBe(200);
      await new Promise((r) => setTimeout(r, 150));
      expect(await assignee(theirs)).toBeNull();
      expect(await events(theirs, 'assigned')).toEqual([]);
      expect(await introducedFirst(theirs, outsider)).toBe(true);
      expect((await joinsOf(theirs))[0].metadata).toMatchObject({ agent_id: outsider, agent_name: 'Omid' });
    } finally {
      await q(`DELETE FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2`, [ws, seated]);
      await q(`DELETE FROM public.user_roles WHERE user_id = ANY($1::uuid[])`, [[seated, outsider]]);
    }
  });

  it('C1 who may move whose: an operator only their own (or takes an unassigned one); a supervisor anyone\'s', async () => {
    const bahars = await conversation({ assigned: b });
    expect((await patch(a, bahars, { assigned_to: a })).body).toEqual({ error: 'not_allowed' });
    expect((await patch(a, bahars, { assigned_to: null })).status).toBe(403);
    const open = await conversation();
    expect((await patch(a, open, { assigned_to: b })).status).toBe(403);
    expect((await patch(a, open, { assigned_to: a })).status).toBe(200);
    // Ali hands his own on to Bahar; Leila (team lead) moves Bahar's to Ali.
    expect((await patch(a, open, { assigned_to: b, expected_assigned_to: a })).status).toBe(200);
    expect(await assignee(open)).toBe(b);
    const moved = await patch(lead, bahars, { assigned_to: a });
    expect(moved.status).toBe(200);
    expect(moved.body.conversation).toMatchObject({ assigned_to: a });
    // The Inbox reads the move (internal), the timeline too; the visitor
    // hears of Ali when he writes. Taking an unheld one wrote nothing.
    await until(() => systemKinds(bahars), (k) => k.includes('conversation_transferred'));
    expect((await thread(bahars)).find((r) => r.kind === 'conversation_transferred')!.metadata)
      .toMatchObject({ internal: true, from_id: b, to_id: a, actor_id: lead });
    expect(publishedRows(bahars)).toEqual([]);
    await until(() => systemKinds(open), (k) => k.includes('conversation_transferred'));
    expect(await systemKinds(open)).toEqual(['conversation_transferred']);
    expect(await until(() => events(bahars, 'assigned'), (e) => e.length >= 1)).toEqual([expect.objectContaining({ from: b, to: a, method: 'manual', actor_id: lead })]);
  });

  it('C2 to whom: never staff, a suspended member or a non-member; a stale or racing change is 409 assignment_changed', async () => {
    const cid = await conversation();
    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role, suspended_at) VALUES ($1, $2, 'agent', now())`, [ws, d]);
    try {
      for (const [target, reason] of [[seo, 'not_a_chat_operator'], [admin, 'not_a_chat_operator'], [d, 'suspended'], [randomUUID(), 'not_a_member']] as const) {
        const res = await patch(owner, cid, { assigned_to: target });
        expect(res.status, reason).toBe(400);
        expect(res.body).toEqual({ error: 'invalid_target', reason });
      }
      // An admin may still take one themselves.
      expect((await patch(admin, cid, { assigned_to: admin })).status).toBe(200);
      // The panel showed it unassigned: somebody took it since.
      const stale = await patch(owner, cid, { assigned_to: b, expected_assigned_to: null });
      expect(stale.status).toBe(409);
      expect(stale.body).toEqual({ error: 'assignment_changed', assigned_to: admin });
      // Two supervisors at once from the same picture: one lands.
      const race = await conversation();
      const both = await Promise.all([
        patch(owner, race, { assigned_to: a, expected_assigned_to: null }),
        patch(lead, race, { assigned_to: b, expected_assigned_to: null }),
      ]);
      expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
      const landed = both.find((r) => r.status === 200)!.body.conversation.assigned_to;
      expect(await assignee(race)).toBe(landed);
      expect(both.find((r) => r.status === 409)!.body).toEqual({ error: 'assignment_changed', assigned_to: landed });
    } finally {
      await q(`DELETE FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2`, [ws, d]);
    }
  });

  it('C3 an AI thread given to a person is theirs: out of the AI\'s queue, the AI stops (R-06)', async () => {
    const cid = await conversation({ meta: { ai_state: 'ai_managed', managed_by_ai: true } });
    expect((await patch(lead, cid, { assigned_to: b })).status).toBe(200);
    const after = await until(() => conv(cid), (r) => (r.metadata as Row).ai_state !== 'ai_managed');
    expect(after.metadata).toMatchObject({ ai_state: 'human_active', managed_by_ai: false, human_takeover_reason: 'assignment', human_takeover_by: b });
    const mine = (await request(app).get(`/api/conversations?workspace_id=${ws}&assigned_to_me=${b}`).set(as(b))).body.conversations as Row[];
    expect(mine.map((r) => r.id)).toContain(cid);
  });

  it('C4 an unassign routes again in auto mode, never back to whoever let it go; the next operator is introduced when they write (R-20)', async () => {
    state.presence.set(a, 'active');
    state.presence.set(b, 'active');
    const cid = await conversation({ assigned: a, meta: { routing_notice_sent: true } });
    expect((await patch(a, cid, { assigned_to: null, expected_assigned_to: a })).status).toBe(200);
    expect(await until(() => assignee(cid), (v) => v === b)).toBe(b);
    expect(await systemKinds(cid)).toEqual(['conversation_unassigned']);
    expect((await one(`SELECT skip_user_ids FROM public.chat_routing_state WHERE conversation_id = $1`, [cid])).skip_user_ids).toEqual([a]);
    // Nobody else is here: it waits (the ticker retries), still never back to Ali.
    state.presence.delete(b);
    const lone = await conversation({ assigned: a });
    await patch(a, lone, { assigned_to: null });
    await until(() => systemKinds(lone), (k) => k.length >= 2);
    expect(await assignee(lone)).toBeNull();
    expect((await one(`SELECT waiting_since IS NOT NULL AS waiting FROM public.chat_routing_state WHERE conversation_id = $1`, [lone])).waiting).toBe(true);
  });

  it('C5 transfer: to an operator, or to a department that routes it there; refused for a colleague\'s chat or a bad target', async () => {
    state.presence.set(b, 'active');
    state.presence.set(c, 'active');
    const transfer = (user: string, cid: string, body: Row) => request(app).post(`/api/conversations/${cid}/transfer`).set(as(user)).send({ workspace_id: ws, ...body });
    const alis = await conversation({ assigned: a });
    const toBahar = await transfer(a, alis, { user_id: b });
    expect(toBahar.status).toBe(200);
    expect(toBahar.body.conversation).toMatchObject({ id: alis, assigned_to: b });
    expect(await until(() => events(alis, 'assigned'), (e) => e.length >= 1)).toEqual([expect.objectContaining({ from: a, to: b, method: 'manual', source: 'transfer' })]);
    // A panel that still shows Ali (the Inbox sends whom it showed): somebody
    // moved it since, so nothing moves and the answer names who has it.
    expect((await transfer(lead, alis, { user_id: c, expected_assigned_to: a })).body).toEqual({ error: 'assignment_changed', assigned_to: b });
    expect((await transfer(lead, alis, { department_id: sales, expected_assigned_to: null })).status).toBe(409);
    // Not Ali's any more: he may not move it.
    expect((await transfer(a, alis, { user_id: a })).status).toBe(403);
    expect((await transfer(a, alis, { department_id: sales })).body).toEqual({ error: 'not_allowed' });
    // Bad targets.
    expect((await transfer(b, alis, { user_id: seo })).body).toEqual({ error: 'invalid_target', reason: 'not_a_chat_operator' });
    expect((await transfer(b, alis, { department_id: randomUUID() })).body).toEqual({ error: 'invalid_target', reason: 'department' });
    expect((await transfer(b, alis, { user_id: c, department_id: sales })).status).toBe(400);
    expect((await transfer(b, alis, {})).status).toBe(400);
    // Bahar sends it to Sales: Cyrus (Sales, here) gets it, never Bahar again.
    const toSales = await transfer(b, alis, { department_id: sales });
    expect(toSales.status).toBe(200);
    expect(toSales.body.conversation).toMatchObject({ assigned_to: c, department_id: sales, department_name: 'Sales' });
    // Both transfers are the Inbox's; nobody is announced until they write.
    const moves = await until(() => thread(alis), (rows) => rows.filter((r) => r.kind === 'conversation_transferred').length >= 2);
    expect(moves.filter((r) => r.who !== 'contact').map((r) => [r.kind, r.metadata.internal])).toEqual([
      ['conversation_transferred', true], ['conversation_transferred', true],
    ]);
    const deptNotice = (await q(`SELECT metadata FROM public.conversation_messages WHERE conversation_id = $1 AND metadata->>'department_id' IS NOT NULL`, [alis]))[0].metadata as Row;
    expect(deptNotice).toMatchObject({ kind: 'conversation_transferred', internal: true, to_name: 'Sales', actor_name: 'Bahar' });
    expect(await until(() => events(alis, 'department_assigned'), (e) => e.length >= 1)).toEqual([expect.objectContaining({ department_id: sales, department_name: 'Sales' })]);
    // The department is on the row for everyone (the list and by id).
    const byId = await request(app).get(`/api/conversations/${alis}?workspace_id=${ws}`).set(as(lead));
    expect(byId.body.conversation).toMatchObject({ department_id: sales, department_name: 'Sales' });
  });

  // ─── D: a member who leaves gives their chats back ─────────────────────

  it('D1 offboarding releases the member\'s open and pending chats in its own transaction and routes the recent ones; finished ones keep them', async () => {
    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'agent')`, [ws, d]);
    state.presence.set(b, 'active');
    const open = await conversation({ assigned: d });
    const pending = await conversation({ assigned: d, status: 'pending' });
    const stale = await conversation({ assigned: d, updatedAgo: '3 days' });
    const done = await conversation({ assigned: d, status: 'resolved' });
    const res = await request(app).delete(`/api/workspace-members/${await memberRow(d)}?workspaceId=${ws}`).set(as(owner)).send({});
    expect(res.status).toBe(200);
    expect(new Set(res.body.offboarding.released_conversation_ids)).toEqual(new Set([open, pending, stale]));
    // Routed again (the recent ones), to whoever is here.
    expect(await until(() => assignee(open), (v) => v === b)).toBe(b);
    expect(await until(() => assignee(pending), (v) => v === b)).toBe(b);
    // The stale one waits in Unassigned (routing runs when its visitor writes).
    expect(await assignee(stale)).toBeNull();
    expect(await assignee(done)).toBe(d);
    expect(await until(() => events(stale, 'unassigned'), (e) => e.length >= 1)).toEqual([expect.objectContaining({ actor: 'system', from: d, method: 'member_removed' })]);
  });

  it('D2 a suspended member\'s open chats go back to routing; a member moved to a role without an Inbox too', async () => {
    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'agent')`, [ws, d]);
    try {
      state.presence.set(a, 'active');
      const open = await conversation({ assigned: d });
      const res = await request(app).patch(`/api/workspace-members/${await memberRow(d)}/suspension?workspaceId=${ws}`).set(as(owner)).send({ suspended: true });
      expect(res.status).toBe(200);
      expect(await until(() => assignee(open), (v) => v === a)).toBe(a);
      expect(await until(() => events(open, 'unassigned'), (e) => e.length >= 1)).toEqual([expect.objectContaining({ from: d, method: 'member_suspended' })]);
      // Reinstated, then made an analyst (no Inbox): released again.
      await request(app).patch(`/api/workspace-members/${await memberRow(d)}/suspension?workspaceId=${ws}`).set(as(owner)).send({ suspended: false });
      state.presence.clear();
      const another = await conversation({ assigned: d });
      expect((await request(app).patch(`/api/workspace-members/${await memberRow(d)}?workspaceId=${ws}`).set(as(owner)).send({ role: 'analyst' })).status).toBe(200);
      expect(await until(() => assignee(another), (v) => v === null)).toBeNull();
    } finally {
      await q(`DELETE FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2`, [ws, d]);
    }
  });

  it('D3 chat_routing_release_member and the skip list in SQL: only open and pending of that member; a skipped member is never picked', async () => {
    const open = await conversation({ assigned: b });
    const spamOpen = await conversation({ assigned: b });
    await q(`UPDATE public.conversations SET is_spam = true WHERE id = $1`, [spamOpen]);
    const resolved = await conversation({ assigned: b, status: 'resolved' });
    const alis = await conversation({ assigned: a });
    const before = (await one(`SELECT updated_at FROM public.conversations WHERE id = $1`, [open])).updated_at;
    const released = (await q(`SELECT conversation_id FROM public.chat_routing_release_member($1, $2)`, [ws, b])).map((r) => r.conversation_id);
    expect(new Set(released)).toEqual(new Set([open, spamOpen]));
    expect(await assignee(resolved)).toBe(b);
    expect(await assignee(alis)).toBe(a);
    // The released threads keep their place in the lists.
    expect((await one(`SELECT updated_at FROM public.conversations WHERE id = $1`, [open])).updated_at).toEqual(before);
    // Skipped: not offered to Bahar again; cleared: offered again.
    await q(`SELECT public.chat_routing_skip($1, $2, $3)`, [ws, open, b]);
    await q(`SELECT public.chat_routing_skip($1, $2, $3)`, [ws, open, b]);
    expect((await one(`SELECT skip_user_ids FROM public.chat_routing_state WHERE conversation_id = $1`, [open])).skip_user_ids).toEqual([b]);
    expect(await one(`SELECT * FROM public.chat_route_claim($1, $2, $3::uuid[], 'given', 'team', 'auto', NULL)`, [ws, open, [b]]))
      .toEqual({ outcome: 'none', picked_user_id: null });
    await q(`SELECT public.chat_routing_skip($1, $2, NULL)`, [ws, open]);
    expect(await one(`SELECT * FROM public.chat_route_claim($1, $2, $3::uuid[], 'given', 'team', 'auto', NULL)`, [ws, open, [b]]))
      .toEqual({ outcome: 'assigned', picked_user_id: b });
  });

  it('D4 offboarding while a claim holds the routing lock waits for it instead of deadlocking (the lock first, then the workspace row)', async () => {
    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'agent')`, [ws, d]);
    // No routing row yet: the claim's insert checks its foreign key on the workspace row.
    const cid = await conversation();
    const claimer = new pg.Client({ connectionString: chain.url });
    const remover = new pg.Client({ connectionString: chain.url });
    await claimer.connect();
    await remover.connect();
    try {
      const removerPid = (await remover.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await claimer.query('BEGIN');
      await claimer.query(`SELECT pg_advisory_xact_lock(hashtextextended('chat_route_claim:' || $1::text, 0))`, [ws]);
      const offboard = remover.query(`SELECT public.offboard_workspace_member($1, $2, $3, 'test') AS r`, [ws, d, owner]);
      expect(await until(
        async () => (await one(`SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`, [removerPid])).wait_event_type,
        (v) => v === 'Lock',
      )).toBe('Lock');
      const claimed = await claimer.query(`SELECT * FROM public.chat_route_claim($1, $2, $3::uuid[], 'given', 'team', 'auto', NULL)`, [ws, cid, [b]]);
      await claimer.query('COMMIT');
      expect(claimed.rows[0]).toEqual({ outcome: 'assigned', picked_user_id: b });
      expect((await offboard).rows[0].r).toMatchObject({ user_id: d, released_conversation_ids: [] });
    } finally {
      await claimer.query('ROLLBACK').catch(() => undefined);
      await Promise.all([claimer.end(), remover.end()]);
      await q(`DELETE FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2`, [ws, d]);
    }
  });

  // ─── E: threads, replies, outreach, the row ────────────────────────────

  it('E1 a reopened conversation keeps its operator only when they could take it now; resolving lets the AI answer the next thread (R-17)', async () => {
    const { getConversationState } = await import('../../../server/services/ai-agent/conversationState.js');
    state.presence.set(a, 'active');
    state.presence.set(b, 'active');
    // Ali answered, then resolved it.
    const cid = await conversation({ assigned: a });
    await send(a, cid);
    expect((await patch(a, cid, { status: 'resolved' })).status).toBe(200);
    const ended = (await conv(cid)).metadata as Row;
    expect(ended).toMatchObject({ ai_state: null, human_takeover_at: null });
    expect(typeof ended.routing_thread_ended_at).toBe('string');
    // The AI sees a new thread: nobody has replied in it.
    await q(`UPDATE public.conversations SET status = 'open' WHERE id = $1`, [cid]);
    expect((await getConversationState(config as never, ws, cid)).hasHumanAgentReplied).toBe(false);
    // Ali is here and has room: he keeps it — and it is his, so the AI
    // (on, answering until a person joins) does not answer over him, and the
    // thread stays in his list instead of moving to the AI's.
    await q(`INSERT INTO public.ai_agent_settings (workspace_id, enabled, mode) VALUES ($1, true, 'auto_reply_until_human_joins')
             ON CONFLICT (workspace_id) DO UPDATE SET enabled = true, mode = 'auto_reply_until_human_joins'`, [ws]);
    try {
      expect(await routing.routeHumanBoundConversation(config as never, { workspaceId: ws, conversationId: cid, reopened: true })).toBeNull();
    } finally {
      await q(`UPDATE public.ai_agent_settings SET enabled = false WHERE workspace_id = $1`, [ws]);
    }
    expect(await assignee(cid)).toBe(a);
    expect(((await conv(cid)).metadata as Row).routing_thread_ended_at).toBeNull();
    expect(((await conv(cid)).metadata as Row).ai_state).toBe('human_active');
    const { decideRuntime } = await import('../../../server/services/ai-agent/runtimePolicy.js');
    const aiOn = { enabled: true, mode: 'auto_reply_until_human_joins', handoff_on_human_request: false, handoff_keywords: [], max_replies_per_conversation: 3, max_replies_per_hour: 0 } as never;
    expect(decideRuntime({ settings: aiOn, state: await getConversationState(config as never, ws, cid), availability: { state: 'online' } as never, visitorText: 'سلام' }).action)
      .not.toBe('auto_reply');
    const mine = ((await request(app).get(`/api/conversations?workspace_id=${ws}`).set(as(a))).body.conversations as Row[]).map((r) => r.id);
    expect(mine).toContain(cid);

    // Ali is away now: the next reopen goes to Bahar.
    await patch(a, cid, { status: 'resolved' });
    await q(`UPDATE public.conversations SET status = 'open' WHERE id = $1`, [cid]);
    state.presence.set(a, 'away');
    expect(await routing.routeHumanBoundConversation(config as never, { workspaceId: ws, conversationId: cid, platformAiOff: true }))
      .toEqual({ outcome: 'assigned_auto', assignedTo: b });
    expect(await until(() => events(cid, 'unassigned'), (e) => e.length >= 1)).toEqual([expect.objectContaining({ from: a, method: 'reopen_release' })]);

    // Out of the window (ended 40 days ago): routed afresh even with Bahar here.
    await q(`UPDATE public.conversations SET metadata = metadata || jsonb_build_object('routing_thread_ended_at', (now() - interval '40 days')::text) WHERE id = $1`, [cid]);
    state.presence.set(a, 'active');
    await q(`UPDATE public.conversations SET assigned_to = $2 WHERE id = $1`, [cid, b]);
    state.presence.delete(b);
    expect((await routing.routeHumanBoundConversation(config as never, { workspaceId: ws, conversationId: cid, platformAiOff: true }))?.assignedTo).toBe(a);
  });

  it('E2 an operator\'s reply into a closed conversation reopens it, so the visitor\'s answer stays in it (I-05)', async () => {
    const cid = await conversation({ assigned: a, status: 'closed' });
    expect((await send(a, cid, 'یک سؤال دیگر داشتم')).status).toBe(200);
    expect((await conv(cid)).status).toBe('open');
    expect(await until(() => events(cid, 'reopened'), (e) => e.length >= 1)).toEqual([expect.objectContaining({ from: 'closed', to: 'open', reason: 'operator_replied' })]);
    expect(state.events.some((e) => e.kind === 'conversation_reopened' && e.conversation_id === cid)).toBe(true);
  });

  it('E3 a conversation started from the Visitors page is the operator\'s (R-29)', async () => {
    const session = randomUUID();
    await q(`INSERT INTO public.visitor_sessions (id, workspace_id, visitor_id) VALUES ($1, $2, 'v-out')`, [session, ws]);
    const res = await request(app).post('/api/conversations/start-from-visitor').set(as(b)).send({ workspace_id: ws, visitor_session_id: session });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(true);
    expect(await assignee(res.body.conversation_id)).toBe(b);
    // Again (the visitor's open one, nobody's): Bahar's too, not a second one.
    const cid = String(res.body.conversation_id);
    await q(`UPDATE public.conversations SET assigned_to = NULL WHERE id = $1`, [cid]);
    const again = await request(app).post('/api/conversations/start-from-visitor').set(as(b)).send({ workspace_id: ws, visitor_session_id: session });
    expect(again.body).toMatchObject({ conversation_id: cid, created: false });
    expect(await assignee(cid)).toBe(b);
    // The visitor's open one is the AI's: taking it is a human takeover (out
    // of the AI's lane, in Bahar's list), as POST /:id/claim makes it.
    await q(`UPDATE public.conversations SET assigned_to = NULL, metadata = metadata || '{"ai_state":"ai_managed","managed_by_ai":true}'::jsonb WHERE id = $1`, [cid]);
    expect((await request(app).post('/api/conversations/start-from-visitor').set(as(b)).send({ workspace_id: ws, visitor_session_id: session })).body)
      .toMatchObject({ conversation_id: cid, created: false });
    expect(await assignee(cid)).toBe(b);
    expect(((await conv(cid)).metadata as Row)).toMatchObject({ ai_state: 'human_active', managed_by_ai: false });
    const listed = ((await request(app).get(`/api/conversations?workspace_id=${ws}`).set(as(b))).body.conversations as Row[]).map((r) => r.id);
    expect(listed).toContain(cid);
  });

  it('E5 the department the visitor chose is kept in manual mode too, and every row names it (R-22)', async () => {
    await q(`UPDATE public.widget_settings SET assignment_mode = 'manual' WHERE workspace_id = $1`, [ws]);
    resetCaches();
    const cid = await conversation();
    await q(`UPDATE public.conversation_messages SET metadata = jsonb_build_object('department_id', $2::text) WHERE conversation_id = $1`, [cid, sales]);
    expect((await routing.routeConversationToOperator(config as never, { workspaceId: ws, conversationId: cid })).outcome).toBe('manual_queue');
    expect(((await conv(cid)).metadata as Row).department_id).toBe(sales);
    const rows = (await request(app).get(`/api/conversations?workspace_id=${ws}`).set(as(a))).body.conversations as Row[];
    expect(rows.find((r) => r.id === cid)).toMatchObject({ department_id: sales, department_name: 'Sales' });
    const plain = await conversation();
    const listed = (await request(app).get(`/api/conversations?workspace_id=${ws}`).set(as(a))).body.conversations as Row[];
    expect(listed.find((r) => r.id === plain)).toMatchObject({ department_id: null, department_name: null, visitor_last_read_at: null });
  });

  it('E4 the row says when the visitor last read the thread; the widget\'s read is announced to the operators (I-03)', async () => {
    const cid = await conversation();
    const read = async () => (await request(app).get(`/api/conversations/${cid}?workspace_id=${ws}`).set(as(a))).body.conversation.visitor_last_read_at;
    expect(await read()).toBeNull();
    state.visitor = `visitor-${randomUUID().slice(0, 8)}`;
    const session = randomUUID();
    await q(`INSERT INTO public.visitor_sessions (id, workspace_id, visitor_id) VALUES ($1, $2, $3)`, [session, ws, state.visitor]);
    await q(`UPDATE public.conversations SET visitor_session_id = $2 WHERE id = $1`, [cid, session]);
    const res = await request(app).post(`/api/widget/conversations/${cid}/read`).send({ workspace_id: ws });
    expect(res.status).toBe(200);
    const at = await read();
    expect(typeof at).toBe('string');
    const announced = await until(async () => state.events.filter((e) => e.kind === 'visitor_read' && e.conversation_id === cid), (e) => e.length > 0);
    expect(announced[0]).toMatchObject({ workspace_id: ws, visitor_last_read_at: expect.any(String) });
    expect(Date.parse(String(announced[0].visitor_last_read_at))).toBe(Date.parse(at));
  });
});
