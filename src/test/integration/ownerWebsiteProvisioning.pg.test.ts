/**
 * The owner's website (owner, 2026-10-28; server/services/ownerWebsite.ts) on
 * real PostgreSQL: the full chain (288 included), the real routes, the real
 * trigger that registers the website.
 *
 *   - an invited member, and an offboarded one, get an account of their own
 *     from first-run provisioning only with a website, never without;
 *   - a website another signup stores (its workspace not created yet) is
 *     taken at signup;
 *   - a website taken meanwhile is replaced on the next provisioning, then
 *     fixed once its workspace registers it;
 *   - only the registered website's row is fixed: a later workspace's own
 *     domains are made primary, moved and removed as before.
 *
 * Driven by TEST_DATABASE_URL (or CLEAN_INSTALL_DATABASE_URL); skipped when
 * no live PostgreSQL is configured.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const DSN = process.env.TEST_DATABASE_URL || process.env.CLEAN_INSTALL_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

vi.mock('../../../server/middleware/security.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/middleware/security.js')>();
  const passthrough = (_req: unknown, _res: unknown, next: () => void) => next();
  return { ...actual, authRateLimiter: passthrough };
});

vi.mock('../../../server/services/email/index.js', async () => {
  const { captureEmail } = await import('./invitationHarness.js');
  return { sendEmail: async (_config: unknown, req: unknown) => captureEmail(req) };
});

vi.mock('../../../server/supabase.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/supabase.js')>();
  const { makePgServiceClient, harnessState } = await import('./invitationHarness.js');
  return { ...actual, getServiceClient: () => makePgServiceClient(() => harnessState.db) };
});

// Settings → Domains is phone gated; the gate is not what is under test.
vi.mock('../../../server/services/phoneVerification/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/phoneVerification/index.js')>();
  return { ...actual, assertPhoneVerificationSatisfied: async () => undefined };
});

const { startHarness } = await import('./invitationHarness.js');
const { websiteEdit } = await import('../../../server/services/ownerWebsite.js');
type H = Awaited<ReturnType<typeof startHarness>>;
let h: H;
const CONFIG = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: [] } as never;
const PASSWORD = 'CorrectHorseBattery1';

/** Accounts and workspaces `userId` owns, with their domain rows. */
async function ownedWorkspaces(userId: string) {
  return h.rows(
    `SELECT w.id, (SELECT count(*)::int FROM public.workspace_domains d WHERE d.workspace_id = w.id) AS domains
       FROM public.accounts a JOIN public.workspaces w ON w.account_id = a.id
      WHERE a.owner_id = $1`,
    [userId],
  );
}

/** An invited member who joined through accept-new: no website, no account of their own. */
async function invitedMember() {
  h.freshAddr();
  const owner = await h.makeOwner(`ow.owner.${Date.now()}@example.test`);
  const acc = await h.prepareAcceptable(owner.cookie, owner.workspaceId);
  const accept = await h.call('POST', '/api/workspace-invitations/accept-new', { cookie: acc.proofCookie, body: acc.acceptBody() });
  expect(accept.status, JSON.stringify(accept.json)).toBe(200);
  const member = await h.one('SELECT id, website_domain FROM public.profiles WHERE lower(email) = lower($1)', [acc.email]);
  expect(member!.website_domain).toBeNull();
  return { owner, email: acc.email, cookie: h.cookieOf(accept, 'gs_session')!, userId: String(member!.id) };
}

