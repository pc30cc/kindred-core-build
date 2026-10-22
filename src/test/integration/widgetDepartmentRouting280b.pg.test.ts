// @vitest-environment node
/**
 * The department a visitor picks in the widget, end to end, on a real
 * database built by the whole chain (280b included; R-13, R-22):
 *
 *   P  the picker (GET /api/widget/departments/visible) offers the
 *      workspace's chat departments; the visitor's first message (POST
 *      /api/widget/message with department_id) is routed by
 *      routeConversationToOperator to that department's operator, not the
 *      team's least busy one; the department stays on the conversation and
 *      on the message. An id that is not one of this workspace's chat
 *      departments is dropped: the team's distribution, no department kept.
 *   Q  in the manual queue the visitor's place (GET /api/widget/queue,
 *      chat_queue_status) counts their own department's queue only, at
 *      entry (queue_entry_position), after a claim and after a hand-back
 *      (the return trigger).
 *
 * Presence, realtime and push are fakes (as chatRouting278.pg.test.ts).
 * Driven by TEST_DATABASE_URL; skipped without it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { createFullChainDatabase, type FullChainDatabase } from './fullChainDatabase';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

type Row = Record<string, unknown>;
type Next = () => void;
const state = vi.hoisted(() => ({
  /** user id → routing presence state ('active' | 'away' | …). */
  presence: new Map<string, string>(),
  visitor: 'visitor-1' as string,
}));

vi.mock('../../../server/services/widget/operatorPresence.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/operatorPresence.js')>()),
  readRoutingPresence: async (_c: unknown, _ws: string, ids: string[]) =>
    new Map(ids.filter((id) => state.presence.has(id)).map((id) => [id, { state: state.presence.get(id)!, lastActivityAt: Date.now() - 60_000 }])),
}));
vi.mock('../../../server/services/widget/security.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/security.js')>()),
  // The widget's token names its workspace (the picker asks with no
  // workspace_id of its own): the one the request names.
  enforceWidgetToken: (req: { query?: Row; body?: Row; _widgetWorkspaceId?: string }, _res: unknown, next: Next) => {
    const named = req.query?.workspace_id ?? req.body?.workspace_id;
    if (typeof named === 'string') req._widgetWorkspaceId = named;
    next();
  },
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
  publishConversationEvent: async () => ({ ok: true }),
  publishOperatorEvent: async () => undefined,
}));
vi.mock('../../../server/services/push/index.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/push/index.js')>()),
  notifyInboundMessage: async () => undefined,
  notifyHandoff: async () => undefined,
  notifyAssignment: async () => undefined,
}));

