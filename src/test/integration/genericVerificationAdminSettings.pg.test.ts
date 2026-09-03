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
import { ALL_VERIFICATION_PURPOSES, getAdminPolicyBaseline } from '../../../server/services/verification/types';

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

/**
 * Every field here is chosen to be at least as strict as EVERY purpose's
 * own baseline (server/services/verification/types.ts's RAW_POLICIES), not
 * just one purpose's — so this fixture stays a valid tightening submission
 * for whichever purpose a test happens to target, now that migration 100
 * rejects a weakening submission from inside the RPC itself. Concretely:
 * rateWindowSeconds/proofTtlSeconds use the tightest extreme across all 8
 * purposes (3600 is the LARGEST baseline rateWindowSeconds — using it
 * satisfies "not smaller than baseline" for every purpose; 180 is the
 * SMALLEST baseline proofTtlSeconds — using it satisfies "not larger than
 * baseline" for every purpose).
 */
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
    rateWindowSeconds: 3600,
    proofTtlSeconds: 180,
    globalRateLimitEnabled: false,
    globalRateLimitMaxPerWindow: null,
    globalRateLimitWindowSeconds: null,
    defaultLocale: 'en',
    locale: 'en',
    ...overrides,
  };
}

/**
 * Calls gv_admin_update_purpose_settings directly (bypassing Express and
 * its per-admin rate limiter entirely) with the same universally-safe
 * tightening values as fullUpdatePayload. Used by tests that are about
 * database/RPC-layer behavior specifically (ledger reclaim, opportunistic
 * purge) rather than the HTTP/Zod/auth layer — calling many of these in a
 * row must never be mistaken for real admin traffic hitting the
 * mutationLimiter (30/min) that fullUpdatePayload's HTTP siblings share
 * across this entire test file.
 */
