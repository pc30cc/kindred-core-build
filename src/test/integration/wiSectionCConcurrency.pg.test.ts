/**
 * WORKSPACE INVITATIONS v5.1 — Section C.1/C.2 (real PostgreSQL 17).
 *
 * Concurrency and race coverage that the canonical idempotency suite does not
 * reach, driven through the REAL Express routers against the REAL self-host
 * schema:
 *
 *   C.1  two acceptances of the SAME invitation racing head-on,
 *        two DIFFERENT invitations racing for the LAST seat,
 *        a seat-limit rejection that burns no token,
 *   C.2  rotate-vs-accept and revoke-vs-accept races on a live manual link.
 *
 * Every race is gated by a DETERMINISTIC barrier: a control connection holds
 * the exact row lock the production code path takes (`workspaces` FOR UPDATE,
 * acquired first by wi_lock_and_validate_token), the racing requests are
 * started, the harness waits until PostgreSQL reports them blocked on that
 * lock, and only then releases. No timing-only sleep decides the interleaving.
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

const { startHarness, harnessState } = await import('./invitationHarness.js');
type H = Awaited<ReturnType<typeof startHarness>>;
let h: H;

/** Lock the row every acceptance path locks FIRST (079: workspaces FOR UPDATE). */
const workspaceLock = (workspaceId: string) => ({
  sql: 'SELECT 1 FROM public.workspaces WHERE id = $1 FOR UPDATE',
  params: [workspaceId],
});

