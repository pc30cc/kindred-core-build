/**
 * The workspace's own call center switch (PUT /api/call-center/settings
 * `enabled`): switching it on needs the call center in the workspace's plan
 * (module `call_center`); switching off is always allowed, and a workspace
 * that is already on saves its other settings (which resend `enabled: true`)
 * whatever its plan says now.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { startTestServer } from './callWidgetHttp';

const WS = '66666666-6666-4666-8666-666666666666';
type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  planAllows: true,
  planChecks: 0,
  updates: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order', 'limit', 'in', 'is', 'insert', 'update']) b[m] = () => b;
      b.maybeSingle = async () => ({ data: null, error: null });
      b.single = async () => ({ data: null, error: null });
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok);
      return b;
    },
    rpc: async (fn: string) => ({ data: fn === 'get_workspace_role' ? 'owner' : null, error: null }),
  }),
}));
vi.mock('../../../server/lib/workspaceAuth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/lib/workspaceAuth.js')>()),
  authorizeWorkspaceAccess: async () => ({ userId: 'u1', isAdmin: true, role: 'owner' }),
}));
vi.mock('../../../server/middleware/featureGating.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/middleware/featureGating.js')>()),
  checkModuleAccess: async (_u: string, _k: string, workspaceId: string, moduleKey: string) => {
    state.planChecks++;
    expect([workspaceId, moduleKey]).toEqual([WS, 'call_center']);
    return { allowed: state.planAllows, plan: state.planAllows ? 'enterprise' : 'free', reason: state.planAllows ? undefined : 'plan' };
  },
}));
vi.mock('../../../server/services/callCenter/settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/callCenter/settings.js')>();
  return {
    ...actual,
    getOrCreateWorkspaceSettings: async () => ({ ...state.row }),
    updateWorkspaceSettings: async (_c: unknown, _w: string, patch: Row) => {
      state.updates.push({ ...patch });
      Object.assign(state.row, patch);
      return { ...state.row };
    },
    getPlatformCallCenterSettings: async () => ({ call_center_enabled: true }),
    computeEffectiveCallCenterCaps: () => ({}),
  };
});
vi.mock('../../../server/services/platformRegion.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/platformRegion.js')>()),
  getPlatformEditionOrNull: async () => 'international',
}));
vi.mock('../../../server/middleware/adminBypass.js', () => ({ isGlobalAdmin: async () => true }));

const { callCenterRouter } = await import('../../../server/routes/callCenter.js');
const server = startTestServer('/api/call-center', callCenterRouter, { supabaseUrl: 'x', supabaseServiceRoleKey: 'z' }, { authUserId: 'u1' });
afterAll(() => { server.close(); });

const put = (body: Row) => server.put<{ settings?: Row; error?: string }>(`/api/call-center/settings?workspaceId=${WS}`, body);
const row = (enabled: boolean): Row => ({
  id: 'cc-1', workspace_id: WS, enabled, public_key: 'cck_x', display_name: null, widget_position: 'right',
  widget_template_id: 'intl', widget_theme: {}, pre_call_form_schema: [], business_hours: {}, avatar_url: null, avatar_storage_path: null,
});

beforeEach(() => { state.row = row(false); state.planAllows = true; state.planChecks = 0; state.updates = []; });

describe('the workspace call center switch follows the plan', () => {
  it('switches on when the plan has the call center', async () => {
    const res = await put({ enabled: true });
    expect(res.status).toBe(200);
    expect(state.row.enabled).toBe(true);
    expect(state.planChecks).toBe(1);
  });

  it('refuses to switch on without it (403 plan_forbidden) and writes nothing', async () => {
    state.planAllows = false;
    const res = await put({ enabled: true, display_name: 'Support' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('plan_forbidden');
    expect(state.updates).toEqual([]);
    expect(state.row.enabled).toBe(false);
  });

  it('switches off whatever the plan says, without asking it', async () => {
    state.row = row(true);
    state.planAllows = false;
    const res = await put({ enabled: false });
    expect(res.status).toBe(200);
    expect(state.row.enabled).toBe(false);
    expect(state.planChecks).toBe(0);
  });

  it('a workspace already on saves its other settings (enabled resent) without a plan check', async () => {
    state.row = row(true);
    state.planAllows = false;
    const res = await put({ enabled: true, display_name: 'Support' });
    expect(res.status).toBe(200);
    expect(state.row.display_name).toBe('Support');
    expect(state.planChecks).toBe(0);
  });

  it('a save that does not name enabled never asks the plan', async () => {
    state.planAllows = false;
    expect((await put({ display_name: 'Team' })).status).toBe(200);
    expect(state.planChecks).toBe(0);
  });
});
