/**
 * BUSINESS HOURS OFF ≠ "force the messenger online".
 *
 * Hours disabled means the WORKSPACE imposes no time restriction; operator
 * manual offline/invisible and personal schedules still decide reachability.
 * A member-less workspace keeps failing open. Only the members who receive
 * chats count (owner decision of 2026-10-21): the owner and the team roles,
 * not suspended, "Receive chats automatically" on — never staff.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;
const db: { widget: Row | null; members: Row[]; prefs: Row[] } = {
  widget: null,
  members: [],
  prefs: [],
};

function builder(rows: Row[]) {
  const api: Record<string, unknown> = {
    select: () => api,
    eq: () => api,
    in: () => api,
    is: () => api,
    maybeSingle: async () => ({ data: rows[0] ?? null }),
    then: (res: (v: { data: Row[] }) => unknown) => Promise.resolve({ data: rows }).then(res),
  };
  return api;
}

const fakeClient = {
  from(table: string) {
    if (table === 'widget_settings') return builder(db.widget ? [db.widget] : []);
    if (table === 'workspace_members') return builder(db.members);
    if (table === 'user_availability_prefs') return builder(db.prefs);
    return builder([]);
  },
};

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient }));
vi.mock('../../../server/supabase', () => ({ getServiceClient: () => fakeClient }));

const { resolveAvailability } = await import('../../../server/services/widget/availability');

const hoursOff = { business_hours: { enabled: false, timezone: 'Europe/Istanbul' }, offline_mode: 'capture_message' };
const open = (user_id: string, over: Row = {}) => ({
  user_id,
  force_offline: false,
  available_when_using_app: true,
  schedule_enabled: false,
  timezone: 'Europe/Istanbul',
  weekly_schedule: {},
  ...over,
});

describe('business hours OFF', () => {
  beforeEach(() => {
    db.widget = { ...hoursOff };
    db.members = [];
    db.prefs = [];
  });

  it('is offline when every operator is manually offline / invisible / out of schedule', async () => {
    db.members = [{ user_id: 'a', role: 'owner' }, { user_id: 'b', role: 'agent' }, { user_id: 'c', role: 'support_agent' }];
    db.prefs = [
      open('a', { force_offline: true }),
      open('b', { available_when_using_app: false }),
      open('c', {
        schedule_enabled: true,
        weekly_schedule: { wed: { enabled: true, intervals: [{ from: '09:00', to: '18:00' }] } },
      }),
    ];
    const snap = await resolveAvailability(
      {} as never,
      { workspaceId: 'ws', now: new Date('2026-01-07T20:00:00+03:00') },
    );
    expect(snap.state).toBe('offline');
    expect(snap.reason).toBe('no_operators_online');
  });

  it('is online when at least one operator is customer-available', async () => {
    db.members = [{ user_id: 'a', role: 'agent' }, { user_id: 'b', role: 'sales_agent' }];
    db.prefs = [open('a', { force_offline: true }), open('b')];
    const snap = await resolveAvailability({} as never, { workspaceId: 'ws' });
    expect(snap.state).toBe('online');
  });

  it('staff, a suspended member and one not receiving chats never make it online', async () => {
    db.members = [
      { user_id: 'owner', role: 'owner', receives_chats: false },
      { user_id: 'admin', role: 'admin' },
      { user_id: 'seo', role: 'seo_manager' },
      { user_id: 'gone', role: 'agent', suspended_at: '2026-10-01T00:00:00Z' },
      { user_id: 'off', role: 'team_lead' },
    ];
    db.prefs = [open('owner'), open('admin'), open('seo'), open('gone'), open('off', { force_offline: true })];
    const snap = await resolveAvailability({} as never, { workspaceId: 'ws' });
    expect(snap.state).toBe('offline');
    expect(snap.reason).toBe('no_operators_online');
    // The team lead comes back: online.
    db.prefs = db.prefs.map((p) => (p.user_id === 'off' ? open('off') : p));
    expect((await resolveAvailability({} as never, { workspaceId: 'ws' })).state).toBe('online');
  });

  it('fails open for a brand-new workspace with zero members', async () => {
    const snap = await resolveAvailability({} as never, { workspaceId: 'ws' });
    expect(snap.state).toBe('online');
    expect(snap.reason).toBe('disabled');
  });
});
