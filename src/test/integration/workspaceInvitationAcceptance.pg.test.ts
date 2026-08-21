/**
 * SELF-HOST OWNER INVITE ACCEPTANCE — real PostgreSQL + real Express.
 *
 * Proves the Owner -> invite -> user accepts -> workspace membership
 * lifecycle end to end against the self-host migration chain (through
 * 042_workspace_invitations.sql), driven by the REAL
 * authSecurityRouter/authEmailRouter/workspacesRouter/workspaceMembersRouter
 * over HTTP with real gs_session cookies — no mocked invitation
 * table/RPC. Only outbound email delivery is intercepted (same technique
 * as selfHostWorkspaceAcceptance.pg.test.ts), so the verification token
 * itself, its redemption, and every invitation/membership write are real.
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

vi.mock('../../../server/middleware/security.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/middleware/security.js')>();
  const passthrough = (_req: unknown, _res: unknown, next: () => void) => next();
  return { ...actual, authRateLimiter: passthrough };
});

// `requireLimit('max_agents', ...)` (mounted on POST /accept-invitation)
// runs FOR REAL in this suite — no mock. It calls checkEntitlementFromDB,
// which builds its OWN raw supabase-js client from
// req.serverConfig.supabaseUrl/supabaseServiceRoleKey and calls
// `rpc('check_workspace_entitlement', ...)` — a completely separate path
// from getServiceClient() above. Self-host has no billing/plan subsystem at
// all (no billing_plans/workspace_subscriptions/check_workspace_entitlement
// anywhere in database/migrations/), so on a real self-host deployment this
// RPC call fails with Postgres 42883 (undefined_function) / PostgREST
// PGRST202. checkEntitlementFromDB now resolves this to allowed/unlimited
// (-1) ONLY when BOTH halves of an explicit two-part condition hold: (1)
// req.serverConfig.selfHostBillingUnlimited is true — set below, mirroring
// the SELF_HOST_BILLING_MODE=unlimited an operator running this exact,
// billing-less chain would set — and (2) the RPC error precisely names
// check_workspace_entitlement as missing
// (isCheckWorkspaceEntitlementFunctionMissing). Neither alone is
// sufficient — a bare PGRST202 can also mean a stale hosted schema-cache
// entry, so this suite deliberately sets the flag explicitly rather than
// relying on the error alone, exactly as a real self-host deployment must.
// Every other RPC failure, or the flag being unset, still fails closed
// (503) — proved directly in src/test/billing/requireLimitMiddleware.test.ts's
// "explicit self-host billing-less boundary" suite (cases A-G). Only the
// HTTP TRANSPORT is swapped out here (real
// PostgREST over HTTP -> a direct query against the same real Postgres
// connection this suite already uses), exactly the same "swap transport,
// not logic" technique makePgServiceClient uses for getServiceClient()
// above — the real middleware, the real parser, and a REAL 42883 from a REAL
// database missing the function all run unmocked.
// `server/` carries its OWN nested node_modules/@supabase/supabase-js
// (different physical package than the root one) — featureGating.ts's
// `import { createClient } from '@supabase/supabase-js'` resolves against
// THAT nested copy, not the root one a root-relative `vi.mock('@supabase/
// supabase-js', ...)` would intercept. Mock it by its actual resolved path
// so this is the exact module featureGating.ts imports.
vi.mock('../../../server/node_modules/@supabase/supabase-js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@supabase/supabase-js')>();
  return {
    ...actual,
    createClient: (_url: string, _key: string) => ({
      rpc: async (name: string, args: Record<string, unknown>) => {
        if (name === 'check_workspace_entitlement') {
          try {
            const r = await db.query(`SELECT public.check_workspace_entitlement($1, $2) AS result`, [args._workspace_id, args._feature]);
            return { data: r.rows[0]?.result ?? null, error: null };
          } catch (e: any) {
            return { data: null, error: { message: e.message, code: e.code } };
          }
        }
        return { data: null, error: { message: `unhandled rpc in test adapter: ${name}` } };
      },
    }),
  };
});

vi.mock('../../../server/services/email/index.js', () => ({
  sendEmail: async (_config: unknown, req: any) => {
    capturedEmails.push({ to: req.to, templateSlug: req.templateSlug, actionUrl: req.templateData?.action_url ?? null });
    return { success: true };
  },
}));

function makePgServiceClient(pg: PgTestClient) {
  function from(table: string) {
    const state: {
      cols: string; wheres: string[]; params: unknown[];
      order: string; limitClause: string; patch: Record<string, unknown> | null; doDelete: boolean;
    } = { cols: '*', wheres: [], params: [], order: '', limitClause: '', patch: null, doDelete: false };

    function addParam(val: unknown): number { state.params.push(val); return state.params.length; }

    async function runSelect() {
      const where = state.wheres.length ? ` WHERE ${state.wheres.join(' AND ')}` : '';
      return pg.query(`SELECT ${state.cols} FROM public.${table}${where}${state.order}${state.limitClause}`, state.params);
    }
    async function runUpdate() {
      const setCols = Object.keys(state.patch!);
      const setParams = setCols.map((c) => (state.patch as any)[c]);
      const baseLen = setParams.length;
      const setSql = setCols.map((c, i) => `${c} = $${i + 1}`).join(', ');
      const whereShifted = state.wheres.map((w) => w.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + baseLen}`));
      const where = whereShifted.length ? ` WHERE ${whereShifted.join(' AND ')}` : '';
      return pg.query(`UPDATE public.${table} SET ${setSql}${where} RETURNING *`, [...setParams, ...state.params]);
    }
    async function runDelete() {
      const where = state.wheres.length ? ` WHERE ${state.wheres.join(' AND ')}` : '';
      return pg.query(`DELETE FROM public.${table}${where} RETURNING *`, state.params);
    }
    async function runInsert(rows: Record<string, unknown>[]) {
      const cols = Object.keys(rows[0]);
      const values: string[] = []; const params: unknown[] = [];
      for (const row of rows) {
        const placeholders = cols.map((c) => { params.push((row as any)[c]); return `$${params.length}`; });
        values.push(`(${placeholders.join(', ')})`);
      }
      return pg.query(`INSERT INTO public.${table} (${cols.join(', ')}) VALUES ${values.join(', ')} RETURNING *`, params);
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
      update(patch: Record<string, unknown>) { state.patch = patch; return builder; },
      delete() { state.doDelete = true; return builder; },
      maybeSingle: async () => {
        try { const r = await runSelect(); return { data: r.rows[0] ?? null, error: null }; }
        catch (e: any) { return { data: null, error: { message: e.message } }; }
      },
      single: async () => {
        try {
          const r = state.patch ? await runUpdate() : state.doDelete ? await runDelete() : await runSelect();
          if (!r.rows[0]) return { data: null, error: { message: 'no rows' } };
          return { data: r.rows[0], error: null };
        } catch (e: any) { return { data: null, error: { message: e.message } }; }
      },
      then(resolvePromise: any) {
        const p = state.patch ? runUpdate() : state.doDelete ? runDelete() : runSelect();
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
      if (name === 'accept_workspace_invitation_as') {
        try {
          const r = await pg.query(`SELECT public.accept_workspace_invitation_as($1, $2) AS result`, [args._token, args._user_id]);
          return { data: r.rows[0].result, error: null };
        } catch (e: any) {
          return { data: null, error: { message: e.message, code: e.code } };
        }
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
const { workspaceMembersRouter } = await import('../../../server/routes/workspaceMembers.js');

const app = express();
app.use((req, _res, next) => {
  // Real self-host deployment posture: the explicit, server-only
  // self-host-billing-less flag is set (as an operator running this chain
  // WITHOUT the billing/plans subsystem would set SELF_HOST_BILLING_MODE=
  // unlimited) — required alongside the real 42883 this DB actually
  // produces for requireLimit's max_agents gate to resolve to unlimited
  // instead of failing closed. See checkEntitlementFromDB's two-part
  // condition in server/middleware/featureGating.ts.
  (req as any).serverConfig = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: ['*'], port: 0, supabaseAnonKey: 'k', rateLimitWindowMs: 60000, rateLimitMax: 10000, selfHostBillingUnlimited: true };
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use('/api/auth', authSecurityRouter);
app.use('/api/auth-email', authEmailRouter);
app.use('/api/workspaces', workspacesRouter);
app.use('/api/workspace-members', workspaceMembersRouter);

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

async function signup(email: string): Promise<void> {
  const res = await call('POST', '/api/auth/signup', { body: { email, password: 'CorrectHorseBattery1', fullName: 'Invite Test User' } });
  expect(res.status).toBe(200);
}

async function login(email: string): Promise<{ status: number; cookie: string | null }> {
  const res = await call('POST', '/api/auth/login', { body: { email, password: 'CorrectHorseBattery1' } });
  const cookieHeader = res.setCookie.find((c) => c.startsWith('gs_session='));
  return { status: res.status, cookie: cookieHeader ? cookieHeader.split(';')[0] : null };
}

async function signupAndVerify(email: string): Promise<{ cookie: string }> {
  await signup(email);
  const sent = capturedEmails.find((e) => e.templateSlug === 'email_verify' && e.actionUrl && e.to === email);
  const token = extractTokenFromUrl(sent!.actionUrl!);
  const verifyRes = await call('POST', '/api/auth-email/verify-email', { body: { token } });
  expect(verifyRes.status).toBe(200);
  const { status, cookie } = await login(email);
  expect(status).toBe(200);
  return { cookie: cookie! };
}

/** Owner with a real, fully-provisioned account + first workspace. */
async function makeOwner(email: string): Promise<{ cookie: string; workspaceId: string; accountId: string }> {
  const { cookie } = await signupAndVerify(email);
  const provisionRes = await call('POST', '/api/workspaces/provision-account', { cookie });
  expect(provisionRes.status).toBe(200);
  const wsRes = await call('GET', '/api/workspaces', { cookie });
  const workspaceId = wsRes.json.workspaces[0].id;
  const accRes = await call('GET', '/api/workspaces/account', { cookie });
  const accountId = accRes.json.account.id;
  return { cookie, workspaceId, accountId };
}

