// @vitest-environment node
/**
 * Chat routing on a real database built by the whole chain, 278 included
 * (DECISIONS §3–§4; R-01, R-05, R-11, R-12, R-13, R-14, R-15, R-18, R-19,
 * R-24, R-28):
 *
 *   S  chat_route_claim(): least busy by CURRENT load (open + pending,
 *      non-spam; resolved, closed and spam never count), ties to whoever was
 *      given a chat least recently; capacity (workspace default, per-member
 *      override; everyone full = all_busy); round robin with one cursor per
 *      pool that continues after the cursor even when that member is gone;
 *      simultaneous chats spread over the team (the per-workspace advisory
 *      lock); the guards (assigned, resolved, spam, suspended, "receive chats"
 *      off, the timeout's expected holder and skip list); the load count is a
 *      range on its partial index.
 *   D  chat_routing_due(): pre-chat deadlines, waits (retried, then
 *      forgotten when someone has the chat) and first-response timeouts
 *      (answered, reassigned by hand, switched off: forgotten).
 *   E  the engine for real (presence and transports are fakes): an AI-off
 *      conversation is routed at its first message to the least busy team
 *      member, never to staff, with an `assigned` event (method auto); the
 *      returning visitor's operator first; a department with nobody online
 *      falls back to the team unless the Super Admin turned the general pool
 *      off; nobody online = a wait with the honest notice, given out by the
 *      ticker once someone is here; the first-response timeout moves the chat
 *      on; a pre-chat form never sent stops holding routing; a plan without
 *      automatic assignment queues.
 *
 * Driven by TEST_DATABASE_URL; skipped without it.
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
  /** user id → routing presence state ('active' | 'away' | 'disconnected' | 'offline'). */
  presence: new Map<string, string>(),
  visitor: 'visitor-1' as string,
  events: [] as Array<Record<string, unknown>>,
  messages: [] as Array<Record<string, unknown>>,
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
vi.mock('../../../server/services/widget/crossWidgetIdentity.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/crossWidgetIdentity.js')>()),
  resolveSessionNetworkContext: async () => ({}),
  ensureVisitorSessionRow: async () => null,
  issueContinuityCookieForContact: async () => undefined,
}));
vi.mock('../../../server/services/realtime/publish.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/realtime/publish.js')>()),
  publishConversationEvent: async (_c: unknown, _ws: string, _cid: string, envelope: Record<string, unknown>) => {
    state.messages.push(envelope);
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

suite('chat routing on a real database (278)', () => {
  let chain: FullChainDatabase;
  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await chain.db.query(sql, params)).rows as Row[];
  const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];

  const owner = randomUUID();
  const a = randomUUID();
  const b = randomUUID();
  const c = randomUUID();
  const admin = randomUUID();
  const seo = randomUUID();
  const ws = randomUUID();
  const wsPlan = randomUUID();
  // Sorted ids, for the round robin.
  const [r1, r2, r3] = [randomUUID(), randomUUID(), randomUUID()].sort();
  const wsRr = randomUUID();

  let config: ReturnType<typeof import('../../../server/config.js')['loadConfig']>;
  let routing: typeof import('../../../server/services/chatRouting.js');
  let ticker: typeof import('../../../server/services/chatRoutingTicker.js');
  let resetCaches: () => void;
  let app: express.Express;
  const tokens: Record<string, string> = {};
  const as = (user: string) => ({ Authorization: `Bearer ${tokens[user]}` });

  const conversation = async (wsId: string, fields: { status?: string; assigned?: string | null; spam?: boolean; contact?: string | null; meta?: Row; updatedAgo?: string } = {}) => {
    const id = randomUUID();
    await q(`INSERT INTO public.conversations (id, workspace_id, status, assigned_to, is_spam, contact_id, metadata, updated_at)
             VALUES ($1, $2, $3::conversation_status, $4, $5, $6, $7::jsonb, now() - $8::interval)`,
    [id, wsId, fields.status ?? 'open', fields.assigned ?? null, fields.spam ?? false, fields.contact ?? null,
      JSON.stringify(fields.meta ?? {}), fields.updatedAgo ?? '0 seconds']);
    return id;
  };
  const message = async (cid: string, sender: 'contact' | 'agent', senderId: string | null = null, ago = '0 seconds') => {
    await q(`INSERT INTO public.conversation_messages (conversation_id, sender_type, sender_id, body, created_at)
             VALUES ($1, $2::sender_type, $3, 'hi', now() - $4::interval)`, [cid, sender, senderId, ago]);
  };
  const claim = async (cid: string, candidates: string[], order = 'least_busy', pool = 'team', method = 'auto', expected: string | null = null, wsId = ws) =>
    one(`SELECT * FROM public.chat_route_claim($1, $2, $3::uuid[], $4, $5, $6, $7)`, [wsId, cid, candidates, order, pool, method, expected]);
  const assignee = async (cid: string) => (await one(`SELECT assigned_to FROM public.conversations WHERE id = $1`, [cid])).assigned_to;
  const clearWorkspace = async (wsId: string) => {
    await q(`DELETE FROM public.conversations WHERE workspace_id = $1`, [wsId]);
    await q(`DELETE FROM public.chat_routing_members WHERE workspace_id = $1`, [wsId]);
    await q(`DELETE FROM public.chat_routing_cursors WHERE workspace_id = $1`, [wsId]);
  };

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `routing278_${Date.now()}`);
    for (const [id, name] of [[owner, 'Owner'], [a, 'Ali'], [b, 'Bahar'], [c, 'Cyrus'], [admin, 'Admin'], [seo, 'Seo'], [r1, 'R1'], [r2, 'R2'], [r3, 'R3']]) {
      await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, $3)`, [id, `p-${id.slice(0, 8)}@test.local`, name]);
    }
    for (const id of [ws, wsPlan, wsRr]) {
      await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [id, `ws-${id.slice(0, 8)}`, owner]);
      await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`, [id, owner]);
    }
    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES
               ($1, $2, 'support_agent'), ($1, $3, 'agent'), ($1, $4, 'sales_agent'), ($1, $5, 'admin'), ($1, $6, 'seo_manager'),
               ($7, $2, 'agent')`, [ws, a, b, c, admin, seo, wsPlan]);
    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'agent'), ($1, $3, 'agent'), ($1, $4, 'agent')`, [wsRr, r1, r2, r3]);
    await q(`INSERT INTO public.widget_settings (workspace_id, enabled, assignment_mode, first_response_timeout_minutes) VALUES ($1, true, 'auto', 5), ($2, true, 'auto', 5), ($3, true, 'round_robin', 5)`, [ws, wsPlan, wsRr]);
    // No pre-chat form (without a row of its own a workspace asks the default
    // one, and routing waits for it): E6 asks one.
    await q(`INSERT INTO public.widget_prechat_settings (workspace_id, ask_name, ask_email, ask_phone, require_name, require_email, prechat_timing)
             VALUES ($1, false, false, false, false, false, 'never'), ($2, false, false, false, false, false, 'never'), ($3, false, false, false, false, false, 'never')`, [ws, wsPlan, wsRr]);

    Object.assign(process.env, {
      DATABASE_URL: chain.url,
      PLATFORM_SIGNING_SECRET: 'signing-secret-for-this-test-only-0123456789',
      SUPABASE_URL: 'https://legacy-project.supabase.co',
      SUPABASE_ANON_KEY: 'legacy-anon-key-value',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-key-value-at-least-32',
      CORS_ORIGINS: 'http://127.0.0.1',
    });
    delete process.env.DATABASE_MODE;
    // Plans are not this suite's subject: every workspace may route
    // automatically, except in E6, which runs without this.
    config = { ...(await import('../../../server/config.js')).loadConfig(), selfHostBillingUnlimited: true };
    routing = await import('../../../server/services/chatRouting.js');
    ticker = await import('../../../server/services/chatRoutingTicker.js');
    const departments = await import('../../../server/services/calls/departments.js');
    const global = await import('../../../server/services/calls/globalAdvancedRouting.js');
    const snapshot = await import('../../../server/services/widget/configSnapshot.js');
    resetCaches = () => {
      for (const id of [ws, wsPlan, wsRr]) departments.invalidateDepartmentCache(id);
      global.__resetGlobalAdvancedRoutingCache();
      snapshot.__resetWidgetConfigCachesForTests();
    };
    const { widgetRouter } = await import('../../../server/routes/widget.js');
    const { workspaceMembersRouter } = await import('../../../server/routes/workspaceMembers.js');
    const { createSession } = await import('../../../server/services/auth/sessions.js');
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { Object.assign(req, { serverConfig: config }); next(); });
    app.use('/api/widget', widgetRouter);
    app.use('/api/workspace-members', workspaceMembersRouter);
    for (const id of [owner, a]) tokens[id] = (await createSession(config as never, { userId: id, email: `p-${id.slice(0, 8)}@test.local` })).token;
  }, 600_000);

  afterAll(async () => {
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer().catch(() => undefined);
    await chain?.drop();
  });

  beforeEach(async () => {
    state.presence.clear();
    state.events.length = 0;
    state.messages.length = 0;
    await q(`UPDATE public.workspace_members SET receives_chats = true, max_concurrent_chats = NULL, suspended_at = NULL WHERE workspace_id IN ($1, $2, $3)`, [ws, wsPlan, wsRr]);
    await q(`UPDATE public.widget_settings SET default_max_concurrent_chats = 5, first_response_timeout_minutes = 5, last_agent_routing_enabled = true`);
    await q(`DELETE FROM public.app_runtime_config WHERE key = 'global_advanced_routing'`);
    await clearWorkspace(ws);
    await clearWorkspace(wsRr);
    await clearWorkspace(wsPlan);
    resetCaches?.();
  });

  // ─── S: the atomic pick ────────────────────────────────────────────────

  it('S1 least busy counts only open and pending, non-spam conversations; ties go to whoever was given one least recently', async () => {
    // Ali: a long history (resolved, closed, a spam chat still open) but nothing open now.
    for (const status of ['resolved', 'resolved', 'resolved', 'closed']) await conversation(ws, { status, assigned: a });
    await conversation(ws, { assigned: a, spam: true });
    // Bahar: one open chat.
    await conversation(ws, { assigned: b });
    const first = await conversation(ws);
    expect(await claim(first, [b, a])).toEqual({ outcome: 'assigned', picked_user_id: a });
    // Now 1 each: the tie goes to Bahar, who routing never gave one (Ali just had one).
    const second = await conversation(ws);
    expect(await claim(second, [a, b])).toEqual({ outcome: 'assigned', picked_user_id: b });
    // A pending chat counts as load too.
    await q(`UPDATE public.conversations SET status = 'pending' WHERE id = $1`, [first]);
    const third = await conversation(ws);
    expect((await claim(third, [a, b, c])).picked_user_id).toBe(c);
    // The claim recorded what the ticker needs: the assignment and its timeout.
    const st = await one(`SELECT assigned_to, assign_method, timeout_due_at > now() + interval '4 minutes' AS due_later FROM public.chat_routing_state WHERE conversation_id = $1`, [third]);
    expect(st).toEqual({ assigned_to: c, assign_method: 'auto', due_later: true });
  });

  it('S2 capacity: the workspace default, a member\'s own maximum, and everyone full = all_busy', async () => {
    await q(`UPDATE public.widget_settings SET default_max_concurrent_chats = 2 WHERE workspace_id = $1`, [ws]);
    await q(`UPDATE public.workspace_members SET max_concurrent_chats = 1 WHERE workspace_id = $1 AND user_id = $2`, [ws, a]);
    await conversation(ws, { assigned: a });
    await conversation(ws, { assigned: b });
    await conversation(ws, { assigned: b, status: 'pending' });
    const cid = await conversation(ws);
    // Ali (1 of 1) and Bahar (2 of 2) are full; Cyrus is not.
    expect(await claim(cid, [a, b, c])).toEqual({ outcome: 'assigned', picked_user_id: c });
    const next = await conversation(ws);
    expect(await claim(next, [a, b])).toEqual({ outcome: 'all_busy', picked_user_id: null });
    expect(await assignee(next)).toBeNull();
    // Raising Ali's own maximum frees him.
    await q(`UPDATE public.workspace_members SET max_concurrent_chats = 3 WHERE workspace_id = $1 AND user_id = $2`, [ws, a]);
    expect((await claim(next, [a, b])).picked_user_id).toBe(a);
  });

  it('S3 round robin: one cursor per pool, continuing after the cursor even when that member is not a candidate any more', async () => {
    const picks: string[] = [];
    for (let i = 0; i < 4; i++) picks.push(String((await claim(await conversation(wsRr), [r3, r1, r2], 'round_robin', 'team', 'round_robin', null, wsRr)).picked_user_id));
    expect(picks).toEqual([r1, r2, r3, r1]);
    // Another pool (a department) rotates on its own.
    const dept = randomUUID();
    expect((await claim(await conversation(wsRr), [r2, r3], 'round_robin', dept, 'round_robin', null, wsRr)).picked_user_id).toBe(r2);
    expect((await claim(await conversation(wsRr), [r2, r3], 'round_robin', dept, 'round_robin', null, wsRr)).picked_user_id).toBe(r3);
    // The team's cursor is on r1; r1 goes offline: the next after r1 (r2), not the alphabetical first again.
    expect((await claim(await conversation(wsRr), [r2, r3], 'round_robin', 'team', 'round_robin', null, wsRr)).picked_user_id).toBe(r2);
    expect((await claim(await conversation(wsRr), [r1, r3], 'round_robin', 'team', 'round_robin', null, wsRr)).picked_user_id).toBe(r3);
    const cursors = await q(`SELECT pool_key, last_user_id FROM public.chat_routing_cursors WHERE workspace_id = $1`, [wsRr]);
    expect(Object.fromEntries(cursors.map((r) => [r.pool_key, r.last_user_id]))).toEqual({ [dept]: r3, team: r3 });
  });

  it('S4 simultaneous chats spread over the team instead of piling on one operator', async () => {
    const ids = await Promise.all([1, 2, 3, 4, 5, 6].map(() => conversation(ws)));
    const clients = await Promise.all(ids.map(async () => {
      const client = new pg.Client({ connectionString: chain.url });
      await client.connect();
      return client;
    }));
    try {
      await Promise.all(ids.map((cid, i) => clients[i].query(
        `SELECT * FROM public.chat_route_claim($1, $2, $3::uuid[], 'least_busy', 'team', 'auto')`, [ws, cid, [a, b, c]],
      )));
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
    const counts = await q(`SELECT assigned_to, count(*)::int AS n FROM public.conversations WHERE id = ANY($1::uuid[]) GROUP BY 1 ORDER BY 1`, [ids]);
    expect(counts.map((r) => r.n)).toEqual([2, 2, 2]);
  });

  it('S5 the guards: assigned, resolved, spam, suspended, "receive chats" off, the timeout\'s holder and skip list', async () => {
    const held = await conversation(ws, { assigned: b });
    expect(await claim(held, [a])).toEqual({ outcome: 'already_assigned', picked_user_id: b });
    expect((await claim(await conversation(ws, { status: 'resolved' }), [a])).outcome).toBe('not_routable');
    expect((await claim(await conversation(ws, { spam: true }), [a])).outcome).toBe('not_routable');
    await q(`UPDATE public.workspace_members SET suspended_at = now() WHERE workspace_id = $1 AND user_id = $2`, [ws, a]);
    await q(`UPDATE public.workspace_members SET receives_chats = false WHERE workspace_id = $1 AND user_id = $2`, [ws, c]);
    const free = await conversation(ws);
    expect(await claim(free, [a, c, randomUUID()])).toEqual({ outcome: 'none', picked_user_id: null });
    // A first-response timeout: only while Bahar still holds it, never back to her, and she joins the skip list.
    expect((await claim(held, [owner], 'least_busy', 'team', 'timeout_reassign', a)).outcome).toBe('assignment_changed');
    expect(await claim(held, [b, owner], 'least_busy', 'team', 'timeout_reassign', b)).toEqual({ outcome: 'assigned', picked_user_id: owner });
    expect((await one(`SELECT skip_user_ids FROM public.chat_routing_state WHERE conversation_id = $1`, [held])).skip_user_ids).toEqual([b]);
    await q(`UPDATE public.conversations SET assigned_to = NULL WHERE id = $1`, [held]);
    expect(await claim(held, [b])).toEqual({ outcome: 'none', picked_user_id: null });
  });

  it('S6 the load count is a range on its partial index', async () => {
    await q('SET enable_seqscan = off');
    const plan = (await q(`EXPLAIN SELECT count(*) FROM public.conversations c2
      WHERE c2.workspace_id = $1 AND c2.assigned_to = $2 AND c2.status IN ('open', 'pending') AND c2.is_spam = false`, [ws, a]))
      .map((r) => String(r['QUERY PLAN'])).join('\n');
    const contact = (await q(`EXPLAIN SELECT id FROM public.conversations WHERE workspace_id = $1 AND contact_id = $2 ORDER BY updated_at DESC LIMIT 1`, [ws, randomUUID()]))
      .map((r) => String(r['QUERY PLAN'])).join('\n');
    await q('RESET enable_seqscan');
    expect(plan).toContain('conversations_open_assignee_idx');
    expect(contact).toContain('conversations_contact_recent_idx');
  });

  // ─── D: the ticker's work list ─────────────────────────────────────────

  it('D1 chat_routing_due: pre-chat deadlines, waits and timeouts that fell due, and forgets what no longer applies', async () => {
    const due = async () => (await q(`SELECT due_conversation_id AS id, due_kind AS kind, due_assignee AS who FROM public.chat_routing_due(100)`))
      .map((r) => `${r.kind}:${r.id}${r.who ? `:${r.who}` : ''}`).sort();
    // Pre-chat: due only once the deadline passed and while routing still waits for it.
    const pre = await conversation(ws, { meta: { routing_pending: true } });
    const preDone = await conversation(ws, { meta: { routing_pending: false } });
    for (const cid of [pre, preDone]) {
      await q(`SELECT public.chat_routing_defer_prechat($1, $2, now() - interval '1 second')`, [ws, cid]);
    }
    const preLater = await conversation(ws, { meta: { routing_pending: true } });
    await q(`SELECT public.chat_routing_defer_prechat($1, $2, now() + interval '2 minutes')`, [ws, preLater]);
    // Waits: retried after 25 s; one somebody has meanwhile is forgotten.
    const wait = await conversation(ws);
    const taken = await conversation(ws);
    for (const cid of [wait, taken]) {
      await q(`SELECT public.chat_routing_wait($1, $2, 'nobody_online')`, [ws, cid]);
      await q(`UPDATE public.chat_routing_state SET waiting_retry_at = now() - interval '1 second' WHERE conversation_id = $1`, [cid]);
    }
    await q(`UPDATE public.conversations SET assigned_to = $2 WHERE id = $1`, [taken, b]);
    // Timeouts: Ali has not answered; Bahar did; Cyrus's chat was reassigned by hand.
    const silent = await conversation(ws);
    const answered = await conversation(ws);
    const moved = await conversation(ws);
    await claim(silent, [a], 'given');
    await claim(answered, [b], 'given');
    await claim(moved, [c], 'given');
    await message(answered, 'agent', b);
    await q(`UPDATE public.conversations SET assigned_to = $2 WHERE id = $1`, [moved, owner]);
    await q(`UPDATE public.chat_routing_state SET timeout_due_at = now() - interval '1 second', assigned_at = now() - interval '6 minutes'
             WHERE conversation_id = ANY($1::uuid[])`, [[silent, answered, moved]]);
    await q(`UPDATE public.conversation_messages SET created_at = now() - interval '1 minute' WHERE conversation_id = $1`, [answered]);

    expect(await due()).toEqual([`prechat:${pre}`, `timeout:${silent}:${a}`, `waiting:${wait}`].sort());
    // Handed out: not again on the next pass (the wait comes back in 25 s, the timeout in 2 minutes).
    expect(await due()).toEqual([]);
    const states = Object.fromEntries((await q(`SELECT conversation_id, prechat_deadline IS NULL AS no_deadline, waiting_since IS NULL AS not_waiting,
        timeout_due_at IS NULL AS no_timeout FROM public.chat_routing_state WHERE workspace_id = $1`, [ws]))
      .map((r) => [r.conversation_id, r]));
    expect(states[preDone]).toMatchObject({ no_deadline: true });
    expect(states[preLater]).toMatchObject({ no_deadline: false });
    expect(states[taken]).toMatchObject({ not_waiting: true });
    expect(states[wait]).toMatchObject({ not_waiting: false });
    expect(states[answered]).toMatchObject({ no_timeout: true });
    expect(states[moved]).toMatchObject({ no_timeout: true });
    expect(states[silent]).toMatchObject({ no_timeout: false });
    // The timeout switched off for the workspace: forgotten too.
    await q(`UPDATE public.chat_routing_state SET timeout_due_at = now() - interval '1 second' WHERE conversation_id = $1`, [silent]);
    await q(`UPDATE public.widget_settings SET first_response_timeout_minutes = 0 WHERE workspace_id = $1`, [ws]);
    expect(await due()).toEqual([]);
    // A chat routing waited on stops waiting when its workspace queues by hand (NULL reason).
    await q(`SELECT public.chat_routing_wait($1, $2, NULL)`, [ws, wait]);
    expect((await one(`SELECT waiting_since FROM public.chat_routing_state WHERE conversation_id = $1`, [wait])).waiting_since).toBeNull();
  });

  it('D2 more waiting chats than a pass takes turns (least recently tried first, a pass oldest wait first); idle waits back off, then are forgotten', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const cid = await conversation(ws);
      await q(`SELECT public.chat_routing_wait($1, $2, 'nobody_online')`, [ws, cid]);
      // ids[i] has waited 10 + i minutes (ids[6] longest), all due long ago.
      await q(`UPDATE public.chat_routing_state SET waiting_since = now() - make_interval(mins => $2), waiting_active_at = now() - make_interval(mins => $2),
                 waiting_retry_at = now() - make_interval(mins => $2) + interval '25 seconds' WHERE conversation_id = $1`, [cid, 10 + i]);
      ids.push(cid);
    }
    const pass = async (limit: number) => (await q(`SELECT due_conversation_id AS id FROM public.chat_routing_due($1) WHERE due_kind = 'waiting'`, [limit]))
      .map((r) => String(r.id));
    // The ticker's next pass, 30 seconds later.
    const later = () => q(`UPDATE public.chat_routing_state SET waiting_retry_at = waiting_retry_at - interval '30 seconds' WHERE workspace_id = $1 AND waiting_since IS NOT NULL`, [ws]);
    expect(await pass(3)).toEqual([ids[6], ids[5], ids[4]]);
    await later();
    // Those three were just tried: the next three go first, not the same ones again.
    expect(await pass(3)).toEqual([ids[3], ids[2], ids[1]]);
    await later();
    expect(await pass(3)).toEqual([ids[6], ids[5], ids[0]]);
    // A wait with activity in the last hour comes back in 25 seconds, an older one in 2 minutes.
    await q(`UPDATE public.chat_routing_state SET waiting_retry_at = now() - interval '1 second' WHERE conversation_id = ANY($1::uuid[])`, [[ids[0], ids[1]]]);
    await q(`UPDATE public.chat_routing_state SET waiting_active_at = now() - interval '2 hours' WHERE conversation_id = $1`, [ids[1]]);
    await pass(100);
    const retryIn = async (cid: string) => Number((await one(`SELECT extract(epoch FROM waiting_retry_at - now()) AS s FROM public.chat_routing_state WHERE conversation_id = $1`, [cid])).s);
    expect(await retryIn(ids[0])).toBeLessThanOrEqual(25);
    expect(await retryIn(ids[1])).toBeGreaterThan(100);
    // The ticker's own retry keeps that; the visitor writing again is activity.
    await q(`SELECT public.chat_routing_wait($1, $2, 'nobody_online', true)`, [ws, ids[1]]);
    expect(await retryIn(ids[1])).toBeGreaterThan(100);
    expect((await one(`SELECT waiting_active_at < now() - interval '1 hour' AS idle FROM public.chat_routing_state WHERE conversation_id = $1`, [ids[1]])).idle).toBe(true);
    await q(`SELECT public.chat_routing_wait($1, $2, 'all_busy')`, [ws, ids[1]]);
    expect(await retryIn(ids[1])).toBeLessThanOrEqual(25);
    expect(await one(`SELECT wait_reason, waiting_active_at > now() - interval '1 minute' AS active,
                        waiting_since < now() - interval '10 minutes' AS kept_since FROM public.chat_routing_state WHERE conversation_id = $1`, [ids[1]]))
      .toEqual({ wait_reason: 'all_busy', active: true, kept_since: true });
    // Nothing but the ticker for 24 hours: forgotten (the chat stays unassigned for the team).
    await q(`UPDATE public.chat_routing_state SET waiting_active_at = now() - interval '25 hours', waiting_retry_at = now() - interval '1 second' WHERE conversation_id = $1`, [ids[2]]);
    expect(await pass(100)).not.toContain(ids[2]);
    expect((await one(`SELECT waiting_since FROM public.chat_routing_state WHERE conversation_id = $1`, [ids[2]])).waiting_since).toBeNull();
    expect(await assignee(ids[2])).toBeNull();
  });

  // ─── E: the engine for real ────────────────────────────────────────────

  const contact = async (wsId: string) => String((await one(`INSERT INTO public.contacts (workspace_id, name) VALUES ($1, 'Visitor') RETURNING id`, [wsId])).id);
  const systemRows = async (cid: string) => (await q(`SELECT metadata FROM public.conversation_messages WHERE conversation_id = $1 AND sender_type = 'system' ORDER BY created_at`, [cid]))
    .map((r) => r.metadata as Row);
  /** The `assigned` events (written fire-and-forget: waited for, up to 3 s, until there are `atLeast`). */
  const assignedEvents = async (cid: string, atLeast = 1) => {
    const read = async () => (await q(`SELECT actor_type, payload FROM public.conversation_events WHERE conversation_id = $1 AND event_type = 'assigned' ORDER BY created_at`, [cid]))
      .map((r) => ({ actor: r.actor_type, ...(r.payload as Row) }));
    for (let i = 0; i < 60; i++) {
      const rows = await read();
      if (rows.length >= atLeast) return rows;
      await new Promise((r) => setTimeout(r, 50));
    }
    return read();
  };

  it('E1 AI off: the visitor\'s first message gets the least busy team member — never staff — with an `assigned` event', async () => {
    for (const id of [owner, a, b, c, admin, seo]) state.presence.set(id, 'active');
    await conversation(ws, { assigned: a });
    await conversation(ws, { assigned: owner });
    await conversation(ws, { assigned: c });
    // Staff hold nothing, and are here: still never picked.
    const cid = await conversation(ws, { contact: await contact(ws) });
    await message(cid, 'contact');
    const res = await routing.routeHumanBoundConversation(config as never, { workspaceId: ws, conversationId: cid, platformAiOff: true });
    expect(res).toEqual({ outcome: 'assigned_auto', assignedTo: b });
    expect(await assignee(cid)).toBe(b);
    expect(await assignedEvents(cid)).toEqual([{ actor: 'system', from: null, to: b, method: 'auto' }]);
    expect(await systemRows(cid)).toEqual([expect.objectContaining({ kind: 'routing_agent_joined', agent_name: 'Bahar', agent_id: b })]);
    // Nobody but staff is here: nobody gets it.
    state.presence.clear();
    for (const id of [admin, seo]) state.presence.set(id, 'active');
    const staffOnly = await conversation(ws, { contact: await contact(ws) });
    expect((await routing.routeHumanBoundConversation(config as never, { workspaceId: ws, conversationId: staffOnly, platformAiOff: true }))?.outcome)
      .toBe('no_eligible_agent');
    expect(await assignee(staffOnly)).toBeNull();
  });

  it('E2 the returning visitor goes back to their operator, when that operator is here and has room', async () => {
    for (const id of [a, b, c]) state.presence.set(id, 'active');
    const who = await contact(ws);
    // Cyrus handled this visitor last week; he is the busiest now.
    await conversation(ws, { contact: who, status: 'resolved', assigned: c, updatedAgo: '7 days' });
    await conversation(ws, { assigned: c });
    const cid = await conversation(ws, { contact: who });
    expect(await routing.routeConversationToOperator(config as never, { workspaceId: ws, conversationId: cid })).toEqual({ outcome: 'assigned_last_agent', assignedTo: c });
    expect((await assignedEvents(cid))[0]).toMatchObject({ method: 'last_agent', to: c });
    // Outside the window (default 30 days), or away: the normal distribution.
    const old = await contact(ws);
    await conversation(ws, { contact: old, status: 'resolved', assigned: c, updatedAgo: '40 days' });
    const later = await conversation(ws, { contact: old });
    expect((await routing.routeConversationToOperator(config as never, { workspaceId: ws, conversationId: later })).outcome).toBe('assigned_auto');
    state.presence.set(c, 'away');
    const third = await conversation(ws, { contact: who });
    expect((await routing.routeConversationToOperator(config as never, { workspaceId: ws, conversationId: third })).assignedTo).not.toBe(c);
  });

  it('E3 a department with nobody online falls back to the team, unless the Super Admin turned the general pool off', async () => {
    const dept = String((await one(`INSERT INTO public.workspace_departments (workspace_id, name) VALUES ($1, 'Sales') RETURNING id`, [ws])).id);
    await q(`INSERT INTO public.workspace_department_members (workspace_id, department_id, user_id) VALUES ($1, $2, $3)`, [ws, dept, c]);
    resetCaches();
    state.presence.set(a, 'active');
    const cid = await conversation(ws, { meta: { department_id: dept } });
    expect(await routing.routeConversationToOperator(config as never, { workspaceId: ws, conversationId: cid })).toEqual({ outcome: 'assigned_auto', assignedTo: a });
    // Cyrus is here: his department's chat goes to him.
    state.presence.set(c, 'active');
    const toSales = await conversation(ws, { meta: { department_id: dept } });
    expect((await routing.routeConversationToOperator(config as never, { workspaceId: ws, conversationId: toSales })).assignedTo).toBe(c);
    // General pool off, Cyrus gone: it waits (the owner, the fallback, is not here either).
    state.presence.delete(c);
    await q(`INSERT INTO public.app_runtime_config (key, value) VALUES ('global_advanced_routing', '{"general_pool_enabled": false}')`);
    resetCaches();
    const waits = await conversation(ws, { meta: { department_id: dept } });
    expect(await routing.routeConversationToOperator(config as never, { workspaceId: ws, conversationId: waits })).toEqual({ outcome: 'no_eligible_agent', assignedTo: null });
    // The owner is here: the owner fallback (global policy) takes it.
    state.presence.set(owner, 'active');
    expect(await routing.routeConversationToOperator(config as never, { workspaceId: ws, conversationId: waits })).toEqual({ outcome: 'assigned_owner_fallback', assignedTo: owner });
  });

  it('E4 nobody online: the chat waits with the honest notice, and the ticker gives it out once someone is here', async () => {
    const cid = await conversation(ws, { contact: await contact(ws) });
    expect(await routing.routeHumanBoundConversation(config as never, { workspaceId: ws, conversationId: cid, platformAiOff: true }))
      .toEqual({ outcome: 'no_eligible_agent', assignedTo: null });
    expect(await systemRows(cid)).toEqual([expect.objectContaining({ kind: 'routing_no_agent_available', reason: 'nobody_online' })]);
    expect((await one(`SELECT wait_reason FROM public.chat_routing_state WHERE conversation_id = $1`, [cid])).wait_reason).toBe('nobody_online');
    // Bahar arrives; the next pass (once the retry is due) assigns it, the visitor is told once.
    state.presence.set(b, 'active');
    await q(`UPDATE public.chat_routing_state SET waiting_retry_at = now() - interval '1 second' WHERE conversation_id = $1`, [cid]);
    const pass = await ticker.runChatRoutingOnce(config as never);
    expect(pass).toMatchObject({ waiting: 1, assigned: 1 });
    expect(await assignee(cid)).toBe(b);
    expect((await systemRows(cid)).map((m) => m.kind)).toEqual(['routing_no_agent_available', 'routing_agent_joined']);
    // Everyone at capacity: the queue notice.
    await q(`UPDATE public.widget_settings SET default_max_concurrent_chats = 1 WHERE workspace_id = $1`, [ws]);
    const busy = await conversation(ws, { contact: await contact(ws) });
    expect((await routing.routeHumanBoundConversation(config as never, { workspaceId: ws, conversationId: busy, platformAiOff: true }))?.outcome).toBe('all_agents_busy');
    expect(await systemRows(busy)).toEqual([expect.objectContaining({ kind: 'routing_in_queue', reason: 'all_busy' })]);
  });

  it('E5 the first-response timeout moves an unanswered chat to the next operator, never back', async () => {
    for (const id of [a, b]) state.presence.set(id, 'active');
    const cid = await conversation(ws, { contact: await contact(ws) });
    const first = await routing.routeConversationToOperator(config as never, { workspaceId: ws, conversationId: cid });
    const holder = String(first.assignedTo);
    const other = holder === a ? b : a;
    await q(`UPDATE public.chat_routing_state SET timeout_due_at = now() - interval '1 second', assigned_at = now() - interval '6 minutes' WHERE conversation_id = $1`, [cid]);
    const pass = await ticker.runChatRoutingOnce(config as never);
    expect(pass).toMatchObject({ timeout: 1, assigned: 1 });
    expect(await assignee(cid)).toBe(other);
    expect((await assignedEvents(cid, 2)).at(-1)).toMatchObject({ method: 'timeout_reassign', from: holder, to: other });
    expect((await one(`SELECT skip_user_ids FROM public.chat_routing_state WHERE conversation_id = $1`, [cid])).skip_user_ids).toEqual([holder]);
    // The next one answers in time: nothing moves.
    await message(cid, 'agent', other);
    await q(`UPDATE public.chat_routing_state SET timeout_due_at = now() - interval '1 second', assigned_at = now() - interval '6 minutes' WHERE conversation_id = $1`, [cid]);
    await q(`UPDATE public.conversation_messages SET created_at = now() - interval '1 minute' WHERE conversation_id = $1 AND sender_type = 'agent'`, [cid]);
    expect(await ticker.runChatRoutingOnce(config as never)).toMatchObject({ timeout: 0 });
    expect(await assignee(cid)).toBe(other);
  });

  it('E5b nobody to take a timed-out chat over: it leaves the silent operator and waits; the next one to come gets it, never the skipped', async () => {
    state.presence.set(a, 'active');
    const cid = await conversation(ws, { contact: await contact(ws) });
    expect((await routing.routeConversationToOperator(config as never, { workspaceId: ws, conversationId: cid })).assignedTo).toBe(a);
    await q(`UPDATE public.chat_routing_state SET timeout_due_at = now() - interval '1 second', assigned_at = now() - interval '6 minutes' WHERE conversation_id = $1`, [cid]);
    expect(await ticker.runChatRoutingOnce(config as never)).toMatchObject({ timeout: 1, assigned: 0 });
    expect(await assignee(cid)).toBeNull();
    const st = await one(`SELECT skip_user_ids, wait_reason, waiting_since IS NOT NULL AS waiting, timeout_due_at FROM public.chat_routing_state WHERE conversation_id = $1`, [cid]);
    // Nobody but Ali is here, and he is passed over: nobody online.
    expect(st).toEqual({ skip_user_ids: [a], wait_reason: 'nobody_online', waiting: true, timeout_due_at: null });
    expect((await systemRows(cid)).map((m) => m.kind)).toEqual(['routing_agent_joined', 'routing_no_agent_available']);
    const unassigned = await q(`SELECT payload FROM public.conversation_events WHERE conversation_id = $1 AND event_type = 'unassigned'`, [cid]);
    for (let i = 0; i < 60 && !unassigned.length; i++) {
      await new Promise((r) => setTimeout(r, 50));
      unassigned.push(...await q(`SELECT payload FROM public.conversation_events WHERE conversation_id = $1 AND event_type = 'unassigned'`, [cid]));
    }
    expect(unassigned[0].payload).toEqual({ from: a, to: null, method: 'timeout_release' });
    // Ali is still here (skipped); Bahar arrives: the next pass gives it to her.
    state.presence.set(b, 'active');
    await q(`UPDATE public.chat_routing_state SET waiting_retry_at = now() - interval '1 second' WHERE conversation_id = $1`, [cid]);
    expect(await ticker.runChatRoutingOnce(config as never)).toMatchObject({ waiting: 1, assigned: 1 });
    expect(await assignee(cid)).toBe(b);
  });

  it('E6 a pre-chat form never sent stops holding routing; a plan without automatic assignment queues', async () => {
    await q(`UPDATE public.widget_prechat_settings SET ask_name = true, prechat_timing = 'after_handoff' WHERE workspace_id = $1`, [ws]);
    state.presence.set(a, 'active');
    const cid = await conversation(ws, { contact: await contact(ws) });
    expect(await routing.routeHumanBoundConversation(config as never, { workspaceId: ws, conversationId: cid, platformAiOff: true }))
      .toEqual({ outcome: 'routing_deferred', assignedTo: null });
    expect((await one(`SELECT metadata FROM public.conversations WHERE id = $1`, [cid])).metadata).toMatchObject({ routing_pending: true });
    expect((await one(`SELECT prechat_deadline > now() + interval '100 seconds' AS later FROM public.chat_routing_state WHERE conversation_id = $1`, [cid])).later).toBe(true);
    await q(`UPDATE public.chat_routing_state SET prechat_deadline = now() - interval '1 second' WHERE conversation_id = $1`, [cid]);
    expect(await ticker.runChatRoutingOnce(config as never)).toMatchObject({ prechat: 1, assigned: 1 });
    expect(await assignee(cid)).toBe(a);
    expect((await one(`SELECT metadata FROM public.conversations WHERE id = $1`, [cid])).metadata).toMatchObject({ routing_pending: false });
    await q(`UPDATE public.widget_prechat_settings SET ask_name = false, prechat_timing = 'never' WHERE workspace_id = $1`, [ws]);

    // No plan grants widget_assignment_routing here: the stored 'auto' routes as manual.
    const planless = { ...config, selfHostBillingUnlimited: false };
    const queued = await conversation(wsPlan);
    state.presence.set(a, 'active');
    expect(await routing.routeConversationToOperator(planless as never, { workspaceId: wsPlan, conversationId: queued }))
      .toEqual({ outcome: 'manual_queue', assignedTo: null });
    expect(await assignee(queued)).toBeNull();
  });
  it('E0 the widget\'s /message: a new conversation with the AI off is routed at its first message', async () => {
    const { __resetWidgetRateLimitsForTests } = await import('../../../server/services/widget/security.js');
    __resetWidgetRateLimitsForTests();
    state.presence.set(c, 'active');
    state.visitor = `visitor-${randomUUID().slice(0, 8)}`;
    const sent = await request(app).post('/api/widget/message')
      .send({ workspace_id: ws, message: 'سلام، سفارشم کجاست؟', visitor_id: state.visitor, session_id: randomUUID() });
    expect(sent.status).toBe(200);
    const cid = String(sent.body.conversation_id);
    // Fire-and-forget after the answer: waited for.
    for (let i = 0; i < 60 && !(await assignee(cid)); i++) await new Promise((r) => setTimeout(r, 50));
    expect(await assignee(cid)).toBe(c);
    expect((await assignedEvents(cid))[0]).toMatchObject({ method: 'auto', to: c });
    // The next message on the same (assigned) conversation routes nothing more.
    await request(app).post('/api/widget/message').send({ workspace_id: ws, conversation_id: cid, message: 'و هزینهٔ ارسال؟', visitor_id: state.visitor });
    await new Promise((r) => setTimeout(r, 200));
    expect(await assignedEvents(cid)).toHaveLength(1);
  });

  it('E7 the widget\'s online/offline counts only members who receive chats; the owner switches a member\'s chats off and sets their maximum', async () => {
    const { resolveAvailability } = await import('../../../server/services/widget/availability.js');
    const online = async () => (await resolveAvailability(config as never, { workspaceId: ws })).state;
    // Nobody set a status: everyone is available, staff included.
    expect(await online()).toBe('online');
    // The owner turns off "Receive chats automatically" for every team member, and their own.
    const rows = await q(`SELECT id, user_id FROM public.workspace_members WHERE workspace_id = $1`, [ws]);
    const rowOf = (user: string) => String(rows.find((r) => r.user_id === user)!.id);
    for (const user of [owner, a, b, c]) {
      const res = await request(app).patch(`/api/workspace-members/${rowOf(user)}/chat-routing?workspaceId=${ws}`).set(as(owner)).send({ receives_chats: false });
      expect(res.status).toBe(200);
      expect(res.body.member).toMatchObject({ user_id: user, receives_chats: false });
    }
    // Only staff (admin, SEO) remain available: the widget is offline — the
    // live config's cached snapshot counts the same members.
    expect(await online()).toBe('offline');
    resetCaches();
    const { getWorkspaceWidgetSnapshot } = await import('../../../server/services/widget/configSnapshot.js');
    const snap = await getWorkspaceWidgetSnapshot(config as never, ws);
    expect(snap.availabilityPrefs.chatMemberIds).toEqual([]);
    expect(snap.availabilityPrefs.memberIds).toHaveLength(6);
    expect((await resolveAvailability(config as never, { workspaceId: ws, availabilityPrefs: snap.availabilityPrefs })).state).toBe('offline');
    // Back on for Bahar, suspended: still offline. Reinstated: online.
    await request(app).patch(`/api/workspace-members/${rowOf(b)}/chat-routing?workspaceId=${ws}`).set(as(owner)).send({ receives_chats: true, max_concurrent_chats: 3 });
    await q(`UPDATE public.workspace_members SET suspended_at = now() WHERE workspace_id = $1 AND user_id = $2`, [ws, b]);
    resetCaches();
    expect(await online()).toBe('offline');
    await q(`UPDATE public.workspace_members SET suspended_at = NULL WHERE workspace_id = $1 AND user_id = $2`, [ws, b]);
    resetCaches();
    expect(await online()).toBe('online');
    expect((await getWorkspaceWidgetSnapshot(config as never, ws)).availabilityPrefs.chatMemberIds).toEqual([b]);
    expect((await one(`SELECT max_concurrent_chats FROM public.workspace_members WHERE id = $1`, [rowOf(b)])).max_concurrent_chats).toBe(3);
    // The listing carries both; a team member may not change them; out-of-range values are refused.
    const list = await request(app).get(`/api/workspace-members?workspaceId=${ws}`).set(as(owner));
    expect((list.body.members as Row[]).find((m) => m.user_id === b)).toMatchObject({ receives_chats: true, max_concurrent_chats: 3 });
    expect((await request(app).patch(`/api/workspace-members/${rowOf(b)}/chat-routing?workspaceId=${ws}`).set(as(a)).send({ receives_chats: false })).status).toBe(403);
    expect((await request(app).patch(`/api/workspace-members/${rowOf(b)}/chat-routing?workspaceId=${ws}`).set(as(owner)).send({ max_concurrent_chats: 51 })).status).toBe(400);
    expect((await request(app).patch(`/api/workspace-members/${randomUUID()}/chat-routing?workspaceId=${ws}`).set(as(owner)).send({ receives_chats: true })).status).toBe(404);
  });
});
