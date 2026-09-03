/**
 * Generic Verification Core — Super Admin settings/audit/readiness, real
 * PostgreSQL + real Express admin router acceptance suite.
 *
 * Real Postgres (the full self-host migration chain, including 098 and
 * 099) + the REAL `adminRouter` (server/routes/admin.ts, which mounts the
 * real `adminVerificationRouter`) over real HTTP. Only the session/role
 * resolution layer is swapped (validateSessionToken/isGlobalAdmin/
 * verifyOriginForMutation) — exactly like
 * src/test/security/adminManagementRoutes.test.ts already does for other
 * admin routes — everything below that (routing, Zod validation, the
 * settings service, the RPC, the CHECK constraints, the audit trail) is
 * the real, unmodified code path.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import { ensureAuthChainInstalled } from './authStubSchema';
import type { PgQueryable } from './pgMigrationChain';

const DSN = process.env.TEST_DATABASE_URL || process.env.CLEAN_INSTALL_DATABASE_URL;
if (!DSN && process.env.REQUIRE_GV_DB === '1') {
  throw new Error('REQUIRE_GV_DB=1 but neither TEST_DATABASE_URL nor CLEAN_INSTALL_DATABASE_URL is set.');
}
const suite = DSN ? describe : describe.skip;

type PgTestClient = PgQueryable & { end(): Promise<void>; connect?(): Promise<any> };
let db: PgTestClient;

const emailSendMock = vi.fn();
const platformEmailSendMock = vi.fn();
const smsSendMock = vi.fn();
vi.mock('../../../server/services/email/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/email/index.js')>();
  return { ...actual, sendEmail: (...a: unknown[]) => emailSendMock(...a), sendPlatformEmail: (...a: unknown[]) => platformEmailSendMock(...a) };
});
vi.mock('../../../server/services/sms/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/sms/index.js')>();
  return { ...actual, sendSms: (...a: unknown[]) => smsSendMock(...a) };
});

function makePgServiceClient(pg: PgTestClient) {
  function from(table: string) {
    const state: { cols: string; wheres: string[]; params: unknown[]; order?: string; asc: boolean; lim?: number } = { cols: '*', wheres: [], params: [], asc: true };
    const addParam = (v: unknown) => { state.params.push(v); return state.params.length; };
    const run = async () => {
      const where = state.wheres.length ? ` WHERE ${state.wheres.join(' AND ')}` : '';
      const order = state.order ? ` ORDER BY ${state.order} ${state.asc ? 'ASC' : 'DESC'}` : '';
      const lim = state.lim ? ` LIMIT ${state.lim}` : '';
      return pg.query(`SELECT ${state.cols} FROM public.${table}${where}${order}${lim}`, state.params);
    };
    const builder: any = {
      select(cols?: string) { state.cols = cols || '*'; return builder; },
      eq(col: string, val: unknown) { state.wheres.push(`${col} = $${addParam(val)}`); return builder; },
      lt(col: string, val: unknown) { state.wheres.push(`${col} < $${addParam(val)}`); return builder; },
      order(col: string, opts?: { ascending?: boolean }) { state.order = col; state.asc = opts?.ascending !== false; return builder; },
      limit(n: number) { state.lim = n; return builder; },
      maybeSingle: async () => {
        try { const r = await run(); return { data: r.rows[0] ?? null, error: null }; }
        catch (e: any) { return { data: null, error: { message: e.message, code: e.code } }; }
      },
      then: (resolve: any) => run().then((r) => resolve({ data: r.rows, error: null })).catch((e: any) => resolve({ data: null, error: { message: e.message } })),
    };
    return builder;
  }

  async function rpc(name: string, args: Record<string, unknown>) {
    try {
      switch (name) {
        case 'gv_admin_update_purpose_settings': {
          const r = await pg.query(
            `SELECT public.gv_admin_update_purpose_settings($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) AS result`,
            [
              args._request_id, args._purpose, args._action, args._actor_profile_id, args._expected_revision, args._admin_enabled,
              args._otp_length, args._otp_ttl_seconds, args._max_verification_attempts, args._resend_cooldown_seconds,
              args._max_sends_per_window, args._rate_window_seconds, args._proof_ttl_seconds, args._global_rate_limit_enabled,
              args._global_rate_limit_max_per_window, args._global_rate_limit_window_seconds, args._default_locale,
              args._ip_hash, args._user_agent, args._locale,
            ],
          );
          return { data: r.rows[0].result, error: null };
        }
        case 'gv_admin_consumer_implemented':
        case 'gv_admin_deployment_allowlisted':
        case 'gv_is_purpose_enabled':
        case 'gv_admin_effective_enabled': {
          const r = await pg.query(`SELECT public.${name}($1) AS result`, [args._purpose]);
          return { data: r.rows[0].result, error: null };
        }
        default:
          return { data: null, error: { message: `unhandled rpc in test adapter: ${name}` } };
      }
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

const SUPER_ADMIN = randomUUID();
const WORKSPACE_ADMIN = randomUUID();
let sessions: Record<string, string> = {};
let admins: Set<string> = new Set();

vi.mock('../../../server/middleware/adminBypass.js', () => ({
  isGlobalAdmin: async (_c: unknown, userId: string) => admins.has(userId),
}));
vi.mock('../../../server/services/auth/sessions.js', () => ({
  SESSION_COOKIE_NAME: 'gs_session',
  validateSessionToken: async (_config: unknown, token: string | undefined) => {
    if (!token) return null;
    const userId = sessions[token];
    return userId ? { sessionId: 's1', userId, email: 'x@example.test' } : null;
  },
  verifyOriginForMutation: () => true,
}));

const { adminRouter } = await import('../../../server/routes/admin.js');
const { __setPurposePolicyOverrideForTests, __clearAllPurposePolicyOverridesForTests } = await import('../../../server/services/verification/types');

const app = express();
app.use((req, _res, next) => {
  (req as any).serverConfig = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: ['*'] };
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use('/api/admin', adminRouter);
const server = http.createServer(app).listen(0);
const port = () => (server.address() as any).port;

function call(method: string, path: string, token: string | null, body?: unknown): Promise<{ status: number; json: any }> {
  const payload = body === undefined ? null : JSON.stringify(body);
  const headers: Record<string, string> = {};
  if (token) headers.cookie = `gs_session=${token}`;
  if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = String(Buffer.byteLength(payload)); }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: port(), path, method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let json: any = {};
        try { json = JSON.parse(d || '{}'); } catch { json = { raw: d }; }
        resolve({ status: res.statusCode || 0, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

beforeAll(async () => {
  if (!DSN) return;
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: DSN, max: 5 });
  db = pool as unknown as PgTestClient;
  await ensureAuthChainInstalled(db);
  // gv_admin_update_purpose_settings FK-references profiles(id) for
  // updated_by/actor_profile_id, so the fake admin identities used by the
  // session-token mocks below need a real profiles row to satisfy it.
  await db.query(
    `INSERT INTO public.profiles (id, email) VALUES ($1, $2), ($3, $4) ON CONFLICT (id) DO NOTHING`,
    [SUPER_ADMIN, 'super-admin@example.test', WORKSPACE_ADMIN, 'workspace-admin@example.test'],
  );
}, 180_000);

afterAll(async () => {
  if (db) {
    await db.query(`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS auth CASCADE; CREATE SCHEMA public;`);
    await ensureAuthChainInstalled(db);
    await db.end();
  }
});

beforeEach(() => {
  sessions = { 'super-admin-token': SUPER_ADMIN, 'workspace-admin-token': WORKSPACE_ADMIN };
  admins = new Set([SUPER_ADMIN]);
  emailSendMock.mockReset();
  platformEmailSendMock.mockReset();
  smsSendMock.mockReset();
  __clearAllPurposePolicyOverridesForTests();
});

async function resetSettingsRow(purpose: string) {
  await db.query(
    `UPDATE public.verification_purpose_settings SET admin_enabled=false, otp_length=6, otp_ttl_seconds=600, max_verification_attempts=5,
       resend_cooldown_seconds=60, max_sends_per_window=5, rate_window_seconds=3600, proof_ttl_seconds=600,
       global_rate_limit_enabled=false, global_rate_limit_max_per_window=NULL, global_rate_limit_window_seconds=NULL,
       default_locale='en', revision=1, updated_by=NULL WHERE purpose=$1`,
    [purpose],
  );
  await db.query(`DELETE FROM public.verification_admin_idempotency WHERE purpose = $1`, [purpose]);
  await db.query(`DELETE FROM public.verification_purpose_settings_audit WHERE purpose = $1`, [purpose]);
}

function fullUpdatePayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    requestId: randomUUID(),
    expectedRevision: 1,
    adminEnabled: false,
    otpLength: 6,
    otpTtlSeconds: 300,
    maxVerificationAttempts: 4,
    resendCooldownSeconds: 90,
    maxSendsPerWindow: 3,
    rateWindowSeconds: 1800,
    proofTtlSeconds: 300,
    globalRateLimitEnabled: false,
    globalRateLimitMaxPerWindow: null,
    globalRateLimitWindowSeconds: null,
    defaultLocale: 'en',
    locale: 'en',
    ...overrides,
  };
}

suite('Generic Verification Core — Super Admin settings (real PostgreSQL + real Express admin router)', () => {
  // ── Authorization ────────────────────────────────────────────────────
  it('unauthenticated requests are rejected on every route', async () => {
    expect((await call('GET', '/api/admin/verification/overview', null)).status).toBe(401);
    expect((await call('GET', '/api/admin/verification/purposes', null)).status).toBe(401);
    expect((await call('PUT', '/api/admin/verification/purposes/signup_email', null, fullUpdatePayload())).status).toBe(401);
    expect((await call('POST', '/api/admin/verification/purposes/signup_email/reset', null, { requestId: randomUUID(), expectedRevision: 1, locale: 'en' })).status).toBe(401);
    expect((await call('GET', '/api/admin/verification/audit', null)).status).toBe(401);
    expect((await call('POST', '/api/admin/verification/templates/preview', null, { locale: 'en' })).status).toBe(401);
  });

  it('an authenticated caller who is NOT a platform Super Admin (e.g. a workspace owner/admin) is rejected with 403 on every route', async () => {
    const token = 'workspace-admin-token';
    expect((await call('GET', '/api/admin/verification/overview', token)).status).toBe(403);
    expect((await call('GET', '/api/admin/verification/purposes', token)).status).toBe(403);
    expect((await call('GET', '/api/admin/verification/purposes/signup_email', token)).status).toBe(403);
    expect((await call('PUT', '/api/admin/verification/purposes/signup_email', token, fullUpdatePayload())).status).toBe(403);
    expect((await call('POST', '/api/admin/verification/purposes/signup_email/reset', token, { requestId: randomUUID(), expectedRevision: 1, locale: 'en' })).status).toBe(403);
    expect((await call('GET', '/api/admin/verification/audit', token)).status).toBe(403);
  });

  it('a real platform Super Admin can read the overview', async () => {
    const res = await call('GET', '/api/admin/verification/overview', 'super-admin-token');
    expect(res.status).toBe(200);
    expect(res.json.purposes).toHaveLength(8);
    expect(res.json.readiness.databaseAvailable).toBe(true);
  });

  // ── Non-negotiable dormancy ──────────────────────────────────────────
  it('every purpose is reported effectively disabled, unconditionally, in this pass', async () => {
    const res = await call('GET', '/api/admin/verification/purposes', 'super-admin-token');
    expect(res.status).toBe(200);
    for (const p of res.json.purposes) {
      expect(p.gates.effectiveEnabled).toBe(false);
      expect(p.gates.consumerImplemented).toBe(false);
      expect(p.gates.deploymentAllowlisted).toBe(false);
    }
  });

  it('attempting to set adminEnabled=true is rejected with PURPOSE_NOT_DEPLOYED, and settings are left unchanged', async () => {
    await resetSettingsRow('signup_email');
    const res = await call('PUT', '/api/admin/verification/purposes/signup_email', 'super-admin-token', fullUpdatePayload({ adminEnabled: true }));
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('PURPOSE_NOT_DEPLOYED');
    const row = await db.query(`SELECT admin_enabled, revision FROM public.verification_purpose_settings WHERE purpose='signup_email'`);
    expect(row.rows[0].admin_enabled).toBe(false);
    expect(row.rows[0].revision).toBe(1);
  });

  it('a direct service-role write flipping admin_enabled=true (bypassing the RPC entirely) still cannot make effectiveEnabled true', async () => {
    await resetSettingsRow('signup_phone');
    await db.query(`UPDATE public.verification_purpose_settings SET admin_enabled = true WHERE purpose = 'signup_phone'`);
    const res = await call('GET', '/api/admin/verification/purposes/signup_phone', 'super-admin-token');
    expect(res.status).toBe(200);
    expect(res.json.gates.adminEnabled).toBe(true);
    expect(res.json.gates.effectiveEnabled).toBe(false);
    await resetSettingsRow('signup_phone');
  });

  // ── Validation / ceilings ────────────────────────────────────────────
  it('a value outside the platform ceiling is rejected with VALIDATION_FAILED before ever reaching the database', async () => {
    await resetSettingsRow('password_reset');
    const res = await call('PUT', '/api/admin/verification/purposes/password_reset', 'super-admin-token', fullUpdatePayload({ otpTtlSeconds: 99999 }));
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('VALIDATION_FAILED');
    const row = await db.query(`SELECT revision FROM public.verification_purpose_settings WHERE purpose='password_reset'`);
    expect(row.rows[0].revision).toBe(1);
  });

  it('a resend_cooldown_seconds below the platform floor is rejected', async () => {
    await resetSettingsRow('password_reset');
    const res = await call('PUT', '/api/admin/verification/purposes/password_reset', 'super-admin-token', fullUpdatePayload({ resendCooldownSeconds: 5 }));
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('VALIDATION_FAILED');
  });

  // ── Optimistic concurrency ───────────────────────────────────────────
  it('a stale expectedRevision is rejected with REVISION_CONFLICT', async () => {
    await resetSettingsRow('login_step_up');
    const first = await call('PUT', '/api/admin/verification/purposes/login_step_up', 'super-admin-token', fullUpdatePayload());
    expect(first.status).toBe(200);
    expect(first.json.settings.revision).toBe(2);

    const stale = await call('PUT', '/api/admin/verification/purposes/login_step_up', 'super-admin-token', fullUpdatePayload({ expectedRevision: 1 }));
    expect(stale.status).toBe(409);
    expect(stale.json.error).toBe('REVISION_CONFLICT');
  });

  // ── requestId idempotency ────────────────────────────────────────────
  it('replaying the SAME requestId with the SAME payload returns the identical cached result', async () => {
    await resetSettingsRow('change_email');
    const payload = fullUpdatePayload();
    const r1 = await call('PUT', '/api/admin/verification/purposes/change_email', 'super-admin-token', payload);
    expect(r1.status).toBe(200);
    const r2 = await call('PUT', '/api/admin/verification/purposes/change_email', 'super-admin-token', payload);
    expect(r2.status).toBe(200);
    expect(r2.json.settings.revision).toBe(r1.json.settings.revision);
    const row = await db.query(`SELECT revision FROM public.verification_purpose_settings WHERE purpose='change_email'`);
    expect(row.rows[0].revision).toBe(2); // NOT bumped a second time
  });

  it('reusing the SAME requestId with a DIFFERENT payload is rejected with ADMIN_REQUEST_CONFLICT', async () => {
    await resetSettingsRow('change_phone');
    const requestId = randomUUID();
    const r1 = await call('PUT', '/api/admin/verification/purposes/change_phone', 'super-admin-token', fullUpdatePayload({ requestId }));
    expect(r1.status).toBe(200);
    const r2 = await call('PUT', '/api/admin/verification/purposes/change_phone', 'super-admin-token', fullUpdatePayload({ requestId, otpLength: 5, expectedRevision: 2 }));
    expect(r2.status).toBe(409);
    expect(r2.json.error).toBe('ADMIN_REQUEST_CONFLICT');
  });

  // ── Atomic update + audit ────────────────────────────────────────────
  it('a successful update writes exactly one audit row with sanitized before/after settings', async () => {
    await resetSettingsRow('sensitive_action');
    const res = await call('PUT', '/api/admin/verification/purposes/sensitive_action', 'super-admin-token', fullUpdatePayload({ otpTtlSeconds: 120 }));
    expect(res.status).toBe(200);
    const audit = await db.query(`SELECT action, previous_settings, new_settings, actor_profile_id FROM public.verification_purpose_settings_audit WHERE purpose='sensitive_action'`);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].action).toBe('update');
    expect(audit.rows[0].new_settings.otpTtlSeconds).toBe(120);
    expect(audit.rows[0].actor_profile_id).toBe(SUPER_ADMIN);
    // Never a secret in the sanitized settings.
    const serialized = JSON.stringify(audit.rows[0]);
    expect(serialized).not.toMatch(/pepper/i);
  });

  it('reset restores platform defaults, forces adminEnabled back to false, and is independently audited', async () => {
    await resetSettingsRow('workspace_invitation');
    await call('PUT', '/api/admin/verification/purposes/workspace_invitation', 'super-admin-token', fullUpdatePayload({ otpTtlSeconds: 120 }));
    const res = await call('POST', '/api/admin/verification/purposes/workspace_invitation/reset', 'super-admin-token', { requestId: randomUUID(), expectedRevision: 2, locale: 'en' });
    expect(res.status).toBe(200);
    expect(res.json.settings.otpTtlSeconds).toBe(600);
    expect(res.json.settings.adminEnabled).toBe(false);
    const audit = await db.query(`SELECT action FROM public.verification_purpose_settings_audit WHERE purpose='workspace_invitation' ORDER BY created_at`);
    expect(audit.rows.map((r: any) => r.action)).toEqual(['update', 'reset']);
  });

  it('GET /audit returns rows filterable by purpose', async () => {
    await resetSettingsRow('signup_email');
    await call('PUT', '/api/admin/verification/purposes/signup_email', 'super-admin-token', fullUpdatePayload());
    const res = await call('GET', '/api/admin/verification/audit?purpose=signup_email', 'super-admin-token');
    expect(res.status).toBe(200);
    expect(res.json.rows.length).toBeGreaterThanOrEqual(1);
    expect(res.json.rows.every((r: any) => r.purpose === 'signup_email')).toBe(true);
  });

  // ── Template preview: no send, no challenge ──────────────────────────
  it('template preview renders a fixed fake code, calls no provider, and creates no challenge row', async () => {
    const before = await db.query(`SELECT count(*)::int AS n FROM public.verification_challenges`);
    const res = await call('POST', '/api/admin/verification/templates/preview', 'super-admin-token', { locale: 'en' });
    expect(res.status).toBe(200);
    expect(res.json.email.text).toContain('123456');
    expect(res.json.sms.text).toContain('123456');
    const after = await db.query(`SELECT count(*)::int AS n FROM public.verification_challenges`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(emailSendMock).not.toHaveBeenCalled();
    expect(platformEmailSendMock).not.toHaveBeenCalled();
    expect(smsSendMock).not.toHaveBeenCalled();
  });

  it('template preview never leaks a secret in its response', async () => {
    const res = await call('POST', '/api/admin/verification/templates/preview', 'super-admin-token', { locale: 'fa' });
    const serialized = JSON.stringify(res.json);
    expect(serialized).not.toMatch(/pepper/i);
    expect(serialized.includes(process.env.GENERIC_VERIFICATION_PEPPER || '###')).toBe(false);
  });

  // ── ACL: tables and RPC, independent of the HTTP layer ───────────────
  it('anon/authenticated cannot SELECT verification_purpose_settings or verification_purpose_settings_audit', async () => {
    const client = await (db as unknown as { connect(): Promise<any> }).connect();
    try {
      await client.query('SET ROLE authenticated');
      await expect(client.query('SELECT * FROM public.verification_purpose_settings LIMIT 1')).rejects.toThrow();
      await expect(client.query('SELECT * FROM public.verification_purpose_settings_audit LIMIT 1')).rejects.toThrow();
      await client.query('RESET ROLE');
    } finally {
      client.release ? client.release() : client.end?.();
    }
  });

  it('anon/authenticated cannot execute gv_admin_update_purpose_settings directly', async () => {
    const client = await (db as unknown as { connect(): Promise<any> }).connect();
    try {
      await client.query('SET ROLE authenticated');
      await expect(
        client.query(
          `SELECT public.gv_admin_update_purpose_settings($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
          ['req-acl-1', 'signup_email', 'update', null, 1, true, 6, 300, 4, 90, 3, 1800, 300, false, null, null, 'en', null, null, 'en'],
        ),
      ).rejects.toThrow();
      await client.query('RESET ROLE');
    } finally {
      client.release ? client.release() : client.end?.();
    }
  });
});
