/**
 * WORKSPACE INVITATIONS v5.1 — Section C.3 residual (real PostgreSQL 17).
 *
 * Department pairing rules, exact consent evidence and cross-workspace
 * isolation during rollback and offboarding. Everything runs through the REAL
 * Express routes and the REAL SQL.
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

const invitationCount = (workspaceId: string) => h.countOf(
  'SELECT count(*)::int AS n FROM public.workspace_invitations WHERE workspace_id = $1', [workspaceId],
);

suite('Workspace Invitations v5.1 §C.3 residual — department pairing, consent evidence and cross-tenant isolation', () => {
  beforeAll(async () => { h = await startHarness(DSN!); }, 300_000);
  afterAll(async () => { if (h) await h.stop(); });

  // ── C.3d ────────────────────────────────────────────────────────────────
  it('C.3d — a customer_facing invitation with NO department is rejected and nothing is written', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c3d.owner.${Date.now()}@example.test`);

    const res = await h.call('POST', '/api/workspace-invitations', {
      cookie: owner.cookie,
      body: h.invitePayload(owner.workspaceId, { memberType: 'customer_facing', role: 'support_agent' }),
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('CUSTOMER_FACING_INVITATION_REQUIRES_DEPARTMENT');
    expect(await invitationCount(owner.workspaceId)).toBe(0);
    expect(await h.countOf('SELECT count(*)::int AS n FROM public.workspace_invitation_jobs')).toBe(0);
  }, 300_000);

  // ── C.3e ────────────────────────────────────────────────────────────────
  it('C.3e — a staff invitation WITH department assignments is rejected and nothing is written', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`c3e.owner.${Date.now()}@example.test`);
    const depts = await makeDepartments(owner.workspaceId, ['Staff-Only']);

    const res = await h.call('POST', '/api/workspace-invitations', {
      cookie: owner.cookie,
      body: h.invitePayload(owner.workspaceId, { memberType: 'staff', role: 'viewer', departmentIds: depts }),
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('STAFF_INVITATION_MUST_HAVE_NO_DEPARTMENT');
    expect(await invitationCount(owner.workspaceId)).toBe(0);
    expect(await h.countOf('SELECT count(*)::int AS n FROM public.workspace_invitation_departments')).toBe(0);
  }, 300_000);

  // ── C.3f ────────────────────────────────────────────────────────────────
  it('C.3f — a department belonging to ANOTHER workspace is rejected and creates no invitation', async () => {
    h.freshAddr();
    const a = await h.makeOwner(`c3f.a.${Date.now()}@example.test`);
    h.freshAddr();
    const b = await h.makeOwner(`c3f.b.${Date.now()}@example.test`);
    const foreign = await makeDepartments(b.workspaceId, ['Foreign']);

    const res = await h.call('POST', '/api/workspace-invitations', {
      cookie: a.cookie,
      body: h.invitePayload(a.workspaceId, {
        memberType: 'customer_facing', role: 'support_agent', departmentIds: foreign,
      }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await invitationCount(a.workspaceId)).toBe(0);
    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_invitation_departments WHERE workspace_id = $1', [a.workspaceId],
    )).toBe(0);
    // B's department is untouched.
    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_departments WHERE id = $1 AND workspace_id = $2',
      [foreign[0], b.workspaceId],
    )).toBe(1);
  }, 300_000);

  // ── C.3g ────────────────────────────────────────────────────────────────
  it('C.3g — the consent row records the EXACT terms/privacy versions, locale, IP, user agent, method and timestamp', async () => {
    h.freshAddr();
    // Loopback peers are private, so the production resolver only records a
    // real client IP behind a trusted proxy — exactly the deployed topology.
    const forwardedIp = '203.0.114.77';
    const owner = await h.makeOwner(`c3g.owner.${Date.now()}@example.test`);
    const ready = await h.prepareAcceptable(owner.cookie, owner.workspaceId);
    const policies = await h.activePolicies();
    const userAgent = 'SectionC/1.0 (consent-evidence-probe)';

    const before = new Date();
    const accept = await h.call('POST', '/api/workspace-invitations/accept-new', {
      cookie: ready.proofCookie,
      headers: { 'user-agent': userAgent, 'x-forwarded-for': forwardedIp },
      body: { ...ready.acceptBody(), locale: 'fa' },
    });
    expect(accept.status, JSON.stringify(accept.json)).toBe(200);
    const after = new Date();

    const consent = await h.one(
      'SELECT * FROM public.workspace_invitation_consents WHERE invitation_id = $1', [ready.invitationId],
    );
    expect(consent, 'acceptance must write exactly one consent row').toBeTruthy();
    expect(String(consent!.terms_version_id)).toBe(String(policies.termsVersionId));
    expect(String(consent!.privacy_version_id)).toBe(String(policies.privacyVersionId));
    expect(consent!.terms_content_hash).toBeTruthy();
    expect(consent!.privacy_content_hash).toBeTruthy();
    expect(String(consent!.locale)).toBe('fa');
    expect(String(consent!.user_agent)).toBe(userAgent);
    expect(String(consent!.ip)).toBe(forwardedIp);
    expect(String(consent!.acceptance_method)).toBe('manual_handoff_otp');
    expect(String(consent!.workspace_id)).toBe(owner.workspaceId);
    expect(String(consent!.user_id)).toBe(String(accept.json.user_id));
    const at = new Date(consent!.accepted_at).getTime();
    expect(at).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(at).toBeLessThanOrEqual(after.getTime() + 1000);
  }, 300_000);

  // ── C.3h ────────────────────────────────────────────────────────────────
  it('C.3h — a rolled-back acceptance and a later offboarding leave ANOTHER workspace\'s departments and memberships untouched', async () => {
    h.freshAddr();
    const a = await h.makeOwner(`c3h.a.${Date.now()}@example.test`);
    const deptA = await makeDepartments(a.workspaceId, ['A-Support']);

    h.freshAddr();
    const b = await h.makeOwner(`c3h.b.${Date.now()}@example.test`);
    const deptB = await makeDepartments(b.workspaceId, ['B-Support']);

    // The same person is a customer-facing member of BOTH workspaces.
    const readyB = await h.prepareAcceptable(b.cookie, b.workspaceId, {
      memberType: 'customer_facing', role: 'support_agent', departmentIds: deptB,
    });
    const acceptedB = await h.call('POST', '/api/workspace-invitations/accept-new', {
      cookie: readyB.proofCookie, body: readyB.acceptBody(),
    });
    expect(acceptedB.status, JSON.stringify(acceptedB.json)).toBe(200);
    const userId = String(acceptedB.json.user_id);
    const invitedEmail = readyB.email;

    const readyA = await h.prepareAcceptable(a.cookie, a.workspaceId, {
      memberType: 'customer_facing', role: 'support_agent', departmentIds: deptA, email: invitedEmail,
    });
    // Existing account: accept-new must fail, rolling the whole thing back.
    const rolledBack = await h.call('POST', '/api/workspace-invitations/accept-new', {
      cookie: readyA.proofCookie, body: readyA.acceptBody(),
    });
    expect(rolledBack.status).toBeGreaterThanOrEqual(400);

    const bDepartments = () => h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_department_members WHERE workspace_id = $1 AND user_id = $2',
      [b.workspaceId, userId],
    );
    const bMembership = () => h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [b.workspaceId, userId],
    );
    expect(await bDepartments()).toBe(1);
    expect(await bMembership()).toBe(1);
    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_department_members WHERE workspace_id = $1', [a.workspaceId],
    )).toBe(0);

    // Now offboard the SAME person from workspace B — A is unaffected, and so
    // are the department definitions themselves.
    const memberB = await h.one(
      'SELECT id FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2', [b.workspaceId, userId],
    );
    const removed = await h.call('DELETE', `/api/workspace-members/${memberB!.id}?workspaceId=${b.workspaceId}`, {
      cookie: b.cookie, body: { requestId: h.rid(), reason: 'moved on' },
    });
    expect(removed.status, JSON.stringify(removed.json)).toBe(200);

    expect(await bMembership()).toBe(0);
    expect(await bDepartments()).toBe(0);
    // Department DEFINITIONS in both workspaces survive an offboarding.
    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_departments WHERE id = ANY($1)', [[...deptA, ...deptB]],
    )).toBe(2);
    // Workspace A's own owner membership is untouched.
    expect(await h.countOf(
      'SELECT count(*)::int AS n FROM public.workspace_members WHERE workspace_id = $1', [a.workspaceId],
    )).toBe(1);
  }, 300_000);
});
