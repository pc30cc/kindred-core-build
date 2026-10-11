// @vitest-environment node
/**
 * Simple billing phase 4, part 5 of the design (§5, §6): seats, channels and
 * storage, against a database built by the whole chain (migration 264
 * included), through the real data layer in postgres-only mode and the real
 * Express routes.
 *
 *   - Seats: past `max_agents - 1` non-owner, non-suspended members (oldest
 *     first) the most recently joined are paused: 403 `seat_locked` on every
 *     workspace route, `seat_locked` on the member list and on /me, never
 *     routed, never notified (push and email). The owner never is.
 *   - A suspension frees a seat: the cache is dropped and whoever is still
 *     paused loses their open chats to the queue; routing also hands back a
 *     chat a paused member still holds.
 *   - Channels the plan no longer has are stopped: ingest answers 200 and
 *     queues nothing, the worker's queued updates and Yahoo mail are dropped,
 *     an outbound intent is cancelled, plugin settings are refused. A channel
 *     override brings it back.
 *   - Storage over the limit blocks new uploads (403), not existing data.
 *   - Kill switch: with billing locks off, every one of these behaves as
 *     before.
 *
 * Driven by TEST_DATABASE_URL; skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { createFullChainDatabase, type FullChainDatabase } from './fullChainDatabase';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

type Row = Record<string, unknown>;

suite('billing locks: seats, channels and storage against the real chain', () => {
  let chain: FullChainDatabase;
  let config: Record<string, unknown>;
  let app: express.Express;
  let state: typeof import('../../../server/services/billing/locks/state.js');
  let stops: typeof import('../../../server/services/billing/planStops.js');
  const q = async (sql: string, p: unknown[] = []) => (await chain.db.query(sql, p)).rows as Row[];
  const one = async (sql: string, p: unknown[] = []) => (await q(sql, p))[0];

  const SECRET = 'internal-secret-for-this-test-0123456789';
  let ws = '';
  let owner = '';
  /** a joined first, then b, then c; d is suspended. */
  let a = '';
  let b = '';
  let c = '';
  let d = '';
  const tokens: Record<string, string> = {};
  let memberRowA = '';
  let integration = '';
  const PUBLIC_ID = `pub-${randomUUID()}`;

  async function profile(name: string): Promise<string> {
    const id = randomUUID();
    await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, $3)`, [id, `${name}-${id.slice(0, 6)}@test.local`, name]);
    return id;
  }

  async function switchTo(on: boolean) {
    await q(`INSERT INTO public.billing_settings (edition, locks_enabled) VALUES ('international', $1)
             ON CONFLICT (edition) DO UPDATE SET locks_enabled = EXCLUDED.locks_enabled`, [on]);
    state.clearLockStateCache();
    stops.clearPlanStopCache();
  }

  const as = (user: string) => ({ Authorization: `Bearer ${tokens[user]}` });

  async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 4000): Promise<T> {
    const until = Date.now() + ms;
    let v = await read();
    while (!ok(v) && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 50));
      v = await read();
    }
    return v;
  }

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `billing_locks_seats_${Date.now()}`);
    Object.assign(process.env, {
      DATABASE_URL: chain.url,
      PLATFORM_SIGNING_SECRET: 'signing-secret-for-this-test-only-0123456789',
      SUPABASE_URL: 'https://legacy-project.supabase.co',
      SUPABASE_ANON_KEY: 'legacy-anon-key-value',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-key-value-at-least-32',
      APP_BASE_URL: 'http://127.0.0.1:5173',
    });
    delete process.env.DATABASE_MODE;
    await q(`UPDATE public.platform_settings SET region_mode = 'multi'`);

    const plan = String((await one(
      `INSERT INTO public.billing_plans (name, slug, prices, limits, entitlements, is_active, is_free, is_hidden, sort_order)
       VALUES ('Seats', 'seats-x', $1, $2, $3, true, false, false, 10) RETURNING id`,
      [
        JSON.stringify({ USD: { monthly: 900, yearly: 9000 } }),
        // Two seats: the owner's and one more.
        JSON.stringify({ max_agents: 2, storage_gb: 1 }),
        JSON.stringify({ telegram: false, yahoomail: false, chat_widget: true }),
      ])).id);

    owner = await profile('owner');
    ws = randomUUID();
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Seats Inc', $2, $3)`, [ws, `seats-${ws.slice(0, 8)}`, owner]);
    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'owner', now() - interval '400 days')
             ON CONFLICT (workspace_id, user_id) DO NOTHING`, [ws, owner]);
    a = await profile('agent-a');
    b = await profile('agent-b');
    c = await profile('agent-c');
    d = await profile('agent-d');
    memberRowA = String((await one(`INSERT INTO public.workspace_members (workspace_id, user_id, role, created_at)
             VALUES ($1, $2, 'agent', now() - interval '30 days') RETURNING id`, [ws, a])).id);
    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'agent', now() - interval '20 days')`, [ws, b]);
    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'agent', now() - interval '10 days')`, [ws, c]);
    // Suspended, and the most recent: holds no seat and never ranks (D3).
    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role, created_at, suspended_at)
             VALUES ($1, $2, 'agent', now() - interval '1 day', now())`, [ws, d]);
    await q(`INSERT INTO public.workspace_subscriptions (workspace_id, plan_id, status, billing_interval, provider_name, current_period_start, current_period_end)
             VALUES ($1, $2, 'active', 'monthly', 'account', now() - interval '10 days', now() + interval '20 days')
             ON CONFLICT (workspace_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, status = 'active',
               current_period_start = EXCLUDED.current_period_start, current_period_end = EXCLUDED.current_period_end`, [ws, plan]);

    const installation = String((await one(
      `INSERT INTO public.workspace_plugin_installations (workspace_id, plugin_id, status) VALUES ($1, 'telegram', 'installed') RETURNING id`, [ws])).id);
    integration = String((await one(
      `INSERT INTO public.channel_integrations (workspace_id, installation_id, provider, public_integration_id, status)
       VALUES ($1, $2, 'telegram', $3, 'connected') RETURNING id`, [ws, installation, PUBLIC_ID])).id);
  }, 600_000);

  afterAll(async () => {
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer().catch(() => undefined);
    await chain?.drop();
  });

  it('loads the server and its routes on the chain', async () => {
    const { loadConfig } = await import('../../../server/config.js');
    config = { ...(loadConfig() as unknown as Record<string, unknown>), coreInternalSecret: SECRET };
    state = await import('../../../server/services/billing/locks/state.js');
    stops = await import('../../../server/services/billing/planStops.js');
    const { workspaceMembersRouter } = await import('../../../server/routes/workspaceMembers.js');
    const { pluginsRouter } = await import('../../../server/routes/plugins.js');
    const { internalChannelsRouter } = await import('../../../server/routes/internalChannels.js');
    const { createSession } = await import('../../../server/services/auth/sessions.js');

    app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use((req, _res, next) => { (req as unknown as { serverConfig: unknown }).serverConfig = config; next(); });
    app.use('/api/workspace-members', workspaceMembersRouter);
    app.use('/api/plugins', pluginsRouter);
    app.use('/internal/channels', internalChannelsRouter);

    for (const [name, id] of Object.entries({ owner, a, b, c })) {
      const session = await createSession(config as never, { userId: id, email: `${name}@test.local` });
      tokens[id] = session.token;
    }
    expect(await state.readLocksEnabled(config as never)).toBe(false);
  });

  it('switch off: every member works, nobody is paused, nothing is stopped', async () => {
    await switchTo(false);
    const list = await request(app).get(`/api/workspace-members?workspaceId=${ws}`).set(as(c));
    expect(list.status).toBe(200);
    expect((list.body.members as Row[]).every((m) => m.seat_locked === false)).toBe(true);

    const me = await request(app).get(`/api/workspace-members/me?workspaceId=${ws}`).set(as(c));
    expect(me.body).toMatchObject({ user_id: c, seat_locked: false });

    const { resolveRoutingCandidates } = await import('../../../server/services/calls/departments.js');
    const routed = await resolveRoutingCandidates(config as never, ws, 'chat');
    // The suspended member was never routable; the rest are.
    expect(new Set(routed.user_ids)).toEqual(new Set([owner, a, b, c]));

    expect(await stops.isProviderStopped(config as never, ws, 'telegram')).toBe(false);
    expect((await stops.checkStorageUpload(config as never, ws)).allowed).toBe(true);
  });

  it('switch on: the most recently joined past the seat limit are paused (owner and suspended never)', async () => {
    await switchTo(true);
    // max_agents 2 = the owner + 1: a keeps the seat, b and c are paused.
    const list = await request(app).get(`/api/workspace-members?workspaceId=${ws}`).set(as(owner));
    expect(list.status).toBe(200);
    const paused = Object.fromEntries((list.body.members as Row[]).map((m) => [m.user_id, m.seat_locked]));
    expect(paused).toEqual({ [owner]: false, [a]: false, [b]: true, [c]: true, [d]: false });

    // Every workspace route refuses a paused member…
    const denied = await request(app).get(`/api/workspace-members?workspaceId=${ws}`).set(as(c));
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({ error: 'seat_locked', upgrade_required: true });
    const plugins = await request(app).get(`/api/plugins/catalog?workspace_id=${ws}`).set(as(b));
    expect(plugins.status).toBe(403);
    // …except /me, which tells the app the seat is paused.
    const me = await request(app).get(`/api/workspace-members/me?workspaceId=${ws}`).set(as(c));
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ user_id: c, role: 'agent', seat_locked: true });
    const meA = await request(app).get(`/api/workspace-members/me?workspaceId=${ws}`).set(as(a));
    expect(meA.body.seat_locked).toBe(false);

    const { isSeatLocked } = await import('../../../server/lib/workspaceAuth.js');
    expect(await isSeatLocked(config as never, ws, owner)).toBe(false);
    expect(await isSeatLocked(config as never, ws, c)).toBe(true);
  });

  it('a paused member is never routed nor notified', async () => {
    const { resolveRoutingCandidates } = await import('../../../server/services/calls/departments.js');
    const routed = await resolveRoutingCandidates(config as never, ws, 'chat');
    expect(new Set(routed.user_ids)).toEqual(new Set([owner, a]));

    // A department of paused members only: routing falls through to the pool.
    const dept = String((await one(
      `INSERT INTO public.workspace_departments (workspace_id, name) VALUES ($1, 'Paused only') RETURNING id`, [ws])).id);
    await q(`INSERT INTO public.workspace_department_members (workspace_id, department_id, user_id) VALUES ($1, $2, $3), ($1, $2, $4)`, [ws, dept, b, c]);
    const viaDept = await resolveRoutingCandidates(config as never, ws, 'chat', dept);
    expect(viaDept.source).not.toBe('department');
    expect(viaDept.user_ids).not.toContain(b);
    expect(viaDept.user_ids).not.toContain(c);
    const { resolveWidgetVisibleDepartments } = await import('../../../server/services/calls/departments.js');
    expect((await resolveWidgetVisibleDepartments(config as never, ws, 'chat')).map((x) => x.id)).not.toContain(dept);

    const { resolveRecipients } = await import('../../../server/services/push/recipients.js');
    const pushed = await resolveRecipients(config as never, {
      workspaceId: ws, assignedTo: null, eventType: 'mention', mentionedUserIds: [a, b, c],
    });
    expect(pushed.map((r) => r.userId).sort()).toEqual([a]);

    const { audienceFor } = await import('../../../server/services/notificationEmail/producers.js');
    const mailed = await audienceFor(config as never, ws, 'weekly_summary');
    expect(new Set(mailed)).toEqual(new Set([owner, a]));

    await switchTo(false);
    const pushedOff = await resolveRecipients(config as never, {
      workspaceId: ws, assignedTo: null, eventType: 'mention', mentionedUserIds: [a, b, c],
    });
    expect(pushedOff.map((r) => r.userId).sort()).toEqual([a, b, c].sort());
    await switchTo(true);
  });

  it('routing hands back a chat a paused member still holds', async () => {
    const conv = String((await one(
      `INSERT INTO public.conversations (workspace_id, status, assigned_to, metadata) VALUES ($1, 'open', $2, '{}') RETURNING id`, [ws, c])).id);
    const { routeConversationToOperator } = await import('../../../server/services/chatRouting.js');
    const result = await routeConversationToOperator(config as never, { workspaceId: ws, conversationId: conv });
    expect(result.outcome).not.toBe('already_assigned');
    const after = await one(`SELECT assigned_to FROM public.conversations WHERE id = $1`, [conv]);
    expect(after.assigned_to).not.toBe(c);
    expect([null, owner, a]).toContain(after.assigned_to);
  });

  it('a suspension frees a seat: the cache drops, and whoever is still paused loses their open chats', async () => {
    const convB = String((await one(
      `INSERT INTO public.conversations (workspace_id, status, assigned_to, metadata) VALUES ($1, 'open', $2, '{}') RETURNING id`, [ws, b])).id);
    const convC = String((await one(
      `INSERT INTO public.conversations (workspace_id, status, assigned_to, metadata) VALUES ($1, 'pending', $2, '{}') RETURNING id`, [ws, c])).id);
    const closedC = String((await one(
      `INSERT INTO public.conversations (workspace_id, status, assigned_to, metadata) VALUES ($1, 'closed', $2, '{}') RETURNING id`, [ws, c])).id);

    const res = await request(app)
      .patch(`/api/workspace-members/${memberRowA}/suspension?workspaceId=${ws}`)
      .set(as(owner))
      .send({ suspended: true });
    expect(res.status).toBe(200);

    // a no longer holds the seat: b (next oldest) gets it at once, c stays paused.
    const meB = await request(app).get(`/api/workspace-members/me?workspaceId=${ws}`).set(as(b));
    expect(meB.body.seat_locked).toBe(false);
    expect((await request(app).get(`/api/workspace-members?workspaceId=${ws}`).set(as(b))).status).toBe(200);
    expect((await request(app).get(`/api/workspace-members?workspaceId=${ws}`).set(as(c))).status).toBe(403);

    const released = await eventually(
      () => one(`SELECT assigned_to FROM public.conversations WHERE id = $1`, [convC]),
      (row) => row.assigned_to !== c,
    );
    expect(released.assigned_to).not.toBe(c);
    expect((await one(`SELECT assigned_to FROM public.conversations WHERE id = $1`, [convB])).assigned_to).toBe(b);
    // A closed chat is not the queue's business.
    expect((await one(`SELECT assigned_to FROM public.conversations WHERE id = $1`, [closedC])).assigned_to).toBe(c);
  });

  it('a stopped channel: ingest is acknowledged and nothing is queued; queued updates are dropped', async () => {
    const jobs = async () => Number((await one(
      `SELECT count(*)::int AS n FROM public.channel_jobs WHERE integration_id = $1 AND job_type = 'telegram_inbound_event'`, [integration])).n);
    const before = await jobs();
    const ingest = await request(app)
      .post('/internal/channels/ingest')
      .set('x-core-internal-secret', SECRET)
      .send({ provider: 'telegram', public_integration_id: PUBLIC_ID, update: { update_id: 1 } });
    expect(ingest.status).toBe(200);
    expect(ingest.body).toEqual({ accepted: false, reason: 'plan_locked' });
    expect(await jobs()).toBe(before);

    const processed = await request(app)
      .post('/internal/channels/process-inbound')
      .set('x-core-internal-secret', SECRET)
      .send({ provider: 'telegram', integration_id: integration, workspace_id: ws, update: { update_id: 2, message: { text: 'hi' } } });
    expect(processed.status).toBe(200);
    expect(processed.body).toMatchObject({ status: 'plan_locked', accepted: false });

    // Yahoo Mail is a plan channel too: nothing is stored, the poller moves on.
    const yahoo = await request(app)
      .post('/internal/channels/yahoo/upsert-thread-message')
      .set('x-core-internal-secret', SECRET)
      .send({
        integration_id: integration, workspace_id: ws, subject: 'Hello',
        message: { external_message_id: '<m1@yahoo>', from_address: 'x@y.test', text_body: 'hi' },
      });
    expect(yahoo.status).toBe(200);
    expect(yahoo.body).toMatchObject({ is_new_message: false, accepted: false, reason: 'plan_locked' });
    expect(Number((await one(`SELECT count(*)::int AS n FROM public.email_threads WHERE workspace_id = $1`, [ws])).n)).toBe(0);

    // The switch off: received as before.
    await switchTo(false);
    const open = await request(app)
      .post('/internal/channels/ingest')
      .set('x-core-internal-secret', SECRET)
      .send({ provider: 'telegram', public_integration_id: PUBLIC_ID, update: { update_id: 3 } });
    expect(open.status).toBe(202);
    expect(await jobs()).toBe(before + 1);
    await switchTo(true);
  });

  it('a stopped channel sends nothing and its settings cannot change; an override brings it back', async () => {
    const conv = String((await one(
      `INSERT INTO public.conversations (workspace_id, status, metadata) VALUES ($1, 'open', $2) RETURNING id`,
      [ws, JSON.stringify({ channel: 'telegram', channel_integration_id: integration, channel_chat_id: '42' })])).id);
    const messageId = randomUUID();
    const job = String((await one(
      `INSERT INTO public.channel_jobs (provider, job_type, workspace_id, integration_id, payload)
       VALUES ('telegram', 'telegram_outbound_message', $1, $2, $3) RETURNING id`,
      [ws, integration, JSON.stringify({ message_id: messageId, chat_id: '42', text: 'hi', conversation_id: conv })])).id);

    const outbound = await import('../../../server/services/channels/outbound.js');
    expect(await outbound.channelOutboundStopped(config as never, { workspaceId: ws, conversationId: conv })).toBe(true);
    const dispatched = await outbound.dispatchOutboundIfChannelConversation(config as never, {
      workspaceId: ws, conversationId: conv, messageId, body: 'hi',
    });
    expect(dispatched).toEqual({ accepted: false, result: 'plan_locked' });
    expect((await one(`SELECT status, last_error FROM public.channel_jobs WHERE id = $1`, [job]))).toMatchObject({
      status: 'cancelled', last_error: 'plan_locked',
    });

    const settings = await request(app)
      .put('/api/plugins/settings')
      .set(as(owner))
      .send({ workspace_id: ws, plugin_id: 'telegram', settings: { greeting: 'hi' } });
    expect(settings.status).toBe(403);
    expect(settings.body).toEqual({ error: 'plan_locked', upgrade_required: true });

    const catalog = await request(app).get(`/api/plugins/catalog?workspace_id=${ws}`).set(as(owner));
    expect(catalog.status).toBe(200);
    const telegram = (catalog.body.items as Row[]).find((i) => i.id === 'telegram');
    expect(telegram).toMatchObject({ installed: true, planAllowed: false, stopped: true });

    // The Super Admin's channel override wins over the plan: running again.
    await q(`INSERT INTO public.workspace_channel_overrides (workspace_id, channel_key, enabled) VALUES ($1, 'telegram', true)`, [ws]);
    stops.clearPlanStopCache(ws);
    expect(await outbound.channelOutboundStopped(config as never, { workspaceId: ws, conversationId: conv })).toBe(false);
    const ingest = await request(app)
      .post('/internal/channels/ingest')
      .set('x-core-internal-secret', SECRET)
      .send({ provider: 'telegram', public_integration_id: PUBLIC_ID, update: { update_id: 4 } });
    expect(ingest.status).toBe(202);
    await q(`DELETE FROM public.workspace_channel_overrides WHERE workspace_id = $1`, [ws]);
    stops.clearPlanStopCache(ws);
  });

  it('storage over the limit blocks new uploads only while the switch is on', async () => {
    await q(`INSERT INTO public.workspace_usage_counters (workspace_id, period, storage_bytes)
             VALUES ($1, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM'), $2)
             ON CONFLICT (workspace_id, period) DO UPDATE SET storage_bytes = EXCLUDED.storage_bytes`, [ws, 2 * 1024 ** 3]);
    const blocked = await stops.checkStorageUpload(config as never, ws);
    expect(blocked.allowed).toBe(false);
    expect(blocked.status).toBe(403);
    expect(blocked.body).toMatchObject({ error: 'Limit reached: storage_gb', upgrade_required: true });

    // An AI knowledge file is refused before anything is written.
    const { queueAiFileIngest, IngestError } = await import('../../../server/services/ai-agent/files/fileIngestion.js');
    const sources = async () => Number((await one(`SELECT count(*)::int AS n FROM public.ai_data_sources WHERE workspace_id = $1`, [ws])).n);
    const before = await sources();
    const attempt = await queueAiFileIngest(config as never, {
      workspaceId: ws, userId: owner, fileName: 'faq.txt', mimeType: 'text/plain', buffer: Buffer.from('hello'),
    } as never).then(() => null, (e: unknown) => e);
    expect(attempt).toBeInstanceOf(IngestError);
    expect(attempt).toMatchObject({ code: 'storage_limit_reached', status: 403 });
    expect(await sources()).toBe(before);

    await switchTo(false);
    expect((await stops.checkStorageUpload(config as never, ws)).allowed).toBe(true);
    // Off, the file goes the way it went before (here: no storage provider).
    const offAttempt = await queueAiFileIngest(config as never, {
      workspaceId: ws, userId: owner, fileName: 'faq.txt', mimeType: 'text/plain', buffer: Buffer.from('hello'),
    } as never).then(() => null, (e: unknown) => e);
    expect((offAttempt as { code?: string } | null)?.code).not.toBe('storage_limit_reached');
    await switchTo(true);
  });

  it('self-host unlimited billing never pauses or stops anything', async () => {
    const unlimited = { ...config, selfHostBillingUnlimited: true } as never;
    const { isSeatLocked } = await import('../../../server/lib/workspaceAuth.js');
    expect(await isSeatLocked(unlimited, ws, c)).toBe(false);
    expect(await stops.isProviderStopped(unlimited, ws, 'telegram')).toBe(false);
    expect((await stops.checkStorageUpload(unlimited, ws)).allowed).toBe(true);
  });
});
