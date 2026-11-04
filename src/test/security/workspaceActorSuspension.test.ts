// @vitest-environment node
/**
 * A suspended or seat-locked member, or one without the role, loses the
 * workspace's management surfaces that used to check only a membership row
 * (audit of 2026-11-04, core-1 to core-8, conversations-8):
 *
 *   - invitations: create, list, read, edit, resend, rotate, revoke, archive
 *     and delete answer 403 FORBIDDEN (reason membership_suspended,
 *     seat_locked, …) before any RPC runs; an edit that changes the address
 *     takes the mail allowances and needs a verified account, one that keeps
 *     it takes nothing;
 *   - privacy: a suspended admin can neither queue a contact export nor list
 *     or download one; a user-subject job refuses a workspace_id; re-auth
 *     needs the password (no `oauth: true`);
 *   - the workspace icon (the widget's logo) is an owner's or admin's;
 *   - department members: only a department of the workspace in the URL;
 *   - team presence: not for a suspended member;
 *   - the cookie CSRF check accepts the dashboard's own hosts from Super
 *     Admin → Domains, never the public host.
 *
 * The REAL routers and the REAL guard (authorizeWorkspaceAccess) run against
 * an in-memory data layer; only the session lookup is replaced.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createFakeServiceDb, fakeServiceClient, type FakeServiceDb } from '../conversations/fakeServiceDb';

process.env.INVITATION_LINK_SECRET ||= 'test-invitation-link-secret-value-32b!!';
process.env.INVITATION_OTP_PEPPER ||= 'test-invitation-otp-pepper-value-32bytes';

const state = vi.hoisted(() => ({
  db: null as unknown as FakeServiceDb,
  user: '',
  verified: true,
  locked: new Set<string>(),
  quotaTaken: 0,
  quotaReturned: 0,
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeServiceClient(state.db) }));
vi.mock('../../../server/lib/workspaceAuth.js', async (orig) => {
  const real = await orig<typeof import('../../../server/lib/workspaceAuth.js')>();
  return {
    ...real,
    requireUser: async () => state.user,
    // The real guard, for the session the test names.
    authorizeWorkspaceAccess: (req: never, res: never, ws: unknown, opts?: { manage?: boolean; allowSeatLocked?: boolean }) =>
      real.authorizeWorkspaceAccessFor(req, res, state.user, ws, opts),
  };
});
vi.mock('../../../server/lib/cacheBus.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/lib/cacheBus.js')>()),
  publishCacheInvalidation: () => undefined,
}));
vi.mock('../../../server/services/billing/locks/predicates.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/billing/locks/predicates.js')>()),
  isMemberLocked: (_state: unknown, userId: string) => state.locked.has(userId),
}));
vi.mock('../../../server/services/billing/locks/state.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/billing/locks/state.js')>()),
  resolveLockState: async () => ({ enabled: true, kb: null, contact: null, member: null, conversation: null }),
}));
vi.mock('../../../server/services/auth/identity.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/auth/identity.js')>()),
  isEmailVerified: async () => state.verified,
  findIdentityById: async (_c: unknown, id: string) => ({
    id, email: `${id}@example.com`, phone: null, emailVerifiedAt: null, createdAt: null, fullName: null, passwordHash: null,
  }),
}));
vi.mock('../../../server/services/auth/sessions.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/auth/sessions.js')>()),
  validateSessionToken: async () => null,
}));
vi.mock('../../../server/services/email/sendQuota.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/email/sendQuota.js')>()),
  takeEmailQuota: async () => {
    state.quotaTaken += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  },
  returnEmailQuota: async () => {
    state.quotaReturned += 1;
  },
}));

const { workspaceInvitationsRouter } = await import('../../../server/routes/workspaceInvitations.js');
const { privacyRouter } = await import('../../../server/routes/privacy.js');
const { accountRouter } = await import('../../../server/routes/account.js');
const { workspaceDepartmentsRouter } = await import('../../../server/routes/workspaceDepartments.js');
const { availabilityRouter } = await import('../../../server/routes/availability.js');
const { aiKbRouter } = await import('../../../server/routes/aiKb.js');
const { mutationOrigins, allowedOrigins, primePlatformOrigins, __resetPlatformOriginsCache } = await import(
  '../../../server/services/platformOrigins.js'
);
const { verifyOriginForMutation } = await import('../../../server/services/auth/sessions.js');
const { invalidateGlobalAdminCache } = await import('../../../server/lib/globalAdminCache.js');

const config = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: ['https://app.example.com'] } as never;
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use((req, _res, next) => { Object.assign(req, { serverConfig: config }); next(); });
app.use('/api/workspace-invitations', workspaceInvitationsRouter);
app.use('/api/privacy', privacyRouter);
app.use('/api/account', accountRouter);
app.use('/api/workspace-departments', workspaceDepartmentsRouter);
app.use('/api/availability', availabilityRouter);
app.use('/api/ai-kb', aiKbRouter);

const WS = randomUUID();
const OTHER_WS = randomUUID();
const OWNER = randomUUID();
const ADMIN = randomUUID();
const SUSPENDED_ADMIN = randomUUID();
const LOCKED_ADMIN = randomUUID();
const VIEWER = randomUUID();
const INVITATION = randomUUID();
const OWN_DEPT = randomUUID();
const OTHER_DEPT = randomUUID();

const executed = () => state.db.rpcs.filter((r) => r.fn !== 'has_role');

beforeEach(() => {
  invalidateGlobalAdminCache();
  state.db = createFakeServiceDb();
  state.db.rpc = (fn, args) => {
    if (fn === 'has_role') return { data: false, error: null };
    // As the SQL answers (251): a membership row, whatever its suspension.
    if (fn === 'is_workspace_member') {
      const member = state.db.tables.workspace_members.some((m) => m.workspace_id === args._workspace_id && m.user_id === args._user_id);
      return { data: member, error: null };
    }
    if (fn === 'wi_execute_idempotent') return { data: { replayed: false, result: { id: INVITATION } }, error: null };
    return { data: null, error: null };
  };
  state.db.tables.workspace_members = [
    { workspace_id: WS, user_id: OWNER, role: 'owner', suspended_at: null },
    { workspace_id: WS, user_id: ADMIN, role: 'admin', suspended_at: null },
    { workspace_id: WS, user_id: SUSPENDED_ADMIN, role: 'admin', suspended_at: '2026-11-01T00:00:00Z' },
    { workspace_id: WS, user_id: LOCKED_ADMIN, role: 'admin', suspended_at: null },
    { workspace_id: WS, user_id: VIEWER, role: 'viewer', suspended_at: null },
  ];
  state.db.tables.workspace_invitations = [
    {
      id: INVITATION, workspace_id: WS, invitation_flow_version: 2, status: 'pending',
      invited_email_normalized: 'old@example.com', invited_phone_e164: null, archived_at: null,
      created_at: '2026-11-01T00:00:00Z',
    },
  ];
  state.db.tables.workspace_invitation_deliveries = [];
  state.db.tables.workspace_invitation_departments = [];
  state.db.tables.workspace_departments = [
    { id: OWN_DEPT, workspace_id: WS, name: 'Sales' },
    { id: OTHER_DEPT, workspace_id: OTHER_WS, name: 'Theirs' },
  ];
  state.db.tables.workspace_department_members = [
    { department_id: OWN_DEPT, workspace_id: WS, user_id: ADMIN },
    { department_id: OTHER_DEPT, workspace_id: OTHER_WS, user_id: randomUUID() },
  ];
  state.db.tables.workspace_branding = [{ workspace_id: WS, logo_url: null, logo_storage_key: null }];
  state.db.tables.privacy_jobs = [];
  state.db.tables.profiles = [];
  state.db.tables.user_availability_prefs = [];
  state.user = ADMIN;
  state.verified = true;
  state.locked = new Set([LOCKED_ADMIN]);
  state.quotaTaken = 0;
  state.quotaReturned = 0;
});

const createBody = () => ({
  workspaceId: WS, firstName: 'New', lastName: 'Person', email: 'mallory+2@example.com',
  memberType: 'staff', role: 'agent', requestId: randomUUID(),
});
const editBody = (email: string) => ({
  firstName: 'New', lastName: 'Person', email, memberType: 'staff', role: 'agent', requestId: randomUUID(),
});

type Call = () => request.Test;
const invitationCalls: Array<[string, Call]> = [
  ['create', () => request(app).post('/api/workspace-invitations').send(createBody())],
  ['list', () => request(app).get(`/api/workspace-invitations?workspaceId=${WS}`)],
  ['read', () => request(app).get(`/api/workspace-invitations/${INVITATION}`)],
  ['edit', () => request(app).patch(`/api/workspace-invitations/${INVITATION}`).send(editBody('mallory+3@example.com'))],
  ['resend', () => request(app).post(`/api/workspace-invitations/${INVITATION}/resend`).set('Idempotency-Key', randomUUID()).send({ requestId: randomUUID() })],
  ['rotate', () => request(app).post(`/api/workspace-invitations/${INVITATION}/rotate-link`).set('Idempotency-Key', randomUUID()).send({ requestId: randomUUID() })],
  ['revoke', () => request(app).post(`/api/workspace-invitations/${INVITATION}/revoke`).set('Idempotency-Key', randomUUID()).send({ reason: 'x', requestId: randomUUID() })],
  ['archive', () => request(app).post(`/api/workspace-invitations/${INVITATION}/archive`).set('Idempotency-Key', randomUUID()).send({ requestId: randomUUID() })],
  ['delete', () => request(app).delete(`/api/workspace-invitations/${INVITATION}`).send({})],
];

describe('invitations: only an active owner or admin manages them (core-1)', () => {
  for (const [name, call] of invitationCalls) {
    it(`${name}: a suspended admin gets 403 FORBIDDEN and no RPC runs`, async () => {
      state.user = SUSPENDED_ADMIN;
      const res = await call();
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'FORBIDDEN', reason: 'membership_suspended' });
      expect(executed()).toEqual([]);
      expect(state.quotaTaken).toBe(0);
    });

    it(`${name}: a seat-locked admin and a viewer get 403 too`, async () => {
      state.user = LOCKED_ADMIN;
      const locked = await call();
      expect(locked.status).toBe(403);
      expect(locked.body).toEqual({ error: 'FORBIDDEN', reason: 'seat_locked' });
      state.user = VIEWER;
      const viewer = await call();
      expect(viewer.status).toBe(403);
      expect(viewer.body.error).toBe('FORBIDDEN');
      expect(executed()).toEqual([]);
    });
  }

  it('an active admin still lists, reads and creates', async () => {
    expect((await request(app).get(`/api/workspace-invitations?workspaceId=${WS}`)).status).toBe(200);
    expect((await request(app).get(`/api/workspace-invitations/${INVITATION}`)).status).toBe(200);
    const created = await request(app).post('/api/workspace-invitations').send(createBody());
    expect(created.status).toBe(201);
    expect(state.db.rpcs.some((r) => r.fn === 'wi_execute_idempotent')).toBe(true);
  });

  it('an unknown invitation answers 404 INVITATION_NOT_FOUND, as the RPCs do', async () => {
    const res = await request(app).post(`/api/workspace-invitations/${randomUUID()}/revoke`).send({ reason: 'x', requestId: randomUUID() });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('INVITATION_NOT_FOUND');
  });
});

describe('invitations: an edit that changes the address is a send (core-5)', () => {
  it('takes the mail allowances when the address changes', async () => {
    const res = await request(app).patch(`/api/workspace-invitations/${INVITATION}`).send(editBody('someone-else@example.com'));
    expect(res.status).toBe(200);
    expect(state.quotaTaken).toBe(2); // per workspace and per actor
    expect(state.quotaReturned).toBe(0);
  });

  it('takes nothing when the address and phone stay', async () => {
    const res = await request(app).patch(`/api/workspace-invitations/${INVITATION}`).send(editBody('OLD@example.com'));
    expect(res.status).toBe(200);
    expect(state.quotaTaken).toBe(0);
  });

  it('needs a verified account to change the address', async () => {
    state.verified = false;
    const res = await request(app).patch(`/api/workspace-invitations/${INVITATION}`).send(editBody('someone-else@example.com'));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('email_verification_required');
    expect(executed()).toEqual([]);
  });

  it('gives the allowances back when the RPC refuses', async () => {
    state.db.rpc = (fn) => (fn === 'wi_execute_idempotent'
      ? { data: null, error: { message: 'INVITATION_NOT_PENDING' } }
      : { data: false, error: null });
    const res = await request(app).patch(`/api/workspace-invitations/${INVITATION}`).send(editBody('someone-else@example.com'));
    expect(res.body.error).toBe('INVITATION_NOT_PENDING');
    expect(state.quotaTaken).toBe(2);
    expect(state.quotaReturned).toBe(2);
  });
});

describe('privacy (core-2, core-3, core-4)', () => {
  const contactExport = { subject_type: 'contact', subject_id: randomUUID(), action: 'export', workspace_id: WS };

  it('a suspended admin cannot queue a contact export', async () => {
    state.user = SUSPENDED_ADMIN;
    const res = await request(app).post('/api/privacy/jobs').send(contactExport);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('membership_suspended');
    expect(state.db.tables.privacy_jobs).toEqual([]);
  });

  it('a seat-locked admin cannot list the workspace jobs', async () => {
    state.user = LOCKED_ADMIN;
    const res = await request(app).get(`/api/privacy/jobs?workspace_id=${WS}`);
    expect(res.status).toBe(403);
  });

  it('a suspended admin cannot mint a download token for a finished export', async () => {
    const job = { id: randomUUID(), workspace_id: WS, subject_type: 'contact', action: 'export', status: 'completed', artifact_path: 'x', actor_user_id: ADMIN };
    state.db.tables.privacy_jobs = [job];
    state.user = SUSPENDED_ADMIN;
    const res = await request(app).post(`/api/privacy/jobs/${job.id}/download-token`).send({});
    expect(res.status).toBe(403);
    expect(state.db.tables.privacy_jobs[0].download_token_hash).toBeUndefined();
  });

  it('an active admin still lists the workspace jobs', async () => {
    const res = await request(app).get(`/api/privacy/jobs?workspace_id=${WS}`);
    expect(res.status).toBe(200);
  });

  it('a user-subject job refuses a workspace_id', async () => {
    state.user = VIEWER;
    const res = await request(app).post('/api/privacy/jobs').send({
      subject_type: 'user', subject_id: VIEWER, action: 'export', workspace_id: OTHER_WS,
    });
    expect(res.status).toBe(400);
    expect(state.db.tables.privacy_jobs).toEqual([]);
  });

  it('re-authentication needs the password: `oauth: true` alone issues nothing', async () => {
    const res = await request(app).post('/api/privacy/reauth').send({ oauth: true });
    expect(res.status).toBe(400);
    expect(res.body.token).toBeUndefined();
  });
});

describe('the workspace icon is an active owner or admin\'s (core-6)', () => {
  const icon = { workspaceId: WS, data: Buffer.from('not really a png').toString('base64'), contentType: 'image/png' };

  for (const [who, user] of [['a viewer', VIEWER], ['a suspended admin', SUSPENDED_ADMIN], ['a seat-locked admin', LOCKED_ADMIN]] as const) {
    it(`${who} can neither replace nor remove it`, async () => {
      state.user = user;
      expect((await request(app).post('/api/account/workspace-icon').send(icon)).status).toBe(403);
      expect((await request(app).delete(`/api/account/workspace-icon?workspaceId=${WS}`)).status).toBe(403);
      expect(state.db.tables.workspace_branding[0]).toEqual({ workspace_id: WS, logo_url: null, logo_storage_key: null });
    });
  }
});

describe('department members stay inside the workspace in the URL (core-7)', () => {
  it('another workspace\'s department answers 404 and its members are not read', async () => {
    const res = await request(app).get(`/api/workspace-departments/${WS}/${OTHER_DEPT}/members`);
    expect(res.status).toBe(404);
    expect(res.body.user_ids).toBeUndefined();
  });

  it('nobody is attached to another workspace\'s department', async () => {
    const res = await request(app).put(`/api/workspace-departments/${WS}/${OTHER_DEPT}/members`).send({ user_ids: [ADMIN] });
    expect(res.status).toBe(404);
    expect(state.db.inserts.filter((i) => i.table === 'workspace_department_members')).toEqual([]);
    expect(state.db.deletes.filter((d) => d.table === 'workspace_department_members')).toEqual([]);
  });

  it('the workspace\'s own department still reads and saves', async () => {
    const read = await request(app).get(`/api/workspace-departments/${WS}/${OWN_DEPT}/members`);
    expect(read.status).toBe(200);
    expect(read.body.user_ids).toEqual([ADMIN]);
    const saved = await request(app).put(`/api/workspace-departments/${WS}/${OWN_DEPT}/members`).send({ user_ids: [ADMIN, VIEWER] });
    expect(saved.status).toBe(200);
  });
});

describe('team presence (conversations-8)', () => {
  it('a suspended member gets 403, an active one the list', async () => {
    state.user = SUSPENDED_ADMIN;
    const refused = await request(app).get(`/api/availability/team/${WS}`);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('membership_suspended');
    state.user = VIEWER;
    expect((await request(app).get(`/api/availability/team/${WS}`)).status).toBe(200);
  });
});

describe('AI knowledge-base jobs and drafts (sweep: aiKb.ts)', () => {
  it('a suspended or seat-locked member gets the same 404 as a stranger', async () => {
    const JOB = randomUUID();
    state.db.tables.ai_kb_jobs = [{ id: JOB, workspace_id: WS, status: 'completed' }];
    for (const user of [SUSPENDED_ADMIN, LOCKED_ADMIN, randomUUID()]) {
      state.user = user;
      const res = await request(app).get(`/api/ai-kb/jobs/${JOB}`);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('job_not_found');
    }
    const draft = randomUUID();
    state.db.tables.ai_kb_generated_articles = [{ id: draft, workspace_id: WS, job_id: JOB, status: 'draft' }];
    state.user = SUSPENDED_ADMIN;
    const publish = await request(app).post(`/api/ai-kb/jobs/${JOB}/publish-all`).send({});
    expect(publish.status).toBe(404);
  });
});

describe('cookie CSRF origins (core-8)', () => {
  it('accept the dashboard hosts of Super Admin → Domains, never the public host', async () => {
    __resetPlatformOriginsCache();
    state.db.tables.platform_domains = [{
      app_base_url: 'https://panel.example.net/', api_base_url: 'https://api.example.net', public_base_url: 'https://www.example.net',
    }];
    primePlatformOrigins(config);
    await vi.waitFor(() => expect(allowedOrigins(config)).toContain('https://www.example.net'));
    const origins = mutationOrigins(config);
    expect(origins).toEqual(expect.arrayContaining(['https://app.example.com', 'https://panel.example.net', 'https://api.example.net']));
    expect(origins).not.toContain('https://www.example.net');
    expect(verifyOriginForMutation({ headers: { origin: 'https://panel.example.net' } }, origins)).toBe(true);
    expect(verifyOriginForMutation({ headers: { origin: 'https://www.example.net' } }, origins)).toBe(false);
    expect(verifyOriginForMutation({ headers: { origin: 'https://evil.example.org' } }, origins)).toBe(false);
    __resetPlatformOriginsCache();
  });
});
