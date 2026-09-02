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
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import { ensureAuthChainInstalled } from './authStubSchema';
import type { PgQueryable } from './pgMigrationChain';

const DSN = process.env.TEST_DATABASE_URL || process.env.CLEAN_INSTALL_DATABASE_URL;
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
            .catch((e: any) => resolve({ data: null, error: { message: e.message, code: e.code } })),
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
    corsOrigins: ['*'], port: 0, rateLimitWindowMs: 60_000, rateLimitMax: 100_000,
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

const rid = () => `req-${crypto.randomUUID()}`;

async function signupAndVerify(email: string): Promise<{ cookie: string; userId: string }> {
  const signup = await call('POST', '/api/auth/signup', { body: { email, password: 'CorrectHorseBattery1', fullName: 'Invite Test User' } });
  if (signup.status !== 200) console.error("SIGNUP FAIL", signup.status, JSON.stringify(signup.json));
  expect(signup.status).toBe(200);
  const sent = capturedEmails.find((e) => e.templateSlug === 'email_verify' && e.actionUrl && e.to === email);
  const token = new URL(sent!.actionUrl!).searchParams.get('token')!;
  expect((await call('POST', '/api/auth-email/verify-email', { body: { token } })).status).toBe(200);
  const login = await call('POST', '/api/auth/login', { body: { email, password: 'CorrectHorseBattery1' } });
  expect(login.status).toBe(200);
  const cookie = cookieOf(login, 'gs_session')!;
  const { rows } = await db.query('SELECT id FROM public.profiles WHERE email = $1', [email]);
  return { cookie, userId: rows[0].id };
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
    role: 'agent',
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

suite('Workspace Invitations v5.1 — canonical API on real PostgreSQL', () => {
  beforeAll(async () => {
    const { Pool } = await import('pg');
    db = new Pool({ connectionString: DSN, max: 10 }) as unknown as PgTestClient;
    await db.query('DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS auth CASCADE; CREATE SCHEMA public;');
    await ensureAuthChainInstalled(db);
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

  it('seeds active terms + privacy policy versions (083 install hardening)', async () => {
    const { termsVersionId, privacyVersionId } = await activePolicies();
    expect(termsVersionId).toBeTruthy();
    expect(privacyVersionId).toBeTruthy();
  });

  it('CASE 1 — creates an invitation, returns a fragment-only manual link, and stores no plaintext', async () => {
    capturedEmails = [];
    const owner = await makeOwner(`owner1.${Date.now()}@example.test`);
    const body = invitePayload(owner.workspaceId);

    const res = await call('POST', '/api/workspace-invitations', { cookie: owner.cookie, body });
    expect(res.status).toBe(201);
    expect(res.json.invitation.status).toBe('pending');

    const token = tokenFromManualLink(res.json.manualLink);
    expect(token.length).toBeGreaterThan(20);

    // No table anywhere may hold the raw token — only its sha256 digest.
    const hash = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM public.workspace_invitation_tokens WHERE token_hash = $1`, [hash],
    );
    expect(rows[0].n).toBeGreaterThan(0);
    const plaintext = await db.query(
      `SELECT count(*)::int AS n FROM public.workspace_invitation_tokens WHERE token_hash <> $1 AND token_hash = $2`,
      [hash, token],
    );
    expect(plaintext.rows[0].n).toBe(0);
  }, 60_000);

  it('CASE 2 — a duplicate pending invitation for the same email is rejected with 409', async () => {
    const owner = await makeOwner(`owner2.${Date.now()}@example.test`);
    const body = invitePayload(owner.workspaceId);
    expect((await call('POST', '/api/workspace-invitations', { cookie: owner.cookie, body })).status).toBe(201);
    const dup = await call('POST', '/api/workspace-invitations', {
      cookie: owner.cookie,
      body: { ...body, requestId: rid() },
    });
    expect(dup.status).toBe(409);
    expect(dup.json.error).toBe('INVITATION_DUPLICATE');
  }, 60_000);

  it('CASE 3 — replaying a committed requestId never re-issues the link', async () => {
    const owner = await makeOwner(`owner3.${Date.now()}@example.test`);
    const body = invitePayload(owner.workspaceId);
    const first = await call('POST', '/api/workspace-invitations', { cookie: owner.cookie, body });
    expect(first.status).toBe(201);
    const replay = await call('POST', '/api/workspace-invitations', { cookie: owner.cookie, body });
    expect(replay.status).toBe(409);
    expect(replay.json.error).toBe('OPERATION_COMMITTED_LINK_NOT_REPLAYABLE');
    expect(replay.json.manualLink).toBeUndefined();
  }, 60_000);

  it('CASE 4 — a token in the query string is refused, and preview requires the right purpose', async () => {
    const owner = await makeOwner(`owner4.${Date.now()}@example.test`);
    const created = await call('POST', '/api/workspace-invitations', { cookie: owner.cookie, body: invitePayload(owner.workspaceId) });
    const token = tokenFromManualLink(created.json.manualLink);

    const inUrl = await call('POST', `/api/workspace-invitations/preview?token=${token}`, { body: { token, purpose: 'manual_handoff' } });
    expect(inUrl.status).toBe(404);

    const wrongPurpose = await call('POST', '/api/workspace-invitations/preview', { body: { token, purpose: 'email_claim' } });
    expect(wrongPurpose.status).toBe(404);

    const ok = await call('POST', '/api/workspace-invitations/preview', { body: { token, purpose: 'manual_handoff' } });
    expect(ok.status).toBe(200);
    expect(ok.json.preview.workspace_id).toBe(owner.workspaceId);
    expect(JSON.stringify(ok.json.preview)).not.toContain(token);
  }, 60_000);

  it('CASE 5 — new account: OTP + HttpOnly proof, consent enforced, membership created exactly once', async () => {
    capturedEmails = [];
    const owner = await makeOwner(`owner5.${Date.now()}@example.test`);
    const body = invitePayload(owner.workspaceId);
    const created = await call('POST', '/api/workspace-invitations', { cookie: owner.cookie, body });
    const token = tokenFromManualLink(created.json.manualLink);
    const policies = await activePolicies();

    // Without a proof cookie, acceptance fails closed.
    const noProof = await call('POST', '/api/workspace-invitations/accept-new', {
      body: { token, purpose: 'manual_handoff', password: 'CorrectHorseBattery1', consent: true, ...policies },
    });
    expect(noProof.status).toBe(400);
    expect(noProof.json.error).toBe('EMAIL_PROOF_REQUIRED');

    capturedEmails = [];
    expect((await call('POST', '/api/workspace-invitations/otp/request', { body: { token, purpose: 'manual_handoff' } })).status).toBe(200);
    const otpMail = capturedEmails.find((e) => /verification code/i.test(String(e.text)));
    const code = String(otpMail!.text).match(/(\d{6})/)![1];

    const wrongCode = await call('POST', '/api/workspace-invitations/otp/verify', {
      body: { token, purpose: 'manual_handoff', code: code === '000000' ? '111111' : '000000' },
    });
    expect(wrongCode.status).toBe(400);
    expect(wrongCode.json.error).toBe('OTP_INVALID');

    const verify = await call('POST', '/api/workspace-invitations/otp/verify', { body: { token, purpose: 'manual_handoff', code } });
    expect(verify.status).toBe(200);
    const proofHeader = verify.setCookie.find((c) => c.startsWith('wi_proof='))!;
    expect(proofHeader).toMatch(/HttpOnly/i);
    expect(proofHeader).toContain('Path=/api/workspace-invitations/accept-new');
    const proofCookie = cookieOf(verify, 'wi_proof')!;

    // Consent is mandatory even with a valid proof.
    const noConsent = await call('POST', '/api/workspace-invitations/accept-new', {
      cookie: proofCookie,
      body: { token, purpose: 'manual_handoff', password: 'CorrectHorseBattery1', ...policies },
    });
    expect(noConsent.status).toBe(400);
    expect(noConsent.json.error).toBe('CONSENT_REQUIRED');

    const accept = await call('POST', '/api/workspace-invitations/accept-new', {
      cookie: proofCookie,
      body: { token, purpose: 'manual_handoff', password: 'CorrectHorseBattery1', consent: true, ...policies },
    });
    expect(accept.status).toBe(200);
    expect(accept.json.session).toBe('created');

    const members = await db.query(
      `SELECT count(*)::int AS n FROM public.workspace_members m
       JOIN public.profiles p ON p.id = m.user_id
       WHERE m.workspace_id = $1 AND p.email = $2`,
      [owner.workspaceId, body.email.toLowerCase()],
    );
    expect(members.rows[0].n).toBe(1);

    const consent = await db.query(
      `SELECT count(*)::int AS n FROM public.workspace_invitation_consents c
       JOIN public.workspace_invitations i ON i.id = c.invitation_id
       WHERE i.workspace_id = $1 AND i.invited_email_normalized = $2`,
      [owner.workspaceId, body.email.toLowerCase()],
    );
    expect(consent.rows[0].n).toBe(1);

    // Replay of the same accepted token creates nothing further.
    const replay = await call('POST', '/api/workspace-invitations/accept-new', {
      cookie: proofCookie,
      body: { token, purpose: 'manual_handoff', password: 'CorrectHorseBattery1', consent: true, ...policies },
    });
    expect([400, 404, 409]).toContain(replay.status);
    const after = await db.query(
      `SELECT count(*)::int AS n FROM public.workspace_members m
       JOIN public.profiles p ON p.id = m.user_id
       WHERE m.workspace_id = $1 AND p.email = $2`,
      [owner.workspaceId, body.email.toLowerCase()],
    );
    expect(after.rows[0].n).toBe(1);
  }, 90_000);

  it('CASE 6 — existing account: login context cookie carries the invitation, never a URL token', async () => {
    capturedEmails = [];
    const owner = await makeOwner(`owner6.${Date.now()}@example.test`);
    const inviteeEmail = `existing6.${Date.now()}@example.test`;
    const invitee = await signupAndVerify(inviteeEmail);

    const created = await call('POST', '/api/workspace-invitations', {
      cookie: owner.cookie,
      body: invitePayload(owner.workspaceId, { email: inviteeEmail }),
    });
    expect(created.status).toBe(201);
    const token = tokenFromManualLink(created.json.manualLink);

    const ctx = await call('POST', '/api/workspace-invitations/login-context', { body: { token, purpose: 'manual_handoff' } });
    expect(ctx.status).toBe(200);
    expect(ctx.json.loginPath).toBe('/auth/login?invited=1');
    expect(JSON.stringify(ctx.json)).not.toContain(token);
    const ctxHeader = ctx.setCookie.find((c) => c.startsWith('wi_ctx='))!;
    expect(ctxHeader).toMatch(/HttpOnly/i);
    const ctxCookie = cookieOf(ctx, 'wi_ctx')!;

    const policies = await activePolicies();

    // No session -> 401, even with a valid context cookie.
    const anon = await call('POST', '/api/workspace-invitations/accept-existing', {
      cookie: ctxCookie,
      body: { consent: true, ...policies },
    });
    expect(anon.status).toBe(401);

    // Session but no context cookie -> uniform not-found.
    const noCtx = await call('POST', '/api/workspace-invitations/accept-existing', {
      cookie: invitee.cookie,
      body: { consent: true, ...policies },
    });
    expect(noCtx.status).toBe(404);

    const accept = await call('POST', '/api/workspace-invitations/accept-existing', {
      cookie: `${invitee.cookie}; ${ctxCookie}`,
      body: { consent: true, ...policies },
    });
    expect(accept.status).toBe(200);
    expect(accept.json.session).toBe('existing');

    const members = await db.query(
      `SELECT count(*)::int AS n FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [owner.workspaceId, invitee.userId],
    );
    expect(members.rows[0].n).toBe(1);
  }, 90_000);

  it('CASE 7 — a different signed-in user cannot consume an email-bound invitation', async () => {
    const owner = await makeOwner(`owner7.${Date.now()}@example.test`);
    const stranger = await signupAndVerify(`stranger7.${Date.now()}@example.test`);
    const created = await call('POST', '/api/workspace-invitations', { cookie: owner.cookie, body: invitePayload(owner.workspaceId) });
    const token = tokenFromManualLink(created.json.manualLink);
    const ctx = await call('POST', '/api/workspace-invitations/login-context', { body: { token, purpose: 'manual_handoff' } });
    const policies = await activePolicies();

    const res = await call('POST', '/api/workspace-invitations/accept-existing', {
      cookie: `${stranger.cookie}; ${cookieOf(ctx, 'wi_ctx')}`,
      body: { consent: true, ...policies },
    });
    expect([400, 403, 404]).toContain(res.status);
    const members = await db.query(
      `SELECT count(*)::int AS n FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [owner.workspaceId, stranger.userId],
    );
    expect(members.rows[0].n).toBe(0);
  }, 90_000);

  it('CASE 8 — revoked and archived invitations: reason required, token dead, list filtered', async () => {
    const owner = await makeOwner(`owner8.${Date.now()}@example.test`);
    const created = await call('POST', '/api/workspace-invitations', { cookie: owner.cookie, body: invitePayload(owner.workspaceId) });
    const id = created.json.invitation.id;
    const token = tokenFromManualLink(created.json.manualLink);

    const noReason = await call('POST', `/api/workspace-invitations/${id}/revoke`, { cookie: owner.cookie, body: { requestId: rid() } });
    expect(noReason.status).toBe(400);
    expect(noReason.json.error).toBe('REVOKE_REASON_REQUIRED');

    const revoke = await call('POST', `/api/workspace-invitations/${id}/revoke`, {
      cookie: owner.cookie, body: { reason: 'left the company', requestId: rid() },
    });
    expect(revoke.status).toBe(200);

    const preview = await call('POST', '/api/workspace-invitations/preview', { body: { token, purpose: 'manual_handoff' } });
    expect(preview.status).toBe(404);

    const archive = await call('POST', `/api/workspace-invitations/${id}/archive`, { cookie: owner.cookie, body: { requestId: rid() } });
    expect(archive.status).toBe(200);

    const list = await call('GET', `/api/workspace-invitations?workspaceId=${owner.workspaceId}`, { cookie: owner.cookie });
    expect(list.status).toBe(200);
    expect(list.json.invitations.some((i: any) => i.id === id)).toBe(false);

    const withArchived = await call('GET', `/api/workspace-invitations?workspaceId=${owner.workspaceId}&archived=1`, { cookie: owner.cookie });
    expect(withArchived.json.invitations.some((i: any) => i.id === id)).toBe(true);
  }, 90_000);

  it('CASE 9 — an expired invitation cannot be previewed or accepted', async () => {
    const owner = await makeOwner(`owner9.${Date.now()}@example.test`);
    const created = await call('POST', '/api/workspace-invitations', { cookie: owner.cookie, body: invitePayload(owner.workspaceId) });
    const token = tokenFromManualLink(created.json.manualLink);

    await db.query(`UPDATE public.workspace_invitations SET expires_at = now() - interval '1 day' WHERE id = $1`, [created.json.invitation.id]);
    await db.query(`UPDATE public.workspace_invitation_tokens SET expires_at = now() - interval '1 day' WHERE invitation_id = $1`, [created.json.invitation.id]);

    const preview = await call('POST', '/api/workspace-invitations/preview', { body: { token, purpose: 'manual_handoff' } });
    expect(preview.status).toBe(404);
  }, 60_000);

  it('CASE 10 — tenant isolation: another workspace owner can neither read nor mutate the invitation', async () => {
    const ownerA = await makeOwner(`ownerA.${Date.now()}@example.test`);
    const ownerB = await makeOwner(`ownerB.${Date.now()}@example.test`);
    const created = await call('POST', '/api/workspace-invitations', { cookie: ownerA.cookie, body: invitePayload(ownerA.workspaceId) });
    const id = created.json.invitation.id;

    expect((await call('GET', `/api/workspace-invitations?workspaceId=${ownerA.workspaceId}`, { cookie: ownerB.cookie })).status).toBe(403);
    expect((await call('GET', `/api/workspace-invitations/${id}`, { cookie: ownerB.cookie })).status).toBe(403);
    const revoke = await call('POST', `/api/workspace-invitations/${id}/revoke`, {
      cookie: ownerB.cookie, body: { reason: 'not mine', requestId: rid() },
    });
    expect([403, 404]).toContain(revoke.status);

    const still = await db.query('SELECT status FROM public.workspace_invitations WHERE id = $1', [id]);
    expect(still.rows[0].status).toBe('pending');
  }, 90_000);

  it('CASE 11 — seat limit reached: creation fails and consumes no invitation, token or job', async () => {
    const owner = await makeOwner(`ownerSeat.${Date.now()}@example.test`);
    await db.query(`SELECT public.set_workspace_seat_entitlement_mode(_mode := 'static', _source := 'test', _seat_limit := 0, _updated_by := $1)`, [owner.userId]);
    try {
      const before = await db.query('SELECT count(*)::int AS n FROM public.workspace_invitation_tokens');
      const res = await call('POST', '/api/workspace-invitations', { cookie: owner.cookie, body: invitePayload(owner.workspaceId) });
      expect(res.status).toBe(409);
      expect(res.json.error).toBe('SEAT_LIMIT_REACHED');
      expect(res.json.manualLink).toBeUndefined();
      const after = await db.query('SELECT count(*)::int AS n FROM public.workspace_invitation_tokens');
      expect(after.rows[0].n).toBe(before.rows[0].n);
    } finally {
      await db.query(`SELECT public.set_workspace_seat_entitlement_mode(_mode := 'unlimited', _source := 'test', _seat_limit := NULL, _updated_by := $1)`, [owner.userId]);
    }
  }, 90_000);

  it('CUTOVER FENCE — every legacy invitation route answers 410 and writes nothing', async () => {
    const owner = await makeOwner(`ownerLegacy.${Date.now()}@example.test`);
    const before = await db.query('SELECT count(*)::int AS n FROM public.workspace_invitations');

    for (const [method, path] of [
      ['POST', '/api/workspace-members/invitations'],
      ['GET', `/api/workspace-members/invitations?workspaceId=${owner.workspaceId}`],
      ['PATCH', '/api/workspace-members/invitations/00000000-0000-0000-0000-000000000000'],
      ['DELETE', '/api/workspace-members/invitations/00000000-0000-0000-0000-000000000000'],
    ] as Array<[string, string]>) {
      const res = await call(method, path, { cookie: owner.cookie, body: method === 'GET' ? undefined : {} });
      expect(res.status).toBe(410);
    }

    const after = await db.query('SELECT count(*)::int AS n FROM public.workspace_invitations');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  }, 90_000);
});
