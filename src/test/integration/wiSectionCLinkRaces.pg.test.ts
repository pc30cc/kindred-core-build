/**
 * WORKSPACE INVITATIONS v5.1 — Section C.1/C.2 residual link races
 * (real PostgreSQL 17, real Express routers, real SQL).
 *
 * Closes the race/rejection cases the first C.1/C.2 suite did not cover:
 *   resend-vs-resend, rotate-vs-rotate, old-token rejection after EVERY
 *   successful resend and rotate, and acceptance of an expired, revoked or
 *   wrong-account invitation. Every race uses the deterministic lock barrier;
 *   after every race exactly ONE live manual token must remain.
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

const workspaceLock = (workspaceId: string) => ({
  sql: 'SELECT 1 FROM public.workspaces WHERE id = $1 FOR UPDATE',
  params: [workspaceId],
});

const liveManualTokens = (invitationId: string) => h.countOf(
  `SELECT count(*)::int AS n FROM public.workspace_invitation_tokens
    WHERE invitation_id = $1 AND purpose = 'manual_handoff'
      AND consumed_at IS NULL AND revoked_at IS NULL`,
  [invitationId],
);

/** Latest invitation-email claim link delivered to `email`, as a raw token. */
async function emailClaimToken(email: string): Promise<string> {
  await h.drainOutbox();
  const hits = harnessState.capturedEmails.filter(
    (e) => e.to?.toLowerCase() === email.toLowerCase() && e.templateSlug === 'invite_member' && e.actionUrl,
  );
  expect(hits.length, `no invitation email captured for ${email}`).toBeGreaterThan(0);
  return h.tokenFromManualLink(String(hits[hits.length - 1].actionUrl));
}

const previewOf = (token: string, purpose: string) =>
  h.call('POST', '/api/workspace-invitations/preview', { body: { token, purpose } });

async function createInvitation(owner: { cookie: string; workspaceId: string }) {
  const payload = h.invitePayload(owner.workspaceId);
  const created = await h.call('POST', '/api/workspace-invitations', { cookie: owner.cookie, body: payload });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  return {
    id: String(created.json.invitation.id),
    email: String(payload.email),
    manualToken: h.tokenFromManualLink(created.json.manualLink),
  };
}

