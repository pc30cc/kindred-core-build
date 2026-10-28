// @vitest-environment node
/**
 * The owner's rule (2026-10-28): the website is required at signup,
 * registered once and fixed for good, with no ownership proof
 * (server/services/ownerWebsite.ts). Every server path:
 *
 *   POST  /api/auth/signup                   refuses a missing, invalid, platform or
 *                                            taken website (verified, or another
 *                                            profile's) before any row exists, and
 *                                            stores the canonical host it checked
 *   PATCH /api/account/me                    once registered, the same website saves and
 *                                            any other value is refused; until then it
 *                                            is set or replaced, never cleared
 *   PATCH /api/admin/users/:id/profile       the same, for Super Admin
 *   GET   /api/admin/management/users/:id    says whether it is registered
 *   GET/DELETE/PATCH …/domains(/:id/primary) the registered website's row is never removed
 *                                            and keeps the flag; other rows as before
 *   GET/PATCH /api/admin/management/domains  the same, for Super Admin
 *   POST  /api/workspaces/provision-account  a new account needs a website, which may come
 *                                            with the request; a website verified elsewhere
 *   POST  /api/workspaces                    meanwhile is a clean DOMAIN_TAKEN, never the
 *                                            raw index error
 *
 * The data layer is an in-memory double.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

type Row = Record<string, unknown>;
/** The few query-builder calls the routes under test make. */
interface Query extends PromiseLike<{ data: Row[]; error: null }> {
  select(): Query;
  eq(col: string, val: unknown): Query;
  neq(col: string, val: unknown): Query;
  is(col: string, val: unknown): Query;
  in(col: string, vals: unknown[]): Query;
  order(): Query;
  limit(): Query;
  update(patch: Row): Query;
  delete(): Query;
  insert(payload: Row | Row[]): Promise<{ data: null; error: null }>;
  maybeSingle(): Promise<{ data: Row | null; error: null }>;
}
const state = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  userId: '',
  rpcError: null as null | { message: string; code?: string },
  rpcCalls: [] as string[],
}));

vi.mock('../../../server/supabase.js', () => {
  function from(table: string) {
    const rows = (): Row[] => state.db[table] || (state.db[table] = []);
    const filters: Array<(r: Row) => boolean> = [];
    let op: { kind: 'select' } | { kind: 'update'; patch: Row } | { kind: 'delete' } = { kind: 'select' };
    const run = () => {
      const matched = rows().filter((r) => filters.every((f) => f(r)));
      if (op.kind === 'update') for (const r of matched) Object.assign(r, (op as { patch: Row }).patch);
      if (op.kind === 'delete') state.db[table] = rows().filter((r) => !matched.includes(r));
      return { data: matched, error: null };
    };
    const builder: Query = {
      select: () => builder,
      eq: (col: string, val: unknown) => { filters.push((r) => r[col] === val); return builder; },
      neq: (col: string, val: unknown) => { filters.push((r) => r[col] !== val); return builder; },
      is: (col: string, val: unknown) => { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return builder; },
      in: (col: string, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return builder; },
      order: () => builder,
      limit: () => builder,
      update: (patch: Row) => { op = { kind: 'update', patch }; return builder; },
      delete: () => { op = { kind: 'delete' }; return builder; },
      insert: (payload: Row | Row[]) => {
        for (const r of Array.isArray(payload) ? payload : [payload]) rows().push({ ...r });
        return Promise.resolve({ data: null, error: null });
      },
      maybeSingle: async () => ({ data: run().data[0] ?? null, error: null }),
      then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); },
    };
    return builder;
  }
  return {
    getServiceClient: () => ({
      from,
      rpc: async (name: string, args: Row = {}) => {
        if (name === 'admin_get_user_detail') {
          return { data: { profile: (state.db.profiles || []).find((p) => p.id === args._user_id) ?? null }, error: null };
        }
        state.rpcCalls.push(name);
        if (state.rpcError) return { data: null, error: state.rpcError };
        return { data: name === 'create_workspace_atomic' ? 'ws-new' : null, error: null };
      },
    }),
  };
});

