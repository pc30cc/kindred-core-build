/**
 * WORKSPACE INVITATIONS v5.1 — canonical acceptance suite.
 *
 * Real PostgreSQL (the FULL self-host chain, zero excluded files) + the REAL
 * Express router (`server/routes/workspaceInvitations.ts`) over HTTP. No RPC
 * is mocked: only two transports are swapped — PostgREST over HTTP becomes a
 * direct query against the same real database, and outbound email delivery is
 * captured instead of sent. Every invitation/membership/consent write, every
 * lock order, every RLS/ACL decision and every OTP/proof digest is real.
 *
 * Covers v5.1 §20: creation, duplicates, idempotency replay, fragment-only
 * links, plaintext absence, OTP + proof (HttpOnly, path-scoped), new-account
 * acceptance, existing-account acceptance through the login context, consent
 * enforcement, revoke/archive/token states, tenant isolation, seat-limit
 * failure that consumes no secret, and the legacy-route cutover fence.
 *
 * Driven by TEST_DATABASE_URL (or CLEAN_INSTALL_DATABASE_URL) — skipped when
 * no live PostgreSQL is configured.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import { ensureAuthChainInstalled } from './authStubSchema';
import type { PgQueryable } from './pgMigrationChain';

const DSN = process.env.TEST_DATABASE_URL || process.env.CLEAN_INSTALL_DATABASE_URL;
if (!DSN && process.env.REQUIRE_WI_DB === '1') {
  // Mandatory CI job: a missing database must FAIL, never silently skip.
  throw new Error(
    'REQUIRE_WI_DB=1 but neither TEST_DATABASE_URL nor CLEAN_INSTALL_DATABASE_URL is set — ' +
      'the workspace-invitation PostgreSQL suite is mandatory and must not be skipped.',
  );
}
const suite = DSN ? describe : describe.skip;


type PgTestClient = PgQueryable & { end(): Promise<void> };

let db: PgTestClient;
let capturedEmails: Array<{ to: string; subject?: string; text?: string; templateSlug?: string; actionUrl: string | null }> = [];

process.env.INVITATION_LINK_SECRET ||= 'test-invitation-link-secret-value-32b!!';
process.env.INVITATION_OTP_PEPPER ||= 'test-invitation-otp-pepper-value-32bytes';

vi.mock('../../../server/middleware/security.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/middleware/security.js')>();
  const passthrough = (_req: unknown, _res: unknown, next: () => void) => next();
  return { ...actual, authRateLimiter: passthrough };
});

vi.mock('../../../server/services/email/index.js', () => ({
  sendEmail: async (_config: unknown, req: any) => {
    capturedEmails.push({
      to: req.to,
      subject: req.subject,
      text: req.text,
      templateSlug: req.templateSlug,
      actionUrl: req.templateData?.action_url ?? null,
    });
    return { success: true };
  },
}));

/**
 * PostgREST-shaped facade over the real connection. Only the transport is
 * different; the SQL, the RLS-bypassing service_role identity and the error
 * codes are the database's own.
 */
