/**
 * WORKSPACE INVITATIONS v5.1 — Section C.5 residual (real PostgreSQL 17).
 *
 * Controlled worker fault points, each injected in the REAL code path:
 *   C.5h  crash after prepare, before provider submission
 *   C.5i  provider hard error (5xx-class) → retry, never a delivery
 *   C.5j  provider ACCEPTS, then the completion write fails → the job is
 *         retried and the external submission happens AGAIN
 *   C.5k  heartbeat renews a live lease
 *   C.5l  heartbeat reports a LOST claim (reclaimed job) and cannot resurrect it
 *   C.5m  a wrong worker identity / stale claim token cannot complete a job
 *   C.5n  graceful shutdown does not abort the in-flight job
 *   C.5o  email and SMS delivery failures never delete or revoke the invitation
 *
 * DELIVERY SEMANTICS PROVEN HERE (and deliberately not stronger):
 * the email provider is not called with a stable provider-side idempotency
 * key, so external submission is AT-LEAST-ONCE. The database state stays
 * idempotent, the terminal success state is `provider_accepted` — never
 * `delivered` — and C.5j demonstrates that an ambiguous provider response can
 * produce a duplicate external submission.
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

const CHANNELS = `ARRAY['email','sms','otp_email']`;

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
      WHERE invitation_id = $1 AND channel = 'otp_email' AND status IN ('queued','retrying')
      ORDER BY created_at DESC LIMIT 1`,
    [created.json.invitation.id],
  );
  expect(job, 'OTP request must enqueue a durable outbox job').toBeTruthy();
  return { token, email: String(payload.email), invitationId: String(created.json.invitation.id), job: job! };
}

function otpMailsFor(email: string) {
  return harnessState.capturedEmails.filter(
    (e) => e.to?.toLowerCase() === email.toLowerCase() && /verification code/i.test(String(e.text)),
  );
}

const jobRow = async (id: string) => (await h.one('SELECT * FROM public.workspace_invitation_jobs WHERE id = $1', [id]))!;

async function injectDeliveryFault(): Promise<void> {
  await h.db.query(`
    CREATE OR REPLACE FUNCTION public.wi_test_delivery_fault() RETURNS trigger
    LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'INJECTED_COMPLETION_FAULT'; END $fn$;
    DROP TRIGGER IF EXISTS wi_test_delivery_fault_trg ON public.workspace_invitation_deliveries;
    CREATE TRIGGER wi_test_delivery_fault_trg
      BEFORE INSERT ON public.workspace_invitation_deliveries
      FOR EACH ROW EXECUTE FUNCTION public.wi_test_delivery_fault();
  `);
}
async function clearDeliveryFault(): Promise<void> {
  await h.db.query(`
    DROP TRIGGER IF EXISTS wi_test_delivery_fault_trg ON public.workspace_invitation_deliveries;
    DROP FUNCTION IF EXISTS public.wi_test_delivery_fault();
  `);
}

suite('Workspace Invitations v5.1 §C.5 residual — controlled worker fault points and delivery semantics', () => {
  beforeAll(async () => { h = await startHarness(DSN!); }, 300_000);
  afterAll(async () => { if (h) { await clearDeliveryFault().catch(() => {}); await h.stop(); } });
  beforeEach(() => { harnessState.emailOutcome = 'ok'; harnessState.capturedEmails.length = 0; });

  // ── C.5h ────────────────────────────────────────────────────────────────
  it('C.5h — a worker that crashes AFTER prepare but BEFORE submission sends nothing, and the reclaimed job delivers exactly once', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c5h.owner.${Date.now()}@example.test`);
    const queued = await queueOtpJob(owner);
    const jobId = String(queued.job.id);

    const claimed = (await h.rows(
      `SELECT * FROM public.claim_invitation_jobs($1, 10, 120, ${CHANNELS})`, ['worker-h-crashes'],
    )).find((r) => String(r.id) === jobId);
    expect(claimed, 'the job must be claimable').toBeTruthy();
    const claimToken = String(claimed!.claim_token);

    // Real prepare, then the process dies — nothing else happens.
    const prepared = await h.one(
      `SELECT public.wi_prepare_invitation_job($1, $2, NULL, NULL, NULL, NULL) AS r`, [jobId, claimToken],
    );
    expect(prepared!.r).toBeTruthy();
    expect(otpMailsFor(queued.email)).toHaveLength(0);
    expect(await h.countOf('SELECT count(*)::int AS n FROM public.workspace_invitation_deliveries WHERE job_id = $1', [jobId])).toBe(0);

    // Lease expiry + reclaim + a healthy worker.
    await h.db.query(
      `UPDATE public.workspace_invitation_jobs SET claim_expires_at = now() - interval '1 second' WHERE id = $1`, [jobId],
    );
    expect(Number((await h.one('SELECT public.reclaim_expired_invitation_jobs() AS n'))!.n)).toBeGreaterThanOrEqual(1);
    const { drainInvitationJobs } = await import('../../../server/services/invitations/worker.js');
    await drainInvitationJobs(WORKER_CONFIG);

    expect((await jobRow(jobId)).status).toBe('provider_accepted');
    expect(otpMailsFor(queued.email)).toHaveLength(1);
    expect(await h.countOf(
      `SELECT count(*)::int AS n FROM public.workspace_invitation_deliveries WHERE job_id = $1 AND status = 'provider_accepted'`,
      [jobId],
    )).toBe(1);
  }, 300_000);

  // ── C.5i ────────────────────────────────────────────────────────────────
  it('C.5i — a provider hard error is retried, records no accepted delivery and never marks anything delivered', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c5i.owner.${Date.now()}@example.test`);
    harnessState.emailOutcome = 'error';
    const queued = await queueOtpJob(owner);
    const jobId = String(queued.job.id);

    const { drainInvitationJobs } = await import('../../../server/services/invitations/worker.js');
    await drainInvitationJobs(WORKER_CONFIG);

    const failed = await jobRow(jobId);
    expect(failed.status).toBe('retrying');
    expect(Number(failed.attempt_count)).toBe(1);
    expect(await h.countOf(
      `SELECT count(*)::int AS n FROM public.workspace_invitation_deliveries WHERE job_id = $1 AND status = 'provider_accepted'`,
      [jobId],
    )).toBe(0);
    // No status in this system ever means "delivered".
    expect(await h.countOf(
      `SELECT count(*)::int AS n FROM public.workspace_invitation_deliveries WHERE status = 'delivered'`,
    )).toBe(0);
    expect((await h.one('SELECT status FROM public.workspace_invitations WHERE id = $1', [queued.invitationId]))!.status)
      .toBe('pending');

    harnessState.emailOutcome = 'ok';
    await h.db.query(`UPDATE public.workspace_invitation_jobs SET available_at = now() WHERE id = $1`, [jobId]);
    await drainInvitationJobs(WORKER_CONFIG);
    expect((await jobRow(jobId)).status).toBe('provider_accepted');
    expect(otpMailsFor(queued.email)).toHaveLength(1);
  }, 300_000);

  // ── C.5j ────────────────────────────────────────────────────────────────
  it('C.5j — when the provider ACCEPTS but the completion write fails, the database stays consistent and the external submission is repeated (at-least-once)', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c5j.owner.${Date.now()}@example.test`);
    const queued = await queueOtpJob(owner);
    const jobId = String(queued.job.id);

    const { drainInvitationJobs } = await import('../../../server/services/invitations/worker.js');
    await injectDeliveryFault();
    await drainInvitationJobs(WORKER_CONFIG);

    // The provider DID receive the message; the completion could not be
    // recorded, so the database still shows unfinished work.
    expect(otpMailsFor(queued.email)).toHaveLength(1);
    expect(await h.countOf('SELECT count(*)::int AS n FROM public.workspace_invitation_deliveries WHERE job_id = $1', [jobId])).toBe(0);
    const stuck = await jobRow(jobId);
    expect(stuck.status).not.toBe('provider_accepted');

    // Recovery: the lease reaper requeues the job and it is submitted AGAIN.
    await clearDeliveryFault();
    await h.db.query(
      `UPDATE public.workspace_invitation_jobs
          SET claim_expires_at = now() - interval '1 second', available_at = now() WHERE id = $1`,
      [jobId],
    );
    await h.db.query('SELECT public.reclaim_expired_invitation_jobs()');
    await drainInvitationJobs(WORKER_CONFIG);

    const done = await jobRow(jobId);
    expect(done.status).toBe('provider_accepted');
    // DATABASE state is idempotent: exactly one accepted delivery row…
    expect(await h.countOf(
      `SELECT count(*)::int AS n FROM public.workspace_invitation_deliveries WHERE job_id = $1 AND status = 'provider_accepted'`,
      [jobId],
    )).toBe(1);
    // …while EXTERNAL submission is at-least-once: the provider saw it twice.
    expect(otpMailsFor(queued.email).length).toBe(2);
    // Both submissions carry the same still-valid code — the retry never
    // rotates the secret, so the recipient can use either message.
    const codes = otpMailsFor(queued.email).map((m) => String(m.text).match(/(\d{6})/)![1]);
    expect(new Set(codes).size).toBe(1);
    const verify = await h.call('POST', '/api/workspace-invitations/otp/verify', {
      body: { requestId: h.rid(), token: queued.token, purpose: 'manual_handoff', code: codes[0] },
    });
    expect(verify.status, JSON.stringify(verify.json)).toBe(200);
  }, 300_000);

  // ── C.5k / C.5l / C.5m ──────────────────────────────────────────────────
  it('C.5k — a heartbeat renews a live lease, C.5l — a lost claim reports false and cannot resurrect the job, C.5m — a wrong worker identity cannot complete it', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c5k.owner.${Date.now()}@example.test`);
    const queued = await queueOtpJob(owner);
    const jobId = String(queued.job.id);

    const claimed = (await h.rows(
      `SELECT * FROM public.claim_invitation_jobs($1, 10, 60, ${CHANNELS})`, ['worker-k'],
    )).find((r) => String(r.id) === jobId)!;
    const claimToken = String(claimed.claim_token);
    const leaseBefore = new Date((await jobRow(jobId)).claim_expires_at).getTime();

    // C.5k — renewal extends the lease.
    const beat = await h.one(
      'SELECT public.wi_heartbeat_invitation_job($1, $2, 600) AS ok', [jobId, claimToken],
    );
    expect(beat!.ok).toBe(true);
    expect(new Date((await jobRow(jobId)).claim_expires_at).getTime()).toBeGreaterThan(leaseBefore);

    // A heartbeat with the WRONG token changes nothing (temporary failure of a
    // single beat is survivable; a forged one is not honoured).
    const leaseNow = new Date((await jobRow(jobId)).claim_expires_at).getTime();
    const forged = await h.one(
      'SELECT public.wi_heartbeat_invitation_job($1, $2, 6000) AS ok', [jobId, crypto.randomUUID()],
    );
    expect(forged!.ok).toBe(false);
    expect(new Date((await jobRow(jobId)).claim_expires_at).getTime()).toBe(leaseNow);

    // C.5l — the lease expires and the job is reclaimed: the old worker's
    // heartbeat now reports a LOST claim and does not re-take the job.
    await h.db.query(
      `UPDATE public.workspace_invitation_jobs SET claim_expires_at = now() - interval '1 second' WHERE id = $1`, [jobId],
    );
    await h.db.query('SELECT public.reclaim_expired_invitation_jobs()');
    expect((await jobRow(jobId)).status).toBe('queued');
    const lost = await h.one('SELECT public.wi_heartbeat_invitation_job($1, $2, 600) AS ok', [jobId, claimToken]);
    expect(lost!.ok).toBe(false);
    expect((await jobRow(jobId)).status).toBe('queued');
    expect((await jobRow(jobId)).locked_by).toBeNull();

    // C.5m — a different worker legitimately owns the job now; the previous
    // identity cannot complete it, and no delivery row appears for it.
    const retaken = (await h.rows(
      `SELECT * FROM public.claim_invitation_jobs($1, 10, 120, ${CHANNELS})`, ['worker-m'],
    )).find((r) => String(r.id) === jobId)!;
    expect(String(retaken.claim_token)).not.toBe(claimToken);
    const stale = await h.one(
      `SELECT public.wi_complete_invitation_job($1, $2, 'provider_accepted', 'worker-k', 'stale', NULL, NULL, 60) AS r`,
      [jobId, claimToken],
    );
    expect(stale!.r?.applied === true).toBe(false);
    expect(await h.countOf('SELECT count(*)::int AS n FROM public.workspace_invitation_deliveries WHERE job_id = $1', [jobId])).toBe(0);
    expect((await jobRow(jobId)).locked_by).toBe('worker-m');
  }, 300_000);

  // ── C.5n ────────────────────────────────────────────────────────────────
  it('C.5n — a graceful shutdown during an active drain neither aborts the in-flight job nor leaves it claimed', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c5n.owner.${Date.now()}@example.test`);
    const queued = await queueOtpJob(owner);
    const jobId = String(queued.job.id);

    const { drainInvitationJobs, startInvitationWorker, stopInvitationWorker } =
      await import('../../../server/services/invitations/worker.js');

    startInvitationWorker(WORKER_CONFIG);
    const inFlight = drainInvitationJobs(WORKER_CONFIG);
    stopInvitationWorker();   // shutdown signal while the job is being processed
    await inFlight;
    stopInvitationWorker();   // idempotent

    const done = await jobRow(jobId);
    expect(done.status).toBe('provider_accepted');
    expect(done.claim_token).toBeNull();
    expect(otpMailsFor(queued.email)).toHaveLength(1);

    // After shutdown no further work is picked up on its own.
    const before = harnessState.capturedEmails.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(harnessState.capturedEmails.length).toBe(before);
  }, 300_000);

  // ── C.5o ────────────────────────────────────────────────────────────────
  it('C.5o — invitation email and SMS delivery failures never delete or revoke the invitation', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c5o.owner.${Date.now()}@example.test`);
    harnessState.emailOutcome = 'error';
    const created = await h.call('POST', '/api/workspace-invitations', {
      cookie: owner.cookie, body: h.invitePayload(owner.workspaceId),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const invitationId = String(created.json.invitation.id);

    const { drainInvitationJobs } = await import('../../../server/services/invitations/worker.js');
    await drainInvitationJobs(WORKER_CONFIG);

    const jobs = await h.rows(
      'SELECT channel, status FROM public.workspace_invitation_jobs WHERE invitation_id = $1', [invitationId],
    );
    expect(jobs.length).toBeGreaterThan(0);
    // Whatever the channels did, none of them reports success-by-delivery…
    expect(jobs.every((j) => j.status !== 'delivered')).toBe(true);
    // …and the invitation itself is untouched: still pending, not revoked, not
    // archived, still exactly one row, and still acceptable later.
    const inv = await h.one('SELECT * FROM public.workspace_invitations WHERE id = $1', [invitationId]);
    expect(inv!.status).toBe('pending');
    expect(inv!.revoked_at).toBeNull();
    expect(inv!.archived_at).toBeNull();
    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_invitations WHERE id = $1', [invitationId],
    )).toBe(1);

    const manualToken = h.tokenFromManualLink(created.json.manualLink);
    const preview = await h.call('POST', '/api/workspace-invitations/preview', {
      body: { token: manualToken, purpose: 'manual_handoff' },
    });
    expect(preview.status, JSON.stringify(preview.json)).toBe(200);
  }, 300_000);
});
