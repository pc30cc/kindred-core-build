// @vitest-environment node
/**
 * 284 — a widget conversation nobody has written in for its workspace's
 * window closes by itself, on a real database: one database built by the
 * chain up to 283, the new server run against it (M7), then 284 applied to it
 * as WebYar's is by hand (M1), and the rest on top:
 *
 *   M7 the new server before 284: a ticker pass is a no-op and takes no
 *      lease; a message racing a close goes live-or-new; both settings
 *      PATCHes with the new keys answer 409; a PATCH close still works (its
 *      markers are metadata); rating an AI-only conversation answers 503;
 *      routing-policy reads off.
 *   M1 the migration: a dry run in BEGIN … ROLLBACK leaves no trace; with
 *      live conversations the switch reads off, with none on; a second run
 *      keeps the Super Admin's value; the checks refuse 0 and 49 (and a
 *      subject that is not operator/ai); only service_role may execute the
 *      functions; an invalid index of that name stops the file.
 *   M2 needsReply.ts and conversation_message_turn() agree on the 780
 *      generated fixtures.
 *   M3 conversation_idle_check(): every guard, a tie, calls (one live, one
 *      stuck, one connected after the question, one 2 h ago), other channels,
 *      spam, closed; the workspace's window against the platform's; a
 *      greeting; idle_due: the 30-day bound, the switch, and rows the team
 *      owes never using up the batch.
 *   M4 conversation_close_if_idle(): updated_at unchanged, the AI's hold
 *      unchanged, exactly the markers and the two stamps, one event as the
 *      PATCH files a close, the line forced to the system's, the backlog's
 *      refusal of a line, 'changed', 'not_live', closed_line_id only for a
 *      line this close wrote, the retention lock the same; the ticker's
 *      envelopes are the PATCH's.
 *   M5 the race: a visitor message being inserted holds the close back and
 *      keeps it open (two connections); a reopen within the grace restores
 *      closed_from and the stamps, retracts the line, once; not past the
 *      grace, not after an operator's close.
 *   M6 the backlog script (psql), on fixtures: the dry run closes every due
 *      row and rolls back; the commit closes the reviewed ids only, skips one
 *      that became owed and turns the switch on; with enable=0 it stays off.
 *   T  the ticker for real; the Inbox's queues after an AI-only close; an
 *      operator's reply into an auto-closed conversation clears the markers;
 *      the AI's rating.
 *
 * Publishing, push, the transcript mail and the AI engine are stand-ins.
 * Driven by TEST_DATABASE_URL; skipped without it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import pg from 'pg';
import { applyMigrationSql } from './pgMigrationChain';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;
const PSQL = spawnSync('psql', ['--version']).status === 0;

type Row = Record<string, unknown>;
type Next = () => void;

const state = vi.hoisted(() => ({
  visitor: 'visitor-284',
  operatorEvents: [] as Array<Record<string, unknown>>,
  conversationEvents: [] as Array<{ cid: string; envelope: Record<string, unknown> }>,
  pushes: 0,
  transcripts: 0,
}));

vi.mock('../../../server/services/widget/security.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/security.js')>()),
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
  publishOperatorEvent: async (_c: unknown, p: Record<string, unknown>) => { state.operatorEvents.push(p); },
  publishConversationEvent: async (_c: unknown, _ws: string, cid: string, envelope: Record<string, unknown>) => {
    state.conversationEvents.push({ cid, envelope });
    return { ok: true };
  },
}));
vi.mock('../../../server/services/push/index.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/push/index.js')>()),
  notifyInboundMessage: async () => { state.pushes++; },
  notifyHandoff: async () => { state.pushes++; },
  notifyAssignment: async () => { state.pushes++; },
}));
vi.mock('../../../server/services/notificationEmail/producers.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/notificationEmail/producers.js')>()),
  queueTranscript: async () => { state.transcripts++; },
}));
vi.mock('../../../server/services/ai-agent/engine.js', () => ({
  maybeRunAiAssistantAfterVisitorMessage: async () => ({ ran: false, action: 'skipped', reason: 'test', runId: 'stand-in' }),
}));

const MIGRATION = resolve(process.cwd(), 'database/migrations/284_conversation_inactivity_close.sql');
const BACKLOG = resolve(process.cwd(), 'database/backfill/284_inactivity_backlog_close.sql');
const CLOSED_KEYS = ['closed_reason', 'closed_by', 'closed_at', 'closed_from', 'closed_source', 'closed_idle_hours',
  'closed_last_exchange_at', 'closed_outcome', 'closed_line_id', 'closed_prev_stamps'];

/** Polls `read` until `ok` holds (fire-and-forget work), up to ~4 s; returns the last value. */
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  let v = await read();
  for (let i = 0; i < 80 && !ok(v); i++) {
    await new Promise((r) => setTimeout(r, 50));
    v = await read();
  }
  return v;
}

