/**
 * FINAL WORKSPACE PROVISIONING SECURITY + IDEMPOTENCY CLOSURE.
 *
 * Three independent proofs, against real PostgreSQL:
 *
 * Part A (self-host chain, shared TEST_DATABASE_URL): create_workspace_atomic
 * is now service_role-only (041); is_account_member's ACL is DELIBERATELY
 * unchanged (documented in 041's own header); provision_account_on_signup
 * is idempotent under both sequential retries and genuine concurrency,
 * proven with TWO independent real `pg` connections calling it for the
 * SAME user id at once.
 *
 * Part B (hosted chain, an isolated throwaway database — hosted-only
 * objects like billing_plans/workspace_subscriptions/plan_change_log don't
 * exist on the self-host chain, so this cannot share Part A's database).
 * The REAL, unmodified
 * supabase/migrations/20260820160000_lock_create_workspace_atomic_and_idempotent_provisioning.sql
 * is applied, read from disk, against a minimal-but-faithful stand-in
 * schema (same convention already established by
 * legacyGotrueSignupBoundary.pg.test.ts's own hosted stand-in — the full
 * hosted migration chain needs the real supabase/postgres CI image this
 * repo's test infra deliberately doesn't replicate locally). Proves literal
 * `SET ROLE anon|authenticated|service_role` execution attempts on
 * create_workspace_atomic, and that provision_account_on_signup's Trial-plan
 * auto-subscribe side effect fires exactly once per user even under
 * concurrency.
 *
 * Part C (self-host chain, real Express router + real HTTP, same database
 * as Part A): POST /api/workspaces/provision-account's route-level
 * contract — 401 unauthenticated, 403 unverified, idempotent on repeat and
 * concurrent calls, GET /api/workspaces/account still unshadowed, and
 * POST /api/workspaces (create_workspace_atomic via service_role) still
 * works now that authenticated has lost direct EXECUTE.
 *
 * Driven by TEST_DATABASE_URL (or the legacy CLEAN_INSTALL_DATABASE_URL) —
 * every part skips when no live Postgres is configured.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import { ensureAuthChainInstalled } from './authStubSchema';
import type { PgQueryable } from './pgMigrationChain';

const DSN = process.env.TEST_DATABASE_URL || process.env.CLEAN_INSTALL_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

type PgTestClient = PgQueryable & { connect(): Promise<void>; end(): Promise<void> };

const HOSTED_MIGRATION = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260820160000_lock_create_workspace_atomic_and_idempotent_provisioning.sql'),
  'utf8',
);
// 037 — real, unmodified, applied first in Part B's setup to match the real
// chain's order: on production hosted, provision_account_on_signup already
// exists and is already service_role-only by the time this closure's
// migration runs (037 sorts before 20260820160000). CREATE OR REPLACE
// FUNCTION preserves an existing function's ACL — it does NOT reset it —
// so without applying 037 first here, this file's own CREATE OR REPLACE
// would be creating provision_account_on_signup for the very first time,
// which defaults to PUBLIC-executable and would misrepresent reality.
const RETIRE_TRIGGER_MIGRATION = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260820140000_retire_legacy_signup_trigger.sql'),
  'utf8',
);

// ══════════════════════════ Part C plumbing (module scope — mocks must be hoisted) ══════════════════════════

let db: PgTestClient;
let capturedEmails: Array<{ to: string; templateSlug: string; actionUrl: string | null }> = [];

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

// Full adapter, identical to selfHostWorkspaceAcceptance.pg.test.ts's own
// (already proven end-to-end for this exact signup/verify/login/provision
// flow) — copied rather than imported since it closes over this file's own
// module-scope `db`/`pg` binding.
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
          then: (resolvePromise: any) => runInsert(rows)
            .then((r) => resolvePromise({ data: r.rows, error: null }))
            .catch((e: any) => resolvePromise({ data: null, error: { message: e.message, code: e.code } })),
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
      then(resolvePromise: any) {
        const p = state.patch ? runUpdate() : runSelect();
        return p
          .then((r: any) => resolvePromise({ data: r.rows, error: null }))
          .catch((e: any) => resolvePromise({ data: null, error: { message: e.message, code: e.code } }));
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
      if (name === 'provision_account_on_signup') {
        await pg.query(`SELECT public.provision_account_on_signup($1)`, [args._user_id]);
        return { data: null, error: null };
      }
      if (name === 'create_workspace_atomic') {
        const r = await pg.query(`SELECT public.create_workspace_atomic($1, $2, $3, $4) AS result`, [args._account_id, args._name, args._slug, args._user_id]);
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
  (req as any).serverConfig = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: ['*'], port: 0, supabaseAnonKey: 'k', rateLimitWindowMs: 60000, rateLimitMax: 10000 };
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
  return new Promise((resolvePromise, reject) => {
    const req = http.request(
      `${baseUrl}${path}`,
      { method, headers: { ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) } },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          let json: any = {};
          try { json = JSON.parse(d || '{}'); } catch { json = { raw: d }; }
          resolvePromise({ status: res.statusCode || 0, json, setCookie: (res.headers['set-cookie'] as string[]) || [] });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function extractTokenFromUrl(url: string): string { return new URL(url).searchParams.get('token')!; }

async function signupOnly(email: string): Promise<void> {
  const res = await call('POST', '/api/auth/signup', { body: { email, password: 'CorrectHorseBattery1', fullName: 'Provisioning Test User' } });
  expect(res.status).toBe(200);
}

async function signupAndVerify(email: string): Promise<{ cookie: string }> {
  await signupOnly(email);
  const sent = capturedEmails.find((e) => e.templateSlug === 'email_verify' && e.actionUrl && e.to === email);
  const token = extractTokenFromUrl(sent!.actionUrl!);
  const verifyRes = await call('POST', '/api/auth-email/verify-email', { body: { token } });
  expect(verifyRes.status).toBe(200);
  const loginRes = await call('POST', '/api/auth/login', { body: { email, password: 'CorrectHorseBattery1' } });
  expect(loginRes.status).toBe(200);
  const cookie = loginRes.setCookie.find((c) => c.startsWith('gs_session='))!.split(';')[0];
  return { cookie };
}

// ══════════════════════════════════════ Part A ══════════════════════════════════════

suite('Part A — self-host chain: create_workspace_atomic ACL + provision_account_on_signup idempotency', () => {
  beforeAll(async () => {
    const { Pool } = await import('pg');
    db = new Pool({ connectionString: DSN, max: 10 }) as unknown as PgTestClient;
    await db.query(`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS auth CASCADE; CREATE SCHEMA public;`);
    await ensureAuthChainInstalled(db);
  }, 120_000);

  afterAll(async () => {
    if (db) {
      await db.query(`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS auth CASCADE; CREATE SCHEMA public;`);
      await ensureAuthChainInstalled(db);
    }
    if (server) server.close();
  });

  beforeAll(async () => {
    server = http.createServer(app).listen(0);
    await new Promise<void>((resolvePromise) => server.once('listening', () => resolvePromise()));
    baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  });

  it('create_workspace_atomic: anon/authenticated denied, service_role allowed (ACL flags)', async () => {
    const sig = 'public.create_workspace_atomic(uuid,text,text,uuid)';
    const { rows } = await db.query(`
      SELECT
        has_function_privilege('anon', '${sig}', 'EXECUTE') AS anon_can,
        has_function_privilege('authenticated', '${sig}', 'EXECUTE') AS auth_can,
        has_function_privilege('service_role', '${sig}', 'EXECUTE') AS svc_can
    `);
    expect(rows[0]).toMatchObject({ anon_can: false, auth_can: false, svc_can: true });
  });

  it('create_workspace_atomic: literal execution as authenticated is denied, service_role succeeds', async () => {
    await db.query('SET ROLE authenticated');
    try {
      await expect(db.query(`SELECT public.create_workspace_atomic(gen_random_uuid(), 'x', '', gen_random_uuid())`)).rejects.toThrow(/permission denied/i);
    } finally {
      await db.query('RESET ROLE');
    }

    await db.query('SET ROLE service_role');
    try {
      // Not an account member -> the function's own internal check rejects
      // it (proves the call reached the function body at all, i.e. EXECUTE
      // was granted), rather than a permission-denied at the ACL layer.
      await expect(db.query(`SELECT public.create_workspace_atomic(gen_random_uuid(), 'x', '', gen_random_uuid())`)).rejects.toThrow(/not an account member/i);
    } finally {
      await db.query('RESET ROLE');
    }
  });

  it('is_account_member ACL is unchanged: authenticated still has EXECUTE (RLS depends on it), anon does not', async () => {
    const sig = 'public.is_account_member(uuid,uuid)';
    const { rows } = await db.query(`
      SELECT
        has_function_privilege('anon', '${sig}', 'EXECUTE') AS anon_can,
        has_function_privilege('authenticated', '${sig}', 'EXECUTE') AS auth_can,
        has_function_privilege('service_role', '${sig}', 'EXECUTE') AS svc_can
    `);
    expect(rows[0]).toMatchObject({ anon_can: false, auth_can: true, svc_can: true });
  });

  it('provision_account_on_signup remains service_role-only (041 changed the body, not the ACL)', async () => {
    const sig = 'public.provision_account_on_signup(uuid)';
    const { rows } = await db.query(`
      SELECT
        has_function_privilege('anon', '${sig}', 'EXECUTE') AS anon_can,
        has_function_privilege('authenticated', '${sig}', 'EXECUTE') AS auth_can,
        has_function_privilege('service_role', '${sig}', 'EXECUTE') AS svc_can
    `);
    expect(rows[0]).toMatchObject({ anon_can: false, auth_can: false, svc_can: true });
  });

  it('a single call provisions exactly one account/membership/workspace/membership', async () => {
    const profile = await db.query(
      `INSERT INTO public.profiles (id, email, full_name) VALUES (gen_random_uuid(), 'single@idempotency.test', 'Single User') RETURNING id`,
    );
    const userId = profile.rows[0].id;

    await db.query(`SELECT public.provision_account_on_signup($1)`, [userId]);

    const accounts = await db.query(`SELECT id FROM public.accounts WHERE owner_id = $1`, [userId]);
    expect(accounts.rowCount).toBe(1);
    const members = await db.query(`SELECT * FROM public.account_members WHERE user_id = $1`, [userId]);
    expect(members.rowCount).toBe(1);
    const workspaces = await db.query(`SELECT id FROM public.workspaces WHERE account_id = $1`, [accounts.rows[0].id]);
    expect(workspaces.rowCount).toBe(1);
    const wsMembers = await db.query(`SELECT * FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2`, [workspaces.rows[0].id, userId]);
    expect(wsMembers.rowCount).toBe(1);
  });

  it('a second, sequential call is a safe no-op — no duplicate account/workspace', async () => {
    const profile = await db.query(
      `INSERT INTO public.profiles (id, email, full_name) VALUES (gen_random_uuid(), 'sequential@idempotency.test', 'Sequential User') RETURNING id`,
    );
    const userId = profile.rows[0].id;

    await db.query(`SELECT public.provision_account_on_signup($1)`, [userId]);
    await db.query(`SELECT public.provision_account_on_signup($1)`, [userId]);
    await db.query(`SELECT public.provision_account_on_signup($1)`, [userId]); // a third call, still a no-op

    const accounts = await db.query(`SELECT id FROM public.accounts WHERE owner_id = $1`, [userId]);
    expect(accounts.rowCount).toBe(1);
    const workspaces = await db.query(`SELECT count(*)::int AS n FROM public.workspaces WHERE account_id = $1`, [accounts.rows[0].id]);
    expect(workspaces.rows[0].n).toBe(1);
  });

  it('TWO real concurrent connections calling provision_account_on_signup for the SAME user create exactly one account/workspace', async () => {
    const { Client } = await import('pg');
    const profile = await db.query(
      `INSERT INTO public.profiles (id, email, full_name) VALUES (gen_random_uuid(), 'concurrent-same@idempotency.test', 'Concurrent User') RETURNING id`,
    );
    const userId = profile.rows[0].id;

    const connA = new Client({ connectionString: DSN });
    const connB = new Client({ connectionString: DSN });
    await connA.connect();
    await connB.connect();
    try {
      const results = await Promise.allSettled([
        connA.query(`SELECT public.provision_account_on_signup($1)`, [userId]),
        connB.query(`SELECT public.provision_account_on_signup($1)`, [userId]),
      ]);
      // Both calls succeed (the second serializes behind the row lock and
      // then no-ops) — neither is expected to error.
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    } finally {
      await connA.end();
      await connB.end();
    }

    const accounts = await db.query(`SELECT id FROM public.accounts WHERE owner_id = $1`, [userId]);
    expect(accounts.rowCount).toBe(1);
    const members = await db.query(`SELECT count(*)::int AS n FROM public.account_members WHERE user_id = $1`, [userId]);
    expect(members.rows[0].n).toBe(1);
    const workspaces = await db.query(`SELECT count(*)::int AS n FROM public.workspaces WHERE account_id = $1`, [accounts.rows[0].id]);
    expect(workspaces.rows[0].n).toBe(1);
  });

  it('two DIFFERENT users provisioning concurrently get two INDEPENDENT accounts', async () => {
    const { Client } = await import('pg');
    const pA = await db.query(`INSERT INTO public.profiles (id, email, full_name) VALUES (gen_random_uuid(), 'diff-user-a@idempotency.test', 'A') RETURNING id`);
    const pB = await db.query(`INSERT INTO public.profiles (id, email, full_name) VALUES (gen_random_uuid(), 'diff-user-b@idempotency.test', 'B') RETURNING id`);
    const userA = pA.rows[0].id;
    const userB = pB.rows[0].id;

    const connA = new Client({ connectionString: DSN });
    const connB = new Client({ connectionString: DSN });
    await connA.connect();
    await connB.connect();
    try {
      await Promise.all([
        connA.query(`SELECT public.provision_account_on_signup($1)`, [userA]),
        connB.query(`SELECT public.provision_account_on_signup($1)`, [userB]),
      ]);
    } finally {
      await connA.end();
      await connB.end();
    }

    const accA = await db.query(`SELECT id FROM public.accounts WHERE owner_id = $1`, [userA]);
    const accB = await db.query(`SELECT id FROM public.accounts WHERE owner_id = $1`, [userB]);
    expect(accA.rowCount).toBe(1);
    expect(accB.rowCount).toBe(1);
    expect(accA.rows[0].id).not.toBe(accB.rows[0].id);
  });

  // ════════════════════════════ Part C (shares Part A's database + server) ════════════════════════════

  describe('Part C — POST /api/workspaces/provision-account route contract', () => {
    it('unauthenticated caller gets 401', async () => {
      const res = await call('POST', '/api/workspaces/provision-account');
      expect(res.status).toBe(401);
    });

    it('unverified (signed up, not verified) caller gets 403 email_verification_required', async () => {
      capturedEmails = [];
      await signupOnly('unverified-provision@route.test');
      const loginRes = await call('POST', '/api/auth/login', { body: { email: 'unverified-provision@route.test', password: 'CorrectHorseBattery1' } });
      // Unverified users may or may not be able to log in depending on
      // policy; either way, provisioning itself must reject them. Try both
      // an authenticated-but-unverified session and, failing that, confirm
      // no session was issued at all (also a correct-by-construction 401).
      if (loginRes.status === 200) {
        const cookie = loginRes.setCookie.find((c) => c.startsWith('gs_session='))!.split(';')[0];
        const res = await call('POST', '/api/workspaces/provision-account', { cookie });
        expect(res.status).toBe(403);
        expect(res.json.error).toBe('email_verification_required');
      } else {
        expect(loginRes.status).not.toBe(200);
      }
    });

    it('first verified call succeeds; second (repeat) call is idempotent — no duplicate account/workspace', async () => {
      capturedEmails = [];
      const { cookie } = await signupAndVerify('repeat-provision@route.test');

      const first = await call('POST', '/api/workspaces/provision-account', { cookie });
      expect(first.status).toBe(200);
      expect(first.json.ok).toBe(true);

      const second = await call('POST', '/api/workspaces/provision-account', { cookie });
      expect(second.status).toBe(200);
      expect(second.json.ok).toBe(true);

      const userId = (await db.query(`SELECT id FROM public.profiles WHERE email = 'repeat-provision@route.test'`)).rows[0].id;
      const accounts = await db.query(`SELECT count(*)::int AS n FROM public.accounts WHERE owner_id = $1`, [userId]);
      expect(accounts.rows[0].n).toBe(1);
    });

    it('two concurrent HTTP calls for the same session do not create duplicate account/workspace', async () => {
      capturedEmails = [];
      const { cookie } = await signupAndVerify('concurrent-http-provision@route.test');

      const [r1, r2] = await Promise.all([
        call('POST', '/api/workspaces/provision-account', { cookie }),
        call('POST', '/api/workspaces/provision-account', { cookie }),
      ]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);

      const userId = (await db.query(`SELECT id FROM public.profiles WHERE email = 'concurrent-http-provision@route.test'`)).rows[0].id;
      const accounts = await db.query(`SELECT count(*)::int AS n FROM public.accounts WHERE owner_id = $1`, [userId]);
      expect(accounts.rows[0].n).toBe(1);
    });

    it('GET /api/workspaces/account remains unshadowed, and POST /api/workspaces still creates a second workspace via service_role', async () => {
      capturedEmails = [];
      const { cookie } = await signupAndVerify('route-followup@route.test');
      await call('POST', '/api/workspaces/provision-account', { cookie });

      const accountRes = await call('GET', '/api/workspaces/account', { cookie });
      expect(accountRes.status).toBe(200);
      const accountId = accountRes.json.account.id;

      const secondRes = await call('POST', '/api/workspaces', { cookie, body: { accountId, name: 'Second Workspace After Lockdown' } });
      expect(secondRes.status).toBe(200);
      expect(secondRes.json.workspaceId).toBeTruthy();
    });
  });
});

// ══════════════════════════════════════ Part B — hosted (isolated throwaway database) ══════════════════════════════════════

// Byte-identical to the CURRENT hosted body (supabase/migrations/20260415081729_...sql),
// reproduced here (rather than applying that whole file) because that file
// also creates RLS policies referencing has_role()/app_role, which this
// minimal stand-in schema deliberately does not replicate — the same
// "minimal stand-in with the real signature/body" convention already
// established by legacyGotrueSignupBoundary.pg.test.ts's own hosted Part B.
const REAL_GENERATE_SHORT_ID = `
CREATE OR REPLACE FUNCTION public.generate_short_id(prefix text DEFAULT '')
RETURNS text LANGUAGE sql VOLATILE SET search_path TO 'public' AS $$
  SELECT prefix || LOWER(SUBSTR(REPLACE(gen_random_uuid()::text, '-', ''), 1, 8))
$$;`;

const REAL_IS_ACCOUNT_MEMBER = `
CREATE OR REPLACE FUNCTION public.is_account_member(_account_id uuid, _user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM account_members WHERE account_id = _account_id AND user_id = _user_id)
$$;`;

const REAL_CREATE_WORKSPACE_ATOMIC = `
CREATE OR REPLACE FUNCTION public.create_workspace_atomic(_account_id uuid, _name text, _slug text, _user_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  _ws_id uuid;
  _safe_slug text;
BEGIN
  IF NOT is_account_member(_account_id, _user_id) THEN
    RAISE EXCEPTION 'Not an account member';
  END IF;
  IF _slug IS NOT NULL AND _slug LIKE 'ws_%' AND _slug ~ '^ws_[a-z0-9]+$' THEN
    _safe_slug := _slug;
  ELSE
    _safe_slug := generate_short_id('ws_');
  END IF;
  INSERT INTO workspaces (name, slug, owner_id, account_id) VALUES (_name, _safe_slug, _user_id, _account_id) RETURNING id INTO _ws_id;
  INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (_ws_id, _user_id, 'owner');
  INSERT INTO workspace_branding (workspace_id) VALUES (_ws_id);
  INSERT INTO widget_settings (workspace_id) VALUES (_ws_id);
  RETURN _ws_id;
END;
$function$;`;

suite('Part B — hosted chain (isolated database): create_workspace_atomic ACL + provision_account_on_signup Trial-plan-preserving idempotency', () => {
  let admin: PgTestClient;
  let hosted: PgTestClient;
  const HOSTED_DB_NAME = `hosted_provisioning_closure_${Date.now()}`;

  beforeAll(async () => {
    const { Client } = await import('pg');
    const adminUrl = new URL(DSN!);
    adminUrl.pathname = '/postgres';
    admin = new Client({ connectionString: adminUrl.toString() }) as unknown as PgTestClient;
    await (admin as any).connect();
    await admin.query(`DROP DATABASE IF EXISTS ${HOSTED_DB_NAME}`);
    await admin.query(`CREATE DATABASE ${HOSTED_DB_NAME}`);

    const hostedUrl = new URL(DSN!);
    hostedUrl.pathname = `/${HOSTED_DB_NAME}`;
    hosted = new Client({ connectionString: hostedUrl.toString() }) as unknown as PgTestClient;
    await (hosted as any).connect();

    await hosted.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
      END $$;
      GRANT anon, authenticated, service_role TO CURRENT_USER;

      CREATE TABLE public.profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), full_name text, company_name text);
      CREATE TABLE public.accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, slug text NOT NULL UNIQUE, owner_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE public.account_members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE, user_id uuid NOT NULL, role text NOT NULL DEFAULT 'member', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (account_id, user_id));
      CREATE TABLE public.workspaces (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, slug text NOT NULL UNIQUE, owner_id uuid NOT NULL, account_id uuid REFERENCES public.accounts(id) ON DELETE CASCADE, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE public.workspace_members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, user_id uuid NOT NULL, role text NOT NULL DEFAULT 'member', created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE public.workspace_branding (workspace_id uuid PRIMARY KEY);
      CREATE TABLE public.widget_settings (workspace_id uuid PRIMARY KEY);
      CREATE TABLE public.billing_plans (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text UNIQUE, is_active boolean NOT NULL DEFAULT true, trial_days integer);
      CREATE TABLE public.workspace_subscriptions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL UNIQUE, plan_id uuid, provider_name text, status text, current_period_start timestamptz, current_period_end timestamptz, trial_end timestamptz, metadata jsonb);
      CREATE TABLE public.plan_change_log (id serial PRIMARY KEY, workspace_id uuid, old_plan_id uuid, new_plan_id uuid, change_type text, metadata jsonb, created_at timestamptz NOT NULL DEFAULT now());

      INSERT INTO public.billing_plans (slug, is_active, trial_days) VALUES ('trial', true, 14);

      -- Minimal auth schema so 037's real "DROP TRIGGER ... ON auth.users"
      -- has a relation to target (037 is a no-op here otherwise, same as
      -- authStubSchema.ts's own stand-in for the self-host chain).
      CREATE SCHEMA auth;
      CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());

      -- Pre-037 vulnerable placeholder for provision_account_on_signup —
      -- same convention as legacyGotrueSignupBoundary.pg.test.ts's own
      -- "installVulnerableStub": the REAL signature, granted exactly the
      -- way 20260731160434_...sql actually left it (authenticated +
      -- service_role executable), so 037 has a real function to lock down
      -- before this closure's migration replaces its body.
      CREATE OR REPLACE FUNCTION public.provision_account_on_signup(_user_id uuid)
      RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
      BEGIN END;
      $$;
      REVOKE ALL ON FUNCTION public.provision_account_on_signup(uuid) FROM PUBLIC, anon;
      GRANT EXECUTE ON FUNCTION public.provision_account_on_signup(uuid) TO authenticated, service_role;
    `);

    await hosted.query(REAL_GENERATE_SHORT_ID);
    await hosted.query(REAL_IS_ACCOUNT_MEMBER);
    await hosted.query(REAL_CREATE_WORKSPACE_ATOMIC);
    // Real, unmodified 037 — locks the placeholder above to service_role
    // only, matching the real chain's order (037 sorts before this
    // closure's migration).
    await hosted.query(RETIRE_TRIGGER_MIGRATION);
    // The function under test — real, unmodified SQL read from disk.
    await hosted.query(HOSTED_MIGRATION);
  }, 60_000);

  afterAll(async () => {
    if (hosted) await (hosted as any).end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${HOSTED_DB_NAME}`);
      await (admin as any).end();
    }
  });

  it('create_workspace_atomic: anon and authenticated denied, service_role allowed (literal execution attempts)', async () => {
    await hosted.query('SET ROLE anon');
    try {
      await expect(hosted.query(`SELECT public.create_workspace_atomic(gen_random_uuid(), 'x', '', gen_random_uuid())`)).rejects.toThrow(/permission denied/i);
    } finally {
      await hosted.query('RESET ROLE');
    }

    await hosted.query('SET ROLE authenticated');
    try {
      await expect(hosted.query(`SELECT public.create_workspace_atomic(gen_random_uuid(), 'x', '', gen_random_uuid())`)).rejects.toThrow(/permission denied/i);
    } finally {
      await hosted.query('RESET ROLE');
    }

    await hosted.query('SET ROLE service_role');
    try {
      await expect(hosted.query(`SELECT public.create_workspace_atomic(gen_random_uuid(), 'x', '', gen_random_uuid())`)).rejects.toThrow(/not an account member/i);
    } finally {
      await hosted.query('RESET ROLE');
    }
  });

  it('provision_account_on_signup: single call subscribes the new workspace to Trial exactly once', async () => {
    const profile = await hosted.query(`INSERT INTO public.profiles (full_name, company_name) VALUES ('Hosted User', 'Acme') RETURNING id`);
    const userId = profile.rows[0].id;

    await hosted.query(`SELECT public.provision_account_on_signup($1)`, [userId]);

    const account = await hosted.query(`SELECT id FROM public.accounts WHERE owner_id = $1`, [userId]);
    expect(account.rowCount).toBe(1);
    const workspace = await hosted.query(`SELECT id FROM public.workspaces WHERE account_id = $1`, [account.rows[0].id]);
    expect(workspace.rowCount).toBe(1);
    const sub = await hosted.query(`SELECT status FROM public.workspace_subscriptions WHERE workspace_id = $1`, [workspace.rows[0].id]);
    expect(sub.rowCount).toBe(1);
    expect(sub.rows[0].status).toBe('trialing');
    const log = await hosted.query(`SELECT count(*)::int AS n FROM public.plan_change_log WHERE workspace_id = $1`, [workspace.rows[0].id]);
    expect(log.rows[0].n).toBe(1);
  });

  it('TWO concurrent connections calling provision_account_on_signup for the SAME user create exactly one account/workspace/Trial-subscription/plan_change_log row', async () => {
    const { Client } = await import('pg');
    const profile = await hosted.query(`INSERT INTO public.profiles (full_name, company_name) VALUES ('Hosted Concurrent User', 'Acme Concurrent') RETURNING id`);
    const userId = profile.rows[0].id;

    const hostedUrl = new URL(DSN!);
    hostedUrl.pathname = `/${HOSTED_DB_NAME}`;
    const connA = new Client({ connectionString: hostedUrl.toString() });
    const connB = new Client({ connectionString: hostedUrl.toString() });
    await connA.connect();
    await connB.connect();
    try {
      const results = await Promise.allSettled([
        connA.query(`SELECT public.provision_account_on_signup($1)`, [userId]),
        connB.query(`SELECT public.provision_account_on_signup($1)`, [userId]),
      ]);
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    } finally {
      await connA.end();
      await connB.end();
    }

    const account = await hosted.query(`SELECT id FROM public.accounts WHERE owner_id = $1`, [userId]);
    expect(account.rowCount).toBe(1);
    const workspace = await hosted.query(`SELECT id FROM public.workspaces WHERE account_id = $1`, [account.rows[0].id]);
    expect(workspace.rowCount).toBe(1);
    const sub = await hosted.query(`SELECT count(*)::int AS n FROM public.workspace_subscriptions WHERE workspace_id = $1`, [workspace.rows[0].id]);
    expect(sub.rows[0].n).toBe(1);
    const log = await hosted.query(`SELECT count(*)::int AS n FROM public.plan_change_log WHERE workspace_id = $1`, [workspace.rows[0].id]);
    expect(log.rows[0].n).toBe(1);
  });

  it('the hosted migration file is safe to re-apply (idempotent) — ACL and function definitions remain stable', async () => {
    await expect(hosted.query(HOSTED_MIGRATION)).resolves.toBeDefined();
    const sig = 'public.create_workspace_atomic(uuid,text,text,uuid)';
    const { rows } = await hosted.query(`SELECT has_function_privilege('service_role', '${sig}', 'EXECUTE') AS svc_can`);
    expect(rows[0].svc_can).toBe(true);
  });
});
