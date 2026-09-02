/**
 * WORKSPACE INVITATIONS v5.1 — shared Section C harness.
 *
 * The concurrency, offboarding, worker-fault and isolation suites all need the
 * same thing the canonical suite already proves out: the FULL self-host
 * migration chain on real PostgreSQL, the REAL Express routers over HTTP and
 * the REAL durable worker. Only two transports are swapped — PostgREST over
 * HTTP becomes a direct query against the same database, and outbound email is
 * captured instead of sent. Nothing about the SQL, the locks, the RLS/ACL
 * decisions or the digests is faked.
 *
 * Each suite declares the `vi.mock` calls itself (mock registration is
 * per-file) and points them at `harnessState`, which this module owns.
 */
import { expect } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import { ensureAuthChainInstalled } from './authStubSchema';
import type { PgQueryable } from './pgMigrationChain';

process.env.INVITATION_LINK_SECRET ||= 'test-invitation-link-secret-value-32b!!';
process.env.INVITATION_OTP_PEPPER ||= 'test-invitation-otp-pepper-value-32bytes';

export type PgTestClient = PgQueryable & { end(): Promise<void> };

export interface CapturedEmail {
  to: string;
  subject?: string;
  text?: string;
  templateSlug?: string;
  actionUrl: string | null;
}

/**
 * Mutable state shared with the per-suite `vi.mock` factories. `emailOutcome`
 * is the fault-injection dial used by the worker suite: 'ok' captures the mail,
 * 'timeout'/'error' return a retryable provider failure and 'unconfigured'
 * returns the stub provider that the worker must treat as terminal.
 */
export const harnessState = {
  db: null as unknown as PgTestClient,
  capturedEmails: [] as CapturedEmail[],
  emailOutcome: 'ok' as 'ok' | 'timeout' | 'error' | 'unconfigured',
};

export function captureEmail(req: any): { success: boolean; provider?: string; error?: string; id?: string } {
  if (harnessState.emailOutcome === 'timeout') {
    return { success: false, provider: 'test-provider', error: 'ETIMEDOUT (injected provider timeout)' };
  }
  if (harnessState.emailOutcome === 'error') {
    return { success: false, provider: 'test-provider', error: 'provider responded 500 (injected)' };
  }
  if (harnessState.emailOutcome === 'unconfigured') {
    return { success: false, provider: 'stub' };
  }
  harnessState.capturedEmails.push({
    to: req.to,
    subject: req.subject,
    text: req.text,
    templateSlug: req.templateSlug,
    actionUrl: req.templateData?.action_url ?? null,
  });
  return { success: true, provider: 'test-provider', id: `msg_${crypto.randomUUID()}` };
}

