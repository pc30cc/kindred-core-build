/**
 * BLOCKER 2 — team/department management routes.
 *
 * TeamPage.tsx / TeamDepartmentsPage.tsx / StaffAccessPage.tsx used to call
 * `supabase.from('workspace_members'/'workspace_invitations'/
 * 'workspace_department_members')` directly from the browser, relying on RLS
 * scoped to `auth.uid()`. Since the dashboard's browser session no longer
 * carries a Supabase Auth JWT, those queries silently returned/wrote
 * nothing. This proves the replacement (server/routes/workspaceMembers.ts,
 * gs_session cookie + service_role) actually works end-to-end, enforces
 * owner/admin-only writes, and accepts the FULL workspace_role enum — not
 * just owner/admin/agent (a real regression caught while writing this test:
 * the initial route schemas only accepted those three roles, which would
 * have 400'd every staff invite/role-change for team_lead, sales_agent,
 * support_agent, marketing_manager, seo_manager, analyst, developer,
 * billing, and viewer — all real, UI-exposed roles).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';

type Row = Record<string, any>;
const db: Record<string, any> = {};

function fakeClient() {
  return {
    from(table: string) {
      const rows: Row[] = db[table] || (db[table] = []);
      const filters: Array<(r: Row) => boolean> = [];
      let inFilter: { col: string; vals: any[] } | null = null;
      const builder: any = {
        select: () => builder,
        eq(col: string, val: any) { filters.push((r) => r[col] === val); return builder; },
        in(col: string, vals: any[]) { inFilter = { col, vals }; return builder; },
        order: () => builder,
        limit: () => builder,
        insert(payload: any) {
          const items = Array.isArray(payload) ? payload : [payload];
          const inserted = items.map((it) => ({ id: it.id ?? crypto.randomUUID(), created_at: new Date().toISOString(), ...it }));
          rows.push(...inserted);
          return {
            select: () => ({
              single: async () => ({ data: inserted[0], error: null }),
            }),
            then: (resolve: any) => resolve({ data: inserted, error: null }),
          };
        },
        update(patch: any) {
          const scoped: Array<(r: Row) => boolean> = [...filters];
          const updateBuilder: any = {
            eq(col: string, val: any) {
              scoped.push((r: Row) => r[col] === val);
              return updateBuilder;
            },
            then(resolve: any) {
              for (const r of rows) {
                if (scoped.every((f) => f(r))) Object.assign(r, patch);
              }
              return resolve({ data: null, error: null });
            },
          };
          return updateBuilder;
        },
        delete() {
          const scoped: Array<(r: Row) => boolean> = [...filters];
          const deleteBuilder: any = {
            eq(col: string, val: any) {
              scoped.push((r: Row) => r[col] === val);
              return deleteBuilder;
            },
            then(resolve: any) {
              const remaining = rows.filter((r) => !scoped.every((f) => f(r)));
              db[table] = remaining;
              return resolve({ data: null, error: null });
            },
          };
          return deleteBuilder;
        },
        async maybeSingle() {
          const matched = rows.filter((r) => filters.every((f) => f(r)));
          return { data: matched[0] ?? null, error: null };
        },
        then(resolve: any) {
          let matched = rows.filter((r) => filters.every((f) => f(r)));
          if (inFilter) matched = matched.filter((r) => inFilter!.vals.includes(r[inFilter!.col]));
          return resolve({ data: matched, error: null });
        },
      };
      return builder;
    },
    rpc: async (name: string, args: any) => {
      db.__rpcCalls.push({ name, args });
      if (name === 'is_workspace_member') {
        const member = (db.workspace_members || []).find(
          (m) => m.workspace_id === args._workspace_id && m.user_id === args._user_id,
        );
        return { data: !!member, error: null };
      }
      // Removing a member is no longer a DELETE against `workspace_members`.
      // It is an offboarding: the row goes, but so do the member's sessions,
      // their assignments and their pending work, and all of that happens
      // inside one database function so it cannot half-happen. The stub does
      // the part this test can observe.
      if (name === 'offboard_workspace_member') {
        db.workspace_members = (db.workspace_members || []).filter(
          (m) => !(m.workspace_id === args._workspace_id && m.user_id === args._user_id),
        );
        return { data: { removed: true }, error: null };
      }
      return { data: null, error: null };
    },
  };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));

vi.mock('../../../server/middleware/adminBypass.js', () => ({
  isGlobalAdmin: async () => false,
}));

vi.mock('../../../server/services/auth/sessions.js', () => ({
  SESSION_COOKIE_NAME: 'gs_session',
  validateSessionToken: async (_config: unknown, token: string | undefined) => {
    if (!token) return null;
    const user = db.__sessions?.find((s) => s.token === token);
    return user ? { sessionId: 'test-session', userId: user.userId, email: 'test@example.com' } : null;
  },
  verifyOriginForMutation: () => true,
}));

const { workspaceMembersRouter } = await import('../../../server/routes/workspaceMembers.js');

const app = express();
app.use((req, _res, next) => {
  (req as any).serverConfig = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: ['*'] };
  next();
});
app.use(cookieParser());
app.use(express.json());
app.use('/api/workspace-members', workspaceMembersRouter);

const server = http.createServer(app).listen(0);
const port = () => (server.address() as any).port;

function call(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: port(),
        path,
        method,
        headers: {
          ...(opts.token ? { cookie: `gs_session=${opts.token}` } : {}),
          'content-type': 'application/json',
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          let json: any = {};
          try { json = JSON.parse(d || '{}'); } catch { json = { raw: d }; }
          resolve({ status: res.statusCode || 0, json });
        });
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

const OWNER = crypto.randomUUID();
const ADMIN = crypto.randomUUID();
const AGENT = crypto.randomUUID();
const OUTSIDER = crypto.randomUUID();
const WS = crypto.randomUUID();
// Second, unrelated workspace + member + department, for cross-tenant tests.
const WS_B = crypto.randomUUID();
const OWNER_B = crypto.randomUUID();
const MEMBER_B = crypto.randomUUID();
let ownerMemberRowId: string;
let adminMemberRowId: string;
let agentMemberRowId: string;
let deptId: string;
let deptBId: string;

beforeEach(() => {
  for (const key of Object.keys(db)) delete db[key];
  ownerMemberRowId = crypto.randomUUID();
  adminMemberRowId = crypto.randomUUID();
  agentMemberRowId = crypto.randomUUID();
  deptId = crypto.randomUUID();
  deptBId = crypto.randomUUID();
  db.__sessions = [
    { token: 'owner-token', userId: OWNER },
    { token: 'admin-token', userId: ADMIN },
    { token: 'agent-token', userId: AGENT },
    { token: 'outsider-token', userId: OUTSIDER },
    { token: 'owner-b-token', userId: OWNER_B },
  ];
  db.workspaces = [
    { id: WS, owner_id: OWNER },
    { id: WS_B, owner_id: OWNER_B },
  ];
  db.workspace_members = [
    { id: ownerMemberRowId, workspace_id: WS, user_id: OWNER, role: 'owner', created_at: new Date().toISOString() },
    { id: adminMemberRowId, workspace_id: WS, user_id: ADMIN, role: 'admin', created_at: new Date().toISOString() },
    { id: agentMemberRowId, workspace_id: WS, user_id: AGENT, role: 'agent', created_at: new Date().toISOString() },
    { id: crypto.randomUUID(), workspace_id: WS_B, user_id: OWNER_B, role: 'owner', created_at: new Date().toISOString() },
    { id: crypto.randomUUID(), workspace_id: WS_B, user_id: MEMBER_B, role: 'agent', created_at: new Date().toISOString() },
  ];
  db.profiles = [
    { id: OWNER, full_name: 'Owner', email: 'owner@example.com', avatar_url: null },
    { id: ADMIN, full_name: 'Admin', email: 'admin@example.com', avatar_url: null },
    { id: AGENT, full_name: 'Agent', email: 'agent@example.com', avatar_url: null },
  ];
  // Verified so invitation-creation tests exercise role/permission logic,
  // not the separate isEmailVerified gate (covered by its own test file).
  db.user_credentials = [
    { user_id: OWNER, email_verified_at: new Date().toISOString() },
    { user_id: ADMIN, email_verified_at: new Date().toISOString() },
  ];
  db.workspace_departments = [
    { id: deptId, workspace_id: WS, name: 'Sales' },
    { id: deptBId, workspace_id: WS_B, name: 'Support (Workspace B)' },
  ];
  db.workspace_department_members = [];
  db.workspace_invitations = [];
  db.__rpcCalls = [];
});

describe('GET /api/workspace-members — member listing with department names', () => {
  it('resolves members joined to profiles and department names', async () => {
    db.workspace_department_members.push({ workspace_id: WS, user_id: AGENT, department_id: deptId });
    const res = await call('GET', `/api/workspace-members?workspaceId=${WS}`, { token: 'owner-token' });
    expect(res.status).toBe(200);
    const agentRow = res.json.members.find((m: any) => m.user_id === AGENT);
    expect(agentRow.profile.email).toBe('agent@example.com');
    expect(agentRow.department_names).toEqual(['Sales']);
  });

  it('rejects a non-member (tenant isolation)', async () => {
    const res = await call('GET', `/api/workspace-members?workspaceId=${WS}`, { token: 'outsider-token' });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/workspace-members/:memberId — role change accepts the FULL workspace_role enum', () => {
  it.each(['admin', 'team_lead', 'sales_agent', 'support_agent', 'marketing_manager', 'seo_manager', 'analyst', 'developer', 'billing', 'viewer'])(
    'owner can set role=%s (not just owner/admin/agent)',
    async (role) => {
      const res = await call('PATCH', `/api/workspace-members/${agentMemberRowId}?workspaceId=${WS}`, {
        token: 'owner-token',
        body: { role },
      });
      expect(res.status, `role ${role} should be accepted`).toBe(200);
      const updated = db.workspace_members.find((m) => m.id === agentMemberRowId);
      expect(updated?.role).toBe(role);
    },
  );

  it('a plain agent (non-manager) cannot change roles', async () => {
    const res = await call('PATCH', `/api/workspace-members/${agentMemberRowId}?workspaceId=${WS}`, {
      token: 'agent-token',
      body: { role: 'admin' },
    });
    expect(res.status).toBe(403);
    expect(db.workspace_members.find((m) => m.id === agentMemberRowId)?.role).toBe('agent');
  });
});

describe('DELETE /api/workspace-members/:memberId', () => {
  it('owner can remove a member, through the offboarding function', async () => {
    const res = await call('DELETE', `/api/workspace-members/${agentMemberRowId}?workspaceId=${WS}`, { token: 'owner-token' });
    expect(res.status).toBe(200);
    expect(db.workspace_members.find((m: any) => m.id === agentMemberRowId)).toBeUndefined();

    // Not a DELETE against `workspace_members`. Removing somebody from a
    // workspace also has to take their sessions, their assignments and
    // their pending work with it, and a route that deleted the row itself
    // would leave every one of those behind — so it calls one database
    // function that does all of it or none of it.
    const offboard = db.__rpcCalls.find((c: any) => c.name === 'offboard_workspace_member');
    expect(offboard, 'the route removed the row without offboarding').toBeDefined();
    expect(offboard.args._workspace_id).toBe(WS);
    expect(offboard.args._actor_id).toBe(OWNER);
  });

  it('a non-manager cannot remove a member', async () => {
    const res = await call('DELETE', `/api/workspace-members/${agentMemberRowId}?workspaceId=${WS}`, { token: 'agent-token' });
    expect(res.status).toBe(403);
    expect(db.workspace_members.find((m) => m.id === agentMemberRowId)).toBeDefined();
  });
});

describe('POST /api/workspace-members/invitations — retired', () => {
  // Invitations left this router entirely: `/api/workspace-invitations` owns
  // creating, resending, rotating, revoking and accepting them now. These
  // cases used to assert that the old path created an invitation with the
  // right role and refused a non-manager. It does neither any more — it
  // refuses everybody, which is the only correct answer for a path whose
  // logic has moved. The rules themselves are checked where they now live:
  // `wi_can_manage_invitation` in the migrations, guarded below.
  it('answers 410 and points at the replacement, whoever asks', async () => {
    for (const token of ['owner-token', 'agent-token']) {
      const res = await call('POST', '/api/workspace-members/invitations', {
        token,
        body: { workspaceId: WS, role: 'marketing_manager', invitedEmail: null },
      });
      expect(res.status).toBe(410);
      expect(res.json.replacement).toBe('/api/workspace-invitations');
    }
  });
});

describe('nobody can be invited as owner — the rule that outlived the route', () => {
  // The old route answered `owner_role_not_assignable` at the Express layer.
  // The rule did not disappear with it; it moved into the database and got
  // stricter on the way. `wi_can_manage_invitation` is consulted by every
  // invitation RPC, and its very first branch refuses `owner` as a target
  // regardless of who is asking — so not even a workspace owner can hand the
  // role out by invitation, and no HTTP caller can route around it.
  const CHAINS = [
    'supabase/migrations/20260902104335_b93ad1a8-42f4-4f7e-93a7-b09e64403289.sql',
    'database/migrations/078_workspace_invitations_v51_rpcs.sql',
  ];

  it.each(CHAINS)('%s refuses owner as an invitation target', (file) => {
    const sql = readFileSync(file, 'utf8');
    const fn = sql.slice(sql.indexOf('FUNCTION public.wi_can_manage_invitation'));
    const body = fn.slice(0, fn.indexOf('$$;'));
    expect(body).toMatch(
      /WHEN _target_role = 'owner'::public\.workspace_role\s+THEN false/,
    );
    // Before any actor check: the refusal cannot be reached past.
    expect(body.indexOf("_target_role = 'owner'")).toBeLessThan(
      body.indexOf("_actor_role = 'owner'"),
    );
  });

  it.each(CHAINS)('%s makes every invitation RPC ask it', (file) => {
    const sql = readFileSync(file, 'utf8');
    expect(sql).toMatch(/create_workspace_invitation_v2[\s\S]*?wi_can_manage_invitation/);
  });

  it('the role is an enum at the boundary, not a free string', () => {
    // `_role public.workspace_role` means an invented role fails on the type
    // before any policy runs — the route above takes `role` as a string, so
    // this is what stops one being smuggled through.
    const sql = readFileSync(CHAINS[0], 'utf8');
    const fn = sql.slice(sql.indexOf('FUNCTION public.create_workspace_invitation_v2'));
    expect(fn.slice(0, 900)).toMatch(/_role\s+public\.workspace_role/);
  });
});

// ════════════════════════════════════════════════════════════════════
// PHASE A — owner/admin privilege boundary.
//
// workspaces.owner_id designates exactly one canonical owner. There is
// no ownership-transfer feature anywhere in the codebase, so role
// assignment must NEVER be able to grant 'owner', and the member row
// matching workspaces.owner_id must never be role-changed or deleted
// through the generic member-management endpoints — regardless of who
// is asking (admin OR the owner acting on their own row).
// ════════════════════════════════════════════════════════════════════
describe('Owner/admin privilege boundary — ADMIN cannot touch ownership', () => {
  it('admin cannot promote self to owner', async () => {
    const res = await call('PATCH', `/api/workspace-members/${adminMemberRowId}?workspaceId=${WS}`, {
      token: 'admin-token',
      body: { role: 'owner' },
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('owner_role_not_assignable');
    expect(db.workspace_members.find((m) => m.id === adminMemberRowId)?.role).toBe('admin');
  });

  it('admin cannot promote another member to owner', async () => {
    const res = await call('PATCH', `/api/workspace-members/${agentMemberRowId}?workspaceId=${WS}`, {
      token: 'admin-token',
      body: { role: 'owner' },
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('owner_role_not_assignable');
    expect(db.workspace_members.find((m) => m.id === agentMemberRowId)?.role).toBe('agent');
  });

  it('owner (acting on someone else) also cannot promote anyone to owner — no transfer flow exists', async () => {
    const res = await call('PATCH', `/api/workspace-members/${agentMemberRowId}?workspaceId=${WS}`, {
      token: 'owner-token',
      body: { role: 'owner' },
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('owner_role_not_assignable');
  });

  it('admin cannot invite a new member with role=owner', async () => {
    // Retired here; the rule lives in `wi_can_manage_invitation` now and is
    // checked in its own describe below. What this path owes an old client
    // is a clear refusal, not a quiet one.
    const res = await call('POST', '/api/workspace-members/invitations', {
      token: 'admin-token',
      body: { workspaceId: WS, role: 'owner', invitedEmail: null },
    });
    expect(res.status).toBe(410);
    expect(db.workspace_invitations).toHaveLength(0);
  });

  it('owner also cannot invite role=owner here — no transfer flow exists', async () => {
    // Same retirement as the admin case above, and the same reason it still
    // matters: being the owner does not re-open a route that is gone. The
    // rule itself — that nobody, owner included, is an assignable invitation
    // target — is asserted against `wi_can_manage_invitation` below.
    const res = await call('POST', '/api/workspace-members/invitations', {
      token: 'owner-token',
      body: { workspaceId: WS, role: 'owner', invitedEmail: null },
    });
    expect(res.status).toBe(410);
    expect(res.json.error).toBe('LEGACY_INVITATION_API_RETIRED');
    expect(db.workspace_invitations).toHaveLength(0);
  });

  it('admin cannot remove the owner', async () => {
    const res = await call('DELETE', `/api/workspace-members/${ownerMemberRowId}?workspaceId=${WS}`, { token: 'admin-token' });
    expect(res.status).toBe(403);
    expect(res.json.error).toBe('cannot_remove_owner');
    expect(db.workspace_members.find((m) => m.id === ownerMemberRowId)).toBeDefined();
  });

  it('admin cannot demote the owner to a lower role', async () => {
    const res = await call('PATCH', `/api/workspace-members/${ownerMemberRowId}?workspaceId=${WS}`, {
      token: 'admin-token',
      body: { role: 'agent' },
    });
    expect(res.status).toBe(403);
    expect(res.json.error).toBe('cannot_modify_owner');
    expect(db.workspace_members.find((m) => m.id === ownerMemberRowId)?.role).toBe('owner');
  });

  it('owner cannot remove themselves — no transfer flow has completed', async () => {
    const res = await call('DELETE', `/api/workspace-members/${ownerMemberRowId}?workspaceId=${WS}`, { token: 'owner-token' });
    expect(res.status).toBe(403);
    expect(res.json.error).toBe('cannot_remove_owner');
    expect(db.workspace_members.find((m) => m.id === ownerMemberRowId)).toBeDefined();
  });

  it('owner cannot demote themselves — no transfer flow has completed', async () => {
    const res = await call('PATCH', `/api/workspace-members/${ownerMemberRowId}?workspaceId=${WS}`, {
      token: 'owner-token',
      body: { role: 'admin' },
    });
    expect(res.status).toBe(403);
    expect(res.json.error).toBe('cannot_modify_owner');
    expect(db.workspace_members.find((m) => m.id === ownerMemberRowId)?.role).toBe('owner');
  });

  it('after every rejected attempt, workspace_members role="owner" count stays exactly 1 and matches workspaces.owner_id', async () => {
    await call('PATCH', `/api/workspace-members/${agentMemberRowId}?workspaceId=${WS}`, { token: 'admin-token', body: { role: 'owner' } });
    await call('PATCH', `/api/workspace-members/${ownerMemberRowId}?workspaceId=${WS}`, { token: 'admin-token', body: { role: 'agent' } });
    await call('DELETE', `/api/workspace-members/${ownerMemberRowId}?workspaceId=${WS}`, { token: 'admin-token' });
    const owners = db.workspace_members.filter((m) => m.workspace_id === WS && m.role === 'owner');
    expect(owners).toHaveLength(1);
    expect(owners[0].user_id).toBe(db.workspaces.find((w) => w.id === WS)?.owner_id);
    expect(owners[0].user_id).toBe(OWNER);
  });

  it('owner still retains the management operations this router still has', async () => {
    // Role changes stayed; invitations did not. The point of this case is
    // that refusing the owner *their own* role is a narrow rule and not a
    // general lockout — so what is left here has to keep working for them.
    const patch = await call('PATCH', `/api/workspace-members/${agentMemberRowId}?workspaceId=${WS}`, {
      token: 'owner-token',
      body: { role: 'admin' },
    });
    expect(patch.status).toBe(200);

    const remove = await call(
      'DELETE', `/api/workspace-members/${adminMemberRowId}?workspaceId=${WS}`,
      { token: 'owner-token' },
    );
    expect(remove.status).toBe(200);
  });
});

describe('GET/PUT /api/workspace-members/user/:userId/departments', () => {
  it('round-trips a department assignment set', async () => {
    const put = await call('PUT', `/api/workspace-members/user/${AGENT}/departments?workspaceId=${WS}`, {
      token: 'owner-token',
      body: { department_ids: [deptId] },
    });
    expect(put.status).toBe(200);

    const get = await call('GET', `/api/workspace-members/user/${AGENT}/departments?workspaceId=${WS}`, { token: 'owner-token' });
    expect(get.status).toBe(200);
    expect(get.json.department_ids).toEqual([deptId]);
  });

  it('a non-manager cannot reassign another member\'s departments', async () => {
    const res = await call('PUT', `/api/workspace-members/user/${AGENT}/departments?workspaceId=${WS}`, {
      token: 'agent-token',
      body: { department_ids: [deptId] },
    });
    expect(res.status).toBe(403);
  });

  // ── Adversarial: cross-workspace target user / department ──
  it('rejects a target user who belongs to a different workspace than the actor manages', async () => {
    const res = await call('PUT', `/api/workspace-members/user/${MEMBER_B}/departments?workspaceId=${WS}`, {
      token: 'owner-token',
      body: { department_ids: [deptId] },
    });
    expect(res.status).toBe(404);
    expect(res.json.error).toBe('target_not_a_workspace_member');
    expect(db.workspace_department_members.find((r) => r.user_id === MEMBER_B)).toBeUndefined();
  });

  it('GET also rejects a target user from a different workspace', async () => {
    const res = await call('GET', `/api/workspace-members/user/${MEMBER_B}/departments?workspaceId=${WS}`, { token: 'owner-token' });
    expect(res.status).toBe(404);
    expect(res.json.error).toBe('target_not_a_workspace_member');
  });

  it('rejects a department id that belongs to a different workspace', async () => {
    const res = await call('PUT', `/api/workspace-members/user/${AGENT}/departments?workspaceId=${WS}`, {
      token: 'owner-token',
      body: { department_ids: [deptBId] },
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('department_not_in_workspace');
    expect(res.json.invalid).toEqual([deptBId]);
    expect(db.workspace_department_members.find((r) => r.user_id === AGENT)).toBeUndefined();
  });

  it('rejects a mixed batch of one valid + one foreign-workspace department id — no partial write', async () => {
    const res = await call('PUT', `/api/workspace-members/user/${AGENT}/departments?workspaceId=${WS}`, {
      token: 'owner-token',
      body: { department_ids: [deptId, deptBId] },
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('department_not_in_workspace');
    expect(res.json.invalid).toEqual([deptBId]);
    // Neither id should have been written — reject-whole-batch semantics.
    expect(db.workspace_department_members.filter((r) => r.user_id === AGENT)).toHaveLength(0);
  });

  it('rejects a nonexistent user id', async () => {
    const res = await call('PUT', `/api/workspace-members/user/${crypto.randomUUID()}/departments?workspaceId=${WS}`, {
      token: 'owner-token',
      body: { department_ids: [deptId] },
    });
    expect(res.status).toBe(404);
    expect(res.json.error).toBe('target_not_a_workspace_member');
  });

  it('rejects a nonexistent department id', async () => {
    const res = await call('PUT', `/api/workspace-members/user/${AGENT}/departments?workspaceId=${WS}`, {
      token: 'owner-token',
      body: { department_ids: [crypto.randomUUID()] },
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('department_not_in_workspace');
  });
});