suite('the visitor\'s department, from the picker to an operator and a place in the queue (280b)', () => {
  let chain: FullChainDatabase;
  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await chain.db.query(sql, params)).rows as Row[];
  const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];

  const owner = randomUUID();
  const ali = randomUUID();   // team, no department
  const bahar = randomUUID(); // Support
  const cyrus = randomUUID(); // Sales
  const ws = randomUUID();
  const wsOther = randomUUID();
  let sales = '';
  let support = '';
  let foreign = '';

  let config: ReturnType<typeof import('../../../server/config.js')['loadConfig']>;
  let resetCaches: () => void;
  let resetRateLimits: () => void;
  let app: express.Express;

  const conversation = async (fields: { assigned?: string | null } = {}) => {
    const id = randomUUID();
    await q(`INSERT INTO public.conversations (id, workspace_id, status, assigned_to, metadata) VALUES ($1, $2, 'open', $3, '{}'::jsonb)`,
      [id, ws, fields.assigned ?? null]);
    return id;
  };
  const meta = async (cid: string) => (await one(`SELECT metadata FROM public.conversations WHERE id = $1`, [cid])).metadata as Row;
  const assignee = async (cid: string) => (await one(`SELECT assigned_to FROM public.conversations WHERE id = $1`, [cid])).assigned_to;
  /** Fire-and-forget after the widget's answer: waited for. */
  const until = async <T>(read: () => Promise<T>, done: (v: T) => boolean): Promise<T> => {
    let v = await read();
    for (let i = 0; i < 100 && !done(v); i++) {
      await new Promise((r) => setTimeout(r, 50));
      v = await read();
    }
    return v;
  };
  /** A new visitor's first message, as the widget sends it after the picker. */
  const firstMessage = async (department: string | null) => {
    resetRateLimits();
    state.visitor = `visitor-${randomUUID().slice(0, 8)}`;
    const sent = await request(app).post('/api/widget/message').send({
      workspace_id: ws,
      message: 'سلام، یک سؤال دارم',
      visitor_id: state.visitor,
      session_id: randomUUID(),
      ...(department ? { department_id: department } : {}),
    });
    expect(sent.status).toBe(200);
    return { cid: String(sent.body.conversation_id), visitor: state.visitor };
  };
  const place = async (cid: string, visitor: string) => {
    state.visitor = visitor;
    const res = await request(app).get('/api/widget/queue').query({ workspace_id: ws, conversation_id: cid, visitor_id: visitor });
    expect(res.status).toBe(200);
    return res.body as { position: number | null; wait_minutes: number | null };
  };

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `deptroute280b_${Date.now()}`);
    for (const [id, name] of [[owner, 'Owner'], [ali, 'Ali'], [bahar, 'Bahar'], [cyrus, 'Cyrus']]) {
      await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, $3)`, [id, `p-${id.slice(0, 8)}@test.local`, name]);
    }
    for (const id of [ws, wsOther]) {
      await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [id, `ws-${id.slice(0, 8)}`, owner]);
      await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`, [id, owner]);
    }
    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'agent'), ($1, $3, 'support_agent'), ($1, $4, 'sales_agent')`,
      [ws, ali, bahar, cyrus]);
    sales = String((await one(`INSERT INTO public.workspace_departments (workspace_id, name, sort_order) VALUES ($1, 'Sales', 1) RETURNING id`, [ws])).id);
    support = String((await one(`INSERT INTO public.workspace_departments (workspace_id, name, sort_order) VALUES ($1, 'Support', 2) RETURNING id`, [ws])).id);
    foreign = String((await one(`INSERT INTO public.workspace_departments (workspace_id, name) VALUES ($1, 'Elsewhere') RETURNING id`, [wsOther])).id);
    await q(`INSERT INTO public.workspace_department_members (workspace_id, department_id, user_id) VALUES ($1, $2, $3), ($1, $4, $5)`,
      [ws, sales, cyrus, support, bahar]);
    await q(`INSERT INTO public.widget_settings (workspace_id, enabled, assignment_mode, first_response_timeout_minutes) VALUES ($1, true, 'auto', 0)`, [ws]);
    // No pre-chat form (without a row of its own the default one is asked, and routing waits for it).
    await q(`INSERT INTO public.widget_prechat_settings (workspace_id, ask_name, ask_email, ask_phone, require_name, require_email, prechat_timing)
             VALUES ($1, false, false, false, false, false, 'never')`, [ws]);

    Object.assign(process.env, {
      DATABASE_URL: chain.url,
      PLATFORM_SIGNING_SECRET: 'signing-secret-for-this-test-only-0123456789',
      SUPABASE_URL: 'https://legacy-project.supabase.co',
      SUPABASE_ANON_KEY: 'legacy-anon-key-value',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-key-value-at-least-32',
      CORS_ORIGINS: 'http://127.0.0.1',
    });
    delete process.env.DATABASE_MODE;
    // Plans are not this suite's subject: automatic assignment is allowed.
    config = { ...(await import('../../../server/config.js')).loadConfig(), selfHostBillingUnlimited: true };
    const departments = await import('../../../server/services/calls/departments.js');
    const global = await import('../../../server/services/calls/globalAdvancedRouting.js');
    const snapshot = await import('../../../server/services/widget/configSnapshot.js');
    const security = await import('../../../server/services/widget/security.js');
    resetCaches = () => {
      departments.invalidateDepartmentCache(ws);
      global.__resetGlobalAdvancedRoutingCache();
      snapshot.__resetWidgetConfigCachesForTests();
    };
    resetRateLimits = () => security.__resetWidgetRateLimitsForTests();
    const { widgetRouter } = await import('../../../server/routes/widget.js');
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { Object.assign(req, { serverConfig: config }); next(); });
    app.use('/api/widget', widgetRouter);
  }, 600_000);

  afterAll(async () => {
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer().catch(() => undefined);
    await chain?.drop();
  });

  beforeEach(async () => {
    state.presence.clear();
    await q(`DELETE FROM public.conversations WHERE workspace_id = $1`, [ws]);
    await q(`DELETE FROM public.chat_routing_members WHERE workspace_id = $1`, [ws]);
    await q(`DELETE FROM public.chat_queue_stats WHERE workspace_id = $1`, [ws]);
    await q(`UPDATE public.widget_settings SET assignment_mode = 'auto' WHERE workspace_id = $1`, [ws]);
    resetCaches?.();
  });

  it('P1 the picked department\'s operator gets the chat, not the team\'s least busy; the department stays on it', async () => {
    for (const id of [ali, bahar, cyrus]) state.presence.set(id, 'active');
    // Cyrus (Sales) is the busiest; Ali, in no department, has nothing.
    await conversation({ assigned: cyrus });
    await conversation({ assigned: cyrus });

    // The picker: both chat departments, someone online in each.
    resetRateLimits();
    const picker = await request(app).get('/api/widget/departments/visible').query({ workspace_id: ws, channel: 'chat' });
    expect(picker.status).toBe(200);
    expect(picker.body.mode).toBe('multi');
    expect(picker.body.visible_departments.map((d: Row) => [d.id, d.name, d.online])).toEqual([[sales, 'Sales', true], [support, 'Support', true]]);

    const { cid } = await firstMessage(sales);
    expect(await until(() => assignee(cid), (v) => !!v)).toBe(cyrus);
    expect(await meta(cid)).toMatchObject({ department_id: sales, routing_outcome: 'assigned_auto' });
    const msg = await one(`SELECT metadata FROM public.conversation_messages WHERE conversation_id = $1 AND sender_type = 'contact'`, [cid]);
    expect((msg.metadata as Row).department_id).toBe(sales);
    const event = await until(
      () => q(`SELECT payload FROM public.conversation_events WHERE conversation_id = $1 AND event_type = 'assigned'`, [cid]),
      (rows) => rows.length > 0,
    );
    expect(event[0].payload).toMatchObject({ method: 'auto', to: cyrus });

    // Support, in another letter case (the picker's ids are lowercase): Bahar.
    const second = await firstMessage(support.toUpperCase());
    expect(await until(() => assignee(second.cid), (v) => !!v)).toBe(bahar);
    expect((await meta(second.cid)).department_id).toBe(support);
  });

  it('P2 a department that is not one of this workspace\'s chat departments is dropped: the team\'s distribution', async () => {
    for (const id of [ali, bahar, cyrus]) state.presence.set(id, 'active');
    await conversation({ assigned: bahar });
    await conversation({ assigned: cyrus });
    for (const dept of [foreign, randomUUID()]) {
      const { cid } = await firstMessage(dept);
      expect(await until(() => assignee(cid), (v) => !!v)).toBe(ali);
      expect((await meta(cid)).department_id).toBeUndefined();
      const msg = await one(`SELECT metadata FROM public.conversation_messages WHERE conversation_id = $1 AND sender_type = 'contact'`, [cid]);
      expect((msg.metadata as Row).department_id).toBeUndefined();
      await q(`UPDATE public.conversations SET status = 'resolved' WHERE id = $1`, [cid]);
    }
    // A department switched off for chat is not one either.
    await q(`UPDATE public.workspace_departments SET chat_enabled = false WHERE id = $1`, [support]);
    resetCaches();
    const { cid } = await firstMessage(support);
    expect(await until(() => assignee(cid), (v) => !!v)).toBe(ali);
    expect((await meta(cid)).department_id).toBeUndefined();
    await q(`UPDATE public.workspace_departments SET chat_enabled = true WHERE id = $1`, [support]);
  });

  it('Q1 in the manual queue the visitor\'s place counts their own department\'s queue', async () => {
    await q(`UPDATE public.widget_settings SET assignment_mode = 'manual' WHERE workspace_id = $1`, [ws]);
    resetCaches();
    const queued = async (department: string | null) => {
      const v = await firstMessage(department);
      const m = await until(() => meta(v.cid), (x) => x.routing_outcome === 'manual_queue' && typeof x.queue_entry_position === 'number');
      return { ...v, entry: m.queue_entry_position, department: m.department_id };
    };
    // In this order: Sales, Support, Sales, none.
    const s1 = await queued(sales);
    const p1 = await queued(support);
    const s2 = await queued(sales);
    const n1 = await queued(null);
    expect([s1.department, p1.department, s2.department, n1.department]).toEqual([sales, support, sales, undefined]);
    // The place at entry, per department (the whole workspace counted 1, 2, 3, 4).
    expect([s1.entry, p1.entry, s2.entry, n1.entry]).toEqual([1, 1, 2, 1]);
    expect((await place(s1.cid, s1.visitor)).position).toBe(1);
    expect((await place(p1.cid, p1.visitor)).position).toBe(1);
    expect((await place(s2.cid, s2.visitor)).position).toBe(2);
    expect((await place(n1.cid, n1.visitor)).position).toBe(1);

    // Cyrus takes the first Sales chat: the second is next.
    await q(`UPDATE public.conversations SET assigned_to = $2 WHERE id = $1`, [s1.cid, cyrus]);
    expect(await place(s1.cid, s1.visitor)).toEqual({ position: null, wait_minutes: null });
    expect((await place(s2.cid, s2.visitor)).position).toBe(1);
    expect((await place(p1.cid, p1.visitor)).position).toBe(1);

    // He hands it back: it keeps its place, ahead of the other Sales chat.
    await q(`UPDATE public.conversations SET assigned_to = NULL WHERE id = $1`, [s1.cid]);
    expect((await place(s1.cid, s1.visitor)).position).toBe(1);
    expect((await place(s2.cid, s2.visitor)).position).toBe(2);
    // He takes the second one and hands it back too: the return is recorded
    // at its place in the Sales queue (behind the first Sales chat; the
    // Support chat queued before it does not count).
    await q(`UPDATE public.conversations SET assigned_to = $2 WHERE id = $1`, [s2.cid, cyrus]);
    await q(`UPDATE public.conversations SET assigned_to = NULL WHERE id = $1`, [s2.cid]);
    expect((await meta(s2.cid)).queue_entry_position).toBe(2);
    expect((await place(s2.cid, s2.visitor)).position).toBe(2);
    // The Support visitor's place never moved with Sales.
    expect((await place(p1.cid, p1.visitor)).position).toBe(1);
  });
});