vi.mock('../../../server/lib/workspaceAuth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/lib/workspaceAuth.js')>()),
  requireUser: async () => state.userId,
  requirePlatformAdmin: async () => state.userId,
  authorizeWorkspaceAccess: async () => ({ userId: state.userId, isAdmin: true, role: 'owner' }),
}));
vi.mock('../../../server/services/phoneVerification/index.js', () => ({ assertPhoneVerificationSatisfied: async () => undefined }));
vi.mock('../../../server/services/auth/identity.js', () => ({
  isEmailVerified: async () => true,
  findIdentityByEmail: async (_c: unknown, email: string) =>
    (state.db.profiles || []).some((p) => p.email === email) ? { id: 'existing', email } : null,
  findIdentityById: async (_c: unknown, id: string) => ({ id, email: 'owner@example.test', phone: null, emailVerifiedAt: null, createdAt: '', fullName: null }),
}));
vi.mock('../../../server/services/auth/signupPolicy.js', () => ({
  getSignupVerificationPolicy: async () => ({ enabled: true, method: 'otp', gate: 'before' }),
  invalidateSignupPolicyCache: () => undefined,
}));
vi.mock('../../../server/services/auth/password.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/auth/password.js')>()),
  hashPassword: async () => 'argon2id$test',
}));
vi.mock('../../../server/services/auth/sessions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/auth/sessions.js')>()),
  validateSessionToken: async () => null,
}));
vi.mock('../../../server/middleware/security.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/middleware/security.js')>()),
  authRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../../server/services/billing/signupPlan.js', () => ({
  applySignupPlanToWorkspace: async () => undefined,
  invalidateSignupPlanCache: () => undefined,
}));
vi.mock('../../../server/lib/cacheBus.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/lib/cacheBus.js')>()),
  publishCacheInvalidation: () => undefined,
}));

const { __resetPlatformHostsCache } = await import('../../../server/services/platformHosts.js');
const { authSecurityRouter } = await import('../../../server/routes/auth.js');
const { accountRouter } = await import('../../../server/routes/account.js');
const { workspacesRouter } = await import('../../../server/routes/workspaces.js');
const { adminRouter } = await import('../../../server/routes/admin.js');

const config = { corsOrigins: ['*'] };
const app = express();
app.use((req, _res, next) => { (req as unknown as { serverConfig: object }).serverConfig = config; next(); });
app.use(express.json());
app.use('/api/auth', authSecurityRouter);
app.use('/api/account', accountRouter);
app.use('/api/workspaces', workspacesRouter);
app.use('/api/admin', adminRouter);

const USER = '00000000-0000-4000-8000-000000000001';
const OWNER = '00000000-0000-4000-8000-000000000002';
const ACCOUNT = '00000000-0000-4000-8000-0000000000a1';
const WS = '00000000-0000-4000-8000-0000000000c1';
const BARE_WS = '00000000-0000-4000-8000-0000000000c2';
const INDEX_ERROR = { code: '23505', message: 'duplicate key value violates unique constraint "workspace_domains_verified_domain_uniq"' };

const profileOf = (id: string) => state.db.profiles.find((p) => p.id === id);
const domainOf = (id: string) => state.db.workspace_domains.find((d) => d.id === id);

beforeEach(() => {
  __resetPlatformHostsCache();
  state.userId = USER;
  state.rpcError = null;
  state.rpcCalls = [];
  state.db = {
    platform_domains: [{
      primary_domain: 'webyar.ai',
      canonical_base_url: 'https://webyar.ai',
      app_base_url: 'https://app.webyar.ai',
      api_base_url: 'https://api.webyar.ai',
    }],
    widget_platform_settings: [],
    profiles: [
      { id: USER, email: 'user@example.test', website_domain: 'shop.example' },
      { id: OWNER, email: 'owner@example.test', website_domain: null },
    ],
    user_credentials: [],
    accounts: [{ id: ACCOUNT, owner_id: USER }, { id: 'acc-other', owner_id: 'someone-else' }],
    account_members: [{ account_id: ACCOUNT, user_id: USER }],
    // USER's website (shop.example) is registered: WS holds it verified.
    workspaces: [{ id: WS, account_id: ACCOUNT }, { id: BARE_WS, account_id: ACCOUNT }, { id: 'ws-other', account_id: 'acc-other' }],
    workspace_domains: [
      { id: 'd-primary', workspace_id: WS, domain: 'shop.example', normalized_domain: 'shop.example', verified: true, is_primary: true },
      { id: 'd-extra', workspace_id: WS, domain: 'extra.example', normalized_domain: 'extra.example', verified: false, is_primary: false },
      { id: 'd-bare', workspace_id: BARE_WS, domain: 'bare.example', normalized_domain: 'bare.example', verified: false, is_primary: false },
      { id: 'd-taken', workspace_id: 'ws-other', domain: 'ninisite.com', normalized_domain: 'ninisite.com', verified: true, is_primary: true },
      { id: 'd-unverified', workspace_id: 'ws-other', domain: 'pending.example', normalized_domain: 'pending.example', verified: false, is_primary: false },
    ],
  };
});

