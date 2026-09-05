/**
 * BUSINESS HOURS OFF ≠ "force the messenger online".
 *
 * Hours disabled means the WORKSPACE imposes no time restriction; operator
 * manual offline/invisible and personal schedules still decide reachability.
 * A member-less workspace keeps failing open.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, any>;
const db: { widget: Row | null; members: Row[]; prefs: Row[] } = {
  widget: null,
  members: [],
  prefs: [],
};

function builder(rows: Row[]) {
  const api: any = {
    select: () => api,
    eq: () => api,
    in: () => api,
    is: () => api,
    maybeSingle: async () => ({ data: rows[0] ?? null }),
    then: (res: any) => Promise.resolve({ data: rows }).then(res),
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
    db.members = [{ user_id: 'a' }, { user_id: 'b' }, { user_id: 'c' }];
    db.prefs = [
      open('a', { force_offline: true }),
      open('b', { available_when_using_app: false }),
      open('c', {
        schedule_enabled: true,
        weekly_schedule: { wed: { enabled: true, intervals: [{ from: '09:00', to: '18:00' }] } },
      }),
    ];
    const snap = await resolveAvailability(
      { } as any,
      { workspaceId: 'ws', now: new Date('2026-01-07T20:00:00+03:00') },
    );
    expect(snap.state).toBe('offline');
    expect(snap.reason).toBe('no_operators_online');
  });

  it('is online when at least one operator is customer-available', async () => {
    db.members = [{ user_id: 'a' }, { user_id: 'b' }];
    db.prefs = [open('a', { force_offline: true }), open('b')];
    const snap = await resolveAvailability({} as any, { workspaceId: 'ws' });
    expect(snap.state).toBe('online');
  });

  it('fails open for a brand-new workspace with zero members', async () => {
    const snap = await resolveAvailability({} as any, { workspaceId: 'ws' });
    expect(snap.state).toBe('online');
    expect(snap.reason).toBe('disabled');
  });
});