async function verifyAndLogin(email: string) {
  const { harnessState } = await import('./invitationHarness.js');
  let sent: { actionUrl: string | null } | undefined;
  for (let i = 0; i < 200 && !sent; i += 1) {
    sent = harnessState.capturedEmails.find((e) => e.templateSlug === 'email_verify' && e.actionUrl && e.to?.toLowerCase() === email.toLowerCase());
    if (!sent) await new Promise((r) => setTimeout(r, 20));
  }
  const token = new URL(sent!.actionUrl!).searchParams.get('token')!;
  expect((await h.call('POST', '/api/auth-email/verify-email', { body: { token } })).status).toBe(200);
  const login = await h.call('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  expect(login.status).toBe(200);
  const profile = await h.one('SELECT id FROM public.profiles WHERE lower(email) = lower($1)', [email]);
  return { cookie: h.cookieOf(login, 'gs_session')!, userId: String(profile!.id) };
}

suite('the owner\'s website on real PostgreSQL', () => {
  beforeAll(async () => { h = await startHarness(DSN!); }, 600_000);
  afterAll(async () => { if (h) await h.stop(); }, 600_000);

  it('an invited member gets an account of their own only with a website', async () => {
    const member = await invitedMember();
    const refused = await h.call('POST', '/api/workspaces/provision-account', { cookie: member.cookie });
    expect(refused.status).toBe(400);
    expect(refused.json).toEqual({ error: 'EMPTY', code: 'EMPTY' });
    expect(await h.countOf('SELECT count(*)::int AS n FROM public.accounts WHERE owner_id = $1', [member.userId])).toBe(0);

    const site = `member-${Date.now()}.example`;
    const made = await h.call('POST', '/api/workspaces/provision-account', { cookie: member.cookie, body: { website: `https://www.${site}/` } });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const owned = await ownedWorkspaces(member.userId);
    expect(owned).toHaveLength(1);
    expect(await h.rows('SELECT domain, verified, is_primary FROM public.workspace_domains WHERE workspace_id = $1', [owned[0].id]))
      .toEqual([{ domain: site, verified: true, is_primary: true }]);
    // Registered: fixed from now on.
    expect(await websiteEdit(CONFIG, member.userId, `else-${Date.now()}.example`)).toMatchObject({ ok: false, code: 'WEBSITE_FIXED' });
  });

  it('an offboarded member who signs in to no workspace is refused the same, with nothing created', async () => {
    const member = await invitedMember();
    const row = await h.one('SELECT id FROM public.workspace_members WHERE workspace_id = $1 AND user_id = $2', [member.owner.workspaceId, member.userId]);
    const removed = await h.call('DELETE', `/api/workspace-members/${row!.id}?workspaceId=${member.owner.workspaceId}`, {
      cookie: member.owner.cookie, body: { requestId: h.rid(), reason: 'left' },
    });
    expect(removed.status, JSON.stringify(removed.json)).toBe(200);
    const login = await h.call('POST', '/api/auth/login', { body: { email: member.email, password: PASSWORD } });
    expect(login.status, JSON.stringify(login.json)).toBe(200);
    const cookie = h.cookieOf(login, 'gs_session')!;
    expect((await h.call('GET', '/api/workspaces', { cookie })).json.workspaces).toEqual([]);
    const refused = await h.call('POST', '/api/workspaces/provision-account', { cookie });
    expect(refused.status).toBe(400);
    expect(refused.json.code).toBe('EMPTY');
    expect(await ownedWorkspaces(member.userId)).toEqual([]);
  });

  it('a website another signup stores, its workspace not created yet, is taken at signup', async () => {
    h.freshAddr();
    const site = `shared-${Date.now()}.example`;
    const first = await h.call('POST', '/api/auth/signup', { body: { email: `ow.a.${Date.now()}@example.test`, password: PASSWORD, fullName: 'A', website: site } });
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    const email = `ow.b.${Date.now()}@example.test`;
    const second = await h.call('POST', '/api/auth/signup', { body: { email, password: PASSWORD, fullName: 'B', website: `https://WWW.${site.toUpperCase()}/` } });
    expect(second.status).toBe(409);
    expect(second.json).toEqual({ error: 'DOMAIN_TAKEN', code: 'DOMAIN_TAKEN' });
    expect(await h.countOf('SELECT count(*)::int AS n FROM public.profiles WHERE lower(email) = lower($1)', [email])).toBe(0);
  });

  it('a website taken meanwhile is replaced on the next provisioning, then fixed once registered', async () => {
    h.freshAddr();
    const site = `meanwhile-${Date.now()}.example`;
    const email = `ow.c.${Date.now()}@example.test`;
    expect((await h.call('POST', '/api/auth/signup', { body: { email, password: PASSWORD, fullName: 'C', website: site } })).status).toBe(200);
    const late = await verifyAndLogin(email);
    // Someone else's workspace verifies the website first (e.g. through its own domain proof).
    const other = await h.makeOwner(`ow.other.${Date.now()}@example.test`);
    await h.db.query('INSERT INTO public.workspace_domains (workspace_id, domain, verified) VALUES ($1, $2, true)', [other.workspaceId, site]);

    const taken = await h.call('POST', '/api/workspaces/provision-account', { cookie: late.cookie });
    expect(taken.status).toBe(409);
    expect(taken.json.code).toBe('DOMAIN_TAKEN');
    expect(await h.countOf('SELECT count(*)::int AS n FROM public.account_members WHERE user_id = $1', [late.userId])).toBe(0);
    // Not registered for this account: still replaceable (Super Admin's edit reads the same rule).
    expect(await websiteEdit(CONFIG, late.userId, `probe-${Date.now()}.example`)).toMatchObject({ ok: true });

    const fresh = `fresh-${Date.now()}.example`;
    const made = await h.call('POST', '/api/workspaces/provision-account', { cookie: late.cookie, body: { website: fresh } });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    expect((await h.one('SELECT website_domain FROM public.profiles WHERE id = $1', [late.userId]))!.website_domain).toBe(fresh);
    const [ws] = await ownedWorkspaces(late.userId);
    expect(await h.rows('SELECT domain, verified, is_primary FROM public.workspace_domains WHERE workspace_id = $1', [ws.id]))
      .toEqual([{ domain: fresh, verified: true, is_primary: true }]);
    expect(await websiteEdit(CONFIG, late.userId, `again-${Date.now()}.example`)).toMatchObject({ ok: false, code: 'WEBSITE_FIXED' });
  });

  it('only the registered website\'s row is fixed: a later workspace\'s domains are managed as before', async () => {
    h.freshAddr();
    const owner = await h.makeOwner(`ow.d.${Date.now()}@example.test`);
    const first = await h.call('GET', `/api/workspaces/${owner.workspaceId}/domains`, { cookie: owner.cookie });
    expect(first.json.domains.map((d: { is_primary: boolean; fixed: boolean }) => [d.is_primary, d.fixed])).toEqual([[true, true]]);
    const websiteRow = first.json.domains[0].id as string;
    const refused = await h.call('DELETE', `/api/workspaces/${owner.workspaceId}/domains/${websiteRow}`, { cookie: owner.cookie });
    expect(refused.status).toBe(403);
    expect(refused.json.code).toBe('PRIMARY_DOMAIN_FIXED');

    const account = await h.call('GET', '/api/workspaces/account', { cookie: owner.cookie });
    const second = await h.call('POST', '/api/workspaces', { cookie: owner.cookie, body: { accountId: account.json.account.id, name: 'Second' } });
    expect(second.status, JSON.stringify(second.json)).toBe(200);
    const wsId = second.json.workspaceId as string;
    for (const d of [`x-${Date.now()}.example`, `y-${Date.now()}.example`]) {
      expect((await h.call('POST', `/api/workspaces/${wsId}/domains`, { cookie: owner.cookie, body: { domain: d } })).status).toBe(200);
    }
    const ids = (await h.rows('SELECT id FROM public.workspace_domains WHERE workspace_id = $1 ORDER BY created_at, id', [wsId])).map((r) => String(r.id));
    expect((await h.call('PATCH', `/api/workspaces/${wsId}/domains/${ids[0]}/primary`, { cookie: owner.cookie })).status).toBe(200);
    expect((await h.call('PATCH', `/api/workspaces/${wsId}/domains/${ids[1]}/primary`, { cookie: owner.cookie })).status).toBe(200);
    expect(await h.rows('SELECT id FROM public.workspace_domains WHERE workspace_id = $1 AND is_primary', [wsId])).toEqual([{ id: ids[1] }]);
    const listed = await h.call('GET', `/api/workspaces/${wsId}/domains`, { cookie: owner.cookie });
    expect(listed.json.domains.every((d: { fixed: boolean }) => d.fixed === false)).toBe(true);
    expect((await h.call('DELETE', `/api/workspaces/${wsId}/domains/${ids[1]}`, { cookie: owner.cookie })).status).toBe(200);
  });
});
