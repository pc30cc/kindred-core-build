/**
 * WORKSPACE INVITATIONS v5.1 — Section C.3/C.4 (real PostgreSQL 17).
 *
 *   C.3  department + consent atomicity: a customer-facing acceptance writes
 *        membership, department assignments and consent together or not at
 *        all, and a concurrent double-submit never duplicates any of them.
 *   C.4  offboarding idempotency: a lost DELETE response replayed with the
 *        same requestId returns the committed outcome instead of re-running a
 *        destructive offboarding, a different payload on the same requestId
 *        fails closed, and concurrent deletes collapse to one offboarding.
 *
 * Everything runs through the REAL Express routes and the REAL SQL.
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

const workspaceLock = (workspaceId: string) => ({
  sql: 'SELECT 1 FROM public.workspaces WHERE id = $1 FOR UPDATE',
  params: [workspaceId],
});

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

/** Onboard a real member through the real acceptance flow. */
async function onboardMember(owner: { cookie: string; workspaceId: string }, over: Record<string, unknown> = {}) {
  const ready = await h.prepareAcceptable(owner.cookie, owner.workspaceId, over);
  const accept = await h.call('POST', '/api/workspace-invitations/accept-new', {
    cookie: ready.proofCookie, body: ready.acceptBody(),
  });
  expect(accept.status, JSON.stringify(accept.json)).toBe(200);
  const member = await h.one(
    'SELECT id, user_id FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2',
    [owner.workspaceId, accept.json.user_id],
  );
  expect(member).toBeTruthy();
  return { ...ready, userId: String(accept.json.user_id), memberId: String(member!.id) };
}