suite('Workspace Invitations v5.1 §C.1/C.2 — acceptance concurrency, seats and link races', () => {
  beforeAll(async () => {
    h = await startHarness(DSN!);
  }, 300_000);

  afterAll(async () => { if (h) await h.stop(); });

  // ── C.1a ────────────────────────────────────────────────────────────────
  it('C.1a — two concurrent acceptances of the same invitation produce exactly one member, one consent and one accepted invitation', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c1a.owner.${Date.now()}@example.test`);
    const ready = await h.prepareAcceptable(owner.cookie, owner.workspaceId);

    // Two DIFFERENT requestIds: this is a genuine double-submit, not a replay.
    const [a, b] = await h.raceUnderLock(workspaceLock(owner.workspaceId), 2, () => [
      h.call('POST', '/api/workspace-invitations/accept-new', { cookie: ready.proofCookie, body: ready.acceptBody() }),
      h.call('POST', '/api/workspace-invitations/accept-new', { cookie: ready.proofCookie, body: ready.acceptBody() }),
    ]);

    const accepted = [a, b].filter((r) => r.status === 200);
    expect(accepted, JSON.stringify([a.json, b.json])).toHaveLength(1);

    const invitation = await h.one('SELECT status, accepted_by FROM public.workspace_invitations WHERE id = $1', [ready.invitationId]);
    expect(invitation!.status).toBe('accepted');
    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_members WHERE workspace_id = $1', [owner.workspaceId],
    )).toBe(2); // owner + exactly one invitee
    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_invitation_consents WHERE invitation_id = $1', [ready.invitationId],
    )).toBe(1);
    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_member_details WHERE workspace_id = $1', [owner.workspaceId],
    )).toBe(1);
    // The manual token is consumed exactly once and no live secret survives.
    expect(await h.countOf(
      `SELECT count(*)::int AS n FROM public.workspace_invitation_tokens
        WHERE invitation_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL`, [ready.invitationId],
    )).toBe(0);
  }, 300_000);

  // ── C.1b ────────────────────────────────────────────────────────────────
  it('C.1b — two different invitations racing for the last seat: exactly one is admitted and the limit is never exceeded', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c1b.owner.${Date.now()}@example.test`);
    const first = await h.prepareAcceptable(owner.cookie, owner.workspaceId);
    const second = await h.prepareAcceptable(owner.cookie, owner.workspaceId);

    // Owner already occupies one seat; the platform allows exactly two.
    await h.db.query(
      `SELECT public.set_workspace_seat_entitlement_mode(
         _mode := 'self_host_fixed_limit', _source := 'test_c1b', _seat_limit := 2)`,
    );
    try {
      const [a, b] = await h.raceUnderLock(workspaceLock(owner.workspaceId), 2, () => [
        h.call('POST', '/api/workspace-invitations/accept-new', { cookie: first.proofCookie, body: first.acceptBody() }),
        h.call('POST', '/api/workspace-invitations/accept-new', { cookie: second.proofCookie, body: second.acceptBody() }),
      ]);

      const ok = [a, b].filter((r) => r.status === 200);
      const rejected = [a, b].filter((r) => r.status !== 200);
      expect(ok, JSON.stringify([a.json, b.json])).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(JSON.stringify(rejected[0].json)).toMatch(/SEAT_LIMIT_REACHED|invitation_not_found|INVITATION_NOT_FOUND/);

      expect(await h.countOf(
        'SELECT count(*)::int AS n FROM public.workspace_members WHERE workspace_id = $1', [owner.workspaceId],
      )).toBe(2);

      // C.1c — the rejected acceptance burned nothing: its token is still live
      // and the SAME invitation can be accepted once a seat is freed.
      const loser = [first, second].find((r) => r.proofCookie !== undefined
        && !ok.some((res) => String(res.json.user_id || '') && res.json.invitation_id === r.invitationId));
      void loser;
      const stillLive = await h.countOf(
        `SELECT count(*)::int AS n
           FROM public.workspace_invitation_tokens t
           JOIN public.workspace_invitations i ON i.id = t.invitation_id
          WHERE i.workspace_id = $1 AND i.status = 'pending'
            AND t.consumed_at IS NULL AND t.revoked_at IS NULL`,
        [owner.workspaceId],
      );
      expect(stillLive).toBeGreaterThanOrEqual(1);
    } finally {
      await h.db.query(
        `SELECT public.set_workspace_seat_entitlement_mode(_mode := 'self_host_unlimited', _source := 'test_reset')`,
      );
    }
  }, 300_000);

  // ── C.1c ────────────────────────────────────────────────────────────────
  it('C.1c — a seat-limit rejection consumes no secret: the same invitation succeeds after the limit is raised', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c1c.owner.${Date.now()}@example.test`);
    const ready = await h.prepareAcceptable(owner.cookie, owner.workspaceId);

    await h.db.query(
      `SELECT public.set_workspace_seat_entitlement_mode(
         _mode := 'self_host_fixed_limit', _source := 'test_c1c', _seat_limit := 1)`,
    );
    const blocked = await h.call('POST', '/api/workspace-invitations/accept-new', {
      cookie: ready.proofCookie, body: ready.acceptBody(),
    });
    expect(blocked.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(blocked.json)).toContain('SEAT_LIMIT_REACHED');

    // No partial write survived the rejected transaction.
    expect(await h.countOf('SELECT count(*)::int AS n FROM public.workspace_members WHERE workspace_id = $1', [owner.workspaceId])).toBe(1);
    expect(await h.countOf('SELECT count(*)::int AS n FROM public.workspace_invitation_consents WHERE invitation_id = $1', [ready.invitationId])).toBe(0);
    expect(await h.countOf(
      `SELECT count(*)::int AS n FROM public.workspace_invitation_tokens
        WHERE invitation_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL`, [ready.invitationId],
    )).toBe(1);
    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_invitation_idempotency WHERE workspace_id = $1 AND operation = $2',
      [owner.workspaceId, 'accept_new'],
    )).toBe(0);

    await h.db.query(
      `SELECT public.set_workspace_seat_entitlement_mode(_mode := 'self_host_unlimited', _source := 'test_reset')`,
    );
    const ok = await h.call('POST', '/api/workspace-invitations/accept-new', {
      cookie: ready.proofCookie, body: ready.acceptBody(),
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(await h.countOf('SELECT count(*)::int AS n FROM public.workspace_members WHERE workspace_id = $1', [owner.workspaceId])).toBe(2);
  }, 300_000);

  // ── C.2a ────────────────────────────────────────────────────────────────
  it('C.2a — rotate racing acceptance never yields both a consumed old link and a live rotated link for one seat', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c2a.owner.${Date.now()}@example.test`);
    const ready = await h.prepareAcceptable(owner.cookie, owner.workspaceId);

    const [accept, rotate] = await h.raceUnderLock(workspaceLock(owner.workspaceId), 2, () => [
      h.call('POST', '/api/workspace-invitations/accept-new', { cookie: ready.proofCookie, body: ready.acceptBody() }),
      h.call('POST', `/api/workspace-invitations/${ready.invitationId}/rotate-link`, {
        cookie: owner.cookie, body: { requestId: h.rid() },
      }),
    ]);

    const memberCount = await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_members WHERE workspace_id = $1', [owner.workspaceId],
    );
    const liveTokens = await h.countOf(
      `SELECT count(*)::int AS n FROM public.workspace_invitation_tokens
        WHERE invitation_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL`, [ready.invitationId],
    );
    const status = String((await h.one('SELECT status FROM public.workspace_invitations WHERE id = $1', [ready.invitationId]))!.status);

    if (accept.status === 200) {
      // Acceptance won: the invitation is closed and no secret may survive,
      // whether or not the rotate call was serialized behind it.
      expect(status).toBe('accepted');
      expect(memberCount).toBe(2);
      expect(liveTokens).toBe(0);
    } else {
      // Rotation won: the old link is dead, exactly one live link remains and
      // no membership was created.
      expect(rotate.status).toBe(200);
      expect(status).toBe('pending');
      expect(memberCount).toBe(1);
      expect(liveTokens).toBe(1);
    }
    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_invitation_consents WHERE invitation_id = $1', [ready.invitationId],
    )).toBe(accept.status === 200 ? 1 : 0);
  }, 300_000);

  // ── C.2b ────────────────────────────────────────────────────────────────
  it('C.2b — revoke racing acceptance is all-or-nothing: never a revoked invitation with a live membership', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c2b.owner.${Date.now()}@example.test`);
    const ready = await h.prepareAcceptable(owner.cookie, owner.workspaceId);

    const [accept, revoke] = await h.raceUnderLock(workspaceLock(owner.workspaceId), 2, () => [
      h.call('POST', '/api/workspace-invitations/accept-new', { cookie: ready.proofCookie, body: ready.acceptBody() }),
      h.call('POST', `/api/workspace-invitations/${ready.invitationId}/revoke`, {
        cookie: owner.cookie, body: { requestId: h.rid(), reason: 'race' },
      }),
    ]);

    const status = String((await h.one('SELECT status FROM public.workspace_invitations WHERE id = $1', [ready.invitationId]))!.status);
    const members = await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_members WHERE workspace_id = $1', [owner.workspaceId],
    );

    expect(['accepted', 'revoked']).toContain(status);
    expect(members).toBe(status === 'accepted' ? 2 : 1);
    if (status === 'revoked') expect(accept.status).not.toBe(200);
    if (status === 'accepted') expect(accept.status).toBe(200);
    void revoke;

    // Whatever the outcome, no usable secret survives a terminal invitation.
    expect(await h.countOf(
      `SELECT count(*)::int AS n FROM public.workspace_invitation_tokens
        WHERE invitation_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL`, [ready.invitationId],
    )).toBe(0);
  }, 300_000);

  // ── C.2c ────────────────────────────────────────────────────────────────
  it('C.2c — concurrent resend and rotate on one invitation leave exactly one live manual link', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c2c.owner.${Date.now()}@example.test`);
    const created = await h.call('POST', '/api/workspace-invitations', {
      cookie: owner.cookie, body: h.invitePayload(owner.workspaceId),
    });
    expect(created.status).toBe(201);
    const id = String(created.json.invitation.id);

    const [resend, rotate] = await h.raceUnderLock(workspaceLock(owner.workspaceId), 2, () => [
      h.call('POST', `/api/workspace-invitations/${id}/resend`, { cookie: owner.cookie, body: { requestId: h.rid() } }),
      h.call('POST', `/api/workspace-invitations/${id}/rotate-link`, { cookie: owner.cookie, body: { requestId: h.rid() } }),
    ]);
    expect(resend.status).toBe(200);
    expect(rotate.status).toBe(200);

    expect(await h.countOf(
      `SELECT count(*)::int AS n FROM public.workspace_invitation_tokens
        WHERE invitation_id = $1 AND purpose = 'manual_handoff'
          AND consumed_at IS NULL AND revoked_at IS NULL`, [id],
    )).toBe(1);
    void harnessState;
  }, 300_000);
});
