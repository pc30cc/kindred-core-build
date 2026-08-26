/**
 * MANDATORY fresh self-host acceptance test.
 *
 * A pristine database, migrated through the COMPLETE self-host chain
 * (database/migrations/, including 037/038/039), driven by the REAL
 * Express routers (authSecurityRouter, authEmailRouter, workspacesRouter)
 * over HTTP — no mocked Supabase client. `server/supabase.js`'s
 * getServiceClient is replaced with a thin PostgREST-shaped adapter over a
 * real `pg` connection to the same database (the same technique already
 * established by entitlementFanoutConsumer.pg.test.ts for exercising
 * shipped RPC/table code unmodified against real PostgreSQL, generalized
 * here to cover the wider set of tables/RPCs a full signup->workspace
 * bootstrap touches). The only thing genuinely stubbed is outbound email
 * delivery (services/email) — the verification TOKEN itself, its hash,
 * its atomic redemption RPC, and the REST endpoint that redeems it are
 * all real; only the "send an SMTP message" side effect is intercepted so
 * the test can read the link it would have contained.
 *
 * Proves, end to end: signup creates zero auth.users rows; the account/
 * workspace runtime contract that 039 ported to the self-host chain
 * actually works (provision-account, a second workspace via
 * create_workspace_atomic, GET /account no longer shadowed by
 * GET /:workspaceId); and cross-user isolation holds throughout.
 *
 * Driven by TEST_DATABASE_URL (or the legacy CLEAN_INSTALL_DATABASE_URL) —
 * skipped entirely when no live Postgres is configured.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import { ensureAuthChainInstalled } from './authStubSchema';
import type { PgQueryable } from './pgMigrationChain';

const DSN = process.env.TEST_DATABASE_URL || process.env.CLEAN_INSTALL_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

type PgTestClient = PgQueryable & { connect(): Promise<void>; end(): Promise<void> };

let db: PgTestClient;
let capturedEmails: Array<{ to: string; templateSlug: string; actionUrl: string | null }> = [];

// This flow drives many real signup/login calls in one process from the
// same test-client "IP" — authRateLimiter (5/min/IP, a fixed module-scope
// singleton unrelated to req.serverConfig) would otherwise 429 requests
// that have nothing to do with what this file is testing. Rate-limiting
// policy itself already has its own dedicated coverage elsewhere.
vi.mock('../../../server/middleware/security.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/middleware/security.js')>();
  const passthrough = (_req: unknown, _res: unknown, next: () => void) => next();
  return { ...actual, authRateLimiter: passthrough };
});

vi.mock('../../../server/services/email/index.js', () => ({
  sendEmail: async (_config: unknown, req: any) => {
    capturedEmails.push({ to: req.to, templateSlug: req.templateSlug, actionUrl: req.templateData?.action_url ?? null });
    return { success: true };
  },
}));

/**
 * A thin PostgREST-shaped adapter over a real `pg` connection — enough of
 * the supabase-js query-builder surface for the routes exercised by this
 * flow (select/eq/neq/is/in/order/limit/insert/update/maybeSingle/single),
 * plus `.rpc()` for the three functions this flow calls. Everything below
 * translates directly into parameterized SQL against the SAME real
 * database the migrations were just applied to — the shipped route code,
 * RPC bodies, and constraints all run completely unmodified.
 */
