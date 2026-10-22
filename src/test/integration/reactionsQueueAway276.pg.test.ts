// @vitest-environment node
/**
 * Round 3 of issue #340 through the REAL routes and services on the real data
 * layer (postgres-only), on a database built by the whole chain, 276
 * included:
 *
 *   R1  reactions: the visitor's ❤️ (GET / POST /api/widget/conversations/:id/
 *       reactions) and an operator's (POST /api/conversations/:id/messages/
 *       :messageId/reactions): one row per actor and emoji (the visitor's NULL
 *       id counts once: NULLS NOT DISTINCT), idempotent both ways, each change
 *       touching the message's updated_at so the inbox's ?since= sync returns
 *       it; the answers and the event name nobody; the operator messages API
 *       summarizes for its reader; the inbox offers React only where the
 *       workspace's effective template (the real snapshot) shows reactions;
 *       before 276 the reads are empty and a write 503s;
 *   Q1  the queue: routing in mode `manual` stamps queued_at and the entry
 *       place; GET /api/widget/queue answers 1, 2, 3 in queue order, skips
 *       assigned, closed, spam and other workspaces' conversations, gives the
 *       wait only from 3 measured claims; the claim trigger samples first
 *       assignments; the count uses the partial index; a hand-back keeps its
 *       place and is announced once (Q2), at once from the inbox's own
 *       unassign, the real PATCH (Q3);
 *   A1  the away thread: POST /api/widget/offline-messages with a client id
 *       (replayed: the same ids, nothing new) and POST /api/widget/identity/
 *       offline-email (only for an `offline` conversation; merged as an
 *       unverified claim, linked, the cookie issued);
 *   P1  the visitor's /history, /poll and /identity/history carry no operator
 *       id; erasing a contact clears its rating comments (chat, timeline
 *       copy, call) and keeps the scores.
 *
 * Driven by TEST_DATABASE_URL; skipped without it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createFullChainDatabase, type FullChainDatabase } from './fullChainDatabase';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

type Next = () => void;
type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  visitor: 'visitor-1' as string | null,
  operator: '' as string,
  events: [] as Array<Record<string, unknown>>,
  conv: [] as Array<Record<string, unknown>>,
  sent: [] as Array<Record<string, unknown>>,
  cookies: [] as string[],
}));

// The away thread's email step is dormant while visitor email is off
// (shared/visitorEmail.ts, owner decision 2026-10-21; the route then answers
// 403 visitor_email_disabled): this suite tests the kept code with it on.
vi.mock('../../../shared/visitorEmail.js', () => ({ VISITOR_EMAIL_FEATURES_ENABLED: true, VISITOR_EMAIL_TEMPLATE_OPTIONS: ['transcriptEmail'] }));
vi.mock('../../../server/services/widget/security.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/security.js')>()),
  enforceWidgetToken: (_req: unknown, _res: unknown, next: Next) => next(),
  enforceOrigin: (_req: unknown, _res: unknown, next: Next) => next(),
}));
vi.mock('../../../server/services/widget/visitorIdentity.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/visitorIdentity.js')>()),
  readVisitorCookie: () => (state.visitor ? { v: state.visitor } : null),
  resolveVisitorIdentity: () => ({ visitorId: state.visitor || 'minted', isNew: false }),
}));
vi.mock('../../../server/services/widget/crossWidgetIdentity.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/crossWidgetIdentity.js')>()),
  resolveSessionNetworkContext: async () => ({}),
  ensureVisitorSessionRow: async () => null,
  issueContinuityCookieForContact: async (_sb: unknown, _req: unknown, _res: unknown, _ws: string, contactId: string) => {
    state.cookies.push(contactId);
  },
}));
vi.mock('../../../server/lib/workspaceAuth.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/lib/workspaceAuth.js')>()),
  authorizeWorkspaceAccess: async () => ({ userId: state.operator, isAdmin: false, role: 'agent' }),
}));
vi.mock('../../../server/services/realtime/publish.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/realtime/publish.js')>()),
  publishConversationEvent: async (_c: unknown, _ws: string, _cid: string, envelope: Record<string, unknown>) => {
    state.conv.push(envelope);
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
vi.mock('../../../server/services/email/index.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/email/index.js')>()),
  sendEmail: async (_c: unknown, request: Record<string, unknown>) => { state.sent.push(request); return { success: true, provider: 'resend' }; },
}));
vi.mock('../../../server/services/widget/availability.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/availability.js')>()),
  resolveAvailability: async () => ({ state: 'offline', reason: 'outside_hours', next_open_at: null }),
}));

const HEART = '❤️';

suite('reactions, the queue and the away thread on a real database (276)', () => {
  let chain: FullChainDatabase;
  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await chain.db.query(sql, params)).rows as Row[];
  const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];

  const owner = randomUUID();
  const sara = randomUUID();
  const ali = randomUUID();
  const ws = randomUUID();
  const wsDefault = randomUUID();
  const wsOther = randomUUID();

  let config: ReturnType<typeof import('../../../server/config.js')['loadConfig']>;
  let server: http.Server;
  let resetCaches: () => void;

  const call = (method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<{ status: number; body: Row }> =>
    new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : '';
      const req = http.request({
        host: '127.0.0.1', port: (server.address() as AddressInfo).port, path, method,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: d ? JSON.parse(d) : null }));
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });

  /** A widget conversation of visitor-1's (metadata.visitor_id: its ownership anchor). */
  const conversation = async (wsId: string, fields: { status?: string; assigned?: string | null; meta?: Row; spam?: boolean; tags?: string[] } = {}) => {
    const cid = randomUUID();
    await q(`INSERT INTO public.conversations (id, workspace_id, status, assigned_to, metadata, is_spam, tags)
             VALUES ($1, $2, $3::conversation_status, $4, $5::jsonb, $6, $7)`,
    [cid, wsId, fields.status ?? 'open', fields.assigned ?? null, JSON.stringify({ visitor_id: 'visitor-1', ...(fields.meta || {}) }), fields.spam ?? false, fields.tags ?? []]);
    return cid;
  };
  const message = async (cid: string, sender: string, metadata: Row = {}, senderId: string | null = null): Promise<string> => {
    const id = randomUUID();
    await q(`INSERT INTO public.conversation_messages (id, conversation_id, sender_type, sender_id, body, metadata)
             VALUES ($1, $2, $3::sender_type, $4, 'hi', $5::jsonb)`, [id, cid, sender, senderId, JSON.stringify(metadata)]);
    return id;
  };
  const touched = async (mid: string) => String((await one(`SELECT updated_at::text AS t FROM public.conversation_messages WHERE id = $1`, [mid])).t);

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `s3r276_${Date.now()}`);
    for (const [id, name] of [[owner, 'Owner'], [sara, 'Sara'], [ali, 'Ali']]) {
      await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, $3)`, [id, `p-${id.slice(0, 8)}@test.local`, name]);
    }
    for (const id of [ws, wsDefault, wsOther]) {
      await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [id, `ws-${id.slice(0, 8)}`, owner]);
      await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'admin')
               ON CONFLICT DO NOTHING`, [id, sara, ali]);
    }
    await q(`UPDATE public.platform_settings SET region_mode = 'iran'`);
    await q(`INSERT INTO public.widget_edition_settings (edition, chat_templates) VALUES ('iran', $1::jsonb)
             ON CONFLICT (edition) DO UPDATE SET chat_templates = EXCLUDED.chat_templates`,
    [JSON.stringify({ default: 'default', items: { t2: { enabled: true } } })]);
    await q(`INSERT INTO public.widget_settings (workspace_id, enabled, widget_template_id, assignment_mode) VALUES ($1, true, 't2', 'manual')`, [ws]);
    await q(`INSERT INTO public.widget_settings (workspace_id, enabled) VALUES ($1, true)`, [wsDefault]);
    await q(`INSERT INTO public.widget_settings (workspace_id, enabled, assignment_mode) VALUES ($1, true, 'manual')`, [wsOther]);

    Object.assign(process.env, {
      DATABASE_URL: chain.url,
      PLATFORM_SIGNING_SECRET: 'signing-secret-for-this-test-only-0123456789',
      SUPABASE_URL: 'https://legacy-project.supabase.co',
      SUPABASE_ANON_KEY: 'legacy-anon-key-value',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-key-value-at-least-32',
      CORS_ORIGINS: 'http://127.0.0.1',
    });
    delete process.env.DATABASE_MODE;
    config = (await import('../../../server/config.js')).loadConfig();
    const snapshot = await import('../../../server/services/widget/configSnapshot.js');
    const region = await import('../../../server/services/platformRegion.js');
    resetCaches = () => {
      snapshot.__resetWidgetConfigCachesForTests();
      region.invalidatePlatformRegionCache();
    };
    resetCaches();
    const { widgetRouter } = await import('../../../server/routes/widget.js');
    const { conversationsRouter } = await import('../../../server/routes/conversations.js');
    const app = express();
    app.use((req, _res, next) => { Object.assign(req, { serverConfig: config }); next(); });
    app.use(express.json());
    app.use('/api/widget', widgetRouter);
    app.use('/api/conversations', conversationsRouter);
    server = http.createServer(app).listen(0);
  }, 600_000);

  afterAll(async () => {
    server?.close();
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer();
    await chain?.drop();
  });

  beforeEach(async () => {
    state.visitor = 'visitor-1';
    state.operator = sara;
    state.events.length = 0;
    state.conv.length = 0;
    state.sent.length = 0;
    state.cookies.length = 0;
    const { __resetWidgetRateLimitsForTests } = await import('../../../server/services/widget/security.js');
    __resetWidgetRateLimitsForTests();
  });

  it('R1 reactions: the visitor\'s ❤️ and the operators\' through the real routes and the unique key', async () => {
    const cid = await conversation(ws);
    const reply = await message(cid, 'agent', {}, sara);
    const asked = await message(cid, 'contact');
    const visitorReact = (mid: string, on: boolean, emoji = HEART) =>
      call('POST', `/api/widget/conversations/${cid}/reactions`, { workspace_id: ws, message_id: mid, emoji, on });
    const operatorReact = (mid: string, emoji: string, on: boolean) =>
      call('POST', `/api/conversations/${cid}/messages/${mid}/reactions`, { workspace_id: ws, emoji, on });

    const before = await touched(reply);
    const first = await visitorReact(reply, true, '❤');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, message_id: reply, reactions: [{ emoji: HEART, count: 1, mine: true }] });
    expect(await touched(reply)).not.toBe(before);
    // Twice: the visitor's NULL id is one actor (NULLS NOT DISTINCT), nothing changes.
    const mid = await touched(reply);
    expect((await visitorReact(reply, true)).body.reactions).toEqual([{ emoji: HEART, count: 1, mine: true }]);
    expect(await touched(reply)).toBe(mid);
    expect(await q(`SELECT actor_type, actor_id, emoji FROM public.conversation_message_reactions WHERE message_id = $1`, [reply]))
      .toEqual([{ actor_type: 'visitor', actor_id: null, emoji: HEART }]);
    expect(state.events).toHaveLength(1);
    // Four tabs at once: one row, every answer 200 with the same count, no second event.
    await visitorReact(reply, false);
    state.events.length = 0;
    const racing = await Promise.all([1, 2, 3, 4].map(() => visitorReact(reply, true)));
    expect(racing.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    for (const r of racing) expect(r.body.reactions).toEqual([{ emoji: HEART, count: 1, mine: true }]);
    expect(await q(`SELECT 1 FROM public.conversation_message_reactions WHERE message_id = $1`, [reply])).toHaveLength(1);
    expect(state.events).toHaveLength(1);

    // Operators react to the visitor's message (t2 workspace), each their own.
    expect((await operatorReact(asked, '👍', true)).body.reactions).toEqual([{ emoji: '👍', count: 1, visitor: false, mine: true }]);
    state.operator = ali;
    expect((await operatorReact(asked, '👍', true)).body.reactions).toEqual([{ emoji: '👍', count: 2, visitor: false, mine: true }]);
    expect((await operatorReact(reply, HEART, true)).status).toBe(422);
    // The operator messages API, for Ali: his own `mine`, can_react on the visitor's message only.
    const thread = await call('GET', `/api/conversations/${cid}/messages`);
    const rows = Object.fromEntries((thread.body.messages as Row[]).map((m) => [m.id, m]));
    expect(rows[asked]).toMatchObject({ reactions: [{ emoji: '👍', count: 2, visitor: false, mine: true }], can_react: true });
    expect(rows[reply]).toMatchObject({ reactions: [{ emoji: HEART, count: 1, visitor: true, mine: false }] });
    expect(rows[reply]).not.toHaveProperty('can_react');
    // The ?since sync returns a message whose reactions changed.
    const cursor = (thread.body.sync as { cursor: string }).cursor;
    await new Promise((r) => setTimeout(r, 5));
    await operatorReact(asked, '👍', false);
    const delta = await call('GET', `/api/conversations/${cid}/messages?since=${encodeURIComponent(cursor)}`);
    expect((delta.body.messages as Row[]).map((m) => m.id)).toContain(asked);
    expect((delta.body.messages as Row[]).find((m) => m.id === asked)).toMatchObject({ reactions: [{ emoji: '👍', count: 1, mine: false }] });

    // The visitor's read: counts and their own part, no ids.
    const read = await call('GET', `/api/widget/conversations/${cid}/reactions?workspace_id=${ws}`);
    expect(read.body.reactions).toEqual({
      [reply]: [{ emoji: HEART, count: 1, mine: true }],
      [asked]: [{ emoji: '👍', count: 1, mine: false }],
    });
    expect(JSON.stringify([read.body, state.events])).not.toMatch(new RegExp(`${sara}|${ali}`));

    // Taking back the visitor's heart leaves the row of nobody else.
    expect((await visitorReact(reply, false)).body.reactions).toEqual([]);
    expect(await q(`SELECT 1 FROM public.conversation_message_reactions WHERE message_id = $1`, [reply])).toHaveLength(0);

    // A default workspace: no React for operators.
    const plain = await conversation(wsDefault);
    const plainAsk = await message(plain, 'contact');
    resetCaches();
    expect((await call('POST', `/api/conversations/${plain}/messages/${plainAsk}/reactions`, { workspace_id: wsDefault, emoji: HEART, on: true })).body)
      .toEqual({ error: 'reactions_not_shown' });
    expect((await call('GET', `/api/conversations/${plain}/messages`)).body.messages).toEqual([expect.not.objectContaining({ can_react: true })]);

    // Before 276: empty reads, a 503 write, never a 500.
    await q(`ALTER TABLE public.conversation_message_reactions RENAME TO conversation_message_reactions_away`);
    try {
      expect(await call('GET', `/api/widget/conversations/${cid}/reactions?workspace_id=${ws}`)).toMatchObject({ status: 200, body: { reactions: {} } });
      expect(await visitorReact(reply, true)).toMatchObject({ status: 503, body: { code: 'migration_required' } });
      const t = await call('GET', `/api/conversations/${cid}/messages`);
      expect(t.status).toBe(200);
      expect((t.body.messages as Row[]).some((m) => 'can_react' in m || 'reactions' in m)).toBe(false);
    } finally {
      await q(`ALTER TABLE public.conversation_message_reactions_away RENAME TO conversation_message_reactions`);
    }
  });

  it('Q1 the queue: stamped by routing, counted in order on the partial index, the wait from 3 claims', async () => {
    const { routeConversationToOperator } = await import('../../../server/services/chatRouting.js');
    const route = (cid: string, wsId = ws) => routeConversationToOperator(config, { workspaceId: wsId, conversationId: cid });
    const pos = async (cid: string, wsId = ws) => (await call('GET', `/api/widget/queue?workspace_id=${wsId}&conversation_id=${cid}`)).body;

    const a = await conversation(ws);
    const b = await conversation(ws);
    const c = await conversation(ws);
    for (const cid of [a, b, c]) {
      expect((await route(cid)).outcome).toBe('manual_queue');
      await new Promise((r) => setTimeout(r, 3));
    }
    const meta = (await one(`SELECT metadata FROM public.conversations WHERE id = $1`, [c])).metadata as Row;
    expect(meta).toMatchObject({ routing_outcome: 'manual_queue', routing_notice_sent: true, queue_entry_position: 3 });
    expect(typeof meta.queued_at).toBe('string');
    expect(await pos(a)).toEqual({ position: 1, wait_minutes: null });
    expect(await pos(b)).toEqual({ position: 2, wait_minutes: null });
    expect(await pos(c)).toEqual({ position: 3, wait_minutes: null });
    // A routing re-run keeps the place.
    await route(a);
    expect(await pos(a)).toEqual({ position: 1, wait_minutes: null });

    // Assigned, closed, spam and another workspace's conversations do not count; nor are they "in" the queue.
    const other = await conversation(wsOther);
    await route(other, wsOther);
    expect(await pos(other, wsOther)).toEqual({ position: 1, wait_minutes: null });
    await q(`UPDATE public.conversations SET is_spam = true WHERE id = $1`, [a]);
    expect(await pos(b)).toEqual({ position: 1, wait_minutes: null });
    expect(await pos(a)).toEqual({ position: null, wait_minutes: null });
    await q(`UPDATE public.conversations SET is_spam = false WHERE id = $1`, [a]);

    // Claims: each first assignment of a queued row is a sample; from the third the wait shows.
    for (const [cid, waited] of [[a, 120], [b, 240]] as const) {
      await q(`UPDATE public.conversations SET metadata = jsonb_set(metadata, '{queued_at}', to_jsonb((now() - make_interval(secs => $2))::text))
               WHERE id = $1`, [cid, waited]);
      await q(`UPDATE public.conversations SET assigned_to = $2 WHERE id = $1`, [cid, sara]);
    }
    expect(await pos(a)).toEqual({ position: null, wait_minutes: null });
    expect(await pos(c)).toEqual({ position: 1, wait_minutes: null });
    const d = await conversation(ws);
    await route(d);
    await q(`UPDATE public.conversations SET metadata = jsonb_set(metadata, '{queued_at}', to_jsonb((now() - interval '60 seconds')::text)) WHERE id = $1`, [c]);
    await q(`UPDATE public.conversations SET assigned_to = $2 WHERE id = $1`, [c, ali]);
    const stats = await one(`SELECT samples, seconds_per_place FROM public.chat_queue_stats WHERE workspace_id = $1`, [ws]);
    expect(Number(stats.samples)).toBe(3);
    const wait = await pos(d);
    expect(wait.position).toBe(1);
    expect(wait.wait_minutes).toBe(Math.max(1, Math.ceil(Number(stats.seconds_per_place) / 60)));
    // A closed conversation is not waiting.
    await q(`UPDATE public.conversations SET status = 'resolved' WHERE id = $1`, [d]);
    expect(await pos(d)).toEqual({ position: null, wait_minutes: null });

    // The count is a range on the partial index.
    await q('SET enable_seqscan = off');
    const plan = (await q(`EXPLAIN SELECT count(*) FROM public.conversations c
      WHERE c.workspace_id = $1 AND c.assigned_to IS NULL AND (c.metadata->>'routing_outcome') = 'manual_queue'
        AND (c.metadata->>'queued_at') <= '9999' AND c.status IN ('open', 'pending') AND c.is_spam = false`, [ws]))
      .map((r) => String(r['QUERY PLAN'])).join('\n');
    await q('RESET enable_seqscan');
    expect(plan).toContain('conversations_manual_queue_idx');
  });

  it('Q2 a hand-back: the place kept, a new queue row from routing, the next claim measured from the return', async () => {
    const { routeConversationToOperator } = await import('../../../server/services/chatRouting.js');
    const wsQ = wsOther;
    const route = (cid: string) => routeConversationToOperator(config, { workspaceId: wsQ, conversationId: cid });
    const pos = async (cid: string) => (await call('GET', `/api/widget/queue?workspace_id=${wsQ}&conversation_id=${cid}`)).body;
    const queueRows = async (cid: string) => (await one(
      `SELECT count(*)::int AS n FROM public.conversation_messages WHERE conversation_id = $1 AND metadata->>'kind' = 'routing_in_queue'`, [cid])).n;
    await q(`DELETE FROM public.conversations WHERE workspace_id = $1`, [wsQ]);
    await q(`DELETE FROM public.chat_queue_stats WHERE workspace_id = $1`, [wsQ]);

    const first = await conversation(wsQ);
    const second = await conversation(wsQ);
    for (const cid of [first, second]) {
      await route(cid);
      await new Promise((r) => setTimeout(r, 3));
    }
    expect(await queueRows(first)).toBe(1);
    const queuedAt = ((await one(`SELECT metadata FROM public.conversations WHERE id = $1`, [first])).metadata as Row).queued_at;
    // Claimed by Sara, then handed back (the inbox's unassign: assigned_to → NULL).
    await q(`UPDATE public.conversations SET assigned_to = $2 WHERE id = $1`, [first, sara]);
    expect(await pos(second)).toEqual({ position: 1, wait_minutes: null });
    await q(`UPDATE public.conversations SET assigned_to = NULL WHERE id = $1`, [first]);
    const back = (await one(`SELECT metadata FROM public.conversations WHERE id = $1`, [first])).metadata as Row;
    expect(back).toMatchObject({ queued_at: queuedAt, queue_entry_position: 1 });
    expect(typeof back.queue_reentered_at).toBe('string');
    // Its place again: first.
    expect(await pos(first)).toEqual({ position: 1, wait_minutes: null });
    expect(await pos(second)).toEqual({ position: 2, wait_minutes: null });
    // The next routing run tells the visitor again, once.
    expect((await route(first)).outcome).toBe('manual_queue');
    expect(await queueRows(first)).toBe(2);
    await route(first);
    expect(await queueRows(first)).toBe(2);
    // Claimed again: sampled from the return (seconds), not from the first entry.
    await q(`UPDATE public.conversations SET metadata = jsonb_set(metadata, '{queued_at}', to_jsonb((now() - interval '2 hours')::text)) WHERE id = $1`, [first]);
    await q(`UPDATE public.conversations SET assigned_to = $2 WHERE id = $1`, [first, ali]);
    const stats = await one(`SELECT samples, seconds_per_place FROM public.chat_queue_stats WHERE workspace_id = $1`, [wsQ]);
    expect(Number(stats.samples)).toBe(2);
    expect(Number(stats.seconds_per_place)).toBeLessThan(600);
  });

  it('Q3 the inbox\'s unassign (the real PATCH): the queue row at once, after the internal notice, once', async () => {
    const { routeConversationToOperator } = await import('../../../server/services/chatRouting.js');
    const wsQ = wsOther;
    const route = (cid: string) => routeConversationToOperator(config, { workspaceId: wsQ, conversationId: cid });
    const kinds = async (cid: string) => (await q(
      `SELECT coalesce(metadata->>'kind', sender_type::text) AS kind FROM public.conversation_messages WHERE conversation_id = $1 ORDER BY created_at, id`, [cid]))
      .map((r) => r.kind);
    const visitorKinds = (cid: string) => state.conv
      .filter((e) => e.type === 'message' && (e.payload as Row).conversation_id === cid)
      .map((e) => ((e.payload as Row).metadata as Row | null)?.kind);
    await q(`DELETE FROM public.conversations WHERE workspace_id = $1`, [wsQ]);

    const cid = await conversation(wsQ);
    await message(cid, 'contact');
    await route(cid);
    await q(`UPDATE public.conversations SET assigned_to = $2 WHERE id = $1`, [cid, sara]);
    state.conv.length = 0;
    state.operator = sara;
    const res = await call('PATCH', `/api/conversations/${cid}`, { workspace_id: wsQ, assigned_to: null });
    expect(res.status).toBe(200);
    // Routing ran in the PATCH's background work: the visitor's row is there without a message of theirs.
    const end = Date.now() + 5000;
    while ((await kinds(cid)).filter((k) => k === 'routing_in_queue').length < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    expect(await kinds(cid)).toEqual(['contact', 'routing_in_queue', 'conversation_unassigned', 'routing_in_queue']);
    expect(visitorKinds(cid)).toEqual(['routing_in_queue']);
    const meta = (await one(`SELECT metadata FROM public.conversations WHERE id = $1`, [cid])).metadata as Row;
    expect(typeof meta.queue_reentered_at).toBe('string');
    expect(meta.queue_return_notice_at).toBe(meta.queue_reentered_at);
    expect((await call('GET', `/api/widget/queue?workspace_id=${wsQ}&conversation_id=${cid}`)).body.position).toBe(1);
    // The visitor's next message routes again: nothing more.
    await route(cid);
    expect((await kinds(cid)).filter((k) => k === 'routing_in_queue')).toHaveLength(2);
    expect(visitorKinds(cid)).toEqual(['routing_in_queue']);
  });

  it('A1 the away thread: a replay-safe first message, then the email for the reply', async () => {
    const cmid = 'local_1760778000000_ab12cd';
    const first = await call('POST', '/api/widget/offline-messages', { workspace_id: ws, message: '?', client_message_id: cmid, locale: 'fa' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, captured: true, transitioning: false });
    const cid = first.body.conversation_id as string;
    const mid = first.body.message_id as string;
    expect(await one(`SELECT tags, metadata FROM public.conversations WHERE id = $1`, [cid])).toMatchObject({
      tags: ['offline'], metadata: { source: 'offline_capture', visitor_id: 'visitor-1', channel_thread_key: `widget_cmid:${cmid}` },
    });
    expect((await one(`SELECT metadata FROM public.conversation_messages WHERE id = $1`, [mid])).metadata).toMatchObject({ client_message_id: cmid });
    const again = await call('POST', '/api/widget/offline-messages', { workspace_id: ws, message: '?', client_message_id: cmid, locale: 'fa' });
    expect(again.body).toEqual({ ok: true, captured: true, conversation_id: cid, transitioning: false, message_id: mid });
    expect(await q(`SELECT 1 FROM public.conversation_messages WHERE conversation_id = $1`, [cid])).toHaveLength(1);
    expect(await q(`SELECT 1 FROM public.conversations WHERE metadata->>'channel_thread_key' = $1`, [`widget_cmid:${cmid}`])).toHaveLength(1);
    // The client id alone finds nobody's capture: without the cookie it is a capture of its own.
    state.visitor = null;
    const cookieless = await call('POST', '/api/widget/offline-messages', { workspace_id: ws, message: '?', client_message_id: cmid, locale: 'fa' });
    expect(cookieless.status).toBe(200);
    expect(cookieless.body.conversation_id).not.toBe(cid);
    expect((await call('POST', '/api/widget/offline-messages', { workspace_id: ws, message: '?', client_message_id: cmid })).body.conversation_id)
      .toBe(cookieless.body.conversation_id);
    state.visitor = 'visitor-1';
    expect((await call('POST', '/api/widget/offline-messages', { workspace_id: ws, message: '?', client_message_id: cmid })).body.conversation_id).toBe(cid);

    // The address for the reply: merged, the conversation linked, the cookie issued.
    const saved = await call('POST', '/api/widget/identity/offline-email', { workspace_id: ws, conversation_id: cid, email: 'ali.r@example.com' });
    expect(saved.status).toBe(200);
    const contactId = saved.body.contact_id as string;
    expect((await one(`SELECT contact_id FROM public.conversations WHERE id = $1`, [cid])).contact_id).toBe(contactId);
    expect(state.cookies).toEqual([contactId]);
    // Somebody else's address is never a link to their contact.
    const theirs = randomUUID();
    await q(`INSERT INTO public.contacts (id, workspace_id, email, name) VALUES ($1, $2, 'taken@example.com', 'Other')`, [theirs, ws]);
    const second = await call('POST', '/api/widget/offline-messages', { workspace_id: ws, message: 'سلام', client_message_id: 'local_1760778000001_zz99yy' });
    const claim = await call('POST', '/api/widget/identity/offline-email', { workspace_id: ws, conversation_id: second.body.conversation_id, email: 'taken@example.com' });
    expect(claim.status).toBe(200);
    expect(claim.body.contact_id).not.toBe(theirs);
    // A conversation not captured while away: 409, nothing merged.
    const normal = await conversation(ws);
    expect((await call('POST', '/api/widget/identity/offline-email', { workspace_id: ws, conversation_id: normal, email: 'x@example.com' })).body)
      .toEqual({ error: 'not_offline_capture' });
    state.visitor = 'visitor-2';
    expect((await call('POST', '/api/widget/identity/offline-email', { workspace_id: ws, conversation_id: cid, email: 'x@example.com' })).status).toBe(403);
  });

  it('P1 no operator id reaches the visitor; erasing a contact clears its rating comments, keeps the scores', async () => {
    const cid = await conversation(ws, { assigned: sara });
    await message(cid, 'agent', { source: 'inbox' }, sara);
    await message(cid, 'system', { kind: 'routing_agent_joined', agent_id: sara, agent_name: 'Sara', actor_id: ali });
    await message(cid, 'system', { kind: 'conversation_transferred', actor_id: ali, from_id: ali, to_id: sara, to_name: 'Sara' });
    const closedId = await message(cid, 'system', { kind: 'conversation_closed', agent_id: ali, agent_name: 'Ali', operator_id: sara, operator_name: 'Sara' });
    for (const path of [`history?workspace_id=${ws}&conversation_id=${cid}`, `poll?workspace_id=${ws}&conversation_id=${cid}`]) {
      const res = await call('GET', `/api/widget/${path}`);
      expect(res.status, path).toBe(200);
      expect((res.body.messages as Row[]).length, path).toBe(4);
      expect(JSON.stringify(res.body), path).not.toMatch(new RegExp(`${sara}|${ali}`));
    }

    // Erasure: the chat rating's comment, its timeline copy and a call rating's comment.
    const contact = randomUUID();
    await q(`INSERT INTO public.contacts (id, workspace_id, name, email) VALUES ($1, $2, 'Erase Me', 'erase@example.com')`, [contact, ws]);
    await q(`UPDATE public.conversations SET contact_id = $2 WHERE id = $1`, [cid, contact]);
    await q(`INSERT INTO public.conversation_ratings (workspace_id, conversation_id, closed_message_id, operator_id, score, comment)
             VALUES ($1, $2, $3, $4, 2, 'my phone is 0912 000 0000')`, [ws, cid, closedId, sara]);
    await q(`INSERT INTO public.conversation_events (workspace_id, conversation_id, event_type, actor_type, payload)
             VALUES ($1, $2, 'rated', 'visitor', $3::jsonb)`, [ws, cid, JSON.stringify({ score: 2, comment: 'my phone is 0912 000 0000', closed_id: closedId })]);
    const call1 = randomUUID();
    await q(`INSERT INTO public.call_sessions (id, workspace_id, provider, call_type, context_type, context_id)
             VALUES ($1, $2, 'livekit', 'audio', 'conversation', $3)`, [call1, ws, cid]);
    await q(`INSERT INTO public.call_ratings (workspace_id, call_session_id, rating, comment) VALUES ($1, $2, 4, 'call me at home')`, [ws, call1]);

    const { runAnonymize } = await import('../../../server/services/privacy/anonymizer.js');
    const job = {
      id: randomUUID(), workspace_id: ws, actor_user_id: owner, subject_type: 'contact', subject_id: contact,
      resolved_identity: { contact_ids: [contact], visitor_ids: [], emails: [] }, action: 'anonymize', status: 'running', scope: {},
    } as unknown as Parameters<typeof runAnonymize>[1];
    const summary = await runAnonymize(config, job);
    expect(summary.rating_comments_cleared).toBe(3);
    expect(await one(`SELECT score, comment FROM public.conversation_ratings WHERE conversation_id = $1`, [cid])).toEqual({ score: 2, comment: null });
    expect((await one(`SELECT payload FROM public.conversation_events WHERE conversation_id = $1 AND event_type = 'rated'`, [cid])).payload)
      .toEqual({ score: 2, comment: null, closed_id: closedId });
    expect(await one(`SELECT rating, comment FROM public.call_ratings WHERE call_session_id = $1`, [call1])).toEqual({ rating: 4, comment: null });
    // Run again: nothing left to clear.
    expect((await runAnonymize(config, job)).rating_comments_cleared).toBe(0);
  });
});
