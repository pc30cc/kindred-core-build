// @vitest-environment node
/**
 * 282b — a panel tab that goes away ends only its own part of the operator's
 * live-presence lease (R-11), on a real database built by the whole chain:
 *
 *   M  before 282b there is no `sources` column; a dry run leaves no trace;
 *      applied, an existing lease reads '{}' and keeps its last_seen_at; the
 *      functions are executable by service_role only; a second run changes
 *      nothing.
 *   F  the functions: a beat stamps its source and drops entries older than
 *      the window; leaving one of two sources keeps the lease, dated by the
 *      other ('present'); leaving the last deletes it ('gone'); an unknown
 *      source or a lease from before 282b changes nothing ('unknown').
 *   R  the real routes, as the panel calls them: heartbeats name their tab
 *      (JSON), the beacon is text/plain with the session cookie and the
 *      Origin; with the real presence reading (database mode) and routing:
 *      - an operator with two tabs who closes one is still connected and
 *        still given chats;
 *      - the desktop app's beats (no source id) keep them here after their
 *        last tab is gone;
 *      - an operator whose only tab is gone is no longer connected at once,
 *        and routing does not pick them (it waits for someone instead);
 *      - the beacon needs the session (401), a workspace of theirs (403) and
 *        a valid body (400); it is 204 otherwise, whatever happened.
 *
 * Driven by TEST_DATABASE_URL; skipped without it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import pg from 'pg';
import { applyMigrationSql } from './pgMigrationChain';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

const DB = `operator_presence_sources_282b_${Date.now()}`;
const DIR = resolve(process.cwd(), 'database/migrations');
const FILE = '282b_operator_presence_sources.sql';
const SQL = () => readFileSync(resolve(DIR, FILE), 'utf8');
const WINDOW_MS = 5 * 60_000;
const ORIGIN = 'http://127.0.0.1';

type Row = Record<string, unknown>;

// The database presence (polling): the lease is the whole connection signal.
vi.mock('../../../server/services/realtime/index.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/realtime/index.js')>()),
  loadRealtimeConfig: async () => ({ vendor: 'polling_builtin', enabled: true, fallback_policy: 'lenient', fallback_vendor: 'polling_builtin', centrifugo: {} }),
  resolveRealtimeProvider: async () => ({ effective_vendor: 'polling_builtin', capabilities: { supportsPresence: false }, public_config: {}, health: { status: 'healthy' } }),
  getCentrifugoDriver: async () => null,
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

suite('282b — a tab that goes away ends only its part of the lease (real PostgreSQL, whole chain)', () => {
  let admin: pg.Client;
  let db: pg.Client;
  let url: string;
  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows as Row[];
  const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];
  const hasSources = async () => (await q(`SELECT 1 FROM information_schema.columns
                                            WHERE table_schema = 'public' AND table_name = 'operator_presence_live' AND column_name = 'sources'`)).length === 1;
  const lease = async (ws: string, user: string) =>
    (await q(`SELECT last_seen_at, sources FROM public.operator_presence_live WHERE workspace_id = $1 AND user_id = $2`, [ws, user]))[0];

  const owner = randomUUID();
  const ali = randomUUID();
  const bahar = randomUUID();
  const early = randomUUID();
  const ws = randomUUID();
  const other = randomUUID();

  beforeAll(async () => {
    const adminUrl = new URL(DSN!);
    adminUrl.pathname = '/postgres';
    admin = new pg.Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    const u = new URL(DSN!);
    u.pathname = `/${DB}`;
    url = u.toString();
    db = new pg.Client({ connectionString: url });
    await db.connect();
    await db.query('SET client_min_messages = warning');
    for (const file of readdirSync(DIR).filter((f) => f.endsWith('.sql') && f < FILE).sort()) {
      await applyMigrationSql(db, readFileSync(resolve(DIR, file), 'utf8'));
    }
    for (const [id, name] of [[owner, 'Owner'], [ali, 'Ali'], [bahar, 'Bahar'], [early, 'Early']]) {
      await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, $3)`, [id, `p-${id.slice(0, 8)}@test.local`, name]);
    }
    for (const id of [ws, other]) {
      await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [id, `ws-${id.slice(0, 8)}`, owner]);
    }
    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'agent'), ($1, $4, 'support_agent'), ($5, $2, 'owner')
             ON CONFLICT DO NOTHING`, [ws, owner, ali, bahar, other]);
    // A lease written before 282b.
    await q(`INSERT INTO public.operator_presence_live (workspace_id, user_id, last_seen_at) VALUES ($1, $2, now())`, [ws, early]);
  }, 600_000);

  afterAll(async () => {
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer().catch(() => undefined);
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      await admin.end();
    }
  });

  describe('M the migration', () => {
    it('before 282b there is no sources column; a dry run leaves no trace', async () => {
      expect(await hasSources()).toBe(false);
      await db.query('BEGIN');
      try {
        await db.query(SQL());
        expect(await hasSources()).toBe(true);
      } finally {
        await db.query('ROLLBACK');
      }
      expect(await hasSources()).toBe(false);
      expect((await q(`SELECT 1 FROM pg_proc WHERE proname = 'operator_presence_leave'`)).length).toBe(0);
    });

    it('applies: an existing lease reads {} and keeps its time; the functions are the backend\'s only', async () => {
      const before = await one(`SELECT last_seen_at FROM public.operator_presence_live WHERE workspace_id = $1 AND user_id = $2`, [ws, early]);
      await applyMigrationSql(db, SQL());
      expect(await lease(ws, early)).toEqual({ last_seen_at: before.last_seen_at, sources: {} });
      for (const fn of [
        'public.operator_presence_beat(uuid, uuid, text, timestamptz, bigint)',
        'public.operator_presence_leave(uuid, uuid, text, timestamptz, bigint)',
        'public.operator_presence_live_sources(jsonb, text, timestamptz, bigint)',
      ]) {
        expect(await one(`SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS s,
                                 has_function_privilege('authenticated', $1, 'EXECUTE') AS a,
                                 has_function_privilege('anon', $1, 'EXECUTE') AS n`, [fn]), fn).toEqual({ s: true, a: false, n: false });
      }
      for (const file of readdirSync(DIR).filter((f) => f.endsWith('.sql') && f > FILE).sort()) {
        await applyMigrationSql(db, readFileSync(resolve(DIR, file), 'utf8'));
      }
    });

    it('re-runnable: a second run changes nothing', async () => {
      const before = await q(`SELECT * FROM public.operator_presence_live ORDER BY user_id`);
      await applyMigrationSql(db, SQL());
      expect(await q(`SELECT * FROM public.operator_presence_live ORDER BY user_id`)).toEqual(before);
    });
  });

  describe('F the functions', () => {
    const T = new Date('2026-10-22T10:00:00Z');
    const at = (sec: number) => new Date(T.getTime() + sec * 1000).toISOString();
    const beat = (user: string, source: string, sec: number) =>
      q(`SELECT public.operator_presence_beat($1, $2, $3, $4, $5)`, [other, user, source, at(sec), WINDOW_MS]);
    const leave = async (user: string, source: string, sec: number) =>
      (await one(`SELECT public.operator_presence_leave($1, $2, $3, $4, $5) AS r`, [other, user, source, at(sec), WINDOW_MS])).r;

    it('two sources: leaving one keeps the lease, dated by the other; leaving the last deletes it', async () => {
      await beat(ali, 'tab-aaaaaaaa', 0);
      await beat(ali, 'tab-bbbbbbbb', 30);
      expect((await lease(other, ali)).sources).toEqual({ 'tab-aaaaaaaa': T.getTime(), 'tab-bbbbbbbb': T.getTime() + 30_000 });
      expect(new Date(String((await lease(other, ali)).last_seen_at)).toISOString()).toBe(at(30));
      expect(await leave(ali, 'tab-bbbbbbbb', 40)).toBe('present');
      expect(await lease(other, ali)).toEqual({ last_seen_at: new Date(at(0)), sources: { 'tab-aaaaaaaa': T.getTime() } });
      expect(await leave(ali, 'tab-aaaaaaaa', 50)).toBe('gone');
      expect(await lease(other, ali)).toBeUndefined();
    });

    it('a source that stopped beating (no beacon: a crash) does not hold the lease past the window', async () => {
      await beat(bahar, 'tab-crashed1', 0);
      await beat(bahar, '_', 200);
      // The desktop app beats on; the crashed tab's entry is dropped at the next beat past the window.
      await beat(bahar, '_', 320);
      expect((await lease(other, bahar)).sources).toEqual({ _: T.getTime() + 320_000 });
      // The beacon of a tab whose entry expired: unknown, nothing changes.
      expect(await leave(bahar, 'tab-crashed1', 330)).toBe('unknown');
      await beat(bahar, 'tab-live0001', 340);
      // Leaving the live tab: the desktop app's beat (20 s old) keeps them here.
      expect(await leave(bahar, 'tab-live0001', 340)).toBe('present');
      // Nothing beat for longer than the window: the last tab's beacon ends the lease.
      await beat(bahar, 'tab-late0001', 700);
      expect(await leave(bahar, 'tab-late0001', 701)).toBe('gone');
    });

    it('no lease, or a lease from before 282b: unknown, nothing changes', async () => {
      expect(await leave(owner, 'tab-whatever', 0)).toBe('unknown');
      const before = await lease(ws, early);
      expect((await one(`SELECT public.operator_presence_leave($1, $2, 'tab-zzzzzzzz', now(), $3) AS r`, [ws, early, WINDOW_MS])).r).toBe('unknown');
      expect(await lease(ws, early)).toEqual(before);
    });
  });

  describe('R the routes, presence and routing', () => {
    let config: ReturnType<typeof import('../../../server/config.js')['loadConfig']>;
    let routing: typeof import('../../../server/services/chatRouting.js');
    let presence: typeof import('../../../server/services/widget/operatorPresence.js');
    let activity: typeof import('../../../server/services/widget/operatorActivity.js');
    let source: typeof import('../../../server/services/widget/operatorPresenceSource.js');
    let app: express.Express;
    const tokens: Record<string, string> = {};
    const cookie = (user: string) => `gs_session=${tokens[user]}`;
    const heartbeat = (user: string, sourceId?: string) =>
      request(app).post('/api/operator-activity/heartbeat').set({ Cookie: cookie(user), Origin: ORIGIN })
        .send(sourceId ? { workspace_id: ws, source_id: sourceId } : { workspace_id: ws });
    // What navigator.sendBeacon(url, string) sends.
    const beacon = (user: string | null, body: string, wsOrigin = ORIGIN) => {
      const r = request(app).post('/api/operator-activity/leave').set('Content-Type', 'text/plain;charset=UTF-8').set('Origin', wsOrigin);
      return (user ? r.set('Cookie', cookie(user)) : r).send(body);
    };
    const connected = async (user: string) => (await source.getConnectedOperators(config as never, ws, [user])).connected.has(user);
    const conversation = async () => {
      const id = randomUUID();
      await q(`INSERT INTO public.conversations (id, workspace_id, status) VALUES ($1, $2, 'open')`, [id, ws]);
      return id;
    };

    beforeAll(async () => {
      await q(`INSERT INTO public.widget_settings (workspace_id, enabled, assignment_mode, first_response_timeout_minutes) VALUES ($1, true, 'auto', 0)`, [ws]);
      Object.assign(process.env, {
        DATABASE_URL: url,
        PLATFORM_SIGNING_SECRET: 'signing-secret-for-this-test-only-0123456789',
        SUPABASE_URL: 'https://legacy-project.supabase.co',
        SUPABASE_ANON_KEY: 'legacy-anon-key-value',
        SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-key-value-at-least-32',
        CORS_ORIGINS: ORIGIN,
      });
      delete process.env.DATABASE_MODE;
      config = { ...(await import('../../../server/config.js')).loadConfig(), selfHostBillingUnlimited: true };
      routing = await import('../../../server/services/chatRouting.js');
      presence = await import('../../../server/services/widget/operatorPresence.js');
      activity = await import('../../../server/services/widget/operatorActivity.js');
      source = await import('../../../server/services/widget/operatorPresenceSource.js');
      const { operatorActivityRouter } = await import('../../../server/routes/operatorActivity.js');
      const { createSession } = await import('../../../server/services/auth/sessions.js');
      app = express();
      app.use(express.json());
      app.use(cookieParser());
      app.use((req, _res, next) => { Object.assign(req, { serverConfig: config }); next(); });
      app.use('/api/operator-activity', operatorActivityRouter);
      for (const id of [owner, ali, bahar]) tokens[id] = (await createSession(config as never, { userId: id, email: `p-${id.slice(0, 8)}@test.local` })).token;
    }, 120_000);

    beforeEach(async () => {
      await q(`DELETE FROM public.operator_presence_live WHERE workspace_id = $1 AND user_id <> $2`, [ws, early]);
      await q(`DELETE FROM public.conversations WHERE workspace_id = $1`, [ws]);
      activity.resetOperatorActivity();
      source.resetPresenceSourceCache();
      presence.__resetPresenceSourcesProbe();
    });

    it('two tabs, one closed: still connected and still given chats; the last one closed: gone at once, and routing waits', async () => {
      expect((await heartbeat(ali, 'tab-ali-one1')).status).toBe(200);
      expect((await heartbeat(ali, 'tab-ali-two2')).status).toBe(200);
      expect(Object.keys((await lease(ws, ali)).sources as Row).sort()).toEqual(['tab-ali-one1', 'tab-ali-two2']);
      expect(await connected(ali)).toBe(true);

      expect((await beacon(ali, JSON.stringify({ workspace_id: ws, source_id: 'tab-ali-one1' }))).status).toBe(204);
      expect(Object.keys((await lease(ws, ali)).sources as Row)).toEqual(['tab-ali-two2']);
      expect(await connected(ali)).toBe(true);
      const first = await conversation();
      expect(await routing.routeConversationToOperator(config as never, { workspaceId: ws, conversationId: first }))
        .toEqual({ outcome: 'assigned_auto', assignedTo: ali });

      expect((await beacon(ali, JSON.stringify({ workspace_id: ws, source_id: 'tab-ali-two2' }))).status).toBe(204);
      expect(await lease(ws, ali)).toBeUndefined();
      expect(await connected(ali)).toBe(false);
      expect((await presence.readRoutingPresence(config as never, ws, [ali])).get(ali)?.state).toBe('disconnected');
      const second = await conversation();
      expect(await routing.routeConversationToOperator(config as never, { workspaceId: ws, conversationId: second }))
        .toEqual({ outcome: 'no_eligible_agent', assignedTo: null });
    });

    it('the desktop app (beats without an id) keeps them here after their last tab is gone', async () => {
      await heartbeat(bahar);
      await heartbeat(bahar, 'tab-bahar-001');
      expect(Object.keys((await lease(ws, bahar)).sources as Row).sort()).toEqual(['_', 'tab-bahar-001']);
      expect((await beacon(bahar, JSON.stringify({ workspace_id: ws, source_id: 'tab-bahar-001' }))).status).toBe(204);
      expect(await connected(bahar)).toBe(true);
      const cid = await conversation();
      expect((await routing.routeConversationToOperator(config as never, { workspaceId: ws, conversationId: cid })).assignedTo).toBe(bahar);
    });

    it('a tab that comes back (a new id) is here again at once', async () => {
      await heartbeat(ali, 'tab-ali-old1');
      await beacon(ali, JSON.stringify({ workspace_id: ws, source_id: 'tab-ali-old1' }));
      expect(await connected(ali)).toBe(false);
      await heartbeat(ali, 'tab-ali-new1');
      expect(await connected(ali)).toBe(true);
    });

    it('the beacon needs the session, a workspace of theirs and a valid body; it ends only its own tab', async () => {
      await heartbeat(ali, 'tab-ali-keep');
      const body = JSON.stringify({ workspace_id: ws, source_id: 'tab-ali-keep' });
      expect((await beacon(null, body)).status).toBe(401);
      // Another workspace: Ali is no member there.
      expect((await beacon(ali, JSON.stringify({ workspace_id: other, source_id: 'tab-ali-keep' }))).status).toBe(403);
      // A foreign page cannot end it (the Origin check every cookie mutation gets).
      expect((await beacon(ali, body, 'https://evil.example')).status).toBe(403);
      for (const bad of ['not json', JSON.stringify({ workspace_id: ws }), JSON.stringify({ workspace_id: ws, source_id: '_' }), JSON.stringify({ workspace_id: 'x', source_id: 'tab-ali-keep' })]) {
        expect((await beacon(ali, bad)).status, bad).toBe(400);
      }
      // Bahar's beacon with Ali's tab id ends nothing of Ali's.
      expect((await beacon(bahar, body)).status).toBe(204);
      expect(Object.keys((await lease(ws, ali)).sources as Row)).toEqual(['tab-ali-keep']);
      expect(await connected(ali)).toBe(true);
    });
  });
});
