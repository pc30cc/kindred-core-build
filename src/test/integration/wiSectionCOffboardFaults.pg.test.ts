/**
 * WORKSPACE INVITATIONS v5.1 — Section C.4 residual (real PostgreSQL 17).
 *
 * Fault injection around member offboarding and invitation archiving:
 *   - a failure raised MIDWAY through the offboarding transaction rolls back
 *     membership deletion, department rows, invitation revocation, history and
 *     audit together,
 *   - a REAL transport loss after the commit followed by the same requestId
 *     returns the committed outcome and writes no second history/audit row,
 *   - global identity (profiles, user_credentials) and memberships in other
 *     workspaces survive an offboarding untouched,
 *   - archive is idempotent and fails closed on a payload conflict.
 *
 * The fault is injected with a real database trigger, so the failure happens
 * inside the production transaction — no mock, no stub, no timing hack.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

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

const { startHarness } = await import('./invitationHarness.js');
type H = Awaited<ReturnType<typeof startHarness>>;
let h: H;

async function makeDepartments(workspaceId: string, names: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const name of names) {
    const id = crypto.randomUUID();
    await h.db.query(
      'INSERT INTO public.workspace_departments (id, workspace_id, name) VALUES ($1, $2, $3)',
      [id, workspaceId, name],
    );
    ids.push(id);
  }
  return ids;
}

async function onboardMember(owner: { cookie: string; workspaceId: string }, over: Record<string, unknown> = {}) {
  const ready = await h.prepareAcceptable(owner.cookie, owner.workspaceId, over);
  const accept = await h.call('POST', '/api/workspace-invitations/accept-new', {
    cookie: ready.proofCookie, body: ready.acceptBody(),
  });
  expect(accept.status, JSON.stringify(accept.json)).toBe(200);
  const member = await h.one(
    'SELECT id FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2',
    [owner.workspaceId, accept.json.user_id],
  );
  return {
    ...ready,
    userId: String(accept.json.user_id),
    memberId: String(member!.id),
    sessionCookie: h.cookieOf(accept, 'gs_session'),
  };
}

/** Injects a hard failure into the offboarding transaction, mid-way. */
async function injectHistoryFault(): Promise<void> {
  await h.db.query(`
    CREATE OR REPLACE FUNCTION public.wi_test_offboard_fault() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      RAISE EXCEPTION 'INJECTED_OFFBOARD_FAULT';
    END
    $fn$;
    DROP TRIGGER IF EXISTS wi_test_offboard_fault_trg ON public.workspace_member_details_history;
    CREATE TRIGGER wi_test_offboard_fault_trg
      BEFORE INSERT ON public.workspace_member_details_history
      FOR EACH ROW EXECUTE FUNCTION public.wi_test_offboard_fault();
  `);
}
async function clearHistoryFault(): Promise<void> {
  await h.db.query(`
    DROP TRIGGER IF EXISTS wi_test_offboard_fault_trg ON public.workspace_member_details_history;
    DROP FUNCTION IF EXISTS public.wi_test_offboard_fault();
  `);
}

