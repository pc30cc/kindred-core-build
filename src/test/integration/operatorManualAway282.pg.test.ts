// @vitest-environment node
/**
 * 282 — an operator's own "Away from desk" (R-26), on a real database built
 * by the whole chain:
 *
 *   M  before 282 the column is not there; a dry run (BEGIN … ROLLBACK)
 *      leaves no trace; applied, every existing row reads false (what it
 *      meant before), a new row starts on false, NOT NULL; a second run
 *      changes nothing.
 *   R  the real PATCH /api/availability stores it; then, with the real
 *      presence reading (the live connection is a fake: everyone is
 *      connected, and interacting):
 *      - an away operator gets no new chat — not as the visitor's previous
 *        operator, not from the team — and the chat goes to a colleague;
 *      - nobody but away operators: the chat waits, and the owner fallback
 *        does not take an away owner either; an owner who is here does take
 *        it;
 *      - the widget is not "online" because of an away operator;
 *      - an away operator keeps the conversation they hold when the visitor
 *        writes again;
 *      - Online from the menu (or force_offline from an older app) brings
 *        them back into routing.
 *
 * Driven by TEST_DATABASE_URL; skipped without it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import pg from 'pg';
import { applyMigrationSql } from './pgMigrationChain';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

const DB = `operator_manual_away_282_${Date.now()}`;
const DIR = resolve(process.cwd(), 'database/migrations');
const FILE = '282_operator_manual_away.sql';
const SQL = () => readFileSync(resolve(DIR, FILE), 'utf8');

type Row = Record<string, unknown>;

vi.mock('../../../server/services/widget/operatorPresenceSource.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/operatorPresenceSource.js')>()),
  // Everyone has a panel open.
  getConnectedOperators: async (_c: unknown, _ws: string, ids: string[]) => ({ mode: 'realtime', connected: new Set(ids), lastSeen: new Map(), degraded: false }),
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
vi.mock('../../../server/lib/cacheBus.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/lib/cacheBus.js')>()),
  publishCacheInvalidation: () => undefined,
}));

suite('282 — "Away from desk" (real PostgreSQL, whole chain)', () => {
  let admin: pg.Client;
  let db: pg.Client;
  let url: string;
  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows as Row[];
  const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];
  const column = async () => (await q(`SELECT data_type, is_nullable, column_default FROM information_schema.columns
                                         WHERE table_schema = 'public' AND table_name = 'user_availability_prefs' AND column_name = 'manual_away'`))[0];

  const owner = randomUUID();
  const ali = randomUUID();
  const bahar = randomUUID();
  const ws = randomUUID();
  const earlyRow = randomUUID();

  let config: ReturnType<typeof import('../../../server/config.js')['loadConfig']>;
  let routing: typeof import('../../../server/services/chatRouting.js');
  let availability: typeof import('../../../server/services/widget/customerAvailability.js');
  let activity: typeof import('../../../server/services/widget/operatorActivity.js');
  let resetCaches: () => void;
  let app: express.Express;
  const tokens: Record<string, string> = {};

  const contact = async () => String((await one(`INSERT INTO public.contacts (workspace_id, name) VALUES ($1, 'Visitor') RETURNING id`, [ws])).id);
  const conversation = async (fields: { status?: string; assigned?: string | null; contact?: string | null; updatedAgo?: string } = {}) => {
    const id = randomUUID();
    await q(`INSERT INTO public.conversations (id, workspace_id, status, assigned_to, contact_id, updated_at)
             VALUES ($1, $2, $3::conversation_status, $4, $5, now() - $6::interval)`,
    [id, ws, fields.status ?? 'open', fields.assigned ?? null, fields.contact ?? null, fields.updatedAgo ?? '0 seconds']);
    return id;
  };
  const assignee = async (cid: string) => (await one(`SELECT assigned_to FROM public.conversations WHERE id = $1`, [cid])).assigned_to;
  const setStatus = async (user: string, body: Row) => {
    const res = await request(app).patch('/api/availability').set({ Authorization: `Bearer ${tokens[user]}` }).send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { prefs: Row; status: Row };
  };
  const away = (user: string) => setStatus(user, { force_offline: false, available_when_using_app: true, manual_away: true });
  const online = (user: string) => setStatus(user, { force_offline: false, available_when_using_app: true, manual_away: false });

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
    for (const [id, name] of [[owner, 'Owner'], [ali, 'Ali'], [bahar, 'Bahar'], [earlyRow, 'Early']]) {
      await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, $3)`, [id, `p-${id.slice(0, 8)}@test.local`, name]);
    }
    // A prefs row written before 282 (offline by hand).
    await q(`INSERT INTO public.user_availability_prefs (user_id, workspace_id, force_offline) VALUES ($1, NULL, true)`, [earlyRow]);
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
    it('before 282 the column is not there; a dry run leaves no trace', async () => {
      expect(await column()).toBeUndefined();
      await db.query('BEGIN');
      try {
        await db.query(SQL());
        expect(await column()).toBeDefined();
      } finally {
        await db.query('ROLLBACK');
      }
      expect(await column()).toBeUndefined();
    });

    it('applies: boolean NOT NULL DEFAULT false; an existing row reads false and keeps the rest', async () => {
      await applyMigrationSql(db, SQL());
      expect(await column()).toEqual({ data_type: 'boolean', is_nullable: 'NO', column_default: 'false' });
      expect(await one(`SELECT force_offline, manual_away FROM public.user_availability_prefs WHERE user_id = $1`, [earlyRow]))
        .toEqual({ force_offline: true, manual_away: false });
      // The rest of the chain, for the routing below.
      for (const file of readdirSync(DIR).filter((f) => f.endsWith('.sql') && f > FILE).sort()) {
        await applyMigrationSql(db, readFileSync(resolve(DIR, file), 'utf8'));
      }
    });

    it('re-runnable: a second run changes nothing', async () => {
      const before = await q(`SELECT * FROM public.user_availability_prefs ORDER BY id`);
      await applyMigrationSql(db, SQL());
      expect(await q(`SELECT * FROM public.user_availability_prefs ORDER BY id`)).toEqual(before);
      expect(await column()).toEqual({ data_type: 'boolean', is_nullable: 'NO', column_default: 'false' });
    });
  });

  describe('R routing, the widget and the held chats', () => {
    beforeAll(async () => {
      await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [ws, `ws-${ws.slice(0, 8)}`, owner]);
      await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'agent'), ($1, $4, 'support_agent')
               ON CONFLICT DO NOTHING`, [ws, owner, ali, bahar]);
      await q(`INSERT INTO public.widget_settings (workspace_id, enabled, assignment_mode, first_response_timeout_minutes) VALUES ($1, true, 'auto', 0)`, [ws]);
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
      routing = await import('../../../server/services/chatRouting.js');
      availability = await import('../../../server/services/widget/customerAvailability.js');
      activity = await import('../../../server/services/widget/operatorActivity.js');
      const departments = await import('../../../server/services/calls/departments.js');
      const global = await import('../../../server/services/calls/globalAdvancedRouting.js');
      resetCaches = () => {
        departments.invalidateDepartmentCache(ws);
        global.__resetGlobalAdvancedRoutingCache();
      };
      const { availabilityRouter } = await import('../../../server/routes/availability.js');
      const { createSession } = await import('../../../server/services/auth/sessions.js');
      app = express();
      app.use(express.json());
      app.use((req, _res, next) => { Object.assign(req, { serverConfig: config }); next(); });
      app.use('/api/availability', availabilityRouter);
      for (const id of [owner, ali, bahar]) tokens[id] = (await createSession(config as never, { userId: id, email: `p-${id.slice(0, 8)}@test.local` })).token;
    }, 120_000);

    beforeEach(async () => {
      await q(`DELETE FROM public.conversations WHERE workspace_id = $1`, [ws]);
      await q(`DELETE FROM public.user_availability_prefs WHERE user_id = ANY($1::uuid[])`, [[owner, ali, bahar]]);
      activity.resetOperatorActivity();
      // Everyone is interacting right now (the active tier).
      for (const id of [owner, ali, bahar]) activity.recordOperatorActivity(ws, id, Date.now());
      resetCaches();
    });

    it('PATCH stores it; the widget is not "online" because of an away operator', async () => {
      const res = await away(ali);
      expect(res.prefs.manual_away).toBe(true);
      expect(res.status).toEqual({ state: 'offline', reason: 'manual_away' });
      expect(await one(`SELECT manual_away FROM public.user_availability_prefs WHERE user_id = $1 AND workspace_id IS NULL`, [ali])).toEqual({ manual_away: true });
      await away(bahar);
      await away(owner);
      expect(await availability.anyCustomerAvailableOperator(config as never, ws)).toEqual({ anyAvailable: false, memberCount: 3 });
      await online(bahar);
      expect((await availability.listCustomerAvailableOperators(config as never, ws)).available.map((r) => r.user_id)).toEqual([bahar]);
    });

    it('the returning visitor\'s operator is away: the chat goes to a colleague, not back to them', async () => {
      const who = await contact();
      await conversation({ contact: who, status: 'resolved', assigned: ali, updatedAgo: '2 days' });
      // Without the away, Ali gets them back.
      const before = await conversation({ contact: who });
      expect(await routing.routeConversationToOperator(config as never, { workspaceId: ws, conversationId: before }))
        .toEqual({ outcome: 'assigned_last_agent', assignedTo: ali });
      await q(`UPDATE public.conversations SET status = 'resolved' WHERE id = $1`, [before]);
      await away(ali);
      await away(owner);
      const cid = await conversation({ contact: who });
      expect(await routing.routeConversationToOperator(config as never, { workspaceId: ws, conversationId: cid }))
        .toEqual({ outcome: 'assigned_auto', assignedTo: bahar });
    });

    it('only away operators: the chat waits; whoever comes back gets it', async () => {
      await away(ali);
      await away(bahar);
      await away(owner);
      const cid = await conversation({ contact: await contact() });
      expect(await routing.routeConversationToOperator(config as never, { workspaceId: ws, conversationId: cid }))
        .toEqual({ outcome: 'no_eligible_agent', assignedTo: null });
      expect(await assignee(cid)).toBeNull();
      await online(bahar);
      expect(await routing.routeConversationToOperator(config as never, { workspaceId: ws, conversationId: cid }))
        .toEqual({ outcome: 'assigned_auto', assignedTo: bahar });
    });

    it('the owner fallback does not take an away owner; an owner who is here does', async () => {
      // Sales is Ali alone, and the Super Admin turned the general pool off:
      // only the owner fallback is left once Ali is away.
      const dept = String((await one(`INSERT INTO public.workspace_departments (workspace_id, name) VALUES ($1, 'Sales') RETURNING id`, [ws])).id);
      await q(`INSERT INTO public.workspace_department_members (workspace_id, department_id, user_id) VALUES ($1, $2, $3)`, [ws, dept, ali]);
      await q(`INSERT INTO public.app_runtime_config (key, value) VALUES ('global_advanced_routing', '{"general_pool_enabled": false}')
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
      try {
        resetCaches();
        await away(ali);
        await away(owner);
        const cid = randomUUID();
        await q(`INSERT INTO public.conversations (id, workspace_id, status, metadata) VALUES ($1, $2, 'open', $3::jsonb)`, [cid, ws, JSON.stringify({ department_id: dept })]);
        expect(await routing.routeConversationToOperator(config as never, { workspaceId: ws, conversationId: cid }))
          .toEqual({ outcome: 'no_eligible_agent', assignedTo: null });
        await online(owner);
        expect(await routing.routeConversationToOperator(config as never, { workspaceId: ws, conversationId: cid }))
          .toEqual({ outcome: 'assigned_owner_fallback', assignedTo: owner });
      } finally {
        await q(`DELETE FROM public.app_runtime_config WHERE key = 'global_advanced_routing'`);
        await q(`DELETE FROM public.workspace_department_members WHERE workspace_id = $1`, [ws]);
        await q(`DELETE FROM public.workspace_departments WHERE workspace_id = $1`, [ws]);
      }
    });

    it('an away operator keeps the conversation they hold when the visitor writes again', async () => {
      const held = await conversation({ contact: await contact(), assigned: ali });
      await away(ali);
      expect(await routing.routeHumanBoundConversation(config as never, { workspaceId: ws, conversationId: held, platformAiOff: true })).toBeNull();
      expect(await assignee(held)).toBe(ali);
    });

    it('Online from the menu, or force_offline from an older app, brings them back into routing', async () => {
      await away(ali);
      await away(owner);
      await setStatus(bahar, { force_offline: true });
      const cid = await conversation({ contact: await contact() });
      expect((await routing.routeConversationToOperator(config as never, { workspaceId: ws, conversationId: cid })).outcome).toBe('no_eligible_agent');
      // An app that only knows force_offline switches Ali online: the away ends.
      const res = await setStatus(ali, { force_offline: false });
      expect(res.prefs.manual_away).toBe(false);
      expect(await routing.routeConversationToOperator(config as never, { workspaceId: ws, conversationId: cid }))
        .toEqual({ outcome: 'assigned_auto', assignedTo: ali });
    });
  });
});