suite('Workspace Invitations v5.1 §C.3/C.4 — department/consent atomicity and offboarding idempotency', () => {
  beforeAll(async () => { h = await startHarness(DSN!); }, 300_000);
  afterAll(async () => { if (h) await h.stop(); });

  // ── C.3a ────────────────────────────────────────────────────────────────
  it('C.3a — a customer-facing acceptance writes membership, ALL departments and consent in one transaction', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c3a.owner.${Date.now()}@example.test`);
    const deptIds = await makeDepartments(owner.workspaceId, ['Support', 'Sales', 'Billing']);

    const ready = await h.prepareAcceptable(owner.cookie, owner.workspaceId, {
      memberType: 'customer_facing', role: 'support_agent', departmentIds: deptIds,
    });
    const accept = await h.call('POST', '/api/workspace-invitations/accept-new', {
      cookie: ready.proofCookie, body: ready.acceptBody(),
    });
    expect(accept.status, JSON.stringify(accept.json)).toBe(200);
    const userId = String(accept.json.user_id);

    const assigned = await h.rows(
      'SELECT department_id FROM public.workspace_department_members WHERE workspace_id = $1 AND user_id = $2',
      [owner.workspaceId, userId],
    );
    expect(assigned.map((r) => String(r.department_id)).sort()).toEqual([...deptIds].sort());
    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_invitation_consents WHERE invitation_id = $1', [ready.invitationId],
    )).toBe(1);
    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [owner.workspaceId, userId],
    )).toBe(1);
  }, 300_000);

  // ── C.3b ────────────────────────────────────────────────────────────────
  it('C.3b — concurrent acceptance of a multi-department invitation duplicates NO department row and NO consent', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c3b.owner.${Date.now()}@example.test`);
    const deptIds = await makeDepartments(owner.workspaceId, ['Ops', 'Success']);
    const ready = await h.prepareAcceptable(owner.cookie, owner.workspaceId, {
      memberType: 'customer_facing', role: 'support_agent', departmentIds: deptIds,
    });

    const [a, b] = await h.raceUnderLock(workspaceLock(owner.workspaceId), 2, () => [
      h.call('POST', '/api/workspace-invitations/accept-new', { cookie: ready.proofCookie, body: ready.acceptBody() }),
      h.call('POST', '/api/workspace-invitations/accept-new', { cookie: ready.proofCookie, body: ready.acceptBody() }),
    ]);
    expect([a, b].filter((r) => r.status === 200), JSON.stringify([a.json, b.json])).toHaveLength(1);

    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_department_members WHERE workspace_id = $1', [owner.workspaceId],
    )).toBe(deptIds.length);
    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_invitation_consents WHERE invitation_id = $1', [ready.invitationId],
    )).toBe(1);
    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_members WHERE workspace_id = $1', [owner.workspaceId],
    )).toBe(2);
  }, 300_000);

  // ── C.3c ────────────────────────────────────────────────────────────────
  it('C.3c — a missing consent version rolls the WHOLE acceptance back: no member, no department, no consent', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c3c.owner.${Date.now()}@example.test`);
    const deptIds = await makeDepartments(owner.workspaceId, ['Retention']);
    const ready = await h.prepareAcceptable(owner.cookie, owner.workspaceId, {
      memberType: 'customer_facing', role: 'support_agent', departmentIds: deptIds,
    });

    const bogus = { ...ready.acceptBody(), termsVersionId: crypto.randomUUID() };
    const failed = await h.call('POST', '/api/workspace-invitations/accept-new', {
      cookie: ready.proofCookie, body: bogus,
    });
    expect(failed.status).toBeGreaterThanOrEqual(400);

    expect(await h.countOf('SELECT count(*)::int AS n FROM public.workspace_members WHERE workspace_id = $1', [owner.workspaceId])).toBe(1);
    expect(await h.countOf('SELECT count(*)::int AS n FROM public.workspace_department_members WHERE workspace_id = $1', [owner.workspaceId])).toBe(0);
    expect(await h.countOf('SELECT count(*)::int AS n FROM public.workspace_invitation_consents WHERE invitation_id = $1', [ready.invitationId])).toBe(0);

    // The failure is recoverable: the correct payload still works.
    const ok = await h.call('POST', '/api/workspace-invitations/accept-new', {
      cookie: ready.proofCookie, body: ready.acceptBody(),
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(await h.countOf('SELECT count(*)::int AS n FROM public.workspace_department_members WHERE workspace_id = $1', [owner.workspaceId])).toBe(1);
  }, 300_000);

  // ── C.4a ────────────────────────────────────────────────────────────────
  it('C.4a — a lost DELETE response replayed with the same requestId offboards exactly once', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c4a.owner.${Date.now()}@example.test`);
    const member = await onboardMember(owner);
    const requestId = h.rid();
    const path = `/api/workspace-members/${member.memberId}?workspaceId=${owner.workspaceId}`;

    const first = await h.call('DELETE', path, { cookie: owner.cookie, body: { requestId, reason: 'left the company' } });
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.json.replayed).toBe(false);

    const historyAfterFirst = await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_member_details_history WHERE workspace_id = $1 AND user_id = $2',
      [owner.workspaceId, member.userId],
    );
    const auditAfterFirst = await h.countOf(
      `SELECT count(*)::int AS n FROM public.audit_logs WHERE workspace_id = $1 AND action LIKE '%offboard%'`,
      [owner.workspaceId],
    );

    // The client never saw the response and retries — the member row it would
    // look up is already gone, so only the ledger can answer correctly.
    const replay = await h.call('DELETE', path, { cookie: owner.cookie, body: { requestId, reason: 'left the company' } });
    expect(replay.status, JSON.stringify(replay.json)).toBe(200);
    expect(replay.json.replayed).toBe(true);
    expect(replay.json.offboarding).toBeTruthy();

    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_member_details_history WHERE workspace_id = $1 AND user_id = $2',
      [owner.workspaceId, member.userId],
    )).toBe(historyAfterFirst);
    expect(await h.countOf(
      `SELECT count(*)::int AS n FROM public.audit_logs WHERE workspace_id = $1 AND action LIKE '%offboard%'`,
      [owner.workspaceId],
    )).toBe(auditAfterFirst);
    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [owner.workspaceId, member.userId],
    )).toBe(0);
    // Exactly one committed ledger row for this destructive operation.
    expect(await h.countOf(
      `SELECT count(*)::int AS n FROM public.workspace_invitation_idempotency
        WHERE workspace_id = $1 AND operation = 'offboard' AND result_state = 'committed'`,
      [owner.workspaceId],
    )).toBe(1);
  }, 300_000);

  // ── C.4b ────────────────────────────────────────────────────────────────
  it('C.4b — the same requestId with a DIFFERENT target fails closed and offboards nobody else', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c4b.owner.${Date.now()}@example.test`);
    const first = await onboardMember(owner);
    const second = await onboardMember(owner);
    const requestId = h.rid();

    const removed = await h.call('DELETE', `/api/workspace-members/${first.memberId}?workspaceId=${owner.workspaceId}`, {
      cookie: owner.cookie, body: { requestId, reason: 'r1' },
    });
    expect(removed.status).toBe(200);

    const reused = await h.call('DELETE', `/api/workspace-members/${second.memberId}?workspaceId=${owner.workspaceId}`, {
      cookie: owner.cookie, body: { requestId, reason: 'r1' },
    });
    expect(reused.status).toBe(409);
    expect(reused.json.error).toBe('IDEMPOTENCY_KEY_REUSED');

    // The second member is untouched.
    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [owner.workspaceId, second.userId],
    )).toBe(1);
  }, 300_000);

  // ── C.4c ────────────────────────────────────────────────────────────────
  it('C.4c — concurrent DELETEs of the same member collapse into exactly one offboarding', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c4c.owner.${Date.now()}@example.test`);
    const member = await onboardMember(owner);
    const path = `/api/workspace-members/${member.memberId}?workspaceId=${owner.workspaceId}`;

    // Two DIFFERENT requestIds: a genuine double-click, not a replay.
    const [a, b] = await h.raceUnderLock(workspaceLock(owner.workspaceId), 2, () => [
      h.call('DELETE', path, { cookie: owner.cookie, body: { requestId: h.rid(), reason: 'dup' } }),
      h.call('DELETE', path, { cookie: owner.cookie, body: { requestId: h.rid(), reason: 'dup' } }),
    ]);

    const succeeded = [a, b].filter((r) => r.status === 200 && r.json.replayed === false);
    expect(succeeded, JSON.stringify([a.json, b.json])).toHaveLength(1);
    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_member_details_history WHERE workspace_id = $1 AND user_id = $2',
      [owner.workspaceId, member.userId],
    )).toBe(1);
    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [owner.workspaceId, member.userId],
    )).toBe(0);
  }, 300_000);

  // ── C.4d ────────────────────────────────────────────────────────────────
  it('C.4d — offboarding revokes the member\'s pending invitations and department rows, and frees the seat', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c4d.owner.${Date.now()}@example.test`);
    const deptIds = await makeDepartments(owner.workspaceId, ['Field']);
    const member = await onboardMember(owner, {
      memberType: 'customer_facing', role: 'support_agent', departmentIds: deptIds,
    });

    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_department_members WHERE workspace_id = $1 AND user_id = $2',
      [owner.workspaceId, member.userId],
    )).toBe(1);

    const removed = await h.call('DELETE', `/api/workspace-members/${member.memberId}?workspaceId=${owner.workspaceId}`, {
      cookie: owner.cookie, body: { requestId: h.rid(), reason: 'offboard' },
    });
    expect(removed.status, JSON.stringify(removed.json)).toBe(200);
    expect(removed.json.offboarding).toBeTruthy();
    // The projection carries counters only — never a token, digest or code.
    expect(JSON.stringify(removed.json)).not.toMatch(/token|digest|code_|pepper|secret/i);

    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_department_members WHERE workspace_id = $1 AND user_id = $2',
      [owner.workspaceId, member.userId],
    )).toBe(0);
    expect(await h.countOf(
      `SELECT count(*)::int AS n FROM public.workspace_invitations
        WHERE workspace_id = $1 AND status = 'pending'
          AND invited_email_normalized = lower($2)`,
      [owner.workspaceId, member.email],
    )).toBe(0);
    // Seat accounting reflects the departure immediately.
    const capacity = await h.one('SELECT * FROM public.wi_resolve_seat_capacity($1)', [owner.workspaceId]);
    expect(Number(capacity!.used)).toBe(1);
  }, 300_000);

  // ── C.4e ────────────────────────────────────────────────────────────────
  it('C.4e — a DELETE without a requestId still works (service callers) and the owner can never be removed', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c4e.owner.${Date.now()}@example.test`);
    const member = await onboardMember(owner);

    const ownerMember = await h.one(
      'SELECT id FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [owner.workspaceId, owner.userId],
    );
    const blocked = await h.call('DELETE', `/api/workspace-members/${ownerMember!.id}?workspaceId=${owner.workspaceId}`, {
      cookie: owner.cookie, body: { requestId: h.rid() },
    });
    expect(blocked.status).toBe(403);
    expect(blocked.json.error).toBe('cannot_remove_owner');

    const legacy = await h.call('DELETE', `/api/workspace-members/${member.memberId}?workspaceId=${owner.workspaceId}`, {
      cookie: owner.cookie, body: { reason: 'no request id' },
    });
    expect(legacy.status, JSON.stringify(legacy.json)).toBe(200);
    expect(legacy.json.replayed).toBe(false);
    // No ledger row is written for the legacy path — it is explicitly opt-in.
    expect(await h.countOf(
      `SELECT count(*)::int AS n FROM public.workspace_invitation_idempotency
        WHERE workspace_id = $1 AND operation = 'offboard'`,
      [owner.workspaceId],
    )).toBe(0);
  }, 300_000);
});