/** PostgREST-shaped facade over the real connection (transport only). */
export function makePgServiceClient(pg: () => PgTestClient) {
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

    const runSelect = () => pg().query(
      `SELECT ${state.cols} FROM public.${table}${state.wheres.length ? ` WHERE ${state.wheres.join(' AND ')}` : ''}${state.order}${state.limitClause}`,
      state.params,
    );
    const runUpdate = () => {
      const cols = Object.keys(state.patch!);
      const setParams = cols.map((c) => (state.patch as any)[c]);
      const setSql = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
      const shifted = state.wheres.map((w) => w.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + setParams.length}`));
      return pg().query(
        `UPDATE public.${table} SET ${setSql}${shifted.length ? ` WHERE ${shifted.join(' AND ')}` : ''} RETURNING *`,
        [...setParams, ...state.params],
      );
    };
    const runDelete = () => pg().query(
      `DELETE FROM public.${table}${state.wheres.length ? ` WHERE ${state.wheres.join(' AND ')}` : ''} RETURNING *`,
      state.params,
    );
    const runInsert = (rows: Record<string, unknown>[]) => {
      const cols = Object.keys(rows[0]);
      const params: unknown[] = [];
      const values = rows.map((row) => `(${cols.map((c) => { params.push((row as any)[c]); return `$${params.length}`; }).join(', ')})`);
      return pg().query(`INSERT INTO public.${table} (${cols.join(', ')}) VALUES ${values.join(', ')} RETURNING *`, params);
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

  async function rpc(name: string, args: Record<string, unknown> = {}) {
    const keys = Object.keys(args);
    const argList = keys.map((k, i) => `${k} := $${i + 1}`).join(', ');
    const values = keys.map((k) => args[k]);
    try {
      const shape = await pg().query(
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
        const r = await pg().query(`SELECT * FROM public.${name}(${argList})`, values);
        return { data: retset ? r.rows : (r.rows[0] ?? null), error: null };
      }
      const r = await pg().query(`SELECT public.${name}(${argList}) AS result`, values);
      return { data: r.rows[0]?.result ?? null, error: null };
    } catch (e: any) {
      return { data: null, error: { message: e.message, code: e.code } };
    }
  }

  return { from, rpc };
}

export interface Res { status: number; json: any; setCookie: string[] }

export interface Harness {
  db: PgTestClient;
  baseUrl: string;
  call(method: string, path: string, opts?: { body?: unknown; cookie?: string; addr?: string }): Promise<Res>;
  cookieOf(res: Res, name: string): string | null;
  rid(): string;
  freshAddr(): string;
  signupAndVerify(email: string): Promise<{ cookie: string; userId: string }>;
  makeOwner(email: string): Promise<{ cookie: string; userId: string; workspaceId: string }>;
  invitePayload(workspaceId: string, over?: Record<string, unknown>): Record<string, unknown>;
  tokenFromManualLink(link: string): string;
  activePolicies(): Promise<{ termsVersionId?: string; privacyVersionId?: string }>;
  drainOutbox(): Promise<void>;
  otpCodeFor(email: string): Promise<string>;
  countOf(sql: string, params?: unknown[]): Promise<number>;
  one(sql: string, params?: unknown[]): Promise<Record<string, any> | undefined>;
  rows(sql: string, params?: unknown[]): Promise<Array<Record<string, any>>>;
  /**
   * Deterministic concurrency barrier. A control connection holds the SAME row
   * lock the production code path takes, the callers are started, the harness
   * WAITS for the database to report exactly `expected` sessions blocked on a
   * lock, and only then commits. No timing-only sleep decides the interleaving.
   */
  raceUnderLock<T>(lock: { sql: string; params?: unknown[] }, expected: number, start: () => Promise<T>[]): Promise<T[]>;
  workerConfig: any;
  stop(): Promise<void>;
}

export const WORKER_CONFIG: any = {
  supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', supabaseAnonKey: 'k',
  corsOrigins: [], port: 0, rateLimitWindowMs: 60_000, rateLimitMax: 100_000,
  selfHostBillingUnlimited: true,
};

/** Boots the schema, the Express app and the helper surface. */
export async function startHarness(dsn: string): Promise<Harness> {
  const { Pool } = await import('pg');
  const db = new Pool({ connectionString: dsn, max: 16 }) as unknown as PgTestClient;
  harnessState.db = db;

  await db.query('DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS auth CASCADE; CREATE SCHEMA public;');
  await ensureAuthChainInstalled(db);
  await db.query(`SELECT public.set_workspace_seat_entitlement_mode(_mode := 'self_host_unlimited', _source := 'test_bootstrap')`);

  const { authSecurityRouter } = await import('../../../server/routes/auth.js');
  const { authEmailRouter } = await import('../../../server/routes/auth-email.js');
  const { workspacesRouter } = await import('../../../server/routes/workspaces.js');
  const { workspaceMembersRouter } = await import('../../../server/routes/workspaceMembers.js');
  const { workspaceInvitationsRouter } = await import('../../../server/routes/workspaceInvitations.js');

  let baseUrl = '';
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

  const server = http.createServer(app).listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;

  let addrSeq = 1;
  let clientAddr = '127.0.0.1';
  const freshAddr = () => {
    addrSeq += 1;
    clientAddr = `127.0.0.${(addrSeq % 250) + 2}`;
    return clientAddr;
  };

  function call(method: string, path: string, opts: { body?: unknown; cookie?: string; addr?: string } = {}): Promise<Res> {
    const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    return new Promise((resolve, reject) => {
      const req = http.request(
        `${baseUrl}${path}`,
        {
          method,
          localAddress: opts.addr || clientAddr,
          family: 4,
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

  async function rows(sql: string, params: unknown[] = []) {
    const r = await db.query(sql, params);
    return r.rows as Array<Record<string, any>>;
  }
  const one = async (sql: string, params: unknown[] = []) => (await rows(sql, params))[0];
  const countOf = async (sql: string, params: unknown[] = []) => Number((await one(sql, params))!.n);

  async function signupAndVerify(email: string) {
    const signup = await call('POST', '/api/auth/signup', {
      body: { email, password: 'CorrectHorseBattery1', fullName: 'Invite Test User' },
    });
    expect(signup.status, JSON.stringify(signup.json)).toBe(200);
    let sent: CapturedEmail | undefined;
    for (let i = 0; i < 200 && !sent; i += 1) {
      sent = harnessState.capturedEmails.find(
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
    const profile = await one('SELECT id FROM public.profiles WHERE lower(email) = lower($1)', [email]);
    return { cookie, userId: String(profile!.id) };
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

  function tokenFromManualLink(link: string): string {
    const url = new URL(link);
    expect(url.search).toBe('');
    const params = new URLSearchParams(url.hash.slice(1));
    return params.get('token')!;
  }

  async function activePolicies() {
    const list = await rows(
      `SELECT policy_type, id FROM public.legal_policy_versions WHERE is_active = true AND effective_from <= now()`,
    );
    const pick = (t: string) => list.find((r) => r.policy_type === t)?.id;
    return { termsVersionId: pick('terms'), privacyVersionId: pick('privacy') };
  }

  async function drainOutbox(): Promise<void> {
    const { drainInvitationJobs } = await import('../../../server/services/invitations/worker.js');
    for (let i = 0; i < 20; i += 1) {
      const n = await countOf(
        `SELECT count(*)::int AS n FROM public.workspace_invitation_jobs WHERE status IN ('queued','retrying') AND available_at <= now()`,
      );
      if (!n) return;
      await drainInvitationJobs(WORKER_CONFIG);
    }
  }

  async function otpCodeFor(email: string): Promise<string> {
    let hit: CapturedEmail | undefined;
    for (let i = 0; i < 100 && !hit; i += 1) {
      await drainOutbox();
      hit = harnessState.capturedEmails.find(
        (e) => e.to?.toLowerCase() === email.toLowerCase() && /verification code/i.test(String(e.text)),
      );
      if (!hit) await new Promise((r) => setTimeout(r, 20));
    }
    expect(hit, `no OTP email captured for ${email}`).toBeTruthy();
    return String(hit!.text).match(/(\d{6})/)![1];
  }

  async function raceUnderLock<T>(
    lock: { sql: string; params?: unknown[] },
    expected: number,
    start: () => Promise<T>[],
  ): Promise<T[]> {
    const { Client } = await import('pg');
    const ctl = new Client({ connectionString: dsn });
    await ctl.connect();
    try {
      await ctl.query('BEGIN');
      await ctl.query(lock.sql, lock.params ?? []);

      const pending = start();

      // Deterministic barrier: wait until the database itself reports that
      // `expected` other sessions are blocked behind the held lock. This is a
      // state condition, not a fixed delay.
      const deadline = Date.now() + 60_000;
      for (;;) {
        const blocked = await countOf(
          `SELECT count(*)::int AS n
             FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
              AND pid <> pg_backend_pid()`,
        );
        if (blocked >= expected) break;
        if (Date.now() > deadline) {
          throw new Error(`concurrency barrier timed out: ${blocked}/${expected} sessions blocked on the lock`);
        }
        await new Promise((r) => setTimeout(r, 25));
      }

      await ctl.query('COMMIT');
      return await Promise.all(pending);
    } finally {
      await ctl.end().catch(() => undefined);
    }
  }

  return {
    db, baseUrl, call, cookieOf, rid, freshAddr, signupAndVerify, makeOwner, invitePayload,
    tokenFromManualLink, activePolicies, drainOutbox, otpCodeFor, countOf, one, rows,
    raceUnderLock, workerConfig: WORKER_CONFIG,
    async stop() {
      server.close();
      await db.query('DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS auth CASCADE; CREATE SCHEMA public;');
      await ensureAuthChainInstalled(db);
      await db.end();
    },
  };
}