function makePgServiceClient(pg: PgTestClient) {
  function from(table: string) {
    const state: {
      cols: string; wheres: string[]; params: unknown[];
      order: string; limitClause: string; patch: Record<string, unknown> | null;
    } = { cols: '*', wheres: [], params: [], order: '', limitClause: '', patch: null };

    function addParam(val: unknown): number {
      state.params.push(val);
      return state.params.length;
    }

    async function runSelect() {
      const where = state.wheres.length ? ` WHERE ${state.wheres.join(' AND ')}` : '';
      const sql = `SELECT ${state.cols} FROM public.${table}${where}${state.order}${state.limitClause}`;
      return pg.query(sql, state.params);
    }
    async function runUpdate() {
      const setCols = Object.keys(state.patch!);
      const setParams = setCols.map((c) => (state.patch as any)[c]);
      const baseLen = setParams.length;
      const setSql = setCols.map((c, i) => `${c} = $${i + 1}`).join(', ');
      const whereShifted = state.wheres.map((w) => w.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + baseLen}`));
      const where = whereShifted.length ? ` WHERE ${whereShifted.join(' AND ')}` : '';
      const sql = `UPDATE public.${table} SET ${setSql}${where} RETURNING *`;
      return pg.query(sql, [...setParams, ...state.params]);
    }
    async function runInsert(rows: Record<string, unknown>[]) {
      const cols = Object.keys(rows[0]);
      const values: string[] = [];
      const params: unknown[] = [];
      for (const row of rows) {
        const placeholders = cols.map((c) => { params.push((row as any)[c]); return `$${params.length}`; });
        values.push(`(${placeholders.join(', ')})`);
      }
      const sql = `INSERT INTO public.${table} (${cols.join(', ')}) VALUES ${values.join(', ')} RETURNING *`;
      return pg.query(sql, params);
    }

    const builder: any = {
      select(cols?: string) { state.cols = cols || '*'; return builder; },
      eq(col: string, val: unknown) { state.wheres.push(`${col} = $${addParam(val)}`); return builder; },
      neq(col: string, val: unknown) { state.wheres.push(`${col} <> $${addParam(val)}`); return builder; },
      is(col: string, val: null) { state.wheres.push(`${col} IS NULL`); void val; return builder; },
      in(col: string, vals: unknown[]) { state.wheres.push(`${col} = ANY($${addParam(vals)})`); return builder; },
      gt(col: string, val: unknown) { state.wheres.push(`${col} > $${addParam(val)}`); return builder; },
      order(col: string, opts?: { ascending?: boolean }) {
        state.order = ` ORDER BY ${col} ${opts?.ascending === false ? 'DESC' : 'ASC'}`;
        return builder;
      },
      limit(n: number) { state.limitClause = ` LIMIT ${Number(n)}`; return builder; },
      insert(payload: Record<string, unknown> | Record<string, unknown>[]) {
        const rows = Array.isArray(payload) ? payload : [payload];
        return {
          select: (cols?: string) => ({
            single: async () => {
              try { const r = await runInsert(rows); state.cols = cols || '*'; return { data: r.rows[0] ?? null, error: null }; }
              catch (e: any) { return { data: null, error: { message: e.message, code: e.code } }; }
            },
          }),
          then: (resolve: any) => runInsert(rows)
            .then((r) => resolve({ data: r.rows, error: null }))
            .catch((e: any) => resolve({ data: null, error: { message: e.message, code: e.code } })),
        };
      },
      update(patch: Record<string, unknown>) {
        state.patch = patch;
        return builder;
      },
      maybeSingle: async () => {
        try { const r = await runSelect(); return { data: r.rows[0] ?? null, error: null }; }
        catch (e: any) { return { data: null, error: { message: e.message } }; }
      },
      single: async () => {
        try {
          const r = state.patch ? await runUpdate() : await runSelect();
          if (!r.rows[0]) return { data: null, error: { message: 'no rows' } };
          return { data: r.rows[0], error: null };
        } catch (e: any) { return { data: null, error: { message: e.message } }; }
      },
      then(resolve: any, reject: any) {
        const p = state.patch ? runUpdate() : runSelect();
        return p
          .then((r: any) => resolve({ data: r.rows, error: null }))
          .catch((e: any) => resolve({ data: null, error: { message: e.message, code: e.code } }));
      },
    };
    return builder;
  }

  async function rpc(name: string, args: Record<string, unknown>) {
    try {
      if (name === 'redeem_email_verify_token') {
        const r = await pg.query(`SELECT * FROM public.redeem_email_verify_token($1)`, [args._token_hash]);
        return { data: r.rows, error: null };
      }
      if (name === 'redeem_password_reset_token') {
        const r = await pg.query(`SELECT * FROM public.redeem_password_reset_token($1, $2)`, [args._token_hash, args._new_password_hash]);
        return { data: r.rows, error: null };
      }
      if (name === 'provision_account_on_signup') {
        await pg.query(`SELECT public.provision_account_on_signup($1)`, [args._user_id]);
        return { data: null, error: null };
      }
      if (name === 'create_workspace_atomic') {
        const r = await pg.query(
          `SELECT public.create_workspace_atomic($1, $2, $3, $4) AS result`,
          [args._account_id, args._name, args._slug, args._user_id],
        );
        return { data: r.rows[0].result, error: null };
      }
      if (name === 'is_workspace_member') {
        const r = await pg.query(`SELECT public.is_workspace_member($1, $2) AS result`, [args._workspace_id, args._user_id]);
        return { data: r.rows[0].result, error: null };
      }
      return { data: null, error: { message: `unhandled rpc in test adapter: ${name}` } };
    } catch (e: any) {
      return { data: null, error: { message: e.message, code: e.code } };
    }
  }

  return { from, rpc };
}

vi.mock('../../../server/supabase.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/supabase.js')>();
  return { ...actual, getServiceClient: () => makePgServiceClient(db) };
});

const { authSecurityRouter } = await import('../../../server/routes/auth.js');
const { authEmailRouter } = await import('../../../server/routes/auth-email.js');
const { workspacesRouter } = await import('../../../server/routes/workspaces.js');

const app = express();
app.use((req, _res, next) => {
  (req as any).serverConfig = {
    supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: ['*'],
    port: 0, supabaseAnonKey: 'k', rateLimitWindowMs: 60000, rateLimitMax: 10000,
  };
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use('/api/auth', authSecurityRouter);
app.use('/api/auth-email', authEmailRouter);
app.use('/api/workspaces', workspacesRouter);

let server: http.Server;
let baseUrl: string;

function call(method: string, path: string, opts: { body?: unknown; cookie?: string } = {}): Promise<{ status: number; json: any; setCookie: string[] }> {
  const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}${path}`,
      {
        method,
        headers: {
          ...(opts.cookie ? { cookie: opts.cookie } : {}),
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          let json: any = {};
          try { json = JSON.parse(d || '{}'); } catch { json = { raw: d }; }
          resolve({ status: res.statusCode || 0, json, setCookie: (res.headers['set-cookie'] as string[]) || [] });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function extractTokenFromUrl(url: string): string {
  return new URL(url).searchParams.get('token')!;
}

async function signupAndVerify(email: string, password: string): Promise<{ cookie: string }> {
  const signupRes = await call('POST', '/api/auth/signup', { body: { email, password, fullName: 'Acceptance User' } });
  expect(signupRes.status).toBe(200);

  const sent = capturedEmails.find((e) => e.templateSlug === 'email_verify' && e.actionUrl);
  const token = extractTokenFromUrl(sent!.actionUrl!);
  const verifyRes = await call('POST', '/api/auth-email/verify-email', { body: { token } });
  expect(verifyRes.status).toBe(200);

  const loginRes = await call('POST', '/api/auth/login', { body: { email, password } });
  expect(loginRes.status).toBe(200);
  const cookieHeader = loginRes.setCookie.find((c) => c.startsWith('gs_session='));
  const cookie = cookieHeader!.split(';')[0];
  return { cookie };
}

suite('Fresh self-host acceptance: signup -> verify -> session -> workspace bootstrap', () => {
  beforeAll(async () => {
    // A Pool, not a single Client: makePgServiceClient's adapter is called
    // concurrently within a single request (e.g. issueVerificationEmail's
    // own Promise.all of independent lookups), which a single Client
    // connection cannot safely pipeline. A Pool hands out a free
    // connection per query, which is safe for both this concurrent
    // request-handling use and the sequential migration-application use
    // below.
    const { Pool } = await import('pg');
    db = new Pool({ connectionString: DSN, max: 10 }) as unknown as PgTestClient;
    // A genuinely PRISTINE install: wipe the shared database's public/auth
    // schemas so the complete chain is proven from zero, not against
    // whatever earlier .pg.test.ts files left behind.
    await db.query(`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS auth CASCADE; CREATE SCHEMA public;`);
    await ensureAuthChainInstalled(db);
  }, 120_000);

  afterAll(async () => {
    if (db) {
      // Restore a normal installed state for whatever pg test file runs
      // next in this shared-database CI job.
      await db.query(`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS auth CASCADE; CREATE SCHEMA public;`);
      await ensureAuthChainInstalled(db);
      await db.end();
    }
    if (server) server.close();
  });

  beforeAll(async () => {
    server = http.createServer(app).listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  });

  it('1. POST /api/auth/signup creates profile + user_credentials with ZERO auth.users rows required', async () => {
    const before = await db.query(`SELECT count(*)::int AS n FROM auth.users`);

    const res = await call('POST', '/api/auth/signup', {
      body: { email: 'owner@acceptance.example.com', password: 'CorrectHorseBattery1', fullName: 'Owner User' },
    });
    expect(res.status).toBe(200);

    const profile = await db.query(`SELECT email FROM public.profiles WHERE email = 'owner@acceptance.example.com'`);
    expect(profile.rowCount).toBe(1);
    const cred = await db.query(`SELECT password_hash FROM public.user_credentials WHERE user_id = (SELECT id FROM public.profiles WHERE email = 'owner@acceptance.example.com')`);
    expect(cred.rows[0].password_hash).toBeTruthy();

    const after = await db.query(`SELECT count(*)::int AS n FROM auth.users`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('2-4. verify email, login, and establish a real gs_session', async () => {
    capturedEmails = [];
    const { cookie } = await signupAndVerify('flow@acceptance.example.com', 'CorrectHorseBattery1');
    expect(cookie).toMatch(/^gs_session=/);

    const verified = await db.query(`SELECT email_verified_at FROM public.user_credentials uc JOIN public.profiles p ON p.id = uc.user_id WHERE p.email = 'flow@acceptance.example.com'`);
    expect(verified.rows[0].email_verified_at).not.toBeNull();

    const sessionRow = await db.query(`SELECT 1 FROM public.auth_sessions s JOIN public.profiles p ON p.id = s.user_id WHERE p.email = 'flow@acceptance.example.com' AND s.revoked_at IS NULL`);
    expect(sessionRow.rowCount).toBe(1);
  });

  it('5. GET /api/workspaces -> [] for a brand-new user', async () => {
    capturedEmails = [];
    const { cookie } = await signupAndVerify('empty@acceptance.example.com', 'CorrectHorseBattery1');
    const res = await call('GET', '/api/workspaces', { cookie });
    expect(res.status).toBe(200);
    expect(res.json.workspaces).toEqual([]);
  });

  it('6. GET /api/workspaces/account reaches the intended static route (no shadowing) — 404 before provisioning', async () => {
    capturedEmails = [];
    const { cookie } = await signupAndVerify('noaccount@acceptance.example.com', 'CorrectHorseBattery1');
    const res = await call('GET', '/api/workspaces/account', { cookie });
    // Reaches the REAL account handler (proven by the response shape: a
    // clean 404 "No account found", not a 400 "Invalid workspaceId" from
    // authorizeWorkspaceAccess, which is what the pre-fix shadowing bug
    // would have produced for workspaceId="account").
    expect(res.status).toBe(404);
    expect(res.json.error).toBe('No account found');
  });

  it('7. POST /api/workspaces/provision-account succeeds: account, owner membership, workspace, and owner workspace membership all exist', async () => {
    capturedEmails = [];
    const { cookie } = await signupAndVerify('provision@acceptance.example.com', 'CorrectHorseBattery1');

    const res = await call('POST', '/api/workspaces/provision-account', { cookie });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);

    const userId = (await db.query(`SELECT id FROM public.profiles WHERE email = 'provision@acceptance.example.com'`)).rows[0].id;

    const account = await db.query(`SELECT id FROM public.accounts WHERE owner_id = $1`, [userId]);
    expect(account.rowCount).toBe(1);
    const accountId = account.rows[0].id;

    const accountMember = await db.query(`SELECT role FROM public.account_members WHERE account_id = $1 AND user_id = $2`, [accountId, userId]);
    expect(accountMember.rows[0]?.role).toBe('owner');

    const workspace = await db.query(`SELECT id FROM public.workspaces WHERE account_id = $1`, [accountId]);
    expect(workspace.rowCount).toBe(1);
    const workspaceId = workspace.rows[0].id;

    const workspaceMember = await db.query(`SELECT role FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, userId]);
    expect(workspaceMember.rows[0]?.role).toBe('owner');

    // 8. GET /api/workspaces/account now returns the newly provisioned account
    const accountRes = await call('GET', '/api/workspaces/account', { cookie });
    expect(accountRes.status).toBe(200);
    expect(accountRes.json.account.id).toBe(accountId);

    // 7 (cont). GET /api/workspaces returns the newly provisioned workspace
    const wsRes = await call('GET', '/api/workspaces', { cookie });
    expect(wsRes.status).toBe(200);
    expect(wsRes.json.workspaces.map((w: any) => w.id)).toEqual([workspaceId]);

    // 9. POST /api/workspaces creates a SECOND workspace via create_workspace_atomic
    const secondRes = await call('POST', '/api/workspaces', {
      cookie,
      body: { accountId, name: 'Second Workspace' },
    });
    expect(secondRes.status).toBe(200);
    expect(secondRes.json.workspaceId).toBeTruthy();

    const wsAfterSecond = await call('GET', '/api/workspaces', { cookie });
    expect(wsAfterSecond.json.workspaces).toHaveLength(2);
  });

  it('10. another user cannot access or create inside the first user\'s account', async () => {
    capturedEmails = [];
    const owner = await signupAndVerify('isolation-owner@acceptance.example.com', 'CorrectHorseBattery1');
    await call('POST', '/api/workspaces/provision-account', { cookie: owner.cookie });

    const ownerId = (await db.query(`SELECT id FROM public.profiles WHERE email = 'isolation-owner@acceptance.example.com'`)).rows[0].id;
    const ownerAccountId = (await db.query(`SELECT id FROM public.accounts WHERE owner_id = $1`, [ownerId])).rows[0].id;

    capturedEmails = [];
    const stranger = await signupAndVerify('isolation-stranger@acceptance.example.com', 'CorrectHorseBattery1');

    // Cannot see the owner's workspace via GET /api/workspaces.
    const wsRes = await call('GET', '/api/workspaces', { cookie: stranger.cookie });
    expect(wsRes.json.workspaces).toEqual([]);

    // Cannot see the owner's account via GET /api/workspaces/account.
    const accRes = await call('GET', '/api/workspaces/account', { cookie: stranger.cookie });
    expect(accRes.status).toBe(404);

    // Cannot create a workspace inside the owner's account —
    // create_workspace_atomic's own is_account_member check rejects it.
    const createRes = await call('POST', '/api/workspaces', {
      cookie: stranger.cookie,
      body: { accountId: ownerAccountId, name: 'Hostile Workspace' },
    });
    expect(createRes.status).toBe(400);
    expect(createRes.json.error).toMatch(/not an account member/i);

    const workspacesUnderOwnerAccount = await db.query(`SELECT count(*)::int AS n FROM public.workspaces WHERE account_id = $1`, [ownerAccountId]);
    expect(workspacesUnderOwnerAccount.rows[0].n).toBe(1); // still just the owner's own
  });
});