async function createInvitation(ownerCookie: string, workspaceId: string, opts: { invitedEmail?: string; role?: string; expiresAt?: string } = {}): Promise<{ id: string; token: string }> {
  const res = await call('POST', '/api/workspace-members/invitations', {
    cookie: ownerCookie,
    body: { workspaceId, role: opts.role || 'agent', invitedEmail: opts.invitedEmail ?? null, expiresAt: opts.expiresAt ?? null },
  });
  expect(res.status).toBe(201);
  return { id: res.json.invitation.id, token: res.json.invitation.token };
}

suite('Self-host owner invite acceptance: full first-party Auth lifecycle', () => {
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
      await db.end();
    }
    if (server) server.close();
  });

  beforeAll(async () => {
    server = http.createServer(app).listen(0);
    await new Promise<void>((resolvePromise) => server.once('listening', () => resolvePromise()));
    baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  });

  it('CASE 1 — existing verified user accepts an invitation: membership created exactly once, correct role, workspace accessible', async () => {
    capturedEmails = [];
    const owner = await makeOwner('case1-owner@invite.test');
    capturedEmails = [];
    const member = await signupAndVerify('case1-member@invite.test');

    const inv = await createInvitation(owner.cookie, owner.workspaceId, { invitedEmail: 'case1-member@invite.test', role: 'agent' });
    const acceptRes = await call('POST', '/api/workspace-members/accept-invitation', { cookie: member.cookie, body: { token: inv.token } });
    expect(acceptRes.status).toBe(200);
    expect(acceptRes.json.already_member).toBe(false);
    expect(acceptRes.json.role).toBe('agent');

    const memberId = (await db.query(`SELECT id FROM public.profiles WHERE email = 'case1-member@invite.test'`)).rows[0].id;
    const rows = await db.query(`SELECT role FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2`, [owner.workspaceId, memberId]);
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].role).toBe('agent');

    // Member can now read the workspace's member list (any-member read).
    const listRes = await call('GET', `/api/workspace-members?workspaceId=${owner.workspaceId}`, { cookie: member.cookie });
    expect(listRes.status).toBe(200);
  });

  it('CASE 2 — brand-new user (no prior account) signs up, verifies, and accepts: membership created exactly once', async () => {
    capturedEmails = [];
    const owner = await makeOwner('case2-owner@invite.test');
    const inv = await createInvitation(owner.cookie, owner.workspaceId, { invitedEmail: 'case2-newuser@invite.test', role: 'viewer' });

    capturedEmails = [];
    const newUser = await signupAndVerify('case2-newuser@invite.test');
    const acceptRes = await call('POST', '/api/workspace-members/accept-invitation', { cookie: newUser.cookie, body: { token: inv.token } });
    expect(acceptRes.status).toBe(200);
    expect(acceptRes.json.role).toBe('viewer');

    const userId = (await db.query(`SELECT id FROM public.profiles WHERE email = 'case2-newuser@invite.test'`)).rows[0].id;
    const rows = await db.query(`SELECT count(*)::int AS n FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2`, [owner.workspaceId, userId]);
    expect(rows.rows[0].n).toBe(1);
  });

  it('CASE 3 — unverified user cannot accept: 403 email_verification_required, zero membership created', async () => {
    capturedEmails = [];
    const owner = await makeOwner('case3-owner@invite.test');
    const inv = await createInvitation(owner.cookie, owner.workspaceId, { invitedEmail: 'case3-unverified@invite.test' });

    capturedEmails = [];
    await signup('case3-unverified@invite.test');
    const { status, cookie } = await login('case3-unverified@invite.test');

    if (status === 200 && cookie) {
      const acceptRes = await call('POST', '/api/workspace-members/accept-invitation', { cookie, body: { token: inv.token } });
      expect(acceptRes.status).toBe(403);
      expect(acceptRes.json.error).toBe('email_verification_required');
    } else {
      // Login itself refuses an unverified account — acceptance is unreachable either way.
      expect(status).not.toBe(200);
    }

    const userId = (await db.query(`SELECT id FROM public.profiles WHERE email = 'case3-unverified@invite.test'`)).rows[0].id;
    const rows = await db.query(`SELECT count(*)::int AS n FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2`, [owner.workspaceId, userId]);
    expect(rows.rows[0].n).toBe(0);
  });

  it('CASE 4 — wrong user/email: a different authenticated user cannot accept an email-bound invitation', async () => {
    capturedEmails = [];
    const owner = await makeOwner('case4-owner@invite.test');
    const inv = await createInvitation(owner.cookie, owner.workspaceId, { invitedEmail: 'case4-intended@invite.test' });

    capturedEmails = [];
    const stranger = await signupAndVerify('case4-stranger@invite.test');
    const acceptRes = await call('POST', '/api/workspace-members/accept-invitation', { cookie: stranger.cookie, body: { token: inv.token } });
    expect(acceptRes.status).toBe(400);
    expect(acceptRes.json.error).toMatch(/different email/i);

    const strangerId = (await db.query(`SELECT id FROM public.profiles WHERE email = 'case4-stranger@invite.test'`)).rows[0].id;
    const rows = await db.query(`SELECT count(*)::int AS n FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2`, [owner.workspaceId, strangerId]);
    expect(rows.rows[0].n).toBe(0);
  });

  it('CASE 5 — revoked invitation is rejected', async () => {
    capturedEmails = [];
    const owner = await makeOwner('case5-owner@invite.test');
    const inv = await createInvitation(owner.cookie, owner.workspaceId, { invitedEmail: 'case5-member@invite.test' });

    const revokeRes = await call('PATCH', `/api/workspace-members/invitations/${inv.id}?workspaceId=${owner.workspaceId}`, { cookie: owner.cookie });
    expect(revokeRes.status).toBe(200);

    capturedEmails = [];
    const member = await signupAndVerify('case5-member@invite.test');
    const acceptRes = await call('POST', '/api/workspace-members/accept-invitation', { cookie: member.cookie, body: { token: inv.token } });
    expect(acceptRes.status).toBe(400);
    expect(acceptRes.json.error).toMatch(/revoked/i);

    const memberId = (await db.query(`SELECT id FROM public.profiles WHERE email = 'case5-member@invite.test'`)).rows[0].id;
    const rows = await db.query(`SELECT count(*)::int AS n FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2`, [owner.workspaceId, memberId]);
    expect(rows.rows[0].n).toBe(0);
  });

  it('CASE 6 — expired invitation is rejected', async () => {
    capturedEmails = [];
    const owner = await makeOwner('case6-owner@invite.test');
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    const inv = await createInvitation(owner.cookie, owner.workspaceId, { invitedEmail: 'case6-member@invite.test', expiresAt: pastExpiry });

    capturedEmails = [];
    const member = await signupAndVerify('case6-member@invite.test');
    const acceptRes = await call('POST', '/api/workspace-members/accept-invitation', { cookie: member.cookie, body: { token: inv.token } });
    expect(acceptRes.status).toBe(400);
    expect(acceptRes.json.error).toMatch(/expired/i);

    const memberId = (await db.query(`SELECT id FROM public.profiles WHERE email = 'case6-member@invite.test'`)).rows[0].id;
    const rows = await db.query(`SELECT count(*)::int AS n FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2`, [owner.workspaceId, memberId]);
    expect(rows.rows[0].n).toBe(0);
  });

  it('CASE 7 — idempotent re-acceptance: no duplicate membership row, no extra seat consumed', async () => {
    capturedEmails = [];
    const owner = await makeOwner('case7-owner@invite.test');
    capturedEmails = [];
    const member = await signupAndVerify('case7-member@invite.test');
    const inv = await createInvitation(owner.cookie, owner.workspaceId, { invitedEmail: 'case7-member@invite.test' });

    const first = await call('POST', '/api/workspace-members/accept-invitation', { cookie: member.cookie, body: { token: inv.token } });
    expect(first.status).toBe(200);
    expect(first.json.already_member).toBe(false);

    const second = await call('POST', '/api/workspace-members/accept-invitation', { cookie: member.cookie, body: { token: inv.token } });
    expect(second.status).toBe(200);
    expect(second.json.already_member).toBe(true);

    const memberId = (await db.query(`SELECT id FROM public.profiles WHERE email = 'case7-member@invite.test'`)).rows[0].id;
    const rows = await db.query(`SELECT count(*)::int AS n FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2`, [owner.workspaceId, memberId]);
    expect(rows.rows[0].n).toBe(1);

    // use_count only increments on the FIRST successful join, not on the
    // already-member no-op branch.
    const useCount = await db.query(`SELECT use_count FROM public.workspace_invitations WHERE id = $1`, [inv.id]);
    expect(useCount.rows[0].use_count).toBe(1);
  });

  it('CASE 8 — role boundary: an invitation with role=owner cannot be created through the generic path', async () => {
    capturedEmails = [];
    const owner = await makeOwner('case8-owner@invite.test');
    const res = await call('POST', '/api/workspace-members/invitations', {
      cookie: owner.cookie,
      body: { workspaceId: owner.workspaceId, role: 'owner', invitedEmail: null, expiresAt: null },
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('owner_role_not_assignable');

    const invCount = await db.query(`SELECT count(*)::int AS n FROM public.workspace_invitations WHERE workspace_id = $1 AND role = 'owner'`, [owner.workspaceId]);
    expect(invCount.rows[0].n).toBe(0);
  });

  it('CASE 9 — tenant isolation: an unrelated workspace owner cannot inspect, modify, revoke, or consume another workspace\'s invitation', async () => {
    capturedEmails = [];
    const ownerA = await makeOwner('case9-ownera@invite.test');
    const invA = await createInvitation(ownerA.cookie, ownerA.workspaceId, { invitedEmail: 'case9-membera@invite.test' });

    capturedEmails = [];
    const ownerB = await makeOwner('case9-ownerb@invite.test');

    // B cannot list A's invitations.
    const listRes = await call('GET', `/api/workspace-members/invitations?workspaceId=${ownerA.workspaceId}`, { cookie: ownerB.cookie });
    expect([401, 403, 404]).toContain(listRes.status);

    // B cannot revoke A's invitation.
    const revokeRes = await call('PATCH', `/api/workspace-members/invitations/${invA.id}?workspaceId=${ownerA.workspaceId}`, { cookie: ownerB.cookie });
    expect([401, 403, 404]).toContain(revokeRes.status);

    // B cannot delete A's invitation.
    const deleteRes = await call('DELETE', `/api/workspace-members/invitations/${invA.id}?workspaceId=${ownerA.workspaceId}`, { cookie: ownerB.cookie });
    expect([401, 403, 404]).toContain(deleteRes.status);

    // B cannot create an invitation inside A's workspace.
    const createRes = await call('POST', '/api/workspace-members/invitations', {
      cookie: ownerB.cookie,
      body: { workspaceId: ownerA.workspaceId, role: 'agent', invitedEmail: null, expiresAt: null },
    });
    expect([401, 403, 404]).toContain(createRes.status);

    // A's invitation is untouched and still acceptable by its real invitee.
    const stillThere = await db.query(`SELECT revoked_at FROM public.workspace_invitations WHERE id = $1`, [invA.id]);
    expect(stillThere.rows[0].revoked_at).toBeNull();

    capturedEmails = [];
    const memberA = await signupAndVerify('case9-membera@invite.test');
    const acceptRes = await call('POST', '/api/workspace-members/accept-invitation', { cookie: memberA.cookie, body: { token: invA.token } });
    expect(acceptRes.status).toBe(200);
  });

  // Every CASE above exercises accounts/account_members/workspace_invitations
  // through makePgServiceClient — a test-harness adapter, not real PostgREST
  // role enforcement. This proves the actual Postgres privilege boundary
  // 043_service_role_table_grants.sql establishes: a literal `SET ROLE
  // service_role` (what self-host PostgREST really does for a service_role
  // JWT) can reach exactly the operations server/routes/workspaces.ts and
  // server/routes/workspaceMembers.ts need, and a literal `SET ROLE
  // anon`/`authenticated` — the direct browser/PostgREST path Section D
  // forbids — cannot reach workspace_invitations at all.
  it('GRANTS PROOF — service_role has exactly the real Postgres table privileges these routes need; anon/authenticated have none', async () => {
    capturedEmails = [];
    const owner = await makeOwner('grants-owner@invite.test');
    const ownerRow = await db.query(`SELECT owner_id FROM public.accounts WHERE id = $1`, [owner.accountId]);
    const ownerId = ownerRow.rows[0].owner_id;

    const client = await (db as unknown as { connect(): Promise<any> }).connect();
    try {
      await client.query('SET ROLE service_role');

      await expect(client.query('SELECT id FROM public.accounts WHERE id = $1', [owner.accountId])).resolves.toBeDefined();
      await expect(client.query('SELECT id FROM public.account_members WHERE account_id = $1', [owner.accountId])).resolves.toBeDefined();
      await expect(client.query('SELECT id FROM public.workspace_invitations WHERE workspace_id = $1', [owner.workspaceId])).resolves.toBeDefined();

      const ins = await client.query(
        `INSERT INTO public.workspace_invitations (workspace_id, role, created_by, max_uses)
         VALUES ($1, 'agent', $2, 0) RETURNING id`,
        [owner.workspaceId, ownerId],
      );
      const invId = ins.rows[0].id;
      await expect(
        client.query(`UPDATE public.workspace_invitations SET revoked_at = now() WHERE id = $1`, [invId]),
      ).resolves.toBeDefined();
      await expect(
        client.query(`DELETE FROM public.workspace_invitations WHERE id = $1`, [invId]),
      ).resolves.toBeDefined();

      await client.query('RESET ROLE');

      await client.query('SET ROLE anon');
      await expect(client.query('SELECT id FROM public.workspace_invitations LIMIT 1')).rejects.toThrow(/permission denied/i);
      await expect(client.query('SELECT id FROM public.accounts LIMIT 1')).rejects.toThrow(/permission denied/i);
      await client.query('RESET ROLE');

      await client.query('SET ROLE authenticated');
      await expect(client.query('SELECT id FROM public.workspace_invitations LIMIT 1')).rejects.toThrow(/permission denied/i);
      await expect(client.query('SELECT id FROM public.accounts LIMIT 1')).rejects.toThrow(/permission denied/i);
      await client.query('RESET ROLE');
    } finally {
      await client.query('RESET ROLE');
      client.release();
    }
  });
});
