/**
 * V-13 (server side): GET /api/widget/departments/visible tells the picker
 * which department somebody answers right now. Chat: a routable member of
 * the department (shared/chatRoles.ts: the owner or a team member, never
 * staff) among those the widget counts online (senderIdentity.ts
 * availableOperatorIds). One boolean per department, no person in it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';

const WS = '11111111-1111-4111-8111-111111111111';
const SALES = 'aaaaaaaa-0000-4000-8000-000000000001';
const TECH = 'aaaaaaaa-0000-4000-8000-000000000002';
const STAFF = 'aaaaaaaa-0000-4000-8000-000000000003';

const db = vi.hoisted(() => ({
  online: new Set<string>(),
  members: [
    { user_id: 'u-sara', role: 'agent', suspended_at: null },
    { user_id: 'u-reza', role: 'support_agent', suspended_at: null },
    { user_id: 'u-admin', role: 'admin', suspended_at: null },
  ],
  departments: [] as Array<Record<string, unknown>>,
  deptMembers: {} as Record<string, string[]>,
}));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      let deptId: string | null = null;
      const b: Record<string, unknown> = {};
      const answer = () => {
        if (table === 'workspace_departments') return db.departments;
        if (table === 'workspace_department_members') return (db.deptMembers[deptId || ''] || []).map((user_id) => ({ user_id }));
        if (table === 'workspace_members') return db.members;
        return [];
      };
      Object.assign(b, {
        select: () => b,
        eq: (col: string, val: unknown) => { if (col === 'department_id') deptId = String(val); return b; },
        order: () => b,
        then: (resolve: (r: unknown) => unknown) => Promise.resolve({ data: answer(), error: null }).then(resolve),
      });
      return b;
    },
  }),
}));
vi.mock('../../../server/services/billing/locks/state.js', () => ({ resolveLockState: async () => ({}) }));
vi.mock('../../../server/services/calls/permissions.js', () => ({
  resolveRolePermissions: async () => ({ can_join_queue_calls: true, can_receive_audio_call: true, can_receive_video_call: true }),
}));
vi.mock('../../../server/services/calls/availability.js', () => ({ listWorkspaceAvailability: async () => [], isEligible: () => false }));
vi.mock('../../../server/services/widget/senderIdentity.js', () => ({ availableOperatorIds: async () => db.online }));
vi.mock('../../../server/services/widget/security.js', () => ({
  enforceWidgetToken: (_req: unknown, _res: unknown, next: () => void) => next(),
  enforceOrigin: (_req: unknown, _res: unknown, next: () => void) => next(),
  resolveWorkspaceId: () => WS,
}));

const { widgetDepartmentsRouter } = await import('../../../server/routes/widgetDepartments.js');
const { resolveWidgetVisibleDepartments } = await import('../../../server/services/calls/departments.js');

const app = express();
app.use((req, _res, next) => { (req as unknown as { serverConfig: unknown }).serverConfig = {}; next(); });
app.use('/api/widget/departments', widgetDepartmentsRouter);
const server = http.createServer(app).listen(0);

function get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, path }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: JSON.parse(d || '{}') }));
    }).on('error', reject);
  });
}

let n = 0;
beforeEach(() => {
  // New department ids per test, so no cached member list of another test answers.
  n++;
  const dept = (id: string, name: string) => ({ id: `${id}-${n}`, workspace_id: WS, name, enabled: true, chat_enabled: true, audio_enabled: false, video_enabled: false, sort_order: 0 });
  db.departments = [dept(SALES, 'فروش'), dept(TECH, 'پشتیبانی فنی'), dept(STAFF, 'مالی')];
  db.deptMembers = { [`${SALES}-${n}`]: ['u-sara'], [`${TECH}-${n}`]: ['u-reza'], [`${STAFF}-${n}`]: ['u-admin', 'u-reza'] };
  db.online = new Set();
});

describe('V-13: a department nobody answers now is marked', () => {
  it('the picker\'s answer carries one `online` per department', async () => {
    db.online = new Set(['u-sara']);
    const res = await get('/api/widget/departments/visible?channel=chat');
    expect(res.status).toBe(200);
    const byName = Object.fromEntries((res.body.visible_departments as Array<{ name: string; online: boolean }>).map((d) => [d.name, d.online]));
    expect(byName['فروش']).toBe(true);
    expect(byName['پشتیبانی فنی']).toBe(false);
    for (const d of res.body.visible_departments as Array<Record<string, unknown>>) {
      expect(Object.keys(d).sort()).toEqual(['capabilities', 'id', 'name', 'online', 'sort_order']);
    }
  });

  it('staff online does not make a department answerable (only the owner and team members receive chats)', async () => {
    db.online = new Set(['u-admin']);
    const out = await resolveWidgetVisibleDepartments({} as never, WS, 'chat', { onlineIds: db.online });
    const finance = out.find((d) => d.name === 'مالی')!;
    expect(finance.online).toBe(false);
    db.online = new Set(['u-admin', 'u-reza']);
    const again = await resolveWidgetVisibleDepartments({} as never, WS, 'chat', { onlineIds: db.online });
    expect(again.find((d) => d.name === 'مالی')!.online).toBe(true);
  });

  it('without online ids (other callers) chat departments read as answerable, as before', async () => {
    const out = await resolveWidgetVisibleDepartments({} as never, WS, 'chat');
    expect(out.every((d) => d.online)).toBe(true);
  });
});
