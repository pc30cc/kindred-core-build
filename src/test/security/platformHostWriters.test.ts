// @vitest-environment node
/**
 * Every writer that can turn user input into a (verified) workspace domain
 * refuses a platform host (server/services/platformHosts.ts), and lets a
 * customer domain through exactly as before:
 *
 *   POST  /api/auth/signup                 drops it (like a website that does not parse)
 *   PATCH /api/account/me                  refuses a new one, saves an unchanged one
 *   PATCH /api/admin/users/:id/profile     the same, for Super Admin
 *   POST  /api/workspaces/provision-account and POST /api/workspaces
 *                                          clear a stored one before the INSERT whose
 *                                          trigger would verify it
 *   POST  /api/workspaces/:id/domains      refuses it, but for the platform's own workspace
 *   PATCH /api/admin/management/domains/:id  the same, for Super Admin (the row keeps `verified`)
 *
 * The data layer is an in-memory double; each RPC records the website the
 * workspace INSERT trigger would read at that moment.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase/Express test doubles are intentionally untyped. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

type Row = Record<string, any>;
const state = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  userId: '',
  triggerSaw: [] as Array<string | null>,
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
    const builder: any = {
      select: () => builder,
      eq: (col: string, val: unknown) => { filters.push((r) => r[col] === val); return builder; },
      in: (col: string, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return builder; },
      order: () => builder,
      limit: () => builder,
      update: (patch: Row) => { op = { kind: 'update', patch }; return builder; },
      delete: () => { op = { kind: 'delete' }; return builder; },
      insert: (payload: Row | Row[]) => {
        const list = Array.isArray(payload) ? payload : [payload];
        for (const r of list) {
          if (table === 'workspace_domains' && rows().some((x) => x.verified && r.verified && x.domain === r.domain)) {
            return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate' } });
          }
          rows().push({ ...r });
        }
        return Promise.resolve({ data: list, error: null });
      },
      maybeSingle: async () => ({ data: run().data[0] ?? null, error: null }),
      then: (resolve: any, reject?: any) => Promise.resolve(run()).then(resolve, reject),
    };
    return builder;
  }
  /** What trg_workspaces_auto_register_owner_domain reads: the account owner's website. */
  const ownerWebsite = (accountId: string | undefined, fallbackUser: string) => {
    const account = (state.db.accounts || []).find((a) => a.id === accountId);
    const owner = account?.owner_id ?? fallbackUser;
    return (state.db.profiles || []).find((p) => p.id === owner)?.website_domain ?? null;
  };
  return {
    getServiceClient: () => ({
      from,
      rpc: async (name: string, args: Row) => {
        if (name === 'provision_account_on_signup') {
          const member = (state.db.account_members || []).find((m) => m.user_id === args._user_id);
          state.triggerSaw.push(ownerWebsite(member?.account_id, args._user_id));
          return { data: null, error: null };
        }
        if (name === 'create_workspace_atomic') {
          state.triggerSaw.push(ownerWebsite(args._account_id, args._user_id));
          return { data: 'ws-new', error: null };
        }
        return { data: null, error: null };
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
  findIdentityByEmail: async () => null,
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

const config = { corsOrigins: ['*'] } as any;
const app = express();
app.use((req, _res, next) => { (req as any).serverConfig = config; next(); });
app.use(express.json());
app.use('/api/auth', authSecurityRouter);
app.use('/api/account', accountRouter);
app.use('/api/workspaces', workspacesRouter);
app.use('/api/admin', adminRouter);

const USER = '00000000-0000-4000-8000-000000000001';
const OWNER = '00000000-0000-4000-8000-000000000002';
const ACCOUNT = '00000000-0000-4000-8000-0000000000a1';
const PLATFORM_WS = '00000000-0000-4000-8000-0000000000f1';
const CUSTOMER_WS = '00000000-0000-4000-8000-0000000000c1';

/** The finding's payloads and the RESPOK twins (the brand comes from each database's own row). */
const REFUSED = (apex: string) => [
  `API.${apex.toUpperCase()}`,
  `api.${apex}.`,
  `https://api.${apex}/x`,
  `api.${apex}:443`,
  ` api.${apex} `,
  `user@api.${apex}`,
  `app.${apex}`,
  apex,
  `foo.${apex}`,
  `ａｐｉ.${apex}`,
  // U+0130 (dotted capital I): Postgres lower() stores it as a plain i.
  ...(apex.includes('i') ? [`app.${apex}`.replace(/i/g, '\u0130'), `API.${apex.toUpperCase()}`.replace(/I/g, '\u0130')] : []),
];
/** A spelling the website trigger would store as the platform host, but that a URL reads otherwise. */
const SQL_ONLY = (value: string) => value.includes('\u0130');

const profileOf = (id: string) => state.db.profiles.find((p) => p.id === id);

describe.each([
  ['WebYar', 'webyar.ai'],
  ['RESPOK', 'respok.app'],
])('%s', (_brand, apex) => {
  beforeEach(() => {
    __resetPlatformHostsCache();
    state.userId = USER;
    state.triggerSaw = [];
    state.db = {
      platform_domains: [{
        primary_domain: apex,
        canonical_base_url: `https://${apex}`,
        public_base_url: `https://${apex}`,
        app_base_url: `https://app.${apex}`,
        api_base_url: `https://api.${apex}`,
      }],
      widget_platform_settings: [],
      profiles: [{ id: USER, website_domain: 'shop.example' }, { id: OWNER, website_domain: 'ninisite.com' }],
      accounts: [],
      account_members: [],
      workspaces: [],
      user_credentials: [],
      workspace_domains: [
        { id: 'd-platform', workspace_id: PLATFORM_WS, domain: apex, normalized_domain: apex, verified: true, is_primary: true },
        { id: 'd-customer', workspace_id: CUSTOMER_WS, domain: 'ninisite.com', normalized_domain: 'ninisite.com', verified: true, is_primary: true },
      ],
    };
  });

  describe('POST /api/auth/signup', () => {
    const signup = (body: Record<string, unknown>) =>
      request(app).post('/api/auth/signup').send({ email: `new-${Math.random()}@example.test`, password: 'correct horse 9', ...body });
    const stored = (id: string) => profileOf(id)?.website_domain;

    it.each(REFUSED(apex))('drops the website %j, from either field', async (value) => {
      const viaMetadata = await signup({ website: value, metadata: { websiteDomain: value } });
      expect(viaMetadata.status).toBe(200);
      expect(stored(viaMetadata.body.user.id)).toBeNull();
      const viaWebsite = await signup({ website: value });
      // `website` is stored as a URL, which reads U+0130 as punycode (xn--…),
      // never the platform host; metadata.websiteDomain is stored as typed.
      if (SQL_ONLY(value)) expect(stored(viaWebsite.body.user.id)).not.toMatch(new RegExp(`(^|[/.])${apex.replace('.', '\\.')}$`));
      else expect(stored(viaWebsite.body.user.id)).toBeNull();
    });

    it('keeps a customer website exactly as before (metadata first, then the URL form of `website`)', async () => {
      const both = await signup({ website: 'shop.example', metadata: { websiteDomain: 'shop.example' } });
      expect(stored(both.body.user.id)).toBe('shop.example');
      const websiteOnly = await signup({ website: 'ninisite.com' });
      expect(stored(websiteOnly.body.user.id)).toBe('https://ninisite.com');
    });

    it('ignores a metadata website that is not a string', async () => {
      const res = await signup({ website: 'shop.example', metadata: { websiteDomain: { host: `api.${apex}` } } });
      expect(stored(res.body.user.id)).toBe('https://shop.example');
    });
  });

  describe('PATCH /api/account/me', () => {
    it.each(REFUSED(apex))('refuses the website %j', async (value) => {
      const res = await request(app).patch('/api/account/me').send({ website_domain: value });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PLATFORM_DOMAIN');
      expect(profileOf(USER)!.website_domain).toBe('shop.example');
    });

    it('saves a customer website, a cleared one, and an unchanged stored value', async () => {
      expect((await request(app).patch('/api/account/me').send({ website_domain: 'ninisite.com' })).status).toBe(200);
      expect(profileOf(USER)!.website_domain).toBe('ninisite.com');
      expect((await request(app).patch('/api/account/me').send({ website_domain: null })).status).toBe(200);
      expect(profileOf(USER)!.website_domain).toBeNull();
      // A value stored before this guard is not a new claim: the form may send it back.
      profileOf(USER)!.website_domain = apex;
      expect((await request(app).patch('/api/account/me').send({ website_domain: apex, full_name: 'Owner' })).status).toBe(200);
    });
  });

  describe('PATCH /api/admin/users/:id/profile (Super Admin)', () => {
    it('refuses a platform host as anyone\'s website, saves the rest as before', async () => {
      const refused = await request(app).patch(`/api/admin/users/${OWNER}/profile`).send({ website_domain: `https://api.${apex}` });
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('PLATFORM_DOMAIN');
      const dotted = await request(app).patch(`/api/admin/users/${OWNER}/profile`).send({ website_domain: `app.${apex}`.replace(/i/g, '\u0130') });
      expect(dotted.status).toBe(400);
      expect(profileOf(OWNER)!.website_domain).toBe('ninisite.com');
      const saved = await request(app).patch(`/api/admin/users/${OWNER}/profile`).send({ website_domain: 'shop.example', full_name: 'X' });
      expect(saved.status).toBe(200);
      expect(profileOf(OWNER)!.website_domain).toBe('shop.example');
    });
  });

  describe('creating a workspace', () => {
    it.each([`HTTPS://api.${apex}:8443/x`, `app.${apex}`.replace(/i/g, '\u0130')])(
      'provision-account: the trigger never sees the platform host %j, the profile is cleared',
      async (website) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        profileOf(USER)!.website_domain = website;
        expect((await request(app).post('/api/workspaces/provision-account')).status).toBe(200);
        warn.mockRestore();
        expect(state.triggerSaw).toEqual([null]);
        expect(profileOf(USER)!.website_domain).toBeNull();
      },
    );

    it('provision-account into an existing account reads that account\'s owner', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      state.db.accounts.push({ id: ACCOUNT, owner_id: OWNER });
      state.db.account_members.push({ account_id: ACCOUNT, user_id: USER, created_at: '2026-01-01' });
      profileOf(OWNER)!.website_domain = `app.${apex}`;
      await request(app).post('/api/workspaces/provision-account');
      warn.mockRestore();
      expect(state.triggerSaw).toEqual([null]);
    });

    it('POST /api/workspaces: the account owner\'s stored platform host is cleared first', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      state.db.accounts.push({ id: ACCOUNT, owner_id: OWNER });
      state.db.account_members.push({ account_id: ACCOUNT, user_id: USER });
      profileOf(OWNER)!.website_domain = `www.www.api.${apex}?x`;
      const res = await request(app).post('/api/workspaces').send({ accountId: ACCOUNT, name: 'Second' });
      warn.mockRestore();
      expect(res.status).toBe(200);
      expect(state.triggerSaw).toEqual([null]);
      expect(profileOf(OWNER)!.website_domain).toBeNull();
    });

    it('a customer website reaches the trigger untouched, as today', async () => {
      expect((await request(app).post('/api/workspaces/provision-account')).status).toBe(200);
      state.db.accounts.push({ id: ACCOUNT, owner_id: OWNER });
      state.db.account_members.push({ account_id: ACCOUNT, user_id: OWNER });
      state.userId = OWNER;
      expect((await request(app).post('/api/workspaces').send({ accountId: ACCOUNT, name: 'Second' })).status).toBe(200);
      expect(state.triggerSaw).toEqual(['shop.example', 'ninisite.com']);
      expect(profileOf(USER)!.website_domain).toBe('shop.example');
    });
  });

  describe('POST /api/workspaces/:id/domains', () => {
    const add = (ws: string, domain: string) => request(app).post(`/api/workspaces/${ws}/domains`).send({ domain });

    // The domain input is stored as punycode, so U+0130 cannot become the platform host here.
    it.each(REFUSED(apex).filter((v) => !/[:@ /]|\.$/.test(v.trim()) && !SQL_ONLY(v)))('refuses %j for a customer workspace', async (value) => {
      const res = await add(CUSTOMER_WS, value);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PLATFORM_DOMAIN');
    });

    it('still rejects the malformed spellings for their format, before anything else', async () => {
      for (const value of [`api.${apex}:443`, `user@api.${apex}`, `https://api.${apex}/x`, `api.${apex}.`]) {
        expect((await add(CUSTOMER_WS, value)).status).toBe(400);
      }
    });

    it('adds a customer domain as before, and lets the platform workspace add its own hosts', async () => {
      expect((await add(CUSTOMER_WS, 'shop.example')).status).toBe(200);
      expect((await add(PLATFORM_WS, `help.${apex}`)).status).toBe(200);
      const added = state.db.workspace_domains.filter((d) => d.id === undefined).map((d) => [d.workspace_id, d.domain, d.verified]);
      expect(added).toEqual([[CUSTOMER_WS, 'shop.example', undefined], [PLATFORM_WS, `help.${apex}`, undefined]]);
    });
  });

  describe('PATCH /api/admin/management/domains/:id (Super Admin)', () => {
    it('refuses to rewrite a customer\'s verified row into a platform host', async () => {
      const res = await request(app).patch('/api/admin/management/domains/d-customer').send({ domain: `api.${apex}` });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PLATFORM_DOMAIN');
      expect(state.db.workspace_domains.find((d) => d.id === 'd-customer')!.domain).toBe('ninisite.com');
    });

    it('rewrites a customer row to a customer domain, and the platform row to a platform host, as before', async () => {
      expect((await request(app).patch('/api/admin/management/domains/d-customer').send({ domain: 'shop.example' })).status).toBe(200);
      expect((await request(app).patch('/api/admin/management/domains/d-platform').send({ domain: `www.${apex}` })).status).toBe(200);
      expect(state.db.workspace_domains.find((d) => d.id === 'd-customer')!.domain).toBe('shop.example');
    });
  });
});