describe('POST /api/auth/signup: the website is required and checked before anything is created', () => {
  const signup = (body: Record<string, unknown>) =>
    request(app).post('/api/auth/signup').send({ email: `new-${Math.random()}@example.test`, password: 'correct horse 9', ...body });
  const created = () => state.db.profiles.length - 2;

  it.each([
    ['missing', {}, 400, 'EMPTY'],
    ['blank', { website: '   ', metadata: { websiteDomain: '' } }, 400, 'EMPTY'],
    ['not a domain', { website: 'my shop' }, 400, 'WHITESPACE'],
    ['a single label', { website: 'shop' }, 400, 'MALFORMED'],
    ['a page, not a site', { website: 'https://shop.example/fa/about' }, 400, 'PATH_NOT_ALLOWED'],
    ['a platform host', { website: 'api.webyar.ai' }, 409, 'PLATFORM_DOMAIN'],
    ['the brand itself', { website: 'https://WebYar.ai' }, 409, 'PLATFORM_DOMAIN'],
    ['verified by another workspace', { website: 'ninisite.com' }, 409, 'DOMAIN_TAKEN'],
    ['the same, spelled otherwise', { website: 'https://WWW.NiniSite.com/' }, 409, 'DOMAIN_TAKEN'],
    ['taken, through metadata only', { metadata: { websiteDomain: 'ninisite.com' } }, 409, 'DOMAIN_TAKEN'],
  ])('%s: refused, nothing created', async (_case, body, status, code) => {
    const res = await signup(body);
    expect(res.status).toBe(status);
    // `error` carries the code: the panel's signup reads only `error`.
    expect(res.body).toEqual({ error: code, code });
    expect(created()).toBe(0);
    expect(state.db.user_credentials).toHaveLength(0);
  });

  it('stores the canonical host it checked, with no ownership proof', async () => {
    const res = await signup({ website: ' https://www.My-Shop.example/ ', metadata: { websiteDomain: 'ignored.example' } });
    expect(res.status).toBe(200);
    expect(profileOf(res.body.user.id)!.website_domain).toBe('my-shop.example');
    expect(state.db.user_credentials).toHaveLength(1);
  });

  it('takes metadata.websiteDomain when `website` is empty (older clients)', async () => {
    const res = await signup({ website: '', metadata: { websiteDomain: 'Legacy-Client.example' } });
    expect(profileOf(res.body.user.id)!.website_domain).toBe('legacy-client.example');
  });

  it('a domain someone only added (unverified) does not block a signup', async () => {
    expect((await signup({ website: 'pending.example' })).status).toBe(200);
  });

  it('another signup\'s website, its workspace not created yet, is taken', async () => {
    profileOf(OWNER)!.website_domain = 'waiting.example';
    const res = await signup({ website: 'https://WWW.Waiting.example/' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'DOMAIN_TAKEN', code: 'DOMAIN_TAKEN' });
    expect(created()).toBe(0);
  });

  it('an existing email is answered first, as before, whatever the website', async () => {
    const res = await signup({ email: 'user@example.test', website: '' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/);
  });
});

describe('PATCH /api/account/me: a registered website is fixed', () => {
  const patch = (body: Record<string, unknown>) => request(app).patch('/api/account/me').send(body);

  it.each(['shop.example', ' shop.example ', 'https://WWW.Shop.Example/'])('the same website %j saves, the stored text untouched', async (value) => {
    const res = await patch({ website_domain: value, full_name: 'Owner' });
    expect(res.status).toBe(200);
    expect(profileOf(USER)!.website_domain).toBe('shop.example');
    expect(profileOf(USER)!.full_name).toBe('Owner');
  });

  it.each([['another site', 'other.example'], ['null', null], ['empty', ''], ['a subdomain', 'blog.shop.example']])('%s is refused', async (_case, value) => {
    const res = await patch({ website_domain: value, full_name: 'Changed' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'WEBSITE_FIXED', code: 'WEBSITE_FIXED' });
    expect(profileOf(USER)!.website_domain).toBe('shop.example');
    expect(profileOf(USER)!.full_name).toBeUndefined();
  });

  it('other fields save when the website is not sent', async () => {
    expect((await patch({ full_name: 'Owner' })).status).toBe(200);
    expect(profileOf(USER)!.website_domain).toBe('shop.example');
  });

  it('an older value that is not a clean domain still matches its host', async () => {
    profileOf(USER)!.website_domain = 'https://Legacy.example';
    expect((await patch({ website_domain: 'legacy.example' })).status).toBe(200);
    expect(profileOf(USER)!.website_domain).toBe('https://Legacy.example');
    expect((await patch({ website_domain: 'other.example' })).status).toBe(403);
  });

  it('an older account without one sets it once, checked as at signup, then it is fixed', async () => {
    profileOf(USER)!.website_domain = null;
    expect((await patch({ website_domain: null })).status).toBe(200);
    expect(profileOf(USER)!.website_domain).toBeNull();
    expect((await patch({ website_domain: 'ninisite.com' })).body.code).toBe('DOMAIN_TAKEN');
    expect((await patch({ website_domain: 'app.webyar.ai' })).body.code).toBe('PLATFORM_DOMAIN');
    expect((await patch({ website_domain: 'not a site' })).status).toBe(400);
    expect(profileOf(USER)!.website_domain).toBeNull();
    expect((await patch({ website_domain: 'WWW.First.example' })).status).toBe(200);
    expect(profileOf(USER)!.website_domain).toBe('first.example');
    expect((await patch({ website_domain: 'second.example' })).status).toBe(403);
    expect(profileOf(USER)!.website_domain).toBe('first.example');
  });

  it('before the account\'s first workspace registers it, a website is replaced, never cleared', async () => {
    state.userId = OWNER;
    profileOf(OWNER)!.website_domain = 'waiting.example';
    expect((await patch({ website_domain: 'second.example' })).status).toBe(200);
    expect(profileOf(OWNER)!.website_domain).toBe('second.example');
    expect((await patch({ website_domain: '' })).body).toEqual({ error: 'EMPTY', code: 'EMPTY' });
    expect((await patch({ website_domain: null })).body.code).toBe('EMPTY');
    expect(profileOf(OWNER)!.website_domain).toBe('second.example');
    // The first workspace is created (its INSERT verifies the website): fixed.
    state.db.accounts.push({ id: 'acc-owner', owner_id: OWNER });
    state.db.workspaces.push({ id: 'ws-owner', account_id: 'acc-owner' });
    expect((await patch({ website_domain: 'third.example' })).status).toBe(403);
    expect(profileOf(OWNER)!.website_domain).toBe('second.example');
  });

  it('a website another account registered is not this profile\'s registration', async () => {
    profileOf(OWNER)!.website_domain = 'ninisite.com';
    state.userId = OWNER;
    expect((await patch({ website_domain: 'own-site.example' })).status).toBe(200);
    expect(profileOf(OWNER)!.website_domain).toBe('own-site.example');
  });
});

describe('PATCH /api/admin/users/:id/profile: fixed for Super Admin too, once registered', () => {
  const patch = (userId: string, body: Record<string, unknown>) => request(app).patch(`/api/admin/users/${userId}/profile`).send(body);

  it('the whole row with the same website saves', async () => {
    const res = await patch(USER, { full_name: 'Owner', company_name: null, website_domain: 'shop.example', preferred_locale: 'fa' });
    expect(res.status).toBe(200);
    expect(profileOf(USER)).toMatchObject({ full_name: 'Owner', website_domain: 'shop.example', preferred_locale: 'fa' });
  });

  it('a change or a clear is refused, and nothing of the row is saved', async () => {
    for (const value of ['other.example', null]) {
      const res = await patch(USER, { full_name: 'X', website_domain: value });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('WEBSITE_FIXED');
    }
    expect(profileOf(USER)).toMatchObject({ website_domain: 'shop.example' });
    expect(profileOf(USER)!.full_name).toBeUndefined();
  });

  it('a profile without one gets one; until a workspace registers it, it is replaced, not cleared', async () => {
    expect((await patch(OWNER, { full_name: 'O', website_domain: null })).status).toBe(200);
    expect(profileOf(OWNER)!.website_domain).toBeNull();
    expect((await patch(OWNER, { website_domain: 'Owner-Site.example' })).status).toBe(200);
    expect(profileOf(OWNER)!.website_domain).toBe('owner-site.example');
    expect((await patch(OWNER, { website_domain: 'else.example' })).status).toBe(200);
    expect(profileOf(OWNER)!.website_domain).toBe('else.example');
    expect((await patch(OWNER, { website_domain: null })).body.code).toBe('EMPTY');
    expect((await patch(OWNER, { website_domain: 'ninisite.com' })).body.code).toBe('DOMAIN_TAKEN');
    expect(profileOf(OWNER)!.website_domain).toBe('else.example');
  });

  it('the user detail says whether the website is registered', async () => {
    const detail = (id: string) => request(app).get(`/api/admin/management/users/${id}`);
    expect((await detail(USER)).body).toMatchObject({ profile: { id: USER }, website_fixed: true });
    profileOf(OWNER)!.website_domain = 'waiting.example';
    expect((await detail(OWNER)).body).toMatchObject({ profile: { id: OWNER }, website_fixed: false });
  });
});

describe('the registered website\'s row is never removed and keeps the primary flag; other rows as before', () => {
  it('GET …/domains marks the registered website\'s row', async () => {
    const res = await request(app).get(`/api/workspaces/${WS}/domains`);
    expect(res.status).toBe(200);
    expect(Object.fromEntries(res.body.domains.map((d: Row) => [d.id, d.fixed]))).toEqual({ 'd-primary': true, 'd-extra': false });
  });

  it('DELETE: refused on the website\'s row; other rows, a primary one included, go as before', async () => {
    const refused = await request(app).delete(`/api/workspaces/${WS}/domains/d-primary`);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('PRIMARY_DOMAIN_FIXED');
    expect(domainOf('d-primary')).toBeTruthy();
    expect((await request(app).delete(`/api/workspaces/${WS}/domains/d-extra`)).status).toBe(200);
    expect(domainOf('d-extra')).toBeUndefined();
    domainOf('d-bare')!.is_primary = true;
    expect((await request(app).delete(`/api/workspaces/${BARE_WS}/domains/d-bare`)).status).toBe(200);
    expect(domainOf('d-bare')).toBeUndefined();
  });

  it('PATCH …/primary: refused while the website is the primary, a no-op on it; any other primary moves as before', async () => {
    const refused = await request(app).patch(`/api/workspaces/${WS}/domains/d-extra/primary`);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('PRIMARY_DOMAIN_FIXED');
    expect(domainOf('d-primary')!.is_primary).toBe(true);
    expect(domainOf('d-extra')!.is_primary).toBe(false);
    expect((await request(app).patch(`/api/workspaces/${WS}/domains/d-primary/primary`)).status).toBe(200);
    expect(domainOf('d-primary')!.is_primary).toBe(true);
    // A workspace whose primary is not the website (a later workspace, an older one).
    state.db.workspace_domains.push({ id: 'd-bare2', workspace_id: BARE_WS, domain: 'bare2.example', normalized_domain: 'bare2.example', verified: true, is_primary: false });
    expect((await request(app).patch(`/api/workspaces/${BARE_WS}/domains/d-bare/primary`)).status).toBe(200);
    expect(domainOf('d-bare')!.is_primary).toBe(true);
    expect((await request(app).patch(`/api/workspaces/${BARE_WS}/domains/d-bare2/primary`)).status).toBe(200);
    expect(domainOf('d-bare2')!.is_primary).toBe(true);
    expect(domainOf('d-bare')!.is_primary).toBe(false);
  });

  it('POST …/domains: adding another domain stays as it is', async () => {
    expect((await request(app).post(`/api/workspaces/${WS}/domains`).send({ domain: 'second-site.example' })).status).toBe(200);
    expect(state.db.workspace_domains.some((d) => d.domain === 'second-site.example' && !d.verified && !d.is_primary)).toBe(true);
  });

  it('Super Admin: the website\'s row keeps its value and flag, no other row takes the flag; other rows as before', async () => {
    const listed = await request(app).get('/api/admin/management/domains');
    expect(listed.body.domains.filter((d: Row) => d.fixed).map((d: Row) => d.id)).toEqual(['d-primary']);
    const patch = (id: string, body: Record<string, unknown>) => request(app).patch(`/api/admin/management/domains/${id}`).send(body);
    expect((await patch('d-primary', { domain: 'moved.example' })).status).toBe(403);
    expect((await patch('d-primary', { is_primary: false })).status).toBe(403);
    expect((await patch('d-extra', { is_primary: true })).status).toBe(403);
    expect(domainOf('d-primary')).toMatchObject({ domain: 'shop.example', is_primary: true });
    expect(domainOf('d-extra')!.is_primary).toBe(false);
    // The same value, or the flag it already has, saves; other rows edit as before.
    expect((await patch('d-primary', { domain: 'www.shop.example', is_primary: true })).status).toBe(200);
    expect((await patch('d-extra', { domain: 'renamed.example' })).status).toBe(200);
    expect(domainOf('d-extra')!.domain).toBe('renamed.example');
    expect((await patch('d-bare', { is_primary: true })).status).toBe(200);
    expect((await patch('d-bare', { domain: 'bare-renamed.example', is_primary: false })).status).toBe(200);
    expect(domainOf('d-bare')).toMatchObject({ domain: 'bare-renamed.example', is_primary: false });
  });
});

describe('creating a workspace when the website was verified elsewhere meanwhile', () => {
  it('provision-account answers DOMAIN_TAKEN, not the raw index error', async () => {
    state.rpcError = INDEX_ERROR;
    const res = await request(app).post('/api/workspaces/provision-account');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'DOMAIN_TAKEN', code: 'DOMAIN_TAKEN' });
  });

  it('POST /api/workspaces answers DOMAIN_TAKEN, not the raw index error', async () => {
    state.rpcError = INDEX_ERROR;
    state.db.workspaces = []; // under the plan's workspace cap
    const res = await request(app).post('/api/workspaces').send({ accountId: ACCOUNT, name: 'Second' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DOMAIN_TAKEN');
  });

  it('other failures keep their answer', async () => {
    state.rpcError = { message: 'boom' };
    expect((await request(app).post('/api/workspaces/provision-account')).status).toBe(500);
  });
});

describe('POST /api/workspaces/provision-account: a new account of one\'s own needs a website', () => {
  const provision = (body?: Record<string, unknown>) => request(app).post('/api/workspaces/provision-account').send(body ?? {});

  it('a member without an account and without a website (invited, offboarded) is refused before the RPC', async () => {
    state.userId = OWNER;
    for (const body of [undefined, { website: '' }, { website: '  ' }]) {
      const res = await provision(body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'EMPTY', code: 'EMPTY' });
    }
    expect(state.rpcCalls).toEqual([]);
  });

  it('the website may come with the request, checked as at signup', async () => {
    state.userId = OWNER;
    expect((await provision({ website: 'ninisite.com' })).body.code).toBe('DOMAIN_TAKEN');
    expect((await provision({ website: 'api.webyar.ai' })).body.code).toBe('PLATFORM_DOMAIN');
    expect((await provision({ website: 'not a site' })).status).toBe(400);
    expect(state.rpcCalls).toEqual([]);
    expect((await provision({ website: 'https://www.Owner-Site.example/' })).status).toBe(200);
    expect(profileOf(OWNER)!.website_domain).toBe('owner-site.example');
    expect(state.rpcCalls).toEqual(['provision_account_on_signup']);
  });

  it('a website taken meanwhile is replaced by the next request\'s, as no workspace holds it', async () => {
    state.userId = OWNER;
    profileOf(OWNER)!.website_domain = 'ninisite.com';
    state.rpcError = INDEX_ERROR;
    expect((await provision()).body.code).toBe('DOMAIN_TAKEN');
    state.rpcError = null;
    expect((await provision({ website: 'fresh.example' })).status).toBe(200);
    expect(profileOf(OWNER)!.website_domain).toBe('fresh.example');
  });

  it('a registered website stays: the same one passes, another is refused', async () => {
    expect((await provision({ website: 'www.shop.example' })).status).toBe(200);
    const res = await provision({ website: 'other.example' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('WEBSITE_FIXED');
    expect(profileOf(USER)!.website_domain).toBe('shop.example');
  });

  it('a member provisioning into another owner\'s account needs no website of its own', async () => {
    state.userId = OWNER;
    state.db.account_members.push({ account_id: ACCOUNT, user_id: OWNER });
    expect((await provision({ website: 'ignored.example' })).status).toBe(200);
    expect(profileOf(OWNER)!.website_domain).toBeNull();
  });
});