async function rpcUpdate(purpose: string, requestId: string, expectedRevision = 1, overrides: Partial<Record<string, unknown>> = {}) {
  const p = { ...fullUpdatePayload({ requestId, expectedRevision, ...overrides }) };
  return db.query(
    `SELECT public.gv_admin_update_purpose_settings($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) AS result`,
    [
      p.requestId, purpose, 'update', null, p.expectedRevision, p.adminEnabled, p.otpLength, p.otpTtlSeconds,
      p.maxVerificationAttempts, p.resendCooldownSeconds, p.maxSendsPerWindow, p.rateWindowSeconds, p.proofTtlSeconds,
      p.globalRateLimitEnabled, p.globalRateLimitMaxPerWindow, p.globalRateLimitWindowSeconds, p.defaultLocale,
      null, null, p.locale,
    ],
  );
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

  // NOTE: `db` here is the migration-owning test connection (e.g. `app_test`),
  // NOT the Postgres `service_role` role — migration 099 explicitly denies
  // `service_role` a direct UPDATE on this table (see the ACL test below),
  // so this is an owner-level/raw-SQL bypass, one level of privilege ABOVE
  // what any real application code path (which only ever runs as
  // service_role or through the RPC) could ever reach. It is included
  // because it is the STRONGEST possible bypass this migration set can be
  // tested against: if even an owner-level raw UPDATE cannot flip
  // effectiveEnabled, then service_role (which has less privilege) and the
  // RPC (which enforces the rule in application logic on top of that)
  // certainly cannot either.
  it('an owner-level raw SQL UPDATE flipping admin_enabled=true (bypassing the RPC and even service_role\'s own ACL) still cannot make effectiveEnabled true', async () => {
    await resetSettingsRow('signup_phone');
    await db.query(`UPDATE public.verification_purpose_settings SET admin_enabled = true WHERE purpose = 'signup_phone'`);
    const res = await call('GET', '/api/admin/verification/purposes/signup_phone', 'super-admin-token');
    expect(res.status).toBe(200);
    expect(res.json.gates.adminEnabled).toBe(true);
    expect(res.json.gates.effectiveEnabled).toBe(false);
    await resetSettingsRow('signup_phone');
  });

  it('service_role itself cannot UPDATE verification_purpose_settings directly, but CAN reach the same mutation through the RPC', async () => {
    await resetSettingsRow('change_phone');
    const client = await (db as unknown as { connect(): Promise<any> }).connect();
    try {
      await client.query('SET ROLE service_role');
      await expect(
        client.query(`UPDATE public.verification_purpose_settings SET admin_enabled = true WHERE purpose = 'change_phone'`),
      ).rejects.toThrow(/permission denied/i);

      const rpcResult = await client.query(
        `SELECT public.gv_admin_update_purpose_settings($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) AS result`,
        ['acl-service-role-rpc-001', 'change_phone', 'update', null, 1, false, 6, 200, 5, 60, 5, 3600, 600, false, null, null, 'en', null, null, 'en'],
      );
      expect(rpcResult.rows[0].result.replayed).toBe(false);
      await client.query('RESET ROLE');
    } finally {
      client.release ? client.release() : client.end?.();
    }

    const row = await db.query(`SELECT otp_ttl_seconds, revision FROM public.verification_purpose_settings WHERE purpose = 'change_phone'`);
    expect(row.rows[0].otp_ttl_seconds).toBe(200);
    expect(row.rows[0].revision).toBe(2);
    await resetSettingsRow('change_phone');
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
    const r2 = await call('PUT', '/api/admin/verification/purposes/change_phone', 'super-admin-token', fullUpdatePayload({ requestId, otpTtlSeconds: 200, expectedRevision: 2 }));
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

  // ── Migration 100 hardening: policy-tightening-only enforcement ──────
  const WEAKENING_CASES: Array<{ field: string; purpose: string; weaken: Record<string, unknown> }> = [
    { field: 'otpLength', purpose: 'signup_email', weaken: { otpLength: 5 } },           // baseline 6, submitting less
    { field: 'otpTtlSeconds', purpose: 'signup_email', weaken: { otpTtlSeconds: 700 } },  // baseline 600, submitting more
    { field: 'maxVerificationAttempts', purpose: 'signup_email', weaken: { maxVerificationAttempts: 6 } }, // baseline 5
    { field: 'resendCooldownSeconds', purpose: 'signup_email', weaken: { resendCooldownSeconds: 50 } },    // baseline 60, submitting less
    { field: 'maxSendsPerWindow', purpose: 'password_reset', weaken: { maxSendsPerWindow: 4 } },           // baseline 3 (below the platform ceiling of 5)
    { field: 'rateWindowSeconds', purpose: 'signup_email', weaken: { rateWindowSeconds: 3000 } },          // baseline 3600, submitting less
    { field: 'proofTtlSeconds', purpose: 'signup_email', weaken: { proofTtlSeconds: 700 } },               // baseline 600, submitting more
  ];

  for (const { field, purpose, weaken } of WEAKENING_CASES) {
    it(`weakening ${field} below/above its purpose baseline is rejected with POLICY_WEAKENING_NOT_ALLOWED, with zero residue`, async () => {
      await resetSettingsRow(purpose);
      const requestId = randomUUID();
      const res = await call('PUT', `/api/admin/verification/purposes/${purpose}`, 'super-admin-token', fullUpdatePayload({ requestId, ...weaken }));
      expect(res.status).toBe(400);
      expect(res.json.error).toBe('POLICY_WEAKENING_NOT_ALLOWED');
      const row = await db.query(`SELECT revision FROM public.verification_purpose_settings WHERE purpose=$1`, [purpose]);
      expect(row.rows[0].revision).toBe(1);
      const audit = await db.query(`SELECT count(*)::int AS n FROM public.verification_purpose_settings_audit WHERE purpose=$1`, [purpose]);
      expect(audit.rows[0].n).toBe(0);
      const idem = await db.query(`SELECT count(*)::int AS n FROM public.verification_admin_idempotency WHERE request_id=$1`, [requestId]);
      expect(idem.rows[0].n).toBe(0);
    });
  }

  it('a submission exactly equal to a purpose\'s own baseline is accepted (equal is never a weakening)', async () => {
    // login_step_up's own baseline: otp6, ttl300, attempts5, cooldown45, maxSends5, rateWindow1800, proofTtl300.
    await resetSettingsRow('login_step_up');
    const res = await call('PUT', '/api/admin/verification/purposes/login_step_up', 'super-admin-token', fullUpdatePayload({
      otpLength: 6, otpTtlSeconds: 300, maxVerificationAttempts: 5, resendCooldownSeconds: 45,
      maxSendsPerWindow: 5, rateWindowSeconds: 1800, proofTtlSeconds: 300,
    }));
    expect(res.status).toBe(200);
    expect(res.json.settings.otpTtlSeconds).toBe(300);
  });

  it('a stricter-than-baseline submission is accepted', async () => {
    await resetSettingsRow('workspace_invitation');
    const res = await call('PUT', '/api/admin/verification/purposes/workspace_invitation', 'super-admin-token', fullUpdatePayload());
    expect(res.status).toBe(200);
  });

  it('a Node-layer bypass (direct RPC call, skipping adminSettings.ts entirely) still rejects a weakening submission', async () => {
    await resetSettingsRow('change_email');
    await expect(
      db.query(
        `SELECT public.gv_admin_update_purpose_settings($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        ['bypass-weaken-001', 'change_email', 'update', null, 1, false, 5, 600, 5, 60, 5, 3600, 600, false, null, null, 'en', null, null, 'en'],
      ),
    ).rejects.toThrow(/POLICY_WEAKENING_NOT_ALLOWED/);
    const row = await db.query(`SELECT revision FROM public.verification_purpose_settings WHERE purpose='change_email'`);
    expect(row.rows[0].revision).toBe(1);
  });

  it('the TypeScript baseline (getAdminPolicyBaseline) is identical to the SQL baseline (gv_admin_default_settings) for every purpose', async () => {
    for (const purpose of ALL_VERIFICATION_PURPOSES) {
      const tsBaseline = getAdminPolicyBaseline(purpose);
      const sqlResult = await db.query(`SELECT public.gv_admin_default_settings($1) AS defaults`, [purpose]);
      const sqlBaseline = sqlResult.rows[0].defaults;
      expect(sqlBaseline.otpLength).toBe(tsBaseline.otpLength);
      expect(sqlBaseline.otpTtlSeconds).toBe(tsBaseline.otpTtlSeconds);
      expect(sqlBaseline.maxVerificationAttempts).toBe(tsBaseline.maxVerificationAttempts);
      expect(sqlBaseline.resendCooldownSeconds).toBe(tsBaseline.resendCooldownSeconds);
      expect(sqlBaseline.maxSendsPerWindow).toBe(tsBaseline.maxSendsPerWindow);
      expect(sqlBaseline.rateWindowSeconds).toBe(tsBaseline.rateWindowSeconds);
      expect(sqlBaseline.proofTtlSeconds).toBe(tsBaseline.proofTtlSeconds);
    }
  });

  // ── Migration 100 hardening: concurrency-safe idempotency ────────────
  it('concurrent requests with the SAME requestId and SAME payload result in exactly one mutation, one audit row, and a deterministic replay', async () => {
    await resetSettingsRow('login_step_up');
    const requestId = randomUUID();
    const payload = fullUpdatePayload({ requestId });
    const [r1, r2] = await Promise.all([
      call('PUT', '/api/admin/verification/purposes/login_step_up', 'super-admin-token', payload),
      call('PUT', '/api/admin/verification/purposes/login_step_up', 'super-admin-token', payload),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.json.settings.revision).toBe(2);
    expect(r2.json.settings.revision).toBe(2);
    const row = await db.query(`SELECT revision FROM public.verification_purpose_settings WHERE purpose='login_step_up'`);
    expect(row.rows[0].revision).toBe(2);
    const audit = await db.query(
      `SELECT count(*)::int AS n FROM public.verification_purpose_settings_audit WHERE purpose='login_step_up' AND request_id=$1`,
      [requestId],
    );
    expect(audit.rows[0].n).toBe(1);
  });

  it('concurrent requests with the SAME requestId but DIFFERENT payloads result in exactly one success and one stable ADMIN_REQUEST_CONFLICT', async () => {
    await resetSettingsRow('sensitive_action');
    const requestId = randomUUID();
    const [r1, r2] = await Promise.all([
      call('PUT', '/api/admin/verification/purposes/sensitive_action', 'super-admin-token', fullUpdatePayload({ requestId, otpTtlSeconds: 250 })),
      call('PUT', '/api/admin/verification/purposes/sensitive_action', 'super-admin-token', fullUpdatePayload({ requestId, otpTtlSeconds: 200 })),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
    const conflictRes = r1.status === 409 ? r1 : r2;
    expect(conflictRes.json.error).toBe('ADMIN_REQUEST_CONFLICT');
    const row = await db.query(`SELECT revision FROM public.verification_purpose_settings WHERE purpose='sensitive_action'`);
    expect(row.rows[0].revision).toBe(2); // bumped exactly once, never twice
    const audit = await db.query(
      `SELECT count(*)::int AS n FROM public.verification_purpose_settings_audit WHERE purpose='sensitive_action' AND request_id=$1`,
      [requestId],
    );
    expect(audit.rows[0].n).toBe(1);
  });

  it('a rejected update leaves zero residue, and a retry with a fresh requestId succeeds cleanly', async () => {
    await resetSettingsRow('workspace_invitation');
    const failedRequestId = randomUUID();
    const failRes = await call('PUT', '/api/admin/verification/purposes/workspace_invitation', 'super-admin-token', fullUpdatePayload({ requestId: failedRequestId, otpLength: 5 }));
    expect(failRes.status).toBe(400);
    expect(failRes.json.error).toBe('POLICY_WEAKENING_NOT_ALLOWED');

    const rowAfterFail = await db.query(`SELECT revision FROM public.verification_purpose_settings WHERE purpose='workspace_invitation'`);
    expect(rowAfterFail.rows[0].revision).toBe(1);
    const auditAfterFail = await db.query(`SELECT count(*)::int AS n FROM public.verification_purpose_settings_audit WHERE purpose='workspace_invitation'`);
    expect(auditAfterFail.rows[0].n).toBe(0);
    const idemAfterFail = await db.query(`SELECT count(*)::int AS n FROM public.verification_admin_idempotency WHERE request_id=$1`, [failedRequestId]);
    expect(idemAfterFail.rows[0].n).toBe(0);

    const retryRes = await call('PUT', '/api/admin/verification/purposes/workspace_invitation', 'super-admin-token', fullUpdatePayload());
    expect(retryRes.status).toBe(200);
    expect(retryRes.json.settings.revision).toBe(2);
  });

  // ── Migration 100 hardening: bounded idempotency retention + purge ───
  it('gv_admin_purge_expired_idempotency deletes only expired ledger rows and never touches the audit trail', async () => {
    await resetSettingsRow('signup_phone');
    const requestId = randomUUID();
    const putRes = await call('PUT', '/api/admin/verification/purposes/signup_phone', 'super-admin-token', fullUpdatePayload({ requestId }));
    expect(putRes.status).toBe(200);

    await db.query(`UPDATE public.verification_admin_idempotency SET expires_at = now() - interval '1 day' WHERE request_id = $1`, [requestId]);
    const auditBefore = await db.query(`SELECT count(*)::int AS n FROM public.verification_purpose_settings_audit WHERE purpose='signup_phone'`);

    const purged = await db.query(`SELECT public.gv_admin_purge_expired_idempotency($1) AS n`, [1000]);
    expect(purged.rows[0].n).toBeGreaterThanOrEqual(1);

    const idemAfter = await db.query(`SELECT count(*)::int AS n FROM public.verification_admin_idempotency WHERE request_id=$1`, [requestId]);
    expect(idemAfter.rows[0].n).toBe(0);
    const auditAfter = await db.query(`SELECT count(*)::int AS n FROM public.verification_purpose_settings_audit WHERE purpose='signup_phone'`);
    expect(auditAfter.rows[0].n).toBe(auditBefore.rows[0].n);
  });

  it('gv_admin_purge_expired_idempotency never touches an unexpired row', async () => {
    await resetSettingsRow('signup_email');
    const requestId = randomUUID();
    await call('PUT', '/api/admin/verification/purposes/signup_email', 'super-admin-token', fullUpdatePayload({ requestId }));
    await db.query(`SELECT public.gv_admin_purge_expired_idempotency($1)`, [1000]);
    const idem = await db.query(`SELECT count(*)::int AS n FROM public.verification_admin_idempotency WHERE request_id=$1`, [requestId]);
    expect(idem.rows[0].n).toBe(1);
  });

  it('gv_admin_purge_expired_idempotency clamps an out-of-range _limit instead of erroring', async () => {
    await expect(db.query(`SELECT public.gv_admin_purge_expired_idempotency($1)`, [-5])).resolves.toBeTruthy();
    await expect(db.query(`SELECT public.gv_admin_purge_expired_idempotency($1)`, [0])).resolves.toBeTruthy();
    await expect(db.query(`SELECT public.gv_admin_purge_expired_idempotency($1)`, [999999])).resolves.toBeTruthy();
  });

  it('the table cannot grow without bound purely because nobody calls the purge RPC manually: every successful settings call opportunistically reclaims expired rows', async () => {
    await resetSettingsRow('password_reset');
    await resetSettingsRow('change_email');
    await resetSettingsRow('change_phone');
    const seedIds = [randomUUID(), randomUUID(), randomUUID()];
    const seedPurposes = ['password_reset', 'change_email', 'change_phone'];
    for (let i = 0; i < 3; i++) {
      await rpcUpdate(seedPurposes[i], seedIds[i]);
    }
    await db.query(`UPDATE public.verification_admin_idempotency SET expires_at = now() - interval '1 day' WHERE request_id = ANY($1)`, [seedIds]);
    const beforeCount = await db.query(`SELECT count(*)::int AS n FROM public.verification_admin_idempotency WHERE request_id = ANY($1)`, [seedIds]);
    expect(beforeCount.rows[0].n).toBe(3);

    // A single, UNRELATED successful call — never a manual purge call —
    // must opportunistically reclaim the expired rows above.
    await resetSettingsRow('sensitive_action');
    await rpcUpdate('sensitive_action', randomUUID());

    const afterCount = await db.query(`SELECT count(*)::int AS n FROM public.verification_admin_idempotency WHERE request_id = ANY($1)`, [seedIds]);
    expect(afterCount.rows[0].n).toBe(0);
  });

  // ── Migration 100 hardening: expired ledger rows are reclaimed, not replayed/rejected ──
  it('an expired ledger row for the SAME requestId is reclaimed as a brand-new operation (not replayed, not rejected)', async () => {
    await resetSettingsRow('login_step_up');
    const requestId = randomUUID();
    const first = await rpcUpdate('login_step_up', requestId, 1);
    expect(first.rows[0].result.replayed).toBe(false);
    expect(first.rows[0].result.result.settings.revision).toBe(2);

    await db.query(`UPDATE public.verification_admin_idempotency SET expires_at = now() - interval '1 day' WHERE request_id = $1`, [requestId]);

    const second = await rpcUpdate('login_step_up', requestId, 2, { otpTtlSeconds: 250 });
    expect(second.rows[0].result.replayed).toBe(false); // a REAL new mutation, not a cached replay
    expect(second.rows[0].result.result.settings.revision).toBe(3);
    expect(second.rows[0].result.result.settings.otpTtlSeconds).toBe(250);

    const row = await db.query(`SELECT expires_at FROM public.verification_admin_idempotency WHERE request_id = $1`, [requestId]);
    expect(new Date(row.rows[0].expires_at).getTime()).toBeGreaterThan(Date.now()); // reclaimed row is fresh, not still expired
  });

  // ── Migration 100 hardening: atomicity — settings mutation never survives an audit/ledger failure ──
  it('fault injection: a CHECK-constraint violation on the audit insert (oversized user_agent) rolls back the settings mutation too', async () => {
    await resetSettingsRow('workspace_invitation');
    const oversizedUserAgent = 'x'.repeat(400); // audit table CHECK caps user_agent at 300 chars
    await expect(
      db.query(
        `SELECT public.gv_admin_update_purpose_settings($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        ['fault-inject-ua-001', 'workspace_invitation', 'update', null, 1, false, 6, 300, 4, 90, 3, 3600, 180, false, null, null, 'en', null, oversizedUserAgent, 'en'],
      ),
    ).rejects.toThrow(/user_agent/i);

    const row = await db.query(`SELECT revision FROM public.verification_purpose_settings WHERE purpose='workspace_invitation'`);
    expect(row.rows[0].revision).toBe(1); // the UPDATE that ran earlier in the same function call did NOT survive
    const audit = await db.query(`SELECT count(*)::int AS n FROM public.verification_purpose_settings_audit WHERE purpose='workspace_invitation'`);
    expect(audit.rows[0].n).toBe(0);
    const idem = await db.query(`SELECT count(*)::int AS n FROM public.verification_admin_idempotency WHERE request_id='fault-inject-ua-001'`);
    expect(idem.rows[0].n).toBe(0);
  });

  // ── Purpose-aware editor: baseline exposure ──────────────────────────
  it('GET /purposes/:purpose and GET /purposes both expose the immutable baseline matching getAdminPolicyBaseline', async () => {
    const single = await call('GET', '/api/admin/verification/purposes/sensitive_action', 'super-admin-token');
    expect(single.status).toBe(200);
    const tsBaseline = getAdminPolicyBaseline('sensitive_action');
    expect(single.json.baseline).toEqual(tsBaseline);

    const list = await call('GET', '/api/admin/verification/purposes', 'super-admin-token');
    expect(list.status).toBe(200);
    for (const overview of list.json.purposes) {
      expect(overview.baseline).toEqual(getAdminPolicyBaseline(overview.purpose));
    }
  });
});