suite('Workspace Invitations v5.1 §C.1/C.2 residual — resend/rotate races and rejected acceptances', () => {
  beforeAll(async () => { h = await startHarness(DSN!); }, 300_000);
  afterAll(async () => { if (h) await h.stop(); });

  // ── C.2d ────────────────────────────────────────────────────────────────
  it('C.2d — two concurrent resends leave exactly one live manual token and one live email token', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c2d.owner.${Date.now()}@example.test`);
    const inv = await createInvitation(owner);

    const [a, b] = await h.raceUnderLock(workspaceLock(owner.workspaceId), 2, () => [
      h.call('POST', `/api/workspace-invitations/${inv.id}/resend`, { cookie: owner.cookie, body: { requestId: h.rid() } }),
      h.call('POST', `/api/workspace-invitations/${inv.id}/resend`, { cookie: owner.cookie, body: { requestId: h.rid() } }),
    ]);
    expect([a.status, b.status].filter((s) => s === 200).length, JSON.stringify([a.json, b.json])).toBeGreaterThanOrEqual(1);

    expect(await liveManualTokens(inv.id)).toBe(1);
    // Resend regenerates the email-claim token: never two live ones at once.
    expect(await h.countOf(
      `SELECT count(*)::int AS n FROM public.workspace_invitation_tokens
        WHERE invitation_id = $1 AND purpose = 'email_claim'
          AND consumed_at IS NULL AND revoked_at IS NULL`,
      [inv.id],
    )).toBeLessThanOrEqual(1);
    expect((await h.one('SELECT status FROM public.workspace_invitations WHERE id = $1', [inv.id]))!.status).toBe('pending');
  }, 300_000);

  // ── C.2e ────────────────────────────────────────────────────────────────
  it('C.2e — two concurrent rotations leave exactly one live manual token and both losers are dead', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c2e.owner.${Date.now()}@example.test`);
    const inv = await createInvitation(owner);

    const [a, b] = await h.raceUnderLock(workspaceLock(owner.workspaceId), 2, () => [
      h.call('POST', `/api/workspace-invitations/${inv.id}/rotate-link`, { cookie: owner.cookie, body: { requestId: h.rid() } }),
      h.call('POST', `/api/workspace-invitations/${inv.id}/rotate-link`, { cookie: owner.cookie, body: { requestId: h.rid() } }),
    ]);
    const ok = [a, b].filter((r) => r.status === 200);
    expect(ok.length, JSON.stringify([a.json, b.json])).toBeGreaterThanOrEqual(1);

    expect(await liveManualTokens(inv.id)).toBe(1);

    // The ORIGINAL link is dead...
    expect((await previewOf(inv.manualToken, 'manual_handoff')).status).toBe(404);
    // ...and only the last rotation's link previews successfully.
    const survivors = ok.map((r) => h.tokenFromManualLink(r.json.manualLink));
    const alive: string[] = [];
    for (const t of survivors) {
      if ((await previewOf(t, 'manual_handoff')).status === 200) alive.push(t);
    }
    expect(alive).toHaveLength(1);
  }, 300_000);

  // ── C.2f ────────────────────────────────────────────────────────────────
  it('C.2f — after EVERY successful rotation the previous manual token is rejected everywhere', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c2f.owner.${Date.now()}@example.test`);
    const inv = await createInvitation(owner);

    let previous = inv.manualToken;
    for (let round = 0; round < 3; round += 1) {
      const rotated = await h.call('POST', `/api/workspace-invitations/${inv.id}/rotate-link`, {
        cookie: owner.cookie, body: { requestId: h.rid() },
      });
      expect(rotated.status, JSON.stringify(rotated.json)).toBe(200);
      const current = h.tokenFromManualLink(rotated.json.manualLink);
      expect(current).not.toBe(previous);

      // Old token: dead on preview AND on the OTP surface.
      expect((await previewOf(previous, 'manual_handoff')).status).toBe(404);
      const otp = await h.call('POST', '/api/workspace-invitations/otp/request', {
        body: { requestId: h.rid(), token: previous, purpose: 'manual_handoff' },
      });
      expect(otp.status).toBe(404);

      // New token: alive. Exactly one live manual token at every step.
      expect((await previewOf(current, 'manual_handoff')).status).toBe(200);
      expect(await liveManualTokens(inv.id)).toBe(1);
      previous = current;
    }
  }, 300_000);

  // ── C.2g ────────────────────────────────────────────────────────────────
  it('C.2g — after EVERY successful resend the previous email-claim token is rejected and the manual link survives', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c2g.owner.${Date.now()}@example.test`);
    const inv = await createInvitation(owner);

    let previous = await emailClaimToken(inv.email);
    expect((await previewOf(previous, 'email_claim')).status).toBe(200);

    for (let round = 0; round < 2; round += 1) {
      const resent = await h.call('POST', `/api/workspace-invitations/${inv.id}/resend`, {
        cookie: owner.cookie, body: { requestId: h.rid() },
      });
      expect(resent.status, JSON.stringify(resent.json)).toBe(200);

      const current = await emailClaimToken(inv.email);
      expect(current).not.toBe(previous);
      expect((await previewOf(previous, 'email_claim')).status).toBe(404);
      expect((await previewOf(current, 'email_claim')).status).toBe(200);
      // A resend never touches the manual handoff link.
      expect(await liveManualTokens(inv.id)).toBe(1);
      expect((await previewOf(inv.manualToken, 'manual_handoff')).status).toBe(200);
      previous = current;
    }
  }, 300_000);

  // ── C.2h ────────────────────────────────────────────────────────────────
  it('C.2h — an EXPIRED invitation cannot be accepted and creates no member', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c2h.owner.${Date.now()}@example.test`);
    const ready = await h.prepareAcceptable(owner.cookie, owner.workspaceId);

    // The v2 check constraint pins expires_at > created_at, so the whole row
    // is moved into the past rather than only its expiry.
    await h.db.query(
      `UPDATE public.workspace_invitations
          SET created_at = now() - interval '3 days', expires_at = now() - interval '1 hour'
        WHERE id = $1`,
      [ready.invitationId],
    );

    const accept = await h.call('POST', '/api/workspace-invitations/accept-new', {
      cookie: ready.proofCookie, body: ready.acceptBody(),
    });
    expect(accept.status).toBeGreaterThanOrEqual(400);
    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_members WHERE workspace_id = $1', [owner.workspaceId],
    )).toBe(1);
    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_invitation_consents WHERE invitation_id = $1', [ready.invitationId],
    )).toBe(0);
  }, 300_000);

  // ── C.2i ────────────────────────────────────────────────────────────────
  it('C.2i — a REVOKED invitation cannot be accepted and its tokens are all dead', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c2i.owner.${Date.now()}@example.test`);
    const ready = await h.prepareAcceptable(owner.cookie, owner.workspaceId);

    const revoked = await h.call('POST', `/api/workspace-invitations/${ready.invitationId}/revoke`, {
      cookie: owner.cookie, body: { requestId: h.rid(), reason: 'no longer joining' },
    });
    expect(revoked.status, JSON.stringify(revoked.json)).toBe(200);

    const accept = await h.call('POST', '/api/workspace-invitations/accept-new', {
      cookie: ready.proofCookie, body: ready.acceptBody(),
    });
    expect(accept.status).toBeGreaterThanOrEqual(400);
    expect(await liveManualTokens(ready.invitationId)).toBe(0);
    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_members WHERE workspace_id = $1', [owner.workspaceId],
    )).toBe(1);
    expect((await previewOf(ready.token, 'manual_handoff')).status).toBe(404);
  }, 300_000);

  // ── C.2j ────────────────────────────────────────────────────────────────
  it('C.2j — a signed-in account whose email does NOT match the invitation cannot accept it', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c2j.owner.${Date.now()}@example.test`);
    const inv = await createInvitation(owner);

    // A completely different, already-registered account.
    h.freshAddr();
    const stranger = await h.signupAndVerify(`c2j.stranger.${Date.now()}@example.test`);

    const ctx = await h.call('POST', '/api/workspace-invitations/login-context', {
      body: { requestId: h.rid(), token: inv.manualToken, purpose: 'manual_handoff' },
    });
    expect(ctx.status, JSON.stringify(ctx.json)).toBe(200);
    const ctxCookie = h.cookieOf(ctx, 'wi_ctx')!;
    expect(ctxCookie).toBeTruthy();

    const policies = await h.activePolicies();
    const attempt = await h.call('POST', '/api/workspace-invitations/accept-existing', {
      cookie: `${stranger.cookie}; ${ctxCookie}`,
      body: { requestId: h.rid(), consent: true, ...policies },
    });
    expect(attempt.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(attempt.json)).toMatch(/WRONG_ACCOUNT|INVITATION_NOT_FOUND|invalid_body/);

    // Nothing was granted and the invitation is still pending and intact.
    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [owner.workspaceId, stranger.userId],
    )).toBe(0);
    expect((await h.one('SELECT status FROM public.workspace_invitations WHERE id = $1', [inv.id]))!.status).toBe('pending');
    expect(await liveManualTokens(inv.id)).toBe(1);
    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_invitation_consents WHERE invitation_id = $1', [inv.id],
    )).toBe(0);
  }, 300_000);
});