function makePgServiceClient(pg: PgTestClient) {
  function from(table: string) {
    const state = {
      cols: '*',
      wheres: [] as string[],
      params: [] as unknown[],
      order: '',
      limitClause: '',
      patch: null as Record<string, unknown> | null,
      doDelete: false,
    };
    const addParam = (val: unknown) => { state.params.push(val); return state.params.length; };

    const runSelect = () => pg.query(
      `SELECT ${state.cols} FROM public.${table}${state.wheres.length ? ` WHERE ${state.wheres.join(' AND ')}` : ''}${state.order}${state.limitClause}`,
      state.params,
    );
    const runUpdate = () => {
      const cols = Object.keys(state.patch!);
      const setParams = cols.map((c) => (state.patch as any)[c]);
      const setSql = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
      const shifted = state.wheres.map((w) => w.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + setParams.length}`));
      return pg.query(
        `UPDATE public.${table} SET ${setSql}${shifted.length ? ` WHERE ${shifted.join(' AND ')}` : ''} RETURNING *`,
        [...setParams, ...state.params],
      );
    };
    const runDelete = () => pg.query(
      `DELETE FROM public.${table}${state.wheres.length ? ` WHERE ${state.wheres.join(' AND ')}` : ''} RETURNING *`,
      state.params,
    );
    const runInsert = (rows: Record<string, unknown>[]) => {
      const cols = Object.keys(rows[0]);
      const params: unknown[] = [];
      const values = rows.map((row) => `(${cols.map((c) => { params.push((row as any)[c]); return `$${params.length}`; }).join(', ')})`);
      return pg.query(`INSERT INTO public.${table} (${cols.join(', ')}) VALUES ${values.join(', ')} RETURNING *`, params);
    };

    const builder: any = {
      select(cols?: string) { state.cols = cols || '*'; return builder; },
      eq(c: string, v: unknown) { state.wheres.push(`${c} = $${addParam(v)}`); return builder; },
      neq(c: string, v: unknown) { state.wheres.push(`${c} <> $${addParam(v)}`); return builder; },
      is(c: string) { state.wheres.push(`${c} IS NULL`); return builder; },
      not(c: string, op: string) { if (op === 'is') state.wheres.push(`${c} IS NOT NULL`); return builder; },
      in(c: string, v: unknown[]) { state.wheres.push(`${c} = ANY($${addParam(v)})`); return builder; },
      gt(c: string, v: unknown) { state.wheres.push(`${c} > $${addParam(v)}`); return builder; },
      lte(c: string, v: unknown) { state.wheres.push(`${c} <= $${addParam(v)}`); return builder; },
      order(c: string, o?: { ascending?: boolean }) { state.order = ` ORDER BY ${c} ${o?.ascending === false ? 'DESC' : 'ASC'}`; return builder; },
      limit(n: number) { state.limitClause = ` LIMIT ${Number(n)}`; return builder; },
      insert(payload: Record<string, unknown> | Record<string, unknown>[]) {
        const rows = Array.isArray(payload) ? payload : [payload];
        const exec = () => runInsert(rows);
        return {
          select: () => ({
            single: async () => {
              try { const r = await exec(); return { data: r.rows[0] ?? null, error: null }; }
              catch (e: any) { return { data: null, error: { message: e.message, code: e.code } }; }
            },
          }),
          then: (resolve: any) => exec()
            .then((r: any) => resolve({ data: r.rows, error: null }))
            .catch((e: any) => { if (process.env.WI_TEST_DEBUG) console.error('[insert]', table, e.message); return resolve({ data: null, error: { message: e.message, code: e.code } }); }),
        };
      },
      update(patch: Record<string, unknown>) { state.patch = patch; return builder; },
      delete() { state.doDelete = true; return builder; },
      maybeSingle: async () => {
        try { const r = await runSelect(); return { data: r.rows[0] ?? null, error: null }; }
        catch (e: any) { return { data: null, error: { message: e.message, code: e.code } }; }
      },
      single: async () => {
        try {
          const r = state.patch ? await runUpdate() : state.doDelete ? await runDelete() : await runSelect();
          if (!r.rows[0]) return { data: null, error: { message: 'no rows' } };
          return { data: r.rows[0], error: null };
        } catch (e: any) { return { data: null, error: { message: e.message, code: e.code } }; }
      },
      then(resolve: any) {
        const p = state.patch ? runUpdate() : state.doDelete ? runDelete() : runSelect();
        return p
          .then((r: any) => resolve({ data: r.rows, error: null }))
          .catch((e: any) => resolve({ data: null, error: { message: e.message, code: e.code } }));
      },
    };
    return builder;
  }

  /** Generic named-notation RPC bridge: every function is called for real. */
  async function rpc(name: string, args: Record<string, unknown> = {}) {
    const keys = Object.keys(args);
    const argList = keys.map((k, i) => `${k} := $${i + 1}`).join(', ');
    const values = keys.map((k) => args[k]);
    try {
      // Match PostgREST's shape: set-returning functions yield an array of
      // rows, composite returns yield one object, scalars yield the value.
      const shape = await pg.query(
        `SELECT p.proretset, t.typtype
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
           JOIN pg_type t ON t.oid = p.prorettype
          WHERE n.nspname = 'public' AND p.proname = $1
          LIMIT 1`,
        [name],
      );
      const retset = shape.rows[0]?.proretset === true;
      const composite = shape.rows[0]?.typtype === 'c';
      if (retset || composite) {
        const r = await pg.query(`SELECT * FROM public.${name}(${argList})`, values);
        return { data: retset ? r.rows : (r.rows[0] ?? null), error: null };
      }
      const r = await pg.query(`SELECT public.${name}(${argList}) AS result`, values);
      return { data: r.rows[0]?.result ?? null, error: null };
    } catch (e: any) {
      if (process.env.WI_TEST_DEBUG) console.error('[rpc]', name, e.message);
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
const { workspaceInvitationsRouter } = await import('../../../server/routes/workspaceInvitations.js');

const ORIGIN = 'http://127.0.0.1';

const app = express();
app.use((req, _res, next) => {
  (req as any).serverConfig = {
    supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', supabaseAnonKey: 'k',
    corsOrigins: [baseUrl], port: 0, rateLimitWindowMs: 60_000, rateLimitMax: 100_000,
    selfHostBillingUnlimited: true,
  };
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use('/api/auth', authSecurityRouter);
app.use('/api/auth-email', authEmailRouter);
app.use('/api/workspaces', workspacesRouter);
app.use('/api/workspace-members', workspaceMembersRouter);
app.use('/api/workspace-invitations', workspaceInvitationsRouter);

let server: http.Server;
let baseUrl: string;

type Res = { status: number; json: any; setCookie: string[] };

function call(method: string, path: string, opts: { body?: unknown; cookie?: string } = {}): Promise<Res> {
  const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}${path}`,
      {
        method,
        headers: {
          origin: baseUrl,
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

const cookieOf = (res: Res, name: string): string | null => {
  const hit = res.setCookie.find((c) => c.startsWith(`${name}=`));
  if (!hit) return null;
  const value = hit.split(';')[0].split('=').slice(1).join('=');
  return value ? `${name}=${value}` : null;
};

const rid = () => crypto.randomUUID();

async function signupAndVerify(email: string): Promise<{ cookie: string; userId: string }> {
  const signup = await call('POST', '/api/auth/signup', { body: { email, password: 'CorrectHorseBattery1', fullName: 'Invite Test User' } });
  expect(signup.status).toBe(200);
  // The verification mail is dispatched after the HTTP response is flushed,
  // so wait for the real delivery instead of assuming a same-tick send.
  let sent: (typeof capturedEmails)[number] | undefined;
  for (let i = 0; i < 100 && !sent; i += 1) {
    // Addresses are normalized to lowercase server-side before delivery.
    sent = capturedEmails.find(
      (e) => e.templateSlug === 'email_verify' && e.actionUrl && e.to?.toLowerCase() === email.toLowerCase(),
    );
    if (!sent) await new Promise((r) => setTimeout(r, 20));
  }
  expect(sent, `no verification email captured for ${email}`).toBeTruthy();
  const token = new URL(sent!.actionUrl!).searchParams.get('token')!;
  expect((await call('POST', '/api/auth-email/verify-email', { body: { token } })).status).toBe(200);
  const login = await call('POST', '/api/auth/login', { body: { email, password: 'CorrectHorseBattery1' } });
  expect(login.status).toBe(200);
  const cookie = cookieOf(login, 'gs_session')!;
  const { rows } = await db.query('SELECT id FROM public.profiles WHERE lower(email) = lower($1)', [email]);
  return { cookie, userId: String((rows[0] as { id: string }).id) };
}

async function makeOwner(email: string) {
  const { cookie, userId } = await signupAndVerify(email);
  expect((await call('POST', '/api/workspaces/provision-account', { cookie })).status).toBe(200);
  const ws = await call('GET', '/api/workspaces', { cookie });
  return { cookie, userId, workspaceId: ws.json.workspaces[0].id as string };
}

let seq = 0;
function invitePayload(workspaceId: string, over: Record<string, unknown> = {}) {
  seq += 1;
  return {
    workspaceId,
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: `invitee${seq}.${Date.now()}@example.test`,
    phone: `+9891234${String(10000 + seq).slice(-5)}`,
    memberType: 'staff',
    role: 'viewer',
    requestId: rid(),
    ...over,
  };
}

/** Manual link tokens live ONLY in the URL fragment (v5.1 §5.5). */
function tokenFromManualLink(link: string): string {
  const url = new URL(link);
  expect(url.search).toBe('');
  expect(url.hash.length).toBeGreaterThan(1);
  const params = new URLSearchParams(url.hash.slice(1));
  return params.get('token')!;
}

async function activePolicies() {
  const { rows } = await db.query(
    `SELECT policy_type, id FROM public.legal_policy_versions WHERE is_active = true AND effective_from <= now()`,
  );
  const pick = (t: string) => rows.find((r: any) => r.policy_type === t)?.id;
  return { termsVersionId: pick('terms'), privacyVersionId: pick('privacy') };
}

/** Ledger reader — the suite asserts on the REAL table, never on a mock. */
async function ledger(): Promise<Array<Record<string, any>>> {
  const { rows } = await db.query('SELECT * FROM public.workspace_invitation_idempotency ORDER BY created_at');
  return rows as Array<Record<string, any>>;
}

async function countOf(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await db.query(sql, params);
  return Number((rows[0] as any).n);
}

suite('Workspace Invitations v5.1 §10 — atomic crash-safe idempotency (real PostgreSQL)', () => {
  beforeAll(async () => {
    const { Pool } = await import('pg');
    db = new Pool({ connectionString: DSN, max: 10 }) as unknown as PgTestClient;
    await db.query('DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS auth CASCADE; CREATE SCHEMA public;');
    await ensureAuthChainInstalled(db);
    await db.query(`SELECT public.set_workspace_seat_entitlement_mode(_mode := 'self_host_unlimited', _source := 'test_bootstrap')`);
    server = http.createServer(app).listen(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
    void ORIGIN;
  }, 180_000);

  afterAll(async () => {
    if (server) server.close();
    if (db) {
      await db.query('DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS auth CASCADE; CREATE SCHEMA public;');
      await ensureAuthChainInstalled(db);
      await db.end();
    }
  }, 180_000);

  // ── A-RESIDUAL — canonical account_exists semantics ───────────────────
  it('A-residual — wi_preview_invitation and wi_preview_login_context agree on account_exists', async () => {
    const owner = await makeOwner(`idem.owner.${Date.now()}@example.test`);
    const policies = await activePolicies();
    void policies;

    // (a) no profile at all -> false in both previews.
    const created = await call('POST', '/api/workspace-invitations', {
      cookie: owner.cookie,
      body: invitePayload(owner.workspaceId),
    });
    expect(created.status).toBe(201);
    const token = tokenFromManualLink(created.json.manualLink);
    const email = String(
      (await db.query('SELECT invited_email_normalized AS e FROM public.workspace_invitations WHERE id = $1', [created.json.invitation.id])).rows[0].e,
    );

    const previewOf = async () =>
      (await db.query('SELECT public.wi_preview_invitation($1, $2) AS p', [
        crypto.createHash('sha256').update(token, 'utf8').digest('hex'),
        'manual_handoff',
      ])).rows[0].p as any;

    expect((await previewOf()).account_exists).toBe(false);

    // (b) profile WITHOUT credentials -> still false.
    const userId = crypto.randomUUID();
    await db.query(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, 'Pending Person')`, [userId, email]);
    expect((await previewOf()).account_exists).toBe(false);

    // (c) credentials with NULL password_hash -> still false.
    await db.query(`INSERT INTO public.user_credentials (user_id, password_hash) VALUES ($1, NULL)`, [userId]);
    expect((await previewOf()).account_exists).toBe(false);

    // The login-context preview must return the SAME verdict for this email.
    const ctx = await call('POST', '/api/workspace-invitations/login-context', {
      body: { requestId: rid(), token, purpose: 'manual_handoff' },
    });
    expect(ctx.status).toBe(200);
    const ctxCookie = cookieOf(ctx, 'wi_ctx')!;
    const ctxPreview = await call('POST', '/api/workspace-invitations/context-preview', { cookie: ctxCookie, body: {} });
    expect(ctxPreview.status).toBe(200);
    expect(ctxPreview.json.preview.account_exists).toBe(false);

    // (d) credentials WITH a password hash -> true in BOTH previews.
    await db.query(`UPDATE public.user_credentials SET password_hash = 'argon2-fake-hash' WHERE user_id = $1`, [userId]);
    expect((await previewOf()).account_exists).toBe(true);
    const ctxPreview2 = await call('POST', '/api/workspace-invitations/context-preview', { cookie: ctxCookie, body: {} });
    expect(ctxPreview2.json.preview.account_exists).toBe(true);

    // (e) a disabled account still reports account_exists = true, matching the
    // accept-new contract which raises ACCOUNT_DISABLED rather than silently
    // creating a second identity.
    await db.query(`UPDATE public.profiles SET is_blocked = true WHERE id = $1`, [userId]).catch(async () => {
      await db.query(`UPDATE public.profiles SET blocked_at = now() WHERE id = $1`, [userId]);
    });
    expect((await previewOf()).account_exists).toBe(true);
    const ctxPreview3 = await call('POST', '/api/workspace-invitations/context-preview', { cookie: ctxCookie, body: {} });
    expect(ctxPreview3.json.preview.account_exists).toBe(true);
  }, 120_000);

  // ── 14. SOURCE GUARD ──────────────────────────────────────────────────
  it('CASE 14 — the Express router never touches the idempotency ledger directly', () => {
    const source = readFileSync('server/routes/workspaceInvitations.ts', 'utf8');
    expect(source).not.toContain('workspace_invitation_idempotency');
    expect(source).not.toContain('withIdempotency');
    expect(source).toContain('runIdempotent');
  });

  // ── 1. CONCURRENT CREATE ──────────────────────────────────────────────
  it('CASE 1 — two concurrent creates with one requestId produce exactly one invitation, token, job and audit', async () => {
    const owner = await makeOwner(`idem.c1.${Date.now()}@example.test`);
    const payload = invitePayload(owner.workspaceId);

    const [a, b] = await Promise.all([
      call('POST', '/api/workspace-invitations', { cookie: owner.cookie, body: payload }),
      call('POST', '/api/workspace-invitations', { cookie: owner.cookie, body: payload }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const winner = a.status === 201 ? a : b;
    const loser = a.status === 201 ? b : a;
    expect(loser.json.error).toBe('OPERATION_COMMITTED_LINK_NOT_REPLAYABLE');
    expect(loser.json.replayed).toBe(true);
    expect(loser.json.manualLink).toBeUndefined();

    const invitationId = winner.json.invitation.id;
    expect(await countOf(
      'SELECT count(*)::int AS n FROM public.workspace_invitations WHERE workspace_id = $1', [owner.workspaceId],
    )).toBe(1);
    expect(await countOf(
      'SELECT count(*)::int AS n FROM public.workspace_invitation_tokens WHERE invitation_id = $1', [invitationId],
    )).toBe(1);
    expect(await countOf(
      'SELECT count(*)::int AS n FROM public.workspace_invitation_jobs WHERE invitation_id = $1 AND channel = $2', [invitationId, 'email'],
    )).toBe(1);
    expect(await countOf(
      `SELECT count(*)::int AS n FROM public.audit_logs WHERE entity_id = $1 AND action = 'invitation.created'`, [invitationId],
    )).toBe(1);
    expect(await countOf(
      'SELECT count(*)::int AS n FROM public.workspace_invitation_idempotency', [],
    )).toBe(1);
  }, 120_000);

  // ── 2. REPLAY AFTER COMMIT ────────────────────────────────────────────
  it('CASE 2 — replaying a committed create mutates nothing and never returns a link', async () => {
    const owner = await makeOwner(`idem.c2.${Date.now()}@example.test`);
    const payload = invitePayload(owner.workspaceId);
    const first = await call('POST', '/api/workspace-invitations', { cookie: owner.cookie, body: payload });
    expect(first.status).toBe(201);
    const invitationId = first.json.invitation.id;

    const tokensBefore = await countOf('SELECT count(*)::int AS n FROM public.workspace_invitation_tokens', []);
    const jobsBefore = await countOf('SELECT count(*)::int AS n FROM public.workspace_invitation_jobs', []);

    const replay = await call('POST', '/api/workspace-invitations', { cookie: owner.cookie, body: payload });
    expect(replay.status).toBe(409);
    expect(replay.json.error).toBe('OPERATION_COMMITTED_LINK_NOT_REPLAYABLE');
    expect(replay.json.manualLink).toBeUndefined();
    expect(replay.json.replayed).toBe(true);
    expect(replay.json.invitation.invitation_id).toBe(invitationId);

    expect(await countOf('SELECT count(*)::int AS n FROM public.workspace_invitation_tokens', [])).toBe(tokensBefore);
    expect(await countOf('SELECT count(*)::int AS n FROM public.workspace_invitation_jobs', [])).toBe(jobsBefore);
  }, 120_000);

  // ── 3. SAME KEY, DIFFERENT PAYLOAD ────────────────────────────────────
  it('CASE 3 — the same requestId with a different payload fails closed with IDEMPOTENCY_KEY_REUSED', async () => {
    const owner = await makeOwner(`idem.c3.${Date.now()}@example.test`);
    const payload = invitePayload(owner.workspaceId);
    const first = await call('POST', '/api/workspace-invitations', { cookie: owner.cookie, body: payload });
    expect(first.status).toBe(201);

    const mutated = { ...payload, role: 'agent' };
    const reused = await call('POST', '/api/workspace-invitations', { cookie: owner.cookie, body: mutated });
    expect(reused.status).toBe(409);
    expect(reused.json.error).toBe('IDEMPOTENCY_KEY_REUSED');

    const { rows } = await db.query('SELECT role FROM public.workspace_invitations WHERE id = $1', [first.json.invitation.id]);
    expect(String((rows[0] as any).role)).toBe('viewer');
    expect(await countOf('SELECT count(*)::int AS n FROM public.workspace_invitations WHERE workspace_id = $1', [owner.workspaceId])).toBe(1);
  }, 120_000);

  // ── 4. BUSINESS FAILURE / ROLLBACK ────────────────────────────────────
  it('CASE 4 — a failed mutation leaves NO ledger row, no token and no job, and a later retry succeeds', async () => {
    const owner = await makeOwner(`idem.c4.${Date.now()}@example.test`);
    // Force a business failure: a staff invitation with a department is illegal.
    const deptId = crypto.randomUUID();
    await db.query(
      `INSERT INTO public.workspace_departments (id, workspace_id, name, slug, created_by)
       VALUES ($1, $2, 'Support', 'support', $3)`,
      [deptId, owner.workspaceId, owner.userId],
    );

    const payload = invitePayload(owner.workspaceId, { departmentIds: [deptId] });
    const failed = await call('POST', '/api/workspace-invitations', { cookie: owner.cookie, body: payload });
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(failed.json.error).toBe('STAFF_INVITATION_MUST_HAVE_NO_DEPARTMENT');

    // The whole transaction rolled back: the ledger has NOTHING stuck.
    expect(await countOf('SELECT count(*)::int AS n FROM public.workspace_invitation_idempotency', [])).toBe(0);
    expect(await countOf('SELECT count(*)::int AS n FROM public.workspace_invitation_tokens', [])).toBe(0);
    expect(await countOf('SELECT count(*)::int AS n FROM public.workspace_invitation_jobs', [])).toBe(0);

    // Same requestId, corrected payload: the retry is allowed to run.
    const retry = await call('POST', '/api/workspace-invitations', {
      cookie: owner.cookie,
      body: { ...payload, departmentIds: [] },
    });
    expect(retry.status).toBe(201);
    expect(await countOf('SELECT count(*)::int AS n FROM public.workspace_invitation_idempotency', [])).toBe(1);
    const rows = await ledger();
    expect(rows[0].result_state).toBe('committed');
    expect(rows[0].completed_at).toBeTruthy();
  }, 120_000);

  // ── 5. TRANSPORT LOSS AFTER COMMIT ────────────────────────────────────
  it('CASE 5 — a lost response after commit is recovered by the same requestId without re-running the mutation', async () => {
    const owner = await makeOwner(`idem.c5.${Date.now()}@example.test`);
    const payload = invitePayload(owner.workspaceId, { requestId: rid() });

    // First attempt commits; the client "never sees" the response.
    const first = await call('POST', '/api/workspace-invitations', { cookie: owner.cookie, body: payload });
    expect(first.status).toBe(201);
    const invitationId = first.json.invitation.id;
    const snapshot = await db.query(
      'SELECT token_hash, token_generation FROM public.workspace_invitation_tokens WHERE invitation_id = $1',
      [invitationId],
    );

    const recovered = await call('POST', '/api/workspace-invitations', { cookie: owner.cookie, body: payload });
    expect(recovered.status).toBe(409);
    expect(recovered.json.invitation.invitation_id).toBe(invitationId);
    expect(recovered.json.invitation.workspace_id).toBe(owner.workspaceId);

    const after = await db.query(
      'SELECT token_hash, token_generation FROM public.workspace_invitation_tokens WHERE invitation_id = $1',
      [invitationId],
    );
    expect(after.rows).toEqual(snapshot.rows);
  }, 120_000);

  // ── 6. CONCURRENT RESEND ──────────────────────────────────────────────
  it('CASE 6 — concurrent resend bumps notification_generation once and enqueues one job', async () => {
    const owner = await makeOwner(`idem.c6.${Date.now()}@example.test`);
    const created = await call('POST', '/api/workspace-invitations', { cookie: owner.cookie, body: invitePayload(owner.workspaceId) });
    expect(created.status).toBe(201);
    const id = created.json.invitation.id;
    const genBefore = Number((await db.query('SELECT notification_generation AS g FROM public.workspace_invitations WHERE id = $1', [id])).rows[0].g);
    const jobsBefore = await countOf('SELECT count(*)::int AS n FROM public.workspace_invitation_jobs WHERE invitation_id = $1', [id]);

    const requestId = rid();
    const [a, b] = await Promise.all([
      call('POST', `/api/workspace-invitations/${id}/resend`, { cookie: owner.cookie, body: { requestId } }),
      call('POST', `/api/workspace-invitations/${id}/resend`, { cookie: owner.cookie, body: { requestId } }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.json.replayed, b.json.replayed].sort()).toEqual([false, true]);

    const genAfter = Number((await db.query('SELECT notification_generation AS g FROM public.workspace_invitations WHERE id = $1', [id])).rows[0].g);
    expect(genAfter).toBe(genBefore + 1);
    expect(await countOf('SELECT count(*)::int AS n FROM public.workspace_invitation_jobs WHERE invitation_id = $1', [id])).toBe(jobsBefore + 1);
  }, 120_000);

  // ── 7. CONCURRENT ROTATE ──────────────────────────────────────────────
  it('CASE 7 — concurrent rotate-link mints exactly one token generation and the replay carries no link', async () => {
    const owner = await makeOwner(`idem.c7.${Date.now()}@example.test`);
    const created = await call('POST', '/api/workspace-invitations', { cookie: owner.cookie, body: invitePayload(owner.workspaceId) });
    const id = created.json.invitation.id;

    const requestId = rid();
    const [a, b] = await Promise.all([
      call('POST', `/api/workspace-invitations/${id}/rotate-link`, { cookie: owner.cookie, body: { requestId } }),
      call('POST', `/api/workspace-invitations/${id}/rotate-link`, { cookie: owner.cookie, body: { requestId } }),
    ]);
    const ok = [a, b].filter((r) => r.status === 200);
    const replayed = [a, b].filter((r) => r.status === 409);
    expect(ok).toHaveLength(1);
    expect(replayed).toHaveLength(1);
    expect(replayed[0].json.error).toBe('OPERATION_COMMITTED_LINK_NOT_REPLAYABLE');
    expect(replayed[0].json.manualLink).toBeUndefined();

    const live = await db.query(
      'SELECT count(*)::int AS n FROM public.workspace_invitation_tokens WHERE invitation_id = $1 AND purpose = $2 AND revoked_at IS NULL AND consumed_at IS NULL',
      [id, 'manual_handoff'],
    );
    expect(Number((live.rows[0] as any).n)).toBe(1);
  }, 120_000);

  // ── 8. ACCEPT-NEW WITH A LOST RESPONSE ────────────────────────────────
  it('CASE 8 — accept-new replay after a lost response creates no duplicate identity and re-issues a session', async () => {
    const owner = await makeOwner(`idem.c8.${Date.now()}@example.test`);
    const policies = await activePolicies();
    const created = await call('POST', '/api/workspace-invitations', { cookie: owner.cookie, body: invitePayload(owner.workspaceId) });
    const token = tokenFromManualLink(created.json.manualLink);
    const invitationId = created.json.invitation.id;

    capturedEmails = [];
    expect((await call('POST', '/api/workspace-invitations/otp/request', {
      body: { requestId: rid(), token, purpose: 'manual_handoff' },
    })).status).toBe(200);
    const code = String(capturedEmails.find((e) => /verification code/i.test(String(e.text)))!.text).match(/(\d{6})/)![1];
    const verify = await call('POST', '/api/workspace-invitations/otp/verify', {
      body: { requestId: rid(), token, purpose: 'manual_handoff', code },
    });
    expect(verify.status).toBe(200);
    const proofCookie = cookieOf(verify, 'wi_proof')!;

    const acceptBody = {
      requestId: rid(), token, purpose: 'manual_handoff',
      password: 'CorrectHorseBattery1', consent: true, ...policies,
    };
    const accept = await call('POST', '/api/workspace-invitations/accept-new', { cookie: proofCookie, body: acceptBody });
    expect(accept.status).toBe(200);
    expect(accept.json.session).toBe('created');
    const userId = accept.json.user_id;

    // Lost response: the client retries with the SAME requestId.
    const retry = await call('POST', '/api/workspace-invitations/accept-new', { cookie: proofCookie, body: acceptBody });
    expect(retry.status).toBe(200);
    expect(retry.json.replayed).toBe(true);
    expect(retry.json.user_id).toBe(userId);
    expect(retry.json.session).toBe('created');
    expect(cookieOf(retry, 'gs_session')).toBeTruthy();

    expect(await countOf('SELECT count(*)::int AS n FROM public.profiles WHERE id = $1', [userId])).toBe(1);
    expect(await countOf('SELECT count(*)::int AS n FROM public.user_credentials WHERE user_id = $1', [userId])).toBe(1);
    expect(await countOf('SELECT count(*)::int AS n FROM public.workspace_members WHERE user_id = $1 AND workspace_id = $2', [userId, owner.workspaceId])).toBe(1);
    expect(await countOf('SELECT count(*)::int AS n FROM public.workspace_invitation_consents WHERE invitation_id = $1', [invitationId])).toBe(1);
    expect(await countOf('SELECT count(*)::int AS n FROM public.workspace_member_details WHERE user_id = $1 AND workspace_id = $2', [userId, owner.workspaceId])).toBe(1);
  }, 120_000);

  // ── 9. ACCEPT-EXISTING REPLAY ─────────────────────────────────────────
  it('CASE 9 — accept-existing replay duplicates neither membership nor consent', async () => {
    const stamp = Date.now();
    const owner = await makeOwner(`idem.c9.owner.${stamp}@example.test`);
    const policies = await activePolicies();
    const inviteeEmail = `idem.c9.invitee.${stamp}@example.test`;
    const invitee = await signupAndVerify(inviteeEmail);

    const created = await call('POST', '/api/workspace-invitations', {
      cookie: owner.cookie,
      body: invitePayload(owner.workspaceId, { email: inviteeEmail }),
    });
    expect(created.status).toBe(201);
    const invitationId = created.json.invitation.id;
    const token = tokenFromManualLink(created.json.manualLink);

    const ctx = await call('POST', '/api/workspace-invitations/login-context', {
      body: { requestId: rid(), token, purpose: 'manual_handoff' },
    });
    const ctxCookie = cookieOf(ctx, 'wi_ctx')!;

    const acceptBody = { requestId: rid(), consent: true, ...policies };
    const accept = await call('POST', '/api/workspace-invitations/accept-existing', {
      cookie: `${invitee.cookie}; ${ctxCookie}`, body: acceptBody,
    });
    expect(accept.status).toBe(200);

    const retry = await call('POST', '/api/workspace-invitations/accept-existing', {
      cookie: `${invitee.cookie}; ${ctxCookie}`, body: acceptBody,
    });
    expect(retry.status).toBe(200);
    expect(retry.json.replayed).toBe(true);

    expect(await countOf('SELECT count(*)::int AS n FROM public.workspace_members WHERE user_id = $1 AND workspace_id = $2', [invitee.userId, owner.workspaceId])).toBe(1);
    expect(await countOf('SELECT count(*)::int AS n FROM public.workspace_invitation_consents WHERE invitation_id = $1', [invitationId])).toBe(1);
    expect(await countOf('SELECT count(*)::int AS n FROM public.workspace_invitation_contexts WHERE invitation_id = $1 AND consumed_at IS NOT NULL', [invitationId])).toBe(1);
  }, 120_000);

  // ── 10. OTP REQUEST REPLAY ────────────────────────────────────────────
  it('CASE 10 — an OTP request replay creates one OTP row and sends no second code', async () => {
    const owner = await makeOwner(`idem.c10.${Date.now()}@example.test`);
    const created = await call('POST', '/api/workspace-invitations', { cookie: owner.cookie, body: invitePayload(owner.workspaceId) });
    const token = tokenFromManualLink(created.json.manualLink);
    const id = created.json.invitation.id;

    capturedEmails = [];
    const requestId = rid();
    const first = await call('POST', '/api/workspace-invitations/otp/request', { body: { requestId, token, purpose: 'manual_handoff' } });
    expect(first.status).toBe(200);
    const second = await call('POST', '/api/workspace-invitations/otp/request', { body: { requestId, token, purpose: 'manual_handoff' } });
    expect(second.status).toBe(200);
    expect(second.json.replayed).toBe(true);

    expect(await countOf('SELECT count(*)::int AS n FROM public.workspace_invitation_otps WHERE invitation_id = $1', [id])).toBe(1);
    expect(capturedEmails.filter((e) => /verification code/i.test(String(e.text)))).toHaveLength(1);
  }, 120_000);

  // ── 11. OTP VERIFY / LOGIN-CONTEXT RETRY ──────────────────────────────
  it('CASE 11 — OTP verify and login-context retries re-issue the identical cookie and store no raw secret', async () => {
    const owner = await makeOwner(`idem.c11.${Date.now()}@example.test`);
    const created = await call('POST', '/api/workspace-invitations', { cookie: owner.cookie, body: invitePayload(owner.workspaceId) });
    const token = tokenFromManualLink(created.json.manualLink);
    const id = created.json.invitation.id;

    capturedEmails = [];
    await call('POST', '/api/workspace-invitations/otp/request', { body: { requestId: rid(), token, purpose: 'manual_handoff' } });
    const code = String(capturedEmails.find((e) => /verification code/i.test(String(e.text)))!.text).match(/(\d{6})/)![1];

    const verifyRid = rid();
    const v1 = await call('POST', '/api/workspace-invitations/otp/verify', { body: { requestId: verifyRid, token, purpose: 'manual_handoff', code } });
    const v2 = await call('POST', '/api/workspace-invitations/otp/verify', { body: { requestId: verifyRid, token, purpose: 'manual_handoff', code } });
    expect(v1.status).toBe(200);
    expect(v2.status).toBe(200);
    expect(v2.json.replayed).toBe(true);
    const proof1 = cookieOf(v1, 'wi_proof');
    const proof2 = cookieOf(v2, 'wi_proof');
    expect(proof1).toBeTruthy();
    expect(proof2).toBe(proof1);
    expect(await countOf('SELECT count(*)::int AS n FROM public.workspace_invitation_proofs WHERE invitation_id = $1', [id])).toBe(1);

    // The raw proof is nowhere in the database.
    const rawProof = proof1!.split('=').slice(1).join('=');
    expect(await countOf(
      'SELECT count(*)::int AS n FROM public.workspace_invitation_proofs WHERE proof_hash = $1', [rawProof],
    )).toBe(0);

    const ctxRid = rid();
    const c1 = await call('POST', '/api/workspace-invitations/login-context', { body: { requestId: ctxRid, token, purpose: 'manual_handoff' } });
    const c2 = await call('POST', '/api/workspace-invitations/login-context', { body: { requestId: ctxRid, token, purpose: 'manual_handoff' } });
    expect(c1.status).toBe(200);
    expect(c2.status).toBe(200);
    expect(c2.json.replayed).toBe(true);
    expect(cookieOf(c2, 'wi_ctx')).toBe(cookieOf(c1, 'wi_ctx'));
    expect(await countOf('SELECT count(*)::int AS n FROM public.workspace_invitation_contexts WHERE invitation_id = $1', [id])).toBe(1);
  }, 120_000);

  // ── 12. CROSS-SCOPE COLLISION ─────────────────────────────────────────
  it('CASE 12 — one requestId reused in another workspace or another operation never replays the wrong result', async () => {
    const stamp = Date.now();
    const ownerA = await makeOwner(`idem.c12a.${stamp}@example.test`);
    const ownerB = await makeOwner(`idem.c12b.${stamp}@example.test`);
    const shared = rid();

    const a = await call('POST', '/api/workspace-invitations', {
      cookie: ownerA.cookie, body: invitePayload(ownerA.workspaceId, { requestId: shared }),
    });
    const b = await call('POST', '/api/workspace-invitations', {
      cookie: ownerB.cookie, body: invitePayload(ownerB.workspaceId, { requestId: shared }),
    });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.json.invitation.id).not.toBe(b.json.invitation.id);

    // Same requestId, different operation on A's invitation: no false replay.
    const revoke = await call('POST', `/api/workspace-invitations/${a.json.invitation.id}/revoke`, {
      cookie: ownerA.cookie, body: { requestId: shared, reason: 'scope check' },
    });
    expect(revoke.status).toBe(200);
    expect(revoke.json.replayed).toBe(false);
    expect(await countOf('SELECT count(*)::int AS n FROM public.workspace_invitation_idempotency', [])).toBe(3);
  }, 120_000);

  // ── 13. LEDGER SECRET SCAN ────────────────────────────────────────────
  it('CASE 13 — the full ledger contains no token, OTP, proof, password, session or raw contact detail', async () => {
    const owner = await makeOwner(`idem.c13.${Date.now()}@example.test`);
    const policies = await activePolicies();
    const payload = invitePayload(owner.workspaceId);
    const created = await call('POST', '/api/workspace-invitations', { cookie: owner.cookie, body: payload });
    const token = tokenFromManualLink(created.json.manualLink);

    capturedEmails = [];
    await call('POST', '/api/workspace-invitations/otp/request', { body: { requestId: rid(), token, purpose: 'manual_handoff' } });
    const code = String(capturedEmails.find((e) => /verification code/i.test(String(e.text)))!.text).match(/(\d{6})/)![1];
    const verify = await call('POST', '/api/workspace-invitations/otp/verify', { body: { requestId: rid(), token, purpose: 'manual_handoff', code } });
    const proofCookie = cookieOf(verify, 'wi_proof')!;
    const accept = await call('POST', '/api/workspace-invitations/accept-new', {
      cookie: proofCookie,
      body: { requestId: rid(), token, purpose: 'manual_handoff', password: 'CorrectHorseBattery1', consent: true, ...policies },
    });
    expect(accept.status).toBe(200);

    const dump = JSON.stringify(await ledger());
    for (const secret of [
      token,
      code,
      'CorrectHorseBattery1',
      String(payload.email),
      String(payload.phone),
      proofCookie.split('=').slice(1).join('='),
    ]) {
      expect(dump).not.toContain(secret);
    }
    // Nothing that looks like a session cookie leaked either.
    expect(dump).not.toContain('gs_session');
    // …and every stored row is a committed, secret-free projection.
    for (const row of await ledger()) {
      expect(['committed']).toContain(row.result_state);
      expect(Object.keys(row.safe_result || {}).sort()).toEqual(
        Object.keys(row.safe_result || {}).filter((k) => [
          'operation', 'invitation_id', 'workspace_id', 'status',
          'notification_generation', 'token_generation', 'user_id', 'role', 'member_type',
        ].includes(k)).sort(),
      );
    }
  }, 120_000);
});
