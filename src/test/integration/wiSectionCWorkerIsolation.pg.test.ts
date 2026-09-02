/**
 * WORKSPACE INVITATIONS v5.1 — Section C.5 (real PostgreSQL 17).
 *
 *   worker crash / lease expiry / reclaim  — a worker that dies mid-job must
 *   not strand the job, and the reclaimed job must be delivered exactly once.
 *   provider fault injection — retryable failures back off and recover, a
 *   stub/unconfigured provider is terminal and never "delivered", and a
 *   terminal OTP failure revokes the live code in the same transaction.
 *   tenant isolation / RPC ACL / secret leakage — no cross-workspace reach,
 *   no untrusted EXECUTE on the privileged RPCs, no plaintext secrets at rest.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const DSN = process.env.TEST_DATABASE_URL || process.env.CLEAN_INSTALL_DATABASE_URL;
if (!DSN && process.env.REQUIRE_WI_DB === '1') {
  throw new Error(
    'REQUIRE_WI_DB=1 but neither TEST_DATABASE_URL nor CLEAN_INSTALL_DATABASE_URL is set — ' +
      'the workspace-invitation PostgreSQL suites are mandatory and must not be skipped.',
  );
}
const suite = DSN ? describe : describe.skip;

vi.mock('../../../server/middleware/security.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/middleware/security.js')>();
  const passthrough = (_req: unknown, _res: unknown, next: () => void) => next();
  return { ...actual, authRateLimiter: passthrough };
});

vi.mock('../../../server/services/email/index.js', async () => {
  const { captureEmail } = await import('./invitationHarness.js');
  return { sendEmail: async (_config: unknown, req: any) => captureEmail(req) };
});

vi.mock('../../../server/supabase.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/supabase.js')>();
  const { makePgServiceClient, harnessState } = await import('./invitationHarness.js');
  return { ...actual, getServiceClient: () => makePgServiceClient(() => harnessState.db) };
});

const { startHarness, harnessState, WORKER_CONFIG } = await import('./invitationHarness.js');
type H = Awaited<ReturnType<typeof startHarness>>;
let h: H;

/** Create an invitation and queue exactly one OTP email job for it. */
async function queueOtpJob(owner: { cookie: string; workspaceId: string }) {
  const payload = h.invitePayload(owner.workspaceId);
  const created = await h.call('POST', '/api/workspace-invitations', { cookie: owner.cookie, body: payload });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const token = h.tokenFromManualLink(created.json.manualLink);
  const requested = await h.call('POST', '/api/workspace-invitations/otp/request', {
    body: { requestId: h.rid(), token, purpose: 'manual_handoff' },
  });
  expect(requested.status, JSON.stringify(requested.json)).toBe(200);
  const job = await h.one(
    `SELECT * FROM public.workspace_invitation_jobs
      WHERE invitation_id = $1 AND status IN ('queued','retrying')
      ORDER BY created_at DESC LIMIT 1`,
    [created.json.invitation.id],
  );
  expect(job, 'OTP request must enqueue a durable outbox job').toBeTruthy();
  return { token, email: String(payload.email), invitationId: String(created.json.invitation.id), job: job! };
}

/** OTP emails actually handed to the provider for this address. */
function otpMailsFor(email: string) {
  return harnessState.capturedEmails.filter(
    (e) => e.to?.toLowerCase() === email.toLowerCase() && /verification code/i.test(String(e.text)),
  );
}

async function jobRow(id: string) {
  return (await h.one('SELECT * FROM public.workspace_invitation_jobs WHERE id = $1', [id]))!;
}