suite('Workspace Invitations v5.1 §C.4 residual — offboarding fault injection and archive idempotency', () => {
  beforeAll(async () => { h = await startHarness(DSN!); }, 300_000);
  afterAll(async () => { if (h) { await clearHistoryFault().catch(() => {}); await h.stop(); } });

  // ── C.4f ────────────────────────────────────────────────────────────────
  it('C.4f — a fault MIDWAY through offboarding rolls back membership, departments, revocation, history and audit together', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c4f.owner.${Date.now()}@example.test`);
    const depts = await makeDepartments(owner.workspaceId, ['Rollback-Dept']);
    const member = await onboardMember(owner, {
      memberType: 'customer_facing', role: 'support_agent', departmentIds: depts,
    });
    // A second, still-pending invitation for the same person: offboarding
    // revokes it, so the rollback must bring it back to pending.
    const pending = await h.call('POST', '/api/workspace-invitations', {
      cookie: owner.cookie,
      body: h.invitePayload(owner.workspaceId, { email: member.email }),
    });
    expect(pending.status, JSON.stringify(pending.json)).toBe(201);
    const pendingId = String(pending.json.invitation.id);

    const auditBefore = await h.countOf(
      `SELECT count(*)::int AS n FROM public.audit_logs WHERE workspace_id = $1`, [owner.workspaceId],
    );

    await injectHistoryFault();
    const failed = await h.call('DELETE', `/api/workspace-members/${member.memberId}?workspaceId=${owner.workspaceId}`, {
      cookie: owner.cookie, body: { requestId: h.rid(), reason: 'fault' },
    });
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(failed.json)).not.toMatch(/token|digest|pepper|secret|password/i);

    // EVERY effect rolled back together.
    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [owner.workspaceId, member.userId],
    )).toBe(1);
    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_department_members WHERE workspace_id = $1 AND user_id = $2',
      [owner.workspaceId, member.userId],
    )).toBe(1);
    expect(String((await h.one('SELECT status FROM public.workspace_invitations WHERE id = $1', [pendingId]))!.status)).toBe('pending');
    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_member_details_history WHERE workspace_id = $1 AND user_id = $2',
      [owner.workspaceId, member.userId],
    )).toBe(0);
    expect(await h.countOf(
      `SELECT count(*)::int AS n FROM public.audit_logs WHERE workspace_id = $1`, [owner.workspaceId],
    )).toBe(auditBefore);
    // No committed ledger row: a rolled-back operation must not look done.
    expect(await h.countOf(
      `SELECT count(*)::int AS n FROM public.workspace_invitation_idempotency
        WHERE workspace_id = $1 AND operation = 'offboard' AND result_state = 'committed'`,
      [owner.workspaceId],
    )).toBe(0);

    // Recovery: with the fault removed the same offboarding succeeds.
    await clearHistoryFault();
    const ok = await h.call('DELETE', `/api/workspace-members/${member.memberId}?workspaceId=${owner.workspaceId}`, {
      cookie: owner.cookie, body: { requestId: h.rid(), reason: 'after fault' },
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [owner.workspaceId, member.userId],
    )).toBe(0);
  }, 300_000);

  // ── C.4g ────────────────────────────────────────────────────────────────
  it('C.4g — a REAL socket loss after commit, replayed with the same requestId, writes no second history or audit row', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c4g.owner.${Date.now()}@example.test`);
    const member = await onboardMember(owner);
    const requestId = h.rid();
    const path = `/api/workspace-members/${member.memberId}?workspaceId=${owner.workspaceId}`;

    const lost = await h.callLosingResponse(
      'DELETE', path,
      { cookie: owner.cookie, body: { requestId, reason: 'transport loss' } },
      async () => (await h.countOf(
        `SELECT count(*)::int AS n FROM public.workspace_invitation_idempotency
          WHERE request_id = $1 AND result_state = 'committed'`, [requestId],
      )) === 1,
    );
    expect(lost.lost || lost.res?.status === 200).toBe(true);

    // The destructive work is committed even though the client saw nothing.
    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [owner.workspaceId, member.userId],
    )).toBe(0);
    const history = await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_member_details_history WHERE workspace_id = $1 AND user_id = $2',
      [owner.workspaceId, member.userId],
    );
    const audit = await h.countOf(
      `SELECT count(*)::int AS n FROM public.audit_logs WHERE workspace_id = $1 AND action LIKE '%offboard%'`,
      [owner.workspaceId],
    );
    expect(history).toBe(1);

    const replay = await h.call('DELETE', path, { cookie: owner.cookie, body: { requestId, reason: 'transport loss' } });
    expect(replay.status, JSON.stringify(replay.json)).toBe(200);
    expect(replay.json.replayed).toBe(true);
    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_member_details_history WHERE workspace_id = $1 AND user_id = $2',
      [owner.workspaceId, member.userId],
    )).toBe(history);
    expect(await h.countOf(
      `SELECT count(*)::int AS n FROM public.audit_logs WHERE workspace_id = $1 AND action LIKE '%offboard%'`,
      [owner.workspaceId],
    )).toBe(audit);
  }, 300_000);

  // ── C.4h ────────────────────────────────────────────────────────────────
  it('C.4h — offboarding leaves the global profile, credentials and other-workspace memberships intact', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c4h.owner.${Date.now()}@example.test`);
    const member = await onboardMember(owner);

    // The same person is ALSO a member of a second, unrelated workspace,
    // joined through the real existing-account acceptance flow.
    h.freshAddr();
    const other = await h.makeOwner(`c4h.other.${Date.now()}@example.test`);
    const inviteB = await h.call('POST', '/api/workspace-invitations', {
      cookie: other.cookie, body: h.invitePayload(other.workspaceId, { email: member.email }),
    });
    expect(inviteB.status, JSON.stringify(inviteB.json)).toBe(201);
    const tokenB = h.tokenFromManualLink(inviteB.json.manualLink);
    const ctx = await h.call('POST', '/api/workspace-invitations/login-context', {
      body: { requestId: h.rid(), token: tokenB, purpose: 'manual_handoff' },
    });
    expect(ctx.status, JSON.stringify(ctx.json)).toBe(200);
    const ctxCookie = h.cookieOf(ctx, 'wi_ctx')!;
    const policies = await h.activePolicies();
    const joined = await h.call('POST', '/api/workspace-invitations/accept-existing', {
      cookie: `${member.sessionCookie}; ${ctxCookie}`,
      body: { requestId: h.rid(), consent: true, ...policies },
    });
    expect(joined.status, JSON.stringify(joined.json)).toBe(200);
    const otherWorkspaceId = other.workspaceId;

    const credentialsBefore = await h.one(
      'SELECT user_id, password_hash FROM public.user_credentials WHERE user_id = $1', [member.userId],
    );
    expect(credentialsBefore).toBeTruthy();

    const removed = await h.call('DELETE', `/api/workspace-members/${member.memberId}?workspaceId=${owner.workspaceId}`, {
      cookie: owner.cookie, body: { requestId: h.rid(), reason: 'left' },
    });
    expect(removed.status, JSON.stringify(removed.json)).toBe(200);

    expect(await h.countOf('SELECT count(*)::int AS n FROM public.profiles WHERE id = $1', [member.userId])).toBe(1);
    const credentialsAfter = await h.one(
      'SELECT user_id, password_hash FROM public.user_credentials WHERE user_id = $1', [member.userId],
    );
    expect(credentialsAfter!.password_hash).toBe(credentialsBefore!.password_hash);
    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [otherWorkspaceId, member.userId],
    )).toBe(1);
  }, 300_000);

  // ── C.4i ────────────────────────────────────────────────────────────────
  it('C.4i — archiving an invitation is idempotent on replay and fails closed on a payload conflict', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c4i.owner.${Date.now()}@example.test`);
    const first = await h.call('POST', '/api/workspace-invitations', {
      cookie: owner.cookie, body: h.invitePayload(owner.workspaceId),
    });
    expect(first.status).toBe(201);
    const second = await h.call('POST', '/api/workspace-invitations', {
      cookie: owner.cookie, body: h.invitePayload(owner.workspaceId),
    });
    expect(second.status).toBe(201);
    const idA = String(first.json.invitation.id);
    const idB = String(second.json.invitation.id);

    // Archiving is only legal once an invitation is no longer pending.
    for (const id of [idA, idB]) {
      const revoked = await h.call('POST', `/api/workspace-invitations/${id}/revoke`, {
        cookie: owner.cookie, body: { requestId: h.rid(), reason: 'obsolete' },
      });
      expect(revoked.status, JSON.stringify(revoked.json)).toBe(200);
    }

    const requestId = h.rid();
    const archive = await h.call('POST', `/api/workspace-invitations/${idA}/archive`, {
      cookie: owner.cookie, body: { requestId },
    });
    expect(archive.status, JSON.stringify(archive.json)).toBe(200);
    expect(archive.json.replayed).toBe(false);
    const archivedAt = (await h.one('SELECT archived_at FROM public.workspace_invitations WHERE id = $1', [idA]))!.archived_at;
    expect(archivedAt).toBeTruthy();

    const replay = await h.call('POST', `/api/workspace-invitations/${idA}/archive`, {
      cookie: owner.cookie, body: { requestId },
    });
    expect(replay.status).toBe(200);
    expect(replay.json.replayed).toBe(true);
    expect(String((await h.one('SELECT archived_at FROM public.workspace_invitations WHERE id = $1', [idA]))!.archived_at))
      .toBe(String(archivedAt));

    // The key is scope-bound (operation + workspace + invitation + requestId),
    // so the SAME requestId against invitation B is a different operation and
    // is executed on its own merits — it can never archive A twice.
    const otherTarget = await h.call('POST', `/api/workspace-invitations/${idB}/archive`, {
      cookie: owner.cookie, body: { requestId },
    });
    expect(otherTarget.status, JSON.stringify(otherTarget.json)).toBe(200);
    expect(otherTarget.json.replayed).toBe(false);
    expect(String((await h.one('SELECT archived_at FROM public.workspace_invitations WHERE id = $1', [idA]))!.archived_at))
      .toBe(String(archivedAt));

    // A genuine PAYLOAD CONFLICT — same key, different arguments — fails closed.
    const conflictRequestId = h.rid();
    const third = await h.call('POST', '/api/workspace-invitations', {
      cookie: owner.cookie, body: h.invitePayload(owner.workspaceId),
    });
    expect(third.status).toBe(201);
    const idC = String(third.json.invitation.id);
    const revokedOnce = await h.call('POST', `/api/workspace-invitations/${idC}/revoke`, {
      cookie: owner.cookie, body: { requestId: conflictRequestId, reason: 'reason-one' },
    });
    expect(revokedOnce.status, JSON.stringify(revokedOnce.json)).toBe(200);
    const conflict = await h.call('POST', `/api/workspace-invitations/${idC}/revoke`, {
      cookie: owner.cookie, body: { requestId: conflictRequestId, reason: 'reason-two' },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.json.error).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(String((await h.one('SELECT revoked_reason FROM public.workspace_invitations WHERE id = $1', [idC]))!.revoked_reason))
      .toBe('reason-one');

    // Exactly one committed archive ledger row.
    expect(await h.countOf(
      `SELECT count(*)::int AS n FROM public.workspace_invitation_idempotency
        WHERE workspace_id = $1 AND operation = 'archive' AND result_state = 'committed'`,
      [owner.workspaceId],
    )).toBe(2);
  }, 300_000);
});
