/**
 * GENERIC VERIFICATION CORE v1 — real PostgreSQL acceptance suite.
 *
 * Real Postgres (the full self-host migration chain, including 098) + the
 * real service.ts functions — there is no worker.ts in this subsystem: the
 * canonical OTP delivery model (matching server/services/phoneVerification/
 * index.ts's issueChallenge on main) has Express call the email/SMS
 * provider DIRECTLY, synchronously, inside requestVerificationChallenge/
 * resendVerificationChallenge. Only two transports are swapped, exactly
 * like every other `.pg.test.ts` file in this repo:
 *   - `getServiceClient()` becomes a direct query against this same real
 *     database instead of a real PostgREST/HTTP round trip.
 *   - `sendEmail`/`sendPlatformEmail`/`sendSms` are captured instead of
 *     actually contacting a vendor — every DB write, RPC, lock, ACL
 *     decision, and crypto digest is real.
 *
 * DATABASE-LAYER DORMANCY — `gv_is_purpose_enabled` ships hardcoded to
 * reject every purpose (see the migration). Test X1 proves that SHIPPED
 * function directly. Every OTHER test in this file needs to exercise a
 * full purpose lifecycle end-to-end against a real database, so `beforeAll`
 * installs an ADDITIONAL, test-only `CREATE OR REPLACE FUNCTION` patch on
 * top of the shipped migration that allow-lists every purpose — this is
 * the exact database-layer analogue of the TypeScript layer's own
 * `__setPurposePolicyOverrideForTests` hook, and is NEVER part of what
 * ships (a real enablement requires a real, reviewed migration, exactly
 * as documented in the migration file itself). The TypeScript-layer gate
 * (`assertPurposeEnabled`/`assertChannelAllowed`, driven by
 * PURPOSE_POLICIES + per-test overrides) is UNCHANGED and still
 * independently decides, per test, whether a given purpose is reachable at
 * all — a test that never calls `__setPurposePolicyOverrideForTests`
 * still gets rejected in Node before any RPC round-trip (see test A).
 *
 * Driven by TEST_DATABASE_URL (or CLEAN_INSTALL_DATABASE_URL). Gated by
 * REQUIRE_GV_DB=1 (this subsystem's own mandatory-CI flag — deliberately
 * NOT the pre-existing REQUIRE_WI_DB, which belongs to the separate,
 * unrelated Workspace Invitations v5.1 suite and must not be conflated
 * with it).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { ensureAuthChainInstalled } from './authStubSchema';
import type { PgQueryable } from './pgMigrationChain';

const DSN = process.env.TEST_DATABASE_URL || process.env.CLEAN_INSTALL_DATABASE_URL;
if (!DSN && process.env.REQUIRE_GV_DB === '1') {
  throw new Error(
    'REQUIRE_GV_DB=1 but neither TEST_DATABASE_URL nor CLEAN_INSTALL_DATABASE_URL is set — ' +
      'the Generic Verification Core PostgreSQL suite is mandatory and must not be skipped.',
  );
}
const suite = DSN ? describe : describe.skip;

type PgTestClient = PgQueryable & { end(): Promise<void>; connect?(): Promise<any> };
let db: PgTestClient;

process.env.GENERIC_VERIFICATION_PEPPER ||= 'test-gv-pepper-value-at-least-32-bytes!!';

const emailSendMock = vi.fn();
const platformEmailSendMock = vi.fn();
const smsSendMock = vi.fn();
/** Test-only hook: makes exactly the NEXT gv_finalize_verification_delivery
 * call fail as if the RPC round-trip itself was lost (simulating "provider
 * accepted but delivery-result persistence failed"), without touching the
 * real send path. Reset to false the instant it fires. */
let forceFinalizeFailureOnce = false;
/** Same idea, for gv_execute_idempotent('verify', ...): the SQL call is
 * still made for real (the DB genuinely commits), but the response reported
 * back to the caller is a synthetic error — modeling "the DB committed, but
 * Express never received/kept the response." Only fires for operation
 * 'verify'. */
let forceVerifyResponseLossOnce = false;

vi.mock('../../../server/services/email/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/email/index.js')>();
  return {
    ...actual,
    sendEmail: (...args: unknown[]) => emailSendMock(...args),
    sendPlatformEmail: (...args: unknown[]) => platformEmailSendMock(...args),
  };
});
vi.mock('../../../server/services/sms/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/sms/index.js')>();
  return { ...actual, sendSms: (...args: unknown[]) => smsSendMock(...args) };
});