suite('Workspace Invitations v5.1 §C.5 — worker faults, tenant isolation, RPC ACL and secret leakage', () => {
  beforeAll(async () => { h = await startHarness(DSN!); }, 300_000);
  afterAll(async () => { if (h) await h.stop(); });
  beforeEach(() => { harnessState.emailOutcome = 'ok'; harnessState.capturedEmails.length = 0; });

  // ── C.5a — retryable provider fault ─────────────────────────────────────
  it('C.5a — a retryable provider failure backs the job off, keeps the OTP alive, and later recovers to a single accepted delivery', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c5a.owner.${Date.now()}@example.test`);
    harnessState.emailOutcome = 'timeout';
    const queued = await queueOtpJob(owner);

    const { drainInvitationJobs } = await import('../../../server/services/invitations/worker.js');
    await drainInvitationJobs(WORKER_CONFIG);

    const afterFailure = await jobRow(String(queued.job.id));
    expect(afterFailure.status).toBe('retrying');
    expect(Number(afterFailure.attempt_count)).toBe(1);
    expect(new Date(afterFailure.available_at).getTime()).toBeGreaterThan(Date.now());
    expect(afterFailure.claim_token).toBeNull();
    // A transport failure must NEVER revoke the invitation or the live code.
    expect(await h.countOf(
      `SELECT count(*)::int AS n FROM public.workspace_invitation_otps
        WHERE invitation_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL`,
      [queued.invitationId],
    )).toBe(1);
    expect((await h.one('SELECT status FROM public.workspace_invitations WHERE id = $1', [queued.invitationId]))!.status)
      .toBe('pending');
    expect(await h.countOf(
      `SELECT count(*)::int AS n FROM public.workspace_invitation_deliveries WHERE job_id = $1 AND status = 'retrying'`,
      [queued.job.id],
    )).toBe(1);

    // The provider recovers; the backoff window is the only thing holding it.
    harnessState.emailOutcome = 'ok';
    await h.db.query(`UPDATE public.workspace_invitation_jobs SET available_at = now() WHERE id = $1`, [queued.job.id]);
    await drainInvitationJobs(WORKER_CONFIG);

    const recovered = await jobRow(String(queued.job.id));
    expect(recovered.status).toBe('provider_accepted');
    expect(Number(recovered.attempt_count)).toBe(2);
    expect(await h.countOf(
      `SELECT count(*)::int AS n FROM public.workspace_invitation_deliveries
        WHERE job_id = $1 AND status = 'provider_accepted'`,
      [queued.job.id],
    )).toBe(1);
    expect(otpMailsFor(queued.email)).toHaveLength(1);

    // And the delivered code still verifies — the retry did not rotate it.
    const code = String(otpMailsFor(queued.email)[0].text).match(/(\d{6})/)![1];
    const verify = await h.call('POST', '/api/workspace-invitations/otp/verify', {
      body: { requestId: h.rid(), token: queued.token, purpose: 'manual_handoff', code },
    });
    expect(verify.status, JSON.stringify(verify.json)).toBe(200);
  }, 300_000);

  // ── C.5b — terminal unconfigured provider ───────────────────────────────
  it('C.5b — an unconfigured provider is terminal, is never reported as delivered, and revokes the live OTP atomically', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c5b.owner.${Date.now()}@example.test`);
    harnessState.emailOutcome = 'unconfigured';
    const queued = await queueOtpJob(owner);

    const { drainInvitationJobs } = await import('../../../server/services/invitations/worker.js');
    await drainInvitationJobs(WORKER_CONFIG);

    const job = await jobRow(String(queued.job.id));
    expect(job.status).toBe('unconfigured');
    expect(job.claim_token).toBeNull();
    expect(await h.countOf(
      `SELECT count(*)::int AS n FROM public.workspace_invitation_deliveries
        WHERE job_id = $1 AND status = 'provider_accepted'`,
      [queued.job.id],
    )).toBe(0);
    // The undeliverable code must not stay live.
    expect(await h.countOf(
      `SELECT count(*)::int AS n FROM public.workspace_invitation_otps
        WHERE invitation_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL`,
      [queued.invitationId],
    )).toBe(0);
    // Terminal delivery failure never revokes the invitation itself.
    expect((await h.one('SELECT status FROM public.workspace_invitations WHERE id = $1', [queued.invitationId]))!.status)
      .toBe('pending');
    // The job is truly terminal: another drain does not resurrect it.
    harnessState.emailOutcome = 'ok';
    await drainInvitationJobs(WORKER_CONFIG);
    expect((await jobRow(String(queued.job.id))).status).toBe('unconfigured');
    expect(otpMailsFor(queued.email)).toHaveLength(0);
  }, 300_000);

  // ── C.5c — worker crash, lease expiry, reclaim ──────────────────────────
  it('C.5c — a crashed worker\'s lease expires, the job is reclaimed and delivered exactly once', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c5c.owner.${Date.now()}@example.test`);
    const queued = await queueOtpJob(owner);
    const jobId = String(queued.job.id);

    // Worker A claims the job and then "crashes" — nothing else is written.
    const claimedRows = await h.rows(
      `SELECT * FROM public.claim_invitation_jobs($1, 10, 120, ARRAY['email','sms','otp_email'])`,
      ['worker-a-crashes'],
    );
    const claimed = claimedRows.find((r) => String(r.id) === jobId);
    expect(claimed, 'worker A must be able to claim the queued job').toBeTruthy();
    expect(claimed!.status).toBe('claimed');
    const staleClaimToken = String(claimed!.claim_token);

    // While the lease is alive no other worker may take it.
    const { drainInvitationJobs } = await import('../../../server/services/invitations/worker.js');
    await drainInvitationJobs(WORKER_CONFIG);
    expect((await jobRow(jobId)).locked_by).toBe('worker-a-crashes');
    expect(otpMailsFor(queued.email)).toHaveLength(0);
    expect(await h.countOf(`SELECT count(*)::int AS n FROM public.workspace_invitation_deliveries WHERE job_id = $1`, [jobId])).toBe(0);

    // The crashed process never renews the lease — expire it in the database.
    await h.db.query(
      `UPDATE public.workspace_invitation_jobs SET claim_expires_at = now() - interval '1 second' WHERE id = $1`,
      [jobId],
    );
    const reclaimed = await h.one('SELECT public.reclaim_expired_invitation_jobs() AS n');
    expect(Number(reclaimed!.n)).toBeGreaterThanOrEqual(1);
    const requeued = await jobRow(jobId);
    expect(requeued.status).toBe('queued');
    expect(requeued.locked_by).toBeNull();
    expect(requeued.claim_token).toBeNull();

    // A healthy worker finishes the job — exactly once.
    await drainInvitationJobs(WORKER_CONFIG);
    const done = await jobRow(jobId);
    expect(done.status).toBe('provider_accepted');
    expect(await h.countOf(
      `SELECT count(*)::int AS n FROM public.workspace_invitation_deliveries WHERE job_id = $1 AND status = 'provider_accepted'`,
      [jobId],
    )).toBe(1);
    expect(otpMailsFor(queued.email)).toHaveLength(1);

    // C.5c(ii) — the zombie worker wakes up and tries to complete the job with
    // its stale claim token. The claim guard must reject it outright.
    const zombie = await h.one(
      `SELECT public.wi_complete_invitation_job($1, $2, 'provider_accepted', 'zombie', 'zombie-msg', NULL, NULL, 60) AS r`,
      [jobId, staleClaimToken],
    );
    expect(zombie!.r?.applied === true).toBe(false);
    expect(await h.countOf(
      `SELECT count(*)::int AS n FROM public.workspace_invitation_deliveries WHERE job_id = $1`, [jobId],
    )).toBe(1);
    expect((await jobRow(jobId)).status).toBe('provider_accepted');
  }, 300_000);

  // ── C.5d — exhausted attempts ───────────────────────────────────────────
  it('C.5d — a job whose lease expires after its final attempt ends permanently_failed, not queued forever', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c5d.owner.${Date.now()}@example.test`);
    const queued = await queueOtpJob(owner);
    const jobId = String(queued.job.id);

    await h.db.query(`UPDATE public.workspace_invitation_jobs SET max_attempts = 1 WHERE id = $1`, [jobId]);
    await h.rows(
      `SELECT * FROM public.claim_invitation_jobs($1, 10, 120, ARRAY['email','sms','otp_email'])`,
      ['worker-final-attempt'],
    );
    await h.db.query(
      `UPDATE public.workspace_invitation_jobs SET claim_expires_at = now() - interval '1 second' WHERE id = $1`,
      [jobId],
    );
    expect(Number((await h.one('SELECT public.reclaim_expired_invitation_jobs() AS n'))!.n)).toBeGreaterThanOrEqual(1);

    const dead = await jobRow(jobId);
    expect(dead.status).toBe('permanently_failed');
    expect(dead.claim_token).toBeNull();

    const { drainInvitationJobs } = await import('../../../server/services/invitations/worker.js');
    await drainInvitationJobs(WORKER_CONFIG);
    expect((await jobRow(jobId)).status).toBe('permanently_failed');
    expect(otpMailsFor(queued.email)).toHaveLength(0);
  }, 300_000);

  // ── C.5e — tenant isolation ─────────────────────────────────────────────
  it('C.5e — a workspace owner cannot invite into, read, revoke or offboard inside another tenant', async () => {
    h.freshAddr();
    const a = await h.makeOwner(`c5e.a.${Date.now()}@example.test`);
    h.freshAddr();
    const b = await h.makeOwner(`c5e.b.${Date.now()}@example.test`);
    expect(a.workspaceId).not.toBe(b.workspaceId);

    const inA = await h.prepareAcceptable(a.cookie, a.workspaceId);
    const accepted = await h.call('POST', '/api/workspace-invitations/accept-new', {
      cookie: inA.proofCookie, body: inA.acceptBody(),
    });
    expect(accepted.status).toBe(200);
    const victim = await h.one(
      'SELECT id FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [a.workspaceId, accepted.json.user_id],
    );

    // B creating an invitation in A's workspace.
    const crossInvite = await h.call('POST', '/api/workspace-invitations', {
      cookie: b.cookie, body: h.invitePayload(a.workspaceId),
    });
    expect([401, 403, 404]).toContain(crossInvite.status);

    // B listing A's invitations.
    const crossList = await h.call('GET', `/api/workspace-invitations?workspaceId=${a.workspaceId}`, { cookie: b.cookie });
    expect([401, 403, 404]).toContain(crossList.status);

    // B offboarding A's member.
    const crossDelete = await h.call('DELETE', `/api/workspace-members/${victim!.id}?workspaceId=${a.workspaceId}`, {
      cookie: b.cookie, body: { requestId: h.rid() },
    });
    expect([401, 403, 404]).toContain(crossDelete.status);
    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_members WHERE id = $1', [victim!.id],
    )).toBe(1);

    // Nothing leaked across the tenant boundary.
    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_invitations WHERE workspace_id = $1', [b.workspaceId],
    )).toBe(0);
    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_members WHERE workspace_id = $1', [b.workspaceId],
    )).toBe(1);
  }, 300_000);

  // ── C.5f — RPC ACL ──────────────────────────────────────────────────────
  it('C.5f — every privileged invitation RPC is service_role-only for anon and authenticated', async () => {
    const privileged = [
      'wi_execute_idempotent', 'wi_peek_idempotent', 'offboard_workspace_member',
      'wi_request_invitation_otp_v2', 'wi_verify_invitation_otp', 'wi_preview_invitation',
      'wi_complete_invitation_job', 'wi_prepare_invitation_job', 'wi_fail_otp_job_atomic',
      'claim_invitation_jobs', 'reclaim_expired_invitation_jobs', 'wi_revoke_undelivered_otp',
      'create_workspace_invitation_v2', 'accept_invitation_new_user_v2', 'accept_invitation_existing_user_v2',
    ];
    const rows = await h.rows(
      `SELECT p.proname,
              bool_or(has_function_privilege('anon', p.oid, 'EXECUTE'))          AS anon_exec,
              bool_or(has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS auth_exec,
              bool_or(has_function_privilege('service_role', p.oid, 'EXECUTE'))  AS svc_exec,
              count(*)::int AS overloads
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = ANY($1)
        GROUP BY p.proname`,
      [privileged],
    );
    const seen = new Map(rows.map((r) => [String(r.proname), r]));
    for (const name of privileged) {
      const row = seen.get(name);
      expect(row, `${name} must exist in the installed schema`).toBeTruthy();
      expect(`${name}:anon=${row!.anon_exec}`).toBe(`${name}:anon=false`);
      expect(`${name}:authenticated=${row!.auth_exec}`).toBe(`${name}:authenticated=false`);
      expect(`${name}:service_role=${row!.svc_exec}`).toBe(`${name}:service_role=true`);
    }

    // Secret-bearing tables are unreachable for untrusted roles too.
    for (const table of ['workspace_invitation_otps', 'workspace_invitation_tokens',
      'workspace_invitation_idempotency', 'workspace_invitation_jobs', 'workspace_invitation_proofs']) {
      for (const role of ['anon', 'authenticated']) {
        for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
          const r = await h.one(
            `SELECT has_table_privilege($1, format('public.%I', $2::text), $3) AS ok`, [role, table, priv],
          );
          expect(`${role}:${table}:${priv}=${r!.ok}`).toBe(`${role}:${table}:${priv}=false`);
        }
      }
    }
  }, 300_000);

  // ── C.5g — secret leakage ───────────────────────────────────────────────
  it('C.5g — no plaintext token, OTP code or proof is stored in jobs, deliveries, the ledger or audit logs', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c5g.owner.${Date.now()}@example.test`);
    const ready = await h.prepareAcceptable(owner.cookie, owner.workspaceId);
    const accept = await h.call('POST', '/api/workspace-invitations/accept-new', {
      cookie: ready.proofCookie, body: ready.acceptBody(),
    });
    expect(accept.status, JSON.stringify(accept.json)).toBe(200);
    const code = String(otpMailsFor(ready.email)[0].text).match(/(\d{6})/)![1];

    const dumps: Array<[string, string]> = [];
    for (const table of ['workspace_invitation_jobs', 'workspace_invitation_deliveries',
      'workspace_invitation_idempotency', 'audit_logs', 'workspace_invitation_otps',
      'workspace_invitation_tokens', 'workspace_invitation_proofs', 'workspace_invitations']) {
      const r = await h.one(
        `SELECT coalesce(jsonb_agg(to_jsonb(t))::text, '[]') AS dump FROM public.${table} t`,
      );
      dumps.push([table, String(r!.dump)]);
    }

    for (const [table, dump] of dumps) {
      expect(`${table}:token`, `raw invitation token found in ${table}`).toBe(
        dump.includes(ready.token) ? `${table}:LEAKED` : `${table}:token`,
      );
      // The 6-digit code may collide with unrelated digits, so require that it
      // appears only as part of a longer hash-like run if at all.
      const bare = new RegExp(`(^|[^0-9a-f])${code}([^0-9a-f]|$)`);
      expect(`${table}:code`, `raw OTP code found in ${table}`).toBe(
        bare.test(dump) ? `${table}:LEAKED` : `${table}:code`,
      );
      expect(`${table}:password`, `raw password found in ${table}`).toBe(
        dump.includes('CorrectHorseBattery1') ? `${table}:LEAKED` : `${table}:password`,
      );
    }

    // Digests ARE stored — proving the checks above are meaningful.
    expect(await h.countOf(
      `SELECT count(*)::int AS n FROM public.workspace_invitation_otps WHERE code_digest IS NOT NULL`,
    )).toBeGreaterThan(0);

    // The API surface never echoes secrets back either.
    const list = await h.call('GET', `/api/workspace-invitations?workspaceId=${owner.workspaceId}`, { cookie: owner.cookie });
    expect(list.status).toBe(200);
    const body = JSON.stringify(list.json);
    expect(body.includes(ready.token)).toBe(false);
    expect(body.includes(code)).toBe(false);
  }, 300_000);
});
