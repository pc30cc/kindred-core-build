// @vitest-environment node
/**
 * GET /api/workspace-departments/:workspaceId/directory — the departments as
 * the Inbox shows them (a conversation's department, the list filter,
 * "Transfer to a department"), with who is in each.
 *
 * The rest of the departments API is the owner's and admins' management
 * surface, so an operator could never name "Sales" to hand a chat to it. This
 * read is for every member who has the Inbox, and only for them: staff
 * without an Inbox are refused, as by the Inbox's own routes.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createFakeDb, type FakeDb } from '../widget/widgetConfigFakeDb';

const state = vi.hoisted(() => ({
  db: null as FakeDb | null,
  auth: { userId: 'u-agent', isAdmin: false, role: 'agent' as string | null },
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => state.db!.client }));
vi.mock('../../../server/lib/workspaceAuth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/lib/workspaceAuth.js')>()),
  serverConfigOf: () => ({}),
  authorizeWorkspaceAccess: async () => state.auth,
}));

const { workspaceDepartmentsRouter } = await import('../../../server/routes/workspaceDepartments.js');

const WS = '7b0e9d8c-1f2a-4b3c-9d4e-5f6a7b8c9d0e';
const OTHER_WS = '0b0e9d8c-1f2a-4b3c-9d4e-5f6a7b8c9d0f';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/workspace-departments', workspaceDepartmentsRouter);
  return a;
}

beforeEach(() => {
  state.auth = { userId: 'u-agent', isAdmin: false, role: 'agent' };
  state.db = createFakeDb({
    workspace_departments: [
      { id: 'd-sales', workspace_id: WS, name: 'Sales', enabled: true, chat_enabled: true, sort_order: 1 },
      { id: 'd-support', workspace_id: WS, name: 'Support', enabled: true, chat_enabled: true, sort_order: 2 },
      { id: 'd-voice', workspace_id: WS, name: 'Voice', enabled: false, chat_enabled: false, sort_order: 3 },
      { id: 'd-elsewhere', workspace_id: OTHER_WS, name: 'Not ours', enabled: true, chat_enabled: true, sort_order: 1 },
    ],
    workspace_department_members: [
      { workspace_id: WS, department_id: 'd-sales', user_id: 'u-lead' },
      { workspace_id: WS, department_id: 'd-support', user_id: 'u-agent' },
      { workspace_id: WS, department_id: 'd-support', user_id: 'u-lead' },
      { workspace_id: OTHER_WS, department_id: 'd-elsewhere', user_id: 'u-agent' },
    ],
  });
});

describe('the Inbox\'s department directory', () => {
  it('lists this workspace\'s departments, with their flags and members, to an operator', async () => {
    const res = await request(app()).get(`/api/workspace-departments/${WS}/directory`);
    expect(res.status).toBe(200);
    const byId = Object.fromEntries((res.body.departments as Array<{ id: string }>).map((d) => [d.id, d]));
    expect(Object.keys(byId).sort()).toEqual(['d-sales', 'd-support', 'd-voice']);
    expect(byId['d-support']).toEqual({
      id: 'd-support', name: 'Support', enabled: true, chat_enabled: true, member_ids: ['u-agent', 'u-lead'],
    });
    expect(byId['d-voice']).toMatchObject({ enabled: false, chat_enabled: false, member_ids: [] });
  });

  it('is open to every role that has the Inbox', async () => {
    for (const role of ['owner', 'admin', 'team_lead', 'support_agent', 'sales_agent']) {
      state.auth = { userId: 'u', isAdmin: false, role };
      expect((await request(app()).get(`/api/workspace-departments/${WS}/directory`)).status, role).toBe(200);
    }
  });

  it('is refused to staff without an Inbox', async () => {
    for (const role of ['analyst', 'billing', 'seo_manager', 'marketing_manager', 'developer', 'viewer']) {
      state.auth = { userId: 'u', isAdmin: false, role };
      const res = await request(app()).get(`/api/workspace-departments/${WS}/directory`);
      expect(res.status, role).toBe(403);
      expect(res.body.error).toBe('inbox_not_allowed');
    }
  });

});