suite('284 — the inactivity close (real PostgreSQL: the chain to 283, the server, then 284)', () => {
  let admin: pg.Client;
  let db: pg.Client;
  let url = '';
  const name = `idle_close_284_${Date.now()}`;
  const q = async (sql: string, p: unknown[] = []): Promise<Row[]> => (await db.query(sql, p)).rows as Row[];
  const one = async (sql: string, p: unknown[] = []): Promise<Row> => (await q(sql, p))[0];

  const owner = randomUUID();
  const sara = randomUUID();
  const reza = randomUUID();
  const superAdmin = randomUUID();
  const ws = randomUUID();
  const VISITOR = 'visitor-284';

  let config: ReturnType<typeof import('../../../server/config.js')['loadConfig']>;
  let app: express.Express;
  let resetRateLimits: () => void;
  let resetSettings: () => void;
  const tokens: Record<string, string> = {};
  const as = (user: string) => ({ Authorization: `Bearer ${tokens[user]}` });

  /** A widget conversation of the visitor's, last touched `quiet` ago (created an hour before that). */
  const conversation = async (o: { status?: string; meta?: Row; quiet?: string; spam?: boolean; assigned?: string | null } = {}) => {
    const id = randomUUID();
    await q(`INSERT INTO public.conversations (id, workspace_id, status, assigned_to, metadata, created_at, updated_at, is_spam)
             VALUES ($1, $2, $3::conversation_status, $4, $5::jsonb, now() - $6::interval - interval '1 hour', now() - $6::interval, $7)`,
    [id, ws, o.status ?? 'open', o.assigned ?? null, JSON.stringify({ visitor_id: VISITOR, ...(o.meta ?? {}) }), o.quiet ?? '30 hours', o.spam ?? false]);
    return id;
  };
  const message = async (cid: string, sender: string, ago: string, meta: Row = {}, body = 'سلام', senderId: string | null = sender === 'agent' ? sara : null) => {
    const id = randomUUID();
    await q(`INSERT INTO public.conversation_messages (id, conversation_id, sender_type, sender_id, body, metadata, created_at)
             VALUES ($1, $2, $3::sender_type, $4, $5, $6::jsonb, now() - $7::interval)`,
    [id, cid, sender, senderId, body, JSON.stringify(meta), ago]);
    return id;
  };
  const conv = async (cid: string) => one(`SELECT status, updated_at, metadata FROM public.conversations WHERE id = $1`, [cid]);
  const verdict = async (cid: string) => one(`SELECT * FROM public.conversation_idle_check($1)`, [cid]);
  const close = async (cid: string, source = 'timer', line: [string, Row] | null = null) => one(
    `SELECT * FROM public.conversation_close_if_idle($1, (SELECT updated_at FROM public.conversations WHERE id = $1), $2, $3, $4::jsonb)`,
    [cid, source, line?.[0] ?? null, line ? JSON.stringify(line[1]) : null],
  );
  const reopen = async (cid: string, grace = 60) => one(`SELECT * FROM public.conversation_reopen_after_idle_close($1, $2, NULL, $3)`, [ws, cid, grace]);
  const events = async (cid: string) => q(
    `SELECT event_type, actor_type, actor_id, payload FROM public.conversation_events WHERE conversation_id = $1 ORDER BY created_at, id`, [cid],
  );
  const setPlatform = (enabled: boolean, hours = 24) => q(
    `UPDATE public.widget_platform_settings SET inactivity_close_enabled = $1, inactivity_close_default_hours = $2`, [enabled, hours],
  );
  const applyMigration = (client: pg.Client = db) => applyMigrationSql(client as never, readFileSync(MIGRATION, 'utf8'));
  const send = (body: Row) => {
    resetRateLimits();
    return request(app).post('/api/widget/message').send({ workspace_id: ws, message: 'هنوز هستید؟', client_message_id: `cmid-${randomUUID()}`, ...body });
  };

  beforeAll(async () => {
    const adminUrl = new URL(DSN!);
    adminUrl.pathname = '/postgres';
    admin = new pg.Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.query(`CREATE DATABASE ${name}`);
    const u = new URL(DSN!);
    u.pathname = `/${name}`;
    url = u.toString();
    db = new pg.Client({ connectionString: url });
    await db.connect();
    await db.query('SET client_min_messages = warning');
    const dir = resolve(process.cwd(), 'database/migrations');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql') && f < '284').sort()) {
      await applyMigrationSql(db, readFileSync(resolve(dir, file), 'utf8'));
    }

    for (const [id, full] of [[owner, 'Owner'], [sara, 'Sara'], [reza, 'Reza'], [superAdmin, 'Admin']]) {
      await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, $3)`, [id, `p-${id.slice(0, 8)}@test.local`, full]);
    }
    await q(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')`, [superAdmin]);
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [ws, `ws-${ws.slice(0, 8)}`, owner]);
    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'agent'), ($1, $4, 'agent')
             ON CONFLICT DO NOTHING`, [ws, owner, sara, reza]);
    await q(`INSERT INTO public.widget_settings (workspace_id, enabled, assignment_mode, first_response_timeout_minutes) VALUES ($1, true, 'manual', 0)`, [ws]);
    await q(`INSERT INTO public.widget_prechat_settings (workspace_id, ask_name, ask_email, ask_phone, require_name, require_email, prechat_timing)
             VALUES ($1, false, false, false, false, false, 'never')`, [ws]);

    Object.assign(process.env, {
      DATABASE_URL: url,
      PLATFORM_SIGNING_SECRET: 'signing-secret-for-this-test-only-0123456789',
      SUPABASE_URL: 'https://legacy-project.supabase.co',
      SUPABASE_ANON_KEY: 'legacy-anon-key-value',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-key-value-at-least-32',
      CORS_ORIGINS: 'http://127.0.0.1',
    });
    delete process.env.DATABASE_MODE;
    config = { ...(await import('../../../server/config.js')).loadConfig(), selfHostBillingUnlimited: true };
    const security = await import('../../../server/services/widget/security.js');
    const snapshot = await import('../../../server/services/widget/configSnapshot.js');
    const platform = await import('../../../server/services/widget/platformSettings.js');
    resetRateLimits = () => security.__resetWidgetRateLimitsForTests();
    resetSettings = () => { platform.__resetInactivityCloseSettingsCache(); snapshot.__resetWidgetConfigCachesForTests(); };
    const { widgetRouter } = await import('../../../server/routes/widget.js');
    const { conversationsRouter } = await import('../../../server/routes/conversations.js');
    const { widgetSettingsRouter } = await import('../../../server/routes/widgetSettings.js');
    const { workspaceDepartmentsRouter } = await import('../../../server/routes/workspaceDepartments.js');
    const { createSession } = await import('../../../server/services/auth/sessions.js');
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { Object.assign(req, { serverConfig: config }); next(); });
    app.use('/api/widget', widgetRouter);
    app.use('/api/conversations', conversationsRouter);
    app.use('/api/widget-settings', widgetSettingsRouter);
    app.use('/api/workspace-departments', workspaceDepartmentsRouter);
    for (const id of [owner, sara, superAdmin]) {
      tokens[id] = (await createSession(config as never, { userId: id, email: `p-${id.slice(0, 8)}@test.local` })).token;
    }
  }, 600_000);

  afterAll(async () => {
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer().catch(() => undefined);
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  });

  beforeEach(() => {
    state.operatorEvents.length = 0;
    state.conversationEvents.length = 0;
    state.pushes = 0;
    state.transcripts = 0;
    state.visitor = VISITOR;
    resetSettings?.();
  });

  // ─── M7: the new server before 284 ──────────────────────────────────────
  it('M7 the new server before 284: the ticker idles, a racing message goes live-or-new, the settings answer 409, a PATCH close works, an AI rating 503', async () => {
    expect((await one(`SELECT to_regproc('public.conversation_idle_due') AS f`)).f).toBeNull();
    const { runConversationIdleCloseOnce } = await import('../../../server/services/conversationIdleCloseTicker.js');
    expect(await runConversationIdleCloseOnce(config as never)).toEqual({ due: 0, closed: 0, skipped: {} });
    expect(await q(`SELECT name FROM public.observability_ticker_lease WHERE name = 'conversation_idle_close'`)).toEqual([]);

    // A message naming a conversation "closed by the timer" a moment ago:
    // nothing can reopen it here, so it goes live-or-new, as before.
    const closed = await conversation({ status: 'closed', meta: { closed_reason: 'inactivity', closed_at: new Date().toISOString(), closed_from: 'open' } });
    const raced = await send({ conversation_id: closed });
    expect(raced.status, JSON.stringify(raced.body)).toBe(200);
    expect(raced.body.conversation_id).not.toBe(closed);
    expect((await conv(closed)).status).toBe('closed');

    const ownSetting = await request(app).patch(`/api/widget-settings/${ws}`).set(as(owner)).send({ inactivity_close_hours: 12 });
    expect(ownSetting.status, JSON.stringify(ownSetting.body)).toBe(409);
    expect(ownSetting.body).toEqual({ error: 'inactivity_close_migration_required' });
    expect((await request(app).patch(`/api/widget-settings/${ws}`).set(as(owner)).send({ assignment_mode: 'manual' })).status).toBe(200);
    const platformId = (await one(`SELECT id FROM public.widget_platform_settings LIMIT 1`)).id;
    const platform = await request(app).patch('/api/widget-settings/platform/config').set(as(superAdmin))
      .send({ id: platformId, inactivity_close_enabled: true, inactivity_close_default_hours: 12 });
    expect(platform.status, JSON.stringify(platform.body)).toBe(409);
    expect(platform.body).toEqual({ error: 'inactivity_close_migration_required' });
    expect((await request(app).get(`/api/workspace-departments/${ws}/routing-policy`).set(as(owner))).body.policy)
      .toMatchObject({ inactivity_close_enabled: false, inactivity_close_default_hours: 24 });

    // An operator's close: its markers are metadata only.
    const open = await conversation({ assigned: sara });
    await message(open, 'contact', '2 hours');
    await message(open, 'agent', '1 hour');
    const closing = await request(app).patch(`/api/conversations/${open}`).set(as(sara)).send({ workspace_id: ws, status: 'closed' });
    expect(closing.status, JSON.stringify(closing.body)).toBe(200);
    expect((await conv(open)).metadata).toMatchObject({ closed_reason: 'operator', closed_by: 'agent', closed_from: 'open', closed_source: null });

    // The AI's rating needs conversation_ratings.subject: 503, nothing stored.
    const ai = await conversation({ status: 'closed' });
    await message(ai, 'contact', '2 hours');
    await message(ai, 'ai', '1 hour', {}, 'از ۹ تا ۱۸.');
    const line = await message(ai, 'system', '30 minutes', { kind: 'conversation_closed', by: 'system', closed_reason: 'inactivity', status: 'closed', agent_name: null });
    const ratings = await import('../../../server/services/conversationRatings.js');
    expect(await ratings.csatState(config as never, { workspaceId: ws, conversationId: ai, csatEnabled: true })).toMatchObject({ rateable: true, subject: 'ai' });
    await expect(ratings.rateClosedConversation(config as never, { workspaceId: ws, conversationId: ai, closedId: line, score: 5, comment: null }))
      .rejects.toMatchObject({ status: 503, code: 'csat_unavailable' });
    expect(await q(`SELECT id FROM public.conversation_ratings WHERE conversation_id = $1`, [ai])).toEqual([]);
  });

  // ─── M1: the migration ─────────────────────────────────────────────────
  it('M1 a dry run leaves no trace; applied with live conversations the switch reads off; a second run keeps the Super Admin\'s value', async () => {
    // Live conversations exist (M7's). A dry run first.
    await db.query('BEGIN');
    await applyMigration();
    expect((await one(`SELECT inactivity_close_enabled FROM public.widget_platform_settings LIMIT 1`)).inactivity_close_enabled).toBe(false);
    await db.query('ROLLBACK');
    expect(await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public'
                    AND column_name IN ('inactivity_close_hours', 'inactivity_close_enabled', 'inactivity_close_default_hours', 'subject')
                    AND table_name IN ('widget_settings', 'widget_platform_settings', 'conversation_ratings')`)).toEqual([]);
    expect((await one(`SELECT to_regproc('public.conversation_close_if_idle') AS f`)).f).toBeNull();
    expect((await one(`SELECT to_regclass('public.conversations_live_updated_idx') AS i`)).i).toBeNull();

    await applyMigration();
    expect(await one(`SELECT inactivity_close_enabled, inactivity_close_default_hours FROM public.widget_platform_settings LIMIT 1`))
      .toEqual({ inactivity_close_enabled: false, inactivity_close_default_hours: 24 });
    // The Super Admin switches it on; a second run leaves it so.
    await setPlatform(true, 12);
    await applyMigration();
    expect(await one(`SELECT inactivity_close_enabled, inactivity_close_default_hours FROM public.widget_platform_settings LIMIT 1`))
      .toEqual({ inactivity_close_enabled: true, inactivity_close_default_hours: 12 });
    expect((await one(`SELECT indisvalid FROM pg_index WHERE indexrelid = 'public.conversations_live_updated_idx'::regclass`)).indisvalid).toBe(true);
    // The new columns of a running installation's rows: their defaults.
    expect(await one(`SELECT inactivity_close_hours FROM public.widget_settings WHERE workspace_id = $1`, [ws])).toEqual({ inactivity_close_hours: null });
  });

  it('M1 an installation with no live conversation starts on', async () => {
    await db.query('BEGIN');
    try {
      await q(`UPDATE public.conversations SET status = 'closed' WHERE status IN ('open', 'pending', 'resolved')`);
      await q(`ALTER TABLE public.widget_platform_settings DROP COLUMN inactivity_close_enabled`);
      await applyMigration();
      expect((await one(`SELECT inactivity_close_enabled FROM public.widget_platform_settings LIMIT 1`)).inactivity_close_enabled).toBe(true);
    } finally {
      await db.query('ROLLBACK');
    }
    expect((await one(`SELECT inactivity_close_enabled FROM public.widget_platform_settings LIMIT 1`)).inactivity_close_enabled).toBe(true);
  });

  it('M1 the checks refuse 0 and 49 and an unknown subject; only service_role may execute the functions', async () => {
    for (const bad of [0, 49]) {
      await expect(q(`UPDATE public.widget_settings SET inactivity_close_hours = $1 WHERE workspace_id = $2`, [bad, ws])).rejects.toThrow(/inactivity_close_hours_check/);
      await expect(q(`UPDATE public.widget_platform_settings SET inactivity_close_default_hours = $1`, [bad])).rejects.toThrow(/inactivity_close_default_hours_check/);
    }
    await q(`UPDATE public.widget_settings SET inactivity_close_hours = 1 WHERE workspace_id = $1`, [ws]);
    await q(`UPDATE public.widget_settings SET inactivity_close_hours = 48 WHERE workspace_id = $1`, [ws]);
    await q(`UPDATE public.widget_settings SET inactivity_close_hours = NULL WHERE workspace_id = $1`, [ws]);
    const cid = await conversation({ status: 'closed' });
    await expect(q(`INSERT INTO public.conversation_ratings (workspace_id, conversation_id, closed_message_id, score, subject)
                    VALUES ($1, $2, $3, 5, 'bot')`, [ws, cid, randomUUID()])).rejects.toThrow(/conversation_ratings_subject_check/);
    expect((await one(`INSERT INTO public.conversation_ratings (workspace_id, conversation_id, closed_message_id, score)
                       VALUES ($1, $2, $3, 5) RETURNING subject`, [ws, cid, randomUUID()])).subject).toBe('operator');

    for (const fn of ['conversation_message_turn(text, text, jsonb)', 'conversation_idle_check(uuid)', 'conversation_idle_due(integer)',
      'conversation_close_if_idle(uuid, timestamptz, text, text, jsonb)', 'conversation_reopen_after_idle_close(uuid, uuid, uuid, integer)']) {
      const p = await one(`SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS service,
                                  has_function_privilege('anon', $1, 'EXECUTE') AS anon,
                                  has_function_privilege('authenticated', $1, 'EXECUTE') AS authenticated,
                                  (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = $1::regprocedure) AS definer,
                                  (SELECT coalesce(array_to_string(p.proacl, ','), '') FROM pg_proc p WHERE p.oid = $1::regprocedure) AS acl`, [`public.${fn}`]);
      expect(p, fn).toMatchObject({ service: true, anon: false, authenticated: false, definer: false });
      expect(String(p.acl), fn).not.toMatch(/(^|,)=X/);
    }
  });

  it('M1 an invalid index of that name stops the file, which then changes nothing', async () => {
    await q(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'public.conversations_live_updated_idx'::regclass`);
    try {
      await expect(applyMigration()).rejects.toThrow(/conversations_live_updated_idx is invalid/);
    } finally {
      await q(`UPDATE pg_index SET indisvalid = true WHERE indexrelid = 'public.conversations_live_updated_idx'::regclass`);
      await db.query(`RESET lock_timeout`).catch(() => undefined);
    }
    // The data layer's schema cache (read during M7, before 284) reloads on
    // the first miss once it is a second old, as a running backend's does
    // after the migration is applied by hand.
    await new Promise((r) => setTimeout(r, 1100));
  });

  // ─── M2: needsReply.ts and the SQL agree ─────────────────────────────────
  it('M2 needsReply.ts and conversation_message_turn() agree on the 780 generated fixtures', async () => {
    const { isActionableCustomerTurn, isQualifiedCustomerFacingAnswer } = await import('../../../server/services/needsReply.js');
    const senders = ['contact', 'agent', 'ai', 'system', 'bot'];
    const bodies = ['hi', '', '   ', ' 　\t', '​', ' x '];
    const metas: Row[] = [
      {}, { attachment_id: 'a1' }, { attachment_id: '' }, { attachment_id: 0 }, { attachment_id: false },
      { provider_echo: true }, { provider_echo: 'true' }, { channel_menu_event: 'true' }, { channel_menu_event: true },
      { channel_menu_event: 'false' }, { channel_menu_command: 'start' }, { channel_menu_command: '' }, { channel_menu_command: 0 },
      { channel_menu_command: {} }, { channel_menu_command: [] }, { routing_notice: 'queued' }, { routing_notice: true },
      { channel_delivery_skip: 'true' }, { channel_delivery_skip: true }, { channel_delivery: 'failed' }, { channel_delivery: 'sent' },
      { handoff: true }, { handoff: 'true' }, { handoff: false }, { kind: 'conversation_closed' }, { internal: true },
    ];
    const fixtures: Array<{ i: number; s: string; b: string; m: Row; ts: string }> = [];
    for (const s of senders) for (const b of bodies) for (const m of metas) {
      const msg = { sender_type: s, body: b, metadata: m };
      fixtures.push({ i: fixtures.length, s, b, m, ts: isActionableCustomerTurn(msg) ? 'visitor' : isQualifiedCustomerFacingAnswer(msg) ? 'team' : '' });
    }
    expect(fixtures).toHaveLength(780);
    const rows = await q(`SELECT x.i, coalesce(public.conversation_message_turn(x.s, x.b, x.m), '') AS turn
                            FROM jsonb_to_recordset($1::jsonb) AS x(i integer, s text, b text, m jsonb) ORDER BY x.i`, [JSON.stringify(fixtures)]);
    const disagree = rows.filter((r) => r.turn !== fixtures[Number(r.i)].ts).map((r) => ({ ...fixtures[Number(r.i)], sql: r.turn }));
    expect(disagree).toEqual([]);
    expect(new Set(fixtures.map((f) => f.ts))).toEqual(new Set(['visitor', 'team', '']));
  });

  // ─── M3: the verdicts ──────────────────────────────────────────────────
  describe('M3 conversation_idle_check() and conversation_idle_due()', () => {
    beforeEach(async () => {
      await q(`DELETE FROM public.conversations WHERE workspace_id = $1`, [ws]);
      await setPlatform(true, 24);
      await q(`UPDATE public.widget_settings SET inactivity_close_hours = NULL WHERE workspace_id = $1`, [ws]);
    });

    it('due, with its outcome; recent within the window; the workspace window against the platform default', async () => {
      const human = await conversation();
      await message(human, 'contact', '31 hours');
      await message(human, 'agent', '30 hours');
      expect(await verdict(human)).toMatchObject({ verdict: 'due', idle_hours: 24, closed_outcome: 'human' });
      const ai = await conversation({ meta: { ai_state: 'ai_managed' } });
      await message(ai, 'contact', '31 hours');
      await message(ai, 'ai', '30 hours');
      expect(await verdict(ai)).toMatchObject({ verdict: 'due', closed_outcome: 'ai_unresolved' });
      const aiDone = await conversation({ meta: { ai_state: 'ai_managed', ai_memory: { issueStatus: 'resolved' } } });
      await message(aiDone, 'contact', '31 hours');
      await message(aiDone, 'ai', '30 hours');
      expect(await verdict(aiDone)).toMatchObject({ verdict: 'due', closed_outcome: 'ai_resolved' });
      const greeting = await conversation({ meta: { source: 'ai_agent_intro', ai_state: 'ai_managed' } });
      await message(greeting, 'ai', '30 hours', { source: 'ai_agent_intro' }, 'سلام! چطور کمک کنم؟');
      expect(await verdict(greeting)).toMatchObject({ verdict: 'due', closed_outcome: 'no_visitor_message', last_visitor_at: null });
      const unanswered = await conversation({ status: 'pending' });
      await message(unanswered, 'contact', '30 hours');
      expect(await verdict(unanswered)).toMatchObject({ verdict: 'due', closed_outcome: 'unanswered' });

      const fresh = await conversation({ quiet: '10 hours' });
      await message(fresh, 'agent', '10 hours');
      expect(await verdict(fresh)).toMatchObject({ verdict: 'recent', idle_hours: 24 });
      await setPlatform(true, 8);
      expect(await verdict(fresh)).toMatchObject({ verdict: 'due', idle_hours: 8 });
      await q(`UPDATE public.widget_settings SET inactivity_close_hours = 12 WHERE workspace_id = $1`, [ws]);
      expect(await verdict(fresh)).toMatchObject({ verdict: 'recent', idle_hours: 12 });
      // Nothing exchanged at all: created_at counts.
      const empty = await conversation({ quiet: '1 hour' });
      expect((await verdict(empty)).verdict).toBe('recent');
    });

    it('never while the team owes: needs_reply (a tie too), a handoff, routing, a call, a callback, a guidance request', async () => {
      const owed = await conversation();
      await message(owed, 'agent', '31 hours');
      await message(owed, 'contact', '30 hours', {}, 'مرسی'); // a bare "thanks" stays owed
      expect((await verdict(owed)).verdict).toBe('needs_reply');
      const tie = await conversation();
      await q(`INSERT INTO public.conversation_messages (conversation_id, sender_type, sender_id, body, created_at)
               VALUES ($1, 'contact', NULL, 'q', now() - interval '30 hours'), ($1, 'agent', $2, 'a', now() - interval '30 hours')`, [tie, sara]);
      await q(`UPDATE public.conversation_messages SET created_at = (SELECT min(created_at) FROM public.conversation_messages WHERE conversation_id = $1) WHERE conversation_id = $1`, [tie]);
      expect((await verdict(tie)).verdict).toBe('needs_reply');
      // Pending: the team waits for the visitor, nothing owed.
      const waiting = await conversation({ status: 'pending' });
      await message(waiting, 'contact', '30 hours');
      expect((await verdict(waiting)).verdict).toBe('due');

      const answered = async (meta: Row = {}, status = 'open') => {
        const cid = await conversation({ meta, status });
        await message(cid, 'contact', '31 hours');
        await message(cid, 'agent', '30 hours');
        return cid;
      };
      expect((await verdict(await answered({ ai_handoff_requested: true }))).verdict).toBe('ai_handoff');
      expect((await verdict(await answered({ ai_state: 'human_assigned' }))).verdict).toBe('ai_handoff');
      expect((await verdict(await answered({ ai_state: 'needs_human' }))).verdict).toBe('ai_handoff');
      expect((await verdict(await answered({ ai_handoff_sent: true }))).verdict).toBe('due');
      expect((await verdict(await answered({ routing_pending: true }))).verdict).toBe('routing');
      expect((await verdict(await answered({ routing_outcome: 'manual_queue', queued_at: new Date().toISOString() }))).verdict).toBe('routing');
      expect((await verdict(await answered({ routing_outcome: 'manual_queue', queued_at: null }))).verdict).toBe('due');
      const waitingRoute = await answered();
      await q(`INSERT INTO public.chat_routing_state (conversation_id, workspace_id, waiting_since) VALUES ($1, $2, now())`, [waitingRoute, ws]);
      expect((await verdict(waitingRoute)).verdict).toBe('routing');
      const skipOnly = await answered();
      await q(`INSERT INTO public.chat_routing_state (conversation_id, workspace_id, skip_user_ids) VALUES ($1, $2, ARRAY[$3]::uuid[])`, [skipOnly, ws, reza]);
      expect((await verdict(skipOnly)).verdict).toBe('due');

      const call = async (cid: string, fields: string, values: string) => q(
        `INSERT INTO public.call_sessions (workspace_id, provider, call_type, context_type, context_id, ${fields}) VALUES ($1, 'livekit', 'audio', 'conversation', $2, ${values})`, [ws, cid],
      );
      const live = await answered();
      await call(live, 'state, created_at', `'active', now() - interval '1 hour'`);
      expect((await verdict(live)).verdict).toBe('call');
      const stuck = await answered();
      await call(stuck, 'state, created_at', `'ringing', now() - interval '13 hours'`);
      expect((await verdict(stuck)).verdict).toBe('due');
      const invited = await answered();
      await q(`INSERT INTO public.call_invitations (workspace_id, conversation_id, created_by_user_id, channel, status, expires_at)
               VALUES ($1, $2, $3, 'audio', 'pending', now() + interval '5 minutes')`, [ws, invited, sara]);
      expect((await verdict(invited)).verdict).toBe('call');
      const queued = await answered();
      await q(`INSERT INTO public.call_queue_entries (workspace_id, channel, state, conversation_id, expires_at) VALUES ($1, 'audio', 'queued', $2, now() + interval '5 minutes')`, [ws, queued]);
      expect((await verdict(queued)).verdict).toBe('call');
      const callback = await answered();
      await q(`INSERT INTO public.callback_requests (workspace_id, conversation_id, status) VALUES ($1, $2, 'scheduled')`, [ws, callback]);
      expect((await verdict(callback)).verdict).toBe('callback');
      const guidance = await answered();
      await q(`INSERT INTO public.ai_agent_guidance_requests (workspace_id, conversation_id, question, status) VALUES ($1, $2, 'چه بگویم؟', 'pending')`, [ws, guidance]);
      expect((await verdict(guidance)).verdict).toBe('guidance');
    });

    it('a call that connected after the question answers it; one 2 h ago is an exchange (recent)', async () => {
      const asked = await conversation();
      await message(asked, 'contact', '31 hours');
      await q(`INSERT INTO public.call_sessions (workspace_id, provider, call_type, context_type, context_id, state, connected_at, ended_at, created_at)
               VALUES ($1, 'livekit', 'audio', 'conversation', $2, 'ended', now() - interval '30 hours 50 minutes', now() - interval '30 hours', now() - interval '31 hours')`, [ws, asked]);
      expect(await verdict(asked)).toMatchObject({ verdict: 'due', closed_outcome: 'human' });
      const before = await conversation();
      await q(`INSERT INTO public.call_sessions (workspace_id, provider, call_type, context_type, context_id, state, connected_at, ended_at, created_at)
               VALUES ($1, 'livekit', 'audio', 'conversation', $2, 'ended', now() - interval '33 hours', now() - interval '32 hours', now() - interval '33 hours')`, [ws, before]);
      await message(before, 'contact', '31 hours');
      expect((await verdict(before)).verdict).toBe('needs_reply');
      const talked = await conversation();
      await message(talked, 'contact', '31 hours');
      await message(talked, 'agent', '30 hours');
      await q(`INSERT INTO public.call_sessions (workspace_id, provider, call_type, context_type, context_id, state, connected_at, ended_at, created_at)
               VALUES ($1, 'livekit', 'audio', 'conversation', $2, 'ended', now() - interval '3 hours', now() - interval '2 hours', now() - interval '3 hours')`, [ws, talked]);
      expect((await verdict(talked)).verdict).toBe('recent');
    });

    it('other channels, platform support, spam and closed are never the widget timer\'s', async () => {
      const quiet = async (o: Parameters<typeof conversation>[0]) => {
        const cid = await conversation(o);
        await message(cid, 'agent', '30 hours');
        return cid;
      };
      for (const channel of ['telegram', 'email', 'whatsapp', 'platform_support']) {
        expect((await verdict(await quiet({ meta: { channel } }))).verdict, channel).toBe('not_widget');
      }
      expect((await verdict(await quiet({ meta: { channel: 'widget' } }))).verdict).toBe('due');
      const support = await quiet({});
      await q(`INSERT INTO public.platform_support_threads (conversation_id, support_workspace_id, user_id) VALUES ($1, $2, $3)`, [support, ws, owner]);
      expect((await verdict(support)).verdict).toBe('not_widget');
      expect((await verdict(await quiet({ spam: true }))).verdict).toBe('spam');
      expect((await verdict(await quiet({ status: 'closed' }))).verdict).toBe('not_live');
      expect((await verdict(randomUUID())).verdict).toBe('not_found');
    });

    it('idle_due: never a row untouched for 30 days, nothing while switched off, and owed rows never use up the batch', async () => {
      const dormant = await conversation({ quiet: '40 days' });
      await message(dormant, 'agent', '40 days');
      expect((await verdict(dormant)).verdict).toBe('due');
      const due = await conversation({ quiet: '30 hours' });
      await message(due, 'agent', '30 hours');
      // Six owed rows, all older than the due one (first in the scan).
      for (let i = 0; i < 6; i++) {
        const owed = await conversation({ quiet: `${40 + i} hours` });
        await message(owed, 'contact', `${40 + i} hours`);
      }
      const rows = await q(`SELECT * FROM public.conversation_idle_due(5)`);
      expect(rows.map((r) => r.due_conversation_id)).toEqual([due]);
      expect(rows[0]).toMatchObject({ due_workspace_id: ws, due_status: 'open', due_has_visitor_turn: false, due_idle_hours: 24 });
      expect(new Date(rows[0].due_updated_at as string).getTime()).toBe(new Date((await conv(due)).updated_at as string).getTime());

      await setPlatform(false);
      expect(await q(`SELECT * FROM public.conversation_idle_due(500)`)).toEqual([]);
      expect(await close(due)).toMatchObject({ closed: false, outcome: 'disabled' });
      // The backlog's close does not ask the switch.
      expect(await close(dormant, 'backlog')).toMatchObject({ closed: true, outcome: 'closed' });
    });
  });

  // ─── M4: the close ─────────────────────────────────────────────────────
  describe('M4 conversation_close_if_idle()', () => {
    beforeEach(async () => {
      await q(`DELETE FROM public.conversations WHERE workspace_id = $1`, [ws]);
      await setPlatform(true, 24);
    });

    it('writes exactly the markers and the two stamps: never updated_at, the AI\'s hold or routing\'s state; one event as the PATCH files it; the line forced', async () => {
      const held = { ai_state: 'ai_managed', managed_by_ai: true, ai_handoff_sent: true, human_takeover_at: '2026-10-01T00:00:00.000Z',
        routing_department_only: true, routing_thread_ended_at: '2026-10-20T00:00:00.000Z' };
      const cid = await conversation({ meta: held, assigned: sara });
      await message(cid, 'contact', '30 hours 30 minutes');
      await message(cid, 'agent', '30 hours');
      await q(`INSERT INTO public.chat_routing_state (conversation_id, workspace_id, skip_user_ids) VALUES ($1, $2, ARRAY[$3]::uuid[])`, [cid, ws, reza]);
      const before = await conv(cid);
      const r = await close(cid, 'timer', ['The conversation was closed', { operator_id: sara, operator_name: 'Sara', agent_name: 'spoof', agent_id: owner, internal: true }]);
      expect(r).toMatchObject({ closed: true, outcome: 'closed', from_status: 'open', event_type: 'resolved', closed_outcome: 'human', workspace_id: ws });
      const after = await conv(cid);
      expect(after.status).toBe('closed');
      expect(new Date(after.updated_at as string).getTime()).toBe(new Date(before.updated_at as string).getTime());
      const was = before.metadata as Row;
      const now = after.metadata as Row;
      const changed = Object.keys(now).filter((k) => JSON.stringify(now[k]) !== JSON.stringify(was[k])).sort();
      expect(changed).toEqual([...CLOSED_KEYS, 'routing_thread_ended_at', 'ai_thread_reset_at'].sort());
      expect(now).toMatchObject({
        ...held, routing_thread_ended_at: now.closed_at, ai_thread_reset_at: now.closed_at,
        closed_reason: 'inactivity', closed_by: 'system', closed_from: 'open', closed_source: 'inactivity_timer',
        closed_idle_hours: 24, closed_outcome: 'human', closed_line_id: r.line_id,
        closed_prev_stamps: { routing_thread_ended_at: '2026-10-20T00:00:00.000Z', ai_thread_reset_at: null },
      });
      expect(String(now.closed_at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect((await one(`SELECT skip_user_ids FROM public.chat_routing_state WHERE conversation_id = $1`, [cid])).skip_user_ids).toEqual([reza]);
      const line = await one(`SELECT sender_type, body, metadata FROM public.conversation_messages WHERE id = $1`, [r.line_id]);
      expect(line).toMatchObject({ sender_type: 'system', body: 'The conversation was closed' });
      expect(line.metadata).toEqual({
        kind: 'conversation_closed', by: 'system', closed_reason: 'inactivity', status: 'closed',
        agent_id: null, agent_name: null, operator_id: sara, operator_name: 'Sara',
      });
      expect(await events(cid)).toEqual([{ event_type: 'resolved', actor_type: 'system', actor_id: null,
        payload: { from: 'open', to: 'closed', reason: 'inactivity', source: 'inactivity_timer', idle_hours: 24 } }]);
      expect(await close(cid)).toMatchObject({ closed: false, outcome: 'not_live' });

      const resolved = await conversation({ status: 'resolved' });
      await message(resolved, 'agent', '30 hours');
      expect(await close(resolved)).toMatchObject({ closed: true, event_type: 'status_changed', from_status: 'resolved', line_id: null });
      expect((await events(resolved))[0]).toMatchObject({ event_type: 'status_changed', payload: { from: 'resolved', to: 'closed' } });
      expect((await conv(resolved)).metadata).toMatchObject({ closed_from: 'resolved', closed_line_id: null });
    });

    it('\'changed\' on a stale updated_at; the backlog refuses a line and writes none; an unknown source raises', async () => {
      const cid = await conversation();
      await message(cid, 'agent', '30 hours');
      const stale = await one(`SELECT * FROM public.conversation_close_if_idle($1, now() - interval '1 day', 'timer')`, [cid]);
      expect(stale).toMatchObject({ closed: false, outcome: 'changed' });
      await expect(close(cid, 'backlog', ['The conversation was closed', {}])).rejects.toThrow(/backlog close writes no visitor line/);
      await expect(close(cid, 'sweep')).rejects.toThrow(/unknown source/);
      const r = await close(cid, 'backlog');
      expect(r).toMatchObject({ closed: true, line_id: null });
      expect((await conv(cid)).metadata).toMatchObject({ closed_source: 'inactivity_backlog', closed_line_id: null });
      expect((await events(cid))[0].payload).toMatchObject({ source: 'inactivity_backlog' });
      expect(await q(`SELECT id FROM public.conversation_messages WHERE conversation_id = $1 AND sender_type = 'system'`, [cid])).toEqual([]);
    });

    it('the plan\'s retention lock reads the same before and after (updated_at did not move)', async () => {
      const { isConversationLocked } = await import('../../../server/services/contactChatLocks.js');
      const locks = { enabled: true, kb: null, contact: null, member: null, conversation: { cut: { ts: new Date(Date.now() - 3 * 86_400_000).toISOString() }, limit: 3 } } as never;
      const old = await conversation({ quiet: '5 days' });
      await message(old, 'agent', '5 days');
      const fresh = await conversation({ quiet: '30 hours' });
      await message(fresh, 'agent', '30 hours');
      const row = (cid: string) => one(`SELECT created_at, updated_at FROM public.conversations WHERE id = $1`, [cid]);
      const before = [isConversationLocked(locks, await row(old) as never), isConversationLocked(locks, await row(fresh) as never)];
      expect(before).toEqual([true, false]);
      await close(old);
      await close(fresh);
      expect([isConversationLocked(locks, await row(old) as never), isConversationLocked(locks, await row(fresh) as never)]).toEqual(before);
    });

    it('the ticker publishes what the Inbox\'s PATCH publishes for the same move (kind, fields), with no actor', async () => {
      const { runConversationIdleCloseOnce } = await import('../../../server/services/conversationIdleCloseTicker.js');
      const kindsOf = (cid: string) => state.operatorEvents.filter((e) => e.conversation_id === cid && e.kind !== 'timeline_event');
      const pair = async (status: string) => {
        const byPatch = await conversation({ status, assigned: sara, quiet: '1 minute' });
        await message(byPatch, 'agent', '1 minute');
        const byTimer = await conversation({ status, assigned: sara });
        await message(byTimer, 'agent', '30 hours');
        return { byPatch, byTimer };
      };
      const open = await pair('open');
      const resolved = await pair('resolved');
      for (const p of [open, resolved]) {
        expect((await request(app).patch(`/api/conversations/${p.byPatch}`).set(as(sara)).send({ workspace_id: ws, status: 'closed' })).status).toBe(200);
      }
      expect(await runConversationIdleCloseOnce(config as never)).toMatchObject({ closed: 2 });
      for (const p of [open, resolved]) {
        const patched = kindsOf(p.byPatch);
        const timed = kindsOf(p.byTimer);
        expect(timed).toHaveLength(1);
        expect(patched).toHaveLength(1);
        expect(timed[0].kind).toBe(patched[0].kind);
        expect(Object.keys(timed[0]).filter((k) => k !== 'reason').sort()).toEqual(Object.keys(patched[0]).sort());
        expect(timed[0]).toMatchObject({ actor_id: null, reason: 'inactivity', changes: patched[0].changes });
        expect(new Date(timed[0].updated_at as string).getTime()).toBe(new Date((await conv(p.byTimer)).updated_at as string).getTime());
        const echo = state.operatorEvents.find((e) => e.conversation_id === p.byTimer && e.kind === 'timeline_event');
        expect(echo).toMatchObject({ actor_type: 'system', actor_id: null, event_type: (await events(p.byTimer))[0].event_type });
      }
      expect(kindsOf(open.byTimer)[0].kind).toBe('conversation_resolved');
      expect(kindsOf(resolved.byTimer)[0].kind).toBe('conversation_updated');
    });
  });

  // ─── M5: the race ──────────────────────────────────────────────────────
  describe('M5 the race', () => {
    beforeEach(async () => {
      await q(`DELETE FROM public.conversations WHERE workspace_id = $1`, [ws]);
      await setPlatform(true, 24);
    });

    it('R1 a visitor message being inserted holds the close back (its foreign key\'s KEY SHARE), and the conversation stays open', async () => {
      const cid = await conversation();
      await message(cid, 'contact', '31 hours');
      await message(cid, 'agent', '30 hours');
      // As the ticker passes it: the exact value (a JS Date drops the microseconds).
      const expected = (await one(`SELECT updated_at::text AS u FROM public.conversations WHERE id = $1`, [cid])).u;
      const visitor = new pg.Client({ connectionString: url });
      const timer = new pg.Client({ connectionString: url });
      await visitor.connect();
      await timer.connect();
      try {
        await visitor.query('BEGIN');
        await visitor.query(`INSERT INTO public.conversation_messages (conversation_id, sender_type, body) VALUES ($1, 'contact', 'هنوز هستید؟')`, [cid]);
        const closing = timer.query(`SELECT * FROM public.conversation_close_if_idle($1, $2, 'timer')`, [cid, expected]);
        await new Promise((r) => setTimeout(r, 300));
        const waiting = await one(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`);
        expect(waiting.n).toBeGreaterThanOrEqual(1);
        await visitor.query('COMMIT');
        expect(['recent', 'needs_reply']).toContain((await closing).rows[0].outcome);
      } finally {
        await visitor.end();
        await timer.end();
      }
      expect((await conv(cid)).status).toBe('open');
    });

    for (const from of ['open', 'pending', 'resolved'] as const) {
      it(`R2 a reopen within the grace restores ${from}, the stamps as they were, retracts the line, once`, async () => {
        const stamps = { routing_thread_ended_at: '2026-10-20T00:00:00.000Z' };
        const cid = await conversation({ status: from, meta: stamps });
        await message(cid, 'contact', '31 hours');
        await message(cid, 'agent', '30 hours');
        const r = await close(cid, 'timer', ['The conversation was closed', { operator_id: sara }]);
        expect(r.closed).toBe(true);
        await message(cid, 'contact', '0 seconds', {}, 'یک سؤال دیگر');
        const back = await reopen(cid);
        expect(back).toMatchObject({ restored_status: from, event_id: expect.any(String), retracted_line_id: r.line_id });
        const after = await conv(cid);
        expect(after.status).toBe(from);
        const meta = after.metadata as Row;
        for (const k of CLOSED_KEYS) expect(meta, k).not.toHaveProperty(k);
        expect(meta.routing_thread_ended_at).toBe('2026-10-20T00:00:00.000Z');
        expect(meta).not.toHaveProperty('ai_thread_reset_at');
        expect(String(meta.idle_close_undone_at)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect((await one(`SELECT metadata->>'internal' AS internal FROM public.conversation_messages WHERE id = $1`, [r.line_id])).internal).toBe('true');
        expect((await events(cid)).map((e) => [e.event_type, e.actor_type, (e.payload as Row).to, (e.payload as Row).reason])).toEqual([
          [from === 'resolved' ? 'status_changed' : 'resolved', 'system', 'closed', 'inactivity'],
          ['reopened', 'visitor', from, 'customer_replied_after_inactivity_close'],
        ]);
        expect((await reopen(cid)).restored_status).toBeNull();
      });
    }

    it('R2 not past the grace, not after an operator\'s close, not another workspace\'s', async () => {
      const old = await conversation({ status: 'closed', meta: { closed_reason: 'inactivity', closed_from: 'open', closed_at: new Date(Date.now() - 5 * 60_000).toISOString() } });
      expect((await reopen(old)).restored_status).toBeNull();
      expect((await reopen(old, 600)).restored_status).toBe('open');
      const byOperator = await conversation({ status: 'closed', meta: { closed_reason: 'operator', closed_from: 'open', closed_at: new Date().toISOString() } });
      expect((await reopen(byOperator)).restored_status).toBeNull();
      const badStamp = await conversation({ status: 'closed', meta: { closed_reason: 'inactivity', closed_at: 'yesterday' } });
      expect((await reopen(badStamp)).restored_status).toBeNull();
      const recent = await conversation({ status: 'closed', meta: { closed_reason: 'inactivity', closed_from: 'open', closed_at: new Date().toISOString() } });
      expect((await one(`SELECT * FROM public.conversation_reopen_after_idle_close($1, $2, NULL, 60)`, [randomUUID(), recent])).restored_status).toBeNull();
      expect((await conv(recent)).status).toBe('closed');
    });

    it('R3 through POST /message: a named conversation closed 10 s ago comes back (same id, not continued); 5 minutes ago a new one', async () => {
      const recent = await conversation({ status: 'closed', meta: { closed_reason: 'inactivity', closed_from: 'resolved', closed_at: new Date(Date.now() - 10_000).toISOString() } });
      const res = await send({ conversation_id: recent });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.conversation_id).toBe(recent);
      expect(res.body.continued).toBeUndefined();
      // Back to resolved, then the visitor's message reopened it as any message does.
      expect((await conv(recent)).status).toBe('open');
      const types = (await events(recent)).map((e) => [e.event_type, (e.payload as Row).reason]);
      expect(types).toEqual(expect.arrayContaining([['reopened', 'customer_replied_after_inactivity_close']]));
      expect(state.operatorEvents).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'conversation_reopened', conversation_id: recent, actor_id: null })]));

      await q(`UPDATE public.conversations SET status = 'closed' WHERE workspace_id = $1`, [ws]);
      const old = await conversation({ status: 'closed', meta: { closed_reason: 'inactivity', closed_from: 'open', closed_at: new Date(Date.now() - 5 * 60_000).toISOString() } });
      const fresh = await send({ conversation_id: old });
      expect(fresh.status).toBe(200);
      expect(fresh.body.conversation_id).not.toBe(old);
      expect((await conv(old)).status).toBe('closed');
    });
  });

  // ─── M6: the backlog script ────────────────────────────────────────────
  (PSQL ? describe : describe.skip)('M6 the backlog script (psql)', () => {
    const run = (vars: Record<string, string>) => {
      const args = [url, '-X', '-q', '-v', 'ON_ERROR_STOP=1', ...Object.entries(vars).flatMap(([k, v]) => ['-v', `${k}=${v}`]), '-f', BACKLOG];
      return spawnSync('psql', args, { encoding: 'utf8' });
    };
    let dueA = '';
    let dueB = '';
    let owedLater = '';
    let owed = '';

    beforeAll(async () => {
      await q(`DELETE FROM public.conversations WHERE workspace_id = $1`, [ws]);
      await setPlatform(false);
      dueA = await conversation({ quiet: '40 days' });
      await message(dueA, 'agent', '40 days');
      dueB = await conversation({ status: 'resolved', quiet: '50 hours' });
      await message(dueB, 'contact', '51 hours');
      await message(dueB, 'agent', '50 hours');
      owedLater = await conversation({ quiet: '60 hours' });
      await message(owedLater, 'agent', '60 hours');
      owed = await conversation({ quiet: '3 days' });
      await message(owed, 'contact', '3 days');
      const recent = await conversation({ quiet: '1 hour' });
      await message(recent, 'contact', '1 hour');
      await conversation({ meta: { channel: 'telegram' } });
    });

    it('the dry run lists every verdict, closes every due row inside the transaction with no line and one event each, then rolls back', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'backlog284-'));
      const out = join(dir, 'backlog.csv');
      const before = await q(`SELECT id, status, updated_at FROM public.conversations WHERE workspace_id = $1 ORDER BY id`, [ws]);
      const res = run({ out });
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toMatch(/due/);
      expect(res.stdout).toMatch(/needs_reply/);
      expect(res.stdout).toMatch(/recent/);
      expect(res.stdout).toMatch(/Dry run: rolled back/);
      expect(res.stdout).not.toMatch(/سلام/); // no message text
      const ids = readFileSync(out, 'utf8').trim().split('\n').sort();
      expect(ids).toEqual([dueA, dueB, owedLater].sort());
      // Nothing changed: statuses, updated_at, events, the switch.
      expect(await q(`SELECT id, status, updated_at FROM public.conversations WHERE workspace_id = $1 ORDER BY id`, [ws])).toEqual(before);
      expect(await q(`SELECT id FROM public.conversation_events WHERE conversation_id = ANY($1::uuid[])`, [before.map((r) => r.id)])).toEqual([]);
      expect((await one(`SELECT inactivity_close_enabled FROM public.widget_platform_settings LIMIT 1`)).inactivity_close_enabled).toBe(false);
    });

    it('the commit closes the reviewed ids only, skips one that became owed since, and turns the switch on (enable=0 keeps it off)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'backlog284-'));
      const csv = join(dir, 'reviewed.csv');
      // Reviewed: dueA and owedLater; dueB is left for another day.
      writeFileSync(csv, `${dueA}\n${owedLater}\n`);
      // Since the review, the visitor wrote in owedLater: it is owed now.
      await message(owedLater, 'contact', '1 minute', {}, 'سلام؟');
      const off = run({ commit: '1', ids: csv, enable: '0' });
      expect(off.status, off.stderr).toBe(0);
      expect(off.stdout).toMatch(/COMMITTED/);
      expect((await conv(dueA)).status).toBe('closed');
      expect((await conv(owedLater)).status).toBe('open');
      expect((await conv(dueB)).status).toBe('resolved');
      expect((await one(`SELECT inactivity_close_enabled FROM public.widget_platform_settings LIMIT 1`)).inactivity_close_enabled).toBe(false);
      expect((await events(dueA)).map((e) => (e.payload as Row).source)).toEqual(['inactivity_backlog']);
      expect(await q(`SELECT id FROM public.conversation_messages WHERE conversation_id = $1 AND sender_type = 'system'`, [dueA])).toEqual([]);

      writeFileSync(csv, `${dueB}\n`);
      const on = run({ commit: '1', ids: csv });
      expect(on.status, on.stderr).toBe(0);
      expect((await conv(dueB)).status).toBe('closed');
      expect((await conv(dueB)).metadata).toMatchObject({ closed_from: 'resolved', closed_source: 'inactivity_backlog' });
      expect((await one(`SELECT inactivity_close_enabled FROM public.widget_platform_settings LIMIT 1`)).inactivity_close_enabled).toBe(true);
      // A commit without the reviewed list refuses to run.
      const bare = run({ commit: '1' });
      expect(bare.stdout + bare.stderr).toMatch(/pass -v ids=/);
    });
  });

  // ─── T: the ticker for real, the Inbox, the rating ──────────────────────
  describe('T the ticker, the Inbox and the rating after an automatic close', () => {
    beforeEach(async () => {
      await q(`DELETE FROM public.conversations WHERE workspace_id = $1`, [ws]);
      await setPlatform(true, 24);
    });

    it('closes what fell due, writes the nameless line where the visitor wrote, tells nobody else; the next pass closes nothing', async () => {
      const { runConversationIdleCloseOnce } = await import('../../../server/services/conversationIdleCloseTicker.js');
      const talked = await conversation({ assigned: sara });
      await message(talked, 'contact', '30 hours 1 minute');
      await message(talked, 'agent', '30 hours');
      const greeting = await conversation({ meta: { source: 'ai_agent_intro', ai_state: 'ai_managed' } });
      await message(greeting, 'ai', '30 hours', { source: 'ai_agent_intro' }, 'سلام! چطور کمک کنم؟');
      const owed = await conversation();
      await message(owed, 'contact', '30 hours');
      const pass = await runConversationIdleCloseOnce(config as never);
      expect(pass).toEqual({ due: 2, closed: 2, skipped: {} });
      const line = await one(`SELECT id, body, metadata FROM public.conversation_messages WHERE conversation_id = $1 AND sender_type = 'system'`, [talked]);
      expect(line).toMatchObject({ body: 'The conversation was closed', metadata: { by: 'system', closed_reason: 'inactivity', agent_name: null, operator_id: sara, operator_name: 'Sara' } });
      expect((await conv(talked)).metadata).toMatchObject({ closed_line_id: line.id });
      expect(await q(`SELECT id FROM public.conversation_messages WHERE conversation_id = $1 AND sender_type = 'system'`, [greeting])).toEqual([]);
      // The visitor's line, live; nothing for the greeting nobody answered.
      await until(async () => state.conversationEvents.length, (n) => n >= 1);
      expect(state.conversationEvents.map((e) => e.cid)).toEqual([talked]);
      expect((state.conversationEvents[0].envelope as Row).type).toBe('message');
      expect(state.pushes).toBe(0);
      expect(state.transcripts).toBe(0);
      expect(await q(`SELECT id FROM public.audit_logs WHERE entity_id = ANY($1::uuid[])`, [[talked, greeting]]).catch(() => [])).toEqual([]);
      expect((await conv(owed)).status).toBe('open');
      expect(await runConversationIdleCloseOnce(config as never)).toEqual({ due: 0, closed: 0, skipped: {} });
    });

    it('a thread that already ends with a closed line keeps it: no second line, closed_line_id null, nothing to retract', async () => {
      const { runConversationIdleCloseOnce } = await import('../../../server/services/conversationIdleCloseTicker.js');
      const cid = await conversation({ assigned: sara });
      await message(cid, 'contact', '31 hours');
      await message(cid, 'agent', '30 hours 30 minutes', {}, 'بفرمایید');
      const earlier = await message(cid, 'system', '30 hours', { kind: 'conversation_closed', by: 'agent', agent_name: 'Sara', status: 'closed', operator_id: sara });
      expect(await runConversationIdleCloseOnce(config as never)).toMatchObject({ closed: 1 });
      expect((await q(`SELECT id FROM public.conversation_messages WHERE conversation_id = $1 AND sender_type = 'system'`, [cid])).map((r) => r.id)).toEqual([earlier]);
      expect((await conv(cid)).metadata).toMatchObject({ closed_line_id: null });
      await message(cid, 'contact', '0 seconds', {}, 'یک سؤال');
      expect((await reopen(cid)).retracted_line_id).toBeNull();
      expect((await one(`SELECT metadata->>'internal' AS internal FROM public.conversation_messages WHERE id = $1`, [earlier])).internal).toBeNull();
    });

    it('an AI-only conversation closed automatically is in no Inbox queue; a person\'s is in their Resolved tab', async () => {
      const { runConversationIdleCloseOnce } = await import('../../../server/services/conversationIdleCloseTicker.js');
      const ai = await conversation({ meta: { ai_state: 'ai_managed' } });
      await message(ai, 'contact', '31 hours');
      await message(ai, 'ai', '30 hours', {}, 'از ۹ تا ۱۸.');
      const human = await conversation({ assigned: sara });
      await message(human, 'contact', '31 hours');
      await message(human, 'agent', '30 hours');
      expect(await runConversationIdleCloseOnce(config as never)).toMatchObject({ closed: 2 });
      expect((await conv(ai)).metadata).toMatchObject({ ai_state: 'ai_managed' });
      const list = async (query: string, user = sara) => ((await request(app).get(`/api/conversations?workspace_id=${ws}&${query}`).set(as(user))).body.conversations as Row[]).map((r) => r.id);
      expect(await list('queue=main&status=resolved')).toEqual([human]);
      expect(await list('queue=main&status=resolved', owner)).not.toContain(ai);
      expect(await list('queue=automated')).not.toContain(ai);
      const tabs = (await request(app).get(`/api/conversations/inbox-tab-counts?workspace_id=${ws}`).set(as(sara))).body;
      expect(tabs).toMatchObject({ resolved: 1, automated: 0 });
    });

    it('an operator\'s reply into an automatically closed conversation reopens it and clears the markers', async () => {
      const cid = await conversation({ assigned: sara });
      await message(cid, 'contact', '31 hours');
      await message(cid, 'agent', '30 hours');
      expect(await close(cid)).toMatchObject({ closed: true });
      const res = await request(app).post('/api/conversations/send-message').set(as(sara)).send({ workspace_id: ws, conversation_id: cid, body: 'هنوز در خدمتم' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const after = await until(() => conv(cid), (c) => c.status === 'open' && (c.metadata as Row).closed_reason === null);
      expect(after.status).toBe('open');
      for (const k of CLOSED_KEYS) expect((after.metadata as Row)[k], k).toBeNull();
      // A later close by the operator is theirs.
      expect((await request(app).patch(`/api/conversations/${cid}`).set(as(sara)).send({ workspace_id: ws, status: 'closed' })).status).toBe(200);
      expect((await conv(cid)).metadata).toMatchObject({ closed_reason: 'operator', closed_from: 'open', closed_source: null });
      const { conversationEndOf } = await import('../../../shared/inactivityClose.js');
      expect(conversationEndOf('closed', (await conv(cid)).metadata)).toBe('closed_operator');
    });

    it('the AI\'s rating: subject ai, no operator, kept out of every operator\'s satisfaction', async () => {
      const { runConversationIdleCloseOnce } = await import('../../../server/services/conversationIdleCloseTicker.js');
      const ratings = await import('../../../server/services/conversationRatings.js');
      const ai = await conversation({ meta: { ai_state: 'ai_managed' } });
      await message(ai, 'contact', '31 hours');
      await message(ai, 'ai', '30 hours', {}, 'از ۹ تا ۱۸.');
      await runConversationIdleCloseOnce(config as never);
      const csat = await ratings.csatState(config as never, { workspaceId: ws, conversationId: ai, csatEnabled: true });
      expect(csat).toMatchObject({ rateable: true, subject: 'ai', operator: null });
      await ratings.rateClosedConversation(config as never, { workspaceId: ws, conversationId: ai, closedId: csat.closed_id, score: 4, comment: null });
      expect(await one(`SELECT operator_id, subject, score FROM public.conversation_ratings WHERE conversation_id = $1`, [ai]))
        .toEqual({ operator_id: null, subject: 'ai', score: 4 });
      const { ratingsByOperator, aiRatings } = await import('../../../server/routes/operatorActivity.js');
      const { getServiceClient } = await import('../../../server/supabase.js');
      const since = new Date(Date.now() - 86_400_000).toISOString();
      expect([...(await ratingsByOperator(getServiceClient(config as never), ws, since)).keys()]).toEqual([]);
      expect(await aiRatings(getServiceClient(config as never), ws, since)).toEqual({ sum: 4, count: 1 });
    });
  });
});
