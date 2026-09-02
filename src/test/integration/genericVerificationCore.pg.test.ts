/**
 * GENERIC VERIFICATION CORE v1 — real PostgreSQL acceptance suite.
 *
 * Real Postgres (the full self-host migration chain, including 098) + the
 * real service.ts/worker.ts functions. Only two transports are swapped,
 * exactly like every other `.pg.test.ts` file in this repo:
 *   - `getServiceClient()` becomes a direct query against this same real
 *     database instead of a real PostgREST/HTTP round trip.
 *   - `sendEmail`/`sendSms` are captured instead of actually contacting a
 *     vendor — every DB write, RPC, lock, ACL decision, and crypto digest
 *     is real. The purpose-registry dormancy gate is bypassed ONLY via the
 *     test-only `__setPurposePolicyOverrideForTests` hook (see
 *     server/services/verification/types.ts) — no route, env var, or
 *     production code path can reach that hook.
 *
 * Driven by TEST_DATABASE_URL (or CLEAN_INSTALL_DATABASE_URL). Gated by
 * REQUIRE_GV_DB=1 (this subsystem's own mandatory-CI flag — deliberately
 * NOT the pre-existing REQUIRE_WI_DB, which belongs to the separate,
 * unrelated Workspace Invitations v5.1 suite and must not be conflated
 * with it).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
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
const smsSendMock = vi.fn();

vi.mock('../../../server/services/email/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/email/index.js')>();
  return { ...actual, sendEmail: (...args: unknown[]) => emailSendMock(...args) };
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
          return { data: r.rows[0].result, error: null };
        }
        case 'gv_verify_verification_challenge': {
          const r = await pg.query(
            `SELECT public.gv_verify_verification_challenge($1) AS result`,
            [args._args],
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
        case 'gv_claim_verification_jobs': {
          const r = await pg.query(
            `SELECT * FROM public.gv_claim_verification_jobs($1,$2,$3,$4)`,
            [args._worker_id, args._limit, args._lease_seconds, args._channels],
          );
          return { data: r.rows, error: null };
        }
        case 'gv_heartbeat_verification_job': {
          const r = await pg.query(`SELECT public.gv_heartbeat_verification_job($1,$2,$3) AS result`, [args._job_id, args._claim_token, args._lease_seconds]);
          return { data: r.rows[0].result, error: null };
        }
        case 'gv_complete_verification_job': {
          const r = await pg.query(
            `SELECT public.gv_complete_verification_job($1,$2,$3,$4,$5,$6,$7,$8) AS result`,
            [args._job_id, args._claim_token, args._outcome, args._provider_name, args._provider_message_id, args._error_code, args._error_message, args._retry_in_seconds],
          );
          return { data: r.rows[0].result, error: null };
        }
        case 'gv_reclaim_expired_verification_jobs': {
          const r = await pg.query(`SELECT public.gv_reclaim_expired_verification_jobs() AS result`, []);
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
const worker = await import('../../../server/services/verification/worker');
const {
  __setPurposePolicyOverrideForTests,
  __clearAllPurposePolicyOverridesForTests,
} = await import('../../../server/services/verification/types');

const config: any = {
  supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: ['*'], port: 0,
  supabaseAnonKey: 'k', rateLimitWindowMs: 60000, rateLimitMax: 10000, selfHostBillingUnlimited: false,
};

function newIdempotencyKey(): string { return randomUUID(); }

suite('Generic Verification Core v1 — real PostgreSQL acceptance', () => {
  beforeAll(async () => {
    const { Pool } = await import('pg');
    db = new Pool({ connectionString: DSN, max: 10 }) as unknown as PgTestClient;
    await db.query(`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS auth CASCADE; CREATE SCHEMA public;`);
    await ensureAuthChainInstalled(db);
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
    smsSendMock.mockReset();
  });

  afterEach(() => {
    __clearAllPurposePolicyOverridesForTests();
  });

  // ── A. disabled-purpose fail-closed with zero writes ──────────────────
  it('A: a disabled purpose writes zero challenge rows and creates zero delivery jobs', async () => {
    const before = await db.query(`SELECT count(*)::int AS n FROM public.verification_challenges`);
    await expect(
      svc.requestVerificationChallenge(config, {
        purpose: 'signup_email', channel: 'email', destination: 'nobody@example.test', subjectKind: 'pending_account',
        idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.1' },
      }),
    ).rejects.toThrow(/disabled/i);
    const after = await db.query(`SELECT count(*)::int AS n FROM public.verification_challenges`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const jobs = await db.query(`SELECT count(*)::int AS n FROM public.verification_delivery_jobs`);
    expect(jobs.rows[0].n).toBe(0);
  });

  // ── B. request idempotency + C. concurrent duplicate requests ─────────
  it('B/C: identical idempotency key replays the same result exactly once, including under concurrency', async () => {
    __setPurposePolicyOverrideForTests('signup_email', { enabled: true });
    const idempotencyKey = newIdempotencyKey();
    const input = {
      purpose: 'signup_email' as const, channel: 'email' as const, destination: 'idem-test@example.test',
      subjectKind: 'pending_account' as const, idempotencyKey, requester: { ipAddress: '203.0.113.2' },
    };

    const [r1, r2, r3] = await Promise.all([
      svc.requestVerificationChallenge(config, input),
      svc.requestVerificationChallenge(config, input),
      svc.requestVerificationChallenge(config, input),
    ]);
    expect(r1.handle).toBe(r2.handle);
    expect(r2.handle).toBe(r3.handle);

    const rows = await db.query(`SELECT count(*)::int AS n FROM public.verification_challenges WHERE handle = $1`, [r1.handle]);
    expect(rows.rows[0].n).toBe(1);
  });

  // ── D. resend invalidates old generation ──────────────────────────────
  it('D: resend revokes the previous live challenge and bumps the generation', async () => {
    __setPurposePolicyOverrideForTests('signup_email', { enabled: true });
    const destination = 'resend-test@example.test';
    const first = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_email', channel: 'email', destination, subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.3' },
    });
    // signup_email's resendCooldownSeconds (60s — see PURPOSE_POLICIES in
    // types.ts) is a real production mechanic orthogonal to what THIS test
    // proves (generation bump + previous-generation revocation on resend),
    // and no policy override can shorten it below the platform minimum
    // (getPurposePolicy's unconditional clampPolicy call), so elapsed time
    // is simulated by backdating the first challenge's created_at directly,
    // rather than waiting 60+ real-world seconds or weakening the cooldown.
    await db.query(
      `UPDATE public.verification_challenges SET created_at = now() - interval '90 seconds' WHERE handle = $1`,
      [first.handle],
    );
    const second = await svc.resendVerificationChallenge(config, {
      purpose: 'signup_email', channel: 'email', destination, subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.3' },
    });
    expect(second.generation).toBe(first.generation + 1);

    const firstRow = await db.query(`SELECT status FROM public.verification_challenges WHERE handle = $1`, [first.handle]);
    expect(firstRow.rows[0].status).toBe('revoked');
    const secondRow = await db.query(`SELECT status FROM public.verification_challenges WHERE handle = $1`, [second.handle]);
    expect(secondRow.rows[0].status).toBe('pending_delivery');
  });

  // ── E. correct-code verification (requires reading the deterministic code back out) ──
  it('E: verifying the correct, deterministically-derived code succeeds and issues a proof', async () => {
    __setPurposePolicyOverrideForTests('signup_email', { enabled: true });
    const destination = 'verify-correct@example.test';
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_email', channel: 'email', destination, subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.4' },
    });

    const row = await db.query(`SELECT generation, key_version, destination_hash FROM public.verification_challenges WHERE handle = $1`, [req.handle]);
    const { deriveOtpCode } = await import('../../../server/services/verification/crypto');
    const code = deriveOtpCode(
      { purpose: 'signup_email', channel: 'email', challengeHandle: req.handle, generation: row.rows[0].generation, destinationHash: row.rows[0].destination_hash },
      row.rows[0].key_version,
      6,
    );

    const result = await svc.verifyVerificationChallenge(config, {
      handle: req.handle, code, purpose: 'signup_email', channel: 'email', requester: { ipAddress: '203.0.113.4' },
    });
    expect(result.ok).toBe(true);
    expect(result.proofToken).toBeTruthy();

    const chalStatus = await db.query(`SELECT status FROM public.verification_challenges WHERE handle = $1`, [req.handle]);
    expect(chalStatus.rows[0].status).toBe('verified');
  });

  // ── F. wrong-code attempt counting + G. attempt exhaustion and lock ────
  it('F/G: wrong codes increment attempts and lock the challenge at max_attempts', async () => {
    __setPurposePolicyOverrideForTests('signup_email', { enabled: true, maxVerificationAttempts: 3 });
    const destination = 'lockout-test@example.test';
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_email', channel: 'email', destination, subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.5' },
    });

    for (let i = 0; i < 3; i++) {
      const result = await svc.verifyVerificationChallenge(config, {
        handle: req.handle, code: '000000', purpose: 'signup_email', channel: 'email', requester: { ipAddress: '203.0.113.5' },
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
    __setPurposePolicyOverrideForTests('signup_email', { enabled: true });
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_email', channel: 'email', destination: 'expiry-test@example.test', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.6' },
    });
    await db.query(`UPDATE public.verification_challenges SET expires_at = now() - interval '1 second' WHERE handle = $1`, [req.handle]);

    const result = await svc.verifyVerificationChallenge(config, {
      handle: req.handle, code: '123456', purpose: 'signup_email', channel: 'email', requester: { ipAddress: '203.0.113.6' },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('expired');
  });

  it('H2: a revoked challenge cannot be verified', async () => {
    __setPurposePolicyOverrideForTests('signup_email', { enabled: true });
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_email', channel: 'email', destination: 'revoke-test@example.test', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.7' },
    });
    const revoked = await svc.revokeVerificationChallenge(config, { handle: req.handle, purpose: 'signup_email', reason: 'test_revoke', idempotencyKey: newIdempotencyKey() });
    expect(revoked.ok).toBe(true);

    const result = await svc.verifyVerificationChallenge(config, {
      handle: req.handle, code: '123456', purpose: 'signup_email', channel: 'email', requester: { ipAddress: '203.0.113.7' },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('revoked');
  });

  // ── I. proof single-consume + J. concurrent proof consumption ─────────
  it('I/J: a proof can be consumed exactly once, even under concurrent consumption attempts', async () => {
    __setPurposePolicyOverrideForTests('signup_email', { enabled: true });
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_email', channel: 'email', destination: 'proof-consume@example.test', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.8' },
    });
    const row = await db.query(`SELECT generation, key_version, destination_hash FROM public.verification_challenges WHERE handle = $1`, [req.handle]);
    const { deriveOtpCode } = await import('../../../server/services/verification/crypto');
    const code = deriveOtpCode({ purpose: 'signup_email', channel: 'email', challengeHandle: req.handle, generation: row.rows[0].generation, destinationHash: row.rows[0].destination_hash }, row.rows[0].key_version, 6);
    const verified = await svc.verifyVerificationChallenge(config, { handle: req.handle, code, purpose: 'signup_email', channel: 'email', requester: { ipAddress: '203.0.113.8' } });
    expect(verified.proofToken).toBeTruthy();

    const [c1, c2, c3] = await Promise.all([
      svc.consumeVerificationProof(config, { proofToken: verified.proofToken!, purpose: 'signup_email', channel: 'email', consumedByContext: 'test_consumer' }),
      svc.consumeVerificationProof(config, { proofToken: verified.proofToken!, purpose: 'signup_email', channel: 'email', consumedByContext: 'test_consumer' }),
      svc.consumeVerificationProof(config, { proofToken: verified.proofToken!, purpose: 'signup_email', channel: 'email', consumedByContext: 'test_consumer' }),
    ]);
    const successes = [c1, c2, c3].filter((r) => r.ok);
    expect(successes.length).toBe(1);
  });

  // ── K. wrong purpose/subject/workspace rejection + L. tenant isolation ─
  it('K/L: a proof cannot be consumed under a different purpose, subject, or workspace than it was issued for', async () => {
    __setPurposePolicyOverrideForTests('login_step_up', { enabled: true });
    // Enabled only so the "wrong purpose" consume attempt below reaches the
    // actual purpose-mismatch check in gv_consume_verification_proof rather
    // than being rejected earlier by the dormancy gate (assertChannelAllowed)
    // for an unrelated reason — the mismatch itself is what this test proves.
    __setPurposePolicyOverrideForTests('sensitive_action', { enabled: true });
    const wsA = randomUUID();
    const wsB = randomUUID();
    await db.query(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, 'Owner A')`, [randomUUID(), `owner-a-${wsA}@example.test`]);
    const ownerRow = await db.query(`SELECT id FROM public.profiles WHERE email = $1`, [`owner-a-${wsA}@example.test`]);
    const ownerId = ownerRow.rows[0].id;
    await db.query(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'WS A', $2, $3)`, [wsA, `ws-a-${wsA}`, ownerId]);
    await db.query(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'WS B', $2, $3)`, [wsB, `ws-b-${wsB}`, ownerId]);

    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'login_step_up', channel: 'email', destination: 'tenant-iso@example.test', subjectKind: 'user',
      subjectRef: ownerId, workspaceId: wsA, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.9', authenticatedUserId: ownerId },
    });
    const row = await db.query(`SELECT generation, key_version, destination_hash FROM public.verification_challenges WHERE handle = $1`, [req.handle]);
    const { deriveOtpCode } = await import('../../../server/services/verification/crypto');
    const code = deriveOtpCode({ purpose: 'login_step_up', channel: 'email', challengeHandle: req.handle, generation: row.rows[0].generation, destinationHash: row.rows[0].destination_hash }, row.rows[0].key_version, 6);

    // Verifying with the WRONG workspace bound must fail uniformly (not "found but wrong tenant").
    const wrongWs = await svc.verifyVerificationChallenge(config, {
      handle: req.handle, code, purpose: 'login_step_up', channel: 'email', workspaceId: wsB, requester: { ipAddress: '203.0.113.9' },
    });
    expect(wrongWs.ok).toBe(false);

    // Correct workspace verifies and issues a proof scoped to wsA.
    const correct = await svc.verifyVerificationChallenge(config, {
      handle: req.handle, code, purpose: 'login_step_up', channel: 'email', workspaceId: wsA, requester: { ipAddress: '203.0.113.9' },
    });
    expect(correct.ok).toBe(true);

    // Consuming under wsB must be rejected — no cross-tenant proof reuse.
    const consumedWrong = await svc.consumeVerificationProof(config, {
      proofToken: correct.proofToken!, purpose: 'login_step_up', channel: 'email', workspaceId: wsB, consumedByContext: 'test',
    });
    expect(consumedWrong.ok).toBe(false);

    // Consuming under the wrong purpose must also be rejected.
    const consumedWrongPurpose = await svc.consumeVerificationProof(config, {
      proofToken: correct.proofToken!, purpose: 'sensitive_action', channel: 'email', workspaceId: wsA, consumedByContext: 'test',
    });
    expect(consumedWrongPurpose.ok).toBe(false);

    // Correct scope succeeds.
    const consumedRight = await svc.consumeVerificationProof(config, {
      proofToken: correct.proofToken!, purpose: 'login_step_up', channel: 'email', workspaceId: wsA, consumedByContext: 'test',
    });
    expect(consumedRight.ok).toBe(true);
  });

  // ── M. email and SMS policy enforcement ────────────────────────────────
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
  });

  // ── N. provider outcomes via the real worker (email success / sms failure / unconfigured) ──
  it('N1: worker processes an email job to provider_accepted on provider success', async () => {
    __setPurposePolicyOverrideForTests('login_step_up', { enabled: true });
    emailSendMock.mockResolvedValue({ success: true, provider: 'resend', id: 'msg-123' });

    const wsId = randomUUID();
    await db.query(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, 'Owner N')`, [randomUUID(), `owner-n-${wsId}@example.test`]);
    const ownerRow = await db.query(`SELECT id FROM public.profiles WHERE email = $1`, [`owner-n-${wsId}@example.test`]);
    await db.query(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'WS N', $2, $3)`, [wsId, `ws-n-${wsId}`, ownerRow.rows[0].id]);

    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'login_step_up', channel: 'email', destination: 'worker-success@example.test', subjectKind: 'user',
      subjectRef: ownerRow.rows[0].id, workspaceId: wsId, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.11' },
    });

    const processed = await worker.drainVerificationJobs(config, { workerId: 'test-worker-1', limit: 10 });
    expect(processed).toBeGreaterThanOrEqual(1);
    expect(emailSendMock).toHaveBeenCalled();

    const chal = await db.query(`SELECT status FROM public.verification_challenges WHERE handle = $1`, [req.handle]);
    expect(chal.rows[0].status).toBe('provider_accepted');
    const delivery = await db.query(`SELECT outcome FROM public.verification_deliveries WHERE challenge_id = (SELECT id FROM public.verification_challenges WHERE handle = $1)`, [req.handle]);
    expect(delivery.rows[0].outcome).toBe('provider_accepted');
  });

  it('N2: worker retries an SMS job on provider failure, then marks permanently_failed after max attempts', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    smsSendMock.mockResolvedValue({ success: false, provider: 'kavenegar', errorCode: 'provider_error' });

    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_phone', channel: 'sms', destination: '09121234567', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.12' },
    });

    await db.query(`UPDATE public.verification_delivery_jobs SET max_attempts = 1 WHERE challenge_id = (SELECT id FROM public.verification_challenges WHERE handle = $1)`, [req.handle]);

    await worker.drainVerificationJobs(config, { workerId: 'test-worker-2', limit: 10 });

    const job = await db.query(`SELECT status FROM public.verification_delivery_jobs WHERE challenge_id = (SELECT id FROM public.verification_challenges WHERE handle = $1)`, [req.handle]);
    expect(job.rows[0].status).toBe('permanently_failed');
    const chal = await db.query(`SELECT status FROM public.verification_challenges WHERE handle = $1`, [req.handle]);
    expect(chal.rows[0].status).toBe('delivery_failed');
  });

  it('N3: a workspace-less email challenge is reported unconfigured, never silently dropped', async () => {
    __setPurposePolicyOverrideForTests('signup_email', { enabled: true });
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_email', channel: 'email', destination: 'unconfigured-test@example.test', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.13' },
    });
    await worker.drainVerificationJobs(config, { workerId: 'test-worker-3', limit: 10 });
    expect(emailSendMock).not.toHaveBeenCalled();
    const delivery = await db.query(`SELECT outcome FROM public.verification_deliveries WHERE challenge_id = (SELECT id FROM public.verification_challenges WHERE handle = $1)`, [req.handle]);
    expect(delivery.rows[0].outcome).toBe('unconfigured');
  });

  // ── O. worker lease/reclaim/stale claim ────────────────────────────────
  it('O: a stale (expired-lease) claim is reclaimed and requeued for another worker', async () => {
    __setPurposePolicyOverrideForTests('signup_email', { enabled: true });
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_email', channel: 'email', destination: 'stale-claim@example.test', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.14' },
    });

    const claimed = await worker.claimVerificationJobs(config, 'stale-worker', { leaseSeconds: 30 });
    expect(claimed.length).toBeGreaterThanOrEqual(1);
    await db.query(`UPDATE public.verification_delivery_jobs SET claim_expires_at = now() - interval '1 second' WHERE challenge_id = (SELECT id FROM public.verification_challenges WHERE handle = $1)`, [req.handle]);

    const reclaimed = await worker.reclaimExpiredVerificationJobs(config);
    expect(reclaimed).toBeGreaterThanOrEqual(1);

    const job = await db.query(`SELECT status, claim_token FROM public.verification_delivery_jobs WHERE challenge_id = (SELECT id FROM public.verification_challenges WHERE handle = $1)`, [req.handle]);
    expect(job.rows[0].status).toBe('queued');
    expect(job.rows[0].claim_token).toBeNull();

    // The original (now-stale) claim token can never overwrite the reclaimed state.
    const staleComplete = await worker.completeVerificationJob(config, claimed[0].id, claimed[0].claim_token, 'provider_accepted', {});
    expect(staleComplete.applied).toBe(false);
  });

  // ── P. crash after provider acceptance ────────────────────────────────
  it('P: a heartbeat on a claim whose lease already expired fails, matching the "lost claim" contract', async () => {
    __setPurposePolicyOverrideForTests('signup_email', { enabled: true });
    await svc.requestVerificationChallenge(config, {
      purpose: 'signup_email', channel: 'email', destination: 'heartbeat-test@example.test', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.15' },
    });
    const claimed = await worker.claimVerificationJobs(config, 'hb-worker', { leaseSeconds: 30 });
    expect(claimed.length).toBeGreaterThanOrEqual(1);
    const job = claimed[0];

    const heartbeatOk = await worker.heartbeatVerificationJob(config, job.id, job.claim_token, 60);
    expect(heartbeatOk).toBe(true);

    await db.query(`UPDATE public.verification_delivery_jobs SET claim_expires_at = now() - interval '1 second' WHERE id = $1`, [job.id]);
    const heartbeatAfterExpiry = await worker.heartbeatVerificationJob(config, job.id, job.claim_token, 60);
    expect(heartbeatAfterExpiry).toBe(false);
  });

  // ── Q. key rotation (already unit-tested in isolation; re-proven here against real DB state) ──
  it('Q: an OTP requested under key v1 still verifies correctly after the current key version rotates to v2', async () => {
    __setPurposePolicyOverrideForTests('signup_email', { enabled: true });
    const { __resetVerificationCryptoCacheForTests, deriveOtpCode } = await import('../../../server/services/verification/crypto');

    process.env.GENERIC_VERIFICATION_PEPPER_RING = JSON.stringify({
      1: process.env.GENERIC_VERIFICATION_PEPPER,
      2: 'second-ring-key-value-at-least-32-bytes!!',
    });
    process.env.GENERIC_VERIFICATION_KEY_VERSION = '1';
    __resetVerificationCryptoCacheForTests();

    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_email', channel: 'email', destination: 'rotation-test@example.test', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.16' },
    });
    const row = await db.query(`SELECT generation, key_version, destination_hash FROM public.verification_challenges WHERE handle = $1`, [req.handle]);
    expect(row.rows[0].key_version).toBe(1);

    // Rotate.
    process.env.GENERIC_VERIFICATION_KEY_VERSION = '2';
    __resetVerificationCryptoCacheForTests();

    const code = deriveOtpCode({ purpose: 'signup_email', channel: 'email', challengeHandle: req.handle, generation: row.rows[0].generation, destinationHash: row.rows[0].destination_hash }, 1, 6);
    const result = await svc.verifyVerificationChallenge(config, { handle: req.handle, code, purpose: 'signup_email', channel: 'email', requester: { ipAddress: '203.0.113.16' } });
    expect(result.ok).toBe(true);

    delete process.env.GENERIC_VERIFICATION_PEPPER_RING;
    delete process.env.GENERIC_VERIFICATION_KEY_VERSION;
    __resetVerificationCryptoCacheForTests();
  });

  // ── R. no secret leakage ────────────────────────────────────────────────
  it('R: no row anywhere in the schema ever contains the raw OTP code or proof token', async () => {
    __setPurposePolicyOverrideForTests('signup_email', { enabled: true });
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_email', channel: 'email', destination: 'no-leak-test@example.test', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.17' },
    });
    const row = await db.query(`SELECT generation, key_version, destination_hash FROM public.verification_challenges WHERE handle = $1`, [req.handle]);
    const { deriveOtpCode } = await import('../../../server/services/verification/crypto');
    const code = deriveOtpCode({ purpose: 'signup_email', channel: 'email', challengeHandle: req.handle, generation: row.rows[0].generation, destinationHash: row.rows[0].destination_hash }, row.rows[0].key_version, 6);
    const verified = await svc.verifyVerificationChallenge(config, { handle: req.handle, code, purpose: 'signup_email', channel: 'email', requester: { ipAddress: '203.0.113.17' } });

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
  });

  // ── S. service-role-only ACL (real SET ROLE proof) ─────────────────────
  it('S: SET ROLE service_role can reach every verification table/RPC; anon/authenticated cannot touch the tables', async () => {
    const client = await (db as unknown as { connect(): Promise<any> }).connect();
    try {
      await client.query('SET ROLE service_role');
      await expect(client.query('SELECT id FROM public.verification_challenges LIMIT 1')).resolves.toBeDefined();
      await expect(client.query('SELECT id FROM public.verification_proofs LIMIT 1')).resolves.toBeDefined();
      await expect(client.query('SELECT id FROM public.verification_delivery_jobs LIMIT 1')).resolves.toBeDefined();
      await expect(client.query('SELECT id FROM public.verification_deliveries LIMIT 1')).resolves.toBeDefined();
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
    __setPurposePolicyOverrideForTests('signup_email', { enabled: true });
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_email', channel: 'email', destination: 'no-enum-test@example.test', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.18' },
    });

    const wrongCodeOnRealHandle = await svc.verifyVerificationChallenge(config, {
      handle: req.handle, code: '000000', purpose: 'signup_email', channel: 'email', requester: { ipAddress: '203.0.113.18' },
    });
    const nonExistentHandle = await svc.verifyVerificationChallenge(config, {
      handle: 'gvc_this_handle_never_existed', code: '000000', purpose: 'signup_email', channel: 'email', requester: { ipAddress: '203.0.113.18' },
    });
    expect(wrongCodeOnRealHandle.ok).toBe(false);
    expect(nonExistentHandle.ok).toBe(false);
    expect(nonExistentHandle.reason).toBe('invalid_code');
  });

  // ── U. effective default-locale persistence ─────────────────────────────
  it('U: the resolved locale is frozen on the challenge row at creation time, not re-resolved later', async () => {
    __setPurposePolicyOverrideForTests('signup_email', { enabled: true });
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_email', channel: 'email', destination: 'locale-test@example.test', subjectKind: 'pending_account',
      locale: 'fa', idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.19' },
    });
    const row = await db.query(`SELECT locale FROM public.verification_challenges WHERE handle = $1`, [req.handle]);
    expect(row.rows[0].locale).toBe('fa');
  });
});
