// @vitest-environment node
/**
 * The backend ahead of its migrations (RESPOK's backend may start before its
 * migrator; WebYar's files are applied by hand): against a database built by
 * the chain up to 277 — no workspace_members.receives_chats /
 * max_concurrent_chats (278), no widget_settings routing columns (278), no
 * chat_route_claim (278), no user_availability_prefs.manual_away (282) —
 * the code that reads them falls back instead of failing or reading empty:
 *
 *   - the chat and call pools find the members (everyone receives chats);
 *   - GET /api/workspace-members answers 200, every member receiving chats
 *     at the default maximum;
 *   - the widget's online/offline and routing presence read the members'
 *     availability (Appear offline still counts);
 *   - PATCH /api/availability saves Online / Appear offline (200);
 *   - routing reads the stored mode, and a run without the 278 functions
 *     waits without throwing.
 *
 * Its own database (CREATE DATABASE on the TEST_DATABASE_URL server).
 * Skipped without TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import pg from 'pg';
import { applyMigrationSql } from './pgMigrationChain';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

const DB = `before_migration_278_${Date.now()}`;
const DIR = resolve(process.cwd(), 'database/migrations');

type Row = Record<string, unknown>;

suite('the backend before migrations 278 and 282 (real PostgreSQL, the chain up to 277)', () => {
  let admin: pg.Client;
  let db: pg.Client;
  let url = '';
  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).rows as Row[];
  const owner = randomUUID();
  const ali = randomUUID();
  const bahar = randomUUID();
  const ws = randomUUID();
  let config: ReturnType<typeof import('../../../server/config.js')['loadConfig']>;
  let app: express.Express;
  const tokens: Record<string, string> = {};

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
    for (const file of readdirSync(DIR).filter((f) => f.endsWith('.sql') && f < '278').sort()) {
      await applyMigrationSql(db, readFileSync(resolve(DIR, file), 'utf8'));
    }
    for (const [id, name] of [[owner, 'Owner'], [ali, 'Ali'], [bahar, 'Bahar']]) {
      await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, $3)`, [id, `p-${id.slice(0, 8)}@test.local`, name]);
    }
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [ws, `ws-${ws.slice(0, 8)}`, owner]);
    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'agent'), ($1, $4, 'support_agent')
             ON CONFLICT DO NOTHING`, [ws, owner, ali, bahar]);
    await q(`INSERT INTO public.widget_settings (workspace_id, enabled, assignment_mode) VALUES ($1, true, 'manual')`, [ws]);
    // Bahar chose "Appear offline".
    await q(`INSERT INTO public.user_availability_prefs (user_id, workspace_id, force_offline) VALUES ($1, NULL, true)`, [bahar]);

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
    const { workspaceMembersRouter } = await import('../../../server/routes/workspaceMembers.js');
    const { availabilityRouter } = await import('../../../server/routes/availability.js');
    const { createSession } = await import('../../../server/services/auth/sessions.js');
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { Object.assign(req, { serverConfig: config }); next(); });
    app.use('/api/workspace-members', workspaceMembersRouter);
    app.use('/api/availability', availabilityRouter);
    for (const id of [owner, ali]) tokens[id] = (await createSession(config as never, { userId: id, email: `p-${id.slice(0, 8)}@test.local` })).token;
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

  it('the database really is before 278 and 282', async () => {
    const cols = (await q(`SELECT table_name, column_name FROM information_schema.columns
                            WHERE table_schema = 'public' AND column_name IN ('receives_chats', 'max_concurrent_chats', 'manual_away', 'last_agent_routing_enabled')`));
    expect(cols).toEqual([]);
    expect((await q(`SELECT to_regproc('public.chat_route_claim') AS f`))[0].f).toBeNull();
  });

  it('the chat and call pools find the members (everyone receives chats)', async () => {
    const departments = await import('../../../server/services/calls/departments.js');
    departments.invalidateDepartmentCache(ws);
    expect(new Set((await departments.resolveChatRoutingPool(config, ws, null)).team)).toEqual(new Set([owner, ali, bahar]));
    expect(new Set(await departments.resolveGeneralPool(config, ws))).toEqual(new Set([owner, ali, bahar]));
    expect(await departments.resolveChatRoutingMember(config, ws, ali)).toEqual({ role: 'agent', suspended: false, receivesChats: true });
  });

  it('GET /api/workspace-members answers, every member receiving chats at the default maximum', async () => {
    const res = await request(app).get(`/api/workspace-members?workspaceId=${ws}`).set({ Authorization: `Bearer ${tokens[owner]}` });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.members).toHaveLength(3);
    for (const m of res.body.members) expect(m).toMatchObject({ receives_chats: true, max_concurrent_chats: null });
  });

  it('the widget\'s online/offline and routing presence read the availability (Appear offline still counts)', async () => {
    const { loadWorkspaceAvailabilityPrefs, listCustomerAvailableOperators } = await import('../../../server/services/widget/customerAvailability.js');
    const prefs = await loadWorkspaceAvailabilityPrefs(config, ws);
    expect(new Set(prefs.chatMemberIds)).toEqual(new Set([owner, ali, bahar]));
    expect(prefs.prefsByUser.get(bahar)).toMatchObject({ force_offline: true });
    const { available } = await listCustomerAvailableOperators(config, ws, new Date(), prefs);
    expect(available.map((a) => a.user_id)).not.toContain(bahar);
    const { readRoutingPresence } = await import('../../../server/services/widget/operatorPresence.js');
    expect((await readRoutingPresence(config, ws, [bahar])).get(bahar)?.state).toBe('offline');
  });

  it('PATCH /api/availability saves Online / Appear offline', async () => {
    const res = await request(app).patch('/api/availability').set({ Authorization: `Bearer ${tokens[ali]}` }).send({ force_offline: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await q(`SELECT force_offline FROM public.user_availability_prefs WHERE user_id = $1 AND workspace_id IS NULL`, [ali]))[0])
      .toEqual({ force_offline: true });
    const back = await request(app).patch('/api/availability').set({ Authorization: `Bearer ${tokens[ali]}` }).send({ force_offline: false });
    expect(back.status).toBe(200);
  });

  it('routing reads the stored mode; without the 278 functions a run waits, never throws', async () => {
    const routing = await import('../../../server/services/chatRouting.js');
    expect((await routing.loadRoutingSettings(config, ws)).mode).toBe('manual');
    await q(`UPDATE public.widget_settings SET assignment_mode = 'auto' WHERE workspace_id = $1`, [ws]);
    const cid = randomUUID();
    await q(`INSERT INTO public.conversations (id, workspace_id, status) VALUES ($1, $2, 'open')`, [cid, ws]);
    // Nobody is connected here, so it waits (chat_routing_wait is not there
    // either: nothing recorded, nothing thrown).
    expect(await routing.routeConversationToOperator(config, { workspaceId: ws, conversationId: cid }))
      .toEqual({ outcome: 'no_eligible_agent', assignedTo: null });
    expect((await q(`SELECT assigned_to FROM public.conversations WHERE id = $1`, [cid]))[0].assigned_to).toBeNull();
  });
});
