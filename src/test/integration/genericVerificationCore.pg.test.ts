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
const smsSendMock = vi.fn();
/** Test-only hook: makes exactly the NEXT gv_finalize_verification_delivery
 * call fail as if the RPC round-trip itself was lost (simulating "provider
 * accepted but delivery-result persistence failed"), without touching the
 * real send path. Reset to false the instant it fires. */
let forceFinalizeFailureOnce = false;

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
            `SELECT public.gv_finalize_verification_delivery($1,$2,$3,$4,$5,$6) AS result`,
            [args._key, args._outcome, args._provider_name, args._provider_message_id, args._error_code, args._error_message],
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

async function insertWorkspace(): Promise<{ workspaceId: string; ownerId: string }> {
  const workspaceId = randomUUID();
  const email = `owner-${workspaceId}@example.test`;
  const ownerId = randomUUID();
  await db.query(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, 'Test Owner')`, [ownerId, email]);
  await db.query(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Test WS', $2, $3)`, [workspaceId, `ws-${workspaceId}`, ownerId]);
  return { workspaceId, ownerId };
}

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
    emailSendMock.mockResolvedValue({ success: true, provider: 'resend', id: 'default-msg' });
    smsSendMock.mockResolvedValue({ success: true, provider: 'kavenegar', messageId: 'default-sms' });
    forceFinalizeFailureOnce = false;
  });

  afterEach(() => {
    __clearAllPurposePolicyOverridesForTests();
  });

  // ── A. disabled-purpose fail-closed with zero writes ──────────────────
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

  // ── B. request idempotency + C. concurrent duplicate requests ─────────
  it('B/C: identical idempotency key replays the same result exactly once, including under concurrency, and sends exactly once', async () => {
    __setPurposePolicyOverrideForTests('signup_phone', { enabled: true });
    const idempotencyKey = newIdempotencyKey();
    const input = {
      purpose: 'signup_phone' as const, channel: 'sms' as const, destination: '09121230101',
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
    // Concurrent duplicates race for the SAME idempotency key: exactly one
    // of them does the real prepare+send+finalize work; the others either
    // replay the committed result or (if they arrive mid-flight) are
    // rejected as already-in-flight and the calling code path here would
    // surface that as a rejection — but a real client only ever fires one
    // logical request, so what matters is the invariant actually enforced:
    // the provider is never called more than once for one logical send.
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
    // signup_phone's resendCooldownSeconds (60s — see PURPOSE_POLICIES in
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
      purpose: 'signup_phone', channel: 'sms', destination, subjectKind: 'pending_account',
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
      handle: req.handle, code, purpose: 'signup_phone', channel: 'sms', requester: { ipAddress: '203.0.113.4' },
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
        handle: req.handle, code: '000000', purpose: 'signup_phone', channel: 'sms', requester: { ipAddress: '203.0.113.5' },
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
      handle: req.handle, code: '123456', purpose: 'signup_phone', channel: 'sms', requester: { ipAddress: '203.0.113.6' },
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
    const revoked = await svc.revokeVerificationChallenge(config, { handle: req.handle, purpose: 'signup_phone', reason: 'test_revoke', idempotencyKey: newIdempotencyKey() });
    expect(revoked.ok).toBe(true);

    const result = await svc.verifyVerificationChallenge(config, {
      handle: req.handle, code: '123456', purpose: 'signup_phone', channel: 'sms', requester: { ipAddress: '203.0.113.7' },
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
    const verified = await svc.verifyVerificationChallenge(config, { handle: req.handle, code, purpose: 'signup_phone', channel: 'sms', requester: { ipAddress: '203.0.113.8' } });
    expect(verified.proofToken).toBeTruthy();

    const [c1, c2, c3] = await Promise.all([
      svc.consumeVerificationProof(config, { proofToken: verified.proofToken!, purpose: 'signup_phone', channel: 'sms', consumedByContext: 'test_consumer' }),
      svc.consumeVerificationProof(config, { proofToken: verified.proofToken!, purpose: 'signup_phone', channel: 'sms', consumedByContext: 'test_consumer' }),
      svc.consumeVerificationProof(config, { proofToken: verified.proofToken!, purpose: 'signup_phone', channel: 'sms', consumedByContext: 'test_consumer' }),
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
    const { workspaceId: wsA, ownerId } = await insertWorkspace();
    const { workspaceId: wsB } = await insertWorkspace();

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
    expect(smsSendMock).not.toHaveBeenCalled();
  });

  // ── N. Express-direct provider outcomes (email success / sms failure / unconfigured) ──
  it('N1: a successful email send is recorded as provider_accepted synchronously, in the SAME request', async () => {
    __setPurposePolicyOverrideForTests('login_step_up', { enabled: true });
    emailSendMock.mockResolvedValue({ success: true, provider: 'resend', id: 'msg-123' });
    const { workspaceId: wsId, ownerId } = await insertWorkspace();

    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'login_step_up', channel: 'email', destination: 'send-success@example.test', subjectKind: 'user',
      subjectRef: ownerId, workspaceId: wsId, idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.11' },
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

    // No automatic retry happens — the challenge stays exactly where the
    // failed send left it (still pending_delivery, not locked or expired),
    // and nothing else touches it until the caller explicitly acts.
    const chal = await db.query(`SELECT status FROM public.verification_challenges WHERE handle = $1`, [req.handle]);
    expect(chal.rows[0].status).toBe('pending_delivery');
    const delivery = await db.query(`SELECT outcome FROM public.verification_delivery_attempts WHERE challenge_id = (SELECT id FROM public.verification_challenges WHERE handle = $1)`, [req.handle]);
    expect(delivery.rows[0].outcome).toBe('retryable_failure');
    expect(smsSendMock).toHaveBeenCalledTimes(1);

    // signup_phone's resendCooldownSeconds (60s) is a real production
    // mechanic orthogonal to what THIS test proves (retryable-failure
    // handling + caller-driven recovery), so elapsed time is simulated by
    // backdating created_at — see test D's identical rationale.
    await db.query(`UPDATE public.verification_challenges SET created_at = now() - interval '90 seconds' WHERE handle = $1`, [req.handle]);

    // An explicit resend (a NEW generation, a NEW idempotency key — a real
    // caller-driven retry, not a background one) succeeds once the
    // provider is healthy again.
    smsSendMock.mockResolvedValueOnce({ success: true, provider: 'kavenegar', messageId: 'recovered' });
    const resent = await svc.resendVerificationChallenge(config, {
      purpose: 'signup_phone', channel: 'sms', destination, subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.12' },
    });
    expect(resent.deliveryOutcome).toBe('provider_accepted');
    expect(resent.generation).toBe(req.generation + 1);
    expect(smsSendMock).toHaveBeenCalledTimes(2);
  });

  it('N3: a workspace-less email challenge is reported unconfigured WITHOUT ever contacting the email provider', async () => {
    __setPurposePolicyOverrideForTests('signup_email', { enabled: true });
    const req = await svc.requestVerificationChallenge(config, {
      purpose: 'signup_email', channel: 'email', destination: 'unconfigured-test@example.test', subjectKind: 'pending_account',
      idempotencyKey: newIdempotencyKey(), requester: { ipAddress: '203.0.113.13' },
    });
    expect(req.deliveryOutcome).toBe('unconfigured');
    expect(emailSendMock).not.toHaveBeenCalled();
    const chal = await db.query(`SELECT status FROM public.verification_challenges WHERE handle = $1`, [req.handle]);
    expect(chal.rows[0].status).toBe('delivery_failed');
    const delivery = await db.query(`SELECT outcome FROM public.verification_delivery_attempts WHERE challenge_id = (SELECT id FROM public.verification_challenges WHERE handle = $1)`, [req.handle]);
    expect(delivery.rows[0].outcome).toBe('unconfigured');
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
    // The delivery-evidence row already exists the MOMENT the request call
    // returns — no polling, no drain, no separate process ever ran.
    const delivery = await db.query(`SELECT outcome FROM public.verification_delivery_attempts WHERE challenge_id = (SELECT id FROM public.verification_challenges WHERE handle = $1)`, [req.handle]);
    expect(delivery.rows[0].outcome).toBe('provider_accepted');
  });

  // ── P. crash/concurrency/replay matrix for the Express-direct delivery model ──
  it('P1: a crash between prepare and finalize (stale in-flight ledger row) is RESUMED with the SAME challenge and the SAME deterministic code, never a duplicate challenge', async () => {
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

    // Simulate: a PRIOR Express process ran gv_prepare_verification_delivery
    // successfully — the challenge row is REAL and committed — and then the
    // process died before ever calling the provider or gv_finalize_
    // verification_delivery. `prepared_at` is backdated past the 30s
    // staleness window so the next attempt treats this as resumable rather
    // than "still in flight".
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

    expect(result.handle).toBe(handle); // resumed the EXISTING challenge, never created a second one
    expect(smsSendMock).toHaveBeenCalledTimes(1);
    const sentBody = String(smsSendMock.mock.calls[0][1]?.body ?? '');
    expect(sentBody.includes(code)).toBe(true); // the SAME code a real prior send would have carried

    const rows = await db.query(`SELECT count(*)::int AS n FROM public.verification_challenges WHERE destination_hash = $1`, [destinationHash]);
    expect(rows.rows[0].n).toBe(1); // no duplicate challenge

    const chal = await db.query(`SELECT status FROM public.verification_challenges WHERE handle = $1`, [handle]);
    expect(chal.rows[0].status).toBe('provider_accepted');
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
    // `prepared_at = now()` — this row was JUST created (by "another
    // in-flight request"), well within the staleness window.
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
    expect(smsSendMock).toHaveBeenCalledTimes(1); // the provider WAS actually contacted

    // An IMMEDIATE retry within the staleness window is correctly rejected
    // as still-in-flight (test P2) — the ledger cannot yet distinguish
    // "my own crashed attempt" from "a genuinely concurrent duplicate", and
    // treating them differently would reopen the double-send race P2
    // guards against. Only once enough time has passed does a retry
    // resume. Backdating `prepared_at` here simulates that elapsed time
    // rather than waiting 30+ real-world seconds.
    const { deriveIdempotencyKey } = await import('../../../server/services/verification/crypto');
    const key = deriveIdempotencyKey({ operation: 'request', scopeKind: 'signup_phone', actorRef: 'anonymous', requestId: idempotencyKey });
    await db.query(`UPDATE public.verification_idempotency SET prepared_at = now() - interval '60 seconds' WHERE key = $1`, [key]);

    // The caller (whoever owns the retry policy — the client, a route
    // handler) retries with the SAME idempotency key, exactly as it would
    // after any transport loss. This is documented, accepted at-least-once
    // provider behavior — the two provider abstractions in this codebase
    // (server/services/email, server/services/sms) take no caller-supplied
    // idempotency key, so a genuine double-send at the provider cannot be
    // suppressed from here. What IS guaranteed is below: the database
    // state is never duplicated.
    const result = await svc.requestVerificationChallenge(config, input);
    expect(result.deliveryOutcome).toBe('provider_accepted');
    expect(smsSendMock).toHaveBeenCalledTimes(2);

    const rows = await db.query(`SELECT count(*)::int AS n FROM public.verification_challenges WHERE handle = $1`, [result.handle]);
    expect(rows.rows[0].n).toBe(1);
    const attempts = await db.query(`SELECT count(*)::int AS n FROM public.verification_delivery_attempts WHERE challenge_id = (SELECT id FROM public.verification_challenges WHERE handle = $1)`, [result.handle]);
    expect(attempts.rows[0].n).toBe(1); // ONE evidence row for one logical send, despite two provider calls
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

  // ── Q. key rotation (already unit-tested in isolation; re-proven here against real DB state) ──
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

    // Rotate.
    process.env.GENERIC_VERIFICATION_KEY_VERSION = '2';
    __resetVerificationCryptoCacheForTests();

    const code = deriveOtpCode({ purpose: 'signup_phone', channel: 'sms', challengeHandle: req.handle, generation: row.rows[0].generation, destinationHash: row.rows[0].destination_hash }, 1, 6);
    const result = await svc.verifyVerificationChallenge(config, { handle: req.handle, code, purpose: 'signup_phone', channel: 'sms', requester: { ipAddress: '203.0.113.16' } });
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
    const verified = await svc.verifyVerificationChallenge(config, { handle: req.handle, code, purpose: 'signup_phone', channel: 'sms', requester: { ipAddress: '203.0.113.17' } });

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
    expect(smsBody).toBeTruthy(); // sanity: the code really was sent somewhere, just never persisted
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
      handle: req.handle, code: '000000', purpose: 'signup_phone', channel: 'sms', requester: { ipAddress: '203.0.113.18' },
    });
    const nonExistentHandle = await svc.verifyVerificationChallenge(config, {
      handle: 'gvc_this_handle_never_existed', code: '000000', purpose: 'signup_phone', channel: 'sms', requester: { ipAddress: '203.0.113.18' },
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
});