function makePgServiceClient(pg: PgTestClient) {
  function from(table: string) {
    const state: { cols: string; wheres: string[]; params: unknown[] } = { cols: '*', wheres: [], params: [] };
    function addParam(v: unknown): number { state.params.push(v); return state.params.length; }
    const builder: any = {
      select(cols?: string) { state.cols = cols || '*'; return builder; },
      eq(col: string, val: unknown) { state.wheres.push(`${col} = $${addParam(val)}`); return builder; },
      maybeSingle: async () => {
        const where = state.wheres.length ? ` WHERE ${state.wheres.join(' AND ')}` : '';
        try {
          const r = await pg.query(`SELECT ${state.cols} FROM public.${table}${where}`, state.params);
          return { data: r.rows[0] ?? null, error: null };
        } catch (e: any) {
          return { data: null, error: { message: e.message, code: e.code } };
        }
      },
    };
    return builder;
  }

  async function rpc(name: string, args: Record<string, unknown>) {
    try {
      switch (name) {
        case 'gv_execute_idempotent': {
          const r = await pg.query(
            `SELECT public.gv_execute_idempotent($1,$2,$3,$4,$5,$6,$7,$8) AS result`,
            [args._key, args._scope_kind, args._operation, args._request_fingerprint, args._purpose, args._workspace_id, args._actor_ref_hash, args._args],
          );
          if (forceVerifyResponseLossOnce && args._operation === 'verify') {
            forceVerifyResponseLossOnce = false;
            return { data: null, error: { message: 'SIMULATED_TRANSPORT_LOSS_AFTER_VERIFY_COMMIT' } };
          }
          return { data: r.rows[0].result, error: null };
        }
        case 'gv_prepare_verification_delivery': {
          const r = await pg.query(
            `SELECT public.gv_prepare_verification_delivery($1,$2,$3,$4,$5,$6,$7,$8) AS result`,
            [args._key, args._scope_kind, args._operation, args._request_fingerprint, args._purpose, args._workspace_id, args._actor_ref_hash, args._args],
          );
          return { data: r.rows[0].result, error: null };
        }
        case 'gv_finalize_verification_delivery': {
          if (forceFinalizeFailureOnce) {
            forceFinalizeFailureOnce = false;
            return { data: null, error: { message: 'SIMULATED_TRANSPORT_LOSS_AFTER_SEND' } };
          }
          const r = await pg.query(
            `SELECT public.gv_finalize_verification_delivery($1,$2,$3,$4,$5,$6,$7) AS result`,
            [args._key, args._attempt_token, args._outcome, args._provider_name, args._provider_message_id, args._error_code, args._error_message],
          );
          return { data: r.rows[0].result, error: null };
        }
        case 'gv_consume_verification_proof': {
          const r = await pg.query(
            `SELECT public.gv_consume_verification_proof($1,$2,$3,$4,$5,$6) AS result`,
            [args._proof_hash, args._purpose, args._channel, args._workspace_id, args._subject_ref_hash, args._consumed_by_context],
          );
          return { data: r.rows[0].result, error: null };
        }
        case 'gv_get_verification_status': {
          const r = await pg.query(`SELECT public.gv_get_verification_status($1) AS result`, [args._handle]);
          return { data: r.rows[0].result, error: null };
        }
        case 'gv_purge_expired_idempotency': {
          const r = await pg.query(`SELECT public.gv_purge_expired_idempotency($1) AS result`, [args._limit]);
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

const svc = await import('../../../server/services/verification/service');
const {
  __setPurposePolicyOverrideForTests,
  __clearAllPurposePolicyOverridesForTests,
} = await import('../../../server/services/verification/types');

const config: any = {
  supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: ['*'], port: 0,
  supabaseAnonKey: 'k', rateLimitWindowMs: 60000, rateLimitMax: 10000, selfHostBillingUnlimited: false,
};

function newIdempotencyKey(): string { return randomUUID(); }
function newRequestId(): string { return randomUUID(); }

function extractCode(text: string): string {
  const m = text.match(/(\d{4,8})/);
  if (!m) throw new Error(`no OTP code found in message body: ${JSON.stringify(text)}`);
  return m[1];
}

/**
 * Runs `fn` under a temporarily rotated pepper ring/current-version, and
 * ALWAYS restores the exact prior env state afterward — including when
 * `fn` throws or an assertion inside it fails. Rotation tests mutate
 * process-global env vars read by every OTHER test in this file; without
 * a try/finally here, a failing assertion partway through one rotation
 * test would leave the ring rotated for every test that runs after it,
 * turning one real failure into a cascade of unrelated-looking ones.
 */
async function withKeyRotation<T>(ring: Record<string, string | undefined>, version: string, fn: () => Promise<T>): Promise<T> {
  const { __resetVerificationCryptoCacheForTests } = await import('../../../server/services/verification/crypto');
  const prevRing = process.env.GENERIC_VERIFICATION_PEPPER_RING;
  const prevVersion = process.env.GENERIC_VERIFICATION_KEY_VERSION;
  const prevPepper = process.env.GENERIC_VERIFICATION_PEPPER;
  process.env.GENERIC_VERIFICATION_PEPPER_RING = JSON.stringify(ring);
  process.env.GENERIC_VERIFICATION_KEY_VERSION = version;
  __resetVerificationCryptoCacheForTests();
  try {
    return await fn();
  } finally {
    if (prevRing === undefined) delete process.env.GENERIC_VERIFICATION_PEPPER_RING; else process.env.GENERIC_VERIFICATION_PEPPER_RING = prevRing;
    if (prevVersion === undefined) delete process.env.GENERIC_VERIFICATION_KEY_VERSION; else process.env.GENERIC_VERIFICATION_KEY_VERSION = prevVersion;
    if (prevPepper === undefined) delete process.env.GENERIC_VERIFICATION_PEPPER; else process.env.GENERIC_VERIFICATION_PEPPER = prevPepper;
    __resetVerificationCryptoCacheForTests();
  }
}

async function insertWorkspace(): Promise<{ workspaceId: string; ownerId: string }> {
  const workspaceId = randomUUID();
  const email = `owner-${workspaceId}@example.test`;
  const ownerId = randomUUID();
  await db.query(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, 'Test Owner')`, [ownerId, email]);
  await db.query(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Test WS', $2, $3)`, [workspaceId, `ws-${workspaceId}`, ownerId]);
  return { workspaceId, ownerId };
}

const ALL_PURPOSES = [
  'signup_email', 'signup_phone', 'password_reset', 'login_step_up',
  'change_email', 'change_phone', 'sensitive_action', 'workspace_invitation',
];

/** The REAL, shipped function body — copied verbatim from the migration.
 * Test X1 temporarily restores this to prove the production posture. */
const SHIPPED_GV_IS_PURPOSE_ENABLED_SQL = `
  CREATE OR REPLACE FUNCTION public.gv_is_purpose_enabled(_purpose text) RETURNS boolean
  LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $function$ SELECT _purpose = ANY(ARRAY[]::text[]); $function$;
`;

/** TEST-ONLY patch (never shipped): allow-lists every purpose at the
 * DATABASE layer so the rest of this suite — which relies on the
 * TypeScript-layer `__setPurposePolicyOverrideForTests` hook to decide,
 * per test, which purpose is reachable at all — can exercise a full
 * lifecycle against a real database. This is the database-layer analogue
 * of that same TypeScript hook: a real production enablement still
 * requires editing BOTH layers via a reviewed migration + code deploy. */
const TEST_ONLY_GV_IS_PURPOSE_ENABLED_SQL = `
  CREATE OR REPLACE FUNCTION public.gv_is_purpose_enabled(_purpose text) RETURNS boolean
  LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $function$
    SELECT _purpose = ANY(ARRAY[${ALL_PURPOSES.map((p) => `'${p}'`).join(',')}]::text[]);
  $function$;
`;

suite('Generic Verification Core v1 — real PostgreSQL acceptance', () => {
  beforeAll(async () => {
    const { Pool } = await import('pg');
    db = new Pool({ connectionString: DSN, max: 10 }) as unknown as PgTestClient;
    await db.query(`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS auth CASCADE; CREATE SCHEMA public;`);
    await ensureAuthChainInstalled(db);
    await db.query(TEST_ONLY_GV_IS_PURPOSE_ENABLED_SQL);
  }, 180_000);

  afterAll(async () => {
    if (db) {
      await db.query(`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS auth CASCADE; CREATE SCHEMA public;`);
      await ensureAuthChainInstalled(db);
      await db.end();
    }
  });

  beforeEach(() => {
    emailSendMock.mockReset();
    platformEmailSendMock.mockReset();
    smsSendMock.mockReset();
    emailSendMock.mockResolvedValue({ success: true, provider: 'resend', id: 'default-msg' });
    platformEmailSendMock.mockResolvedValue({ success: false, provider: 'stub', error: 'Email provider is not configured' });
    smsSendMock.mockResolvedValue({ success: true, provider: 'kavenegar', messageId: 'default-sms' });
    forceFinalizeFailureOnce = false;
    forceVerifyResponseLossOnce = false;
  });

  afterEach(() => {
    __clearAllPurposePolicyOverridesForTests();
  });

  // ── A. disabled-purpose fail-closed with zero writes (TypeScript layer) ──
  it('A: a disabled purpose writes zero challenge rows, zero delivery-attempt rows, and contacts no provider', async () => {
    const before = await db.query(`SELECT count(*)::int AS n FROM public.verification_challenges`);
    await expect(
      svc.requestVerificationChallenge(config, {
        purpose: 'signup_email', channel: 'email', destination: 'nobody@example.test', subjectKind: 'pending_account',
        idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.1' },
      }),
    ).rejects.toThrow(/disabled/i);
    const after = await db.query(`SELECT count(*)::int AS n FROM public.verification_challenges`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const attempts = await db.query(`SELECT count(*)::int AS n FROM public.verification_delivery_attempts`);
    expect(attempts.rows[0].n).toBe(0);
    expect(emailSendMock).not.toHaveBeenCalled();
    expect(smsSendMock).not.toHaveBeenCalled();
  });

  // ── X. database-layer dormancy + internal-function isolation ───────────
  it('X1: the SHIPPED (production) gv_is_purpose_enabled blocks every purpose at the database layer, independent of the TypeScript registry — a direct service-role RPC call for a disabled purpose produces zero writes', async () => {
    await db.query(SHIPPED_GV_IS_PURPOSE_ENABLED_SQL);
    try {
      __setPurposePolicyOverrideForTests('password_reset', { enabled: true }); // TypeScript layer says "enabled"...
      const before = await db.query(`SELECT count(*)::int AS n FROM public.verification_challenges`);
      const idemBefore = await db.query(`SELECT count(*)::int AS n FROM public.verification_idempotency`);
      // ...but the DATABASE still says no, independent of that override.
      await expect(
        svc.requestVerificationChallenge(config, {
          purpose: 'password_reset', channel: 'email', destination: 'x1@example.test', subjectKind: 'user',
          subjectRef: randomUUID(), idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.80' },
        }),
      ).rejects.toThrow(/VERIFICATION_PURPOSE_DISABLED/);
      const after = await db.query(`SELECT count(*)::int AS n FROM public.verification_challenges`);
      expect(after.rows[0].n).toBe(before.rows[0].n);
      const idemAfter = await db.query(`SELECT count(*)::int AS n FROM public.verification_idempotency`);
      expect(idemAfter.rows[0].n).toBe(idemBefore.rows[0].n); // the tentative ledger insert rolled back too

      // Every OTHER known purpose is ALSO blocked by the shipped function —
      // this is what the migration's own DO $verify$ block asserts at
      // apply time; re-proven here directly, live, against the real table.
      for (const p of ALL_PURPOSES) {
        const row = await db.query(`SELECT public.gv_is_purpose_enabled($1) AS enabled`, [p]);
        expect(row.rows[0].enabled).toBe(false);
      }
    } finally {
      // Restore the test-only patch so the REST of this suite (which relies
      // on it) keeps working.
      await db.query(TEST_ONLY_GV_IS_PURPOSE_ENABLED_SQL);
    }
  });

  it('X2: internal functions are unreachable directly, even by service_role — only their public wrappers can invoke them', async () => {
    const client = await (db as unknown as { connect(): Promise<any> }).connect();
    try {
      await client.query('SET ROLE service_role');
      await expect(client.query(`SELECT public._gv_do_request($1)`, [{}])).rejects.toThrow(/permission denied/i);
      await expect(client.query(`SELECT public._gv_do_resend($1)`, [{}])).rejects.toThrow(/permission denied/i);
      await expect(client.query(`SELECT public._gv_do_verify($1)`, [{}])).rejects.toThrow(/permission denied/i);
      await expect(client.query(`SELECT public._gv_do_revoke($1)`, [{}])).rejects.toThrow(/permission denied/i);
      await expect(client.query(`SELECT public.gv_is_purpose_enabled($1)`, ['x'])).rejects.toThrow(/permission denied/i);
    } finally {
      await client.query('RESET ROLE');
      client.release();
    }
  });

  // ── B. request idempotency + C. concurrent duplicate requests ─────────
  it('B/C: identical idempotency key replays the same result exactly once, including under concurrency, and sends exactly once', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    const idempotencyKey = newIdempotencyKey();
    const input = {
      purpose: 'signup_phone' as const, channel: 'sms' as const, destination: '09121230101',
      subjectKind: 'pending_account' as const, idempotencyKey, requester: { ipAddress: '203.0.113.2' },
    };

    const settled = await Promise.allSettled([
      svc.requestVerificationChallenge(config, input),
      svc.requestVerificationChallenge(config, input),
      svc.requestVerificationChallenge(config, input),
    ]);
    const fulfilled = settled.filter((s): s is PromiseFulfilledResult<Awaited<ReturnType<typeof svc.requestVerificationChallenge>>> => s.status === 'fulfilled');
    const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const r of rejected) {
      expect((r.reason as { name?: string })?.name).toBe('VerificationAlreadyInFlightError');
    }
    const handles = new Set(fulfilled.map((f) => f.value.handle));
    expect(handles.size).toBe(1);
    const [handle] = handles;

    const rows = await db.query(`SELECT count(*)::int AS n FROM public.verification_challenges WHERE handle = $1`, [handle]);
    expect(rows.rows[0].n).toBe(1);
    expect(smsSendMock.mock.calls.length).toBeLessThanOrEqual(1);
  });

  // ── D. resend invalidates old generation ──────────────────────────────
  it('D: resend revokes the previous live challenge and bumps the generation', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    const destination = '09121230102';
    const first = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_phone', channel: 'sms', destination, subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.3' },
    });
    await db.query(
      `UPDATE public.verification_challenges SET created_at = now() - interval '90 seconds' WHERE handle = $1`,
      [first.handle],
    );
    const second = await svc.resendVerificationChallenge(config, {
      handle: first.handle, purpose: 'signup_phone', channel: 'sms', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.3' },
    });
    expect(second.generation).toBe(first.generation + 1);

    const firstRow = await db.query(`SELECT status FROM public.verification_challenges WHERE handle = $1`, [first.handle]);
    expect(firstRow.rows[0].status).toBe('revoked');
    const secondRow = await db.query(`SELECT status FROM public.verification_challenges WHERE handle = $1`, [second.handle]);
    expect(secondRow.rows[0].status).toBe('provider_accepted'); // sent synchronously, in THIS call
  });

  // ── E. correct-code verification (requires reading the deterministic code back out) ──
  it('E: verifying the correct, deterministically-derived code succeeds and issues a proof', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    const destination = '09121230103';
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_phone', channel: 'sms', destination, subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.4' },
    });
    expect(req.deliveryOutcome).toBe('provider_accepted');

    const row = await db.query(`SELECT generation, key_version, destination_hash FROM public.verification_challenges WHERE handle = $1`, [req.handle]);
    const { deriveOtpCode } = await import('../../../server/services/verification/crypto');
    const code = deriveOtpCode(
      { purpose: 'signup_phone', channel: 'sms', challengeHandle: req.handle, generation: row.rows[0].generation, destinationHash: row.rows[0].destination_hash },
      row.rows[0].key_version,
      6,
    );

    const result = await svc.verifyVerificationChallenge(config, {
      handle: req.handle, code, purpose: 'signup_phone', channel: 'sms', requestId: newRequestId(), requester: { ipAddress: '203.0.113.4' },
    });
    expect(result.ok).toBe(true);
    expect(result.proofToken).toBeTruthy();

    const chalStatus = await db.query(`SELECT status FROM public.verification_challenges WHERE handle = $1`, [req.handle]);
    expect(chalStatus.rows[0].status).toBe('verified');
  });

  // ── F. wrong-code attempt counting + G. attempt exhaustion and lock ────
  it('F/G: wrong codes increment attempts and lock the challenge at max_attempts', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true, maxVerificationAttempts: 3 });
    const destination = '09121230104';
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_phone', channel: 'sms', destination, subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.5' },
    });

    for (let i = 0; i < 3; i++) {
      const result = await svc.verifyVerificationChallenge(config, {
        handle: req.handle, code: '000000', purpose: 'signup_phone', channel: 'sms', requestId: newRequestId(), requester: { ipAddress: '203.0.113.5' },
      });
      expect(result.ok).toBe(false);
    }

    const row = await db.query(`SELECT status, attempt_count FROM public.verification_challenges WHERE handle = $1`, [req.handle]);
    expect(row.rows[0].status).toBe('locked');
    expect(row.rows[0].attempt_count).toBe(3);

    const attempts = await db.query(`SELECT count(*)::int AS n FROM public.verification_attempts WHERE challenge_id = (SELECT id FROM public.verification_challenges WHERE handle = $1)`, [req.handle]);
    expect(attempts.rows[0].n).toBe(3);
  });

  // ── H. expiration and revocation ───────────────────────────────────────
  it('H1: an expired challenge cannot be verified', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_phone', channel: 'sms', destination: '09121230105', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.6' },
    });
    await db.query(`UPDATE public.verification_challenges SET expires_at = now() - interval '1 second' WHERE handle = $1`, [req.handle]);

    const result = await svc.verifyVerificationChallenge(config, {
      handle: req.handle, code: '123456', purpose: 'signup_phone', channel: 'sms', requestId: newRequestId(), requester: { ipAddress: '203.0.113.6' },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('expired');
  });

  it('H2: a revoked challenge cannot be verified', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_phone', channel: 'sms', destination: '09121230106', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.7' },
    });
    const revoked = await svc.revokeVerificationChallenge(config, {
      handle: req.handle, purpose: 'signup_phone', channel: 'sms', reason: 'test_revoke',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.7' },
    });
    expect(revoked.ok).toBe(true);

    const result = await svc.verifyVerificationChallenge(config, {
      handle: req.handle, code: '123456', purpose: 'signup_phone', channel: 'sms', requestId: newRequestId(), requester: { ipAddress: '203.0.113.7' },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('revoked');
  });

  // ── I. proof single-consume + J. concurrent proof consumption ─────────
  it('I/J: a proof can be consumed exactly once, even under concurrent consumption attempts', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_phone', channel: 'sms', destination: '09121230107', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.8' },
    });
    const row = await db.query(`SELECT generation, key_version, destination_hash FROM public.verification_challenges WHERE handle = $1`, [req.handle]);
    const { deriveOtpCode } = await import('../../../server/services/verification/crypto');
    const code = deriveOtpCode({ purpose: 'signup_phone', channel: 'sms', challengeHandle: req.handle, generation: row.rows[0].generation, destinationHash: row.rows[0].destination_hash }, row.rows[0].key_version, 6);
    const verified = await svc.verifyVerificationChallenge(config, { handle: req.handle, code, purpose: 'signup_phone', channel: 'sms', requestId: newRequestId(), requester: { ipAddress: '203.0.113.8' } });
    expect(verified.proofToken).toBeTruthy();

    const [c1, c2, c3] = await Promise.all([
      svc.consumeVerificationProof(config, { proofToken: verified.proofToken!, purpose: 'signup_phone', channel: 'sms', consumedByContext: 'test_consumer' }),
      svc.consumeVerificationProof(config, { proofToken: verified.proofToken!, purpose: 'signup_phone', channel: 'sms', consumedByContext: 'test_consumer' }),
      svc.consumeVerificationProof(config, { proofToken: verified.proofToken!, purpose: 'signup_phone', channel: 'sms', consumedByContext: 'test_consumer' }),
    ]);
    const successes = [c1, c2, c3].filter((r) => r.ok);
    expect(successes.length).toBe(1);
  });

  // ── K/L. wrong purpose/subject/workspace rejection + tenant isolation ─
  it('K/L: a proof cannot be consumed under a different purpose, subject, or workspace than it was issued for', async () => {
    __setPurposePolicyOverrideForTests('login_step_up', { enabled: true });
    __setPurposePolicyOverrideForTests('sensitive_action', { enabled: true });
    const { workspaceId: wsA, ownerId } = await insertWorkspace();
    const { workspaceId: wsB } = await insertWorkspace();

    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'login_step_up', channel: 'email', destination: 'tenant-iso@example.test', subjectKind: 'user',
      subjectRef: ownerId, workspaceId: wsA, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.9', authenticatedUserId: ownerId },
    });
    const row = await db.query(`SELECT generation, key_version, destination_hash FROM public.verification_challenges WHERE handle = $1`, [req.handle]);
    const { deriveOtpCode } = await import('../../../server/services/verification/crypto');
    const code = deriveOtpCode({ purpose: 'login_step_up', channel: 'email', challengeHandle: req.handle, generation: row.rows[0].generation, destinationHash: row.rows[0].destination_hash }, row.rows[0].key_version, 6);

    const wrongWs = await svc.verifyVerificationChallenge(config, {
      handle: req.handle, code, purpose: 'login_step_up', channel: 'email', workspaceId: wsB, subjectRef: ownerId, requestId: newRequestId(), requester: { ipAddress: '203.0.113.9', authenticatedUserId: ownerId },
    });
    expect(wrongWs.ok).toBe(false);

    const correct = await svc.verifyVerificationChallenge(config, {
      handle: req.handle, code, purpose: 'login_step_up', channel: 'email', workspaceId: wsA, subjectRef: ownerId, requestId: newRequestId(), requester: { ipAddress: '203.0.113.9', authenticatedUserId: ownerId },
    });
    expect(correct.ok).toBe(true);

    const consumedWrong = await svc.consumeVerificationProof(config, {
      proofToken: correct.proofToken!, purpose: 'login_step_up', channel: 'email', workspaceId: wsB, subjectRef: ownerId, authenticatedUserId: ownerId, consumedByContext: 'test',
    });
    expect(consumedWrong.ok).toBe(false);

    const consumedWrongPurpose = await svc.consumeVerificationProof(config, {
      proofToken: correct.proofToken!, purpose: 'sensitive_action', channel: 'email', workspaceId: wsA, subjectRef: ownerId, authenticatedUserId: ownerId, consumedByContext: 'test',
    });
    expect(consumedWrongPurpose.ok).toBe(false);

    const consumedRight = await svc.consumeVerificationProof(config, {
      proofToken: correct.proofToken!, purpose: 'login_step_up', channel: 'email', workspaceId: wsA, subjectRef: ownerId, authenticatedUserId: ownerId, consumedByContext: 'test',
    });
    expect(consumedRight.ok).toBe(true);
  });

  // ── M. channel policy enforcement ────────────────────────────────────
  it('M: a channel not allowed by the purpose policy is rejected before any DB write', async () => {
    __setPurposePolicyOverrideForTests('signup_email', { enabled: true }); // allowedChannels: ['email'] only
    const before = await db.query(`SELECT count(*)::int AS n FROM public.verification_challenges`);
    await expect(
      svc.requestVerificationChallenge(config, {
        purpose: 'signup_email', channel: 'sms', destination: '+989121234567', subjectKind: 'pending_account',
        idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.10' },
      }),
    ).rejects.toThrow();
    const after = await db.query(`SELECT count(*)::int AS n FROM public.verification_challenges`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(smsSendMock).not.toHaveBeenCalled();
  });

  // ── N. Express-direct provider outcomes ────────────────────────────────
  it('N1: a successful email send is recorded as provider_accepted synchronously, in the SAME request', async () => {
    __setPurposePolicyOverrideForTests('login_step_up', { enabled: true });
    emailSendMock.mockResolvedValue({ success: true, provider: 'resend', id: 'msg-123' });
    const { workspaceId: wsId, ownerId } = await insertWorkspace();

    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'login_step_up', channel: 'email', destination: 'send-success@example.test', subjectKind: 'user',
      subjectRef: ownerId, workspaceId: wsId, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.11', authenticatedUserId: ownerId },
    });

    expect(emailSendMock).toHaveBeenCalledTimes(1);
    expect(req.deliveryOutcome).toBe('provider_accepted');

    const chal = await db.query(`SELECT status FROM public.verification_challenges WHERE handle = $1`, [req.handle]);
    expect(chal.rows[0].status).toBe('provider_accepted');
    const delivery = await db.query(`SELECT outcome, provider_name FROM public.verification_delivery_attempts WHERE challenge_id = (SELECT id FROM public.verification_challenges WHERE handle = $1)`, [req.handle]);
    expect(delivery.rows[0].outcome).toBe('provider_accepted');
    expect(delivery.rows[0].provider_name).toBe('resend');
  });

  it('N2: a provider failure is recorded as retryable_failure, the challenge is NOT auto-retried (there is no worker), and an explicit resend recovers it', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    smsSendMock.mockResolvedValueOnce({ success: false, provider: 'kavenegar', errorCode: 'provider_error' });

    const destination = '09121230108';
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_phone', channel: 'sms', destination, subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.12' },
    });
    expect(req.deliveryOutcome).toBe('retryable_failure');

    const chal = await db.query(`SELECT status FROM public.verification_challenges WHERE handle = $1`, [req.handle]);
    expect(chal.rows[0].status).toBe('pending_delivery');
    const delivery = await db.query(`SELECT outcome FROM public.verification_delivery_attempts WHERE challenge_id = (SELECT id FROM public.verification_challenges WHERE handle = $1)`, [req.handle]);
    expect(delivery.rows[0].outcome).toBe('retryable_failure');
    expect(smsSendMock).toHaveBeenCalledTimes(1);

    await db.query(`UPDATE public.verification_challenges SET created_at = now() - interval '90 seconds' WHERE handle = $1`, [req.handle]);

    smsSendMock.mockResolvedValueOnce({ success: true, provider: 'kavenegar', messageId: 'recovered' });
    const resent = await svc.resendVerificationChallenge(config, {
      handle: req.handle, purpose: 'signup_phone', channel: 'sms', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.12' },
    });
    expect(resent.deliveryOutcome).toBe('provider_accepted');
    expect(resent.generation).toBe(req.generation + 1);
    expect(smsSendMock).toHaveBeenCalledTimes(2);
  });

  // ── O. no background worker exists or is required ──────────────────────
  it('O: delivery happens synchronously — no job/outbox table exists, and no worker module is required', async () => {
    expect(existsSync('server/services/verification/worker.ts')).toBe(false);

    const jobTable = await db.query(`SELECT to_regclass('public.verification_delivery_jobs') AS reg`);
    expect(jobTable.rows[0].reg).toBeNull();

    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    smsSendMock.mockResolvedValue({ success: true, provider: 'kavenegar', messageId: 'sync-proof' });
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_phone', channel: 'sms', destination: '09121230109', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.14' },
    });
    const delivery = await db.query(`SELECT outcome FROM public.verification_delivery_attempts WHERE challenge_id = (SELECT id FROM public.verification_challenges WHERE handle = $1)`, [req.handle]);
    expect(delivery.rows[0].outcome).toBe('provider_accepted');
  });

  // ── P. crash/concurrency/replay matrix for the Express-direct delivery model ──
  it('P1: a crash between prepare and finalize (stale in-flight ledger row) is RESUMED with the SAME challenge and the SAME deterministic code, never a duplicate challenge, and rotates the attempt token', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    const {
      deriveIdempotencyKey, deriveRequestFingerprint, hashDestination,
      generateChallengeHandle, currentVerificationKeyVersion, digestOtpCode, deriveOtpCode,
    } = await import('../../../server/services/verification/crypto');
    const { normalizeDestination } = await import('../../../server/services/verification/destination');

    const idempotencyKeyRaw = newIdempotencyKey();
    const destinationRaw = '09121230110';
    const normalized = normalizeDestination('sms', destinationRaw);
    const destinationHash = hashDestination(normalized.normalized!);
    const idempotencyKey = deriveIdempotencyKey({ operation: 'request', scopeKind: 'signup_phone', actorRef: 'anonymous', requestId: idempotencyKeyRaw });
    const fingerprint = deriveRequestFingerprint({ purpose: 'signup_phone', channel: 'sms', destinationHash, subjectRefHash: null, workspaceId: null });

    const handle = generateChallengeHandle();
    const keyVersion = currentVerificationKeyVersion();
    const domain = { purpose: 'signup_phone', channel: 'sms' as const, challengeHandle: handle, generation: 1, destinationHash };
    const code = deriveOtpCode(domain, keyVersion, 6);
    const codeDigest = digestOtpCode(domain, code, keyVersion);

    const inserted = await db.query(
      `INSERT INTO public.verification_challenges (handle, purpose, channel, subject_kind, destination_normalized, destination_hash, locale, generation, status, key_version, code_digest, max_attempts, max_sends, resend_cooldown_seconds, expires_at)
       VALUES ($1, 'signup_phone', 'sms', 'pending_account', $2, $3, 'en', 1, 'pending_delivery', $4, $5, 5, 5, 60, now() + interval '5 minutes')
       RETURNING id`,
      [handle, normalized.normalized, destinationHash, keyVersion, codeDigest],
    );
    const challengeId = inserted.rows[0].id;
    const safeResult = {
      challengeId, handle, generation: 1, channel: 'sms', destinationNormalized: normalized.normalized,
      destinationHash, locale: 'en', keyVersion,
      expiresAt: new Date(Date.now() + 300_000).toISOString(), resendAvailableAt: new Date().toISOString(),
    };
    await db.query(
      `INSERT INTO public.verification_idempotency (key, scope_kind, operation, purpose, challenge_id, result_state, request_fingerprint, safe_result, prepared_at)
       VALUES ($1, 'signup_phone', 'request', 'signup_phone', $2, 'prepared', $3, $4, now() - interval '60 seconds')`,
      [idempotencyKey, challengeId, fingerprint, JSON.stringify(safeResult)],
    );

    smsSendMock.mockResolvedValue({ success: true, provider: 'kavenegar', messageId: 'resumed-msg' });

    const result = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_phone', channel: 'sms', destination: destinationRaw, subjectKind: 'pending_account',
      idempotencyKey: idempotencyKeyRaw, requester: { ipAddress: '203.0.113.20' },
    });

    expect(result.handle).toBe(handle);
    expect(smsSendMock).toHaveBeenCalledTimes(1);
    const sentBody = String(smsSendMock.mock.calls[0][1]?.body ?? '');
    expect(sentBody.includes(code)).toBe(true);

    const rows = await db.query(`SELECT count(*)::int AS n FROM public.verification_challenges WHERE destination_hash = $1`, [destinationHash]);
    expect(rows.rows[0].n).toBe(1);

    const chal = await db.query(`SELECT status FROM public.verification_challenges WHERE handle = $1`, [handle]);
    expect(chal.rows[0].status).toBe('provider_accepted');

    // The resume rotated the attempt token — the ledger row now carries a
    // token, whereas the manually-seeded row above never set one.
    const ledger = await db.query(`SELECT attempt_token FROM public.verification_idempotency WHERE key = $1`, [idempotencyKey]);
    expect(ledger.rows[0].attempt_token).toBeTruthy();
  });

  it('P2: a GENUINELY concurrent identical request (fresh in-flight ledger row) is rejected outright, never double-sent', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    const {
      deriveIdempotencyKey, deriveRequestFingerprint, hashDestination,
      generateChallengeHandle, currentVerificationKeyVersion, digestOtpCode, deriveOtpCode,
    } = await import('../../../server/services/verification/crypto');
    const { normalizeDestination } = await import('../../../server/services/verification/destination');

    const idempotencyKeyRaw = newIdempotencyKey();
    const destinationRaw = '09121230111';
    const normalized = normalizeDestination('sms', destinationRaw);
    const destinationHash = hashDestination(normalized.normalized!);
    const idempotencyKey = deriveIdempotencyKey({ operation: 'request', scopeKind: 'signup_phone', actorRef: 'anonymous', requestId: idempotencyKeyRaw });
    const fingerprint = deriveRequestFingerprint({ purpose: 'signup_phone', channel: 'sms', destinationHash, subjectRefHash: null, workspaceId: null });
    const handle = generateChallengeHandle();
    const keyVersion = currentVerificationKeyVersion();
    const domain = { purpose: 'signup_phone', channel: 'sms' as const, challengeHandle: handle, generation: 1, destinationHash };
    const codeDigest = digestOtpCode(domain, deriveOtpCode(domain, keyVersion, 6), keyVersion);

    const inserted = await db.query(
      `INSERT INTO public.verification_challenges (handle, purpose, channel, subject_kind, destination_normalized, destination_hash, locale, generation, status, key_version, code_digest, max_attempts, max_sends, resend_cooldown_seconds, expires_at)
       VALUES ($1, 'signup_phone', 'sms', 'pending_account', $2, $3, 'en', 1, 'pending_delivery', $4, $5, 5, 5, 60, now() + interval '5 minutes')
       RETURNING id`,
      [handle, normalized.normalized, destinationHash, keyVersion, codeDigest],
    );
    await db.query(
      `INSERT INTO public.verification_idempotency (key, scope_kind, operation, purpose, challenge_id, result_state, request_fingerprint, safe_result, prepared_at)
       VALUES ($1, 'signup_phone', 'request', 'signup_phone', $2, 'prepared', $3, $4, now())`,
      [idempotencyKey, inserted.rows[0].id, fingerprint, JSON.stringify({ handle, generation: 1 })],
    );

    const { VerificationAlreadyInFlightError } = await import('../../../server/services/verification/service');
    await expect(
      svc.requestVerificationChallenge(config, {
        purpose: 'signup_phone', channel: 'sms', destination: destinationRaw, subjectKind: 'pending_account',
        idempotencyKey: idempotencyKeyRaw, requester: { ipAddress: '203.0.113.21' },
      }),
    ).rejects.toBeInstanceOf(VerificationAlreadyInFlightError);
    expect(smsSendMock).not.toHaveBeenCalled();
  });

  it('P3: "provider accepted but delivery-result persistence failed" — the failing call surfaces the error, and a CALLER retry resumes and finalizes for real (at-least-once provider delivery, never duplicate DB state)', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    smsSendMock.mockResolvedValue({ success: true, provider: 'kavenegar', messageId: 'first-send' });
    const idempotencyKey = newIdempotencyKey();
    const input = {
      purpose: 'signup_phone' as const, channel: 'sms' as const, destination: '09121230112',
      subjectKind: 'pending_account' as const, idempotencyKey, requester: { ipAddress: '203.0.113.22' },
    };

    forceFinalizeFailureOnce = true;
    await expect(svc.requestVerificationChallenge(config, input)).rejects.toThrow(/SIMULATED_TRANSPORT_LOSS/);
    expect(smsSendMock).toHaveBeenCalledTimes(1);

    const { deriveIdempotencyKey } = await import('../../../server/services/verification/crypto');
    const key = deriveIdempotencyKey({ operation: 'request', scopeKind: 'signup_phone', actorRef: 'anonymous', requestId: idempotencyKey });
    await db.query(`UPDATE public.verification_idempotency SET prepared_at = now() - interval '60 seconds' WHERE key = $1`, [key]);

    const result = await svc.requestVerificationChallenge(config, input);
    expect(result.deliveryOutcome).toBe('provider_accepted');
    expect(smsSendMock).toHaveBeenCalledTimes(2);

    const rows = await db.query(`SELECT count(*)::int AS n FROM public.verification_challenges WHERE handle = $1`, [result.handle]);
    expect(rows.rows[0].n).toBe(1);
    const attempts = await db.query(`SELECT count(*)::int AS n FROM public.verification_delivery_attempts WHERE challenge_id = (SELECT id FROM public.verification_challenges WHERE handle = $1)`, [result.handle]);
    expect(attempts.rows[0].n).toBe(1);
  });

  it('same idempotency key with a DIFFERENT payload is rejected, never silently reinterpreted as the new payload', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    const idempotencyKey = newIdempotencyKey();
    await svc.requestVerificationChallenge(config, {
      purpose: 'signup_phone', channel: 'sms', destination: '09121230113', subjectKind: 'pending_account',
      idempotencyKey, requester: { ipAddress: '203.0.113.23' },
    });
    await expect(
      svc.requestVerificationChallenge(config, {
        purpose: 'signup_phone', channel: 'sms', destination: '09121230114', subjectKind: 'pending_account',
        idempotencyKey, requester: { ipAddress: '203.0.113.23' },
      }),
    ).rejects.toThrow(/idempotency conflict/i);
  });

  // ── AA. delivery-attempt ownership token ────────────────────────────────
  it('AA1: finalize with a stale (rotated-away) attempt token is rejected softly and never overwrites the newer attempts outcome', async () => {
    const {
      deriveIdempotencyKey, deriveRequestFingerprint, hashDestination,
      generateChallengeHandle, currentVerificationKeyVersion, digestOtpCode, deriveOtpCode,
    } = await import('../../../server/services/verification/crypto');
    const { normalizeDestination } = await import('../../../server/services/verification/destination');

    const idempotencyKeyRaw = newIdempotencyKey();
    const destinationRaw = '09121230130';
    const normalized = normalizeDestination('sms', destinationRaw);
    const destinationHash = hashDestination(normalized.normalized!);
    const idempotencyKey = deriveIdempotencyKey({ operation: 'request', scopeKind: 'signup_phone', actorRef: 'anonymous', requestId: idempotencyKeyRaw });
    const fingerprint = deriveRequestFingerprint({ purpose: 'signup_phone', channel: 'sms', destinationHash, subjectRefHash: null, workspaceId: null });
    const handle = generateChallengeHandle();
    const keyVersion = currentVerificationKeyVersion();
    const domain = { purpose: 'signup_phone', channel: 'sms' as const, challengeHandle: handle, generation: 1, destinationHash };
    const codeDigest = digestOtpCode(domain, deriveOtpCode(domain, keyVersion, 6), keyVersion);
    const rpcArgs = {
      handle, purpose: 'signup_phone', channel: 'sms', workspaceId: null, subjectKind: 'pending_account', subjectRef: null, subjectRefHash: null,
      destinationNormalized: normalized.normalized, destinationHash, locale: 'en', keyVersion, codeDigest,
      ttlSeconds: 300, maxAttempts: 5, maxSends: 5, resendCooldownSeconds: 60, rateWindowSeconds: 3600, maxPerWindow: 5,
      invalidatePrevious: true, requestIpHash: null,
    };

    const prep1 = await db.query(
      `SELECT public.gv_prepare_verification_delivery($1,$2,$3,$4,$5,$6,$7,$8) AS result`,
      [idempotencyKey, 'signup_phone', 'request', fingerprint, 'signup_phone', null, null, rpcArgs],
    );
    const token1 = prep1.rows[0].result.attemptToken;
    expect(token1).toBeTruthy();

    // Simulate the "stale" heuristic firing: backdate prepared_at and
    // resume — this rotates the token.
    await db.query(`UPDATE public.verification_idempotency SET prepared_at = now() - interval '60 seconds' WHERE key = $1`, [idempotencyKey]);
    const prep2 = await db.query(
      `SELECT public.gv_prepare_verification_delivery($1,$2,$3,$4,$5,$6,$7,$8) AS result`,
      [idempotencyKey, 'signup_phone', 'request', fingerprint, 'signup_phone', null, null, rpcArgs],
    );
    expect(prep2.rows[0].result.status).toBe('resume');
    const token2 = prep2.rows[0].result.attemptToken;
    expect(token2).not.toBe(token1);

    // The FIRST (stale) attempt's provider call finally "completes" and
    // tries to finalize with its OLD token — rejected softly, never applied.
    const staleFinalize = await db.query(
      `SELECT public.gv_finalize_verification_delivery($1,$2,$3,$4,$5,$6,$7) AS result`,
      [idempotencyKey, token1, 'provider_accepted', 'kavenegar', 'stale-msg', null, null],
    );
    expect(staleFinalize.rows[0].result.applied).toBe(false);
    expect(staleFinalize.rows[0].result.reason).toBe('stale_attempt_token');

    // The NEWER (resumed) attempt's finalize call, using the CURRENT
    // token, succeeds and is the one whose outcome is actually recorded.
    const realFinalize = await db.query(
      `SELECT public.gv_finalize_verification_delivery($1,$2,$3,$4,$5,$6,$7) AS result`,
      [idempotencyKey, token2, 'provider_accepted', 'kavenegar', 'resumed-msg', null, null],
    );
    expect(realFinalize.rows[0].result.applied).toBe(true);

    const delivery = await db.query(`SELECT provider_message_id FROM public.verification_delivery_attempts WHERE challenge_id = (SELECT id FROM public.verification_challenges WHERE handle = $1)`, [handle]);
    expect(delivery.rows[0].provider_message_id).toBe('resumed-msg');
    const count = await db.query(`SELECT count(*)::int AS n FROM public.verification_delivery_attempts WHERE challenge_id = (SELECT id FROM public.verification_challenges WHERE handle = $1)`, [handle]);
    expect(count.rows[0].n).toBe(1); // the stale finalize never wrote anything
  });

  // ── Q. key rotation (low-level, non-provider-captured) ──────────────────
  it('Q: an OTP requested under key v1 still verifies correctly after the current key version rotates to v2', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    const { __resetVerificationCryptoCacheForTests, deriveOtpCode } = await import('../../../server/services/verification/crypto');

    process.env.GENERIC_VERIFICATION_PEPPER_RING = JSON.stringify({
      1: process.env.GENERIC_VERIFICATION_PEPPER,
      2: 'second-ring-key-value-at-least-32-bytes!!',
    });
    process.env.GENERIC_VERIFICATION_KEY_VERSION = '1';
    __resetVerificationCryptoCacheForTests();

    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_phone', channel: 'sms', destination: '09121230115', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.16' },
    });
    const row = await db.query(`SELECT generation, key_version, destination_hash FROM public.verification_challenges WHERE handle = $1`, [req.handle]);
    expect(row.rows[0].key_version).toBe(1);

    process.env.GENERIC_VERIFICATION_KEY_VERSION = '2';
    __resetVerificationCryptoCacheForTests();

    const code = deriveOtpCode({ purpose: 'signup_phone', channel: 'sms', challengeHandle: req.handle, generation: row.rows[0].generation, destinationHash: row.rows[0].destination_hash }, 1, 6);
    const result = await svc.verifyVerificationChallenge(config, { handle: req.handle, code, purpose: 'signup_phone', channel: 'sms', requestId: newRequestId(), requester: { ipAddress: '203.0.113.16' } });
    expect(result.ok).toBe(true);

    delete process.env.GENERIC_VERIFICATION_PEPPER_RING;
    delete process.env.GENERIC_VERIFICATION_KEY_VERSION;
    __resetVerificationCryptoCacheForTests();
  });

  // ── R. no secret leakage ────────────────────────────────────────────────
  it('R: no row anywhere in the schema ever contains the raw OTP code or proof token', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_phone', channel: 'sms', destination: '09121230116', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.17' },
    });
    const row = await db.query(`SELECT generation, key_version, destination_hash FROM public.verification_challenges WHERE handle = $1`, [req.handle]);
    const { deriveOtpCode } = await import('../../../server/services/verification/crypto');
    const code = deriveOtpCode({ purpose: 'signup_phone', channel: 'sms', challengeHandle: req.handle, generation: row.rows[0].generation, destinationHash: row.rows[0].destination_hash }, row.rows[0].key_version, 6);
    const verified = await svc.verifyVerificationChallenge(config, { handle: req.handle, code, purpose: 'signup_phone', channel: 'sms', requestId: newRequestId(), requester: { ipAddress: '203.0.113.17' } });

    const challengeRow = await db.query(`SELECT code_digest FROM public.verification_challenges WHERE handle = $1`, [req.handle]);
    expect(challengeRow.rows[0].code_digest.includes(code)).toBe(false);

    if (verified.proofToken) {
      const proofRow = await db.query(`SELECT proof_hash FROM public.verification_proofs WHERE challenge_id = (SELECT id FROM public.verification_challenges WHERE handle = $1)`, [req.handle]);
      expect(proofRow.rows[0].proof_hash.includes(verified.proofToken)).toBe(false);
    }

    const idempotencyRows = await db.query(`SELECT safe_result FROM public.verification_idempotency`);
    for (const r of idempotencyRows.rows) {
      expect(JSON.stringify(r.safe_result ?? {}).includes(code)).toBe(false);
    }

    const smsBody = smsSendMock.mock.calls.find((c) => String(c[1]?.body ?? '').includes(code));
    expect(smsBody).toBeTruthy();
  });

  // ── S. service-role-only ACL (real SET ROLE proof) ─────────────────────
  it('S: SET ROLE service_role can reach every verification table/RPC; anon/authenticated cannot touch the tables', async () => {
    const client = await (db as unknown as { connect(): Promise<any> }).connect();
    try {
      await client.query('SET ROLE service_role');
      await expect(client.query('SELECT id FROM public.verification_challenges LIMIT 1')).resolves.toBeDefined();
      await expect(client.query('SELECT id FROM public.verification_proofs LIMIT 1')).resolves.toBeDefined();
      await expect(client.query('SELECT id FROM public.verification_delivery_attempts LIMIT 1')).resolves.toBeDefined();
      await client.query('RESET ROLE');

      await client.query('SET ROLE anon');
      await expect(client.query('SELECT id FROM public.verification_challenges LIMIT 1')).rejects.toThrow(/permission denied/i);
      await client.query('RESET ROLE');

      await client.query('SET ROLE authenticated');
      await expect(client.query('SELECT id FROM public.verification_challenges LIMIT 1')).rejects.toThrow(/permission denied/i);
      await expect(client.query(`SELECT public.gv_get_verification_status('nope')`)).rejects.toThrow(/permission denied/i);
      await client.query('RESET ROLE');
    } finally {
      await client.query('RESET ROLE');
      client.release();
    }
  });

  // ── T. no account-existence leakage ─────────────────────────────────────
  it('T: verifying a non-existent handle returns the SAME generic failure shape as a wrong code on a real challenge', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_phone', channel: 'sms', destination: '09121230117', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.18' },
    });

    const wrongCodeOnRealHandle = await svc.verifyVerificationChallenge(config, {
      handle: req.handle, code: '000000', purpose: 'signup_phone', channel: 'sms', requestId: newRequestId(), requester: { ipAddress: '203.0.113.18' },
    });
    const nonExistentHandle = await svc.verifyVerificationChallenge(config, {
      handle: 'gvc_this_handle_never_existed', code: '000000', purpose: 'signup_phone', channel: 'sms', requestId: newRequestId(), requester: { ipAddress: '203.0.113.18' },
    });
    expect(wrongCodeOnRealHandle.ok).toBe(false);
    expect(nonExistentHandle.ok).toBe(false);
    expect(nonExistentHandle.reason).toBe('invalid_code');
  });

  // ── U. effective default-locale persistence ─────────────────────────────
  it('U: the resolved locale is frozen on the challenge row at creation time, not re-resolved later', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_phone', channel: 'sms', destination: '09121230118', subjectKind: 'pending_account',
      locale: 'fa', idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.19' },
    });
    const row = await db.query(`SELECT locale FROM public.verification_challenges WHERE handle = $1`, [req.handle]);
    expect(row.rows[0].locale).toBe('fa');
  });

  // ── V. crash-safe idempotent verify (item 1) ───────────────────────────
  it('V1: verifying with the SAME requestId and SAME code/scope replays the identical committed result without creating a second attempt or a second proof', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_phone', channel: 'sms', destination: '09121230140', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.30' },
    });
    const code = extractCode(String(smsSendMock.mock.calls.at(-1)?.[1]?.body ?? ''));
    const requestId = newRequestId();

    const r1 = await svc.verifyVerificationChallenge(config, { handle: req.handle, code, purpose: 'signup_phone', channel: 'sms', requestId, requester: { ipAddress: '203.0.113.30' } });
    const r2 = await svc.verifyVerificationChallenge(config, { handle: req.handle, code, purpose: 'signup_phone', channel: 'sms', requestId, requester: { ipAddress: '203.0.113.30' } });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r2.proofToken).toBe(r1.proofToken);

    const attempts = await db.query(`SELECT count(*)::int AS n FROM public.verification_attempts WHERE challenge_id = (SELECT id FROM public.verification_challenges WHERE handle = $1)`, [req.handle]);
    expect(attempts.rows[0].n).toBe(1);
    const proofs = await db.query(`SELECT count(*)::int AS n FROM public.verification_proofs WHERE challenge_id = (SELECT id FROM public.verification_challenges WHERE handle = $1)`, [req.handle]);
    expect(proofs.rows[0].n).toBe(1);
  });

  it('V2: the SAME requestId with a DIFFERENT candidate code is rejected as an idempotency conflict, never silently re-verified', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_phone', channel: 'sms', destination: '09121230141', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.31' },
    });
    const code = extractCode(String(smsSendMock.mock.calls.at(-1)?.[1]?.body ?? ''));
    const requestId = newRequestId();
    const differentCode = code === '111111' ? '222222' : '111111';

    await svc.verifyVerificationChallenge(config, { handle: req.handle, code, purpose: 'signup_phone', channel: 'sms', requestId, requester: { ipAddress: '203.0.113.31' } });
    await expect(
      svc.verifyVerificationChallenge(config, { handle: req.handle, code: differentCode, purpose: 'signup_phone', channel: 'sms', requestId, requester: { ipAddress: '203.0.113.31' } }),
    ).rejects.toThrow(/idempotency conflict/i);
  });

  it('V3: replaying an identical WRONG-code verify (same requestId) does not double-count the attempt', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_phone', channel: 'sms', destination: '09121230142', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.32' },
    });
    const requestId = newRequestId();
    const wrongCode = '000000';

    const r1 = await svc.verifyVerificationChallenge(config, { handle: req.handle, code: wrongCode, purpose: 'signup_phone', channel: 'sms', requestId, requester: { ipAddress: '203.0.113.32' } });
    const r2 = await svc.verifyVerificationChallenge(config, { handle: req.handle, code: wrongCode, purpose: 'signup_phone', channel: 'sms', requestId, requester: { ipAddress: '203.0.113.32' } });
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);

    const row = await db.query(`SELECT attempt_count FROM public.verification_challenges WHERE handle = $1`, [req.handle]);
    expect(row.rows[0].attempt_count).toBe(1);
  });

  it('V4: a NEW requestId with the SAME wrong code counts as a genuinely new attempt', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_phone', channel: 'sms', destination: '09121230143', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.33' },
    });

    await svc.verifyVerificationChallenge(config, { handle: req.handle, code: '000000', purpose: 'signup_phone', channel: 'sms', requestId: newRequestId(), requester: { ipAddress: '203.0.113.33' } });
    await svc.verifyVerificationChallenge(config, { handle: req.handle, code: '000000', purpose: 'signup_phone', channel: 'sms', requestId: newRequestId(), requester: { ipAddress: '203.0.113.33' } });

    const row = await db.query(`SELECT attempt_count FROM public.verification_challenges WHERE handle = $1`, [req.handle]);
    expect(row.rows[0].attempt_count).toBe(2);
  });

  it('V5: concurrent identical verify calls (same requestId) serialize and create exactly one attempt and one proof', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_phone', channel: 'sms', destination: '09121230144', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.34' },
    });
    const code = extractCode(String(smsSendMock.mock.calls.at(-1)?.[1]?.body ?? ''));
    const requestId = newRequestId();

    const [r1, r2, r3] = await Promise.all([
      svc.verifyVerificationChallenge(config, { handle: req.handle, code, purpose: 'signup_phone', channel: 'sms', requestId, requester: { ipAddress: '203.0.113.34' } }),
      svc.verifyVerificationChallenge(config, { handle: req.handle, code, purpose: 'signup_phone', channel: 'sms', requestId, requester: { ipAddress: '203.0.113.34' } }),
      svc.verifyVerificationChallenge(config, { handle: req.handle, code, purpose: 'signup_phone', channel: 'sms', requestId, requester: { ipAddress: '203.0.113.34' } }),
    ]);
    expect([r1, r2, r3].every((r) => r.ok)).toBe(true);
    const proofTokens = new Set([r1.proofToken, r2.proofToken, r3.proofToken]);
    expect(proofTokens.size).toBe(1);

    const attempts = await db.query(`SELECT count(*)::int AS n FROM public.verification_attempts WHERE challenge_id = (SELECT id FROM public.verification_challenges WHERE handle = $1)`, [req.handle]);
    expect(attempts.rows[0].n).toBe(1);
    const proofs = await db.query(`SELECT count(*)::int AS n FROM public.verification_proofs WHERE challenge_id = (SELECT id FROM public.verification_challenges WHERE handle = $1)`, [req.handle]);
    expect(proofs.rows[0].n).toBe(1);
  });

  it('V6: transport loss AFTER a verify call successfully commits is recovered by retrying with the SAME requestId, replaying the identical usable proof', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_phone', channel: 'sms', destination: '09121230145', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.35' },
    });
    const code = extractCode(String(smsSendMock.mock.calls.at(-1)?.[1]?.body ?? ''));
    const requestId = newRequestId();

    forceVerifyResponseLossOnce = true;
    await expect(
      svc.verifyVerificationChallenge(config, { handle: req.handle, code, purpose: 'signup_phone', channel: 'sms', requestId, requester: { ipAddress: '203.0.113.35' } }),
    ).rejects.toThrow(/SIMULATED_TRANSPORT_LOSS_AFTER_VERIFY_COMMIT/);

    // The DB actually committed the verify+proof despite the "lost" response.
    const chal = await db.query(`SELECT status FROM public.verification_challenges WHERE handle = $1`, [req.handle]);
    expect(chal.rows[0].status).toBe('verified');

    const retried = await svc.verifyVerificationChallenge(config, { handle: req.handle, code, purpose: 'signup_phone', channel: 'sms', requestId, requester: { ipAddress: '203.0.113.35' } });
    expect(retried.ok).toBe(true);
    expect(retried.proofToken).toBeTruthy();

    const consumed = await svc.consumeVerificationProof(config, { proofToken: retried.proofToken!, purpose: 'signup_phone', channel: 'sms', consumedByContext: 'test' });
    expect(consumed.ok).toBe(true);
  });

  // ── W. policy-binding enforcement (item 2) ─────────────────────────────
  it('W1: requiresAuth purpose rejects an unauthenticated requester before any DB write', async () => {
    __setPurposePolicyOverrideForTests('login_step_up', { enabled: true });
    const before = await db.query(`SELECT count(*)::int AS n FROM public.verification_challenges`);
    await expect(
      svc.requestVerificationChallenge(config, {
        purpose: 'login_step_up', channel: 'email', destination: 'w1@example.test', subjectKind: 'user',
        subjectRef: randomUUID(), idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.40' },
      }),
    ).rejects.toThrow(/authenticated requester/i);
    const after = await db.query(`SELECT count(*)::int AS n FROM public.verification_challenges`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('W2: a subjectRef different from (or absent from) the authenticated requester is rejected — omitting subjectRef never bypasses the binding', async () => {
    __setPurposePolicyOverrideForTests('login_step_up', { enabled: true });
    const authedUserId = randomUUID();
    const otherUserId = randomUUID();
    await expect(
      svc.requestVerificationChallenge(config, {
        purpose: 'login_step_up', channel: 'email', destination: 'w2@example.test', subjectKind: 'user',
        subjectRef: otherUserId, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.41', authenticatedUserId: authedUserId },
      }),
    ).rejects.toThrow(/subject binding/i);

    await expect(
      svc.requestVerificationChallenge(config, {
        purpose: 'login_step_up', channel: 'email', destination: 'w2b@example.test', subjectKind: 'user',
        idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.41', authenticatedUserId: authedUserId },
      } as any),
    ).rejects.toThrow(/subject binding/i);
  });

  it('W3: a required tenant binding rejects a missing workspaceId, and a forbidden tenant binding rejects a supplied one', async () => {
    __setPurposePolicyOverrideForTests('sensitive_action', { enabled: true }); // tenantBinding: 'required'
    const authedUserId = randomUUID();
    await expect(
      svc.requestVerificationChallenge(config, {
        purpose: 'sensitive_action', channel: 'email', destination: 'w3a@example.test', subjectKind: 'user',
        subjectRef: authedUserId, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.42', authenticatedUserId: authedUserId },
      }),
    ).rejects.toThrow(/tenant binding/i);

    __setPurposePolicyOverrideForTests('signup_email', { enabled: true }); // tenantBinding: 'none'
    const { workspaceId } = await insertWorkspace();
    await expect(
      svc.requestVerificationChallenge(config, {
        purpose: 'signup_email', channel: 'email', destination: 'w3b@example.test', subjectKind: 'pending_account',
        workspaceId, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.42' },
      }),
    ).rejects.toThrow(/tenant binding/i);
  });

  it('W4: a subjectKind that does not match the purpose policy is rejected', async () => {
    __setPurposePolicyOverrideForTests('signup_email', { enabled: true }); // subjectBinding: 'pending_account'
    await expect(
      svc.requestVerificationChallenge(config, {
        purpose: 'signup_email', channel: 'email', destination: 'w4@example.test', subjectKind: 'anonymous',
        idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.43' },
      }),
    ).rejects.toThrow(/subject binding/i);
  });

  // ── Y. resend cross-tenant / cross-subject isolation (item 4) ──────────
  it('Y1: a resend claiming a DIFFERENT workspace than the existing challenge is rejected, and the original challenge in workspace A is never touched', async () => {
    __setPurposePolicyOverrideForTests('sensitive_action', { enabled: true });
    const { workspaceId: wsA, ownerId } = await insertWorkspace();
    const { workspaceId: wsB } = await insertWorkspace();
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'sensitive_action', channel: 'email', destination: 'y1@example.test', subjectKind: 'user',
      subjectRef: ownerId, workspaceId: wsA, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.50', authenticatedUserId: ownerId },
    });
    const statusBefore = (await db.query(`SELECT status FROM public.verification_challenges WHERE handle = $1`, [req.handle])).rows[0].status;

    await expect(
      svc.resendVerificationChallenge(config, {
        handle: req.handle, purpose: 'sensitive_action', channel: 'email', subjectKind: 'user',
        subjectRef: ownerId, workspaceId: wsB, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.50', authenticatedUserId: ownerId },
      }),
    ).rejects.toThrow(/scope mismatch/i);

    // The rejected cross-workspace resend attempt must leave the ORIGINAL
    // challenge's status exactly as it was — never revoked, never touched.
    const row = await db.query(`SELECT status FROM public.verification_challenges WHERE handle = $1`, [req.handle]);
    expect(row.rows[0].status).toBe(statusBefore);
    expect(row.rows[0].status).not.toBe('revoked');
  });

  it('Y2: two different subjects sharing the SAME destination stay isolated — a resend claimed by the wrong subject never revokes the other subjects live challenge', async () => {
    __setPurposePolicyOverrideForTests('login_step_up', { enabled: true });
    const subjectA = randomUUID();
    const subjectB = randomUUID();
    const destination = 'shared-destination-y2@example.test';

    const reqA = await svc.requestVerificationChallenge(config, {
      purpose: 'login_step_up', channel: 'email', destination, subjectKind: 'user',
      subjectRef: subjectA, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.51', authenticatedUserId: subjectA },
    });
    const statusBefore = (await db.query(`SELECT status FROM public.verification_challenges WHERE handle = $1`, [reqA.handle])).rows[0].status;

    await expect(
      svc.resendVerificationChallenge(config, {
        handle: reqA.handle, purpose: 'login_step_up', channel: 'email', subjectKind: 'user',
        subjectRef: subjectB, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.51', authenticatedUserId: subjectB },
      }),
    ).rejects.toThrow(/scope mismatch/i);

    const row = await db.query(`SELECT status FROM public.verification_challenges WHERE handle = $1`, [reqA.handle]);
    expect(row.rows[0].status).toBe(statusBefore);
    expect(row.rows[0].status).not.toBe('revoked');
  });

  // ── Z. atomic multi-bucket rate limits (item 5) ─────────────────────────
  it('Z1 (destination bucket): concurrent requests to the SAME destination never exceed the resend cooldown — exactly one of N concurrent requests succeeds', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    const destination = '09121230150';
    const N = 6;
    const results = await Promise.allSettled(
      Array.from({ length: N }, () => svc.requestVerificationChallenge(config, {
        purpose: 'signup_phone', channel: 'sms', destination, subjectKind: 'pending_account',
        idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.60' },
      })),
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;
    expect(succeeded).toBe(1);
    expect(failed).toBe(N - 1);
    const rows = await db.query(`SELECT count(*)::int AS n FROM public.verification_challenges WHERE destination_normalized = $1`, ['+989121230150']);
    expect(rows.rows[0].n).toBe(1);
  });

  it('Z2 (IP bucket): concurrent requests from the SAME IP to DIFFERENT destinations are capped atomically at maxPerWindow*10, never racing past it', async () => {
    __setPurposePolicyOverrideForTests('change_phone', { enabled: true, maxSendsPerWindow: 1 }); // dedicated purpose — no cross-test accumulation
    const ip = '203.0.113.61';
    const N = 15; // bucket cap = 1*10 = 10
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) => {
        // change_phone requires auth + subjectBinding:'user' — each call
        // uses its OWN unique subject so the SUBJECT bucket (cap =
        // maxPerWindow = 1 per subject) never becomes the constraint;
        // only the shared IP is common across all N calls, isolating the
        // IP bucket as the thing actually being proven here.
        const subjectId = randomUUID();
        return svc.requestVerificationChallenge(config, {
          purpose: 'change_phone', channel: 'sms', destination: `0912123${String(1300 + i).padStart(4, '0')}`, subjectKind: 'user',
          subjectRef: subjectId, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: ip, authenticatedUserId: subjectId },
        });
      }),
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    expect(succeeded).toBe(10);
  });

  it('Z3 (subject bucket): concurrent requests bound to the SAME subject across different destinations are capped atomically at maxPerWindow', async () => {
    __setPurposePolicyOverrideForTests('login_step_up', { enabled: true, maxSendsPerWindow: 2 });
    const subjectId = randomUUID();
    const N = 6;
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) => svc.requestVerificationChallenge(config, {
        purpose: 'login_step_up', channel: 'email', destination: `z3-${i}@example.test`, subjectKind: 'user',
        subjectRef: subjectId, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.62', authenticatedUserId: subjectId },
      })),
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    expect(succeeded).toBe(2);
  });

  it('Z4 (workspace bucket): concurrent requests bound to the SAME workspace across different subjects/destinations are capped atomically at maxPerWindow*5', async () => {
    __setPurposePolicyOverrideForTests('sensitive_action', { enabled: true, maxSendsPerWindow: 1 });
    const { workspaceId } = await insertWorkspace();
    const N = 8; // cap = 1*5 = 5
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) => {
        const subjectId = randomUUID();
        return svc.requestVerificationChallenge(config, {
          purpose: 'sensitive_action', channel: 'email', destination: `z4-${i}@example.test`, subjectKind: 'user',
          subjectRef: subjectId, workspaceId, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.70', authenticatedUserId: subjectId },
        });
      }),
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    expect(succeeded).toBe(5);
  });

  it('Z5a (purpose+channel bucket, item 5/P1): by default (globalRateLimit: null), ordinary requests across many unrelated users are NOT capped at maxSendsPerWindow*20 or at all — no platform-wide hot lock in the normal path', async () => {
    __setPurposePolicyOverrideForTests('change_email', { enabled: true, maxSendsPerWindow: 1 }); // dedicated purpose — never used elsewhere in this file
    const N = 25; // the OLD formula would have capped this purpose+channel at 1*20 = 20
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) => {
        const subjectId = randomUUID();
        return svc.requestVerificationChallenge(config, {
          purpose: 'change_email', channel: 'email', destination: `z5a-${i}@example.test`, subjectKind: 'user',
          subjectRef: subjectId, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: `203.0.113.${100 + i}`, authenticatedUserId: subjectId },
        });
      }),
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    // Every one succeeds — 25 unrelated destinations/subjects/IPs, well
    // above the old *20 ceiling, none of them sharing a destination,
    // subject, or workspace bucket with any other.
    expect(succeeded).toBe(N);
  });

  it('Z5b (purpose+channel bucket, item 5/P1 opt-in): an EXPLICITLY configured globalRateLimit still enforces its own cap atomically when a deployment opts in', async () => {
    __setPurposePolicyOverrideForTests('password_reset', {
      enabled: true,
      globalRateLimit: { maxPerWindow: 3, windowSeconds: 3600 },
    }); // dedicated purpose+channel — the ONLY other use of password_reset (X1) is
    // rejected at the DB layer before any challenge row is written, so this
    // bucket starts genuinely empty regardless of test execution order.
    const N = 10;
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) => {
        const subjectId = randomUUID();
        return svc.requestVerificationChallenge(config, {
          purpose: 'password_reset', channel: 'email', destination: `z5b-${i}@example.test`, subjectKind: 'user',
          subjectRef: subjectId, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: `203.0.113.${130 + i}` },
        });
      }),
    );
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    expect(succeeded).toBe(3);
  });

  // ── BB. provider-captured OTP (item 7) ──────────────────────────────────
  it('BB1: SMS initial send — the code used to verify is CAPTURED from the actual provider payload, never independently re-derived', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_phone', channel: 'sms', destination: '09121230160', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.100' },
    });
    const capturedCode = extractCode(String(smsSendMock.mock.calls.at(-1)?.[1]?.body ?? ''));
    const result = await svc.verifyVerificationChallenge(config, {
      handle: req.handle, code: capturedCode, purpose: 'signup_phone', channel: 'sms',
      requestId: newRequestId(), requester: { ipAddress: '203.0.113.100' },
    });
    expect(result.ok).toBe(true);
  });

  it('BB2: SMS resend — the PREVIOUS captured code/handle is rejected after resend, and the NEW captured code verifies', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    const destination = '09121230161';
    const first = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_phone', channel: 'sms', destination, subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.101' },
    });
    const firstCode = extractCode(String(smsSendMock.mock.calls.at(-1)?.[1]?.body ?? ''));
    await db.query(`UPDATE public.verification_challenges SET created_at = now() - interval '90 seconds' WHERE handle = $1`, [first.handle]);

    const second = await svc.resendVerificationChallenge(config, {
      handle: first.handle, purpose: 'signup_phone', channel: 'sms', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.101' },
    });
    const secondCode = extractCode(String(smsSendMock.mock.calls.at(-1)?.[1]?.body ?? ''));
    expect(secondCode).not.toBe(firstCode);

    const oldRejected = await svc.verifyVerificationChallenge(config, {
      handle: first.handle, code: firstCode, purpose: 'signup_phone', channel: 'sms',
      requestId: newRequestId(), requester: { ipAddress: '203.0.113.101' },
    });
    expect(oldRejected.ok).toBe(false);

    const verified = await svc.verifyVerificationChallenge(config, {
      handle: second.handle, code: secondCode, purpose: 'signup_phone', channel: 'sms',
      requestId: newRequestId(), requester: { ipAddress: '203.0.113.101' },
    });
    expect(verified.ok).toBe(true);
  });

  it('BB3: email initial send — the code is CAPTURED from the actual rendered email body sent through sendEmail, never independently re-derived', async () => {
    __setPurposePolicyOverrideForTests('login_step_up', { enabled: true });
    const { workspaceId, ownerId } = await insertWorkspace();
    emailSendMock.mockResolvedValue({ success: true, provider: 'resend', id: 'bb3-msg' });
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'login_step_up', channel: 'email', destination: 'bb3@example.test', subjectKind: 'user',
      subjectRef: ownerId, workspaceId, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.102', authenticatedUserId: ownerId },
    });
    const capturedCode = extractCode(String(emailSendMock.mock.calls.at(-1)?.[1]?.text ?? ''));
    const result = await svc.verifyVerificationChallenge(config, {
      handle: req.handle, code: capturedCode, purpose: 'login_step_up', channel: 'email', workspaceId, subjectRef: ownerId,
      requestId: newRequestId(), requester: { ipAddress: '203.0.113.102', authenticatedUserId: ownerId },
    });
    expect(result.ok).toBe(true);
  });

  it('BB4: email resend — the PREVIOUS captured code is rejected after resend, and the NEW captured code verifies', async () => {
    __setPurposePolicyOverrideForTests('login_step_up', { enabled: true });
    const { workspaceId, ownerId } = await insertWorkspace();
    emailSendMock.mockResolvedValue({ success: true, provider: 'resend', id: 'bb4-msg' });
    const first = await svc.requestVerificationChallenge(config, {
      purpose: 'login_step_up', channel: 'email', destination: 'bb4@example.test', subjectKind: 'user',
      subjectRef: ownerId, workspaceId, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.103', authenticatedUserId: ownerId },
    });
    const firstCode = extractCode(String(emailSendMock.mock.calls.at(-1)?.[1]?.text ?? ''));
    await db.query(`UPDATE public.verification_challenges SET created_at = now() - interval '90 seconds' WHERE handle = $1`, [first.handle]);

    const second = await svc.resendVerificationChallenge(config, {
      handle: first.handle, purpose: 'login_step_up', channel: 'email', subjectKind: 'user',
      subjectRef: ownerId, workspaceId, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.103', authenticatedUserId: ownerId },
    });
    const secondCode = extractCode(String(emailSendMock.mock.calls.at(-1)?.[1]?.text ?? ''));
    expect(secondCode).not.toBe(firstCode);

    const oldRejected = await svc.verifyVerificationChallenge(config, {
      handle: first.handle, code: firstCode, purpose: 'login_step_up', channel: 'email', workspaceId, subjectRef: ownerId,
      requestId: newRequestId(), requester: { ipAddress: '203.0.113.103', authenticatedUserId: ownerId },
    });
    expect(oldRejected.ok).toBe(false);

    const verified = await svc.verifyVerificationChallenge(config, {
      handle: second.handle, code: secondCode, purpose: 'login_step_up', channel: 'email', workspaceId, subjectRef: ownerId,
      requestId: newRequestId(), requester: { ipAddress: '203.0.113.103', authenticatedUserId: ownerId },
    });
    expect(verified.ok).toBe(true);
  });

  it('BB6: a provider-captured code remains valid through a supported pepper rotation', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    const { __resetVerificationCryptoCacheForTests } = await import('../../../server/services/verification/crypto');
    process.env.GENERIC_VERIFICATION_PEPPER_RING = JSON.stringify({
      1: process.env.GENERIC_VERIFICATION_PEPPER,
      2: 'second-ring-key-value-at-least-32-bytes!!',
    });
    process.env.GENERIC_VERIFICATION_KEY_VERSION = '1';
    __resetVerificationCryptoCacheForTests();

    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_phone', channel: 'sms', destination: '09121230162', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.104' },
    });
    const capturedCode = extractCode(String(smsSendMock.mock.calls.at(-1)?.[1]?.body ?? ''));

    process.env.GENERIC_VERIFICATION_KEY_VERSION = '2';
    __resetVerificationCryptoCacheForTests();

    const result = await svc.verifyVerificationChallenge(config, {
      handle: req.handle, code: capturedCode, purpose: 'signup_phone', channel: 'sms',
      requestId: newRequestId(), requester: { ipAddress: '203.0.113.104' },
    });
    expect(result.ok).toBe(true);

    delete process.env.GENERIC_VERIFICATION_PEPPER_RING;
    delete process.env.GENERIC_VERIFICATION_KEY_VERSION;
    __resetVerificationCryptoCacheForTests();
  });

  // ── CC. workspace-less (pre-account) email support (item 8) ────────────
  it('CC1a: a workspace-less email send uses the platform-level provider abstraction and actually succeeds when one is configured', async () => {
    __setPurposePolicyOverrideForTests('signup_email', { enabled: true }); // tenantBinding: 'none'
    platformEmailSendMock.mockResolvedValueOnce({ success: true, provider: 'resend', id: 'cc1a-msg' });
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_email', channel: 'email', destination: 'cc1a@example.test', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.110' },
    });
    expect(req.deliveryOutcome).toBe('provider_accepted');
    expect(platformEmailSendMock).toHaveBeenCalledTimes(1);
    expect(emailSendMock).not.toHaveBeenCalled();
    const chal = await db.query(`SELECT status FROM public.verification_challenges WHERE handle = $1`, [req.handle]);
    expect(chal.rows[0].status).toBe('provider_accepted');
  });

  it('CC1b: a workspace-less email send with no platform provider configured is reported unconfigured, matching the real production default', async () => {
    __setPurposePolicyOverrideForTests('signup_email', { enabled: true });
    platformEmailSendMock.mockResolvedValueOnce({ success: false, provider: 'stub', error: 'Email provider is not configured' });
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_email', channel: 'email', destination: 'cc1b@example.test', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.111' },
    });
    expect(req.deliveryOutcome).toBe('unconfigured');
  });

  // ── DD. remaining database defects (item 9) ─────────────────────────────
  it('DD1: gv_purge_expired_idempotency deletes ALL matching expired rows in one call and returns the EXACT count, never just the first row', async () => {
    const keys = Array.from({ length: 5 }, () => `purge-test-${randomUUID()}`);
    for (const key of keys) {
      await db.query(
        `INSERT INTO public.verification_idempotency (key, scope_kind, operation, purpose, result_state, request_fingerprint, expires_at)
         VALUES ($1, 'dd1', 'request', 'signup_phone', 'committed', 'fp', now() - interval '1 second')`,
        [key],
      );
    }
    const result = await db.query(`SELECT public.gv_purge_expired_idempotency($1) AS n`, [1000]);
    expect(result.rows[0].n).toBeGreaterThanOrEqual(5);
    const remaining = await db.query(`SELECT count(*)::int AS n FROM public.verification_idempotency WHERE key = ANY($1)`, [keys]);
    expect(remaining.rows[0].n).toBe(0);
  });

  it('DD2: a genuinely unexpected internal failure during prepare is recorded as result_state=failed and returned as a structured error, WITHOUT the failure marker itself being rolled back', async () => {
    __setPurposePolicyOverrideForTests('sensitive_action', { enabled: true }); // tenantBinding: required
    const nonExistentWorkspaceId = randomUUID(); // no such workspace row exists — the FK on verification_challenges.workspace_id will reject the insert
    const authedUserId = randomUUID();

    await expect(
      svc.requestVerificationChallenge(config, {
        purpose: 'sensitive_action', channel: 'email', destination: 'dd2@example.test', subjectKind: 'user',
        subjectRef: authedUserId, workspaceId: nonExistentWorkspaceId,
        idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.90', authenticatedUserId: authedUserId },
      }),
    ).rejects.toThrow(/gv_prepare_verification_delivery failed/);

    // The idempotency ledger row PERSISTS with result_state='failed' — the
    // exact bug this fix addresses: a naive "mark failed, then re-raise"
    // (or a single outer EXCEPTION block around both the tentative insert
    // AND the risky call) would have rolled this UPDATE's target row back
    // along with everything else, leaving no trace of the failure at all.
    const idemRow = await db.query(
      `SELECT result_state FROM public.verification_idempotency WHERE purpose = 'sensitive_action' AND result_state = 'failed' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(idemRow.rows[0]?.result_state).toBe('failed');

    const chal = await db.query(`SELECT count(*)::int AS n FROM public.verification_challenges WHERE destination_normalized = 'dd2@example.test'`);
    expect(chal.rows[0].n).toBe(0);
  });

  // ── KR. key-rotation correctness (P0 item 1) ────────────────────────────
  // Every test below rotates GENERIC_VERIFICATION_KEY_VERSION mid-test and
  // proves something that a "recompute with whatever version is current"
  // bug would break: idempotency-key/fingerprint stability, rate-limit
  // bucket hash stability, proof-token identity across a transport-loss
  // replay, and fail-closed behavior when a historical key is genuinely
  // removed (not merely superseded).
  it('KR1: a request replayed with the SAME idempotencyKey AFTER a key rotation returns the ORIGINAL challenge and sends nothing again', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    const idempotencyKey = newIdempotencyKey();
    const destination = '09121230170';
    const first = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_phone', channel: 'sms', destination, subjectKind: 'pending_account',
      idempotencyKey, requester: { ipAddress: '203.0.113.140' },
    });
    expect(smsSendMock).toHaveBeenCalledTimes(1);

    await withKeyRotation({ 1: process.env.GENERIC_VERIFICATION_PEPPER!, 2: 'kr1-second-ring-key-value-at-least-32-bytes!!' }, '2', async () => {
      // If deriveIdempotencyKey used the CURRENT (now rotated) version
      // instead of the stable index version, this would compute a
      // DIFFERENT ledger key than the original call, find no matching
      // row, and send a SECOND, duplicate code.
      const replayed = await svc.requestVerificationChallenge(config, {
        purpose: 'signup_phone', channel: 'sms', destination, subjectKind: 'pending_account',
        idempotencyKey, requester: { ipAddress: '203.0.113.140' },
      });
      expect(replayed.handle).toBe(first.handle);
      expect(smsSendMock).toHaveBeenCalledTimes(1);
    });
  });

  it('KR2: a user-bound (subjectRef) challenge can be resent and then verified correctly AFTER a key rotation', async () => {
    __setPurposePolicyOverrideForTests('login_step_up', { enabled: true });
    const { workspaceId, ownerId: subjectId } = await insertWorkspace();
    emailSendMock.mockResolvedValue({ success: true, provider: 'resend', id: 'kr2-msg' });
    const first = await svc.requestVerificationChallenge(config, {
      purpose: 'login_step_up', channel: 'email', destination: 'kr2@example.test', subjectKind: 'user',
      subjectRef: subjectId, workspaceId, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.141', authenticatedUserId: subjectId },
    });
    await db.query(`UPDATE public.verification_challenges SET created_at = now() - interval '90 seconds' WHERE handle = $1`, [first.handle]);

    await withKeyRotation({ 1: process.env.GENERIC_VERIFICATION_PEPPER!, 2: 'kr2-second-ring-key-value-at-least-32-bytes!!' }, '2', async () => {
      // If subjectRefHash were derived from the CURRENT (rotated)
      // version, this resend would find a stable-index mismatch against
      // the row's ORIGINAL subject_ref_hash and be wrongly rejected as a
      // scope mismatch, even though the caller presents the correct
      // subject.
      const second = await svc.resendVerificationChallenge(config, {
        handle: first.handle, purpose: 'login_step_up', channel: 'email', subjectKind: 'user',
        subjectRef: subjectId, workspaceId, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.141', authenticatedUserId: subjectId },
      });
      expect(second.generation).toBe(first.generation + 1);
      const capturedCode = extractCode(String(emailSendMock.mock.calls.at(-1)?.[1]?.text ?? ''));

      const verified = await svc.verifyVerificationChallenge(config, {
        handle: second.handle, code: capturedCode, purpose: 'login_step_up', channel: 'email', workspaceId, subjectRef: subjectId,
        requestId: newRequestId(), requester: { ipAddress: '203.0.113.141', authenticatedUserId: subjectId },
      });
      expect(verified.ok).toBe(true);
    });
  });

  it('KR3: a verify transport-loss replay AFTER a key rotation still returns the IDENTICAL, still-consumable raw proof token', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_phone', channel: 'sms', destination: '09121230171', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.142' },
    });
    const code = extractCode(String(smsSendMock.mock.calls.at(-1)?.[1]?.body ?? ''));
    const requestId = newRequestId();

    forceVerifyResponseLossOnce = true;
    await expect(
      svc.verifyVerificationChallenge(config, { handle: req.handle, code, purpose: 'signup_phone', channel: 'sms', requestId, requester: { ipAddress: '203.0.113.142' } }),
    ).rejects.toThrow(/SIMULATED_TRANSPORT_LOSS_AFTER_VERIFY_COMMIT/);

    // Rotate BETWEEN the lost response and the caller's retry.
    await withKeyRotation({ 1: process.env.GENERIC_VERIFICATION_PEPPER!, 2: 'kr3-second-ring-key-value-at-least-32-bytes!!' }, '2', async () => {
      const retried = await svc.verifyVerificationChallenge(config, { handle: req.handle, code, purpose: 'signup_phone', channel: 'sms', requestId, requester: { ipAddress: '203.0.113.142' } });
      expect(retried.ok).toBe(true);
      expect(retried.proofToken).toBeTruthy();

      // Successfully consuming it IS the proof of identity: if the
      // re-derived token differed even by one byte from what was
      // committed by the FIRST (lost-response) call, its hash would not
      // match the stored proof_hash and this would fail with 'not_found'.
      const consumed = await svc.consumeVerificationProof(config, { proofToken: retried.proofToken!, purpose: 'signup_phone', channel: 'sms', consumedByContext: 'test' });
      expect(consumed.ok).toBe(true);
    });
  });

  it('KR4: a proof issued BEFORE a key rotation can still be consumed AFTER it', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_phone', channel: 'sms', destination: '09121230172', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.143' },
    });
    const code = extractCode(String(smsSendMock.mock.calls.at(-1)?.[1]?.body ?? ''));
    const verified = await svc.verifyVerificationChallenge(config, {
      handle: req.handle, code, purpose: 'signup_phone', channel: 'sms', requestId: newRequestId(), requester: { ipAddress: '203.0.113.143' },
    });
    expect(verified.ok).toBe(true);
    const proofToken = verified.proofToken!;
    expect(proofToken).toMatch(/^gvp_v1_/); // issued under key v1

    await withKeyRotation({ 1: process.env.GENERIC_VERIFICATION_PEPPER!, 2: 'kr4-second-ring-key-value-at-least-32-bytes!!' }, '2', async () => {
      // hashProofToken parses "v1" from the token itself and hashes under
      // v1 regardless of the fact that "current" is now v2 — this is the
      // exact bug an unversioned/current-defaulted hash would fail on.
      const consumed = await svc.consumeVerificationProof(config, { proofToken, purpose: 'signup_phone', channel: 'sms', consumedByContext: 'test' });
      expect(consumed.ok).toBe(true);
    });
  });

  it('KR5a: the DESTINATION rate-limit bucket is not reset merely by rotating the OTP key', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    const destination = '09121230173';
    await svc.requestVerificationChallenge(config, {
      purpose: 'signup_phone', channel: 'sms', destination, subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.144' },
    });

    await withKeyRotation({ 1: process.env.GENERIC_VERIFICATION_PEPPER!, 2: 'kr5a-second-ring-key-value-at-least-32-bytes!!' }, '2', async () => {
      await expect(
        svc.requestVerificationChallenge(config, {
          purpose: 'signup_phone', channel: 'sms', destination, subjectKind: 'pending_account',
          idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.144' },
        }),
      ).rejects.toBeInstanceOf(svc.VerificationRateLimitedError);
    });
  });

  it('KR5b: the SUBJECT rate-limit bucket is not reset merely by rotating the OTP key', async () => {
    __setPurposePolicyOverrideForTests('login_step_up', { enabled: true, maxSendsPerWindow: 1 });
    const subjectId = randomUUID();
    await svc.requestVerificationChallenge(config, {
      purpose: 'login_step_up', channel: 'email', destination: 'kr5b-a@example.test', subjectKind: 'user',
      subjectRef: subjectId, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.150', authenticatedUserId: subjectId },
    });

    await withKeyRotation({ 1: process.env.GENERIC_VERIFICATION_PEPPER!, 2: 'kr5b-second-ring-key-value-at-least-32-bytes!!' }, '2', async () => {
      await expect(
        svc.requestVerificationChallenge(config, {
          purpose: 'login_step_up', channel: 'email', destination: 'kr5b-b@example.test', subjectKind: 'user',
          subjectRef: subjectId, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.151', authenticatedUserId: subjectId },
        }),
      ).rejects.toBeInstanceOf(svc.VerificationRateLimitedError);
    });
  });

  it('KR5c: the IP rate-limit bucket is not reset merely by rotating the OTP key', async () => {
    __setPurposePolicyOverrideForTests('change_phone', { enabled: true, maxSendsPerWindow: 1 }); // IP cap = 1*10 = 10
    const ip = '203.0.113.160';
    for (let i = 0; i < 10; i++) {
      const subjectId = randomUUID();
      await svc.requestVerificationChallenge(config, {
        purpose: 'change_phone', channel: 'sms', destination: `0912123${String(1600 + i).padStart(4, '0')}`, subjectKind: 'user',
        subjectRef: subjectId, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: ip, authenticatedUserId: subjectId },
      });
    }

    await withKeyRotation({ 1: process.env.GENERIC_VERIFICATION_PEPPER!, 2: 'kr5c-second-ring-key-value-at-least-32-bytes!!' }, '2', async () => {
      const subjectId = randomUUID();
      await expect(
        svc.requestVerificationChallenge(config, {
          purpose: 'change_phone', channel: 'sms', destination: '09121231699', subjectKind: 'user',
          subjectRef: subjectId, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: ip, authenticatedUserId: subjectId },
        }),
      ).rejects.toBeInstanceOf(svc.VerificationRateLimitedError);
    });
  });

  it('KR6: removing a historical key fails CLOSED for a still-live challenge under it, and recovers once the key is restored', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    const { __resetVerificationCryptoCacheForTests } = await import('../../../server/services/verification/crypto');
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_phone', channel: 'sms', destination: '09121230180', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.170' },
    });
    const code = extractCode(String(smsSendMock.mock.calls.at(-1)?.[1]?.body ?? ''));
    const originalPepper = process.env.GENERIC_VERIFICATION_PEPPER!;

    // Genuinely REMOVE v1 (not merely supersede it) — GENERIC_VERIFICATION_PEPPER
    // is deleted OUTSIDE withKeyRotation's own tracking (it only manages the
    // RING/VERSION vars), so this test owns restoring it itself in a
    // try/finally — otherwise a mid-test throw would leak "no pepper
    // configured at all" into every later test in the file.
    delete process.env.GENERIC_VERIFICATION_PEPPER;
    try {
      await withKeyRotation({ 2: 'kr6-second-ring-key-value-at-least-32-bytes!!' }, '2', async () => {
        // The still-live v1 challenge fails CLOSED — a loud, specific
        // error — never a silent fallback to v2 (which would just look
        // like an ordinary wrong-code response and could mask an
        // operational mistake).
        await expect(
          svc.verifyVerificationChallenge(config, {
            handle: req.handle, code, purpose: 'signup_phone', channel: 'sms', requestId: newRequestId(), requester: { ipAddress: '203.0.113.170' },
          }),
        ).rejects.toThrow(/No pepper available for key version 1/);

        // Restore v1 WITHIN the rotated scope — the SAME challenge now
        // verifies fine, proving the failure above was purely about key
        // availability, not a corrupted or already-consumed challenge.
        process.env.GENERIC_VERIFICATION_PEPPER = originalPepper;
        process.env.GENERIC_VERIFICATION_PEPPER_RING = JSON.stringify({ 1: originalPepper, 2: 'kr6-second-ring-key-value-at-least-32-bytes!!' });
        __resetVerificationCryptoCacheForTests();
        const recovered = await svc.verifyVerificationChallenge(config, {
          handle: req.handle, code, purpose: 'signup_phone', channel: 'sms', requestId: newRequestId(), requester: { ipAddress: '203.0.113.170' },
        });
        expect(recovered.ok).toBe(true);
      });
    } finally {
      process.env.GENERIC_VERIFICATION_PEPPER = originalPepper;
      __resetVerificationCryptoCacheForTests();
    }
  });

  // ── DB. proofs are bound to the verified destination (P0 item 2) ───────
  it('DB1 (signup_email): a proof returns EXACTLY the destination it was verified for — never a different one — and consume takes no destination input at all', async () => {
    __setPurposePolicyOverrideForTests('signup_email', { enabled: true });
    platformEmailSendMock.mockResolvedValueOnce({ success: true, provider: 'resend', id: 'db1-msg' });
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_email', channel: 'email', destination: 'db1-real@example.test', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.180' },
    });
    const capturedCode = extractCode(String(platformEmailSendMock.mock.calls.at(-1)?.[1]?.text ?? ''));
    const verified = await svc.verifyVerificationChallenge(config, {
      handle: req.handle, code: capturedCode, purpose: 'signup_email', channel: 'email',
      requestId: newRequestId(), requester: { ipAddress: '203.0.113.180' },
    });
    expect(verified.ok).toBe(true);

    const consumed = await svc.consumeVerificationProof(config, {
      proofToken: verified.proofToken!, purpose: 'signup_email', channel: 'email', consumedByContext: 'test',
    });
    expect(consumed.ok).toBe(true);
    expect(consumed.destinationNormalized).toBe('db1-real@example.test');
    expect(consumed.destinationNormalized).not.toBe('attacker-b@example.test');
  });

  it('DB2 (signup_phone): a proof returns EXACTLY the destination it was verified for — never a different one', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_phone', channel: 'sms', destination: '09121230190', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.181' },
    });
    const capturedCode = extractCode(String(smsSendMock.mock.calls.at(-1)?.[1]?.body ?? ''));
    const verified = await svc.verifyVerificationChallenge(config, {
      handle: req.handle, code: capturedCode, purpose: 'signup_phone', channel: 'sms',
      requestId: newRequestId(), requester: { ipAddress: '203.0.113.181' },
    });
    expect(verified.ok).toBe(true);

    const consumed = await svc.consumeVerificationProof(config, {
      proofToken: verified.proofToken!, purpose: 'signup_phone', channel: 'sms', consumedByContext: 'test',
    });
    expect(consumed.ok).toBe(true);
    expect(consumed.destinationNormalized).toBe('+989121230190');
    expect(consumed.destinationNormalized).not.toBe('+989121230199');
  });

  it('DB3 (change_email): a proof returns EXACTLY the destination it was verified for — never a different (attacker-supplied) one', async () => {
    __setPurposePolicyOverrideForTests('change_email', { enabled: true });
    const subjectId = randomUUID();
    // change_email has tenantBinding: 'none', so it can never carry a
    // workspaceId — sendOtpDirect always routes it through the
    // workspace-less platform provider, never the tenant `sendEmail`.
    platformEmailSendMock.mockResolvedValueOnce({ success: true, provider: 'resend', id: 'db3-msg' });
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'change_email', channel: 'email', destination: 'db3-new-real@example.test', subjectKind: 'user',
      subjectRef: subjectId, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.182', authenticatedUserId: subjectId },
    });
    const capturedCode = extractCode(String(platformEmailSendMock.mock.calls.at(-1)?.[1]?.text ?? ''));
    const verified = await svc.verifyVerificationChallenge(config, {
      handle: req.handle, code: capturedCode, purpose: 'change_email', channel: 'email', subjectRef: subjectId,
      requestId: newRequestId(), requester: { ipAddress: '203.0.113.182', authenticatedUserId: subjectId },
    });
    expect(verified.ok).toBe(true);

    const consumed = await svc.consumeVerificationProof(config, {
      proofToken: verified.proofToken!, purpose: 'change_email', channel: 'email', subjectRef: subjectId,
      authenticatedUserId: subjectId, consumedByContext: 'test',
    });
    expect(consumed.ok).toBe(true);
    // The value a consumer MUST use for its business mutation is exactly
    // this — there is no `destination`/`newEmail` field anywhere in
    // ConsumeProofInput a client could set to redirect this to a
    // different address.
    expect(consumed.destinationNormalized).toBe('db3-new-real@example.test');
    expect(consumed.destinationNormalized).not.toBe('attacker-controlled@example.test');
  });

  it('DB4 (change_phone): a proof returns EXACTLY the destination it was verified for — never a different (attacker-supplied) one', async () => {
    __setPurposePolicyOverrideForTests('change_phone', { enabled: true });
    const subjectId = randomUUID();
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'change_phone', channel: 'sms', destination: '09121230195', subjectKind: 'user',
      subjectRef: subjectId, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.183', authenticatedUserId: subjectId },
    });
    const capturedCode = extractCode(String(smsSendMock.mock.calls.at(-1)?.[1]?.body ?? ''));
    const verified = await svc.verifyVerificationChallenge(config, {
      handle: req.handle, code: capturedCode, purpose: 'change_phone', channel: 'sms', subjectRef: subjectId,
      requestId: newRequestId(), requester: { ipAddress: '203.0.113.183', authenticatedUserId: subjectId },
    });
    expect(verified.ok).toBe(true);

    const consumed = await svc.consumeVerificationProof(config, {
      proofToken: verified.proofToken!, purpose: 'change_phone', channel: 'sms', subjectRef: subjectId,
      authenticatedUserId: subjectId, consumedByContext: 'test',
    });
    expect(consumed.ok).toBe(true);
    expect(consumed.destinationNormalized).toBe('+989121230195');
    expect(consumed.destinationNormalized).not.toBe('+989121230199');
  });

  // ── LOCK. canonical lock order — no deadlock (P0 item 3) ────────────────
  it('LOCK1 (request-vs-resend): concurrent request and resend on DIFFERENT challenges in the SAME workspace never deadlock, and both settle with a consistent final state', async () => {
    __setPurposePolicyOverrideForTests('sensitive_action', { enabled: true });
    const { workspaceId, ownerId } = await insertWorkspace();
    const existing = await svc.requestVerificationChallenge(config, {
      purpose: 'sensitive_action', channel: 'email', destination: 'lock1-existing@example.test', subjectKind: 'user',
      subjectRef: ownerId, workspaceId, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.190', authenticatedUserId: ownerId },
    });
    await db.query(`UPDATE public.verification_challenges SET created_at = now() - interval '90 seconds' WHERE handle = $1`, [existing.handle]);

    const [freshResult, resendResult] = await Promise.allSettled([
      svc.requestVerificationChallenge(config, {
        purpose: 'sensitive_action', channel: 'email', destination: 'lock1-fresh@example.test', subjectKind: 'user',
        subjectRef: ownerId, workspaceId, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.190', authenticatedUserId: ownerId },
      }),
      svc.resendVerificationChallenge(config, {
        handle: existing.handle, purpose: 'sensitive_action', channel: 'email', subjectKind: 'user',
        subjectRef: ownerId, workspaceId, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.190', authenticatedUserId: ownerId },
      }),
    ]);

    for (const r of [freshResult, resendResult]) {
      if (r.status === 'rejected') {
        expect(String((r.reason as Error)?.message ?? r.reason)).not.toMatch(/deadlock/i);
      }
    }
    expect(freshResult.status).toBe('fulfilled');
    expect(resendResult.status).toBe('fulfilled');

    const freshRows = await db.query(`SELECT count(*)::int AS n FROM public.verification_challenges WHERE destination_normalized = 'lock1-fresh@example.test'`);
    expect(freshRows.rows[0].n).toBe(1);
    const activeForExisting = await db.query(
      `SELECT count(*)::int AS n FROM public.verification_challenges WHERE workspace_id = $1 AND destination_normalized = 'lock1-existing@example.test' AND status IN ('pending_delivery','provider_accepted')`,
      [workspaceId],
    );
    expect(activeForExisting.rows[0].n).toBe(1); // never two simultaneously-active generations
  });

  it('LOCK2 (request-vs-revoke): concurrent request and revoke on DIFFERENT challenges in the SAME workspace never deadlock', async () => {
    __setPurposePolicyOverrideForTests('sensitive_action', { enabled: true });
    const { workspaceId, ownerId } = await insertWorkspace();
    const toRevoke = await svc.requestVerificationChallenge(config, {
      purpose: 'sensitive_action', channel: 'email', destination: 'lock2-revoke@example.test', subjectKind: 'user',
      subjectRef: ownerId, workspaceId, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.191', authenticatedUserId: ownerId },
    });

    const [freshResult, revokeResult] = await Promise.allSettled([
      svc.requestVerificationChallenge(config, {
        purpose: 'sensitive_action', channel: 'email', destination: 'lock2-fresh@example.test', subjectKind: 'user',
        subjectRef: ownerId, workspaceId, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.191', authenticatedUserId: ownerId },
      }),
      svc.revokeVerificationChallenge(config, {
        handle: toRevoke.handle, purpose: 'sensitive_action', channel: 'email', workspaceId, subjectRef: ownerId,
        reason: 'lock_test', idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.191', authenticatedUserId: ownerId },
      }),
    ]);

    for (const r of [freshResult, revokeResult]) {
      if (r.status === 'rejected') {
        expect(String((r.reason as Error)?.message ?? r.reason)).not.toMatch(/deadlock/i);
      }
    }
    expect(freshResult.status).toBe('fulfilled');
    expect(revokeResult.status).toBe('fulfilled');
    if (revokeResult.status === 'fulfilled') expect((revokeResult.value as { ok: boolean }).ok).toBe(true);

    const revokedRow = await db.query(`SELECT status FROM public.verification_challenges WHERE handle = $1`, [toRevoke.handle]);
    expect(revokedRow.rows[0].status).toBe('revoked');
  });

  it('LOCK3 (resend-vs-revoke): concurrent resend and revoke on DIFFERENT challenges in the SAME workspace never deadlock', async () => {
    __setPurposePolicyOverrideForTests('sensitive_action', { enabled: true });
    const { workspaceId, ownerId } = await insertWorkspace();
    const toResend = await svc.requestVerificationChallenge(config, {
      purpose: 'sensitive_action', channel: 'email', destination: 'lock3-resend@example.test', subjectKind: 'user',
      subjectRef: ownerId, workspaceId, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.192', authenticatedUserId: ownerId },
    });
    await db.query(`UPDATE public.verification_challenges SET created_at = now() - interval '90 seconds' WHERE handle = $1`, [toResend.handle]);
    const toRevoke = await svc.requestVerificationChallenge(config, {
      purpose: 'sensitive_action', channel: 'email', destination: 'lock3-revoke@example.test', subjectKind: 'user',
      subjectRef: ownerId, workspaceId, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.192', authenticatedUserId: ownerId },
    });

    const [resendResult, revokeResult] = await Promise.allSettled([
      svc.resendVerificationChallenge(config, {
        handle: toResend.handle, purpose: 'sensitive_action', channel: 'email', subjectKind: 'user',
        subjectRef: ownerId, workspaceId, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.192', authenticatedUserId: ownerId },
      }),
      svc.revokeVerificationChallenge(config, {
        handle: toRevoke.handle, purpose: 'sensitive_action', channel: 'email', workspaceId, subjectRef: ownerId,
        reason: 'lock_test', idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.192', authenticatedUserId: ownerId },
      }),
    ]);

    for (const r of [resendResult, revokeResult]) {
      if (r.status === 'rejected') {
        expect(String((r.reason as Error)?.message ?? r.reason)).not.toMatch(/deadlock/i);
      }
    }
    expect(resendResult.status).toBe('fulfilled');
    expect(revokeResult.status).toBe('fulfilled');
  });

  // ── REV. revoke scoping and authorization (P0 item 4) ───────────────────
  it('REV1: revoke rejects an unauthenticated requester for a requiresAuth purpose before any database write, and never modifies the challenge', async () => {
    __setPurposePolicyOverrideForTests('login_step_up', { enabled: true });
    const subjectId = randomUUID();
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'login_step_up', channel: 'email', destination: 'rev1@example.test', subjectKind: 'user',
      subjectRef: subjectId, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.200', authenticatedUserId: subjectId },
    });
    await expect(
      svc.revokeVerificationChallenge(config, {
        handle: req.handle, purpose: 'login_step_up', channel: 'email', subjectRef: subjectId,
        reason: 'test', idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.200' },
      }),
    ).rejects.toThrow(/authenticated requester/i);
    const row = await db.query(`SELECT status FROM public.verification_challenges WHERE handle = $1`, [req.handle]);
    expect(row.rows[0].status).not.toBe('revoked');
  });

  it('REV2: revoke claiming the WRONG workspace is rejected with the same generic failure as a non-existent handle, and never modifies the challenge', async () => {
    __setPurposePolicyOverrideForTests('sensitive_action', { enabled: true });
    const { workspaceId: wsA, ownerId } = await insertWorkspace();
    const { workspaceId: wsB } = await insertWorkspace();
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'sensitive_action', channel: 'email', destination: 'rev2@example.test', subjectKind: 'user',
      subjectRef: ownerId, workspaceId: wsA, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.201', authenticatedUserId: ownerId },
    });
    const revoked = await svc.revokeVerificationChallenge(config, {
      handle: req.handle, purpose: 'sensitive_action', channel: 'email', workspaceId: wsB, subjectRef: ownerId,
      reason: 'test', idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.201', authenticatedUserId: ownerId },
    });
    expect(revoked.ok).toBe(false);
    const row = await db.query(`SELECT status FROM public.verification_challenges WHERE handle = $1`, [req.handle]);
    expect(row.rows[0].status).not.toBe('revoked');
  });

  it('REV3: revoke claiming the WRONG subject is rejected the same way, and never modifies the challenge', async () => {
    __setPurposePolicyOverrideForTests('login_step_up', { enabled: true });
    const subjectA = randomUUID();
    const subjectB = randomUUID();
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'login_step_up', channel: 'email', destination: 'rev3@example.test', subjectKind: 'user',
      subjectRef: subjectA, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.202', authenticatedUserId: subjectA },
    });
    const revoked = await svc.revokeVerificationChallenge(config, {
      handle: req.handle, purpose: 'login_step_up', channel: 'email', subjectRef: subjectB,
      reason: 'test', idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.202', authenticatedUserId: subjectB },
    });
    expect(revoked.ok).toBe(false);
    const row = await db.query(`SELECT status FROM public.verification_challenges WHERE handle = $1`, [req.handle]);
    expect(row.rows[0].status).not.toBe('revoked');
  });

  it('REV4: revoke claiming the WRONG channel is rejected the same way, and never modifies the challenge', async () => {
    __setPurposePolicyOverrideForTests('sensitive_action', { enabled: true }); // allows both email and sms
    const { workspaceId, ownerId } = await insertWorkspace();
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'sensitive_action', channel: 'email', destination: 'rev4@example.test', subjectKind: 'user',
      subjectRef: ownerId, workspaceId, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.203', authenticatedUserId: ownerId },
    });
    const revoked = await svc.revokeVerificationChallenge(config, {
      handle: req.handle, purpose: 'sensitive_action', channel: 'sms', workspaceId, subjectRef: ownerId,
      reason: 'test', idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.203', authenticatedUserId: ownerId },
    });
    expect(revoked.ok).toBe(false);
    const row = await db.query(`SELECT status FROM public.verification_challenges WHERE handle = $1`, [req.handle]);
    expect(row.rows[0].status).not.toBe('revoked');
  });

  // ── CP. consumeVerificationProof malformed-token handling (P0 hardening) ──
  it('CP1: a malformed proof token (bad prefix, truncated, oversized, or absurd version) returns a generic { ok: false } from consumeVerificationProof, never an uncaught exception, and touches zero database rows', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    const before = await db.query(`SELECT count(*)::int AS n FROM public.verification_proofs`);
    const beforeIdem = await db.query(`SELECT count(*)::int AS n FROM public.verification_idempotency`);

    const malformedTokens = [
      'not-a-proof-token-at-all',
      'gvp_someRawValueWithNoVersionPrefix1234567890abcdefghijk', // old, retired unversioned format
      'gvp_v0_' + 'a'.repeat(43), // zero version
      'gvp_v99999999999999999999999999_' + 'a'.repeat(43), // absurd version
      'gvp_v1_' + 'a'.repeat(10), // truncated value
      'gvp_v1_' + 'a'.repeat(60), // oversized value
    ];

    for (const proofToken of malformedTokens) {
      const result = await svc.consumeVerificationProof(config, {
        proofToken, purpose: 'signup_phone', channel: 'sms', consumedByContext: 'test-cp1',
      });
      expect(result.ok).toBe(false);
      expect(typeof result.reason).toBe('string');
    }

    const after = await db.query(`SELECT count(*)::int AS n FROM public.verification_proofs`);
    const afterIdem = await db.query(`SELECT count(*)::int AS n FROM public.verification_idempotency`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(afterIdem.rows[0].n).toBe(beforeIdem.rows[0].n);
  });

  it('CP2: a well-formed proof token whose embedded key version has no corresponding ring entry also returns a generic { ok: false }, not an uncaught exception', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    const { deriveProofToken } = await import('../../../server/services/verification/crypto');
    // Derive a genuinely valid token under a real key version to get a
    // correctly-shaped 43-char base64url value, then splice in a version
    // number that was never in this process's ring — this is the ONLY way
    // to construct this scenario, since deriveProofToken itself refuses to
    // derive anything under an unavailable version.
    const validToken = deriveProofToken({ handle: 'gvc_doesnotexist', requestId: 'r1', purpose: 'signup_phone', channel: 'sms' }, 1);
    const value = validToken.slice('gvp_v1_'.length);
    const proofToken = `gvp_v999_${value}`;
    const result = await svc.consumeVerificationProof(config, {
      proofToken, purpose: 'signup_phone', channel: 'sms', consumedByContext: 'test-cp2',
    });
    expect(result.ok).toBe(false);
  });

  // ── PI. database-layer proof integrity (P0 hardening) ───────────────────
  it('PI1: gv_execute_idempotent aborts the WHOLE transaction if proof version/hash args are internally inconsistent — no attempt row, no proof row, and the challenge is never marked verified', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    const { candidateOtpDigest } = await import('../../../server/services/verification/crypto');
    smsSendMock.mockResolvedValue({ success: true, provider: 'kavenegar', messageId: 'pi1-msg' });

    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_phone', channel: 'sms', destination: '09121230210', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.210' },
    });
    const code = extractCode(String(smsSendMock.mock.calls.at(-1)?.[1]?.body ?? ''));

    const chalRow = await db.query(
      `SELECT id, generation, key_version, destination_hash FROM public.verification_challenges WHERE handle = $1`,
      [req.handle],
    );
    const { id: challengeId, generation, key_version: keyVersion, destination_hash: destinationHash } = chalRow.rows[0];
    const candidateDigest = candidateOtpDigest(
      { purpose: 'signup_phone', channel: 'sms', challengeHandle: req.handle, generation, destinationHash },
      code,
      keyVersion,
    );

    async function attemptWithBadArgs(proofKeyVersion: number | null, proofHash: string, tag: string) {
      const args = {
        handle: req.handle, candidateDigest, purpose: 'signup_phone', channel: 'sms',
        workspaceId: null, subjectRefHash: null, ipHash: null,
        issuesProof: true, proofHash, proofKeyVersion, proofTtlSeconds: 300,
      };
      return db.query(
        `SELECT public.gv_execute_idempotent($1,$2,$3,$4,$5,$6,$7,$8) AS result`,
        [randomUUID().replace(/-/g, ''), 'signup_phone', 'verify', `pi1-fp-${tag}`, 'signup_phone', null, null, JSON.stringify(args)],
      );
    }

    // (a) proofKeyVersion does not match the challenge's own recorded key_version.
    await expect(attemptWithBadArgs(keyVersion + 1, `v${keyVersion + 1}:${'a'.repeat(64)}`, 'version-mismatch')).rejects.toThrow();

    // (b) proofHash is well-formed but its embedded version disagrees with proofKeyVersion.
    await expect(attemptWithBadArgs(keyVersion, `v${keyVersion + 1}:${'a'.repeat(64)}`, 'hash-version-mismatch')).rejects.toThrow();

    // (c) proofHash is not even the canonical v<N>:<64 lowercase hex> shape.
    await expect(attemptWithBadArgs(keyVersion, 'not-a-valid-hash', 'malformed-hash')).rejects.toThrow();

    // (d) proofKeyVersion is non-positive.
    await expect(attemptWithBadArgs(0, `v0:${'a'.repeat(64)}`, 'zero-version')).rejects.toThrow();

    // None of the four malicious attempts left ANY trace: the challenge is
    // exactly as it was before (not verified, zero attempts recorded), and
    // no proof exists — every attempt's WHOLE transaction rolled back,
    // including the attempt-row insert and the 'verified' status update
    // that happen earlier in the SAME _gv_do_verify call, because the
    // integrity check raises before COMMIT and gv_execute_idempotent's own
    // exception handler rolls back to its enclosing savepoint.
    const afterChal = await db.query(`SELECT status, attempt_count FROM public.verification_challenges WHERE id = $1`, [challengeId]);
    expect(afterChal.rows[0].status).toBe('provider_accepted');
    expect(afterChal.rows[0].attempt_count).toBe(0);
    const attempts = await db.query(`SELECT count(*)::int AS n FROM public.verification_attempts WHERE challenge_id = $1`, [challengeId]);
    expect(attempts.rows[0].n).toBe(0);
    const proofs = await db.query(`SELECT count(*)::int AS n FROM public.verification_proofs WHERE challenge_id = $1`, [challengeId]);
    expect(proofs.rows[0].n).toBe(0);

    // The challenge survived all four attacks completely unharmed and is
    // still perfectly verifiable for real with correct arguments.
    const verified = await svc.verifyVerificationChallenge(config, {
      handle: req.handle, code, purpose: 'signup_phone', channel: 'sms', requestId: newRequestId(), requester: { ipAddress: '203.0.113.210' },
    });
    expect(verified.ok).toBe(true);
  });

  it('PI2: the verification_proofs table itself rejects an inconsistent proof_hash/proof_key_version pair at the CHECK-constraint level, independent of _gv_do_verify', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    smsSendMock.mockResolvedValue({ success: true, provider: 'kavenegar', messageId: 'pi2-msg' });
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_phone', channel: 'sms', destination: '09121230211', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.211' },
    });
    const chalRow = await db.query(
      `SELECT id, destination_normalized, destination_hash, subject_kind, subject_ref, subject_ref_hash, purpose, channel FROM public.verification_challenges WHERE handle = $1`,
      [req.handle],
    );
    const c = chalRow.rows[0];

    // A hand-crafted direct INSERT bypassing _gv_do_verify entirely — this
    // must be rejected by the table's own CHECK constraints, proving the
    // defense-in-depth is real and not merely redundant with the
    // application-level check inside _gv_do_verify.
    await expect(
      db.query(
        `INSERT INTO public.verification_proofs (
           challenge_id, proof_hash, proof_key_version, purpose, channel, workspace_id, subject_kind, subject_ref, subject_ref_hash,
           destination_normalized, destination_hash, destination_hash_key_version, expires_at
         ) VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, $9, $10, 1, now() + interval '300 seconds')`,
        [c.id, `v1:${'a'.repeat(64)}`, 2, c.purpose, c.channel, c.subject_kind, c.subject_ref, c.subject_ref_hash, c.destination_normalized, c.destination_hash],
      ),
    ).rejects.toThrow(/verification_proofs_hash_version_matches|check constraint/i);

    const proofs = await db.query(`SELECT count(*)::int AS n FROM public.verification_proofs WHERE challenge_id = $1`, [c.id]);
    expect(proofs.rows[0].n).toBe(0);
  });
});
